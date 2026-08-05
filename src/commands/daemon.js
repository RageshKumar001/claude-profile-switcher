import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readCredentials, tokenHealth, writeCredentials } from '../credentials.js';
import { refreshCredentials } from '../oauth.js';
import { logsDir } from '../paths.js';
import { listProfileNames, profileCredentialsPath, updateMeta } from '../store.js';
import { syncMcpOAuth } from '../mcp-sync.js';
import { c, formatDuration, sym } from '../ui.js';

const TASK_NAME = 'ClaudeProfileSwitcher-KeepAlive';

/**
 * Refresh tokens for profiles whose refresh window is closing.
 *
 * Refresh tokens last ~17 days. A project you have not touched in that long
 * would otherwise need a browser login before you could use it again, which is
 * exactly the friction this tool exists to remove.
 *
 * Refreshing early is pointless traffic, so we only act inside the threshold.
 */
export async function runKeepAlive({ dryRun = false, thresholdDays = 7, quiet = false } = {}) {
  const names = listProfileNames();
  const report = [];

  for (const name of names) {
    const file = profileCredentialsPath(name);
    const creds = readCredentials(file);
    const health = tokenHealth(creds);

    if (!health.present) {
      report.push({ name, action: 'skipped', reason: 'no credentials' });
      continue;
    }
    if (health.state === 'expired') {
      report.push({ name, action: 'dead', reason: 'refresh window already closed -- re-login required' });
      updateMeta(name, { keepAliveState: 'dead' });
      continue;
    }

    // With no recorded refresh deadline we cannot know how long this profile
    // has, so refresh it: that is both how it stays alive and how we learn.
    const withinThreshold = health.refreshExpiryKnown
      ? health.refreshMsLeft < thresholdDays * 86_400_000
      : true;

    if (!withinThreshold) {
      report.push({ name, action: 'ok', reason: `${formatDuration(health.refreshMsLeft)} left` });
      continue;
    }

    if (dryRun) {
      report.push({
        name,
        action: 'would refresh',
        reason: health.refreshExpiryKnown
          ? formatDuration(health.refreshMsLeft)
          : 'no refresh deadline recorded',
      });
      continue;
    }

    try {
      const { creds: next, rotated } = await refreshCredentials(creds);
      // Re-read immediately before writing: a live session may have refreshed
      // underneath us while we were on the network.
      const current = readCredentials(file);
      writeCredentials(file, { ...current, claudeAiOauth: next.claudeAiOauth });

      const after = tokenHealth(next);
      updateMeta(name, {
        keepAliveState: 'refreshed',
        lastRefreshedAt: new Date().toISOString(),
      });

      // If the server did not rotate the refresh token, its expiry did not move
      // and this profile will still die on schedule. Say so plainly.
      const stillExpiring =
        after.refreshExpiryKnown && after.refreshMsLeft < thresholdDays * 86_400_000;
      report.push({
        name,
        action: 'refreshed',
        reason: !after.refreshExpiryKnown
          ? `access token renewed for ${formatDuration(after.accessMsLeft)}${rotated ? ', refresh token rotated' : ''}`
          : rotated
            ? `rotated, ${formatDuration(after.refreshMsLeft)} left`
            : stillExpiring
              ? `access token renewed, but the refresh window did NOT move (${formatDuration(after.refreshMsLeft)}) -- re-login will still be needed`
              : `${formatDuration(after.refreshMsLeft)} left`,
        warn: !rotated && stillExpiring,
      });
    } catch (err) {
      updateMeta(name, { keepAliveState: err.terminal ? 'dead' : 'error', lastError: err.message });
      report.push({
        name,
        action: err.terminal ? 'dead' : 'failed',
        reason: err.terminal ? 'refresh token rejected -- re-login required' : err.message,
      });
    }
  }

  if (!dryRun && names.length) syncMcpOAuth();

  logReport(report);
  if (!quiet) printReport(report);
  return report;
}

function printReport(report) {
  if (!report.length) {
    console.log(c.dim('no profiles to maintain'));
    return;
  }
  const icon = {
    ok: c.green(sym.ok),
    refreshed: c.green(sym.ok),
    'would refresh': c.dim('~'),
    skipped: c.dim('-'),
    failed: c.red(sym.bad),
    dead: c.red(sym.bad),
  };
  for (const row of report) {
    const mark = row.warn ? c.yellow(sym.warn) : (icon[row.action] ?? ' ');
    console.log(`${mark} ${row.name.padEnd(18)} ${c.dim(row.action)}  ${row.reason}`);
  }
}

function logReport(report) {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    const stamp = new Date().toISOString();
    const lines = report.map((r) => `${stamp}  ${r.name}  ${r.action}  ${r.reason}`).join('\n');
    if (lines) fs.appendFileSync(path.join(logsDir(), 'keepalive.log'), `${lines}\n`, 'utf8');
  } catch {
    /* logging must not break the job */
  }
}

// ------------------------------------------------------------ scheduled task

function cliEntry() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'ccp.js');
}

export function installTask({ atTime = '13:00' } = {}) {
  const command = `"${process.execPath}" "${cliEntry()}" daemon run --quiet`;
  const result = spawnSync(
    'schtasks',
    ['/Create', '/F', '/SC', 'DAILY', '/TN', TASK_NAME, '/TR', command, '/ST', atTime],
    { encoding: 'utf8', windowsHide: true, shell: false },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'schtasks failed').trim());
  }
  console.log(`${c.green(sym.ok)} scheduled daily keep-alive at ${atTime}`);
  console.log(c.dim(`  task: ${TASK_NAME}`));
  console.log(c.dim(`  log:  ${path.join(logsDir(), 'keepalive.log')}`));
}

export function uninstallTask() {
  const result = spawnSync('schtasks', ['/Delete', '/F', '/TN', TASK_NAME], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'schtasks failed').trim());
  }
  console.log(`${c.green(sym.ok)} keep-alive task removed`);
}

export function taskStatus() {
  const result = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) {
    console.log(c.dim(`keep-alive task not installed -- run ${c.cyan('ccp daemon install')}`));
    return;
  }
  console.log(result.stdout.trim());
}

import path from 'node:path';

import { readCredentials, tokenHealth, writeCredentials } from '../credentials.js';
import { defaultProfileInfo, isDefaultName } from '../default-profile.js';
import { readJson, writeJsonAtomic } from '../json-file.js';
import { refreshCredentials } from '../oauth.js';
import { ccpRoot, credentialsPath, storeCredentials } from '../paths.js';
import { listProfileNames, profileExists, readMeta, updateMeta } from '../store.js';
import { fetchUsage, headline, resetsIn, severityOf } from '../usage.js';
import { c, sym, table } from '../ui.js';

/**
 * Where the default account's usage is cached.
 *
 * Stored profiles keep this in their own meta.json, but ~/.claude is read-only
 * to us, so its cache lives alongside our other notes about it.
 */
const defaultUsageFile = () => path.join(ccpRoot(), 'default-usage.json');

function readCache(name) {
  if (isDefaultName(name)) return readJson(defaultUsageFile(), null);
  return readMeta(name)?.usage ?? null;
}

function writeCache(name, usage) {
  try {
    if (isDefaultName(name)) writeJsonAtomic(defaultUsageFile(), usage, { mode: 0o600 });
    else updateMeta(name, { usage });
  } catch {
    /* a display cache must never break the command */
  }
}

function ageMs(usage) {
  const t = usage?.fetchedAt ? Date.parse(usage.fetchedAt) : NaN;
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

/**
 * Usage for one account, refreshing its token first if that is allowed.
 *
 * `maxAge` in seconds: 0 always goes to the network, which is what a human
 * typing `ccp usage` expects. The VS Code extension passes a few minutes so a
 * status bar redraw does not mean a request every time.
 */
export async function usageFor(name, { maxAge = 0 } = {}) {
  const isDefault = isDefaultName(name);

  const cached = readCache(name);
  if (cached && ageMs(cached) < maxAge * 1000) {
    return { name, usage: cached, source: 'cache' };
  }

  const credsPath = isDefault ? credentialsPath({}) : storeCredentials(name);
  let creds = readCredentials(credsPath);
  if (!creds?.claudeAiOauth) {
    return { name, usage: null, error: 'not signed in' };
  }

  const health = tokenHealth(creds);
  if (health.accessExpired) {
    if (isDefault) {
      // Refreshing would rotate the live refresh token, which is precisely the
      // thing this tool promises not to do to ~/.claude. Report what we have.
      return {
        name,
        usage: cached,
        source: cached ? 'stale cache' : undefined,
        error: 'access token lapsed -- ccp will not refresh ~/.claude',
      };
    }
    try {
      const { creds: refreshed } = await refreshCredentials(creds);
      writeCredentials(credsPath, refreshed);
      creds = refreshed;
    } catch (err) {
      return { name, usage: cached, error: `token refresh failed: ${err.message}` };
    }
  }

  try {
    const usage = await fetchUsage(creds.claudeAiOauth.accessToken);
    writeCache(name, usage);
    return { name, usage, source: 'live' };
  } catch (err) {
    return { name, usage: cached, source: cached ? 'stale cache' : undefined, error: err.message };
  }
}

function percentCell(win, label) {
  if (!win) return c.grey('-');
  const text = `${win.percent}%`;
  const colour =
    severityOf(win.percent) === 'critical'
      ? c.red
      : severityOf(win.percent) === 'warning'
        ? c.yellow
        : c.green;
  return `${colour(text.padStart(4))} ${c.dim(label)}`;
}

/** All accounts, or one named account, with their quota. */
export async function usage(name, { json = false, maxAge = 0 } = {}) {
  const names = name
    ? [name]
    : [
        ...(defaultProfileInfo().hasCredentials ? ['default'] : []),
        ...listProfileNames(),
      ];

  if (name && !isDefaultName(name) && !profileExists(name)) {
    throw new Error(`no such profile "${name}"`);
  }
  if (!names.length) {
    console.log(c.dim('no accounts yet -- run `ccp login <name>`'));
    return;
  }

  // Independent requests, so there is no reason to wait for them in turn.
  const results = await Promise.all(names.map((n) => usageFor(n, { maxAge })));

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const rows = [
    [c.dim('ACCOUNT'), c.dim('SESSION'), c.dim('WEEK'), c.dim('OPUS'), c.dim('RESETS')].map((h) =>
      c.bold(h),
    ),
  ];

  for (const r of results) {
    if (!r.usage) {
      rows.push([c.bold(r.name), c.red(r.error ?? 'unavailable'), '', '', '']);
      continue;
    }
    const worst = headline(r.usage);
    rows.push([
      c.bold(r.name),
      percentCell(r.usage.fiveHour, '5h'),
      percentCell(r.usage.sevenDay, '7d'),
      r.usage.opus ? percentCell(r.usage.opus, '') : c.grey('-'),
      c.dim(resetsIn(worst?.resetsAt) ?? ''),
    ]);
  }

  console.log('');
  console.log(table(rows));
  console.log('');

  for (const r of results) {
    if (r.usage && r.error) {
      console.log(`  ${c.yellow(sym.warn)} ${r.name}: ${r.error}`);
    }
    if (r.source === 'stale cache') {
      console.log(c.dim(`  ${r.name}: showing the last known figures, not live`));
    }
  }

  const blocked = results.filter((r) => headline(r.usage)?.percent >= 100);
  const free = results.filter((r) => r.usage && headline(r.usage).percent < 75);
  if (blocked.length && free.length) {
    console.log(
      `  ${blocked.map((r) => c.bold(r.name)).join(', ')} out of quota -- ` +
        `${c.cyan(`ccp bind ${free[0].name}`)} has room`,
    );
  }
}

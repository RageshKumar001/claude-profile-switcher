import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { authStatus, resolveClaudeBinary } from '../claude-cli.js';
import { loadBindings, resolveBinding } from '../bindings.js';
import { readJson } from '../json-file.js';
import { readCredentials } from '../credentials.js';
import {
  bindingsIndex,
  claudeConfigDir,
  claudeConfigFile,
  credentialsPath,
  shimExe,
  storeDir,
} from '../paths.js';
import { defaultProfileDir, defaultProfileInfo, isDefaultName } from '../default-profile.js';
import { listProfiles, profileExists } from '../store.js';
import { c, healthLabel, sym } from '../ui.js';
import { candidateSettingsPaths, readSetting } from '../vscode-settings.js';

const WRAPPER_KEY = 'claudeCode.claudeProcessWrapper';

/**
 * Assert every assumption this tool makes about Claude Code's internals.
 *
 * Nothing here is a supported API -- it was all read out of the shipped binary.
 * A Claude Code update can invalidate any of it, so doctor exists to say
 * exactly what changed rather than let the tool corrupt state quietly.
 */
export function doctor() {
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail });

  // --- Claude Code itself -------------------------------------------------
  let binary;
  try {
    binary = resolveClaudeBinary();
    const version = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 20_000,
    });
    add('ok', 'claude binary', `${binary} ${c.dim((version.stdout ?? '').trim())}`);
  } catch (err) {
    add('fail', 'claude binary', err.message);
  }

  // --- Credential storage assumptions -------------------------------------
  const credFile = credentialsPath({});
  if (fs.existsSync(credFile)) {
    const creds = readCredentials(credFile);
    if (creds?.claudeAiOauth) {
      add('ok', 'default credentials', credFile);
    } else {
      add('warn', 'default credentials', `${credFile} exists but has no claudeAiOauth key`);
    }
  } else {
    add('warn', 'default credentials', `${credFile} not found -- is anything logged in?`);
  }

  const configFile = claudeConfigFile({});
  add(
    fs.existsSync(configFile) ? 'ok' : 'warn',
    'config file',
    `${configFile}${fs.existsSync(configFile) ? '' : ' (missing)'}`,
  );

  // --- The remote kill switch ---------------------------------------------
  // If Anthropic flips tengu_windows_credman, credentials move into Windows
  // Credential Manager and every file-based approach here stops working.
  const config = readJson(configFile, {});
  const credman = config?.cachedGrowthBookFeatures?.tengu_windows_credman;
  if (credman === true) {
    add(
      'fail',
      'credential backend',
      'tengu_windows_credman is ENABLED -- Claude Code now stores credentials in Windows Credential Manager, not files. This tool cannot bind accounts until it grows a credman backend.',
    );
  } else {
    add('ok', 'credential backend', `plaintext file (tengu_windows_credman=${credman ?? 'unset'})`);
  }

  // --- Shared identity block -----------------------------------------------
  // oauthAccount lives in ~/.claude.json, which no store redirects, so any
  // `claude auth login` into another store overwrites it. Claude Code only
  // re-fetches identity when the block is incomplete, so a complete-but-wrong
  // one is never self-corrected -- worth naming rather than leaving as a
  // mystery when /status disagrees with the status bar.
  const fallback = defaultProfileInfo();
  if (fallback.identityVerified === false) {
    add(
      'warn',
      'shared identity',
      "~/.claude.json describes a different account than ~/.claude's credentials. " +
        'Authentication is unaffected; /status and any tool reading that block will ' +
        'name the wrong account until the default account signs in again.',
    );
  } else if (fallback.hasCredentials) {
    add('ok', 'shared identity', fallback.meta.email ?? 'matches the default credentials');
  }

  // --- Shim ----------------------------------------------------------------
  if (fs.existsSync(shimExe())) {
    add('ok', 'shim', `${shimExe()} ${c.dim(`(${fs.statSync(shimExe()).size} bytes)`)}`);
  } else {
    add('fail', 'shim', `not built -- run ${c.cyan('ccp setup')}`);
  }

  const editors = candidateSettingsPaths();
  if (!editors.length) {
    add('warn', 'vs code', 'no settings.json found for any VS Code flavour');
  }
  for (const { flavour, file } of editors) {
    const wrapper = readSetting(file, WRAPPER_KEY);
    if (wrapper === shimExe()) add('ok', `vs code (${flavour})`, 'wrapper configured');
    else if (!wrapper) add('warn', `vs code (${flavour})`, `wrapper not set -- run ${c.cyan('ccp setup')}`);
    else add('warn', `vs code (${flavour})`, `wrapper points elsewhere: ${wrapper}`);
  }

  // --- Bindings -------------------------------------------------------------
  const { bindings } = loadBindings();
  const bindingCount = Object.keys(bindings).length;
  const indexExists = fs.existsSync(bindingsIndex());
  if (!indexExists && bindingCount) {
    add('fail', 'bindings index', `missing -- run ${c.cyan('ccp setup')} to regenerate`);
  } else {
    const indexLines = indexExists
      ? fs.readFileSync(bindingsIndex(), 'utf8').split('\n').filter(Boolean).length
      : 0;
    if (indexLines !== bindingCount) {
      add(
        'warn',
        'bindings index',
        `${bindingCount} binding(s) but ${indexLines} indexed -- some profiles may be missing`,
      );
    } else {
      add('ok', 'bindings index', `${bindingCount} binding(s)`);
    }
  }

  for (const [key, value] of Object.entries(bindings)) {
    if (isDefaultName(value.profile)) continue; // ~/.claude, checked above
    if (!profileExists(value.profile)) {
      add('fail', 'binding', `${value.displayPath ?? key} -> missing profile "${value.profile}"`);
    }
  }

  // --- Profiles -------------------------------------------------------------
  for (const profile of listProfiles()) {
    if (!profile.hasCredentials) {
      add('fail', `profile ${profile.name}`, `no credentials -- run ${c.cyan(`ccp login ${profile.name}`)}`);
      continue;
    }
    const level =
      profile.health.state === 'expired'
        ? 'fail'
        : profile.health.state === 'expiring'
          ? 'warn'
          : 'ok';
    add(level, `profile ${profile.name}`, `${profile.meta.email ?? '?'}  ${healthLabel(profile.health)}`);
  }

  // --- Report ---------------------------------------------------------------
  const icon = { ok: c.green(sym.ok), warn: c.yellow(sym.warn), fail: c.red(sym.bad) };
  for (const { level, label, detail } of results) {
    console.log(`${icon[level]} ${label.padEnd(24)} ${detail}`);
  }

  const failures = results.filter((r) => r.level === 'fail').length;
  const warnings = results.filter((r) => r.level === 'warn').length;
  console.log('');
  console.log(
    failures
      ? c.red(`${failures} failure(s), ${warnings} warning(s)`)
      : warnings
        ? c.yellow(`no failures, ${warnings} warning(s)`)
        : c.green('all checks passed'),
  );

  if (failures) process.exitCode = 1;
}

/** What the shim would do for a directory, without launching anything. */
export function explain(cwd = process.cwd()) {
  const match = resolveBinding(cwd);
  console.log(`${c.dim('cwd')}      ${cwd}`);
  console.log(`${c.dim('config')}   ${claudeConfigDir({})}`);
  if (!match) {
    console.log(`${c.dim('resolves')} ${c.yellow('default account (no binding matches)')}`);
    return;
  }
  const isDefault = isDefaultName(match.profile);
  const dir = isDefault ? defaultProfileDir() : storeDir(match.profile);
  console.log(`${c.dim('matched')}  ${match.key}`);
  console.log(
    `${c.dim('profile')}  ${c.bold(match.profile)}${isDefault ? c.dim(' (the live ~/.claude login)') : ''}`,
  );
  console.log(`${c.dim('store')}    ${credentialsPath({ CLAUDE_SECURESTORAGE_CONFIG_DIR: dir })}`);
  const status = authStatus(dir);
  console.log(
    `${c.dim('identity')} ${status.loggedIn ? c.green(status.email ?? 'logged in') : c.red(status.error ?? 'not logged in')}`,
  );
}

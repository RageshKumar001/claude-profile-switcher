import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { resolveBinding } from '../bindings.js';
import { readCredentials } from '../credentials.js';
import { defaultProfileDir, defaultProfileInfo, isDefaultName } from '../default-profile.js';
import { storeCredentials, storeDir } from '../paths.js';
import { profileExists, touchUsed } from '../store.js';
import { isSealed, unsealIfNeeded } from './seal.js';
import { c, sym } from '../ui.js';

/**
 * Run things as a profile without VS Code.
 *
 * The shim only covers processes VS Code launches. Everything else -- a plain
 * terminal, a script, another editor -- had no way in. These two commands are
 * that way in, and they do exactly what the shim does: point
 * CLAUDE_SECURESTORAGE_CONFIG_DIR at a store and exec.
 */

/**
 * Which store a name (or the current directory) resolves to.
 *
 * Exported and free of side effects so the resolution rules can be tested
 * without spawning anything.
 */
export function resolveProfileTarget({ name, cwd = process.cwd() } = {}) {
  if (name) {
    if (isDefaultName(name)) {
      return { name: 'default', dir: defaultProfileDir(), isDefault: true, source: 'argument' };
    }
    if (!profileExists(name)) {
      throw new Error(`no such profile "${name}" -- run \`ccp ls\` to see what exists`);
    }
    return { name, dir: storeDir(name), isDefault: false, source: 'argument' };
  }

  const bound = resolveBinding(cwd);
  if (!bound) {
    return { name: 'default', dir: defaultProfileDir(), isDefault: true, source: 'unbound' };
  }
  if (isDefaultName(bound.profile)) {
    return { name: 'default', dir: defaultProfileDir(), isDefault: true, source: 'binding' };
  }
  if (!profileExists(bound.profile)) {
    throw new Error(
      `this directory is bound to "${bound.profile}", which no longer exists -- ` +
        'run `ccp bind <name>` to point it somewhere real',
    );
  }
  return { name: bound.profile, dir: storeDir(bound.profile), isDefault: false, source: 'binding' };
}

/** Prepare a store for use and return the environment to launch with. */
function prepare(target, { quiet = false } = {}) {
  if (!target.isDefault && isSealed(target.name)) {
    unsealIfNeeded(target.name);
    if (!quiet) console.log(c.dim(`  unsealed ${target.name}`));
  }

  const creds = target.isDefault
    ? defaultProfileInfo().hasCredentials
    : Boolean(readCredentials(storeCredentials(target.name))?.claudeAiOauth);

  if (!creds && !quiet) {
    console.log(
      `${c.yellow(sym.warn)} ${target.name} has no credentials -- \`ccp login ${target.name}\` first`,
    );
  }

  if (!target.isDefault) touchUsed(target.name);

  return {
    ...process.env,
    // Always overwrite. The variable is frequently already present and set to
    // "" by the VS Code SDK, and "" means ~/.claude rather than "unset".
    CLAUDE_SECURESTORAGE_CONFIG_DIR: target.dir,
    // Purely informational, for prompts and scripts that want to show it.
    CCP_PROFILE: target.name,
  };
}

/** Forward the child's exit status as our own, signals included. */
function follow(child) {
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`${c.red(sym.bad)} ${err.message}`);
    process.exitCode = 1;
  });
}

export function exec(name, command, { cwd = process.cwd() } = {}) {
  if (!command?.length) {
    throw new Error('nothing to run -- usage: ccp exec [profile] -- <command> [args...]');
  }

  const target = resolveProfileTarget({ name, cwd });
  const env = prepare(target, { quiet: true });

  follow(spawn(command[0], command.slice(1), { env, cwd, stdio: 'inherit', shell: false }));
}

// ------------------------------------------------------------------- shell

/** First match for `name` on PATH, honouring PATHEXT on Windows. */
function resolveOnPath(name) {
  const exts =
    process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * The shell to nest. CCP_SHELL wins so anyone with a preference can set it;
 * otherwise PowerShell 7 if installed, Windows PowerShell if not, and $SHELL
 * elsewhere.
 */
export function pickShell() {
  if (process.env.CCP_SHELL) return { command: process.env.CCP_SHELL, kind: 'custom' };
  if (process.platform === 'win32') {
    const pwsh = resolveOnPath('pwsh');
    if (pwsh) return { command: pwsh, kind: 'powershell' };
    return { command: 'powershell.exe', kind: 'powershell' };
  }
  return { command: process.env.SHELL || '/bin/bash', kind: 'posix' };
}

export function shell(name, { cwd = process.cwd() } = {}) {
  if (process.env.CCP_PROFILE) {
    console.log(
      `${c.yellow(sym.warn)} already in a ccp shell for ${c.bold(process.env.CCP_PROFILE)}`,
    );
    console.log(c.dim('  `exit` first, or use `ccp exec` for a one-off command'));
    return;
  }

  const target = resolveProfileTarget({ name, cwd });

  console.log(`${c.dim('account')}  ${c.bold(target.name)}  ${c.dim(target.dir)}`);
  const env = prepare(target);
  console.log(c.dim(`  nested shell -- type 'exit' to come back`));
  console.log('');

  const { command, kind } = pickShell();
  const args = [];

  if (kind === 'powershell') {
    // Make the nesting visible. Forgetting which shell you are in is the whole
    // failure mode of this command, so the prompt has to say so.
    //
    // This is the one place a profile name is interpolated into something a
    // shell evaluates. assertValidProfileName already limits names to
    // [A-Za-z0-9._-], but that runs at creation time and this reads whatever is
    // on disk -- so re-check here rather than trust it.
    const label = /^[A-Za-z0-9._-]{1,64}$/.test(target.name) ? target.name : 'profile';
    args.push(
      '-NoLogo',
      '-NoExit',
      '-Command',
      `function global:prompt { "[ccp:${label}] PS " + (Get-Location) + "> " }`,
    );
  } else if (kind === 'posix') {
    args.push('-i');
  }

  follow(spawn(command, args, { env, cwd, stdio: 'inherit', shell: false }));
}

/** `ccp env <name>` -- for scripts and CI that want the value, not a process. */
export function printEnv(name, { cwd = process.cwd() } = {}) {
  const target = resolveProfileTarget({ name, cwd });
  if (process.platform === 'win32') {
    // Single quotes, doubled to escape. PowerShell has no backslash escapes, so
    // JSON.stringify would emit C:\\Users\\... and set a literally wrong path.
    console.log(
      `$env:CLAUDE_SECURESTORAGE_CONFIG_DIR = '${target.dir.replace(/'/g, "''")}'`,
    );
  } else {
    // Single quotes, with any embedded quote closed and re-opened -- the usual
    // POSIX trick, so a path with spaces or quotes survives `eval`.
    console.log(
      `export CLAUDE_SECURESTORAGE_CONFIG_DIR='${target.dir.replace(/'/g, `'\\''`)}'`,
    );
  }
}

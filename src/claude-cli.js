import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let cached;

/**
 * Locate the real Claude Code executable.
 *
 * Resolved explicitly rather than relying on `shell: true`, because every spawn
 * here passes user-controlled paths and shell quoting on Windows is a foot-gun.
 */
export function resolveClaudeBinary() {
  if (cached) return cached;

  const candidates = [];
  if (process.env.CCP_CLAUDE_BIN) candidates.push(process.env.CCP_CLAUDE_BIN);
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'));

  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) candidates.push(path.join(dir, `claude${ext}`));
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        cached = candidate;
        return cached;
      }
    } catch {
      /* keep looking */
    }
  }
  throw new Error('could not locate the claude executable (set CCP_CLAUDE_BIN)');
}

/**
 * Ask Claude Code who a given credential store is logged in as.
 *
 * Uses the CLI's own `auth status --json` rather than decoding the JWT, so we
 * inherit its notion of identity instead of reimplementing it.
 *
 * Returns { loggedIn, authMethod, email, orgId, orgName, subscriptionType }.
 */
export function authStatus(storeDirPath, { timeout = 30_000 } = {}) {
  const env = { ...process.env };
  if (storeDirPath) env.CLAUDE_SECURESTORAGE_CONFIG_DIR = storeDirPath;
  else delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;

  const result = spawnSync(resolveClaudeBinary(), ['auth', 'status', '--json'], {
    env,
    timeout,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });

  if (result.error) return { loggedIn: false, error: result.error.message };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      loggedIn: false,
      error: (result.stderr || result.stdout || 'unparseable auth status').trim().slice(0, 300),
    };
  }
}

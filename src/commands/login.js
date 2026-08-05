import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { resolveClaudeBinary } from '../claude-cli.js';
import { applyAccount, extractAccount, readCredentials, writeCredentials } from '../credentials.js';
import { defaultProfileInfo } from '../default-profile.js';
import { syncMcpOAuth } from '../mcp-sync.js';
import { credentialsPath, storeCredentials, storeDir } from '../paths.js';
import { createProfile, profileExists, refreshIdentity } from '../store.js';
import { c, sym } from '../ui.js';

/**
 * Add an account by logging in directly into its own credential store.
 *
 * This is the preferred way to add accounts: the browser login mints a token
 * pair that belongs to this store alone, and ~/.claude is never touched.
 */
export function login(name, { timeout = 10 * 60_000 } = {}) {
  const fresh = !profileExists(name);
  if (fresh) createProfile(name);

  // Claude's own login rewrites the identity block in the SHARED ~/.claude.json,
  // which no store redirects. Reading the default profile here caches that
  // identity while it is still correct, so the account can be named afterwards.
  // Credentials are unaffected -- only the display block moves.
  const before = defaultProfileInfo();

  const dir = storeDir(name);
  console.log(`${c.dim('store')}  ${dir}`);
  console.log(c.dim('opening browser login -- ~/.claude credentials are not modified'));
  if (before.hasCredentials) {
    console.log(
      c.dim('this does overwrite the shared identity block Claude shows in /status,'),
    );
    console.log(
      c.dim(`so it will name ${name} until the default account signs in again`),
    );
  }
  console.log('');

  const result = spawnSync(resolveClaudeBinary(), ['auth', 'login'], {
    env: { ...process.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir },
    stdio: 'inherit',
    timeout,
    windowsHide: true,
    shell: false,
  });

  if (result.status !== 0) {
    if (fresh) fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`login failed (exit ${result.status ?? 'signal'})`);
  }

  const meta = refreshIdentity(name);
  if (!meta.loggedIn) {
    throw new Error('login reported success but the store has no usable credentials');
  }

  console.log('');
  console.log(`${c.green(sym.ok)} ${c.bold(name)}  ${meta.email ?? ''} ${c.dim(meta.subscriptionType ?? '')}`);

  const sync = syncMcpOAuth();
  if (sync.changed.length) {
    console.log(c.dim(`  synced ${sync.servers} MCP logins into ${sync.changed.length} store(s)`));
  }
  console.log('');
  console.log(`  Bind a project to it:  ${c.cyan(`ccp bind ${name}`)}`);
}

/**
 * Capture the account currently logged into ~/.claude as a profile.
 *
 * Convenient, but it copies an existing token pair rather than minting a new
 * one, so two stores end up holding the same refresh token -- and refresh
 * tokens ARE rotated on use (observed directly: a keep-alive refresh returned
 * a different refresh token). So the two copies diverge the first time either
 * one refreshes. `ccp login` mints an independent pair and avoids this.
 */
export function save(name, { force = false } = {}) {
  if (profileExists(name) && !force) {
    throw new Error(`profile "${name}" already exists (use --force to overwrite)`);
  }

  const globalCreds = readCredentials(credentialsPath({}));
  const account = extractAccount(globalCreds);
  if (!account?.claudeAiOauth) {
    throw new Error('~/.claude has no account logged in -- nothing to save');
  }

  if (!profileExists(name)) createProfile(name);
  const target = storeCredentials(name);
  writeCredentials(target, applyAccount(readCredentials(target), account));

  const meta = refreshIdentity(name);
  console.log(`${c.green(sym.ok)} saved ${c.bold(name)}  ${meta.email ?? ''}`);
  console.log('');
  console.log(
    `${c.yellow(sym.warn)} This copied the existing token rather than minting a new one.`,
  );
  console.log(
    c.dim('  Both ~/.claude and this profile now hold the same refresh token, and'),
  );
  console.log(
    c.dim('  refresh tokens rotate on use -- so whichever refreshes first leaves the'),
  );
  console.log(
    c.dim('  other holding a spent token. `ccp login` mints a separate pair instead.'),
  );
}

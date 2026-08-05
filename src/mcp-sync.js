import fs from 'node:fs';

import { credentialsPath } from './paths.js';
import { readCredentials, writeCredentials } from './credentials.js';
import { listProfileNames, profileCredentialsPath } from './store.js';

/**
 * MCP server logins live inside .credentials.json, so giving each project its
 * own credential store also gives it its own MCP logins -- verified: a fresh
 * store came back containing only an mcpOAuth block. Left alone, you would
 * re-authenticate every MCP server once per account.
 *
 * These logins are not account-scoped, so we treat them as shared state and
 * replicate the best-known entry for each server into every store.
 */

function sourceFiles() {
  const files = [{ file: credentialsPath({}), label: 'global', writable: false }];
  for (const name of listProfileNames()) {
    files.push({ file: profileCredentialsPath(name), label: name, writable: true });
  }
  return files;
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Pick the best entry per server key across all stores.
 *
 * Entries carry no timestamps, so file mtime is the tiebreak. An entry holding
 * a non-empty accessToken always beats one without, because a blank token means
 * discovery happened but the login did not.
 */
export function collectBestMcpOAuth() {
  const best = new Map();

  for (const source of sourceFiles()) {
    const creds = readCredentials(source.file);
    const block = creds?.mcpOAuth;
    if (!block) continue;
    const mtime = mtimeOf(source.file);

    for (const [server, entry] of Object.entries(block)) {
      const hasToken = Boolean(entry?.accessToken);
      const current = best.get(server);
      if (!current) {
        best.set(server, { entry, mtime, hasToken });
        continue;
      }
      const better =
        (hasToken && !current.hasToken) ||
        (hasToken === current.hasToken && mtime > current.mtime);
      if (better) best.set(server, { entry, mtime, hasToken });
    }
  }

  return Object.fromEntries([...best].map(([server, v]) => [server, v.entry]));
}

/**
 * Replicate the merged MCP logins into every profile store.
 *
 * The global store is read as a source but never written -- the whole design
 * promise is that binding never modifies ~/.claude.
 */
export function syncMcpOAuth({ dryRun = false } = {}) {
  const merged = collectBestMcpOAuth();
  const servers = Object.keys(merged);
  const changed = [];

  if (!servers.length) return { servers: 0, changed };

  for (const name of listProfileNames()) {
    const file = profileCredentialsPath(name);
    const creds = readCredentials(file);
    if (!creds) continue; // never create a store just to seed MCP state

    const before = JSON.stringify(creds.mcpOAuth ?? {});
    const after = JSON.stringify(merged);
    if (before === after) continue;

    changed.push(name);
    if (!dryRun) writeCredentials(file, { ...creds, mcpOAuth: merged });
  }

  return { servers: servers.length, changed };
}

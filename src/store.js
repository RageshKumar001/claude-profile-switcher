import fs from 'node:fs';
import path from 'node:path';

import { authStatus } from './claude-cli.js';
import { readCredentials, tokenHealth } from './credentials.js';
import { readJson, writeJsonAtomic } from './json-file.js';
import {
  assertValidProfileName,
  storeCredentials,
  storeDir,
  storeMeta,
  storeRoot,
} from './paths.js';

export function listProfileNames() {
  try {
    return fs
      .readdirSync(storeRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function profileExists(name) {
  try {
    return fs.statSync(storeDir(name)).isDirectory();
  } catch {
    return false;
  }
}

export function createProfile(name) {
  assertValidProfileName(name);
  if (profileExists(name)) throw new Error(`profile "${name}" already exists`);
  fs.mkdirSync(storeDir(name), { recursive: true });
  writeMeta(name, { name, createdAt: new Date().toISOString() });
  return storeDir(name);
}

export function readMeta(name) {
  return readJson(storeMeta(name), { name });
}

export function writeMeta(name, meta) {
  writeJsonAtomic(storeMeta(name), meta, { mode: 0o600 });
  return meta;
}

export function updateMeta(name, patch) {
  return writeMeta(name, { ...readMeta(name), ...patch });
}

/**
 * Re-read a profile's identity from Claude Code itself and cache it in meta.
 * Costs one CLI invocation, so callers decide when it is worth doing.
 */
export function refreshIdentity(name) {
  const status = authStatus(storeDir(name));
  const patch = {
    loggedIn: Boolean(status.loggedIn),
    email: status.email ?? null,
    orgId: status.orgId ?? null,
    orgName: status.orgName ?? null,
    subscriptionType: status.subscriptionType ?? null,
    authMethod: status.authMethod ?? null,
    identityCheckedAt: new Date().toISOString(),
  };
  if (status.error) patch.lastError = status.error;
  else delete patch.lastError;
  return updateMeta(name, patch);
}

/**
 * Everything needed to render one row of `ccp ls`, without spawning the CLI.
 * Identity comes from cached meta; token state is read live off disk.
 */
export function profileInfo(name) {
  const meta = readMeta(name);
  const creds = readCredentials(storeCredentials(name));
  return {
    name,
    dir: storeDir(name),
    meta,
    health: tokenHealth(creds),
    hasCredentials: Boolean(creds?.claudeAiOauth),
  };
}

export function listProfiles() {
  return listProfileNames().map(profileInfo);
}

export function removeProfile(name) {
  if (!profileExists(name)) return false;
  fs.rmSync(storeDir(name), { recursive: true, force: true });
  return true;
}

export function touchUsed(name) {
  return updateMeta(name, { lastUsedAt: new Date().toISOString() });
}

export function profileCredentialsPath(name) {
  return path.join(storeDir(name), '.credentials.json');
}

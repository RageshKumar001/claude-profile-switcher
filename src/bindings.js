import fs from 'node:fs';
import path from 'node:path';

import { bindingsIndex, bindingsJson, storeDir } from './paths.js';
import { defaultProfileDir, isDefaultName } from './default-profile.js';
import { readJson, writeJsonAtomic, writeTextAtomic } from './json-file.js';

const isWindows = process.platform === 'win32';

/**
 * Canonical form for prefix comparison. Windows paths are case-insensitive and
 * mix separators, so both sides of every comparison go through this.
 */
export function normalizeProjectPath(p) {
  let out = path.resolve(p);
  if (isWindows) out = out.replace(/\//g, '\\').toLowerCase();
  // Drop a trailing separator, but keep it for drive roots ("c:\").
  if (out.length > 3 && (out.endsWith('\\') || out.endsWith('/'))) out = out.slice(0, -1);
  return out;
}

/** True when `child` is `parent` or lives beneath it, respecting path boundaries. */
export function isUnder(child, parent) {
  if (child === parent) return true;
  const sep = isWindows ? '\\' : '/';
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

export function loadBindings() {
  return readJson(bindingsJson(), { version: 1, bindings: {} });
}

export function saveBindings(data) {
  writeJsonAtomic(bindingsJson(), data, { mode: 0o600 });
  writeShimIndex(data);
}

export function setBinding(projectPath, profileName) {
  const data = loadBindings();
  const key = normalizeProjectPath(projectPath);
  data.bindings[key] = {
    profile: profileName,
    // Kept for display; the key is already normalised beyond recognition.
    displayPath: path.resolve(projectPath),
    boundAt: new Date().toISOString(),
  };
  saveBindings(data);
  return data.bindings[key];
}

export function removeBinding(projectPath) {
  const data = loadBindings();
  const key = normalizeProjectPath(projectPath);
  const existed = key in data.bindings;
  delete data.bindings[key];
  saveBindings(data);
  return existed;
}

/**
 * Longest-prefix match, so a binding on a subfolder beats one on its parent.
 */
export function resolveBinding(cwd, data = loadBindings()) {
  const target = normalizeProjectPath(cwd);
  let best = null;
  for (const [key, value] of Object.entries(data.bindings)) {
    if (!isUnder(target, key)) continue;
    if (!best || key.length > best.key.length) best = { key, ...value };
  }
  return best;
}

/**
 * Write the flat index the shim reads.
 *
 * Deliberately not JSON. The shim sits in front of every Claude launch in every
 * window, so it must never fail in a way that stops Claude starting. A
 * tab-separated file with one binding per line needs no parser, cannot throw on
 * malformed input, and degrades to "no match" instead of an exception.
 *
 * Sorted longest-prefix-first so the shim can take the first match and stop.
 */
export function writeShimIndex(data = loadBindings()) {
  const rows = Object.entries(data.bindings)
    .map(([key, value]) => ({
      key,
      // "default" is the live login, so it resolves to ~/.claude -- which is
      // where the shim would have left Claude Code looking anyway. Writing the
      // row anyway keeps the binding explicit and survivable.
      dir: isDefaultName(value.profile) ? defaultProfileDir() : storeDir(value.profile),
      profile: value.profile,
    }))
    .filter((row) => fs.existsSync(row.dir))
    .sort((a, b) => b.key.length - a.key.length);

  const body = rows.map((r) => `${r.key}\t${r.dir}\t${r.profile}`).join('\n');
  writeTextAtomic(bindingsIndex(), body ? `${body}\n` : '', { mode: 0o600 });
  return rows.length;
}

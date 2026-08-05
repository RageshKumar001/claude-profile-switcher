import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * VS Code's settings.json is JSONC -- comments and trailing commas are legal,
 * and users have them. So we never reserialise the file: we do a targeted
 * textual edit of a single key and leave every other byte alone.
 */

export function settingsPath({ flavour = 'Code' } = {}) {
  const appData =
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, flavour, 'User', 'settings.json');
}

/** Known VS Code-family install locations, so `ccp setup` can find them all. */
export function candidateSettingsPaths() {
  return ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf']
    .map((flavour) => ({ flavour, file: settingsPath({ flavour }) }))
    .filter((entry) => fs.existsSync(entry.file));
}

export function readSetting(file, key) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const match = text.match(keyPattern(key));
  if (!match) return undefined;
  try {
    return JSON.parse(match[2]);
  } catch {
    return undefined;
  }
}

/**
 * Set one string setting, preserving comments and formatting.
 * Returns { changed, backup } -- backup is null when nothing needed changing.
 */
export function writeSetting(file, key, value) {
  const encoded = JSON.stringify(value);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{\n  ${JSON.stringify(key)}: ${encoded}\n}\n`, 'utf8');
    return { changed: true, backup: null, created: true };
  }

  const existing = text.match(keyPattern(key));
  if (existing && existing[2] === encoded) return { changed: false, backup: null };

  const backup = `${file}.ccp-backup`;
  fs.copyFileSync(file, backup);

  let updated;
  if (existing) {
    updated =
      text.slice(0, existing.index) +
      existing[1] +
      encoded +
      text.slice(existing.index + existing[0].length);
  } else {
    const brace = text.indexOf('{');
    if (brace === -1) throw new Error(`${file} does not look like a settings file`);
    const insertion = `\n  ${JSON.stringify(key)}: ${encoded},`;
    updated = text.slice(0, brace + 1) + insertion + text.slice(brace + 1);
  }

  fs.writeFileSync(file, updated, 'utf8');
  return { changed: true, backup };
}

// Captures: [1] everything up to the value, [2] the JSON-encoded value itself.
function keyPattern(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`("${escaped}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|null|true|false)`);
}

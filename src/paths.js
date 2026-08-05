import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code normalises config paths to NFC before use. We mirror that so our
// comparisons against its paths never diverge over Unicode composition.
const nfc = (p) => p.normalize('NFC');

/**
 * Mirrors Claude Code's config-dir resolution:
 *   CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
 */
export function claudeConfigDir(env = process.env) {
  return nfc(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'));
}

/**
 * Mirrors Claude Code's config-FILE resolution, including the `.config.json`
 * precedence rule:
 *   exists(<configDir>/.config.json) ? that
 *                                    : join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
 *
 * Note the second branch deliberately uses the raw env var, not configDir --
 * that asymmetry is Claude Code's, and copying it exactly matters.
 */
export function claudeConfigFile(env = process.env) {
  const dotConfig = path.join(claudeConfigDir(env), '.config.json');
  if (fs.existsSync(dotConfig)) return dotConfig;
  return path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

/**
 * Mirrors Claude Code's credential-store resolution:
 *   CLAUDE_SECURESTORAGE_CONFIG_DIR defined ? (value || ~/.claude)
 *                                           : configDir
 *
 * The empty-string case is load-bearing. The VS Code extension's SDK sets this
 * variable to "" when it has nothing better, and "" means "use the default",
 * not "use the current directory". It also means the variable is often already
 * defined in a child env -- so anything setting it must OVERWRITE rather than
 * set-if-absent.
 */
export function secureStorageDir(env = process.env) {
  const v = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (v !== undefined) return nfc(v || path.join(os.homedir(), '.claude'));
  return claudeConfigDir(env);
}

export function credentialsPath(env = process.env) {
  return path.join(secureStorageDir(env), '.credentials.json');
}

// ---------------------------------------------------------------- ccp's own

/** Kept outside ~/.claude so Claude Code's own cleanup never touches it. */
export function ccpRoot() {
  return process.env.CCP_HOME || path.join(os.homedir(), '.claude-profiles');
}

export const storeRoot = () => path.join(ccpRoot(), 'store');
export const storeDir = (name) => path.join(storeRoot(), name);
export const storeCredentials = (name) => path.join(storeDir(name), '.credentials.json');
export const storeMeta = (name) => path.join(storeDir(name), 'meta.json');
export const storeSealed = (name) => path.join(storeDir(name), 'credentials.dpapi');

export const bindingsJson = () => path.join(ccpRoot(), 'bindings.json');
/** Flat index the shim reads. See src/bindings.js for why it is not JSON. */
export const bindingsIndex = () => path.join(ccpRoot(), 'bindings.tsv');
export const stateJson = () => path.join(ccpRoot(), 'state.json');
export const logsDir = () => path.join(ccpRoot(), 'logs');
export const shimExe = () => path.join(ccpRoot(), 'bin', 'ccp-shim.exe');
/**
 * Written by `ccp setup`. Lets the VS Code extension find this CLI instead of
 * reimplementing binding logic -- one implementation, no drift.
 */
export const installManifest = () => path.join(ccpRoot(), 'install.json');

/**
 * Names that already mean something. "default" is the live ~/.claude login,
 * surfaced as a read-only profile -- a store by that name would shadow it.
 * Kept as a literal here rather than imported to avoid a cycle with
 * default-profile.js, which needs these path helpers.
 */
export const RESERVED_PROFILE_NAMES = new Set(['default']);

/** Profile names become directory names, so keep them boring. */
export function assertValidProfileName(name) {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      `invalid profile name ${JSON.stringify(name)} -- use letters, digits, dot, dash, underscore (max 64)`,
    );
  }
  if (RESERVED_PROFILE_NAMES.has(name.toLowerCase())) {
    throw new Error(
      `"${name}" is reserved -- it already refers to the account signed into ~/.claude`,
    );
  }
  return name;
}

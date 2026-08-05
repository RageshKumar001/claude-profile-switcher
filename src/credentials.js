import { readJson, writeJsonAtomic } from './json-file.js';

/**
 * Keys inside .credentials.json that identify the *account*. These move when a
 * profile moves.
 */
export const ACCOUNT_KEYS = ['claudeAiOauth', 'organizationUuid'];

/**
 * Keys that are NOT account-scoped and must survive an account swap.
 *
 * `mcpOAuth` holds per-MCP-server logins. Verified empirically: pointing
 * CLAUDE_SECURESTORAGE_CONFIG_DIR at an empty directory and starting Claude
 * produced a fresh .credentials.json containing only mcpOAuth entries. So MCP
 * logins are per-store, and writing a profile's whole credentials file over a
 * live one would silently roll those logins back.
 */
export const SHARED_KEYS = ['mcpOAuth'];

export function readCredentials(file) {
  return readJson(file, null);
}

/** The account-scoped slice of a credentials blob. */
export function extractAccount(creds) {
  if (!creds) return null;
  const account = {};
  for (const key of ACCOUNT_KEYS) {
    if (creds[key] !== undefined) account[key] = creds[key];
  }
  return Object.keys(account).length ? account : null;
}

/** The account-independent slice (MCP logins). */
export function extractShared(creds) {
  if (!creds) return {};
  const shared = {};
  for (const key of SHARED_KEYS) {
    if (creds[key] !== undefined) shared[key] = creds[key];
  }
  return shared;
}

/**
 * Produce the credentials blob to write: the incoming account's keys, on top of
 * whatever account-independent state is already live at the destination.
 */
export function applyAccount(liveCreds, account) {
  const out = { ...(liveCreds ?? {}) };
  for (const key of ACCOUNT_KEYS) {
    if (account?.[key] === undefined) delete out[key];
    else out[key] = account[key];
  }
  return out;
}

export function writeCredentials(file, creds) {
  const intended = creds?.claudeAiOauth;
  writeJsonAtomic(file, creds, {
    verify: (back) => {
      if (!intended) return true;
      const got = back?.claudeAiOauth;
      if (!got) return false;
      // Same account is what matters. A *newer* token for that account means
      // Claude Code refreshed underneath us -- that is a better value than
      // ours, so accept it rather than clobbering it.
      if (got.accessToken === intended.accessToken) return true;
      return Boolean(
        got.expiresAt && intended.expiresAt && got.expiresAt >= intended.expiresAt,
      );
    },
  });
}

/**
 * Token health for display and for deciding what the keep-alive job must touch.
 *
 * Access tokens last ~8h, measured on a live install and confirmed by the
 * `expiresAt` Claude Code writes.
 *
 * The refresh token's lifetime is NOT knowable from disk. Claude Code 2.1.167
 * writes claudeAiOauth as exactly
 *   { accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier }
 * -- the string "refreshTokenExpiresAt" does not appear anywhere in the binary,
 * and the write replaces the whole object, so any such key is dropped on the
 * next refresh. Where it does appear on disk it is a legacy value left by an
 * older version: usable if present, never expected.
 *
 * So an absent refresh deadline is the normal case, not a broken store, and
 * must not be read as "expired" -- that reported a working, minutes-old login
 * as dead. Unknown is reported as unknown, and judged on the access token.
 */
export function tokenHealth(creds, now = Date.now()) {
  const oauth = creds?.claudeAiOauth;
  if (!oauth) return { present: false, state: 'missing' };

  const accessMsLeft = (oauth.expiresAt ?? 0) - now;
  const accessExpired = accessMsLeft <= 0;

  const refreshExpiryKnown = Number.isFinite(oauth.refreshTokenExpiresAt);
  const refreshMsLeft = refreshExpiryKnown ? oauth.refreshTokenExpiresAt - now : null;

  let state;
  if (refreshExpiryKnown) {
    if (refreshMsLeft <= 0) state = 'expired';
    else if (refreshMsLeft < 3 * 24 * 3600 * 1000) state = 'expiring';
    else state = 'healthy';
  } else {
    // No refresh deadline recorded. A live access token proves the login works;
    // once it lapses we genuinely cannot tell without asking the server.
    state = accessExpired ? 'unknown' : 'healthy';
  }

  return {
    present: true,
    state,
    accessExpired,
    accessMsLeft,
    refreshMsLeft,
    refreshExpiryKnown,
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
  };
}

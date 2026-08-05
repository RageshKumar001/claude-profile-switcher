/**
 * Direct OAuth refresh, matching what Claude Code itself sends.
 *
 * Extracted from the shipped binary's production config:
 *   TOKEN_URL = https://platform.claude.com/v1/oauth/token
 *   body      = { grant_type, refresh_token, client_id, scope }
 *   response  = { access_token, refresh_token (optional), expires_in }
 *
 * This is your own credentials refreshing your own accounts -- the same call
 * the official client makes -- but it is an undocumented endpoint, so `ccp
 * doctor` checks it and the daemon reports failures loudly rather than letting
 * profiles rot silently.
 */

export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Claude Code's default scope set. */
export const DEFAULT_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

export async function refreshAccessToken(refreshToken, { scopes, clientId, timeout = 30_000 } = {}) {
  if (!refreshToken) throw new Error('no refresh token');

  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId ?? CLIENT_ID,
    scope: (Array.isArray(scopes) && scopes.length ? scopes : DEFAULT_SCOPES).join(' '),
  };

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`token refresh failed (${response.status})`);
    error.status = response.status;
    // A 400/401 here means the refresh token is dead: re-login is the only fix.
    error.terminal = response.status === 400 || response.status === 401;
    error.detail = detail.slice(0, 300);
    throw error;
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    // The server rotates the refresh token -- observed directly: a keep-alive
    // refresh came back with a different one, meaning the old token is spent.
    // Still tolerate its absence and keep the old one, exactly as Claude Code
    // does, rather than assuming rotation is guaranteed.
    refreshToken: data.refresh_token ?? refreshToken,
    rotated: Boolean(data.refresh_token && data.refresh_token !== refreshToken),
    expiresAt: Date.now() + (data.expires_in ?? 0) * 1000,
    scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : undefined,
  };
}

/**
 * Refresh a stored credentials blob in place, preserving everything we do not
 * own -- notably mcpOAuth, and refreshTokenExpiresAt when the server does not
 * supply a new one.
 */
export async function refreshCredentials(creds) {
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.refreshToken) throw new Error('store has no refresh token');

  const result = await refreshAccessToken(oauth.refreshToken, { scopes: oauth.scopes });

  return {
    creds: {
      ...creds,
      claudeAiOauth: {
        ...oauth,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        ...(result.scopes ? { scopes: result.scopes } : {}),
      },
    },
    rotated: result.rotated,
  };
}

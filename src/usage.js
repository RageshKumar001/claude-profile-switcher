/**
 * Quota, read from the same endpoint Claude Code itself uses.
 *
 * Extracted from the shipped binary:
 *   fetchUtilization: GET /api/oauth/usage
 * on the same origin as the token endpoint, with the account's bearer token.
 *
 * This matters more than it sounds: it means quota can be read WITHOUT making
 * an inference request. The older approach -- scraping
 * anthropic-ratelimit-* response headers -- required spending tokens to learn
 * how many tokens you had left, and those header names have since changed
 * anyway. This costs nothing and touches no quota.
 */

import { TOKEN_URL } from './oauth.js';

/** Same origin as the token endpoint; the binary derives both from BASE_API_URL. */
export const USAGE_URL = new URL('/api/oauth/usage', TOKEN_URL).toString();

/** One rate-limit window, or null when the account has no such window. */
function window_(raw) {
  if (!raw || typeof raw.utilization !== 'number') return null;
  return {
    percent: Math.round(raw.utilization),
    resetsAt: raw.resets_at ?? null,
    limitDollars: raw.limit_dollars ?? null,
    usedDollars: raw.used_dollars ?? null,
  };
}

/**
 * Reduce the response to the parts we display.
 *
 * Deliberately tolerant: the payload carries a dozen keys for unreleased
 * buckets, all null here, and the set changes between releases. Anything not
 * recognised is ignored rather than treated as an error.
 */
export function normalizeUsage(body) {
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  return {
    fiveHour: window_(body?.five_hour),
    sevenDay: window_(body?.seven_day),
    opus: window_(body?.seven_day_opus),
    sonnet: window_(body?.seven_day_sonnet),
    extra: body?.extra_usage?.is_enabled
      ? {
          percent:
            typeof body.extra_usage.utilization === 'number'
              ? Math.round(body.extra_usage.utilization)
              : null,
          limit: body.extra_usage.monthly_limit ?? null,
        }
      : null,
    limits: limits.map((l) => ({
      kind: l.kind ?? null,
      percent: typeof l.percent === 'number' ? Math.round(l.percent) : null,
      severity: l.severity ?? null,
      resetsAt: l.resets_at ?? null,
      active: Boolean(l.is_active),
    })),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchUsage(accessToken, { timeout = 15_000 } = {}) {
  if (!accessToken) throw new Error('no access token');

  const response = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const error = new Error(`usage lookup failed (${response.status})`);
    error.status = response.status;
    // 401 means the access token has lapsed; the caller decides whether
    // refreshing is allowed -- for ~/.claude it is not.
    error.needsRefresh = response.status === 401 || response.status === 403;
    throw error;
  }

  return normalizeUsage(await response.json());
}

/**
 * The single number worth putting in a status bar.
 *
 * The binding constraint is whichever window is closest to full: a 5-hour
 * window at 100% stops you now, but so does a weekly one, and showing the
 * smaller of the two would be actively misleading.
 */
export function headline(usage) {
  const candidates = [
    usage?.fiveHour && { ...usage.fiveHour, window: '5h' },
    usage?.sevenDay && { ...usage.sevenDay, window: '7d' },
    usage?.opus && { ...usage.opus, window: 'opus' },
  ].filter(Boolean);

  if (!candidates.length) return null;
  return candidates.reduce((worst, c) => (c.percent > worst.percent ? c : worst));
}

/** normal | warning | critical, matching how the API grades its own limits. */
export function severityOf(percent) {
  if (percent === null || percent === undefined) return 'unknown';
  if (percent >= 95) return 'critical';
  if (percent >= 75) return 'warning';
  return 'normal';
}

/** "resets in 3h 20m", or null when there is nothing to reset. */
export function resetsIn(resetsAt, now = Date.now()) {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'resetting now';

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `resets in ${days}d ${hours % 24}h`;
}

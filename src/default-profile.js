import fs from 'node:fs';
import path from 'node:path';

import { readCredentials, tokenHealth } from './credentials.js';
import { readJson, writeJsonAtomic } from './json-file.js';
import { ccpRoot, claudeConfigDir, claudeConfigFile, credentialsPath } from './paths.js';

/**
 * The account already signed into ~/.claude, surfaced as a profile.
 *
 * It is deliberately NOT a store under ~/.claude-profiles. Copying the live
 * token pair into a store would leave two places holding the same refresh
 * token, and if the server rotates refresh tokens on use, whichever store
 * refreshes first would invalidate the other -- breaking the one promise this
 * tool makes, that the existing login is left exactly as it is.
 *
 * So this is a *view*: identity is read out of the live files, never written
 * back, and binding a project to it simply points the shim at ~/.claude, which
 * is where Claude Code would have looked anyway. Zero duplication, zero risk.
 */
export const DEFAULT_PROFILE = 'default';

export function isDefaultName(name) {
  return typeof name === 'string' && name.toLowerCase() === DEFAULT_PROFILE;
}

/** Where the live account's credentials actually live. */
export function defaultProfileDir() {
  // An empty env on purpose: ccp may itself be running inside a bound session
  // with CLAUDE_SECURESTORAGE_CONFIG_DIR already set, and "default" must always
  // mean ~/.claude regardless of who launched us.
  return claudeConfigDir({});
}

/**
 * Identity for the live account, read from the files Claude Code already keeps.
 *
 * Read straight off disk rather than via `claude auth status`, because spawning
 * the CLI against ~/.claude could prompt it to refresh and rewrite the very
 * files we promised not to touch.
 */
/**
 * Our own copy of the default account's identity.
 *
 * The shared oauthAccount block is destroyed by the next `claude auth login`
 * into any store, and Claude Code never re-fetches a block that looks complete,
 * so the real identity is simply lost. Caching it the moment we see a verified
 * one costs nothing and is the only way to still name the account afterwards.
 * Purely a display cache -- nothing authenticates against it.
 */
const identityCacheFile = () => path.join(ccpRoot(), 'default-identity.json');

function rememberDefaultIdentity(account, credOrg) {
  if (!credOrg || !account?.emailAddress) return;
  const cached = readJson(identityCacheFile(), null);
  if (cached?.organizationUuid === credOrg && cached.emailAddress === account.emailAddress) return;
  try {
    writeJsonAtomic(
      identityCacheFile(),
      {
        organizationUuid: credOrg,
        accountUuid: account.accountUuid ?? null,
        emailAddress: account.emailAddress,
        organizationName: account.organizationName ?? null,
        seenAt: new Date().toISOString(),
      },
      { mode: 0o600 },
    );
  } catch {
    /* a display cache must never break a command */
  }
}

export function defaultProfileInfo() {
  const dir = defaultProfileDir();
  const creds = readCredentials(credentialsPath({}));
  const account = readJson(claudeConfigFile({}), {})?.oauthAccount ?? {};

  // oauthAccount lives in the SHARED ~/.claude.json, which no store redirects.
  // Signing into any other store rewrites it, so it routinely describes a
  // different account than the credentials sitting in ~/.claude. Only trust it
  // when the two agree on the organisation; otherwise report identity as
  // unknown rather than confidently naming the wrong account.
  const credOrg = creds?.organizationUuid ?? null;
  const blockOrg = account.organizationUuid ?? null;
  const identityVerified = credOrg && blockOrg ? credOrg === blockOrg : null;

  if (identityVerified) rememberDefaultIdentity(account, credOrg);

  // Drifted: fall back to the last identity we saw agree with these exact
  // credentials. Still evidence-based -- the organisation has to match.
  const cached = readJson(identityCacheFile(), null);
  const usable =
    identityVerified === false && cached?.organizationUuid === credOrg ? cached : null;
  const identity = usable ?? (identityVerified === false ? {} : account);
  const identitySource = usable ? 'cache' : identityVerified === false ? null : 'live';

  return {
    name: DEFAULT_PROFILE,
    dir,
    readonly: true,
    identityVerified,
    identitySource,
    meta: {
      name: DEFAULT_PROFILE,
      email: identity.emailAddress ?? null,
      orgName: identity.organizationName ?? null,
      accountUuid: identity.accountUuid ?? null,
      organizationUuid: credOrg,
      // Always straight from the credentials -- these are per-store and so
      // always describe the account actually in ~/.claude.
      subscriptionType: creds?.claudeAiOauth?.subscriptionType ?? null,
      rateLimitTier: creds?.claudeAiOauth?.rateLimitTier ?? null,
    },
    health: tokenHealth(creds),
    hasCredentials: Boolean(creds?.claudeAiOauth),
    exists: fs.existsSync(dir),
  };
}

/**
 * Refuse operations that would write to, delete or encrypt ~/.claude.
 * Binding and listing are fine; everything that mutates is not.
 */
export function assertNotDefault(name, verb) {
  if (!isDefaultName(name)) return;
  throw new Error(
    `"${DEFAULT_PROFILE}" is the account already signed into ~/.claude, not a store -- ` +
      `it cannot be ${verb}. ccp never writes to ~/.claude.`,
  );
}

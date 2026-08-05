import { loadBindings } from '../bindings.js';
import { defaultProfileInfo } from '../default-profile.js';
import { listProfiles } from '../store.js';
import { c, formatRelative, healthLabel, sym, table } from '../ui.js';

export function list({ json = false } = {}) {
  const stored = listProfiles();
  // The live ~/.claude login leads the list: it is the account every unbound
  // project already uses, so seeing it named is the point.
  const fallback = defaultProfileInfo();
  const profiles = fallback.hasCredentials ? [fallback, ...stored] : stored;

  const { bindings } = loadBindings();
  const counts = new Map();
  for (const value of Object.values(bindings)) {
    counts.set(value.profile, (counts.get(value.profile) ?? 0) + 1);
  }

  if (json) {
    console.log(
      JSON.stringify(
        profiles.map((p) => ({
          name: p.name,
          email: p.meta.email ?? null,
          plan: p.meta.subscriptionType ?? null,
          orgName: p.meta.orgName ?? null,
          projects: counts.get(p.name) ?? 0,
          health: p.health,
          readonly: Boolean(p.readonly),
          lastUsedAt: p.meta.lastUsedAt ?? null,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (!profiles.length) {
    console.log(c.dim('no profiles yet'));
    console.log(`  add one with ${c.cyan('ccp login <name>')}`);
    return;
  }

  const rows = [
    [c.dim('PROFILE'), c.dim('ACCOUNT'), c.dim('PLAN'), c.dim('PROJECTS'), c.dim('TOKEN'), c.dim('USED')],
  ];

  for (const profile of profiles) {
    const bound = counts.get(profile.name) ?? 0;
    rows.push([
      `${bound ? c.green(sym.active) : c.grey(sym.idle)} ${c.bold(profile.name)}`,
      profile.meta.email ?? c.grey('unknown'),
      profile.meta.subscriptionType ?? c.grey('-'),
      bound ? String(bound) : c.grey('0'),
      healthLabel(profile.health),
      profile.readonly ? c.dim('~/.claude') : formatRelative(profile.meta.lastUsedAt),
    ]);
  }

  console.log(table(rows));

  const shownFallback = profiles.find((p) => p.readonly);
  if (shownFallback) {
    console.log('');
    console.log(
      c.dim('  default is the account already signed into ~/.claude. It is read-only:'),
    );
    console.log(
      c.dim('  bind projects to it, but ccp never writes to, seals or deletes it.'),
    );
  }

  if (shownFallback?.identityVerified === false) {
    console.log('');
    console.log(
      `${c.yellow(sym.warn)} The shared identity block in ~/.claude.json describes a different`,
    );
    console.log(
      c.dim("  account than default's credentials -- a later `ccp login` overwrote it."),
    );
    console.log(
      c.dim("  default's plan above is accurate; its email is hidden rather than guessed."),
    );
    console.log(c.dim('  Claude Code\'s own /status is reading that same stale block. Run ') +
      c.cyan('ccp doctor'));
  }

  const unbound = profiles.filter((p) => !p.readonly && !counts.get(p.name));
  if (unbound.length) {
    console.log('');
    console.log(
      c.dim(`  ${unbound.length} profile(s) not bound to any project -- bind with `) +
        c.cyan('ccp bind <name>'),
    );
  }
}

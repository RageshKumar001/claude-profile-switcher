import path from 'node:path';

import { loadBindings, removeBinding, resolveBinding, setBinding } from '../bindings.js';
import { defaultProfileInfo, isDefaultName } from '../default-profile.js';
import { unsealIfNeeded } from './seal.js';
import { profileExists, readMeta, touchUsed } from '../store.js';
import { c, sym, table } from '../ui.js';

/** Identity for either a stored profile or the live ~/.claude login. */
function metaFor(profileName) {
  return isDefaultName(profileName) ? defaultProfileInfo().meta : readMeta(profileName);
}

export function bind(profileName, { cwd = process.cwd() } = {}) {
  const isDefault = isDefaultName(profileName);

  if (isDefault) {
    if (!defaultProfileInfo().hasCredentials) {
      throw new Error('~/.claude has no account signed in -- nothing to bind to');
    }
  } else if (!profileExists(profileName)) {
    throw new Error(`no such profile "${profileName}" -- run \`ccp ls\` to see what exists`);
  }

  // A sealed profile cannot be read by the shim, so binding one unseals it.
  // "default" is never sealed -- ccp does not write to ~/.claude at all.
  const wasSealed = !isDefault && unsealIfNeeded(profileName);

  const previous = resolveBinding(cwd);
  setBinding(cwd, profileName);
  if (!isDefault) touchUsed(profileName);

  if (wasSealed) console.log(c.dim(`  unsealed ${profileName} so the shim can read it`));

  const meta = metaFor(profileName);
  const who = meta.email ? c.dim(` (${meta.email})`) : '';
  console.log(`${c.green(sym.ok)} ${path.resolve(cwd)}`);
  console.log(`  bound to ${c.bold(profileName)}${who}`);

  if (previous && previous.profile !== profileName) {
    console.log(c.dim(`  was: ${previous.profile}`));
  }
  if (isDefault) {
    console.log('');
    console.log(c.dim('  This follows whatever ~/.claude is signed into, rather than pinning'));
    console.log(c.dim('  a captured token. Sign that account out and this project follows.'));
  }
  console.log('');
  console.log(
    c.dim('  Takes effect on the next Claude launch in this project -- start a new'),
  );
  console.log(c.dim('  conversation, or reload the window, to apply it now.'));
}

export function unbind({ cwd = process.cwd() } = {}) {
  if (removeBinding(cwd)) {
    console.log(`${c.green(sym.ok)} unbound ${path.resolve(cwd)}`);
    console.log(c.dim('  this project now uses the default account'));
  } else {
    console.log(c.dim(`no binding for ${path.resolve(cwd)}`));
  }
}

export function listBindings() {
  const { bindings } = loadBindings();
  const entries = Object.entries(bindings);
  if (!entries.length) {
    console.log(c.dim('no projects bound yet -- run `ccp bind <profile>` inside one'));
    return;
  }

  const rows = entries
    .sort((a, b) => (a[1].displayPath ?? a[0]).localeCompare(b[1].displayPath ?? b[0]))
    .map(([key, value]) => {
      const missing = !isDefaultName(value.profile) && !profileExists(value.profile);
      return [
        missing ? c.red(value.profile) : c.bold(value.profile),
        value.displayPath ?? key,
        missing ? c.red(`${sym.warn} profile missing`) : '',
      ];
    });

  console.log(table(rows));
}

/** Which account this directory resolves to, and why. */
export function current({ cwd = process.cwd(), json = false } = {}) {
  const match = resolveBinding(cwd);

  // Unbound and bound-to-default resolve to the same account; only the intent
  // differs. Report the live identity either way so the answer is never blank.
  const usesDefault = !match || isDefaultName(match.profile);
  const meta = usesDefault ? defaultProfileInfo().meta : readMeta(match.profile);

  if (json) {
    console.log(
      JSON.stringify(
        {
          project: path.resolve(cwd),
          bound: Boolean(match),
          profile: match?.profile ?? null,
          boundPath: match?.displayPath ?? match?.key ?? null,
          usesDefault,
          email: meta?.email ?? null,
          plan: meta?.subscriptionType ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${c.dim('project')}  ${path.resolve(cwd)}`);

  if (!match) {
    const who = meta.email ? c.dim(` (${meta.email})`) : '';
    console.log(`${c.dim('account')}  ${c.yellow('default -- not bound')}${who}`);
    console.log('');
    console.log(c.dim('  Claude here uses whichever account ~/.claude is signed into.'));
    console.log(c.dim(`  Pin it explicitly with `) + c.cyan('ccp bind default'));
    return;
  }

  console.log(`${c.dim('account')}  ${c.bold(match.profile)}${meta.email ? c.dim(` (${meta.email})`) : ''}`);
  console.log(`${c.dim('bound')}    ${match.displayPath ?? match.key}`);
  if (meta.subscriptionType) console.log(`${c.dim('plan')}     ${meta.subscriptionType}`);
  console.log('');

  if (usesDefault) {
    console.log(c.dim('  This is the live ~/.claude login, so /status agrees with it.'));
  } else {
    console.log(
      c.dim(`  Claude Code's own /status will report the account in ~/.claude, not this one.`),
    );
    console.log(
      c.dim('  That is expected: only credentials are per-project, not identity display.'),
    );
  }
}

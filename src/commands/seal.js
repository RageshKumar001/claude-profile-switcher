import fs from 'node:fs';

import { loadBindings } from '../bindings.js';
import { storeCredentials, storeSealed } from '../paths.js';
import { protectFile, unprotectFile } from '../storage/dpapi.js';
import { listProfileNames, profileExists, updateMeta } from '../store.js';
import { c, sym } from '../ui.js';

export function isSealed(name) {
  return fs.existsSync(storeSealed(name)) && !fs.existsSync(storeCredentials(name));
}

function boundProfiles() {
  const { bindings } = loadBindings();
  return new Set(Object.values(bindings).map((b) => b.profile));
}

/** Seal profiles that are not bound to any project. */
export function seal(name) {
  const bound = boundProfiles();
  const targets = name ? [name] : listProfileNames();
  let sealed = 0;

  for (const profile of targets) {
    if (!profileExists(profile)) {
      console.log(`${c.red(sym.bad)} ${profile}  no such profile`);
      continue;
    }
    if (isSealed(profile)) {
      console.log(`${c.dim('-')} ${profile}  already sealed`);
      continue;
    }
    if (bound.has(profile)) {
      // The shim reads the plaintext file at launch and cannot decrypt, by
      // design. Sealing a bound profile would silently drop that project back
      // to the default account.
      console.log(`${c.yellow(sym.warn)} ${profile}  bound to a project -- left in plaintext`);
      continue;
    }
    if (!fs.existsSync(storeCredentials(profile))) {
      console.log(`${c.dim('-')} ${profile}  nothing to seal`);
      continue;
    }

    protectFile(storeCredentials(profile), storeSealed(profile));
    fs.rmSync(storeCredentials(profile));
    updateMeta(profile, { sealed: true, sealedAt: new Date().toISOString() });
    console.log(`${c.green(sym.ok)} ${profile}  sealed`);
    sealed++;
  }

  if (!name && !sealed) console.log(c.dim('nothing to seal'));
}

export function unseal(name) {
  if (!profileExists(name)) throw new Error(`no such profile "${name}"`);
  if (!isSealed(name)) {
    console.log(c.dim(`${name} is not sealed`));
    return false;
  }
  unprotectFile(storeSealed(name), storeCredentials(name));
  fs.rmSync(storeSealed(name));
  updateMeta(name, { sealed: false });
  console.log(`${c.green(sym.ok)} ${name}  unsealed`);
  return true;
}

/** Used by `ccp bind` so binding a sealed profile just works. */
export function unsealIfNeeded(name) {
  if (!isSealed(name)) return false;
  unprotectFile(storeSealed(name), storeCredentials(name));
  fs.rmSync(storeSealed(name));
  updateMeta(name, { sealed: false });
  return true;
}

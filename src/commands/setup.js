import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildShim } from '../../scripts/build-shim.mjs';
import { installManifest, shimExe } from '../paths.js';
import { writeShimIndex } from '../bindings.js';
import { writeJsonAtomic } from '../json-file.js';
import { c, sym } from '../ui.js';
import { candidateSettingsPaths, readSetting, writeSetting } from '../vscode-settings.js';

const WRAPPER_KEY = 'claudeCode.claudeProcessWrapper';

/**
 * One-time install: build the shim and point VS Code at it.
 *
 * `claudeCode.claudeProcessWrapper` is machine-scoped, so it can only live in
 * user settings -- which is exactly what we want. It is set once, globally, and
 * the shim supplies the per-project behaviour.
 */
export function setup({ dryRun = false } = {}) {
  const built = buildShim();
  console.log(`${c.green(sym.ok)} shim built  ${c.dim(`${built.out} (${built.bytes} bytes)`)}`);

  writeShimIndex();
  console.log(`${c.green(sym.ok)} bindings index written`);

  // Record where this CLI lives so the VS Code extension can shell out to it
  // rather than carry a second copy of the binding logic.
  const cliEntry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'bin',
    'ccp.js',
  );
  writeJsonAtomic(
    installManifest(),
    { version: 1, cliEntry, node: process.execPath, shim: shimExe(), installedAt: new Date().toISOString() },
    { mode: 0o600 },
  );
  console.log(`${c.green(sym.ok)} install manifest written  ${c.dim(installManifest())}`);

  const editors = candidateSettingsPaths();
  if (!editors.length) {
    console.log(`${c.yellow(sym.warn)} no VS Code settings.json found`);
    console.log(`  set ${c.cyan(WRAPPER_KEY)} to ${c.cyan(shimExe())} manually`);
    return;
  }

  for (const { flavour, file } of editors) {
    const current = readSetting(file, WRAPPER_KEY);
    if (current === shimExe()) {
      console.log(`${c.green(sym.ok)} ${flavour} already configured`);
      continue;
    }
    if (current) {
      console.log(
        `${c.yellow(sym.warn)} ${flavour} already has a wrapper: ${c.dim(current)}`,
      );
      console.log('  refusing to replace it -- remove it first, or chain it from the shim');
      continue;
    }
    if (dryRun) {
      console.log(`${c.dim('would set')} ${flavour} ${WRAPPER_KEY}`);
      continue;
    }
    const result = writeSetting(file, WRAPPER_KEY, shimExe());
    console.log(
      `${c.green(sym.ok)} ${flavour} configured` +
        (result.backup ? c.dim(`  (backup: ${result.backup})`) : ''),
    );
  }

  console.log('');
  console.log(c.bold('Next:'));
  console.log(`  ${c.cyan('ccp login <name>')}   add an account`);
  console.log(`  ${c.cyan('ccp bind <name>')}    bind this project to it`);
  console.log(c.dim('  Restart VS Code so the extension picks up the wrapper setting.'));
}

/** Undo the VS Code side of setup. Profiles and bindings are left alone. */
export function teardown() {
  for (const { flavour, file } of candidateSettingsPaths()) {
    const current = readSetting(file, WRAPPER_KEY);
    if (current !== shimExe()) continue;
    writeSetting(file, WRAPPER_KEY, null);
    console.log(`${c.green(sym.ok)} ${flavour} wrapper cleared`);
  }
  if (fs.existsSync(shimExe())) {
    console.log(c.dim(`shim left in place at ${shimExe()}`));
  }
}

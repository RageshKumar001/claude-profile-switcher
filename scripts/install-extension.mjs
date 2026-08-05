#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * Install the companion VS Code extension without requiring `vsce`.
 *
 * VS Code loads any folder under its extensions directory that contains a
 * package.json, so copying the folder in is enough. If `vsce` happens to be
 * available we build a .vsix instead, which is the nicer artefact to hand
 * around a team.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, '..', 'vscode-extension');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
const folderName = `${manifest.publisher}.${manifest.name}-${manifest.version}`;

const EDITORS = [
  { name: 'VS Code', dir: path.join(os.homedir(), '.vscode', 'extensions') },
  { name: 'VS Code Insiders', dir: path.join(os.homedir(), '.vscode-insiders', 'extensions') },
  { name: 'Cursor', dir: path.join(os.homedir(), '.cursor', 'extensions') },
  { name: 'Windsurf', dir: path.join(os.homedir(), '.windsurf', 'extensions') },
];

function copyInto(targetRoot) {
  const target = path.join(targetRoot, folderName);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function tryPackage() {
  const result = spawnSync('npx', ['--no-install', 'vsce', 'package', '--out', path.join(here, '..', `${folderName}.vsix`)], {
    cwd: source,
    encoding: 'utf8',
    windowsHide: true,
    shell: true,
  });
  return result.status === 0 ? path.join(here, '..', `${folderName}.vsix`) : null;
}

const installed = [];
for (const editor of EDITORS) {
  if (!fs.existsSync(editor.dir)) continue;
  installed.push({ editor: editor.name, target: copyInto(editor.dir) });
}

if (!installed.length) {
  console.error('no VS Code extensions directory found -- is VS Code installed for this user?');
  process.exit(1);
}

for (const { editor, target } of installed) {
  console.log(`installed into ${editor}`);
  console.log(`  ${target}`);
}

const vsix = process.argv.includes('--vsix') ? tryPackage() : null;
if (vsix) console.log(`\npackaged ${vsix}`);
else if (process.argv.includes('--vsix')) {
  console.log('\nvsce not available -- skipped .vsix packaging (npm i -g @vscode/vsce)');
}

console.log('\nRestart VS Code to load it.');

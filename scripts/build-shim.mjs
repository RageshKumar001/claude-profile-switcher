#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { shimExe } from '../src/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, '..', 'shim', 'ccp-shim.cs');

/**
 * Built with the C# compiler that ships with Windows itself.
 *
 * The shim has to be a real executable: the SDK spawns
 * `pathToClaudeCodeExecutable` with no `shell` option, so a .cmd or .bat is not
 * launchable. csc.exe is present on every Windows install, needs no toolchain
 * to be installed, and produces a dependency-free binary.
 */
function findCsc() {
  if (process.env.CCP_CSC) return process.env.CCP_CSC;

  const root = process.env.SystemRoot || 'C:\\Windows';
  const frameworks = [
    path.join(root, 'Microsoft.NET', 'Framework64'),
    path.join(root, 'Microsoft.NET', 'Framework'),
  ];

  const found = [];
  for (const dir of frameworks) {
    let versions;
    try {
      versions = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const version of versions) {
      const candidate = path.join(dir, version, 'csc.exe');
      if (fs.existsSync(candidate)) found.push({ version, candidate });
    }
  }

  if (!found.length) {
    throw new Error(
      'could not find csc.exe -- set CCP_CSC to a C# compiler, or install the .NET Framework developer tools',
    );
  }
  found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return found[0].candidate;
}

export function buildShim({ out = shimExe() } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('the shim is Windows-only; nothing to build on this platform');
  }

  const csc = findCsc();
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const result = spawnSync(
    csc,
    [
      '/nologo',
      '/optimize+',
      '/target:exe',
      '/platform:anycpu',
      '/r:System.dll',
      `/out:${out}`,
      source,
    ],
    { encoding: 'utf8', windowsHide: true, shell: false },
  );

  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    // The shim stays alive as the parent of every session it launches, so the
    // exe is locked for as long as any Claude window is open. csc reports that
    // as CS0016, which reads like a broken toolchain rather than "close Claude".
    if (output.includes('CS0016')) {
      throw new Error(
        `cannot replace ${out} while it is in use.\n` +
          '  The shim is the parent process of every running Claude session, so it stays\n' +
          '  locked until they all exit. Close your Claude conversations (or the VS Code\n' +
          '  windows running them) and try again.',
      );
    }
    throw new Error(`csc failed (${result.status}):\n${output}`);
  }

  return { out, csc, bytes: fs.statSync(out).size };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-shim.mjs')) {
  try {
    const { out, csc, bytes } = buildShim();
    console.log(`built ${out} (${bytes} bytes)`);
    console.log(`  using ${csc}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

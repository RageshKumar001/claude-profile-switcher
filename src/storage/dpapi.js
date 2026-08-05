import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Windows DPAPI (CurrentUser scope) for profiles that are not in use.
 *
 * Be clear about what this buys: DPAPI unseals automatically for anything
 * running as you, so it is not protection against malware in your own session.
 * It means someone who copies the profile folder off the machine gets nothing,
 * and that only the accounts actually bound to a project sit in plaintext
 * rather than all of them.
 *
 * A bound profile can never be sealed -- the shim reads .credentials.json
 * directly and deliberately has no ability to decrypt.
 */

function encodeCommand(script) {
  // -EncodedCommand takes base64 UTF-16LE, which sidesteps PowerShell quoting
  // entirely -- these scripts carry file paths we do not control.
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script) {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'powershell failed').trim().slice(0, 400));
  }
  return result.stdout;
}

export function protectFile(inputFile, outputFile) {
  runPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [IO.File]::ReadAllBytes('${inputFile.replace(/'/g, "''")}')
$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[IO.File]::WriteAllBytes('${outputFile.replace(/'/g, "''")}', $sealed)
`);
  if (!fs.existsSync(outputFile)) throw new Error('seal produced no output');
}

export function unprotectFile(inputFile, outputFile) {
  runPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$sealed = [IO.File]::ReadAllBytes('${inputFile.replace(/'/g, "''")}')
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser')
[IO.File]::WriteAllBytes('${outputFile.replace(/'/g, "''")}', $bytes)
`);
  if (!fs.existsSync(outputFile)) throw new Error('unseal produced no output');
}

export function isAvailable() {
  if (process.platform !== 'win32') return false;
  try {
    runPowerShell("Add-Type -AssemblyName System.Security; 'ok'");
    return true;
  } catch {
    return false;
  }
}

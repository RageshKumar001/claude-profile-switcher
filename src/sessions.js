import fs from 'node:fs';
import path from 'node:path';

import { launchesDir } from './paths.js';
import { loadBindings, resolveBinding } from './bindings.js';
import { isDefaultName } from './default-profile.js';

/**
 * Which account each *running* Claude process is actually using.
 *
 * This exists because a binding is a promise about the next launch, not a
 * statement about the present. `CLAUDE_SECURESTORAGE_CONFIG_DIR` is read once,
 * at process start, so switching accounts leaves every conversation already
 * open on the account it started with -- and nothing in Claude Code's UI says
 * so. Reporting the binding as though it were the live state is how a switch
 * can silently keep billing the old account.
 *
 * The shim writes one record per launch and deletes it on exit; anything left
 * behind by a killed shim is dropped here when its pid turns out to be gone.
 */

/** Does a process with this id exist? Signal 0 checks without delivering. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else -- still alive.
    return err.code === 'EPERM';
  }
}

function parseRecord(file, text) {
  const pid = Number(path.basename(file, '.tsv'));
  if (!Number.isInteger(pid) || pid <= 0) return null;

  // The shim writes Environment.NewLine, so the record ends "\r\n" on Windows.
  // A trailing \r on the last field silently breaks the binding comparison and
  // reports drift for every session -- trim before splitting, not after.
  const line = text.split('\n')[0].replace(/\r$/, '');
  const [startedAt, profile, storeDir, cwd] = line.split('\t');
  if (!startedAt || !profile) return null;
  return { pid, startedAt, profile, storeDir: storeDir || null, cwd: cwd || null };
}

/**
 * Every live Claude process the shim launched, annotated with whether the
 * account it is running on still matches the binding for its directory.
 *
 * `prune` deletes records for processes that have exited. It is on by default:
 * reading the list is the natural moment to tidy it, and a stale record would
 * otherwise be reported forever as a phantom session.
 */
export function liveSessions({ prune = true } = {}) {
  const dir = launchesDir();
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.tsv'));
  } catch {
    return []; // no launches directory yet -- nothing has run through the shim
  }

  const bindings = loadBindings();
  const sessions = [];

  for (const name of entries) {
    const file = path.join(dir, name);
    let record;
    try {
      record = parseRecord(file, fs.readFileSync(file, 'utf8'));
    } catch {
      record = null;
    }

    if (!record || !alive(record.pid)) {
      if (prune) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* it may already be gone */
        }
      }
      continue;
    }

    // What the same directory would resolve to if Claude were launched now.
    const match = record.cwd ? resolveBinding(record.cwd, bindings) : null;
    const boundProfile = match ? match.profile : 'default';
    sessions.push({
      ...record,
      boundProfile,
      // Both names go through the same normalisation so an unbound session
      // running on ~/.claude is not reported as drifting from "default".
      drifted: normalizeProfileName(record.profile) !== normalizeProfileName(boundProfile),
    });
  }

  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function normalizeProfileName(name) {
  return isDefaultName(name) ? 'default' : name;
}

/** Live sessions whose account no longer matches the binding for their folder. */
export function driftedSessions(options) {
  return liveSessions(options).filter((s) => s.drifted);
}

/**
 * The drifted sessions belonging to one project.
 *
 * Used by the VS Code extension: a warning is only honest if it is about the
 * window you are looking at.
 */
export function driftForProject(cwd, options) {
  const target = resolveBinding(cwd);
  const key = target ? target.key : null;
  return driftedSessions(options).filter((s) => {
    if (!s.cwd) return false;
    const match = resolveBinding(s.cwd);
    return (match ? match.key : null) === key;
  });
}

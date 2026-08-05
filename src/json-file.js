import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Claude Code treats these rename errors as transient and retries; we mirror
// that set so our writes behave the same way its own do on Windows.
const TRANSIENT_RENAME = new Set(['EXDEV', 'EPERM', 'EEXIST', 'EBUSY']);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function writeTextAtomic(file, text, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    if (!TRANSIENT_RENAME.has(err.code)) {
      safeUnlink(tmp);
      throw err;
    }
    // Windows will refuse rename-over in some states; drop the target first.
    try {
      fs.unlinkSync(file);
    } catch {
      /* target may not exist */
    }
    try {
      fs.renameSync(tmp, file);
    } catch (err2) {
      safeUnlink(tmp);
      throw err2;
    }
  }
}

/**
 * Atomic write with an optional read-back check.
 *
 * There is no lock file on .credentials.json -- Claude Code relies purely on
 * atomic rename -- so a concurrent token refresh can land between our write and
 * anyone reading it. `verify` decides whether what ended up on disk is
 * acceptable; if it isn't, we rewrite once and re-check.
 *
 * `verify` must NOT be a plain equality check for credentials: Claude Code
 * writing a *newer* token for the same account is a good outcome, not a lost
 * update, and blindly rewriting would clobber a fresher token.
 */
export function writeJsonAtomic(file, data, { mode = 0o600, verify } = {}) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  writeTextAtomic(file, text, { mode });
  if (!verify) return;

  for (let attempt = 0; attempt < 2; attempt++) {
    const back = readJson(file);
    if (verify(back)) return;
    if (attempt === 0) writeTextAtomic(file, text, { mode });
  }
  throw new Error(`lost update: ${file} did not retain the intended contents`);
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
}

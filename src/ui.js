const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (code) => (text) => (useColor ? `[${code}m${text}[0m` : String(text));

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
  grey: wrap('90'),
};

export const sym = {
  active: '●',
  idle: '○',
  warn: '⚠',
  ok: '✓',
  bad: '✗',
};

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  const past = ms < 0;
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  const hours = abs / 3_600_000;
  const days = abs / 86_400_000;

  let out;
  if (minutes < 60) out = `${minutes}m`;
  else if (hours < 48) out = `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  else out = `${days.toFixed(days < 10 ? 1 : 0)}d`;
  return past ? `${out} ago` : out;
}

export function formatRelative(iso) {
  if (!iso) return c.grey('never');
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return c.grey('?');
  return formatDuration(then - Date.now());
}

/** Colour a token-health object for display. */
export function healthLabel(health) {
  if (!health?.present) return c.red('no credentials');
  switch (health.state) {
    case 'expired':
      return c.red('re-login needed');
    case 'expiring':
      return c.yellow(`expiring ${formatDuration(health.refreshMsLeft)}`);
    case 'unknown':
      // A fresh login records no refresh deadline, so we can only report what
      // we know rather than guess -- and guessing "expired" was the old bug.
      return c.yellow('access lapsed, refresh window unknown');
    default:
      return health.refreshExpiryKnown === false
        ? c.green(`healthy, access ${formatDuration(health.accessMsLeft)}`)
        : c.green(`healthy ${formatDuration(health.refreshMsLeft)}`);
  }
}

/** Left-aligned column table. Values are already-coloured strings. */
export function table(rows, { indent = '  ' } = {}) {
  if (!rows.length) return '';
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  return rows
    .map((row) =>
      indent +
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell + ' '.repeat(widths[i] - visibleLength(cell)),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

// Column widths must ignore ANSI escapes or coloured cells misalign.
function visibleLength(text) {
  return String(text).replace(/\[[0-9;]*m/g, '').length;
}

export function fail(message) {
  console.error(`${c.red('error')} ${message}`);
  process.exitCode = 1;
}

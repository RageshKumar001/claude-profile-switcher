import path from 'node:path';

import { liveSessions } from '../sessions.js';
import { c, formatRelative, sym, table } from '../ui.js';

/**
 * Show which account every running Claude process is actually using.
 *
 * `ccp current` answers "what will the next launch use here". This answers
 * "what is running right now", which is a different question and the one that
 * matters after a switch: an open conversation keeps the account it started
 * with until it is restarted.
 */
export function sessions({ json = false } = {}) {
  const live = liveSessions();

  if (json) {
    console.log(JSON.stringify(live, null, 2));
    return live;
  }

  if (!live.length) {
    console.log(c.dim('  no Claude sessions running through the shim'));
    return live;
  }

  const rows = [[c.dim('PID'), c.dim('RUNNING AS'), c.dim('STARTED'), c.dim('PROJECT')]];
  for (const s of live) {
    rows.push([
      String(s.pid),
      s.drifted ? c.yellow(`${sym.warn} ${s.profile}`) : c.green(s.profile),
      formatRelative(s.startedAt),
      s.cwd ? path.basename(s.cwd) : c.grey('?'),
    ]);
  }
  console.log(table(rows));

  const drifted = live.filter((s) => s.drifted);
  if (drifted.length) {
    console.log('');
    for (const s of drifted) {
      console.log(
        `${c.yellow(sym.warn)} ${c.bold(s.cwd ? path.basename(s.cwd) : `pid ${s.pid}`)} is bound to ` +
          `${c.bold(s.boundProfile)} but its running session is on ${c.bold(s.profile)}.`,
      );
    }
    console.log('');
    console.log(
      c.dim(
        '  A session keeps the account it launched with. Reload the VS Code window\n' +
          '  (or quit that session and start a new one) to pick up the binding.',
      ),
    );
  }

  return live;
}

const vscode = require('vscode');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MANIFEST = path.join(os.homedir(), '.claude-profiles', 'install.json');
const BINDINGS = path.join(os.homedir(), '.claude-profiles', 'bindings.json');

let statusBar;
let output;

function activate(context) {
  output = vscode.window.createOutputChannel('Claude Profile Switcher');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'ccp.switchAccount';
  context.subscriptions.push(statusBar, output);

  context.subscriptions.push(
    vscode.commands.registerCommand('ccp.switchAccount', switchAccount),
    vscode.commands.registerCommand('ccp.addAccount', addAccount),
    vscode.commands.registerCommand('ccp.unbind', unbind),
    vscode.commands.registerCommand('ccp.refresh', refresh),
    vscode.commands.registerCommand('ccp.showUsage', showUsage),
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
  );

  // bindings.json lives outside any workspace, so the workspace file watcher
  // will not see it. Poll its mtime instead -- cheap, and it keeps the status
  // bar honest when a binding changes from the CLI or another window.
  try {
    fs.watchFile(BINDINGS, { interval: 2000 }, refresh);
    context.subscriptions.push({ dispose: () => fs.unwatchFile(BINDINGS, refresh) });
  } catch {
    /* status bar just will not auto-refresh */
  }

  refresh();
}

function deactivate() {}

// ---------------------------------------------------------------- CLI bridge

/**
 * `ccp setup` records where the CLI lives, so the extension shells out to the
 * one implementation rather than carrying its own copy of the binding rules.
 */
function resolveCli() {
  const configured = vscode.workspace.getConfiguration('ccp').get('cliPath');
  if (configured) return { node: process.execPath, cliEntry: configured };

  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (manifest.cliEntry && fs.existsSync(manifest.cliEntry)) {
      return { node: manifest.node || process.execPath, cliEntry: manifest.cliEntry };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Same bridge, without blocking the extension host.
 *
 * Usage needs a network round trip, and refresh() runs on every editor change,
 * so it must never be fetched with spawnSync.
 */
function runCliAsync(args, { json = false, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const cli = resolveCli();
    if (!cli) return reject(new Error('ccp is not set up yet'));

    const child = cp.spawn(cli.node, [cli.cliEntry, ...args], {
      windowsHide: true,
      shell: false,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err || out || 'ccp failed').trim()));
      if (!json) return resolve(out);
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`could not parse output of \`ccp ${args.join(' ')}\``));
      }
    });
  });
}

function runCli(args, { json = false } = {}) {
  const cli = resolveCli();
  if (!cli) {
    throw new Error('ccp is not set up yet -- run `ccp setup` in a terminal');
  }

  const result = cp.spawnSync(cli.node, [cli.cliEntry, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: '1' },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `ccp ${args[0]} failed`).trim());
  }
  if (!json) return result.stdout;

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`could not parse output of \`ccp ${args.join(' ')}\``);
  }
}

// ------------------------------------------------------------------ commands

/** The folder whose account we are talking about. */
function activeFolder(resource) {
  if (resource instanceof vscode.Uri) {
    const folder = vscode.workspace.getWorkspaceFolder(resource);
    if (folder) return folder.uri.fsPath;
    return resource.fsPath;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return null;
  if (folders.length === 1) return folders[0].uri.fsPath;

  // Multi-root: follow the active editor, so the status bar tracks what you
  // are actually looking at.
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const folder = vscode.workspace.getWorkspaceFolder(active);
    if (folder) return folder.uri.fsPath;
  }
  return folders[0].uri.fsPath;
}

async function switchAccount(resource) {
  const folder = activeFolder(resource);
  if (!folder) {
    vscode.window.showWarningMessage('Open a folder before binding a Claude account to it.');
    return;
  }

  let profiles;
  let currentBinding;
  try {
    profiles = runCli(['ls', '--json'], { json: true });
    currentBinding = runCli(['current', '--json', '--cwd', folder], { json: true });
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Profile: ${err.message}`);
    return;
  }

  if (!profiles.length) {
    const choice = await vscode.window.showInformationMessage(
      'No Claude accounts yet. Add one?',
      'Add Account',
    );
    if (choice) await addAccount();
    return;
  }

  // Which account has room is usually the reason you are opening this list, so
  // it is worth a short wait. Cached figures are reused, and a failure here
  // just means the list renders without them.
  let usageRows = [];
  try {
    usageRows = await runCliAsync(['usage', '--json', '--max-age', '120'], { json: true });
  } catch {
    /* quota is optional context */
  }
  const quotaFor = (name) => worstWindow(usageRows.find((r) => r.name === name)?.usage);

  const items = profiles.map((p) => {
    const quota = quotaFor(p.name);
    return {
      label: `${p.name === currentBinding.profile ? '$(check) ' : p.readonly ? '$(home) ' : '$(account) '}${p.name}`,
      description: [p.email, p.plan, quota && `${quota.percent}% used`]
        .filter(Boolean)
        .join('  ·  '),
      detail:
        (p.readonly ? 'The account already signed into ~/.claude' : describeHealth(p)) +
        (quota?.percent >= 100 ? '  —  out of quota right now' : ''),
      profile: p.name,
    };
  });

  // Only offered when there is something to clear. "default" is already in the
  // list above with its real identity, so an extra "use the default" entry here
  // would be two ways to say the same thing.
  if (currentBinding.bound) {
    items.push({
      label: '$(circle-slash) Clear binding',
      detail: 'Leave this project unbound; it follows ~/.claude',
      profile: null,
    });
  }
  items.push({ label: '$(add) Add account…', profile: undefined });

  const picked = await vscode.window.showQuickPick(items, {
    title: `Claude account for ${path.basename(folder)}`,
    placeHolder: currentBinding.bound
      ? `Currently: ${currentBinding.profile}`
      : 'Currently: default account',
  });
  if (!picked) return;

  if (picked.profile === undefined) {
    await addAccount();
    return;
  }

  try {
    if (picked.profile === null) runCli(['unbind', '--cwd', folder]);
    else runCli(['bind', picked.profile, '--cwd', folder]);
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Profile: ${err.message}`);
    return;
  }

  refresh();
  await offerRestart(picked.profile);
}

/**
 * A binding only takes effect when Claude Code next starts, because the shim
 * reads it at launch.
 *
 * Reloading the window is the primary action because it is the only one that is
 * *certain*. `claude-vscode.newConversation` does spawn a correctly bound
 * process, but it leaves the conversation you were in open and selected -- and
 * that one is still running on the old account. Offering it as "Restart Claude"
 * was wrong: it looked like the switch had landed while the session kept
 * spending the previous account's quota, with nothing on screen to say so.
 */
async function offerRestart(profileName) {
  const label = profileName ?? 'the default account';
  const choice = await vscode.window.showInformationMessage(
    `This project now uses ${label}.`,
    {
      modal: false,
      detail:
        'Conversations already open keep the account they started on. Reload to move them.',
    },
    'Reload Window',
    'New Conversation',
    'Later',
  );

  if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }

  if (choice === 'New Conversation') {
    try {
      await vscode.commands.executeCommand('claude-vscode.newConversation');
      // The old conversation is still there, still on the old account. Say so
      // rather than let a stale tab quietly bill the wrong place.
      vscode.window.showWarningMessage(
        `Started a new conversation on ${label}. Any conversation you had open before ` +
          'is still running on the previous account -- reload the window to end it.',
      );
    } catch (err) {
      output.appendLine(`newConversation failed: ${err.message}`);
      const reload = await vscode.window.showWarningMessage(
        'Could not start a new Claude conversation. Reload the window instead?',
        'Reload Window',
        'Cancel',
      );
      if (reload === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }
  }

  // Whatever was chosen, re-check what is actually running.
  refresh();
}

async function addAccount() {
  const name = await vscode.window.showInputBox({
    title: 'Add a Claude account',
    prompt: 'Short name for this account (e.g. work, personal, client-a)',
    validateInput: (value) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value ?? '')
        ? null
        : 'Letters, digits, dot, dash and underscore only',
  });
  if (!name) return;

  const cli = resolveCli();
  if (!cli) {
    vscode.window.showErrorMessage('ccp is not set up yet -- run `ccp setup` in a terminal.');
    return;
  }

  // Login is interactive and opens a browser, so it belongs in a terminal
  // rather than a background spawn.
  const terminal = vscode.window.createTerminal({ name: `ccp login ${name}` });
  terminal.show();
  terminal.sendText(`& "${cli.node}" "${cli.cliEntry}" login ${name}`);

  vscode.window.showInformationMessage(
    `Signing in as "${name}" in the terminal. Run "Switch Account" once it finishes.`,
  );
}

async function unbind() {
  const folder = activeFolder();
  if (!folder) return;
  try {
    runCli(['unbind', '--cwd', folder]);
    refresh();
    await offerRestart(null);
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Profile: ${err.message}`);
  }
}

// ------------------------------------------------------------------ statusbar

function describeHealth(profile) {
  if (!profile.health?.present) return 'no credentials — sign in again';
  if (profile.health.state === 'expired') return 'expired — sign in again';
  if (profile.health.state === 'expiring') return 'token expiring soon';
  return profile.projects ? `${profile.projects} project(s)` : 'not bound to any project';
}

// Quota, keyed by account name. Populated in the background so the status bar
// can show it without ever waiting on the network.
const usageByProfile = new Map();
let lastInfo = null;
/** A live session in this window running on an account the binding no longer names. */
let drift = null;

/** The worst of an account's windows -- whichever one will stop you first. */
function worstWindow(usage) {
  const windows = [
    usage?.fiveHour && { ...usage.fiveHour, window: '5h' },
    usage?.sevenDay && { ...usage.sevenDay, window: '7d' },
    usage?.opus && { ...usage.opus, window: 'Opus' },
  ].filter(Boolean);
  if (!windows.length) return null;
  return windows.reduce((worst, w) => (w.percent > worst.percent ? w : worst));
}

function usageSuffix(profileName) {
  const worst = worstWindow(usageByProfile.get(profileName));
  return worst ? `  ${worst.percent}%` : '';
}

function usageTooltip(profileName) {
  const usage = usageByProfile.get(profileName);
  if (!usage) return '';
  const parts = [];
  if (usage.fiveHour) parts.push(`Session (5h): ${usage.fiveHour.percent}%`);
  if (usage.sevenDay) parts.push(`Week (7d): ${usage.sevenDay.percent}%`);
  if (usage.opus) parts.push(`Opus (7d): ${usage.opus.percent}%`);
  return parts.length ? `\n\n${parts.join('\n')}` : '';
}

/**
 * Fetch quota for the account in view, then repaint.
 *
 * `--max-age` lets the CLI serve a recent answer from cache, so a burst of
 * editor changes does not become a burst of requests.
 */
async function updateUsage(profileName) {
  if (!profileName) return;
  try {
    const rows = await runCliAsync(['usage', profileName, '--json', '--max-age', '240'], {
      json: true,
    });
    if (rows?.[0]?.usage) {
      usageByProfile.set(profileName, rows[0].usage);
      paint();
    }
  } catch {
    /* quota is a nicety -- never let it break the status bar */
  }
}

// Folders already considered this session, so opening files does not re-ask.
const declaredChecked = new Set();

/**
 * Honour a git-remote rule or a checked-in .ccp.json when a folder opens.
 *
 * A rule is something you wrote locally, so it applies silently. A .ccp.json
 * arrived inside someone else's repo -- it carries only a name, never
 * credentials, but it does decide which of your accounts gets spent, so it is
 * asked about once and the answer remembered.
 */
async function applyDeclared(folder) {
  if (!folder || declaredChecked.has(folder)) return;
  declaredChecked.add(folder);

  let plan;
  try {
    plan = await runCliAsync(['apply', '--cwd', folder, '--dry-run', '--json'], { json: true });
  } catch {
    return;
  }
  if (!plan?.source || plan.alreadyBound) return;

  if (plan.source === 'rule') {
    try {
      await runCliAsync(['apply', '--cwd', folder, '--yes']);
      refresh();
      output.appendLine(`applied rule ${plan.pattern} -> ${plan.profile} for ${folder}`);
    } catch (err) {
      output.appendLine(`rule apply failed: ${err.message}`);
    }
    return;
  }

  if (plan.approval === 'denied') return;
  if (plan.approval !== 'approved') {
    const choice = await vscode.window.showInformationMessage(
      `This repo's .ccp.json asks to use the Claude account "${plan.profile}".`,
      { modal: false, detail: 'The file holds only a name, never credentials.' },
      'Use it',
      'No',
    );
    if (choice !== 'Use it') {
      if (choice === 'No') {
        try {
          await runCliAsync(['apply', '--cwd', folder, '--deny']);
        } catch {
          /* remembering the refusal is best effort */
        }
      }
      return;
    }
  }

  try {
    await runCliAsync(['apply', '--cwd', folder, '--yes']);
    refresh();
    await offerRestart(plan.profile);
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Profile: ${err.message}`);
  }
}

function refresh() {
  if (!statusBar) return;

  if (!vscode.workspace.getConfiguration('ccp').get('showStatusBar')) {
    statusBar.hide();
    return;
  }

  const folder = activeFolder();
  if (!folder) {
    statusBar.hide();
    return;
  }

  try {
    lastInfo = runCli(['current', '--json', '--cwd', folder], { json: true });
  } catch (err) {
    lastInfo = null;
    statusBar.text = '$(account) Claude: not set up';
    statusBar.tooltip = err.message;
    statusBar.backgroundColor = undefined;
    statusBar.show();
    return;
  }

  paint();
  // Deliberately not awaited: the account name is already on screen, and the
  // percentage arrives when it arrives.
  void updateUsage(lastInfo.usesDefault || !lastInfo.bound ? 'default' : lastInfo.profile);
  void updateDrift(folder);
  if (!lastInfo.bound) void applyDeclared(folder);
}

/**
 * Is a Claude session in this window still running on the previous account?
 *
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` is read once, when the process starts, so
 * switching accounts cannot move a conversation that is already open -- it
 * keeps billing the account it launched with. Claude Code's own UI gives no
 * sign of this, so showing the binding alone is actively misleading: it reads
 * as the current state when it is only a statement about the next launch.
 */
async function updateDrift(folder) {
  let live = [];
  try {
    live = await runCliAsync(['sessions', '--json'], { json: true });
  } catch {
    // Older shim, or nothing has launched through it yet. Absence of evidence
    // is not drift, so say nothing rather than guess.
  }

  const here = String(folder).replace(/\//g, '\\').toLowerCase();
  drift =
    live.find((s) => {
      if (!s.drifted || !s.cwd) return false;
      const cwd = String(s.cwd).replace(/\//g, '\\').toLowerCase();
      return cwd === here || cwd.startsWith(here.endsWith('\\') ? here : here + '\\');
    }) ?? null;

  paint();
}

function paint() {
  if (!statusBar || !lastInfo) return;
  const info = lastInfo;
  const name = info.usesDefault || !info.bound ? 'default' : info.profile;

  // Drift outranks everything else on the status bar. Whatever the binding
  // says, this is the account the running session is spending.
  if (drift) {
    statusBar.text = `$(warning) Claude: ${drift.profile} (not ${drift.boundProfile})`;
    statusBar.tooltip =
      `This project is bound to ${drift.boundProfile}, but the Claude session ` +
      `running here (pid ${drift.pid}) started on ${drift.profile} and is still ` +
      `using it.\n\nA session keeps the account it launched with. Reload the ` +
      `window to move it onto ${drift.boundProfile}.\n\nClick to change the binding.`;
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBar.show();
    return;
  }

  const who = (info.email ? `\n${info.email}` : '') + (info.plan ? `  (${info.plan})` : '');
  const quota = usageSuffix(name);

  if (!info.bound) {
    statusBar.text = `$(home) Claude: default${quota}`;
    statusBar.tooltip =
      `This project uses the account ~/.claude is signed into.${who}` +
      usageTooltip(name) +
      '\n\nClick to bind it to a specific account.';
  } else if (info.usesDefault) {
    statusBar.text = `$(home) Claude: default${quota}`;
    statusBar.tooltip =
      `Bound to the account ~/.claude is signed into.${who}` + usageTooltip(name) + '\n\nClick to change.';
  } else {
    statusBar.text = `$(account) ${info.profile}${quota}`;
    statusBar.tooltip =
      `Claude account for this project: ${info.profile}${who}` +
      usageTooltip(name) +
      // Worth stating plainly: only credentials are per-project. Claude Code's
      // own /status reads identity from the shared config and will disagree.
      `\n\nNote: Claude's /status shows the default account, not this one.` +
      `\nAuthentication is correct; only that display lags.` +
      '\n\nClick to change.';
  }

  // Only shout when the account is actually spent -- a warning colour that is
  // on half the time is one nobody reads.
  const worst = worstWindow(usageByProfile.get(name));
  statusBar.backgroundColor =
    worst && worst.percent >= 100
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  statusBar.show();
}

/** `Claude Profile: Show Usage` -- every account, in the output channel. */
async function showUsage() {
  output.show(true);
  output.appendLine('');
  try {
    output.appendLine(await runCliAsync(['usage']));
  } catch (err) {
    output.appendLine(`usage lookup failed: ${err.message}`);
    vscode.window.showErrorMessage(`Claude Profile: ${err.message}`);
  }
}

module.exports = { activate, deactivate };

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

  const items = profiles.map((p) => ({
    label: `${p.name === currentBinding.profile ? '$(check) ' : p.readonly ? '$(home) ' : '$(account) '}${p.name}`,
    description: [p.email, p.plan].filter(Boolean).join('  ·  '),
    detail: p.readonly ? 'The account already signed into ~/.claude' : describeHealth(p),
    profile: p.name,
  }));

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
 * reads it at launch. Starting a new conversation respawns that process.
 */
async function offerRestart(profileName) {
  const label = profileName ?? 'the default account';
  const choice = await vscode.window.showInformationMessage(
    `This project now uses ${label}. Claude picks this up on its next launch.`,
    'Restart Claude',
    'Later',
  );
  if (choice !== 'Restart Claude') return;

  try {
    await vscode.commands.executeCommand('claude-vscode.newConversation');
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

  let info;
  try {
    info = runCli(['current', '--json', '--cwd', folder], { json: true });
  } catch (err) {
    statusBar.text = '$(account) Claude: not set up';
    statusBar.tooltip = err.message;
    statusBar.backgroundColor = undefined;
    statusBar.show();
    return;
  }

  const who = (info.email ? `\n${info.email}` : '') + (info.plan ? `  (${info.plan})` : '');

  if (!info.bound) {
    statusBar.text = '$(home) Claude: default';
    statusBar.tooltip =
      `This project uses the account ~/.claude is signed into.${who}` +
      '\n\nClick to bind it to a specific account.';
  } else if (info.usesDefault) {
    statusBar.text = '$(home) Claude: default';
    statusBar.tooltip =
      `Bound to the account ~/.claude is signed into.${who}` +
      '\n\nClick to change.';
  } else {
    statusBar.text = `$(account) ${info.profile}`;
    statusBar.tooltip =
      `Claude account for this project: ${info.profile}${who}` +
      // Worth stating plainly: only credentials are per-project. Claude Code's
      // own /status reads identity from the shared config and will disagree.
      `\n\nNote: Claude's /status shows the default account, not this one.` +
      `\nAuthentication is correct; only that display lags.` +
      '\n\nClick to change.';
  }
  statusBar.backgroundColor = undefined;
  statusBar.show();
}

module.exports = { activate, deactivate };

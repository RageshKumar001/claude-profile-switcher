#!/usr/bin/env node
import { bind, current, listBindings, unbind } from '../src/commands/bind.js';
import { installTask, runKeepAlive, taskStatus, uninstallTask } from '../src/commands/daemon.js';
import { doctor, explain } from '../src/commands/doctor.js';
import { exec, printEnv, shell } from '../src/commands/exec.js';
import { list } from '../src/commands/list.js';
import { login, save } from '../src/commands/login.js';
import { seal, unseal } from '../src/commands/seal.js';
import { setup, teardown } from '../src/commands/setup.js';
import { assertNotDefault } from '../src/default-profile.js';
import { syncMcpOAuth } from '../src/mcp-sync.js';
import { profileExists, removeProfile } from '../src/store.js';
import { c, fail } from '../src/ui.js';

const HELP = `${c.bold('ccp')} -- per-project Claude Code accounts

${c.dim('Each project gets its own account. Binding never modifies ~/.claude.')}

${c.bold('Setup')}
  ccp setup                 build the shim and point VS Code at it
  ccp doctor                check every assumption this tool makes
  ccp teardown              remove the VS Code wrapper setting

${c.bold('Accounts')}
  ccp login <name>          add an account (browser login into its own store)
  ccp save <name>           copy the account already in ~/.claude into a store
  ccp ls                    list accounts, token health and project counts
  ccp rm <name>             delete a profile

  ${c.dim('The account already signed into ~/.claude is listed as')} ${c.bold('default')}${c.dim('.')}
  ${c.dim('It is read-only -- bindable, never written to, sealed or deleted.')}

${c.bold('Anywhere else')}
  ccp exec [name] -- <cmd>  run a command as an account ${c.dim("(defaults to this project's)")}
  ccp shell [name]          nested shell using that account
  ccp env [name]            print the environment line, for scripts

${c.bold('Projects')}
  ccp bind <name>           bind the current project to an account ${c.dim('(incl. default)')}
  ccp unbind                revert this project to the default account
  ccp bindings              list every bound project
  ccp current               show which account this project uses
  ccp explain               show what the shim will do here, and why

${c.bold('Maintenance')}
  ccp sync-mcp              replicate MCP server logins across all stores
  ccp seal [name]           encrypt at rest any profile not bound to a project
  ccp unseal <name>         decrypt a sealed profile
  ccp daemon install        schedule a daily job so idle profiles never expire
  ccp daemon run            run that job now  ${c.dim('(--dry-run to preview)')}
  ccp daemon status         show the scheduled task
  ccp daemon uninstall      remove the scheduled task
`;

const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);
const flag = (name) => rest.includes(`--${name}`);

/** `--name value` or `--name=value`. */
function option(name) {
  const inline = rest.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = rest.indexOf(`--${name}`);
  if (index !== -1 && rest[index + 1] && !rest[index + 1].startsWith('--')) {
    return rest[index + 1];
  }
  return undefined;
}

// The VS Code extension runs this from its own working directory, so every
// project-scoped command accepts an explicit --cwd.
const cwd = option('cwd') ?? process.cwd();
const json = flag('json');

const optionValues = new Set([option('cwd'), option('at')].filter(Boolean));
const positional = rest.filter((a) => !a.startsWith('--') && !optionValues.has(a));

try {
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    case 'setup':
      setup({ dryRun: flag('dry-run') });
      break;

    case 'teardown':
      teardown();
      break;

    case 'login':
      requireName(positional[0], 'login');
      assertNotDefault(positional[0], 'signed into as a separate store');
      login(positional[0]);
      break;

    case 'save':
      requireName(positional[0], 'save');
      assertNotDefault(positional[0], 'used as a name for a copy');
      save(positional[0], { force: flag('force') });
      break;

    case 'ls':
    case 'list':
      list({ json });
      break;

    case 'rm':
    case 'remove': {
      const name = positional[0];
      requireName(name, 'rm');
      assertNotDefault(name, 'deleted');
      if (!profileExists(name)) throw new Error(`no such profile "${name}"`);
      removeProfile(name);
      console.log(`removed ${name}`);
      break;
    }

    case 'exec': {
      // Parsed by hand: everything after `--` belongs to the child, so the
      // generic flag parsing above must not touch it. A `--cwd` meant for the
      // child would otherwise be read as ours.
      const sep = rest.indexOf('--');
      if (sep === -1) {
        throw new Error(
          'ccp exec needs `--` before the command:  ccp exec [profile] -- <command> [args...]',
        );
      }
      const head = rest.slice(0, sep);
      const headCwd = head.find((a) => a.startsWith('--cwd='))?.slice(6) ?? cwd;
      const name = head.find((a) => !a.startsWith('--'));
      exec(name, rest.slice(sep + 1), { cwd: headCwd });
      break;
    }

    case 'shell':
      shell(positional[0], { cwd });
      break;

    case 'env':
      printEnv(positional[0], { cwd });
      break;

    case 'bind':
      requireName(positional[0], 'bind');
      bind(positional[0], { cwd });
      break;

    case 'unbind':
      unbind({ cwd });
      break;

    case 'bindings':
      listBindings();
      break;

    case 'current':
    case 'who':
      current({ cwd, json });
      break;

    case 'explain':
      explain(cwd);
      break;

    case 'doctor':
      doctor();
      break;

    case 'daemon': {
      const sub = positional[0] ?? 'status';
      if (sub === 'run') await runKeepAlive({ dryRun: flag('dry-run'), quiet: flag('quiet') });
      else if (sub === 'install') installTask({ atTime: option('at') ?? '13:00' });
      else if (sub === 'uninstall') uninstallTask();
      else if (sub === 'status') taskStatus();
      else throw new Error(`unknown daemon subcommand "${sub}"`);
      break;
    }

    case 'seal':
      if (positional[0]) assertNotDefault(positional[0], 'sealed');
      seal(positional[0]);
      break;

    case 'unseal':
      requireName(positional[0], 'unseal');
      assertNotDefault(positional[0], 'unsealed');
      unseal(positional[0]);
      break;

    case 'sync-mcp': {
      const result = syncMcpOAuth({ dryRun: flag('dry-run') });
      console.log(
        result.changed.length
          ? `synced ${result.servers} MCP login(s) into: ${result.changed.join(', ')}`
          : `already in sync (${result.servers} MCP login(s))`,
      );
      break;
    }

    default:
      fail(`unknown command "${command}"`);
      console.log(HELP);
  }
} catch (err) {
  fail(err.message);
  if (process.env.CCP_DEBUG === '1') console.error(err.stack);
}

function requireName(name, forCommand) {
  if (!name) throw new Error(`\`ccp ${forCommand}\` needs a profile name`);
}

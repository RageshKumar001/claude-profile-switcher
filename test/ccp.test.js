import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Every module resolves ccpRoot() lazily from CCP_HOME, so pointing it at a
// scratch directory keeps the suite away from the real profile store.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-test-'));
process.env.CCP_HOME = sandbox;

const {
  claudeConfigFile,
  secureStorageDir,
  credentialsPath,
  assertValidProfileName,
  launchesDir,
} = await import('../src/paths.js');
const {
  normalizeProjectPath,
  isUnder,
  setBinding,
  removeBinding,
  resolveBinding,
  writeShimIndex,
} = await import('../src/bindings.js');
const { applyAccount, extractAccount, tokenHealth } = await import('../src/credentials.js');
const { DEFAULT_PROFILE, isDefaultName, defaultProfileDir, assertNotDefault } = await import(
  '../src/default-profile.js'
);
const { writeJsonAtomic, readJson } = await import('../src/json-file.js');
const { resolveProfileTarget, pickShell } = await import('../src/commands/exec.js');
const { normalizeUsage, headline, severityOf, resetsIn } = await import('../src/usage.js');
const { normalizeRemote, matchRule, readOriginUrl, readProjectConfig } = await import(
  '../src/rules.js'
);
const { liveSessions, driftedSessions } = await import('../src/sessions.js');

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

// --------------------------------------------------------------------- paths

test('secureStorageDir treats an empty string as "use the default"', () => {
  // The VS Code SDK sets this variable to "" when it has nothing better, and
  // Claude Code reads that as the default store, not as a relative path.
  const asDefault = secureStorageDir({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' });
  assert.equal(asDefault, path.join(os.homedir(), '.claude').normalize('NFC'));
});

test('secureStorageDir honours an explicit store, overriding CLAUDE_CONFIG_DIR', () => {
  const dir = secureStorageDir({
    CLAUDE_SECURESTORAGE_CONFIG_DIR: 'C:\\stores\\work',
    CLAUDE_CONFIG_DIR: 'C:\\other',
  });
  assert.equal(dir, 'C:\\stores\\work');
  assert.equal(credentialsPath({ CLAUDE_SECURESTORAGE_CONFIG_DIR: 'C:\\stores\\work' }),
    path.join('C:\\stores\\work', '.credentials.json'));
});

test('secureStorageDir falls back to the config dir when unset', () => {
  assert.equal(secureStorageDir({ CLAUDE_CONFIG_DIR: 'C:\\cfg' }), 'C:\\cfg');
});

test('claudeConfigFile prefers .config.json inside the config dir', () => {
  const configDir = path.join(sandbox, 'cfgdir');
  fs.mkdirSync(configDir, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: configDir };

  // Without the marker file it is <CLAUDE_CONFIG_DIR>/.claude.json ...
  assert.equal(claudeConfigFile(env), path.join(configDir, '.claude.json'));

  // ... and with it, the marker wins.
  fs.writeFileSync(path.join(configDir, '.config.json'), '{}');
  assert.equal(claudeConfigFile(env), path.join(configDir, '.config.json'));
});

test('profile names are restricted to safe directory names', () => {
  assert.equal(assertValidProfileName('work-1.a'), 'work-1.a');
  for (const bad of ['', '../escape', 'has space', '-leading', 'a'.repeat(65)]) {
    assert.throws(() => assertValidProfileName(bad), /invalid profile name/);
  }
});

// ------------------------------------------------------------------ bindings

test('isUnder respects path boundaries', () => {
  assert.ok(isUnder('c:\\a\\b', 'c:\\a'));
  assert.ok(isUnder('c:\\a', 'c:\\a'));
  // "c:\\ab" must not match a binding on "c:\\a"
  assert.equal(isUnder('c:\\ab', 'c:\\a'), false);
});

test('normalizeProjectPath is case- and separator-insensitive on Windows', (t) => {
  if (process.platform !== 'win32') return t.skip('windows-only');
  assert.equal(normalizeProjectPath('C:/Projects/App/'), 'c:\\projects\\app');
});

test('resolveBinding picks the longest matching prefix', () => {
  fs.mkdirSync(path.join(sandbox, 'store', 'outer'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'store', 'inner'), { recursive: true });

  const root = path.join(sandbox, 'proj');
  const nested = path.join(root, 'packages', 'api');
  fs.mkdirSync(nested, { recursive: true });

  setBinding(root, 'outer');
  setBinding(nested, 'inner');

  assert.equal(resolveBinding(root).profile, 'outer');
  assert.equal(resolveBinding(nested).profile, 'inner');
  // A file deeper still inherits the nearest binding, not the outer one.
  assert.equal(resolveBinding(path.join(nested, 'src')).profile, 'inner');
});

test('the shim index is sorted longest-prefix-first so first match wins', () => {
  writeShimIndex();
  const lines = fs
    .readFileSync(path.join(sandbox, 'bindings.tsv'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const lengths = lines.map((line) => line.split('\t')[0].length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
});

test('the shim index omits bindings whose store is gone', () => {
  setBinding(path.join(sandbox, 'ghost'), 'deleted-profile');
  writeShimIndex();
  const body = fs.readFileSync(path.join(sandbox, 'bindings.tsv'), 'utf8');
  assert.ok(!body.includes('deleted-profile'));
});

// ----------------------------------------------------------- default profile

test('"default" is reserved, so no store can shadow the live login', () => {
  assert.throws(() => assertValidProfileName('default'), /reserved/);
  assert.throws(() => assertValidProfileName('DEFAULT'), /reserved/);
  // Names that merely start with it are ordinary.
  assert.equal(assertValidProfileName('default-work'), 'default-work');
});

test('isDefaultName ignores case', () => {
  assert.ok(isDefaultName('default'));
  assert.ok(isDefaultName('Default'));
  assert.ok(!isDefaultName('defaults'));
  assert.ok(!isDefaultName(undefined));
});

test('the shim index points a default binding at ~/.claude, not a store', () => {
  const project = path.join(sandbox, 'uses-live-login');
  setBinding(project, DEFAULT_PROFILE);
  writeShimIndex();

  const row = fs
    .readFileSync(path.join(sandbox, 'bindings.tsv'), 'utf8')
    .split('\n')
    .find((line) => line.includes(DEFAULT_PROFILE));

  assert.ok(row, 'default binding should survive into the index');
  const [, dir] = row.split('\t');
  assert.equal(dir, defaultProfileDir());
  // It must NOT have been filtered out as a missing store, which is what would
  // happen if it were resolved through storeDir().
  assert.ok(!dir.includes('store'));
});

test('mutating operations refuse to touch the default profile', () => {
  for (const verb of ['deleted', 'sealed']) {
    assert.throws(() => assertNotDefault('default', verb), /~\/\.claude/);
  }
  // Real profiles pass straight through.
  assert.doesNotThrow(() => assertNotDefault('work', 'deleted'));
});

// ---------------------------------------------------------------- exec/shell

test('exec resolves an explicit profile to its own store', () => {
  fs.mkdirSync(path.join(sandbox, 'store', 'work'), { recursive: true });
  const target = resolveProfileTarget({ name: 'work', cwd: sandbox });
  assert.equal(target.name, 'work');
  assert.equal(target.source, 'argument');
  assert.equal(target.isDefault, false);
  assert.ok(target.dir.endsWith(path.join('store', 'work')));
});

test('exec resolves "default" to ~/.claude rather than a store', () => {
  const target = resolveProfileTarget({ name: 'default', cwd: sandbox });
  assert.equal(target.isDefault, true);
  assert.equal(target.dir, defaultProfileDir());
});

test('exec falls back to the default account in an unbound directory', () => {
  const loose = path.join(sandbox, 'nowhere-near-a-binding');
  fs.mkdirSync(loose, { recursive: true });
  const target = resolveProfileTarget({ cwd: loose });
  assert.equal(target.source, 'unbound');
  assert.equal(target.isDefault, true);
});

test('exec uses the binding when no profile is named', () => {
  fs.mkdirSync(path.join(sandbox, 'store', 'bound-acct'), { recursive: true });
  const project = path.join(sandbox, 'a-bound-project');
  setBinding(project, 'bound-acct');
  const target = resolveProfileTarget({ cwd: path.join(project, 'nested', 'deep') });
  assert.equal(target.name, 'bound-acct');
  assert.equal(target.source, 'binding');
});

test('exec refuses a profile that does not exist', () => {
  assert.throws(() => resolveProfileTarget({ name: 'not-a-profile', cwd: sandbox }), /no such profile/);
});

test('CCP_SHELL overrides the shell that `ccp shell` nests', () => {
  const before = process.env.CCP_SHELL;
  process.env.CCP_SHELL = '/usr/bin/fish';
  try {
    assert.equal(pickShell().command, '/usr/bin/fish');
  } finally {
    if (before === undefined) delete process.env.CCP_SHELL;
    else process.env.CCP_SHELL = before;
  }
});

test('removing a binding drops it from the shim index too', () => {
  // This is what `ccp doctor --fix` does for a binding whose profile is gone:
  // the index must not keep pointing at it.
  const project = path.join(sandbox, 'doomed-project');
  fs.mkdirSync(path.join(sandbox, 'store', 'doomed'), { recursive: true });
  setBinding(project, 'doomed');
  assert.ok(fs.readFileSync(path.join(sandbox, 'bindings.tsv'), 'utf8').includes('doomed'));

  assert.equal(removeBinding(project), true);
  assert.ok(!fs.readFileSync(path.join(sandbox, 'bindings.tsv'), 'utf8').includes('doomed-project'));
  // Removing it twice is not an error -- repairs must be safe to re-run.
  assert.equal(removeBinding(project), false);
});

// --------------------------------------------------------------------- rules

test('normalizeRemote reduces every clone form to host/owner/repo', () => {
  const expected = 'github.com/acme/infra';
  for (const url of [
    'git@github.com:acme/infra.git',
    'https://github.com/acme/infra.git',
    'https://github.com/acme/infra',
    'ssh://git@github.com/acme/infra.git',
    'https://someone@github.com/Acme/Infra.git',
    'git://github.com/acme/infra.git/',
  ]) {
    assert.equal(normalizeRemote(url), expected, url);
  }
  assert.equal(normalizeRemote(null), null);
  assert.equal(normalizeRemote(''), null);
});

test('a rule glob stops at path separators unless doubled', () => {
  const rules = {
    rules: [
      { pattern: 'github.com/acme/*', profile: 'work' },
      { pattern: 'gitlab.com/**', profile: 'personal' },
    ],
  };
  assert.equal(matchRule('git@github.com:acme/infra.git', rules).profile, 'work');
  // Single * must not span a separator, so a nested group does not match.
  assert.equal(matchRule('git@github.com:acme/team/infra.git', rules), null);
  assert.equal(matchRule('https://gitlab.com/a/b/c.git', rules).profile, 'personal');
  assert.equal(matchRule('https://bitbucket.org/acme/x.git', rules), null);
});

test('the most specific rule wins, not the first one added', () => {
  const rules = {
    rules: [
      { pattern: 'github.com/**', profile: 'catch-all' },
      { pattern: 'github.com/acme/*', profile: 'work' },
      { pattern: 'github.com/acme/secret', profile: 'client' },
    ],
  };
  assert.equal(matchRule('github.com/acme/secret', rules).profile, 'client');
  assert.equal(matchRule('github.com/acme/other', rules).profile, 'work');
  assert.equal(matchRule('github.com/someone/else', rules).profile, 'catch-all');
});

test('a malformed rule pattern is skipped, not thrown', () => {
  const rules = {
    rules: [
      { pattern: '[', profile: 'broken' },
      { pattern: 'github.com/acme/*', profile: 'work' },
    ],
  };
  assert.equal(matchRule('github.com/acme/infra', rules).profile, 'work');
});

test('readOriginUrl parses .git/config without invoking git', () => {
  const repo = path.join(sandbox, 'a-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.git', 'config'),
    [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "upstream"]',
      '\turl = https://github.com/upstream/wrong.git',
      '[remote "origin"]',
      '\turl = git@github.com:acme/right.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n'),
  );
  assert.equal(readOriginUrl(repo), 'git@github.com:acme/right.git');
  // Found from a subdirectory too, which is how VS Code will call it.
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  assert.equal(readOriginUrl(path.join(repo, 'src', 'deep')), 'git@github.com:acme/right.git');
  assert.equal(readOriginUrl(sandbox), null);
});

test('readProjectConfig finds .ccp.json from a subdirectory', () => {
  const repo = path.join(sandbox, 'declared');
  fs.mkdirSync(path.join(repo, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.ccp.json'), JSON.stringify({ profile: 'client-a' }));
  const found = readProjectConfig(path.join(repo, 'nested'));
  assert.equal(found.profile, 'client-a');
  assert.equal(found.dir, repo);
  // A file with no profile in it is not a declaration.
  fs.writeFileSync(path.join(repo, '.ccp.json'), JSON.stringify({ note: 'hi' }));
  assert.equal(readProjectConfig(repo), null);
});

// --------------------------------------------------------------------- usage

// Shape captured from a live GET /api/oauth/usage response.
const USAGE_BODY = {
  five_hour: { utilization: 100, resets_at: '2026-08-05T21:00:00.000000+00:00' },
  seven_day: { utilization: 61, resets_at: '2026-08-11T04:00:00.000000+00:00' },
  seven_day_opus: null,
  // A dozen null keys for unreleased buckets ship in every response; they must
  // not be mistaken for data.
  tangelo: null,
  nimbus_quill: null,
  extra_usage: { is_enabled: false, utilization: null },
  limits: [
    { kind: 'session', percent: 100, severity: 'critical', is_active: true },
    { kind: 'weekly_all', percent: 61, severity: 'normal', is_active: false },
  ],
};

test('normalizeUsage keeps the windows that exist and drops the empty ones', () => {
  const usage = normalizeUsage(USAGE_BODY);
  assert.equal(usage.fiveHour.percent, 100);
  assert.equal(usage.sevenDay.percent, 61);
  assert.equal(usage.opus, null);
  assert.equal(usage.extra, null);
  assert.equal(usage.limits.length, 2);
});

test('normalizeUsage survives a response with nothing in it', () => {
  const usage = normalizeUsage({});
  assert.equal(usage.fiveHour, null);
  assert.deepEqual(usage.limits, []);
});

test('headline reports the window that will stop you first', () => {
  // The weekly window is the binding constraint here, not the session one.
  const usage = normalizeUsage({
    five_hour: { utilization: 12, resets_at: null },
    seven_day: { utilization: 96, resets_at: null },
  });
  assert.equal(headline(usage).percent, 96);
  assert.equal(headline(usage).window, '7d');
  assert.equal(headline(normalizeUsage({})), null);
});

test('severityOf grades a percentage', () => {
  assert.equal(severityOf(10), 'normal');
  assert.equal(severityOf(80), 'warning');
  assert.equal(severityOf(100), 'critical');
  assert.equal(severityOf(null), 'unknown');
});

test('resetsIn renders a countdown, not a timestamp', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');
  assert.equal(resetsIn('2026-08-05T12:30:00Z', now), 'resets in 30m');
  assert.equal(resetsIn('2026-08-05T15:20:00Z', now), 'resets in 3h 20m');
  assert.equal(resetsIn('2026-08-07T18:00:00Z', now), 'resets in 2d 6h');
  assert.equal(resetsIn('2026-08-05T11:00:00Z', now), 'resetting now');
  assert.equal(resetsIn(null, now), null);
});

// --------------------------------------------------------------- credentials

test('applyAccount swaps the account but preserves MCP logins', () => {
  const live = {
    claudeAiOauth: { accessToken: 'old', refreshToken: 'old-r' },
    organizationUuid: 'org-old',
    mcpOAuth: { 'cloudflare|abc': { accessToken: 'mcp-token' } },
  };
  const incoming = {
    claudeAiOauth: { accessToken: 'new', refreshToken: 'new-r' },
    organizationUuid: 'org-new',
  };

  const merged = applyAccount(live, incoming);
  assert.equal(merged.claudeAiOauth.accessToken, 'new');
  assert.equal(merged.organizationUuid, 'org-new');
  // The whole point: MCP server logins are not account-scoped.
  assert.deepEqual(merged.mcpOAuth, live.mcpOAuth);
});

test('applyAccount drops account keys the incoming profile does not have', () => {
  const merged = applyAccount(
    { claudeAiOauth: { accessToken: 'x' }, organizationUuid: 'org', mcpOAuth: { a: 1 } },
    { claudeAiOauth: { accessToken: 'y' } },
  );
  assert.equal(merged.organizationUuid, undefined);
  assert.deepEqual(merged.mcpOAuth, { a: 1 });
});

test('extractAccount returns null when nothing is logged in', () => {
  assert.equal(extractAccount({ mcpOAuth: {} }), null);
  assert.equal(extractAccount(null), null);
});

test('a fresh login with no refresh deadline is not reported as expired', () => {
  // `claude auth login` writes credentials without refreshTokenExpiresAt; only
  // a later refresh fills it in. Treating that as expired called a working,
  // minutes-old login dead.
  const now = Date.now();
  const fresh = tokenHealth(
    { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: now + 8 * 3600_000 } },
    now,
  );
  assert.equal(fresh.state, 'healthy');
  assert.equal(fresh.refreshExpiryKnown, false);
  assert.equal(fresh.refreshMsLeft, null);
  assert.equal(fresh.accessExpired, false);

  // Once the access token lapses we genuinely cannot tell -- say so.
  const stale = tokenHealth(
    { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: now - 1000 } },
    now,
  );
  assert.equal(stale.state, 'unknown');
  assert.equal(stale.refreshExpiryKnown, false);
});

test('tokenHealth classifies the refresh window', () => {
  const now = Date.now();
  const day = 86_400_000;
  const build = (refreshDays) => ({
    claudeAiOauth: {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: now + 3600_000,
      refreshTokenExpiresAt: now + refreshDays * day,
    },
  });

  assert.equal(tokenHealth(build(17), now).state, 'healthy');
  assert.equal(tokenHealth(build(1), now).state, 'expiring');
  assert.equal(tokenHealth(build(-1), now).state, 'expired');
  assert.equal(tokenHealth({}, now).state, 'missing');
});

// ----------------------------------------------------------------- json-file

test('writeJsonAtomic leaves no temp files behind', () => {
  const file = path.join(sandbox, 'atomic', 'data.json');
  writeJsonAtomic(file, { hello: 'world' });
  assert.deepEqual(readJson(file), { hello: 'world' });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeJsonAtomic surfaces a lost update when verification keeps failing', () => {
  const file = path.join(sandbox, 'verify.json');
  assert.throws(
    () => writeJsonAtomic(file, { a: 1 }, { verify: () => false }),
    /lost update/,
  );
});

test('writeJsonAtomic accepts a passing verification', () => {
  const file = path.join(sandbox, 'verify-ok.json');
  writeJsonAtomic(file, { a: 1 }, { verify: (back) => back?.a === 1 });
  assert.deepEqual(readJson(file), { a: 1 });
});

test('readJson returns the fallback for a missing file', () => {
  assert.equal(readJson(path.join(sandbox, 'nope.json'), 'fallback'), 'fallback');
});

// ------------------------------------------------------------------ sessions
//
// A binding describes the next launch, not the present. These cover the gap
// that let a switched project keep billing its old account in silence.

/** Write a launch record exactly as the shim does, CRLF and all. */
function writeLaunchRecord(pid, { profile, storeDir = '', cwd }) {
  const dir = launchesDir();
  fs.mkdirSync(dir, { recursive: true });
  const line = [new Date().toISOString(), profile, storeDir, cwd].join('\t');
  fs.writeFileSync(path.join(dir, `${pid}.tsv`), `${line}\r\n`);
}

function clearLaunches() {
  fs.rmSync(launchesDir(), { recursive: true, force: true });
}

test('a live session is reported with the account it actually launched on', () => {
  clearLaunches();
  const project = path.join(sandbox, 'proj-live');
  setBinding(project, 'work');
  // process.pid is by definition alive, which is the whole liveness contract.
  writeLaunchRecord(process.pid, { profile: 'work', cwd: normalizeProjectPath(project) });

  const live = liveSessions({ prune: false });
  assert.equal(live.length, 1);
  assert.equal(live[0].profile, 'work');
  assert.equal(live[0].boundProfile, 'work');
  assert.equal(live[0].drifted, false);
  removeBinding(project);
});

test('a session still on the old account after a switch is reported as drifted', () => {
  clearLaunches();
  const project = path.join(sandbox, 'proj-drift');
  setBinding(project, 'personal');
  // Launched before the switch, so it is running the previous account.
  writeLaunchRecord(process.pid, { profile: 'work', cwd: normalizeProjectPath(project) });

  const [session] = driftedSessions({ prune: false });
  assert.ok(session, 'the drifted session should be reported');
  assert.equal(session.profile, 'work');
  assert.equal(session.boundProfile, 'personal');
  removeBinding(project);
});

test('the record survives the CRLF the shim writes', () => {
  clearLaunches();
  const project = path.join(sandbox, 'proj-crlf');
  setBinding(project, 'work');
  const cwd = normalizeProjectPath(project);
  writeLaunchRecord(process.pid, { profile: 'work', cwd });

  // A trailing \r on the last field breaks the path comparison and makes every
  // session look drifted -- which is worse than no warning, because it trains
  // you to ignore the one that matters.
  const [session] = liveSessions({ prune: false });
  assert.equal(session.cwd, cwd);
  assert.equal(session.drifted, false);
  removeBinding(project);
});

test('an unbound session running on the default account is not drift', () => {
  clearLaunches();
  const project = path.join(sandbox, 'proj-unbound');
  fs.mkdirSync(project, { recursive: true });
  writeLaunchRecord(process.pid, { profile: 'default', cwd: normalizeProjectPath(project) });

  assert.deepEqual(driftedSessions({ prune: false }), []);
});

test('a record whose process is gone is dropped, and pruned from disk', () => {
  clearLaunches();
  const project = path.join(sandbox, 'proj-dead');
  setBinding(project, 'work');
  // A pid that cannot exist: Windows and Linux both refuse to allocate it.
  const deadPid = 999999999;
  writeLaunchRecord(deadPid, { profile: 'work', cwd: normalizeProjectPath(project) });

  assert.deepEqual(liveSessions(), []);
  assert.equal(fs.existsSync(path.join(launchesDir(), `${deadPid}.tsv`)), false);
  removeBinding(project);
});

test('a truncated record is ignored rather than thrown on', () => {
  clearLaunches();
  fs.mkdirSync(launchesDir(), { recursive: true });
  fs.writeFileSync(path.join(launchesDir(), `${process.pid}.tsv`), 'garbage\r\n');
  assert.deepEqual(liveSessions({ prune: false }), []);
});

test('liveSessions returns nothing when no launch directory exists', () => {
  clearLaunches();
  assert.deepEqual(liveSessions(), []);
});

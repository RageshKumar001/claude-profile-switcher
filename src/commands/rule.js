import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { normalizeProjectPath, resolveBinding, setBinding } from '../bindings.js';
import { isDefaultName } from '../default-profile.js';
import {
  approvalFor,
  loadRules,
  matchRule,
  normalizeRemote,
  readOriginUrl,
  readProjectConfig,
  recordApproval,
  saveRules,
} from '../rules.js';
import { profileExists } from '../store.js';
import { c, sym, table } from '../ui.js';

// -------------------------------------------------------------------- rules

export function ruleAdd(pattern, profile) {
  if (!pattern || !profile) {
    throw new Error('usage: ccp rule add <remote-pattern> <profile>');
  }
  if (!isDefaultName(profile) && !profileExists(profile)) {
    throw new Error(`no such profile "${profile}"`);
  }

  const data = loadRules();
  const existing = data.rules.find((r) => r.pattern.toLowerCase() === pattern.toLowerCase());
  if (existing) {
    existing.profile = profile;
    existing.addedAt = new Date().toISOString();
  } else {
    data.rules.push({ pattern, profile, addedAt: new Date().toISOString() });
  }
  saveRules(data);

  console.log(`${c.green(sym.ok)} ${c.bold(pattern)} ${c.dim('->')} ${c.bold(profile)}`);
  console.log(c.dim('  applies to repos you `ccp apply` or open in VS Code'));
}

export function ruleRemove(pattern) {
  const data = loadRules();
  const before = data.rules.length;
  data.rules = data.rules.filter((r) => r.pattern.toLowerCase() !== pattern?.toLowerCase());
  if (data.rules.length === before) throw new Error(`no rule matching "${pattern}"`);
  saveRules(data);
  console.log(`${c.green(sym.ok)} removed ${pattern}`);
}

export function ruleList() {
  const { rules } = loadRules();
  if (!rules.length) {
    console.log(c.dim('no rules yet'));
    console.log(c.dim('  ccp rule add "github.com/acme/*" work'));
    return;
  }
  // Longest pattern first, which is also the order they are matched in.
  const rows = [...rules]
    .sort((a, b) => b.pattern.length - a.pattern.length)
    .map((r) => [
      c.bold(r.pattern),
      c.dim('->'),
      isDefaultName(r.profile) || profileExists(r.profile)
        ? r.profile
        : c.red(`${r.profile} ${sym.warn} missing`),
    ]);
  console.log(table(rows));
}

// ------------------------------------------------------------------- apply

/**
 * Work out which account a directory should use, without changing anything.
 *
 * Order matters: an explicit binding is something you did on purpose and always
 * wins. After that a checked-in .ccp.json beats a rule, because it is the more
 * specific statement -- but only once approved.
 */
export function resolveDeclared(cwd) {
  const key = normalizeProjectPath(cwd);
  const existing = resolveBinding(cwd);

  const project = readProjectConfig(cwd);
  if (project) {
    return {
      key,
      existing,
      source: 'project-config',
      profile: project.profile,
      file: project.file,
      dir: project.dir,
      approval: approvalFor(normalizeProjectPath(project.dir)),
    };
  }

  const remote = readOriginUrl(cwd);
  const rule = remote ? matchRule(remote) : null;
  if (rule) {
    return {
      key,
      existing,
      source: 'rule',
      profile: rule.profile,
      pattern: rule.pattern,
      remote: normalizeRemote(remote),
    };
  }

  return { key, existing, source: null, profile: null, remote: normalizeRemote(remote) };
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} ${c.dim('[y/N]')} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Turn whatever this directory declares into a real binding.
 *
 * The shim only reads bindings.tsv, so rules and .ccp.json have to be resolved
 * here and written down. That is deliberate: it keeps the thing in front of
 * every Claude launch a parser-free lookup that cannot fail.
 */
export async function apply({
  cwd = process.cwd(),
  yes = false,
  deny = false,
  dryRun = false,
  json = false,
  quiet = false,
} = {}) {
  const found = resolveDeclared(cwd);
  const say = (...args) => !quiet && !json && console.log(...args);
  const report = (result) => {
    if (json) console.log(JSON.stringify({ ...result, source: found.source }, null, 2));
    return result;
  };

  // The VS Code extension cannot answer a terminal prompt, so it asks what
  // would happen, puts the question in its own UI, and comes back with --yes
  // or --deny.
  if (dryRun) {
    return report({
      applied: false,
      reason: 'dry-run',
      profile: found.profile,
      approval: found.approval ?? null,
      file: found.file ?? null,
      pattern: found.pattern ?? null,
      remote: found.remote ?? null,
      alreadyBound: found.existing?.profile ?? null,
    });
  }

  if (deny) {
    if (found.source !== 'project-config') {
      return report({ applied: false, reason: 'nothing-to-deny' });
    }
    recordApproval(normalizeProjectPath(found.dir), 'denied', found.profile);
    say(c.dim(`${found.file} declined`));
    return report({ applied: false, reason: 'denied', profile: found.profile });
  }

  if (!found.source) {
    say(c.dim(found.remote ? `no rule matches ${found.remote}` : 'nothing declared here'));
    say(c.dim('  ccp rule add <pattern> <profile>, or add a .ccp.json'));
    return report({ applied: false, reason: 'nothing-declared' });
  }

  if (!isDefaultName(found.profile) && !profileExists(found.profile)) {
    say(
      `${c.yellow(sym.warn)} ${found.source === 'rule' ? 'rule' : found.file} asks for ` +
        `${c.bold(found.profile)}, which does not exist here`,
    );
    return report({ applied: false, reason: 'missing-profile', profile: found.profile });
  }

  if (found.existing?.profile === found.profile) {
    say(c.dim(`already bound to ${found.profile}`));
    return report({ applied: false, reason: 'already-bound', profile: found.profile });
  }

  if (found.source === 'project-config') {
    const projectKey = normalizeProjectPath(found.dir);
    if (found.approval === 'denied' && !yes) {
      say(c.dim(`${found.file} was declined before -- ccp apply --yes to change that`));
      return report({ applied: false, reason: 'denied', profile: found.profile });
    }
    if (found.approval !== 'approved' && !yes) {
      // This file came with someone else's repo. It cannot carry credentials,
      // but it can decide which of your accounts gets spent, so it is asked
      // about once rather than obeyed silently.
      say(`${c.bold(found.file)} asks for account ${c.bold(found.profile)}`);
      say(c.dim('  a .ccp.json holds only a name -- no credentials -- but it does'));
      say(c.dim('  choose which of your accounts this repo uses'));
      const ok = await confirm('  Honour it for this project?');
      recordApproval(projectKey, ok ? 'approved' : 'denied', found.profile);
      if (!ok) {
        say(c.dim('  declined; this project keeps using the default account'));
        return report({ applied: false, reason: 'denied', profile: found.profile });
      }
    } else if (found.approval !== 'approved') {
      recordApproval(projectKey, 'approved', found.profile);
    }
  }

  setBinding(cwd, found.profile);
  const why =
    found.source === 'rule'
      ? `${c.dim('rule')} ${found.pattern} ${c.dim('->')} ${found.remote}`
      : c.dim(found.file);
  say(`${c.green(sym.ok)} ${path.resolve(cwd)}`);
  say(`  bound to ${c.bold(found.profile)}  ${why}`);
  return report({ applied: true, profile: found.profile });
}

// -------------------------------------------------------------------- scan

/** Directories that look like a project: a repo, or something that declares one. */
function* projectDirs(root, depth) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const isProject = entries.some((e) => e.name === '.git' || e.name === '.ccp.json');
  if (isProject) {
    yield root;
    return; // do not descend into a repo looking for more repos
  }
  if (depth <= 0) return;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    yield* projectDirs(path.join(root, entry.name), depth - 1);
  }
}

/** Apply rules across a whole tree of repos in one go. */
export async function scan(root, { depth = 3, yes = false } = {}) {
  const start = path.resolve(root ?? process.cwd());
  if (!fs.existsSync(start)) throw new Error(`no such directory ${start}`);

  console.log(c.dim(`scanning ${start} (depth ${depth})`));
  console.log('');

  let bound = 0;
  let skipped = 0;
  for (const dir of projectDirs(start, depth)) {
    const result = await apply({ cwd: dir, yes, quiet: true });
    if (result.applied) {
      bound++;
      console.log(`${c.green(sym.ok)} ${c.bold(result.profile)}  ${c.dim(dir)}`);
    } else if (result.reason === 'missing-profile') {
      console.log(`${c.yellow(sym.warn)} wants ${result.profile}  ${c.dim(dir)}`);
      skipped++;
    } else if (result.reason === 'denied') {
      skipped++;
    }
  }

  console.log('');
  console.log(
    bound ? `${bound} project(s) bound` : c.dim('nothing matched -- add a rule with `ccp rule add`'),
  );
  if (skipped) console.log(c.dim(`${skipped} skipped`));
}

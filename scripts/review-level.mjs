#!/usr/bin/env node
// review-level.mjs: how deep a review a branch needs, decided by code from what the branch changed.
//
// What it does, in plain English:
//   A review has one of three levels. What each asks of the reviewer is in docs/agents/procedures/review-levels.md.
//     deep       the change touches a high-risk path ("highRiskPaths" in scripts/kit.config.json:
//                sign-in, money, stored data, and the like)
//     quick      every changed file is under a quick review path ("quickReviewPaths"), and the lines
//                added plus the lines removed are at most "quickReviewMaxLines" (50 when not set)
//     standard   everything else
//   Deep is tested first, so a small change in a high-risk place is still deep. A path in those lists
//   that ends in "/" is a folder and everything inside it; any other entry is one file exactly.
//   The change is what the branch did since it left the base branch, in commits. A renamed file
//   counts under its old name and its new one. A changed file that is not text (a picture, say) has
//   no lines to count, so such a change is never quick. A branch that changed no file is standard.
//   A branch cannot lower its own level: the settings are read from git, from the base branch as it
//   is right now and from the branch, and joined in the stricter direction. The high-risk paths of
//   both count. A quick review path counts only when the base branch lists it and the branch still
//   does. The line limit is the smaller of the two.
//   With no "quickReviewPaths" set, no change is quick: a project that never asked for quick reviews
//   gets standard and deep ones only.
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/review-level.mjs [<branch>] [--base <ref>]
//       Prints "kit-level <level> <why>". <branch> is the current one when left out. The base is
//       <remote>/<baseBranch> from scripts/kit.config.json, else the local <baseBranch>, unless
//       --base names another.
// Exit codes: 0 done, 1 an error (git cannot read the branch, or the settings are bad), 2 wrong usage.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILE, baseCandidates, loadConfig, mergeConfig } from './check-plans.mjs';

// Lowest first: a review at a later level also covers the earlier ones.
export const LEVELS = Object.freeze(['quick', 'standard', 'deep']);
// The line limit for a quick review when the settings name none.
export const QUICK_MAX_LINES = 50;
const USAGE = 'Usage: node scripts/review-level.mjs [<branch>] [--base <ref>]';

const usage = (msg) => Object.assign(new Error(msg), { usage: true });
// The first entry of a path list that holds the file: a folder (ends in "/") or that exact file.
const under = (file, paths) => paths.find((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

// The level for one change: { level, why }. why is one plain sentence part, for the printed line.
//   files: every path the change touched. lines: lines added plus lines removed; a number that is
//   not finite means they could not be counted.
export function reviewLevel({ files = [], lines = 0, highRiskPaths = [], quickReviewPaths = [], quickReviewMaxLines = QUICK_MAX_LINES } = {}) {
  for (const file of files) {
    const risky = under(file, highRiskPaths);
    if (risky !== undefined) return { level: 'deep', why: `the change touches the high-risk path ${risky} (${file})` };
  }
  const standard = (why) => ({ level: 'standard', why });
  if (!files.length) return standard('the branch changed no file');
  if (!quickReviewPaths.length) return standard('the change is not in a high-risk path, and no quick review path is set on the base branch');
  const outside = files.find((f) => under(f, quickReviewPaths) === undefined);
  if (outside !== undefined) return standard(`${outside} is not under a quick review path`);
  if (!Number.isFinite(lines)) return standard('a changed file is not text, so its lines cannot be counted');
  if (lines > quickReviewMaxLines) return standard(`${lines} lines were added or removed, more than the quick review limit of ${quickReviewMaxLines}`);
  return { level: 'quick', why: `every changed file is under a quick review path, and ${lines} ${lines === 1 ? 'line was' : 'lines were'} added or removed (the limit is ${quickReviewMaxLines})` };
}

// The base branch's settings joined with the branch's, in the stricter direction:
// { highRiskPaths, quickReviewPaths, quickReviewMaxLines }. A missing key takes its default.
export function joinSettings(base = {}, branch = {}) {
  const branchQuick = branch.quickReviewPaths ?? [];
  return {
    highRiskPaths: [...new Set([...(base.highRiskPaths ?? []), ...(branch.highRiskPaths ?? [])])],
    quickReviewPaths: (base.quickReviewPaths ?? []).filter((p) => branchQuick.includes(p)),
    quickReviewMaxLines: Math.min(base.quickReviewMaxLines ?? QUICK_MAX_LINES, branch.quickReviewMaxLines ?? QUICK_MAX_LINES),
  };
}

// ---------- Reading a branch (git) ----------

const gitIn = (root) => (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// The level for one branch: { level, why, files, lines, base }.
//   root: the project's folder. base: the base ref (found from the settings when left out).
//   branch: the branch to read (the current one when left out).
//   readSettings(raw) -> settings: checks one copy of the settings file; the rule checker's own by default.
//   files: the paths the branch changed. lines: the lines added plus removed that could be counted.
// Throws, with a plain message, when git cannot find the branch, the base, or where they parted, or
// when a copy of the settings file is bad.
export function levelFor(root, { base, branch = 'HEAD', readSettings = mergeConfig } = {}) {
  const git = gitIn(root);
  const exists = (ref) => git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).code === 0;
  if (!exists(branch)) throw new Error(`git has no branch or commit named ${branch} here. Check the name, and fetch first if it is on the shared copy.`);
  if (base && !exists(base)) throw new Error(`git has no branch or commit named ${base} here. Fetch first, and write the base in full, like origin/main.`);
  if (!base) {
    const tried = baseCandidates(loadConfig(root));
    base = tried.find(exists);
    if (!base) throw new Error(`cannot find the base branch here (tried ${tried.join(' and ')}). Fetch first, or name it with --base, like --base origin/main.`);
  }
  const settingsOn = (ref) => {
    const shown = git(['show', `${ref}:${CONFIG_FILE}`]);
    if (shown.code !== 0) return readSettings({}); // no settings file there: the defaults
    let raw;
    try {
      raw = JSON.parse(shown.stdout);
    } catch (e) {
      throw new Error(`${CONFIG_FILE} on ${ref} is not valid JSON: ${e.message}`);
    }
    return readSettings(raw);
  };
  const joined = joinSettings(settingsOn(base), settingsOn(branch));
  const fork = git(['merge-base', base, branch]);
  if (fork.code !== 0) throw new Error(`cannot find where ${branch} left ${base}: ${(fork.stderr || 'the two share no commit').trim()}`);
  // One record per file: "<added> TAB <removed> TAB <path>", ended by a zero byte. A file that is not
  // text shows "-" for both counts.
  const stat = git(['diff', '--numstat', '-z', '--no-renames', fork.stdout.trim(), branch]);
  if (stat.code !== 0) throw new Error(`cannot list what ${branch} changed: ${stat.stderr.trim()}`);
  const files = [];
  let lines = 0;
  let notText = false;
  for (const record of stat.stdout.split('\0').filter(Boolean)) {
    const [added, removed, ...path] = record.split('\t');
    files.push(path.join('\t'));
    if (added === '-' || removed === '-') notText = true;
    else lines += Number(added) + Number(removed);
  }
  return { ...reviewLevel({ files, lines: notText ? Infinity : lines, ...joined }), files, lines, base };
}

// ---------- The command line ----------

function parseArgs(argv) {
  const o = { branch: undefined, base: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') {
      o.base = argv[++i];
      if (!o.base || o.base.startsWith('-')) throw usage('--base needs a ref, like origin/main.');
    } else if (a.startsWith('-')) throw usage(`unknown option ${a}`);
    else if (o.branch !== undefined) throw usage(`unexpected ${a}: name one branch at most.`);
    else o.branch = a;
  }
  return o;
}

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  try {
    const o = parseArgs(argv);
    const top = gitIn(cwd)(['rev-parse', '--show-toplevel']);
    if (top.code !== 0) throw new Error(`${resolve(cwd)} is not inside a git working tree, so there is no change to read here.`);
    const found = levelFor(top.stdout.trim(), { base: o.base, branch: o.branch });
    out(`kit-level ${found.level} ${found.why}\n`);
    return 0;
  } catch (e) {
    if (e.usage) {
      err(`Wrong usage: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    err(`review-level: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

#!/usr/bin/env node
// clean-worktrees.mjs: removes git worktrees whose work is finished. It never deletes a branch.
//
// A worktree is an extra working copy of a repo, on its own branch, in its own folder. Agents
// each get one, so they never edit the same folder. Each leftover worktree costs disk space and,
// if a file watcher such as watchman watches it, memory. Removing a live agent's folder, or the
// only copy of some work, is far worse than a missed cleanup. So whenever anything is unknown, the
// folder is kept.
//
// The rule, in one sentence: a worktree is removed only when all its work is already safe
// elsewhere (in the base branch, or in a branch, tag, or remote branch) and there is real evidence
// nobody uses it: no program has a folder or file in it open, no unsettled T3 Code thread names it,
// and no file in it changed in the last 15 minutes (or its branch was just merged via --merged-branch).
//
// In full, a worktree is kept if ANY of these hold (see `decide`):
//   - it is the main checkout (the project root, which belongs to the human), or the copy this runs from
//   - it is locked (`git worktree lock --reason "why" <path>` keeps a folder on purpose)
//   - it is passed with --in-use
//   - it has unsaved or new files, asked of git in a way its settings cannot hide
//   - a tracked file in it is marked assume-unchanged or skip-worktree (git would not see an edit)
//   - it holds ignored files outside the rebuildable output folders in REBUILDABLE (node_modules,
//     dist, build, caches; each must be a folder): such a file, like private/notes.txt or .env, may
//     be the only copy. The limit: ignored build and package folders are treated as rebuildable, so a
//     hand edit inside node_modules or dist is lost. The script cannot tell such an edit apart.
//   - its HEAD history (reflog), on either side of any entry, names a commit that no branch, tag,
//     or remote branch has. The script reads that history from git's files (logs/HEAD). If the repo stores it another way
//     (git's "reftable" format), or git cannot say how it stores it, every worktree is kept: no git
//     command prints both commit ids of every entry, and reading half of them could lose work
//   - its branch has an open pull request
//   - a program on this Mac has its working folder, or any file, open inside it (from `lsof`). If
//     lsof fails, warns, or its list looks incomplete, nothing at all is removed
//   - an unsettled T3 Code thread names it as its worktree, however old the thread; if T3 Code
//     cannot be asked, or any thread's detail is unreadable or incomplete, every worktree in T3
//     Code's own folder (~/.t3/worktrees) is kept
//   - a file in it, or git's record of its HEAD, changed in the quiet time (15 minutes, or 0 for a
//     branch passed with --merged-branch), going by the newer of the modified time and the change time
//     (ctime), which cannot be set back. The walk skips .git and the REBUILDABLE folders. If any file
//     cannot be checked, or there are more than 20,000 entries, the folder is kept. Folder times are
//     not read: watchman resets them.
// A worktree with commits that are not in the base branch is always "left alone", whatever its age:
// the human decides about unmerged work. A fresh folder that never committed sits on the base
// branch's version, so it looks merged; the evidence above is what protects it (2026-11-04 incident).
// With --delete, each folder is checked once more just before it is removed, and a fresh lsof list
// is the very last check, after every git check. A few milliseconds still remain between that list
// and the removal: this script cannot lock a folder against programs it does not start.
//
// How to run (from any copy of the repo; needs Node 18 or newer, git, gh, and lsof):
//   node scripts/clean-worktrees.mjs              # dry run: prints the plan, changes nothing
//   node scripts/clean-worktrees.mjs --delete     # fetches, removes the folders marked "remove", and logs them
// A dry run changes nothing, not even in git: it judges from the local copy of the base branch.
// --delete first runs `git fetch --prune` and `git worktree prune`; --fetch runs only the fetch.
// Options:
//   --in-use <path>            also keep this folder (repeat for more)
//   --merged-branch <name>     allow immediate removal (0 idle wait) for a clean worktree on this branch
//   --merged-commit <sha>      narrow --merged-branch so only a worktree on this commit gets 0 idle wait
//   --ignore-pid <pid>         for a worktree on a --merged-branch only, do not count this program as
//                              using it (repeat for more). The merge script passes itself, so a merge
//                              run from inside the merged worktree does not block its own cleanup
//   --fetch                    in a dry run, fetch the base branch first (this updates git's remote refs)
//   --no-fetch                 with --delete, skip the fetch (when the caller just fetched)
//   --base <remote>/<branch>   branch that "merged" means (default origin/main, or $WORKTREE_BASE)
//   --idle-hours <n>           the quiet time (default 0.25 = 15 minutes, or $WORKTREE_IDLE_HOURS)
// Exit codes: 0 done. 1 failed (gh, lsof, or git could not answer, or a removal failed); when the
// facts cannot be read, nothing is removed. 2 wrong usage.
// Open pull requests come from `gh pr list`; $WORKTREE_OPEN_PR_BRANCHES (comma separated branch
// names) replaces that lookup, for tests. T3 Code's command line is $T3CODE_CLI_PATH or ~/.t3/bin/t3;
// its folder is $T3CODE_HOME or ~/.t3. Removals are logged to <git common dir>/worktree-cleanup.log.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { t3Path, oneLine, THREAD_ID } from './t3.mjs';

export const DEFAULT_IDLE_HOURS = 0.25;
export const IDLE_MS = DEFAULT_IDLE_HOURS * 60 * 60 * 1000;
export const DEFAULT_BASE = 'origin/main';
export const FILE_LIMIT = 20_000;
// Ignored output that a build or an install makes again, so losing it loses nothing.
export const REBUILDABLE = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.expo', '.turbo', '.cache', '.vite', '.parcel-cache', '.svelte-kit', 'Pods', 'DerivedData', '.gradle', '__pycache__', '.pytest_cache', 'test-results', 'playwright-report']);
// Ignored single files that hold nothing of value regardless of contents.
export const REBUILDABLE_FILES = new Set(['.DS_Store']);
const USAGE = 'Usage: node scripts/clean-worktrees.mjs [--delete] [--fetch|--no-fetch] [--in-use <path> ...] [--merged-branch <name> ...] [--merged-commit <sha>] [--ignore-pid <pid> ...] [--base origin/main] [--idle-hours 0.25]';

// Parses `git worktree list --porcelain`. The first entry is the main checkout (the project root).
export function parseWorktreeList(text) {
  const entries = [];
  for (const block of text.trim().split(/\n\n+/)) {
    const entry = { path: '', head: '', branch: null, locked: false };
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') entry.path = value;
      else if (key === 'HEAD') entry.head = value;
      else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'locked') entry.locked = true;
    }
    if (entry.path) entries.push(entry);
  }
  return entries;
}

// Parses `lsof -Fpcn`: a p (pid) and c (command) line per process, then an n (name) line for each
// open file, its working folder included.
export function parseLsof(text) {
  const files = [];
  let cur = {};
  for (const line of text.split('\n')) {
    const key = line[0];
    const value = line.slice(1);
    if (key === 'p') cur = { pid: Number(value), command: '' };
    else if (key === 'c') cur.command = value;
    else if (key === 'n' && cur.pid) files.push({ ...cur, path: value });
  }
  return files;
}

// Why an lsof answer cannot be trusted, or null. Any warning, a cut-off end, or a list that leaves
// out the script itself (which always has files open) means some programs may be missing.
export function lsofProblem(stdout, stderr, selfPid) {
  if (String(stderr).trim()) return `lsof warned: ${oneLine(stderr, 160)}`;
  if (stdout && !stdout.endsWith('\n')) return 'its output was cut off';
  if (!stdout.split('\n').includes(`p${selfPid}`)) return 'its output did not list this script itself, so it may be incomplete';
  return null;
}

// The programs with a folder or file open at this folder or inside it, one entry per program,
// leaving out the program ids in `ignorePids`.
export function processesIn(dir, files, ignorePids = new Set()) {
  const seen = new Map();
  for (const f of files) if ((f.path === dir || f.path.startsWith(dir + sep)) && !ignorePids.has(f.pid) && !seen.has(f.pid)) seen.set(f.pid, { pid: f.pid, command: f.command });
  return [...seen.values()];
}

// The T3 Code threads to ask about: every unsettled one, however old.
export const threadsToCheck = (list) => list.filter((t) => t.settled !== true && THREAD_ID.test(String(t.threadId ?? '')));

// The first tracked file marked assume-unchanged (a lowercase tag) or skip-worktree (S), from
// `git ls-files -v -z`, or null.
export function flaggedFile(text) {
  for (const item of text.split('\0')) {
    const tag = item[0];
    if (tag && (tag === 'S' || tag !== tag.toUpperCase())) return item.slice(2);
  }
  return null;
}

const EXPO_GENERATED_LINES = new Set([
  '/// <reference types="expo/types" />',
  '// NOTE: This file should not be edited and should be in your git ignore',
  '// NOTE: This file should not be edited and should be in your git ignore.',
]);

// True only when an ignored expo-env.d.ts holds exclusively Expo's known auto-generated lines.
export function isGeneratedExpoEnv(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.includes('/// <reference types="expo/types" />') && lines.every((l) => EXPO_GENERATED_LINES.has(l));
}

// The first ignored path (from `git ls-files --others --ignored --directory -z`) that is not inside
// a REBUILDABLE folder, or null. git ends a folder's path with "/"; a FILE named dist is not a folder.
// When `readIgnored` is given, an ignored expo-env.d.ts is rebuildable only if its contents match
// Expo's generated stub.
export function preciousIgnored(text, readIgnored = null) {
  for (const path of text.split('\0').filter(Boolean)) {
    const folders = path.split('/');
    const name = folders.pop(); // '' when the path ends in "/"; otherwise a file name, not a folder
    if (name !== '' && REBUILDABLE_FILES.has(name)) continue;
    if (name === 'expo-env.d.ts' && typeof readIgnored === 'function') {
      try {
        const content = readIgnored(path);
        if (content !== null && isGeneratedExpoEnv(content)) continue;
      } catch { /* unreadable counts as precious */ }
    }
    if (!folders.some((part) => REBUILDABLE.has(part))) return path;
  }
  return null;
}

const VALID_SHA = (s) => /^[0-9a-f]{40,64}$/.test(s) && !/^0+$/.test(s);

// Every (oldSha, newSha) pair from `commit (amend):` entries in logs/HEAD.
export function amendedPairs(text) {
  const pairs = [];
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    const reason = tab >= 0 ? line.slice(tab + 1) : '';
    const [oldSha = '', newSha = ''] = line.split(' ');
    if (reason.startsWith('commit (amend):') && VALID_SHA(oldSha) && VALID_SHA(newSha) && oldSha !== newSha) {
      pairs.push({ oldSha, newSha });
    }
  }
  return pairs;
}

// Every commit a HEAD history file (logs/HEAD) names, on both sides of each entry (moved from and
// moved to), in order, each once. A commit replaced in place by `commit (amend):` is skipped on
// the old side when `allowAmend` approves it (default: true for pure callers; live checks verify
// the amend did not delete any files).
export function reflogCommits(text, allowAmend = () => true) {
  const amended = new Set();
  for (const { oldSha, newSha } of amendedPairs(text)) {
    if (allowAmend(oldSha, newSha)) amended.add(oldSha);
  }
  const out = [];
  for (const line of text.split('\n')) {
    const [oldSha = '', newSha = ''] = line.split(' ');
    for (const sha of [oldSha, newSha]) {
      if (VALID_SHA(sha) && !out.includes(sha)) out.push(sha);
    }
  }
  return out.filter((sha) => !amended.has(sha));
}

// The commit recorded at the end of a worktree's logs/HEAD, or null.
export function lastReflogCommit(text) {
  const lines = text.trimEnd().split('\n').filter(Boolean);
  if (!lines.length) return null;
  const newSha = lines[lines.length - 1].split(' ')[1] || '';
  return VALID_SHA(newSha) ? newSha : null;
}

// "12 minutes", "3 hours", "2 days".
export function ago(ms) {
  const minutes = Math.floor(ms / 60000);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return plural(minutes, 'minute');
  if (minutes < 48 * 60) return plural(Math.floor(minutes / 60), 'hour');
  return plural(Math.floor(minutes / 1440), 'day');
}

const changedMs = (st) => Math.max(st.mtimeMs, st.ctimeMs);

// The newest change in a folder's files (the newer of modified and change time). Stops at the first
// file changed at or after sinceMs. If any entry cannot be read, or there are more than `limit`,
// `unchecked` says so and the answer is not known.
export function newestChange(dir, sinceMs, limit = FILE_LIMIT) {
  let ms = 0;
  let file = null;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let items;
    try { items = readdirSync(d, { withFileTypes: true }); } catch {
      return { ms, file, unchecked: `a folder in it could not be checked (${relative(dir, d) || '.'})` };
    }
    for (const item of items) {
      if (++seen > limit) return { ms, file, unchecked: `it has more than ${limit} files to check` };
      const p = join(d, item.name);
      if (item.isDirectory()) { if (item.name !== '.git' && !REBUILDABLE.has(item.name)) stack.push(p); continue; }
      if (item.name.startsWith('.watchman-cookie-')) continue;
      let t;
      try { t = changedMs(lstatSync(p)); } catch { return { ms, file, unchecked: `a file in it could not be checked (${relative(dir, p)})` }; }
      if (t > ms) { ms = t; file = relative(dir, p); }
      if (ms >= sinceMs) return { ms, file, unchecked: null };
    }
  }
  return { ms, file, unchecked: null };
}

// Pure rule: given the facts about one worktree, say what to do with it and why.
// action: 'remove', 'keep', or 'leave' (unmerged work, for the human).
export function decide(f, now = Date.now(), quietMs = IDLE_MS) {
  const keep = [];
  if (f.isMain) keep.push('it is the main checkout');
  if (f.isSelf) keep.push('this script runs from it');
  if (f.locked) keep.push('it is locked');
  if (f.inUse) keep.push('it was passed with --in-use');
  if (f.error) keep.push(`its state could not be read (${f.error})`);
  if (f.moved) keep.push('its branch or commit changed since the first check');
  if (f.dirty) keep.push('it has unsaved or new files');
  if (f.hiddenTracked) keep.push(`it has tracked files git is told not to check (${f.hiddenTracked})`);
  if (f.preciousIgnored) keep.push(`it holds ignored files that may be the only copy (${f.preciousIgnored})`);
  if (f.historyUnreadable) keep.push('this repo stores its history in a format the script cannot read');
  if (f.lostCommit) keep.push(`its history holds a commit that no branch, tag, or remote branch has (${f.lostCommit})`);
  if (f.openPr) keep.push('its branch has an open pull request');
  const procs = f.processes || [];
  if (procs.length) keep.push(`a program is using it (${procs.slice(0, 3).map((p) => `${p.command}, pid ${p.pid}`).join('; ')})`);
  if (f.t3Thread) keep.push(`T3 Code thread "${f.t3Thread}" works in it`);
  if (f.t3Unknown) keep.push('T3 Code could not be asked whether a thread works in it');
  if (f.filesUnchecked) keep.push(f.filesUnchecked);
  const quiet = now - (f.lastChangeMs ?? now);
  if (!f.error && quiet < quietMs) keep.push(`a file changed ${ago(quiet)} ago${f.changedFile ? ` (${f.changedFile})` : ''}`);
  if (!f.isMain && !f.isSelf && !f.error && !f.merged) return { action: 'leave', reasons: [`it has commits that are not in ${f.base || DEFAULT_BASE}`, ...keep] };
  if (keep.length) return { action: 'keep', reasons: keep };
  return { action: 'remove', reasons: [`merged into ${f.base || DEFAULT_BASE}, nothing running, no file changed for ${ago(quiet)} (ignored build and package folders are treated as rebuildable)`] };
}

const usageError = (message) => Object.assign(new Error(message), { usage: true });

// Reads the command line. Flags win over environment variables, which win over defaults.
export function parseArgs(argv, env = {}) {
  const rawIdle = env.WORKTREE_IDLE_HOURS === undefined ? '' : String(env.WORKTREE_IDLE_HOURS).trim();
  const opts = {
    remove: false,
    fetch: false,
    noFetch: false,
    inUse: [],
    mergedBranches: [],
    mergedCommit: null,
    ignorePids: [],
    base: env.WORKTREE_BASE || DEFAULT_BASE,
    idleHours: rawIdle === '' ? DEFAULT_IDLE_HOURS : Number(rawIdle),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { if (argv[i + 1] === undefined) throw usageError(`${arg} needs a value`); return argv[++i]; };
    const nonFlagValue = () => {
      const v = value();
      if (v.startsWith('--')) throw usageError(`${arg} needs a value`);
      return v;
    };
    if (arg === '--delete') opts.remove = true;
    else if (arg === '--fetch') opts.fetch = true;
    else if (arg === '--no-fetch') opts.noFetch = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--in-use') opts.inUse.push(value());
    else if (arg === '--merged-branch') opts.mergedBranches.push(nonFlagValue());
    else if (arg === '--merged-commit') opts.mergedCommit = nonFlagValue();
    else if (arg === '--ignore-pid') {
      const raw = nonFlagValue();
      if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw usageError('--ignore-pid must be a program id, a whole number above 0');
      opts.ignorePids.push(Number(raw));
    }
    else if (arg === '--base') opts.base = value();
    else if (arg === '--idle-hours') {
      const raw = value().trim();
      if (raw === '') throw usageError('--idle-hours must be a number of hours, 0 or more');
      opts.idleHours = Number(raw);
    } else throw usageError(`unknown option ${arg}`);
  }
  if (opts.fetch && opts.noFetch) throw usageError('give --fetch or --no-fetch, not both');
  if (opts.mergedCommit !== null && !VALID_SHA(opts.mergedCommit)) throw usageError('--merged-commit must be a full commit hash');
  if (!/^[^/\s]+\/\S+$/.test(opts.base)) throw usageError(`--base must look like remote/branch, for example origin/main (got "${opts.base}")`);
  if (!Number.isFinite(opts.idleHours) || opts.idleHours < 0) throw usageError('--idle-hours must be a number of hours, 0 or more');
  opts.remote = opts.base.slice(0, opts.base.indexOf('/'));
  return opts;
}

const exec = (cmd, args, cwd, timeout = 60_000, input) => execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
const git = (args, cwd, input) => exec('git', args, cwd, 60_000, input).trim();
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const changed = (p) => { try { return changedMs(statSync(p)); } catch { return 0; } };
const why = (e) => oneLine(e?.stderr || e?.message || e, 160);

// Branches with an open pull request, or null if gh fails.
function openPrBranches(repo, env) {
  if (env.WORKTREE_OPEN_PR_BRANCHES !== undefined) return new Set(env.WORKTREE_OPEN_PR_BRANCHES.split(',').filter(Boolean));
  try {
    return new Set(exec('gh', ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'headRefName', '--jq', '.[].headRefName'], repo).split('\n').filter(Boolean));
  } catch { return null; }
}

// Every program's open files and working folder. Returns { files } or { error }.
function scanPrograms(cwd) {
  const r = spawnSync('lsof', ['-n', '-P', '-Fpcn'], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { error: why(r.error) };
  if (r.status !== 0) return { error: `it stopped with code ${r.status}: ${oneLine(r.stderr, 160) || 'no message'}` };
  const problem = lsofProblem(r.stdout, r.stderr, process.pid);
  return problem ? { error: problem } : { files: parseLsof(r.stdout) };
}

// Map of real worktree path to thread title, from T3 Code. Returns { owners } or { error }.
function t3Owners(mainPath, env) {
  const cli = t3Path(env);
  try {
    const list = JSON.parse(exec(cli, ['thread', 'list', '--json', '--project', mainPath], mainPath, 15_000));
    if (!Array.isArray(list)) return { error: 'its thread list was not a list' };
    const owners = new Map();
    for (const t of threadsToCheck(list)) {
      const shown = JSON.parse(exec(cli, ['thread', 'show', '--json', '--messages', '0', t.threadId], mainPath, 15_000));
      // A full answer names worktreePath: a folder, or null for a thread with no worktree.
      const thread = shown?.thread;
      const path = thread && typeof thread === 'object' && 'worktreePath' in thread ? thread.worktreePath : undefined;
      if (path !== null && (typeof path !== 'string' || path === '')) return { error: `its detail for thread ${t.threadId} was incomplete` };
      if (path) owners.set(real(path), oneLine(thread.title || t.title || t.threadId, 80));
    }
    return { owners };
  } catch (e) {
    return { error: e.code === 'ENOENT' ? `its command line was not found at ${cli}` : why(e) };
  }
}

// When another worktree advances this worktree's branch ref, this folder's files and index stay on
// its own last merged reflog commit, making `git status` look dirty even though nothing was edited.
// Returns that merged commit SHA only when zero untracked files and zero byte diffs exist against it.
function staleRefCommit(dir, gitDir, liveHead, liveBranch, base, historyUnreadable) {
  if (historyUnreadable || liveBranch === null) return null;
  const headLog = join(gitDir, 'logs', 'HEAD');
  if (!existsSync(headLog)) return null;
  const lastSha = lastReflogCommit(readFileSync(headLog, 'utf8'));
  if (!lastSha || lastSha === liveHead) return null;
  try {
    git(['merge-base', '--is-ancestor', lastSha, base], dir);
    const untracked = git(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'ls-files', '--others', '--exclude-standard'], dir);
    if (untracked !== '') return null;
    git(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'diff', '--quiet', '--ignore-submodules=none', lastSha], dir);
    git(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'diff', '--cached', '--quiet', '--ignore-submodules=none', lastSha], dir);
    return lastSha;
  } catch {
    return null;
  }
}

// The cheap facts. The costly ones come later, only for a folder that might be removed.
function gatherFacts(entry, ctx) {
  const dir = real(entry.path);
  const facts = { base: ctx.base, isMain: ctx.isMain, isSelf: dir === ctx.self, locked: entry.locked, inUse: ctx.inUse.has(dir), historyUnreadable: ctx.historyUnreadable, moved: false, staleRef: null };
  let liveBranch = entry.branch;
  try {
    // Re-read gitDir, HEAD, and symbolic branch in one git call so a commit or checkout after
    // `git worktree list` is never missed without adding extra subprocess latency.
    const [gitDir = '', liveHead = '', fullRef = ''] = git(['rev-parse', '--absolute-git-dir', 'HEAD', '--symbolic-full-name', 'HEAD'], dir).split('\n');
    facts.gitDir = gitDir;
    liveBranch = fullRef.startsWith('refs/heads/') ? fullRef.slice('refs/heads/'.length) : null;
    if ((entry.head && liveHead !== entry.head) || liveBranch !== entry.branch) facts.moved = true;
    // HEAD and its log change on worktree creation, checkout, and commit.
    facts.lastChangeMs = Math.max(changed(join(facts.gitDir, 'HEAD')), changed(join(facts.gitDir, 'logs', 'HEAD')));
    // Settings cannot hide new files from this: untracked files are asked for by name.
    // --no-optional-locks keeps status from rewriting the index, so a dry run writes nothing.
    facts.dirty = git(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], dir) !== '';
    try { git(['merge-base', '--is-ancestor', liveHead, ctx.base], dir); facts.merged = true; } catch { facts.merged = false; }
    if (facts.dirty && facts.merged) {
      facts.staleRef = staleRefCommit(dir, facts.gitDir, liveHead, liveBranch, ctx.base, ctx.historyUnreadable);
      if (facts.staleRef) facts.dirty = false;
    }
  } catch (e) {
    facts.error = why(e);
  }
  facts.openPr = liveBranch !== null && ctx.openPrs.has(liveBranch);
  facts.processes = processesIn(dir, ctx.files, ctx.ignorePids);
  facts.t3Thread = ctx.t3.owners?.get(dir) ?? null;
  facts.t3Unknown = Boolean(ctx.t3.error) && (dir === ctx.t3Dir || dir.startsWith(ctx.t3Dir + sep));
  return facts;
}

// The costly facts: files git hides, commits only this folder's history names, and file times.
function deepFacts(dir, facts, sinceMs) {
  try {
    const readIgnored = (relPath) => {
      const full = join(dir, relPath);
      if (!lstatSync(full).isFile()) return null;
      return readFileSync(full, 'utf8');
    };
    const deep = {
      hiddenTracked: flaggedFile(git(['ls-files', '-v', '-z'], dir)),
      preciousIgnored: preciousIgnored(git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z'], dir), readIgnored),
      lostCommit: null,
    };
    const headLog = existsSync(join(facts.gitDir, 'logs', 'HEAD')) ? readFileSync(join(facts.gitDir, 'logs', 'HEAD'), 'utf8') : '';
    // An amend is safe to skip on its old side only when it did not delete any file from the old commit.
    const allowAmend = (oldSha, newSha) => {
      try {
        return git(['diff', '--diff-filter=D', '--name-only', oldSha, newSha], dir) === '';
      } catch {
        return false;
      }
    };
    const commits = reflogCommits(headLog, allowAmend);
    if (commits.length) {
      const lost = git(['rev-list', '--max-count=1', '--stdin', '--not', '--branches', '--tags', '--remotes'], dir, commits.join('\n') + '\n');
      deep.lostCommit = lost ? lost.slice(0, 7) : null;
    }
    const files = newestChange(dir, sinceMs);
    const fromFiles = files.ms > facts.lastChangeMs;
    return { ...deep, lastChangeMs: Math.max(facts.lastChangeMs, files.ms), changedFile: fromFiles ? files.file : null, filesUnchecked: files.unchecked };
  } catch (e) {
    return { error: why(e) };
  }
}

// The full verdict on one worktree, with the costly checks only when the cheap ones allow removal.
function judge(entry, isMain, ctx, quietMs) {
  const now = Date.now();
  const facts = gatherFacts(entry, { ...ctx, isMain });
  const first = decide(facts, now, quietMs);
  if (first.action !== 'remove') return { ...first, staleRef: facts.staleRef };
  return { ...decide({ ...facts, ...deepFacts(real(entry.path), facts, now - quietMs) }, now, quietMs), staleRef: facts.staleRef };
}

// Returns the exit code. io: { stdout, stderr, cwd, env } (all optional).
export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const env = io.env || process.env;
  let opts;
  try { opts = parseArgs(argv, env); } catch (e) { err(`Wrong usage: ${e.message}\n${USAGE}\n`); return 2; }
  if (opts.help) { out(`${USAGE}\n`); return 0; }
  try {
    const quietMs = opts.idleHours * 60 * 60 * 1000;
    const self = real(git(['rev-parse', '--show-toplevel'], io.cwd || process.cwd()));
    const log = join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], self), 'worktree-cleanup.log');
    // HEAD history is read from files only in git's "files" format; anything else, or no answer, is unknown.
    let historyUnreadable = true;
    try { historyUnreadable = git(['rev-parse', '--show-ref-format'], self) !== 'files'; } catch {}
    if ((opts.remove && !opts.noFetch) || opts.fetch) git(['fetch', '-q', '--prune', opts.remote], self);
    try { git(['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`], self); } catch {
      err(`The base branch ${opts.base} was not found. Nothing removed. Pass --base <remote>/<branch>.\n`);
      return 1;
    }
    if (opts.remove) git(['worktree', 'prune'], self);
    const openPrs = openPrBranches(self, env);
    if (openPrs === null) { err('Could not list open pull requests (gh pr list failed). Nothing removed. Check `gh auth status`.\n'); return 1; }
    const scan = scanPrograms(self);
    if (scan.error) { err(`Could not see which programs are using files (lsof: ${scan.error}). Nothing removed.\n`); return 1; }
    const entries = parseWorktreeList(git(['worktree', 'list', '--porcelain'], self));
    const t3 = t3Owners(real(entries[0].path), env);
    const t3Dir = real(join(env.T3CODE_HOME || join(homedir(), '.t3'), 'worktrees'));
    if (t3.error) out(`Note: T3 Code could not be asked about its threads (${t3.error}). Worktrees in ${t3Dir} are kept.\n`);
    const ctx = { base: opts.base, self, historyUnreadable, inUse: new Set(opts.inUse.map(real)), mergedBranches: new Set(opts.mergedBranches), mergedCommit: opts.mergedCommit, ignorePids: new Set(opts.ignorePids), openPrs, files: scan.files, t3, t3Dir };

    let removed = 0;
    let failed = 0;
    entries.forEach((entry, i) => {
      if (!existsSync(entry.path)) return;
      const branchMatches = entry.branch !== null && ctx.mergedBranches.has(entry.branch);
      const commitMatches = !ctx.mergedCommit || entry.head === ctx.mergedCommit;
      const justMerged = branchMatches && commitMatches;
      const entryQuietMs = justMerged ? 0 : quietMs;
      // --ignore-pid counts only for the just-merged worktree; every other folder sees every program.
      const ignorePids = justMerged ? ctx.ignorePids : new Set();
      const verdict = judge(entry, i === 0, { ...ctx, ignorePids }, entryQuietMs);
      const label = { keep: 'kept', leave: 'left alone', remove: 'remove' }[verdict.action];
      out(`${entry.path} [${entry.branch ?? 'detached'}]\n  ${label}: ${verdict.reasons.join('; ')}\n`);
      if (verdict.action !== 'remove' || !opts.remove) return;
      // Check once more just before removing: every git check first, then a fresh list of programs last.
      const second = judge(entry, false, { ...ctx, ignorePids, files: [] }, entryQuietMs);
      if (second.action !== 'remove') { out(`  not removed: it was checked again just before removal: ${second.reasons.join('; ')}\n`); return; }
      const again = scanPrograms(self);
      if (again.error) { out(`  not removed: lsof could not check it again (${again.error})\n`); failed++; return; }
      const users = processesIn(real(entry.path), again.files, ignorePids);
      if (users.length) { out(`  not removed: it was checked again just before removal: ${decide({ processes: users, merged: true, lastChangeMs: 0 }).reasons.join('; ')}\n`); return; }
      // No --force: git itself refuses if a file appeared since the check.
      // For a stale-ref worktree (its branch moved in another checkout, while this folder's files
      // and index still match its own already-merged last reflog commit), detach only this
      // worktree's HEAD to that commit first so git still checks cleanliness without --force.
      try {
        if (second.staleRef) git(['update-ref', '--no-deref', 'HEAD', second.staleRef], entry.path);
        git(['worktree', 'remove', entry.path], self);
        appendFileSync(log, `${new Date().toISOString()} removed ${entry.path} ${entry.branch ?? entry.head}\n`);
        out('  removed.\n');
        removed++;
      } catch (e) {
        if (second.staleRef && entry.branch) {
          try {
            git(['symbolic-ref', 'HEAD', `refs/heads/${entry.branch}`], entry.path);
          } catch (re) {
            out(`  warning: could not restore branch ${entry.branch} (${why(re)})\n`);
          }
        }
        out(`  could not remove it: ${why(e)}\n`);
        failed++;
      }
    });
    if (!opts.remove && opts.fetch) out('Dry run (fetched remote refs; no worktrees removed). Add --delete to remove the folders marked "remove".\n');
    else if (!opts.remove) out('Dry run. Nothing changed. Add --delete to remove the folders marked "remove".\n');
    else out(`Done. Removed ${removed} worktrees${failed ? `; ${failed} could not be removed` : ''}. No branch was deleted. Log: ${log}\n`);
    return failed ? 1 : 0;
  } catch (e) {
    err(`clean-worktrees: ${why(e)}. Nothing more was removed.\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

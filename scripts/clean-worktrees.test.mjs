// Tests for clean-worktrees.mjs. Run: node --test scripts/clean-worktrees.test.mjs
// Each rule that protects a worktree has a test that fails if the rule is removed.
// The end to end tests run the real script inside throwaway repos with a fake remote (a bare repo)
// and a fake T3 Code command line. They never ask the real T3 Code and never touch a real project.
// A file's change time (ctime) cannot be set back, so the tests about quiet time use a quiet time of
// a few seconds and really wait; the others use a quiet time of 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, utimesSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ago, decide, flaggedFile, isGeneratedExpoEnv, lsofProblem, newestChange, parseArgs, parseLsof, parseWorktreeList, preciousIgnored, processesIn, reflogCommits, threadsToCheck, IDLE_MS, FILE_LIMIT } from './clean-worktrees.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'clean-worktrees.mjs');
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = { isMain: false, isSelf: false, locked: false, inUse: false, dirty: false, openPr: false, processes: [], t3Thread: null, t3Unknown: false, filesUnchecked: null, hiddenTracked: null, preciousIgnored: null, lostCommit: null, base: 'origin/main' };
// Everything in it is merged, nothing uses it, and nothing changed for two days.
const finished = { ...clean, merged: true, lastChangeMs: NOW - 2 * 24 * HOUR };

test('a finished worktree is removed, and the output says why', () => {
  assert.deepEqual(decide(finished, NOW), { action: 'remove', reasons: ['merged into origin/main, nothing running, no file changed for 2 days (ignored build and package folders are treated as rebuildable)'] });
});

for (const [name, change, reason] of [
  ['the main checkout', { isMain: true }, 'it is the main checkout'],
  ['the copy this runs from', { isSelf: true }, 'this script runs from it'],
  ['a locked worktree', { locked: true }, 'it is locked'],
  ['a worktree passed with --in-use', { inUse: true }, 'it was passed with --in-use'],
  ['a worktree whose branch or commit changed since the first check', { moved: true }, 'its branch or commit changed since the first check'],
  ['a worktree with unsaved or new files', { dirty: true }, 'it has unsaved or new files'],
  ['a worktree with tracked files git is told not to check', { hiddenTracked: 'a.txt' }, 'it has tracked files git is told not to check (a.txt)'],
  ['a worktree holding ignored files that may be the only copy', { preciousIgnored: 'private/' }, 'it holds ignored files that may be the only copy (private/)'],
  ['a worktree whose history holds a commit nothing else has', { lostCommit: 'abc1234' }, 'its history holds a commit that no branch, tag, or remote branch has (abc1234)'],
  ['a worktree whose branch has an open pull request', { openPr: true }, 'its branch has an open pull request'],
  ['a worktree a program uses', { processes: [{ pid: 42, command: 'node' }] }, 'a program is using it (node, pid 42)'],
  ['a worktree an unsettled T3 Code thread works in', { t3Thread: 'Fix login' }, 'T3 Code thread "Fix login" works in it'],
  ['a T3 Code worktree when T3 Code cannot be asked', { t3Unknown: true }, 'T3 Code could not be asked whether a thread works in it'],
  ['a worktree whose files could not all be checked', { filesUnchecked: 'it has more than 20000 files to check' }, 'it has more than 20000 files to check'],
  ['a worktree with a file changed 12 minutes ago', { lastChangeMs: NOW - 12 * 60 * 1000, changedFile: 'src/a.ts' }, 'a file changed 12 minutes ago (src/a.ts)'],
  ['a worktree in a repo whose history format the script cannot read', { historyUnreadable: true }, 'this repo stores its history in a format the script cannot read'],
  ['a worktree whose facts could not be read', { error: 'boom' }, 'its state could not be read (boom)'],
]) {
  test(`keeps ${name}`, () => {
    assert.deepEqual(decide({ ...finished, ...change }, NOW), { action: 'keep', reasons: [reason] });
  });
}

test('a worktree with commits not in the base branch is left alone, however old and quiet', () => {
  const unmerged = { ...finished, merged: false, lastChangeMs: NOW - 365 * 24 * HOUR };
  assert.deepEqual(decide(unmerged, NOW), { action: 'leave', reasons: ['it has commits that are not in origin/main'] });
  assert.equal(decide({ ...unmerged, isMain: true }, NOW).action, 'keep');
});

test('the default quiet time is 15 minutes, and a custom one is honored', () => {
  assert.equal(IDLE_MS, 0.25 * HOUR);
  const tenMinutes = { ...finished, lastChangeMs: NOW - 10 * 60 * 1000 };
  assert.equal(decide(tenMinutes, NOW).action, 'keep');
  assert.equal(decide(tenMinutes, NOW, 5 * 60 * 1000).action, 'remove');
  const twentyMinutes = { ...finished, lastChangeMs: NOW - 20 * 60 * 1000 };
  assert.equal(decide(twentyMinutes, NOW).action, 'remove');
});

test('says how long ago in plain words', () => {
  assert.deepEqual([ago(30_000), ago(60_000), ago(12 * 60_000), ago(3 * HOUR), ago(3 * 24 * HOUR)],
    ['less than a minute', '1 minute', '12 minutes', '3 hours', '3 days']);
});

test('options: defaults, environment, and flags (flags win); unknown options are refused', () => {
  const d = parseArgs([]);
  assert.deepEqual([d.base, d.remote, d.idleHours, d.remove, d.fetch, d.noFetch, d.mergedBranches, d.mergedCommit], ['origin/main', 'origin', 0.25, false, false, false, [], null]);
  assert.equal(parseArgs(['--fetch']).fetch, true);
  assert.equal(parseArgs(['--no-fetch']).noFetch, true);
  assert.equal(parseArgs([], { WORKTREE_IDLE_HOURS: '0' }).idleHours, 0);
  assert.equal(parseArgs([], { WORKTREE_IDLE_HOURS: '' }).idleHours, 0.25);
  assert.equal(parseArgs([], { WORKTREE_IDLE_HOURS: ' \t ' }).idleHours, 0.25);
  const e = parseArgs([], { WORKTREE_BASE: 'upstream/trunk', WORKTREE_IDLE_HOURS: '2' });
  assert.deepEqual([e.remote, e.idleHours], ['upstream', 2]);
  const sha = 'a'.repeat(40);
  const f = parseArgs(['--base', 'origin/develop', '--idle-hours', '1', '--in-use', '/a', '--in-use', '/b', '--merged-branch', 'build/001-a', '--merged-branch', 'lead/002-b', '--merged-commit', sha, '--delete'], { WORKTREE_BASE: 'upstream/trunk' });
  assert.deepEqual([f.base, f.idleHours, f.inUse, f.mergedBranches, f.mergedCommit, f.remove], ['origin/develop', 1, ['/a', '/b'], ['build/001-a', 'lead/002-b'], sha, true]);
  assert.throws(() => parseArgs(['--idle-hours', 'later']), /number of hours/);
  assert.throws(() => parseArgs(['--idle-hours', ' ']), /number of hours/);
  assert.throws(() => parseArgs(['--base', 'main']), /remote\/branch/);
  assert.throws(() => parseArgs(['--min-age-minutes', '5']), /unknown option/);
  assert.throws(() => parseArgs(['--in-use']), /needs a value/);
  assert.throws(() => parseArgs(['--merged-branch']), /needs a value/);
  assert.throws(() => parseArgs(['--merged-branch', '--delete']), /needs a value/);
  assert.throws(() => parseArgs(['--merged-commit', 'not-a-sha']), /full commit hash/);
  assert.throws(() => parseArgs(['--fetch', '--no-fetch']), /not both/);
});

test('parses git worktree list output, including locks and detached heads', () => {
  const list = parseWorktreeList('worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /wt/one\nHEAD bbb\nbranch refs/heads/build/001-x\nlocked kept on purpose\n\nworktree /wt/two\nHEAD ccc\ndetached\n');
  assert.deepEqual(list.map((e) => [e.path, e.branch, e.locked]), [['/repo', 'main', false], ['/wt/one', 'build/001-x', true], ['/wt/two', null, false]]);
});

test('finds programs with a working folder or an open file inside a worktree, not in a look-alike folder', () => {
  const procs = parseLsof('p10\ncnode\nfcwd\nn/wt/one\np11\nczsh\nfcwd\nn/home\nf3\nn/wt/one/src/a.ts\np12\ncvim\nfcwd\nn/wt/one-b\np13\ncbash\nfcwd\nn/\n');
  assert.deepEqual(processesIn('/wt/one', procs).map((p) => [p.pid, p.command]), [[10, 'node'], [11, 'zsh']]);
});

test('treats an lsof warning or partial output as unknown', () => {
  const full = 'p7\ncnode\nfcwd\nn/x\n';
  assert.equal(lsofProblem(full, '', 7), null);
  assert.match(lsofProblem(full, 'lsof: WARNING: can\'t stat() nfs file system /mnt', 7), /warned/);
  assert.match(lsofProblem(full, '', 8), /did not list this script/);
  assert.match(lsofProblem('p7\ncnode\nfcwd\nn/x', '', 7), /cut off/);
  assert.match(lsofProblem('', '', 7), /did not list this script/);
});

test('asks T3 Code about every unsettled thread, however old', () => {
  const iso = (ms) => new Date(ms).toISOString();
  const list = [
    { threadId: 'a', settled: false, updatedAt: iso(NOW - HOUR) },
    { threadId: 'b', settled: true, updatedAt: iso(NOW - HOUR) },
    { threadId: 'c', settled: false, updatedAt: iso(NOW - 30 * 24 * HOUR) },
    { threadId: 'd' },
    { threadId: '--evil', settled: false },
  ];
  assert.deepEqual(threadsToCheck(list).map((t) => t.threadId), ['a', 'c', 'd']);
});

test('finds tracked files flagged assume-unchanged or skip-worktree', () => {
  assert.equal(flaggedFile('H a.txt\0H b.txt\0'), null);
  assert.equal(flaggedFile('H a.txt\0h b.txt\0'), 'b.txt');
  assert.equal(flaggedFile('H a.txt\0S c.txt\0'), 'c.txt');
  assert.equal(flaggedFile('s d.txt\0'), 'd.txt');
});

test('ignored files count as rebuildable only inside the known output folders', () => {
  const expoStub = '/// <reference types="expo/types" />\n\n// NOTE: This file should not be edited and should be in your git ignore\n';
  assert.equal(isGeneratedExpoEnv(expoStub), true);
  assert.equal(isGeneratedExpoEnv(`${expoStub}/// <reference path="./local.d.ts" />\n`), false);
  assert.equal(isGeneratedExpoEnv(`${expoStub}declare module 'custom';\n`), false);
  assert.equal(preciousIgnored('node_modules/\0packages/a/dist/\0.DS_Store\0'), null);
  assert.equal(preciousIgnored('apps/mobile/expo-env.d.ts\0', () => expoStub), null);
  assert.equal(preciousIgnored('apps/mobile/expo-env.d.ts\0', () => `${expoStub}/// <reference path="./local.d.ts" />\n`), 'apps/mobile/expo-env.d.ts');
  assert.equal(preciousIgnored('apps/mobile/expo-env.d.ts\0', () => 'declare module "custom";\n'), 'apps/mobile/expo-env.d.ts');
  assert.equal(preciousIgnored('apps/mobile/expo-env.d.ts\0'), 'apps/mobile/expo-env.d.ts');
  assert.equal(preciousIgnored('node_modules/\0private/unique.txt\0'), 'private/unique.txt');
  assert.equal(preciousIgnored('apps/server/.wrangler/state/v3/d1/local.sqlite\0'), 'apps/server/.wrangler/state/v3/d1/local.sqlite');
  assert.equal(preciousIgnored('apps/server/.wrangler/\0'), 'apps/server/.wrangler/');
  assert.equal(preciousIgnored('.env\0'), '.env');
  // A FILE named like a rebuildable folder is not rebuildable output.
  assert.equal(preciousIgnored('dist\0'), 'dist');
  assert.equal(preciousIgnored('packages/a/build\0'), 'packages/a/build');
  assert.equal(preciousIgnored('dist/\0packages/a/build/\0'), null);
});

test('reads the commits a worktree\'s HEAD history names, skipping commits replaced by commit (amend)', () => {
  const a = 'a'.repeat(40); const b = 'b'.repeat(40); const c = 'c'.repeat(40); const d = 'd'.repeat(40); const z = '0'.repeat(40);
  assert.deepEqual(reflogCommits(`${z} ${a} n <e> 1 +0000\tbranch: Created\n${a} ${b} n <e> 2 +0000\tcommit: x\n${b} ${a} n <e> 3 +0000\tcheckout: moving\n`), [a, b]);
  // A commit named only on the old side of a non-amend entry (its own entry was deleted) is read too.
  assert.deepEqual(reflogCommits(`${z} ${a} n <e> 1 +0000\tbranch: Created\n${c} ${a} n <e> 3 +0000\tcheckout: moving\n`), [a, c]);
  // A commit replaced by commit (amend) is skipped on the old side, while the amended result stays checked.
  assert.deepEqual(reflogCommits(`${z} ${a} n <e> 1 +0000\tbranch: Created\n${a} ${b} n <e> 2 +0000\tcommit: x\n${b} ${c} n <e> 3 +0000\tcommit (amend): x\n${c} ${d} n <e> 4 +0000\tcommit (amend): x\n`), [a, d]);
});

test('finds the newest change by modified or changed time, skipping rebuildable output and watchman cookies', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clean-wt-')));
  try {
    mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'node_modules', '.cache'), { recursive: true }); mkdirSync(join(dir, 'dist'));
    for (const f of ['a.txt', 'src/b.ts']) writeFileSync(join(dir, f), f);
    await sleep(1200);
    const mark = Date.now();
    for (const f of ['node_modules/.cache/x', 'dist/out.js', '.watchman-cookie-host-1-2']) writeFileSync(join(dir, f), 'new');
    assert.ok(newestChange(dir, mark).ms < mark, 'skipped files do not count');
    // Saved with the same bytes, old modified time put back: the change time still shows it.
    const old = statSync(join(dir, 'src', 'b.ts')).mtime;
    writeFileSync(join(dir, 'src', 'b.ts'), 'src/b.ts'); utimesSync(join(dir, 'src', 'b.ts'), old, old);
    assert.equal(newestChange(dir, mark).file, join('src', 'b.ts'));
    assert.match(newestChange(dir, Date.now() + IDLE_MS, 2).unchecked, /more than 2 files/);
    mkdirSync(join(dir, 'locked-away')); chmodSync(join(dir, 'locked-away'), 0o000);
    assert.equal(newestChange(dir, Date.now() + IDLE_MS).unchecked, 'a folder in it could not be checked (locked-away)');
  } finally { try { chmodSync(join(dir, 'locked-away'), 0o755); } catch {} rmSync(dir, { recursive: true, force: true }); }
});

// A throwaway repo with a fake remote, a fake T3 Code, and helpers.
function sandbox(cloneArgs = []) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'clean-wt-')));
  const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  sh(['init', '-q', '--bare', '-b', 'main', join(base, 'origin.git')], base);
  const repo = join(base, 'repo');
  sh(['clone', '-q', ...cloneArgs, join(base, 'origin.git'), repo], base);
  sh(['config', 'user.email', 't@t'], repo); sh(['config', 'user.name', 't'], repo); sh(['config', 'commit.gpgsign', 'false'], repo);
  writeFileSync(join(repo, 'a.txt'), 'a'); writeFileSync(join(repo, '.gitignore'), 'node_modules/\nprivate/\n');
  sh(['add', '.'], repo); sh(['commit', '-q', '-m', 'a'], repo); sh(['push', '-q', 'origin', 'main'], repo);
  const wt = (path, args) => { mkdirSync(dirname(path), { recursive: true }); sh(['worktree', 'add', '-q', ...args, path, 'origin/main'], repo); return path; };
  const commitIn = (p, file) => { writeFileSync(join(p, file), file); sh(['add', '.'], p); sh(['commit', '-q', '-m', file], p); };
  const t3Home = join(base, 't3home');
  mkdirSync(join(t3Home, 'worktrees'), { recursive: true });
  // A fake T3 Code command line. threads: [{ title, path, updatedAt? }]. onList: code it runs when listed.
  const fakeT3 = (threads, onList = '') => {
    const cli = join(base, 'fake-t3');
    const list = threads.map((t, i) => ({ threadId: `thread-${i}`, title: t.title, settled: false, updatedAt: t.updatedAt || new Date().toISOString() }));
    const shows = Object.fromEntries(threads.map((t, i) => [`thread-${i}`, t.show ?? { thread: { title: t.title, worktreePath: t.path } }]));
    writeFileSync(cli, `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[1] === 'list') { ${onList}; console.log(${JSON.stringify(JSON.stringify(list))}); }\nelse console.log(JSON.stringify(${JSON.stringify(shows)}[a.at(-1)]));\n`);
    chmodSync(cli, 0o755);
    return cli;
  };
  // A fake lsof, first on PATH. body: shell lines; $PPID is the script that ran it.
  const fakeLsof = (body) => {
    const bin = join(base, 'bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'lsof'), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, 'lsof'), 0o755);
    return `${bin}:${process.env.PATH}`;
  };
  const env = (extra = {}) => ({ ...process.env, WORKTREE_BASE: '', WORKTREE_IDLE_HOURS: '0', WORKTREE_OPEN_PR_BRANCHES: '', T3CODE_HOME: t3Home, T3CODE_CLI_PATH: join(base, 'no-such-t3'), ...extra });
  const run = (args, e = env(), cwd = repo) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: e });
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  return { base, sh, repo, wt, commitIn, t3Home, fakeT3, fakeLsof, env, run, cleanup };
}

const verdictFor = (output, path) => output.split('\n')[output.split('\n').findIndex((l) => l.startsWith(path + ' ')) + 1] || '';
const holdOpen = (cwd, file) => spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(file)}, 'r'); setTimeout(() => {}, 30000)`], { cwd, stdio: 'ignore' });

test('end to end: removes only finished worktrees, keeps the rest, and deletes no branch', async () => {
  const s = sandbox();
  try {
    const { sh, repo, wt, commitIn, base } = s;
    // Made a commit, merged into main. Its ignored node_modules is rebuildable, so it does not count.
    const done = wt(join(base, 'done'), ['-b', 'done']); commitIn(done, 'd.txt'); sh(['push', '-q', 'origin', 'HEAD:main'], done);
    sh(['fetch', '-q', 'origin'], repo);
    mkdirSync(join(done, 'node_modules')); writeFileSync(join(done, 'node_modules', 'cache.json'), '{}');
    const checker = wt(join(base, 'checker'), ['--detach']); // never committed: a finished read-only checker
    const busy = wt(join(base, 'busy'), ['--detach']);
    const locked = wt(join(base, 'locked'), ['--detach']); sh(['worktree', 'lock', '--reason', 'keep', locked], repo);
    const dirty = wt(join(base, 'dirty'), ['--detach']);
    const pushed = wt(join(base, 'pushed'), ['-b', 'pushed']); commitIn(pushed, 'p.txt'); sh(['push', '-q', 'origin', 'pushed'], pushed);
    const pr = wt(join(base, 'pr'), ['-b', 'has-pr']);
    const touched = wt(join(base, 'touched'), ['--detach']); // merged and git-quiet, but a file is saved later
    await sleep(3500); // everything above is now older than the 3 second quiet time
    const fresh = wt(join(base, 'fresh'), ['-b', 'fresh']); // a fresh folder on main's version: looks merged
    writeFileSync(join(dirty, 'new.txt'), 'x');
    // Same bytes, old modified time put back: git sees no change, but the change time does.
    const old = statSync(join(touched, 'a.txt')).mtime;
    writeFileSync(join(touched, 'a.txt'), 'a'); utimesSync(join(touched, 'a.txt'), old, old);

    const env = s.env({ WORKTREE_OPEN_PR_BRANCHES: 'has-pr', WORKTREE_IDLE_HOURS: String(3 / 3600) });
    const dry = s.run(['--in-use', busy], env);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(verdictFor(dry.stdout, done), /^ {2}remove: merged into origin\/main, nothing running, no file changed for less than a minute \(ignored build and package folders are treated as rebuildable\)/);
    assert.match(verdictFor(dry.stdout, checker), /remove:/);
    assert.match(verdictFor(dry.stdout, pushed), /left alone: it has commits that are not in origin\/main/);
    assert.match(verdictFor(dry.stdout, fresh), /kept: a file changed less than a minute ago/);
    assert.match(verdictFor(dry.stdout, touched), /kept: a file changed less than a minute ago \(a\.txt\)/);
    assert.match(verdictFor(dry.stdout, repo), /kept: it is the main checkout/);
    assert.match(dry.stdout, /Dry run\. Nothing changed\./);
    assert.ok(existsSync(done), 'a dry run deletes nothing');

    // Refresh fresh and touched right before --delete so slow CI/parallel dry-run load cannot expire the 3s window.
    const freshOld = statSync(join(fresh, 'a.txt')).mtime;
    writeFileSync(join(fresh, 'a.txt'), 'a'); utimesSync(join(fresh, 'a.txt'), freshOld, freshOld);
    writeFileSync(join(touched, 'a.txt'), 'a'); utimesSync(join(touched, 'a.txt'), old, old);

    const real = s.run(['--in-use', busy, '--delete'], env);
    assert.equal(real.status, 0, real.stdout + real.stderr);
    assert.equal(existsSync(done), false, 'the finished worktree is removed');
    assert.equal(existsSync(checker), false, 'the idle checker is removed');
    for (const p of [busy, locked, dirty, pushed, pr, fresh, touched, repo]) assert.ok(existsSync(p), `${p} is kept`);
    assert.match(sh(['branch', '--list', 'done'], repo), /done/, 'the removed worktree\'s branch is not deleted');
  } finally { s.cleanup(); }
});

// The first reviewer's case: merged, git quiet, but tests still running in it.
test('keeps a merged, quiet worktree while a program runs in it', async () => {
  const s = sandbox();
  try {
    const live = s.wt(join(s.base, 'live'), ['-b', 'live']); s.commitIn(live, 'b.txt'); s.sh(['push', '-q', 'origin', 'HEAD:main'], live);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: live, stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    let r;
    try { r = s.run(['--delete']); } finally { child.kill(); }
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, live), new RegExp(`kept: a program is using it \\(node, pid ${child.pid}\\)`));
    assert.ok(existsSync(live));
  } finally { s.cleanup(); }
});

test('keeps a worktree a program outside it holds a file open in', async () => {
  const s = sandbox();
  try {
    const held = s.wt(join(s.base, 'held'), ['--detach']);
    const child = holdOpen(s.base, join(held, 'a.txt'));
    await new Promise((r) => child.once('spawn', r)); await sleep(300);
    let r;
    try { r = s.run(['--delete']); } finally { child.kill(); }
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, held), /kept: a program is using it \(node/);
    assert.ok(existsSync(held));
  } finally { s.cleanup(); }
});

test('checks again just before removing: a program that arrives after the first look keeps the folder', () => {
  const s = sandbox();
  const pidFile = join(s.base, 'late.pid');
  try {
    const late = s.wt(join(s.base, 'late'), ['--detach']);
    // T3 Code is asked after the first look, so the fake starts a program in the folder then.
    const cli = s.fakeT3([], `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: ${JSON.stringify(late)}, detached: true, stdio: 'ignore' }); c.unref(); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); require('child_process').execFileSync('sleep', ['0.3'])`);
    const r = s.run(['--delete'], s.env({ T3CODE_CLI_PATH: cli }));
    assert.match(r.stdout, /not removed: it was checked again just before removal: a program is using it/);
    assert.ok(existsSync(late));
  } finally {
    try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch {}
    s.cleanup();
  }
});

for (const [name, body, why] of [
  ['warns', 'echo "p$PPID"; echo "cnode"; echo "fcwd"; echo "n/"; echo "lsof: WARNING: can\'t stat() nfs file system /mnt" >&2', /warned/],
  ['leaves this script out of its list', 'echo "p1"; echo "claunchd"; echo "fcwd"; echo "n/"', /did not list this script/],
]) {
  test(`removes nothing when lsof exits 0 but ${name}`, () => {
    const s = sandbox();
    try {
      const gone = s.wt(join(s.base, 'gone'), ['--detach']);
      const r = s.run(['--delete'], s.env({ PATH: s.fakeLsof(body) }));
      assert.equal(r.status, 1);
      assert.match(r.stderr, why);
      assert.match(r.stderr, /Nothing removed/);
      assert.ok(existsSync(gone));
    } finally { s.cleanup(); }
  });
}

test('keeps worktrees holding files git hides: ignored, untracked when hidden by config, assume-unchanged, skip-worktree', () => {
  const s = sandbox();
  try {
    const ignored = s.wt(join(s.base, 'ignored'), ['--detach']);
    mkdirSync(join(ignored, 'private')); writeFileSync(join(ignored, 'private', 'unique.txt'), 'only copy');
    const hiddenNew = s.wt(join(s.base, 'hidden-new'), ['--detach']);
    writeFileSync(join(hiddenNew, 'new.txt'), 'only copy');
    const assumed = s.wt(join(s.base, 'assumed'), ['--detach']);
    s.sh(['update-index', '--assume-unchanged', 'a.txt'], assumed); writeFileSync(join(assumed, 'a.txt'), 'edited');
    const skipped = s.wt(join(s.base, 'skipped'), ['--detach']);
    s.sh(['update-index', '--skip-worktree', 'a.txt'], skipped); writeFileSync(join(skipped, 'a.txt'), 'edited');
    s.sh(['config', 'status.showUntrackedFiles', 'no'], s.repo);
    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, ignored), /kept: it holds ignored files that may be the only copy \(private\/\)/);
    assert.match(verdictFor(r.stdout, hiddenNew), /kept: it has unsaved or new files/);
    assert.match(verdictFor(r.stdout, assumed), /kept: it has tracked files git is told not to check \(a\.txt\)/);
    assert.match(verdictFor(r.stdout, skipped), /kept: it has tracked files git is told not to check \(a\.txt\)/);
    for (const p of [ignored, hiddenNew, assumed, skipped]) assert.ok(existsSync(p), `${p} is kept`);
  } finally { s.cleanup(); }
});

test('keeps a worktree whose HEAD history holds the only record of a commit', () => {
  const s = sandbox();
  try {
    const lost = s.wt(join(s.base, 'lost'), ['--detach']);
    s.commitIn(lost, 'only-here.txt');
    const sha = s.sh(['rev-parse', '--short=7', 'HEAD'], lost).trim();
    s.sh(['checkout', '-q', '--detach', 'origin/main'], lost);
    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, lost), new RegExp(`kept: its history holds a commit that no branch, tag, or remote branch has \\(${sha}\\)`));
    assert.ok(existsSync(lost));
  } finally { s.cleanup(); }
});

test('keeps a worktree an unsettled T3 Code thread works in, however old the thread', () => {
  const s = sandbox();
  try {
    const owned = s.wt(join(s.base, 'owned'), ['--detach']);
    const loose = s.wt(join(s.base, 'loose'), ['--detach']);
    const monthAgo = new Date(Date.now() - 30 * 24 * HOUR).toISOString();
    const r = s.run(['--delete'], s.env({ T3CODE_CLI_PATH: s.fakeT3([{ title: 'Fix login', path: owned, updatedAt: monthAgo }]) }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, owned), /kept: T3 Code thread "Fix login" works in it/);
    assert.ok(existsSync(owned));
    assert.equal(existsSync(loose), false);
  } finally { s.cleanup(); }
});

for (const [name, show] of [['empty', {}], ['without a worktree field', { thread: { title: 'x' } }]]) {
  test(`a T3 Code thread detail that is ${name} counts as unknown, so T3 Code's worktrees are kept`, () => {
    const s = sandbox();
    try {
      const inT3 = s.wt(join(s.t3Home, 'worktrees', 'proj', 'a'), ['--detach']);
      const outside = s.wt(join(s.base, 'outside'), ['--detach']);
      const r = s.run(['--delete'], s.env({ T3CODE_CLI_PATH: s.fakeT3([{ title: 'Odd', show }]) }));
      assert.equal(r.status, 0, r.stderr);
      assert.match(verdictFor(r.stdout, inT3), /kept: T3 Code could not be asked whether a thread works in it/);
      assert.ok(existsSync(inT3));
      assert.equal(existsSync(outside), false);
    } finally { s.cleanup(); }
  });
}

test('a T3 Code thread with no worktree (worktreePath null) is a full answer', () => {
  const s = sandbox();
  try {
    const inT3 = s.wt(join(s.t3Home, 'worktrees', 'proj', 'a'), ['--detach']);
    const r = s.run(['--delete'], s.env({ T3CODE_CLI_PATH: s.fakeT3([{ title: 'Local', show: { thread: { title: 'Local', worktreePath: null } } }]) }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(inT3), false);
  } finally { s.cleanup(); }
});

test('keeps a worktree whose lost commit is named only as the old side of a history entry', () => {
  const s = sandbox();
  try {
    const lost = s.wt(join(s.base, 'lost'), ['--detach']);
    s.commitIn(lost, 'only-here.txt');
    const sha = s.sh(['rev-parse', '--short=7', 'HEAD'], lost).trim();
    s.sh(['checkout', '-q', '--detach', 'origin/main'], lost);
    s.sh(['reflog', 'delete', 'HEAD@{1}'], lost); // drops the entry that moved to the commit
    assert.doesNotMatch(s.sh(['reflog', '--format=%H', 'HEAD'], lost), new RegExp(sha));
    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, lost), new RegExp(`its history holds a commit that no branch, tag, or remote branch has \\(${sha}\\)`));
    assert.ok(existsSync(lost));
  } finally { s.cleanup(); }
});

// git's newer "reftable" format keeps the history in binary tables, not in logs/HEAD.
test('keeps every worktree when the repo stores its history as reftable', () => {
  const s = sandbox(['--ref-format=reftable']);
  try {
    const lost = s.wt(join(s.base, 'lost'), ['--detach']);
    s.commitIn(lost, 'only-here.txt');
    s.sh(['checkout', '-q', '--detach', 'origin/main'], lost);
    s.sh(['reflog', 'delete', 'HEAD@{1}'], lost);
    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, lost), /kept: this repo stores its history in a format the script cannot read/);
    assert.ok(existsSync(lost));
  } finally { s.cleanup(); }
});

test('keeps every worktree when git cannot say how the repo stores its history (an old git)', () => {
  const s = sandbox();
  try {
    const plain = s.wt(join(s.base, 'plain'), ['--detach']);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(s.base, 'oldgit'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = "rev-parse" ] && [ "$2" = "--show-ref-format" ]; then echo "fatal: unknown option" >&2; exit 129; fi\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const r = s.run(['--delete'], s.env({ PATH: `${bin}:${process.env.PATH}` }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, plain), /kept: this repo stores its history in a format the script cannot read/);
    assert.ok(existsSync(plain));
  } finally { s.cleanup(); }
});

// A program that enters while the last git checks run must still be seen: the open-files scan is last.
test('the open-files scan is the last check before a removal', () => {
  const s = sandbox();
  const pidFile = join(s.base, 'late.pid');
  try {
    const late = s.wt(join(s.base, 'late'), ['--detach']);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(s.base, 'gitbin'); mkdirSync(bin);
    // A git that starts a program in the folder during the second "ls-files -v" (the final checks).
    writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "$1" = "ls-files" ] && [ "$2" = "-v" ] && [ "$PWD" = "${late}" ]; then
  n=$(cat "${s.base}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${s.base}/count"
  if [ $n = 2 ]; then sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "${pidFile}"; fi
fi
exec "${realGit}" "$@"
`);
    chmodSync(join(bin, 'git'), 0o755);
    const r = s.run(['--delete'], s.env({ PATH: `${bin}:${process.env.PATH}` }));
    assert.match(verdictFor(r.stdout, late), /remove:/);
    assert.match(r.stdout, /not removed: it was checked again just before removal: a program is using it \(sleep/);
    assert.ok(existsSync(late));
  } finally {
    try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch {}
    s.cleanup();
  }
});

test('when T3 Code cannot be asked, it does not crash and keeps every worktree in T3 Code\'s folder', () => {
  const s = sandbox();
  try {
    const inT3 = s.wt(join(s.t3Home, 'worktrees', 'proj', 'a'), ['--detach']);
    const outside = s.wt(join(s.base, 'outside'), ['--detach']);
    const r = s.run(['--delete']); // T3CODE_CLI_PATH points at a missing program
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /T3 Code could not be asked about its threads \(its command line was not found/);
    assert.match(verdictFor(r.stdout, inT3), /kept: T3 Code could not be asked whether a thread works in it/);
    assert.ok(existsSync(inT3));
    assert.equal(existsSync(outside), false, 'a folder outside T3 Code\'s folder is still cleaned');
  } finally { s.cleanup(); }
});

test(`keeps a worktree with more entries than the ${FILE_LIMIT} it will check`, () => {
  const s = sandbox();
  try {
    const big = s.wt(join(s.base, 'big'), ['--detach']);
    mkdirSync(join(big, 'many'));
    for (let i = 0; i <= FILE_LIMIT; i++) mkdirSync(join(big, 'many', String(i))); // empty folders: git does not see them
    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, big), new RegExp(`kept: it has more than ${FILE_LIMIT} files to check`));
    assert.ok(existsSync(big));
  } finally { s.cleanup(); }
});

test('never removes the worktree it runs from, even when it is finished', () => {
  const s = sandbox();
  try {
    const self = s.wt(join(s.base, 'self'), ['--detach']);
    const r = s.run(['--delete'], s.env(), self);
    assert.equal(r.status, 0, r.stderr);
    assert.match(verdictFor(r.stdout, self), /kept: this script runs from it/);
    assert.ok(existsSync(self));
  } finally { s.cleanup(); }
});

test('a dry run changes nothing in git: no fetch and no worktree prune, unless --fetch or --delete', () => {
  const s = sandbox();
  try {
    const { sh, repo, wt, commitIn, base } = s;
    const before = sh(['rev-parse', 'origin/main'], repo).trim();
    // The remote gains a commit; the local origin/main is put back, so only a fetch would move it.
    const ahead = wt(join(base, 'ahead'), ['--detach']); commitIn(ahead, 'n.txt'); sh(['push', '-q', 'origin', 'HEAD:main'], ahead);
    sh(['update-ref', 'refs/remotes/origin/main', before], repo);
    // A worktree whose folder is gone leaves a stale entry that `git worktree prune` would delete.
    rmSync(wt(join(base, 'stale'), ['--detach']), { recursive: true, force: true });
    const staleEntry = join(repo, '.git', 'worktrees', 'stale');
    const dry = s.run([]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run\. Nothing changed\./);
    assert.equal(sh(['rev-parse', 'origin/main'], repo).trim(), before, 'a dry run does not fetch');
    assert.ok(existsSync(staleEntry), 'a dry run does not prune worktree entries');
    const fetched = s.run(['--fetch']);
    assert.equal(fetched.status, 0, fetched.stderr);
    assert.notEqual(sh(['rev-parse', 'origin/main'], repo).trim(), before, '--fetch updates the base first');
    assert.doesNotMatch(fetched.stdout, /Nothing changed/, 'after a fetch the footer does not claim nothing changed');
    assert.match(fetched.stdout, /Dry run \(fetched remote refs; no worktrees removed\)\. Add --delete to remove the folders marked "remove"\./);
    assert.ok(existsSync(staleEntry), '--fetch alone still prunes nothing');
    const real = s.run(['--delete']);
    assert.equal(real.status, 0, real.stdout + real.stderr);
    assert.equal(existsSync(staleEntry), false, '--delete prunes stale entries');
  } finally { s.cleanup(); }
});

test('a dry run does not rewrite the git index, even for a file whose time changed but whose content did not', () => {
  const s = sandbox();
  try {
    const { repo, wt, base } = s;
    const other = wt(join(base, 'other'), ['--detach']);
    const indexes = [join(repo, '.git', 'index'), join(repo, '.git', 'worktrees', 'other', 'index')];
    const later = new Date(Date.now() + 60_000);
    for (const dir of [repo, other]) utimesSync(join(dir, 'a.txt'), later, later);
    const before = indexes.map((f) => [readFileSync(f), statSync(f).mtimeMs]);
    const dry = s.run([]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(indexes.map((f) => [readFileSync(f), statSync(f).mtimeMs]), before, 'the index files are byte for byte the same, with the same time');
  } finally { s.cleanup(); }
});

test('without --in-use, --delete runs and exits 0', () => {
  const s = sandbox();
  try {
    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Done\. Removed 0 worktrees\. No branch was deleted\./);
  } finally { s.cleanup(); }
});

test('stops with exit 1 when the base branch does not exist', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clean-wt-')));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'o.git')]);
    execFileSync('git', ['clone', '-q', join(dir, 'o.git'), join(dir, 'r')], { stdio: 'ignore' });
    const r = spawnSync(process.execPath, [SCRIPT, '--delete'], { cwd: join(dir, 'r'), encoding: 'utf8', env: { ...process.env, WORKTREE_OPEN_PR_BRANCHES: '' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The base branch origin\/main was not found\. Nothing removed\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stops with exit 1 when open pull requests cannot be listed', () => {
  const s = sandbox();
  try {
    const e = s.env({ PATH: '/usr/bin:/bin' }); delete e.WORKTREE_OPEN_PR_BRANCHES;
    const r = s.run(['--delete'], e);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Could not list open pull requests/);
  } finally { s.cleanup(); }
});

test('stops with exit 1 when it cannot see which programs are running', () => {
  const s = sandbox();
  try {
    const gone = s.wt(join(s.base, 'gone'), ['--detach']);
    const r = s.run(['--delete'], s.env({ PATH: '/usr/bin:/bin' })); // lsof lives in /usr/sbin
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Could not see which programs are using files/);
    assert.ok(existsSync(gone), 'nothing is removed');
  } finally { s.cleanup(); }
});

test('wrong usage exits 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--min-age-minutes', '5'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option --min-age-minutes/);
});

test('--merged-branch removes a clean merged worktree right away without waiting, while keeping other recent or dirty worktrees', () => {
  const s = sandbox();
  try {
    const { sh, repo, wt, commitIn, base } = s;
    const justMerged = wt(join(base, 'just-merged'), ['-b', 'build/001-done']);
    commitIn(justMerged, 'm.txt');
    sh(['push', '-q', 'origin', 'HEAD:main'], justMerged);
    sh(['fetch', '-q', 'origin'], repo);
    const otherRecent = wt(join(base, 'other-recent'), ['-b', 'build/002-other']);
    const dirtyMerged = wt(join(base, 'dirty-merged'), ['-b', 'build/003-dirty']);
    writeFileSync(join(dirtyMerged, 'unsaved.txt'), 'keep me');

    const env = s.env({ WORKTREE_IDLE_HOURS: '1' });
    const r = s.run(['--delete', '--merged-branch', 'build/001-done', '--merged-branch', 'build/003-dirty'], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(justMerged), false, 'the just-merged clean worktree is removed right away');
    assert.ok(existsSync(otherRecent), 'another recently changed worktree still waits for the quiet time');
    assert.match(verdictFor(r.stdout, otherRecent), /kept: a file changed/);
    assert.ok(existsSync(dirtyMerged), 'a dirty worktree on --merged-branch is still kept');
    assert.match(verdictFor(r.stdout, dirtyMerged), /kept: it has unsaved or new files/);
    assert.match(sh(['branch', '--list', 'build/001-done'], repo), /build\/001-done/, 'no branch is deleted');
  } finally { s.cleanup(); }
});

test('checks branch and commit again just before removal: a new commit made between the two checks keeps the folder', () => {
  const s = sandbox();
  try {
    const wtPath = s.wt(join(s.base, 'late-commit'), ['-b', 'build/004-late']);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(s.base, 'gitcommit'); mkdirSync(bin);
    // On the second check's first git call (`rev-parse --absolute-git-dir`), create a brand-new commit in the worktree.
    writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--absolute-git-dir" ] && [ "$PWD" = "${wtPath}" ]; then
  n=$(cat "${s.base}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${s.base}/count"
  if [ $n = 2 ]; then
    echo "late" > "${wtPath}/late.txt"
    "${realGit}" -C "${wtPath}" add late.txt
    "${realGit}" -C "${wtPath}" commit -q -m "late commit"
  fi
fi
exec "${realGit}" "$@"
`);
    chmodSync(join(bin, 'git'), 0o755);
    const r = s.run(['--delete', '--merged-branch', 'build/004-late'], s.env({ PATH: `${bin}:${process.env.PATH}` }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(verdictFor(r.stdout, wtPath), /remove:/);
    assert.match(r.stdout, /not removed: it was checked again just before removal:.*its branch or commit changed since the first check/);
    assert.ok(existsSync(wtPath), 'the worktree is kept when a new commit arrived before removal');
    assert.ok(existsSync(join(wtPath, 'late.txt')), 'the new commit file is intact');
  } finally { s.cleanup(); }
});

test('amended commits: removes a merged worktree whose commit was amended, but keeps an abandoned amended commit', () => {
  const s = sandbox();
  try {
    const { sh, repo, wt, commitIn, base } = s;
    const mergedAmend = wt(join(base, 'merged-amend'), ['-b', 'build/010-amended']);
    commitIn(mergedAmend, 'x.txt');
    writeFileSync(join(mergedAmend, 'x.txt'), 'x2');
    sh(['add', 'x.txt'], mergedAmend);
    sh(['commit', '-q', '--amend', '-m', 'x2'], mergedAmend);
    sh(['push', '-q', 'origin', 'HEAD:main'], mergedAmend);
    sh(['fetch', '-q', 'origin'], repo);

    const abandonedAmend = wt(join(base, 'abandoned-amend'), ['--detach']);
    commitIn(abandonedAmend, 'y.txt');
    writeFileSync(join(abandonedAmend, 'y.txt'), 'y2');
    sh(['add', 'y.txt'], abandonedAmend);
    sh(['commit', '-q', '--amend', '-m', 'y2'], abandonedAmend);
    const abandonedSha = sh(['rev-parse', '--short=7', 'HEAD'], abandonedAmend).trim();
    sh(['checkout', '-q', '--detach', 'origin/main'], abandonedAmend);

    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(mergedAmend), false, 'merged amended worktree is removed');
    assert.ok(existsSync(abandonedAmend), 'abandoned amended commit is still protected');
    assert.match(verdictFor(r.stdout, abandonedAmend), new RegExp(`its history holds a commit that no branch, tag, or remote branch has \\(${abandonedSha}\\)`));
  } finally { s.cleanup(); }
});

test('stale-ref worktree: removes a merged worktree whose branch moved in another checkout, but keeps one with a real edit or untracked file', () => {
  const s = sandbox();
  try {
    const { sh, repo, wt, commitIn, base } = s;
    // Clean stale worktree: builder commits c1, another checkout advances the branch to c2 and merges both into origin/main.
    const staleClean = wt(join(base, 'stale-clean'), ['-b', 'build/011-stale']);
    commitIn(staleClean, 's1.txt');
    const c1 = sh(['rev-parse', 'HEAD'], staleClean).trim();
    const other = join(base, 'other-checkout');
    sh(['worktree', 'add', '-q', '--detach', other, c1], repo);
    commitIn(other, 's2.txt');
    const c2 = sh(['rev-parse', 'HEAD'], other).trim();
    sh(['push', '-q', 'origin', `${c2}:main`], other);
    sh(['update-ref', 'refs/heads/build/011-stale', c2], repo);
    sh(['fetch', '-q', 'origin'], repo);

    // Dirty stale worktree: same setup, plus one real local edit in the folder.
    const staleDirty = wt(join(base, 'stale-dirty'), ['-b', 'build/012-stale-dirty']);
    commitIn(staleDirty, 'd1.txt');
    const d1 = sh(['rev-parse', 'HEAD'], staleDirty).trim();
    const other2 = join(base, 'other-checkout-2');
    sh(['worktree', 'add', '-q', '--detach', other2, d1], repo);
    commitIn(other2, 'd2.txt');
    const d2 = sh(['rev-parse', 'HEAD'], other2).trim();
    sh(['push', '-q', 'origin', `${d2}:main`], other2);
    sh(['update-ref', 'refs/heads/build/012-stale-dirty', d2], repo);
    sh(['fetch', '-q', 'origin'], repo);
    writeFileSync(join(staleDirty, 'd1.txt'), 'real unsaved edit');

    // Both look dirty to `git status` before cleanup.
    assert.notEqual(sh(['status', '--porcelain'], staleClean).trim(), '');
    assert.notEqual(sh(['status', '--porcelain'], staleDirty).trim(), '');

    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(staleClean), false, 'clean stale-ref worktree is removed without --force');
    assert.equal(sh(['rev-parse', 'refs/heads/build/011-stale'], repo).trim(), c2, 'the branch ref itself is untouched');
    assert.ok(existsSync(staleDirty), 'stale-ref worktree with a real local edit is kept');
    assert.match(verdictFor(r.stdout, staleDirty), /kept: it has unsaved or new files/);
  } finally { s.cleanup(); }
});

test('keeps a worktree holding an ignored local database under .wrangler/', () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.repo, '.gitignore'), 'node_modules/\nprivate/\n.wrangler/\n');
    s.sh(['add', '.gitignore'], s.repo);
    s.sh(['commit', '-q', '-m', 'ignore wrangler'], s.repo);
    s.sh(['push', '-q', 'origin', 'main'], s.repo);
    s.sh(['fetch', '-q', 'origin'], s.repo);
    const dbWt = s.wt(join(s.base, 'wrangler-db'), ['--detach']);
    mkdirSync(join(dbWt, '.wrangler', 'state', 'v3', 'd1'), { recursive: true });
    writeFileSync(join(dbWt, '.wrangler', 'state', 'v3', 'd1', 'local.sqlite'), 'sqlite-data');
    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(verdictFor(r.stdout, dbWt), /kept: it holds ignored files that may be the only copy \(\.wrangler\/\)/);
    assert.ok(existsSync(join(dbWt, '.wrangler', 'state', 'v3', 'd1', 'local.sqlite')), 'the ignored local database survives cleanup');
  } finally { s.cleanup(); }
});

test('expo-env.d.ts: removes worktree with generated Expo stub, keeps one with handwritten declarations', () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.repo, '.gitignore'), 'node_modules/\nprivate/\nexpo-env.d.ts\n');
    s.sh(['add', '.gitignore'], s.repo);
    s.sh(['commit', '-q', '-m', 'ignore expo-env'], s.repo);
    s.sh(['push', '-q', 'origin', 'main'], s.repo);
    s.sh(['fetch', '-q', 'origin'], s.repo);
    const genWt = s.wt(join(s.base, 'expo-gen'), ['--detach']);
    writeFileSync(join(genWt, 'expo-env.d.ts'), '/// <reference types="expo/types" />\n\n// NOTE: This file should not be edited and should be in your git ignore\n');
    const customWt = s.wt(join(s.base, 'expo-custom'), ['--detach']);
    writeFileSync(join(customWt, 'expo-env.d.ts'), '/// <reference types="expo/types" />\n/// <reference path="./local.d.ts" />\n// NOTE: This file should not be edited and should be in your git ignore\n');

    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(genWt), false, 'generated expo-env.d.ts is rebuildable');
    assert.ok(existsSync(customWt), 'handwritten expo-env.d.ts is protected');
    assert.match(verdictFor(r.stdout, customWt), /kept: it holds ignored files that may be the only copy \(expo-env\.d\.ts\)/);
  } finally { s.cleanup(); }
});

test('--merged-commit narrows --merged-branch so a reused branch on another commit keeps its quiet window', () => {
  const s = sandbox();
  try {
    const { sh, repo, wt, commitIn, base } = s;
    const mergedWt = wt(join(base, 'merged-exact'), ['-b', 'build/015-exact']);
    commitIn(mergedWt, 'e1.txt');
    const exactSha = sh(['rev-parse', 'HEAD'], mergedWt).trim();
    sh(['push', '-q', 'origin', 'HEAD:main'], mergedWt);
    sh(['fetch', '-q', 'origin'], repo);
    const otherSha = sh(['rev-parse', 'HEAD~1'], mergedWt).trim();
    const reusedWt = join(base, 'reused-branch');
    sh(['worktree', 'add', '-q', '-b', 'build/016-reused', reusedWt, otherSha], repo);

    const env = s.env({ WORKTREE_IDLE_HOURS: '1' });
    const r = s.run(['--delete', '--merged-branch', 'build/015-exact', '--merged-branch', 'build/016-reused', '--merged-commit', exactSha], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(mergedWt), false, 'exact merged branch+commit is removed right away');
    assert.ok(existsSync(reusedWt), 'worktree on a different commit still respects the quiet time');
    assert.match(verdictFor(r.stdout, reusedWt), /kept: a file changed/);
  } finally { s.cleanup(); }
});

test('keeps a worktree whose amend deleted a unique file, and handles tags sharing a branch name', () => {
  const s = sandbox();
  try {
    const { sh, repo, wt, commitIn, base } = s;
    const droppedAmend = wt(join(base, 'dropped-amend'), ['-b', 'build/017-dropped']);
    commitIn(droppedAmend, 'unique.txt');
    const origSha = sh(['rev-parse', '--short=7', 'HEAD'], droppedAmend).trim();
    sh(['rm', '-q', 'unique.txt'], droppedAmend);
    writeFileSync(join(droppedAmend, 'other.txt'), 'other');
    sh(['add', 'other.txt'], droppedAmend);
    sh(['commit', '-q', '--amend', '-m', 'dropped unique'], droppedAmend);
    sh(['push', '-q', 'origin', 'HEAD:main'], droppedAmend);
    sh(['fetch', '-q', 'origin'], repo);

    // Tag with the exact same name as a branch must not cause a false "moved" verdict.
    const sameTagWt = wt(join(base, 'same-tag'), ['-b', 'topic']);
    sh(['tag', 'topic', 'origin/main'], repo);

    const r = s.run(['--delete']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(droppedAmend), 'amend that deleted a file keeps the worktree');
    assert.match(verdictFor(r.stdout, droppedAmend), new RegExp(`its history holds a commit that no branch, tag, or remote branch has \\(${origSha}\\)`));
    assert.equal(existsSync(sameTagWt), false, 'branch sharing a tag name is still removed cleanly');
  } finally { s.cleanup(); }
});

test('stale-ref worktree keeps untracked files and staged changes, checks actual git remove args, and rolls back HEAD on failure', () => {
  const s = sandbox();
  try {
    const { sh, repo, wt, commitIn, base } = s;
    const makeStale = (name, branch, file) => {
      const p = wt(join(base, name), ['-b', branch]);
      commitIn(p, file);
      const c1 = sh(['rev-parse', 'HEAD'], p).trim();
      const tmp = join(base, `${name}-other`);
      sh(['worktree', 'add', '-q', '--detach', tmp, c1], repo);
      commitIn(tmp, `${file}-2`);
      const c2 = sh(['rev-parse', 'HEAD'], tmp).trim();
      sh(['push', '-q', 'origin', `${c2}:main`], tmp);
      sh(['update-ref', `refs/heads/${branch}`, c2], repo);
      sh(['fetch', '-q', 'origin'], repo);
      sh(['worktree', 'remove', tmp], repo);
      return { p, c1, c2 };
    };

    const untracked = makeStale('stale-untracked', 'build/018-untracked', 'u.txt');
    writeFileSync(join(untracked.p, 'new-only.txt'), 'keep');

    const staged = makeStale('stale-staged', 'build/019-staged', 'st.txt');
    writeFileSync(join(staged.p, 'st.txt'), 'staged change');
    sh(['add', 'st.txt'], staged.p);

    const rollback = makeStale('stale-rollback', 'build/020-rollback', 'rb.txt');
    const clean = makeStale('stale-clean-args', 'build/021-clean', 'cl.txt');

    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(base, 'gitlog'); mkdirSync(bin);
    const argsLog = join(base, 'remove-args.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
  echo "$*" >> "${argsLog}"
  if [ "$3" = "${rollback.p}" ]; then
    echo "simulated remove error" >&2
    exit 1
  fi
fi
exec "${realGit}" "$@"
`);
    chmodSync(join(bin, 'git'), 0o755);

    const r = s.run(['--delete', '--no-fetch'], s.env({ PATH: `${bin}:${process.env.PATH}` }));
    assert.equal(r.status, 1, 'exit 1 because rollback worktree failed removal');
    assert.ok(existsSync(untracked.p), 'stale worktree with untracked file is kept');
    assert.match(verdictFor(r.stdout, untracked.p), /kept: it has unsaved or new files/);
    assert.ok(existsSync(staged.p), 'stale worktree with staged change is kept');
    assert.match(verdictFor(r.stdout, staged.p), /kept: it has unsaved or new files/);
    assert.equal(existsSync(clean.p), false, 'clean stale worktree is removed');
    const logged = readFileSync(argsLog, 'utf8');
    assert.doesNotMatch(logged, /--force/, 'git worktree remove is never called with --force');
    assert.ok(existsSync(rollback.p), 'failed removal keeps the folder');
    assert.equal(sh(['symbolic-ref', '-q', 'HEAD'], rollback.p).trim(), 'refs/heads/build/020-rollback', 'failed removal restores HEAD to the original branch');
  } finally { s.cleanup(); }
});

test('checks branch again just before removal: switching branches at the same commit keeps the folder', () => {
  const s = sandbox();
  try {
    const wtPath = s.wt(join(s.base, 'switch-branch'), ['-b', 'build/022-a']);
    s.sh(['branch', 'build/022-b', 'origin/main'], s.repo);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(s.base, 'gitswitch'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--absolute-git-dir" ] && [ "$PWD" = "${wtPath}" ]; then
  n=$(cat "${s.base}/swcount" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${s.base}/swcount"
  if [ $n = 2 ]; then
    "${realGit}" -C "${wtPath}" checkout -q build/022-b
  fi
fi
exec "${realGit}" "$@"
`);
    chmodSync(join(bin, 'git'), 0o755);
    const r = s.run(['--delete', '--merged-branch', 'build/022-a'], s.env({ PATH: `${bin}:${process.env.PATH}` }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(verdictFor(r.stdout, wtPath), /remove:/);
    assert.match(r.stdout, /not removed: it was checked again just before removal:.*its branch or commit changed since the first check/);
    assert.ok(existsSync(wtPath), 'worktree is kept when its branch switched at the same commit');
  } finally { s.cleanup(); }
});

// Tests for merge-pr.mjs. Run: node --test scripts/merge-pr.test.mjs
// Most tests hand the flow fake git, gh, and check runners, so they are fast and touch nothing.
// The last two build real temp git repos and a fake `gh` to prove the script works end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  API_MARKER, CACHE_FILE, EXIT, MANIFEST_FILE, MAX_AGE_MS, MAX_TRIES, MERGE_CALL_SECONDS, MERGE_LOCK_MINUTES,
  BLOCK_LOG_FILE, FEATURES, cacheKey, checkOnly, checkerApi, checkerArgs, exec, findDuplicateNumbers, formatComment, isCached, isLeadBranch, logStamp, mergePr, parseArgs, parseStatusZ,
  pickTier, planChecks, protectedTestsChanged, pruneCache, readCache, recordPass, runPostMergeCleanup, settings, splitTests, writeCache,
  RETRY_CAP, failStreak, parkedAsk, parseNameStatus, planIsDone, plansMovedToCompleted, riskOf,
  LEVEL_ORDER, MODES, VERIFIED_REASON_MIN, WATCHERS, guardScope, modeOf, reviewScope, stricter, uncoveredBy, verifiedRule,
} from './merge-pr.mjs';
import { checkAsk } from './ask.mjs';
import { branchSlice, checkMessage, parseVerified } from './commit-msg.mjs';
import { pathMatches } from './checklist.mjs';
import { answerLine } from './findings.mjs';
import { LEVELS } from './review-level.mjs';
import { KINDS } from './test-changes.mjs';
import { parseTasks } from './check-plans.mjs';
import { taskStates } from './slice.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'merge-pr.mjs');
const PAPERWORK = ['docs/', 'AGENTS.md'];
const CHECKS = [
  { name: 'typecheck', run: 'pnpm typecheck' },
  { name: 'lint', run: 'pnpm lint' },
  { name: 'test', run: 'pnpm test', slot: true },
];

// ---------- Pure rules ----------

test('a docs-only change is the paperwork tier', () => {
  assert.equal(pickTier(['docs/handoff.md', 'docs/plans/active/003-save-word.md', 'AGENTS.md'], PAPERWORK), 'paperwork');
  assert.equal(pickTier([], PAPERWORK), 'paperwork');
});

test('one code file makes it the code tier', () => {
  assert.equal(pickTier(['docs/handoff.md', 'apps/mobile/src/save.ts'], PAPERWORK), 'code');
  assert.equal(pickTier(['scripts/check-plans.mjs'], PAPERWORK), 'code');
});

test('paperwork paths match a whole folder or one exact file, nothing looser', () => {
  assert.equal(pickTier(['docs-extra/notes.md'], PAPERWORK), 'code');
  assert.equal(pickTier(['AGENTS.md.bak'], PAPERWORK), 'code');
  assert.equal(pickTier(['packages/core/AGENTS.md'], PAPERWORK), 'code');
});

test('lead branches are the base branch and the lead prefixes only', () => {
  assert.equal(isLeadBranch('lead/handoff', 'main', ['lead/']), true);
  assert.equal(isLeadBranch('main', 'main', ['lead/']), true);
  assert.equal(isLeadBranch('build/003-save-word', 'main', ['lead/']), false);
  assert.equal(isLeadBranch('leader', 'main', ['lead/']), false);
  assert.equal(isLeadBranch('', 'main', ['lead/']), false);
});

test('parseArgs reads both ways to run', () => {
  assert.deepEqual(parseArgs(['42', '--ready', '--who', 'head 7']), { mode: 'merge', pr: 42, ready: true, noCache: false, noClean: false, fast: false, who: 'head 7', wait: 0, help: false });
  assert.equal(parseArgs(['#42']).pr, 42);
  assert.equal(parseArgs(['42', '--no-clean']).noClean, true);
  assert.deepEqual(parseArgs(['--check', '--fast', '--no-cache']), { mode: 'check', pr: null, ready: false, noCache: true, noClean: false, fast: true, who: '', wait: 0, help: false });
});

test('parseArgs reads --wait as whole seconds above 0, in both modes, and refuses anything else', () => {
  assert.equal(parseArgs(['42', '--wait', '540']).wait, 540);
  assert.equal(parseArgs(['--check', '--wait', '1']).wait, 1);
  for (const bad of [['42', '--wait'], ['42', '--wait', '0'], ['42', '--wait', '-5'], ['42', '--wait', '1.5'], ['42', '--wait', 'soon'], ['42', '--wait', '--ready']]) {
    assert.throws(() => parseArgs(bad), /--wait needs a number of seconds/, bad.join(' '));
  }
});

test('parseArgs refuses anything unclear', () => {
  assert.throws(() => parseArgs([]), /pull request number, or --check/);
  assert.throws(() => parseArgs(['42', '--check']), /not both/);
  assert.throws(() => parseArgs(['42', '--fast']), /only with --check/);
  assert.throws(() => parseArgs(['--check', '--ready']), /only with a pull request/);
  assert.throws(() => parseArgs(['--check', '--no-clean']), /only with a pull request/);
  assert.throws(() => parseArgs(['42', '--force']), /not understood/);
  assert.throws(() => parseArgs(['42', '43']), /only one/);
  assert.throws(() => parseArgs(['42', '--who']), /needs a name/);
});

const TEST_PATHS = ['.test.', '.spec.', '__tests__/', '__snapshots__/', 'tests/', 'test/'];
const FLAGS_OFF = { protectedTests: false, reviewReceipts: false, mergeLock: false, duplicateNumbers: false, blockLog: false, claimCheck: false, events: false, testReasons: false, incomingCommits: false, verifiedStamp: false, changeChecklist: false, reviewLevels: false, securityReview: false, findingAnswers: false };
const MODES_OFF = Object.fromEntries(Object.keys(FLAGS_OFF).map((name) => [name, 'off']));

test('settings fills defaults and fails loud on a bad checks list', () => {
  assert.deepEqual(settings({}), { baseBranch: 'main', remote: 'origin', leadPrefixes: ['lead/'], paperworkPaths: ['docs/', 'AGENTS.md'], checks: [], features: FLAGS_OFF, numberedPaths: ['docs/plans/', 'docs/decisions/'], testPaths: TEST_PATHS, models: { headAgent: [], builder: '', reviewer: '' }, highRiskPaths: [], presets: [], checkSettingsPaths: [], snapshotPaths: [], plansDir: 'docs/plans', buildPrefix: 'build/', productPaths: [], modes: MODES_OFF });
  assert.throws(() => settings({ checks: [{ name: 'test' }] }), /"name" and a "run"/);
  for (const name of ['rules', 'kit tests', 'script tests']) assert.throws(() => settings({ checks: [{ name, run: 'x' }] }), /may not be named/);
  assert.throws(() => settings({ checks: [{ name: 'a', run: 'x' }, { name: 'a', run: 'y' }] }), /two checks/);
  assert.throws(() => settings({ paperworkPaths: 'docs/' }), /must be a list/);
});

test('settings: feature flags are true or false, a missing one is false, anything else fails loud', () => {
  assert.deepEqual(FEATURES, ['protectedTests', 'reviewReceipts', 'mergeLock', 'duplicateNumbers', 'blockLog', 'claimCheck', 'events', 'testReasons', 'incomingCommits', 'verifiedStamp', 'changeChecklist', 'reviewLevels', 'securityReview', 'findingAnswers']);
  assert.equal(settings({ features: { mergeLock: true } }).features.mergeLock, true);
  assert.equal(settings({ features: { mergeLock: true } }).features.blockLog, false);
  for (const value of ['true', 1, null, 'yes']) assert.throws(() => settings({ features: { mergeLock: value } }), /"features\.mergeLock" must be true or false/, String(value));
  assert.throws(() => settings({ features: { mergelock: true } }), /unknown feature "mergelock"/, 'a misspelled flag is never silently off');
  for (const bad of [[], 'mergeLock', true]) assert.throws(() => settings({ features: bad }), /"features" must be an object/);
});

test('settings: numberedPaths lists folders ending in "/"', () => {
  assert.deepEqual(settings({ numberedPaths: ['apps/server/migrations/'] }).numberedPaths, ['apps/server/migrations/']);
  assert.deepEqual(settings({ numberedPaths: [] }).numberedPaths, []);
  for (const bad of [['docs/plans'], [''], [7]]) assert.throws(() => settings({ numberedPaths: bad }), /"numberedPaths" must list folders that end with "\/"/, JSON.stringify(bad));
});

test('findDuplicateNumbers: two different files with one number in one numbered folder clash', () => {
  const paths = ['docs/plans/', 'apps/server/migrations/'];
  assert.deepEqual(findDuplicateNumbers([
    'docs/plans/active/090-sync.md', 'docs/plans/logs/090-sync.md', // a plan and its log: one name, no clash
    'docs/plans/completed/089-old.md', 'docs/plans/active/089-new.md', // in two subfolders of one numbered folder: a clash
    'apps/server/migrations/0026_words.sql', 'apps/server/migrations/0026-users.sql', // NNNN_ and NNNN- styles: a clash
    'apps/server/migrations/0027_x.up.sql', 'apps/server/migrations/0027_x.down.sql', // one name, two parts: no clash
    'docs/threads/051-a.md', 'docs/threads/051-b.md', // not a numbered folder
    'docs/plans/_template.md', 'docs/plans/12-short.md', 'docs/plans/012-a.md', // no number, or fewer than 3 digits
  ], paths), [
    { folder: 'docs/plans/', number: '089', files: ['docs/plans/active/089-new.md', 'docs/plans/completed/089-old.md'] },
    { folder: 'apps/server/migrations/', number: '0026', files: ['apps/server/migrations/0026-users.sql', 'apps/server/migrations/0026_words.sql'] },
  ]);
  assert.deepEqual(findDuplicateNumbers(['docs/plans/a/007-x.md', 'docs/plans/b/0007-y.md'], ['docs/plans/'])[0]?.files, ['docs/plans/a/007-x.md', 'docs/plans/b/0007-y.md'], '007 and 0007 are one number');
  assert.deepEqual(findDuplicateNumbers(['docs/plans/090-a.md', 'docs/plans/090-b.md'], []), [], 'no numbered folders, nothing checked');
});

test('findDuplicateNumbers: only an .up/.down pair or one name in two folders is one item; other dots still make two names', () => {
  const dir = ['db/migrations/'];
  assert.deepEqual(findDuplicateNumbers(['db/migrations/0026_add.users.sql', 'db/migrations/0026_add.orders.sql'], dir)[0]?.files,
    ['db/migrations/0026_add.orders.sql', 'db/migrations/0026_add.users.sql'], 'two migrations on 0026 clash');
  assert.deepEqual(findDuplicateNumbers(['db/migrations/0026_add.users.up.sql', 'db/migrations/0026_add.users.down.sql'], dir), [], 'one migration, two halves');
  assert.equal(findDuplicateNumbers(['db/migrations/0026_add.users.up.sql', 'db/migrations/0026_add.orders.down.sql'], dir).length, 1, 'halves of two migrations clash');
});

test('settings: testPaths lists name pieces and folders, never wildcards', () => {
  assert.deepEqual(settings({ testPaths: ['_test.go', 'e2e/'] }).testPaths, ['_test.go', 'e2e/']);
  for (const bad of ['tests/', [''], [7], ['**/*.test.ts'], ['/']]) assert.throws(() => settings({ testPaths: bad }), /"testPaths"/, JSON.stringify(bad));
});

// `git diff --name-status -z -M` output: status, then one path (two for a rename or a copy).
const z = (...parts) => parts.join('\0') + '\0';

test('protectedTestsChanged: existing test files modified, deleted, or renamed away are listed; new ones are free', () => {
  const diff = z(
    'M', 'scripts/merge-pr.test.mjs', // modified test: listed
    'D', 'apps/mobile/__tests__/home.tsx', // deleted file in a test folder: listed
    'R100', 'packages/core/word.spec.ts', 'packages/core/old/word.ts', // renamed away from a test name: listed
    'R087', 'tests/a.ts', 'tests/b.ts', // renamed inside a test folder: listed under its old name
    'T', 'apps/server/tests/fixture.json', // type change: listed as modified
    'A', 'scripts/new.test.mjs', // new test file: free
    'C090', 'scripts/slot.test.mjs', 'scripts/slot2.test.mjs', // copy: the old file is untouched, the copy is new
    'R100', 'src/helper.ts', 'tests/helper.ts', // a non-test file moved into a test folder: new there
    'M', 'src/app.ts', // not a test
    'M', 'docs/testing.md', 'M', 'latest/x.ts', 'M', 'contests/x.ts', // look close, are not tests
  );
  assert.deepEqual(protectedTestsChanged(diff, TEST_PATHS), [
    { file: 'apps/mobile/__tests__/home.tsx', change: 'deleted' },
    { file: 'apps/server/tests/fixture.json', change: 'modified' },
    { file: 'packages/core/word.spec.ts', change: 'renamed', to: 'packages/core/old/word.ts' },
    { file: 'scripts/merge-pr.test.mjs', change: 'modified' },
    { file: 'tests/a.ts', change: 'renamed', to: 'tests/b.ts' },
  ]);
  assert.deepEqual(protectedTestsChanged('', TEST_PATHS), [], 'nothing changed');
  assert.deepEqual(protectedTestsChanged(z('M', 'a.test.ts'), []), [], 'no test paths, nothing listed');
  assert.deepEqual(protectedTestsChanged(z('M', 'my file.test.ts'), TEST_PATHS), [{ file: 'my file.test.ts', change: 'modified' }], 'spaces in a name are kept');
});

test('planChecks: paperwork runs only the rules and script tests', () => {
  const { planned, skipped } = planChecks({ tier: 'paperwork', checks: CHECKS, scriptTests: ['scripts/a.test.mjs'] });
  assert.deepEqual(planned.map((p) => p.name), ['rules', 'script tests']);
  assert.deepEqual(skipped, [{ name: 'typecheck', why: 'docs-only' }, { name: 'lint', why: 'docs-only' }, { name: 'test', why: 'docs-only' }]);
});

test('planChecks: code runs everything in order, and --fast leaves out slot checks', () => {
  const full = planChecks({ tier: 'code', checks: CHECKS, scriptTests: ['scripts/a.test.mjs'] });
  assert.deepEqual(full.planned.map((p) => p.name), ['rules', 'script tests', 'typecheck', 'lint', 'test']);
  assert.equal(full.planned.at(-1).slot, true);
  const fast = planChecks({ tier: 'code', checks: CHECKS, fast: true, scriptTests: [] });
  assert.deepEqual(fast.planned.map((p) => p.name), ['rules', 'typecheck', 'lint']);
  assert.deepEqual(fast.skipped, [{ name: 'test', why: 'fast' }]);
});

test('planChecks: a pass on the same tree is cached; another tree, another command, or the rules are not', () => {
  const now = 1_000_000_000_000;
  const cache = {
    [cacheKey('tree1', 'test', 'pnpm test')]: { name: 'test', passedAt: now - 1000 },
    [cacheKey('tree1', 'rules', 'check-plans')]: { name: 'rules', passedAt: now - 1000 },
  };
  const same = planChecks({ tier: 'code', checks: CHECKS, tree: 'tree1', cache, now });
  assert.deepEqual(same.planned.filter((p) => p.cached).map((p) => p.name), ['test']);
  const otherTree = planChecks({ tier: 'code', checks: CHECKS, tree: 'tree2', cache, now });
  assert.deepEqual(otherTree.planned.filter((p) => p.cached), []);
  const otherCommand = planChecks({ tier: 'code', checks: [{ name: 'test', run: 'pnpm test --runInBand', slot: true }], tree: 'tree1', cache, now });
  assert.deepEqual(otherCommand.planned.filter((p) => p.cached), []);
  const ignored = planChecks({ tier: 'code', checks: CHECKS, tree: 'tree1', cache: null, now });
  assert.deepEqual(ignored.planned.filter((p) => p.cached), []);
});

test('cache: entries older than 14 days are dropped, and a broken file reads as empty', () => {
  const now = 2_000_000_000_000;
  const cache = { fresh: { name: 'a', passedAt: now - 1000 }, old: { name: 'b', passedAt: now - MAX_AGE_MS - 1 }, junk: 'nope' };
  assert.deepEqual(Object.keys(pruneCache(cache, now)), ['fresh']);
  assert.equal(isCached(cache, 'old', now), false);
  const dir = mkdtempSync(join(tmpdir(), 'merge-pr-cache-'));
  try {
    const path = join(dir, 'nested', CACHE_FILE);
    assert.deepEqual(readCache(path), {});
    writeCache(path, { old: { name: 'b', passedAt: now - MAX_AGE_MS - 1 } });
    recordPass(path, 'k1', 'test', now);
    assert.deepEqual(readCache(path), { k1: { name: 'test', passedAt: now } });
    writeFileSync(path, '{ not json');
    assert.deepEqual(readCache(path), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatComment has the commit, the tier, one line per check, and the docs-only line', () => {
  const code = formatComment({ shortSha: 'abc1234', tier: 'code', results: [{ name: 'rules', cached: false, ms: 420 }, { name: 'script tests', cached: false, ms: 4100 }, { name: 'test', cached: true, ms: 0 }] });
  assert.equal(code, ['Local checks on abc1234 (tier: code, by scripts/merge-pr.mjs)', '- rules: pass (0.4 s)', '- script tests: pass (4.1 s)', '- test: pass (cached)'].join('\n'));
  const docs = formatComment({ shortSha: 'abc1234', tier: 'paperwork', results: [{ name: 'rules', cached: false, ms: 300 }], skipped: [{ name: 'lint', why: 'docs-only' }, { name: 'test', why: 'docs-only' }] });
  assert.match(docs, /tier: paperwork/);
  assert.match(docs, /Docs-only change: app checks skipped \(lint, test\)\.$/);
});

test('formatComment: with protected tests on, a named list the reviewer must rule on, or "none"', () => {
  const base = { shortSha: 'abc1234', tier: 'code', results: [{ name: 'rules', cached: false, ms: 300 }] };
  assert.doesNotMatch(formatComment(base), /Protected tests/, 'flag off: no section');
  assert.match(formatComment({ ...base, protectedTests: [] }), /\nProtected tests changed: none\.$/);
  const listed = formatComment({ ...base, protectedTests: [{ file: 'a.test.ts', change: 'modified' }, { file: 'tests/b.ts', change: 'renamed', to: 'tests/c.ts' }] });
  assert.match(listed, /\nProtected tests changed \(2\): the reviewer must give a verdict on each by name\.\n- modified: `a\.test\.ts`\n- renamed: `tests\/b\.ts` to `tests\/c\.ts`$/);
});

test('formatComment: a file name with a backtick or a line break is shown quoted and escaped, never breaking out of its code span', () => {
  const body = formatComment({ shortSha: 'abc1234', tier: 'code', results: [], protectedTests: [{ file: 'tests/a`b.ts', change: 'modified' }, { file: 'tests/c\nd.ts', change: 'renamed', to: 'tests/"e".ts' }] });
  assert.match(body, /\n- modified: `"tests\/a\\u0060b\.ts"`\n- renamed: `"tests\/c\\nd\.ts"` to `"tests\/\\"e\\"\.ts"`$/);
  assert.equal(body.split('\n').filter((l) => l.startsWith('- ')).length, 2, 'one line per file');
});

test('parseStatusZ lists unsaved, new, and renamed files', () => {
  assert.deepEqual(parseStatusZ(' M docs/a.md\0?? new file.ts\0R  new.ts\0old.ts\0'), ['docs/a.md', 'new file.ts', 'new.ts', 'old.ts']);
  assert.deepEqual(parseStatusZ(''), []);
});

test('logStamp is safe in a file name', () => {
  assert.equal(logStamp(Date.UTC(2026, 10, 11, 22, 15, 30)), '20261111T221530');
});

// ---------- The flows, with fake git, gh, and check runners ----------

// Builds a fake machine. `over` changes the story: the pull request, the changed files, which
// checks fail, and so on. Returns the ctx to hand to the flow plus a record of every call.
function fakeMachine(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-pr-flow-'));
  const root = join(dir, 'work');
  const commonDir = join(dir, 'git');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(commonDir);
  writeFileSync(join(root, 'scripts', 'a.test.mjs'), '');
  const s = {
    pr: { number: 7, state: 'OPEN', isDraft: false, headRefName: 'lead/notes', baseRefName: 'main' },
    files: ['docs/handoff.md'], // changed against the base branch
    status: '', // `git status --porcelain` output
    branch: 'lead/notes', // the branch checked out here
    tree: 'tree1',
    scriptsTree: 'scripts1', // the hash of the scripts folder alone
    manifest: null, // list of repo paths in scripts/kit.manifest.json; null means no manifest
    projectTests: [], // extra scripts/*.test.mjs files that belong to the project
    baseChecker: `// ${API_MARKER}\n`, // the checker on the base branch; null means it has none
    localChecker: 'export const CHECKER_API = 2;\n', // this folder's own checker
    baseConfig: { checks: CHECKS }, // scripts/kit.config.json on the base branch; null means it has none
    contains: true, // HEAD holds the remote branch's newest commit
    mergeCode: 0,
    conflicted: '',
    ahead: '0',
    moves: 0, // how many times the base branch moves while the checks run
    codes: {}, // check name -> exit code (default 0)
    slot: true, // scripts/slot.mjs exists
    head: 'headsha', // the commit checked out here
    commits: null, // the commits after the base, newest first: [{ sha, message }]; null means git is never asked
    known: [], // commit ids that exist, for a "Fixes:" line
    gitleaksToml: false, // kit-lint/gitleaks.toml exists
    baseToml: null, // the text of kit-lint/gitleaks.toml on the base branch; null means it has none
    ghFail: {}, // gh subcommand -> exit code
    ghTimeout: {}, // gh subcommand -> true: the call ran past its time limit
    tracked: null, // every file git lists after the merge; null means git is never asked
    nameStatus: null, // `git diff --name-status -z -M` output; null means git is never asked, false means it fails
    numstat: null, // `git diff --numstat` output; null means git is never asked
    shown: {}, // path -> the file's text at HEAD, for `git show HEAD:<path>`
    ...over,
  };
  if (s.slot) writeFileSync(join(root, 'scripts', 'slot.mjs'), '');
  if (s.gitleaksToml) {
    mkdirSync(join(root, 'kit-lint'));
    writeFileSync(join(root, 'kit-lint', 'gitleaks.toml'), '[extend]\nuseDefault = true\n');
  }
  if (s.localChecker !== null) writeFileSync(join(root, 'scripts', 'check-plans.mjs'), s.localChecker);
  for (const file of s.projectTests) writeFileSync(join(root, file), '');
  if (s.manifest) writeFileSync(join(root, MANIFEST_FILE), JSON.stringify({ files: Object.fromEntries(s.manifest.map((f) => [f, 'sha'])) }));
  const calls = { git: [], gh: [], ghOptions: [], run: [], out: [] };
  let fetches = 0;
  let baseGen = 0;
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const no = (stderr = 'failed') => ({ code: 1, stdout: '', stderr });
  const git = (args) => {
    const a = args.join(' ');
    calls.git.push(a);
    if (a.startsWith('status')) return ok(s.status);
    if (a.startsWith('fetch')) {
      fetches++;
      if (fetches > 1 && s.moves > 0) { s.moves--; baseGen++; }
      return ok();
    }
    if (a.startsWith('symbolic-ref')) return s.branch ? ok(`${s.branch}\n`) : no();
    if (a === 'rev-parse -q --verify HEAD^{tree}') return ok(`${s.tree}\n`);
    if (a === 'rev-parse -q --verify HEAD:scripts') return ok(`${s.scriptsTree}\n`);
    if (a.startsWith('rev-parse -q --verify')) return ok('sha\n');
    if (a === 'rev-parse --short HEAD') return ok('abc1234\n');
    if (a === 'rev-parse origin/main') return ok(`base-${baseGen}\n`);
    if (a.startsWith('rev-parse')) return ok(`${s.head}\n`);
    if (a === 'log --format=%H%x1f%P%x1f%B%x1e origin/main..HEAD' && s.commits) return ok(s.commits.map((c) => `${c.sha}\x1f${c.parents ?? 'p1'}\x1f${c.message}\x1e\n`).join(''));
    if (a === 'show origin/main:kit-lint/gitleaks.toml') return s.baseToml === null ? no('not in base') : ok(s.baseToml);
    if (a.startsWith('cat-file -e ')) return s.known.includes(a.slice('cat-file -e '.length).replace('^{commit}', '')) ? ok() : no();
    if (a.startsWith('merge-base --is-ancestor')) return s.contains ? ok() : no();
    if (a === 'merge --abort') return ok();
    if (a.startsWith('merge ')) return s.mergeCode === 0 ? ok() : { code: s.mergeCode, stdout: 'CONFLICT', stderr: '' };
    if (a.startsWith('diff --name-only --diff-filter=U')) return ok(s.conflicted);
    if (a.startsWith('diff --name-only -z')) return ok(s.files.join('\0'));
    if (a.startsWith('rev-list --count')) return ok(`${s.ahead}\n`);
    if (a.startsWith('push')) return ok();
    if (a.startsWith('show ') && a.endsWith(':scripts/kit.config.json')) {
      if (s.baseConfig === null) return no('not in base');
      return ok(typeof s.baseConfig === 'string' ? s.baseConfig : JSON.stringify(s.baseConfig));
    }
    if (a.startsWith('show ') && a.endsWith(':scripts/check-plans.mjs')) return s.baseChecker === null ? no('not in base') : ok(s.baseChecker);
    if (a.startsWith('diff --name-status -z -M origin/main...HEAD') && s.nameStatus !== null) return s.nameStatus === false ? no('bad revision') : ok(s.nameStatus);
    if (a === 'ls-files -z --cached --others --exclude-standard' && s.tracked) return ok(s.tracked.join('\0'));
    if (a === 'diff --numstat origin/main...HEAD' && s.numstat !== null) return ok(s.numstat);
    if (a.startsWith('show HEAD:') && s.shown[a.slice('show HEAD:'.length)] !== undefined) return ok(s.shown[a.slice('show HEAD:'.length)]);
    throw new Error(`fake git does not know: git ${a}`);
  };
  const gh = (args, options) => {
    calls.gh.push(args);
    calls.ghOptions.push(options);
    const sub = args[1];
    if (s.ghTimeout[sub]) return { code: 127, stdout: '', stderr: 'spawnSync gh ETIMEDOUT', timedOut: true };
    if (s.ghFail[sub]) return { code: s.ghFail[sub], stdout: '', stderr: `gh ${sub} failed` };
    if (sub === 'view') {
      const fields = args[args.indexOf('--json') + 1];
      if (fields === 'state') return ok(JSON.stringify({ state: s.mergeQueued ? 'OPEN' : 'MERGED' }));
      return ok(JSON.stringify(s.pr));
    }
    return ok();
  };
  const run = (command, args, options) => {
    // The trusted checker lives in a temp folder only while it runs, so read it now.
    const checkerText = options.name === 'rules' && existsSync(args[0]) ? readFileSync(args[0], 'utf8') : null;
    calls.run.push({ name: options.name, command, args, logFile: options.logFile, cwd: options.cwd, checkerText });
    return { code: s.codes[options.name] ?? 0, tail: `last lines of ${options.name}` };
  };
  let clock = 1_800_000_000_000;
  const ctx = { root, commonDir, config: settings({ checks: CHECKS, ...(over.config ?? {}) }), git, gh, run, print: (line) => calls.out.push(line), now: () => (clock += 100) };
  return { ctx, calls, root, commonDir, state: s, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const merge = (m, extra = {}) => mergePr({ ...parseArgs(['7']), ...extra }, m.ctx);
const ghSubs = (m) => m.calls.gh.map((c) => c[1]);
const ran = (m) => m.calls.run.map((r) => r.name);

test('flow: a docs-only pull request skips the app checks, posts the results, then merges', () => {
  const m = fakeMachine();
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests']);
    assert.deepEqual(ghSubs(m), ['view', 'comment', 'merge', 'view']);
    const body = m.calls.gh[1][4];
    assert.match(body, /^Local checks on abc1234 \(tier: paperwork, by scripts\/merge-pr\.mjs\)/);
    assert.match(body, /Docs-only change: app checks skipped \(typecheck, lint, test\)\./);
    assert.deepEqual(m.calls.gh[2], ['pr', 'merge', '7', '--merge', '--match-head-commit', 'headsha']);
    assert.ok(m.calls.git.includes('merge --no-edit origin/main'), 'the base branch is merged in first');
  } finally { m.cleanup(); }
});

test('flow: a code pull request runs every check in order, the full test run through the slot', () => {
  const m = fakeMachine({ files: ['docs/handoff.md', 'apps/mobile/save.ts'] });
  try {
    assert.equal(merge(m, { who: 'head 7' }), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint', 'test']);
    const scriptTests = m.calls.run[1];
    assert.deepEqual(scriptTests.args, ['--test', 'scripts/a.test.mjs']);
    assert.deepEqual(m.calls.run[2].args, ['-c', 'pnpm typecheck']);
    const slotRun = m.calls.run[4];
    assert.equal(slotRun.command, process.execPath);
    assert.deepEqual(slotRun.args, [join(m.root, 'scripts', 'slot.mjs'), 'run', 'tests', '--who', 'head 7', '--minutes', '30', '--', 'sh', '-c', 'pnpm test']);
    assert.match(slotRun.logFile, /kit-logs\/\d{8}T\d{6}-test\.log$/);
    assert.match(m.calls.gh[1][4], /tier: code/);
    assert.doesNotMatch(m.calls.gh[1][4], /Docs-only/);
  } finally { m.cleanup(); }
});

test('flow: checks that passed on the same tree are skipped next time; a changed tree runs them again', () => {
  const m = fakeMachine({ files: ['apps/mobile/save.ts'] });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal(m.calls.run.length, 5);
    m.calls.run.length = 0;
    m.calls.gh.length = 0;
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules'], 'only the rules run again on the same tree');
    assert.match(m.calls.gh[1][4], /- test: pass \(cached\)/);
    m.calls.run.length = 0;
    m.state.tree = 'tree2';
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint', 'test']);
    m.calls.run.length = 0;
    assert.equal(merge(m, { noCache: true }), EXIT.ok);
    assert.equal(m.calls.run.length, 5, '--no-cache runs everything');
  } finally { m.cleanup(); }
});

test('flow: a failing check blocks the merge, shows the last lines, and is not remembered as a pass', () => {
  const m = fakeMachine({ files: ['apps/mobile/save.ts'], codes: { lint: 1 } });
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint'], 'stops at the first failure');
    assert.deepEqual(ghSubs(m), ['view'], 'no comment and no merge');
    const out = m.calls.out.join('\n');
    assert.match(out, /FAIL {2}lint/);
    assert.match(out, /last lines of lint/);
    assert.match(out, /Full output: .*kit-logs/);
    const cache = readCache(join(m.commonDir, CACHE_FILE));
    assert.deepEqual(Object.values(cache).map((e) => e.name).sort(), ['script tests', 'typecheck']);
  } finally { m.cleanup(); }
});

test('flow: a busy test slot ends the run with exit code 75 and no merge', () => {
  const m = fakeMachine({ files: ['apps/mobile/save.ts'], codes: { test: 75 } });
  try {
    assert.equal(merge(m), EXIT.busy);
    assert.equal(EXIT.busy, 75);
    assert.deepEqual(ghSubs(m), ['view']);
    assert.match(m.calls.out.join('\n'), /test slot is taken/);
  } finally { m.cleanup(); }
});

test('flow: without scripts/slot.mjs a slot check runs directly, with a warning', () => {
  const m = fakeMachine({ files: ['apps/mobile/save.ts'], slot: false });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual([m.calls.run[4].command, m.calls.run[4].args], ['sh', ['-c', 'pnpm test']]);
    assert.match(m.calls.out.join('\n'), /Warning: scripts\/slot\.mjs is missing/);
  } finally { m.cleanup(); }
});

test('flow: a branch that is not a lead branch is checked by the base branch\'s checker', () => {
  const pr = { number: 7, state: 'OPEN', isDraft: false, headRefName: 'build/003-save-word', baseRefName: 'main' };
  const m = fakeMachine({ pr, files: ['apps/mobile/save.ts'], baseChecker: `// trusted copy ${API_MARKER}\n` });
  try {
    assert.equal(merge(m), EXIT.ok);
    const rules = m.calls.run[0];
    assert.ok(m.calls.git.includes('show origin/main:scripts/check-plans.mjs'));
    assert.ok(!rules.args[0].startsWith(m.root), 'runs a copy from outside the worktree');
    assert.equal(rules.checkerText, `// trusted copy ${API_MARKER}\n`);
    assert.deepEqual(rules.args.slice(1), ['--root', m.root, '--branch', 'build/003-save-word']);
    assert.equal(existsSync(rules.args[0]), false, 'the temp copy is removed afterwards');
  } finally { m.cleanup(); }
});

test('flow: if the base branch\'s checker cannot run from outside, the local one runs, with a warning', () => {
  const pr = { number: 7, state: 'OPEN', isDraft: false, headRefName: 'build/003-save-word', baseRefName: 'main' };
  for (const baseChecker of ['// an old checker\n', null]) {
    const m = fakeMachine({ pr, baseChecker });
    try {
      assert.equal(merge(m), EXIT.ok);
      assert.equal(m.calls.run[0].args[0], join(m.root, 'scripts', 'check-plans.mjs'));
      assert.equal(m.calls.out.filter((l) => l.startsWith('Warning:')).length, 1);
    } finally { m.cleanup(); }
  }
});

test('flow: a lead branch is checked by its own copy of the checker', () => {
  const m = fakeMachine();
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal(m.calls.run[0].args[0], join(m.root, 'scripts', 'check-plans.mjs'));
    assert.ok(!m.calls.git.some((c) => c.startsWith('show ') && c.endsWith('check-plans.mjs')), 'the base branch\'s checker is not fetched');
    assert.deepEqual(m.calls.run[0].args.slice(1), ['--root', m.root, '--branch', 'lead/notes']);
  } finally { m.cleanup(); }
});

test('flow: a draft is refused without --ready, and marked ready just before the merge with it', () => {
  const pr = { number: 7, state: 'OPEN', isDraft: true, headRefName: 'lead/007-thread', baseRefName: 'main' };
  const refused = fakeMachine({ pr });
  try {
    assert.equal(merge(refused), EXIT.usage);
    assert.deepEqual(ghSubs(refused), ['view']);
    assert.equal(refused.calls.run.length, 0, 'no checks run');
    assert.equal(refused.calls.git.length, 0, 'nothing is fetched or merged');
    assert.match(refused.calls.out.join('\n'), /is a draft/);
  } finally { refused.cleanup(); }
  const allowed = fakeMachine({ pr });
  try {
    assert.equal(merge(allowed, { ready: true }), EXIT.ok);
    assert.deepEqual(ghSubs(allowed), ['view', 'comment', 'ready', 'merge', 'view']);
  } finally { allowed.cleanup(); }
});

test('flow: a pull request that is not open is refused', () => {
  const m = fakeMachine({ pr: { number: 7, state: 'MERGED', isDraft: false, headRefName: 'lead/notes', baseRefName: 'main' } });
  try {
    assert.equal(merge(m), EXIT.usage);
    assert.match(m.calls.out.join('\n'), /is merged, not open/);
    assert.equal(m.calls.run.length, 0);
  } finally { m.cleanup(); }
});

test('flow: unsaved files, or a folder that lacks the branch\'s newest commits, stop it before any check', () => {
  const dirty = fakeMachine({ status: ' M docs/handoff.md\n' });
  try {
    assert.equal(merge(dirty), EXIT.usage);
    assert.match(dirty.calls.out.join('\n'), /Unsaved or new files/);
    assert.equal(dirty.calls.run.length, 0);
  } finally { dirty.cleanup(); }
  const behind = fakeMachine({ contains: false });
  try {
    assert.equal(merge(behind), EXIT.usage);
    assert.match(behind.calls.out.join('\n'), /git pull origin lead\/notes/);
    assert.equal(behind.calls.run.length, 0);
  } finally { behind.cleanup(); }
});

test('flow: merge conflicts are undone and reported with exit code 1', () => {
  const m = fakeMachine({ mergeCode: 1, conflicted: 'docs/handoff.md\n' });
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.ok(m.calls.git.includes('merge --abort'));
    assert.match(m.calls.out.join('\n'), /conflicts in:\ndocs\/handoff\.md/);
    assert.deepEqual(ghSubs(m), ['view']);
    assert.equal(m.calls.run.length, 0);
  } finally { m.cleanup(); }
});

test('flow: when merging the base adds commits, the branch is pushed before the checks', () => {
  const m = fakeMachine({ ahead: '2' });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.ok(m.calls.git.includes('push origin HEAD:refs/heads/lead/notes'));
  } finally { m.cleanup(); }
  const quiet = fakeMachine();
  try {
    merge(quiet);
    assert.ok(!quiet.calls.git.some((c) => c.startsWith('push')), 'nothing to push when the branch is not ahead');
  } finally { quiet.cleanup(); }
});

test('flow: if the base branch moves while the checks run, it starts over; after three tries it gives up', () => {
  const once = fakeMachine({ moves: 1 });
  try {
    assert.equal(merge(once), EXIT.ok);
    assert.equal(once.calls.git.filter((c) => c === 'merge --no-edit origin/main').length, 2);
    assert.deepEqual(ghSubs(once), ['view', 'comment', 'merge', 'view']);
  } finally { once.cleanup(); }
  const always = fakeMachine({ moves: 99 });
  try {
    assert.equal(merge(always), EXIT.failed);
    assert.equal(always.calls.git.filter((c) => c === 'merge --no-edit origin/main').length, MAX_TRIES);
    assert.deepEqual(ghSubs(always), ['view'], 'never merged');
  } finally { always.cleanup(); }
});

test('flow: if the results cannot be posted, nothing is merged', () => {
  const m = fakeMachine({ ghFail: { comment: 1 } });
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.deepEqual(ghSubs(m), ['view', 'comment']);
  } finally { m.cleanup(); }
});

test('--check --fast skips the slot checks and changes nothing in git or on GitHub', () => {
  const m = fakeMachine({ branch: 'build/003-save-word', files: ['apps/mobile/save.ts'] });
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint']);
    assert.equal(m.calls.gh.length, 0);
    assert.ok(!m.calls.git.some((c) => /^(merge|push|fetch|commit)/.test(c)), 'no merge, push, or fetch');
    assert.match(m.calls.out.join('\n'), /skip {2}test \(--fast/);
    assert.deepEqual(m.calls.run[0].args.slice(1), ['--root', m.root, '--branch', 'build/003-save-word']);
  } finally { m.cleanup(); }
});

test('--check without --fast runs the slot checks too, and a failure gives exit code 1', () => {
  const m = fakeMachine({ branch: 'build/003-save-word', files: ['apps/mobile/save.ts'], codes: { test: 1 } });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.failed);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint', 'test']);
  } finally { m.cleanup(); }
});

test('--check counts unsaved files in the tier and does not trust remembered passes while they exist', () => {
  const m = fakeMachine({ branch: 'lead/notes', files: ['docs/handoff.md'] });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests'], 'docs only: paperwork tier');
    m.calls.run.length = 0;
    m.state.status = ' M apps/mobile/save.ts\0';
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint', 'test'], 'an unsaved code file makes it the code tier, nothing cached');
    assert.match(m.calls.out.join('\n'), /remembered passes are not used/);
  } finally { m.cleanup(); }
});

// ---------- Merge lock and duplicate numbers ----------

// Every git, gh, and run call in one list, in the order they happened.
function trace(m) {
  const order = [];
  for (const key of ['git', 'gh', 'run']) {
    const inner = m.ctx[key];
    m.ctx[key] = (...args) => {
      const label = key === 'run' ? `run ${args[2].name}` : key === 'gh' ? `gh ${args[0][1]}` : `git ${args[0][0]}`;
      order.push(label);
      if (key === 'gh' && args[0][1] === 'merge' && m.throwOnMerge) throw new Error('gh blew up');
      return inner(...args);
    };
  }
  return order;
}
const LOCK = { config: { features: { mergeLock: true } } };

test('merge lock: taken after the checks and before the last fetch, given back after GitHub merges', () => {
  const m = fakeMachine(LOCK);
  const order = trace(m);
  try {
    assert.equal(merge(m), EXIT.ok);
    const lock = order.indexOf('run merge lock');
    assert.ok(lock > order.indexOf('run script tests'), 'after the checks');
    assert.equal(order[lock + 1], 'git fetch', 'right before the last fetch');
    assert.ok(order.indexOf('run merge lock release') > order.indexOf('gh merge'), 'held until GitHub answers');
    const acquire = m.calls.run.find((r) => r.name === 'merge lock');
    assert.deepEqual(acquire.args.slice(1, 4), ['acquire', 'merge', '--who']);
    assert.ok(!acquire.args.includes('--wait'), 'no --wait asked for');
  } finally { m.cleanup(); }
});

test('merge lock: flag off, the lock is never asked for', () => {
  const m = fakeMachine();
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.ok(!ran(m).some((n) => n.startsWith('merge lock')));
  } finally { m.cleanup(); }
});

test('merge lock: busy exits 75 with a clear line and merges nothing', () => {
  const m = fakeMachine({ ...LOCK, codes: { 'merge lock': 75 } });
  try {
    assert.equal(merge(m), EXIT.busy);
    assert.deepEqual(ghSubs(m), ['view']);
    assert.match(m.calls.out.join('\n'), /busy {2}merge lock: another merge on this machine holds it\. Run this again with --wait <seconds>/);
    assert.ok(!ran(m).includes('merge lock release'), 'nothing to give back');
  } finally { m.cleanup(); }
});

test('merge lock: given back when GitHub refuses, when posting fails, and when a step throws', () => {
  for (const over of [{ ghFail: { merge: 1 } }, { ghFail: { comment: 1 } }, { throwOnMerge: true }]) {
    const m = fakeMachine({ ...LOCK, ...over });
    m.throwOnMerge = over.throwOnMerge;
    trace(m);
    try {
      if (over.throwOnMerge) assert.throws(() => merge(m), /gh blew up/);
      else assert.equal(merge(m), EXIT.failed);
      assert.equal(ran(m).filter((n) => n === 'merge lock release').length, 1, JSON.stringify(over));
    } finally { m.cleanup(); }
  }
});

test('merge lock: when the base moves, the lock is given back before starting over and taken again', () => {
  const m = fakeMachine({ ...LOCK, moves: 1 });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m).filter((n) => n.startsWith('merge lock')), ['merge lock', 'merge lock release', 'merge lock', 'merge lock renew', 'merge lock release']);
  } finally { m.cleanup(); }
});

test('merge lock: with the flag on and no scripts/slot.mjs, it stops before merging', () => {
  const m = fakeMachine({ ...LOCK, slot: false });
  try {
    assert.equal(merge(m), EXIT.usage);
    assert.deepEqual(ghSubs(m), ['view']);
    assert.match(m.calls.out.join('\n'), /merge lock is on, but scripts\/slot\.mjs is missing/);
  } finally { m.cleanup(); }
});

test('merge lock: the owner name is unique to this process and folder, and the pid goes on record', () => {
  for (const [extra, name] of [[{}, 'merge-pr #7'], [{ who: 'head 7' }, 'head 7']]) {
    const m = fakeMachine(LOCK);
    m.ctx.pid = 4242;
    try {
      assert.equal(merge(m, extra), EXIT.ok);
      const owner = `${name} (pid 4242, ${m.root})`;
      const lockCalls = m.calls.run.filter((r) => r.name.startsWith('merge lock'));
      assert.deepEqual(lockCalls.map((r) => r.args.slice(1, 5)), [['acquire', 'merge', '--who', owner], ['renew', 'merge', '--who', owner], ['release', 'merge', '--who', owner]]);
      assert.deepEqual(lockCalls[0].args.slice(lockCalls[0].args.indexOf('--pid'), lockCalls[0].args.indexOf('--pid') + 2), ['--pid', '4242']);
    } finally { m.cleanup(); }
  }
});

test('merge lock: renewed right before GitHub merges; if the hold is no longer ours, nothing merges', () => {
  const m = fakeMachine(LOCK);
  const order = trace(m);
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal(order[order.indexOf('gh merge') - 1], 'run merge lock renew', 'renewed right before the merge call');
  } finally { m.cleanup(); }
  const lost = fakeMachine({ ...LOCK, codes: { 'merge lock renew': 1 } });
  try {
    assert.equal(merge(lost), EXIT.failed);
    assert.ok(!ghSubs(lost).includes('merge'), 'not merged');
    assert.match(lost.calls.out.join('\n'), /FAIL {2}merge lock: this merge no longer holds it .*Not merged\./);
    assert.ok(!ran(lost).includes('merge lock release'), 'it does not give back a lock it no longer holds');
  } finally { lost.cleanup(); }
});

const CLASH = ['docs/plans/active/090-sync.md', 'docs/plans/completed/090-words.md', 'docs/plans/logs/090-sync.md'];

test('duplicate numbers: a merged result with two files on one number fails before the checks, and nothing merges', () => {
  const m = fakeMachine({ config: { features: { duplicateNumbers: true } }, tracked: CLASH });
  const order = trace(m);
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.ok(order.indexOf('git ls-files') > order.indexOf('git merge'), 'it looks at the tree after the base is merged in');
    assert.deepEqual(ran(m), [], 'no check ran');
    assert.deepEqual(ghSubs(m), ['view']);
    assert.match(m.calls.out.join('\n'), /FAIL {2}numbers: .*\n {2}docs\/plans\/ 090: docs\/plans\/active\/090-sync\.md, docs\/plans\/completed\/090-words\.md/);
  } finally { m.cleanup(); }
});

test('duplicate numbers: --check fails the same way; with no clash both go on; flag off, git is never asked', () => {
  const on = { config: { features: { duplicateNumbers: true } } };
  const m = fakeMachine({ ...on, tracked: CLASH });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.failed);
    assert.deepEqual(ran(m), []);
  } finally { m.cleanup(); }
  const fine = fakeMachine({ ...on, tracked: CLASH.slice(0, 1) });
  try {
    assert.equal(merge(fine), EXIT.ok);
    assert.match(fine.calls.out.join('\n'), /pass {2}numbers/);
  } finally { fine.cleanup(); }
  const off = fakeMachine();
  try {
    assert.equal(merge(off), EXIT.ok, 'the fake git throws if ls-files is asked');
  } finally { off.cleanup(); }
});

// ---------- Protected tests ----------

const PROTECTED = { config: { features: { protectedTests: true } } };
const EDITED = z('M', 'scripts/a.test.mjs', 'D', 'tests/old.ts', 'A', 'scripts/new.test.mjs', 'M', 'src/app.ts');

test('protected tests: the merge prints the list and posts it in the results comment, each file by name', () => {
  const m = fakeMachine({ ...PROTECTED, files: ['src/app.ts'], nameStatus: EDITED });
  try {
    assert.equal(merge(m), EXIT.ok);
    const out = m.calls.out.join('\n');
    assert.match(out, /note {2}protected tests: 2 existing test files changed\. The reviewer must rule on each by name:\n {2}modified {2}scripts\/a\.test\.mjs\n {2}deleted {3}tests\/old\.ts/);
    const body = m.calls.gh.find((c) => c[1] === 'comment')[4];
    assert.match(body, /Protected tests changed \(2\): the reviewer must give a verdict on each by name\.\n- modified: `scripts\/a\.test\.mjs`\n- deleted: `tests\/old\.ts`$/);
    assert.doesNotMatch(body, /new\.test\.mjs/, 'a new test file is free');
  } finally { m.cleanup(); }
});

test('protected tests: --check prints the same list; none changed says so; flag off, git is never asked', () => {
  const m = fakeMachine({ ...PROTECTED, files: ['src/app.ts'], nameStatus: EDITED });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    assert.match(m.calls.out.join('\n'), /note {2}protected tests: 2 existing test files changed\. .*\n {2}modified {2}scripts\/a\.test\.mjs\n {2}deleted {3}tests\/old\.ts/);
    assert.deepEqual(m.calls.gh, [], 'nothing posted');
  } finally { m.cleanup(); }
  const none = fakeMachine({ ...PROTECTED, nameStatus: z('A', 'scripts/new.test.mjs') });
  try {
    assert.equal(merge(none), EXIT.ok);
    assert.match(none.calls.out.join('\n'), /note {2}protected tests: no existing test file changed/);
    assert.match(none.calls.gh.find((c) => c[1] === 'comment')[4], /\nProtected tests changed: none\.$/);
  } finally { none.cleanup(); }
  const off = fakeMachine({ files: ['src/app.ts'] });
  try {
    assert.equal(merge(off), EXIT.ok, 'the fake git throws if --name-status is asked');
    assert.doesNotMatch(off.calls.gh.find((c) => c[1] === 'comment')[4], /Protected tests/);
  } finally { off.cleanup(); }
});

test('protected tests: a file name with a line break prints on one line, quoted and escaped', () => {
  const m = fakeMachine({ ...PROTECTED, files: ['src/app.ts'], nameStatus: z('M', 'tests/a\nb.ts', 'M', 'tests/plain.ts') });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    const out = m.calls.out.join('\n');
    assert.match(out, /\n {2}modified {2}"tests\/a\\nb\.ts"\n {2}modified {2}tests\/plain\.ts\n/);
  } finally { m.cleanup(); }
});

test('protected tests: if git cannot list the changes, both ways stop with exit code 1 and nothing merges', () => {
  const m = fakeMachine({ ...PROTECTED, nameStatus: false });
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.deepEqual(ghSubs(m), ['view']);
    assert.match(m.calls.out.join('\n'), /FAIL {2}protected tests: cannot list the changed files: bad revision/);
  } finally { m.cleanup(); }
  const c = fakeMachine({ ...PROTECTED, nameStatus: false });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), c.ctx), EXIT.failed);
  } finally { c.cleanup(); }
});

const RECEIPTS = { config: { features: { reviewReceipts: true } } };
const UNCOVERED = [{ sha: 'c0ffee1234567890', kind: 'commit', subject: 'Change app', why: "no approving receipt from a model other than the builder's and the head agent's" }];

test('receipts: flag on, an uncovered commit stops the merge with exit 1 and a plain list, before any check runs', () => {
  const m = fakeMachine({ ...RECEIPTS, files: ['src/app.ts'] });
  const asked = [];
  m.ctx.checkReceipts = (args) => {
    asked.push(args);
    return { uncovered: UNCOVERED, covered: 1, notes: ['docs/receipts/084-1a2b3c4d.json: does not match its session record; not counted'] };
  };
  try {
    assert.equal(merge(m), EXIT.failed);
    const out = m.calls.out.join('\n');
    assert.match(out, /note {2}receipts: docs\/receipts\/084-1a2b3c4d\.json: does not match/);
    assert.match(out, /FAIL {2}receipts: 1 commit has no approving review receipt[^\n]*\n {2}c0ffee1 Change app: no approving receipt/);
    assert.match(out, /node scripts\/receipt\.mjs make/);
    assert.deepEqual(ran(m), [], 'no check ran');
    assert.deepEqual(ghSubs(m), ['view'], 'nothing posted or merged');
    assert.equal(asked[0].baseRef, 'origin/main');
    assert.equal(asked[0].isPaperwork('docs/a.md'), true, 'the trusted paperwork rule');
    assert.equal(asked[0].isPaperwork('src/a.ts'), false);
    assert.deepEqual(asked[0].protectedTests('M\0scripts/a.test.mjs\0'), [{ file: 'scripts/a.test.mjs', change: 'modified' }]);
  } finally { m.cleanup(); }
});

test('receipts: covered merges; flag off never asks; a failing gate or a missing receipt.mjs stops the merge', () => {
  const ok = fakeMachine({ ...RECEIPTS, files: ['src/app.ts'] });
  ok.ctx.checkReceipts = () => ({ uncovered: [], covered: 2, notes: [] });
  try {
    assert.equal(merge(ok), EXIT.ok);
    assert.match(ok.calls.out.join('\n'), /pass {2}receipts \(2 commits covered by an approving review\)/);
  } finally { ok.cleanup(); }
  const off = fakeMachine({ files: ['src/app.ts'] });
  off.ctx.checkReceipts = () => { throw new Error('asked with the flag off'); };
  try {
    assert.equal(merge(off), EXIT.ok);
  } finally { off.cleanup(); }
  const bad = fakeMachine({ ...RECEIPTS });
  bad.ctx.checkReceipts = () => ({ fail: 'set "models.builder" and "models.headAgent"', notes: [] });
  try {
    assert.equal(merge(bad), EXIT.failed);
    assert.match(bad.calls.out.join('\n'), /FAIL {2}receipts: set "models\.builder"/);
  } finally { bad.cleanup(); }
  const missing = fakeMachine({ ...RECEIPTS });
  missing.ctx.receiptsError = 'Cannot find module';
  try {
    assert.equal(merge(missing), EXIT.usage);
    assert.match(missing.calls.out.join('\n'), /reviewReceipts flag is on, but scripts\/receipt\.mjs cannot be loaded: Cannot find module/);
    assert.deepEqual(ghSubs(missing), ['view']);
  } finally { missing.cleanup(); }
});

// ---------- Block log ----------

const BLOCKS = (extra = {}) => ({ config: { features: { blockLog: true, ...extra } } });
const PRINTS = [{ sha: 'c0ffee1234567890', kind: 'commit', subject: 'Change app', fingerprint: 'f'.repeat(40), protected: [] }];
const blockLines = (m) => (existsSync(join(m.commonDir, BLOCK_LOG_FILE)) ? readFileSync(join(m.commonDir, BLOCK_LOG_FILE), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)) : []);
const withPrints = (m) => {
  m.asked = [];
  m.ctx.neededCommits = (args) => { m.asked.push(args); return { list: PRINTS }; };
  return m;
};

test('block log: a failed check writes one line with the time, pull request, branch, check, tip, tree, and fingerprints', () => {
  const m = withPrints(fakeMachine({ ...BLOCKS(), files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.deepEqual(blockLines(m).filter((l) => l.outcome !== 'passed').map((l) => ({ ...l, at: 'x' })), [{
      at: 'x', outcome: 'blocked', pr: 7, branch: 'lead/notes', base: 'main',
      check: 'lint', tip: 'headsha', tree: 'tree1', fingerprints: [{ commit: 'c0ffee1234567890', fingerprint: 'f'.repeat(40) }],
    }]);
    assert.match(blockLines(m)[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(m.asked[0].baseRef, 'origin/main');
    assert.equal(m.asked[0].isPaperwork('docs/a.md'), true, 'the trusted paperwork rule');
  } finally { m.cleanup(); }
});

test('block log: a number clash, an uncovered commit, and a GitHub refusal are refusals; each writes its check name', () => {
  const n = withPrints(fakeMachine({ ...BLOCKS({ duplicateNumbers: true }), tracked: CLASH }));
  try {
    assert.equal(merge(n), EXIT.failed);
    assert.deepEqual(blockLines(n).map((l) => [l.outcome, l.check]), [['blocked', 'numbers']]);
  } finally { n.cleanup(); }
  const r = withPrints(fakeMachine({ ...BLOCKS({ reviewReceipts: true }), files: ['src/app.ts'] }));
  r.ctx.checkReceipts = () => ({ uncovered: UNCOVERED, covered: 0, notes: [] });
  try {
    assert.equal(merge(r), EXIT.failed);
    assert.deepEqual(blockLines(r).map((l) => [l.outcome, l.check]), [['blocked', 'receipts']]);
  } finally { r.cleanup(); }
  const g = withPrints(fakeMachine({ ...BLOCKS(), ghFail: { merge: 1 } }));
  try {
    assert.equal(merge(g), EXIT.failed);
    assert.match(g.calls.out.join('\n'), /GitHub refused the merge of pull request #7/);
    assert.deepEqual(blockLines(g).at(-1).outcome, 'blocked');
    assert.equal(blockLines(g).at(-1).check, 'github', 'a GitHub refusal is logged by the name "github"');
  } finally { g.cleanup(); }
});

test('block log: a merge writes a "merged" line with the same fields, so a later pass can be matched to a block', () => {
  const m = withPrints(fakeMachine({ ...BLOCKS(), files: ['src/app.ts'] }));
  try {
    assert.equal(merge(m), EXIT.ok);
    const line = blockLines(m).at(-1);
    assert.deepEqual({ ...line, at: 'x' }, { at: 'x', outcome: 'merged', pr: 7, branch: 'lead/notes', base: 'main', check: null, tip: 'headsha', tree: 'tree1', fingerprints: [{ commit: 'c0ffee1234567890', fingerprint: 'f'.repeat(40) }] });
    assert.equal(blockLines(m).filter((l) => l.outcome === 'merged').length, 1);
  } finally { m.cleanup(); }
});

test('block log: busy, a receipts setup failure, and a conflict write nothing; flag off writes nothing', () => {
  const cases = [
    [fakeMachine({ ...BLOCKS(), files: ['apps/mobile/save.ts'], codes: { test: 75 } }), EXIT.busy],
    [fakeMachine({ ...BLOCKS({ reviewReceipts: true }) }), EXIT.failed, (m) => { m.ctx.checkReceipts = () => ({ fail: 'set "models.builder"', notes: [] }); }],
    [fakeMachine({ ...BLOCKS(), mergeCode: 1, conflicted: 'a.ts' }), EXIT.failed],
    [fakeMachine({ files: ['apps/mobile/save.ts'], codes: { lint: 1 } }), EXIT.failed, (m) => { m.ctx.neededCommits = () => { throw new Error('asked with the flag off'); }; }],
  ];
  for (const [m, code, setup] of cases) {
    try {
      if (!m.ctx.neededCommits) withPrints(m);
      setup?.(m);
      assert.equal(merge(m), code);
      assert.deepEqual(blockLines(m).filter((l) => l.outcome !== 'passed'), [], m.calls.out.join('\n'));
      if (!m.state.config?.features?.blockLog) assert.deepEqual(blockLines(m), [], 'flag off: nothing at all');
    } finally { m.cleanup(); }
  }
});

test('block log: without fingerprints (receipt.mjs missing or git failing) the line still lands, with null and a warning', () => {
  const m = fakeMachine({ ...BLOCKS(), files: ['apps/mobile/save.ts'], codes: { lint: 1 } });
  m.ctx.neededCommits = () => ({ fail: 'cannot list the commits' });
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.equal(blockLines(m)[0].fingerprints, null);
    assert.match(m.calls.out.join('\n'), /Warning: block log: no fingerprints \(cannot list the commits\)/);
  } finally { m.cleanup(); }
});

test('block log: when the log cannot be written, the refusal still stops the merge and says why', () => {
  const m = withPrints(fakeMachine({ ...BLOCKS(), files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  mkdirSync(join(m.commonDir, BLOCK_LOG_FILE)); // a folder where the file should be: appending fails
  try {
    assert.equal(merge(m), EXIT.failed);
    const out = m.calls.out.join('\n');
    assert.match(out, /FAIL {2}lint/);
    assert.match(out, /Warning: block log: could not write/);
    assert.ok(!m.calls.gh.some((a) => a[1] === 'merge'), 'nothing merged');
  } finally { m.cleanup(); }
});

test('block log: each check that passes writes a "passed" line, cached ones too, so a block is settled per check', () => {
  const m = withPrints(fakeMachine({ ...BLOCKS(), files: ['apps/mobile/save.ts'], codes: { test: 1 } }));
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.deepEqual(blockLines(m).map((l) => [l.outcome, l.check]), [['passed', 'rules'], ['passed', 'script tests'], ['passed', 'typecheck'], ['passed', 'lint'], ['blocked', 'test']]);
    assert.deepEqual(blockLines(m)[3].fingerprints, [{ commit: 'c0ffee1234567890', fingerprint: 'f'.repeat(40) }], 'a pass carries the fingerprints');
    assert.equal(m.asked.length, 1, 'the fingerprints are worked out once per try, not once per line');
    // The same files again: lint passes from the cache, and that pass is logged too.
    m.state.codes = { test: 1 };
    m.asked = [];
    assert.equal(merge(m), EXIT.failed);
    assert.deepEqual(blockLines(m).slice(5).map((l) => [l.outcome, l.check]), [['passed', 'rules'], ['passed', 'script tests'], ['passed', 'typecheck'], ['passed', 'lint'], ['blocked', 'test']]);
  } finally { m.cleanup(); }
  const off = fakeMachine({ files: ['apps/mobile/save.ts'] });
  try {
    assert.equal(merge(off), EXIT.ok);
    assert.deepEqual(blockLines(off), [], 'flag off: no pass lines');
  } finally { off.cleanup(); }
});

test('block log: the numbers and receipts checks write a "passed" line when they pass, so their blocks settle too', () => {
  const m = withPrints(fakeMachine({ ...BLOCKS({ duplicateNumbers: true, reviewReceipts: true }), tracked: CLASH.slice(0, 1), files: ['src/app.ts'] }));
  m.ctx.checkReceipts = () => ({ uncovered: [], covered: 1, notes: [] });
  try {
    assert.equal(merge(m), EXIT.ok, m.calls.out.join('\n'));
    assert.deepEqual(blockLines(m).slice(0, 2).map((l) => [l.outcome, l.check]), [['passed', 'numbers'], ['passed', 'receipts']]);
  } finally { m.cleanup(); }
  const off = fakeMachine({ config: { features: { duplicateNumbers: true, reviewReceipts: true } }, tracked: CLASH.slice(0, 1), files: ['src/app.ts'] });
  off.ctx.checkReceipts = () => ({ uncovered: [], covered: 1, notes: [] });
  try {
    assert.equal(merge(off), EXIT.ok);
    assert.deepEqual(blockLines(off), [], 'flag off: no pass lines');
  } finally { off.cleanup(); }
});

test('merge call: a hard time limit well inside the merge lock lease; when it runs out, the merge state is called unknown', () => {
  assert.ok(MERGE_CALL_SECONDS * 1000 <= (MERGE_LOCK_MINUTES * 60_000) / 2, 'at most half the lease, which is renewed right before the call');
  const m = fakeMachine(LOCK);
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal(m.calls.ghOptions[ghSubs(m).indexOf('merge')]?.timeoutMs, MERGE_CALL_SECONDS * 1000);
  } finally { m.cleanup(); }
  const t = withPrints(fakeMachine({ ...BLOCKS({ mergeLock: true }), ghTimeout: { merge: true } }));
  try {
    assert.equal(merge(t), EXIT.failed);
    const out = t.calls.out.join('\n');
    assert.match(out, /FAIL {2}merge: GitHub did not answer within 5 minutes, so the call was stopped\. The merge state is unknown/);
    assert.match(out, /gh pr view 7 --json state/);
    assert.doesNotMatch(out, /Merged pull request|GitHub refused/);
    assert.deepEqual(blockLines(t).filter((l) => l.outcome !== 'passed'), [], 'neither a refusal nor a merge');
    assert.equal(ran(t).filter((n) => n === 'merge lock release').length, 1);
  } finally { t.cleanup(); }
});

test('exec: a command still running at its time limit is stopped and marked timedOut', () => {
  const slow = exec(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], process.cwd(), undefined, 300);
  assert.equal(slow.timedOut, true);
  assert.notEqual(slow.code, 0);
  const quick = exec(process.execPath, ['-e', 'process.stdout.write("hi")'], process.cwd(), undefined, 10000);
  assert.deepEqual(quick, { code: 0, stdout: 'hi', stderr: '' });
});

// ---------- --wait, with the real slot script in a sandbox ----------

// A fake machine whose slot calls go to a real copy of scripts/slot.mjs, with its records in a
// temp folder (never the real ~/.agent-slots) and a fast poll. The only check is one slot check.
function slotMachine(over = {}) {
  const m = fakeMachine({ files: ['apps/mobile/save.ts'], config: { checks: [{ name: 'test', run: over.testRun ?? 'true', slot: true }] }, ...over });
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of ['slot.mjs', 'ram-health.mjs']) copyFileSync(join(here, f), join(m.root, 'scripts', f));
  const slots = join(m.root, '..', 'slots');
  mkdirSync(slots);
  const env = { ...process.env, AGENT_SLOTS_DIR: slots, AGENT_SLOTS_NO_PROBE: '1', SLOT_POLL_MS: '50' };
  delete env.SLOT_QUEUE_TTL_MIN;
  delete env.SLOT_SHARED_OK;
  const slotScript = join(m.root, 'scripts', 'slot.mjs');
  const fakeRun = m.ctx.run;
  m.ctx.run = (command, args, options) => {
    if (args[0] !== slotScript) return fakeRun(command, args, options);
    m.calls.run.push({ name: options.name, command, args });
    if (args[1] === 'run' && over.runNeverStarts) return { code: 127, tail: 'could not start' };
    const r = spawnSync(command, args, { cwd: options.cwd, env, encoding: 'utf8' });
    // Like slot.mjs failing to write its health report after the grant: slot taken, exit 1.
    if (args[1] === 'acquire' && over.acquireFailsAfterGrant) return { code: 1, tail: 'EISDIR: health.log' };
    return { code: r.status ?? 1, tail: `${r.stdout}${r.stderr}`.trim() };
  };
  const slotCli = (...args) => spawnSync(process.execPath, [slotScript, ...args], { env, encoding: 'utf8' });
  const holder = () => {
    const file = join(slots, 'tests.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).holder : null;
  };
  return { ...m, env, slotScript, slotCli, holder };
}

// Another thread holds the test slot through `slot.mjs run` for about holdMs, then gives it back.
// Resolves once it holds the slot; `exited` resolves when it is done.
async function otherThreadHolds(s, holdMs) {
  const child = spawn(process.execPath, [s.slotScript, 'run', 'tests', '--who', 'Other thread', '--', process.execPath, '-e', `setTimeout(() => {}, ${holdMs})`], { env: s.env, stdio: 'ignore' });
  const end = Date.now() + 30000;
  while (!(s.holder()?.who === 'Other thread' && s.holder()?.pid === child.pid)) {
    if (Date.now() > end) throw new Error('the other thread never took the slot');
    await new Promise((r) => setTimeout(r, 20));
  }
  return { exited: new Promise((done) => child.on('exit', done)) };
}

test('--wait: a busy test slot is waited for, then the checks run and the merge goes on', async () => {
  const s = slotMachine();
  try {
    const other = await otherThreadHolds(s, 400);
    assert.equal(merge(s, { who: 'head 7', wait: 20 }), EXIT.ok);
    await other.exited;
    const out = s.calls.out.join('\n');
    assert.equal(out.match(/^wait {2}test: .*Waiting up to 20 seconds/gm)?.length, 1, 'one line when it starts waiting');
    assert.equal(out.match(/^slot {2}test: got the test slot after/gm)?.length, 1, 'one line when it gets the slot');
    assert.match(out, /pass {2}test/);
    assert.deepEqual(ghSubs(s), ['view', 'comment', 'merge', 'view']);
    assert.equal(s.holder(), null, 'the slot is given back after the waited run');
  } finally { s.cleanup(); }
});

test('--wait with --check: still busy when the time runs out gives exit code 75 and says how long it waited', () => {
  const s = slotMachine();
  try {
    assert.equal(s.slotCli('acquire', 'tests', '--who', 'Other thread').status, 0);
    const started = Date.now();
    assert.equal(checkOnly(parseArgs(['--check', '--wait', '1']), s.ctx), EXIT.busy);
    assert.ok(Date.now() - started >= 900, 'it really waited');
    assert.match(s.calls.out.join('\n'), /busy {2}test: waited 1 seconds and the machine's test slot is still taken/);
    assert.ok(!s.calls.run.some((r) => r.args[1] === 'run'), 'the test command never ran');
    assert.equal(s.holder().who, 'Other thread', 'the other thread still holds it');
  } finally { s.cleanup(); }
});

test('without --wait a busy test slot still exits 75 at once', () => {
  const s = slotMachine();
  try {
    assert.equal(s.slotCli('acquire', 'tests', '--who', 'Other thread').status, 0);
    const started = Date.now();
    assert.equal(merge(s), EXIT.busy);
    assert.ok(Date.now() - started < 5000, 'no waiting');
    assert.ok(!s.calls.out.some((l) => /^wait /.test(l)));
    assert.deepEqual(ghSubs(s), ['view']);
  } finally { s.cleanup(); }
});

test('--wait: the slot is given back when the waited check fails or its run never starts', () => {
  for (const over of [{ testRun: 'exit 3' }, { runNeverStarts: true }]) {
    const s = slotMachine(over);
    try {
      assert.equal(checkOnly(parseArgs(['--check', '--wait', '5']), s.ctx), EXIT.failed);
      assert.equal(s.holder(), null, JSON.stringify(over));
    } finally { s.cleanup(); }
  }
});

test('--wait: a slot granted by an acquire that then fails is still given back', () => {
  const s = slotMachine({ acquireFailsAfterGrant: true });
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--wait', '5']), s.ctx), EXIT.failed);
    assert.equal(s.holder(), null, 'the slot is not left held after the failed acquire');
  } finally { s.cleanup(); }
});

test('merge lock, real slot script: another merge of the same pull request is not mistaken for this one, and a lost hold merges nothing', () => {
  const s = slotMachine({ config: { checks: [], features: { mergeLock: true } } });
  const lockHolder = () => JSON.parse(readFileSync(join(s.env.AGENT_SLOTS_DIR, 'merge.json'), 'utf8')).holder;
  try {
    assert.equal(s.slotCli('acquire', 'merge', '--who', 'merge-pr #7').status, 0, 'another merge of #7, by the old name');
    assert.equal(merge(s), EXIT.busy, 'busy, not a renewal of the other merge');
    assert.equal(lockHolder().who, 'merge-pr #7', 'the other merge still holds it');
    assert.equal(s.slotCli('release', 'merge', '--who', 'merge-pr #7').status, 0);
    // While this merge posts its results, its lease is taken over by another merge.
    const gh = s.ctx.gh;
    s.ctx.gh = (args) => {
      if (args[1] === 'comment') {
        assert.equal(lockHolder().pid, process.pid, 'the pid of the merge is on record');
        assert.equal(s.slotCli('release', 'merge', '--who', 'x', '--force').status, 0);
        assert.equal(s.slotCli('acquire', 'merge', '--who', 'Other merge').status, 0);
      }
      return gh(args);
    };
    assert.equal(merge(s), EXIT.failed);
    assert.ok(!ghSubs(s).includes('merge'), 'not merged');
    assert.equal(lockHolder().who, 'Other merge', 'the other merge keeps its lock');
  } finally { s.cleanup(); }
});

// ---------- Kit tests and project tests ----------

test('merge lock, real slot script: waited for with --wait and given back; without --wait a held lock gives 75', async () => {
  const s = slotMachine({ config: { checks: [], features: { mergeLock: true } } });
  const lockHolder = () => {
    const file = join(s.env.AGENT_SLOTS_DIR, 'merge.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).holder : null;
  };
  try {
    assert.equal(s.slotCli('acquire', 'tests', '--who', 'Tester').status, 0, 'a held tests slot does not matter to the merge lock');
    const child = spawn(process.execPath, [s.slotScript, 'run', 'merge', '--who', 'Other merge', '--', process.execPath, '-e', 'setTimeout(() => {}, 400)'], { env: s.env, stdio: 'ignore' });
    const end = Date.now() + 30000;
    while (lockHolder()?.pid !== child.pid) {
      if (Date.now() > end) throw new Error('the other merge never took the lock');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(merge(s, { wait: 20 }), EXIT.ok);
    assert.match(s.calls.out.join('\n'), /wait {2}merge lock: another merge on this machine holds it\. Waiting up to 20 seconds/);
    assert.equal(lockHolder(), null, 'given back after the merge');
    await new Promise((done) => child.on('exit', done));
    assert.equal(s.slotCli('acquire', 'merge', '--who', 'Other merge').status, 0);
    assert.equal(merge(s), EXIT.busy);
    assert.deepEqual(ghSubs(s), ['view', 'comment', 'merge', 'view', 'view'], 'the second run merged nothing');
    assert.equal(lockHolder().who, 'Other merge', 'the other merge still holds it');
  } finally { s.cleanup(); }
});

test('splitTests: with a manifest the kit\'s tests and the project\'s tests are told apart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-pr-split-'));
  try {
    assert.deepEqual(splitTests(dir), { kitTests: [], scriptTests: [] }, 'no scripts folder');
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['check-plans.test.mjs', 'slot.test.mjs', 'home-placement.test.mjs', 'helper.mjs']) writeFileSync(join(dir, 'scripts', f), '');
    assert.deepEqual(splitTests(dir), { kitTests: [], scriptTests: ['scripts/check-plans.test.mjs', 'scripts/home-placement.test.mjs', 'scripts/slot.test.mjs'] }, 'no manifest: one combined list');
    const files = { 'scripts/slot.test.mjs': 'x', 'scripts/check-plans.test.mjs': 'x', 'scripts/check-plans.mjs': 'x', 'docs/agents/core.md': 'x', 'scripts/deep/other.test.mjs': 'x' };
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ files }));
    assert.deepEqual(splitTests(dir), { kitTests: ['scripts/check-plans.test.mjs', 'scripts/slot.test.mjs'], scriptTests: ['scripts/home-placement.test.mjs'] });
    writeFileSync(join(dir, MANIFEST_FILE), '{ not json');
    assert.throws(() => splitTests(dir), /not valid JSON/);
    writeFileSync(join(dir, MANIFEST_FILE), '{}');
    assert.throws(() => splitTests(dir), /"files" object/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('planChecks: kit tests are remembered by the scripts folder alone, script tests by the whole tree', () => {
  const now = 1_000_000_000_000;
  const input = { tier: 'paperwork', kitTests: ['scripts/slot.test.mjs'], scriptTests: ['scripts/home.test.mjs'], now };
  const first = planChecks({ ...input, tree: 'tree1', scriptsTree: 'scripts1', cache: {} });
  assert.deepEqual(first.planned.map((p) => p.name), ['rules', 'kit tests', 'script tests']);
  assert.deepEqual(first.planned.map((p) => p.files), [undefined, ['scripts/slot.test.mjs'], ['scripts/home.test.mjs']]);
  assert.equal(first.planned[0].key, null, 'the rules are never remembered');
  const cache = Object.fromEntries(first.planned.filter((p) => p.key).map((p) => [p.key, { name: p.name, passedAt: now - 1000 }]));
  const docsChanged = planChecks({ ...input, tree: 'tree2', scriptsTree: 'scripts1', cache });
  assert.deepEqual(docsChanged.planned.filter((p) => p.cached).map((p) => p.name), ['kit tests']);
  const scriptsChanged = planChecks({ ...input, tree: 'tree3', scriptsTree: 'scripts2', cache });
  assert.deepEqual(scriptsChanged.planned.filter((p) => p.cached), []);
  const noProjectTests = planChecks({ ...input, scriptTests: [], tree: 'tree1', scriptsTree: 'scripts1', cache });
  assert.deepEqual(noProjectTests.planned.map((p) => p.name), ['rules', 'kit tests']);
});

test('flow: with a manifest, a second docs-only pull request skips "kit tests" as cached; a change in scripts/ reruns it', () => {
  const m = fakeMachine({ manifest: ['scripts/a.test.mjs', 'scripts/check-plans.mjs'], projectTests: ['scripts/home.test.mjs'] });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'kit tests', 'script tests'], 'the paperwork tier runs both');
    assert.deepEqual(m.calls.run[1].args, ['--test', 'scripts/a.test.mjs']);
    assert.deepEqual(m.calls.run[2].args, ['--test', 'scripts/home.test.mjs'], 'project test files run under "script tests"');

    // A second pull request: other docs changed, so the whole tree is new, but scripts/ is the same.
    m.calls.run.length = 0;
    m.calls.gh.length = 0;
    m.state.tree = 'tree2';
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests']);
    assert.match(m.calls.gh[1][4], /- kit tests: pass \(cached\)/);
    assert.match(m.calls.out.join('\n'), /pass {2}kit tests \(cached/);

    // Any change under scripts/ gives that folder a new hash: the kit tests run again.
    m.calls.run.length = 0;
    m.state.tree = 'tree3';
    m.state.scriptsTree = 'scripts2';
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'kit tests', 'script tests']);

    m.calls.run.length = 0;
    assert.equal(merge(m, { noCache: true }), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'kit tests', 'script tests'], '--no-cache ignores the remembered passes');
  } finally { m.cleanup(); }
});

test('flow: with a manifest and no project test files, "script tests" is left out with no line printed', () => {
  const m = fakeMachine({ manifest: ['scripts/a.test.mjs'] });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'kit tests']);
    assert.ok(!m.calls.out.some((l) => l.includes('script tests')));
    assert.doesNotMatch(m.calls.gh[1][4], /script tests/);
  } finally { m.cleanup(); }
});

test('flow: with no manifest, every scripts test runs as one "script tests" check keyed by the whole tree', () => {
  const m = fakeMachine({ projectTests: ['scripts/home.test.mjs'] });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests']);
    assert.deepEqual(m.calls.run[1].args, ['--test', 'scripts/a.test.mjs', 'scripts/home.test.mjs']);
    m.calls.run.length = 0;
    m.state.tree = 'tree2';
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests'], 'a new tree reruns it even though scripts/ did not change');
  } finally { m.cleanup(); }
});

test('flow: a manifest that cannot be read stops the run with exit code 2', () => {
  const m = fakeMachine();
  try {
    writeFileSync(join(m.root, MANIFEST_FILE), '{ not json');
    assert.equal(merge(m), EXIT.usage);
    assert.equal(m.calls.run.length, 0);
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.usage);
  } finally { m.cleanup(); }
});

test('--check with unsaved files reruns the kit tests too', () => {
  const m = fakeMachine({ manifest: ['scripts/a.test.mjs'], branch: 'lead/notes' });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    m.calls.run.length = 0;
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    assert.deepEqual(ran(m), ['rules'], 'cached on a clean folder');
    m.calls.run.length = 0;
    m.state.status = ' M docs/handoff.md\0';
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'kit tests'], 'unsaved files: no remembered pass is trusted');
  } finally { m.cleanup(); }
});

// ---------- Trusted settings, checker flags, and the exact-commit merge ----------

const BUILD_PR = { number: 7, state: 'OPEN', isDraft: false, headRefName: 'build/003-save-word', baseRefName: 'main' };

test('checkerApi reads the version from the checker text', () => {
  assert.equal(checkerApi('// an old checker\n'), 0);
  assert.equal(checkerApi(`// supports ${API_MARKER}\n`), 2, 'the bare word counts as 2');
  assert.equal(checkerApi('export const CHECKER_API = 2;\n'), 2);
  assert.equal(checkerApi('export const CHECKER_API = 3;\n'), 3);
  assert.equal(checkerApi('export const CHECKER_API=12;'), 12);
});

test('checkerArgs: --root and --branch from API 2, --base only from API 3', () => {
  const input = { root: '/w', branch: 'build/003-save-word', baseRef: 'origin/main' };
  assert.deepEqual(checkerArgs({ ...input, api: 0 }), []);
  assert.deepEqual(checkerArgs({ ...input, api: 2 }), ['--root', '/w', '--branch', 'build/003-save-word']);
  assert.deepEqual(checkerArgs({ ...input, api: 3 }), ['--root', '/w', '--branch', 'build/003-save-word', '--base', 'origin/main']);
  assert.deepEqual(checkerArgs({ ...input, branch: '', api: 3 }), ['--root', '/w', '--base', 'origin/main']);
});

test('flow: the merge names the exact commit that was checked, and a refusal is final', () => {
  const m = fakeMachine({ ghFail: { merge: 1 } });
  try {
    assert.equal(merge(m), EXIT.failed);
    const merges = m.calls.gh.filter((c) => c[1] === 'merge');
    assert.equal(merges.length, 1, 'no second attempt');
    assert.deepEqual(merges[0], ['pr', 'merge', '7', '--merge', '--match-head-commit', 'headsha']);
    assert.match(m.calls.out.join('\n'), /GitHub refused the merge[\s\S]*Not merged/);
  } finally { m.cleanup(); }
});

test('flow: a draft is marked ready before the exact-commit merge', () => {
  const m = fakeMachine({ pr: { ...BUILD_PR, isDraft: true } });
  try {
    assert.equal(merge(m, { ready: true }), EXIT.ok);
    assert.deepEqual(ghSubs(m), ['view', 'comment', 'ready', 'merge', 'view']);
    assert.deepEqual(m.calls.gh[3].slice(3), ['--merge', '--match-head-commit', 'headsha']);
  } finally { m.cleanup(); }
});

test('flow: a build branch that empties "checks" or widens the docs paths in its own settings still gets the base branch\'s checks', () => {
  const config = { checks: [], paperworkPaths: ['docs/', 'apps/'] };
  const m = fakeMachine({ pr: BUILD_PR, files: ['apps/mobile/save.ts'], config });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.ok(m.calls.git.includes('show origin/main:scripts/kit.config.json'));
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint', 'test']);
    assert.match(m.calls.gh[1][4], /tier: code/);
  } finally { m.cleanup(); }
});

test('flow: a build branch that adds "build/" to leadPrefixes in its own settings is still not a lead branch', () => {
  const config = { checks: [], leadPrefixes: ['lead/', 'build/'] };
  const m = fakeMachine({ pr: BUILD_PR, files: ['apps/mobile/save.ts'], config, baseChecker: 'export const CHECKER_API = 2; // base copy\n' });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.ok(!m.calls.run[0].args[0].startsWith(m.root), 'the base branch\'s checker runs, not its own');
    assert.equal(m.calls.run[0].checkerText, 'export const CHECKER_API = 2; // base copy\n');
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint', 'test']);
  } finally { m.cleanup(); }
});

test('flow: a lead branch\'s own settings change takes effect', () => {
  const config = { checks: [{ name: 'new check', run: 'echo new' }], paperworkPaths: ['docs/plans/'] };
  const m = fakeMachine({ files: ['docs/handoff.md'], config });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'new check'], 'docs/handoff.md is code under the new paths, and the new check runs');
    assert.equal(m.calls.run[0].args[0], join(m.root, 'scripts', 'check-plans.mjs'));
  } finally { m.cleanup(); }
});

test('flow: the base branch\'s settings decide what a lead branch is', () => {
  // The base says head agents use "head/". A "lead/" branch is then not a lead branch, and its own settings do not count.
  const m = fakeMachine({ files: ['apps/mobile/save.ts'], baseConfig: { checks: CHECKS, leadPrefixes: ['head/'] }, config: { checks: [] } });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.ok(!m.calls.run[0].args[0].startsWith(m.root));
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint', 'test']);
  } finally { m.cleanup(); }
});

test('flow: with no settings file on the base branch, a build branch gets the defaults', () => {
  const code = fakeMachine({ pr: BUILD_PR, files: ['apps/mobile/save.ts'], baseConfig: null, config: { paperworkPaths: ['apps/'] } });
  try {
    assert.equal(merge(code), EXIT.ok);
    assert.deepEqual(ran(code), ['rules', 'script tests'], 'the defaults have no app checks');
    assert.match(code.calls.gh[1][4], /tier: code/, 'the default docs paths, not the branch\'s');
  } finally { code.cleanup(); }
  const docs = fakeMachine({ pr: BUILD_PR, files: ['docs/plans/active/003-save-word.md', 'AGENTS.md'], baseConfig: null });
  try {
    assert.equal(merge(docs), EXIT.ok);
    assert.match(docs.calls.gh[1][4], /tier: paperwork/);
  } finally { docs.cleanup(); }
});

test('flow: settings on the base branch that cannot be read stop the run with exit code 2', () => {
  for (const baseConfig of ['{ not json', JSON.stringify({ checks: [{ name: 'test' }] })]) {
    const m = fakeMachine({ pr: BUILD_PR, baseConfig });
    try {
      assert.equal(merge(m), EXIT.usage);
      assert.match(m.calls.out.join('\n'), /settings on origin\/main cannot be read/);
      assert.equal(m.calls.run.length, 0);
      assert.deepEqual(ghSubs(m), ['view']);
    } finally { m.cleanup(); }
  }
});

test('flow: a build branch may not point the script at another remote', () => {
  const m = fakeMachine({ pr: BUILD_PR, baseConfig: { checks: CHECKS, remote: 'upstream' } });
  try {
    assert.equal(merge(m), EXIT.usage);
    assert.match(m.calls.out.join('\n'), /Only a lead branch may change settings/);
    assert.equal(m.calls.run.length, 0);
  } finally { m.cleanup(); }
});

test('flow: --base goes to the checker only when its text says API 3 or higher', () => {
  const trusted3 = fakeMachine({ pr: BUILD_PR, baseChecker: 'export const CHECKER_API = 3;\n' });
  try {
    assert.equal(merge(trusted3), EXIT.ok);
    assert.deepEqual(trusted3.calls.run[0].args.slice(1), ['--root', trusted3.root, '--branch', 'build/003-save-word', '--base', 'origin/main']);
  } finally { trusted3.cleanup(); }
  const trusted2 = fakeMachine({ pr: BUILD_PR, baseChecker: 'export const CHECKER_API = 2;\n' });
  try {
    assert.equal(merge(trusted2), EXIT.ok);
    assert.deepEqual(trusted2.calls.run[0].args.slice(1), ['--root', trusted2.root, '--branch', 'build/003-save-word']);
  } finally { trusted2.cleanup(); }
  const lead3 = fakeMachine({ localChecker: 'export const CHECKER_API = 3;\n' });
  try {
    assert.equal(merge(lead3), EXIT.ok);
    assert.deepEqual(lead3.calls.run[0].args.slice(1), ['--root', lead3.root, '--branch', 'lead/notes', '--base', 'origin/main']);
  } finally { lead3.cleanup(); }
  const old = fakeMachine({ localChecker: '// a checker from before the flags\n' });
  try {
    assert.equal(merge(old), EXIT.ok);
    assert.deepEqual(old.calls.run[0].args.slice(1), [], 'no CHECKER_API: no flags at all');
  } finally { old.cleanup(); }
});

test('--check applies the same trusted-settings rule, with the base branch from this folder\'s settings', () => {
  const build = fakeMachine({ branch: 'build/003-save-word', files: ['apps/mobile/save.ts'], config: { checks: [], leadPrefixes: ['lead/', 'build/'] }, baseChecker: 'export const CHECKER_API = 3;\n' });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), build.ctx), EXIT.ok);
    assert.deepEqual(ran(build), ['rules', 'script tests', 'typecheck', 'lint', 'test'], 'the base branch\'s checks');
    assert.ok(!build.calls.run[0].args[0].startsWith(build.root), 'the base branch\'s checker');
    assert.deepEqual(build.calls.run[0].args.slice(1), ['--root', build.root, '--branch', 'build/003-save-word', '--base', 'origin/main']);
  } finally { build.cleanup(); }
  const lead = fakeMachine({ branch: 'lead/notes', files: ['apps/mobile/save.ts'], config: { checks: [{ name: 'new check', run: 'echo new' }] } });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), lead.ctx), EXIT.ok);
    assert.deepEqual(ran(lead), ['rules', 'script tests', 'new check']);
  } finally { lead.cleanup(); }
  const moved = fakeMachine({ branch: 'build/003-save-word', baseConfig: { checks: CHECKS, baseBranch: 'release' } });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), moved.ctx), EXIT.usage, 'a build branch may not change the base branch');
    assert.match(moved.calls.out.join('\n'), /"baseBranch"/);
  } finally { moved.cleanup(); }
});

test('flow: a lead branch reads its settings again after the base branch is merged in', () => {
  const m = fakeMachine({ files: ['apps/mobile/save.ts'], config: { checks: [] } });
  try {
    m.ctx.reloadConfig = () => settings({ checks: [{ name: 'merged in', run: 'echo merged' }] });
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'merged in']);
  } finally { m.cleanup(); }
});

// ---------- The quick check, the saved time, and the risk label ----------

test('planChecks: --fast also leaves out a check marked "fast": false; with no "fast" key, or "fast": true, it still runs', () => {
  const checks = [{ name: 'lint', run: 'pnpm lint', fast: true }, { name: 'types', run: 'pnpm tsc' }, { name: 'audit', run: 'pnpm audit', fast: false }, { name: 'test', run: 'pnpm test', slot: true }];
  const fast = planChecks({ tier: 'code', checks, fast: true });
  assert.deepEqual(fast.planned.map((p) => p.name), ['rules', 'lint', 'types']);
  assert.deepEqual(fast.skipped, [{ name: 'audit', why: 'fast' }, { name: 'test', why: 'fast' }]);
  assert.deepEqual(planChecks({ tier: 'code', checks }).planned.map((p) => p.name), ['rules', 'lint', 'types', 'audit', 'test'], 'a merge and a full check run every one');
});

test('recordPass saves how long the check took, and the flow hands it the real time', () => {
  const m = fakeMachine({ files: ['apps/mobile/save.ts'] });
  try {
    recordPass(join(m.commonDir, 'one.json'), 'k1', 'test', 5, 420);
    assert.deepEqual(readCache(join(m.commonDir, 'one.json')), { k1: { name: 'test', passedAt: 5, ms: 420 } });
    assert.equal(merge(m), EXIT.ok);
    const saved = Object.values(readCache(join(m.commonDir, CACHE_FILE)));
    assert.deepEqual(saved.map((e) => e.name).sort(), ['lint', 'script tests', 'test', 'typecheck']);
    assert.ok(saved.every((e) => e.ms === 100), 'the fake clock moves 100 ms per look');
  } finally { m.cleanup(); }
});

test('riskOf: high when a changed file is in a high-risk folder or is a high-risk file, with the entries that matched', () => {
  const paths = ['apps/server/auth/', 'migrations/', '.env.example'];
  assert.deepEqual(riskOf(['apps/server/auth/login.ts', 'src/a.ts', '.env.example'], paths), { risk: 'high', riskPaths: ['apps/server/auth/', '.env.example'] });
  assert.deepEqual(riskOf(['apps/server/authz.ts', 'docs/.env.example'], paths), { risk: 'normal', riskPaths: [] }, 'a folder is a prefix, a file is an exact path');
  assert.deepEqual(riskOf(['src/a.ts'], []), { risk: 'normal', riskPaths: [] });
});

test('risk label: printed and posted when the settings list high-risk paths; it never blocks; with none listed, no line', () => {
  const RISKY = { config: { highRiskPaths: ['apps/server/auth/', 'migrations/'] }, baseConfig: { checks: CHECKS, highRiskPaths: ['apps/server/auth/', 'migrations/'] } };
  const high = fakeMachine({ ...RISKY, files: ['apps/server/auth/login.ts', 'migrations/0007_users.sql'] });
  try {
    assert.equal(merge(high), EXIT.ok, 'a high-risk change still merges');
    assert.ok(high.calls.out.includes('note  risk: high (touches apps/server/auth/, migrations/)'));
    assert.match(high.calls.gh.find((c) => c[1] === 'comment')[4], /^Local checks on abc1234[^\n]*\nRisk: high \(touches `apps\/server\/auth\/`, `migrations\/`\)\.\n/);
  } finally { high.cleanup(); }
  const normal = fakeMachine({ ...RISKY, branch: 'build/003-save-word', files: ['src/app.ts'] });
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), normal.ctx), EXIT.ok);
    assert.ok(normal.calls.out.includes('note  risk: normal'));
    assert.equal(merge(normal), EXIT.ok);
    assert.match(normal.calls.gh.find((c) => c[1] === 'comment')[4], /\nRisk: normal\.\n/);
  } finally { normal.cleanup(); }
  const unset = fakeMachine({ files: ['apps/server/auth/login.ts'] });
  try {
    assert.equal(merge(unset), EXIT.ok);
    assert.doesNotMatch(unset.calls.gh.find((c) => c[1] === 'comment')[4], /Risk/);
    assert.doesNotMatch(unset.calls.out.join('\n'), /risk/);
  } finally { unset.cleanup(); }
});

// ---------- Events ----------

const EVENTS = (extra = {}) => ({ config: { features: { events: true, ...extra } }, baseConfig: { checks: CHECKS, features: { events: true, ...extra } } });

// Gives a fake machine an event log in memory, shaped like scripts/events.mjs writes it, and asks.
function withEvents(m) {
  m.events = [];
  m.asks = [];
  let n = 0;
  m.ctx.appendEvent = (root, { type, data, branch, slice }, { now }) => {
    assert.equal(root, m.root);
    const fromBranch = String(branch ?? '').match(/(?:^|\/)(\d{3})(?=-|$)/);
    const event = { id: `e${++n}`, at: new Date(now).toISOString(), type, branch: branch ?? null, slice: slice ?? (fromBranch ? Number(fromBranch[1]) : null), data };
    m.events.push(event);
    return event;
  };
  m.ctx.readEvents = (root, { types }) => ({ events: m.events.filter((e) => types.includes(e.type)), skipped: 0 });
  m.ctx.newAsk = (root, fields) => {
    const ask = { id: `ask${m.asks.length + 1}`, ...checkAsk(fields), slice: fields.slice };
    m.asks.push(ask);
    return ask;
  };
  m.ctx.parseTasks = parseTasks;
  m.ctx.taskStates = taskStates;
  return m;
}
const types = (m) => m.events.map((e) => e.type);
const NUMSTAT = '10\t2\tapps/mobile/save.ts\n-\t-\tassets/logo.png\n3\t0\tapps/mobile/save.test.ts\n';

test('events: a merge writes one check-run per check that really ran, with its time, then merged with the size, risk, and new test files', () => {
  const m = withEvents(fakeMachine({ ...EVENTS(), files: ['apps/mobile/save.ts'], numstat: NUMSTAT, nameStatus: z('M', 'apps/mobile/save.ts', 'A', 'assets/logo.png', 'A', 'apps/mobile/save.test.ts') }));
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(types(m), ['check-run', 'check-run', 'check-run', 'check-run', 'check-run', 'merged']);
    assert.deepEqual(m.events.slice(0, 5).map((e) => e.data), ['rules', 'script tests', 'typecheck', 'lint', 'test'].map((check) => ({ check, ok: true, ms: 100, tier: 'code', pr: 7, mode: 'merge', head: 'headsha' })));
    assert.ok(m.events.every((e) => e.branch === 'lead/notes'), 'tagged with the pull request\'s branch');
    assert.deepEqual(m.events.at(-1).data, { pr: 7, tier: 'code', files: 3, added: 13, removed: 2, risk: 'normal', riskPaths: [], testsAdded: 1, testReasons: false });
    m.events.length = 0;
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(m.events.filter((e) => e.type === 'check-run').map((e) => e.data.check), ['rules'], 'a remembered pass is not a run and writes nothing');
  } finally { m.cleanup(); }
});

test('events: the merged event carries the high risk label and the entries that matched', () => {
  const risky = { config: { features: { events: true }, highRiskPaths: ['migrations/'] }, baseConfig: { checks: CHECKS, features: { events: true }, highRiskPaths: ['migrations/'] } };
  const m = withEvents(fakeMachine({ ...risky, files: ['migrations/0007_users.sql'], numstat: '4\t0\tmigrations/0007_users.sql\n', nameStatus: z('A', 'migrations/0007_users.sql') }));
  try {
    assert.equal(merge(m), EXIT.ok);
    const { risk, riskPaths } = m.events.at(-1).data;
    assert.deepEqual([risk, riskPaths], ['high', ['migrations/']]);
  } finally { m.cleanup(); }
});

test('events: a failed check writes check-run with ok false and one merge-blocked that names the check', () => {
  const m = withEvents(fakeMachine({ ...EVENTS(), files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.deepEqual(types(m), ['check-run', 'check-run', 'check-run', 'check-run', 'merge-blocked']);
    assert.deepEqual(m.events[3].data, { check: 'lint', ok: false, ms: 100, tier: 'code', pr: 7, mode: 'merge', head: 'headsha' });
    assert.deepEqual(m.events[4].data, { pr: 7, reason: 'The check "lint" failed.', check: 'lint' });
  } finally { m.cleanup(); }
});

test('events: a conflict and a GitHub refusal are merge-blocked; a busy slot, wrong usage, and an unknown merge state are not', () => {
  const conflict = withEvents(fakeMachine({ ...EVENTS(), mergeCode: 1, conflicted: 'docs/roadmap.md\n' }));
  try {
    assert.equal(merge(conflict), EXIT.failed);
    assert.deepEqual(conflict.events.map((e) => [e.type, e.data]), [['merge-blocked', { pr: 7, reason: 'Merging origin/main has conflicts in:', check: null }]]);
  } finally { conflict.cleanup(); }
  const github = withEvents(fakeMachine({ ...EVENTS(), ghFail: { merge: 1 } }));
  try {
    assert.equal(merge(github), EXIT.failed);
    assert.deepEqual(github.events.at(-1).data, { pr: 7, reason: 'GitHub refused the merge: gh merge failed', check: 'github' });
  } finally { github.cleanup(); }
  const receipts = withEvents(fakeMachine({ ...EVENTS({ reviewReceipts: true }), files: ['src/app.ts'] }));
  receipts.ctx.checkReceipts = () => ({ uncovered: UNCOVERED, covered: 0, notes: [] });
  try {
    assert.equal(merge(receipts), EXIT.failed);
    assert.deepEqual(receipts.events.map((e) => [e.type, e.data.check]), [['merge-blocked', 'receipts']]);
    assert.match(receipts.events[0].data.reason, /^receipts: 1 commit has no approving review receipt/);
    assert.doesNotMatch(receipts.events[0].data.reason, /\n/, 'one line');
  } finally { receipts.cleanup(); }
  for (const [over, code] of [[{ files: ['apps/mobile/save.ts'], codes: { test: 75 } }, EXIT.busy], [{ status: ' M docs/handoff.md\n' }, EXIT.usage], [{ ghTimeout: { merge: true } }, EXIT.failed]]) {
    const m = withEvents(fakeMachine({ ...EVENTS(), ...over }));
    try {
      assert.equal(merge(m), code);
      assert.equal(types(m).includes('merge-blocked'), false, JSON.stringify(over));
      assert.equal(types(m).includes('merged'), false);
    } finally { m.cleanup(); }
  }
});

test('events: --check writes check-run with mode "check" and no pull request, and never merge-blocked', () => {
  const m = withEvents(fakeMachine({ ...EVENTS(), branch: 'build/003-save-word', files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.failed);
    assert.deepEqual(types(m), ['check-run', 'check-run', 'check-run', 'check-run']);
    assert.deepEqual(m.events[3], { ...m.events[3], branch: 'build/003-save-word', slice: 3, data: { check: 'lint', ok: false, ms: 100, tier: 'code', pr: null, mode: 'check', head: 'headsha' } });
  } finally { m.cleanup(); }
});

test('events: flag off, the event log is never touched', () => {
  const m = fakeMachine({ files: ['apps/mobile/save.ts'], codes: { lint: 1 } });
  m.ctx.appendEvent = () => { throw new Error('written with the flag off'); };
  m.ctx.readEvents = () => { throw new Error('read with the flag off'); };
  try {
    assert.equal(merge(m), EXIT.failed);
    m.state.codes = {};
    assert.equal(merge(m), EXIT.ok);
    assert.doesNotMatch(m.calls.out.join('\n'), /event log/);
  } finally { m.cleanup(); }
});

test('events: a write that fails, or a missing scripts/events.mjs, prints one line each and the merge still lands', () => {
  const broken = fakeMachine({ ...EVENTS(), numstat: NUMSTAT, nameStatus: z('M', 'docs/handoff.md') });
  broken.ctx.appendEvent = () => { throw new Error('disk full'); };
  try {
    assert.equal(merge(broken), EXIT.ok);
    assert.deepEqual(ghSubs(broken), ['view', 'comment', 'merge', 'view']);
    const warned = broken.calls.out.filter((l) => l.startsWith('Warning: event log'));
    assert.deepEqual(warned, ['rules', 'script tests'].map(() => 'Warning: event log: no check-run event was written (disk full). Carrying on.').concat('Warning: event log: no merged event was written (disk full). Carrying on.'));
  } finally { broken.cleanup(); }
  const missing = fakeMachine({ ...EVENTS(), codes: { rules: 1 } });
  missing.ctx.eventsError = 'Cannot find module events.mjs';
  try {
    assert.equal(merge(missing), EXIT.failed, 'the failed check still decides the exit code');
    assert.match(missing.calls.out.join('\n'), /Warning: event log: no check-run event was written \(Cannot find module events\.mjs\)/);
  } finally { missing.cleanup(); }
  const noGit = withEvents(fakeMachine({ ...EVENTS() }));
  try {
    assert.equal(merge(noGit), EXIT.ok, 'the fake git cannot give the size of the change');
    assert.match(noGit.calls.out.at(-1), /^Warning: event log: .*The merge is done\.$/);
    assert.equal(types(noGit).includes('merged'), false);
  } finally { noGit.cleanup(); }
});

const PLAN = (status) => `---\nid: 082\nstatus: ${status}\n---\n\n# 082: Sync\n\n## Tasks\n\n1. Build the queue\n2. Send the queue\n3. Show a banner\n4. Old idea\n`;
const CLOSING = { numstat: '1\t1\tdocs/plans/completed/082-sync.md\n', files: ['docs/plans/completed/082-sync.md'] };

test('events: a merge that moves a plan into completed/ as done writes slice-closed, and task-done for each task nobody logged', () => {
  const m = withEvents(fakeMachine({ ...EVENTS(), ...CLOSING, nameStatus: z('R090', 'docs/plans/active/082-sync.md', 'docs/plans/completed/082-sync.md'), shown: { 'docs/plans/completed/082-sync.md': PLAN('done') } }));
  const logged = (type, task) => m.events.push({ id: `t${task}`, at: '2026-11-18T10:00:00.000Z', type, branch: 'build/082-sync', slice: 82, data: { task, title: 'x' } });
  logged('task-done', 1);
  logged('task-started', 2);
  logged('task-dropped', 4);
  m.events.push({ id: 'other', at: '2026-11-18T10:00:00.000Z', type: 'task-done', branch: 'build/081-x', slice: 81, data: { task: 3, title: 'another slice' } });
  try {
    assert.equal(merge(m), EXIT.ok);
    const written = m.events.slice(4).filter((e) => e.type !== 'check-run');
    assert.deepEqual(written.map((e) => [e.type, e.slice, e.data]), [
      ['merged', null, { pr: 7, tier: 'paperwork', files: 1, added: 1, removed: 1, risk: 'normal', riskPaths: [], testsAdded: 0, testReasons: false }],
      ['slice-closed', 82, { pr: 7 }],
      ['task-done', 82, { task: 2, title: 'Send the queue', note: null, auto: true }],
      ['task-done', 82, { task: 3, title: 'Show a banner', note: null, auto: true }],
    ], 'task 1 was logged done and task 4 dropped, so neither is written again');
  } finally { m.cleanup(); }
});

test('events: a plan that is not done, or that was already in completed/, closes no slice', () => {
  for (const [nameStatus, text] of [
    [z('A', 'docs/plans/completed/082-sync.md'), PLAN('in_review')],
    [z('M', 'docs/plans/completed/082-sync.md'), PLAN('done')],
    [z('R100', 'docs/plans/completed/082-sync.md', 'docs/plans/completed/082-sync-app.md'), PLAN('done')],
    [z('A', 'docs/plans/active/082-sync.md'), PLAN('done')],
  ]) {
    const m = withEvents(fakeMachine({ ...EVENTS(), ...CLOSING, nameStatus, shown: { 'docs/plans/completed/082-sync.md': text, 'docs/plans/completed/082-sync-app.md': text } }));
    try {
      assert.equal(merge(m), EXIT.ok);
      assert.deepEqual(types(m).filter((t) => t !== 'check-run'), ['merged'], nameStatus);
    } finally { m.cleanup(); }
  }
});

test('plansMovedToCompleted, planIsDone, parseNameStatus: the pure pieces', () => {
  const entries = parseNameStatus(z('A', 'docs/plans/completed/082-sync.md', 'R090', 'docs/plans/active/083-x.md', 'docs/plans/completed/083-x.md', 'M', 'docs/plans/completed/001-a.md', 'A', 'docs/plans/completed/notes.md', 'A', 'docs/plans/completed/logs/084-x.md', 'D', 'docs/plans/completed/002-b.md'));
  assert.deepEqual(entries[1], { status: 'R', file: 'docs/plans/active/083-x.md', to: 'docs/plans/completed/083-x.md' });
  assert.deepEqual(plansMovedToCompleted(entries, 'docs/plans'), [{ slice: 82, path: 'docs/plans/completed/082-sync.md' }, { slice: 83, path: 'docs/plans/completed/083-x.md' }]);
  assert.deepEqual(plansMovedToCompleted(entries, 'plans'), [], 'the folder comes from the settings');
  assert.equal(planIsDone(PLAN('done')), true);
  assert.equal(planIsDone(PLAN('in_review')), false);
  assert.equal(planIsDone('# 082\n\nstatus: done\n'), false, 'only the header between the two --- lines counts');
});

// ---------- The retry cap ----------

const run = (branch, check, ok) => ({ type: 'check-run', branch, data: { check, ok } });

test('failStreak: failures of one check in a row on one branch; only a pass of that same check starts the count again', () => {
  const b = 'build/003-save-word';
  assert.deepEqual(failStreak([run(b, 'lint', false), run(b, 'lint', false)], b, 'lint'), { fails: 2, parked: false });
  assert.deepEqual(failStreak([run(b, 'lint', false), run(b, 'rules', true), run(b, 'typecheck', true), run(b, 'lint', false), run(b, 'lint', false)], b, 'lint'), { fails: 3, parked: false }, 'other checks passing in the same run do not hide a check that keeps failing');
  assert.deepEqual(failStreak([run(b, 'lint', false), run(b, 'lint', false), run(b, 'lint', true), run(b, 'lint', false)], b, 'lint'), { fails: 1, parked: false });
  assert.deepEqual(failStreak([run(b, 'lint', false), run('build/004-other', 'lint', false), run(b, 'test', false), run(b, 'lint', false)], b, 'lint'), { fails: 2, parked: false }, 'another branch and another check do not count');
  const parked = { type: 'slice-parked', branch: b, data: { check: 'lint', ask: 'a1' } };
  assert.deepEqual(failStreak([run(b, 'lint', false), run(b, 'lint', false), run(b, 'lint', false), parked, run(b, 'lint', false)], b, 'lint'), { fails: 4, parked: true });
  assert.deepEqual(failStreak([run(b, 'lint', false), parked, run(b, 'lint', true), run(b, 'lint', false)], b, 'lint'), { fails: 1, parked: false }, 'a pass ends the parked run too');
  assert.equal(RETRY_CAP, 3);
});

test('parkedAsk: always inside the limits scripts/ask.mjs enforces, however long the names', () => {
  const ask = checkAsk(parkedAsk({ branch: `build/003-${'very-long-name-'.repeat(20)}`, check: 'a check with a very long name '.repeat(10), fails: 3 }));
  assert.equal(ask.title, 'What should happen to a branch whose checks keep failing?');
  assert.match(ask.why, /failed 3 times in a row on build\/003-very-long-name/);
  assert.deepEqual(ask.options.map((o) => o.key), ['A', 'B', 'C']);
  assert.match(checkAsk(parkedAsk({ branch: 'build/003-save-word', check: 'lint', fails: 3 })).why, /^The check "lint" failed 3 times in a row on build\/003-save-word, so the agent was told to stop retrying it\.$/);
});

test('retry cap: the third failure in a row of one check files one ask, writes slice-parked, and says to stop; later failures do not ask again', () => {
  const m = withEvents(fakeMachine({ ...EVENTS(), branch: 'build/003-save-word', files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  const check = () => checkOnly(parseArgs(['--check', '--fast']), m.ctx);
  try {
    assert.equal(check(), EXIT.failed);
    assert.equal(check(), EXIT.failed);
    assert.deepEqual(m.asks, [], 'two failures: nothing yet');
    assert.doesNotMatch(m.calls.out.join('\n'), /STOP/);
    assert.equal(check(), EXIT.failed);
    assert.equal(m.asks.length, 1);
    assert.equal(m.asks[0].slice, 3, 'the ask carries the slice from the branch name');
    assert.deepEqual(m.events.at(-1), { ...m.events.at(-1), type: 'slice-parked', branch: 'build/003-save-word', slice: 3, data: { check: 'lint', ask: 'ask1' } });
    assert.equal(m.calls.out.at(-1), 'STOP  "lint" has now failed 3 times in a row on build/003-save-word. Stop retrying it. An ask for Stephen was filed (id ask1). Move to other work until he answers.');
    assert.equal(check(), EXIT.failed);
    assert.equal(m.asks.length, 1, 'one ask per branch, not one per failure');
    assert.equal(types(m).filter((t) => t === 'slice-parked').length, 1);
    assert.equal(m.calls.out.at(-1), 'STOP  "lint" has now failed 4 times in a row on build/003-save-word. Stop retrying it. An ask for Stephen is already filed. Move to other work until he answers.');
    // It blocks nothing: once the check passes, the run passes, and the count starts again.
    m.state.codes = {};
    assert.equal(check(), EXIT.ok);
    m.state.codes = { lint: 1 };
    m.state.tree = 'tree2';
    assert.equal(check(), EXIT.failed);
    assert.equal(m.asks.length, 1);
    assert.doesNotMatch(m.calls.out.at(-1), /STOP/);
  } finally { m.cleanup(); }
});

test('retry cap: it counts at a merge too; with events off it does nothing; an ask that cannot be filed is one warning line', () => {
  const m = withEvents(fakeMachine({ ...EVENTS(), files: ['apps/mobile/save.ts'], codes: { test: 1 } }));
  try {
    for (let i = 0; i < 3; i++) assert.equal(merge(m), EXIT.failed);
    assert.equal(m.asks.length, 1);
    assert.match(m.asks[0].why, /The check "test" failed 3 times in a row on lead\/notes/);
    assert.deepEqual(types(m).slice(-3), ['check-run', 'slice-parked', 'merge-blocked']);
  } finally { m.cleanup(); }
  const off = withEvents(fakeMachine({ branch: 'build/003-save-word', files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  try {
    for (let i = 0; i < 4; i++) assert.equal(checkOnly(parseArgs(['--check', '--fast']), off.ctx), EXIT.failed);
    assert.deepEqual([off.events, off.asks], [[], []]);
  } finally { off.cleanup(); }
  const broken = withEvents(fakeMachine({ ...EVENTS(), branch: 'build/003-save-word', files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  broken.ctx.newAsk = () => { throw new Error('the ask was refused'); };
  try {
    for (let i = 0; i < 3; i++) assert.equal(checkOnly(parseArgs(['--check', '--fast']), broken.ctx), EXIT.failed);
    assert.equal(broken.calls.out.at(-1), 'Warning: retry cap: the ask was refused. Carrying on.');
    assert.equal(types(broken).includes('slice-parked'), false, 'not parked, so the next failure tries to ask again');
  } finally { broken.cleanup(); }
});

// ---------- Test protection: reasons and rulings ----------

const MODELS_SET = { builder: 'claude/claude-opus-5-5', headAgent: ['claude/claude-opus-5-5'], reviewer: 'codex/gpt-6.1-sol' };
const REASONS = (extra = {}) => ({ config: { features: { testReasons: true, ...extra }, models: MODELS_SET }, baseConfig: { checks: CHECKS, features: { testReasons: true, ...extra }, models: MODELS_SET } });
const WEAK_TEST = { file: 'apps/web/save.test.ts', kind: 'expectation-changed', what: '1 line that holds an assertion was removed or changed', reason: 'The API now answers 201 for a new word.', problem: '', id: 'aaaaaaaaaaa1' };
const WEAK_RATCHET = { file: 'kit.ratchets.json', kind: 'ratchet-raised', what: 'the count "useEffect uses" went up from 3 to 4', reason: 'The map screen needs one more effect.', problem: '', id: 'aaaaaaaaaaa2' };
const noReason = (w) => ({ ...w, reason: null, id: null, problem: 'no reason line yet' });
const ALLOWED = { ruling: 'allowed', ruledBy: 'gpt-6.1-sol', why: '' };

// Gives a fake machine a sorter that finds `items` and a receipt reader that answers with `rulings`.
function withWeakenings(m, items, rulings = items.map(() => ALLOWED)) {
  m.sorted = [];
  m.ruled = [];
  m.ctx.collectWeakenings = (args) => {
    m.sorted.push(args);
    return { items, testsAdded: 0, reasonFile: `docs/weakenings/${args.branch.replace('/', '-')}.md` };
  };
  m.ctx.checkWeakenings = (args) => {
    m.ruled.push(args);
    return { rulings, notes: [] };
  };
  return m;
}

test('test protection: flag off, the sorter is never asked', () => {
  const m = fakeMachine({ files: ['apps/web/save.test.ts'] });
  m.ctx.collectWeakenings = () => { throw new Error('asked with the flag off'); };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    assert.doesNotMatch(m.calls.gh.find((c) => c[1] === 'comment')[4], /Weakenings/);
  } finally { m.cleanup(); }
});

test('test protection: a weakening with no reason stops --check and the merge, with the exact line to add and the file to add it to', () => {
  const m = withWeakenings(fakeMachine({ ...REASONS(), branch: 'build/003-save-word', files: ['apps/web/save.test.ts'] }), [noReason(WEAK_TEST), WEAK_RATCHET]);
  m.ctx.checkWeakenings = () => { throw new Error('rulings asked before every reason is in'); };
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.failed);
    const out = m.calls.out.join('\n');
    assert.match(out, /note {2}weakenings: 2 changes that weaken a guard\. Each needs the builder's reason and a ruling by a reviewer on another model:\n {2}expectation-changed {4}apps\/web\/save\.test\.ts: 1 line that holds an assertion was removed or changed\n {2}ratchet-raised {9}kit\.ratchets\.json: the count/);
    assert.match(out, /FAIL {2}weakenings: 1 of them has no reason that will do\. Add one line for each to docs\/weakenings\/build-003-save-word\.md \(make the file if it is not there\), commit, push, and run this again:\n {2}- apps\/web\/save\.test\.ts: <why this change is right, in one plain sentence> {3}\(no reason line yet\)$/);
    assert.deepEqual(ran(m), [], 'no check ran');
    const asked = m.sorted[0];
    assert.deepEqual([asked.baseRef, asked.branch, asked.root, asked.presetNames, asked.extraSettingsFiles, asked.configFile], ['origin/main', 'build/003-save-word', m.root, [], [], 'scripts/kit.config.json']);
    assert.equal(asked.isTest('apps/web/save.test.ts'), true, 'the trusted testPaths rule');
    assert.equal(asked.isTest('apps/web/save.ts'), false);
  } finally { m.cleanup(); }
  const merging = withEvents(withWeakenings(fakeMachine({ ...REASONS({ events: true }), files: ['apps/web/save.test.ts'] }), [noReason(WEAK_TEST)]));
  try {
    assert.equal(merge(merging), EXIT.failed);
    assert.deepEqual(ghSubs(merging), ['view'], 'nothing posted or merged');
    assert.deepEqual(ran(merging), []);
    assert.deepEqual(merging.events.map((e) => [e.type, e.data.check]), [['merge-blocked', 'weakenings']]);
  } finally { merging.cleanup(); }
});

test('test protection: --check passes once every weakening has a reason, and does not ask for rulings', () => {
  const m = withWeakenings(fakeMachine({ ...REASONS(), branch: 'build/003-save-word', files: ['apps/web/save.test.ts'] }), [WEAK_TEST]);
  m.ctx.checkWeakenings = () => { throw new Error('the review comes after the quick check'); };
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.ok);
    assert.ok(m.calls.out.includes('pass  weakenings (each has a reason; the reviewer rules on each one before the merge)'));
  } finally { m.cleanup(); }
  const none = withWeakenings(fakeMachine({ ...REASONS(), files: ['src/app.ts'] }), []);
  try {
    assert.equal(merge(none), EXIT.ok);
    assert.ok(none.calls.out.includes('pass  weakenings (no change weakens a test, a ratchet, or a check)'));
    assert.match(none.calls.gh.find((c) => c[1] === 'comment')[4], /\nWeakenings: none\.$/);
    assert.deepEqual(none.ruled, [], 'nothing to rule on');
  } finally { none.cleanup(); }
});

test('test protection: a merge needs each weakening ruled "allowed" by another model; then it merges, posts them, and writes one weakening event each', () => {
  const m = withEvents(withWeakenings(fakeMachine({ ...REASONS({ events: true }), files: ['apps/web/save.test.ts'], numstat: '1\t1\tapps/web/save.test.ts\n', nameStatus: z('M', 'apps/web/save.test.ts') }), [WEAK_TEST, WEAK_RATCHET], [ALLOWED, { ...ALLOWED, ruledBy: 'gpt-7-nova' }]));
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.ok(m.calls.out.includes('pass  weakenings (2 ruled "allowed" by a reviewer on another model)'));
    assert.deepEqual(m.ruled[0].items.map((i) => i.id), ['aaaaaaaaaaa1', 'aaaaaaaaaaa2']);
    assert.deepEqual(m.ruled[0].models, [MODELS_SET, MODELS_SET], 'the models in use and the base branch\'s decide whose ruling counts');
    const body = m.calls.gh.find((c) => c[1] === 'comment')[4];
    assert.match(body, /\nWeakenings \(2\): each has the builder's reason and a ruling of "allowed" by a reviewer on another model\.\n- expectation-changed: `apps\/web\/save\.test\.ts`\. Reason: The API now answers 201 for a new word\. Ruled by gpt-6\.1-sol\.\n- ratchet-raised: `kit\.ratchets\.json`\. Reason: The map screen needs one more effect\. Ruled by gpt-7-nova\.$/);
    assert.deepEqual(m.events.filter((e) => e.type === 'weakening').map((e) => e.data), [
      { pr: 7, kind: 'expectation-changed', file: 'apps/web/save.test.ts', reason: 'The API now answers 201 for a new word.', ruling: 'allowed', ruledBy: 'gpt-6.1-sol' },
      { pr: 7, kind: 'ratchet-raised', file: 'kit.ratchets.json', reason: 'The map screen needs one more effect.', ruling: 'allowed', ruledBy: 'gpt-7-nova' },
    ]);
    assert.ok(types(m).indexOf('merged') < types(m).indexOf('weakening'), 'written once GitHub has merged');
  } finally { m.cleanup(); }
});

test('test protection: no ruling, a ruling by the builder\'s own model, or a ruling of "refused" stops the merge before any check', () => {
  const own = { ruling: null, ruledBy: null, why: "the only ruling is by claude-opus-5-5, the model that built the change or a head agent's; a different model must rule" };
  const missing = { ruling: null, ruledBy: null, why: 'no reviewer has ruled on this exact change and reason' };
  const refused = { ruling: 'refused', ruledBy: 'gpt-6.1-sol', why: '' };
  for (const [ruling, line] of [[own, /expectation-changed {4}apps\/web\/save\.test\.ts: the only ruling is by claude-opus-5-5, the model that built the change/], [missing, /apps\/web\/save\.test\.ts: no reviewer has ruled on this exact change and reason/], [refused, /apps\/web\/save\.test\.ts: refused by gpt-6\.1-sol/]]) {
    const m = withEvents(withWeakenings(fakeMachine({ ...REASONS({ events: true }), files: ['apps/web/save.test.ts'] }), [WEAK_TEST, WEAK_RATCHET], [ruling, ALLOWED]));
    try {
      assert.equal(merge(m), EXIT.failed);
      const out = m.calls.out.join('\n');
      assert.match(out, /FAIL {2}weakenings: 1 of them is not ruled "allowed" by a reviewer on another model:/);
      assert.match(out, line);
      assert.match(out, /node scripts\/receipt\.mjs fingerprints <branch>.*"- <file>: allowed" or "- <file>: refused"/);
      assert.deepEqual(ran(m), [], 'no check ran');
      assert.deepEqual(ghSubs(m), ['view'], 'nothing posted or merged');
      const written = m.events.map((e) => [e.type, e.data.ruling ?? e.data.check]);
      assert.deepEqual(written, ruling === refused ? [['weakening', 'refused'], ['merge-blocked', 'weakenings']] : [['merge-blocked', 'weakenings']], 'only a real refusal is written as a weakening event');
      if (ruling === refused) assert.deepEqual(m.events[0].data, { pr: 7, kind: 'expectation-changed', file: 'apps/web/save.test.ts', reason: 'The API now answers 201 for a new word.', ruling: 'refused', ruledBy: 'gpt-6.1-sol' });
    } finally { m.cleanup(); }
  }
});

test('test protection: a missing sorter or receipt script, a sorter that fails, or models that are not set stop the merge', () => {
  const noSorter = fakeMachine({ ...REASONS() });
  noSorter.ctx.sorterError = 'Cannot find module';
  try {
    assert.equal(merge(noSorter), EXIT.usage);
    assert.match(noSorter.calls.out.join('\n'), /FAIL {2}weakenings: the testReasons flag is on, but scripts\/test-changes\.mjs cannot be loaded: Cannot find module\. Not merged\./);
    assert.deepEqual(ghSubs(noSorter), ['view']);
  } finally { noSorter.cleanup(); }
  const noReceipts = withWeakenings(fakeMachine({ ...REASONS() }), [WEAK_TEST]);
  delete noReceipts.ctx.checkWeakenings;
  try {
    assert.equal(merge(noReceipts), EXIT.usage);
    assert.match(noReceipts.calls.out.join('\n'), /the testReasons flag is on, but scripts\/receipt\.mjs cannot be loaded/);
  } finally { noReceipts.cleanup(); }
  const failing = withWeakenings(fakeMachine({ ...REASONS() }), []);
  failing.ctx.collectWeakenings = () => ({ fail: 'cannot load the language presets: scripts/presets/any.json: no such preset' });
  try {
    assert.equal(merge(failing), EXIT.failed);
    assert.match(failing.calls.out.join('\n'), /FAIL {2}weakenings: cannot load the language presets/);
    assert.deepEqual(ghSubs(failing), ['view']);
  } finally { failing.cleanup(); }
  const noModels = withWeakenings(fakeMachine({ ...REASONS() }), [WEAK_TEST]);
  noModels.ctx.checkWeakenings = () => ({ fail: 'set "models.builder" and "models.headAgent" in scripts/kit.config.json', notes: [] });
  try {
    assert.equal(merge(noModels), EXIT.failed);
    assert.match(noModels.calls.out.join('\n'), /FAIL {2}weakenings: set "models\.builder"/);
  } finally { noModels.cleanup(); }
});

test('test protection: a lead branch that turns the switch off in its own settings still goes through the gate that one time', () => {
  const m = withWeakenings(fakeMachine({ config: { features: { testReasons: false } }, baseConfig: { checks: CHECKS, features: { testReasons: true } }, files: ['scripts/kit.config.json'] }), [noReason({ file: 'scripts/kit.config.json', kind: 'check-removed', what: 'the switch testReasons went from enforce to off: it no longer runs' })]);
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.equal(m.sorted.length, 1, 'the base branch still has the switch on');
    assert.match(m.calls.out.join('\n'), /check-removed {10}scripts\/kit\.config\.json: the switch testReasons went from enforce to off: it no longer runs/);
  } finally { m.cleanup(); }
});

test('test protection with the block log: a refusal is a "blocked" line for check "weakenings", and a pass a "passed" line', () => {
  const stopped = withPrints(withWeakenings(fakeMachine({ ...REASONS({ blockLog: true }), files: ['apps/web/save.test.ts'] }), [noReason(WEAK_TEST)]));
  try {
    assert.equal(merge(stopped), EXIT.failed);
    assert.deepEqual(blockLines(stopped).map((l) => [l.outcome, l.check]), [['blocked', 'weakenings']]);
  } finally { stopped.cleanup(); }
  const passed = withPrints(withWeakenings(fakeMachine({ ...REASONS({ blockLog: true }) }), [WEAK_TEST]));
  try {
    assert.equal(merge(passed), EXIT.ok);
    assert.deepEqual(blockLines(passed).filter((l) => l.check === 'weakenings').map((l) => l.outcome), ['passed']);
  } finally { passed.cleanup(); }
});

test('formatComment: the risk line sits under the title; the weakenings list comes last', () => {
  const base = { shortSha: 'abc1234', tier: 'code', results: [{ name: 'rules', cached: false, ms: 300 }] };
  assert.doesNotMatch(formatComment(base), /Risk|Weakenings/, 'neither is shown unless asked for');
  assert.equal(formatComment({ ...base, risk: { risk: 'normal', riskPaths: [] } }).split('\n')[1], 'Risk: normal.');
  assert.equal(formatComment({ ...base, risk: { risk: 'high', riskPaths: ['a`b/', 'migrations/'] } }).split('\n')[1], 'Risk: high (touches `"a\\u0060b/"`, `migrations/`).');
  const listed = formatComment({ ...base, protectedTests: [], weakenings: [{ ...WEAK_TEST, to: 'apps/web/save2.test.ts', ruledBy: 'gpt-6.1-sol' }] });
  assert.match(listed, /\nProtected tests changed: none\.\nWeakenings \(1\): [^\n]+\n- expectation-changed: `apps\/web\/save\.test\.ts` to `apps\/web\/save2\.test\.ts`\. Reason: The API now answers 201 for a new word\. Ruled by gpt-6\.1-sol\.$/);
});

// ---------- Review round 2: ways around the gate that a reviewer found ----------

test('#4 test protection: the sorter is handed what the base branch and the branch protect, taken together', () => {
  const base = { checks: CHECKS, features: { testReasons: true }, models: MODELS_SET, testPaths: ['.test.', 'specimens/'], checkSettingsPaths: ['pyproject.toml'], snapshotPaths: ['goldens/'], presets: ['python'] };
  const own = { features: { testReasons: true }, models: MODELS_SET, testPaths: ['e2e/'], checkSettingsPaths: ['deno.json'], snapshotPaths: [], presets: ['rust'] };
  // A lead branch is checked with its own settings, so it could take a file out of protection in the change that edits it.
  const lead = withWeakenings(fakeMachine({ config: own, baseConfig: base, files: ['scripts/kit.config.json'] }), []);
  try {
    assert.equal(merge(lead), EXIT.ok);
    const asked = lead.sorted[0];
    assert.equal(asked.isTest('specimens/sample.txt'), true, 'a test path only the base branch still lists');
    assert.equal(asked.isTest('src/save.test.ts'), true);
    assert.equal(asked.isTest('e2e/login.ts'), true, 'a test path only the branch lists');
    assert.equal(asked.isTest('src/save.ts'), false);
    assert.deepEqual([asked.extraSettingsFiles, asked.snapshotPaths, asked.presetNames], [['deno.json', 'pyproject.toml'], ['goldens/'], ['rust', 'python']]);
    assert.equal(typeof asked.readSettings, 'function');
  } finally { lead.cleanup(); }
  const build = withWeakenings(fakeMachine({ config: own, baseConfig: base, branch: 'build/003-save-word', files: ['src/app.ts'] }), []);
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), build.ctx), EXIT.ok);
    const asked = build.sorted[0];
    assert.deepEqual([asked.extraSettingsFiles, asked.snapshotPaths, asked.presetNames], [['pyproject.toml'], ['goldens/'], ['python']], 'a build branch gets the base branch\'s lists only');
    assert.equal(asked.isTest('e2e/login.ts'), false);
  } finally { build.cleanup(); }
});

test('#5 test protection: a ruling is judged by the base branch\'s models as well as the branch\'s own', () => {
  const changed = { builder: 'codex/gpt-6.1-sol', headAgent: ['codex/gpt-6.1-sol'], reviewer: 'claude/claude-opus-5-5' };
  const m = withWeakenings(fakeMachine({ config: { features: { testReasons: true, reviewReceipts: true }, models: changed, paperworkPaths: ['docs/', 'src/'], testPaths: [] }, baseConfig: { checks: CHECKS, features: { testReasons: true, reviewReceipts: true }, models: MODELS_SET }, files: ['scripts/kit.config.json'] }), [WEAK_TEST]);
  const receipts = [];
  m.ctx.checkReceipts = (args) => {
    receipts.push(args);
    return { uncovered: [], covered: 1, notes: [] };
  };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(m.ruled[0].models, [changed, MODELS_SET], 'so the model that was the builder until this change cannot rule on it');
    assert.deepEqual(receipts[0].models, [changed, MODELS_SET], 'the receipt gate too');
    assert.equal(receipts[0].isPaperwork('src/app.ts'), false, 'a folder the branch just called docs still needs a review in this merge');
    assert.equal(receipts[0].isPaperwork('docs/a.md'), true);
    assert.deepEqual(receipts[0].protectedTests('M\0src/a.test.ts\0'), [{ file: 'src/a.test.ts', change: 'modified' }], 'a test path the branch just dropped is still protected in this merge');
  } finally { m.cleanup(); }
});

test('#8 retry cap: a branch parked for one check still gets an ask when another check fails three times', () => {
  const b = 'build/003-save-word';
  const parked = { type: 'slice-parked', branch: b, data: { check: 'lint', ask: 'a1' } };
  assert.deepEqual(failStreak([run(b, 'lint', false), run(b, 'lint', false), run(b, 'lint', false), parked, run(b, 'test', false), run(b, 'test', false), run(b, 'test', false)], b, 'test'), { fails: 3, parked: false });
  const m = withEvents(fakeMachine({ ...EVENTS(), branch: b, files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  const check = () => checkOnly(parseArgs(['--check']), m.ctx);
  try {
    for (let i = 0; i < 3; i++) assert.equal(check(), EXIT.failed);
    assert.deepEqual(m.asks.map((a) => a.why.match(/"(\w+)"/)[1]), ['lint']);
    m.state.codes = { test: 1 };
    for (let i = 0; i < 3; i++) assert.equal(check(), EXIT.failed);
    assert.deepEqual(m.asks.map((a) => a.why.match(/"(\w+)"/)[1]), ['lint', 'test'], 'lint was fixed; the test check now fails three times and gets its own ask');
    assert.deepEqual(m.events.filter((e) => e.type === 'slice-parked').map((e) => e.data.check), ['lint', 'test']);
  } finally { m.cleanup(); }
});

test('#12 events: a lead branch that turns the events switch off is still recorded through that merge', () => {
  const m = withEvents(fakeMachine({ config: { features: { events: false } }, baseConfig: { checks: CHECKS, features: { events: true } }, files: ['scripts/kit.config.json'], numstat: '1\t1\tscripts/kit.config.json\n', nameStatus: z('M', 'scripts/kit.config.json') }));
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual([...new Set(types(m))], ['check-run', 'merged']);
  } finally { m.cleanup(); }
});

// ---------- Review round 3: the commits a branch brings in ----------

const INCOMING = (extra = {}) => ({ config: { features: { incomingCommits: true, ...extra } }, baseConfig: { checks: CHECKS, features: { incomingCommits: true, ...extra } } });
const SHA = (letter) => letter.repeat(40);
const GOOD = [{ sha: SHA('a'), message: 'feat: add the save button\n' }, { sha: SHA('b'), message: 'docs: say how to save\n\nMore words.\n' }];
// Gives a fake machine the kit's real commit message check.
function withMessageCheck(m) {
  m.ctx.checkMessage = checkMessage;
  m.ctx.branchSlice = branchSlice;
  return m;
}
const SCAN4 = (config) => ['git', '--log-opts=--diff-merges=first-parent origin/main..HEAD', '--redact', '--no-banner', '--no-color', '--verbose', '--ignore-gitleaks-allow', '--config', config];

test('incoming commits: flag off, the commits are never read and no secret scan runs', () => {
  const m = withMessageCheck(fakeMachine({ gitleaksToml: true, files: ['apps/mobile/save.ts'] }));
  try {
    assert.equal(merge(m), EXIT.ok, 'the fake git throws if the commits are listed');
    assert.equal(ran(m).includes('incoming commits'), false);
  } finally { m.cleanup(); }
});

test('incoming commits: a message that would not pass the commit hook stops the merge, in the docs-only tier too, before any other check', () => {
  const commits = [
    { sha: SHA('c'), message: 'wip stuff\n' },
    { sha: SHA('d'), message: 'fix: stop the crash\n' },
    { sha: SHA('e'), message: 'fix: stop the other crash\n\nFixes: 1234567\n' },
    ...GOOD,
  ];
  const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits, gitleaksToml: true }));
  try {
    assert.equal(merge(m), EXIT.failed);
    const out = m.calls.out.join('\n');
    assert.match(out, /FAIL {2}incoming commits: 3 commit messages on this branch would not pass the commit message check \(scripts\/commit-msg\.mjs\):/);
    assert.match(out, /\n {2}ccccccc "wip stuff": The first line must look like "type: description"/);
    assert.match(out, /\n {2}ddddddd "fix: stop the crash": A "fix" commit needs a "Fixes:" line/);
    assert.match(out, /\n {2}eeeeeee "fix: stop the other crash": "Fixes: 1234567" names a commit that is not in this repo/);
    assert.match(out, /Reword each one \(the newest with "git commit --amend", an older one with a rebase\), push, and run this again\./);
    assert.deepEqual(ran(m), [], 'no secret scan and no other check ran');
    assert.deepEqual(ghSubs(m), ['view'], 'nothing posted or merged');
    m.state.known = ['1234567'];
    m.state.commits = commits.slice(2);
    assert.equal(merge(m), EXIT.ok, 'a Fixes line that names a real commit is fine');
  } finally { m.cleanup(); }
});

test('incoming commits: a leftover fixup!, squash!, or amend! commit is refused with a line that says to squash it first', () => {
  for (const word of ['fixup', 'squash', 'amend']) {
    const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits: [{ sha: SHA('f'), message: `${word}! this is not a fixup\n` }, ...GOOD] }));
    try {
      assert.equal(merge(m), EXIT.failed, word);
      assert.match(m.calls.out.join('\n'), new RegExp(`\\n {2}fffffff "${word}! this is not a fixup": a ${word}! commit is still here\\. Squash it into the commit it belongs to first \\(git rebase --autosquash origin/main\\), or give it a real message\\.`));
    } finally { m.cleanup(); }
  }
});

test('incoming commits: on a build branch a Slice line must match the branch; a missing one is not added and not an error', () => {
  const pr = { number: 7, state: 'OPEN', isDraft: false, headRefName: 'build/003-save-word', baseRefName: 'main' };
  const wrong = withMessageCheck(fakeMachine({ ...INCOMING(), pr, commits: [{ sha: SHA('a'), message: 'feat: add the save button\n\nSlice: 004\n' }] }));
  try {
    assert.equal(merge(wrong), EXIT.failed);
    assert.match(wrong.calls.out.join('\n'), /This branch is for slice 003, but the message says "Slice: 004"/);
  } finally { wrong.cleanup(); }
  const none = withMessageCheck(fakeMachine({ ...INCOMING(), pr, commits: [{ sha: SHA('a'), message: 'feat: add the save button\n\nSlice: 003\n' }, { sha: SHA('b'), message: 'docs: no slice line here\n' }] }));
  try {
    assert.equal(merge(none), EXIT.ok);
  } finally { none.cleanup(); }
});

test('incoming commits: the secret scan runs over exactly the new commits with the kit\'s settings, in the docs-only tier, and its line is posted', () => {
  const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits: GOOD, gitleaksToml: true }));
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['incoming commits', 'rules', 'script tests'], 'first, and also for a docs-only change');
    assert.equal(m.calls.run[0].command, 'gitleaks');
    assert.deepEqual(m.calls.run[0].args, SCAN4('kit-lint/gitleaks.toml'));
    assert.equal(m.calls.run[0].cwd, m.root);
    assert.ok(m.calls.out.some((l) => /^pass {2}incoming commits \(2 commits: messages and secret scan, \d\.\d s\)$/.test(l)));
    assert.match(m.calls.gh.find((c) => c[1] === 'comment')[4], /^Local checks on abc1234[^\n]*\n- incoming commits: pass \(\d\.\d s\)\n- rules: pass/);
  } finally { m.cleanup(); }
});

test('incoming commits: without kit-lint/gitleaks.toml the scan is skipped with one line; the messages are still checked', () => {
  const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits: GOOD }));
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests']);
    assert.ok(m.calls.out.includes('note  incoming commits: no kit-lint/gitleaks.toml in this project, so the secret scan of the new commits is skipped. The project has not taken the kit\'s lint folder yet.'));
    assert.ok(m.calls.out.some((l) => /^pass {2}incoming commits \(2 commits: messages, \d\.\d s\)$/.test(l)));
    m.state.commits = [{ sha: SHA('c'), message: 'wip\n' }];
    m.state.head = 'head2';
    assert.equal(merge(m), EXIT.failed);
  } finally { m.cleanup(); }
});

test('incoming commits: a found secret, a missing gitleaks, and a scan that breaks each stop the merge with their own plain line', () => {
  const run = (code) => {
    const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits: GOOD, gitleaksToml: true, codes: { 'incoming commits': code } }));
    try {
      assert.equal(merge(m), EXIT.failed, String(code));
      assert.deepEqual(ghSubs(m), ['view'], 'nothing posted or merged');
      assert.deepEqual(ran(m), ['incoming commits'], 'no other check ran');
      return m.calls.out.join('\n');
    } finally { m.cleanup(); }
  };
  const found = run(1);
  assert.match(found, /FAIL {2}incoming commits: the secret scan found a secret in the commits on this branch\. The key is in git history even if a later commit removed it, so replace it at the service that issued it\./);
  assert.match(found, /last lines of incoming commits/);
  assert.match(found, /Full output: .*kit-logs\/\d{8}T\d{6}-incoming-commits\.log/);
  assert.match(run(127), /FAIL {2}incoming commits: the secret scan needs gitleaks, and it is not installed\. Install it: brew install gitleaks/);
  assert.match(run(2), /FAIL {2}incoming commits: the secret scan could not run \(gitleaks exit code 2\)\./);
});

test('incoming commits: a pass is remembered by the head commit, never by the files: the same files under a new commit are scanned again', () => {
  const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits: GOOD, gitleaksToml: true }));
  try {
    assert.equal(merge(m), EXIT.ok);
    m.calls.run.length = 0;
    m.calls.git.length = 0;
    assert.equal(merge(m), EXIT.ok);
    assert.equal(ran(m).includes('incoming commits'), false, 'the same head commit: remembered');
    assert.equal(m.calls.git.some((c) => c.startsWith('log --format')), false);
    assert.ok(m.calls.out.includes('pass  incoming commits (cached: these exact commits already passed)'));
    assert.match(m.calls.gh.filter((c) => c[1] === 'comment')[1][4], /- incoming commits: pass \(cached\)/);
    // A secret was added and then removed: the files (the tree) are the same again, the history is not.
    m.calls.run.length = 0;
    m.state.head = 'head-after-add-and-remove';
    m.state.codes = { 'incoming commits': 1 };
    assert.equal(m.state.tree, 'tree1');
    assert.equal(merge(m), EXIT.failed, 'the old pass is not reused');
    assert.deepEqual(ran(m), ['incoming commits']);
    m.calls.run.length = 0;
    m.state.codes = {};
    assert.equal(merge(m, { noCache: true }), EXIT.ok);
    assert.equal(ran(m)[0], 'incoming commits', '--no-cache runs it again');
  } finally { m.cleanup(); }
});

test('incoming commits: --check runs it too, --fast or not; the event log gets its check-run; a missing commit-msg.mjs stops the merge', () => {
  const m = withEvents(withMessageCheck(fakeMachine({ ...INCOMING({ events: true }), branch: 'build/003-save-word', commits: [{ sha: SHA('c'), message: 'wip\n' }], gitleaksToml: true, files: ['apps/mobile/save.ts'] })));
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.failed);
    assert.deepEqual(m.events.map((e) => [e.type, e.data.check, e.data.ok]), [['check-run', 'incoming commits', false]]);
    m.state.commits = GOOD;
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    assert.deepEqual(m.events.slice(1, 2).map((e) => [e.data.check, e.data.ok, e.data.mode]), [['incoming commits', true, 'check']]);
  } finally { m.cleanup(); }
  const missing = fakeMachine({ ...INCOMING(), commits: GOOD });
  missing.ctx.messageCheckError = 'Cannot find module';
  try {
    assert.equal(merge(missing), EXIT.usage);
    assert.match(missing.calls.out.join('\n'), /FAIL {2}incoming commits: the incomingCommits flag is on, but scripts\/commit-msg\.mjs cannot be loaded: Cannot find module\. Not merged\./);
  } finally { missing.cleanup(); }
});

test('incoming commits: a lead branch that turns the switch off is still checked through that merge; a settings check may not take the name', () => {
  const m = withMessageCheck(fakeMachine({ config: { features: { incomingCommits: false } }, baseConfig: { checks: CHECKS, features: { incomingCommits: true } }, commits: [{ sha: SHA('c'), message: 'wip\n' }] }));
  try {
    assert.equal(merge(m), EXIT.failed);
  } finally { m.cleanup(); }
  assert.throws(() => settings({ checks: [{ name: 'incoming commits', run: 'x' }] }), /may not be named/);
});

test('round 3 events: the merged event says whether test protection was in force', () => {
  const on = withEvents(withWeakenings(fakeMachine({ ...REASONS({ events: true }), numstat: NUMSTAT, nameStatus: z('M', 'docs/handoff.md') }), []));
  try {
    assert.equal(merge(on), EXIT.ok);
    assert.equal(on.events.at(-1).data.testReasons, true);
  } finally { on.cleanup(); }
  const off = withEvents(fakeMachine({ ...EVENTS(), numstat: NUMSTAT, nameStatus: z('M', 'docs/handoff.md') }));
  try {
    assert.equal(merge(off), EXIT.ok);
    assert.equal(off.events.at(-1).data.testReasons, false);
  } finally { off.cleanup(); }
});

// ---------- Review round 4 ----------

test('F risk: a branch that takes a folder out of highRiskPaths still gets the high label for touching it', () => {
  const m = fakeMachine({ config: { highRiskPaths: [] }, baseConfig: { checks: CHECKS, highRiskPaths: ['auth/'] }, files: ['auth/login.ts', 'scripts/kit.config.json'] });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.match(m.calls.gh.find((c) => c[1] === 'comment')[4], /\nRisk: high \(touches `auth\/`\)\.\n/);
    assert.ok(m.calls.out.includes('note  risk: high (touches auth/)'));
  } finally { m.cleanup(); }
});

test('F events: a conflict on a branch that turned events off is still written, because the base branch has them on', () => {
  const m = withEvents(fakeMachine({ config: { features: { events: false } }, baseConfig: { checks: CHECKS, features: { events: true } }, mergeCode: 1, conflicted: 'scripts/kit.config.json\n' }));
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.deepEqual(m.events.map((e) => [e.type, e.data.reason]), [['merge-blocked', 'Merging origin/main has conflicts in:']]);
  } finally { m.cleanup(); }
});

test('G incoming commits: the scan also reads what each merge commit changed, and runs when the only new commit is a merge', () => {
  const merges = [{ sha: SHA('d'), parents: 'p1 p2', message: "Merge branch 'main' into lead/notes\n" }];
  const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits: merges, gitleaksToml: true }));
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal(ran(m)[0], 'incoming commits', 'a range with nothing but a merge commit is scanned too');
    assert.deepEqual(m.calls.run[0].args, SCAN4('kit-lint/gitleaks.toml'));
    assert.ok(m.calls.out.some((l) => /^pass {2}incoming commits \(1 commit: messages and secret scan, \d\.\d s\)$/.test(l)));
  } finally { m.cleanup(); }
});

test('H incoming commits: the scan uses the base branch\'s copy of the kit settings, so a branch that deletes or edits its own copy changes nothing', () => {
  const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits: GOOD, baseToml: '[extend]\nuseDefault = true\n' }));
  let seen = null;
  const run = m.ctx.run;
  m.ctx.run = (command, args, options) => {
    if (command === 'gitleaks') seen = { path: args.at(-1), text: readFileSync(args.at(-1), 'utf8') };
    return run(command, args, options);
  };
  try {
    assert.equal(existsSync(join(m.root, 'kit-lint', 'gitleaks.toml')), false, 'the branch has no copy');
    assert.equal(merge(m), EXIT.ok);
    assert.equal(ran(m)[0], 'incoming commits', 'the scan still ran');
    assert.equal(seen.text, '[extend]\nuseDefault = true\n', 'with the base branch\'s settings');
    assert.notEqual(seen.path, 'kit-lint/gitleaks.toml');
    assert.deepEqual(m.calls.run[0].args, SCAN4(seen.path));
    assert.equal(existsSync(seen.path), false, 'the copy is removed afterwards');
    assert.doesNotMatch(m.calls.out.join('\n'), /is skipped/);
  } finally { m.cleanup(); }
  const own = withMessageCheck(fakeMachine({ ...INCOMING(), commits: GOOD, gitleaksToml: true, baseToml: 'base settings\n' }));
  own.ctx.run = (command, args, options) => {
    if (command === 'gitleaks') seen = { text: readFileSync(args.at(-1), 'utf8') };
    return run(command, args, options);
  };
  try {
    assert.equal(merge(own), EXIT.ok);
    assert.equal(seen.text, 'base settings\n', 'the base branch\'s copy wins over the branch\'s own');
  } finally { own.cleanup(); }
});

test('I incoming commits: a .gitleaksignore file on disk stops the scan, tracked or not, even when the same commits passed before', () => {
  const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits: GOOD, gitleaksToml: true }));
  try {
    assert.equal(merge(m), EXIT.ok);
    writeFileSync(join(m.root, '.gitleaksignore'), 'abc123:docs/key.md:github-pat:1\n');
    m.calls.run.length = 0;
    assert.equal(merge(m), EXIT.failed, 'the saved pass is not reused');
    assert.deepEqual(ran(m), [], 'and nothing is scanned with the file there');
    assert.ok(m.calls.out.includes('FAIL  incoming commits: there is a .gitleaksignore file in this folder. It tells the secret scan to keep quiet about what it lists, so the scan does not run while it is there. Delete it (rm .gitleaksignore), then remove and replace any real key it was hiding.'));
  } finally { m.cleanup(); }
});

test('J incoming commits: a saved pass is for one base commit, one head commit, one slice, and one set of scan settings', () => {
  const commits = [{ sha: SHA('a'), message: 'feat: cache the list\n\nSlice: 008\n' }];
  const m = withMessageCheck(fakeMachine({ ...INCOMING(), commits, gitleaksToml: true }));
  const scans = () => ran(m).filter((n) => n === 'incoming commits').length;
  try {
    assert.equal(merge(m), EXIT.ok, 'on a lead branch any slice number will do');
    assert.equal(scans(), 1);
    assert.equal(merge(m), EXIT.ok);
    assert.equal(scans(), 1, 'the same base, head, slice, and settings: remembered');
    m.state.pr = { ...m.state.pr, headRefName: 'build/007-cache' };
    assert.equal(merge(m), EXIT.failed, 'the same head commit on the branch of slice 007 is checked again');
    assert.match(m.calls.out.join('\n'), /This branch is for slice 007, but the message says "Slice: 008"/);
    m.state.pr = { ...m.state.pr, headRefName: 'lead/notes' };
    writeFileSync(join(m.root, 'kit-lint', 'gitleaks.toml'), '[extend]\nuseDefault = false\n');
    assert.equal(merge(m), EXIT.ok);
    assert.equal(scans(), 2, 'other scan settings: scanned again');
    m.state.moves = 1;
    assert.equal(merge(m), EXIT.ok);
    assert.equal(scans(), 3, 'the base branch moved while the checks ran: the first try is remembered, the second is scanned for the new base');
  } finally { m.cleanup(); }
});

test('L incoming commits: a commit with one parent cannot call itself a merge to skip the message check; a real merge may say anything', () => {
  const sneaky = withMessageCheck(fakeMachine({ ...INCOMING(), commits: [{ sha: SHA('c'), message: 'Merge this invalid one-parent commit message\n' }] }));
  try {
    assert.equal(merge(sneaky), EXIT.failed);
    assert.match(sneaky.calls.out.join('\n'), /\n {2}ccccccc "Merge this invalid one-parent commit message": this commit has one parent, so it is not a merge\. Its first line must look like "type: description"\./);
  } finally { sneaky.cleanup(); }
  const real = withMessageCheck(fakeMachine({ ...INCOMING(), commits: [{ sha: SHA('d'), parents: 'p1 p2', message: 'anything at all\n' }, { sha: SHA('e'), message: 'Revert "feat: add the save button"\n\nThis reverts commit abc.\n' }] }));
  try {
    assert.equal(merge(real), EXIT.ok, 'a two-parent commit, and git\'s own revert, pass');
  } finally { real.cleanup(); }
});

test('O test protection: the run says how many test files changed in formatting only', () => {
  const m = withWeakenings(fakeMachine({ ...REASONS(), files: ['src/a.test.ts'] }), []);
  const collect = m.ctx.collectWeakenings;
  m.ctx.collectWeakenings = (args) => ({ ...collect(args), formattingOnly: 300 });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.ok(m.calls.out.includes('note  weakenings: 300 test files changed in formatting only'));
    m.ctx.collectWeakenings = (args) => ({ ...collect(args), formattingOnly: 1 });
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    assert.ok(m.calls.out.includes('note  weakenings: 1 test file changed in formatting only'));
  } finally { m.cleanup(); }
});

test('kit update: the lines the sorter hands back are printed, such as a preset taken from this branch because the base branch\'s is in an older form', () => {
  const m = withWeakenings(fakeMachine({ ...REASONS(), files: ['scripts/presets/typescript.json'] }), []);
  const collect = m.ctx.collectWeakenings;
  m.ctx.collectWeakenings = (args) => ({ ...collect(args), notes: ["the base branch's preset typescript is in an older form; using this branch's"] });
  try {
    assert.equal(merge(m), EXIT.ok, 'the update merges');
    assert.ok(m.calls.out.includes("note  weakenings: the base branch's preset typescript is in an older form; using this branch's"));
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
  } finally { m.cleanup(); }
});

// ---------- End to end: real git repos, a fake gh ----------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A stand-in checker: it supports --root and --branch, and fails when the checked folder holds a
// file named BAD. loadConfig reads plain JSON, so these tests do not depend on the real checker.
const STUB_CHECKER = `// stub rule checker for merge-pr tests. ${API_MARKER}
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function loadConfig(root) {
  const p = join(root, 'scripts', 'kit.config.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}
if (process.argv[1] && process.argv[1].endsWith('check-plans.mjs')) {
  const i = process.argv.indexOf('--root');
  const root = i >= 0 ? process.argv[i + 1] : process.cwd();
  if (existsSync(join(root, 'BAD'))) { console.error('rule broken: a file named BAD'); process.exit(1); }
  console.log('Rule checks passed');
}
`;

const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'view') {
  const pr = JSON.parse(process.env.GH_PR_JSON);
  const fields = args[args.indexOf('--json') + 1];
  console.log(JSON.stringify(fields === 'state' ? { ...pr, state: 'MERGED' } : pr));
}
`;

// Makes a bare "remote", a clone with the script and a stub checker on main, and a fake gh.
function realRepos() {
  const dir = mkdtempSync(join(tmpdir(), 'merge-pr-e2e-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(work, 'scripts'));
  mkdirSync(join(work, 'docs'));
  mkdirSync(join(work, 'src'));
  copyFileSync(SCRIPT, join(work, 'scripts', 'merge-pr.mjs'));
  writeFileSync(join(work, 'scripts', 'check-plans.mjs'), STUB_CHECKER);
  writeFileSync(join(work, 'scripts', 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  // The app check leaves a mark outside the repo, so a test can see whether it ran.
  writeFileSync(join(work, 'scripts', 'kit.config.json'), JSON.stringify({ checks: [{ name: 'app', run: `echo ran >> "${join(dir, 'app-check-ran')}"` }] }));
  writeFileSync(join(work, 'docs', 'handoff.md'), '# Handoff\n');
  writeFileSync(join(work, 'src', 'app.js'), 'export const one = 1;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Start repo');
  git(work, 'push', '-q', 'origin', 'main');
  const ghLog = join(dir, 'gh.log');
  const runScript = (argv, pr) => spawnSync(process.execPath, [join(work, 'scripts', 'merge-pr.mjs'), ...argv], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: ghLog, GH_PR_JSON: JSON.stringify(pr) },
  });
  const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { dir, remote, work, runScript, ghCalls, appCheckRan: () => existsSync(join(dir, 'app-check-ran')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('end to end: a docs-only lead branch gets main merged in, pushed, checked in the paperwork tier, and merged', () => {
  const r = realRepos();
  try {
    git(r.work, 'switch', '-q', '-c', 'lead/handoff');
    writeFileSync(join(r.work, 'docs', 'handoff.md'), '# Handoff\n\nNext: slice 002.\n');
    git(r.work, 'commit', '-q', '-am', 'Update handoff');
    git(r.work, 'push', '-q', 'origin', 'lead/handoff');
    // Meanwhile main moves on: the script must merge it in and push the result.
    git(r.work, 'switch', '-q', 'main');
    writeFileSync(join(r.work, 'src', 'app.js'), 'export const one = 1;\nexport const two = 2;\n');
    git(r.work, 'commit', '-q', '-am', 'Other work lands on main');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', 'lead/handoff');

    const pr = { number: 12, state: 'OPEN', isDraft: false, headRefName: 'lead/handoff', baseRefName: 'main' };
    const out = r.runScript(['12'], pr);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /tier: paperwork/);
    assert.match(out.stdout, /pass {2}rules/);
    assert.match(out.stdout, /pass {2}script tests/);
    assert.equal(r.appCheckRan(), false, 'the app check is skipped for a docs-only change');
    const calls = r.ghCalls();
    assert.deepEqual(calls.map((c) => c[1]), ['view', 'comment', 'merge', 'view']);
    assert.match(calls[1][4], /Docs-only change: app checks skipped \(app\)\./);
    assert.deepEqual(calls[2], ['pr', 'merge', '12', '--merge', '--match-head-commit', git(r.work, 'rev-parse', 'HEAD')]);
    // The remote branch now holds main's newest commit, and is exactly what was checked.
    assert.equal(git(r.remote, 'rev-parse', 'lead/handoff'), git(r.work, 'rev-parse', 'HEAD'));
    git(r.remote, 'merge-base', '--is-ancestor', 'main', 'lead/handoff');
    const logs = join(git(r.work, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'kit-logs');
    assert.ok(existsSync(logs), 'full output is kept in the git folder');
  } finally { r.cleanup(); }
});

test('end to end: a build branch that weakened its own checker still fails by the base branch\'s copy, and is not merged', () => {
  const r = realRepos();
  try {
    git(r.work, 'switch', '-q', '-c', 'build/001-save-word');
    writeFileSync(join(r.work, 'scripts', 'check-plans.mjs'), STUB_CHECKER.replace("process.exit(1);", ''));
    // It also tries to call itself a lead branch and to drop the app check, in its own settings.
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ checks: [], leadPrefixes: ['lead/', 'build/'], paperworkPaths: ['docs/', 'src/', 'scripts/', 'BAD'] }));
    writeFileSync(join(r.work, 'BAD'), 'this breaks a rule\n');
    writeFileSync(join(r.work, 'src', 'app.js'), 'export const one = 11;\n');
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Build, and switch the rule off');
    git(r.work, 'push', '-q', 'origin', 'build/001-save-word');

    const pr = { number: 13, state: 'OPEN', isDraft: false, headRefName: 'build/001-save-word', baseRefName: 'main' };
    const out = r.runScript(['13'], pr);
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /tier: code/);
    assert.match(out.stdout, /FAIL {2}rules/);
    assert.match(out.stdout, /rule broken: a file named BAD/);
    assert.deepEqual(r.ghCalls().map((c) => c[1]), ['view'], 'no comment, no merge');
    assert.equal(r.appCheckRan(), false, 'it stopped at the first failing check');

    // With the rule no longer broken, the same branch passes, the app check runs, and it merges.
    git(r.work, 'rm', '-q', 'BAD');
    git(r.work, 'commit', '-q', '-m', 'Remove BAD');
    git(r.work, 'push', '-q', 'origin', 'build/001-save-word');
    const again = r.runScript(['13'], pr);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(r.appCheckRan(), true, 'the base branch\'s settings still decide the checks');
    assert.match(again.stdout, /tier: code/);
    assert.deepEqual(r.ghCalls().map((c) => c[1]), ['view', 'view', 'comment', 'merge', 'view']);
  } finally { r.cleanup(); }
});

test('end to end: with reviewReceipts on, a code commit with no receipt is refused by name, nothing merges, and the block log holds its fingerprint', () => {
  const r = realRepos();
  try {
    copyFileSync(join(dirname(SCRIPT), 'receipt.mjs'), join(r.work, 'scripts', 'receipt.mjs'));
    // receipt.mjs needs modelOf from the checker; the stub gets a copy of the real rule.
    writeFileSync(join(r.work, 'scripts', 'check-plans.mjs'), `${STUB_CHECKER}export const modelOf = (f) => (String(f).match(/^[a-z0-9-]+\\/([A-Za-z0-9._-]+)$/) || [])[1] ?? null;\n`);
    const models = { builder: 'claude/claude-opus-5-5', headAgent: ['claude/claude-opus-5-5'], reviewer: 'codex/gpt-6.1-sol' };
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ checks: [], features: { reviewReceipts: true, blockLog: true }, models }));
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Turn receipts on');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'build/002-receipts');
    writeFileSync(join(r.work, 'src', 'app.js'), 'export const one = 111;\n');
    git(r.work, 'commit', '-q', '-am', 'Unreviewed change');
    git(r.work, 'push', '-q', 'origin', 'build/002-receipts');

    const pr = { number: 14, state: 'OPEN', isDraft: false, headRefName: 'build/002-receipts', baseRefName: 'main' };
    const out = r.runScript(['14'], pr);
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, new RegExp(`FAIL {2}receipts: 1 commit has no approving review receipt[^\\n]*\\n {2}${git(r.work, 'rev-parse', '--short=7', 'HEAD')} Unreviewed change: `));
    assert.deepEqual(r.ghCalls().map((c) => c[1]), ['view'], 'no comment, no merge');
    const logFile = join(git(r.work, 'rev-parse', '--path-format=absolute', '--git-common-dir'), BLOCK_LOG_FILE);
    const [line] = readFileSync(logFile, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([line.outcome, line.check, line.pr, line.branch], ['blocked', 'receipts', 14, 'build/002-receipts']);
    assert.deepEqual(line.fingerprints.map((f) => f.commit), [git(r.work, 'rev-parse', 'HEAD')]);
    assert.match(line.fingerprints[0].fingerprint, /^[0-9a-f]{40}$/);
  } finally { r.cleanup(); }
});

// A Codex reviewer's session record: it ran the fingerprints command, saw `output`, and replied `text`.
const reviewerRecord = (model, at, output, text) => `${[
  { type: 'turn_context', timestamp: at, payload: { model } },
  { type: 'response_item', timestamp: at, payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'node scripts/receipt.mjs fingerprints' }) } },
  { type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output }) } },
  { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
].map((row) => JSON.stringify(row)).join('\n')}\n`;

test('end to end: test protection with real git, the real sorter, receipts, and event log: no reason, no ruling, the builder\'s own model, then a merge', () => {
  const r = realRepos();
  try {
    const here = dirname(SCRIPT);
    for (const file of ['receipt.mjs', 'test-changes.mjs', 'presets.mjs', 'events.mjs', 'token-ledger.mjs', 'run-file.mjs']) copyFileSync(join(here, file), join(r.work, 'scripts', file));
    cpSync(join(here, 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    // The real scripts import three more names from the checker; the stub gets a stand-in for each.
    writeFileSync(join(r.work, 'scripts', 'check-plans.mjs'), `${STUB_CHECKER}export const modelOf = (f) => (String(f).match(/^[a-z0-9-]+\\/([A-Za-z0-9._-]+)$/) || [])[1] ?? null;\nexport const mergeConfig = (raw) => raw;\nexport const parsePlan = () => ({});\n`);
    const models = { builder: 'claude/claude-opus-5-5', headAgent: ['claude/claude-opus-5-5'], reviewer: 'codex/gpt-6.1-sol' };
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ checks: [], features: { testReasons: true, events: true }, models, presets: ['typescript'] }));
    writeFileSync(join(r.work, 'src', 'price.test.js'), "test('adds tax', () => {\n  expect(price(100)).toEqual(108);\n});\n");
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Turn test protection on');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'build/003-tax');
    writeFileSync(join(r.work, 'src', 'price.test.js'), "test('adds tax', () => {\n  expect(price(100)).toEqual(110);\n});\n");
    git(r.work, 'commit', '-q', '-am', 'Change the tax');
    git(r.work, 'push', '-q', 'origin', 'build/003-tax');
    const pr = { number: 15, state: 'OPEN', isDraft: false, headRefName: 'build/003-tax', baseRefName: 'main' };
    const save = (file, text, message) => {
      mkdirSync(dirname(join(r.work, file)), { recursive: true });
      writeFileSync(join(r.work, file), text);
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', message);
      git(r.work, 'push', '-q', 'origin', 'build/003-tax');
    };
    const receipt = (...args) => spawnSync(process.execPath, [join(r.work, 'scripts', 'receipt.mjs'), ...args], { cwd: r.work, encoding: 'utf8' });
    const review = (name, model, at) => {
      const shown = receipt('fingerprints');
      assert.equal(shown.status, 0, shown.stderr);
      assert.match(shown.stdout, /^kit-weakening [0-9a-f]{12} expectation-changed src\/price\.test\.js$/m);
      const session = join(r.dir, `${name}.jsonl`);
      writeFileSync(session, reviewerRecord(model, at, shown.stdout, 'VERDICT: approve\nREVIEWED: abc1234\nTASK: 003\n\nFINDINGS\nnone\n\nRULINGS\n- src/price.test.js: allowed, the spec says 10 percent now.\n'));
      const made = receipt('make', session);
      assert.equal(made.status, 0, made.stderr);
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', `Receipt from ${name}`);
      git(r.work, 'push', '-q', 'origin', 'build/003-tax');
    };

    const noReason = r.runScript(['15'], pr);
    assert.equal(noReason.status, 1, noReason.stdout + noReason.stderr);
    assert.match(noReason.stdout, /expectation-changed {4}src\/price\.test\.js: 1 line that holds an assertion was removed or changed/);
    assert.match(noReason.stdout, /FAIL {2}weakenings: 1 of them has no reason that will do\. Add one line for each to docs\/weakenings\/build-003-tax\.md[^\n]*\n {2}- src\/price\.test\.js: <why this change is right, in one plain sentence>/);

    save('docs/weakenings/build-003-tax.md', '- src/price.test.js: Tax went from 8 to 10 percent in the spec.\n', 'Reason');
    const noRuling = r.runScript(['15'], pr);
    assert.equal(noRuling.status, 1, noRuling.stdout + noRuling.stderr);
    assert.match(noRuling.stdout, /src\/price\.test\.js: no reviewer has ruled on this exact change and reason/);

    review('builder-model', 'claude-opus-5-5', '2026-11-18T10:00:00.000Z');
    const ownModel = r.runScript(['15'], pr);
    assert.equal(ownModel.status, 1, ownModel.stdout + ownModel.stderr);
    assert.match(ownModel.stdout, /src\/price\.test\.js: the only ruling is by claude-opus-5-5, the model that built the change or a head agent's/);
    assert.deepEqual(r.ghCalls().map((c) => c[1]), ['view', 'view', 'view'], 'three tries, nothing posted or merged');

    review('other-model', 'gpt-6.1-sol', '2026-11-18T11:00:00.000Z');
    const merged = r.runScript(['15'], pr);
    assert.equal(merged.status, 0, merged.stdout + merged.stderr);
    // token-ledger.mjs imports merge-pr.mjs, so this run also proves the script loads the event log without hanging on that loop.
    assert.doesNotMatch(merged.stdout + merged.stderr, /Warning|unsettled/);
    assert.match(merged.stdout, /pass {2}weakenings \(1 ruled "allowed" by a reviewer on another model\)/);
    const calls = r.ghCalls();
    assert.deepEqual(calls.slice(3).map((c) => c[1]), ['view', 'comment', 'merge', 'view']);
    assert.match(calls[4][4], /\nWeakenings \(1\): [^\n]+\n- expectation-changed: `src\/price\.test\.js`\. Reason: Tax went from 8 to 10 percent in the spec\. Ruled by gpt-6\.1-sol\.$/);

    const log = join(git(r.work, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'kit-events.jsonl');
    const events = readFileSync(log, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.every((e) => e.branch === 'build/003-tax' && e.slice === 3), 'every event carries the branch and its slice');
    assert.deepEqual(events.filter((e) => e.type === 'merge-blocked').map((e) => e.data.check), ['weakenings', 'weakenings', 'weakenings']);
    assert.deepEqual(events.filter((e) => e.type === 'weakening').map((e) => e.data), [{ pr: 15, kind: 'expectation-changed', file: 'src/price.test.js', reason: 'Tax went from 8 to 10 percent in the spec.', ruling: 'allowed', ruledBy: 'gpt-6.1-sol' }]);
    const done = events.find((e) => e.type === 'merged').data;
    assert.deepEqual([done.pr, done.tier, done.risk, done.testsAdded], [15, 'code', 'normal', 0]);
    assert.ok(done.files >= 3 && done.added >= 2 && done.removed >= 1, JSON.stringify(done));
    const runs = events.filter((e) => e.type === 'check-run');
    assert.deepEqual([...new Set(runs.map((e) => e.data.check))].sort(), ['rules', 'script tests']);
    assert.ok(runs.every((e) => e.data.ok === true && e.data.mode === 'merge' && e.data.pr === 15 && Number.isFinite(e.data.ms)));
  } finally { r.cleanup(); }
});

test('#10 end to end: a file renamed out of a high-risk folder still gets the high risk label', () => {
  const r = realRepos();
  try {
    mkdirSync(join(r.work, 'auth'));
    writeFileSync(join(r.work, 'auth', 'login.js'), 'export const login = () => true;\nexport const logout = () => true;\n');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ checks: [], highRiskPaths: ['auth/'] }));
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'A high-risk folder');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/move-login');
    git(r.work, 'mv', 'auth/login.js', 'src/login.js');
    git(r.work, 'commit', '-q', '-m', 'Move the sign-in code');
    git(r.work, 'push', '-q', 'origin', 'lead/move-login');
    const out = r.runScript(['16'], { number: 16, state: 'OPEN', isDraft: false, headRefName: 'lead/move-login', baseRefName: 'main' });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /note {2}risk: high \(touches auth\/\)/);
    assert.match(r.ghCalls().find((c) => c[1] === 'comment')[4], /\nRisk: high \(touches `auth\/`\)\.\n/);
  } finally { r.cleanup(); }
});

test('#4 #9 #12 end to end: a lead branch that stops protecting a test and a settings file, and turns events off, still needs a ruling on each, and the reviewer sees them from any folder', () => {
  const r = realRepos();
  try {
    const here = dirname(SCRIPT);
    for (const file of ['receipt.mjs', 'test-changes.mjs', 'presets.mjs', 'events.mjs', 'token-ledger.mjs', 'run-file.mjs']) copyFileSync(join(here, file), join(r.work, 'scripts', file));
    cpSync(join(here, 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    writeFileSync(join(r.work, 'scripts', 'check-plans.mjs'), `${STUB_CHECKER}export const modelOf = (f) => (String(f).match(/^[a-z0-9-]+\\/([A-Za-z0-9._-]+)$/) || [])[1] ?? null;\nexport const mergeConfig = (raw) => raw;\nexport const parsePlan = () => ({});\n`);
    const models = { builder: 'claude/claude-opus-5-5', headAgent: ['claude/claude-opus-5-5'], reviewer: 'codex/gpt-6.1-sol' };
    const settingsOnMain = { checks: [], features: { testReasons: true, events: true }, models, presets: ['typescript'], testPaths: ['.test.'], checkSettingsPaths: ['pyproject.toml'] };
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify(settingsOnMain));
    writeFileSync(join(r.work, 'src', 'price.test.js'), "test('adds tax', () => {\n  expect(price(100)).toEqual(108);\n});\n");
    writeFileSync(join(r.work, 'pyproject.toml'), '[tool.ruff]\nselect = ["E", "F"]\n');
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Test protection on, with a settings file of the project\'s own');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/loosen');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ ...settingsOnMain, features: { testReasons: true, events: false }, testPaths: [], checkSettingsPaths: [] }));
    writeFileSync(join(r.work, 'src', 'price.test.js'), "test('adds tax', () => {\n  expect(price(100)).toEqual(110);\n});\n");
    writeFileSync(join(r.work, 'pyproject.toml'), '[tool.ruff]\nselect = ["E"]\n');
    git(r.work, 'commit', '-q', '-am', 'Stop protecting two files, and edit both');
    git(r.work, 'push', '-q', 'origin', 'lead/loosen');
    const pr = { number: 17, state: 'OPEN', isDraft: false, headRefName: 'lead/loosen', baseRefName: 'main' };
    const three = /check-settings-changed pyproject\.toml[\s\S]*check-removed scripts\/kit\.config\.json[\s\S]*expectation-changed src\/price\.test\.js/;

    const blocked = r.runScript(['17'], pr);
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout.replace(/ +/g, ' '), three);
    assert.match(blocked.stdout, /"\.test\." was taken out of "testPaths"; "pyproject\.toml" was taken out of "checkSettingsPaths"; the switch events went from enforce to off: it no longer runs/);
    assert.match(blocked.stdout, /FAIL {2}weakenings: 3 of them have no reason that will do/);

    // The reviewer runs the command from main's folder, naming the branch: the same three are listed.
    git(r.work, 'switch', '-q', 'main');
    const receipt = (...args) => spawnSync(process.execPath, [join(r.work, 'scripts', 'receipt.mjs'), ...args], { cwd: r.work, encoding: 'utf8' });
    const early = receipt('fingerprints', 'lead/loosen');
    assert.equal(early.status, 0, early.stderr);
    for (const file of ['pyproject.toml', 'scripts/kit.config.json', 'src/price.test.js']) assert.match(early.stdout, new RegExp(`^not ready: ${file.replace(/[./]/g, '\\$&')} `, 'm'));

    git(r.work, 'switch', '-q', 'lead/loosen');
    mkdirSync(join(r.work, 'docs', 'weakenings'), { recursive: true });
    writeFileSync(join(r.work, 'docs', 'weakenings', 'lead-loosen.md'), '- pyproject.toml: Rule F moves to Pyrefly, which now checks names.\n- scripts/kit.config.json: The two lists move into the presets next slice.\n- src/price.test.js: Tax went from 8 to 10 percent in the spec.\n');
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Reasons');
    git(r.work, 'push', '-q', 'origin', 'lead/loosen');
    git(r.work, 'switch', '-q', 'main');
    const shown = receipt('fingerprints', 'lead/loosen');
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.stdout.match(/^kit-weakening [0-9a-f]{12} /gm).length, 3, shown.stdout);
    git(r.work, 'switch', '-q', 'lead/loosen');
    const session = join(r.dir, 'reviewer.jsonl');
    writeFileSync(session, reviewerRecord('gpt-6.1-sol', '2026-11-18T11:00:00.000Z', shown.stdout, 'VERDICT: approve\nREVIEWED: abc1234\nTASK: loosen\n\nRULINGS\n- pyproject.toml: allowed\n- scripts/kit.config.json: allowed\n- src/price.test.js: allowed\n'));
    assert.equal(receipt('make', session).status, 0);
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Receipt');
    git(r.work, 'push', '-q', 'origin', 'lead/loosen');

    const merged = r.runScript(['17'], pr);
    assert.equal(merged.status, 0, merged.stdout + merged.stderr);
    assert.match(merged.stdout, /pass {2}weakenings \(3 ruled "allowed" by a reviewer on another model\)/);
    // The branch turned events off, yet the base branch's switch holds for this one merge.
    const log = join(git(r.work, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'kit-events.jsonl');
    const events = readFileSync(log, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(events.filter((e) => e.type === 'weakening').map((e) => [e.data.kind, e.data.file, e.data.ruling]), [['check-settings-changed', 'pyproject.toml', 'allowed'], ['check-removed', 'scripts/kit.config.json', 'allowed'], ['expectation-changed', 'src/price.test.js', 'allowed']]);
    assert.equal(events.filter((e) => e.type === 'merged').length, 1);
    assert.deepEqual(events.filter((e) => e.type === 'merge-blocked').map((e) => e.data.check), ['weakenings']);
  } finally { r.cleanup(); }
});

test('end to end, incoming commits: a docs-only branch is scanned by its commits, so a secret added and then removed is still found, and a bad message is refused', () => {
  const r = realRepos();
  try {
    copyFileSync(join(dirname(SCRIPT), 'commit-msg.mjs'), join(r.work, 'scripts', 'commit-msg.mjs'));
    // A stand-in for gitleaks: it reads the same commit range and "finds" one marker word. The real
    // scan command is tried by hand against the real tool; here the point is which commits it is given.
    const scans = join(r.dir, 'gitleaks.log');
    writeFileSync(join(r.dir, 'bin', 'gitleaks'), `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(scans)}, JSON.stringify(args) + '\\n');
const opts = args.find((a) => a.startsWith('--log-opts=')).slice('--log-opts='.length).split(' ');
if (execFileSync('git', ['log', '-p', ...opts], { encoding: 'utf8' }).includes('KIT-FAKE-KEY')) { console.log('File: docs/handoff.md'); process.exit(1); }
`);
    chmodSync(join(r.dir, 'bin', 'gitleaks'), 0o755);
    mkdirSync(join(r.work, 'kit-lint'));
    writeFileSync(join(r.work, 'kit-lint', 'gitleaks.toml'), '[extend]\nuseDefault = true\n');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ checks: [], features: { incomingCommits: true } }));
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'chore: turn the incoming commits check on');
    git(r.work, 'push', '-q', 'origin', 'main');
    const say = (text, message) => {
      writeFileSync(join(r.work, 'docs', 'handoff.md'), text);
      git(r.work, 'commit', '-q', '-am', message);
    };
    const pr = (head) => ({ number: 18, state: 'OPEN', isDraft: false, headRefName: head, baseRefName: 'main' });

    git(r.work, 'switch', '-q', '-c', 'lead/handoff');
    say('# Handoff\n\nNext: slice 002.\n', 'docs: say what is next');
    git(r.work, 'push', '-q', 'origin', 'lead/handoff');
    const clean = r.runScript(['18'], pr('lead/handoff'));
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /tier: paperwork/);
    assert.match(clean.stdout, /pass {2}incoming commits \(1 commit: messages and secret scan, /);
    const given = JSON.parse(readFileSync(scans, 'utf8').trim());
    assert.deepEqual(given.slice(0, -1), ['git', '--log-opts=--diff-merges=first-parent origin/main..HEAD', '--redact', '--no-banner', '--no-color', '--verbose', '--ignore-gitleaks-allow', '--config']);
    assert.match(given.at(-1), /kit-trusted-gitleaks-.*gitleaks\.toml$/, 'the settings are the base branch\'s copy, in a temp file');
    const tree = git(r.work, 'rev-parse', 'HEAD^{tree}');

    say('# Handoff\n\nNext: slice 002.\nkey: KIT-FAKE-KEY\n', 'docs: note the key');
    say('# Handoff\n\nNext: slice 002.\n', 'docs: take the key out again');
    git(r.work, 'push', '-q', 'origin', 'lead/handoff');
    assert.equal(git(r.work, 'rev-parse', 'HEAD^{tree}'), tree, 'the files are exactly what passed a moment ago');
    const leaked = r.runScript(['18'], pr('lead/handoff'));
    assert.equal(leaked.status, 1, leaked.stdout + leaked.stderr);
    assert.match(leaked.stdout, /FAIL {2}incoming commits: the secret scan found a secret in the commits on this branch\. The key is in git history even if a later commit removed it, so replace it at the service that issued it\.\nFile: docs\/handoff\.md/);
    assert.deepEqual(r.ghCalls().map((c) => c[1]), ['view', 'comment', 'merge', 'view', 'view'], 'the second try posts and merges nothing');

    git(r.work, 'switch', '-q', '-c', 'lead/messages', 'origin/main');
    say('# Handoff\n\nA.\n', 'wip');
    say('# Handoff\n\nB.\n', 'fixup! this is not a fixup');
    say('# Handoff\n\nC.\n', 'docs: a good message');
    git(r.work, 'push', '-q', 'origin', 'lead/messages');
    const worded = r.runScript(['18'], pr('lead/messages'));
    assert.equal(worded.status, 1, worded.stdout + worded.stderr);
    assert.match(worded.stdout, /FAIL {2}incoming commits: 2 commit messages on this branch would not pass the commit message check/);
    assert.match(worded.stdout, /"fixup! this is not a fixup": a fixup! commit is still here\. Squash it into the commit it belongs to first/);
    assert.match(worded.stdout, /"wip": The first line must look like "type: description"/);
    assert.doesNotMatch(worded.stdout, /a good message/);
  } finally { r.cleanup(); }
});

test('G H I end to end: a key added only in a merge commit is found; the base branch\'s scan settings are used after the branch deletes its own; a hidden .gitleaksignore stops the scan', () => {
  const r = realRepos();
  try {
    copyFileSync(join(dirname(SCRIPT), 'commit-msg.mjs'), join(r.work, 'scripts', 'commit-msg.mjs'));
    // The stand-in for gitleaks again: it reads the commits the way gitleaks does (git log -p with
    // the given options) and "finds" one marker word. It also writes down the settings it was given.
    const scans = join(r.dir, 'gitleaks.log');
    writeFileSync(join(r.dir, 'bin', 'gitleaks'), `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(scans)}, JSON.stringify(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8')) + '\\n');
const opts = args.find((a) => a.startsWith('--log-opts=')).slice('--log-opts='.length).split(' ');
if (execFileSync('git', ['log', '-p', ...opts], { encoding: 'utf8' }).includes('KIT-FAKE-KEY')) { console.log('found the marker'); process.exit(1); }
`);
    chmodSync(join(r.dir, 'bin', 'gitleaks'), 0o755);
    mkdirSync(join(r.work, 'kit-lint'));
    writeFileSync(join(r.work, 'kit-lint', 'gitleaks.toml'), '# the settings on main\n');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ checks: [], features: { incomingCommits: true } }));
    writeFileSync(join(r.work, 'docs', 'handoff.md'), '# Handoff\n\nline one\nline two\n');
    writeFileSync(join(r.work, 'docs', 'other.md'), 'other\n');
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'chore: turn the incoming commits check on');
    git(r.work, 'push', '-q', 'origin', 'main');
    const pr = (head) => ({ number: 19, state: 'OPEN', isDraft: false, headRefName: head, baseRefName: 'main' });
    const onMain = (file, text, message) => {
      git(r.work, 'switch', '-q', 'main');
      writeFileSync(join(r.work, file), text);
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', message);
      git(r.work, 'push', '-q', 'origin', 'main');
    };
    const found = /FAIL {2}incoming commits: the secret scan found a secret in the commits on this branch\./;

    // 1. A conflict fixed by hand, with a key typed into the fix. No ordinary commit holds it.
    git(r.work, 'switch', '-q', '-c', 'lead/conflict');
    writeFileSync(join(r.work, 'docs', 'handoff.md'), '# Handoff\n\nline one, by the branch\nline two\n');
    git(r.work, 'commit', '-q', '-am', 'docs: the branch says it its way');
    onMain('docs/handoff.md', '# Handoff\n\nline one, by main\nline two\n', 'docs: main says it another way');
    git(r.work, 'switch', '-q', 'lead/conflict');
    assert.notEqual(spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd: r.work }).status, 0, 'the two edits clash');
    writeFileSync(join(r.work, 'docs', 'handoff.md'), '# Handoff\n\nline one, by both\nkey: KIT-FAKE-KEY\nline two\n');
    git(r.work, 'commit', '-q', '-am', 'Merge main, fixing the clash by hand');
    git(r.work, 'push', '-q', 'origin', 'lead/conflict');
    assert.doesNotMatch(git(r.work, 'log', '-p', 'origin/main..HEAD'), /KIT-FAKE-KEY/, 'a plain look at the commits does not show the key');
    const fixed = r.runScript(['19'], pr('lead/conflict'));
    assert.equal(fixed.status, 1, fixed.stdout + fixed.stderr);
    assert.match(fixed.stdout, found);

    // 2. An "evil merge": git merged cleanly, and a key was slipped into the merge commit.
    git(r.work, 'switch', '-q', '-c', 'lead/evil', 'origin/main');
    writeFileSync(join(r.work, 'docs', 'other.md'), 'other, by the branch\n');
    git(r.work, 'commit', '-q', '-am', 'docs: the branch edits another file');
    onMain('docs/third.md', 'third\n', 'docs: main adds a file');
    git(r.work, 'switch', '-q', 'lead/evil');
    git(r.work, 'merge', '-q', '--no-commit', '--no-ff', 'origin/main');
    writeFileSync(join(r.work, 'docs', 'slipped.md'), 'key: KIT-FAKE-KEY\n');
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Merge main');
    git(r.work, 'push', '-q', 'origin', 'lead/evil');
    const evil = r.runScript(['19'], pr('lead/evil'));
    assert.equal(evil.status, 1, evil.stdout + evil.stderr);
    assert.match(evil.stdout, found);

    // 3. The branch deletes the scan settings and adds a key in an ordinary commit.
    git(r.work, 'switch', '-q', '-c', 'lead/no-settings', 'origin/main');
    git(r.work, 'rm', '-q', 'kit-lint/gitleaks.toml');
    writeFileSync(join(r.work, 'docs', 'other.md'), 'key: KIT-FAKE-KEY\n');
    git(r.work, 'commit', '-q', '-am', 'docs: drop the scan settings and add a key');
    git(r.work, 'push', '-q', 'origin', 'lead/no-settings');
    const dropped = r.runScript(['19'], pr('lead/no-settings'));
    assert.equal(dropped.status, 1, dropped.stdout + dropped.stderr);
    assert.match(dropped.stdout, found);
    assert.doesNotMatch(dropped.stdout, /is skipped/);
    assert.equal(JSON.parse(readFileSync(scans, 'utf8').trim().split('\n').at(-1)), '# the settings on main\n', 'scanned with main\'s settings');

    // 4. A clean branch, and a .gitleaksignore that git does not even list.
    git(r.work, 'switch', '-q', '-c', 'lead/clean', 'origin/main');
    writeFileSync(join(r.work, 'docs', 'other.md'), 'other, said better\n');
    git(r.work, 'commit', '-q', '-am', 'docs: say it better');
    git(r.work, 'push', '-q', 'origin', 'lead/clean');
    const before = readFileSync(scans, 'utf8');
    writeFileSync(join(git(r.work, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'exclude'), '.gitleaksignore\n');
    writeFileSync(join(r.work, '.gitleaksignore'), 'anything\n');
    assert.equal(git(r.work, 'status', '--porcelain'), '', 'git shows nothing unsaved');
    const hidden = r.runScript(['19'], pr('lead/clean'));
    assert.equal(hidden.status, 1, hidden.stdout + hidden.stderr);
    assert.match(hidden.stdout, /FAIL {2}incoming commits: there is a \.gitleaksignore file in this folder\./);
    assert.equal(readFileSync(scans, 'utf8'), before, 'no scan ran with the file there');
    rmSync(join(r.work, '.gitleaksignore'));
    const clean = r.runScript(['19'], pr('lead/clean'));
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  } finally { r.cleanup(); }
});

test('end to end: wrong usage prints the usage and exits with 2', () => {
  const out = spawnSync(process.execPath, [SCRIPT, '--fast'], { encoding: 'utf8' });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /Usage:/);
});

// ---------- Kit 5.1: modes (off, observe, enforce) ----------

// The same switches in this folder's settings and on the base branch.
const ON = (features, extra = {}) => ({ config: { features, models: MODELS_SET, ...extra }, baseConfig: { checks: CHECKS, features, models: MODELS_SET, ...extra } });
// A change to one code file, with what the `merged` event reads about it.
const ONE_FILE = { files: ['src/app.ts'], numstat: '1\t0\tsrc/app.ts\n', nameStatus: z('M', 'src/app.ts') };
const wouldBlock = (m) => m.events.filter((e) => e.type === 'would-block').map((e) => e.data);
const printed = (m) => m.calls.out.join('\n');
const mergedData = (m) => m.events.find((e) => e.type === 'merged')?.data;
const comment = (m) => m.calls.gh.find((c) => c[1] === 'comment')?.[4];

test('modes: a features value is true, false, or a mode word; settings keeps a run flag and a mode for each switch', () => {
  assert.deepEqual(MODES, ['off', 'observe', 'enforce']);
  assert.deepEqual([true, false, undefined, 'off', 'observe', 'enforce'].map(modeOf), ['enforce', 'off', 'off', 'off', 'observe', 'enforce']);
  for (const bad of ['on', 'Observe', 1, null, 'true']) assert.equal(modeOf(bad), null, String(bad));
  const s = settings({ features: { reviewReceipts: 'observe', testReasons: 'enforce', events: true, blockLog: 'off', protectedTests: false } });
  assert.deepEqual([s.modes.reviewReceipts, s.modes.testReasons, s.modes.events, s.modes.blockLog, s.modes.protectedTests, s.modes.findingAnswers], ['observe', 'enforce', 'enforce', 'off', 'off', 'off']);
  assert.deepEqual([s.features.reviewReceipts, s.features.testReasons, s.features.events, s.features.blockLog, s.features.protectedTests, s.features.findingAnswers], [true, true, true, false, false, false], 'a gate on observe runs, so its flag is true');
  assert.deepEqual(Object.keys(s.modes), FEATURES);
  assert.throws(() => settings({ features: { reviewReceipts: 'watch' } }), /"features\.reviewReceipts" must be true or false, or one of the words "off", "observe", "enforce"/);
});

test('modes: "observe" is refused, with a plain reason, for the four switches that cannot watch', () => {
  const cannot = ['events', 'mergeLock', 'blockLog', 'claimCheck'];
  assert.deepEqual(FEATURES.filter((name) => !WATCHERS.includes(name)).sort(), [...cannot].sort());
  for (const name of cannot) {
    assert.throws(() => settings({ features: { [name]: 'observe' } }), new RegExp(`"features\\.${name}" cannot be "observe": ${name} does not stop a merge`), name);
    assert.equal(settings({ features: { [name]: 'enforce' } }).features[name], true, `${name} takes "enforce"`);
    assert.equal(settings({ features: { [name]: 'off' } }).features[name], false, `${name} takes "off"`);
  }
  for (const name of WATCHERS) assert.equal(settings({ features: { [name]: 'observe' } }).modes[name], 'observe', name);
});

test('modes: the mode used is the stricter of the base branch\'s and the branch\'s, for every switch that can watch', () => {
  assert.equal(stricter('off', 'observe'), 'observe');
  assert.equal(stricter('enforce', 'observe'), 'enforce');
  assert.equal(stricter('off', 'off'), 'off');
  for (const name of WATCHERS) {
    for (const [mine, bases, want] of [['off', 'off', 'off'], ['off', 'observe', 'observe'], ['observe', 'off', 'observe'], ['observe', 'enforce', 'enforce'], ['enforce', 'observe', 'enforce'], ['off', 'enforce', 'enforce'], [false, true, 'enforce']]) {
      const scope = guardScope(settings({ features: { [name]: mine } }), settings({ features: { [name]: bases } }));
      assert.equal(scope.modes[name], want, `${name}: ${mine} here, ${bases} on the base`);
    }
  }
  assert.deepEqual(Object.keys(guardScope(settings({})).modes), WATCHERS);
});

test('modes: a lead branch that moves a gate from enforce to observe, or turns it off, is still stopped by the base branch\'s mode', () => {
  for (const mine of ['observe', 'off']) {
    const m = fakeMachine({ config: { features: { reviewReceipts: mine } }, baseConfig: { checks: CHECKS, features: { reviewReceipts: 'enforce' } }, ...ONE_FILE });
    m.ctx.checkReceipts = () => ({ uncovered: UNCOVERED, covered: 0, notes: [] });
    try {
      assert.equal(merge(m), EXIT.failed, mine);
      assert.match(printed(m), /^FAIL {2}receipts: 1 commit has no approving review receipt/m);
      assert.doesNotMatch(printed(m), /watching only/);
    } finally { m.cleanup(); }
  }
  // The same for the two older gates that used to read the branch's own switch alone.
  const numbers = fakeMachine({ config: { features: { duplicateNumbers: false } }, baseConfig: { checks: CHECKS, features: { duplicateNumbers: true } }, tracked: CLASH });
  try {
    assert.equal(merge(numbers), EXIT.failed);
    assert.match(printed(numbers), /FAIL {2}numbers/);
  } finally { numbers.cleanup(); }
  const tests = fakeMachine({ config: { features: { protectedTests: false } }, baseConfig: { checks: CHECKS, features: { protectedTests: true } }, files: ['src/app.ts'], nameStatus: EDITED });
  try {
    assert.equal(merge(tests), EXIT.ok);
    assert.match(printed(tests), /note {2}protected tests: 2 existing test files changed/);
  } finally { tests.cleanup(); }
});

test('modes, observe: a gate that would stop the merge prints one "watching only" line, writes would-block, and the merge goes on', () => {
  const m = withEvents(fakeMachine({ ...ON({ events: true, reviewReceipts: 'observe' }), ...ONE_FILE }));
  m.ctx.checkReceipts = () => ({ uncovered: UNCOVERED, covered: 0, notes: [] });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.match(printed(m), /^watching only: reviewReceipts would have stopped this merge: receipts: 1 commit has no approving review receipt[^\n]*\n {2}c0ffee1 Change app: no approving receipt/m);
    assert.deepEqual(wouldBlock(m), [{ gate: 'reviewReceipts', pr: 7, reason: "receipts: 1 commit has no approving review receipt from a model other than the builder's and the head agent's:" }]);
    assert.equal(types(m).includes('merge-blocked'), false, 'watching is not blocking');
    assert.equal(types(m).at(-1), 'merged');
    assert.deepEqual(ghSubs(m).slice(-2), ['merge', 'view']);
    assert.match(comment(m), /Watching only \(1\): these gates are set to "observe"\. Each would have stopped this merge\.\n- reviewReceipts: receipts: 1 commit has no approving review receipt/);
  } finally { m.cleanup(); }
  // The same story with the switch on enforce stops, and writes no would-block.
  const strict = withEvents(fakeMachine({ ...ON({ events: true, reviewReceipts: 'enforce' }), ...ONE_FILE }));
  strict.ctx.checkReceipts = () => ({ uncovered: UNCOVERED, covered: 0, notes: [] });
  try {
    assert.equal(merge(strict), EXIT.failed);
    assert.deepEqual(wouldBlock(strict), []);
    assert.deepEqual(types(strict), ['merge-blocked']);
  } finally { strict.cleanup(); }
  // A gate that passes says nothing about watching.
  const fine = withEvents(fakeMachine({ ...ON({ events: true, reviewReceipts: 'observe' }), ...ONE_FILE }));
  fine.ctx.checkReceipts = () => ({ uncovered: [], covered: 1, notes: [] });
  try {
    assert.equal(merge(fine), EXIT.ok);
    assert.deepEqual(wouldBlock(fine), []);
    assert.doesNotMatch(`${printed(fine)}\n${comment(fine)}`, /[Ww]atching only/);
  } finally { fine.cleanup(); }
});

test('modes, observe: a gate whose reader throws, or whose script cannot be loaded, never stops the merge; on enforce it stops with the plain message', () => {
  const broken = (mode) => {
    const m = withEvents(fakeMachine({ ...ON({ events: true, reviewReceipts: mode }), ...ONE_FILE }));
    m.ctx.checkReceipts = () => { throw new Error('git has no branch or commit named origin/main here'); };
    return m;
  };
  const watching = broken('observe');
  try {
    assert.equal(merge(watching), EXIT.ok);
    assert.deepEqual(wouldBlock(watching), [{ gate: 'reviewReceipts', pr: 7, reason: 'receipts: git has no branch or commit named origin/main here' }]);
    assert.equal(types(watching).at(-1), 'merged');
  } finally { watching.cleanup(); }
  const strict = broken('enforce');
  try {
    assert.equal(merge(strict), EXIT.failed);
    assert.match(printed(strict), /^FAIL {2}receipts: git has no branch or commit named origin\/main here$/m);
    assert.deepEqual(ghSubs(strict), ['view']);
  } finally { strict.cleanup(); }
  const missing = withEvents(fakeMachine({ ...ON({ events: true, reviewReceipts: 'observe' }), ...ONE_FILE }));
  missing.ctx.receiptsError = 'Cannot find module';
  try {
    assert.equal(merge(missing), EXIT.ok);
    assert.match(wouldBlock(missing)[0].reason, /scripts\/receipt\.mjs cannot be loaded: Cannot find module/);
  } finally { missing.cleanup(); }
});

// Each older gate that can watch, with a change it would stop.
const OLDER_GATES = [
  ['duplicateNumbers', { tracked: CLASH }, (m) => m, /^numbers: two files in one numbered folder share a number/],
  ['protectedTests', { nameStatus: false }, (m) => m, /^protected tests: cannot list the changed files: bad revision/],
  ['testReasons', { nameStatus: z('M', 'apps/web/save.test.ts') }, (m) => withWeakenings(m, [noReason(WEAK_TEST)]), /^weakenings: 1 of them has no reason that will do/],
  ['incomingCommits', { commits: [{ sha: SHA('a'), message: 'made it work\n' }] }, (m) => withMessageCheck(m), /^incoming commits: 1 commit message on this branch would not pass/],
];

test('modes, observe: each older gate that can watch lets the merge go on and writes one would-block; on enforce the same change is stopped', () => {
  for (const [name, over, arm, reason] of OLDER_GATES) {
    const m = arm(withEvents(fakeMachine({ ...ON({ events: true, [name]: 'observe' }), files: ['apps/web/save.test.ts'], numstat: '1\t1\tapps/web/save.test.ts\n', nameStatus: z('M', 'apps/web/save.test.ts'), ...over })));
    try {
      assert.equal(merge(m), EXIT.ok, name);
      assert.deepEqual(ghSubs(m).slice(-2), ['merge', 'view'], name);
      assert.deepEqual(wouldBlock(m).map((d) => [d.gate, d.pr]), [[name, 7]], name);
      assert.match(wouldBlock(m)[0].reason, reason, name);
      assert.match(printed(m), new RegExp(`^watching only: ${name} would have stopped this merge: `, 'm'), name);
      assert.equal(types(m).includes('merge-blocked'), false, name);
    } finally { m.cleanup(); }
    const strict = arm(withEvents(fakeMachine({ ...ON({ events: true, [name]: 'enforce' }), files: ['apps/web/save.test.ts'], numstat: '1\t1\tapps/web/save.test.ts\n', nameStatus: z('M', 'apps/web/save.test.ts'), ...over })));
    try {
      assert.equal(merge(strict), EXIT.failed, name);
      assert.deepEqual(wouldBlock(strict), [], name);
      assert.deepEqual(ghSubs(strict), ['view'], name);
    } finally { strict.cleanup(); }
  }
});

test('modes, observe: --check goes on too, says "this check", and leaves the would-block event to the merge', () => {
  for (const [name, over, arm] of OLDER_GATES) {
    const m = arm(withEvents(fakeMachine({ ...ON({ events: true, [name]: 'observe' }), files: ['apps/web/save.test.ts'], nameStatus: z('M', 'apps/web/save.test.ts'), ...over })));
    try {
      assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.ok, name);
      assert.match(printed(m), new RegExp(`^watching only: ${name} would have stopped this check: `, 'm'), name);
      assert.deepEqual(wouldBlock(m), [], name);
    } finally { m.cleanup(); }
    const strict = arm(withEvents(fakeMachine({ ...ON({ events: true, [name]: 'enforce' }), files: ['apps/web/save.test.ts'], nameStatus: z('M', 'apps/web/save.test.ts'), ...over })));
    try {
      assert.equal(checkOnly(parseArgs(['--check', '--fast']), strict.ctx), EXIT.failed, name);
    } finally { strict.cleanup(); }
  }
});

test('modes, observe: the incoming commits check on watch is recorded as observed and never counts toward the retry cap', () => {
  const m = withMessageCheck(withEvents(fakeMachine({ ...ON({ events: true, incomingCommits: 'observe' }), ...ONE_FILE, commits: [{ sha: SHA('a'), message: 'made it work\n' }] })));
  try {
    for (let i = 0; i < RETRY_CAP + 1; i++) assert.equal(merge(m, { noCache: true }), EXIT.ok);
    const runs = m.events.filter((e) => e.type === 'check-run' && e.data.check === 'incoming commits').map((e) => [e.data.ok, e.data.observed]);
    assert.deepEqual(runs, Array.from({ length: RETRY_CAP + 1 }, () => [false, true]));
    assert.equal(types(m).includes('slice-parked'), false);
    assert.deepEqual(m.asks, []);
  } finally { m.cleanup(); }
});

test('modes, observe: when the remote moves and the checks start over, one would-block is written for a gate, not one per try', () => {
  const m = withEvents(fakeMachine({ ...ON({ events: true, reviewReceipts: 'observe' }), ...ONE_FILE, moves: 1 }));
  m.ctx.checkReceipts = () => ({ uncovered: UNCOVERED, covered: 0, notes: [] });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.match(printed(m), /Starting over/);
    assert.equal(wouldBlock(m).length, 1);
    assert.equal(comment(m).match(/^- reviewReceipts: /gm).length, 1, 'and one line in the comment');
  } finally { m.cleanup(); }
});

// ---------- Kit 5.1: a check on "observe", and the commit a check ran on ----------

const WATCHED_LINT = [{ name: 'typecheck', run: 'pnpm typecheck' }, { name: 'lint', run: 'pnpm lint', observe: true }, { name: 'test', run: 'pnpm test', slot: true }];
const LINT_WATCHED = { config: { checks: WATCHED_LINT, features: { events: true } }, baseConfig: { checks: WATCHED_LINT, features: { events: true } } };

test('a check on "observe": settings take true or false only, and the plan carries the mark', () => {
  assert.throws(() => settings({ checks: [{ name: 'lint', run: 'x', observe: 'yes' }] }), /"observe" of the check "lint" must be true or false/);
  const { planned } = planChecks({ tier: 'code', checks: WATCHED_LINT, tree: 't' });
  assert.deepEqual(planned.map((p) => [p.name, p.observe]), [['rules', undefined], ['typecheck', undefined], ['lint', true], ['test', undefined]]);
  assert.equal('observe' in planned[1], false, 'a check that enforces has no such key, as before');
});

test('a check on "observe" that fails is printed and recorded with observed: true, and does not stop the merge', () => {
  const m = withEvents(fakeMachine({ ...LINT_WATCHED, files: ['apps/mobile/save.ts'], codes: { lint: 1 }, numstat: NUMSTAT, nameStatus: z('M', 'apps/mobile/save.ts') }));
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint', 'test'], 'the checks after it still run');
    assert.match(printed(m), /FAIL {2}lint \(0\.1 s, exit code 1\)\nlast lines of lint\nFull output: [^\n]+\nwatching only: the check "lint" is set to "observe", so its failure does not stop this merge\./);
    const runs = m.events.filter((e) => e.type === 'check-run').map((e) => e.data);
    assert.deepEqual(runs.find((d) => d.check === 'lint'), { check: 'lint', ok: false, ms: 100, tier: 'code', pr: 7, mode: 'merge', head: 'headsha', observed: true });
    assert.equal(runs.filter((d) => 'observed' in d).length, 1, 'only the watching check is marked');
    assert.equal(types(m).includes('merge-blocked'), false);
    assert.equal(types(m).at(-1), 'merged');
    assert.match(comment(m), /^- lint: FAILED, watching only: it did not stop the merge \(0\.1 s\)$/m);
    assert.match(comment(m), /^- test: pass/m);
    assert.equal(Object.values(readCache(join(m.commonDir, CACHE_FILE))).some((e) => e.name === 'lint'), false, 'a failure is never remembered as a pass');
  } finally { m.cleanup(); }
  // The same check without the mark stops the merge.
  const strict = withEvents(fakeMachine({ ...EVENTS(), files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  try {
    assert.equal(merge(strict), EXIT.failed);
    assert.equal('observed' in strict.events.find((e) => e.data.check === 'lint').data, false);
  } finally { strict.cleanup(); }
});

test('a check on "observe" that passes is marked observed too, and one that keeps failing never parks the slice', () => {
  const pass = withEvents(fakeMachine({ ...LINT_WATCHED, files: ['apps/mobile/save.ts'], numstat: NUMSTAT, nameStatus: z('M', 'apps/mobile/save.ts') }));
  try {
    assert.equal(merge(pass), EXIT.ok);
    assert.deepEqual(pass.events.find((e) => e.data.check === 'lint').data, { check: 'lint', ok: true, ms: 100, tier: 'code', pr: 7, mode: 'merge', head: 'headsha', observed: true });
  } finally { pass.cleanup(); }
  const m = withEvents(fakeMachine({ ...LINT_WATCHED, branch: 'build/003-save-word', files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  try {
    for (let i = 0; i < RETRY_CAP + 1; i++) assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.ok);
    assert.match(printed(m), /4 checks passed\. 1 check on "observe" failed or could not run, and stopped nothing\. Nothing was pushed or merged\./);
    assert.match(printed(m), /so its failure does not stop this check\./);
    assert.equal(types(m).includes('slice-parked'), false);
    assert.deepEqual(m.asks, []);
  } finally { m.cleanup(); }
  // A check that failed three times while it enforced, then was moved to observe: its next failure is
  // not one more retry, so the agent is not told to stop again.
  const moved = withEvents(fakeMachine({ ...LINT_WATCHED, branch: 'build/003-save-word', files: ['apps/mobile/save.ts'], codes: { lint: 1 } }));
  moved.events.push(...[1, 2, 3].map(() => run('build/003-save-word', 'lint', false)));
  try {
    assert.equal(checkOnly(parseArgs(['--check']), moved.ctx), EXIT.ok);
    assert.doesNotMatch(printed(moved), /STOP/);
    assert.deepEqual(moved.asks, []);
  } finally { moved.cleanup(); }
  // The count itself leaves observed runs out: they neither add to a run of failures nor end one.
  const observed = { type: 'check-run', branch: 'b', data: { check: 'lint', ok: false, observed: true } };
  assert.deepEqual(failStreak([observed, observed, observed], 'b', 'lint'), { fails: 0, parked: false });
  assert.deepEqual(failStreak([run('b', 'lint', false), { ...observed, data: { ...observed.data, ok: true } }, run('b', 'lint', false)], 'b', 'lint'), { fails: 2, parked: false });
});

test('check-run names the commit that was checked: its short id, or nothing when unsaved files were checked with it', () => {
  const m = withEvents(fakeMachine({ ...EVENTS(), branch: 'build/003-save-word', files: ['apps/mobile/save.ts'], head: '0123456789abcdef0123456789abcdef01234567' }));
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.ok);
    assert.deepEqual([...new Set(m.events.map((e) => e.data.head))], ['0123456']);
    m.events.length = 0;
    m.state.status = ' M apps/mobile/save.ts\0';
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.ok);
    assert.deepEqual([...new Set(m.events.map((e) => e.data.head))], [null]);
  } finally { m.cleanup(); }
});

// ---------- Kit 5.1: weakening a switch or a check is a weakening ----------

test('the weakening gate hands the sorter the settings as they are written, mode words and watching checks included', () => {
  const m = withWeakenings(fakeMachine({ ...REASONS(), files: ['scripts/kit.config.json'] }), []);
  try {
    assert.equal(merge(m), EXIT.ok);
    const text = '{"features":{"reviewLevels":"observe","testReasons":"enforce"},"checks":[{"name":"lint","run":"x","observe":true}]}';
    assert.deepEqual(m.sorted[0].readSettings(text), JSON.parse(text), 'the sorter reads the modes itself, so nothing is turned into true or false on the way');
  } finally { m.cleanup(); }
});

test('end to end: a lead branch that moves a switch from enforce to observe, and a check to observe, needs a reason and a ruling before it merges', () => {
  const r = realRepos();
  try {
    const here = dirname(SCRIPT);
    for (const file of ['receipt.mjs', 'test-changes.mjs', 'presets.mjs']) copyFileSync(join(here, file), join(r.work, 'scripts', file));
    cpSync(join(here, 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    writeFileSync(join(r.work, 'scripts', 'check-plans.mjs'), `${STUB_CHECKER}export const modelOf = (f) => (String(f).match(/^[a-z0-9-]+\\/([A-Za-z0-9._-]+)$/) || [])[1] ?? null;\nexport const mergeConfig = (raw) => raw;\n`);
    const models = { builder: 'claude/claude-opus-5-5', headAgent: ['claude/claude-opus-5-5'], reviewer: 'codex/gpt-6.1-sol' };
    const lint = { name: 'lint', run: 'true' };
    const settingsWith = (duplicateNumbers, check) => JSON.stringify({ checks: [check], features: { testReasons: true, duplicateNumbers }, models });
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), settingsWith('enforce', lint));
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Two gates that enforce');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/watch-only');
    const pr = { number: 18, state: 'OPEN', isDraft: false, headRefName: 'lead/watch-only', baseRefName: 'main' };
    const save = (file, text, message) => {
      mkdirSync(dirname(join(r.work, file)), { recursive: true });
      writeFileSync(join(r.work, file), text);
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', message);
      git(r.work, 'push', '-q', 'origin', 'lead/watch-only');
    };
    const receipt = (...args) => spawnSync(process.execPath, [join(r.work, 'scripts', 'receipt.mjs'), ...args], { cwd: r.work, encoding: 'utf8' });

    // The same settings in other words: true for "enforce". Nothing is weaker, so nothing is asked.
    save('scripts/kit.config.json', JSON.stringify({ checks: [lint], features: { testReasons: 'enforce', duplicateNumbers: true }, models }), 'Same settings, other words');
    const same = r.runScript(['--check', '--fast'], pr);
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.match(same.stdout, /pass {2}weakenings \(no change weakens a test, a ratchet, or a check\)/);

    save('scripts/kit.config.json', settingsWith('observe', { ...lint, observe: true }), 'Only watch for now');
    const noReason = r.runScript(['18'], pr);
    assert.equal(noReason.status, 1, noReason.stdout + noReason.stderr);
    assert.match(noReason.stdout, /check-removed {10}scripts\/kit\.config\.json: the check 'lint' now only watches: a failure no longer stops a merge; the switch duplicateNumbers went from enforce to observe: it now only watches/);
    assert.match(noReason.stdout, /FAIL {2}weakenings: 1 of them has no reason that will do/);

    save('docs/weakenings/lead-watch-only.md', '- scripts/kit.config.json: We watch both for two weeks before they may stop a merge again.\n', 'Reason');
    const noRuling = r.runScript(['18'], pr);
    assert.equal(noRuling.status, 1, noRuling.stdout + noRuling.stderr);
    assert.match(noRuling.stdout, /FAIL {2}weakenings: 1 of them is not ruled "allowed" by a reviewer on another model:\n {2}check-removed {10}scripts\/kit\.config\.json: no reviewer has ruled on this exact change and reason/);

    const shown = receipt('fingerprints');
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^kit-weakening [0-9a-f]{12} check-removed scripts\/kit\.config\.json\n {4}spotted: the check 'lint' now only watches: a failure no longer stops a merge; the switch duplicateNumbers went from enforce to observe: it now only watches$/m, 'the reviewer is shown the same words the gate prints');
    const session = join(r.dir, 'reviewer.jsonl');
    writeFileSync(session, reviewerRecord('gpt-6.1-sol', '2026-11-19T10:00:00.000Z', shown.stdout, 'VERDICT: approve\nREVIEWED: abc1234\nTASK: watch\n\nFINDINGS\nnone\n\nRULINGS\n- scripts/kit.config.json: allowed, two weeks of watching is the plan.\n'));
    assert.equal(receipt('make', session).status, 0);
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Receipt');
    git(r.work, 'push', '-q', 'origin', 'lead/watch-only');
    const merged = r.runScript(['18'], pr);
    assert.equal(merged.status, 0, merged.stdout + merged.stderr);
    assert.match(merged.stdout, /pass {2}weakenings \(1 ruled "allowed" by a reviewer on another model\)/);
    assert.deepEqual(r.ghCalls().slice(-4).map((c) => c[1]), ['view', 'comment', 'merge', 'view']);
  } finally { r.cleanup(); }
});

test('the three flaky-test kinds from scripts/test-changes.mjs go through the gate like any other weakening', () => {
  for (const kind of ['wait-added', 'timeout-raised', 'retry-added']) {
    assert.ok(KINDS.includes(kind), `${kind} is a kind the sorter knows`);
    const item = { ...WEAK_TEST, kind, what: 'spotted by the sorter' };
    const unruled = withWeakenings(withEvents(fakeMachine({ ...REASONS({ events: true }), files: ['apps/web/save.test.ts'] })), [item], [{ ruling: null, ruledBy: null, why: 'no reviewer has ruled on this exact change and reason' }]);
    try {
      assert.equal(merge(unruled), EXIT.failed, kind);
      assert.match(printed(unruled), new RegExp(`^ {2}${kind} +apps/web/save\\.test\\.ts: no reviewer has ruled`, 'm'));
    } finally { unruled.cleanup(); }
    const ruled = withWeakenings(withEvents(fakeMachine({ ...REASONS({ events: true }), files: ['apps/web/save.test.ts'], numstat: '1\t1\tapps/web/save.test.ts\n', nameStatus: z('M', 'apps/web/save.test.ts') })), [item]);
    try {
      assert.equal(merge(ruled), EXIT.ok, kind);
      assert.deepEqual(ruled.events.find((e) => e.type === 'weakening').data, { pr: 7, kind, file: 'apps/web/save.test.ts', reason: WEAK_TEST.reason, ruling: 'allowed', ruledBy: 'gpt-6.1-sol' });
      assert.match(comment(ruled), new RegExp(`^- ${kind}: \`apps/web/save\\.test\\.ts\``, 'm'));
    } finally { ruled.cleanup(); }
  }
});

// ---------- Kit 5.1: the five newer gates ----------

const NEW_GATES = ['verifiedStamp', 'changeChecklist', 'reviewLevels', 'securityReview', 'findingAnswers'];
const C1 = { sha: SHA('c'), kind: 'commit', subject: 'Change app', fingerprint: 'f'.repeat(40), protected: [], files: ['src/app.ts'] };
const C2 = { sha: SHA('d'), kind: 'commit', subject: 'Change sign-in', fingerprint: 'e'.repeat(40), protected: [], files: ['src/auth/login.ts'] };
const covers = (commits, extra = {}) => ({ verdict: 'approve', model: 'gpt-6.1-sol', fingerprints: commits.map((c) => ({ fingerprint: c.fingerprint, commit: c.sha })), protectedTests: [], ...extra });
// Gives a fake machine the reviews that count: the commits that need a review, and the receipts.
function withReviews(m, usable, needed = [C1]) {
  m.reviewAsks = [];
  m.ctx.approvals = (args) => {
    m.reviewAsks.push(args);
    return { needed, usable, notes: [] };
  };
  return m;
}
// Gives a fake machine the branch's commits, newest first: [{ sha, message, files, parents? }].
function withCommits(m, commits) {
  m.state.commits = commits;
  m.ctx.parseVerified = parseVerified;
  const inner = m.ctx.git;
  m.ctx.git = (args, input) => {
    const one = args.join(' ').match(/^(?:diff-tree --root --no-commit-id --name-only -r -z|show --remerge-diff --format= --name-only -z) (\w+)$/);
    return one ? { code: 0, stdout: commits.find((c) => c.sha === one[1]).files.join('\0'), stderr: '' } : inner(args, input);
  };
  return m;
}
const newGate = (name, mode, over = {}) => withEvents(fakeMachine({ ...ON({ events: true, [name]: mode }), ...ONE_FILE, ...over }));
// What every refusal must do: stop before a check runs, post nothing, and write merge-blocked.
const assertStopped = (m, check) => {
  assert.equal(merge(m), EXIT.failed);
  assert.deepEqual(ran(m), [], 'no check ran');
  assert.deepEqual(ghSubs(m), ['view'], 'nothing posted or merged');
  assert.deepEqual(m.events.map((e) => [e.type, e.data.check]), [['merge-blocked', check]]);
};
// What every watching gate must do: let the merge through and write one would-block for its switch.
const assertWatched = (m, name, reason) => {
  assert.equal(merge(m), EXIT.ok);
  assert.deepEqual(ghSubs(m).slice(-2), ['merge', 'view']);
  assert.deepEqual(wouldBlock(m).map((d) => [d.gate, d.pr]), [[name, 7]]);
  assert.match(wouldBlock(m)[0].reason, reason);
  assert.match(printed(m), new RegExp(`^watching only: ${name} would have stopped this merge: `, 'm'));
  assert.equal(types(m).includes('merge-blocked'), false);
};

test('the five newer switches are known, can watch, and a branch cannot weaken one for its own merge', () => {
  for (const name of NEW_GATES) {
    assert.ok(FEATURES.includes(name) && WATCHERS.includes(name), name);
    assert.equal(settings({}).features[name], false, `${name} is off when missing`);
  }
  // A lead branch is checked with its own settings. Each gate is armed with a change it would stop.
  const arm = {
    verifiedStamp: (m) => withCommits(m, [{ sha: SHA('a'), message: 'feat: add the save button\n\nVerified: none\n', files: ['src/app.ts'] }]),
    changeChecklist: (m) => withReviews(withChecklist(m, [CL3]), [covers([C1])]),
    reviewLevels: (m) => { m.ctx.levelFor = () => ({ level: 'deep', why: 'the change touches the high-risk path src/auth/ (src/auth/login.ts)' }); return withReviews(m, [covers([C1])]); },
    securityReview: (m) => { m.ctx.levelFor = () => ({ level: 'deep', why: 'the change touches the high-risk path src/auth/ (src/auth/login.ts)' }); return withReviews(m, [covers([C1])]); },
    findingAnswers: (m) => { m.ctx.findingsFor = () => ({ file: 'docs/findings/lead-notes.md', rounds: [{ round: 1 }], answers: [], problems: [], owed: [{ round: 1, missing: [1] }] }); return m; },
  };
  for (const name of NEW_GATES) {
    for (const mine of [false, 'off', 'observe']) {
      const m = arm[name](fakeMachine({ config: { features: { [name]: mine }, models: MODELS_SET }, baseConfig: { checks: CHECKS, features: { [name]: 'enforce' }, models: MODELS_SET }, ...ONE_FILE }));
      try {
        assert.equal(merge(m), EXIT.failed, `${name}: ${mine} here, enforce on the base`);
        assert.deepEqual(ghSubs(m), ['view'], name);
        assert.doesNotMatch(printed(m), /watching only/, name);
      } finally { m.cleanup(); }
    }
  }
});

test('the newer gates run only at a merge: --check asks none of their readers', () => {
  const all = Object.fromEntries(NEW_GATES.map((name) => [name, 'enforce']));
  const m = fakeMachine({ ...ON(all), files: ['src/app.ts'] });
  const never = () => { throw new Error('asked by --check'); };
  Object.assign(m.ctx, { parseVerified: never, approvals: never, checklistFor: never, levelFor: never, findingsFor: never });
  try {
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.ok);
  } finally { m.cleanup(); }
});

// ----- verifiedStamp

const said = (line, files = ['src/app.ts'], sha = SHA('a')) => ({ sha, message: `feat: add the save button\n\n${line}\n`, files });

test('verifiedRule: one code commit that says ran or tests is enough, or the newest one gives a reason of 15 characters or more', () => {
  const v = (...lines) => verifiedRule(lines.map((line, i) => ({ sha: `s${i}`, subject: 'x', verified: line === null ? null : parseVerified(`fix: x\n\n${line}\n`) })));
  assert.deepEqual(v('Verified: ran'), { counts: { ran: 1, tests: 0, checks: 0, none: 0 }, ok: true });
  assert.deepEqual(v('Verified: none', 'Verified: tests, checks', 'Verified: none'), { counts: { ran: 0, tests: 1, checks: 1, none: 2 }, ok: true }, 'an older commit that says tests is enough');
  assert.equal(v('Verified: checks').ok, false, 'format, lint, and types alone do not say the change was tried');
  assert.equal(v('Verified: none').ok, false);
  assert.equal(VERIFIED_REASON_MIN, 15);
  assert.equal('docs only edit'.length, 14);
  assert.equal(v('Verified: none (docs only edit)').ok, false, 'a reason of 14 characters is too short');
  assert.equal(v('Verified: none (docs only edits)').ok, true, 'a reason of 15 characters will do');
  assert.equal(v('Verified: none', 'Verified: none (there is no app to run yet)').ok, false, 'only the newest commit may give the reason');
  assert.deepEqual(v(null, 'Verified: ran'), { counts: { ran: 1, tests: 0, checks: 0, none: 1 }, ok: true }, 'a commit with no line counts as none');
  assert.deepEqual(v(), { counts: { ran: 0, tests: 0, checks: 0, none: 0 }, ok: true }, 'no code commit, nothing to stamp');
});

test('verifiedStamp off: the commits are never read, and the merged event has no verified field', () => {
  const m = newGate('verifiedStamp', 'off');
  m.ctx.parseVerified = () => { throw new Error('asked with the switch off'); };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal(m.calls.git.some((a) => a.startsWith('diff-tree')), false);
    assert.equal('verified' in mergedData(m), false);
  } finally { m.cleanup(); }
});

test('verifiedStamp observe: a branch whose code commits all say none merges, with one would-block and the counts in the merged event', () => {
  const m = withCommits(newGate('verifiedStamp', 'observe'), [said('Verified: none'), said('Verified: checks', ['src/b.ts'], SHA('b'))]);
  try {
    assertWatched(m, 'verifiedStamp', /^verified: none of the 2 commits on this branch that change product code says the change was tried\.$/);
    assert.deepEqual(mergedData(m).verified, { ran: 0, tests: 0, checks: 1, none: 1 });
  } finally { m.cleanup(); }
});

test('verifiedStamp enforce: the merge stops, names each commit, shows the grammar, and says what to do next', () => {
  const m = withCommits(newGate('verifiedStamp', 'enforce'), [said('Verified: none'), { sha: SHA('b'), message: 'fix: no stamp at all\n', files: ['src/b.ts'] }]);
  try {
    assertStopped(m, 'verified');
    const out = printed(m);
    assert.match(out, /^FAIL {2}verified: none of the 2 commits on this branch that change product code says the change was tried\.$/m);
    assert.match(out, /^ {2}aaaaaaa "feat: add the save button": it says "Verified: none"$/m);
    assert.match(out, /^ {2}bbbbbbb "fix: no stamp at all": it has no Verified line that can be read$/m);
    assert.match(out, /"Verified: <kinds>", "Verified: none", or "Verified: none \(<reason>\)"\. The kinds, in a comma list: ran \([^)]+\), tests \([^)]+\), checks \(format, lint, types\)\./);
    assert.match(out, /^The newest commit that changes product code is aaaaaaa\. It is the last commit made on this branch, so "git commit --amend" rewords it\.$/m);
    assert.match(out, /^To pass: try the change \(docs\/verify\.md says how\)\. Then either end the message of your next commit that changes product code with "Verified: ran" or "Verified: tests", or reword one of the commits listed above to say so\. If the change cannot be tried, aaaaaaa itself must say why, in 15 characters or more: "Verified: none \(<reason>\)"\.$/m);
    assert.match(out, /^A new empty commit, or a commit that changes only docs, does not count: it changes no product code\. Push, and run this again\.$/m);
  } finally { m.cleanup(); }
});

test('verifiedStamp enforce: ran, tests, or a real reason on the newest code commit lets the merge through', () => {
  for (const [commits, counts, line] of [
    [[said('Verified: none'), said('Verified: ran, checks', ['src/b.ts'], SHA('b'))], { ran: 1, tests: 0, checks: 1, none: 1 }, /pass {2}verified \(2 commits change product code: 1 say ran, 0 say tests\)/],
    [[said('Verified: tests')], { ran: 0, tests: 1, checks: 0, none: 0 }, /pass {2}verified \(1 commit changes product code/],
    [[said('Verified: none (this repo has no app to run yet)')], { ran: 0, tests: 0, checks: 0, none: 1 }, /pass {2}verified/],
  ]) {
    const m = withCommits(newGate('verifiedStamp', 'enforce'), commits);
    try {
      assert.equal(merge(m), EXIT.ok);
      assert.match(printed(m), line);
      assert.deepEqual(mergedData(m).verified, counts);
      assert.deepEqual(wouldBlock(m), []);
    } finally { m.cleanup(); }
  }
});

test('verifiedStamp: only the branch\'s own commits that change product code count; docs, tests, and merge commits are left out', () => {
  // No productPaths: product code is any file that is not paperwork and not a test.
  const free = withCommits(newGate('verifiedStamp', 'enforce'), [
    said('Verified: none', ['docs/notes.md'], SHA('a')),
    said('Verified: none', ['src/app.test.ts'], SHA('b')),
    { sha: SHA('c'), parents: 'p1 p2', message: 'Merge branch main\n', files: [] }, // git's own merge: nothing done by hand
  ]);
  try {
    assert.equal(merge(free), EXIT.ok);
    assert.match(printed(free), /pass {2}verified \(no commit on this branch changes product code\)/);
    assert.deepEqual(mergedData(free).verified, { ran: 0, tests: 0, checks: 0, none: 0 });
  } finally { free.cleanup(); }
  // With productPaths: only files under them, tests included.
  const paths = (commits) => withCommits(newGate('verifiedStamp', 'enforce', ON({ events: true, verifiedStamp: 'enforce' }, { productPaths: ['apps/'] })), commits);
  const outside = paths([said('Verified: none', ['tools/build.ts'])]);
  try {
    assert.equal(merge(outside), EXIT.ok);
  } finally { outside.cleanup(); }
  const inside = paths([said('Verified: none', ['apps/web/save.test.ts'])]);
  try {
    assert.equal(merge(inside), EXIT.failed);
    assert.match(printed(inside), /the one commit on this branch that changes product code does not say the change was tried/);
  } finally { inside.cleanup(); }
  // A branch cannot shrink productPaths for its own merge: when either version leaves it empty, everything counts.
  const scope = guardScope(settings({ productPaths: ['apps/'] }), settings({}));
  assert.equal(scope.isProduct('tools/build.ts'), true);
  assert.equal(guardScope(settings({ productPaths: ['apps/'] }), settings({ productPaths: ['packages'] })).isProduct('packages/core/a.ts'), true, 'two lists count together');
});

test('verifiedStamp: a missing commit-msg.mjs, or git failing, stops an enforcing merge with a plain line and never a watching one', () => {
  for (const [mode, code] of [['enforce', EXIT.failed], ['observe', EXIT.ok]]) {
    const m = newGate('verifiedStamp', mode, { commits: [said('Verified: ran')] });
    m.ctx.messageCheckError = 'Cannot find module';
    try {
      assert.equal(merge(m), code, mode);
      assert.match(printed(m), /verified: the verifiedStamp switch is on, but scripts\/commit-msg\.mjs cannot be loaded: Cannot find module/);
    } finally { m.cleanup(); }
  }
});

// ----- changeChecklist

const CL3 = { id: 'CL-3', paths: ['src/**'], check: 'Data saved by the old version still loads' };
const CL5 = { id: 'CL-5', paths: ['src/**'], check: 'The new key is in .env.example' };
function withChecklist(m, matched, present = true) {
  m.checklistAsks = [];
  m.ctx.pathMatches = pathMatches;
  m.ctx.checklistFor = (root, args) => {
    m.checklistAsks.push([root, args]);
    return { present, items: matched, matched, problems: [], base: args.base };
  };
  return m;
}

test('changeChecklist off: the checklist is never read, and the merged event has no checklist field', () => {
  const m = newGate('changeChecklist', 'off');
  m.ctx.checklistFor = () => { throw new Error('asked with the switch off'); };
  m.ctx.approvals = () => { throw new Error('asked with the switch off'); };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal('checklist' in mergedData(m), false);
  } finally { m.cleanup(); }
});

test('changeChecklist observe: an unanswered row lets the merge through, with one would-block and the matched ids in the merged event', () => {
  const m = withReviews(withChecklist(newGate('changeChecklist', 'observe'), [CL3, CL5]), [covers([C1], { checklist: [{ id: 'CL-5', answer: 'ok' }] })]);
  try {
    assertWatched(m, 'changeChecklist', /^checklist: 1 row of the change checklist has no "ok" or "does not apply" in an approving review receipt/);
    assert.deepEqual(mergedData(m).checklist, ['CL-3', 'CL-5']);
  } finally { m.cleanup(); }
});

test('changeChecklist enforce: each row that fits the change needs "ok" or "does not apply" from a review that counts, and the refusal says what to do', () => {
  const m = withReviews(withChecklist(newGate('changeChecklist', 'enforce'), [CL3, CL5]), [covers([C1], { checklist: [{ id: 'CL-5', answer: 'finding' }] })]);
  try {
    assertStopped(m, 'checklist');
    const out = printed(m);
    assert.match(out, /^FAIL {2}checklist: 2 rows of the change checklist have no "ok" or "does not apply" in an approving review receipt from a model other than the builder's and the head agent's:$/m);
    assert.match(out, /^ {2}CL-3: Data saved by the old version still loads {3}\(no answer in an approving receipt that covers ccccccc, the newest commit that touches it\)$/m);
    assert.match(out, /^ {2}CL-5: The new key is in \.env\.example {3}\(the reviewer wrote "finding": fix it, then have it reviewed again\)$/m);
    assert.match(out, /The reviewer runs "node scripts\/receipt\.mjs fingerprints <branch>" and answers each kit-checklist line it prints, in the CHECKLIST part of its reply: "- CL-3: ok" or "- CL-3: does not apply, <why>"\. Then make the receipt \(node scripts\/receipt\.mjs make <reviewer session file>\), commit and push it, and run this again\./);
    assert.deepEqual(m.checklistAsks, [[m.root, { base: 'origin/main', branch: 'HEAD' }]]);
    assert.deepEqual(m.reviewAsks[0].models, [MODELS_SET, MODELS_SET], 'the builder and head agent models of both versions of the settings');
    assert.equal(m.reviewAsks[0].baseRef, 'origin/main');
  } finally { m.cleanup(); }
});

test('changeChecklist enforce: answered rows, a change no row fits, a project with no checklist, and a change with nothing to review all merge', () => {
  const answered = withReviews(withChecklist(newGate('changeChecklist', 'enforce'), [CL3, CL5]), [covers([C1], { checklist: [{ id: 'CL-3', answer: 'ok' }] }), covers([C1], { checklist: [{ id: 'CL-5', answer: 'does not apply' }] })]);
  try {
    assert.equal(merge(answered), EXIT.ok);
    assert.match(printed(answered), /pass {2}checklist \(CL-3, CL-5: answered in an approving review of the newest commit that touches each\)/);
    assert.deepEqual(mergedData(answered).checklist, ['CL-3', 'CL-5']);
    assert.deepEqual(wouldBlock(answered), []);
  } finally { answered.cleanup(); }
  for (const [present, line] of [[true, /pass {2}checklist \(no row of the change checklist fits this change\)/], [false, /note {2}checklist: this project has no change checklist yet/]]) {
    const m = withChecklist(newGate('changeChecklist', 'enforce'), [], present);
    m.ctx.approvals = () => { throw new Error('no row fits, so the receipts are not read'); };
    try {
      assert.equal(merge(m), EXIT.ok);
      assert.match(printed(m), line);
      assert.deepEqual(mergedData(m).checklist, []);
    } finally { m.cleanup(); }
  }
});

test('finding 9, changeChecklist: a row that fits is never passed with no receipt to hold the answer, whatever kind of file the change is in', () => {
  const m = withReviews(withChecklist(newGate('changeChecklist', 'enforce'), [CL3]), [], []);
  try {
    assertStopped(m, 'checklist');
    assert.match(printed(m), /^ {2}CL-3: Data saved by the old version still loads {3}\(no commit of this change has a review receipt that could hold the answer\)$/m);
    assert.doesNotMatch(printed(m), /pass {2}checklist/);
  } finally { m.cleanup(); }
});

test('changeChecklist: a reader that throws, a missing script, or unset models stop an enforcing merge with the plain message, and never a watching one', () => {
  const cases = [
    [(m) => { m.ctx.checklistFor = () => { throw new Error('cannot find where HEAD left origin/main: the two share no commit'); }; }, /checklist: cannot find where HEAD left origin\/main: the two share no commit/],
    [(m) => { m.ctx.checklistError = 'Cannot find module'; }, /checklist: the changeChecklist switch is on, but scripts\/checklist\.mjs cannot be loaded: Cannot find module/],
    [(m) => { withChecklist(m, [CL3]); m.ctx.approvals = () => ({ fail: 'set "models.builder" and "models.headAgent" in scripts/kit.config.json', notes: [] }); }, /checklist: set "models\.builder" and "models\.headAgent"/],
    [(m) => { withChecklist(m, [CL3]); m.ctx.receiptsError = 'Cannot find module'; }, /checklist: the changeChecklist switch is on, but scripts\/receipt\.mjs cannot be loaded: Cannot find module/],
  ];
  for (const [arm, line] of cases) {
    for (const [mode, code] of [['enforce', EXIT.failed], ['observe', EXIT.ok]]) {
      const m = newGate('changeChecklist', mode);
      arm(m);
      try {
        assert.equal(merge(m), code, `${mode} ${line}`);
        assert.match(printed(m), line);
        assert.equal(wouldBlock(m).length, mode === 'observe' ? 1 : 0);
        if (mode === 'observe') assert.equal('checklist' in mergedData(m), false, 'what could not be read is left out, not guessed');
      } finally { m.cleanup(); }
    }
  }
});

// ----- reviewLevels and securityReview

const DEEP = { level: 'deep', why: 'the change touches the high-risk path src/auth/ (src/auth/login.ts)' };
const STANDARD = { level: 'standard', why: 'src/app.ts is not under a quick review path' };
function withLevel(m, want) {
  m.levelAsks = [];
  m.ctx.levelFor = (root, args) => {
    m.levelAsks.push([root, args]);
    return { ...want, files: ['src/app.ts'], lines: 1, base: args.base };
  };
  return m;
}

test('the review levels are in the same order here as in scripts/review-level.mjs', () => {
  assert.deepEqual(LEVEL_ORDER, LEVELS);
});

test('uncoveredBy: a commit is covered only by a receipt that holds its fingerprint and passes the test', () => {
  const deep = covers([C1], { level: 'deep' });
  const plain = covers([C1, C2]);
  assert.deepEqual(uncoveredBy([C1, C2], [deep, plain], (r) => r.level === 'deep'), [C2]);
  assert.deepEqual(uncoveredBy([C1, C2], [deep, plain], () => true), []);
  assert.deepEqual(uncoveredBy([{ ...C1, fingerprint: '' }], [covers([{ ...C1, fingerprint: '' }])], () => true).length, 1, 'a commit with no fingerprint is never covered');
});

test('reviewLevels off: the level is never worked out, no LEVEL line is needed, and the merged event has no level field', () => {
  const m = newGate('reviewLevels', 'off');
  m.ctx.levelFor = () => { throw new Error('asked with the switch off'); };
  m.ctx.approvals = () => { throw new Error('asked with the switch off'); };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal('level' in mergedData(m), false);
  } finally { m.cleanup(); }
});

test('reviewLevels observe: a review below the level the code works out lets the merge through, with one would-block and the level in the merged event', () => {
  const m = withReviews(withLevel(newGate('reviewLevels', 'observe'), DEEP), [covers([C1], { level: 'standard' })]);
  try {
    assertWatched(m, 'reviewLevels', /^review level: this change needs a deep review, and 1 commit has no approving receipt at that level/);
    assert.equal(mergedData(m).level, 'deep');
  } finally { m.cleanup(); }
});

test('reviewLevels enforce: every commit needs an approving receipt at the worked-out level or above, and the refusal says what to do', () => {
  const m = withReviews(withLevel(newGate('reviewLevels', 'enforce'), DEEP), [covers([C1], { level: 'deep' }), covers([C1, C2])], [C1, C2]);
  try {
    assertStopped(m, 'review level');
    const out = printed(m);
    assert.match(out, /^FAIL {2}review level: this change needs a deep review, and 1 commit has no approving receipt at that level from a model other than the builder's and the head agent's\.$/m);
    assert.match(out, /^ {2}Why deep: the change touches the high-risk path src\/auth\/ \(src\/auth\/login\.ts\)\.$/m);
    assert.match(out, /^ {2}ddddddd Change sign-in$/m);
    assert.doesNotMatch(out, /ccccccc/, 'the commit a deep review covers is not listed');
    assert.match(out, /reviews at the level on the kit-level line it prints, and writes "LEVEL: deep" in its reply\. Then make the receipt \(node scripts\/receipt\.mjs make <reviewer session file>\), commit and push it, and run this again\./);
    assert.deepEqual(m.levelAsks, [[m.root, { base: 'origin/main', branch: 'HEAD' }]]);
  } finally { m.cleanup(); }
});

test('reviewLevels enforce: a receipt with no level is a standard review, and a higher level always covers a lower one', () => {
  for (const [want, level, code] of [
    [STANDARD, undefined, EXIT.ok], [STANDARD, 'quick', EXIT.failed], [STANDARD, 'deep', EXIT.ok],
    [{ level: 'quick', why: 'small' }, undefined, EXIT.ok], [{ level: 'quick', why: 'small' }, 'quick', EXIT.ok],
    [DEEP, undefined, EXIT.failed], [DEEP, 'deep', EXIT.ok],
  ]) {
    const m = withReviews(withLevel(newGate('reviewLevels', 'enforce'), want), [covers([C1], level ? { level } : {})]);
    try {
      assert.equal(merge(m), code, `needs ${want.level}, reviewed at ${level ?? 'no level line'}`);
      if (code === EXIT.ok) {
        assert.equal(mergedData(m).level, want.level);
        assert.match(printed(m), new RegExp(`pass {2}review level \\(${want.level}: `));
      }
    } finally { m.cleanup(); }
  }
});

test('securityReview off: nothing is asked. With the level below deep, no SECURITY line is needed', () => {
  const off = newGate('securityReview', 'off');
  off.ctx.levelFor = () => { throw new Error('asked with the switch off'); };
  try {
    assert.equal(merge(off), EXIT.ok);
    assert.equal('level' in mergedData(off), false);
  } finally { off.cleanup(); }
  const standard = withLevel(newGate('securityReview', 'enforce'), STANDARD);
  standard.ctx.approvals = () => { throw new Error('below deep, the receipts are not read'); };
  try {
    assert.equal(merge(standard), EXIT.ok);
    assert.match(printed(standard), /pass {2}security review \(not needed: the review level is standard\)/);
    assert.equal(mergedData(standard).level, 'standard');
  } finally { standard.cleanup(); }
});

test('securityReview observe: a deep change with no "SECURITY: clear" lets the merge through, with one would-block', () => {
  const m = withReviews(withLevel(newGate('securityReview', 'observe'), DEEP), [covers([C1], { level: 'deep', security: 'open' })]);
  try {
    assertWatched(m, 'securityReview', /^security review: this change needs a deep review, and 1 commit has no approving receipt that says "SECURITY: clear"/);
    assert.equal(mergedData(m).level, 'deep');
  } finally { m.cleanup(); }
});

test('securityReview enforce: at deep, every commit needs an approving receipt that says "SECURITY: clear"; the refusal says what to do', () => {
  for (const security of [undefined, 'open']) {
    const m = withReviews(withLevel(newGate('securityReview', 'enforce'), DEEP), [covers([C1], security ? { security } : {})]);
    try {
      assertStopped(m, 'security review');
      const out = printed(m);
      assert.match(out, /^FAIL {2}security review: this change needs a deep review, and 1 commit has no approving receipt that says "SECURITY: clear" from a model other than the builder's and the head agent's\.$/m);
      assert.match(out, /^ {2}ccccccc Change app$/m);
      assert.match(out, /The reviewer does the security pass and writes "SECURITY: clear" in its reply\. An open security finding \("SECURITY: open"\) must be fixed first\. Then make the receipt/);
    } finally { m.cleanup(); }
  }
  const clear = withReviews(withLevel(newGate('securityReview', 'enforce'), DEEP), [covers([C1], { security: 'clear' })]);
  try {
    assert.equal(merge(clear), EXIT.ok);
    assert.match(printed(clear), /pass {2}security review \(an approving review says the security pass is clear\)/);
  } finally { clear.cleanup(); }
});

test('reviewLevels and securityReview together read the level and the receipts once, and a broken level reader stops only an enforcing gate', () => {
  const both = withReviews(withLevel(withEvents(fakeMachine({ ...ON({ events: true, reviewLevels: 'enforce', securityReview: 'enforce', changeChecklist: 'enforce' }), ...ONE_FILE })), DEEP), [covers([C1], { level: 'deep', security: 'clear', checklist: [{ id: 'CL-3', answer: 'ok' }] })]);
  withChecklist(both, [CL3]);
  try {
    assert.equal(merge(both), EXIT.ok);
    assert.equal(both.levelAsks.length, 1);
    assert.equal(both.reviewAsks.length, 1);
    assert.deepEqual([mergedData(both).level, mergedData(both).checklist], ['deep', ['CL-3']]);
  } finally { both.cleanup(); }
  for (const [mode, code] of [['enforce', EXIT.failed], ['observe', EXIT.ok]]) {
    const m = newGate('reviewLevels', mode);
    m.ctx.levelFor = () => { throw new Error('scripts/kit.config.json on origin/main is not valid JSON: Unexpected token'); };
    try {
      assert.equal(merge(m), code, mode);
      assert.match(printed(m), /review level: scripts\/kit\.config\.json on origin\/main is not valid JSON/);
      if (mode === 'observe') assert.equal('level' in mergedData(m), false);
    } finally { m.cleanup(); }
  }
});

// ----- findingAnswers

const ANSWERS = [
  { round: 1, n: 1, label: 'Important', outcome: 'fixed', note: 'Added the check and a test for it.', line: 3 },
  { round: 1, n: 2, label: 'Pre-existing', outcome: 'later', note: 'Logged as a task for the next slice.', line: 4 },
  { round: 2, n: 1, label: 'Nit', outcome: 'not worth it', note: 'The name is used in forty places.', line: 5 },
];
function withFindings(m, { answers = [], owed = [], problems = [] } = {}) {
  m.findingAsks = [];
  m.ctx.answerLine = answerLine;
  m.ctx.findingsFor = (root, args) => {
    m.findingAsks.push([root, args]);
    return { file: 'docs/findings/lead-notes.md', rounds: [{ round: 1 }, { round: 2 }], answers, problems, owed };
  };
  return m;
}

test('findingAnswers off: the findings are never read, and no finding event is written', () => {
  const m = newGate('findingAnswers', 'off');
  m.ctx.findingsFor = () => { throw new Error('asked with the switch off'); };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.equal(types(m).includes('finding'), false);
  } finally { m.cleanup(); }
});

test('findingAnswers observe: findings with no answer let the merge through, with one would-block; the answers that are there become finding events', () => {
  const m = withFindings(newGate('findingAnswers', 'observe'), { answers: ANSWERS.slice(0, 1), owed: [{ round: 1, missing: [2] }, { round: 2, missing: [1] }] });
  try {
    assertWatched(m, 'findingAnswers', /^findings: 2 review findings have no answer line in docs\/findings\/lead-notes\.md\.$/);
    assert.deepEqual(m.events.filter((e) => e.type === 'finding').map((e) => e.data), [{ pr: 7, round: 1, n: 1, label: 'important', outcome: 'fixed' }]);
  } finally { m.cleanup(); }
});

test('findingAnswers enforce: every finding a review round counted needs an answer line; the refusal shows the lines to add', () => {
  const m = withFindings(newGate('findingAnswers', 'enforce'), { answers: ANSWERS.slice(0, 1), owed: [{ round: 1, missing: [2] }, { round: 2, missing: [1] }], problems: ['line 7: R2.1: the outcome "done" is not one of: fixed, wrong, intended, not worth it, later'] });
  try {
    assertStopped(m, 'findings');
    const out = printed(m);
    assert.match(out, /^note {2}findings: docs\/findings\/lead-notes\.md, line 7: R2\.1: the outcome "done" is not one of/m);
    assert.match(out, /^FAIL {2}findings: 2 review findings have no answer line in docs\/findings\/lead-notes\.md\.$/m);
    assert.ok(out.includes(`  ${answerLine(1, 2)}\n  ${answerLine(2, 1)}\n`), 'the exact lines to add, one per finding');
    assert.match(out, /The builder adds one line like these for each to docs\/findings\/lead-notes\.md \(make the file if it is not there\), commits, and pushes\. Then run this again\./);
    assert.deepEqual(m.findingAsks, [[m.root, { base: 'origin/main', branch: 'HEAD', name: 'lead/notes' }]]);
    assert.equal(types(m).includes('finding'), false, 'nothing merged, so no finding is on record yet');
  } finally { m.cleanup(); }
});

test('findingAnswers enforce: with every finding answered the merge goes through and writes one finding event per answer, the label in small letters', () => {
  const m = withFindings(newGate('findingAnswers', 'enforce'), { answers: ANSWERS });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.match(printed(m), /pass {2}findings \(2 review rounds, 3 answers\)/);
    assert.deepEqual(m.events.filter((e) => e.type === 'finding').map((e) => e.data), [
      { pr: 7, round: 1, n: 1, label: 'important', outcome: 'fixed' },
      { pr: 7, round: 1, n: 2, label: 'pre-existing', outcome: 'later' },
      { pr: 7, round: 2, n: 1, label: 'nit', outcome: 'not worth it' },
    ]);
    assert.deepEqual(types(m).slice(-4), ['merged', 'finding', 'finding', 'finding'], 'after the merged event');
  } finally { m.cleanup(); }
});

test('findingAnswers: a reader that throws, or a missing script, stops an enforcing merge with the plain message and never a watching one', () => {
  const cases = [
    [(m) => { m.ctx.findingsFor = () => { throw new Error('the review receipt docs/receipts/084-1a2b3c4d.json cannot be read (Unexpected end of JSON input). Make it again with node scripts/receipt.mjs make <session-file>.'); }; }, /findings: the review receipt docs\/receipts\/084-1a2b3c4d\.json cannot be read/],
    [(m) => { m.ctx.findingsError = 'Cannot find module'; }, /findings: the findingAnswers switch is on, but scripts\/findings\.mjs cannot be loaded: Cannot find module/],
  ];
  for (const [arm, line] of cases) {
    for (const [mode, code] of [['enforce', EXIT.failed], ['observe', EXIT.ok]]) {
      const m = newGate('findingAnswers', mode);
      arm(m);
      try {
        assert.equal(merge(m), code, mode);
        assert.match(printed(m), line);
        assert.equal(types(m).includes('finding'), false);
      } finally { m.cleanup(); }
    }
  }
});

test('old settings: with none of the newer switches set, the merged event and the check-run events hold exactly the older fields plus head', () => {
  const m = withEvents(fakeMachine({ ...EVENTS(), ...ONE_FILE }));
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(Object.keys(mergedData(m)), ['pr', 'tier', 'files', 'added', 'removed', 'risk', 'riskPaths', 'testsAdded', 'testReasons']);
    assert.deepEqual(Object.keys(m.events[0].data), ['check', 'ok', 'ms', 'tier', 'pr', 'mode', 'head']);
    assert.deepEqual([...new Set(types(m))], ['check-run', 'merged']);
  } finally { m.cleanup(); }
});

test('the merged event says testReasons only when the weakening gate was met, so a watched gate that was not met leaves no false cover', () => {
  const unmet = withWeakenings(withEvents(fakeMachine({ ...REASONS({ events: true, testReasons: 'observe' }), files: ['apps/web/save.test.ts'], numstat: '1\t1\tapps/web/save.test.ts\n', nameStatus: z('M', 'apps/web/save.test.ts') })), [noReason(WEAK_TEST)]);
  try {
    assert.equal(merge(unmet), EXIT.ok);
    assert.equal(mergedData(unmet).testReasons, false);
    assert.doesNotMatch(comment(unmet), /^Weakenings/m);
  } finally { unmet.cleanup(); }
  const met = withWeakenings(withEvents(fakeMachine({ ...REASONS({ events: true, testReasons: 'observe' }), files: ['apps/web/save.test.ts'], numstat: '1\t1\tapps/web/save.test.ts\n', nameStatus: z('M', 'apps/web/save.test.ts') })), [WEAK_TEST]);
  try {
    assert.equal(merge(met), EXIT.ok);
    assert.equal(mergedData(met).testReasons, true);
    assert.equal(types(met).includes('weakening'), true);
  } finally { met.cleanup(); }
});

test('end to end, kit 5.1: the newer gates with real git and the real readers: stamp, checklist, level, findings, then a merge that a watching gate did not stop', () => {
  const r = realRepos();
  try {
    const here = dirname(SCRIPT);
    for (const file of ['receipt.mjs', 'test-changes.mjs', 'presets.mjs', 'events.mjs', 'token-ledger.mjs', 'run-file.mjs', 'commit-msg.mjs', 'checklist.mjs', 'review-level.mjs', 'findings.mjs']) copyFileSync(join(here, file), join(r.work, 'scripts', file));
    cpSync(join(here, 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    // The real scripts import a few more names from the checker; the stub gets a stand-in for each.
    writeFileSync(join(r.work, 'scripts', 'check-plans.mjs'), `${STUB_CHECKER}export const CONFIG_FILE = 'scripts/kit.config.json';\nexport const modelOf = (f) => (String(f).match(/^[a-z0-9-]+\\/([A-Za-z0-9._-]+)$/) || [])[1] ?? null;\nexport const mergeConfig = (raw) => raw;\nexport const parsePlan = () => ({});\nexport const baseCandidates = (c) => [(c.remote ?? 'origin') + '/' + (c.baseBranch ?? 'main'), c.baseBranch ?? 'main'];\n`);
    const models = { builder: 'claude/claude-opus-5-5', headAgent: ['claude/claude-opus-5-5'], reviewer: 'codex/gpt-6.1-sol' };
    const features = { events: true, verifiedStamp: 'enforce', changeChecklist: 'enforce', reviewLevels: 'enforce', securityReview: 'observe', findingAnswers: 'enforce' };
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ checks: [], features, models, highRiskPaths: ['src/auth/'] }));
    writeFileSync(join(r.work, 'docs', 'change-checklist.md'), '# Change Checklist\n\nFormat: kit change checklist, version 1\n\n| Id | When the change touches | Check this | Why |\n|---|---|---|---|\n| CL-1 | `src/**` | Old data still loads | The 2026 outage |\n| CL-2 | `db/**` | The migration can be undone | A lost table |\n');
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Turn the newer gates on');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'build/004-login');
    const pr = { number: 16, state: 'OPEN', isDraft: false, headRefName: 'build/004-login', baseRefName: 'main' };
    const save = (file, text, message) => {
      mkdirSync(dirname(join(r.work, file)), { recursive: true });
      writeFileSync(join(r.work, file), text);
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', message);
      git(r.work, 'push', '-q', 'origin', 'build/004-login');
    };
    const receipt = (...args) => spawnSync(process.execPath, [join(r.work, 'scripts', 'receipt.mjs'), ...args], { cwd: r.work, encoding: 'utf8' });
    const review = (name, at, lines) => {
      const shown = receipt('fingerprints');
      assert.equal(shown.status, 0, shown.stderr);
      assert.match(shown.stdout, /^kit-checklist CL-1 Old data still loads$/m);
      assert.doesNotMatch(shown.stdout, /CL-2/, 'a row that does not fit the change is not printed');
      assert.match(shown.stdout, /^kit-level deep the change touches the high-risk path src\/auth\/ \(src\/auth\/login\.js\)$/m);
      const session = join(r.dir, `${name}.jsonl`);
      writeFileSync(session, reviewerRecord('gpt-6.1-sol', at, shown.stdout, `${lines.join('\n')}\n`));
      const made = receipt('make', session);
      assert.equal(made.status, 0, made.stderr);
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', `Receipt from ${name}`);
      git(r.work, 'push', '-q', 'origin', 'build/004-login');
    };
    const stopped = (line) => {
      const run = r.runScript(['16'], pr);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stdout, line);
      return run.stdout;
    };

    save('src/auth/login.js', 'export const login = () => true;\n', 'feat: add sign-in');
    stopped(/^FAIL {2}verified: the one commit on this branch that changes product code does not say the change was tried\.\n {2}[0-9a-f]{7} "feat: add sign-in": it has no Verified line that can be read$/m);

    save('src/auth/login.js', 'export const login = (word) => word === secret;\n', 'fix: check the password\n\nVerified: tests');
    stopped(/^pass {2}verified \(2 commits change product code: 0 say ran, 1 say tests\)\nFAIL {2}checklist: 1 row of the change checklist has no "ok" or "does not apply"[^\n]*\n {2}CL-1: Old data still loads {3}\(no answer in an approving receipt that covers [0-9a-f]{7}, the newest commit that touches it\)$/m);

    review('round-1', '2026-11-19T10:00:00.000Z', ['VERDICT: changes needed', 'COUNT: 1 important, 0 nit, 0 pre-existing', 'LEVEL: deep', 'SECURITY: open', 'REVIEWED: abc1234', 'TASK: 004', '', 'FINDINGS', '1. [Important] src/auth/login.js:1, no limit on wrong tries', '', 'CHECKLIST', '- CL-1: finding 1']);
    stopped(/^FAIL {2}checklist: 1 row of the change checklist has no "ok" or "does not apply"/m);

    save('src/auth/login.js', 'export const login = (word) => tries++ < 5 && word === secret;\n', 'fix: lock the account after five wrong tries\n\nVerified: ran, tests');
    review('round-2', '2026-11-19T11:00:00.000Z', ['VERDICT: approve', 'COUNT: 0 important, 0 nit, 0 pre-existing', 'REVIEWED: abc1234', 'TASK: 004', '', 'CHECKLIST', '- CL-1: ok']);
    stopped(/^pass {2}checklist \(CL-1: answered in an approving review of the newest commit that touches each\)\nFAIL {2}review level: this change needs a deep review, and 3 commits have no approving receipt at that level[^\n]*\n {2}Why deep: the change touches the high-risk path src\/auth\/ \(src\/auth\/login\.js\)\.$/m);

    // A deep review that leaves out the SECURITY line: the security gate only watches here.
    review('round-3', '2026-11-19T12:00:00.000Z', ['VERDICT: approve', 'COUNT: 0 important, 0 nit, 0 pre-existing', 'LEVEL: deep the change touches the high-risk path src/auth/', 'REVIEWED: abc1234', 'TASK: 004', '', 'CHECKLIST', '- CL-1: ok']);
    const owing = stopped(/^FAIL {2}findings: 1 review finding has no answer line in docs\/findings\/build-004-login\.md\.\n {2}- R1\.1 </m);
    assert.match(owing, /^pass {2}review level \(deep: /m);
    assert.match(owing, /^watching only: securityReview would have stopped this merge: security review: this change needs a deep review, and 3 commits have no approving receipt that says "SECURITY: clear"/m);

    save('docs/findings/build-004-login.md', '# Findings\n\n- R1.1 Important: fixed: Added a lock after five wrong tries.\n', 'docs: answer the review');
    const merged = r.runScript(['16'], pr);
    assert.equal(merged.status, 0, merged.stdout + merged.stderr);
    assert.doesNotMatch(merged.stdout + merged.stderr, /Warning|unsettled/, 'every script loaded, with no loop of imports');
    assert.match(merged.stdout, /^pass {2}findings \(3 review rounds, 1 answer\)$/m);
    const calls = r.ghCalls();
    assert.deepEqual(calls.slice(-4).map((c) => c[1]), ['view', 'comment', 'merge', 'view']);
    assert.match(calls.at(-3)[4], /\nWatching only \(1\): [^\n]+\n- securityReview: security review: this change needs a deep review/);

    const log = join(git(r.work, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'kit-events.jsonl');
    const events = readFileSync(log, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(events.filter((e) => e.type === 'merge-blocked').map((e) => e.data.check), ['verified', 'checklist', 'checklist', 'review level', 'findings']);
    const done = events.find((e) => e.type === 'merged').data;
    assert.deepEqual([done.verified, done.level, done.checklist], [{ ran: 1, tests: 2, checks: 0, none: 1 }, 'deep', ['CL-1']]);
    assert.deepEqual(events.filter((e) => e.type === 'finding').map((e) => e.data), [{ pr: 16, round: 1, n: 1, label: 'important', outcome: 'fixed' }]);
    const watched = events.filter((e) => e.type === 'would-block').map((e) => e.data);
    assert.equal(watched.length, 2, 'one for each run that reached the watching gate');
    assert.ok(watched.every((d) => d.gate === 'securityReview' && d.pr === 16 && /^security review: this change needs a deep review/.test(d.reason)), JSON.stringify(watched));
    const runs = events.filter((e) => e.type === 'check-run');
    assert.ok(runs.length > 0 && runs.every((e) => /^[0-9a-f]{7}$/.test(e.data.head)), 'each check-run names the commit it ran on');
    assert.equal(new Set(runs.map((e) => e.data.head)).size, 1, 'and they all ran on the commit that merged');
  } finally { r.cleanup(); }
});

test('the notes on receipts that were not counted are printed once: by the receipts gate when it is on, else by the first newer gate that reads them', () => {
  const NOTE = 'docs/receipts/084-1a2b3c4d.json: does not match its session record; not counted';
  for (const receipts of ['enforce', 'off']) {
    const m = withLevel(withChecklist(withEvents(fakeMachine({ ...ON({ events: true, reviewReceipts: receipts, changeChecklist: 'enforce', reviewLevels: 'enforce' }), ...ONE_FILE })), [CL3]), STANDARD);
    m.ctx.checkReceipts = () => ({ uncovered: [], covered: 1, notes: [NOTE] });
    m.ctx.approvals = () => ({ needed: [C1], usable: [covers([C1], { checklist: [{ id: 'CL-3', answer: 'ok' }] })], notes: [NOTE] });
    try {
      assert.equal(merge(m), EXIT.ok);
      assert.equal(printed(m).split(`note  receipts: ${NOTE}`).length - 1, 1, `reviewReceipts ${receipts}`);
    } finally { m.cleanup(); }
  }
});

// ---------- Review of kit 5.1: what a branch could still loosen for its own merge, and gaps in the newer gates ----------

test('finding 2: a branch cannot move a check the base branch still enforces to "observe" for its own merge', () => {
  const own = [{ name: 'typecheck', run: 'pnpm typecheck' }, { name: 'lint', run: 'pnpm lint', observe: true }, { name: 'test', run: 'pnpm test', slot: true }];
  const m = fakeMachine({ config: { checks: own }, baseConfig: { checks: CHECKS }, files: ['apps/mobile/save.ts'], codes: { lint: 1 } });
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.deepEqual(ghSubs(m), ['view'], 'nothing posted or merged');
    assert.match(printed(m), /^note {2}checks: "lint" is set to "observe" on this branch, but the base branch still enforces it, so it enforces here too\.$/m);
    assert.doesNotMatch(printed(m), /watching only/);
    assert.equal(checkOnly(parseArgs(['--check']), m.ctx), EXIT.failed, 'and the same in --check');
  } finally { m.cleanup(); }
  const scope = guardScope(settings({ checks: own }), settings({ checks: CHECKS }));
  assert.deepEqual([scope.heldChecks, scope.checks.map((c) => c.observe === true)], [['lint'], [false, false, false]]);
  // Once the base branch has it on observe too, or for a check the base branch does not have, it watches.
  const both = guardScope(settings({ checks: [...own, { name: 'new', run: 'x', observe: true }] }), settings({ checks: own }));
  assert.deepEqual([both.heldChecks, both.checks.map((c) => c.observe === true)], [[], [false, true, false, true]]);
});

test('finding 3: the numbered folders of the base branch are still checked when the branch empties its own list', () => {
  const twice = ['db/migrations/0026_users.sql', 'db/migrations/0026_orders.sql'];
  const m = fakeMachine({ config: { features: { duplicateNumbers: 'enforce' }, numberedPaths: [] }, baseConfig: { checks: CHECKS, features: { duplicateNumbers: 'enforce' }, numberedPaths: ['db/migrations/'] }, files: twice, tracked: twice });
  try {
    assert.equal(merge(m), EXIT.failed);
    assert.match(printed(m), /FAIL {2}numbers: two files in one numbered folder share a number[^\n]*\n {2}db\/migrations\/ 0026: /);
    assert.equal(checkOnly(parseArgs(['--check', '--fast']), m.ctx), EXIT.failed);
  } finally { m.cleanup(); }
  assert.deepEqual(guardScope(settings({ numberedPaths: ['a/'] }), settings({ numberedPaths: ['b/'] })).numberedPaths, ['a/', 'b/']);
});

test('finding 5: a file the base branch treats as product code still needs a stamp when the branch names its folder a test folder or a docs folder', () => {
  for (const loosened of [{ testPaths: ['src/', 'scripts/'] }, { paperworkPaths: ['docs/', 'AGENTS.md', 'src/'] }]) {
    const m = withCommits(withEvents(fakeMachine({ config: { features: { verifiedStamp: 'enforce' }, ...loosened }, baseConfig: { checks: CHECKS, features: { verifiedStamp: 'enforce' } }, ...ONE_FILE })), [said('Verified: none')]);
    try {
      assert.equal(merge(m), EXIT.failed, JSON.stringify(loosened));
      assert.match(printed(m), /FAIL {2}verified: the one commit on this branch that changes product code does not say the change was tried\./);
    } finally { m.cleanup(); }
    const scope = guardScope(settings(loosened), settings({}));
    assert.equal(scope.isProduct('src/app.ts'), true);
    assert.equal(scope.isProduct('docs/notes.md'), false, 'what both versions call a doc is still no product code');
  }
  assert.equal(guardScope(settings({ productPaths: ['apps/'] }), settings({ productPaths: ['packages/'] })).isProduct('tools/x.ts'), false, 'with both lists set, only what is under one of them');
});

test('sweep: a branch that names a code folder a docs folder still gets the code tier and every check', () => {
  const m = fakeMachine({ config: { paperworkPaths: ['docs/', 'AGENTS.md', 'apps/'] }, baseConfig: { checks: CHECKS }, files: ['apps/mobile/save.ts'] });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(ran(m), ['rules', 'script tests', 'typecheck', 'lint', 'test']);
    assert.match(comment(m), /tier: code/);
    assert.equal(checkOnly(parseArgs(['--check', '--no-cache']), m.ctx), EXIT.ok);
    assert.match(printed(m), /^Checks for lead\/notes \(tier: code\)$/m, 'and --check picks the tier the same way');
  } finally { m.cleanup(); }
});

test('finding 7: product code edited by hand inside a merge commit needs the stamp like any other commit', () => {
  const byHand = { sha: SHA('c'), parents: 'p1 p2', message: 'Merge branch main into build\n', files: ['src/app.ts'] };
  const m = withCommits(newGate('verifiedStamp', 'enforce'), [byHand, said('Verified: none', ['docs/notes.md'], SHA('a'))]);
  try {
    assertStopped(m, 'verified');
    assert.match(printed(m), /^ {2}ccccccc "Merge branch main into build": it has no Verified line that can be read$/m);
  } finally { m.cleanup(); }
  const stamped = withCommits(newGate('verifiedStamp', 'enforce'), [{ ...byHand, message: 'Merge branch main into build\n\nVerified: tests\n' }]);
  try {
    assert.equal(merge(stamped), EXIT.ok);
    assert.deepEqual(mergedData(stamped).verified, { ran: 0, tests: 1, checks: 0, none: 0 });
  } finally { stamped.cleanup(); }
});

test('finding 8: a checklist answer counts only from a receipt that covers the newest commit that touches the row', () => {
  const later = { ...C2, files: ['src/app.ts'], subject: 'Change app again' };
  const first = covers([C1], { checklist: [{ id: 'CL-3', answer: 'ok' }] });
  const stale = withReviews(withChecklist(newGate('changeChecklist', 'enforce'), [CL3]), [first, covers([C1, later])], [C1, later]);
  try {
    assertStopped(stale, 'checklist');
    assert.match(printed(stale), /^ {2}CL-3: [^\n]+ {3}\(no answer in an approving receipt that covers ddddddd, the newest commit that touches it\)$/m);
  } finally { stale.cleanup(); }
  const fresh = withReviews(withChecklist(newGate('changeChecklist', 'enforce'), [CL3]), [first, covers([C1, later], { checklist: [{ id: 'CL-3', answer: 'does not apply' }] })], [C1, later]);
  try {
    assert.equal(merge(fresh), EXIT.ok);
  } finally { fresh.cleanup(); }
  // A later commit that does not touch the row's paths asks for nothing new.
  const elsewhere = withReviews(withChecklist(newGate('changeChecklist', 'enforce'), [CL3]), [first, covers([C1, { ...later, files: ['tools/build.ts'] }])], [C1, { ...later, files: ['tools/build.ts'] }]);
  try {
    assert.equal(merge(elsewhere), EXIT.ok);
  } finally { elsewhere.cleanup(); }
});

test('finding 9: with the newer gates on, a docs file under a high-risk path or a checklist row needs a review, and the receipt readers are told so', () => {
  const on = guardScope(settings({ features: { securityReview: 'observe', changeChecklist: 'observe' }, highRiskPaths: ['docs/private/'] }));
  const rows = [{ id: 'CL-1', paths: ['docs/api/**'] }];
  const wide = reviewScope(on, { items: rows, pathMatches });
  assert.deepEqual(['docs/private/plan.md', 'docs/api/v1/words.md', 'docs/notes.md', 'src/app.ts'].map(wide.isPaperwork), [false, false, true, false]);
  const off = guardScope(settings({ highRiskPaths: ['docs/private/'] }));
  assert.deepEqual(['docs/private/plan.md', 'docs/api/v1/words.md'].map(reviewScope(off, { items: rows, pathMatches }).isPaperwork), [true, true], 'with the switches off, docs are docs as before');
  assert.equal(reviewScope(guardScope(settings({ features: { reviewLevels: 'enforce' }, highRiskPaths: ['docs/private/'] }))).isPaperwork('docs/private/plan.md'), false);

  const m = withReviews(withChecklist(withLevel(withEvents(fakeMachine({ ...ON({ events: true, reviewReceipts: 'enforce', securityReview: 'enforce', changeChecklist: 'enforce' }, { highRiskPaths: ['docs/private/'] }), files: ['docs/private/plan.md'], numstat: '1\t0\tdocs/private/plan.md\n', nameStatus: z('M', 'docs/private/plan.md') })), DEEP), [{ id: 'CL-1', paths: ['docs/api/**'], check: 'The public page says the same' }]), [], []);
  const asked = [];
  m.ctx.checkReceipts = (args) => { asked.push(args); return { uncovered: [], covered: 0, notes: [] }; };
  try {
    merge(m);
    for (const args of [asked[0], m.reviewAsks[0]]) assert.deepEqual(['docs/private/plan.md', 'docs/api/v1/words.md', 'docs/notes.md'].map(args.isPaperwork), [false, false, true]);
  } finally { m.cleanup(); }
});

test('finding 9: a deep change with no receipt at all is stopped by the level and security gates, and nothing says an approving review cleared it', () => {
  for (const name of ['securityReview', 'reviewLevels']) {
    const m = withReviews(withLevel(newGate(name, 'enforce', { files: ['docs/private/plan.md'] }), DEEP), [], []);
    try {
      assertStopped(m, name === 'securityReview' ? 'security review' : 'review level');
      assert.doesNotMatch(printed(m), /^pass {2}(security review|review level)/m);
      assert.doesNotMatch(printed(m), /says the security pass is clear/);
      assert.match(printed(m), name === 'securityReview'
        ? /^FAIL {2}security review: this change needs a deep review, and it has no approving receipt that says "SECURITY: clear"/m
        : /^FAIL {2}review level: this change needs a deep review, and no approving receipt covers it at all\. A receipt from a model other than the builder's and the head agent's is needed\.$/m);
    } finally { m.cleanup(); }
  }
  // A standard docs-only change still needs no review.
  const docs = withReviews(withLevel(newGate('reviewLevels', 'enforce', { files: ['docs/notes.md'] }), STANDARD), [], []);
  try {
    assert.equal(merge(docs), EXIT.ok);
  } finally { docs.cleanup(); }
});

test('finding 14: with events off, a watching gate still writes its would-block, and nothing else is written', () => {
  const m = withCommits(withEvents(fakeMachine({ ...ON({ verifiedStamp: 'observe' }), ...ONE_FILE })), [said('Verified: none')]);
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(m.events.map((e) => [e.type, e.data.gate, e.data.pr, e.branch]), [['would-block', 'verifiedStamp', 7, 'lead/notes']]);
  } finally { m.cleanup(); }
});

test('finding 15: a check on "observe" that cannot get the test slot says it could not run, and the merge goes on', () => {
  const watchedTest = [{ name: 'lint', run: 'pnpm lint' }, { name: 'test', run: 'pnpm test', slot: true, observe: true }];
  for (const [extra, codes] of [[{}, { test: 75 }], [{ wait: 5 }, { 'test slot': 75 }]]) {
    const m = withEvents(fakeMachine({ config: { checks: watchedTest, features: { events: true } }, baseConfig: { checks: watchedTest, features: { events: true } }, files: ['apps/mobile/save.ts'], codes, numstat: NUMSTAT, nameStatus: z('M', 'apps/mobile/save.ts') }));
    try {
      assert.equal(merge(m, extra), EXIT.ok, JSON.stringify(extra));
      assert.match(printed(m), /^watching only: the check "test" could not run, because the machine's test slot is taken\. It is set to "observe", so this merge goes on without it\.$/m);
      assert.match(comment(m), /^- test: not run, the test slot was busy \(watching only: it did not stop the merge\)$/m);
      assert.equal(m.events.some((e) => e.type === 'check-run' && e.data.check === 'test'), false, 'it did not run, so no run is on record');
      assert.equal(types(m).at(-1), 'merged');
    } finally { m.cleanup(); }
  }
  // The same busy slot under a check that enforces still ends the run with 75.
  const strict = fakeMachine({ files: ['apps/mobile/save.ts'], codes: { test: 75 } });
  try {
    assert.equal(merge(strict), EXIT.busy);
  } finally { strict.cleanup(); }
  const check = fakeMachine({ config: { checks: watchedTest }, baseConfig: { checks: watchedTest }, files: ['apps/mobile/save.ts'], codes: { test: 75 } });
  try {
    assert.equal(checkOnly(parseArgs(['--check']), check.ctx), EXIT.ok);
    assert.match(printed(check), /3 checks passed\. 1 check on "observe" failed or could not run, and stopped nothing\./);
  } finally { check.cleanup(); }
});

test('finding 21: when the newest product-code commit is not the last commit, the stamp message names it and says amending would reword the wrong one', () => {
  const m = withCommits(newGate('verifiedStamp', 'enforce'), [said('Verified: none', ['docs/notes.md'], SHA('a')), said('Verified: none', ['src/app.ts'], SHA('b'))]);
  try {
    assertStopped(m, 'verified');
    assert.match(printed(m), /^The newest commit that changes product code is bbbbbbb\. It is not the last commit made on this branch \(aaaaaaa is\), so "git commit --amend" would reword the wrong one\.$/m);
    assert.match(printed(m), /If the change cannot be tried, bbbbbbb itself must say why/);
    assert.match(printed(m), /A new empty commit, or a commit that changes only docs, does not count/);
  } finally { m.cleanup(); }
});

test('finding 6: a review receipt whose counts cannot be checked against its session record stops the findings gate, and never a watching one', () => {
  for (const [mode, code] of [['enforce', EXIT.failed], ['observe', EXIT.ok]]) {
    const m = withFindings(newGate('findingAnswers', mode), { answers: ANSWERS });
    const inner = m.ctx.findingsFor;
    m.ctx.findingsFor = (...args) => ({ ...inner(...args), notes: ['docs/receipts/084-1a2b3c4d.json: its session record cannot be read again (ENOENT), so its counts cannot be checked'], unchecked: ['docs/receipts/084-1a2b3c4d.json'] });
    try {
      assert.equal(merge(m), code, mode);
      assert.match(printed(m), /^note {2}findings: docs\/receipts\/084-1a2b3c4d\.json: its session record cannot be read again/m);
      assert.match(printed(m), /findings: the counts of 1 review receipt on this branch cannot be checked against the reviewer's session record, so how many answers are owed is not known\.\n {2}docs\/receipts\/084-1a2b3c4d\.json\nEither put each session record back at the path its receipt names \(the "session" line inside the receipt file\), or make the receipt again from where the record is now \(node scripts\/receipt\.mjs make <reviewer session file>\) and delete the old receipt file in the same commit\. The old file must go: while it is on the branch it still counts as a round nobody can check\. Then push, and run this again\./);
    } finally { m.cleanup(); }
  }
});

// ---------- Review of kit 5.1, round 2 ----------

test('round 2, finding 1: a commit that needs a receipt only because of a watching gate is not stopped by the enforcing receipts gate', () => {
  const doc = { ...C1, subject: 'docs: update the handoff', files: ['docs/handoff.md'] };
  const m = withLevel(withEvents(fakeMachine({ ...ON({ events: true, reviewReceipts: 'enforce', securityReview: 'observe' }, { highRiskPaths: ['docs/handoff.md'] }), files: ['docs/handoff.md'], numstat: '1\t0\tdocs/handoff.md\n', nameStatus: z('M', 'docs/handoff.md') })), DEEP);
  // Both readers answer as the real ones do: the docs commit needs a receipt only when it is not paperwork.
  m.ctx.checkReceipts = (args) => (args.isPaperwork('docs/handoff.md') ? { uncovered: [], covered: 0, notes: [] } : { uncovered: [{ ...doc, why: 'no approving receipt' }], covered: 0, notes: [] });
  m.ctx.approvals = (args) => ({ needed: args.isPaperwork('docs/handoff.md') ? [] : [doc], usable: [], notes: [] });
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.match(printed(m), /^pass {2}receipts \(0 commits covered/m);
    assert.deepEqual(wouldBlock(m).map((d) => d.gate), ['securityReview'], 'the watching gate reports it');
    assert.equal(types(m).at(-1), 'merged');
  } finally { m.cleanup(); }
  // reviewScope: with own given, a switch widens only when it enforces or is the asking gate's own.
  const scope = guardScope(settings({ features: { reviewReceipts: 'enforce', securityReview: 'observe', changeChecklist: 'observe', reviewLevels: 'off' }, highRiskPaths: ['docs/private/'] }));
  const rows = [{ id: 'CL-1', paths: ['docs/api/**'] }];
  const paper = (own) => ['docs/private/plan.md', 'docs/api/words.md'].map(reviewScope(scope, { items: rows, pathMatches, own }).isPaperwork);
  assert.deepEqual(paper([]), [true, true], 'the receipts gate: nothing that only watches');
  assert.deepEqual(paper(['securityReview']), [false, true]);
  assert.deepEqual(paper(['changeChecklist']), [true, false]);
  assert.deepEqual(paper(undefined), [false, false], 'the reviewer is shown every commit any gate may ask about');
  const strict = guardScope(settings({ features: { securityReview: 'enforce' }, highRiskPaths: ['docs/private/'] }));
  assert.equal(reviewScope(strict, { own: [] }).isPaperwork('docs/private/plan.md'), false, 'an enforcing switch counts for every gate');
});

test('round 2, finding 1: an enforcing level gate is not asked about a commit only a watching checklist row needs reviewed', () => {
  const row = { id: 'CL-1', paths: ['docs/api/**'], check: 'The public page says the same' };
  const m = withLevel(withChecklist(withEvents(fakeMachine({ ...ON({ events: true, reviewLevels: 'enforce', changeChecklist: 'observe' }), files: ['docs/api/words.md'], numstat: '1\t0\tdocs/api/words.md\n', nameStatus: z('M', 'docs/api/words.md') })), [row]), STANDARD);
  const doc = { ...C1, files: ['docs/api/words.md'] };
  const asks = [];
  m.ctx.approvals = (args) => { asks.push(args.isPaperwork('docs/api/words.md')); return { needed: args.isPaperwork('docs/api/words.md') ? [] : [doc], usable: [], notes: [] }; };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(asks, [false, true], 'the checklist gate sees the docs commit; the level gate does not');
    assert.deepEqual(wouldBlock(m).map((d) => d.gate), ['changeChecklist']);
  } finally { m.cleanup(); }
});

test('round 2, finding 2: only a checklist row that fits the change, "and adds" part included, makes a docs commit need a review', () => {
  const m = fakeMachine({ ...ON({ reviewReceipts: 'enforce', changeChecklist: 'enforce' }), files: ['docs/handoff.md'] });
  const row = { id: 'CL-1', paths: ['docs/handoff.md'], adds: 'migration', check: 'The migration is listed' };
  m.ctx.pathMatches = pathMatches;
  m.ctx.checklistFor = () => ({ present: true, items: [row], matched: [], problems: [] }); // a typo fix: the row's paths, but no "migration" added
  const asked = [];
  m.ctx.checkReceipts = (args) => { asked.push(args.isPaperwork('docs/handoff.md')); return { uncovered: [], covered: 0, notes: [] }; };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(asked, [true], 'the row does not fit, so the file is still paperwork for the receipts gate');
    assert.match(printed(m), /pass {2}checklist \(no row of the change checklist fits this change\)/);
  } finally { m.cleanup(); }
  const fits = fakeMachine({ ...ON({ reviewReceipts: 'enforce', changeChecklist: 'enforce' }), files: ['docs/handoff.md'] });
  fits.ctx.pathMatches = pathMatches;
  fits.ctx.checklistFor = () => ({ present: true, items: [row], matched: [row], problems: [] });
  fits.ctx.checkReceipts = (args) => { asked.push(args.isPaperwork('docs/handoff.md')); return { uncovered: [], covered: 0, notes: [] }; };
  withReviews(fits, [], []);
  try {
    merge(fits);
    assert.equal(asked[1], false, 'a row that fits does');
  } finally { fits.cleanup(); }
});

test('round 2, finding 5: the stamp message compares the commit it names with the real tip of the branch, a merge commit included', () => {
  const docsMerge = { sha: SHA('c'), parents: 'p1 p2', message: 'Merge branch docs-work\n', files: [] };
  const m = withCommits(newGate('verifiedStamp', 'enforce'), [docsMerge, said('Verified: none', ['src/app.ts'], SHA('b'))]);
  try {
    assertStopped(m, 'verified');
    assert.match(printed(m), /^The newest commit that changes product code is bbbbbbb\. It is not the last commit made on this branch \(ccccccc is\), so "git commit --amend" would reword the wrong one\.$/m);
    assert.doesNotMatch(printed(m), /so "git commit --amend" rewords it/);
  } finally { m.cleanup(); }
});

// ---------- Post-merge worktree cleanup ----------

test('post-merge cleanup runs after a successful merge with baseRef, branch, commit, and noFetch, and --no-clean skips it', () => {
  const m = fakeMachine();
  const calls = [];
  m.ctx.cleanWorktrees = (arg) => { calls.push(arg); return { line: 'note  worktrees: Done. Removed 1 worktrees. No branch was deleted.' }; };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(calls, [{ baseRef: 'origin/main', branch: 'lead/notes', commit: 'headsha', noFetch: true }]);
    assert.match(printed(m), /note {2}worktrees: Done\. Removed 1 worktrees\./);

    calls.length = 0;
    assert.equal(merge(m, { noClean: true }), EXIT.ok);
    assert.deepEqual(calls, [], '--no-clean skips cleanup');
  } finally { m.cleanup(); }
});

test('post-merge cleanup does not run on --check, queued merges, or failed merges, and a cleanup error never fails a merge', () => {
  const checked = fakeMachine({ branch: 'lead/notes' });
  const checkCalls = [];
  checked.ctx.cleanWorktrees = (arg) => { checkCalls.push(arg); };
  try {
    assert.equal(checkOnly(parseArgs(['--check']), checked.ctx), EXIT.ok);
    assert.deepEqual(checkCalls, []);
  } finally { checked.cleanup(); }

  const failed = fakeMachine({ ghFail: { merge: 1 } });
  const failCalls = [];
  failed.ctx.cleanWorktrees = (arg) => { failCalls.push(arg); };
  try {
    assert.equal(merge(failed), EXIT.failed);
    assert.deepEqual(failCalls, []);
  } finally { failed.cleanup(); }

  const queued = withEvents(fakeMachine({ ...EVENTS(), mergeQueued: true }));
  const queueCalls = [];
  queued.ctx.cleanWorktrees = (arg) => { queueCalls.push(arg); };
  try {
    assert.equal(merge(queued), EXIT.ok);
    assert.deepEqual(queueCalls, [], 'queued pull request with empty gh merge output does not run cleanup');
    assert.equal(types(queued).includes('merged'), false, 'queued pull request is not recorded as merged');
    assert.match(printed(queued), /not merged yet/);
    assert.match(printed(queued), /worktree cleanup skipped: pull request is not in MERGED state yet/);
  } finally { queued.cleanup(); }

  const broken = fakeMachine();
  broken.ctx.cleanWorktrees = () => { throw new Error('lsof boom'); };
  try {
    assert.equal(merge(broken), EXIT.ok);
    assert.match(printed(broken), /note {2}worktree cleanup skipped: lsof boom/);
  } finally { broken.cleanup(); }
});

test('post-merge fetch runs while mergeLock is held, and mergeLock is released before cleanWorktrees runs', () => {
  const m = fakeMachine({ config: { features: { mergeLock: true } }, baseConfig: { checks: CHECKS, features: { mergeLock: true } } });
  const order = [];
  const origGit = m.ctx.git;
  const origRun = m.ctx.run;
  writeFileSync(join(m.root, 'scripts', 'slot.mjs'), '// stub\n');
  m.ctx.git = (args, input) => {
    if (args[0] === 'fetch' && args.includes('--prune')) order.push('post-fetch');
    return origGit(args, input);
  };
  m.ctx.run = (cmd, args, opts) => {
    if (args[0]?.endsWith('slot.mjs') && args[1] === 'release') order.push('release-lock');
    return origRun(cmd, args, opts);
  };
  m.ctx.cleanWorktrees = (arg) => { order.push(`clean(noFetch=${arg.noFetch})`); return { line: 'note  worktrees: Done. Removed 0 worktrees.' }; };
  try {
    assert.equal(merge(m), EXIT.ok);
    assert.deepEqual(order, ['post-fetch', 'release-lock', 'clean(noFetch=true)']);
  } finally { m.cleanup(); }
});

test('runPostMergeCleanup passes expected flags and reports success, partial failure, timeout, and hard error accurately', () => {
  const seen = [];
  const fakeScript = SCRIPT;
  const sha = 'a'.repeat(40);
  const ok = runPostMergeCleanup({
    baseRef: 'origin/main',
    branch: 'build/001-x',
    commit: sha,
    noFetch: true,
    root: '/tmp/repo',
    scriptPath: fakeScript,
    execFn: (cmd, args) => {
      seen.push({ cmd, args });
      return { code: 0, stdout: 'Done. Removed 2 worktrees. No branch was deleted.\n', stderr: '' };
    },
  });
  assert.deepEqual(seen[0].args, [fakeScript, '--delete', '--no-fetch', '--base', 'origin/main', '--merged-branch', 'build/001-x', '--merged-commit', sha]);
  assert.equal(ok.line, 'note  worktrees: Done. Removed 2 worktrees. No branch was deleted.');

  const partial = runPostMergeCleanup({
    baseRef: 'origin/main',
    branch: 'build/001-x',
    root: '/tmp/repo',
    scriptPath: fakeScript,
    execFn: () => ({ code: 1, stdout: '/wt/a [x]\n  removed.\n/wt/b [y]\n  could not remove it: permission denied\nDone. Removed 1 worktrees; 1 could not be removed. No branch was deleted.\n', stderr: '' }),
  });
  assert.equal(partial.line, 'note  worktrees (partial): Done. Removed 1 worktrees; 1 could not be removed. No branch was deleted. (could not remove it: permission denied)');

  const timedOut = runPostMergeCleanup({
    baseRef: 'origin/main',
    branch: 'build/001-x',
    root: '/tmp/repo',
    scriptPath: fakeScript,
    execFn: () => ({ code: 124, stdout: '', stderr: 'ETIMEDOUT', timedOut: true }),
  });
  assert.match(timedOut.line, /cleanup timed out after 120 s/);

  const skipped = runPostMergeCleanup({
    baseRef: 'origin/main',
    branch: 'build/001-x',
    root: '/tmp/repo',
    scriptPath: fakeScript,
    execFn: () => ({ code: 1, stdout: '', stderr: 'Could not list open pull requests' }),
  });
  assert.equal(skipped.line, 'note  worktree cleanup skipped: Could not list open pull requests');
});

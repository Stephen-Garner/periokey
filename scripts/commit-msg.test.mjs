// Tests for commit-msg.mjs. Run: node --test scripts/commit-msg.test.mjs
// Pure parts are tested with a fake git. Two tests run the real hook through "git commit" in a temp repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPES, addSliceLine, addTrailerLines, branchSlice, checkMessage, contentLines, parseBug, parseMessage, parseVerified, run } from './commit-msg.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const exists = (ids) => (id) => ids.includes(id.toLowerCase());
const ctx = (over = {}) => ({ slice: null, commitExists: exists([]), ...over });
const check = (text, over) => checkMessage(text, ctx(over));
const ok = (text, over) => assert.deepEqual(check(text, over).problems, [], text);
const bad = (text, pattern, over) => {
  const r = check(text, over);
  assert.ok(r.problems.length, `should be refused: ${text}`);
  assert.match(r.problems.join('\n'), pattern);
};

test('the first line: every allowed type, with and without a scope or a "!"', () => {
  for (const type of TYPES) {
    if (type === 'fix') continue; // needs a Fixes line, tested below
    ok(`${type}: do the thing`);
    ok(`${type}(auth): do the thing`);
    ok(`${type}!: do the thing`);
  }
});

test('the first line: wrong shapes are refused', () => {
  bad('Update the readme', /type: description/);
  bad('feature: add a thing', /must be one of/);
  bad('Feat: add a thing', /type: description/);
  bad('feat:add a thing', /type: description/);
  bad('feat: ', /type: description/);
  bad('feat(): add a thing', /type: description/);
  bad('feat (auth): add a thing', /type: description/);
  bad('', /empty/);
  bad('# only a git comment\n', /empty/);
});

test('the first line: 100 characters pass, 101 are refused', () => {
  ok(`feat: ${'a'.repeat(94)}`);
  bad(`feat: ${'a'.repeat(95)}`, /101 characters/);
});

test('git comments and the verbose diff are ignored', () => {
  ok('feat: add a thing\n\n# Please enter the commit message\n# On branch main\n');
  bad('# feat: add a thing\nupdate stuff\n', /type: description/);
  const verbose = 'feat: add a thing\n\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n';
  ok(verbose);
  assert.deepEqual(contentLines(verbose), ['feat: add a thing', '']);
});

test('merge commits, git reverts, and fixup, squash, amend lines pass untouched', () => {
  for (const line of ['Merge pull request #7 from o/build/007-x', 'Merge branch main into x', 'Revert "feat: add a thing"', 'fixup! feat: add a thing', 'squash! fix: x', 'amend! docs: y']) {
    const r = check(line, { slice: '007' });
    assert.equal(r.skipped, true, line);
    assert.deepEqual(r.problems, []);
    assert.equal(r.addSlice, null, `a skipped message gains no Slice line: ${line}`);
  }
});

test('parseMessage reads trailers from the last paragraph only', () => {
  const p = parseMessage('feat: x\n\nSome-Key: not a trailer\n\nSlice: 007\nCo-Authored-By: A <a@b.c>\n');
  assert.deepEqual(p.trailers.map((t) => t.key), ['Slice', 'Co-Authored-By']);
  assert.equal(p.block, true);
  assert.deepEqual(parseMessage('fix: Fixes: abc1234').trailers, [], 'the first line is never a trailer');
  assert.equal(parseMessage('feat: x\n\nA sentence.\nSlice: 007').block, false, 'prose in the last paragraph: not a pure trailer block');
});

test('Slice: must be a whole number, and match the branch on a build branch', () => {
  bad('feat: x\n\nSlice: seven', /not a whole number/);
  bad('feat: x\n\nSlice: 7a', /not a whole number/);
  ok('feat: x\n\nSlice: 007');
  ok('feat: x\n\nSlice: 7', { slice: '007' });
  bad('feat: x\n\nSlice: 008', /slice 007.*Slice: 008/, { slice: '007' });
  ok('feat: x\n\nSlice: 008', { slice: null });
});

test('Slice: is added only when the branch has a number and the message has none', () => {
  assert.equal(check('feat: x', { slice: '007' }).addSlice, '007');
  assert.equal(check('feat: x', { slice: null }).addSlice, null);
  assert.equal(check('feat: x\n\nSlice: 007', { slice: '007' }).addSlice, null);
});

test('addSliceLine: after a blank line, joined to the trailer block, keeps Co-Authored-By', () => {
  assert.equal(addSliceLine('feat: x\n', '007'), 'feat: x\n\nSlice: 007\n');
  assert.equal(addSliceLine('feat: x', '007'), 'feat: x\n\nSlice: 007');
  assert.equal(addSliceLine('feat: x\n\nThe body.\n', '007'), 'feat: x\n\nThe body.\n\nSlice: 007\n');
  assert.equal(
    addSliceLine('feat: x\n\nThe body.\n\nCo-Authored-By: A <a@b.c>\n', '007'),
    'feat: x\n\nThe body.\n\nCo-Authored-By: A <a@b.c>\nSlice: 007\n',
  );
  assert.equal(
    addSliceLine('feat: x\n\nFixes: unknown\nCo-Authored-By: A <a@b.c>\n', '007'),
    'feat: x\n\nFixes: unknown\nCo-Authored-By: A <a@b.c>\nSlice: 007\n',
  );
});

test('addSliceLine: goes before git comments, not after them', () => {
  assert.equal(addSliceLine('feat: x\n\n# Please enter a message\n# On branch b\n', '007'), 'feat: x\n\nSlice: 007\n\n# Please enter a message\n# On branch b\n');
  assert.equal(addSliceLine('feat: x\n# note\n\n# ------------------------ >8 ------------------------\ndiff\n', '007'), 'feat: x\n\nSlice: 007\n# note\n\n# ------------------------ >8 ------------------------\ndiff\n');
});

test('a fix needs Fixes: with a real commit id or the word unknown', () => {
  bad('fix: stop the crash', /Fixes: <id>.*Fixes: unknown.*counts/s);
  bad('fix(auth): stop the crash\n\nBody only.', /needs a "Fixes:" line/);
  ok('fix: stop the crash\n\nFixes: unknown');
  ok('fix: stop the crash\n\nFixes: abc1234', { commitExists: exists(['abc1234']) });
  ok('fix: stop the crash\n\nFixes: ABC1234', { commitExists: exists(['abc1234']) });
  bad('fix: stop the crash\n\nFixes: abc1234', /not in this repo/);
  bad('fix: stop the crash\n\nFixes: abc12', /not a commit id/);
  bad('fix: stop the crash\n\nFixes: the login commit', /not a commit id/);
  bad('fix: stop the crash\n\nFixes: ' + 'a'.repeat(41), /not a commit id/);
  ok('fix: stop the crash\n\nFixes: ' + 'a'.repeat(40), { commitExists: exists(['a'.repeat(40)]) });
  ok('feat: add a thing');
});

test('only a fix needs Fixes:, and the refusal for a fix shows a fix example', () => {
  ok('feat: x');
  ok('refactor: x');
  assert.match(check('fix: x').example, /^fix\(login\):.*\n\nFixes: unknown$/s);
  assert.match(check('nonsense').example, /^feat: /);
});

test('branchSlice reads the number after the build prefix, and the setting', () => {
  assert.equal(branchSlice('build/007-x', 'build/'), '007');
  assert.equal(branchSlice('feature/012-y', 'feature/'), '012');
  assert.equal(branchSlice('build/007-x', 'feature/'), null);
  assert.equal(branchSlice('build/x', 'build/'), null);
  assert.equal(branchSlice('lead/007-x', 'build/'), null);
  assert.equal(branchSlice(null, 'build/'), null);
});

// ---------- run(), with a fake git and a message file ----------

function runWith(text, { branch = 'main', ids = [], argv } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'commit-msg-run-'));
  const file = join(dir, 'MSG');
  writeFileSync(file, text);
  const logs = { out: '', err: '', calls: [] };
  const git = (args) => {
    logs.calls.push(args.join(' '));
    if (args[0] === 'symbolic-ref') {
      if (branch === null) throw new Error('detached');
      return `${branch}\n`;
    }
    if (args[0] === 'cat-file') {
      if (ids.some((id) => args[2].startsWith(id))) return '';
      throw new Error('missing');
    }
    throw new Error(`unexpected git call: ${args}`);
  };
  const code = run(argv || [file], { cwd: dir, git, stdout: (s) => (logs.out += s), stderr: (s) => (logs.err += s) });
  const after = readFileSync(file, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { code, after, ...logs };
}

test('run: usage errors exit 2', () => {
  assert.equal(runWith('', { argv: [] }).code, 2);
  assert.equal(runWith('', { argv: ['a', 'b'] }).code, 2);
  const r = runWith('', { argv: ['/no/such/file'] });
  assert.equal(r.code, 2);
  assert.match(r.err, /Cannot read/);
});

test('run: a good message exits 0; off a build branch it gains only Verified: none', () => {
  const r = runWith('feat: add a thing\n');
  assert.equal(r.code, 0);
  assert.equal(r.after, 'feat: add a thing\n\nVerified: none\n');
});

test('run: a bad message exits 1, says what is wrong, and shows an example', () => {
  const r = runWith('did stuff\n');
  assert.equal(r.code, 1);
  assert.match(r.err, /Commit message refused/);
  assert.match(r.err, /"did stuff"/);
  assert.match(r.err, /A correct message looks like this:\n\n  feat: add the save button/);
});

test('run: on a build branch the Slice line is added and a wrong one is refused', () => {
  const added = runWith('feat: add a thing\n\nCo-Authored-By: A <a@b.c>\n', { branch: 'build/007-save-word' });
  assert.equal(added.code, 0);
  assert.equal(added.after, 'feat: add a thing\n\nCo-Authored-By: A <a@b.c>\nSlice: 007\nVerified: none\n', 'added lines: Slice first, then Verified');
  const wrong = runWith('feat: add a thing\n\nSlice: 009\n', { branch: 'build/007-save-word' });
  assert.equal(wrong.code, 1);
  assert.equal(wrong.after, 'feat: add a thing\n\nSlice: 009\n', 'a refused message is left as it was');
});

test('run: a fix checks the commit id with git cat-file', () => {
  const good = runWith('fix: stop the crash\n\nFixes: abc1234\n', { ids: ['abc1234'] });
  assert.equal(good.code, 0);
  assert.ok(good.calls.includes('cat-file -e abc1234^{commit}'));
  assert.equal(runWith('fix: stop the crash\n\nFixes: abc1234\n').code, 1);
  assert.equal(runWith('fix: stop the crash\n\nFixes: unknown\n').code, 0);
  assert.equal(runWith('fix: stop the crash\n').code, 1);
});

test('run: a detached head is not a build branch', () => {
  const r = runWith('feat: add a thing\n\nVerified: tests\n', { branch: null });
  assert.equal(r.code, 0);
  assert.equal(r.after, 'feat: add a thing\n\nVerified: tests\n', 'nothing to add: a Slice line needs a build branch, and Verified is there');
});

test('Verified: the grammar, and what parseVerified returns', () => {
  const v = (line) => parseVerified(`feat: x\n\n${line}\n`);
  assert.deepEqual(v('Verified: none'), { kinds: [], none: true, note: null });
  assert.deepEqual(v('Verified: none (docs only, nothing to run)'), { kinds: [], none: true, note: 'docs only, nothing to run' });
  assert.deepEqual(v('Verified: ran'), { kinds: ['ran'], none: false, note: null });
  assert.deepEqual(v('Verified: ran, tests, checks'), { kinds: ['ran', 'tests', 'checks'], none: false, note: null });
  assert.deepEqual(v('Verified: tests,checks (the unit tests (all) and lint)'), { kinds: ['tests', 'checks'], none: false, note: 'the unit tests (all) and lint' });
  assert.deepEqual(v('Verified: ran, ran'), { kinds: ['ran'], none: false, note: null }, 'a repeated word counts once');
  for (const bad of ['Verified: yes', 'Verified: none, ran', 'Verified: ran tests', 'Verified: ran,', 'Verified: ran ()', 'Verified: RAN', 'Verified: ran (note) extra', 'Verified:', 'Verified: lint']) {
    assert.equal(v(bad), null, bad);
  }
  assert.equal(parseVerified('feat: x\n\nSlice: 007\n'), null, 'no line: null');
  assert.deepEqual(parseVerified('feat: x\n\nSlice: 007\nVerified: tests\nCo-Authored-By: A <a@b.c>\n'), { kinds: ['tests'], none: false, note: null }, 'among other trailers');
  assert.equal(parseVerified('Verified: ran'), null, 'the first line is not a trailer');
  assert.equal(parseVerified('feat: x\n\nVerified: ran\n\nA closing paragraph.\n'), null, 'only the last paragraph counts');
});

test('Verified: a missing line is added, a good one is kept, a bad one is refused with the grammar and two examples', () => {
  assert.equal(check('feat: x').addVerified, true);
  assert.equal(check('feat: x\n\nSlice: 007').addVerified, true);
  assert.equal(check('feat: x\n\nVerified: ran (note)').addVerified, false);
  assert.equal(check('Merge pull request #7 from o/x').addVerified, false, 'merges are left alone');
  assert.equal(check('Revert "feat: x"').addVerified, false);
  assert.equal(check('fixup! feat: x').addVerified, false);
  bad('feat: x\n\nVerified: yes', /"Verified: yes" does not fit[\s\S]*ran[\s\S]*tests[\s\S]*checks[\s\S]*Verified: ran, tests \([\s\S]*Verified: none \(/);
  bad('feat: x\n\nVerified:', /does not fit/);
  bad('feat: x\n\nVerified: ran\nVerified: none', /more than one "Verified:"/);
  assert.equal(check('feat: x\n\nVerified: yes').addVerified, false, 'a bad line is never papered over with a new one');
});

test('addTrailerLines: Slice then Verified, at the end of the block, after Co-Authored-By', () => {
  assert.equal(addTrailerLines('feat: x\n', ['Slice: 007', 'Verified: none']), 'feat: x\n\nSlice: 007\nVerified: none\n');
  assert.equal(addTrailerLines('feat: x\n\nThe body.\n', ['Verified: none']), 'feat: x\n\nThe body.\n\nVerified: none\n');
  assert.equal(addTrailerLines('feat: x\n\nSlice: 007\nCo-Authored-By: A <a@b.c>\n', ['Verified: none']), 'feat: x\n\nSlice: 007\nCo-Authored-By: A <a@b.c>\nVerified: none\n');
  const msg = addTrailerLines('feat: x\n', ['Slice: 007', 'Verified: none']);
  const again = check(msg, { slice: '007' });
  assert.deepEqual([again.problems, again.addSlice, again.addVerified], [[], null, false], 'what the hook added is not added twice');
});

test('Bug: optional, one sentence of 15 to 200 characters; parseBug returns it or null', () => {
  const fix = (bug) => `fix: stop the crash\n\nFixes: unknown\nBug: ${bug}\nVerified: tests\n`;
  ok(fix('a'.repeat(15)));
  ok(fix('a'.repeat(200)));
  bad(fix('a'.repeat(14)), /"Bug:" line must be one sentence of 15 to 200.*Yours is 14/);
  bad(fix('a'.repeat(201)), /Yours is 201/);
  bad('fix: x\n\nFixes: unknown\nBug:\n', /Yours is 0/);
  bad('fix: x\n\nFixes: unknown\nBug: one sentence that is long enough\nBug: another that is long enough\n', /more than one "Bug:"/);
  ok('fix: x\n\nFixes: unknown\nVerified: none\n');
  assert.equal(parseBug(fix('saving a word with an accent crashed the app')), 'saving a word with an accent crashed the app');
  assert.equal(parseBug(fix('too short')), null);
  assert.equal(parseBug(fix('a'.repeat(201))), null);
  assert.equal(parseBug('fix: x\n\nFixes: unknown\n'), null);
  assert.equal(parseBug('fix: x\n\nBug: a sentence in the first of two paragraphs.\n\nFixes: unknown\n'), null, 'only the last paragraph counts');
});

test('Slice, Fixes, Bug, and Verified lines together do not confuse one another', () => {
  const msg = 'fix(a): stop it\n\nFixes: abc1234\nBug: the second save lost the first word\nSlice: 007\nVerified: ran, tests\nCo-Authored-By: A <a@b.c>\n';
  const r = check(msg, { slice: '007', commitExists: exists(['abc1234']) });
  assert.deepEqual([r.problems, r.addSlice, r.addVerified], [[], null, false]);
  assert.deepEqual(parseVerified(msg), { kinds: ['ran', 'tests'], none: false, note: null });
  assert.equal(parseBug(msg), 'the second save lost the first word');
  assert.deepEqual(parseMessage(msg).trailers.map((t) => t.key), ['Fixes', 'Bug', 'Slice', 'Verified', 'Co-Authored-By']);
});

test('a stamp in a paragraph that also has prose is not lost when the hook adds Slice: (the lines are moved into the block it writes)', () => {
  const r = runWith('feat: x\n\nSome prose.\nVerified: tests\n', { branch: 'build/001-x' });
  assert.equal(r.code, 0);
  assert.equal(r.after, 'feat: x\n\nSome prose.\n\nVerified: tests\nSlice: 001\n');
  assert.deepEqual(parseVerified(r.after), { kinds: ['tests'], none: false, note: null });
  const fix = runWith('fix: x\n\nWhat happened.\nFixes: abc1234\nBug: the second save lost the first word\nCo-Authored-By: A <a@b.c>\n', { branch: 'build/001-x', ids: ['abc1234'] });
  assert.equal(fix.code, 0);
  assert.equal(fix.after, 'fix: x\n\nWhat happened.\n\nFixes: abc1234\nBug: the second save lost the first word\nCo-Authored-By: A <a@b.c>\nSlice: 001\nVerified: none\n');
  const emptied = runWith('feat: x\n\nVerified:ran\n', { branch: 'build/001-x' });
  assert.equal(emptied.after, 'feat: x\n\nVerified:ran\nSlice: 001\n', 'a paragraph that was only trailers stays one block, with no blank line added');
});

test('what the hook accepts is what the later scripts read: every shape, with and without a build branch', () => {
  const shapes = [
    'feat: x',
    'feat: x\n\nBody only.',
    'feat: x\n\nSome prose.\nVerified: tests',
    'feat: x\n\nSome prose.\nVerified: none (docs only, nothing to run)\nCo-Authored-By: A <a@b.c>',
    'feat: x\n\nVerified: ran, checks\nSome prose after it.',
    'feat: x\n\nVerified:ran',
    'fix: x\n\nWhat happened.\nFixes: abc1234\nBug: the second save lost the first word',
    'fix: x\n\nFixes: unknown\nWhat happened.\nBug: the second save lost the first word\nSlice: 1',
    'fix: x\n\nFixes: abc1234\nSlice: 001\nVerified: tests',
    'fix: x\n\nVerified: ran\n\nFixes: unknown',
    'feat: x\n\n# a git comment\nSome prose.\n# another\nVerified: tests\n# more',
  ];
  for (const text of shapes) {
    for (const branch of ['main', 'build/001-x']) {
      const before = check(text, { slice: branch === 'main' ? null : '001', commitExists: exists(['abc1234']) });
      const r = runWith(`${text}\n`, { branch, ids: ['abc1234'] });
      assert.equal(r.code, before.problems.length ? 1 : 0, `${branch}: ${text}`);
      if (before.problems.length) continue;
      const final = checkMessage(r.after, { slice: branch === 'main' ? null : '001', commitExists: exists(['abc1234']) });
      assert.deepEqual([final.problems, final.addSlice, final.addVerified], [[], null, false], `final message is complete: ${branch}: ${text}`);
      const stamped = parseVerified(`${text}\n`);
      assert.deepEqual(parseVerified(r.after), before.addVerified ? { kinds: [], none: true, note: null } : stamped, `parseVerified agrees with the hook: ${branch}: ${text}`);
      const fixes = (m) => parseMessage(m).trailers.filter((t) => ['fixes', 'bug'].includes(t.key.toLowerCase())).map((t) => `${t.key}: ${t.value}`);
      assert.deepEqual(fixes(r.after), fixes(`${text}\n`), `Fixes and Bug lines stay readable: ${branch}: ${text}`);
      assert.equal(parseBug(r.after), parseBug(`${text}\n`));
      if (branch !== 'main') assert.deepEqual(parseMessage(r.after).trailers.filter((t) => t.key === 'Slice').map((t) => Number(t.value)), [1], 'one Slice line, in the last paragraph');
    }
  }
});

test('a trailer moves with its continuation lines, and git reads the same trailers before and after', () => {
  const parse = (m) => spawnSync('git', ['interpret-trailers', '--parse'], { input: m, encoding: 'utf8' }).stdout.trim().split('\n');
  const before = 'feat: x\n\nSome prose.\nSigned-off-by: Person Name\n <person@example.com>\nVerified: tests\n';
  assert.deepEqual(parse(before), ['Signed-off-by: Person Name <person@example.com>', 'Verified: tests'], 'git reads the sign-off with its email');
  const r = runWith(before, { branch: 'build/011-x' });
  assert.equal(r.code, 0);
  assert.equal(r.after, 'feat: x\n\nSome prose.\n\nSigned-off-by: Person Name\n <person@example.com>\nVerified: tests\nSlice: 011\n');
  assert.deepEqual(parse(r.after), [...parse(before), 'Slice: 011']);
  assert.deepEqual(parseVerified(r.after), { kinds: ['tests'], none: false, note: null });
  const tabbed = runWith('feat: x\n\nSome prose.\nCo-Authored-By: A\n\t<a@b.c>\nMore prose.\n  indented prose\n', { branch: 'build/011-x' });
  assert.equal(tabbed.after, 'feat: x\n\nSome prose.\nMore prose.\n  indented prose\n\nCo-Authored-By: A\n\t<a@b.c>\nSlice: 011\nVerified: none\n', 'only the lines right after a trailer go with it');
});

// ---------- the real hook, through "git commit" ----------

// The hook is at .githooks/commit-msg in an installed project, at scripts/githooks/commit-msg in the kit.
function hookPath() {
  const options = [join(HERE, '..', '.githooks', 'commit-msg'), join(HERE, 'githooks', 'commit-msg')];
  const found = options.find((p) => existsSync(p));
  assert.ok(found, `The commit-msg hook is missing. Looked in: ${options.join(' and ')}`);
  return found;
}

function makeRepo(settings) {
  const root = mkdtempSync(join(tmpdir(), 'commit-msg-repo-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, '.githooks'));
  copyFileSync(join(HERE, 'commit-msg.mjs'), join(root, 'scripts', 'commit-msg.mjs'));
  copyFileSync(join(HERE, 'check-plans.mjs'), join(root, 'scripts', 'check-plans.mjs'));
  copyFileSync(hookPath(), join(root, '.githooks', 'commit-msg'));
  chmodSync(join(root, '.githooks', 'commit-msg'), 0o755);
  if (settings) writeFileSync(join(root, 'scripts', 'kit.config.json'), JSON.stringify(settings));
  g('config', 'core.hooksPath', '.githooks');
  return { root, g };
}

const commit = (root, message) => spawnSync('git', ['commit', '--allow-empty', '-F', '-'], { cwd: root, input: message, encoding: 'utf8' });

test('real hook: a bad message is refused by git commit, a good one on a build branch gains Slice: 007', () => {
  const { root, g } = makeRepo();
  try {
    const refused = commit(root, 'did some stuff\n');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Commit message refused/);
    assert.match(refused.stderr, /Commit blocked by the message check/);
    assert.throws(() => g('rev-parse', '--verify', 'HEAD'), 'no commit was made');

    g('checkout', '-q', '-b', 'build/007-x');
    const done = commit(root, 'feat: add a thing\n\nCo-Authored-By: A <a@b.c>\n');
    assert.equal(done.status, 0, done.stderr);
    assert.equal(g('log', '-1', '--format=%B').trim(), 'feat: add a thing\n\nCo-Authored-By: A <a@b.c>\nSlice: 007\nVerified: none');

    const wrongSlice = commit(root, 'feat: another\n\nSlice: 008\n');
    assert.notEqual(wrongSlice.status, 0);
    assert.match(wrongSlice.stderr, /slice 007/);

    const badStamp = commit(root, 'feat: third\n\nVerified: maybe\n');
    assert.notEqual(badStamp.status, 0);
    assert.match(badStamp.stderr, /Verified: ran, tests/);
    const stamped = commit(root, 'feat: fourth\n\nVerified: ran, tests (tried it)\n');
    assert.equal(stamped.status, 0, stamped.stderr);
    assert.equal(g('log', '-1', '--format=%B').trim(), 'feat: fourth\n\nVerified: ran, tests (tried it)\nSlice: 007');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real hook: Fixes: is checked against this repo, and the buildPrefix setting is used', () => {
  const { root, g } = makeRepo({ buildPrefix: 'feature/' });
  try {
    assert.equal(commit(root, 'chore: first\n').status, 0);
    const first = g('rev-parse', '--short', 'HEAD').trim();
    assert.notEqual(commit(root, 'fix: oops\n').status, 0, 'a fix with no Fixes line');
    assert.notEqual(commit(root, 'fix: oops\n\nFixes: 1234567\n').status, 0, 'an id that is not in the repo');
    assert.equal(commit(root, `fix: oops\n\nFixes: ${first}\n`).status, 0);
    assert.equal(commit(root, 'fix: oops again\n\nFixes: unknown\n').status, 0);

    g('checkout', '-q', '-b', 'build/007-x');
    commit(root, 'feat: not a build branch here\n');
    assert.doesNotMatch(g('log', '-1', '--format=%B'), /Slice:/, 'build/ is not the prefix in this repo');
    g('checkout', '-q', '-b', 'feature/012-y');
    assert.equal(commit(root, 'feat: yes\n').status, 0);
    assert.match(g('log', '-1', '--format=%B'), /Slice: 012/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

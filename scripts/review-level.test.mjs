// Tests for review-level.mjs. Run: node --test scripts/review-level.test.mjs
// The git tests make a throwaway repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LEVELS, QUICK_MAX_LINES, joinSettings, levelFor, reviewLevel, run } from './review-level.mjs';

const level = (input) => reviewLevel(input).level;
const QUICK = { quickReviewPaths: ['docs/', 'README.md'], quickReviewMaxLines: 50 };

// ---------- reviewLevel ----------

test('the levels are quick, standard, deep, lowest first', () => {
  assert.deepEqual([...LEVELS], ['quick', 'standard', 'deep']);
  assert.equal(QUICK_MAX_LINES, 50);
});

test('deep when the change touches a high-risk folder or file, and the reason names both', () => {
  const folder = reviewLevel({ files: ['README.md', 'src/auth/login.ts'], lines: 3, highRiskPaths: ['src/auth/'] });
  assert.deepEqual(folder, { level: 'deep', why: 'the change touches the high-risk path src/auth/ (src/auth/login.ts)' });
  assert.equal(level({ files: ['billing.config.js'], lines: 1, highRiskPaths: ['billing.config.js'] }), 'deep');
});

test('a path beside a high-risk one is not high-risk', () => {
  assert.equal(level({ files: ['src/auth-notes/x.md'], lines: 1, highRiskPaths: ['src/auth/'] }), 'standard');
  assert.equal(level({ files: ['web/billing.config.js'], lines: 1, highRiskPaths: ['billing.config.js'] }), 'standard');
  // An entry with no "/" at the end is one file exactly, not the start of a name.
  assert.equal(level({ files: ['billing.config.js.bak'], lines: 1, highRiskPaths: ['billing.config.js'] }), 'standard');
  assert.equal(level({ files: ['README.md.old'], lines: 1, ...QUICK }), 'standard');
});

test('deep wins over quick: a small change in a place that is both is still deep', () => {
  assert.equal(level({ files: ['docs/keys.md'], lines: 1, highRiskPaths: ['docs/keys.md'], ...QUICK }), 'deep');
});

test('quick when every changed file is under a quick review path and the lines are within the limit', () => {
  const r = reviewLevel({ files: ['docs/a.md', 'README.md'], lines: 50, ...QUICK });
  assert.equal(r.level, 'quick');
  assert.match(r.why, /50 lines were added or removed \(the limit is 50\)/);
});

test('one line over the limit is standard, and the reason gives both numbers', () => {
  const r = reviewLevel({ files: ['docs/a.md'], lines: 51, ...QUICK });
  assert.deepEqual(r, { level: 'standard', why: '51 lines were added or removed, more than the quick review limit of 50' });
  assert.equal(level({ files: ['docs/a.md'], lines: 11, quickReviewPaths: ['docs/'], quickReviewMaxLines: 10 }), 'standard');
  assert.equal(level({ files: ['docs/a.md'], lines: 10, quickReviewPaths: ['docs/'], quickReviewMaxLines: 10 }), 'quick');
});

test('the limit is 50 when none is given', () => {
  assert.equal(level({ files: ['docs/a.md'], lines: 50, quickReviewPaths: ['docs/'] }), 'quick');
  assert.equal(level({ files: ['docs/a.md'], lines: 51, quickReviewPaths: ['docs/'] }), 'standard');
});

test('one changed file outside the quick review paths makes it standard, and the reason names the file', () => {
  const r = reviewLevel({ files: ['docs/a.md', 'src/app.ts'], lines: 2, ...QUICK });
  assert.deepEqual(r, { level: 'standard', why: 'src/app.ts is not under a quick review path' });
  assert.equal(level({ files: ['web/README.md'], lines: 2, ...QUICK }), 'standard', 'an entry with no "/" at the end is one file exactly');
});

test('with no quick review paths nothing is quick, however small', () => {
  assert.equal(level({ files: ['docs/a.md'], lines: 1 }), 'standard');
  assert.equal(level({ files: ['docs/a.md'], lines: 0, quickReviewPaths: [] }), 'standard');
});

test('a change whose lines cannot be counted, or that changed no file, is standard', () => {
  const r = reviewLevel({ files: ['docs/logo.png'], lines: Infinity, ...QUICK });
  assert.deepEqual(r, { level: 'standard', why: 'a changed file is not text, so its lines cannot be counted' });
  assert.deepEqual(reviewLevel({ files: [], lines: 0, ...QUICK }), { level: 'standard', why: 'the branch changed no file' });
});

// ---------- joinSettings ----------

test('high-risk paths from the base branch and from the branch both count', () => {
  const joined = joinSettings({ highRiskPaths: ['src/auth/', 'src/pay/'] }, { highRiskPaths: ['src/pay/', 'src/keys/'] });
  assert.deepEqual(joined.highRiskPaths, ['src/auth/', 'src/pay/', 'src/keys/']);
  assert.deepEqual(joinSettings({ highRiskPaths: ['src/auth/'] }, { highRiskPaths: [] }).highRiskPaths, ['src/auth/'], 'a branch cannot take one away');
});

test('a quick review path counts only when the base branch lists it: a branch cannot add its own', () => {
  assert.deepEqual(joinSettings({ quickReviewPaths: [] }, { quickReviewPaths: ['src/'] }).quickReviewPaths, []);
  assert.deepEqual(joinSettings({}, { quickReviewPaths: ['src/'] }).quickReviewPaths, []);
  assert.deepEqual(joinSettings({ quickReviewPaths: ['docs/'] }, { quickReviewPaths: ['docs/', 'src/'] }).quickReviewPaths, ['docs/']);
});

test('a quick review path the branch took out no longer counts', () => {
  assert.deepEqual(joinSettings({ quickReviewPaths: ['docs/', 'notes/'] }, { quickReviewPaths: ['notes/'] }).quickReviewPaths, ['notes/']);
});

test('the line limit is the smaller of the two, and 50 where a copy names none', () => {
  assert.equal(joinSettings({ quickReviewMaxLines: 30 }, { quickReviewMaxLines: 500 }).quickReviewMaxLines, 30);
  assert.equal(joinSettings({ quickReviewMaxLines: 80 }, { quickReviewMaxLines: 20 }).quickReviewMaxLines, 20);
  assert.equal(joinSettings({}, { quickReviewMaxLines: 500 }).quickReviewMaxLines, 50);
  assert.deepEqual(joinSettings(), { highRiskPaths: [], quickReviewPaths: [], quickReviewMaxLines: 50 });
});

// ---------- levelFor and the command line, with real git ----------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const CONFIG = 'scripts/kit.config.json';
const many = (n, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}\n`).join('');

// A repo with one commit on main, holding the given settings, and a branch build/001-x checked out.
function repo(settings = null) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-review-level-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
  const write = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const commit = (message) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-verify', '-m', message);
  };
  write('README.md', 'A project.\n');
  write('docs/notes.md', many(40));
  write('src/auth/login.ts', 'export const login = 1;\n');
  if (settings !== null) write(CONFIG, `${JSON.stringify(settings)}\n`);
  commit('Start');
  git(dir, 'checkout', '-q', '-b', 'build/001-x');
  const cli = (...argv) => {
    let stdout = '';
    let stderr = '';
    const code = run(argv, { cwd: dir, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
    return { code, stdout, stderr };
  };
  return { dir, write, commit, cli, git: (...args) => git(dir, ...args), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// The two quick review settings, read as written. (The checked reader is the default; these tests
// hand in a plain one so they do not depend on which settings keys the rule checker knows today.)
const asWritten = { readSettings: (raw) => raw };

test('a branch that touches a high-risk path of the base branch is deep, even after it takes the path off the list', () => {
  const r = repo({ highRiskPaths: ['src/auth/'] });
  try {
    r.write(CONFIG, `${JSON.stringify({ highRiskPaths: [] })}\n`);
    r.write('src/auth/login.ts', 'export const login = 2;\n');
    r.commit('Change sign-in and the settings');
    const found = levelFor(r.dir, { base: 'main', branch: 'build/001-x' });
    assert.equal(found.level, 'deep');
    assert.equal(found.why, 'the change touches the high-risk path src/auth/ (src/auth/login.ts)');
    assert.deepEqual(found.files, [CONFIG, 'src/auth/login.ts']);
    assert.equal(found.lines, 4);
  } finally {
    r.cleanup();
  }
});

test('a high-risk path the branch itself adds to the settings counts too', () => {
  const r = repo({});
  try {
    r.write('src/pay/charge.ts', 'export const charge = 1;\n');
    r.commit('Add payments');
    assert.equal(levelFor(r.dir, { base: 'main' }).level, 'standard');
    r.write(CONFIG, `${JSON.stringify({ highRiskPaths: ['src/pay/'] })}\n`);
    r.commit('Mark payments high-risk');
    assert.equal(levelFor(r.dir, { base: 'main' }).level, 'deep');
  } finally {
    r.cleanup();
  }
});

test('with no settings file at all, a change is standard, and the base is found without --base', () => {
  const r = repo(null);
  try {
    r.write('docs/notes.md', `${many(40)}one more\n`);
    r.commit('Add a note');
    const found = levelFor(r.dir);
    assert.equal(found.level, 'standard');
    assert.equal(found.base, 'main');
    assert.deepEqual(found.files, ['docs/notes.md']);
    assert.equal(found.lines, 1);
  } finally {
    r.cleanup();
  }
});

test('a small change under a quick review path of the base branch is quick; lines are added plus removed', () => {
  const r = repo({ quickReviewPaths: ['docs/'], quickReviewMaxLines: 50 });
  try {
    // 10 old lines replaced by 10 new ones: 10 removed and 10 added.
    r.write('docs/notes.md', `${many(10, 'new')}${many(40).split('\n').slice(10).join('\n')}`);
    r.commit('Reword the notes');
    const small = levelFor(r.dir, { base: 'main', ...asWritten });
    assert.equal(small.lines, 20);
    assert.equal(small.level, 'quick');
    // 16 more of each: 26 removed and 26 added is 52, over the limit of 50.
    r.write('docs/notes.md', `${many(26, 'new')}${many(40).split('\n').slice(26).join('\n')}`);
    r.commit('Reword more of them');
    const big = levelFor(r.dir, { base: 'main', ...asWritten });
    assert.equal(big.lines, 52);
    assert.equal(big.level, 'standard');
    assert.match(big.why, /52 lines were added or removed, more than the quick review limit of 50/);
  } finally {
    r.cleanup();
  }
});

test('only the branch\'s own change is counted: what the base branch did since is left out', () => {
  const r = repo({ quickReviewPaths: ['docs/'] });
  try {
    r.write('docs/more.md', 'One line.\n');
    r.commit('Add a doc');
    r.git('checkout', '-q', 'main');
    r.write('src/app.ts', many(200));
    r.commit('Main adds code');
    r.git('checkout', '-q', 'build/001-x');
    const found = levelFor(r.dir, { base: 'main', ...asWritten });
    assert.deepEqual(found.files, ['docs/more.md']);
    assert.equal(found.level, 'quick');
  } finally {
    r.cleanup();
  }
});

test('a branch cannot make itself quick: its own quick review path and its own higher limit do not count', () => {
  // The settings file is itself a quick review path here, so that changing it is not what decides the level.
  const r = repo({ quickReviewPaths: ['docs/', CONFIG], quickReviewMaxLines: 5 });
  try {
    // A small change within the limit is quick: the two branches below differ from this only in what they loosen.
    r.write('docs/notes.md', `${many(40)}${many(3, 'extra')}`);
    r.commit('Three lines of notes');
    assert.equal(levelFor(r.dir, { base: 'main', ...asWritten }).level, 'quick');

    r.write(CONFIG, `${JSON.stringify({ quickReviewPaths: ['docs/', CONFIG], quickReviewMaxLines: 5000 })}\n`);
    r.write('docs/notes.md', `${many(40)}${many(6, 'extra')}`);
    r.commit('Raise the limit and add three more lines');
    const raised = levelFor(r.dir, { base: 'main', ...asWritten });
    assert.equal(raised.lines, 8);
    assert.deepEqual([raised.level, raised.why], ['standard', '8 lines were added or removed, more than the quick review limit of 5']);

    r.git('checkout', '-q', '-b', 'build/002-y', 'main');
    r.write(CONFIG, `${JSON.stringify({ quickReviewPaths: ['docs/', CONFIG, 'src/'], quickReviewMaxLines: 5 })}\n`);
    r.write('src/app.ts', 'export const app = 1;\n');
    r.commit('Call src/ quick and change it');
    const added = levelFor(r.dir, { base: 'main', branch: 'build/002-y', ...asWritten });
    assert.equal(added.lines, 3);
    assert.deepEqual([added.level, added.why], ['standard', 'src/app.ts is not under a quick review path']);
  } finally {
    r.cleanup();
  }
});

test('a changed file that is not text is never quick', () => {
  const r = repo({ quickReviewPaths: ['docs/'] });
  try {
    r.write('docs/logo.bin', Buffer.from([0, 1, 2, 0, 255, 254, 0, 9]));
    r.commit('Add a picture');
    const found = levelFor(r.dir, { base: 'main', ...asWritten });
    assert.deepEqual(found.files, ['docs/logo.bin']);
    assert.equal(found.level, 'standard');
    assert.match(found.why, /is not text/);
  } finally {
    r.cleanup();
  }
});

test('a renamed file counts under its old name too, so moving a file out of a high-risk folder is deep', () => {
  const r = repo({ highRiskPaths: ['src/auth/'] });
  try {
    r.git('mv', 'src/auth/login.ts', 'src/login.ts');
    r.commit('Move sign-in');
    const found = levelFor(r.dir, { base: 'main' });
    assert.deepEqual(found.files, ['src/auth/login.ts', 'src/login.ts']);
    assert.equal(found.level, 'deep');
  } finally {
    r.cleanup();
  }
});

test('bad settings on either copy, or a ref git does not know, is a plain error', () => {
  const r = repo({});
  try {
    assert.throws(() => levelFor(r.dir, { base: 'origin/nope' }), /git has no branch or commit named origin\/nope/);
    assert.throws(() => levelFor(r.dir, { base: 'main', branch: 'build/nope' }), /git has no branch or commit named build\/nope/);
    r.write(CONFIG, '{ "noSuchSetting": 1 }\n');
    r.commit('A setting the rule checker does not know');
    assert.throws(() => levelFor(r.dir, { base: 'main' }), /unknown setting "noSuchSetting"/);
    r.write(CONFIG, '{ not json\n');
    r.commit('Break the settings file');
    assert.throws(() => levelFor(r.dir, { base: 'main' }), /scripts\/kit\.config\.json on HEAD is not valid JSON/);
  } finally {
    r.cleanup();
  }
});

test('the command prints "kit-level <level> <why>" and exits 0', () => {
  const r = repo({ highRiskPaths: ['src/auth/'] });
  try {
    r.write('README.md', 'A project, explained.\n');
    r.commit('Explain');
    const standard = r.cli();
    assert.deepEqual(standard, { code: 0, stdout: 'kit-level standard the change is not in a high-risk path, and no quick review path is set on the base branch\n', stderr: '' });
    r.write('src/auth/login.ts', 'export const login = 3;\n');
    r.commit('Change sign-in');
    assert.deepEqual(r.cli('build/001-x', '--base', 'main'), { code: 0, stdout: 'kit-level deep the change touches the high-risk path src/auth/ (src/auth/login.ts)\n', stderr: '' });
    assert.equal(r.cli('main', '--base', 'main').stdout, 'kit-level standard the branch changed no file\n');
  } finally {
    r.cleanup();
  }
});

test('wrong usage exits 2 with the usage line; a git error exits 1', () => {
  const r = repo({});
  try {
    for (const argv of [['--all'], ['--base'], ['--base', '--x'], ['a', 'b']]) {
      const res = r.cli(...argv);
      assert.equal(res.code, 2, argv.join(' '));
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /^Wrong usage: .*\nUsage: node scripts\/review-level\.mjs \[<branch>\] \[--base <ref>\]\n$/);
    }
    const res = r.cli('--base', 'origin/nope');
    assert.equal(res.code, 1);
    assert.match(res.stderr, /^review-level: git has no branch or commit named origin\/nope/);
  } finally {
    r.cleanup();
  }
  const outside = mkdtempSync(join(tmpdir(), 'kit-review-level-none-'));
  try {
    let stderr = '';
    assert.equal(run([], { cwd: outside, stdout: () => {}, stderr: (s) => (stderr += s) }), 1);
    assert.match(stderr, /is not inside a git working tree/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

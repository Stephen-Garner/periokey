// Tests for cases.mjs. Run: node --test scripts/cases.test.mjs
// Each test makes a throwaway git repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { END, START, caseSet, findCases, findControls, formatControls, formatTable, hintLine, parseLog, pickControls, prInMergeSubject, prInSubject, run, withTable } from './cases.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cases-'));
  const sh = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t.t');
  sh('config', 'user.name', 't');
  sh('config', 'commit.gpgsign', 'false');
  let n = 0;
  const commit = (message, day) => {
    writeFileSync(join(dir, `f${n++}.txt`), String(n));
    sh('add', '.');
    const date = `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`;
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'ignore' });
    return sh('rev-parse', 'HEAD');
  };
  return { dir, sh, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const go = (r, argv) => {
  let out = '';
  let err = '';
  const code = run(argv, { cwd: r.dir, stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
  return { code, out, err };
};

test('a pull request number comes from "(#N)" in a first line, or from the merge that first brought the commit onto the main line', () => {
  assert.equal(prInSubject('feat: save button (#12)'), 12);
  assert.equal(prInSubject('feat: undo (#3) again (#14)'), 14);
  assert.equal(prInSubject('feat: no number'), null);
  assert.equal(prInMergeSubject('Merge pull request #5 from a/b'), 5);
  assert.equal(prInMergeSubject("Merge branch 'main' into x"), null);
});

test('parseLog keeps commits with a Fixes trailer, reading it the way the commit check does', () => {
  const rec = (hash, msg) => `${hash}\x1f${hash.slice(0, 7)}\x1f2026-10-05T12:00:00Z\x1f${msg}\x1e`;
  const text = rec('a'.repeat(40), 'fix: one\n\nFixes: 1234567\n')
    + rec('b'.repeat(40), 'feat: plain\n')
    + rec('c'.repeat(40), 'fix: two\n\nFixes: unknown\nSlice: 003\n')
    + rec('d'.repeat(40), 'docs: a note\n\nThe line Fixes: 1234567 is in a sentence, not a trailer.\n');
  const got = parseLog(text);
  assert.deepEqual(got.map((c) => [c.short, c.subject, c.fixes]), [['aaaaaaa', 'fix: one', ['1234567']], ['ccccccc', 'fix: two', ['unknown']]]);
  assert.equal(got[0].date, '2026-10-05');
});

test('each commit named by a Fixes trailer is a case, newest first; unknown and missing ids are counted but make no case', () => {
  const r = repo();
  try {
    const old = r.commit('feat: old thing (#4)', 1);
    const newer = r.commit('feat: newer thing | with a pipe', 5);
    r.commit('feat: clean change', 6);
    r.commit(`fix: repair the old thing\n\nFixes: ${old.slice(0, 8)}`, 7);
    r.commit(`fix: repair the newer thing\n\nFixes: ${newer}\nBug: the newer thing lost the last word`, 8);
    r.commit(`fix: repair it again\n\nFixes: ${newer.slice(0, 7)}\nFixes: unknown`, 9);
    r.commit('fix: no cause known\n\nFixes: unknown', 10);
    r.commit('fix: names a commit that is gone\n\nFixes: deadbeef', 11);
    const { cases, unknown, missing } = findCases((args) => r.sh(...args));
    assert.deepEqual(cases.map((c) => c.subject), ['feat: newer thing | with a pipe', 'feat: old thing (#4)']);
    assert.deepEqual(cases.map((c) => c.date), ['2026-10-05', '2026-10-01']);
    assert.deepEqual(cases[0].fixes.map((f) => f.subject), ['fix: repair it again', 'fix: repair the newer thing']);
    assert.equal(cases[0].fixes.length, 2, 'two fixes name one case: one row');
    assert.equal(cases[1].pr, 4);
    assert.deepEqual([unknown, missing], [2, 1]);
    const table = formatTable({ cases, unknown, missing });
    assert.match(table, /^\| Case \| Set \| Date \| First line \| Pull request \| Named by \| Answer \|\n\|---\|/);
    assert.equal(cases[0].answer, 'the newer thing lost the last word');
    assert.equal(cases[1].answer, null);
    assert.match(table, /needs an answer \|\n/);
    assert.match(table, /feat: newer thing \\\| with a pipe/);
    assert.match(table, /Cases: 2\. Fixes that said "Fixes: unknown": 2/);
    assert.match(table, /does not have: 1/);
  } finally { r.done(); }
});

test('the pull request of a case with no number in its first line comes from the merge that brought it in', () => {
  const r = repo();
  try {
    r.commit('chore: start', 1);
    r.sh('checkout', '-q', '-b', 'feature');
    const bug = r.commit('feat: the buggy change', 2);
    r.sh('checkout', '-q', 'main');
    r.commit('chore: main moves on', 3);
    r.sh('merge', '--no-ff', '-q', '-m', 'Merge pull request #21 from me/feature', 'feature');
    r.commit(`fix: the bug\n\nFixes: ${bug}`, 5);
    const { cases } = findCases((args) => r.sh(...args));
    assert.equal(cases.length, 1);
    assert.equal(cases[0].pr, 21);
    assert.match(formatTable({ cases, unknown: 0, missing: 0 }), /\| #21 \|/);
  } finally { r.done(); }
});

test('a bug that went through an integration branch is credited to the pull request that put it on main, not the inner one', () => {
  const r = repo();
  try {
    r.commit('chore: start', 1);
    r.sh('checkout', '-q', '-b', 'integ');
    r.sh('checkout', '-q', '-b', 'feature');
    const bug = r.commit('feat: the buggy change', 2);
    r.sh('checkout', '-q', 'integ');
    r.commit('chore: integ moves on', 3);
    r.sh('merge', '--no-ff', '-q', '-m', 'Merge pull request #11 from me/feature', 'feature');
    r.sh('checkout', '-q', 'main');
    r.commit('chore: main moves on', 5);
    r.sh('merge', '--no-ff', '-q', '-m', 'Merge pull request #22 from me/integ', 'integ');
    r.commit(`fix: the bug\n\nFixes: ${bug}`, 7);
    assert.equal(findCases((args) => r.sh(...args)).cases[0].pr, 22);
  } finally { r.done(); }
});

test('a case committed straight to main gets no pull request from a later, unrelated merge', () => {
  const r = repo();
  try {
    const bug = r.commit('feat: straight to main', 1);
    r.sh('checkout', '-q', '-b', 'other');
    r.commit('feat: unrelated', 2);
    r.sh('checkout', '-q', 'main');
    r.commit('chore: more', 3);
    r.sh('merge', '--no-ff', '-q', '-m', 'Merge pull request #30 from me/other', 'other');
    r.commit(`fix: the bug\n\nFixes: ${bug}`, 5);
    assert.equal(findCases((args) => r.sh(...args)).cases[0].pr, null);
  } finally { r.done(); }
});

test('the hint appears below 10 cases and not at 10', () => {
  assert.match(hintLine(9), /9 cases \(fewer than 10\).*a hint, not a verdict/);
  assert.match(hintLine(1), /only 1 case \(/);
  assert.equal(hintLine(10), null);
  const r = repo();
  try {
    const bug = r.commit('feat: x', 1);
    r.commit(`fix: y\n\nFixes: ${bug}`, 2);
    const res = go(r, []);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /a hint, not a verdict/);
    const j = JSON.parse(go(r, ['--json']).out);
    assert.equal(j.cases.length, 1);
    assert.match(j.hint, /hint/);
  } finally { r.done(); }
});

test('--write replaces the table between the markers and keeps what a person wrote; a second run changes nothing', () => {
  const r = repo();
  try {
    const bug = r.commit('feat: x', 1);
    r.commit(`fix: y\n\nFixes: ${bug}`, 2);
    const file = join(r.dir, 'docs/review-cases.md');
    const first = go(r, ['--write']);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /Wrote: docs\/review-cases\.md/);
    const made = readFileSync(file, 'utf8');
    assert.ok(made.includes(START) && made.includes(END) && made.includes('feat: x'));
    writeFileSync(file, `Written by hand, before.\n\n${made.replace('# Review cases', '# Mine')}\nWritten by hand, after.\n`);
    r.commit('feat: z', 3);
    const bug2 = r.sh('rev-parse', 'HEAD');
    r.commit(`fix: w\n\nFixes: ${bug2}`, 4);
    go(r, ['--write']);
    const updated = readFileSync(file, 'utf8');
    assert.match(updated, /^Written by hand, before\./);
    assert.match(updated, /Written by hand, after\.\n$/);
    assert.match(updated, /# Mine/);
    assert.match(updated, /feat: z/);
    assert.equal(updated.split(START).length, 2, 'one generated block, not two');
    const again = go(r, ['--write']);
    assert.match(again.out, /Already up to date/);
    assert.equal(readFileSync(file, 'utf8'), updated);
  } finally { r.done(); }
});

test('withTable: a file with no markers gets the block at the end; no file gets a heading', () => {
  assert.equal(withTable('# Mine\n\nhand text\n', 'T\n'), `# Mine\n\nhand text\n\n${START}\nT\n${END}\n`);
  assert.match(withTable(null, 'T\n'), /^# Review cases\n[\s\S]*<!-- review-cases:start[\s\S]*\nT\n<!-- review-cases:end -->\n$/);
  assert.equal(withTable(`a\n${START}\nOLD\n${END}\nb\n`, 'NEW\n'), `a\n${START}\nNEW\n${END}\nb\n`);
});

test('wrong options exit 2; a folder that is not a git repo exits 1 with a plain message', () => {
  const r = repo();
  try {
    assert.equal(go(r, ['--what']).code, 2);
    const plain = mkdtempSync(join(tmpdir(), 'cases-nogit-'));
    mkdirSync(join(plain, 'x'));
    let err = '';
    const code = run([], { cwd: join(plain, 'x'), stdout: () => {}, stderr: (t) => { err += t; }, git: () => { throw new Error('fatal: not a git repository'); } });
    assert.equal(code, 1);
    assert.match(err, /git history could not be read: fatal: not a git repository/);
    rmSync(plain, { recursive: true, force: true });
  } finally { r.done(); }
});

test('the Answer column comes from the fix commit Bug: line; a case with none says "needs an answer"; two answers are both shown', () => {
  const r = repo();
  try {
    const a = r.commit('feat: first', 1);
    const b = r.commit('feat: second', 2);
    const c = r.commit('feat: third', 3);
    r.commit(`fix: one\n\nFixes: ${a}\nBug: the first save lost the last word typed\nVerified: tests`, 4);
    r.commit(`fix: two\n\nFixes: ${b}`, 5);
    r.commit(`fix: three\n\nFixes: ${c}\nBug: the third crashed on an accent`, 6);
    r.commit(`fix: three again\n\nFixes: ${c}\nBug: the third also crashed on an empty word`, 7);
    r.commit(`fix: short note\n\nFixes: ${a}\nBug: too short`, 8);
    const { cases } = findCases((args) => r.sh(...args));
    const answer = (subject) => cases.find((x) => x.subject === subject).answer;
    assert.equal(answer('feat: first'), 'the first save lost the last word typed', 'a Bug line that is too short is no answer');
    assert.equal(answer('feat: second'), null);
    assert.equal(answer('feat: third'), 'the third also crashed on an empty word; the third crashed on an accent');
    const table = formatTable({ cases, unknown: 0, missing: 0 });
    assert.match(table, /\| feat: second \|.*\| needs an answer \|/);
    assert.match(table, /\| feat: first \|.*\| the first save lost the last word typed \|/);
    assert.equal(JSON.parse(go(r, ['--json']).out).cases.length, 3);
  } finally { r.done(); }
});

test('caseSet: the last hex digit of the full id decides, even is the fixed test set; findCases sets it', () => {
  assert.equal(caseSet(`${'a'.repeat(39)}0`), 'test');
  assert.equal(caseSet(`${'a'.repeat(39)}8`), 'test');
  assert.equal(caseSet(`${'a'.repeat(39)}e`), 'test');
  assert.equal(caseSet(`${'a'.repeat(39)}1`), 'tune');
  assert.equal(caseSet(`${'a'.repeat(39)}f`), 'tune');
  const r = repo();
  try {
    const bug = r.commit('feat: x', 1);
    r.commit(`fix: y\n\nFixes: ${bug}`, 2);
    const [c] = findCases((args) => r.sh(...args)).cases;
    assert.equal(c.set, caseSet(bug));
    assert.match(formatTable({ cases: [c], unknown: 0, missing: 0 }), new RegExp(`\\| \`${c.short}\` \\| ${c.set} \\|`));
  } finally { r.done(); }
});

// A pull request: a branch with one file of `lines` lines, merged with a "Merge pull request" commit.
function pr(r, n, lines, day) {
  r.sh('checkout', '-q', '-b', `pr${n}`);
  writeFileSync(join(r.dir, `pr${n}.txt`), 'x\n'.repeat(lines));
  r.sh('add', '.');
  r.sh('commit', '-q', '-m', `feat: change ${n}`);
  const inside = r.sh('rev-parse', 'HEAD');
  r.sh('checkout', '-q', 'main');
  r.sh('merge', '--no-ff', '-q', '-m', `Merge pull request #${n} from me/pr${n}`, `pr${n}`);
  return inside;
}
const gitOf = (r) => (args) => r.sh(...args);

test('controls: close in size to the cases, never a change a fix points at, only pull requests, and the same list every time', () => {
  const r = repo();
  try {
    r.commit('chore: start', 1);
    pr(r, 1, 10, 2);
    pr(r, 2, 12, 3);
    const bug = pr(r, 3, 50, 4);
    pr(r, 4, 52, 5);
    pr(r, 5, 200, 6);
    pr(r, 6, 11, 7);
    writeFileSync(join(r.dir, 'direct.txt'), 'x\n'.repeat(50));
    r.sh('add', '.');
    r.sh('commit', '-q', '-m', 'chore: a direct commit, no pull request');
    writeFileSync(join(r.dir, 'squash.txt'), 'x\n'.repeat(49));
    r.sh('add', '.');
    r.sh('commit', '-q', '-m', 'feat: a squashed pull request (#9)');
    r.commit(`fix: the bug\n\nFixes: ${bug}\nBug: change 3 lost a line when saving`, 20);

    const { cases } = findCases(gitOf(r));
    assert.equal(cases.length, 1);
    assert.equal(cases[0].pr, 3);
    const one = findControls(gitOf(r), cases, 1);
    assert.deepEqual(one.controls.map((c) => c.pr), [9], '49 lines is closest to 50; PR 3 (50) is the case itself; the direct commit (50) is no pull request');
    assert.equal(one.controls[0].size, 49);
    assert.equal(one.note, null);
    const three = findControls(gitOf(r), cases, 3);
    assert.deepEqual(three.controls.map((c) => c.pr).sort((a, b) => a - b), [2, 4, 9]);
    assert.ok(!three.controls.some((c) => c.pr === 3), 'the change the fix points at is never a control');
    assert.deepEqual(findControls(gitOf(r), cases, 3), three, 'same repo, same list');
    const lines = go(r, ['--controls', '3']);
    assert.equal(lines.code, 0, lines.err);
    assert.match(lines.out, /\| Control \| Date \| First line \| Pull request \| Lines changed \|/);
    assert.match(lines.out, /\| #9 \| 49 \|/);
    assert.equal(go(r, ['--controls', '3']).out.split('\n').filter((l) => /^\| `/.test(l)).length, 1 + 3, 'one case row and three control rows');
    const j = JSON.parse(go(r, ['--json', '--controls', '2']).out);
    assert.deepEqual(j.controls.map((c) => c.pr).sort((a, b) => a - b), [4, 9]);
    assert.equal(JSON.parse(go(r, ['--json']).out).controls, undefined, 'no --controls, no controls');
  } finally { r.done(); }
});

test('controls: asking for more than qualify gives the ones that do, with a plain note; no cases gives none', () => {
  const r = repo();
  try {
    r.commit('chore: start', 1);
    pr(r, 1, 5, 2);
    assert.match(findControls(gitOf(r), [], 2).note, /no cases yet/);
    const bug = pr(r, 2, 5, 3);
    pr(r, 3, 6, 4);
    r.commit(`fix: the bug\n\nFixes: ${bug}`, 9);
    const { cases } = findCases(gitOf(r));
    const got = findControls(gitOf(r), cases, 5);
    assert.deepEqual(got.controls.map((c) => c.pr).sort(), [1, 3]);
    assert.match(got.note, /Only 2 pull requests qualified.*fewer than the 5 asked for/);
    assert.match(formatControls(got), /Only 2 pull requests qualified/);
  } finally { r.done(); }
});

test('controls: a pull request whose merge commit is itself named by a fix is not a control', () => {
  const r = repo();
  try {
    r.commit('chore: start', 1);
    pr(r, 1, 20, 2);
    pr(r, 2, 21, 3);
    pr(r, 3, 60, 4);
    const mergeOf2 = r.sh('log', '--first-parent', '--format=%H', '--grep=Merge pull request #2', '-1');
    r.commit(`fix: the bug\n\nFixes: ${mergeOf2}`, 9);
    const { cases } = findCases(gitOf(r));
    assert.equal(cases.length, 1);
    assert.deepEqual(findControls(gitOf(r), cases, 1).controls.map((c) => c.pr), [1], 'PR 3 is far from 21; PR 2 is the case');
  } finally { r.done(); }
});

test('pickControls: nearest size first, targets in turn, ties to the smaller id, never one change twice', () => {
  const pool = [
    { hash: 'b', size: 10, date: '2026-10-02' },
    { hash: 'a', size: 10, date: '2026-10-01' },
    { hash: 'c', size: 100, date: '2026-10-03' },
    { hash: 'd', size: 55, date: '2026-10-04' },
  ];
  assert.deepEqual(pickControls([10], pool, 1).map((c) => c.hash), ['a']);
  assert.deepEqual(pickControls([10, 100], pool, 2).map((c) => c.hash).sort(), ['a', 'c']);
  assert.deepEqual(pickControls([100], pool, 10).map((c) => c.hash).sort(), ['a', 'b', 'c', 'd'], 'each once, and no more than the pool');
  assert.deepEqual(pickControls([], pool, 3), []);
});

test('--controls needs a whole number above 0', () => {
  const r = repo();
  try {
    for (const argv of [['--controls'], ['--controls', '0'], ['--controls', 'x'], ['--controls', '-1'], ['--controls', '2.5']]) {
      const res = go(r, argv);
      assert.equal(res.code, 2, argv.join(' '));
      assert.match(res.err, /Usage:.*--controls <n>/);
    }
  } finally { r.done(); }
});

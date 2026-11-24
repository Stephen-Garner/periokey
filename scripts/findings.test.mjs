// Tests for findings.mjs. Run: node --test scripts/findings.test.mjs
// The git tests make a throwaway repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildReceipt } from './receipt.mjs';
import { reasonFile } from './test-changes.mjs';
import { LABELS, NOTE_MAX, NOTE_MIN, OUTCOMES, answerLine, describe, findingsFile, findingsFor, owed, parseFindings, run, totalOf } from './findings.mjs';

const counts = (important, nit = 0, preExisting = 0) => ({ important, nit, preExisting });
const answer = (round, n) => ({ round, n, label: 'Important', outcome: 'fixed', note: 'Fixed it with a test.', line: 1 });

// ---------- parseFindings ----------

test('the outcomes are the five in the spec, and the labels are the reviewer\'s three', () => {
  assert.deepEqual([...OUTCOMES], ['fixed', 'wrong', 'intended', 'not worth it', 'later']);
  assert.deepEqual([...LABELS], ['Important', 'Nit', 'Pre-existing']);
});

test('a label is read without regard to capital letters and comes back in the standard spelling', () => {
  for (const [written, want] of [['Important', 'Important'], ['important', 'Important'], ['NIT', 'Nit'], ['nit', 'Nit'], ['pre-existing', 'Pre-existing'], ['PRE-EXISTING', 'Pre-existing']]) {
    const { answers, problems } = parseFindings(`- R1.1 ${written}: fixed: A note that is long enough.`);
    assert.deepEqual(problems, [], written);
    assert.equal(answers[0].label, want);
  }
});

test('any label but the three is a problem that names the three, and the line is not an answer', () => {
  for (const written of ['naming', 'missing null check', 'Importantly', 'Pre existing', 'Preexisting', 'Minor', 'Important, Nit']) {
    const { answers, problems } = parseFindings(`- R1.1 ${written}: fixed: A note that is long enough.`);
    assert.deepEqual(answers, [], written);
    assert.deepEqual(problems, [`line 1: R1.1: the label "${written}" is not one of: Important, Nit, Pre-existing. Copy the label the reviewer gave this finding`]);
  }
});

test('an answer line gives its round, number, label, outcome, note, and line number', () => {
  const text = '# Answers\n\n- R1.2 Important: fixed: Added the check in save.ts and a test for it.\n- R2.1 Pre-existing: later: Logged as row 14 of the mistakes list: not ours.\n';
  assert.deepEqual(parseFindings(text), {
    answers: [
      { round: 1, n: 2, label: 'Important', outcome: 'fixed', note: 'Added the check in save.ts and a test for it.', line: 3 },
      { round: 2, n: 1, label: 'Pre-existing', outcome: 'later', note: 'Logged as row 14 of the mistakes list: not ours.', line: 4 },
    ],
    problems: [],
  });
});

test('every outcome is read, with or without capitals, and "not worth it" keeps its spaces', () => {
  for (const outcome of OUTCOMES) {
    const { answers, problems } = parseFindings(`- R1.1 Nit: ${outcome.toUpperCase()}: A note that is long enough.`);
    assert.deepEqual(problems, []);
    assert.equal(answers[0].outcome, outcome);
  }
});

test('headings, plain text, and list lines that are not answers are left alone', () => {
  assert.deepEqual(parseFindings('# Findings\n\nSome words.\n- a loose note\n* another\n\n'), { answers: [], problems: [] });
  assert.deepEqual(parseFindings(''), { answers: [], problems: [] });
});

test('an answer that breaks the shape is a problem with its line, and does not count as an answer', () => {
  const bad = (line, want) => {
    const { answers, problems } = parseFindings(`# Answers\n${line}\n`);
    assert.deepEqual(answers, [], line);
    assert.equal(problems.length, 1, line);
    assert.match(problems[0], /^line 2: /);
    assert.match(problems[0], want);
  };
  bad('- R1.1 fixed', /cannot be read\. Write it as "- R<round>\.<number> <label>: <outcome>: <note>", like "- R1\.2 Important: fixed: /);
  bad('- R1 Nit: fixed: A note that is long enough.', /cannot be read/);
  bad('- R1.1 Nit: fixed', /cannot be read/);
  bad('- R0.1 Nit: fixed: A note that is long enough.', /numbered from 1/);
  bad('- R1.0 Nit: fixed: A note that is long enough.', /numbered from 1/);
  bad('- R1.1 : fixed: A note that is long enough.', /R1\.1: the label is missing/);
  bad('- R1.1 Nit: done: A note that is long enough.', /R1\.1: the outcome "done" is not one of: fixed, wrong, intended, not worth it, later/);
  bad('- R1.1 Nit: fixed and wrong: A note that is long enough.', /the outcome "fixed and wrong" is not one of/);
  bad('- R1.1 src/a.ts:42 Nit: fixed: A note that is long enough.', /the label "src\/a\.ts" is not one of: Important, Nit, Pre-existing/);
  bad(`- R1.1 Nit: fixed: ${'x'.repeat(NOTE_MIN - 1)}`, /the note is 9 characters; write one full sentence \(10 characters or more\)/);
  bad(`- R1.1 Nit: fixed: ${'x'.repeat(NOTE_MAX + 1)}`, /the note is 301 characters; shorten it to 300 or fewer/);
  bad('- R1.1 Nit: fixed:', /the note is 0 characters/);
  bad(answerLine(1, 1), /R1\.1: the line still holds the placeholder text/);
  bad('- R1.1 Nit: fixed: <what you did, or why not, in one plain sentence>', /placeholder text/);
});

test('notes of 10 and 300 characters are fine', () => {
  for (const line of [`- R1.1 Important: fixed: ${'y'.repeat(NOTE_MIN)}`, `- R1.1 Nit: wrong: ${'y'.repeat(NOTE_MAX)}`]) {
    const { answers, problems } = parseFindings(line);
    assert.deepEqual(problems, []);
    assert.equal(answers.length, 1);
  }
});

test('a finding answered twice is a problem; the first line stays', () => {
  const { answers, problems } = parseFindings('- R1.1 Nit: fixed: Renamed it in both files.\n- R1.1 Nit: wrong: The name is fine as it was.\n');
  assert.deepEqual(answers.map((a) => a.outcome), ['fixed']);
  assert.deepEqual(problems, ['line 2: R1.1 is answered twice; keep one line for it']);
});

// ---------- owed ----------

test('a round owes one answer per finding it counted, numbered from 1', () => {
  assert.deepEqual(owed([counts(2, 1, 1)], []), [{ round: 1, missing: [1, 2, 3, 4] }]);
  assert.deepEqual(owed([counts(2, 1, 1)], [answer(1, 1), answer(1, 3)]), [{ round: 1, missing: [2, 4] }]);
  assert.deepEqual(owed([counts(2, 1, 1)], [1, 2, 3, 4].map((n) => answer(1, n))), []);
  assert.equal(totalOf(counts(2, 1, 1)), 4);
});

test('an answer for another round, or with a number above the count, pays nothing', () => {
  assert.deepEqual(owed([counts(1), counts(1)], [answer(2, 1)]), [{ round: 1, missing: [1] }]);
  assert.deepEqual(owed([counts(2)], [answer(1, 1), answer(1, 5)]), [{ round: 1, missing: [2] }]);
  assert.deepEqual(owed([counts(1)], [answer(1, 1), answer(3, 1)]), [], 'an answer for a round with no receipt yet is not an error');
});

test('a round with no counts, or with all zeros, owes nothing', () => {
  assert.deepEqual(owed([null, counts(0, 0, 0), undefined], []), []);
  assert.deepEqual(owed([null, counts(1)], []), [{ round: 2, missing: [1] }], 'the round after a receipt with no counts keeps its number');
  assert.deepEqual(owed([], []), []);
  assert.equal(totalOf(null), 0);
  assert.equal(totalOf({ important: 'two', nit: -1, preExisting: 1.5 }), 0);
});

// ---------- findingsFile ----------

test('the findings file is named the way the weakenings file is', () => {
  assert.equal(findingsFile('build/082-save-word'), 'docs/findings/build-082-save-word.md');
  for (const branch of ['build/082-save-word', 'lead/kit sync', 'a/b/c', '']) {
    assert.equal(findingsFile(branch).slice('docs/findings/'.length), reasonFile(branch).slice('docs/weakenings/'.length), branch);
  }
});

// ---------- findingsFor and the command line, with real git ----------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const FILE = 'docs/findings/build-001-x.md';

// A repo with one commit on main and a branch build/001-x checked out.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-findings-'));
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
  // A reviewer's session record (Codex shape), kept outside the repo as a real one is, and the receipt
  // scripts/receipt.mjs makes from it. With no counts, the reply has no COUNT line, like an older review.
  const sessions = mkdtempSync(join(tmpdir(), 'kit-findings-sessions-'));
  const sessionOf = (name) => join(sessions, `${name}.jsonl`);
  const record = (name, at, c) => {
    const text = `VERDICT: changes needed\n${c === undefined ? '' : `COUNT: ${c.important} important, ${c.nit} nit, ${c.preExisting} pre-existing\n`}REVIEWED: abc1234\nTASK: T1\n\nFINDINGS\n1. [Important] src/app.ts:1, wrong number\n`;
    const rows = [
      { type: 'turn_context', timestamp: at, payload: { model: 'gpt-6.1-sol' } },
      { type: 'response_item', timestamp: at, payload: { type: 'function_call', call_id: 'c1', arguments: JSON.stringify({ cmd: 'node scripts/receipt.mjs fingerprints' }) } },
      { type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: 'c1', output: 'No code commits after the base branch: nothing for a receipt to cover.' } },
      { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
    ];
    writeFileSync(sessionOf(name), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    return buildReceipt(readFileSync(sessionOf(name), 'utf8'), sessionOf(name));
  };
  const receipt = (name, at, receiptCounts) => {
    const made = record(name, at, receiptCounts);
    write(`docs/receipts/${name}.json`, `${JSON.stringify(made, null, 2)}\n`);
    commit(`Receipt ${name}`);
    return made;
  };
  write('README.md', 'A project.\n');
  commit('Start');
  git(dir, 'checkout', '-q', '-b', 'build/001-x');
  write('src/app.ts', 'export const app = 1;\n');
  commit('The work');
  const cli = (...argv) => {
    let stdout = '';
    let stderr = '';
    const code = run(argv, { cwd: dir, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
    return { code, stdout, stderr };
  };
  return { dir, write, commit, receipt, sessionOf, cli, git: (...args) => git(dir, ...args), cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(sessions, { recursive: true, force: true }); } };
}

test('receipts the branch added are the rounds, oldest first by their time, whatever their file names', () => {
  const r = repo();
  try {
    // The file names sort the other way round from the times.
    r.receipt('T1-zzzz0001', '2026-11-19T09:00:00.000Z', counts(2, 0, 0));
    r.receipt('T1-aaaa0002', '2026-11-19T11:00:00.000Z', counts(0, 1, 0));
    const found = findingsFor(r.dir, { base: 'main', branch: 'build/001-x' });
    assert.equal(found.file, FILE);
    assert.deepEqual(found.rounds, [
      { round: 1, receipt: 'docs/receipts/T1-zzzz0001.json', counts: counts(2, 0, 0) },
      { round: 2, receipt: 'docs/receipts/T1-aaaa0002.json', counts: counts(0, 1, 0) },
    ]);
    assert.deepEqual(found.owed, [{ round: 1, missing: [1, 2] }, { round: 2, missing: [1] }]);
  } finally {
    r.cleanup();
  }
});

test('a committed answer pays for its finding; one that is not committed does not', () => {
  const r = repo();
  try {
    r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z', counts(1, 1, 0));
    r.write(FILE, '- R1.1 Important: fixed: Added the check and a test for it.\n');
    assert.deepEqual(findingsFor(r.dir, { base: 'main' }).owed, [{ round: 1, missing: [1, 2] }]);
    r.commit('Answer the first finding');
    const found = findingsFor(r.dir, { base: 'main' });
    assert.deepEqual(found.answers.map((a) => [a.round, a.n, a.outcome]), [[1, 1, 'fixed']]);
    assert.deepEqual(found.owed, [{ round: 1, missing: [2] }]);
    r.write(FILE, '- R1.1 Important: fixed: Added the check and a test for it.\n- R1.2 Nit: not worth it: The name is used in forty places and reads fine.\n');
    r.commit('Answer the second finding');
    assert.deepEqual(findingsFor(r.dir, { base: 'main' }).owed, []);
  } finally {
    r.cleanup();
  }
});

test('a receipt with no counts owes nothing, and the next receipt is still the next round', () => {
  const r = repo();
  try {
    r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z');
    r.receipt('T1-00000002', '2026-11-19T10:00:00.000Z', counts(1, 0, 0));
    const found = findingsFor(r.dir, { base: 'main' });
    assert.deepEqual(found.rounds.map((x) => x.counts), [null, counts(1, 0, 0)]);
    assert.deepEqual(found.owed, [{ round: 2, missing: [1] }]);
  } finally {
    r.cleanup();
  }
});

test('receipts and answers already on the base branch do not count for this branch', () => {
  const r = repo();
  try {
    // An earlier branch with the same name was merged: main holds its receipt and its answer.
    r.git('checkout', '-q', 'main');
    r.receipt('T0-00000000', '2026-11-01T09:00:00.000Z', counts(3, 0, 0));
    r.write(FILE, '- R1.1 Nit: fixed: Renamed the helper in both files.\n');
    r.commit('An old answer');
    r.git('checkout', '-q', 'build/001-x');
    r.git('merge', '-q', '--no-edit', 'main');
    r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z', counts(1, 0, 0));
    const before = findingsFor(r.dir, { base: 'main' });
    assert.deepEqual(before.rounds.map((x) => x.receipt), ['docs/receipts/T1-00000001.json']);
    assert.deepEqual(before.answers, []);
    assert.deepEqual(before.owed, [{ round: 1, missing: [1] }]);
    r.write(FILE, '- R1.1 Nit: fixed: Renamed the helper in both files.\n- R1.1 Important: fixed: The loop now stops at the last row.\n');
    r.commit('This branch\'s own answer');
    const after = findingsFor(r.dir, { base: 'main' });
    assert.deepEqual(after.answers.map((a) => [a.label, a.line]), [['Important', 2]]);
    assert.deepEqual(after.problems, []);
    assert.deepEqual(after.owed, []);
  } finally {
    r.cleanup();
  }
});

test('the file is found by the branch\'s name: from the checkout, from the argument, or from "name"', () => {
  const r = repo();
  try {
    r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z', counts(1, 0, 0));
    r.write(FILE, '- R1.1 Nit: intended: The short name matches the public API.\n');
    r.commit('Answer');
    assert.equal(findingsFor(r.dir).file, FILE);
    assert.deepEqual(findingsFor(r.dir).owed, []);
    const tip = r.git('rev-parse', 'HEAD').trim();
    r.git('checkout', '-q', 'main');
    assert.deepEqual(findingsFor(r.dir, { branch: 'build/001-x' }).owed, []);
    assert.deepEqual(findingsFor(r.dir, { branch: tip, name: 'build/001-x' }).owed, []);
    // Read by its commit id with no name, the answers are looked for in another file, so they are owed.
    assert.deepEqual(findingsFor(r.dir, { branch: tip }).owed, [{ round: 1, missing: [1] }]);
    r.git('checkout', '-q', '--detach', tip);
    assert.throws(() => findingsFor(r.dir), /no branch is checked out here.*Name the branch/);
  } finally {
    r.cleanup();
  }
});

test('a receipt that is not valid JSON, or a ref git does not know, is a plain error', () => {
  const r = repo();
  try {
    assert.throws(() => findingsFor(r.dir, { base: 'origin/nope' }), /git has no branch or commit named origin\/nope/);
    assert.throws(() => findingsFor(r.dir, { branch: 'build/nope' }), /git has no branch or commit named build\/nope/);
    r.write('docs/receipts/T1-bad.json', '{ not json\n');
    r.commit('A broken receipt');
    assert.throws(() => findingsFor(r.dir, { base: 'main' }), /the review receipt docs\/receipts\/T1-bad\.json cannot be read.*Make it again/);
  } finally {
    r.cleanup();
  }
});

test('the command prints each round with its answers and the exact lines still to add, and exits 1 while one is owed', () => {
  const r = repo();
  try {
    r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z', counts(1, 1, 1));
    r.write(FILE, '- R1.2 Nit: wrong: The name follows the glossary entry.\n');
    r.commit('One answer');
    const res = r.cli();
    assert.equal(res.code, 1);
    assert.equal(res.stderr, '');
    assert.equal(res.stdout, [
      'Round 1 (docs/receipts/T1-00000001.json): 1 important, 1 nit, 1 pre-existing',
      '  R1.1 no answer yet',
      '  R1.2 Nit: wrong: The name follows the glossary entry.',
      '  R1.3 no answer yet',
      `2 answers still owed. Add one line for each to ${FILE} (make the file if it is not there), then commit it:`,
      '  - R1.1 <Important | Nit | Pre-existing>: <fixed | wrong | intended | not worth it | later>: <what you did, or why not, in one plain sentence>',
      '  - R1.3 <Important | Nit | Pre-existing>: <fixed | wrong | intended | not worth it | later>: <what you did, or why not, in one plain sentence>',
      '',
    ].join('\n'));
  } finally {
    r.cleanup();
  }
});

test('the command exits 0 when every finding has an answer, and when there is no receipt yet', () => {
  const r = repo();
  try {
    const none = r.cli();
    assert.deepEqual(none, { code: 0, stdout: 'No review receipt has been added on this branch yet, so no answer is owed.\n', stderr: '' });
    r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z', counts(0, 0, 1));
    r.receipt('T1-00000002', '2026-11-19T10:00:00.000Z');
    r.write(FILE, '- R1.1 Pre-existing: later: Logged in the mistakes list for the next slice.\n');
    r.commit('Answer');
    const done = r.cli('build/001-x');
    assert.equal(done.code, 0);
    assert.equal(done.stderr, '');
    assert.equal(done.stdout, [
      'Round 1 (docs/receipts/T1-00000001.json): 0 important, 0 nit, 1 pre-existing',
      '  R1.1 Pre-existing: later: Logged in the mistakes list for the next slice.',
      'Round 2 (docs/receipts/T1-00000002.json): this receipt holds no counts, so it owes no answers',
      'Every finding has an answer.',
      '',
    ].join('\n'));
  } finally {
    r.cleanup();
  }
});

test('an answer line with a problem makes the command exit 1 and say which file and line', () => {
  const r = repo();
  try {
    r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z', counts(1, 0, 0));
    r.write(FILE, '# Answers\n- R1.1 Nit: sorted: Renamed the helper in both files.\n');
    r.commit('A bad answer');
    const res = r.cli();
    assert.equal(res.code, 1);
    assert.match(res.stdout, /R1\.1 no answer yet/);
    assert.match(res.stderr, /^docs\/findings\/build-001-x\.md line 2: R1\.1: the outcome "sorted" is not one of/);
    assert.match(res.stderr, /A line with a problem does not count as an answer/);
  } finally {
    r.cleanup();
  }
});

test('describe shows an answer for a round that has no receipt yet', () => {
  const text = describe({ file: FILE, rounds: [], answers: [{ ...answer(1, 1), label: 'Nit' }], owed: [] });
  assert.equal(text, 'No review receipt has been added on this branch yet, so no answer is owed.\nRound 1: no review receipt on this branch yet\n  R1.1 Nit: fixed: Fixed it with a test.');
});

test('wrong usage exits 2 with the usage line; a git error exits 1', () => {
  const r = repo();
  try {
    for (const argv of [['--json'], ['a', 'b'], ['a', '--base']]) {
      const res = r.cli(...argv);
      assert.equal(res.code, 2, argv.join(' '));
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /^Wrong usage: .*\nUsage: node scripts\/findings\.mjs \[<branch>\]\n$/);
    }
    const res = r.cli('build/nope');
    assert.equal(res.code, 1);
    assert.match(res.stderr, /^findings: git has no branch or commit named build\/nope/);
  } finally {
    r.cleanup();
  }
  const outside = mkdtempSync(join(tmpdir(), 'kit-findings-none-'));
  try {
    let stderr = '';
    assert.equal(run([], { cwd: outside, stdout: () => {}, stderr: (s) => (stderr += s) }), 1);
    assert.match(stderr, /is not inside a git working tree/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------- Counts are taken from the reviewer's session record, not from the committed file ----------

const ROUND_1 = 'docs/receipts/T1-00000001.json';

test('a committed receipt whose count was edited down still owes what its session record says, and a note says the file does not match', () => {
  const r = repo();
  try {
    const made = r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z', counts(1));
    const honest = findingsFor(r.dir, { base: 'main' });
    assert.deepEqual([honest.rounds[0].counts, honest.owed, honest.notes, honest.unchecked], [counts(1), [{ round: 1, missing: [1] }], [], []]);
    r.write(ROUND_1, `${JSON.stringify({ ...made, counts: counts(0) }, null, 2)}\n`);
    r.commit('Edit the count to zero');
    const edited = findingsFor(r.dir, { base: 'main' });
    assert.deepEqual(edited.rounds[0].counts, counts(1), 'the record still says one');
    assert.deepEqual(edited.owed, [{ round: 1, missing: [1] }]);
    assert.match(edited.notes.join('\n'), /^docs\/receipts\/T1-00000001\.json does not match its session record, so its counts are taken from the record\. Make it again: node scripts\/receipt\.mjs make /);
    assert.deepEqual(edited.unchecked, []);
    // Taking the count out altogether does not make it an old receipt that owes nothing either.
    const { counts: gone, ...bare } = made;
    assert.deepEqual(gone, counts(1));
    r.write(ROUND_1, `${JSON.stringify(bare, null, 2)}\n`);
    r.commit('Take the count out');
    assert.deepEqual(findingsFor(r.dir, { base: 'main' }).owed, [{ round: 1, missing: [1] }]);
  } finally { r.cleanup(); }
});

test('a receipt whose session record cannot be read again is listed as unchecked, with its own counts shown', () => {
  const r = repo();
  try {
    const made = r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z', counts(1));
    r.write(ROUND_1, `${JSON.stringify({ ...made, session: '/nowhere/reviewer.jsonl', counts: counts(0) }, null, 2)}\n`);
    r.write('docs/receipts/T1-00000002.json', `${JSON.stringify({ task: 'T1', verdict: 'approve', model: 'gpt-6.1-sol', at: '2026-11-19T10:00:00.000Z', fingerprints: [], counts: counts(0) }, null, 2)}\n`);
    r.commit('Two receipts nobody can check');
    const found = findingsFor(r.dir, { base: 'main' });
    assert.deepEqual(found.unchecked, [ROUND_1, 'docs/receipts/T1-00000002.json']);
    assert.match(found.notes[0], /^docs\/receipts\/T1-00000001\.json: its session record cannot be read again \(ENOENT[^)]*\), so its counts cannot be checked$/);
    assert.match(found.notes[1], /^docs\/receipts\/T1-00000002\.json: its session record cannot be read again \(it names no session record\), so its counts cannot be checked$/);
    assert.deepEqual(found.rounds.map((x) => x.counts), [counts(0), counts(0)]);
  } finally { r.cleanup(); }
});

test('round 2, finding 3: the command names a receipt whose session record is gone and exits 1, also for an old receipt with no counts', () => {
  const r = repo();
  try {
    r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z'); // an older review: no COUNT line
    assert.deepEqual(r.cli(), { code: 0, stdout: `Round 1 (${ROUND_1}): this receipt holds no counts, so it owes no answers\nEvery finding has an answer.\n`, stderr: '' });
    renameSync(r.sessionOf('T1-00000001'), r.sessionOf('moved'));
    const out = r.cli();
    assert.equal(out.code, 1);
    assert.doesNotMatch(out.stdout, /Every finding has an answer/);
    assert.match(out.stdout, /^Not known whether every finding has an answer: 1 receipt cannot be checked \(see below\)\.$/m);
    assert.match(out.stderr, /^docs\/receipts\/T1-00000001\.json: its session record cannot be read again \(ENOENT[^\n]*\), so its counts cannot be checked\nA receipt that cannot be checked could have had its count edited down, so the merge gate stops on it\. Either put the session record back at the path the receipt names \(its "session" line\), or make the receipt again from where the record is now \(node scripts\/receipt\.mjs make <reviewer session file>\) and delete the old receipt file in the same commit\.\n$/);
  } finally { r.cleanup(); }
});

test('round 2, finding 4: after a session record moved, either way the message names works: the record put back, or a new receipt with the old file deleted in the same commit', () => {
  const r = repo();
  try {
    r.receipt('T1-00000001', '2026-11-19T09:00:00.000Z', counts(1));
    renameSync(r.sessionOf('T1-00000001'), r.sessionOf('moved'));
    assert.deepEqual(findingsFor(r.dir, { base: 'main' }).unchecked, [ROUND_1]);
    // A second receipt beside the stale one is not enough: the old file is still a round nobody can check.
    const again = buildReceipt(readFileSync(r.sessionOf('moved'), 'utf8'), r.sessionOf('moved'));
    r.write('docs/receipts/T1-00000009.json', `${JSON.stringify(again, null, 2)}\n`);
    r.commit('The receipt again, beside the old one');
    assert.deepEqual(findingsFor(r.dir, { base: 'main' }).unchecked, [ROUND_1]);
    // The second way: the old file deleted with it.
    r.git('rm', '-q', ROUND_1);
    r.commit('Delete the stale receipt');
    const fixed = findingsFor(r.dir, { base: 'main' });
    assert.deepEqual([fixed.unchecked, fixed.notes, fixed.rounds, fixed.owed], [[], [], [{ round: 1, receipt: 'docs/receipts/T1-00000009.json', counts: counts(1) }], [{ round: 1, missing: [1] }]]);
    // The first way: the record back at its old path.
    r.git('reset', '-q', '--hard', 'HEAD~2');
    renameSync(r.sessionOf('moved'), r.sessionOf('T1-00000001'));
    assert.deepEqual(findingsFor(r.dir, { base: 'main' }).unchecked, []);
  } finally { r.cleanup(); }
});

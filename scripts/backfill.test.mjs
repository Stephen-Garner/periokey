// Tests for backfill.mjs. Run: node --test scripts/backfill.test.mjs
// Each test makes a throwaway git repo in the temp folder, with one old plan on main and a folder of
// proposal files beside it; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFolder, backfillId, checkFolder, noonOf, run } from './backfill.mjs';
import { appendEvent, eventsFile, isoLocal, readEvents } from './events.mjs';
import { logTask, sliceStatus } from './slice.mjs';

// On a GitHub pull request run this names the real repo's base branch; the throwaway repos here have only main.
// An empty value counts as unset (scripts/check-plans.mjs), and setting one variable is ordinary test setup.
process.env.GITHUB_BASE_REF = '';

const PLAN_PATH = 'docs/plans/completed/075-availability.md';
const PLAN = `---
id: 75
status: done
depends_on: []
builder: "claude/claude-opus-5-5"
reviewer: "codex/gpt-6.1-sol"
tests: []
code: []
---

# 075: Availability

## Goal

Show when a tutor is free.

## Done when

- [x] The calendar shows free hours

## Tasks

1. **Calendar model:** the free hours rule
2. Booking page

## Progress log

- 2026-11-10: build started on the calendar model.
- 2026-11-11: task 1 merged (PR #579) after a Sol review (3 findings fixed)
  and an approving re-review.
- 2026-11-12: Task 2a: Review: approved by codex/gpt-6.1-sol on 2026-11-12 (2 findings fixed by the head agent). Task 2 merged (PR #581).

## Review

Review: approved by codex/gpt-6.1-sol on 2026-11-13. Slice done.
`;

const started = { type: 'slice-started', slice: 75, at: '2026-11-10', data: {}, evidence: '2026-11-10: build started on the calendar model.' };
const round1 = { type: 'review-round', slice: 75, at: '2026-11-11', model: 'codex/gpt-6.1-sol', data: { task: 1, part: null, round: 1, verdict: 'changes', findings: 3 }, evidence: 'after a Sol review (3 findings fixed)' };
// This quote crosses a line break in the plan: runs of spaces and line breaks count as one space.
const round2 = { type: 'review-round', slice: 75, at: '2026-11-11', model: 'codex/gpt-6.1-sol', data: { task: 1, part: null, round: 2, verdict: 'approved', findings: 0 }, evidence: '(3 findings fixed) and an approving re-review.' };
const done1 = { type: 'task-done', slice: 75, at: '2026-11-11', data: { task: 1, pr: 579 }, evidence: 'task 1 merged (PR #579)' };
const round2a = { type: 'review-round', slice: 75, at: '2026-11-12', model: null, data: { task: 2, part: '2a', round: 1, verdict: 'approved', findings: null }, evidence: 'Task 2a: Review: approved by codex/gpt-6.1-sol on 2026-11-12' };
const closed = { type: 'slice-closed', slice: 75, at: '2026-11-13', data: {}, evidence: 'Review: approved by codex/gpt-6.1-sol on 2026-11-13. Slice done.' };
const GOOD = [started, round1, round2, done1, round2a, closed];

const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

// A repo with the plan committed on main, and a proposals folder outside the repo. files: { '075.jsonl': rows }.
function setup(files = { '075.jsonl': GOOD }) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-backfill-'));
  const work = join(dir, 'project');
  const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  mkdirSync(join(work, 'docs', 'plans', 'completed'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(dir, 'no-hooks'));
  writeFileSync(join(work, PLAN_PATH), PLAN);
  git('add', '-A');
  git('commit', '-q', '-m', 'the old plan');
  const proposals = join(dir, 'proposals');
  mkdirSync(proposals);
  for (const [name, rows] of Object.entries(files)) writeFileSync(join(proposals, name), jsonl(rows));
  let out = '';
  let err = '';
  const io = { cwd: work, stdout: (s) => (out += s), stderr: (s) => (err += s) };
  return {
    dir, work, proposals, io,
    out: () => out, err: () => err,
    reset: () => { out = ''; err = ''; },
    log: () => (existsSync(eventsFile(work)) ? readFileSync(eventsFile(work), 'utf8') : ''),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('check passes a file whose every line is in the plan, and reads only NNN.jsonl files', () => {
  const t = setup({ '075.jsonl': GOOD, '075.notes.txt': ['not a proposal'], 'readme.jsonl': ['{bad'] });
  try {
    assert.equal(run(['check', t.proposals], t.io), 0);
    assert.equal(t.out(), 'ok: 6 lines in 1 file\n');
    assert.equal(t.log(), '', 'check never writes to the log');
  } finally {
    t.cleanup();
  }
});

test('check refuses each kind of made-up or malformed line, as file:line: reason', () => {
  const cases = [
    ['{not json', /not valid JSON/],
    ['[1, 2]', /not a JSON object/],
    [{ ...started, type: 'merge-blocked' }, /type must be one of slice-started, task-done, review-round, slice-closed/],
    [{ ...started, slice: 76 }, /slice must be 75/],
    [{ ...started, at: '2026-11-10T09:00:00' }, /at must be a real day like 2026-11-11/],
    [{ ...started, at: '2026-02-31' }, /at must be a real day/],
    [{ ...started, at: '2026-11-09' }, /the date 2026-11-09 is nowhere in the plan/],
    [{ ...started, evidence: 'too short' }, /evidence must be a quote of 10 to 240 characters/],
    [{ ...started, evidence: 'x'.repeat(241) }, /evidence must be a quote of 10 to 240 characters/],
    [{ ...started, evidence: '2026-11-10: build began on the calendar model.' }, /the evidence quote is not in the plan word for word/],
    [{ ...started, data: null }, /data must be an object/],
    [{ ...done1, data: { task: 3, pr: 579 } }, /data\.task must be a task number from the plan \(1, 2\)/],
    [{ ...done1, data: { task: 1, pr: '579' } }, /data\.pr must be a pull request number or null/],
    [{ ...round1, data: { ...round1.data, task: 9 } }, /data\.task must be null or a task number from the plan/],
    [{ ...round1, data: { ...round1.data, part: 'much too long' } }, /data\.part must be null or a short label like 2a/],
    [{ ...round1, data: { ...round1.data, round: 0 } }, /data\.round must be 1 or more/],
    [{ ...round1, data: { ...round1.data, verdict: 'fine' } }, /data\.verdict must be approved or changes/],
    [{ ...round1, data: { ...round1.data, findings: -1 } }, /data\.findings must be a count or null/],
    [{ ...round1, model: 'Sol' }, /model must be null or tool\/model-id/],
  ];
  for (const [row, why] of cases) {
    const t = setup({ '075.jsonl': [started, row].slice(typeof row === 'object' && row.type === 'slice-started' ? 1 : 0) });
    try {
      const line = typeof row === 'object' && row.type === 'slice-started' ? 1 : 2;
      assert.equal(run(['check', t.proposals], t.io), 1, JSON.stringify(row));
      assert.match(t.err(), new RegExp(`075\\.jsonl:${line}: `), 'the problem names the file and the line');
      assert.match(t.err(), why);
      assert.equal(t.out(), '');
    } finally {
      t.cleanup();
    }
  }
});

test('check refuses a line that says the same thing twice, and a file whose number no plan has', () => {
  const t = setup({ '075.jsonl': [started, done1, { ...done1, evidence: 'Task 2 merged (PR #581).' }, round1, round1, { ...started }], '099.jsonl': [{ ...started, slice: 99 }] });
  try {
    const res = checkFolder(t.work, t.proposals);
    assert.deepEqual(res.problems.map((p) => [p.file.slice(-9), p.line, p.reason]), [
      ['075.jsonl', 3, 'repeats an earlier line (75|task-done|1||)'],
      ['075.jsonl', 5, 'repeats an earlier line (75|review-round|1||1)'],
      ['075.jsonl', 6, 'repeats an earlier line (75|slice-started|||)'],
      ['099.jsonl', 0, 'no plan file starts with 099- in docs/plans/active or docs/plans/completed on main'],
    ]);
    assert.deepEqual([res.files, res.lines], [2, 7]);
  } finally {
    t.cleanup();
  }
});

test('apply writes each line as one event: noon of its day, a stable id, the plan as source, the quote as evidence', () => {
  const t = setup();
  try {
    assert.equal(run(['apply', t.proposals], t.io), 0);
    assert.equal(t.out(), [
      '6 lines read from 1 file; 6 events written, 0 skipped (already in the log)',
      '  slice-started  written 1, skipped 0',
      '  task-done      written 1, skipped 0',
      '  review-round   written 3, skipped 0',
      '  slice-closed   written 1, skipped 0',
      '',
    ].join('\n'));
    const { events } = readEvents(t.work);
    assert.deepEqual(events.map((e) => [e.type, e.at]), [
      ['slice-started', isoLocal(new Date(2026, 10, 10, 12).getTime())],
      ['review-round', isoLocal(new Date(2026, 10, 11, 12).getTime())],
      ['review-round', isoLocal(new Date(2026, 10, 11, 12).getTime())],
      ['task-done', isoLocal(new Date(2026, 10, 11, 12).getTime())],
      ['review-round', isoLocal(new Date(2026, 10, 12, 12).getTime())],
      ['slice-closed', isoLocal(new Date(2026, 10, 13, 12).getTime())],
    ]);
    const sha = (key) => createHash('sha1').update(key).digest('hex').slice(0, 8);
    assert.deepEqual(events.map((e) => e.id), ['75|slice-started|||', '75|review-round|1||1', '75|review-round|1||2', '75|task-done|1||', '75|review-round|2|2a|1', '75|slice-closed|||'].map(sha));
    assert.deepEqual(events[1], {
      id: sha('75|review-round|1||1'), at: isoLocal(new Date(2026, 10, 11, 12).getTime()), type: 'review-round', branch: null, slice: 75, thread: null, role: 'reviewer', model: 'codex/gpt-6.1-sol',
      data: { task: 1, part: null, round: 1, verdict: 'changes', findings: 3, backfilled: true, dateOnly: true, source: PLAN_PATH, evidence: round1.evidence },
    });
    assert.deepEqual(events[3], {
      id: sha('75|task-done|1||'), at: isoLocal(new Date(2026, 10, 11, 12).getTime()), type: 'task-done', branch: null, slice: 75, thread: null, role: null, model: null,
      data: { task: 1, pr: 579, title: 'Calendar model: the free hours rule', backfilled: true, dateOnly: true, source: PLAN_PATH, evidence: done1.evidence },
    });
    assert.deepEqual([events[0].role, events[0].model, events[4].model, events[5].data], [null, null, null, { backfilled: true, dateOnly: true, source: PLAN_PATH, evidence: closed.evidence }]);
  } finally {
    t.cleanup();
  }
});

test('apply twice adds nothing: every id is already in the log, and the second run says how many it skipped', () => {
  const t = setup();
  try {
    assert.equal(run(['apply', t.proposals], t.io), 0);
    const first = t.log();
    t.reset();
    assert.equal(run(['apply', t.proposals], t.io), 0);
    assert.equal(t.log(), first, 'the log is byte for byte the same');
    assert.match(t.out(), /^6 lines read from 1 file; 0 events written, 6 skipped \(already in the log\)\n/);
    assert.match(t.out(), /review-round {3}written 0, skipped 3/);

    // A new line in the same file is the only one written the next time.
    writeFileSync(join(t.proposals, '075.jsonl'), jsonl([...GOOD, { type: 'task-done', slice: 75, at: '2026-11-12', data: { task: 2, pr: 581 }, evidence: 'Task 2 merged (PR #581).' }]));
    const res = applyFolder(t.work, t.proposals);
    assert.deepEqual([res.written, res.skipped, res.byType['task-done']], [1, 6, { read: 2, written: 1, skipped: 1 }]);
    assert.equal(readEvents(t.work).events.length, 7);
  } finally {
    t.cleanup();
  }
});

test('apply writes nothing at all when any line of any file fails, and --dry-run writes nothing either', () => {
  const t = setup({ '075.jsonl': GOOD, '076.jsonl': [{ ...started, slice: 76 }] });
  try {
    assert.equal(run(['apply', t.proposals], t.io), 1);
    assert.match(t.err(), /076\.jsonl:0: no plan file starts with 076-/);
    assert.match(t.err(), /backfill: 1 problem in 2 files\. Nothing was written\.\n$/);
    assert.equal(t.log(), '', 'the six good lines of the other file were not written');

    rmSync(join(t.proposals, '076.jsonl'));
    t.reset();
    assert.equal(run(['apply', t.proposals, '--dry-run'], t.io), 0);
    assert.match(t.out(), /^dry run, nothing written: 6 lines read from 1 file; 6 events would be written, 0 skipped/);
    assert.equal(t.log(), '');
  } finally {
    t.cleanup();
  }
});

test('an id that the log holds on a different event, or that two different lines share, is an error and nothing is written', () => {
  const t = setup({ '075.jsonl': [started, closed] });
  try {
    appendEvent(t.work, { id: backfillId(started), type: 'ask', data: { title: 'Pick a name?' }, slice: null, branch: null }, { env: {} });
    const before = t.log();
    assert.equal(run(['apply', t.proposals], t.io), 1);
    assert.match(t.err(), new RegExp(`075\\.jsonl:1: its event id \\(${backfillId(started)}\\) is already in the log on a different event \\(ask\\)`));
    assert.equal(t.log(), before);
  } finally {
    t.cleanup();
  }
  // Two review rounds whose SHA-1 starts with the same 8 hex characters (found by trying 400,000 round numbers).
  const a = { ...round1, slice: 7, data: { task: null, part: null, round: 19793, verdict: 'changes', findings: null } };
  const b = { ...a, data: { ...a.data, round: 35423 } };
  assert.equal(backfillId(a), backfillId(b), 'the two lines really do get the same id');
  const u = setup({ '075.jsonl': [] });
  try {
    execFileSync('git', ['mv', PLAN_PATH, 'docs/plans/completed/007-availability.md'], { cwd: u.work });
    execFileSync('git', ['commit', '-q', '-m', 'renumber'], { cwd: u.work });
    writeFileSync(join(u.proposals, '007.jsonl'), jsonl([a, b]));
    assert.equal(run(['apply', u.proposals], u.io), 1);
    assert.match(u.err(), /007\.jsonl:2: gets the same event id \(9e53f52a\) as a different line \(7\|review-round\|\|\|19793\)/);
    assert.equal(u.log(), '');
  } finally {
    u.cleanup();
  }
});

test('a backfilled task-done counts like a live one, and the newest event by time wins wherever it sits in the file', () => {
  const t = setup();
  try {
    // A live event is written first, with today's time. The backfill then appends older days after it.
    const live = logTask(t.work, 'start', 1, { slice: 75 }, { env: {}, now: new Date(2026, 10, 18, 9).getTime() });
    assert.equal(live.written, true);
    assert.equal(run(['apply', t.proposals], t.io), 0);
    const { events } = readEvents(t.work);
    assert.equal(events.at(-1).id, live.event.id, 'readers get events oldest first, so the live one from the 18th comes last');
    assert.deepEqual(events.map((e) => Date.parse(e.at)), events.map((e) => Date.parse(e.at)).sort((x, y) => x - y));
    // The plan here is on main with status done, so read the states through the task events alone.
    const mine = events.filter((e) => e.slice === 75 && e.type.startsWith('task-') && e.data.task === 1);
    assert.deepEqual(mine.map((e) => [e.type, e.data.backfilled === true]), [['task-done', true], ['task-started', false]], 'task 1: done on the 11th, put back in work on the 18th');
  } finally {
    t.cleanup();
  }
  const u = setup();
  try {
    execFileSync('git', ['-C', u.work, 'commit', '-q', '--allow-empty', '-m', 'x']);
    writeFileSync(join(u.work, PLAN_PATH), PLAN.replace('status: done', 'status: in_progress'));
    execFileSync('git', ['-C', u.work, 'commit', '-q', '-am', 'reopen']);
    assert.deepEqual(sliceStatus(u.work, { slice: 75 }).tasks.map((x) => x.state), ['todo', 'todo']);
    assert.equal(run(['apply', u.proposals], u.io), 0);
    const st = sliceStatus(u.work, { slice: 75 });
    assert.deepEqual([st.done, st.total, st.logged], [1, 2, true]);
    assert.deepEqual(st.tasks, [
      { n: 1, title: 'Calendar model: the free hours rule', state: 'done', at: isoLocal(noonOf('2026-11-11')), backfilled: true, dateOnly: true },
      { n: 2, title: 'Booking page', state: 'todo', at: null },
    ], 'the row says it came from old records, so the dashboard can mark it');
    // Logging the same task done by hand afterwards writes nothing: it already has that state.
    assert.equal(logTask(u.work, 'done', 1, { slice: 75 }, { env: {} }).written, false);
    // A later live start wins over the old backfilled done, though the file holds it after.
    logTask(u.work, 'start', 1, { slice: 75 }, { env: {} });
    const [now1] = sliceStatus(u.work, { slice: 75 }).tasks;
    assert.deepEqual([now1.state, 'backfilled' in now1], ['doing', false]);
  } finally {
    u.cleanup();
  }
});

test('wrong usage exits 2 with how to run it; a folder that is not there is an error', () => {
  const t = setup();
  try {
    for (const argv of [[], ['load', t.proposals], ['check'], ['check', t.proposals, '--dry-run'], ['apply', t.proposals, '--force'], ['apply', t.proposals, t.proposals]]) {
      t.reset();
      assert.equal(run(argv, t.io), 2, argv.join(' '));
      assert.match(t.err(), /^Wrong usage: .*\nUsage: node scripts\/backfill\.mjs check <folder>/);
    }
    t.reset();
    assert.equal(run(['check', join(t.dir, 'nowhere')], t.io), 1);
    assert.match(t.err(), /^backfill: .*nowhere is not a folder\.\n$/);
    assert.equal(noonOf('2026-11-11'), new Date(2026, 10, 11, 12).getTime());
    assert.equal(noonOf('2026-13-01'), null);
  } finally {
    t.cleanup();
  }
});

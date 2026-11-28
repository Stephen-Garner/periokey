// Tests for slice.mjs. Run: node --test scripts/slice.test.mjs
// Each test makes a throwaway git repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkNewPlans, parsePlan, parseTasks, tasksProblem, validatePlan } from './check-plans.mjs';
import { appendEvent, eventsFile, readEvents } from './events.mjs';
import {
  DEFAULT_MAX_PRS_PER_THREAD, DEFAULT_MAX_TASKS_PER_THREAD,
  fillTemplate, formatRelayBaton, listSlices, logTask, newPlan, readPlans, run,
  sliceHealth, sliceStatus, sliceTasks, taskStates,
} from './slice.mjs';

// A small plan template with the kit template's shape, so these tests run the same in the kit and in a
// project (kit/sync.mjs copies this file into projects). The kit's real template is tested in kit/template.test.mjs.
const TEMPLATE = `---
id: 0
status: todo
depends_on: []
builder: ""
reviewer: ""
tests: []
code: []
invariants: none
risk: normal
undo: revert the merge commit
owns: none
proof: the test run
log: docs/plans/logs/NNN-short-name.md
---

# NNN: Slice name

<!-- Made as docs/plans/active/NNN-short-name.md. Delete this comment when filled. -->

## Goal

One sentence a user would understand.

## Done when

- [ ] A testable outcome

## Tasks

<!-- A numbered list. Name the branch for each: build/NNN-short-name, then -2, -3.
1. A line inside a comment is not a task. -->

1. Task small enough for one fresh worker

## Decision log

## Review
`;
const OPTS = { env: {} };

const plan = (id, { status = 'in_progress', title = 'Search', tasks = '1. **Order module:** the rule.\n2. Server marking\n3. Result page\n' } = {}) => `---
id: ${id}
status: ${status}
depends_on: []
builder: "claude/claude-opus-5-5"
reviewer: "codex/gpt-6.1-sol"
tests: []
code: []
---

# ${String(id).padStart(3, '0')}: ${title}

## Goal

A goal.

## Done when

- [ ] It works

## Tasks

All tasks run in order on one branch.

${tasks}
## Review
`;

// A repo on main with the given files committed. Returns helpers; call cleanup when done.
function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-slice-'));
  const sh = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'user.name', 'Test');
  sh('config', 'commit.gpgsign', 'false');
  sh('config', 'core.hooksPath', join(dir, 'no-hooks'));
  for (const [path, text] of Object.entries(files)) write(path, text);
  sh('add', '-A');
  sh('commit', '-q', '--allow-empty', '-m', 'init');
  return { dir, sh, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Runs the command line in dir. Returns { code, out, err }.
function cli(dir, ...argv) {
  let out = '';
  let err = '';
  const code = run(argv, { cwd: dir, env: {}, stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, out, err };
}

const P82 = 'docs/plans/active/082-search.md';
const taskEvents = (dir) => readEvents(dir).events.map((e) => [e.type, e.slice, e.data.task]);

test('taskStates: a task is todo with no event, else the state of its newest event for that slice', () => {
  const tasks = [{ n: 1, title: 'one' }, { n: 2, title: 'two' }, { n: 3, title: 'three' }, { n: 4, title: 'four' }];
  const ev = (type, slice, task, at) => ({ type, slice, at, data: { task } });
  const events = [
    ev('task-started', 82, 1, '2026-11-18T01:00:00Z'), ev('task-done', 82, 1, '2026-11-18T02:00:00Z'),
    ev('task-started', 82, 2, '2026-11-18T03:00:00Z'),
    ev('task-dropped', 82, 4, '2026-11-18T04:00:00Z'),
    ev('task-done', 84, 3, '2026-11-18T05:00:00Z'), // another slice: not ours
    ev('ask', 82, 3, '2026-11-18T06:00:00Z'), // another type: not a task event
  ];
  assert.deepEqual(taskStates(tasks, events, 82), [
    { n: 1, title: 'one', state: 'done', at: '2026-11-18T02:00:00Z' },
    { n: 2, title: 'two', state: 'doing', at: '2026-11-18T03:00:00Z' },
    { n: 3, title: 'three', state: 'todo', at: null },
    { n: 4, title: 'four', state: 'dropped', at: '2026-11-18T04:00:00Z' },
  ]);
  // Started again after done: the task is back in work.
  assert.equal(taskStates(tasks, [...events, ev('task-started', 82, 1, '2026-11-18T07:00:00Z')], 82)[0].state, 'doing');
});

test('sliceTasks: dropped tasks leave the total; a done slice counts as fully done; logged needs a task event', () => {
  const tasks = [{ n: 1, title: 'one' }, { n: 2, title: 'two' }, { n: 3, title: 'three' }];
  const ev = (type, task) => ({ type, slice: 82, at: '2026-11-18T01:00:00Z', data: { task } });
  const events = [ev('task-done', 1), ev('task-dropped', 3)];
  const live = sliceTasks({ slice: 82, status: 'in_progress', tasks }, events);
  assert.deepEqual([live.done, live.total, live.logged], [1, 2, true]);
  const closed = sliceTasks({ slice: 82, status: 'done', tasks }, events);
  assert.deepEqual([closed.done, closed.total], [2, 2]);
  assert.deepEqual(closed.tasks.map((t) => t.state), ['done', 'done', 'dropped']);
  const quiet = sliceTasks({ slice: 82, status: 'in_progress', tasks }, [{ type: 'ask', slice: 82, at: 'x', data: {} }, { type: 'task-done', slice: 84, at: 'x', data: { task: 1 } }]);
  assert.deepEqual([quiet.done, quiet.total, quiet.logged], [0, 3, false]);
});

test('task start, done, and drop write one event each, with the slice at the top and the task in data', () => {
  const r = repo({ [P82]: plan(82) });
  try {
    const started = logTask(r.dir, 'start', 1, { slice: 82 }, OPTS);
    assert.equal(started.written, true);
    assert.deepEqual([started.event.type, started.event.slice, started.event.data], ['task-started', 82, { task: 1, title: 'Order module: the rule.' }]);
    const done = logTask(r.dir, 'done', '1', { slice: '082', note: '  Tests pass.  ' }, OPTS);
    assert.deepEqual([done.event.type, done.event.slice, done.event.data], ['task-done', 82, { task: 1, title: 'Order module: the rule.', note: 'Tests pass.' }]);
    assert.deepEqual(logTask(r.dir, 'done', 2, { slice: 82 }, OPTS).event.data, { task: 2, title: 'Server marking', note: null });
    const dropped = logTask(r.dir, 'drop', 3, { slice: 82, why: 'Moved to slice 90.' }, OPTS);
    assert.deepEqual([dropped.event.type, dropped.event.data], ['task-dropped', { task: 3, title: 'Result page', why: 'Moved to slice 90.' }]);
    assert.deepEqual(taskEvents(r.dir), [['task-started', 82, 1], ['task-done', 82, 1], ['task-done', 82, 2], ['task-dropped', 82, 3]]);
  } finally {
    r.cleanup();
  }
});

test('running a task command twice writes nothing the second time, exits 0, and says so', () => {
  const r = repo({ [P82]: plan(82) });
  try {
    const first = cli(r.dir, 'task', 'done', '1', '--slice', '82');
    assert.deepEqual([first.code, first.out], [0, 'done: slice 082 task 1 (Order module: the rule.)\n']);
    const again = cli(r.dir, 'task', 'done', '1', '--slice', '82', '--note', 'Again.');
    assert.equal(again.code, 0);
    assert.match(again.out, /^already done since \S+: slice 082 task 1 \(Order module: the rule\.\); nothing written\n$/);
    assert.equal(cli(r.dir, 'task', 'start', '2', '--slice', '82').code, 0);
    assert.match(cli(r.dir, 'task', 'start', '2', '--slice', '82').out, /^already doing since /);
    assert.equal(cli(r.dir, 'task', 'drop', '3', '--slice', '82', '--why', 'Not needed.').code, 0);
    assert.match(cli(r.dir, 'task', 'drop', '3', '--slice', '82', '--why', 'Not needed.').out, /^already dropped since /);
    assert.deepEqual(taskEvents(r.dir), [['task-done', 82, 1], ['task-started', 82, 2], ['task-dropped', 82, 3]]);
    // A different state is a real change, so it is written: a done task can be taken up again.
    assert.equal(cli(r.dir, 'task', 'start', '1', '--slice', '82').out, 'doing: slice 082 task 1 (Order module: the rule.)\n');
    assert.equal(taskEvents(r.dir).length, 4);
  } finally {
    r.cleanup();
  }
});

test('a task number that is not in the plan is refused, with the numbers that exist, and nothing is written', () => {
  const r = repo({ [P82]: plan(82), 'docs/plans/active/083-bare.md': plan(83, { tasks: 'Nothing numbered yet.\n' }) });
  try {
    const bad = cli(r.dir, 'task', 'done', '9', '--slice', '82');
    assert.equal(bad.code, 2);
    assert.equal(bad.err, `Refused: Slice 082 has no task 9. Its plan (${P82}) lists these task numbers: 1, 2, 3.\n`);
    const bare = cli(r.dir, 'task', 'start', '1', '--slice', '83');
    assert.equal(bare.code, 2);
    assert.match(bare.err, /^Refused: The plan for slice 083 \(docs\/plans\/active\/083-bare\.md\) has no numbered tasks under "## Tasks"/);
    const noPlan = cli(r.dir, 'task', 'done', '1', '--slice', '99');
    assert.equal(noPlan.code, 1);
    assert.match(noPlan.err, /^slice: No plan file starts with 099- /);
    assert.ok(!existsSync(eventsFile(r.dir)));
  } finally {
    r.cleanup();
  }
});

test('the slice comes from the branch name when --slice is missing; a branch with no number is wrong usage', () => {
  const r = repo({ [P82]: plan(82), 'docs/plans/active/084-sign-in.md': plan(84, { title: 'Sign-in' }) });
  try {
    const none = cli(r.dir, 'task', 'done', '1');
    assert.equal(none.code, 2);
    assert.match(none.err, /^Wrong usage: The branch main has no slice number in its name \(build\/082-x is slice 82\)\. Pass --slice N\.\nUsage: /);
    r.sh('switch', '-q', '-c', 'build/082-search-2');
    assert.equal(cli(r.dir, 'task', 'done', '1').out, 'done: slice 082 task 1 (Order module: the rule.)\n');
    // --slice wins over the branch.
    assert.equal(cli(r.dir, 'task', 'start', '2', '--slice', '84').code, 0);
    assert.deepEqual(taskEvents(r.dir), [['task-done', 82, 1], ['task-started', 84, 2]]);
    assert.deepEqual(readEvents(r.dir).events.map((e) => e.branch), ['build/082-search-2', 'build/082-search-2']);
  } finally {
    r.cleanup();
  }
});

test('a plan the working tree lacks is read from the base ref; the working tree copy wins when both exist', () => {
  const r = repo({ 'README.md': 'x\n' });
  try {
    // The builder's branch was cut before the plan merged into main.
    r.sh('switch', '-q', '-c', 'build/082-search');
    r.sh('switch', '-q', 'main');
    r.write(P82, plan(82));
    r.sh('add', '-A');
    r.sh('commit', '-q', '-m', 'plan 082');
    r.sh('switch', '-q', 'build/082-search');
    assert.ok(!existsSync(join(r.dir, P82)));
    assert.deepEqual(readPlans(r.dir).map((p) => [p.slice, p.from, p.tasks.length]), [[82, 'main', 3]]);
    assert.equal(cli(r.dir, 'task', 'done', '3').code, 0);
    assert.equal(cli(r.dir, 'task', 'done', '4').code, 2);
    // Now the working tree has its own copy with a fourth task.
    r.write(P82, plan(82, { tasks: '1. a\n2. b\n3. c\n4. d\n' }));
    assert.deepEqual(readPlans(r.dir).map((p) => [p.slice, p.from, p.tasks.length]), [[82, 'the working tree', 4]]);
    assert.equal(cli(r.dir, 'task', 'done', '4').code, 0);
  } finally {
    r.cleanup();
  }
});

test('the plan folder comes from the kit settings', () => {
  const r = repo({ 'scripts/kit.config.json': JSON.stringify({ plansDir: 'notes/plans' }), 'notes/plans/active/082-search.md': plan(82), [P82]: plan(82, { tasks: '1. only one\n' }) });
  try {
    assert.equal(sliceStatus(r.dir, { slice: 82 }).path, 'notes/plans/active/082-search.md');
    assert.equal(cli(r.dir, 'task', 'done', '3', '--slice', '82').code, 0);
  } finally {
    r.cleanup();
  }
});

test('wrong usage and refused text exit 2 and write nothing', () => {
  const r = repo({ [P82]: plan(82) });
  try {
    const cases = [
      [['task'], /^Wrong usage: task needs start, done, or drop\./],
      [['task', 'finish', '1'], /^Wrong usage: task needs start, done, or drop\./],
      [['task', 'done', '--slice', '82'], /^Wrong usage: task done needs the task number, such as 3\./],
      [['task', 'done', 'two', '--slice', '82'], /^Wrong usage: task done needs the task number/],
      [['task', 'done', '1', '--slice', 'x'], /^Wrong usage: --slice needs a slice number, such as 82\./],
      [['task', 'start', '1', '--slice', '82', '--note', 'x'], /^Wrong usage: unknown option --note/],
      [['task', 'done', '1', '2', '--slice', '82'], /^Wrong usage: unexpected 2/],
      [['task', 'drop', '1', '--slice', '82'], /^Refused: Dropping a task needs --why/],
      [['task', 'done', '1', '--slice', '82', '--note', 'n'.repeat(301)], /^Refused: The note is 301 characters; shorten it to 300 or fewer\./],
      [['task', 'drop', '1', '--slice', '82', '--why', 'w'.repeat(301)], /^Refused: The why is 301 characters; shorten it to 300 or fewer\./],
      [['list', '--status', 'finished'], /^Wrong usage: --status must be one of: todo, in_progress, in_review, blocked, parked, done\./],
      [['status', '--slice'], /^Wrong usage: --slice needs a value\./],
      [['new', '--title', 'T'], /^Wrong usage: new needs a short name/],
      [['new', 'Bad_Name', '--title', 'T'], /^Wrong usage: new needs a short name/],
      [['new', 'ok-name'], /^Wrong usage: new needs --title/],
      [['frobnicate'], /^Wrong usage: unknown command frobnicate/],
      [[], /^Wrong usage: no command/],
    ];
    for (const [argv, msg] of cases) {
      const res = cli(r.dir, ...argv);
      assert.equal(res.code, 2, argv.join(' '));
      assert.match(res.err, msg, argv.join(' '));
    }
    assert.ok(!existsSync(eventsFile(r.dir)));
  } finally {
    r.cleanup();
  }
});

test('status lists each task with its state and time, as text and as JSON', () => {
  const r = repo({ [P82]: plan(82) });
  try {
    r.sh('switch', '-q', '-c', 'build/082-search');
    const done = logTask(r.dir, 'done', 1, {}, OPTS);
    const doing = logTask(r.dir, 'start', 2, {}, OPTS);
    const s = sliceStatus(r.dir);
    assert.deepEqual(s, {
      slice: 82, title: 'Search', status: 'in_progress', path: P82,
      tasks: [
        { n: 1, title: 'Order module: the rule.', state: 'done', at: done.event.at },
        { n: 2, title: 'Server marking', state: 'doing', at: doing.event.at },
        { n: 3, title: 'Result page', state: 'todo', at: null },
      ],
      done: 1, total: 3, logged: true,
    });
    const json = cli(r.dir, 'status', '--json');
    assert.deepEqual(JSON.parse(json.out), s);
    const text = cli(r.dir, 'status', '--slice', '82').out.split('\n');
    assert.equal(text[0], 'slice 082: Search (in_progress), 1 of 3 tasks done');
    assert.match(text[1], new RegExp(`^  1  done   ${done.event.at.replace(/[+]/g, '\\+')}  Order module: the rule\\.$`));
    assert.match(text[2], /^  2  doing  \S+  Server marking$/);
    assert.match(text[3], /^  3  todo   -\s+Result page$/);
  } finally {
    r.cleanup();
  }
});

test('list gives one line per plan from the headers: id, status, builder, reviewer, tasks done of total', () => {
  const r = repo({
    [P82]: plan(82),
    'docs/plans/active/084-sign-in.md': plan(84, { status: 'todo', title: 'Sign-in', tasks: '1. a\n2. b\n' }).replace('builder: "claude/claude-opus-5-5"', 'builder: ""').replace('reviewer: "codex/gpt-6.1-sol"', 'reviewer: ""'),
    'docs/plans/active/085-old.md': plan(85, { status: 'blocked', title: 'Old plan', tasks: 'No numbered list.\n' }),
    'docs/plans/completed/001-shell.md': plan(1, { status: 'done', title: 'Shell', tasks: '1. a\n2. b\n' }),
    'docs/plans/active/notes.md': 'not a plan\n',
  });
  try {
    logTask(r.dir, 'done', 1, { slice: 82 }, OPTS);
    logTask(r.dir, 'drop', 3, { slice: 82, why: 'Cut.' }, OPTS);
    const rows = listSlices(r.dir);
    assert.deepEqual(rows.map((x) => [x.id, x.status, x.builder, x.reviewer, x.done, x.total, x.title]), [
      [1, 'done', 'claude/claude-opus-5-5', 'codex/gpt-6.1-sol', 2, 2, 'Shell'],
      [82, 'in_progress', 'claude/claude-opus-5-5', 'codex/gpt-6.1-sol', 1, 2, 'Search'],
      [84, 'todo', null, null, 0, 2, 'Sign-in'],
      [85, 'blocked', 'claude/claude-opus-5-5', 'codex/gpt-6.1-sol', 0, 0, 'Old plan'],
    ]);
    assert.equal(rows[1].path, P82);
    const text = cli(r.dir, 'list');
    assert.equal(text.code, 0);
    assert.deepEqual(text.out.trimEnd().split('\n').map((l) => l.split(/ {2,}/)), [
      ['001', 'done', 'claude/claude-opus-5-5', 'codex/gpt-6.1-sol', '2 of 2 tasks', 'Shell'],
      ['082', 'in_progress', 'claude/claude-opus-5-5', 'codex/gpt-6.1-sol', '1 of 2 tasks', 'Search'],
      ['084', 'todo', '-', '-', '0 of 2 tasks', 'Sign-in'],
      ['085', 'blocked', 'claude/claude-opus-5-5', 'codex/gpt-6.1-sol', 'no tasks', 'Old plan'],
    ]);
    assert.deepEqual(JSON.parse(cli(r.dir, 'list', '--status', 'in_progress', '--json').out).map((x) => x.id), [82]);
    assert.equal(cli(r.dir, 'list', '--status', 'parked').out, 'no plans\n');
  } finally {
    r.cleanup();
  }
});

test('new writes a plan from the template with the next free number, id, log, and title, plus its log file', () => {
  const r = repo({
    'docs/plans/_template.md': TEMPLATE,
    'docs/plans/active/004-search.md': plan(4),
    'docs/plans/completed/002-shell.md': plan(2, { status: 'done' }),
    'docs/roadmap.md': '| 004 | Search | [plan](plans/active/004-search.md) |\n',
  });
  try {
    const res = cli(r.dir, 'new', 'save-word', '--title', 'Save a $1 word');
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /^wrote docs\/plans\/active\/005-save-word\.md and docs\/plans\/logs\/005-save-word\.md\n/);
    const text = readFileSync(join(r.dir, 'docs/plans/active/005-save-word.md'), 'utf8');
    assert.match(text, /^---\nid: 5\nstatus: todo\n/);
    assert.match(text, /\nlog: docs\/plans\/logs\/005-save-word\.md\n---\n\n# 005: Save a \$1 word\n/);
    assert.ok(!text.includes('NNN-short-name'));
    assert.ok(text.includes('Made as docs/plans/active/005-save-word.md.') && text.includes('build/005-save-word, then -2, -3.'), 'the name is filled in everywhere');
    assert.equal(readFileSync(join(r.dir, 'docs/plans/logs/005-save-word.md'), 'utf8'), '# 005: Save a $1 word log\n');
    // The generated file is a valid plan as it stands, so the checker has nothing to say about its shape.
    assert.deepEqual(validatePlan(text, '005-save-word.md', 'active').errors, []);
    assert.deepEqual(readPlans(r.dir).find((p) => p.slice === 5).tasks.map((t) => t.n), [1]);
    // The next one takes the next number.
    assert.match(cli(r.dir, 'new', 'theme', '--title', 'Theme').out, /^wrote docs\/plans\/active\/006-theme\.md /);
  } finally {
    r.cleanup();
  }
});

test('new counts plan numbers on the base ref too, and refuses to overwrite a file', () => {
  const r = repo({ 'docs/plans/_template.md': TEMPLATE, 'docs/plans/active/003-a.md': plan(3) });
  try {
    // main moves on to plan 007 after this branch was cut, so the working tree does not have it.
    r.sh('switch', '-q', '-c', 'lead/next');
    r.sh('switch', '-q', 'main');
    r.write('docs/plans/completed/007-b.md', plan(7, { status: 'done' }));
    r.sh('add', '-A');
    r.sh('commit', '-q', '-m', 'plan 007');
    r.sh('switch', '-q', 'lead/next');
    assert.equal(newPlan(r.dir, 'c', { title: 'C' }).id, 8);

    // The log file for the next number is already there: refuse, and write no plan either.
    r.write('docs/plans/logs/009-d.md', 'kept\n');
    const res = cli(r.dir, 'new', 'd', '--title', 'D');
    assert.equal(res.code, 2);
    assert.equal(res.err, 'Refused: docs/plans/logs/009-d.md already exists; nothing was written. Move or delete it first, or pick another name.\n');
    assert.ok(!existsSync(join(r.dir, 'docs/plans/active/009-d.md')));
    assert.equal(readFileSync(join(r.dir, 'docs/plans/logs/009-d.md'), 'utf8'), 'kept\n');
  } finally {
    r.cleanup();
  }
});

test('new says so when the template is missing; fillTemplate adds header fields an older template lacks', () => {
  const r = repo({ 'README.md': 'x\n' });
  try {
    const res = cli(r.dir, 'new', 'a', '--title', 'A');
    assert.equal(res.code, 1);
    assert.equal(res.err, 'slice: docs/plans/_template.md is missing, so there is nothing to make the plan from.\n');
  } finally {
    r.cleanup();
  }
  const old = '---\nid: 0\nstatus: todo\n---\n\n# NNN: Slice name\n\n## Tasks\n\n1. One\n';
  assert.equal(fillTemplate(old, { id: 12, name: 'x-y', title: 'T', log: 'docs/plans/logs/012-x-y.md' }), '---\nid: 12\nstatus: todo\nlog: docs/plans/logs/012-x-y.md\n---\n\n# 012: T\n\n## Tasks\n\n1. One\n');
  assert.throws(() => fillTemplate('# no header\n', { id: 1, name: 'x', title: 'T', log: 'l' }), /no header/);
});

test('a template shaped like the kit one fills into a plan the checker accepts as new', () => {
  const text = fillTemplate(TEMPLATE, { id: 91, name: 'save-word', title: 'Save a word', log: 'docs/plans/logs/091-save-word.md' });
  assert.deepEqual(validatePlan(text, '091-save-word.md', 'active').errors, []);
  assert.equal(tasksProblem(parseTasks(text)), null, 'a new plan made from the template passes the numbered tasks rule as it stands');
  const path = 'docs/plans/active/091-save-word.md';
  const fresh = { folder: 'active', file: '091-save-word.md', path, header: parsePlan(text).header, tasks: parseTasks(text) };
  assert.deepEqual(checkNewPlans({ plans: [fresh], changes: [{ status: 'A', path }], readBase: () => null }), [], 'and every rule for a new plan: log, tasks, invariants, risk, undo, owns, proof');
  assert.match(text, /^# 091: Save a word$/m);
});

// ---------- Relay Baton and Merge Odometer ----------

test('sliceHealth: counts code PRs and distinct tasks since last slice-handoff, ignores paperwork PRs and other slices', () => {
  assert.equal(DEFAULT_MAX_PRS_PER_THREAD, 2);
  assert.equal(DEFAULT_MAX_TASKS_PER_THREAD, 2);

  assert.deepEqual(sliceHealth(82, []), {
    slice: 82,
    codePrsSinceHandoff: 0,
    tasksDoneSinceHandoff: 0,
    maxPrs: 2,
    maxTasks: 2,
    totalCodePrs: 0,
    handoffs: 0,
    lastHandoffAt: null,
    mergedPrs: [],
    handoffRecommended: false,
    reasons: [],
  });

  const events = [
    { type: 'pr-merged', slice: 82, at: '2026-11-25T01:00:00Z', data: { pr: 10, branch: 'build/082-a', tier: 'code' } },
    { type: 'pr-merged', slice: 82, at: '2026-11-25T01:10:00Z', data: { pr: 11, branch: 'lead/082-docs', tier: 'paperwork' } },
    { type: 'pr-merged', slice: 84, at: '2026-11-25T01:15:00Z', data: { pr: 99, branch: 'build/084-other', tier: 'code' } },
    { type: 'task-done', slice: 82, at: '2026-11-25T01:20:00Z', data: { task: 1 } },
    { type: 'task-done', slice: 82, at: '2026-11-25T01:25:00Z', data: { task: 1 } }, // duplicate task number counts once
  ];
  const before = sliceHealth(82, events);
  assert.equal(before.codePrsSinceHandoff, 1);
  assert.equal(before.tasksDoneSinceHandoff, 1);
  assert.equal(before.totalCodePrs, 1);
  assert.equal(before.handoffs, 0);
  assert.equal(before.mergedPrs.length, 2);
  assert.equal(before.handoffRecommended, false);
  assert.deepEqual(before.reasons, []);

  // Second code PR and second distinct task trigger handoffRecommended with both reasons.
  events.push(
    { type: 'pr-merged', slice: 82, at: '2026-11-25T02:00:00Z', data: { pr: 12, branch: 'build/082-b', tier: 'code' } },
    { type: 'task-done', slice: 82, at: '2026-11-25T02:05:00Z', data: { task: 2 } },
  );
  const full = sliceHealth(82, events);
  assert.equal(full.codePrsSinceHandoff, 2);
  assert.equal(full.tasksDoneSinceHandoff, 2);
  assert.equal(full.totalCodePrs, 2);
  assert.equal(full.handoffRecommended, true);
  assert.deepEqual(full.reasons, [
    '2 code PRs merged since last handoff (limit 2)',
    '2 tasks finished since last handoff (limit 2)',
  ]);

  // A slice-handoff event resets the per-thread counters while keeping historical totals.
  events.push({ type: 'slice-handoff', slice: 82, at: '2026-11-25T03:00:00Z', data: { next: 'Task 3', threadPr: 20, note: null } });
  const reset = sliceHealth(82, events);
  assert.equal(reset.codePrsSinceHandoff, 0);
  assert.equal(reset.tasksDoneSinceHandoff, 0);
  assert.equal(reset.totalCodePrs, 2);
  assert.equal(reset.handoffs, 1);
  assert.equal(reset.lastHandoffAt, '2026-11-25T03:00:00Z');
  assert.equal(reset.handoffRecommended, false);
  assert.deepEqual(reset.reasons, []);

  // Custom maxPrs limit triggers on 1 code PR.
  events.push({ type: 'pr-merged', slice: 82, at: '2026-11-25T04:00:00Z', data: { pr: 13, branch: 'build/082-c', tier: 'code' } });
  const custom = sliceHealth(82, events, { maxPrs: 1 });
  assert.equal(custom.codePrsSinceHandoff, 1);
  assert.equal(custom.handoffRecommended, true);
  assert.deepEqual(custom.reasons, ['1 code PR merged since last handoff (limit 1)']);
});

test('formatRelayBaton stays compact (< 25 lines) even with many tasks and merged PRs', () => {
  const manyTasks = Array.from({ length: 12 }, (_, i) => ({
    n: i + 1,
    title: `Task number ${i + 1}`,
    state: i < 4 ? 'done' : i === 4 ? 'doing' : 'todo',
    at: null,
  }));
  const manyPrs = Array.from({ length: 7 }, (_, i) => ({
    pr: 10 + i,
    branch: `build/082-t${i + 1}`,
    tier: 'code',
    at: '2026-11-25T01:00:00Z',
  }));
  const card = formatRelayBaton({
    plan: { slice: 82, title: 'Search', status: 'in_progress', path: P82 },
    taskSummary: { tasks: manyTasks, done: 4, total: 12 },
    health: { slice: 82, codePrsSinceHandoff: 0, tasksDoneSinceHandoff: 0, maxPrs: 2, maxTasks: 2, handoffs: 2, handoffRecommended: false, reasons: [] },
    lastHandoff: { at: '2026-11-25T03:00:00Z', data: { next: 'Finish task 5', threadPr: 42, note: 'Watch fixture port.' } },
    mergedPrs: manyPrs,
  });
  const lines = card.split('\n');
  assert.ok(lines.length < 25, `expected < 25 lines, got ${lines.length}`);
  assert.match(card, /RELAY BATON: slice 082 - Search \(in_progress\)/);
  assert.match(card, /Tasks: 4\/12 done, 1 doing, 7 todo/);
  assert.match(card, /Merged PRs: \(\+2 earlier\)/);
  assert.match(card, /Thread PR: #42/);
  assert.match(card, /Handoffs: 2/);
  assert.match(card, /Next: Finish task 5/);
  assert.match(card, /Note: Watch fixture port\./);
});

test('CLI handoff --next, handoff --show (text & --json), and health before/after 2 code PRs and handoff reset', () => {
  const r = repo({ [P82]: plan(82) });
  try {
    // Log task 1 done and task 2 started.
    assert.equal(cli(r.dir, 'task', 'done', '1', '--slice', '82').code, 0);
    assert.equal(cli(r.dir, 'task', 'start', '2', '--slice', '82').code, 0);

    // 1 code PR + 1 paperwork PR: health is still OK.
    appendEvent(r.dir, { type: 'pr-merged', slice: 82, data: { pr: 101, branch: 'build/082-order', tier: 'code' } }, OPTS);
    appendEvent(r.dir, { type: 'pr-merged', slice: 82, data: { pr: 102, branch: 'lead/082-notes', tier: 'paperwork' } }, OPTS);
    const h1 = cli(r.dir, 'health', '--slice', '82', '--json');
    assert.equal(h1.code, 0, h1.err);
    const h1Data = JSON.parse(h1.out);
    assert.equal(h1Data.codePrsSinceHandoff, 1);
    assert.equal(h1Data.totalCodePrs, 1);
    assert.equal(h1Data.handoffRecommended, false);

    // 2nd code PR: health now recommends handoff.
    appendEvent(r.dir, { type: 'pr-merged', slice: 82, data: { pr: 103, branch: 'build/082-server', tier: 'code' } }, OPTS);
    const h2 = cli(r.dir, 'health', '--slice', '82');
    assert.equal(h2.code, 0, h2.err);
    assert.match(h2.out, /slice 082 health: HANDOFF RECOMMENDED/);
    assert.match(h2.out, /code PRs since handoff: 2 \/ 2 \(total: 2\)/);
    assert.match(h2.out, /2 code PRs merged since last handoff \(limit 2\)/);

    // Record handoff with --next, --thread-pr, and --note.
    const handoff = cli(r.dir, 'handoff', '--slice', '82', '--next', 'Build task 3 result page on build/082-result', '--thread-pr', '88', '--note', 'Keep search sort stable.');
    assert.equal(handoff.code, 0, handoff.err);
    assert.ok(handoff.out.trimEnd().split('\n').length < 25, 'Relay Baton card is under 25 lines');
    assert.match(handoff.out, /RELAY BATON: slice 082 - Search \(in_progress\)/);
    assert.match(handoff.out, /Merged PRs: #101 \(code, build\/082-order\), #102 \(paperwork, lead\/082-notes\), #103 \(code, build\/082-server\)/);
    assert.match(handoff.out, /Thread PR: #88/);
    assert.match(handoff.out, /Handoffs: 1 \| Odometer: 0\/2 code PRs, 0\/2 tasks \[OK\]/);
    assert.match(handoff.out, /Next: Build task 3 result page on build\/082-result/);
    assert.match(handoff.out, /Note: Keep search sort stable\./);

    // Event log has slice-handoff with exact payload.
    const handoffEvents = readEvents(r.dir, { types: ['slice-handoff'] }).events;
    assert.equal(handoffEvents.length, 1);
    assert.deepEqual(handoffEvents[0].data, { next: 'Build task 3 result page on build/082-result', threadPr: 88, note: 'Keep search sort stable.' });

    // Health is reset after slice-handoff.
    const h3 = JSON.parse(cli(r.dir, 'health', '--slice', '82', '--json').out);
    assert.equal(h3.codePrsSinceHandoff, 0);
    assert.equal(h3.tasksDoneSinceHandoff, 0);
    assert.equal(h3.totalCodePrs, 2);
    assert.equal(h3.handoffs, 1);
    assert.equal(h3.handoffRecommended, false);

    // handoff --show (text & --json) returns the same Relay Baton card and structured data.
    const showText = cli(r.dir, 'handoff', '--show', '--slice', '82');
    assert.equal(showText.code, 0, showText.err);
    assert.equal(showText.out, handoff.out);

    const showJson = cli(r.dir, 'handoff', '--show', '--slice', '82', '--json');
    assert.equal(showJson.code, 0, showJson.err);
    const parsed = JSON.parse(showJson.out);
    assert.equal(parsed.slice, 82);
    assert.equal(parsed.title, 'Search');
    assert.equal(parsed.threadPr, 88);
    assert.equal(parsed.health.handoffs, 1);
    assert.equal(parsed.mergedPrs.length, 3);
    assert.equal(parsed.lastHandoff.data.next, 'Build task 3 result page on build/082-result');
    assert.equal(parsed.baton, showText.out.trimEnd());

    // Custom --max-prs on CLI works after 1 more code PR.
    appendEvent(r.dir, { type: 'pr-merged', slice: 82, data: { pr: 104, branch: 'build/082-result', tier: 'code' } }, OPTS);
    const hCustom = JSON.parse(cli(r.dir, 'health', '--slice', '82', '--max-prs', '1', '--json').out);
    assert.equal(hCustom.handoffRecommended, true);
    assert.equal(hCustom.maxPrs, 1);

    // Custom --max-tasks on CLI works after 1 task done since handoff.
    assert.equal(cli(r.dir, 'task', 'done', '2', '--slice', '82').code, 0);
    const hMaxTasks = JSON.parse(cli(r.dir, 'health', '--slice', '82', '--max-prs', '5', '--max-tasks', '1', '--json').out);
    assert.equal(hMaxTasks.handoffRecommended, true);
    assert.equal(hMaxTasks.maxTasks, 1);
    assert.deepEqual(hMaxTasks.reasons, ['1 task finished since last handoff (limit 1)']);
  } finally {
    r.cleanup();
  }
});

test('sliceHealth: deduplicates pr-merged events by PR number while keeping unnamed entries', () => {
  // Duplicate pr-merged events for PR 21 must count as 1 merged PR, not 2.
  const dup = sliceHealth(82, [
    { type: 'pr-merged', slice: 82, at: '2026-11-25T01:00:00Z', data: { pr: 21, branch: 'build/082-a', tier: 'code' } },
    { type: 'pr-merged', slice: 82, at: '2026-11-25T01:05:00Z', data: { pr: 21, branch: 'build/082-a', tier: 'code' } },
    { type: 'pr-merged', slice: 82, at: '2026-11-25T01:10:00Z', data: { pr: '21', branch: 'build/082-a', tier: 'code' } },
  ]);
  assert.equal(dup.codePrsSinceHandoff, 1);
  assert.equal(dup.totalCodePrs, 1);
  assert.equal(dup.mergedPrs.length, 1);
  assert.equal(dup.mergedPrs[0].pr, 21);
  assert.equal(dup.handoffRecommended, false);

  // Duplicate pr-merged for a PR already merged before a handoff does not count after the handoff.
  const crossHandoff = sliceHealth(82, [
    { type: 'pr-merged', slice: 82, at: '2026-11-25T01:00:00Z', data: { pr: 21, branch: 'build/082-a', tier: 'code' } },
    { type: 'slice-handoff', slice: 82, at: '2026-11-25T02:00:00Z', data: { next: 'Task 2', threadPr: 21, note: null } },
    { type: 'pr-merged', slice: 82, at: '2026-11-25T02:05:00Z', data: { pr: 21, branch: 'build/082-a', tier: 'code' } },
  ]);
  assert.equal(crossHandoff.codePrsSinceHandoff, 0);
  assert.equal(crossHandoff.totalCodePrs, 1);
  assert.equal(crossHandoff.mergedPrs.length, 1);
  assert.equal(crossHandoff.handoffRecommended, false);

  // Unnamed pr-merged entries (pr == null or missing) are kept and counted individually.
  const unnamed = sliceHealth(82, [
    { type: 'pr-merged', slice: 82, at: '2026-11-25T01:00:00Z', data: { pr: null, branch: 'build/082-a', tier: 'code' } },
    { type: 'pr-merged', slice: 82, at: '2026-11-25T02:00:00Z', data: { branch: 'build/082-b', tier: 'code' } },
  ]);
  assert.equal(unnamed.codePrsSinceHandoff, 2);
  assert.equal(unnamed.totalCodePrs, 2);
  assert.equal(unnamed.mergedPrs.length, 2);
  assert.equal(unnamed.handoffRecommended, true);
});

test('CLI handoff and health reject invalid flags with exit code 2 and write nothing', () => {
  const r = repo({ [P82]: plan(82) });
  try {
    const cases = [
      [['handoff', '--slice', '82'], /^Wrong usage: handoff needs --next/],
      [['handoff', '--slice', '82', '--next', '   '], /^Refused: handoff needs a non-empty --next/],
      [['handoff', '--show', '--next', 'Task 2', '--slice', '82'], /^Wrong usage: handoff --show cannot be combined/],
      [['handoff', '--show', '--thread-pr', '10', '--slice', '82'], /^Wrong usage: handoff --show cannot be combined/],
      [['handoff', '--next', 'Task 2', '--thread-pr', '0', '--slice', '82'], /^Wrong usage: --thread-pr needs a positive whole number/],
      [['handoff', '--next', 'Task 2', '--thread-pr', 'abc', '--slice', '82'], /^Wrong usage: --thread-pr needs a positive whole number/],
      [['handoff', '--next', 'Task 2', '--note', 'n'.repeat(301), '--slice', '82'], /^Refused: The note is 301 characters; shorten it to 300 or fewer\./],
      [['handoff', '--next', 'Task 2', '--bogus', '1', '--slice', '82'], /^Wrong usage: unknown option --bogus/],
      [['health', '--slice', '82', '--max-prs', '0'], /^Wrong usage: --max-prs needs a positive whole number/],
      [['health', '--slice', '82', '--max-prs', 'two'], /^Wrong usage: --max-prs needs a positive whole number/],
      [['health', '--slice', '82', '--max-tasks', '0'], /^Wrong usage: --max-tasks needs a positive whole number/],
      [['health', '--slice', '82', '--max-tasks', 'two'], /^Wrong usage: --max-tasks needs a positive whole number/],
      [['health', '--slice', '82', '--bogus', '1'], /^Wrong usage: unknown option --bogus/],
    ];
    for (const [argv, msg] of cases) {
      const res = cli(r.dir, ...argv);
      assert.equal(res.code, 2, argv.join(' '));
      assert.match(res.err, msg, argv.join(' '));
    }
    const usageOut = cli(r.dir, 'health', '--slice', '82', '--bogus', '1').err;
    assert.match(usageOut, /health \[--slice N\] \[--max-prs N\] \[--max-tasks N\] \[--json\]/);
    assert.ok(!existsSync(eventsFile(r.dir)));
  } finally {
    r.cleanup();
  }
});

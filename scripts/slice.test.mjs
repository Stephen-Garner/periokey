// Tests for slice.mjs. Run: node --test scripts/slice.test.mjs
// Each test makes a throwaway git repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkNewPlans, parsePlan, parseTasks, tasksProblem, validatePlan } from './check-plans.mjs';
import { eventsFile, readEvents } from './events.mjs';
import { fillTemplate, listSlices, logTask, newPlan, readPlans, run, sliceStatus, sliceTasks, taskStates } from './slice.mjs';

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

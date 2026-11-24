// Tests for events.mjs. Run: node --test scripts/events.test.mjs
// Each test makes a throwaway git repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, eventsFile, parsePairs, readEvents, readEventsFile, run } from './events.mjs';

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-events-')));
  const main = join(dir, 'proj');
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  sh(main, 'config', 'user.email', 'test@example.com');
  sh(main, 'config', 'user.name', 'Test');
  sh(main, 'config', 'commit.gpgsign', 'false');
  sh(main, 'commit', '-q', '--allow-empty', '-m', 'start');
  const worktree = (name, branch) => {
    const path = join(dir, name);
    sh(main, 'worktree', 'add', '-q', '-b', branch, path);
    return path;
  };
  return { dir, main, worktree, status: () => sh(main, 'status', '--porcelain'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ENV = {};

test('append then read gives the same event back, with id, time, and a newline-ended line', () => {
  const r = repo();
  try {
    const e = appendEvent(r.main, { type: 'job-finished', data: { job: 'x', run: 'r1', status: 'ok' }, role: 'builder' }, { env: { T3CODE_THREAD_ID: 'thread-9' }, now: new Date(2026, 10, 18, 3, 10).getTime() });
    assert.match(e.id, /^[0-9a-f]{8}$/);
    assert.match(e.at, /^2026-11-18T03:10:00[+-]\d\d:\d\d$/);
    assert.equal(e.branch, 'main');
    assert.equal(e.slice, null);
    assert.equal(e.thread, 'thread-9');
    const file = eventsFile(r.main);
    assert.equal(file, join(r.main, '.git', 'kit-events.jsonl'));
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
    assert.deepEqual(readEvents(r.main), { events: [e], skipped: 0 });
    assert.equal(r.status(), '', 'the working tree is untouched');
  } finally {
    r.cleanup();
  }
});

test('a missing log reads as empty', () => {
  const r = repo();
  try {
    assert.deepEqual(readEvents(r.main), { events: [], skipped: 0 });
  } finally {
    r.cleanup();
  }
});

test('two worktrees and the main checkout write to one log; slice comes from the branch', () => {
  const r = repo();
  try {
    const a = r.worktree('wt-a', 'build/082-search');
    const b = r.worktree('wt-b', 'lead/x');
    assert.equal(eventsFile(a), eventsFile(r.main));
    assert.equal(eventsFile(b), eventsFile(r.main));
    appendEvent(a, { type: 'one' }, { env: ENV, now: 1000 });
    appendEvent(b, { type: 'two' }, { env: ENV, now: 2000 });
    appendEvent(r.main, { type: 'three' }, { env: ENV, now: 3000 });
    const { events } = readEvents(b);
    assert.deepEqual(events.map((e) => [e.type, e.branch, e.slice]), [['one', 'build/082-search', 82], ['two', 'lead/x', null], ['three', 'main', null]]);
  } finally {
    r.cleanup();
  }
});

test('a broken line is skipped and counted; types and since filter; order is oldest first', () => {
  const r = repo();
  try {
    appendEvent(r.main, { type: 'late' }, { env: ENV, now: new Date(2026, 10, 18, 9).getTime() });
    appendFileSync(eventsFile(r.main), '{not json\n[1,2]\n');
    appendEvent(r.main, { type: 'early' }, { env: ENV, now: new Date(2026, 10, 10, 9).getTime() });
    const all = readEvents(r.main);
    assert.equal(all.skipped, 2);
    assert.deepEqual(all.events.map((e) => e.type), ['early', 'late']);
    assert.deepEqual(readEvents(r.main, { types: ['early'] }).events.map((e) => e.type), ['early']);
    assert.deepEqual(readEvents(r.main, { since: '2026-11-18' }).events.map((e) => e.type), ['late']);
  } finally {
    r.cleanup();
  }
});

test('add puts slice, role, model, thread, branch at the top and everything else in data', () => {
  assert.deepEqual(parsePairs(['job=a', 'slice=84', 'role=head', 'summary=Two things.', 'report=null']), { data: { job: 'a', summary: 'Two things.', report: null }, slice: '84', role: 'head' });
  assert.throws(() => parsePairs(['nope']), /not key=value/);
  const r = repo();
  try {
    const wt = r.worktree('wt', 'build/090-x');
    let out = '';
    const code = run(['add', 'job-finished', 'job=factory-analyst', 'run=r1', 'status=ok', 'summary=All fine.', 'role=researcher', 'model=m1'], { cwd: wt, env: ENV, stdout: (s) => (out += s), stderr: () => {} });
    assert.equal(code, 0);
    assert.match(out, /^added job-finished [0-9a-f]{8}\n$/);
    const [e] = readEvents(r.main).events;
    assert.deepEqual([e.role, e.model, e.slice, e.branch], ['researcher', 'm1', 90, 'build/090-x']);
    assert.deepEqual(e.data, { job: 'factory-analyst', run: 'r1', status: 'ok', summary: 'All fine.' });
  } finally {
    r.cleanup();
  }
});

test('add refuses a bad job-finished and a long summary; list prints and filters', () => {
  const r = repo();
  try {
    let err = '';
    const io = { cwd: r.main, env: ENV, stdout: () => {}, stderr: (s) => (err += s) };
    assert.equal(run(['add', 'job-finished', 'job=a', 'run=r', 'status=maybe'], io), 2);
    assert.equal(run(['add', 'job-finished', 'job=a', 'run=r', 'status=ok', `summary=${'x'.repeat(301)}`], io), 2);
    assert.match(err, /301 characters; shorten it to 300/);
    assert.equal(run(['add'], io), 2);
    assert.ok(!existsSync(eventsFile(r.main)), 'nothing was written');
    assert.equal(run(['add', 'note', 'text=hi'], io), 0);
    let out = '';
    assert.equal(run(['list', '--type', 'note', '--json'], { ...io, stdout: (s) => (out += s) }), 0);
    assert.deepEqual(JSON.parse(out).map((e) => e.data.text), ['hi']);
  } finally {
    r.cleanup();
  }
});

test('outside a git repo, add fails with a plain error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-events-nogit-'));
  try {
    let err = '';
    assert.equal(run(['add', 'note'], { cwd: dir, env: ENV, stdout: () => {}, stderr: (s) => (err += s) }), 1);
    assert.match(err, /not inside a git repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a row whose time is not text that reads as a time is skipped alone; the good rows stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-events-at-'));
  try {
    const file = join(dir, 'kit-events.jsonl');
    const row = (at, type) => JSON.stringify({ id: 'abcd0001', at, type, data: {} });
    writeFileSync(file, [row('2026-11-18T10:00:00-07:00', 'good'), row([2026], 'list'), row({ toString: 0 }, 'object'), row(20261118, 'number'), row('bad-time', 'text'), row('2026-11-18T11:00:00-07:00', 'also-good')].join('\n') + '\n');
    const all = readEventsFile(file);
    assert.deepEqual(all.events.map((e) => e.type), ['good', 'also-good']);
    assert.equal(all.skipped, 4);
    assert.deepEqual(readEventsFile(file, { since: '2026-11-18' }).events.map((e) => e.type), ['good', 'also-good'], 'the since filter reads only good times');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Tests for slot.mjs. Run: node --test scripts/slot.test.mjs
// The rules are tested as pure functions with plain data. The command line is tested with real
// processes, against a throwaway records folder, without looking at the real machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT, DEFAULT_MINUTES, emptyState, acquire, renew, release, view, probeMessage, parseArgs, holderIsLive, withMutex, pidAlive,
} from './slot.mjs';

const SCRIPT = fileURLToPath(new URL('./slot.mjs', import.meta.url));
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-11T12:00:00Z');
const ask = (who, extra = {}) => ({ slot: 'device', who, minutes: 20, ...extra });

// ---------- The rules ----------

test('default lease lengths: device 20 minutes, tests 30, merge 10', () => {
  assert.deepEqual(DEFAULT_MINUTES, { device: 20, tests: 30, merge: 10 });
});

test('a free slot is granted, with a lease that ends after the asked minutes', () => {
  const r = acquire(emptyState(), ask('A'), T0);
  assert.equal(r.granted, true);
  assert.equal(r.code, EXIT.ok);
  assert.equal(r.state.holder.who, 'A');
  assert.equal(Date.parse(r.state.holder.until), T0 + 20 * MIN);
  assert.deepEqual(r.state.queue, []);
  assert.ok(r.events.some((e) => e.type === 'grant'));
});

test('a second thread is told busy, joins the line once, and learns its place and the wait', () => {
  const held = acquire(emptyState(), ask('A'), T0).state;
  const r = acquire(held, ask('B'), T0 + 5 * MIN);
  assert.equal(r.granted, false);
  assert.equal(r.code, EXIT.busy);
  assert.match(r.message, /held by A for about 15 more minutes/);
  assert.match(r.message, /number 1 in line/);
  const again = acquire(r.state, ask('B'), T0 + 6 * MIN);
  assert.equal(again.state.queue.length, 1, 'asking twice must not add a second place in line');
  assert.equal(again.state.holder.who, 'A');
});

test('the line is served in order: a later thread cannot jump ahead when the slot frees', () => {
  let s = acquire(emptyState(), ask('A'), T0).state;
  s = acquire(s, ask('B'), T0 + 1 * MIN).state;
  s = acquire(s, ask('C'), T0 + 2 * MIN).state;
  const freed = release(s, ask('A'), T0 + 3 * MIN);
  assert.match(freed.message, /Next in line: B/);
  const c = acquire(freed.state, ask('C'), T0 + 4 * MIN);
  assert.equal(c.granted, false);
  assert.match(c.message, /B asked before you/);
  assert.match(c.message, /number 2 in line/);
  const b = acquire(c.state, ask('B'), T0 + 5 * MIN);
  assert.equal(b.granted, true);
  assert.deepEqual(b.state.queue.map((q) => q.who), ['C']);
});

test('a lease that ran out can be taken over, and the grant says from whom', () => {
  const s = acquire(emptyState(), ask('A'), T0).state;
  const before = acquire(s, ask('B'), T0 + 19 * MIN);
  assert.equal(before.granted, false, 'one minute before the lease ends it is still held');
  const r = acquire(before.state, ask('B'), T0 + 25 * MIN);
  assert.equal(r.granted, true);
  assert.match(r.message, /took over from A, whose lease ran out 5 minutes ago/);
  assert.equal(r.state.holder.who, 'B');
  assert.ok(r.events.some((e) => e.type === 'expiry' && e.who === 'A'));
  assert.ok(r.events.some((e) => e.type === 'takeover' && /took over from A/.test(e.detail)));
});

test('an expiry is logged once, not on every later request', () => {
  let s = acquire(emptyState(), ask('A'), T0).state;
  s = acquire(s, ask('B'), T0 + 1 * MIN).state;
  s = acquire(s, ask('B'), T0 + 15 * MIN).state; // B keeps its place by asking again
  const first = acquire(s, ask('C'), T0 + 21 * MIN); // lease over; C is behind B, so still busy
  assert.equal(first.granted, false);
  assert.equal(first.events.filter((e) => e.type === 'expiry').length, 1);
  const second = acquire(first.state, ask('C'), T0 + 22 * MIN);
  assert.equal(second.events.filter((e) => e.type === 'expiry').length, 0);
});

test('a thread that stops asking is dropped from the line, so it never blocks it', () => {
  let s = acquire(emptyState(), ask('A'), T0).state;
  s = acquire(s, ask('B'), T0 + 1 * MIN).state; // B joins, then goes quiet
  s = release(s, ask('A'), T0 + 2 * MIN).state;
  const soon = acquire(s, ask('C'), T0 + 5 * MIN);
  assert.equal(soon.granted, false, 'within 10 minutes B still has its place');
  const later = acquire(soon.state, ask('C'), T0 + 12 * MIN);
  assert.equal(later.granted, true, 'after 10 quiet minutes B is dropped');
  assert.ok(later.events.some((e) => e.type === 'dropped' && e.who === 'B'));
  assert.deepEqual(later.state.queue, []);
});

test('asking again keeps your place and resets the 10 minute clock', () => {
  let s = acquire(emptyState(), ask('A', { minutes: 60 }), T0).state;
  s = acquire(s, ask('B'), T0 + 1 * MIN).state;
  s = acquire(s, ask('C'), T0 + 2 * MIN).state;
  s = acquire(s, ask('B'), T0 + 9 * MIN).state; // B asks again
  const r = acquire(s, ask('B'), T0 + 18 * MIN); // 17 minutes after joining, 9 after last asking
  assert.match(r.message, /number 1 in line/);
  assert.deepEqual(r.state.queue.map((q) => q.who), ['B'], 'C went quiet for 16 minutes and is dropped; B stays');
});

test('acquire by the current holder renews the lease', () => {
  const s = acquire(emptyState(), ask('A'), T0).state;
  const r = acquire(s, ask('A', { minutes: 30 }), T0 + 10 * MIN);
  assert.equal(r.granted, true);
  assert.equal(r.fresh, false);
  assert.equal(Date.parse(r.state.holder.until), T0 + 40 * MIN);
  assert.equal(r.state.holder.since, new Date(T0).toISOString(), 'a renewal keeps the original start time');
});

test('renew works only for the live holder', () => {
  const s = acquire(emptyState(), ask('A'), T0).state;
  const ok = renew(s, ask('A', { minutes: 45 }), T0 + 5 * MIN);
  assert.equal(ok.code, EXIT.ok);
  assert.equal(Date.parse(ok.state.holder.until), T0 + 50 * MIN);
  assert.equal(renew(s, ask('B'), T0 + 5 * MIN).code, EXIT.error);
  const late = renew(s, ask('A'), T0 + 30 * MIN);
  assert.equal(late.code, EXIT.error, 'a lease that already ran out cannot be renewed');
  assert.match(late.message, /acquire device/);
});

test('a holder whose command is gone (dead pid) frees the slot at once', () => {
  const alive = new Set([111]);
  const opts = { pidAlive: (pid) => alive.has(pid) };
  const s = acquire(emptyState(), ask('A', { pid: 111 }), T0, opts).state;
  assert.equal(acquire(s, ask('B'), T0 + 1 * MIN, opts).granted, false);
  alive.delete(111);
  assert.equal(holderIsLive(s.holder, T0 + 2 * MIN, opts.pidAlive), false);
  const r = acquire(s, ask('C'), T0 + 2 * MIN, opts);
  assert.equal(r.granted, true, 'the lease has 18 minutes left, but its process is gone');
  assert.match(r.message, /took over from A, whose command ended without releasing/);
});

test('the same name cannot run two commands in one slot at once', () => {
  const opts = { pidAlive: () => true };
  const s = acquire(emptyState(), ask('A', { pid: 111 }), T0, opts).state;
  const r = acquire(s, ask('A', { pid: 222 }), T0 + 1 * MIN, opts);
  assert.equal(r.granted, false);
  assert.equal(r.code, EXIT.busy);
  assert.equal(r.state.holder.pid, 111);
});

test('release by a thread that does not hold the slot fails, unless forced', () => {
  const s = acquire(emptyState(), ask('A'), T0).state;
  const no = release(s, ask('B'), T0 + 1 * MIN);
  assert.equal(no.code, EXIT.error);
  assert.equal(no.state.holder.who, 'A', 'the holder is untouched');
  const forced = release(s, ask('B', { force: true }), T0 + 1 * MIN);
  assert.equal(forced.code, EXIT.ok);
  assert.equal(forced.state.holder, null);
  assert.ok(forced.events.some((e) => e.type === 'release' && /forced by B/.test(e.detail)));
  assert.equal(release(emptyState(), ask('A'), T0).code, EXIT.ok, 'releasing a free slot is harmless');
});

test('before a grant the caller must look at the machine; what it sees can mean busy', () => {
  const need = acquire(emptyState(), ask('A'), T0, { needsProbe: true });
  assert.deepEqual(need, { needProbe: true });
  const clear = acquire(emptyState(), ask('A'), T0, { needsProbe: true, blocked: null });
  assert.equal(clear.granted, true);
  const blocked = acquire(emptyState(), ask('A'), T0, { needsProbe: true, blocked: 'a device is on, but nobody holds the device slot.' });
  assert.equal(blocked.granted, false);
  assert.equal(blocked.code, EXIT.busy);
  assert.equal(blocked.state.holder, null);
  assert.match(blocked.message, /a device is on, but nobody holds/);
  assert.deepEqual(blocked.state.queue.map((q) => q.who), ['A']);
  // No look is needed when the answer is busy anyway.
  const held = acquire(emptyState(), ask('A'), T0).state;
  assert.equal(acquire(held, ask('B'), T0, { needsProbe: true }).code, EXIT.busy);
});

test('a device that is on, or a test run with workers, counts as busy when nobody holds the slot', () => {
  assert.equal(probeMessage('device', { simulators: [], emulators: [] }), null);
  const device = probeMessage('device', { simulators: [{ name: 'iPhone 17', udid: 'ABC' }], emulators: [{ name: 'Pixel_9', pid: 7 }] });
  assert.match(device, /iPhone 17 \(ABC\)/);
  assert.match(device, /emulator Pixel_9 \(pid 7\)/);
  assert.match(device, /xcrun simctl shutdown <udid>/);
  assert.match(device, /adb -s <serial> emu kill/);
  assert.equal(probeMessage('tests', { testRuns: [] }), null);
  assert.match(probeMessage('tests', { testRuns: [{ parentPid: 9, workerPids: [1, 2] }] }), /untracked test run is going \(parent pid 9, 2 workers\)/);
  // The two take turns: a booted Simulator blocks the tests slot, and a test run blocks the device
  // slot, unless SLOT_SHARED_OK says the machine can carry both.
  const sim = { simulators: [{ name: 'iPhone 17', udid: 'ABC' }], emulators: [], testRuns: [] };
  assert.match(probeMessage('tests', sim), /a device is on: iPhone 17 \(ABC\)\. A device and a full test run at the same time overload this machine/);
  assert.equal(probeMessage('tests', sim, { sharedOk: true }), null);
  const run = { simulators: [], emulators: [], testRuns: [{ parentPid: 9, workerPids: [1, 2] }] };
  assert.match(probeMessage('device', run), /a test run is going \(parent pid 9, 2 workers\)/);
  assert.equal(probeMessage('device', run, { sharedOk: true }), null);
});

test('the two slots take turns: tests waits while device is held, and the other way round', () => {
  const T = (who) => ({ slot: 'tests', who, minutes: 30 });
  const device = acquire(emptyState(), ask('Builder'), T0).state;

  const blocked = acquire(emptyState(), T('Merger'), T0 + MIN, { other: device });
  assert.equal(blocked.granted, false);
  assert.equal(blocked.code, EXIT.busy);
  assert.match(blocked.message, /tests is free, but the device slot is held by Builder for about 19 more minutes/);
  assert.match(blocked.message, /You are number 1 in line/);
  assert.equal(view(blocked.state, T0 + MIN, { other: device }, 'tests').waitsFor, 'device');

  const freed = release(device, ask('Builder'), T0 + 2 * MIN).state;
  const granted = acquire(blocked.state, T('Merger'), T0 + 2 * MIN, { other: freed });
  assert.equal(granted.granted, true, 'once device is released, the first in line gets tests');
  assert.equal(view(granted.state, T0 + 2 * MIN, { other: freed }, 'tests').waitsFor, null);

  const back = acquire(freed, ask('Builder'), T0 + 3 * MIN, { other: granted.state });
  assert.equal(back.granted, false, 'device waits while tests is held');
  assert.match(back.message, /device is free, but the tests slot is held by Merger/);
});

test('the turn-taking rule: a lease that ran out on the other slot does not block; SLOT_SHARED_OK turns it off', () => {
  const T = (who) => ({ slot: 'tests', who, minutes: 30 });
  const device = acquire(emptyState(), ask('Builder'), T0).state;
  assert.equal(acquire(emptyState(), T('Merger'), T0 + 21 * MIN, { other: device }).granted, true, 'the device lease ended at 20 minutes');
  assert.equal(acquire(emptyState(), T('Merger'), T0 + MIN, { other: device, sharedOk: true }).granted, true);
  assert.equal(acquire(emptyState(), T('Merger'), T0 + MIN, { other: emptyState() }).granted, true);
  assert.equal(acquire(emptyState(), T('Merger'), T0 + MIN).granted, true, 'without the other slot\'s record, only this slot counts');
});

test('status view shows the live holder, an unreleased dead one, and the line', () => {
  let s = acquire(emptyState(), ask('A', { note: 'screens for 085' }), T0).state;
  s = acquire(s, ask('B'), T0 + 1 * MIN).state;
  const during = view(s, T0 + 5 * MIN);
  assert.equal(during.holder.who, 'A');
  assert.equal(during.holder.minutesLeft, 15);
  assert.equal(during.holder.note, 'screens for 085');
  assert.deepEqual(during.queue, ['B']);
  const after = view(s, T0 + 30 * MIN);
  assert.equal(after.holder, null);
  assert.equal(after.expired.who, 'A');
  assert.deepEqual(after.queue, [], 'B went quiet for more than 10 minutes');
});

test('the command line is read strictly; wrong usage throws', () => {
  const ok = parseArgs(['run', 'tests', '--who', 'UniLex 085', '--wait', '30', '--', 'pnpm', 'test', '--force']);
  assert.deepEqual({ command: ok.command, slot: ok.slot, who: ok.who, minutes: ok.minutes, wait: ok.wait, cmd: ok.cmd, force: ok.force },
    { command: 'run', slot: 'tests', who: 'UniLex 085', minutes: 30, wait: 30, cmd: ['pnpm', 'test', '--force'], force: false });
  assert.equal(parseArgs(['acquire', 'device', '--who', 'A']).minutes, 20);
  assert.equal(parseArgs(['status', '--json']).json, true);
  assert.equal(parseArgs(['acquire', 'merge', '--who', 'A', '--pid', '4242']).pid, 4242);
  assert.equal(parseArgs(['acquire', 'merge', '--who', 'A']).pid, null);
  for (const bad of [
    [], ['grab', 'device', '--who', 'A'], ['acquire', 'printer', '--who', 'A'], ['acquire', '--who', 'A'], ['acquire', 'device'],
    ['acquire', 'device', '--who', 'A', '--minutes', '0'], ['acquire', 'device', '--who', 'A', '--minutes', 'soon'],
    ['acquire', 'device', '--who', 'A', '--wait', '-1'], ['acquire', 'device', '--who', 'A', '--loud'], ['acquire', 'device', '--who'],
    ['run', 'tests', '--who', 'A'], ['acquire', 'device', '--who', 'A', '--', 'ls'], ['status', 'device'],
    ['acquire', 'merge', '--who', 'A', '--pid', '0'], ['acquire', 'merge', '--who', 'A', '--pid', '1.5'], ['acquire', 'merge', '--who', 'A', '--pid'],
    ['release', 'merge', '--who', 'A', '--pid', '42'], ['run', 'tests', '--who', 'A', '--pid', '42', '--', 'ls'],
  ]) assert.throws(() => parseArgs(bad), Error, `should refuse: ${bad.join(' ')}`);
});

// ---------- The short lock ----------

test('a short lock left by a dead process is cleared; a fresh one makes others wait, then give up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slot-mutex-'));
  try {
    const lock = join(dir, 'device.mutex');
    mkdirSync(lock);
    const old = new Date(Date.now() - 60 * 1000);
    utimesSync(lock, old, old);
    assert.equal(withMutex(dir, 'device', () => 'ran'), 'ran', 'a 60 second old lock is stale and removed');
    assert.equal(existsSync(lock), false, 'the lock is gone after the work');
    mkdirSync(lock); // a fresh lock, as if another process were mid-change
    assert.throws(() => withMutex(dir, 'device', () => 'ran', { waitMs: 150 }), /Could not get the short lock/);
    assert.equal(existsSync(lock), true, 'a fresh lock is never removed by a waiter');
    assert.throws(() => withMutex(dir, 'tests', () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(join(dir, 'tests.mutex')), false, 'the lock is released even when the work fails');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- The command line, with real processes ----------

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'slot-test-'));
  const env = { ...process.env, AGENT_SLOTS_DIR: dir, AGENT_SLOTS_NO_PROBE: '1', SLOT_POLL_MS: '100' };
  delete env.SLOT_QUEUE_TTL_MIN;
  delete env.SLOT_SHARED_OK;
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  const start = (...args) => spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = (slot) => JSON.parse(readFileSync(join(dir, `${slot}.json`), 'utf8'));
  return { dir, env, cli, start, state, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const exited = (child) => new Promise((done) => {
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (code, signal) => done({ code, signal, out }));
});

// Waits for proof, never for a fixed time: the deadline is only there so a broken test ends.
async function until(check, what, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (check()) return; } catch { /* not there yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// A command for `run` that proves it is running (it writes a "started" file), then stays up
// until the test says go (a "go" file appears), then exits with the given code. So no test
// depends on how fast the machine is. Starting it also proves `run` is past its own setup:
// `run` installs its signal handlers before it starts the command.
function held(box, name, exitCode = 0) {
  const started = join(box.dir, `${name}.started`);
  const go = join(box.dir, `${name}.go`);
  const code = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(started)}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) process.exit(${exitCode}); }, 20);`;
  return {
    command: [process.execPath, '-e', code],
    running: () => until(() => existsSync(started), `${name} command to start`),
    letGo: () => writeFileSync(go, ''),
  };
}

test('five acquire commands at the same moment: exactly one wins', async () => {
  const box = sandbox();
  try {
    const results = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((who) => exited(box.start('acquire', 'device', '--who', who))));
    const codes = results.map((r) => r.code).sort((a, b) => a - b);
    assert.deepEqual(codes, [EXIT.ok, EXIT.busy, EXIT.busy, EXIT.busy, EXIT.busy]);
    const s = box.state('device');
    assert.equal(s.queue.length, 4);
    assert.equal(new Set([s.holder.who, ...s.queue.map((q) => q.who)]).size, 5, 'one holder and four different threads in line');
    assert.equal(existsSync(join(box.dir, 'device.mutex')), false);
  } finally {
    box.done();
  }
});

test('acquire, status, release, and the log, end to end', () => {
  const box = sandbox();
  try {
    const a = box.cli('acquire', 'device', '--who', 'UniLex 085', '--minutes', '10', '--note', 'screens');
    assert.equal(a.status, EXIT.ok);
    assert.match(a.stdout, /Granted: device is yours/);
    assert.match(a.stdout, /release device --who "UniLex 085"/);
    const b = box.cli('acquire', 'device', '--who', 'Aimline 003');
    assert.equal(b.status, EXIT.busy);
    assert.match(b.stdout, /held by UniLex 085/);
    const t = box.cli('acquire', 'tests', '--who', 'Merger');
    assert.equal(t.status, EXIT.busy, 'tests waits while device is held');
    assert.match(t.stdout, /the device slot is held by UniLex 085/);
    assert.match(box.cli('acquire', 'tests', '--who', 'Merger').stdout, /You are number 1 in line/, 'asking again keeps the place');

    const status = JSON.parse(box.cli('status', '--json').stdout);
    assert.equal(status.slots.device.holder.who, 'UniLex 085');
    assert.equal(status.slots.device.holder.note, 'screens');
    assert.deepEqual(status.slots.device.queue, ['Aimline 003']);
    assert.equal(status.slots.tests.holder, null);
    assert.deepEqual(status.slots.tests.queue, ['Merger']);
    assert.equal(status.slots.tests.waitsFor, 'device');
    assert.equal(status.machine, null, 'with AGENT_SLOTS_NO_PROBE=1 the machine is not looked at');
    const text = box.cli('status').stdout;
    assert.match(text, /device: held by UniLex 085 until .*\n\s+in line: 1\. Aimline 003/);
    assert.match(text, /tests:\s+free\n\s+in line: 1\. Merger\n\s+waits for device/);

    const wrong = box.cli('release', 'device', '--who', 'Aimline 003');
    assert.equal(wrong.status, EXIT.error);
    assert.match(wrong.stderr, /held by UniLex 085/);
    assert.equal(box.state('device').holder.who, 'UniLex 085');
    const right = box.cli('release', 'device', '--who', 'UniLex 085');
    assert.equal(right.status, EXIT.ok);
    assert.match(right.stdout, /Next in line: Aimline 003/);
    assert.equal(box.cli('acquire', 'device', '--who', 'Aimline 003').status, EXIT.ok);
    assert.equal(box.cli('release', 'device', '--who', 'Aimline 003').status, EXIT.ok);
    assert.equal(box.cli('acquire', 'tests', '--who', 'Merger').status, EXIT.ok, 'with device free, the first in the tests line gets it');

    const log = readFileSync(join(box.dir, 'slots.log'), 'utf8');
    assert.match(log, /device grant who="UniLex 085"/);
    assert.match(log, /device queued who="Aimline 003"/);
    assert.match(log, /device release who="UniLex 085"/);
    assert.match(log, /device grant who="Aimline 003"/);
  } finally {
    box.done();
  }
});

test('the merge slot only keeps out other merges: it never waits for, or blocks, device or tests', () => {
  const box = sandbox();
  try {
    assert.equal(box.cli('acquire', 'device', '--who', 'Builder').status, EXIT.ok);
    const m1 = box.cli('acquire', 'merge', '--who', 'Merge 7');
    assert.equal(m1.status, EXIT.ok, m1.stdout + m1.stderr);
    assert.match(m1.stdout, /Granted: merge is yours/);
    assert.equal(box.cli('release', 'device', '--who', 'Builder').status, EXIT.ok);
    assert.equal(box.cli('acquire', 'tests', '--who', 'Tester').status, EXIT.ok, 'a held merge slot does not block tests');
    const m2 = box.cli('acquire', 'merge', '--who', 'Merge 8');
    assert.equal(m2.status, EXIT.busy, 'a second merge waits');
    assert.match(m2.stdout, /merge is held by Merge 7/);
    assert.equal(box.cli('release', 'merge', '--who', 'Merge 7').status, EXIT.ok);
    assert.equal(box.cli('acquire', 'merge', '--who', 'Merge 8').status, EXIT.ok, 'a held tests slot does not block merge');
    assert.equal(box.cli('acquire', 'device', '--who', 'Builder').status, EXIT.busy, 'device and tests still take turns');
    assert.deepEqual(Object.keys(box.state('tests')).sort(), ['holder', 'queue'], 'the old record shape, so older copies still read it');
    const status = JSON.parse(box.cli('status', '--json').stdout);
    assert.equal(status.slots.merge.holder.who, 'Merge 8');
    assert.match(box.cli('status').stdout, /merge:\s+held by Merge 8/);
  } finally {
    box.done();
  }
});

test('with SLOT_SHARED_OK=1 the device and a test run may be held at the same time', () => {
  const box = sandbox();
  try {
    assert.equal(box.cli('acquire', 'device', '--who', 'Builder').status, EXIT.ok);
    const shared = spawnSync(process.execPath, [SCRIPT, 'acquire', 'tests', '--who', 'Merger'], { env: { ...box.env, SLOT_SHARED_OK: '1' }, encoding: 'utf8' });
    assert.equal(shared.status, EXIT.ok, shared.stdout + shared.stderr);
    assert.equal(box.state('tests').holder.who, 'Merger');
  } finally {
    box.done();
  }
});

test('wrong usage exits with code 2 and changes nothing', () => {
  const box = sandbox();
  try {
    for (const args of [['acquire', 'printer', '--who', 'A'], ['acquire', 'device'], ['dance'], ['run', 'tests', '--who', 'A']]) {
      const r = box.cli(...args);
      assert.equal(r.status, EXIT.usage, args.join(' '));
      assert.match(r.stderr, /Usage:/);
    }
    assert.equal(existsSync(join(box.dir, 'device.json')), false);
  } finally {
    box.done();
  }
});

test('a lease that ran out on disk is taken over by the next command', () => {
  const box = sandbox();
  try {
    const past = (min) => new Date(Date.now() - min * MIN).toISOString();
    writeFileSync(join(box.dir, 'device.json'), JSON.stringify({ holder: { who: 'Old thread', since: past(30), until: past(7.5) }, queue: [] }));
    const r = box.cli('acquire', 'device', '--who', 'New thread');
    assert.equal(r.status, EXIT.ok);
    assert.match(r.stdout, /took over from Old thread, whose lease ran out 7 minutes ago/);
    assert.match(readFileSync(join(box.dir, 'slots.log'), 'utf8'), /device expiry who="Old thread" lease ran out\n.*device takeover who="New thread"/);
  } finally {
    box.done();
  }
});

test('a holder recorded with a pid that no longer exists is free at once', () => {
  const box = sandbox();
  try {
    const gone = spawnSync(process.execPath, ['-e', '']).pid; // a process that has already ended
    assert.equal(pidAlive(gone), false);
    const soon = new Date(Date.now() + 25 * MIN).toISOString();
    writeFileSync(join(box.dir, 'tests.json'), JSON.stringify({ holder: { who: 'Crashed run', since: new Date().toISOString(), until: soon, pid: gone }, queue: [] }));
    const r = box.cli('acquire', 'tests', '--who', 'Next run');
    assert.equal(r.status, EXIT.ok);
    assert.match(r.stdout, /took over from Crashed run, whose command ended without releasing/);
  } finally {
    box.done();
  }
});

test('acquire --pid puts the pid on record, so when that process is gone the slot is free at once', () => {
  const box = sandbox();
  try {
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const r = box.cli('acquire', 'merge', '--who', 'Merge 7', '--pid', String(gone));
    assert.equal(r.status, EXIT.ok, r.stdout + r.stderr);
    assert.equal(box.state('merge').holder.pid, gone);
    const next = box.cli('acquire', 'merge', '--who', 'Merge 8');
    assert.equal(next.status, EXIT.ok, 'the dead merge does not block');
    assert.match(next.stdout, /took over from Merge 7, whose command ended without releasing/);
  } finally {
    box.done();
  }
});

test('run holds the slot while the command runs, then frees it and returns the command\'s exit code', async () => {
  const box = sandbox();
  try {
    const job = held(box, 'job', 3);
    const run = box.start('run', 'tests', '--who', 'A', '--', ...job.command);
    const finished = exited(run);
    await job.running();
    assert.equal(box.state('tests').holder.pid, run.pid, 'the record names the run that holds the slot');
    assert.equal(box.cli('acquire', 'tests', '--who', 'B').status, EXIT.busy, 'another thread is busy while the command runs');
    job.letGo();
    const r = await finished;
    assert.equal(r.code, 3, 'a failing command still returns its own exit code');
    assert.equal(box.state('tests').holder, null, 'a failing command still frees the slot');
    assert.equal(box.cli('acquire', 'tests', '--who', 'B').status, EXIT.ok);
    assert.match(readFileSync(join(box.dir, 'slots.log'), 'utf8'), /tests release who="A"/);
  } finally {
    box.done();
  }
});

test('run frees the slot when the command is killed, and when run itself is told to stop', async () => {
  const box = sandbox();
  try {
    const killed = box.cli('run', 'tests', '--who', 'A', '--', process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")');
    assert.equal(killed.status, 128 + 9, 'killed by signal 9 becomes exit code 137');
    assert.equal(box.state('tests').holder, null);

    const job = held(box, 'job');
    const run = box.start('run', 'tests', '--who', 'A', '--', ...job.command);
    const finished = exited(run);
    await job.running(); // the command is up, so run is ready to pass a signal on
    assert.equal(box.state('tests').holder.pid, run.pid);
    run.kill('SIGTERM');
    const r = await finished;
    assert.equal(r.code, 128 + 15, 'the stop signal is passed to the command, and its end is reported');
    assert.equal(box.state('tests').holder, null, 'the slot is free after run was stopped');

    const missing = box.cli('run', 'tests', '--who', 'A', '--', 'no-such-command-anywhere');
    assert.equal(missing.status, 127);
    assert.equal(box.state('tests').holder, null, 'a command that cannot start still frees the slot');
  } finally {
    box.done();
  }
});

test('--wait keeps asking in the foreground until the slot frees', async () => {
  const box = sandbox();
  try {
    const job = held(box, 'job');
    const run = box.start('run', 'tests', '--who', 'A', '--', ...job.command);
    const finished = exited(run);
    await job.running();
    assert.equal(box.cli('acquire', 'tests', '--who', 'B').status, EXIT.busy, 'without --wait the answer is busy at once');

    const waiter = box.start('acquire', 'tests', '--who', 'B', '--wait', '120');
    let seen = '';
    waiter.stdout.on('data', (d) => { seen += d; });
    const waited = exited(waiter);
    await until(() => /Waiting up to 120 seconds/.test(seen), 'the waiter to say it is waiting');
    job.letGo(); // only now does the slot free
    await finished;
    const w = await waited;
    assert.equal(w.code, EXIT.ok, 'the waiter is granted the slot once it frees');
    assert.match(w.out, /Granted: tests is yours/);
    assert.equal(box.state('tests').holder.who, 'B');

    const giveUp = box.cli('acquire', 'tests', '--who', 'C', '--wait', '0.3');
    assert.equal(giveUp.status, EXIT.busy, 'when the wait is over it gives up with the busy code');
  } finally {
    box.done();
  }
});

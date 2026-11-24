#!/usr/bin/env node
// slot.mjs: a machine-wide lock for the things only one agent thread may use at a time.
//
//   device   the one iPhone Simulator or Android emulator allowed to run on this machine
//   tests    the one full test run allowed at a time
//   merge    the one pull request merge allowed at a time (scripts/merge-pr.mjs takes it)
//
// A "slot" is permission to use one of them. This script hands the slot to one thread, keeps a
// waiting line for the rest, and writes down who holds it. It takes the place of asking the RAM
// Administrator thread by message: the answer is instant, costs no AI usage, and two threads can
// never both win. It only records and reports. It never kills a process or shuts a device down.
//
// How to run (Node 18 or newer). <slot> is `device`, `tests`, or `merge`; <name> is your thread, for
// example "UniLex 085 head agent":
//   node scripts/slot.mjs acquire <slot> --who <name> [--minutes N] [--note text] [--wait seconds] [--pid N]
//   node scripts/slot.mjs renew <slot> --who <name> [--minutes N]
//   node scripts/slot.mjs release <slot> --who <name> [--force]
//   node scripts/slot.mjs status [--json]
//   node scripts/slot.mjs run <slot> --who <name> [--minutes N] [--wait seconds] -- <command...>
//
// Exit codes: 0 done or granted. 75 busy: you are in line; do other work and ask again.
// 1 an error, such as releasing a slot someone else holds. 2 wrong usage.
// `run` exits with the command's own exit code.
//
// The rules:
//   - A slot is a lease: it is yours until a stated time (default: device 20 minutes, tests 30,
//     merge 10).
//     When that time passes, the slot is free again, so a dead thread can never hold it forever.
//     Need longer? Ask with `renew`, or `acquire` again while you hold it.
//   - First come, first served. If the slot is taken, you join the line and are told your place.
//     Ask again within 10 minutes to keep your place; a thread that stops asking is dropped.
//   - `acquire --pid N` puts process N on record as the holder's process (merge-pr.mjs passes its
//     own), so the slot is free at once when that process is gone, as with `run`.
//   - `run` takes the slot, runs your command in the foreground, keeps the lease alive while it
//     runs, and gives the slot back when it ends, even if it fails or is stopped. Use it for
//     full test runs: `node scripts/slot.mjs run tests --who <name> -- pnpm test`.
//   - The two slots take turns: a device and a full test run at the same time overload a 16 GB
//     machine (a full run with a Simulator booted took 763 s instead of 285 s, and 9 tests timed
//     out). So `tests` waits while someone holds `device`, and the other way round. Each slot keeps
//     its own line; when the other slot frees, the first in each line gets it on their next ask.
//     `merge` uses almost no memory, so it takes no turns: it only keeps out another merge, and
//     the machine is not looked at for it.
//   - Before a grant it looks at the machine. A device that is on while nobody holds the device
//     slot, or a test run with workers while nobody holds the tests slot, means "busy". So does a
//     device that is on when you ask for `tests`, or a test run going when you ask for `device`.
//   - On every grant it prints the memory flags from ram-health.mjs and logs them. Flags never
//     block a grant; report them (docs/agents/ram-rules.md).
//
// Where the records live: the folder ~/.agent-slots/ (or $AGENT_SLOTS_DIR). One small JSON file
// per slot, slots.log (every grant, release, takeover, and expiry), and health.log.
//
// Settings, by environment variable:
//   AGENT_SLOTS_DIR=~/.agent-slots   where the records live
//   SLOT_QUEUE_TTL_MIN=10            minutes a thread keeps its place in line without asking again
//   AGENT_SLOTS_NO_PROBE=1           do not look at the machine (the tests set this)
//   SLOT_POLL_MS=5000                how often --wait asks again
//   SLOT_SHARED_OK=1                 let the two slots be held at the same time (a bigger machine)
//   RAM_TEST_WORKER_PATTERN          what a test worker looks like (see ram-health.mjs)

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, findEmulators, findTestRuns, gatherFacts, parsePs, parseSimctlBooted, readLimits } from './ram-health.mjs';

export const SLOTS = ['device', 'tests', 'merge'];
// The two slots that take turns. Every other slot stands alone.
const PAIRED = ['device', 'tests'];
export const COMMANDS = ['acquire', 'renew', 'release', 'status', 'run'];
export const DEFAULT_MINUTES = { device: 20, tests: 30, merge: 10 };
export const DEFAULT_QUEUE_TTL_MIN = 10;
export const EXIT = { ok: 0, error: 1, usage: 2, busy: 75 };

const MIN = 60 * 1000;
const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const minutesLeft = (holder, now) => Math.max(1, Math.ceil((at(holder.until) - now) / MIN));
// The slot this one takes turns with, or null for a slot that stands alone.
export const otherSlot = (slot) => (slot === 'device' ? 'tests' : slot === 'tests' ? 'device' : null);

// ---------- The rules, as pure functions (no files, no clock, no processes) ----------

export function emptyState() {
  return { holder: null, queue: [] };
}

// Why a recorded holder no longer counts: 'lease' (its time ran out), 'pid' (the command that
// held it is gone), or null (it still holds the slot).
export function deadReason(holder, now, pidAlive = () => true) {
  if (!holder) return null;
  if (at(holder.until) <= now) return 'lease';
  if (holder.pid !== undefined && !pidAlive(holder.pid)) return 'pid';
  return null;
}

export function holderIsLive(holder, now, pidAlive = () => true) {
  return Boolean(holder) && deadReason(holder, now, pidAlive) === null;
}

// Housekeeping every change starts with. A holder that no longer counts is marked once (and stays
// on record, so the next grant can say whom it took over from). Threads that stopped asking leave
// the line. Returns a new state and the events to log.
function tidy(state, now, { pidAlive, queueTtlMs }) {
  const events = [];
  const holder = state.holder ? { ...state.holder } : null;
  const reason = deadReason(holder, now, pidAlive);
  if (reason && !holder.expired) {
    holder.expired = iso(now);
    events.push({ type: 'expiry', who: holder.who, detail: reason === 'lease' ? 'lease ran out' : `pid ${holder.pid} is gone` });
  }
  const queue = [];
  for (const entry of state.queue) {
    if (now - at(entry.seen) > queueTtlMs) events.push({ type: 'dropped', who: entry.who, detail: 'stopped asking' });
    else queue.push({ ...entry });
  }
  return { state: { holder, queue }, events };
}

function options(opts) {
  return { pidAlive: () => true, queueTtlMs: DEFAULT_QUEUE_TTL_MIN * MIN, needsProbe: false, blocked: undefined, other: null, sharedOk: false, ...opts };
}

// The live holder of the other slot when the two must take turns, or null. other: the other
// slot's state as read from its file (it is only read, never changed, here).
function otherInUse(slot, o, now) {
  if (o.sharedOk || !o.other || !holderIsLive(o.other.holder, now, o.pidAlive)) return null;
  return { slot: otherSlot(slot), holder: o.other.holder };
}

// A request for the slot. req: { slot, who, minutes, note?, pid? } (pid is set by `run` and by `acquire --pid`).
// opts.needsProbe: the caller can look at the machine. opts.blocked: what that look found:
// undefined = not looked yet, null = all clear, text = why the slot counts as busy.
// opts.other: the other slot's state; while it has a live holder this slot is not granted, unless
// opts.sharedOk.
// Returns { state, granted, code, message, events }, or { needProbe: true } when the request
// would be granted and the caller must look at the machine first, then ask again with `blocked`.
export function acquire(state, req, now, opts = {}) {
  const o = options(opts);
  const { state: s, events } = tidy(state, now, o);
  const live = holderIsLive(s.holder, now, o.pidAlive);
  const until = now + req.minutes * MIN;

  if (live && s.holder.who === req.who) {
    if (req.pid !== undefined && s.holder.pid !== undefined && s.holder.pid !== req.pid) {
      return { state: s, granted: false, code: EXIT.busy, events, message: `Busy: "${req.who}" already runs a command in the ${req.slot} slot (pid ${s.holder.pid}). Wait for it to end.` };
    }
    s.holder.until = iso(until);
    if (req.pid !== undefined) s.holder.pid = req.pid;
    if (req.note) s.holder.note = req.note;
    events.push({ type: 'renew', who: req.who, detail: `until ${s.holder.until}` });
    return { state: s, granted: true, fresh: false, code: EXIT.ok, events, message: `Renewed: ${req.slot} is yours until ${clock(until)} (${plural(req.minutes, 'minute')}).` };
  }

  const place = s.queue.findIndex((q) => q.who === req.who);
  const first = s.queue.length === 0 || place === 0;
  const cross = otherInUse(req.slot, o, now);
  if (!live && first && !cross) {
    if (o.needsProbe && o.blocked === undefined) return { needProbe: true };
    if (!o.blocked) {
      const lines = [`Granted: ${req.slot} is yours until ${clock(until)} (${plural(req.minutes, 'minute')}).`];
      const previous = s.holder;
      if (previous) {
        const ago = Math.max(0, Math.floor((now - at(previous.until)) / MIN));
        const how = at(previous.until) <= now ? `whose lease ran out ${plural(ago, 'minute')} ago` : 'whose command ended without releasing';
        lines.push(previous.who === req.who ? 'Your earlier lease had ended; this is a new one.' : `You took over from ${previous.who}, ${how}.`);
        events.push({ type: 'takeover', who: req.who, detail: `took over from ${previous.who}, ${how}` });
      }
      s.holder = { who: req.who, since: iso(now), until: iso(until), ...(req.pid !== undefined ? { pid: req.pid } : {}), ...(req.note ? { note: req.note } : {}) };
      s.queue = s.queue.filter((q) => q.who !== req.who);
      events.push({ type: 'grant', who: req.who, detail: `until ${s.holder.until}${req.note ? `, note: ${req.note}` : ''}` });
      if (req.pid === undefined) lines.push(`When you are done: node scripts/slot.mjs release ${req.slot} --who "${req.who}"`);
      return { state: s, granted: true, fresh: true, code: EXIT.ok, events, message: lines.join('\n') };
    }
  }

  // Busy: join the line once, or keep your place by asking again.
  if (place === -1) {
    s.queue.push({ who: req.who, since: iso(now), seen: iso(now) });
    events.push({ type: 'queued', who: req.who, detail: `place ${s.queue.length}` });
  } else {
    s.queue[place].seen = iso(now);
  }
  const number = s.queue.findIndex((q) => q.who === req.who) + 1;
  let why;
  if (live) why = `${req.slot} is held by ${s.holder.who} for about ${plural(minutesLeft(s.holder, now), 'more minute')}.`;
  else if (!first) why = `${req.slot} is free, but ${s.queue[0].who} asked before you.`;
  else if (cross) why = `${req.slot} is free, but the ${cross.slot} slot is held by ${cross.holder.who} for about ${plural(minutesLeft(cross.holder, now), 'more minute')}. A device and a full test run at the same time overload this machine, so they take turns.`;
  else why = o.blocked;
  return {
    state: s, granted: false, code: EXIT.busy, events,
    message: `Busy: ${why}\nYou are number ${number} in line. Do other work, and ask again within ${Math.round(o.queueTtlMs / MIN)} minutes to keep your place.`,
  };
}

// More time for the thread that holds the slot. A lease that already ran out cannot be renewed:
// the slot is free, so ask with `acquire` like everyone else.
export function renew(state, req, now, opts = {}) {
  const o = options(opts);
  const { state: s, events } = tidy(state, now, o);
  if (!holderIsLive(s.holder, now, o.pidAlive) || s.holder.who !== req.who) {
    const holds = holderIsLive(s.holder, now, o.pidAlive) ? `${s.holder.who} holds it` : 'nobody holds it now';
    return { state: s, code: EXIT.error, events, message: `Cannot renew: "${req.who}" does not hold ${req.slot} (${holds}). Ask with: node scripts/slot.mjs acquire ${req.slot} --who "${req.who}"` };
  }
  const until = now + req.minutes * MIN;
  s.holder.until = iso(until);
  events.push({ type: 'renew', who: req.who, detail: `until ${s.holder.until}` });
  return { state: s, code: EXIT.ok, events, message: `Renewed: ${req.slot} is yours until ${clock(until)} (${plural(req.minutes, 'minute')}).` };
}

// Gives the slot back. Only the holder may, unless req.force is set.
export function release(state, req, now, opts = {}) {
  const o = options(opts);
  const { state: s, events } = tidy(state, now, o);
  const next = () => (s.queue.length ? ` Next in line: ${s.queue[0].who}.` : '');
  if (!s.holder) return { state: s, code: EXIT.ok, events, message: `${req.slot} was already free.${next()}` };
  if (s.holder.who !== req.who && !req.force) {
    return { state: s, code: EXIT.error, events, message: `Cannot release: ${req.slot} is held by ${s.holder.who}, not "${req.who}". Only the holder releases it (or add --force if you are sure its thread is gone).` };
  }
  events.push({ type: 'release', who: s.holder.who, detail: s.holder.who === req.who ? '' : `forced by ${req.who}` });
  s.holder = null;
  return { state: s, code: EXIT.ok, events, message: `Released: ${req.slot} is free.${next()}` };
}

// What `status` shows for one slot. Changes nothing. waitsFor names the other slot when this
// slot is free and has a line, but its first in line cannot have it only because of the other.
export function view(state, now, opts = {}, slot = 'device') {
  const o = options(opts);
  const live = holderIsLive(state.holder, now, o.pidAlive);
  const queue = state.queue.filter((q) => now - at(q.seen) <= o.queueTtlMs).map((q) => q.who);
  const cross = !live && queue.length ? otherInUse(slot, o, now) : null;
  return {
    holder: live ? { ...state.holder, minutesLeft: minutesLeft(state.holder, now) } : null,
    expired: !live && state.holder ? { who: state.holder.who, until: state.holder.until } : null,
    queue,
    waitsFor: cross ? cross.slot : null,
  };
}

// What a look at the machine means for a slot. Null means all clear.
// seen: { simulators: [{ name, udid }], emulators: [{ name, pid }], testRuns: [{ parentPid, workerPids }] }
// Unless sharedOk, a device that is on also blocks `tests`, and a test run going also blocks `device`.
export function probeMessage(slot, seen, { sharedOk = false } = {}) {
  const on = [...(seen.simulators ?? []).map((d) => `${d.name} (${d.udid})`), ...(seen.emulators ?? []).map((e) => `emulator ${e.name} (pid ${e.pid})`)];
  const runs = seen.testRuns ?? [];
  const runText = runs.map((r) => `parent pid ${r.parentPid}, ${plural(r.workerPids.length, 'worker')}`).join('; ');
  if (slot === 'device') {
    if (on.length) return `a device is on, but nobody holds the device slot: ${on.join(', ')}. If it is a leftover, shut it down (\`xcrun simctl shutdown <udid>\` or \`adb -s <serial> emu kill\`) and ask again.`;
    if (runs.length && !sharedOk) return `a test run is going (${runText}). A device and a full test run at the same time overload this machine: wait for it to end and ask again.`;
    return null;
  }
  if (runs.length) return `an untracked test run is going (${runText}), but nobody holds the tests slot. Wait for it to end and ask again.`;
  if (on.length && !sharedOk) return `a device is on: ${on.join(', ')}. A device and a full test run at the same time overload this machine: wait until it is shut down and ask again.`;
  return null;
}

// Reads the command line. Throws an Error with a plain message on wrong usage.
export function parseArgs(argv) {
  const dash = argv.indexOf('--');
  const head = dash === -1 ? argv : argv.slice(0, dash);
  const cmd = dash === -1 ? [] : argv.slice(dash + 1);
  const [command, ...rest] = head;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command "${command ?? ''}". Use one of: ${COMMANDS.join(', ')}.`);
  const out = { command, slot: null, who: null, minutes: null, note: null, wait: 0, pid: null, force: false, json: false, cmd };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new Error(`${arg} needs a value.`);
      return rest[++i];
    };
    if (arg === '--who') out.who = value().replace(/\s+/g, ' ').trim();
    else if (arg === '--minutes') out.minutes = Number(value());
    else if (arg === '--note') out.note = value().replace(/\s+/g, ' ').trim();
    else if (arg === '--wait') out.wait = Number(value());
    else if (arg === '--pid') out.pid = Number(value());
    else if (arg === '--force') out.force = true;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option "${arg}".`);
    else positional.push(arg);
  }
  if (command !== 'run' && dash !== -1) throw new Error('Only `run` takes a command after "--".');
  if (command === 'status') {
    if (positional.length) throw new Error('`status` takes no slot name; it shows them all.');
    return out;
  }
  if (positional.length !== 1 || !SLOTS.includes(positional[0])) throw new Error(`Name one slot: ${SLOTS.join(', ')}.`);
  out.slot = positional[0];
  if (!out.who) throw new Error('Say who you are: --who "<your thread name>".');
  if (out.minutes === null) out.minutes = DEFAULT_MINUTES[out.slot];
  if (!Number.isFinite(out.minutes) || out.minutes <= 0) throw new Error('--minutes must be a number above 0.');
  if (!Number.isFinite(out.wait) || out.wait < 0) throw new Error('--wait must be a number of seconds, 0 or more.');
  if (out.pid !== null && (command !== 'acquire' || !Number.isInteger(out.pid) || out.pid <= 0)) throw new Error('--pid goes with `acquire` only, and must be a whole number above 0.');
  if (command === 'run' && cmd.length === 0) throw new Error('`run` needs a command after "--", for example: run tests --who me -- pnpm test');
  return out;
}

// ---------- Files: the records, the short lock around each change, the logs ----------

export const stateDir = (env = process.env) => env.AGENT_SLOTS_DIR || join(homedir(), '.agent-slots');

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export function readState(dir, slot) {
  const path = join(dir, `${slot}.json`);
  if (!existsSync(path)) return emptyState();
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e.message}). Look at it, then delete it to reset the ${slot} slot.`);
  }
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.queue)) throw new Error(`${path} does not look like a slot record. Look at it, then delete it to reset the ${slot} slot.`);
  return { holder: raw.holder ?? null, queue: raw.queue };
}

// Written to a side file and renamed, so a reader never sees half a record.
export function writeState(dir, slot, state) {
  const path = join(dir, `${slot}.json`);
  const side = `${path}.${process.pid}.tmp`;
  writeFileSync(side, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(side, path);
}

// Runs fn while holding a short lock, so two changes to one slot never overlap. The lock is a
// folder: making a folder either works or fails as one step, so only one process can make it.
// A lock folder older than staleMs was left by a process that died, and is removed.
export function withMutex(dir, slot, fn, { waitMs = 5000, staleMs = 30000 } = {}) {
  const lock = join(dir, `${slot}.mutex`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // it was just removed; try again
      }
      if (age > staleMs) {
        try { rmdirSync(lock); } catch { /* another process removed it first */ }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Could not get the short lock for ${slot} within ${waitMs / 1000} seconds (${lock}). Try again.`);
      sleepSync(20 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch { /* already gone */ }
  }
}

function logEvents(dir, slot, events, now) {
  if (!events.length) return;
  appendFileSync(join(dir, 'slots.log'), events.map((e) => `${iso(now)} ${slot} ${e.type} who="${e.who}"${e.detail ? ` ${e.detail}` : ''}\n`).join(''));
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // it exists, but belongs to another user
  }
}

function queueTtlMs(env) {
  if (env.SLOT_QUEUE_TTL_MIN === undefined || env.SLOT_QUEUE_TTL_MIN === '') return DEFAULT_QUEUE_TTL_MIN * MIN;
  const n = Number(env.SLOT_QUEUE_TTL_MIN);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`SLOT_QUEUE_TTL_MIN must be a number above 0 (got "${env.SLOT_QUEUE_TTL_MIN}")`);
  return n * MIN;
}

const sharedOk = (env) => env.SLOT_SHARED_OK === '1';

// One change to one slot: read, apply a pure rule, write, log. All inside the short lock.
// withOther: also read the other slot, holding both short locks (always in the same order, so two
// changes can never wait on each other), so a device and a test run can never both be granted.
function change(dir, slot, rule, env, { withOther = false } = {}) {
  const now = Date.now();
  const apply = () => {
    const other = withOther ? readState(dir, otherSlot(slot)) : null;
    const result = rule(readState(dir, slot), now, { pidAlive, queueTtlMs: queueTtlMs(env), other, sharedOk: sharedOk(env) });
    if (result.state) {
      writeState(dir, slot, result.state);
      logEvents(dir, slot, result.events, now);
    }
    return result;
  };
  if (!withOther) return withMutex(dir, slot, apply);
  return withMutex(dir, PAIRED[0], () => withMutex(dir, PAIRED[1], apply));
}

// ---------- Looking at the machine ----------

const probing = (env) => env.AGENT_SLOTS_NO_PROBE !== '1';

const exec = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
  } catch (e) {
    return e.stdout ? String(e.stdout) : '';
  }
};

function look(env) {
  const procs = parsePs(exec('ps', ['-axo', 'pid=,ppid=,command=']));
  return {
    simulators: parseSimctlBooted(exec('xcrun', ['simctl', 'list', 'devices', 'booted'])),
    emulators: findEmulators(procs),
    testRuns: findTestRuns(procs, readLimits(env).testWorkerPattern),
  };
}

// The memory flags, as one short line. Also kept in health.log (its last 200 lines).
function healthLine(dir, slot, who, env) {
  let line;
  try {
    const limits = readLimits(env);
    const flags = evaluate(gatherFacts(limits), limits);
    line = flags.length ? `Memory flags (report these; do not kill other threads' processes): ${flags.join(' ')}` : 'Memory: healthy';
  } catch (e) {
    line = `Memory: could not check (${e.message})`;
  }
  const log = join(dir, 'health.log');
  const old = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  writeFileSync(log, `${[...old, `${iso(Date.now())} ${slot} who="${who}" ${line}`].slice(-200).join('\n')}\n`);
  return line;
}

// ---------- The commands ----------

// Asks once. If the request would be granted, looks at the machine first (outside the short lock,
// because the look can take a second), then asks again with what it found.
function tryAcquire(dir, req, env) {
  let blocked;
  for (;;) {
    const paired = otherSlot(req.slot) !== null;
    const result = change(dir, req.slot, (state, now, opts) => acquire(state, req, now, { ...opts, needsProbe: paired && probing(env), blocked }), env, { withOther: paired && !sharedOk(env) });
    if (!result.needProbe) return result;
    blocked = probeMessage(req.slot, look(env), { sharedOk: sharedOk(env) });
  }
}

// Asks, and with --wait keeps asking in the foreground until granted or the wait is over.
function acquireWithWait(dir, req, waitSeconds, env) {
  const pollMs = Number(env.SLOT_POLL_MS) > 0 ? Number(env.SLOT_POLL_MS) : 5000;
  const deadline = Date.now() + waitSeconds * 1000;
  let told = false;
  for (;;) {
    const result = tryAcquire(dir, req, env);
    if (result.code !== EXIT.busy || Date.now() + pollMs > deadline) return result;
    if (!told) {
      console.log(`${result.message}\nWaiting up to ${waitSeconds} seconds for it.`);
      told = true;
    }
    sleepSync(pollMs);
  }
}

function showStatus(dir, json, env) {
  const now = Date.now();
  const states = Object.fromEntries(SLOTS.map((slot) => [slot, readState(dir, slot)]));
  const opts = (slot) => ({ pidAlive, queueTtlMs: queueTtlMs(env), other: states[otherSlot(slot)] ?? null, sharedOk: sharedOk(env) });
  const slots = Object.fromEntries(SLOTS.map((slot) => [slot, view(states[slot], now, opts(slot), slot)]));
  const seen = probing(env) ? look(env) : null;
  if (json) {
    console.log(JSON.stringify({ dir, slots, machine: seen }, null, 2));
    return;
  }
  console.log(`Slots (records in ${dir})`);
  for (const slot of SLOTS) {
    const v = slots[slot];
    let line;
    if (v.holder) line = `held by ${v.holder.who} until ${clock(at(v.holder.until))} (${plural(v.holder.minutesLeft, 'minute')} left)${v.holder.pid !== undefined ? `, running a command (pid ${v.holder.pid})` : ''}${v.holder.note ? `. Note: ${v.holder.note}` : ''}`;
    else if (v.expired) line = `free (${v.expired.who} held it and never released it)`;
    else line = 'free';
    console.log(`${`${slot}:`.padEnd(8)}${line}`);
    if (v.queue.length) console.log(`${' '.repeat(8)}in line: ${v.queue.map((who, i) => `${i + 1}. ${who}`).join('  ')}`);
    if (v.waitsFor) console.log(`${' '.repeat(8)}waits for ${v.waitsFor}: the first in line gets it once the ${v.waitsFor} slot is free`);
  }
  if (!seen) return;
  const on = [...seen.simulators.map((d) => `${d.name} (${d.udid})`), ...seen.emulators.map((e) => `emulator ${e.name} (pid ${e.pid})`)];
  console.log(`Devices on:      ${on.length ? on.join(', ') : 'none'}`);
  console.log(`Test runs going: ${seen.testRuns.length}`);
}

// Takes the slot, runs the command in the foreground, and always gives the slot back.
function runCommand(dir, args, env) {
  const { slot, who, minutes } = args;
  const req = { slot, who, minutes, note: args.note, pid: process.pid };
  const got = acquireWithWait(dir, req, args.wait, env);
  if (!got.granted) {
    console.log(got.message);
    process.exit(got.code);
  }
  // Catch stop signals from the moment the slot is ours, before anything slow. A handler runs
  // only once this function has returned, and by then the command has started, so the signal
  // is always passed on and the slot is given back. (If this script is killed outright, the
  // record names a process that is gone, and the slot is free at once.)
  let child;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal));
  console.log(got.message);
  if (got.fresh && probing(env) && otherSlot(slot)) console.log(healthLine(dir, slot, who, env));

  // Only touch the record while it is still this very run's: same name and same process.
  const ifMine = (rule) => (state, now, opts) => (state.holder && state.holder.who === who && state.holder.pid === process.pid ? rule(state, now, opts) : {});
  child = spawn(args.cmd[0], args.cmd.slice(1), { stdio: 'inherit' });
  const keepAlive = setInterval(() => {
    try { change(dir, slot, ifMine((state, now, opts) => renew(state, req, now, opts)), env); } catch { /* try again in a minute */ }
  }, MIN);
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    clearInterval(keepAlive);
    try {
      change(dir, slot, ifMine((state, now, opts) => release(state, req, now, opts)), env);
    } catch (e) {
      console.error(`Could not release ${slot}: ${e.message}. It frees itself now that this command has ended.`);
    }
    process.exit(code);
  };
  child.on('error', (e) => {
    console.error(`Could not start "${args.cmd[0]}": ${e.message}`);
    finish(127);
  });
  child.on('exit', (code, signal) => finish(signal ? 128 + (osConstants.signals[signal] ?? 0) : code ?? 1));
}

const USAGE = `Usage:
  node scripts/slot.mjs acquire <device|tests|merge> --who <name> [--minutes N] [--note text] [--wait seconds] [--pid N]
  node scripts/slot.mjs renew <device|tests|merge> --who <name> [--minutes N]
  node scripts/slot.mjs release <device|tests|merge> --who <name> [--force]
  node scripts/slot.mjs status [--json]
  node scripts/slot.mjs run <device|tests|merge> --who <name> [--minutes N] [--wait seconds] -- <command...>
Exit codes: 0 done or granted, 75 busy (you are in line; ask again later), 1 error, 2 wrong usage.`;

function main(argv, env) {
  let args;
  try {
    args = parseArgs(argv);
    queueTtlMs(env);
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(EXIT.usage);
  }
  try {
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    if (args.command === 'status') return showStatus(dir, args.json, env);
    if (args.command === 'run') return runCommand(dir, args, env);
    const req = { slot: args.slot, who: args.who, minutes: args.minutes, note: args.note, force: args.force, ...(args.pid !== null ? { pid: args.pid } : {}) };
    let result;
    if (args.command === 'acquire') result = acquireWithWait(dir, req, args.wait, env);
    else if (args.command === 'renew') result = change(dir, args.slot, (state, now, opts) => renew(state, req, now, opts), env);
    else result = change(dir, args.slot, (state, now, opts) => release(state, req, now, opts), env);
    (result.code === EXIT.error ? console.error : console.log)(result.message);
    if (result.granted && result.fresh && probing(env) && otherSlot(args.slot)) console.log(healthLine(dir, args.slot, args.who, env));
    process.exit(result.code);
  } catch (e) {
    console.error(e.message);
    process.exit(EXIT.error);
  }
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main(process.argv.slice(2), process.env);

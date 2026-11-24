#!/usr/bin/env node
// ram-health.mjs: one memory health report for a Mac that many agents share, with flags.
//
// It only looks. It never stops, kills, or changes anything ("look, don't kill").
// It reports: free memory, swap (disk space the Mac uses when memory is full), test runs that use
// workers (helper processes) and each worker's memory, watchman's memory, booted iPhone Simulators,
// running Android emulators, the top memory users, and, if asked, which dev server ports are taken.
// Memory per process comes from `top`, whose MEM column includes compressed memory; `ps` RSS misses
// it (watchman once showed 15 MB in ps and 601 MB in top).
//
// How to run (macOS, Node 18 or newer):
//   node scripts/ram-health.mjs                      # report; exit 0 if healthy, 1 if anything is flagged
//   node scripts/ram-health.mjs --ports 8081,8083    # also say which of these ports something listens on
//   node scripts/ram-health.mjs --tests-free         # exit 0 only if no test run with workers is going
//
// Thresholds, set by environment variable (defaults are tuned for a 16 GB Mac; see docs/agents/ram-rules.md):
//   RAM_MIN_FREE_PCT=40       flag when free memory is under this percent
//   RAM_MAX_SWAP_GB=5         flag when swap used is over this
//   RAM_MAX_TEST_RUNS=1       flag when more test runs with workers than this run at once
//   RAM_MAX_WORKER_GB=2       flag any one test worker over this
//   RAM_MAX_WATCHMAN_GB=1     flag watchman over this
//   RAM_MAX_DEVICES=1         flag when more Simulators plus emulators than this are running
//   RAM_TEST_WORKER_PATTERN=jest-worker   regular expression for a test worker's command line
//                                         (for example jest-worker|vitest/dist/workers)
//   RAM_PORTS=8081,8083       same as --ports

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GB = 1024 ** 3;

export const DEFAULT_LIMITS = {
  minFreePct: 40,
  maxSwapGb: 5,
  maxTestRuns: 1,
  maxWorkerGb: 2,
  maxWatchmanGb: 1,
  maxDevices: 1,
  testWorkerPattern: 'jest-worker',
};

export function readLimits(env = {}) {
  const num = (name, fallback) => {
    if (env[name] === undefined || env[name] === '') return fallback;
    const n = Number(env[name]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number, 0 or more (got "${env[name]}")`);
    return n;
  };
  return {
    minFreePct: num('RAM_MIN_FREE_PCT', DEFAULT_LIMITS.minFreePct),
    maxSwapGb: num('RAM_MAX_SWAP_GB', DEFAULT_LIMITS.maxSwapGb),
    maxTestRuns: num('RAM_MAX_TEST_RUNS', DEFAULT_LIMITS.maxTestRuns),
    maxWorkerGb: num('RAM_MAX_WORKER_GB', DEFAULT_LIMITS.maxWorkerGb),
    maxWatchmanGb: num('RAM_MAX_WATCHMAN_GB', DEFAULT_LIMITS.maxWatchmanGb),
    maxDevices: num('RAM_MAX_DEVICES', DEFAULT_LIMITS.maxDevices),
    testWorkerPattern: env.RAM_TEST_WORKER_PATTERN || DEFAULT_LIMITS.testWorkerPattern,
  };
}

// "601M", "2501M+", "1024K-", "3.4G", "512B" -> bytes. Null if it is not a size.
export function parseSize(text) {
  const m = String(text).trim().match(/^([\d.]+)([BKMGT])?[+-]?$/i);
  if (!m) return null;
  const power = { B: 0, K: 1, M: 2, G: 3, T: 4 }[(m[2] || 'B').toUpperCase()];
  return Math.round(Number(m[1]) * 1024 ** power);
}

// `memory_pressure` output -> free memory percent.
export function parseFreePercent(text) {
  const m = String(text).match(/System-wide memory free percentage:\s*(\d+)%/);
  return m ? Number(m[1]) : null;
}

// `sysctl vm.swapusage` output -> { totalBytes, usedBytes }.
export function parseSwap(text) {
  const total = String(text).match(/total = ([\d.]+[KMGT]?)/);
  const used = String(text).match(/used = ([\d.]+[KMGT]?)/);
  if (!total || !used) return null;
  return { totalBytes: parseSize(total[1]), usedBytes: parseSize(used[1]) };
}

// `top -l 1 -stats pid,command,mem` output -> [{ pid, command, memBytes }].
// The command name can hold spaces ("T3 Code (Nightly"), so: first word is the pid, last is MEM.
export function parseTop(text) {
  const lines = String(text).split('\n');
  const header = lines.findIndex((l) => /^\s*PID\s+COMMAND\s+MEM\s*$/.test(l));
  if (header < 0) return [];
  const rows = [];
  for (const line of lines.slice(header + 1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || !/^\d+$/.test(parts[0])) continue;
    const memBytes = parseSize(parts[parts.length - 1]);
    if (memBytes === null) continue;
    rows.push({ pid: Number(parts[0]), command: parts.slice(1, -1).join(' '), memBytes });
  }
  return rows;
}

// `ps -axo pid=,ppid=,command=` output -> [{ pid, ppid, command }].
export function parsePs(text) {
  const procs = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return procs;
}

// Test workers grouped by the process that started them: one group is one test run.
export function findTestRuns(procs, pattern) {
  const re = new RegExp(pattern);
  const runs = new Map();
  for (const p of procs) {
    if (!re.test(p.command)) continue;
    if (!runs.has(p.ppid)) runs.set(p.ppid, []);
    runs.get(p.ppid).push(p.pid);
  }
  return [...runs].map(([parentPid, workerPids]) => ({ parentPid, workerPids }));
}

export function findWatchman(procs) {
  return procs.filter((p) => /(^|\/)watchman(\s|$)/.test(p.command)).map((p) => p.pid);
}

// Android emulators run as qemu-system processes (started by the `emulator -avd <name>` launcher).
// Count the qemu processes; fall back to launchers only when no qemu process exists yet.
export function findEmulators(procs) {
  const qemu = procs.filter((p) => /qemu-system/.test(p.command));
  const list = qemu.length ? qemu : procs.filter((p) => /(^|\/)emulator\s.*-avd\s/.test(p.command));
  return list.map((p) => ({ pid: p.pid, name: (p.command.match(/-avd\s+(\S+)/) || [])[1] || 'unknown' }));
}

// `xcrun simctl list devices booted` output -> [{ name, udid }].
export function parseSimctlBooted(text) {
  const devices = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s+(.+?) \(([0-9A-F-]{36})\) \(Booted\)/i);
    if (m) devices.push({ name: m[1], udid: m[2] });
  }
  return devices;
}

// Pure rule: given the facts, list every threshold that is crossed. Unknown facts never flag.
export function evaluate(facts, limits) {
  const flags = [];
  if (facts.freePct !== null && facts.freePct < limits.minFreePct) flags.push(`Free memory ${facts.freePct}% is under ${limits.minFreePct}%.`);
  if (facts.swap && facts.swap.usedBytes / GB > limits.maxSwapGb) flags.push(`Swap used ${(facts.swap.usedBytes / GB).toFixed(1)} GB is over ${limits.maxSwapGb} GB.`);
  if (facts.testRuns.length > limits.maxTestRuns) flags.push(`${facts.testRuns.length} test runs with workers at once (limit ${limits.maxTestRuns}).`);
  for (const w of facts.workers) if (w.memBytes / GB > limits.maxWorkerGb) flags.push(`Test worker ${w.pid} uses ${(w.memBytes / GB).toFixed(1)} GB (over ${limits.maxWorkerGb} GB).`);
  if (facts.watchmanBytes / GB > limits.maxWatchmanGb) flags.push(`Watchman uses ${(facts.watchmanBytes / GB).toFixed(1)} GB (over ${limits.maxWatchmanGb} GB). Clean up finished worktrees.`);
  const devices = facts.simulators.length + facts.emulators.length;
  if (devices > limits.maxDevices) flags.push(`${devices} devices running (limit ${limits.maxDevices}): ${[...facts.simulators.map((s) => s.name), ...facts.emulators.map((e) => e.name)].join(', ')}.`);
  return flags;
}

export function parsePorts(text) {
  if (!text) return [];
  return String(text).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Not a port number: "${s}"`);
    return n;
  });
}

// Runs a command and returns its output, or null if the tool is missing or fails.
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }); } catch (e) { return e.stdout ? String(e.stdout) : null; } };

function memByPid(pids) {
  if (pids.length === 0) return new Map();
  const out = run('top', ['-l', '1', '-stats', 'pid,command,mem', ...pids.flatMap((p) => ['-pid', String(p)])]);
  return new Map(parseTop(out || '').map((r) => [r.pid, r.memBytes]));
}

function listening(port) {
  const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (!out) return null;
  const line = out.split('\n').find((l) => /^\S+\s+\d+\s/.test(l) && !/^COMMAND\s/.test(l));
  if (!line) return null;
  const [command, pid] = line.trim().split(/\s+/);
  return { command, pid: Number(pid) };
}

// Gathers every fact the report and the flags need, in one call. Other scripts reuse it
// (slot.mjs prints the flags each time it grants a slot). It only looks.
// procs: the parsed `ps` list, if the caller already has one.
export function gatherFacts(limits = DEFAULT_LIMITS, procs = parsePs(run('ps', ['-axo', 'pid=,ppid=,command=']) || '')) {
  const testRuns = findTestRuns(procs, limits.testWorkerPattern);
  const watchmanPids = findWatchman(procs);
  const mem = memByPid([...testRuns.flatMap((r) => r.workerPids), ...watchmanPids]);
  return {
    freePct: parseFreePercent(run('memory_pressure', []) || ''),
    swap: parseSwap(run('sysctl', ['vm.swapusage']) || ''),
    testRuns,
    workers: testRuns.flatMap((r) => r.workerPids).map((pid) => ({ pid, memBytes: mem.get(pid) ?? 0 })),
    watchmanPids,
    watchmanBytes: watchmanPids.reduce((sum, pid) => sum + (mem.get(pid) ?? 0), 0),
    simulators: parseSimctlBooted(run('xcrun', ['simctl', 'list', 'devices', 'booted']) || ''),
    emulators: findEmulators(procs),
  };
}

const fmt = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

function main(argv) {
  let limits; let ports;
  try {
    limits = readLimits(process.env);
    const i = argv.indexOf('--ports');
    ports = parsePorts(i >= 0 ? argv[i + 1] : process.env.RAM_PORTS);
    new RegExp(limits.testWorkerPattern);
  } catch (e) { console.error(e.message); process.exit(2); }

  const procs = parsePs(run('ps', ['-axo', 'pid=,ppid=,command=']) || '');
  const testRuns = findTestRuns(procs, limits.testWorkerPattern);

  if (argv.includes('--tests-free')) {
    if (testRuns.length === 0) { console.log('No test run with workers is going. You may start one.'); return; }
    for (const r of testRuns) console.log(`Test run (parent pid ${r.parentPid}) with ${r.workerPids.length} workers: ${r.workerPids.join(', ')}`);
    console.log('A test run is going. Do other work and check again later.');
    process.exit(1);
  }

  const facts = gatherFacts(limits, procs);
  const { workers, emulators, watchmanPids } = facts;
  const top = parseTop(run('top', ['-l', '1', '-o', 'mem', '-n', '10', '-stats', 'pid,command,mem']) || '');
  const ramBytes = Number((run('sysctl', ['-n', 'hw.memsize']) || '').trim()) || 0;
  const flags = evaluate(facts, limits);

  const unknown = 'unknown (tool not available)';
  console.log(`RAM health, ${new Date().toLocaleString()}${ramBytes ? `, ${fmt(ramBytes)} machine` : ''}`);
  console.log(`Free memory:     ${facts.freePct === null ? unknown : `${facts.freePct}%`}`);
  console.log(`Swap used:       ${facts.swap ? `${fmt(facts.swap.usedBytes)} of ${fmt(facts.swap.totalBytes)}` : unknown}`);
  console.log(`Test runs:       ${testRuns.length}${testRuns.length ? ` (${workers.map((w) => `worker ${w.pid} ${fmt(w.memBytes)}`).join(', ')})` : ''}`);
  console.log(`Watchman:        ${watchmanPids.length ? fmt(facts.watchmanBytes) : 'not running'}`);
  console.log(`Simulators:      ${facts.simulators.length ? facts.simulators.map((s) => `${s.name} (${s.udid})`).join(', ') : 'none booted'}`);
  console.log(`Emulators:       ${emulators.length ? emulators.map((e) => `${e.name} (pid ${e.pid})`).join(', ') : 'none running'}`);
  for (const port of ports) {
    const who = listening(port);
    console.log(`Port ${port}:${' '.repeat(Math.max(1, 10 - String(port).length))}${who ? `in use by ${who.command} (pid ${who.pid})` : 'free'}`);
  }
  console.log('Top memory users (top MEM, includes compressed memory):');
  for (const r of top) console.log(`  ${fmt(r.memBytes).padStart(8)}  ${r.command} (pid ${r.pid})`);
  if (flags.length === 0) { console.log('Flags: none. Healthy.'); return; }
  console.log(`Flags: ${flags.length}. Report these; do not kill other threads' processes.`);
  for (const f of flags) console.log(`- ${f}`);
  process.exit(1);
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

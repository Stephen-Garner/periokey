// Tests for ram-health.mjs. Run: node --test scripts/ram-health.test.mjs
// They feed saved tool output to the parsers and fixed facts to `evaluate`, so they run anywhere,
// start no test workers, and never touch the real machine. Each flag has a test that fails if
// its threshold is removed or changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIMITS, readLimits, parseSize, parseFreePercent, parseSwap, parseTop, parsePs,
  findTestRuns, findWatchman, findEmulators, parseSimctlBooted, evaluate, parsePorts, gatherFacts,
} from './ram-health.mjs';

const GB = 1024 ** 3;

test('default limits match the 16 GB Mac rules (ram-rules.md)', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    minFreePct: 40, maxSwapGb: 5, maxTestRuns: 1, maxWorkerGb: 2, maxWatchmanGb: 1, maxDevices: 1, testWorkerPattern: 'jest-worker',
  });
});

test('limits can be tuned per machine by environment variable', () => {
  const l = readLimits({ RAM_MIN_FREE_PCT: '30', RAM_MAX_SWAP_GB: '8', RAM_MAX_DEVICES: '2', RAM_TEST_WORKER_PATTERN: 'vitest' });
  assert.deepEqual([l.minFreePct, l.maxSwapGb, l.maxDevices, l.testWorkerPattern, l.maxTestRuns], [30, 8, 2, 'vitest', 1]);
  assert.throws(() => readLimits({ RAM_MAX_SWAP_GB: 'lots' }), /RAM_MAX_SWAP_GB/);
});

test('parses sizes as top prints them', () => {
  assert.equal(parseSize('601M'), 601 * 1024 ** 2);
  assert.equal(parseSize('2501M+'), 2501 * 1024 ** 2);
  assert.equal(parseSize('1024K-'), 1024 * 1024);
  assert.equal(parseSize('3.4G'), Math.round(3.4 * GB));
  assert.equal(parseSize('512B'), 512);
  assert.equal(parseSize('n/a'), null);
});

test('parses memory_pressure and swap output', () => {
  assert.equal(parseFreePercent('Pageouts: 326465\n\nSystem-wide memory free percentage: 37%\n'), 37);
  assert.equal(parseFreePercent('nothing here'), null);
  assert.deepEqual(parseSwap('vm.swapusage: total = 2048.00M  used = 1682.00M  free = 366.00M  (encrypted)'), {
    totalBytes: 2048 * 1024 ** 2, usedBytes: 1682 * 1024 ** 2,
  });
});

test('parses top output, including command names with spaces', () => {
  const rows = parseTop(`Processes: 700 total
PhysMem: 15G used

PID    COMMAND          MEM
51374  MyApp            800M
42102  T3 Code (Nightly 482M
56867  watchman         601M+
`);
  assert.deepEqual(rows, [
    { pid: 51374, command: 'MyApp', memBytes: 800 * 1024 ** 2 },
    { pid: 42102, command: 'T3 Code (Nightly', memBytes: 482 * 1024 ** 2 },
    { pid: 56867, command: 'watchman', memBytes: 601 * 1024 ** 2 },
  ]);
});

const PS = `  100     1 /opt/homebrew/bin/watchman --foreground --logfile=/x/log
  200   150 node /repo-a/node_modules/.bin/jest --maxWorkers=2
  201   200 /usr/local/bin/node /repo-a/node_modules/jest-worker/build/workers/processChild.js
  202   200 /usr/local/bin/node /repo-a/node_modules/jest-worker/build/workers/processChild.js
  301   300 /usr/local/bin/node /repo-b/node_modules/jest-worker/build/workers/processChild.js
  400     1 /Users/me/Library/Android/sdk/emulator/emulator -avd test-pixel
  401   400 /Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd test-pixel -no-window
  500     1 grep watchman-notes.txt
`;

test('groups test workers into runs by their parent process', () => {
  const runs = findTestRuns(parsePs(PS), 'jest-worker');
  assert.deepEqual(runs, [{ parentPid: 200, workerPids: [201, 202] }, { parentPid: 300, workerPids: [301] }]);
  assert.deepEqual(findTestRuns(parsePs(PS), 'vitest'), []);
});

test('finds watchman and Android emulators without double counting the launcher', () => {
  const procs = parsePs(PS);
  assert.deepEqual(findWatchman(procs), [100]);
  assert.deepEqual(findEmulators(procs), [{ pid: 401, name: 'test-pixel' }]);
  assert.deepEqual(findEmulators(procs.filter((p) => p.pid !== 401)), [{ pid: 400, name: 'test-pixel' }]);
});

test('parses booted Simulators from simctl', () => {
  const sims = parseSimctlBooted(`== Devices ==
-- iOS 26.5 --
    Test-Phone (F4F090E1-7EA4-4935-BB49-E51707ADA502) (Booted)
    Other-Phone (A4F090E1-7EA4-4935-BB49-E51707ADA503) (Shutdown)
`);
  assert.deepEqual(sims, [{ name: 'Test-Phone', udid: 'F4F090E1-7EA4-4935-BB49-E51707ADA502' }]);
});

const healthy = {
  freePct: 70,
  swap: { totalBytes: 4 * GB, usedBytes: 1 * GB },
  testRuns: [{ parentPid: 200, workerPids: [201, 202] }],
  workers: [{ pid: 201, memBytes: 1.5 * GB }, { pid: 202, memBytes: 1 * GB }],
  watchmanBytes: 0.5 * GB,
  simulators: [{ name: 'Test-Phone', udid: 'x' }],
  emulators: [],
};

test('a healthy machine has no flags', () => {
  assert.deepEqual(evaluate(healthy, DEFAULT_LIMITS), []);
});

for (const [name, change, pattern] of [
  ['free memory under 40 percent', { freePct: 39 }, /Free memory 39% is under 40%/],
  ['swap over 5 GB', { swap: { totalBytes: 8 * GB, usedBytes: 5.5 * GB } }, /Swap used 5\.5 GB is over 5 GB/],
  ['two test runs at once', { testRuns: [{ parentPid: 1, workerPids: [2] }, { parentPid: 3, workerPids: [4] }] }, /2 test runs with workers at once/],
  ['a test worker over 2 GB', { workers: [{ pid: 9, memBytes: 2.2 * GB }] }, /Test worker 9 uses 2\.2 GB/],
  ['watchman over 1 GB', { watchmanBytes: 3.4 * GB }, /Watchman uses 3\.4 GB/],
  ['a Simulator and an emulator at once', { emulators: [{ pid: 401, name: 'test-pixel' }] }, /2 devices running \(limit 1\): Test-Phone, test-pixel/],
]) {
  test(`flags ${name}`, () => {
    const flags = evaluate({ ...healthy, ...change }, DEFAULT_LIMITS);
    assert.equal(flags.length, 1, flags.join(' | '));
    assert.match(flags[0], pattern);
  });
}

test('unknown facts (tool missing) never raise a flag', () => {
  assert.deepEqual(evaluate({ ...healthy, freePct: null, swap: null }, DEFAULT_LIMITS), []);
});

test('ports are checked', () => {
  assert.deepEqual(parsePorts('8081, 8083'), [8081, 8083]);
  assert.deepEqual(parsePorts(undefined), []);
  assert.throws(() => parsePorts('8081,metro'), /Not a port number/);
});

test('gatherFacts builds every fact from a given process list, and evaluate accepts it', () => {
  // The process list is passed in, so the worker and watchman lists are known. Memory, swap, and
  // Simulators come from the real machine (or are unknown where the tools are missing).
  const procs = parsePs('  10  1 /usr/local/bin/watchman --foreground\n  20  7 node jest-worker/processChild.js\n  21  7 node jest-worker/processChild.js\n');
  const facts = gatherFacts(DEFAULT_LIMITS, procs);
  assert.deepEqual(facts.testRuns, [{ parentPid: 7, workerPids: [20, 21] }]);
  assert.deepEqual(facts.workers.map((w) => w.pid), [20, 21]);
  assert.deepEqual(facts.watchmanPids, [10]);
  assert.deepEqual(facts.emulators, []);
  for (const key of ['freePct', 'swap', 'watchmanBytes', 'simulators']) assert.ok(key in facts, `missing ${key}`);
  assert.ok(Array.isArray(evaluate(facts, DEFAULT_LIMITS)));
});

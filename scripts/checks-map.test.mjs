// Tests for checks-map.mjs. Run: node --test scripts/checks-map.test.mjs
// The CLI tests make a throwaway git repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN, MAP_FILE, blanks, buildMap, findHookFile, hookJobs, newestTimes, run, table, withoutTimes } from './checks-map.mjs';
import { CACHE_FILE } from './merge-pr.mjs';


const LINT = { name: 'eslint', run: 'pnpm exec eslint .', fast: true, protects: 'Kit rules.', misses: 'Wrong logic.' };
const AUDIT = { name: 'audit', run: 'pnpm audit', protects: 'Known holes.', misses: 'Unknown holes.' };

function repo(config) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-checks-map-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/kit.config.json'), JSON.stringify(config));
  return dir;
}

function cli(argv, cwd) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { cwd, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { code, stdout, stderr };
}

test('blanks names each check with a blank protects or misses', () => {
  assert.deepEqual(blanks([LINT, { name: 'test', run: 'x', protects: ' ' }, { name: 'b', run: 'y', protects: 'p' }]), [
    { name: 'test', fields: ['protects', 'misses'] },
    { name: 'b', fields: ['misses'] },
  ]);
  assert.deepEqual(blanks([LINT, AUDIT]), []);
});

test('the map has a row per check, with the merge script rule for the quick check, the hook jobs, and the measured time', () => {
  const SLOW = { name: 'test', run: 'pnpm test', slot: true, protects: 'p', misses: 'm' };
  const OFF = { name: 'e2e', run: 'pnpm e2e', fast: false, protects: 'p', misses: 'm' };
  const text = buildMap([LINT, AUDIT, SLOW, OFF], { eslint: 4210 }, ['eslint', 'format']);
  const row = (name) => text.split('\n').find((l) => l.startsWith(`| ${name} `)).split('|').map((c) => c.trim());
  assert.deepEqual(row('eslint').slice(1, 6), ['eslint', 'commit hook, quick check, merge', '4.2 s', 'Kit rules.', 'Wrong logic.']);
  assert.deepEqual(row('audit').slice(1, 6), ['audit', 'quick check, merge', 'not measured', 'Known holes.', 'Unknown holes.'], 'no "fast" key: it runs in the quick check');
  assert.equal(row('test')[2], 'merge', '"slot": true is skipped by --fast');
  assert.equal(row('e2e')[2], 'merge', '"fast": false is skipped by --fast');
  assert.equal(row('rules')[2], 'commit hook, quick check, merge');
  for (const b of BUILT_IN) assert.ok(row(b.name), b.name);
  assert.match(text, /^# Checks map$/m);
});

test('the table pads every column to one width and escapes a pipe in a cell', () => {
  assert.equal(table([['A', 'Bb'], ['long', 'x|y']]), '| A    | Bb  |\n| ---- | --- |\n| long | x|y |');
  assert.ok(buildMap([{ ...AUDIT, misses: 'a | b' }]).includes('a \\| b'), 'a pipe in a cell is escaped');
});

test('newestTimes takes the newest measured run per check and skips entries with no time', () => {
  const cache = {
    k1: { name: 'eslint', passedAt: 100, ms: 3000 },
    k2: { name: 'eslint', passedAt: 200, ms: 5000 },
    k3: { name: 'tsc', passedAt: 300 },
    k4: { name: 'audit', passedAt: 50, ms: 900 },
  };
  assert.deepEqual(newestTimes(cache), { eslint: 5000, audit: 900 });
});

test('withoutTimes ignores the time and the padding, but not a changed line of text', () => {
  const a = buildMap([LINT], {});
  assert.equal(withoutTimes(a), withoutTimes(buildMap([LINT], { eslint: 123456 })));
  assert.notEqual(withoutTimes(a), withoutTimes(buildMap([{ ...LINT, misses: 'Something else.' }], {})));
  assert.notEqual(withoutTimes(a), withoutTimes(buildMap([{ ...LINT, fast: false }], {})));
  assert.notEqual(withoutTimes(a), withoutTimes(buildMap([LINT], {}, ['eslint'])));
});

test('CLI: a check with a blank protects or misses is named, and nothing is written', () => {
  const dir = repo({ checks: [{ name: 'test', run: 'pnpm test' }] });
  try {
    const r = cli([], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /check "test" has a blank "protects" and "misses"/);
    assert.throws(() => readFileSync(join(dir, MAP_FILE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: writes the map, --check passes on it and fails when it is missing or old', () => {
  const dir = repo({ checks: [] });
  try {
    assert.equal(cli(['--check'], dir).code, 1, 'missing');
    const w = cli([], dir);
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /Wrote docs\/checks-map\.md \(3 checks\)/);
    assert.equal(cli(['--check'], dir).code, 0);
    writeFileSync(join(dir, MAP_FILE), readFileSync(join(dir, MAP_FILE), 'utf8').replace('Code outside scripts/.', 'Nothing.'));
    const old = cli(['--check'], dir);
    assert.equal(old.code, 1);
    assert.match(old.stderr, /out of date/);
    assert.equal(cli(['--frob'], dir).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hookJobs reads only the pre-commit section, in both its jobs and commands forms', () => {
  const text = 'pre-push:\n  jobs:\n    - name: format\n      run: x\npre-commit:\n  commands:\n    eslint:\n      run: y\n    "tsc":\n      run: z\n  jobs:\n    - name: secrets\n      run: g\ncommit-msg:\n  commands:\n    oxlint:\n      run: q\n';
  assert.deepEqual(hookJobs(text).sort(), ['eslint', 'secrets', 'tsc']);
});

test('hookJobs reads the job names from lefthook.yml', () => {
  assert.deepEqual(hookJobs('pre-commit:\n  jobs:\n    - name: format\n      run: x\n    - name: "eslint"\n      run: y\n'), ['format', 'eslint']);
  assert.deepEqual(hookJobs(null), []);
});

test('the incoming commits row shows only when the merge script runs that step', () => {
  const has = (text) => text.split('\n').some((l) => l.startsWith('| incoming commits '));
  assert.equal(has(buildMap([], {}, [])), false);
  const text = buildMap([], {}, [], { features: { incomingCommits: true } });
  assert.equal(has(text), true);
  assert.match(text, /\| incoming commits +\| quick check, merge +\|/);
  for (const name of ['rules', 'kit tests', 'script tests']) assert.ok(text.includes(`| ${name} `), name);
});

test('findHookFile finds the hook settings under every name lefthook reads, and says when it cannot read the format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-hook-'));
  try {
    assert.deepEqual(findHookFile(dir), { file: null, jobs: [], note: '' });
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, '.config/lefthook.yaml'), 'pre-commit:\n  jobs:\n    - name: eslint\n');
    assert.deepEqual(findHookFile(dir), { file: '.config/lefthook.yaml', jobs: ['eslint'], note: '' });
    writeFileSync(join(dir, '.lefthook.yml'), 'pre-commit:\n  jobs:\n    - name: format\n');
    assert.deepEqual(findHookFile(dir).jobs, ['format'], '.lefthook.yml comes before .config/lefthook.yaml');
    writeFileSync(join(dir, 'lefthook.toml'), '[pre-commit]\n');
    const toml = findHookFile(dir);
    assert.equal(toml.file, 'lefthook.toml');
    assert.deepEqual(toml.jobs, []);
    assert.match(toml.note, /lefthook\.toml is a format this script cannot read/);
    assert.match(buildMap([], {}, toml.jobs, { hookNote: toml.note }), /lefthook\.toml is a format this script cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: the map reads a hook file under another name and adds the incoming commits row when that step is on', () => {
  const dir = repo({ checks: [], features: { incomingCommits: true } });
  try {
    writeFileSync(join(dir, '.lefthook.yaml'), 'pre-commit:\n  jobs:\n    - name: rules\n');
    const first = cli([], dir);
    assert.equal(first.code, 0);
    assert.match(first.stdout, /\(4 checks\)/, 'rules, kit tests, script tests, incoming commits');
    const text = readFileSync(join(dir, MAP_FILE), 'utf8');
    assert.match(text, /\| incoming commits +\| quick check, merge +\|/);
    writeFileSync(join(dir, 'lefthook.json'), '{}');
    const r = cli([], dir);
    assert.match(r.stdout, /lefthook\.json is a format this script cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: the time comes from the merge script record of passed checks', () => {
  const dir = repo({ checks: [LINT] });
  try {
    writeFileSync(join(dir, '.git', CACHE_FILE), JSON.stringify({ k: { name: 'eslint', passedAt: Date.now(), ms: 2500 } }));
    const r = cli([], dir);
    assert.equal(r.code, 0, r.stderr);
    writeFileSync(join(dir, 'lefthook.yml'), 'pre-commit:\n  jobs:\n    - name: eslint\n      run: x\n');
    assert.equal(cli([], dir).code, 0);
    assert.match(readFileSync(join(dir, MAP_FILE), 'utf8'), /\| eslint +\| commit hook, quick check, merge +\| 2\.5 s +\|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the incoming commits row shows for true, "enforce", and "observe", and says when it only watches', () => {
  const row = (features) => buildMap([], {}, [], { features }).split('\n').find((l) => l.startsWith('| incoming commits '));
  assert.ok(row({ incomingCommits: true }));
  assert.ok(row({ incomingCommits: 'enforce' }));
  assert.match(row({ incomingCommits: 'observe' }), /only watches/);
  assert.doesNotMatch(row({ incomingCommits: 'enforce' }), /only watches/);
  for (const off of [false, 'off', undefined]) assert.equal(row({ incomingCommits: off }), undefined, String(off));
});

test('a check marked "observe" says it only watches', () => {
  const text = buildMap([{ name: 'e2e', run: 'pnpm e2e', observe: true, protects: 'p', misses: 'm' }], {}, []);
  assert.match(text.split('\n').find((l) => l.startsWith('| e2e ')), /\| quick check, merge \(only watches\) +\|/);
});

test('the five merge gates get a row each when on, and say when they only watch', () => {
  const gates = ['verifiedStamp', 'changeChecklist', 'reviewLevels', 'securityReview', 'findingAnswers'];
  const none = buildMap([], {}, [], { features: {} });
  const on = buildMap([], {}, [], { features: Object.fromEntries(gates.map((g, i) => [g, i % 2 ? 'observe' : true])) });
  for (const [i, g] of gates.entries()) {
    const row = on.split('\n').find((l) => l.startsWith(`| ${g} `));
    assert.ok(row, g);
    assert.equal(none.includes(`| ${g} `), false, `${g} is hidden when off`);
    assert.match(row, i % 2 ? /\| merge \(only watches\) +\|/ : /\| merge +\|/, g);
    const cells = row.split('|').map((c) => c.trim());
    assert.ok(cells[4].length > 20 && cells[5].length > 20, `${g} has protects and misses lines`);
  }
});

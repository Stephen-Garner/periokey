// Tests for scripts/run-file.mjs: the run file's shape, its reader, and its command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNS_DIR, readRun, validateRun } from './run-file.mjs';

const SCRIPT = fileURLToPath(new URL('./run-file.mjs', import.meta.url));
const RUN = {
  name: '2026-11-16-wave-1',
  start: '2026-11-16T09:00:00Z',
  end: null,
  tokenLimit: 120000000,
  leadBranch: 'lead/wave-1',
  sliceBranches: ['build/012-save-word', 'build/013-share'],
};
const errs = (over, opts) => validateRun({ ...RUN, ...over }, { file: '2026-11-16-wave-1.json', ...opts });
const has = (list, text) => list.some((e) => e.includes(text));

test('a run file lives in docs/runs/; a sound run, open or ended, has no errors', () => {
  assert.equal(RUNS_DIR, 'docs/runs/');
  assert.deepEqual(errs({}), []);
  assert.deepEqual(errs({ end: '2026-11-16T17:30:00.000+02:00' }), []);
  assert.deepEqual(errs({ sliceBranches: [] }), [], 'a run may start before its first slice branch exists');
});

test('every field is checked: name, times, limit, branches, and no unknown keys', () => {
  assert.ok(has(errs({ name: 'other' }), 'name "other" must match the file name "2026-11-16-wave-1"'));
  assert.ok(has(errs({ start: '2026-11-16 09:00' }), '"start" must be a time like 2026-11-16T09:00:00Z'));
  assert.ok(has(errs({ start: '2026-11-16T09:00:00' }), '"start" must be a time like'), 'no time zone is a guess');
  assert.ok(has(errs({ start: '2026-13-40T09:00:00Z' }), '"start" must be a time like'));
  assert.ok(has(errs({ end: '2026-11-16T08:00:00Z' }), '"end" is before "start"'));
  assert.ok(has(errs({ end: undefined }), '"end" must be null while the run goes on'));
  for (const bad of [0, -5, 1.5, '100', null]) assert.ok(has(errs({ tokenLimit: bad }), '"tokenLimit" must be a whole number above 0'), String(bad));
  assert.ok(has(errs({ leadBranch: 'build/wave' }), '"leadBranch" must start with lead/'));
  assert.deepEqual(errs({ leadBranch: 'head/wave' }, { leadPrefixes: ['head/'] }), []);
  assert.ok(has(errs({ sliceBranches: 'build/012' }), '"sliceBranches" must be a list of branch names'));
  assert.ok(has(errs({ sliceBranches: ['build/012', 'build/012'] }), '"sliceBranches" lists build/012 twice'));
  assert.ok(has(errs({ sliceBranches: ['lead/wave-1'] }), '"sliceBranches" lists the lead branch'));
  assert.ok(has(errs({ sliceBranches: ['has space'] }), '"sliceBranches" lists "has space", which is not a branch name'));
  assert.ok(has(errs({ owner: 'me' }), 'unknown key "owner"'));
  assert.ok(has(validateRun([], {}), 'must be a JSON object'));
});

test('branch names follow git\'s own rules: each name is judged as git check-ref-format --branch judges it', () => {
  const names = ['build/012-save-word', 'build/012..save.lock', 'build/012..save', 'build/save.lock', 'build/.hidden', 'build//012',
    'build/012.', '-build', 'HEAD', 'build/a.b-c_d', 'lead/wave.1', 'build/x.lock/y', '.build', 'has space'];
  // Stricter than git on letters: only A-Z, a-z, 0-9, and . _ / - are allowed, so 'build/@' is refused though git takes it.
  assert.ok(has(errs({ sliceBranches: ['build/@'] }), 'which is not a branch name'));
  for (const name of names) {
    const git = spawnSync('git', ['check-ref-format', '--branch', name], { encoding: 'utf8' }).status === 0;
    assert.equal(has(errs({ sliceBranches: [name] }), 'which is not a branch name'), !git, `${name}: git says ${git ? 'valid' : 'invalid'}`);
  }
});

test('readRun: gives back the run, or throws every error with the file name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-file-'));
  try {
    const good = join(dir, '2026-11-16-wave-1.json');
    writeFileSync(good, JSON.stringify(RUN));
    assert.deepEqual(readRun(good), RUN);
    const bad = join(dir, 'wave-2.json');
    writeFileSync(bad, JSON.stringify({ ...RUN, tokenLimit: 0, leadBranch: 'main' }));
    assert.throws(() => readRun(bad), (e) => e.message.includes('wave-2.json') && e.message.includes('"tokenLimit"') && e.message.includes('"leadBranch"'));
    const broken = join(dir, 'wave-3.json');
    writeFileSync(broken, '{ "name": ');
    assert.throws(() => readRun(broken), /wave-3\.json: not valid JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('command line: checks each file; exit 0 when all are sound, 1 with every error, 2 with no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-file-cli-'));
  try {
    const good = join(dir, '2026-11-16-wave-1.json');
    writeFileSync(good, JSON.stringify(RUN));
    const bad = join(dir, 'wave-2.json');
    writeFileSync(bad, JSON.stringify({ ...RUN, name: 'wave-2', tokenLimit: 0 }));
    const ok = spawnSync(process.execPath, [SCRIPT, good], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /ok {2}.*2026-11-16-wave-1\.json/);
    const fail = spawnSync(process.execPath, [SCRIPT, good, bad], { encoding: 'utf8' });
    assert.equal(fail.status, 1);
    assert.match(fail.stdout, /FAIL .*wave-2\.json[^\n]*\n {2}"tokenLimit" must be a whole number above 0/);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

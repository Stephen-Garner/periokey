// Tests for experiment.mjs. Run: node --test scripts/experiment.test.mjs
// Each test makes a throwaway git repo and a fake home folder in the temp folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimentsFrom, finishExperiment, listExperiments, proposeExperiment, run, slug, startExperiment } from './experiment.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-exp-'));
  const main = join(dir, 'Proj');
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  const home = join(dir, 'home');
  mkdirSync(join(home, '.agent-dashboard', 'proj'), { recursive: true });
  writeFileSync(join(home, '.agent-dashboard', 'proj', 'data.json'), JSON.stringify({ totals: { fixPerFeat: 10.1, openPrs: null } }));
  return { dir, main, home, opts: { env: {}, home }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PLAN = { question: 'Do two reviewers cut fix commits?', change: 'Two reviewers on every code pull request.', metric: 'fixPerFeat', days: 14, why: 'Fixes run high.' };

test('life cycle: propose, start (baseline from the last build), finish; a started proposal shows once', () => {
  const r = repo();
  try {
    const p = proposeExperiment(r.main, { ...PLAN, role: 'researcher' }, { ...r.opts, now: new Date(2026, 10, 18, 8).getTime() });
    let [x] = listExperiments(r.main);
    assert.deepEqual([x.id, x.status, x.baseline, x.startedAt, x.why, x.proposedBy], [p.id, 'proposed', null, null, 'Fixes run high.', { role: 'researcher', thread: null }]);
    const s = startExperiment(r.main, { proposal: p.id }, { ...r.opts, now: new Date(2026, 10, 18, 9).getTime() });
    assert.equal(s.data.experiment, p.id);
    assert.equal(s.data.baseline, 10.1, 'baseline read from ~/.agent-dashboard/<project>/data.json');
    const all = listExperiments(r.main);
    assert.equal(all.length, 1);
    [x] = all;
    assert.deepEqual([x.id, x.status, x.baseline, x.reviewAfter, x.question], [p.id, 'running', 10.1, '2026-12-02', PLAN.question]);
    assert.throws(() => startExperiment(r.main, { proposal: p.id }, r.opts), /already started/);
    assert.throws(() => finishExperiment(r.main, p.id, { verdict: 'maybe' }, r.opts), /verdict must be keep, drop, unclear/);
    finishExperiment(r.main, p.id, { verdict: 'keep', result: '6.2', note: 'Clear drop.' }, { ...r.opts, now: new Date(2026, 10, 18, 10).getTime() });
    [x] = listExperiments(r.main);
    assert.deepEqual([x.status, x.verdict, x.result, x.note], ['finished', 'keep', 6.2, 'Clear drop.']);
    assert.throws(() => finishExperiment(r.main, p.id, { verdict: 'drop' }, { ...r.opts, now: new Date(2026, 10, 18, 11).getTime() }), /already finished/);
  } finally {
    r.cleanup();
  }
});

test('baseline: a given one wins; a label not in totals, or a null total, gives null', () => {
  const r = repo();
  try {
    assert.equal(startExperiment(r.main, { ...PLAN, baseline: '7' }, r.opts).data.baseline, 7);
    assert.equal(startExperiment(r.main, { ...PLAN, metric: 'my label' }, r.opts).data.baseline, null);
    assert.equal(startExperiment(r.main, { ...PLAN, metric: 'openPrs' }, r.opts).data.baseline, null);
    assert.equal(startExperiment(r.main, PLAN, { ...r.opts, home: join(r.dir, 'nohome') }).data.baseline, null);
  } finally {
    r.cleanup();
  }
});

test('a direct start uses its own id; unknown ids and unstarted proposals are errors; fields are checked', () => {
  const r = repo();
  try {
    const s = startExperiment(r.main, PLAN, r.opts);
    assert.equal(s.data.experiment, s.id);
    assert.equal(listExperiments(r.main)[0].proposedBy, null);
    assert.throws(() => startExperiment(r.main, { proposal: 'deadbeef' }, r.opts), /No experiment has the id deadbeef/);
    const p = proposeExperiment(r.main, PLAN, r.opts);
    assert.throws(() => finishExperiment(r.main, p.id, { verdict: 'keep' }, r.opts), /never started/);
    assert.throws(() => proposeExperiment(r.main, { ...PLAN, question: '' }, r.opts), /needs a question/);
    assert.throws(() => proposeExperiment(r.main, { ...PLAN, days: '0' }, r.opts), /whole number of 1 or more/);
    assert.throws(() => proposeExperiment(r.main, { ...PLAN, metric: 'm'.repeat(41) }, r.opts), /metric is 41 characters/);
    assert.throws(() => finishExperiment(r.main, s.id, { verdict: 'keep', result: 'lots' }, r.opts), /result must be a number/);
  } finally {
    r.cleanup();
  }
});

test('experimentsFrom orders running, then proposed, then finished', () => {
  const ev = (id, type, at, data) => ({ id, type, at: `2026-11-${at}T09:00:00Z`, data });
  const rows = experimentsFrom([
    ev('p0000001', 'experiment-proposed', '01', { question: 'old proposal', days: 7 }),
    ev('s0000002', 'experiment-started', '02', { experiment: 's0000002', question: 'done', days: 7 }),
    ev('f0000003', 'experiment-finished', '03', { experiment: 's0000002', verdict: 'drop' }),
    ev('s0000004', 'experiment-started', '04', { experiment: 's0000004', question: 'live', days: 7 }),
    ev('f0000005', 'experiment-finished', '05', { experiment: 'nope', verdict: 'keep' }),
    ev('s0000006', 'experiment-started', '06', { experiment: 's0000002', question: 'restarted', days: 7 }),
  ]);
  assert.deepEqual(rows.map((x) => [x.question, x.status]), [['live', 'running'], ['old proposal', 'proposed'], ['done', 'finished']], 'a second start of one id is ignored');
});

test('export writes one Markdown file per experiment into docs/experiments of the current folder', () => {
  const r = repo();
  try {
    const s = startExperiment(r.main, PLAN, r.opts);
    const branchDir = join(r.dir, 'branch-copy');
    mkdirSync(branchDir);
    assert.equal(slug(PLAN.question), 'do-two-reviewers-cut-fix-commits');
    let out = '';
    // The log is found from the repo; the files land in the folder the command runs in.
    const code = run(['export'], { cwd: r.main, env: {}, home: r.home, stdout: (t) => (out += t), stderr: () => {} });
    assert.equal(code, 0);
    const files = readdirSync(join(r.main, 'docs', 'experiments'));
    assert.deepEqual(files, [`${s.id}-do-two-reviewers-cut-fix-commits.md`]);
    const text = readFileSync(join(r.main, 'docs', 'experiments', files[0]), 'utf8');
    assert.match(text, new RegExp(`^# Experiment ${s.id}: Do two reviewers cut fix commits\\?`));
    assert.match(text, /- Status: running/);
    assert.match(text, /- Baseline: 10\.1/);
    assert.equal(run(['export', 'deadbeef'], { cwd: r.main, env: {}, stdout: () => {}, stderr: () => {} }), 1);
  } finally {
    r.cleanup();
  }
});

test('the commands: propose, start a proposal, finish, list', () => {
  const r = repo();
  try {
    let out = '';
    const io = { cwd: r.main, env: {}, home: r.home, stdout: (t) => (out += t), stderr: () => {} };
    assert.equal(run(['propose', '--question', 'Q?', '--change', 'C', '--metric', 'fixPerFeat', '--days', '7'], io), 0);
    const id = out.match(/^proposed ([0-9a-f]{8})/)[1];
    assert.equal(run(['start', id], io), 0);
    assert.equal(run(['finish', id, '--verdict', 'unclear'], io), 0);
    out = '';
    assert.equal(run(['list', '--json'], io), 0);
    assert.deepEqual(JSON.parse(out).map((x) => [x.id, x.status, x.verdict, x.baseline]), [[id, 'finished', 'unclear', 10.1]]);
    assert.equal(run(['finish'], io), 2);
    assert.equal(run(['start', '--nope', 'x'], io), 2);
  } finally {
    r.cleanup();
  }
});

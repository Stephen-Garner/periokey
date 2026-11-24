// Tests for receipt.mjs. Run: node --test scripts/receipt.test.mjs
// Session records are small fixture files written to temp folders; nothing reads a home folder.
// Fingerprints come from real git repos made in temp folders.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OPTIONAL_FIELDS, RECEIPT_DIR, approvals, buildReceipt, checkReceipts, checkWeakenings, countBranchReceipts, formatFingerprints, neededCommits, parseSession, receiptPath } from './receipt.mjs';
import { findingsFor } from './findings.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'receipt.mjs');
const TS = '2026-11-14T10:00:00.000Z';
const FP = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const RUN = 'node scripts/receipt.mjs fingerprints build/084-welcome';
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const reply = ({ verdict = 'approve', task = '084', rulings = ['- `scripts/a.test.mjs`: still guards'] } = {}) =>
  `VERDICT: ${verdict}\nREVIEWED: abc1234\n${task ? `TASK: ${task}\n` : ''}\nFINDINGS\nnone\n\nPROTECTED TESTS\n${rulings.join('\n') || 'none'}\n\nQUESTIONS FOR THE LEAD\n- none\n`;
const fpOutput = (fps) => fps.map((f) => `kit-fingerprint ${f.fingerprint} ${f.commit} commit  some subject`).join('\n');

// A Claude Code record: tool calls and their output are blocks inside assistant and user lines.
function claudeRecord({ fps = [{ fingerprint: FP, commit: SHA }], output = fpOutput(fps), model = 'claude-opus-5-5', command = RUN, text = reply(), after = [] } = {}) {
  return jsonl([
    { type: 'user', timestamp: TS, message: { role: 'user', content: 'You are a reviewer.' } },
    { type: 'assistant', timestamp: TS, message: { id: 'm1', model, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } },
    { type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: output }] } },
    { type: 'assistant', timestamp: TS, message: { id: 'm2', model, content: [{ type: 'text', text }] } },
    ...after,
  ]);
}

// A Codex record: the model is in turn_context; tool output is a JSON string inside the payload.
function codexRecord({ fps = [{ fingerprint: FP, commit: SHA }], output = fpOutput(fps), model = 'gpt-6.1-sol', command = RUN, text = reply() } = {}) {
  return jsonl([
    { type: 'session_meta', timestamp: TS, payload: { cwd: '/w/project', git: { branch: 'build/084-welcome' } } },
    { type: 'turn_context', timestamp: TS, payload: { model } },
    { type: 'response_item', timestamp: TS, payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: command }) } },
    { type: 'response_item', timestamp: TS, payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: `${output}\n`, metadata: { exit_code: 0 } }) } },
    { type: 'response_item', timestamp: TS, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
  ]);
}

// ---------- Reading a session record ----------

test('parseSession, Claude: model from the reply\'s own model field, fingerprints from the fingerprints command\'s output', () => {
  const s = parseSession(claudeRecord());
  assert.deepEqual(s, {
    tool: 'claude', task: '084', verdict: 'approve', model: 'claude-opus-5-5', at: TS,
    fingerprints: [{ fingerprint: FP, commit: SHA }],
    protectedTests: [{ file: 'scripts/a.test.mjs', ruling: 'still guards' }],
  });
});

test('parseSession, Codex: model from turn_context, fingerprints from a tool output wrapped in JSON', () => {
  const s = parseSession(codexRecord({ text: reply({ verdict: 'changes needed', rulings: ['- tests/old.ts: weakened, it no longer checks the empty list'] }) }));
  assert.equal(s.tool, 'codex');
  assert.equal(s.model, 'gpt-6.1-sol');
  assert.equal(s.verdict, 'changes needed');
  assert.deepEqual(s.fingerprints, [{ fingerprint: FP, commit: SHA }]);
  assert.deepEqual(s.protectedTests, [{ file: 'tests/old.ts', ruling: 'weakened' }]);
});

test('parseSession: fingerprints the reviewer typed, or that another command printed, do not count', () => {
  const typed = `${reply()}\n${fpOutput([{ fingerprint: FP, commit: SHA }])}\n`;
  assert.throws(() => parseSession(claudeRecord({ command: 'cat notes.txt', text: typed })), /did not run "node scripts\/receipt\.mjs fingerprints" before its verdict/);
  assert.throws(() => parseSession(codexRecord({ command: 'cat notes.txt' })), /did not run "node scripts\/receipt\.mjs fingerprints"/);
});

test('parseSession: a fingerprints run after the verdict does not count; no verdict or no TASK line makes no receipt', () => {
  const late = jsonl([
    { type: 'assistant', timestamp: TS, message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: reply() }] } },
    { type: 'assistant', timestamp: TS, message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: RUN } }] } },
    { type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: fpOutput([{ fingerprint: FP, commit: SHA }]) }] } },
  ]);
  assert.throws(() => parseSession(late), /before its verdict/);
  assert.throws(() => parseSession(claudeRecord({ text: 'Looks good to me.' })), /no "VERDICT: approve" or "VERDICT: changes needed" line/);
  assert.throws(() => parseSession(claudeRecord({ text: reply({ task: '' }) })), /no "TASK: <id>" line/);
  // The newest verdict wins: a later round in the same thread replaces the earlier one.
  const again = claudeRecord({ after: [{ type: 'assistant', timestamp: '2026-11-14T11:00:00.000Z', message: { id: 'm3', model: 'claude-opus-5-5', content: [{ type: 'text', text: reply({ verdict: 'changes needed' }) }] } }] });
  assert.equal(parseSession(again).verdict, 'changes needed');
});

// ---------- Real git ----------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const runner = (cwd) => (args, input) => {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const PAPER = (f) => f.startsWith('docs/') || f === 'AGENTS.md';
const GUARDED = (z) => {
  // A tiny stand-in for merge-pr's protectedTestsChanged: modified, deleted, or renamed-away *.test.* files.
  const p = z.split('\0');
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const kind = p[i].charAt(0);
    if (!kind) continue;
    const file = p[++i];
    if (kind === 'R' || kind === 'C') i++;
    if ('MDR'.includes(kind) && file.includes('.test.')) out.push({ file });
  }
  return out;
};
const commitFile = (cwd, file, text, message) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

// A bare "remote" and a clone, with src/app.js, src/other.js, scripts/a.test.mjs and a doc on main.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-'));
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', join(dir, 'remote.git'));
  git(dir, 'clone', '-q', join(dir, 'remote.git'), work);
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
  mkdirSync(join(work, 'src'));
  mkdirSync(join(work, 'scripts'));
  mkdirSync(join(work, 'docs'));
  writeFileSync(join(work, 'src', 'app.js'), 'export const one = 1;\n');
  writeFileSync(join(work, 'src', 'other.js'), 'export const two = 2;\n');
  writeFileSync(join(work, 'scripts', 'a.test.mjs'), '// a test\n');
  writeFileSync(join(work, 'docs', 'notes.md'), '# Notes\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Start');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'switch', '-q', '-c', 'build/084-welcome');
  return { dir, work, run: runner(work), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const need = (r, baseRef = 'main') => neededCommits({ baseRef, tip: 'HEAD', git: r.run, isPaperwork: PAPER, protectedTests: GUARDED });

test('fingerprint: the same after a rebase with no edits; a one-space edit changes it', () => {
  const r = repo();
  try {
    commitFile(r.work, 'src/app.js', 'export const one = 1;\nexport const three = 3;\n', 'Add three');
    const before = need(r).list[0].fingerprint;
    assert.match(before, /^[0-9a-f]{40}$/);
    git(r.work, 'switch', '-q', 'main');
    commitFile(r.work, 'src/other.js', 'export const two = 22;\n', 'Main moves on');
    git(r.work, 'switch', '-q', 'build/084-welcome');
    git(r.work, 'rebase', '-q', 'main');
    const after = need(r).list[0];
    assert.notEqual(after.sha, git(r.work, 'rev-parse', 'main'), 'the rebased commit is a new commit');
    assert.equal(after.fingerprint, before, 'moved without edits: same fingerprint');
    writeFileSync(join(r.work, 'src', 'app.js'), 'export const one = 1;\nexport const three =  3;\n');
    git(r.work, 'commit', '-q', '--amend', '-am', 'Add three');
    assert.notEqual(need(r).list[0].fingerprint, before, 'one extra space: a different fingerprint');
  } finally { r.cleanup(); }
});

test('neededCommits: code commits and hand-resolved merges; docs, receipts, and git\'s own merges are free', () => {
  const r = repo();
  try {
    const code = commitFile(r.work, 'scripts/a.test.mjs', '// a test, edited\n', 'Edit a test');
    commitFile(r.work, 'docs/notes.md', '# Notes\n\nMore.\n', 'Docs only');
    commitFile(r.work, `${RECEIPT_DIR}084-00000000.json`, '{}\n', 'A receipt');
    // git's own merge: main changed a different file.
    git(r.work, 'switch', '-q', 'main');
    commitFile(r.work, 'src/other.js', 'export const two = 22;\n', 'Main moves on');
    git(r.work, 'switch', '-q', 'build/084-welcome');
    git(r.work, 'merge', '-q', '--no-edit', 'main');
    // A hand-resolved merge: both sides changed src/app.js, and the result is typed by hand.
    git(r.work, 'switch', '-q', 'main');
    commitFile(r.work, 'src/app.js', 'export const one = 100;\n', 'Main edits app');
    git(r.work, 'switch', '-q', 'build/084-welcome');
    commitFile(r.work, 'src/app.js', 'export const one = 10;\n', 'Branch edits app');
    spawnSync('git', ['merge', '--no-edit', 'main'], { cwd: r.work });
    writeFileSync(join(r.work, 'src', 'app.js'), 'export const one = 110;\n');
    git(r.work, 'commit', '-q', '-am', 'Merge main, by hand');
    const hand = git(r.work, 'rev-parse', 'HEAD');

    const { list, fail } = need(r, 'main');
    assert.equal(fail, undefined);
    assert.deepEqual(list.map((c) => [c.kind, c.subject]), [['commit', 'Edit a test'], ['commit', 'Branch edits app'], ['merge', 'Merge main, by hand']]);
    assert.equal(list[0].sha, code);
    assert.deepEqual(list[0].protected, ['scripts/a.test.mjs'], 'the protected test this commit touched');
    assert.deepEqual(list[1].protected, []);
    assert.equal(list[2].sha, hand);
    assert.match(list[2].fingerprint, /^[0-9a-f]{40}$/);
    assert.match(formatFingerprints(list), new RegExp(`^kit-fingerprint ${list[0].fingerprint} ${code} commit  Edit a test$`, 'm'));
    assert.match(formatFingerprints(list), /Protected tests to rule on by name[^\n]*\n- scripts\/a\.test\.mjs$/m);
    assert.ok(need(r, 'nope').fail, 'a bad base fails loud');
  } finally { r.cleanup(); }
});

// ---------- The merge gate ----------

const MODELS = { builder: 'claude/claude-opus-5-5', headAgent: ['claude/claude-opus-5-5', 'codex/gpt-6-astra'], reviewer: 'codex/gpt-6.1-sol' };

// A branch with one code commit that touched a protected test, plus a receipt committed for it.
function reviewed({ model = 'gpt-6.1-sol', verdict = 'approve', rulings } = {}) {
  const r = repo();
  commitFile(r.work, 'scripts/a.test.mjs', '// a test, edited\n', 'Edit a test');
  commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
  const list = need(r, 'origin/main').list;
  const session = join(r.dir, 'reviewer.jsonl');
  writeFileSync(session, codexRecord({ model, output: formatFingerprints(list), text: reply({ verdict, rulings }) }));
  const receipt = buildReceipt(readFileSync(session, 'utf8'), session);
  commitFile(r.work, receiptPath(receipt), `${JSON.stringify(receipt, null, 2)}\n`, 'Receipt');
  const check = () => checkReceipts({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models: MODELS, isPaperwork: PAPER, protectedTests: GUARDED });
  return { ...r, session, receipt, list, check };
}

test('checkReceipts: an approving receipt from another model, ruling on each protected test, covers every code commit', () => {
  const r = reviewed();
  try {
    const out = r.check();
    assert.deepEqual(out.uncovered, []);
    assert.equal(out.covered, 2);
    assert.match(receiptPath(r.receipt), /^docs\/receipts\/084-[0-9a-f]{8}\.json$/);
    assert.equal(r.receipt.session, r.session);
  } finally { r.cleanup(); }
});

test('checkReceipts: a receipt from the builder\'s or a head agent\'s model, or "changes needed", covers nothing', () => {
  for (const [opts, note] of [[{ model: 'claude-opus-5-5' }, /builder's or a head agent's model/], [{ model: 'gpt-6-astra' }, /builder's or a head agent's model/], [{ verdict: 'changes needed' }, null]]) {
    const r = reviewed(opts);
    try {
      const out = r.check();
      assert.deepEqual(out.uncovered.map((u) => u.subject), ['Edit a test', 'Change app'], JSON.stringify(opts));
      assert.match(out.uncovered[0].why, /no approving receipt from a model other than the builder's and the head agent's/);
      if (note) assert.match(out.notes.join('\n'), note);
    } finally { r.cleanup(); }
  }
});

test('checkReceipts: a receipt that skips a protected test does not cover the commit that touched it', () => {
  const r = reviewed({ rulings: [] });
  try {
    const out = r.check();
    assert.deepEqual(out.uncovered.map((u) => u.subject), ['Edit a test']);
    assert.match(out.uncovered[0].why, /does not rule on the protected test scripts\/a\.test\.mjs/);
  } finally { r.cleanup(); }
});

test('checkReceipts: a protected test renamed on the branch stays protected under its new name', () => {
  const r = repo();
  try {
    git(r.work, 'mv', 'scripts/a.test.mjs', 'scripts/b.test.mjs');
    git(r.work, 'commit', '-q', '-m', 'Rename a test');
    commitFile(r.work, 'scripts/b.test.mjs', '// a test, weakened\n', 'Weaken the renamed test');
    const list = need(r, 'origin/main').list;
    assert.deepEqual(list.map((c) => [c.subject, c.protected]), [['Rename a test', ['scripts/a.test.mjs']], ['Weaken the renamed test', ['scripts/b.test.mjs']]]);
    const session = join(r.dir, 'reviewer.jsonl');
    writeFileSync(session, codexRecord({ model: 'gpt-6.1-sol', output: formatFingerprints(list), text: reply() }));
    const receipt = buildReceipt(readFileSync(session, 'utf8'), session);
    commitFile(r.work, receiptPath(receipt), `${JSON.stringify(receipt, null, 2)}\n`, 'Receipt');
    const out = checkReceipts({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models: MODELS, isPaperwork: PAPER, protectedTests: GUARDED });
    assert.deepEqual(out.uncovered.map((u) => u.subject), ['Weaken the renamed test'], 'a ruling on the old name does not cover a later edit');
    assert.match(out.uncovered[0].why, /does not rule on the protected test scripts\/b\.test\.mjs/);
  } finally { r.cleanup(); }
});

// A reviewer that approves the commits listed now, with the given rulings; then the gate's answer.
function approveAndCheck(r, rulings) {
  const session = join(r.dir, 'reviewer.jsonl');
  writeFileSync(session, codexRecord({ model: 'gpt-6.1-sol', output: formatFingerprints(need(r, 'origin/main').list), text: reply({ rulings }) }));
  const receipt = buildReceipt(readFileSync(session, 'utf8'), session);
  commitFile(r.work, receiptPath(receipt), `${JSON.stringify(receipt, null, 2)}\n`, 'Receipt');
  return checkReceipts({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models: MODELS, isPaperwork: PAPER, protectedTests: GUARDED });
}

test('checkReceipts: a renamed test stays protected even when the old name comes back and the final difference shows only a new file', () => {
  const r = repo();
  try {
    git(r.work, 'mv', 'scripts/a.test.mjs', 'scripts/b.test.mjs');
    git(r.work, 'commit', '-q', '-m', 'Rename a test');
    writeFileSync(join(r.work, 'scripts', 'a.test.mjs'), '// a test\n');
    commitFile(r.work, 'scripts/b.test.mjs', '// a test, weakened\n', 'Restore the old name, weaken the new');
    assert.equal(git(r.work, 'diff', '--name-status', 'origin/main...HEAD'), 'A\tscripts/b.test.mjs', 'the final difference lists only a new file');
    assert.deepEqual(need(r, 'origin/main').list.map((c) => [c.subject, c.protected]), [['Rename a test', ['scripts/a.test.mjs']], ['Restore the old name, weaken the new', ['scripts/a.test.mjs', 'scripts/b.test.mjs']]], 'a name stays protected after it is renamed away');
    const out = approveAndCheck(r, ['- `scripts/a.test.mjs`: still guards']);
    assert.deepEqual(out.uncovered.map((u) => u.subject), ['Restore the old name, weaken the new']);
  } finally { r.cleanup(); }
});

test('checkReceipts: a merge resolved by renaming a protected test passes protection to the new name', () => {
  const r = repo();
  const body = (n) => `// a test\n${Array.from({ length: 12 }, (_, i) => `check(${i});\n`).join('')}// side ${n}\n`;
  try {
    commitFile(r.work, 'scripts/a.test.mjs', body('start'), 'Grow a test');
    git(r.work, 'push', '-q', 'origin', 'HEAD:main');
    git(r.work, 'fetch', '-q');
    git(r.work, 'switch', '-q', 'main');
    git(r.work, 'reset', '-q', '--hard', 'origin/main');
    commitFile(r.work, 'scripts/a.test.mjs', body('main'), 'Main edits the test');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', 'build/084-welcome');
    commitFile(r.work, 'scripts/a.test.mjs', body('branch'), 'Branch edits the test');
    spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd: r.work });
    git(r.work, 'rm', '-q', '-f', 'scripts/a.test.mjs');
    mkdirSync(join(r.work, 'scripts'), { recursive: true });
    writeFileSync(join(r.work, 'scripts', 'b.test.mjs'), body('both'));
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Merge main, moving the test');
    commitFile(r.work, 'scripts/b.test.mjs', '// a test, weakened\n', 'Weaken the moved test');
    assert.deepEqual(need(r, 'origin/main').list.map((c) => [c.subject, c.protected]), [['Branch edits the test', ['scripts/a.test.mjs']], ['Merge main, moving the test', ['scripts/a.test.mjs']], ['Weaken the moved test', ['scripts/b.test.mjs']]]);
    const out = approveAndCheck(r, ['- `scripts/a.test.mjs`: still guards']);
    assert.deepEqual(out.uncovered.map((u) => u.subject), ['Weaken the moved test'], 'a ruling on the old name does not cover a later edit of the new one');
  } finally { r.cleanup(); }
});

test('neededCommits: a merge that deletes a protected test and adds a test file by hand passes protection on, even when git sees no rename', () => {
  const r = repo();
  // Both sides rewrite every line, so the file left by the merge looks like neither: git reports a delete and a new file.
  const body = (word) => `// a test\n${Array.from({ length: 12 }, (_, i) => `${word}(${i});\n`).join('')}`;
  try {
    commitFile(r.work, 'scripts/a.test.mjs', body('start'), 'Grow a test');
    git(r.work, 'push', '-q', 'origin', 'HEAD:main');
    git(r.work, 'fetch', '-q');
    git(r.work, 'switch', '-q', 'main');
    git(r.work, 'reset', '-q', '--hard', 'origin/main');
    commitFile(r.work, 'scripts/a.test.mjs', body('main'), 'Main rewrites the test');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', 'build/084-welcome');
    commitFile(r.work, 'scripts/a.test.mjs', body('branch'), 'Branch rewrites the test');
    spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd: r.work });
    git(r.work, 'rm', '-q', '-f', 'scripts/a.test.mjs');
    mkdirSync(join(r.work, 'scripts'), { recursive: true });
    writeFileSync(join(r.work, 'scripts', 'b.test.mjs'), body('both'));
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Merge main, moving the test');
    assert.match(git(r.work, 'show', '--remerge-diff', '--format=', '--name-status', '-M', 'HEAD'), /^D\tscripts\/a\.test\.mjs\nA\tscripts\/b\.test\.mjs$/, 'git sees a delete and a new file, not a rename');
    commitFile(r.work, 'scripts/b.test.mjs', '// a test, weakened\n', 'Weaken the moved test');
    assert.deepEqual(need(r, 'origin/main').list.map((c) => [c.subject, c.protected]), [['Branch rewrites the test', ['scripts/a.test.mjs']], ['Merge main, moving the test', ['scripts/a.test.mjs']], ['Weaken the moved test', ['scripts/b.test.mjs']]]);
    const out = approveAndCheck(r, ['- `scripts/a.test.mjs`: still guards']);
    assert.deepEqual(out.uncovered.map((u) => u.subject), ['Weaken the moved test'], 'the later edit of the new file needs its own ruling');
  } finally { r.cleanup(); }
});

test('neededCommits: a test file the branch added needs no ruling for its own early edits when the base branch later adds the same file', () => {
  const r = repo();
  try {
    commitFile(r.work, 'scripts/new.test.mjs', '// new\n', 'Add a new test');
    commitFile(r.work, 'scripts/new.test.mjs', '// new\n// more\n', 'Grow the new test');
    git(r.work, 'switch', '-q', 'main');
    commitFile(r.work, 'scripts/new.test.mjs', '// new\n// more\n', 'Main adds the same test');
    git(r.work, 'switch', '-q', 'build/084-welcome');
    git(r.work, 'merge', '-q', '--no-edit', 'main');
    commitFile(r.work, 'scripts/new.test.mjs', '// weakened\n', 'Edit it after main has it');
    assert.deepEqual(need(r, 'main').list.map((c) => [c.subject, c.protected]), [
      ['Add a new test', []],
      ['Grow the new test', []],
      ['Edit it after main has it', ['scripts/new.test.mjs']],
    ], 'only the edit made after the base branch had the file touches a protected test');
  } finally { r.cleanup(); }
});

test('checkReceipts: a receipt that no longer matches its session record, or a commit made after the review, is not covered', () => {
  const r = reviewed();
  try {
    commitFile(r.work, 'src/app.js', 'export const one = 12;\n', 'Fix after review');
    assert.deepEqual(r.check().uncovered.map((u) => u.subject), ['Fix after review'], 'the reviewed commits stay covered');
    appendFileSync(r.session, jsonl([{ type: 'response_item', timestamp: TS, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply({ verdict: 'changes needed' }) }] } }]));
    const out = r.check();
    assert.equal(out.uncovered.length, 3);
    assert.match(out.notes.join('\n'), /does not match its session record/);
    rmSync(r.session);
    assert.match(r.check().notes.join('\n'), /cannot be read again/);
  } finally { r.cleanup(); }
});

test('checkReceipts: with no builder or head agent model set, it fails loud', () => {
  const r = reviewed();
  try {
    for (const models of [{ headAgent: [], builder: '', reviewer: '' }, { ...MODELS, builder: '' }, { ...MODELS, headAgent: [] }]) {
      const out = checkReceipts({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models, isPaperwork: PAPER, protectedTests: GUARDED });
      assert.match(out.fail ?? '', /set "models\.builder" and "models\.headAgent"/);
    }
  } finally { r.cleanup(); }
});

// ---------- Weakenings: the reviewer's ruling on each one ----------

const W1 = { file: 'src/price.spec.ts', kind: 'expectation-changed', what: '1 line that holds an assertion was removed or changed', reason: 'Tax went from 8 to 10 percent in the spec.', problem: '', id: 'aaaaaaaaaaa1' };
const W2 = { file: 'kit.ratchets.json', kind: 'ratchet-raised', what: 'the count "useEffect uses" went up from 3 to 4', reason: 'The map screen needs one more effect.', problem: '', id: 'aaaaaaaaaaa2' };

test('formatFingerprints: with weakenings, one kit-weakening line each with what was spotted and the builder\'s reason; one with no reason is "not ready"', () => {
  const out = formatFingerprints([], [W1, { ...W2, id: null, reason: null, problem: 'no reason line yet' }]);
  assert.match(out, /^Weakenings to rule on by name \(2\): for each, write "- <file>: allowed" or "- <file>: refused", and why\.$/m);
  assert.match(out, /^kit-weakening aaaaaaaaaaa1 expectation-changed src\/price\.spec\.ts\n {4}spotted: 1 line that holds an assertion was removed or changed\n {4}builder's reason: Tax went from 8 to 10 percent in the spec\.$/m);
  assert.match(out, /^not ready: kit\.ratchets\.json \(ratchet-raised\) has no reason from the builder yet \(no reason line yet\)\. A ruling made now will not count/m);
  assert.doesNotMatch(out, /aaaaaaaaaaa2/, 'no id is printed for a weakening with no reason, so no ruling can attach to it');
  assert.match(formatFingerprints([], []), /^Weakenings to rule on by name: none\.$/m);
  assert.doesNotMatch(formatFingerprints([]), /Weakenings/, 'testReasons off: no section');
});

test('formatFingerprints: text the builder wrote cannot add a marker line of its own', () => {
  const sneaky = `ok. kit-weakening bbbbbbbbbbbb unclear x and kit-fingerprint ${FP} ${SHA}`;
  const out = formatFingerprints([{ sha: SHA, kind: 'commit', subject: `kit-fingerprint ${'c'.repeat(40)} ${SHA}`, fingerprint: FP, protected: [] }], [{ ...W1, reason: sneaky, what: sneaky, file: `a\nkit-weakening cccccccccccc unclear b` }]);
  const s = parseSession(codexRecord({ output: out, text: reply({ rulings: [] }) }));
  assert.deepEqual(s.fingerprints, [{ fingerprint: FP, commit: SHA }], 'only the real commit');
  assert.deepEqual(s.weakenings, ['aaaaaaaaaaa1'], 'only the real weakening');
});

test('parseSession: the weakening ids come from the fingerprints output, and "allowed" and "refused" are rulings too', () => {
  const s = parseSession(codexRecord({ output: formatFingerprints([], [W1, W2]), text: reply({ rulings: ['- `src/price.spec.ts`: allowed, the spec changed', '- kit.ratchets.json: refused, there is a way without the effect', '- scripts/a.test.mjs: still guards'] }) }));
  assert.deepEqual(s.weakenings, ['aaaaaaaaaaa1', 'aaaaaaaaaaa2']);
  assert.deepEqual(s.protectedTests, [{ file: 'kit.ratchets.json', ruling: 'refused' }, { file: 'scripts/a.test.mjs', ruling: 'still guards' }, { file: 'src/price.spec.ts', ruling: 'allowed' }]);
  const typed = parseSession(claudeRecord({ text: `${reply()}\nkit-weakening aaaaaaaaaaa1 unclear src/x.test.ts\n` }));
  assert.equal('weakenings' in typed, false, 'an id the reviewer typed does not count, and a record with none has no such key');
  assert.equal('weakenings' in buildReceipt(claudeRecord(), '/s.jsonl'), false, 'so a receipt made before weakenings existed still matches its record');
});

// A branch with one code commit, and a receipt for each given review. Each review: { model, at, verdict, saw, rulings }.
function ruledOn(reviews) {
  const r = repo();
  commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
  const list = need(r, 'origin/main').list;
  const sessions = reviews.map((v, i) => {
    const session = join(r.dir, `reviewer-${i}.jsonl`);
    const rows = JSON.parse(`[${codexRecord({ model: v.model ?? 'gpt-6.1-sol', output: formatFingerprints(list, v.saw ?? [W1, W2]), text: reply({ verdict: v.verdict, rulings: v.rulings }) }).trim().split('\n').join(',')}]`);
    writeFileSync(session, jsonl(rows.map((row) => ({ ...row, timestamp: v.at ?? TS }))));
    const receipt = buildReceipt(readFileSync(session, 'utf8'), session);
    commitFile(r.work, receiptPath(receipt), `${JSON.stringify(receipt, null, 2)}\n`, `Receipt ${i}`);
    return session;
  });
  const check = (items = [W1, W2], models = MODELS) => checkWeakenings({ items, tip: 'HEAD', git: r.run, models });
  return { ...r, sessions, check };
}
const ALLOW_BOTH = ['- src/price.spec.ts: allowed', '- kit.ratchets.json: allowed, no other way'];

test('checkWeakenings: a reviewer on another model that saw the weakening and ruled on it by name decides it', () => {
  const r = ruledOn([{ rulings: ['- src/price.spec.ts: allowed', '- `kit.ratchets.json`: refused, use a ref instead'] }]);
  try {
    const out = r.check();
    assert.deepEqual(out.rulings, [{ ruling: 'allowed', ruledBy: 'gpt-6.1-sol', why: '' }, { ruling: 'refused', ruledBy: 'gpt-6.1-sol', why: '' }]);
    assert.deepEqual(out.notes, []);
  } finally { r.cleanup(); }
});

test('checkWeakenings: the old words count the same: "still guards" allows, "weakened" refuses', () => {
  const r = ruledOn([{ rulings: ['- src/price.spec.ts: still guards', '- kit.ratchets.json: weakened'] }]);
  try {
    assert.deepEqual(r.check().rulings.map((x) => x.ruling), ['allowed', 'refused']);
  } finally { r.cleanup(); }
});

test('checkWeakenings: a ruling by the builder\'s or a head agent\'s model never counts', () => {
  for (const model of ['claude-opus-5-5', 'gpt-6-astra']) {
    const r = ruledOn([{ model, rulings: ALLOW_BOTH }]);
    try {
      const [first] = r.check().rulings;
      assert.equal(first.ruling, null, model);
      assert.equal(first.ruledBy, null);
      assert.match(first.why, new RegExp(`the only ruling is by ${model}, the model that built the change or a head agent's; a different model must rule`));
    } finally { r.cleanup(); }
  }
});

test('checkWeakenings: a ruling must name the file, and must be about this exact change and reason', () => {
  const r = ruledOn([{ rulings: ['- src/price.spec.ts: allowed'] }]);
  try {
    const out = r.check();
    assert.equal(out.rulings[0].ruling, 'allowed');
    assert.deepEqual(out.rulings[1], { ruling: null, ruledBy: null, why: 'a reviewer was shown this change but did not rule on it by name' });
    const edited = r.check([{ ...W1, id: 'bbbbbbbbbbb1' }, W2]);
    assert.deepEqual(edited.rulings[0], { ruling: null, ruledBy: null, why: 'no reviewer has ruled on this exact change and reason' }, 'a new reason or a further edit gives a new id, and the old ruling is not about it');
  } finally { r.cleanup(); }
});

test('checkWeakenings: the newest ruling wins, and a ruling in a "changes needed" review counts too', () => {
  const first = { at: '2026-11-14T10:00:00.000Z', verdict: 'changes needed', rulings: ['- src/price.spec.ts: refused, the spec still says 8', '- kit.ratchets.json: allowed'] };
  const second = { at: '2026-11-14T12:00:00.000Z', model: 'gpt-7-nova', saw: [W1], rulings: ['- src/price.spec.ts: allowed, the builder showed the new spec line'] };
  const r = ruledOn([first, second]);
  try {
    assert.deepEqual(r.check().rulings, [{ ruling: 'allowed', ruledBy: 'gpt-7-nova', why: '' }, { ruling: 'allowed', ruledBy: 'gpt-6.1-sol', why: '' }]);
  } finally { r.cleanup(); }
  const back = ruledOn([{ ...second, at: '2026-11-14T09:00:00.000Z' }, first]);
  try {
    assert.deepEqual(back.check().rulings[0], { ruling: 'refused', ruledBy: 'gpt-6.1-sol', why: '' }, 'a later refusal overrules an earlier "allowed"');
  } finally { back.cleanup(); }
});

test('checkWeakenings: a receipt that no longer matches its record does not count; with no models set it fails loud', () => {
  const r = ruledOn([{ rulings: ALLOW_BOTH }]);
  try {
    assert.match(r.check([W1, W2], { headAgent: [], builder: '', reviewer: '' }).fail, /set "models\.builder" and "models\.headAgent"/);
    appendFileSync(r.sessions[0], jsonl([{ type: 'response_item', timestamp: TS, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply({ rulings: ['- src/price.spec.ts: refused'] }) }] } }]));
    const out = r.check();
    assert.deepEqual(out.rulings.map((x) => x.ruling), [null, null]);
    assert.match(out.notes.join('\n'), /does not match its session record/);
  } finally { r.cleanup(); }
});

// ---------- The command line ----------

const cli = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

test('command line, testReasons on: fingerprints lists the weakening with its id, and a receipt made from that review allows it at the gate', () => {
  const r = repo();
  try {
    cpSync(join(dirname(SCRIPT), 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    git(r.work, 'switch', '-q', 'main');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ features: { testReasons: true }, presets: ['typescript'] }));
    commitFile(r.work, 'src/price.spec.ts', "test('adds tax', () => {\n  expect(price(100)).toEqual(108);\n});\n", 'Settings and a test');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'build/085-tax');
    commitFile(r.work, 'src/price.spec.ts', "test('adds tax', () => {\n  expect(price(100)).toEqual(110);\n});\n", 'Change the tax');
    const early = cli(r.work, 'fingerprints');
    assert.equal(early.status, 0, early.stderr);
    assert.match(early.stdout, /^not ready: src\/price\.spec\.ts \(expectation-changed\) has no reason from the builder yet/m);
    commitFile(r.work, 'docs/weakenings/build-085-tax.md', '- src/price.spec.ts: Tax went from 8 to 10 percent in the spec.\n', 'Reason');
    const shown = cli(r.work, 'fingerprints');
    assert.equal(shown.status, 0, shown.stderr);
    const line = shown.stdout.match(/^kit-weakening ([0-9a-f]{12}) expectation-changed src\/price\.spec\.ts\n {4}spotted: [^\n]+\n {4}builder's reason: Tax went from 8 to 10 percent in the spec\.$/m);
    assert.ok(line, shown.stdout);
    const session = join(r.dir, 'reviewer.jsonl');
    writeFileSync(session, codexRecord({ output: shown.stdout, text: reply({ rulings: ['- src/price.spec.ts: allowed, the spec says 10 now'] }) }));
    assert.equal(cli(r.work, 'make', session).status, 0);
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Receipt');
    const item = { file: 'src/price.spec.ts', id: line[1] };
    assert.deepEqual(checkWeakenings({ items: [item], git: r.run, models: MODELS }).rulings, [{ ruling: 'allowed', ruledBy: 'gpt-6.1-sol', why: '' }]);
  } finally { r.cleanup(); }
});

test('command line: fingerprints prints one line per commit; make writes the receipt once, from the record alone', () => {
  const r = repo();
  try {
    const sha = commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
    const shown = cli(r.work, 'fingerprints');
    assert.equal(shown.status, 0, shown.stderr);
    const line = shown.stdout.match(/^kit-fingerprint ([0-9a-f]{40}) ([0-9a-f]{40}) commit {2}Change app$/m);
    assert.ok(line, shown.stdout);
    assert.equal(line[2], sha);
    assert.match(shown.stdout, /Protected tests to rule on by name: none/);

    const session = join(r.dir, 'reviewer.jsonl');
    writeFileSync(session, claudeRecord({ fps: [{ fingerprint: line[1], commit: sha }], model: 'gpt-6.1-sol', text: reply({ rulings: [] }) }));
    const made = cli(r.work, 'make', session);
    assert.equal(made.status, 0, made.stderr);
    const files = readdirSync(join(r.work, RECEIPT_DIR));
    assert.equal(files.length, 1);
    const saved = JSON.parse(readFileSync(join(r.work, RECEIPT_DIR, files[0]), 'utf8'));
    assert.equal(saved.model, 'gpt-6.1-sol');
    assert.deepEqual(saved.fingerprints, [{ fingerprint: line[1], commit: sha }]);
    assert.match(made.stdout, /approve by gpt-6\.1-sol \(claude\), task 084, 1 commit/);
    assert.equal(cli(r.work, 'make', session).status, 0);
    assert.equal(readdirSync(join(r.work, RECEIPT_DIR)).length, 1, 'making it twice gives the same file');

    writeFileSync(session, claudeRecord({ text: 'No verdict here.' }));
    const bad = cli(r.work, 'make', session);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /No receipt: .*no "VERDICT: approve"/);
    assert.equal(cli(r.work, 'make').status, 2, 'no session file: wrong usage');
  } finally { r.cleanup(); }
});

test('command line: a branch that turns testReasons off in its own settings still gets that edit listed as a weakening', () => {
  const r = repo();
  try {
    cpSync(join(dirname(SCRIPT), 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    git(r.work, 'switch', '-q', 'main');
    commitFile(r.work, 'scripts/kit.config.json', JSON.stringify({ features: { testReasons: true } }), 'Test protection on');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/settings');
    commitFile(r.work, 'scripts/kit.config.json', JSON.stringify({ features: { testReasons: false } }), 'Test protection off');
    const shown = cli(r.work, 'fingerprints');
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^Weakenings to rule on by name \(1\)/m);
    assert.match(shown.stdout, /^not ready: scripts\/kit\.config\.json \(check-removed\) has no reason from the builder yet/m);
  } finally { r.cleanup(); }
});

// ---------- Review round 2: ways around the receipt gate that a reviewer found ----------

test('#5 checkWeakenings and checkReceipts: with two versions of the models, a builder or head agent in either cannot rule, and one empty version is not an error', () => {
  const swapped = { builder: 'codex/gpt-6.1-sol', headAgent: ['codex/gpt-6.1-sol'], reviewer: 'claude/claude-opus-5-5' };
  const unset = { builder: '', headAgent: [], reviewer: '' };
  // The branch renames the builder, then has the old builder's model rule on its own work.
  const old = ruledOn([{ model: 'claude-opus-5-5', rulings: ALLOW_BOTH }]);
  try {
    assert.equal(old.check([W1, W2], swapped).rulings[0].ruling, 'allowed', 'with the branch\'s models alone, the old builder passes');
    const out = old.check([W1, W2], [swapped, MODELS]);
    assert.equal(out.rulings[0].ruling, null);
    assert.match(out.rulings[0].why, /the only ruling is by claude-opus-5-5/);
  } finally { old.cleanup(); }
  // The branch deletes the settings file: its own models are empty, the base branch's still decide.
  const gone = ruledOn([{ rulings: ALLOW_BOTH }]);
  try {
    const out = gone.check([W1, W2], [unset, MODELS]);
    assert.equal(out.fail, undefined);
    assert.deepEqual(out.rulings.map((x) => [x.ruling, x.ruledBy]), [['allowed', 'gpt-6.1-sol'], ['allowed', 'gpt-6.1-sol']]);
    assert.match(gone.check([W1, W2], [unset, unset]).fail, /set "models\.builder" and "models\.headAgent"/);
  } finally { gone.cleanup(); }
  const r = reviewed({ model: 'claude-opus-5-5' });
  try {
    const gate = (models) => checkReceipts({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models, isPaperwork: PAPER, protectedTests: GUARDED });
    assert.deepEqual(gate(swapped).uncovered, [], 'with the branch\'s models alone, the old builder\'s receipt covers');
    assert.equal(gate([swapped, MODELS]).uncovered.length, 2);
  } finally { r.cleanup(); }
});

test('#9 command line: fingerprints for a named branch uses that branch\'s settings and the base branch\'s, whatever folder it runs in', () => {
  const r = repo();
  try {
    cpSync(join(dirname(SCRIPT), 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    git(r.work, 'switch', '-q', 'main');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ features: { testReasons: true } }));
    commitFile(r.work, 'specimens/sample.txt', 'one\ntwo\n', 'Test protection on, and a folder that is not a test path yet');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/specimens');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ features: { testReasons: true }, testPaths: ['.test.', 'specimens/'] }));
    commitFile(r.work, 'specimens/sample.txt', 'one\nthree\n', 'Make the folder a test path and edit a file in it');
    const onBranch = cli(r.work, 'fingerprints');
    assert.match(onBranch.stdout, /^not ready: specimens\/sample\.txt \(unclear\)/m, onBranch.stdout + onBranch.stderr);
    git(r.work, 'switch', '-q', 'main');
    const fromMain = cli(r.work, 'fingerprints', 'lead/specimens');
    assert.equal(fromMain.status, 0, fromMain.stderr);
    assert.match(fromMain.stdout, /^not ready: specimens\/sample\.txt \(unclear\)/m, 'the same list from main\'s folder');
    assert.match(fromMain.stdout, /^Protected tests to rule on by name \(1\):\n- specimens\/sample\.txt$/m, 'and the same protected tests');
  } finally { r.cleanup(); }
});

// ---------- Review round 4 ----------

test('K command line: every weakening id comes through a pipe, however long the list and however slow the reader', () => {
  const r = repo();
  const many = 200;
  const name = (i) => `src/case${String(i).padStart(3, '0')}.test.js`;
  const body = (want) => `test('adds', () => {\n  expect(add(1, 1)).toBe(${want});\n});\n`;
  try {
    cpSync(join(dirname(SCRIPT), 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    git(r.work, 'switch', '-q', 'main');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ features: { testReasons: true }, presets: ['typescript'] }));
    for (let i = 0; i < many; i++) writeFileSync(join(r.work, name(i)), body(2));
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Many tests');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/many');
    for (let i = 0; i < many; i++) writeFileSync(join(r.work, name(i)), body(3));
    mkdirSync(join(r.work, 'docs', 'weakenings'), { recursive: true });
    writeFileSync(join(r.work, 'docs', 'weakenings', 'lead-many.md'), Array.from({ length: many }, (_, i) => `- ${name(i)}: Sum number ${i} is three now, as the new rule for adding in the plan says. This sentence is long on purpose, so that two hundred of them are far more than one pipe holds at a time, and the script has to keep writing after its work is done.\n`).join(''));
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Change every one, with reasons');
    // A slow reader: it takes the first piece, waits, and only then reads on. The pipe fills up
    // meanwhile, so the script still has output to write when its work is done.
    const reader = join(r.dir, 'slow-reader.cjs');
    writeFileSync(reader, `let text = '';
process.stdin.once('data', (first) => {
  text += first;
  process.stdin.pause();
  setTimeout(() => process.stdin.on('data', (d) => { text += d; }).on('end', () => console.log((text.match(/^kit-weakening /gm) || []).length)).resume(), 700);
});
`);
    const piped = spawnSync('sh', ['-c', `"${process.execPath}" "${SCRIPT}" fingerprints | "${process.execPath}" "${reader}"`], { cwd: r.work, encoding: 'utf8' });
    assert.equal(Number(piped.stdout.trim()), many, piped.stderr);
  } finally { r.cleanup(); }
});

// ---------- Review round 5: the last pass ----------

test('3 command line: fingerprints does not guess a formatting check for a branch that is not checked out; it says to run it from that branch', () => {
  const r = repo();
  try {
    cpSync(join(dirname(SCRIPT), 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    git(r.work, 'switch', '-q', 'main');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ features: { testReasons: true }, presets: ['typescript'] }));
    commitFile(r.work, 'src/price.spec.ts', "test('adds tax', () => {\n      expect(price(100)).toEqual(108)\n})\n", 'Settings and a test laid out oddly');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/format');
    commitFile(r.work, 'src/price.spec.ts', "test('adds tax', () => {\n  expect(price(100)).toEqual(108);\n});\n", 'Lay it out the usual way');
    git(r.work, 'switch', '-q', 'main');
    const away = cli(r.work, 'fingerprints', 'lead/format');
    assert.equal(away.status, 1, away.stdout + away.stderr);
    assert.match(away.stderr, /The weakenings cannot be listed: cannot tell whether 1 test file changed in formatting only: the formatter reads its settings from the files in this folder, and lead\/format is not what is checked out here\. Run this again from a checkout of that branch\./);
    assert.doesNotMatch(away.stdout, /kit-weakening|not ready/, 'no list is printed that the merge might not agree with');
    git(r.work, 'switch', '-q', 'lead/format');
    const here = cli(r.work, 'fingerprints', 'lead/format');
    assert.equal(here.status, 0, here.stderr);
    assert.match(here.stdout, /^(not ready: src\/price\.spec\.ts|Weakenings to rule on by name: none\.)/m, 'from the branch itself the formatter is asked (here it cannot run, so the file is listed)');
  } finally { r.cleanup(); }
});

test('kit update, command line: fingerprints still works when the base branch\'s preset is in an older form, and says which copy it used', () => {
  const r = repo();
  const preset = (name, change = (p) => p) => JSON.stringify(change(JSON.parse(readFileSync(join(dirname(SCRIPT), 'presets', `${name}.json`), 'utf8'))));
  try {
    git(r.work, 'switch', '-q', 'main');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ features: { testReasons: true }, presets: ['typescript'] }));
    commitFile(r.work, 'scripts/presets/any.json', preset('any'), 'The always-on preset');
    commitFile(r.work, 'scripts/presets/typescript.json', preset('typescript', (p) => ({ ...p, retiredField: true })), 'A preset from an older kit');
    commitFile(r.work, 'src/price.spec.ts', "test('adds tax', () => {\n      expect(price(100)).toEqual(108)\n})\n", 'A test laid out oddly');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/kit-update');
    commitFile(r.work, 'scripts/presets/typescript.json', preset('typescript', (p) => ({ ...p, formatStdin: 'cat' })), 'The kit update');
    commitFile(r.work, 'src/price.spec.ts', "test('adds tax', () => {\n  expect(price(100)).toEqual(108);\n});\n", 'Lay the test out the usual way');
    const shown = cli(r.work, 'fingerprints');
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stderr, /^Note: the base branch's preset typescript is in an older form; using this branch's\.$/m);
    assert.doesNotMatch(shown.stdout, /older form/, 'the note stays off the output the receipt is read from');
    assert.match(shown.stdout, /^not ready: src\/price\.spec\.ts \(expectation-changed\)/m, 'sorted with this branch\'s patterns; "cat" does not format, so the file is listed');
  } finally { r.cleanup(); }
});

// ---------- Kit 5.1: the newer lines of the reply, and the reviews that count ----------

// The reply shape at the end of process/reviewer.md.
const fullReply = ({ verdict = 'approve', count = 'COUNT: 2 important, 1 nit, 0 pre-existing', level = 'LEVEL: deep', security = 'SECURITY: clear', checklist = ['- CL-12: does not apply, the change adds no column', '- CL-3: ok', '- CL-5: finding 2'], rulings = ['- `scripts/a.test.mjs`: allowed'] } = {}) =>
  `VERDICT: ${verdict}\n${[count, level, security].filter(Boolean).join('\n')}\nREVIEWED: abc1234\nTASK: 084\n\nFINDINGS\n1. [Important] src/app.js:1, wrong number\n   It is off by ten. Use eleven.\n\nRULINGS\n${rulings.join('\n') || '- none'}\n\nCHECKLIST\n${checklist.join('\n') || '- none'}\n\nQUESTIONS FOR THE LEAD\n- none\n`;
const OLD_KEYS = ['task', 'verdict', 'model', 'tool', 'at', 'session', 'fingerprints', 'protectedTests'];

test('parseSession: COUNT, LEVEL, SECURITY, and the CHECKLIST answers of the verdict reply go into the receipt, in fixed shapes', () => {
  for (const record of [claudeRecord({ text: fullReply() }), codexRecord({ text: fullReply() })]) {
    const s = parseSession(record);
    assert.deepEqual(s.counts, { important: 2, nit: 1, preExisting: 0 });
    assert.equal(s.level, 'deep');
    assert.equal(s.security, 'clear');
    assert.deepEqual(s.checklist, [{ id: 'CL-3', answer: 'ok' }, { id: 'CL-5', answer: 'finding' }, { id: 'CL-12', answer: 'does not apply' }], 'by id, in number order');
    assert.deepEqual(s.protectedTests, [{ file: 'scripts/a.test.mjs', ruling: 'allowed' }], 'a checklist answer is not a ruling on a file');
  }
  const receipt = buildReceipt(codexRecord({ text: fullReply() }), '/tmp/reviewer.jsonl');
  assert.deepEqual(Object.keys(receipt), [...OLD_KEYS, 'counts', 'level', 'security', 'checklist'], 'the new fields come last, in a fixed order');
  assert.deepEqual(OPTIONAL_FIELDS, ['weakenings', 'counts', 'level', 'security', 'checklist']);
});

test('parseSession: the level may be copied with the words after it, and a reply with none of the newer lines gets none of the newer fields', () => {
  const read = (over) => parseSession(codexRecord({ text: fullReply(over) }));
  assert.equal(read({ level: 'LEVEL: deep the change touches the high-risk path src/auth/ (src/auth/login.ts)' }).level, 'deep');
  assert.equal(read({ level: 'LEVEL: kit-level standard src/app.ts is not under a quick review path' }).level, 'standard');
  assert.equal(read({ level: 'level: Quick' }).level, 'quick');
  assert.equal('level' in read({ level: '' }), false, 'no LEVEL line, no level field: the gate counts that as standard');
  assert.equal(read({ security: 'SECURITY: open' }).security, 'open');
  assert.equal('security' in read({ security: '' }), false);
  assert.deepEqual(read({ count: 'COUNT: 0 important, 3 nits, 12 pre-existing' }).counts, { important: 0, nit: 3, preExisting: 12 });
  assert.equal('counts' in read({ count: '' }), false);
  assert.deepEqual(read({ checklist: ['- CL-3: finding 1', '- `CL-3`: OK, I ran the old save file'] }).checklist, [{ id: 'CL-3', answer: 'ok' }], 'the last line for an id wins');
  assert.equal('checklist' in read({ checklist: [] }), false, 'no answers, no field');
});

test('old receipts: a reply without the newer lines makes exactly the older receipt, and a receipt written before they existed still covers its commits', () => {
  assert.deepEqual(Object.keys(buildReceipt(codexRecord(), '/tmp/reviewer.jsonl')), OLD_KEYS);
  const r = repo();
  try {
    commitFile(r.work, 'scripts/a.test.mjs', '// a test, edited\n', 'Edit a test');
    commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
    const list = need(r, 'origin/main').list;
    const session = join(r.dir, 'reviewer.jsonl');
    writeFileSync(session, codexRecord({ output: formatFingerprints(list) }));
    // Written out by hand, key by key, the way the script wrote it before kit 5.1.
    const old = { task: '084', verdict: 'approve', model: 'gpt-6.1-sol', tool: 'codex', at: TS, session, fingerprints: list.map((c) => ({ fingerprint: c.fingerprint, commit: c.sha })), protectedTests: [{ file: 'scripts/a.test.mjs', ruling: 'still guards' }] };
    commitFile(r.work, `${RECEIPT_DIR}084-0ld0ld00.json`, `${JSON.stringify(old, null, 2)}\n`, 'Receipt');
    const out = checkReceipts({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models: MODELS, isPaperwork: PAPER, protectedTests: GUARDED });
    assert.deepEqual([out.uncovered, out.covered, out.notes], [[], 2, []]);
  } finally { r.cleanup(); }
});

// A branch with one code commit and a receipt made from a reply in the newer shape.
function reviewedFully(over = {}, model = 'gpt-6.1-sol') {
  const r = repo();
  commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
  const list = need(r, 'origin/main').list;
  const session = join(r.dir, 'reviewer.jsonl');
  writeFileSync(session, codexRecord({ model, output: formatFingerprints(list), text: fullReply({ rulings: [], ...over }) }));
  const receipt = buildReceipt(readFileSync(session, 'utf8'), session);
  const path = receiptPath(receipt);
  commitFile(r.work, path, `${JSON.stringify(receipt, null, 2)}\n`, 'Receipt');
  const counted = () => approvals({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models: MODELS, isPaperwork: PAPER, protectedTests: GUARDED });
  return { ...r, session, receipt, path, list, counted };
}

test('approvals: the commits that need a review, and the receipts that count, each with what the reviewer wrote', () => {
  const r = reviewedFully();
  try {
    const out = r.counted();
    assert.deepEqual(out.needed.map((c) => c.subject), ['Change app']);
    assert.deepEqual(out.usable, [r.receipt]);
    assert.deepEqual([out.usable[0].level, out.usable[0].security, out.usable[0].counts, out.usable[0].checklist.length], ['deep', 'clear', { important: 2, nit: 1, preExisting: 0 }, 3]);
    assert.deepEqual(out.notes, []);
    assert.deepEqual(checkReceipts({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models: MODELS, isPaperwork: PAPER, protectedTests: GUARDED }).uncovered, [], 'the receipts gate reads the same list');
  } finally { r.cleanup(); }
});

test('approvals: a "changes needed" round, the builder\'s own model, and a receipt edited by hand to say more than its record never count', () => {
  const round = reviewedFully({ verdict: 'changes needed' });
  try {
    assert.deepEqual(round.counted().usable, []);
  } finally { round.cleanup(); }
  const own = reviewedFully({}, 'claude-opus-5-5');
  try {
    const out = own.counted();
    assert.deepEqual(out.usable, []);
    assert.match(out.notes.join('\n'), /written by claude-opus-5-5, the builder's or a head agent's model; not counted/);
  } finally { own.cleanup(); }
  for (const edit of [{ level: 'deep' }, { security: 'clear' }, { checklist: [{ id: 'CL-3', answer: 'ok' }] }, { counts: { important: 0, nit: 0, preExisting: 0 } }]) {
    const r = reviewedFully({ count: 'COUNT: 1 important, 0 nit, 0 pre-existing', level: 'LEVEL: standard', security: '', checklist: [] });
    try {
      writeFileSync(join(r.work, r.path), `${JSON.stringify({ ...r.receipt, ...edit }, null, 2)}\n`);
      git(r.work, 'commit', '-q', '-am', 'Edit the receipt by hand');
      const out = r.counted();
      assert.deepEqual(out.usable, [], JSON.stringify(edit));
      assert.match(out.notes.join('\n'), /does not match its session record; not counted/);
    } finally { r.cleanup(); }
  }
  const unset = reviewedFully();
  try {
    assert.match(approvals({ baseRef: 'origin/main', tip: 'HEAD', git: unset.run, models: { headAgent: [], builder: '' }, isPaperwork: PAPER, protectedTests: GUARDED }).fail, /set "models\.builder" and "models\.headAgent"/);
  } finally { unset.cleanup(); }
});

test('formatFingerprints: one kit-checklist line per row that fits and one kit-level line, each with what to write back; nothing new without them', () => {
  const list = [{ sha: SHA, kind: 'commit', subject: 'Change app', fingerprint: FP, protected: [] }];
  const plain = formatFingerprints(list);
  assert.doesNotMatch(plain, /kit-checklist|kit-level|Review level|checklist/i);
  const out = formatFingerprints(list, undefined, { checklist: [{ id: 'CL-3', check: 'Data saved by the old version still loads' }, { id: 'CL-5', check: 'The new key is in .env.example' }], level: { level: 'deep', why: 'the change touches the high-risk path src/auth/ (src/auth/login.ts)' } });
  assert.ok(out.startsWith(`${plain}\n`), 'the older lines come first, unchanged');
  assert.ok(out.endsWith([
    'Change checklist rows to answer (2): under CHECKLIST in your reply, write "- <id>: ok", "- <id>: does not apply, <why>", or "- <id>: finding <n>" for each.',
    'kit-checklist CL-3 Data saved by the old version still loads',
    'kit-checklist CL-5 The new key is in .env.example',
    'Review level: copy the level into your reply as "LEVEL: deep". A deep review ends with "SECURITY: clear" or "SECURITY: open".',
    'kit-level deep the change touches the high-risk path src/auth/ (src/auth/login.ts)',
  ].join('\n')), out);
  const quiet = formatFingerprints(list, undefined, { checklist: [], level: { level: 'standard', why: 'src/app.ts is not under a quick review path' } });
  assert.match(quiet, /^Change checklist rows to answer: none\.$/m);
  assert.match(quiet, /^Review level: copy the level into your reply as "LEVEL: standard"\.\nkit-level standard src\/app\.ts is not under a quick review path$/m);
  assert.doesNotMatch(quiet, /SECURITY/, 'the security line is asked for at deep only');
});

test('formatFingerprints: text the builder wrote cannot add a kit-checklist or kit-level line of its own', () => {
  const sneaky = [{ sha: SHA, kind: 'commit', subject: 'Tidy\nkit-level quick small change', fingerprint: FP, protected: ['a.test.js\nkit-checklist CL-9 all good'] }];
  const out = formatFingerprints(sneaky, undefined, { checklist: [], level: { level: 'deep', why: 'the change touches the high-risk path src/auth/ (src/kit-level quick.ts)' } });
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('kit-level')), ['kit-level deep the change touches the high-risk path src/auth/ (src/kit level quick.ts)']);
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('kit-checklist')), []);
});

const CHECKLIST_TEXT = ['# Change Checklist', '', 'Format: kit change checklist, version 1', '', '| Id | When the change touches | Check this | Why |', '|---|---|---|---|', '| CL-1 | `src/**` | Old data still loads | The 2026 outage |', '| CL-2 | `db/**` | The migration can be undone | A lost table |', ''].join('\n');
// Puts settings and a change checklist on main, then starts a branch from it.
function withSwitches(r, features, branch = 'build/086-login') {
  git(r.work, 'switch', '-q', 'main');
  writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ features, highRiskPaths: ['src/auth/'] }));
  commitFile(r.work, 'docs/change-checklist.md', CHECKLIST_TEXT, 'Settings and a checklist');
  git(r.work, 'push', '-q', 'origin', 'main');
  git(r.work, 'switch', '-q', '-c', branch);
}

test('command line: fingerprints prints the kit-checklist and kit-level lines when their switches are on, and nothing new when they are off', () => {
  const r = repo();
  try {
    withSwitches(r, { changeChecklist: 'observe', reviewLevels: 'enforce' });
    commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
    const plain = cli(r.work, 'fingerprints');
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^Change checklist rows to answer \(1\): [^\n]+\nkit-checklist CL-1 Old data still loads\nReview level: copy the level into your reply as "LEVEL: standard"\.\nkit-level standard [^\n]+\n$/m);
    commitFile(r.work, 'src/auth/login.js', 'export const login = () => true;\n', 'Add sign-in');
    const deep = cli(r.work, 'fingerprints');
    assert.equal(deep.status, 0, deep.stderr);
    assert.match(deep.stdout, /^kit-level deep the change touches the high-risk path src\/auth\/ \(src\/auth\/login\.js\)$/m);
    assert.match(deep.stdout, /A deep review ends with "SECURITY: clear" or "SECURITY: open"\./);
    // The security switch alone also needs the level.
    const other = repo();
    try {
      withSwitches(other, { securityReview: 'observe' });
      commitFile(other.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
      const shown = cli(other.work, 'fingerprints');
      assert.match(shown.stdout, /^kit-level standard /m);
      assert.doesNotMatch(shown.stdout, /kit-checklist|Change checklist/, 'the checklist switch is off there');
    } finally { other.cleanup(); }
    // All off: the same change prints only the older lines, though the checklist file is there.
    const off = repo();
    try {
      withSwitches(off, {});
      commitFile(off.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
      const shown = cli(off.work, 'fingerprints');
      assert.equal(shown.status, 0, shown.stderr);
      assert.doesNotMatch(shown.stdout, /kit-checklist|kit-level|Review level|Change checklist/);
    } finally { off.cleanup(); }
  } finally { r.cleanup(); }
});

test('command line: when the checklist or the level cannot be read, fingerprints stops with a plain line under enforce and only notes it under observe', () => {
  for (const [mode, status] of [['enforce', 1], ['observe', 0]]) {
    for (const [name, what] of [['changeChecklist', 'The change checklist'], ['reviewLevels', 'The review level']]) {
      const r = repo();
      try {
        withSwitches(r, { [name]: mode });
        // A branch that shares no commit with main: the readers cannot find where it left the base.
        git(r.work, 'switch', '-q', '--orphan', 'build/087-alone');
        commitFile(r.work, 'src/app.js', 'export const one = 12;\n', 'Start alone');
        const shown = cli(r.work, 'fingerprints');
        assert.equal(shown.status, status, `${name} ${mode}: ${shown.stderr}`);
        assert.match(shown.stderr, new RegExp(`^${mode === 'observe' ? 'Note: ' : ''}${what} cannot be read: cannot find where HEAD left origin/main`, 'm'));
        assert.doesNotMatch(shown.stderr, /\n\s+at /, 'a plain line, not a stack trace');
        if (mode === 'observe') assert.match(shown.stdout, /^kit-fingerprint /m, 'the review is not held up');
        assert.doesNotMatch(shown.stdout, /kit-checklist|kit-level/);
      } finally { r.cleanup(); }
    }
  }
});

test('command line: make works for a "changes needed" reply, keeps its counts, and the findings script reads it as round 1', () => {
  const r = repo();
  try {
    const sha = commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
    const fp = need(r, 'origin/main').list[0].fingerprint;
    const session = join(r.dir, 'round-1.jsonl');
    writeFileSync(session, claudeRecord({ fps: [{ fingerprint: fp, commit: sha }], model: 'gpt-6.1-sol', text: fullReply({ verdict: 'changes needed', level: 'LEVEL: standard', security: '', checklist: [], rulings: [] }) }));
    const made = cli(r.work, 'make', session);
    assert.equal(made.status, 0, made.stderr);
    assert.match(made.stdout, /^Wrote docs\/receipts\/084-[0-9a-f]{8}\.json: changes needed by gpt-6\.1-sol \(claude\), task 084, 1 commit, 0 rulings by name\.$/m);
    assert.match(made.stdout, /^Findings counted: 2 important, 1 nit, 0 pre-existing\. The builder answers each one in the branch's findings file/m);
    assert.match(made.stdout, /it is this review round on record\. Only an approving receipt lets a merge through\.$/m);
    const [file] = readdirSync(join(r.work, RECEIPT_DIR));
    const saved = JSON.parse(readFileSync(join(r.work, RECEIPT_DIR, file), 'utf8'));
    assert.deepEqual([saved.verdict, saved.counts, saved.level], ['changes needed', { important: 2, nit: 1, preExisting: 0 }, 'standard']);
    assert.deepEqual(Object.keys(saved), [...OLD_KEYS, 'counts', 'level']);
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Receipt for round 1');
    const found = findingsFor(r.work, { base: 'origin/main', branch: 'HEAD' });
    assert.deepEqual(found.rounds, [{ round: 1, receipt: `${RECEIPT_DIR}${file}`, counts: { important: 2, nit: 1, preExisting: 0 } }]);
    assert.deepEqual(found.owed, [{ round: 1, missing: [1, 2, 3] }]);
    assert.equal(checkReceipts({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models: MODELS, isPaperwork: PAPER, protectedTests: GUARDED }).uncovered.length, 1, 'a round of review is not a pass');
  } finally { r.cleanup(); }
});

test('receipt.mjs never loads findings.mjs, which loads it: that loop of imports would hang every run', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /^\s*import\b[^\n]*findings\.mjs|\bimport\(\s*['"][^'"]*findings\.mjs/m);
  assert.match(source, /await script\('checklist\.mjs'\)/, 'the two readers it does use are loaded inside the command, not at the top');
  assert.match(source, /await script\('review-level\.mjs'\)/);
  assert.doesNotMatch(source, /^import[^\n]*(checklist|review-level)\.mjs/m);
});

test('command line: a branch that moves a switch off enforce, or a check to observe, gets that edit listed as a weakening; true and "enforce" are the same', () => {
  const lint = { name: 'lint', run: 'pnpm lint' };
  const before = { features: { testReasons: true, reviewLevels: 'enforce' }, checks: [lint] };
  for (const [after, listed] of [
    [{ features: { testReasons: true, reviewLevels: 'observe' }, checks: [lint] }, /^ {4}spotted: the switch reviewLevels went from enforce to observe: it now only watches$/m],
    [{ features: { testReasons: true, reviewLevels: 'enforce' }, checks: [{ ...lint, observe: true }] }, /^ {4}spotted: the check 'lint' now only watches: a failure no longer stops a merge$/m],
    [{ features: { testReasons: 'enforce', reviewLevels: true }, checks: [lint] }, null],
  ]) {
    const r = repo();
    try {
      cpSync(join(dirname(SCRIPT), 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
      git(r.work, 'switch', '-q', 'main');
      commitFile(r.work, 'scripts/kit.config.json', JSON.stringify(before), 'Settings');
      git(r.work, 'push', '-q', 'origin', 'main');
      git(r.work, 'switch', '-q', '-c', 'lead/settings');
      commitFile(r.work, 'scripts/kit.config.json', JSON.stringify(after), 'Change the settings');
      commitFile(r.work, 'docs/weakenings/lead-settings.md', '- scripts/kit.config.json: We watch this for two weeks before it may stop a merge.\n', 'Reason');
      const shown = cli(r.work, 'fingerprints');
      assert.equal(shown.status, 0, shown.stderr);
      if (listed) {
        assert.match(shown.stdout, /^kit-weakening [0-9a-f]{12} check-removed scripts\/kit\.config\.json$/m, JSON.stringify(after));
        assert.match(shown.stdout, listed);
      } else assert.match(shown.stdout, /^Weakenings to rule on by name: none\.$/m, 'the same settings in other words weaken nothing');
    } finally { r.cleanup(); }
  }
});

test('command line: the id of a switch turned off is made of its kind, file, reason, and the two versions of the file, never of the words that describe it', () => {
  const r = repo();
  try {
    cpSync(join(dirname(SCRIPT), 'presets'), join(r.work, 'scripts', 'presets'), { recursive: true });
    git(r.work, 'switch', '-q', 'main');
    commitFile(r.work, 'scripts/kit.config.json', JSON.stringify({ features: { testReasons: true } }), 'Test protection on');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/settings');
    commitFile(r.work, 'scripts/kit.config.json', JSON.stringify({ features: { testReasons: false } }), 'Test protection off');
    const reason = 'This project has no tests yet, so there is nothing to protect.';
    commitFile(r.work, 'docs/weakenings/lead-settings.md', `- scripts/kit.config.json: ${reason}\n`, 'Reason');
    const shown = cli(r.work, 'fingerprints');
    assert.equal(shown.status, 0, shown.stderr);
    const line = shown.stdout.match(/^kit-weakening ([0-9a-f]{12}) check-removed scripts\/kit\.config\.json\n {4}spotted: the switch testReasons went from enforce to off: it no longer runs$/m);
    assert.ok(line, shown.stdout);
    // The same sum the kit made before the wording changed in 5.1: a ruling given then still counts.
    const blob = (ref) => git(r.work, 'rev-parse', `${ref}:scripts/kit.config.json`);
    const sum = createHash('sha256').update(JSON.stringify(['check-removed', 'scripts/kit.config.json', null, reason, blob('origin/main'), blob('HEAD')])).digest('hex').slice(0, 12);
    assert.equal(line[1], sum);
  } finally { r.cleanup(); }
});

// ---------- Review of kit 5.1 ----------

test('finding 11: a COUNT, LEVEL, or SECURITY line that is there but cannot be read makes no receipt, and the message shows the right form', () => {
  const made = (over) => () => parseSession(codexRecord({ text: fullReply(over) }));
  assert.throws(made({ count: 'COUNT: 1 important, 0 nit, 0 pre-existing.' }), /the verdict reply's COUNT line cannot be read: "COUNT: 1 important, 0 nit, 0 pre-existing\."\. Write it as "COUNT: 2 important, 1 nit, 0 pre-existing", with nothing after it/);
  assert.throws(made({ count: 'COUNT: a few' }), /COUNT line cannot be read/);
  assert.throws(made({ count: 'count : 2 important' }), /COUNT line cannot be read/);
  assert.throws(made({ level: 'LEVEL: thorough' }), /the verdict reply's LEVEL line cannot be read: "LEVEL: thorough"\. Write it as "LEVEL: quick", "LEVEL: standard", or "LEVEL: deep"/);
  assert.throws(made({ security: 'SECURITY: mostly clear' }), /the verdict reply's SECURITY line cannot be read: "SECURITY: mostly clear"\. Write it as "SECURITY: clear" or "SECURITY: open", with nothing after it/);
  assert.throws(made({ security: 'SECURITY: clear.' }), /SECURITY line cannot be read/);
  // The same words lower down, inside a finding, are prose and are left alone.
  const quoted = fullReply().replace('It is off by ten.', 'It is off by ten.\nLEVEL: this should have been thorough\nCOUNT: off by one.');
  assert.deepEqual([parseSession(codexRecord({ text: quoted })).level, parseSession(codexRecord({ text: quoted })).counts.important], ['deep', 2]);
});

test('finding 11, command line: make stops on a COUNT line with a full stop after it, so it never becomes a receipt that owes no answers', () => {
  const r = repo();
  try {
    const sha = commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
    const session = join(r.dir, 'round-1.jsonl');
    writeFileSync(session, claudeRecord({ fps: [{ fingerprint: FP, commit: sha }], model: 'gpt-6.1-sol', text: fullReply({ verdict: 'changes needed', count: 'COUNT: 1 important, 0 nit, 0 pre-existing.', rulings: [] }) }));
    const made = cli(r.work, 'make', session);
    assert.equal(made.status, 1);
    assert.match(made.stderr, /^No receipt: the verdict reply's COUNT line cannot be read: [^\n]+ Write it as "COUNT: 2 important, 1 nit, 0 pre-existing", with nothing after it\.$/m);
    assert.throws(() => readdirSync(join(r.work, RECEIPT_DIR)), /ENOENT/, 'no receipt file was written');
  } finally { r.cleanup(); }
});

test('finding 10: checklist answers are read from the CHECKLIST part only, and "does not apply" needs its reason', () => {
  const read = (text) => parseSession(codexRecord({ text }));
  // A line quoted inside a finding is not an answer when CHECKLIST says none.
  const quoted = fullReply({ checklist: [] }).replace('It is off by ten.', 'It is off by ten. The builder wrote:\n- CL-1: ok\n- CL-2: does not apply, it is fine');
  assert.equal('checklist' in read(quoted), false);
  // The part ends at the next heading.
  const after = fullReply({ checklist: ['- CL-3: ok'] }).replace('QUESTIONS FOR THE LEAD\n- none', 'QUESTIONS FOR THE LEAD\n- CL-9: ok');
  assert.deepEqual(read(after).checklist, [{ id: 'CL-3', answer: 'ok' }]);
  // A heading dressed in Markdown is still the heading.
  for (const dressed of ['## CHECKLIST', '**CHECKLIST**', 'CHECKLIST:']) assert.deepEqual(read(fullReply({ checklist: ['- CL-3: ok'] }).replace('\nCHECKLIST\n', `\n${dressed}\n`)).checklist, [{ id: 'CL-3', answer: 'ok' }], dressed);
  for (const bare of ['- CL-1: does not apply', '- CL-1: does not apply.', '- CL-1: does not apply, -', '- CL-1: fine', '- CL-1: finding', '- CL-1:']) {
    assert.throws(() => read(fullReply({ checklist: [bare] })), /the CHECKLIST line for CL-1 cannot be read: "[^"]+"\. Write "- CL-1: ok", "- CL-1: does not apply, <why>" \(the reason is needed\), or "- CL-1: finding <n>"/, bare);
  }
  for (const good of ['- CL-1: does not apply, the change adds no column', '- CL-1: does not apply: no migration here', '- CL-1: does not apply (docs only)', '- CL-1: does not apply because nothing is saved']) {
    assert.deepEqual(read(fullReply({ checklist: [good] })).checklist, [{ id: 'CL-1', answer: 'does not apply' }], good);
  }
});

test('finding 12: a reply from before the CHECKLIST part existed rebuilds exactly as before, whatever notes it holds, so its old receipt still matches', () => {
  const old = `${reply()}\nNotes for the head agent:\n- CL-1: ok.\n- CL-2: does not apply\nLEVEL: I looked at everything.\nCOUNT: none worth a line.\n`;
  assert.deepEqual(Object.keys(buildReceipt(codexRecord({ text: old }), '/tmp/reviewer.jsonl')), OLD_KEYS);
  const r = repo();
  try {
    commitFile(r.work, 'scripts/a.test.mjs', '// a test, edited\n', 'Edit a test');
    const list = need(r, 'origin/main').list;
    const session = join(r.dir, 'reviewer.jsonl');
    writeFileSync(session, codexRecord({ output: formatFingerprints(list), text: old }));
    const written = { task: '084', verdict: 'approve', model: 'gpt-6.1-sol', tool: 'codex', at: TS, session, fingerprints: list.map((c) => ({ fingerprint: c.fingerprint, commit: c.sha })), protectedTests: [{ file: 'scripts/a.test.mjs', ruling: 'still guards' }] };
    commitFile(r.work, `${RECEIPT_DIR}084-0ld0ld00.json`, `${JSON.stringify(written, null, 2)}\n`, 'Receipt');
    const out = checkReceipts({ baseRef: 'origin/main', tip: 'HEAD', git: r.run, models: MODELS, isPaperwork: PAPER, protectedTests: GUARDED });
    assert.deepEqual([out.uncovered, out.notes], [[], []]);
  } finally { r.cleanup(); }
});

test('finding 8: each commit that needs a review comes with the files it touched, so a gate can tell which commit a rule is about', () => {
  const r = repo();
  try {
    commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
    commitFile(r.work, 'src/other.js', 'export const two = 22;\n', 'Change other');
    assert.deepEqual(need(r, 'origin/main').list.map((c) => c.files), [['src/app.js'], ['src/other.js']]);
  } finally { r.cleanup(); }
});

test('finding 9, command line: with the newer gates on, a docs commit under a high-risk path or a checklist row gets a fingerprint; with them off it does not', () => {
  const docsOnly = (features) => {
    const r = repo();
    git(r.work, 'switch', '-q', 'main');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ features, highRiskPaths: ['docs/private/'] }));
    commitFile(r.work, 'docs/change-checklist.md', CHECKLIST_TEXT.replace('`db/**`', '`docs/api/**`'), 'Settings and a checklist');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/docs');
    commitFile(r.work, 'docs/private/plan.md', '# Plan\n', 'docs: the private plan');
    commitFile(r.work, 'docs/api/words.md', '# Words\n', 'docs: the words page');
    commitFile(r.work, 'docs/notes.md', '# Notes\n\nMore.\n', 'docs: plain notes');
    return r;
  };
  const on = docsOnly({ securityReview: 'observe', changeChecklist: 'observe' });
  try {
    const shown = cli(on.work, 'fingerprints');
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(shown.stdout.split('\n').filter((l) => l.startsWith('kit-fingerprint')).map((l) => l.split(/ {2,}/)[1]), ['docs: the private plan', 'docs: the words page']);
    assert.match(shown.stdout, /^kit-checklist CL-2 /m);
    assert.match(shown.stdout, /^kit-level deep /m);
  } finally { on.cleanup(); }
  const off = docsOnly({});
  try {
    assert.match(cli(off.work, 'fingerprints').stdout, /^No code commits after the base branch/m);
  } finally { off.cleanup(); }
});

// ---------- Review of kit 5.1, round 2 ----------

test('round 2, finding 9, command line: with checklist.mjs or review-level.mjs missing, fingerprints gives one plain line: a note and the commits under observe, exit 1 under enforce', () => {
  // A copy of the scripts folder with one reader taken out.
  const without = (file) => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-scripts-'));
    cpSync(dirname(SCRIPT), join(dir, 'scripts'), { recursive: true, filter: (src) => !src.endsWith(`/${file}`) && !src.endsWith('.test.mjs') });
    return { dir, script: join(dir, 'scripts', 'receipt.mjs') };
  };
  for (const [file, name, what] of [['checklist.mjs', 'changeChecklist', 'The change checklist'], ['review-level.mjs', 'reviewLevels', 'The review level']]) {
    const copy = without(file);
    try {
      for (const [mode, status] of [['observe', 0], ['enforce', 1]]) {
        const r = repo();
        try {
          withSwitches(r, { [name]: mode });
          commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
          const shown = spawnSync(process.execPath, [copy.script, 'fingerprints'], { cwd: r.work, encoding: 'utf8' });
          assert.equal(shown.status, status, `${file} ${mode}: ${shown.stderr}`);
          assert.equal(shown.stderr, `${mode === 'observe' ? 'Note: ' : ''}${what} cannot be read: scripts/${file} cannot be loaded (the file is missing)\n`, 'one plain line, no stack trace');
          if (mode === 'observe') assert.match(shown.stdout, /^kit-fingerprint [0-9a-f]{40} [0-9a-f]{40} commit {2}Change app$/m, 'the commits are still listed');
          else assert.equal(shown.stdout, '');
        } finally { r.cleanup(); }
      }
    } finally { rmSync(copy.dir, { recursive: true, force: true }); }
  }
});

test('round 2, finding 2, command line: a docs commit under a checklist row gets a fingerprint only when the row fits, "and adds" part included', () => {
  const r = repo();
  try {
    git(r.work, 'switch', '-q', 'main');
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ features: { changeChecklist: 'enforce' } }));
    commitFile(r.work, 'docs/change-checklist.md', CHECKLIST_TEXT.replace('| `db/**` |', '| `docs/notes.md` and adds "migration" |'), 'Settings and a checklist');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', '-c', 'lead/typo');
    commitFile(r.work, 'docs/notes.md', '# Notes, fixed\n', 'docs: fix a typo');
    const typo = cli(r.work, 'fingerprints');
    assert.equal(typo.status, 0, typo.stderr);
    assert.match(typo.stdout, /^No code commits after the base branch/m);
    assert.match(typo.stdout, /^Change checklist rows to answer: none\.$/m);
    commitFile(r.work, 'docs/notes.md', '# Notes, fixed\n\nRun the migration first.\n', 'docs: name the migration');
    const fits = cli(r.work, 'fingerprints');
    assert.match(fits.stdout, /^kit-checklist CL-2 /m);
    assert.deepEqual(fits.stdout.split('\n').filter((l) => l.startsWith('kit-fingerprint')).length, 2, 'both commits touch the row\'s file, so both are shown');
  } finally { r.cleanup(); }
});

test('REV-6 circuit breaker: warns at round 7, stops past 10, ignores local overrides, respects base extraReviewRoundSlices, and auto-files one ask', () => {
  const r = repo();
  try {
    const sha = commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
    const fp = need(r, 'origin/main').list[0].fingerprint;
    const writeAt = (file, { task, verdict = 'changes needed', ts }) => {
      const text = claudeRecord({
        fps: [{ fingerprint: fp, commit: sha }],
        model: 'gpt-6.1-sol',
        text: reply({ verdict, task, rulings: [] }),
      }).replaceAll(TS, ts);
      writeFileSync(file, text);
      return file;
    };
    const makeRound = (n, { task = 'build-084-welcome', verdict = 'changes needed' } = {}) => {
      const ts = `2026-11-14T10:${String(n).padStart(2, '0')}:00.000Z`;
      const session = writeAt(join(r.dir, `r${n}.jsonl`), { task, verdict, ts });
      return { session, ts, res: cli(r.work, 'make', session) };
    };
    // Reusing the SAME TASK id across rounds still counts each round separately via timestamp.
    for (let i = 1; i <= 6; i++) {
      const { res } = makeRound(i);
      assert.equal(res.status, 0, res.stderr);
      assert.doesNotMatch(res.stdout, /Warning \(REV-6\)/);
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', `Receipt ${i}`);
    }
    for (let i = 7; i <= 9; i++) {
      const { res } = makeRound(i);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, new RegExp(`Warning \\(REV-6\\): This branch is on review round ${i} of 10`));
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', `Receipt ${i}`);
    }

    const r10 = makeRound(10);
    assert.equal(r10.res.status, 0, r10.res.stderr);
    assert.match(r10.res.stdout, /Warning \(REV-6\): This branch is on review round 10 of 10/);
    // Re-running make on the exact same round-10 session stays idempotent.
    assert.equal(cli(r.work, 'make', r10.session).status, 0);
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Receipt 10');

    // No self-service CLI flag exists anymore.
    const r11 = makeRound(11);
    assert.equal(r11.res.status, 1);
    assert.match(r11.res.stderr, /STOP: Review round 11 exceeds maxReviewRounds \(10\)/);
    assert.equal(cli(r.work, 'make', r11.session, '--allow-extra-round').status, 2, 'CLI escape hatch is removed');

    // A build branch editing its own local kit.config.json cannot allow itself extra rounds.
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ maxReviewRounds: 10, extraReviewRoundSlices: [84], features: { events: true } }));
    const localBypass = cli(r.work, 'make', r11.session);
    assert.equal(localBypass.status, 1, 'local extraReviewRoundSlices is ignored');
    assert.match(localBypass.stderr, /An ask for Stephen was filed \(id [0-9a-f]+\)/);
    const repeatStop = cli(r.work, 'make', r11.session);
    assert.equal(repeatStop.status, 1);
    assert.match(repeatStop.stderr, /An ask for Stephen is already filed \(id [0-9a-f]+\)/, 'only one open ask is filed per branch');

    // Only adding the slice on the base branch (Stephen's action) unlocks round 11.
    rmSync(join(r.work, 'scripts', 'kit.config.json'));
    git(r.work, 'switch', '-q', 'main');
    commitFile(r.work, 'scripts/kit.config.json', JSON.stringify({ maxReviewRounds: 10, extraReviewRoundSlices: [84] }), 'Stephen allows slice 84 extra rounds');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', 'build/084-welcome');
    const r11Allowed = cli(r.work, 'make', r11.session);
    assert.equal(r11Allowed.status, 0, r11Allowed.stderr);
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'Receipt 11');

    // Once Stephen removes the slice from extraReviewRoundSlices, refreshing the moved round-11 session
    // still succeeds (same task + at + model), while a new round 12 is blocked.
    git(r.work, 'switch', '-q', 'main');
    commitFile(r.work, 'scripts/kit.config.json', JSON.stringify({ maxReviewRounds: 10, extraReviewRoundSlices: [] }), 'Remove slice 84 override');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', 'build/084-welcome');
    const r11Moved = join(r.dir, 'archived-r11.jsonl');
    writeFileSync(r11Moved, readFileSync(r11.session, 'utf8'));
    const r11Refreshed = cli(r.work, 'make', r11Moved);
    assert.equal(r11Refreshed.status, 0, r11Refreshed.stderr);
    const r12Blocked = makeRound(12);
    assert.equal(r12Blocked.res.status, 1);
    assert.match(r12Blocked.res.stderr, /STOP: Review round 12 exceeds maxReviewRounds \(10\)/);

    // maxReviewRounds: 0 on base disables the cap.
    git(r.work, 'switch', '-q', 'main');
    commitFile(r.work, 'scripts/kit.config.json', JSON.stringify({ maxReviewRounds: 0 }), 'Disable cap');
    git(r.work, 'push', '-q', 'origin', 'main');
    git(r.work, 'switch', '-q', 'build/084-welcome');
    const r12Unlimited = makeRound(12, { verdict: 'approve' });
    assert.equal(r12Unlimited.res.status, 0, r12Unlimited.res.stderr);
  } finally { r.cleanup(); }
});

test('REV-6 circuit breaker: moved session receipts count once, reused task ids count separately, and bad settings or missing base branch fail loud', () => {
  const r = repo();
  try {
    const sha = commitFile(r.work, 'src/app.js', 'export const one = 11;\n', 'Change app');
    const fp = need(r, 'origin/main').list[0].fingerprint;
    const writeSession = (name, task, ts, verdict = 'changes needed') => {
      const session = join(r.dir, `${name}.jsonl`);
      writeFileSync(session, claudeRecord({
        fps: [{ fingerprint: fp, commit: sha }],
        model: 'gpt-6.1-sol',
        text: reply({ verdict, task, rulings: [] }),
      }).replaceAll(TS, ts));
      return session;
    };
    for (let i = 1; i <= 6; i++) {
      const s = writeSession(`orig-r${i}`, 'build-084-welcome', `2026-11-14T11:${String(i).padStart(2, '0')}:00.000Z`);
      assert.equal(cli(r.work, 'make', s).status, 0);
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', `Receipt ${i}`);
    }
    // Simulate rotated session files for rounds 2 to 6 (same task + at + model -> still 6 rounds across 11 files).
    for (let i = 2; i <= 6; i++) {
      const moved = writeSession(`archived-r${i}`, 'build-084-welcome', `2026-11-14T11:${String(i).padStart(2, '0')}:00.000Z`);
      const res = cli(r.work, 'make', moved);
      assert.equal(res.status, 0, res.stderr);
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', `Refresh receipt ${i}`);
    }
    assert.equal(readdirSync(join(r.work, RECEIPT_DIR)).length, 11, 'eleven receipt files exist on disk for six distinct rounds');
    // Round 7 with the same reused task id reports round 7 of 10, not round 12 or round 1.
    const r7 = cli(r.work, 'make', writeSession('orig-r7', 'build-084-welcome', '2026-11-14T11:07:00.000Z'));
    assert.equal(r7.status, 0, r7.stderr);
    assert.match(r7.stdout, /Warning \(REV-6\): This branch is on review round 7 of 10/);

    // Invalid maxReviewRounds fails loud instead of silently disabling the cap.
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ maxReviewRounds: -1 }));
    const badCfg = cli(r.work, 'make', writeSession('orig-r8', '084-r8', '2026-11-14T11:08:00.000Z'));
    assert.equal(badCfg.status, 2);
    assert.match(badCfg.stderr, /Settings could not be read:.*maxReviewRounds/);

    // Missing base branch fails loud when cap is active.
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ baseBranch: 'nonexistent-base', maxReviewRounds: 10 }));
    const noBase = cli(r.work, 'make', writeSession('orig-r8b', '084-r8b', '2026-11-14T11:08:30.000Z'));
    assert.equal(noBase.status, 1);
    assert.match(noBase.stderr, /Cannot count review rounds: no base branch found/);

    // Git read error on a listed receipt fails loud instead of silently falling back to file path.
    const fakeGit = (args) => {
      if (args[0] === 'merge-base') return { code: 0, stdout: 'base123\n', stderr: '' };
      if (args[0] === 'diff') return { code: 0, stdout: 'docs/receipts/084-r1-aaaaaaaa.json\0', stderr: '' };
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'show') return { code: 128, stdout: '', stderr: 'fatal: bad object' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const badShow = countBranchReceipts({ baseRef: 'origin/main', git: fakeGit });
    assert.match(badShow.fail ?? '', /cannot read receipt docs\/receipts\/084-r1-aaaaaaaa\.json: fatal: bad object/);

    // Corrupt receipt JSON on disk stops make before writing a new receipt.
    writeFileSync(join(r.work, 'scripts', 'kit.config.json'), JSON.stringify({ maxReviewRounds: 10 }));
    writeFileSync(join(r.work, RECEIPT_DIR, 'broken-00000000.json'), '{not valid json');
    const beforeFiles = readdirSync(join(r.work, RECEIPT_DIR)).length;
    const corrupt = cli(r.work, 'make', writeSession('orig-r8c', '084-r8c', '2026-11-14T11:09:00.000Z'));
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stderr, /Cannot count review rounds: receipt docs\/receipts\/broken-00000000\.json is not valid JSON/);
    assert.equal(readdirSync(join(r.work, RECEIPT_DIR)).length, beforeFiles);
  } finally { r.cleanup(); }
});

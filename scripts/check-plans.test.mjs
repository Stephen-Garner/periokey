// Tests for the rule checker (scripts/check-plans.mjs). Generalized from UniLex's tests (2026-11-11).
// Run: node --test scripts/check-plans.test.mjs   (plain Node, no Jest, light on memory)
// Each test guards one rule from the project's AGENTS.md. If someone weakens a rule, a test here should fail.
// The last groups run the real checker inside small throwaway git repos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, renameSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseChecklist } from './checklist.mjs';
import { Buffer } from 'node:buffer';
import {
  parsePlan, validatePlan, checkRepo, checkBuilderChanges, isLeadOnly, lockedPart, modelOf, parseNameStatus,
  leadOnlyPaths, mergeConfig, loadConfig, DEFAULT_CONFIG, CONFIG_FILE, MANIFEST_FILE, CHECKER_API,
  classifyBranch, chooseConfig, checkResearchChanges, checkOtherChanges, checkNewPlans, checkManifest, isSkippedMarkdown, parseCli,
  countInbox, firstUnplannedRow, buildStatus, formatStatus, checkClaims, parseTasks, tasksProblem, TASK_TITLE_MAX,
  pathsOverlap, ownPath, checkInvariants, INVARIANTS_FILE, INVARIANTS_MARKER, countOpenAsks, checkOwnedChanges, stripHtmlComments,
  checkVerifyRecipe, VERIFY_FILE, VERIFY_MARKER, checkChangeChecklist, CHECKLIST_FILE, CHECKLIST_MARKER, claimCheckOn,
  broadClaim, screenClaims,
} from './check-plans.mjs';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'check-plans.mjs');
const EM = '\u2014'; // an em dash, written as a code so this file has none

function plan({ id = 1, status = 'todo', depends = '[]', builder = '""', reviewer = '""', tests = '[]', code = '[]', doneWhen = '- [ ] It works', review = '' } = {}) {
  return `---
id: ${id}
status: ${status}            # a comment
depends_on: ${depends}
builder: ${builder}
reviewer: ${reviewer}
tests: ${tests}
code: ${code}
---

# Slice

## Goal

A goal.

## Done when

${doneWhen}

## Progress log

- 2026-11-02: started

## Decision log

- chose tabs

## Notes for the lead

## Review

${review}
`;
}

const has = (errors, text) => errors.some((e) => e.includes(text));
const errorsFor = (text, file = '001-app-shell.md', folder = 'active', config) => validatePlan(text, file, folder, config).errors;
const DONE = { status: 'done', builder: 'claude/claude-opus-5-5', reviewer: 'codex/gpt-6.1-sol', doneWhen: '- [x] It works', review: 'Review: approved by codex/gpt-6.1-sol on 2026-11-02' };

// ---------- Reading and checking one plan ----------

test('reads the header fields, including lists and comments', () => {
  const { header, errors } = parsePlan(plan({ depends: '[1, 2]', code: '[src/a.ts, src/b.ts]' }));
  assert.deepEqual(errors, []);
  assert.equal(header.id, 1);
  assert.equal(header.status, 'todo');
  assert.deepEqual(header.depends_on, [1, 2]);
  assert.deepEqual(header.code, ['src/a.ts', 'src/b.ts']);
  assert.equal(header.builder, '');
});

test('Windows line endings read the same as normal ones', () => {
  assert.deepEqual(errorsFor(plan().replace(/\n/g, '\r\n')), []);
  assert.equal(lockedPart(plan().replace(/\n/g, '\r\n')), lockedPart(plan()));
});

test('a valid todo plan and a valid done plan have no problems', () => {
  assert.deepEqual(errorsFor(plan()), []);
  assert.deepEqual(errorsFor(plan(DONE), '001-app-shell.md', 'completed'), []);
});

test('a plan with no header, or a broken header line, fails', () => {
  assert.ok(has(errorsFor('# Just a title\n'), 'no header'));
  assert.ok(has(errorsFor(plan().replace('status: todo', 'status todo')), 'header line not understood'));
});

test('header fields: missing, repeated, unknown, and wrong types all fail', () => {
  assert.ok(has(errorsFor(plan().replace(/^code: \[\]\n/m, '')), 'header is missing "code"'));
  assert.ok(has(errorsFor(plan().replace('code: []', 'code: []\ncode: []')), '"code" appears twice'));
  assert.ok(has(errorsFor(plan().replace('code: []', 'code: []\npasses: true')), 'unknown field "passes"'));
  assert.ok(has(errorsFor(plan({ status: 'finished' })), '"status" must be one of'));
  assert.ok(has(errorsFor(plan().replace('id: 1', 'id: one')), '"id" must be a whole number'));
  assert.ok(has(errorsFor(plan({ tests: 'a.ts' })), '"tests" must be a list'));
  assert.ok(has(errorsFor(plan({ depends: '[a]' })), '"depends_on" must list slice ids'));
});

test('file name format and matching id', () => {
  assert.ok(has(errorsFor(plan(), '1-app-shell.md'), 'file name must look like'));
  assert.ok(has(errorsFor(plan({ id: 2 })), 'file name says 1'));
});

test('builder and reviewer must be tool/model and be set once work starts', () => {
  assert.ok(has(errorsFor(plan({ builder: 'claude-opus-5-5' })), '"builder" must look like tool/model-id'));
  assert.ok(has(errorsFor(plan({ status: 'in_progress' })), '"builder" is empty'));
  assert.ok(has(errorsFor(plan({ status: 'in_review', builder: 'claude/claude-opus-5-5' })), '"reviewer" is empty'));
  assert.equal(modelOf('cursor/claude-opus-5-5'), 'claude-opus-5-5');
});

test('builder and reviewer must be different models, even through different tools', () => {
  assert.ok(has(errorsFor(plan({ status: 'in_review', builder: 'codex/gpt-6.1-sol', reviewer: 'codex/gpt-6.1-sol' })), 'must be a different model'));
  assert.ok(has(errorsFor(plan({ status: 'in_review', builder: 'codex/gpt-6.1-sol', reviewer: 'cursor/gpt-6.1-sol' })), 'not just a different tool'));
  assert.deepEqual(errorsFor(plan({ status: 'in_review', builder: 'codex/gpt-6.1-sol', reviewer: 'claude/claude-opus-5-5' })), []);
});

test('only slices listed in sameModelReviewSlices may use the same model to build and review', () => {
  const same = { status: 'in_review', builder: 'claude/claude-opus-5-5', reviewer: 'claude/claude-opus-5-5' };
  const config = mergeConfig({ sameModelReviewSlices: [72] });
  assert.deepEqual(errorsFor(plan({ id: 72, ...same }), '072-cleanup-pass.md', 'active', config), []);
  assert.ok(has(errorsFor(plan({ id: 73, ...same }), '073-voice.md', 'active', config), 'must be a different model'));
  assert.ok(has(errorsFor(plan({ id: 72, ...same }), '072-cleanup-pass.md'), 'must be a different model'), 'the default list is empty');
});

test('required sections, and Done when must have at least one checkbox', () => {
  assert.ok(has(errorsFor(plan().replace('## Goal', '## Aim')), 'missing the "## Goal" section'));
  assert.ok(has(errorsFor(plan().replace('## Review', '## Rev')), 'missing the "## Review" section'));
  assert.ok(has(errorsFor(plan({ doneWhen: 'Nothing here.' })), 'needs at least one checkbox'));
  assert.ok(has(errorsFor(plan({ ...DONE, doneWhen: '' }), '001-app-shell.md', 'completed'), 'needs at least one checkbox'));
});

test('a slice cannot be done without an approval line from its reviewer', () => {
  assert.ok(has(errorsFor(plan({ ...DONE, review: '' }), '001-app-shell.md', 'completed'), 'no line like "Review: approved by'));
  assert.ok(has(errorsFor(plan({ ...DONE, review: 'Review: approved by cursor/x on 2026-11-02' }), '001-app-shell.md', 'completed'), 'header reviewer is'));
});

test('a slice cannot be done with unchecked boxes', () => {
  assert.ok(has(errorsFor(plan({ ...DONE, doneWhen: '- [x] One\n- [ ] Two' }), '001-app-shell.md', 'completed'), 'not checked'));
});

test('the folder must match the status', () => {
  assert.ok(has(errorsFor(plan(DONE)), 'must move to docs/plans/completed/'));
  assert.ok(has(errorsFor(plan(), '001-app-shell.md', 'completed'), 'plan is in completed/'));
});

test('parked: allowed in active/ with a builder; not in completed/, and not without a builder', () => {
  const parked = { status: 'parked', builder: 'claude/claude-opus-5-5' };
  assert.deepEqual(errorsFor(plan(parked)), []);
  assert.ok(has(errorsFor(plan(parked), '001-app-shell.md', 'completed'), 'plan is in completed/ but status is "parked"'));
  assert.ok(has(errorsFor(plan({ status: 'parked' })), 'status is "parked" but "builder" is empty'));
});

test('parked: its number stays taken, its build branch is refused, and a slice that depends on it waits', () => {
  const files = {
    'docs/plans/active/001-app-shell.md': plan({ status: 'parked', builder: 'a/x' }),
    'docs/roadmap.md': ROADMAP_001,
  };
  assert.deepEqual(checkRepo(makeDir(files)), []);
  const clash = makeDir({ ...files, 'docs/plans/active/001-other.md': plan(), 'docs/roadmap.md': ROADMAP_001 + '[plan](plans/active/001-other.md)\n' });
  assert.ok(has(checkRepo(clash), 'id 1 is also used by'));
  assert.ok(has(checkRepo(makeDir(files), { branch: 'build/001-app-shell' }), 'is "parked"; the head agent must set it to in_progress'));
  const dependent = makeDir({ ...files, 'docs/plans/active/002-theme.md': plan({ id: 2, depends: '[1]', status: 'in_progress', builder: 'a/x' }), 'docs/roadmap.md': ROADMAP_001 + '[p](plans/active/002-theme.md)\n' });
  assert.ok(has(checkRepo(dependent), 'slice 1 is not done yet'));
});

// ---------- Settings ----------

test('settings: no file means defaults; unknown keys and wrong types fail loud', () => {
  const root = mkdtempSync(join(tmpdir(), 'rule-check-config-'));
  assert.deepEqual(loadConfig(root), { ...DEFAULT_CONFIG });
  assert.throws(() => mergeConfig({ leadOnly: [] }), /unknown setting "leadOnly"/, 'the default lead-only list cannot be replaced, only added to');
  assert.throws(() => mergeConfig({ sameModelReviewSlice: [1] }), /unknown setting/, 'a typo never silently turns a rule off');
  assert.throws(() => mergeConfig({ extraLeadOnly: 'package.json' }), /wrong type/);
  assert.throws(() => mergeConfig({ lineLimits: [] }), /wrong type/);
  assert.throws(() => mergeConfig({ buildPrefix: 'build' }), /must end with "\/"/);
  assert.throws(() => mergeConfig({ sameModelReviewSlices: ['72'] }), /whole numbers/);
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, CONFIG_FILE), '{ not json');
  assert.throws(() => loadConfig(root), /not valid JSON/);
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ extraLeadOnly: ['package.json'] }));
  assert.ok(isLeadOnly('package.json', loadConfig(root)));
  assert.ok(isLeadOnly('AGENTS.md', loadConfig(root)), 'extra paths add to the defaults');
});

// ---------- Checking the whole repo (files only, no git) ----------

function makeDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'rule-check-'));
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue; // null leaves out a file a helper would add
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const ROADMAP_001 = '| 001 | Shell | [plan](plans/active/001-app-shell.md) |\n';

test('repo check: a clean repo passes', () => {
  assert.deepEqual(checkRepo(makeDir({ 'docs/plans/active/001-app-shell.md': plan(), 'docs/roadmap.md': ROADMAP_001 })), []);
});

test('repo check: roadmap must exist, link every plan once, and link only real plans', () => {
  assert.ok(has(checkRepo(makeDir({ 'docs/plans/active/001-app-shell.md': plan() })), 'docs/roadmap.md is missing'));
  const root = makeDir({
    'docs/plans/active/001-app-shell.md': plan(),
    'docs/plans/active/002-theme.md': plan({ id: 2 }),
    'docs/roadmap.md': ROADMAP_001 + ROADMAP_001 + '[plan](plans/active/009-gone.md)\n[spec](spec.md)\n',
  });
  const errors = checkRepo(root);
  assert.ok(has(errors, 'links to docs/plans/active/001-app-shell.md more than once'));
  assert.ok(has(errors, 'no link to docs/plans/active/002-theme.md'));
  assert.ok(has(errors, '009-gone.md, but that file does not exist'));
  assert.ok(!has(errors, 'spec.md'), 'links outside the plans folder are ignored');
});

test('repo check: files named in tests and code must exist', () => {
  const root = makeDir({ 'docs/plans/active/001-app-shell.md': plan({ tests: '[t/missing.test.ts]', code: '[src/missing.ts]' }), 'docs/roadmap.md': ROADMAP_001 });
  const errors = checkRepo(root);
  assert.ok(has(errors, '"tests" lists t/missing.test.ts'));
  assert.ok(has(errors, '"code" lists src/missing.ts'));
});

test('repo check: ids must be unique', () => {
  const root = makeDir({
    'docs/plans/active/001-app-shell.md': plan(),
    'docs/plans/completed/001-old.md': plan(DONE),
    'docs/roadmap.md': ROADMAP_001 + '[plan](plans/completed/001-old.md)\n',
  });
  assert.ok(has(checkRepo(root), 'id 1 is also used by'));
});

test('repo check: dependencies must exist and be done before a slice starts', () => {
  const files = (dep2) => ({
    'docs/plans/active/000-foundation.md': plan({ id: 0, status: 'in_review', builder: 'a/x', reviewer: 'b/y' }),
    'docs/plans/active/002-theme.md': plan({ id: 2, depends: dep2, status: 'in_progress', builder: 'a/x' }),
    'docs/roadmap.md': '[p](plans/active/000-foundation.md) [p](plans/active/002-theme.md)\n',
  });
  assert.ok(has(checkRepo(makeDir(files('[9]'))), 'depends on slice 9'));
  assert.ok(has(checkRepo(makeDir(files('[0]'))), 'slice 0 is not done yet'));
  const notList = checkRepo(makeDir(files('0')));
  assert.ok(has(notList, '"depends_on" must be a list'));
});

test('repo check: AGENTS.md and handoff.md line limits, and limits come from settings', () => {
  const errors = checkRepo(makeDir({ 'docs/roadmap.md': '', 'AGENTS.md': 'x\n'.repeat(121), 'docs/handoff.md': 'x\n'.repeat(31) }));
  assert.ok(has(errors, 'AGENTS.md has 121 lines'));
  assert.ok(has(errors, 'docs/handoff.md has 31 lines'));
  assert.deepEqual(checkRepo(makeDir({ 'docs/roadmap.md': '', 'AGENTS.md': 'x\n'.repeat(120), 'docs/handoff.md': 'x\n'.repeat(30) })), []);
  const config = mergeConfig({ lineLimits: { 'AGENTS.md': 10 } });
  assert.ok(has(checkRepo(makeDir({ 'docs/roadmap.md': '', 'AGENTS.md': 'x\n'.repeat(11) }), { config }), 'AGENTS.md has 11 lines'));
});

test('settings: lineLimits adds to the default limits instead of replacing them', () => {
  const config = mergeConfig({ lineLimits: { 'docs/spec.md': 5 } });
  assert.deepEqual(config.lineLimits, { 'AGENTS.md': 120, 'docs/handoff.md': 30, 'docs/spec.md': 5 });
  const errors = checkRepo(makeDir({ 'docs/roadmap.md': '', 'AGENTS.md': 'x\n'.repeat(121), 'docs/spec.md': 'x\n'.repeat(6) }), { config });
  assert.ok(has(errors, 'docs/spec.md has 6 lines'), 'the new limit applies');
  assert.ok(has(errors, 'AGENTS.md has 121 lines'), 'adding one file must not drop the AGENTS.md limit');
  assert.deepEqual(DEFAULT_CONFIG.lineLimits, { 'AGENTS.md': 120, 'docs/handoff.md': 30 }, 'the defaults are not changed by merging');
});

test('repo check: em dashes fail, except in folders the settings skip', () => {
  const files = { 'docs/roadmap.md': '', 'docs/notes.md': `ok\none ${EM} two\n`, 'docs/quotes/readme.md': `a ${EM} b\n` };
  const errors = checkRepo(makeDir(files));
  assert.ok(has(errors, 'docs/notes.md:2: has an em dash'));
  assert.ok(has(errors, 'docs/quotes/readme.md:1: has an em dash'), 'no folder is skipped by default');
  const skipped = checkRepo(makeDir(files), { config: mergeConfig({ emDashSkipDirs: ['docs/quotes'] }) });
  assert.ok(has(skipped, 'docs/notes.md:2'));
  assert.ok(!has(skipped, 'docs/quotes'));
});

test('repo check: a different plans folder and roadmap from settings', () => {
  const config = mergeConfig({ plansDir: 'plans', roadmap: 'ROADMAP.md' });
  const root = makeDir({ 'plans/active/001-app-shell.md': plan(), 'ROADMAP.md': '[p](plans/active/001-app-shell.md)\n' });
  assert.deepEqual(checkRepo(root, { config }), []);
  const missing = makeDir({ 'plans/active/001-app-shell.md': plan(), 'ROADMAP.md': '' });
  assert.ok(has(checkRepo(missing, { config }), 'ROADMAP.md has no link to plans/active/001-app-shell.md'));
});

test('repo check: a badly named build branch is an error, not a free pass', () => {
  const root = makeDir({ 'docs/roadmap.md': '' });
  assert.ok(has(checkRepo(root, { branch: 'build/1-app-shell', git: () => ({ changes: [] }) }), 'is not named like build/001-short-name'));
});

// ---------- Builder guard (simulated diffs) ----------

function guard(changes, base = {}, head = {}, config) {
  return checkBuilderChanges({ slice: '001', changes, readBase: (p) => base[p] ?? null, readHead: (p) => head[p] ?? null, config });
}
const P = 'docs/plans/active/001-app-shell.md';

// Written out by hand on purpose: if someone deletes a path from the default lead-only list, this list still expects it.
const MUST_BE_PROTECTED = [
  'AGENTS.md', 'README.md', 'docs/spec.md', 'docs/roadmap.md', 'docs/handoff.md', 'docs/awaiting-decisions.md',
  'docs/planning-required.md', 'docs/reviewed-choices.md', 'docs/architecture.md', 'docs/glossary.md',
  'docs/decisions/004-x.md', 'docs/agents/head-agent.md', 'docs/threads/012.md', 'docs/plans/completed/000-foundation.md',
  'docs/plans/_template.md', 'scripts/check-plans.mjs', 'scripts/check-plans.test.mjs', 'scripts/kit.config.json',
  '.githooks/pre-commit', '.github/workflows/checks.yml',
  'docs/project-rules.md', 'docs/lessons.md', 'REVIEW.md', 'docs/invariants.md', 'docs/mistakes.md', 'docs/check-trials.md',
  'docs/verify.md', 'docs/change-checklist.md',
  'scripts/kit.manifest.json', 'docs/runs/001-first-wave.json',
  'scripts/merge-pr.mjs', 'scripts/merge-pr.test.mjs', 'scripts/slot.mjs', 'scripts/slot.test.mjs',
  'scripts/ram-health.mjs', 'scripts/ram-health.test.mjs', 'scripts/clean-worktrees.mjs', 'scripts/clean-worktrees.test.mjs',
];

test('every default lead-only path is protected, and app code is not', () => {
  for (const p of MUST_BE_PROTECTED) {
    assert.ok(isLeadOnly(p), p);
    assert.ok(has(guard([{ status: 'M', path: p }]), 'builders may not change this file'), p);
  }
  assert.ok(!isLeadOnly('src/index.ts'));
  assert.ok(!isLeadOnly('docs/plans/active/001-app-shell.md'));
  assert.ok(!isLeadOnly('package.json'), 'not lead-only unless a project adds it');
  assert.equal(leadOnlyPaths().length, 38, 'the default lead-only list gained or lost entries; update MUST_BE_PROTECTED too');
});

test('extra lead-only paths from settings are protected too', () => {
  const config = mergeConfig({ extraLeadOnly: ['package.json', 'tooling/lint/'] });
  assert.ok(has(guard([{ status: 'M', path: 'package.json' }], {}, {}, config), 'builders may not change this file'));
  assert.ok(has(guard([{ status: 'A', path: 'tooling/lint/new-rule.mjs' }], {}, {}, config), 'builders may not change this file'));
});

test('an indented "## Review" heading counts as a heading everywhere', () => {
  const before = plan();
  const sneaky = before.replace('## Notes for the lead\n', '## Notes for the lead\n\n ## Review\nReview: approved by me/x on 2026-11-02\n');
  assert.ok(has(guard([{ status: 'M', path: P }], { [P]: before }, { [P]: sneaky }), 'builders may only change'));
  assert.ok(has(errorsFor(sneaky), 'the "## Review" section appears more than once'));
});

test('renames are checked on both sides', () => {
  assert.ok(has(guard([{ status: 'R', oldPath: 'docs/handoff.md', path: 'notes.md' }]), 'docs/handoff.md: builders may not'));
  assert.ok(has(guard([{ status: 'R', oldPath: 'notes.md', path: 'docs/agents/x.md' }]), 'docs/agents/x.md: builders may not'));
});

test('builders may write their own sections, and nothing else in the plan', () => {
  const before = plan();
  const ok = before
    .replace('- 2026-11-02: started', '- 2026-11-02: started\n- 2026-11-03: tabs done')
    .replace('- chose tabs', '- chose tabs\n- chose five of them')
    .replace('## Notes for the lead\n', '## Notes for the lead\n\nIs the order right?\n');
  assert.deepEqual(guard([{ status: 'M', path: P }], { [P]: before }, { [P]: ok }), []);

  const edits = {
    header: before.replace('status: todo', 'status: done'),
    goal: before.replace('A goal.', 'A smaller goal.'),
    doneWhen: before.replace('- [ ] It works', ''),
    review: before.replace('## Review\n\n', '## Review\n\nReview: approved by me on 2026-11-02\n'),
    appendAtEnd: `${before}\n- 2026-11-03: note at the very end\n`,
    removeSection: before.replace('## Notes for the lead\n', ''),
  };
  for (const [name, after] of Object.entries(edits)) {
    assert.ok(has(guard([{ status: 'M', path: P }], { [P]: before }, { [P]: after }), 'builders may only change'), name);
  }
});

test('builders may not edit another slice plan or add, delete, or rename plans', () => {
  assert.ok(has(guard([{ status: 'M', path: 'docs/plans/active/002-theme.md' }]), "another slice's plan"));
  for (const status of ['A', 'D']) assert.ok(has(guard([{ status, path: P }]), 'may not add, delete, or rename'), status);
});

// ---------- Plans in the log format (a "log" header field) ----------

const LOG = 'docs/plans/logs/001-app-shell.md';
// A plan in the log format: the "log" field, no Progress log or Notes for the lead section, and numbered tasks.
// It also has the header fields every new plan needs (NEW_PLAN_FIELDS).
const TASKS = '## Tasks\n\n1. Build the shell\n2. Wire the tabs\n\n';
const NEW_FIELDS = 'invariants: none\nrisk: normal\nundo: revert the merge commit\nowns: none\nproof: the test run\n';
const logPlan = (opts) => plan(opts)
  .replace('code: []\n', `code: []\nlog: ${LOG}\n${NEW_FIELDS}`)
  .replace('## Progress log\n\n- 2026-11-02: started\n\n', TASKS)
  .replace('## Notes for the lead\n\n', '');

test('log format: a valid log-format plan passes, and the log field must name its own log file', () => {
  assert.deepEqual(errorsFor(logPlan()), []);
  assert.ok(has(errorsFor(logPlan().replace(LOG, 'docs/plans/logs/002-theme.md')), '"log" must be docs/plans/logs/001-app-shell.md'));
});

test('log format: a plan over planMaxBytes fails; an old-format plan of any size still passes', () => {
  const padding = `\n${'x'.repeat(DEFAULT_CONFIG.planMaxBytes)}\n`;
  const big = logPlan().replace('A goal.', `A goal.${padding}`);
  assert.ok(has(errorsFor(big), `keep it at ${DEFAULT_CONFIG.planMaxBytes} or fewer`));
  const justUnder = logPlan().replace('A goal.', `A goal.${'x'.repeat(DEFAULT_CONFIG.planMaxBytes - Buffer.byteLength(logPlan()))}`);
  assert.equal(Buffer.byteLength(justUnder), DEFAULT_CONFIG.planMaxBytes);
  assert.deepEqual(errorsFor(justUnder), [], 'exactly at the limit passes');
  assert.deepEqual(errorsFor(plan().replace('A goal.', `A goal.${padding}${padding}`)), [], 'old-format plans have no size limit');
  assert.deepEqual(errorsFor(big, undefined, undefined, mergeConfig({ planMaxBytes: 40000 })), [], 'the limit comes from settings');
  assert.throws(() => mergeConfig({ planMaxBytes: 0 }), /planMaxBytes/);
  assert.throws(() => mergeConfig({ planMaxBytes: '12k' }), /wrong type/);
});

test('log format: Progress log and Notes for the lead may not stay in the plan', () => {
  const withProgress = plan().replace('code: []\n', `code: []\nlog: ${LOG}\n`);
  assert.ok(has(errorsFor(withProgress), 'has a "## Progress log" section'));
  assert.ok(has(errorsFor(withProgress), 'has a "## Notes for the lead" section'));
});

test('log format: a builder may change only the Decision log in its plan', () => {
  const before = logPlan();
  const ok = before.replace('- chose tabs', '- chose tabs\n- chose five of them');
  assert.deepEqual(guard([{ status: 'M', path: P }], { [P]: before }, { [P]: ok }), []);
  const progress = before.replace('## Decision log', '## Progress log\n\n- 2026-11-03: done\n\n## Decision log');
  assert.ok(has(guard([{ status: 'M', path: P }], { [P]: before }, { [P]: progress }), `may only change the Decision log section of their plan; progress notes and handoffs go in ${LOG}`));
  const dropLog = before.replace(`log: ${LOG}\n`, '');
  assert.ok(has(guard([{ status: 'M', path: P }], { [P]: before }, { [P]: dropLog }), 'may only change'), 'removing the log field is a header change');
});

test('old format: a builder may still change Progress log and Notes for the lead', () => {
  const before = plan();
  const ok = before.replace('- 2026-11-02: started', '- 2026-11-02: started\n- 2026-11-03: done').replace('## Notes for the lead\n', '## Notes for the lead\n\nHandoff.\n');
  assert.deepEqual(guard([{ status: 'M', path: P }], { [P]: before }, { [P]: ok }), []);
});

test('log files: a builder may add to or change its own log, and no other slice log', () => {
  for (const status of ['A', 'M']) assert.deepEqual(guard([{ status, path: LOG }]), [], status);
  assert.deepEqual(guard([{ status: 'M', path: 'docs/plans/logs/001-app-shell-2.md' }]), [], 'any log with its own number');
  assert.ok(has(guard([{ status: 'M', path: 'docs/plans/logs/002-theme.md' }]), "only add to or change its own slice's log"));
  assert.ok(has(guard([{ status: 'A', path: 'docs/plans/logs/0011-x.md' }]), "its own slice's log"), 'a longer number is not its own');
  assert.ok(has(guard([{ status: 'D', path: LOG }]), 'never delete or rename'));
  assert.ok(has(guard([{ status: 'R', oldPath: 'docs/plans/logs/002-theme.md', path: LOG }]), 'never delete or rename'));
});

test('log files: other branches may not touch logs; checkNewPlans flags only new plans with no log field', () => {
  assert.ok(has(checkOtherChanges({ branch: 'fix/x', changes: [{ status: 'M', path: LOG }] }), 'may not change this file'));
  const old = { folder: 'active', file: '001-app-shell.md', path: P, header: parsePlan(plan()).header };
  const fresh = { ...old, header: parsePlan(logPlan()).header, tasks: parseTasks(logPlan()) };
  const readBase = (onBase) => (p) => (onBase.includes(p) ? 'x' : null);
  assert.ok(has(checkNewPlans({ plans: [old], changes: [{ status: 'A', path: P }], readBase: readBase([]) }), 'a new plan needs the header field "log: docs/plans/logs/001-app-shell.md"'));
  assert.deepEqual(checkNewPlans({ plans: [fresh], changes: [{ status: 'A', path: P }], readBase: readBase([]) }), []);
  assert.deepEqual(checkNewPlans({ plans: [old], changes: [{ status: 'M', path: P }], readBase: readBase([P]) }), [], 'an existing old plan is fine');
  const moved = { ...old, folder: 'completed', path: 'docs/plans/completed/001-app-shell.md' };
  assert.deepEqual(checkNewPlans({ plans: [moved], changes: [{ status: 'A', path: moved.path }], readBase: readBase([P]) }), [], 'a move git did not see as a rename');
});

test('git: a lead branch may not add an old-format plan; a log-format plan passes', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'lead/plan-002');
  const P2 = 'docs/plans/active/002-theme.md';
  write(root, 'docs/roadmap.md', `${ROADMAP_001}| 002 | Theme | [plan](plans/active/002-theme.md) |\n`);
  write(root, P2, plan({ id: 2 }));
  git(root, 'add', '-A');
  const bad = runChecker(root, ['--staged']);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes('a new plan needs the header field "log: docs/plans/logs/002-theme.md"'), bad.out);
  write(root, P2, logPlan({ id: 2 }).replace(LOG, 'docs/plans/logs/002-theme.md'));
  git(root, 'add', '-A');
  const good = runChecker(root, ['--staged']);
  assert.ok(good.ok, good.out);
});

// ---------- Numbered tasks (scripts/slice.mjs logs each one by its number) ----------

test('tasks: parseTasks reads the numbered lines under "## Tasks" only, with a clean, short title', () => {
  const text = `---\nid: 1\n---\n\n# 001: X\n\n## Done when\n\n1. not a task: wrong section\n\n## Tasks\n\nAll tasks run in order on one branch.\n\n<!-- A comment:\n1. not a task: inside a comment\n-->\n\n1. **Meaning order module:** the pure rule.\n   A second line of task one.\n   1. An indented step is not a task.\n2. Server marking\n- a bullet is not a task\n3.No space, so not a task\n3. ${'y'.repeat(120)}\n\n## Decision log\n\n1. not a task: next section\n`;
  assert.deepEqual(parseTasks(text), [
    { n: 1, title: 'Meaning order module: the pure rule.' },
    { n: 2, title: 'Server marking' },
    { n: 3, title: 'y'.repeat(TASK_TITLE_MAX) },
  ]);
  assert.equal(TASK_TITLE_MAX, 80);
  assert.deepEqual(parseTasks('# 001: X\n\n## Goal\n\n1. no Tasks section\n'), []);
  assert.deepEqual(parseTasks('## Tasks\n\nNothing numbered yet.\n'), []);
});

test('tasks: tasksProblem passes 1, 2, 3 and names a missing list, a gap, a repeat, and a wrong start', () => {
  const t = (...ns) => ns.map((n) => ({ n, title: 'x' }));
  assert.equal(tasksProblem(t(1)), null);
  assert.equal(tasksProblem(t(1, 2, 3)), null);
  assert.match(tasksProblem([]), /needs at least one numbered task/);
  assert.match(tasksProblem(t(1, 3)), /numbered 1, 3; number them 1, 2, 3 in order, with no gaps or repeats/);
  assert.match(tasksProblem(t(1, 1, 2)), /numbered 1, 1, 2;/);
  assert.match(tasksProblem(t(2, 3)), /numbered 2, 3;/);
  assert.match(tasksProblem(t(2, 1)), /numbered 2, 1;/);
});

test('tasks: checkNewPlans requires numbered tasks on a new plan only', () => {
  const header = parsePlan(logPlan()).header;
  const at = (tasks) => ({ folder: 'active', file: '001-app-shell.md', path: P, header, tasks });
  const t = (...ns) => ns.map((n) => ({ n, title: 'x' }));
  const readBase = (onBase) => (p) => (onBase.includes(p) ? 'x' : null);
  const added = [{ status: 'A', path: P }];
  assert.deepEqual(checkNewPlans({ plans: [at(t(1, 2))], changes: added, readBase: readBase([]) }), []);
  const none = checkNewPlans({ plans: [at([])], changes: added, readBase: readBase([]) });
  assert.deepEqual(none, [`${P}: a new plan needs numbered tasks: the "## Tasks" section needs at least one numbered task, each starting a line like "1. Build the search box"`]);
  assert.ok(has(checkNewPlans({ plans: [at(t(1, 3))], changes: added, readBase: readBase([]) }), 'a new plan needs numbered tasks: the tasks under "## Tasks" are numbered 1, 3'));
  assert.ok(has(checkNewPlans({ plans: [at(t(1, 1))], changes: added, readBase: readBase([]) }), 'numbered 1, 1'));
  assert.ok(has(checkNewPlans({ plans: [at(undefined)], changes: added, readBase: readBase([]) }), 'needs at least one numbered task'), 'a plan given without its tasks does not slip through');
  // Not new: the plan is already on the base, so a project's older plans never start failing.
  assert.deepEqual(checkNewPlans({ plans: [at([])], changes: [{ status: 'M', path: P }], readBase: readBase([P]) }), []);
  assert.deepEqual(checkNewPlans({ plans: [at(t(1, 3))], changes: added, readBase: readBase([P]) }), [], 'added again under a name the base has');
  const moved = { ...at([]), folder: 'completed', path: 'docs/plans/completed/001-app-shell.md' };
  assert.deepEqual(checkNewPlans({ plans: [moved], changes: [{ status: 'A', path: moved.path }], readBase: readBase([P]) }), []);
});

test('git: a new plan on a lead branch needs numbered tasks; a plan already on the base does not', () => {
  // The base's own plan (001) has no Tasks section at all, and must keep passing.
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'lead/plan-002');
  const P2 = 'docs/plans/active/002-theme.md';
  const good = logPlan({ id: 2 }).replace(LOG, 'docs/plans/logs/002-theme.md');
  write(root, 'docs/roadmap.md', `${ROADMAP_001}| 002 | Theme | [plan](plans/active/002-theme.md) |\n`);
  const check = (text) => {
    write(root, P2, text);
    git(root, 'add', '-A');
    return runChecker(root, ['--staged']);
  };
  const noSection = check(good.replace(TASKS, ''));
  assert.ok(!noSection.ok);
  assert.ok(noSection.out.includes(`${P2}: a new plan needs numbered tasks: the "## Tasks" section needs at least one numbered task`), noSection.out);
  assert.ok(!noSection.out.includes('001-app-shell.md'), noSection.out);
  const proseOnly = check(good.replace(TASKS, '## Tasks\n\nBuild it all in one go.\n\n'));
  assert.ok(proseOnly.out.includes('needs at least one numbered task'), proseOnly.out);
  const gap = check(good.replace('2. Wire the tabs', '3. Wire the tabs'));
  assert.ok(gap.out.includes('are numbered 1, 3; number them 1, 2, 3 in order, with no gaps or repeats'), gap.out);
  const repeat = check(good.replace('2. Wire the tabs', '1. Wire the tabs'));
  assert.ok(repeat.out.includes('are numbered 1, 1;'), repeat.out);
  const withIntro = check(good.replace('## Tasks\n\n', '## Tasks\n\nAll tasks run in order on one branch.\n\n'));
  assert.ok(withIntro.ok, withIntro.out);
  assert.ok(check(good).ok);
});

test('git: a builder writes its own log; another slice log fails', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, LOG, '# 001 log\n\n## 2026-11-03 builder\n\nDone.\n');
  git(root, 'add', '-A');
  const good = runChecker(root, ['--staged']);
  assert.ok(good.ok, good.out);
  write(root, 'docs/plans/logs/002-theme.md', '# 002 log\n');
  git(root, 'add', '-A');
  const bad = runChecker(root, ['--staged']);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes("docs/plans/logs/002-theme.md: this build branch may only add to or change its own slice's log"), bad.out);
});

test('reads git -z output, including renames and names with spaces or accents', () => {
  const out = 'M\0src/a b.ts\0R100\0docs/handoff.md\0x.md\0A\0docs/decisions/004-café.md\0';
  assert.deepEqual(parseNameStatus(out), [
    { status: 'M', path: 'src/a b.ts' },
    { status: 'R', oldPath: 'docs/handoff.md', path: 'x.md' },
    { status: 'A', path: 'docs/decisions/004-café.md' },
  ]);
});

// ---------- The real checker inside throwaway git repos ----------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRepo(extra = {}) {
  const root = makeDir({
    'AGENTS.md': '# Map\n',
    'docs/handoff.md': '# Handoff\n',
    'docs/plans/active/001-app-shell.md': plan({ status: 'in_progress', builder: 'claude/claude-opus-5-5' }),
    'docs/roadmap.md': ROADMAP_001,
    ...extra,
  });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(CHECKER, join(root, 'scripts/check-plans.mjs'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

// Runs the checker as a separate program, the way the hook does. Returns { ok, out }.
function runChecker(root, args = [], env = {}) {
  const clean = { ...process.env };
  for (const k of ['GITHUB_HEAD_REF', 'GITHUB_BASE_REF', 'GITHUB_REF_NAME']) delete clean[k];
  const r = spawnSync(process.execPath, ['scripts/check-plans.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...clean, ...env } });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
}

const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

test('git: on main, lead edits are allowed', () => {
  const root = makeRepo();
  write(root, 'AGENTS.md', '# Map\nNew rule.\n');
  const r = runChecker(root);
  assert.ok(r.ok, r.out);
});

test('git: a builder may add code and write its progress log, but not touch lead files', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, 'src/a.ts', 'export {};\n');
  const planText = readFileSync(join(root, P), 'utf8').replace('- 2026-11-02: started', '- 2026-11-02: started\n- 2026-11-03: done');
  write(root, P, planText);
  git(root, 'add', '-A');
  const good = runChecker(root);
  assert.ok(good.ok, good.out);

  write(root, 'AGENTS.md', '# Map\nSneaky.\n');
  const bad = runChecker(root);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes('AGENTS.md: builders may not change this file'));
});

test('git: a build branch needs a matching plan that has started', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'build/999-no-plan');
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  const noPlan = runChecker(root, ['--staged']);
  assert.ok(!noPlan.ok);
  assert.ok(noPlan.out.includes('has no matching plan'), noPlan.out);

  git(root, 'checkout', '-q', 'main');
  write(root, P, readFileSync(join(root, P), 'utf8').replace('status: in_progress', 'status: todo'));
  git(root, 'commit', '-qam', 'back to todo');
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  const notStarted = runChecker(root);
  assert.ok(!notStarted.ok);
  assert.ok(notStarted.out.includes('must set it to in_progress'), notStarted.out);
});

test('git: renames and accented file names in lead folders are caught', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  renameSync(join(root, 'docs/handoff.md'), join(root, 'docs/old-handoff.md'));
  write(root, 'docs/decisions/004-café.md', '# x\n');
  git(root, 'add', '-A');
  const r = runChecker(root);
  assert.ok(!r.ok);
  assert.ok(r.out.includes('docs/handoff.md: builders may not'), r.out);
  assert.ok(r.out.includes('docs/decisions/004-café.md: builders may not'), r.out);
});

test('git: --staged checks what will be committed, not what is on disk', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, 'AGENTS.md', '# Map\nSneaky.\n');
  git(root, 'add', 'AGENTS.md');
  write(root, 'AGENTS.md', '# Map\n'); // disk looks clean again, but the bad version is staged
  assert.ok(!runChecker(root, ['--staged']).ok);

  git(root, 'reset', '-q');
  write(root, 'AGENTS.md', '# Map\nUnstaged.\n'); // bad edit only on disk, not staged
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', 'src/a.ts');
  const r = runChecker(root, ['--staged']);
  assert.ok(r.ok, r.out);
});

test('git: a builder is not blamed for lead changes already on origin/main', () => {
  const root = makeRepo();
  const first = git(root, 'rev-parse', 'HEAD');
  write(root, 'AGENTS.md', '# Map\nLead rule.\n');
  git(root, 'commit', '-qam', 'lead change');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  git(root, 'update-ref', 'refs/heads/main', first); // local main is now behind the shared copy
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  const r = runChecker(root);
  assert.ok(r.ok, r.out);
});

test('git: merging origin/main into a build branch does not blame the builder for lead changes', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'builder work');
  git(root, 'checkout', '-q', 'main');
  write(root, 'AGENTS.md', '# Map\nLead rule.\n');
  git(root, 'commit', '-qam', 'lead change');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-q', 'build/001-app-shell');
  git(root, 'merge', '--no-commit', '--no-ff', '-q', 'origin/main');
  const merging = runChecker(root, ['--staged']);
  assert.ok(merging.ok, merging.out);

  // A lead edit the builder adds inside the merge is still caught.
  write(root, 'docs/handoff.md', '# Handoff\nSneaky.\n');
  git(root, 'add', 'docs/handoff.md');
  const sneaky = runChecker(root, ['--staged']);
  assert.ok(!sneaky.ok);
  assert.ok(sneaky.out.includes('docs/handoff.md: builders may not'), sneaky.out);
});

test('git: merging a branch that is not on main still catches its lead edits', () => {
  const root = makeRepo();
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-qb', 'side');
  write(root, 'AGENTS.md', '# Map\nSide rule.\n');
  git(root, 'commit', '-qam', 'side lead change');
  git(root, 'checkout', '-q', 'main');
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  git(root, 'merge', '--no-commit', '--no-ff', '-q', 'side');
  const r = runChecker(root, ['--staged']);
  assert.ok(!r.ok);
  assert.ok(r.out.includes('AGENTS.md: builders may not'), r.out);
});

test('git: in a GitHub pull request, the branch and base come from GitHub settings', () => {
  const root = makeRepo();
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-q', '--detach');
  write(root, 'docs/handoff.md', '# Handoff\nChanged.\n');
  git(root, 'commit', '-qam', 'pr change');
  const pr = runChecker(root, [], { GITHUB_HEAD_REF: 'build/001-app-shell', GITHUB_BASE_REF: 'main' });
  assert.ok(!pr.ok);
  assert.ok(pr.out.includes('docs/handoff.md: builders may not'), pr.out);
  const push = runChecker(root, [], { GITHUB_REF_NAME: 'main' });
  assert.ok(push.ok, push.out);
});

test('git: settings file changes the base branch and build prefix, and is itself lead-only', () => {
  const settings = JSON.stringify({ baseBranch: 'trunk', buildPrefix: 'feature/' });
  const root = makeRepo({ [CONFIG_FILE]: settings });
  git(root, 'branch', '-m', 'main', 'trunk');
  git(root, 'checkout', '-qb', 'feature/001-app-shell');
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  const good = runChecker(root, ['--staged']);
  assert.ok(good.ok, good.out);

  write(root, CONFIG_FILE, JSON.stringify({ baseBranch: 'trunk', buildPrefix: 'feature/', sameModelReviewSlices: [1] }));
  git(root, 'add', '-A');
  const bad = runChecker(root, ['--staged']);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes(`${CONFIG_FILE}: builders may not change this file`), bad.out);
});

test('git: a broken settings file stops the run with a clear message', () => {
  const root = makeRepo({ [CONFIG_FILE]: '{"buildPrefx": "build/"}' });
  const r = runChecker(root);
  assert.ok(!r.ok);
  assert.ok(r.out.includes('unknown setting "buildPrefx"'), r.out);
});

// ---------- Settings added with the kit's scripts (models, checks, branch names) ----------

test('settings: new keys have defaults, and models adds to the defaults like lineLimits', () => {
  assert.equal(CONFIG_FILE, 'scripts/kit.config.json');
  assert.deepEqual(DEFAULT_CONFIG.leadPrefixes, ['lead/']);
  assert.equal(DEFAULT_CONFIG.researchPrefix, 'research/');
  assert.equal(DEFAULT_CONFIG.researchDir, 'docs/research/');
  assert.equal(DEFAULT_CONFIG.inbox, 'docs/awaiting-decisions.md');
  assert.deepEqual(DEFAULT_CONFIG.paperworkPaths, ['docs/', 'AGENTS.md']);
  assert.equal(DEFAULT_CONFIG.staleMinutes, 90);
  const config = mergeConfig({ models: { builder: 'claude/claude-opus-5-5' } });
  assert.deepEqual(config.models, { headAgent: [], builder: 'claude/claude-opus-5-5', reviewer: '' });
  assert.deepEqual(DEFAULT_CONFIG.models, { headAgent: [], builder: '', reviewer: '' }, 'the defaults are not changed by merging');
});

test('settings: models fail loud on an unknown key, a bad model name, or a reviewer that shares a model', () => {
  assert.throws(() => mergeConfig({ models: { critic: 'a/b' } }), /"models" has unknown key "critic"/);
  assert.throws(() => mergeConfig({ models: [] }), /wrong type/);
  assert.throws(() => mergeConfig({ models: { headAgent: 'claude/claude-opus-5-5' } }), /"models.headAgent" must be a list/);
  assert.throws(() => mergeConfig({ models: { headAgent: ['claude-opus-5-5'] } }), /"models.headAgent" must be a list of tool\/model-id/);
  assert.throws(() => mergeConfig({ models: { builder: 'opus' } }), /"models.builder" must look like tool\/model-id/);
  assert.throws(() => mergeConfig({ models: { builder: 'claude/x', reviewer: 'cursor/x' } }), /are both the model "x"/);
  assert.throws(() => mergeConfig({ models: { headAgent: ['claude/x'], builder: 'claude/y', reviewer: 'codex/x' } }), /also a head agent model/);
  const ok = mergeConfig({ models: { headAgent: ['claude/x', 'codex/w'], builder: 'claude/x', reviewer: 'codex/z' } });
  assert.equal(ok.models.reviewer, 'codex/z', 'the head agent and builder may share a model');
});

test('settings: checks entries are name, run, and an optional slot, with unique names', () => {
  const checks = [{ name: 'lint', run: 'pnpm lint' }, { name: 'test', run: 'pnpm test', slot: true }];
  assert.deepEqual(mergeConfig({ checks }).checks, checks);
  assert.throws(() => mergeConfig({ checks: {} }), /wrong type/);
  assert.throws(() => mergeConfig({ checks: ['pnpm test'] }), /entry 1 must be an object/);
  assert.throws(() => mergeConfig({ checks: [{ name: 'test' }] }), /needs a "run" command/);
  assert.throws(() => mergeConfig({ checks: [{ run: 'pnpm test' }] }), /needs a "name"/);
  assert.throws(() => mergeConfig({ checks: [{ name: 'test', run: 'pnpm test', slot: 'yes' }] }), /"slot" must be true or false/);
  assert.throws(() => mergeConfig({ checks: [{ name: 'test', run: 'pnpm test', timeout: 5 }] }), /unknown key "timeout"/);
  assert.throws(() => mergeConfig({ checks: [{ name: 'test', run: 'a' }, { name: 'test', run: 'b' }] }), /two entries named "test"/);
});

test('settings: branch prefixes, the research folder, paths, and staleMinutes are checked', () => {
  assert.throws(() => mergeConfig({ leadPrefixes: ['lead'] }), /"leadPrefixes" must list prefixes that end with "\/"/);
  assert.throws(() => mergeConfig({ researchPrefix: 'research' }), /"researchPrefix" must end with "\/"/);
  assert.throws(() => mergeConfig({ researchDir: 'docs/research' }), /"researchDir" must end with "\/"/);
  assert.throws(() => mergeConfig({ paperworkPaths: [''] }), /"paperworkPaths" must list paths/);
  assert.throws(() => mergeConfig({ paperworkPaths: 'docs/' }), /wrong type/);
  assert.deepEqual(DEFAULT_CONFIG.checkSettingsPaths, []);
  assert.deepEqual(mergeConfig({ checkSettingsPaths: ['tooling/lint.json'] }).checkSettingsPaths, ['tooling/lint.json']);
  assert.throws(() => mergeConfig({ checkSettingsPaths: [''] }), /"checkSettingsPaths" must list paths/);
  assert.throws(() => mergeConfig({ checkSettingsPaths: 'tooling/' }), /wrong type/);
  assert.throws(() => mergeConfig({ staleMinutes: -1 }), /"staleMinutes" must be a number of minutes/);
  assert.throws(() => mergeConfig({ staleMinutes: '90' }), /wrong type/);
  assert.throws(() => mergeConfig({ inbox: 5 }), /wrong type/);
});

// ---------- The reviewer must differ from the head agent's model ----------

test('a live slice may not be reviewed by a head agent model; finished and excepted slices are left alone', () => {
  const config = mergeConfig({ models: { headAgent: ['claude/claude-opus-5-5'] }, sameModelReviewSlices: [72] });
  const live = { builder: 'codex/gpt-6.1-sol', reviewer: 'cursor/claude-opus-5-5' };
  for (const status of ['in_progress', 'in_review']) {
    assert.ok(has(errorsFor(plan({ status, ...live }), '001-app-shell.md', 'active', config), 'also a head agent model'), status);
  }
  assert.deepEqual(errorsFor(plan({ status: 'in_review', ...live }), '001-app-shell.md', 'active'), [], 'no head agent models set means no rule');
  assert.deepEqual(errorsFor(plan({ status: 'in_review', builder: 'codex/gpt-6.1-sol', reviewer: 'x/other-model' }), '001-app-shell.md', 'active', config), []);
  assert.deepEqual(errorsFor(plan({ status: 'todo', ...live }), '001-app-shell.md', 'active', config), [], 'not live yet');
  const done = { ...DONE, ...live, review: 'Review: approved by cursor/claude-opus-5-5 on 2026-11-02' };
  assert.deepEqual(errorsFor(plan(done), '001-app-shell.md', 'completed', config), [], 'done plans are not re-judged');
  assert.deepEqual(errorsFor(plan({ id: 72, status: 'in_review', ...live }), '072-cleanup-pass.md', 'active', config), [], 'the owner allowed slice 72');
});

// ---------- Branch classes: a branch the checker does not know gets limits ----------

test('branch classes: lead, build, research, and everything else', () => {
  assert.equal(classifyBranch('main'), 'lead');
  assert.equal(classifyBranch('lead/handoff'), 'lead');
  assert.equal(classifyBranch('build/001-app-shell'), 'build');
  assert.equal(classifyBranch('research/2026-11-11-databases'), 'research');
  assert.equal(classifyBranch('t3/some-thread'), 'other');
  assert.equal(classifyBranch('leader'), 'other', 'a prefix must match as written');
  assert.equal(classifyBranch(''), 'other', 'a detached HEAD has no name');
  const config = mergeConfig({ baseBranch: 'trunk', leadPrefixes: ['head/', 'lead/'] });
  assert.equal(classifyBranch('trunk', config), 'lead');
  assert.equal(classifyBranch('head/x', config), 'lead');
  assert.equal(classifyBranch('main', config), 'other');
});

test('a research branch may only add or change files in the research folder', () => {
  const research = (changes) => checkResearchChanges({ branch: 'research/2026-11-11-db', changes });
  assert.deepEqual(research([{ status: 'A', path: 'docs/research/2026-11-11-db.md' }, { status: 'M', path: 'docs/research/old.md' }]), []);
  assert.ok(has(research([{ status: 'A', path: 'src/a.ts' }]), 'src/a.ts: research branch research/2026-11-11-db may only add or change files under docs/research/'));
  assert.ok(has(research([{ status: 'M', path: 'docs/roadmap.md' }]), 'docs/roadmap.md: research branch'));
  assert.ok(has(research([{ status: 'D', path: 'docs/research/old.md' }]), 'may only add or change'), 'deleting a note is not adding or changing');
  assert.ok(has(research([{ status: 'R', oldPath: 'docs/research/old.md', path: 'docs/research/new.md' }]), 'may only add or change'));
  const config = mergeConfig({ researchDir: 'notes/' });
  assert.deepEqual(checkResearchChanges({ branch: 'research/x', changes: [{ status: 'A', path: 'notes/x.md' }], config }), []);
});

test('an unknown branch or a detached HEAD may change code, but no lead-only file and no plan', () => {
  const other = (changes, branch = 't3/some-thread') => checkOtherChanges({ branch, changes });
  assert.deepEqual(other([{ status: 'A', path: 'src/a.ts' }, { status: 'M', path: 'package.json' }]), []);
  for (const p of MUST_BE_PROTECTED) assert.ok(has(other([{ status: 'M', path: p }]), `${p}: branch "t3/some-thread" is not a lead branch`), p);
  assert.ok(has(other([{ status: 'M', path: P }]), 'is not a lead branch'), 'an active plan is locked too');
  assert.ok(has(other([{ status: 'A', path: 'docs/plans/active/009-new.md' }]), 'git switch -c lead/short-name'));
  assert.ok(has(other([{ status: 'R', oldPath: 'docs/handoff.md', path: 'notes.md' }]), 'docs/handoff.md:'), 'renames are checked on both sides');
  assert.ok(has(other([{ status: 'M', path: 'AGENTS.md' }], ''), 'a detached HEAD (no branch) is not a lead branch'));
});

test('repo check: branch rules need git, except on a lead branch or with no branch at all', () => {
  const root = makeDir({ 'docs/roadmap.md': '' });
  assert.deepEqual(checkRepo(root), [], 'a plain folder with no branch has no branch rules');
  assert.deepEqual(checkRepo(root, { branch: 'lead/x' }), []);
  assert.deepEqual(checkRepo(root, { branch: 'main' }), []);
  assert.ok(has(checkRepo(root, { branch: 't3/thread' }), 'git is not available'));
  assert.ok(has(checkRepo(root, { branch: 'research/x' }), 'git is not available'));
  const lead = [{ status: 'M', path: 'AGENTS.md' }];
  assert.ok(has(checkRepo(root, { branch: '', git: () => ({ changes: lead }) }), 'a detached HEAD'));
  assert.ok(has(checkRepo(root, { branch: 'research/x', git: () => ({ changes: lead }) }), 'research branch research/x'));
  assert.deepEqual(checkRepo(root, { branch: 'lead/x', git: () => { throw new Error('a lead branch must not be compared'); } }), []);
});

test('git: a research branch passes with only its note, and fails when it touches anything else', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'research/2026-11-11-databases');
  write(root, 'docs/research/2026-11-11-databases.md', '# Databases\n');
  git(root, 'add', '-A');
  const good = runChecker(root, ['--staged']);
  assert.ok(good.ok, good.out);
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  const bad = runChecker(root, ['--staged']);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes('src/a.ts: research branch research/2026-11-11-databases may only add or change files under docs/research/'), bad.out);
});

test('git: a branch with an unknown name may add code but not touch lead files or plans', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 't3/some-thread');
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  const good = runChecker(root);
  assert.ok(good.ok, good.out);

  write(root, 'AGENTS.md', '# Map\nSneaky.\n');
  write(root, P, readFileSync(join(root, P), 'utf8').replace('- 2026-11-02: started', '- 2026-11-02: started\n- 2026-11-03: more'));
  const bad = runChecker(root);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes('AGENTS.md: branch "t3/some-thread" is not a lead branch'), bad.out);
  assert.ok(bad.out.includes(`${P}: branch "t3/some-thread" is not a lead branch`), bad.out);

  git(root, 'checkout', '-q', '-b', 'lead/fix');
  const lead = runChecker(root);
  assert.ok(lead.ok, lead.out);
});

test('git: a detached HEAD is not a lead branch', () => {
  const root = makeRepo();
  git(root, 'checkout', '-q', '--detach');
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  const good = runChecker(root, ['--staged']);
  assert.ok(good.ok, good.out);
  write(root, 'docs/handoff.md', '# Handoff\nChanged.\n');
  git(root, 'add', '-A');
  const bad = runChecker(root, ['--staged']);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes('docs/handoff.md: a detached HEAD (no branch) is not a lead branch'), bad.out);
});

test('git: a lead branch stopped in the middle of a rebase is still a lead branch', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'lead/handoff');
  write(root, 'docs/handoff.md', '# Handoff\nNew state.\n');
  git(root, 'commit', '-qam', 'handoff');
  // "-x false" runs a failing command after the commit is replayed, so the rebase stops with HEAD detached.
  spawnSync('git', ['rebase', '-x', 'false', 'HEAD~1'], { cwd: root, encoding: 'utf8' });
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root }).status, 1, 'the test needs a detached HEAD');
  write(root, 'AGENTS.md', '# Map\nLead rule.\n');
  const r = runChecker(root);
  assert.ok(r.ok, r.out);
});

test('git: lead branch prefixes come from settings', () => {
  const root = makeRepo({ [CONFIG_FILE]: JSON.stringify({ leadPrefixes: ['head/'] }) });
  git(root, 'checkout', '-qb', 'head/handoff');
  write(root, 'AGENTS.md', '# Map\nLead rule.\n');
  const ok = runChecker(root);
  assert.ok(ok.ok, ok.out);
  git(root, 'checkout', '-qb', 'lead/handoff');
  const bad = runChecker(root);
  assert.ok(!bad.ok, 'lead/ is no longer a lead prefix in this repo');
  assert.ok(bad.out.includes('is not a lead branch'), bad.out);
});

// ---------- Reading git, not the disk ----------

test('the em dash check skips library and build folders, and folders the settings name', () => {
  assert.ok(isSkippedMarkdown('node_modules/pkg/README.md'));
  assert.ok(isSkippedMarkdown('apps/mobile/dist/notes.md'));
  assert.ok(!isSkippedMarkdown('docs/build.md'), 'only folder names count, not file names');
  assert.ok(isSkippedMarkdown('docs/quotes/readme.md', ['docs/quotes']));
  assert.ok(isSkippedMarkdown('docs/quotes/deep/readme.md', ['docs/quotes/']));
  assert.ok(!isSkippedMarkdown('docs/quotes-2/readme.md', ['docs/quotes']));
});

test('git: Markdown in a folder git ignores is never scanned; new Markdown git does not ignore is', () => {
  const root = makeRepo({ '.gitignore': 'Pods/\n', 'Pods/Lib/README.md': `outside ${EM} text\n` });
  const ignored = runChecker(root);
  assert.ok(ignored.ok, ignored.out);
  const staged = runChecker(root, ['--staged']);
  assert.ok(staged.ok, staged.out);

  write(root, 'docs/new-note.md', `mine ${EM} not committed yet\n`);
  const fresh = runChecker(root);
  assert.ok(!fresh.ok);
  assert.ok(fresh.out.includes('docs/new-note.md:1: has an em dash'), fresh.out);
  assert.ok(!fresh.out.includes('Pods'), fresh.out);
});

test('git: --staged reads git for what it needs: listed files, line limits, and em dashes', () => {
  const settings = JSON.stringify({ lineLimits: { 'notes.txt': 2 } });
  const withCode = plan({ status: 'in_progress', builder: 'claude/claude-opus-5-5', code: '[src/a.ts]', tests: '[src]' });
  const root = makeRepo({ [CONFIG_FILE]: settings, 'src/a.ts': 'export {};\n', 'notes.txt': 'a\nb\n', [P]: withCode });
  const clean = runChecker(root, ['--staged']);
  assert.ok(clean.ok, clean.out);

  git(root, 'rm', '-q', '--cached', 'src/a.ts'); // staged for deletion, still on disk
  write(root, 'notes.txt', 'a\nb\nc\n');
  write(root, 'docs/note.md', `one ${EM} two\n`);
  git(root, 'add', 'notes.txt', 'docs/note.md');
  write(root, 'notes.txt', 'a\nb\n'); // disk looks fine again
  write(root, 'docs/note.md', 'one, two\n');
  const bad = runChecker(root, ['--staged']);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes('"code" lists src/a.ts, but that file does not exist'), bad.out);
  assert.ok(bad.out.includes('notes.txt has 3 lines'), bad.out);
  assert.ok(bad.out.includes('docs/note.md:1: has an em dash'), bad.out);
  const disk = runChecker(root);
  assert.ok(disk.ok, disk.out);
});

// ---------- Command line: --root, --branch, and a trusted copy of the checker ----------

test('command line: unknown options fail loud, and --root and --branch need a value', () => {
  assert.equal(CHECKER_API, 3);
  assert.deepEqual(parseCli([]), { staged: false, status: false, fetch: true, root: null, branch: null, base: null });
  assert.deepEqual(parseCli(['--staged', '--root', '/x', '--branch', 'build/001-a', '--base', 'origin/main']), { staged: true, status: false, fetch: true, root: '/x', branch: 'build/001-a', base: 'origin/main' });
  assert.deepEqual(parseCli(['--status', '--no-fetch']), { staged: false, status: true, fetch: false, root: null, branch: null, base: null });
  assert.throws(() => parseCli(['--stagd']), /unknown option "--stagd"/);
  assert.throws(() => parseCli(['--root']), /--root needs a value/);
  assert.throws(() => parseCli(['--branch', '--staged']), /--branch needs a value/);
  assert.throws(() => parseCli(['--base']), /--base needs a value/);
  const r = runChecker(makeRepo(), ['--stagd']);
  assert.ok(!r.ok);
  assert.ok(r.out.includes('unknown option'), r.out);
});

test('git: a copy of the checker kept outside the repo checks it with --root and --branch', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'lead/local-name');
  write(root, 'AGENTS.md', '# Map\nSneaky.\n');
  // The branch empties its own copy of the checker; the trusted copy does not care.
  write(root, 'scripts/check-plans.mjs', '// rules switched off\n');
  const outside = mkdtempSync(join(tmpdir(), 'rule-check-trusted-'));
  copyFileSync(CHECKER, join(outside, 'check-plans.mjs'));
  const run = (...args) => {
    const r = spawnSync(process.execPath, [join(outside, 'check-plans.mjs'), '--root', root, ...args], { cwd: outside, encoding: 'utf8' });
    return { ok: r.status === 0, out: r.stdout + r.stderr };
  };
  const asLead = run();
  assert.ok(asLead.ok, asLead.out);
  assert.ok(asLead.out.includes('Rule checks passed'), 'the copy must really run, not exit quietly');
  const asBuilder = run('--branch', 'build/001-app-shell');
  assert.ok(!asBuilder.ok);
  assert.ok(asBuilder.out.includes('AGENTS.md: builders may not change this file'), asBuilder.out);
  assert.ok(asBuilder.out.includes('scripts/check-plans.mjs: builders may not change this file'), asBuilder.out);
});

// ---------- Starter kit manifest: managed files are not edited in a project ----------

const fingerprint = (text) => createHash('sha256').update(text).digest('hex');
const manifestOf = (files) => JSON.stringify({ kit: 'starter-kit', kitCommit: 'abc1234', updatedAt: '2026-11-11', files });

test('manifest: a managed file that changed or went missing is an error; no manifest means no check', () => {
  const store = (files) => (p) => (p in files ? Buffer.from(files[p]) : null);
  assert.deepEqual(checkManifest(store({})), []);
  const guide = '# Head agent\n';
  const manifest = manifestOf({ 'docs/agents/head-agent.md': fingerprint(guide), 'scripts/slot.mjs': fingerprint('slot\n') });
  assert.deepEqual(checkManifest(store({ [MANIFEST_FILE]: manifest, 'docs/agents/head-agent.md': guide, 'scripts/slot.mjs': 'slot\n' })), []);
  const errors = checkManifest(store({ [MANIFEST_FILE]: manifest, 'docs/agents/head-agent.md': `${guide}Local rule.\n` }));
  assert.ok(has(errors, 'docs/agents/head-agent.md: this file is managed by the starter kit and was changed here. Put project changes in docs/project-rules.md'));
  assert.ok(has(errors, 'scripts/slot.mjs: this file is managed by the starter kit and is missing'));
  assert.ok(has(errors, 'kit/sync.mjs'));
});

test('manifest: a broken manifest fails loud', () => {
  const only = (text) => checkManifest((p) => (p === MANIFEST_FILE ? Buffer.from(text) : null));
  assert.ok(has(only('{ not json'), 'scripts/kit.manifest.json is not valid JSON'));
  assert.ok(has(only('[]'), 'is broken'));
  assert.ok(has(only(JSON.stringify({ kit: 'other-kit', files: {} })), 'is broken'));
  assert.ok(has(only(JSON.stringify({ kit: 'starter-kit' })), 'is broken'));
  assert.ok(has(only(manifestOf({ 'a.md': 'abc' })), 'the fingerprint for a.md is not a sha256'));
  assert.deepEqual(only(manifestOf({})), []);
});

test('git: the manifest check runs on disk and on staged content', () => {
  const guide = '# Head agent\n';
  const tool = '// slot\n';
  const root = makeRepo({
    'docs/agents/head-agent.md': guide,
    'scripts/slot.mjs': tool,
    [MANIFEST_FILE]: manifestOf({ 'docs/agents/head-agent.md': fingerprint(guide), 'scripts/slot.mjs': fingerprint(tool) }),
  });
  const clean = runChecker(root);
  assert.ok(clean.ok, clean.out);
  assert.ok(runChecker(root, ['--staged']).ok);

  write(root, 'scripts/slot.mjs', '// slot, weakened\n');
  git(root, 'add', 'scripts/slot.mjs');
  write(root, 'scripts/slot.mjs', tool); // the disk copy is put back, but the changed one is staged
  write(root, 'docs/agents/head-agent.md', `${guide}Local rule.\n`); // changed on disk only
  const staged = runChecker(root, ['--staged']);
  assert.ok(!staged.ok);
  assert.ok(staged.out.includes('scripts/slot.mjs: this file is managed by the starter kit and was changed here'), staged.out);
  assert.ok(!staged.out.includes('head-agent.md'), staged.out);
  const disk = runChecker(root);
  assert.ok(!disk.ok);
  assert.ok(disk.out.includes('docs/agents/head-agent.md: this file is managed by the starter kit and was changed here'), disk.out);
  assert.ok(!disk.out.includes('scripts/slot.mjs'), disk.out);
});

// ---------- Where the project stands (--status) ----------

const INBOX = `# Awaiting Decisions

Status: loop running

## Your to-do

Things only the owner can do.

<!-- Item format:
- YYYY-MM-DD, slice NNN, **short title**: what he must do.
-->

- 2026-11-10, slice 026, **Log in**: run \`eas login\`.
  - a detail line under the item
- 2026-11-09, slice 020, **Pay**: add a card.

## To review

- 2026-11-10, slice 030, **Chose tabs** (head agent). Undo: revert pull request 12.

## Decided, to apply

<!-- - 2026-11-01, **hidden**: an item inside a comment is not counted -->
`;

test('status: the inbox counter counts top-level items and ignores comments', () => {
  assert.deepEqual(countInbox(INBOX), { todo: 2, review: 1, decided: 0 });
  assert.deepEqual(countInbox(`${INBOX}\n- 2026-11-11, **Use tabs**: yes.\n`), { todo: 2, review: 1, decided: 1 });
  assert.deepEqual(countInbox('# Empty\n'), { todo: 0, review: 0, decided: 0 });
});

test('status: the first roadmap row with no plan link is the next one to plan', () => {
  const roadmap = `# Roadmap

<!-- | 999 | A row inside a comment | | -->

| # | Slice | Plan |
|---|---|---|
| 000 | Foundation | [plan](plans/completed/000-foundation.md) |
| 001 | Save a word | [plan](plans/active/001-save-word.md) |
| 002 | Review words | |
| 003 | Share a list | |
`;
  assert.equal(firstUnplannedRow(roadmap), '002 | Review words');
  assert.equal(firstUnplannedRow(roadmap.replace('| 002 | Review words | |\n| 003 | Share a list | |\n', '')), null);
});

const entry = (file, header, folder = 'active') => ({ file, folder, path: `docs/plans/${folder}/${file}`, header: { depends_on: [], ...header } });

test('status: a live slice with no build branch ahead is stalled; one with a branch ahead is held', () => {
  const plans = [
    entry('000-foundation.md', { id: 0, status: 'done' }, 'completed'),
    entry('001-save-word.md', { id: 1, status: 'in_progress' }),
    entry('002-review-words.md', { id: 2, status: 'in_review' }),
    entry('003-share.md', { id: 3, status: 'blocked' }),
    entry('004-export.md', { id: 4, status: 'todo' }),
  ];
  const branches = [{ name: 'build/002-review-words', ahead: 3 }, { name: 'build/002-review-words-2', ahead: 1 }, { name: 'lead/handoff', ahead: 1 }, { name: 'dependabot/x', ahead: 2 }];
  const report = buildStatus({ plans, order: plans.map((p) => p.path), branches });
  assert.deepEqual(report.live.map((s) => [s.slice, s.status, s.stalled]), [['001', 'in_progress', true], ['002', 'in_review', false], ['003', 'blocked', false]]);
  assert.deepEqual(report.live[1].branches.map((b) => b.name), ['build/002-review-words', 'build/002-review-words-2']);
  assert.deepEqual(report.next, { slice: '004', path: 'docs/plans/active/004-export.md' });
  assert.deepEqual(report.open.map((b) => b.name), ['build/002-review-words', 'build/002-review-words-2', 'lead/handoff'], 'only lead, build, and research branches are listed');

  const lines = formatStatus({ report }).join('\n');
  assert.ok(lines.includes('001 in_progress  docs/plans/active/001-save-word.md  STALLED'), lines);
  assert.ok(lines.includes('002 in_review  docs/plans/active/002-review-words.md  build/002-review-words (+3), build/002-review-words-2 (+1)'), lines);
  assert.ok(lines.includes('Next free slice: 004'), lines);
});

test('status: a parked slice is listed by name, is never stalled, and is never the next free slice', () => {
  const plans = [entry('001-save-word.md', { id: 1, status: 'parked' }), entry('002-share.md', { id: 2, status: 'todo' })];
  const report = buildStatus({ plans, order: plans.map((p) => p.path) });
  assert.deepEqual(report.live.map((s) => [s.slice, s.status, s.stalled]), [['001', 'parked', false]]);
  assert.equal(report.next.slice, '002');
  assert.ok(formatStatus({ report }).join('\n').includes('  001 parked  docs/plans/active/001-save-word.md'));
  assert.equal(buildStatus({ plans: plans.slice(0, 1), order: [plans[0].path] }).next, null);
});

test('status: a slice whose dependency is not done is skipped, and "none" says why', () => {
  const plans = [
    entry('001-save-word.md', { id: 1, status: 'in_progress' }),
    entry('002-review-words.md', { id: 2, status: 'todo', depends_on: [1] }),
    entry('003-share.md', { id: 3, status: 'todo' }),
  ];
  const order = plans.map((p) => p.path);
  assert.equal(buildStatus({ plans, order }).next.slice, '003', 'roadmap order, skipping the one that waits');
  const none = buildStatus({ plans: plans.slice(0, 2), order });
  assert.equal(none.next, null);
  assert.ok(none.why.includes('002 waits on 1'), none.why);
  assert.ok(formatStatus({ report: none }).join('\n').includes('Next free slice: none, every todo plan waits'));
  assert.equal(buildStatus({ plans: plans.slice(0, 1), order }).why, 'no plan in the roadmap has status todo');
  assert.equal(buildStatus({ plans, order: [...order].reverse() }).next.slice, '003', 'the roadmap decides the order');
});

test('status: the printed report covers the base, models, inbox, and a stale last push', () => {
  const config = mergeConfig({ models: { headAgent: ['claude/claude-opus-5-5'], builder: 'claude/claude-opus-5-5', reviewer: 'codex/gpt-6.1-sol' } });
  const report = buildStatus({ plans: [], order: [] });
  const lines = formatStatus({
    report, config,
    base: { ref: 'origin/main', commit: 'abc1234', behind: 2 },
    lastPush: { ref: 'origin/build/001-save-word', subject: 'Save a word', minutes: 91 },
    inbox: { todo: 2, review: 1, decided: 1 },
    asks: { open: 3, note: null },
    unplanned: '002 | Review words',
  });
  const text = lines.join('\n');
  assert.ok(lines.length <= 25, 'the report stays short');
  assert.ok(text.includes('Base: origin/main at abc1234. Your checkout is 2 commits behind it'), text);
  assert.ok(text.includes('Models: head agent claude/claude-opus-5-5; builder claude/claude-opus-5-5; reviewer codex/gpt-6.1-sol'), text);
  assert.ok(text.includes('Live slices: none'), text);
  assert.ok(text.includes('Next to plan (roadmap row with no plan yet): 002 | Review words'), text);
  assert.ok(text.includes('Open asks for Stephen: 3 (node scripts/ask.mjs list --open)'), text);
  assert.ok(text.includes('Inbox (docs/awaiting-decisions.md): to review 1, decided to apply 1 (apply these first)'), text);
  assert.ok(!text.includes('to-do'), 'the old to-do section is not counted any more: questions for Stephen are asks');
  assert.ok(text.includes('Last push: 91 minutes ago, origin/build/001-save-word "Save a word"  STALE'), text);
  const fresh = formatStatus({ report, lastPush: { ref: 'origin/main', subject: 'x', minutes: 90 }, inbox: { todo: 0, review: 0, decided: 0 } }).join('\n');
  assert.ok(!fresh.includes('STALE'), '90 minutes is the limit, not over it');
  assert.ok(!fresh.includes('apply these first'));
  assert.ok(fresh.includes('Models: not set'));
  assert.ok(fresh.includes('Base: not found'));
});

test('git: --status prints the report from a real repo and exits 0', () => {
  const root = makeRepo({ 'docs/awaiting-decisions.md': INBOX });
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'Add the app shell');
  git(root, 'update-ref', 'refs/remotes/origin/build/001-app-shell', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  const r = runChecker(root, ['--status', '--no-fetch']);
  assert.ok(r.ok, r.out);
  assert.ok(r.out.includes('Base: origin/main at '), r.out);
  assert.ok(r.out.includes('001 in_progress  docs/plans/active/001-app-shell.md  build/001-app-shell (+1)'), r.out);
  assert.ok(r.out.includes('Next free slice: none, no plan in the roadmap has status todo'), r.out);
  assert.ok(r.out.includes('Open branches, not merged: build/001-app-shell (+1)'), r.out);
  assert.ok(r.out.includes('Open asks for Stephen: 0 (no event log yet)'), r.out);
  assert.ok(r.out.includes('Inbox (docs/awaiting-decisions.md): to review 1, decided to apply 0'), r.out);
  assert.ok(r.out.includes('ago, origin/build/001-app-shell "Add the app shell"'), r.out);
  assert.ok(r.out.trim().split('\n').length <= 25, r.out);

  const fetched = runChecker(root, ['--status']); // there is no remote to fetch from: say so, and still report
  assert.ok(fetched.ok, fetched.out);
  assert.ok(fetched.out.includes('could not fetch from origin'), fetched.out);
});

// ---------- Whose settings count: a branch cannot loosen its own rules ----------

test('settings choice: the class comes from the trusted settings, and only a lead gets the proposed ones', () => {
  const trusted = mergeConfig({});
  const proposed = mergeConfig({ leadPrefixes: ['lead/', 'build/'], sameModelReviewSlices: [1] });
  assert.deepEqual(chooseConfig({ branch: 'build/001-app-shell', proposed, trusted }), { kind: 'build', config: trusted }, 'a builder cannot name itself a lead');
  assert.deepEqual(chooseConfig({ branch: 'research/x', proposed, trusted }), { kind: 'research', config: trusted });
  assert.deepEqual(chooseConfig({ branch: 't3/thread', proposed, trusted }), { kind: 'other', config: trusted });
  assert.deepEqual(chooseConfig({ branch: '', proposed, trusted }), { kind: 'other', config: trusted });
  assert.deepEqual(chooseConfig({ branch: 'lead/settings', proposed, trusted }), { kind: 'lead', config: proposed }, 'a lead may change the settings');
  assert.deepEqual(chooseConfig({ branch: 'main', proposed, trusted }), { kind: 'lead', config: proposed });
  const moved = mergeConfig({ leadPrefixes: ['head/'] });
  assert.equal(chooseConfig({ branch: 'lead/x', proposed: moved, trusted }).kind, 'lead', 'still a lead while it drops its own prefix');
  assert.equal(chooseConfig({ branch: 'lead/x', proposed: trusted, trusted: moved }).kind, 'other', 'once the base says head/, lead/ is no lead');
});

test('repo check: a class decided by the caller wins over the branch name', () => {
  const root = makeDir({ 'docs/roadmap.md': '' });
  const lead = [{ status: 'M', path: 'AGENTS.md' }];
  assert.ok(has(checkRepo(root, { branch: 'lead/x', kind: 'other', git: () => ({ changes: lead }) }), 'is not a lead branch'));
  assert.deepEqual(checkRepo(root, { branch: 't3/x', kind: 'lead', git: () => ({ changes: lead }) }), []);
});

test('git: a build branch that adds its own prefix to leadPrefixes is still a build branch', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, CONFIG_FILE, JSON.stringify({ leadPrefixes: ['lead/', 'build/'] }));
  write(root, 'docs/roadmap.md', `${ROADMAP_001}\nA row the builder added.\n`);
  git(root, 'add', '-A');
  const staged = runChecker(root, ['--staged']);
  assert.ok(!staged.ok, staged.out);
  assert.ok(staged.out.includes(`${CONFIG_FILE}: builders may not change this file`), staged.out);
  assert.ok(staged.out.includes('docs/roadmap.md: builders may not change this file'), staged.out);
  git(root, 'commit', '-qm', 'sneaky');
  const committed = runChecker(root);
  assert.ok(!committed.ok, 'still caught after it is committed');
  assert.ok(committed.out.includes('docs/roadmap.md: builders may not change this file'), committed.out);
});

test('git: a build branch cannot give itself the same-model exception; a lead branch can', () => {
  const same = plan({ status: 'in_review', builder: 'claude/claude-opus-5-5', reviewer: 'cursor/claude-opus-5-5' });
  const root = makeRepo({ [P]: same });
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, CONFIG_FILE, JSON.stringify({ sameModelReviewSlices: [1] }));
  git(root, 'add', '-A');
  const builder = runChecker(root, ['--staged']);
  assert.ok(!builder.ok);
  assert.ok(builder.out.includes('the reviewer must be a different model'), builder.out);
  assert.ok(builder.out.includes(`${CONFIG_FILE}: builders may not change this file`), builder.out);

  git(root, 'checkout', '-qb', 'lead/allow-001');
  const lead = runChecker(root, ['--staged']);
  assert.ok(lead.ok, lead.out);
});

test('git: with --base, a build branch that names itself the base branch is still compared with the real base', () => {
  const root = makeRepo();
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, CONFIG_FILE, JSON.stringify({ baseBranch: 'build/001-app-shell' }));
  write(root, 'AGENTS.md', '# Map\nSneaky.\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'sneaky');
  for (const args of [['--base', 'origin/main'], ['--base', 'origin/main', '--staged'], ['--base', 'main']]) {
    const r = runChecker(root, args);
    assert.ok(!r.ok, args.join(' '));
    assert.ok(r.out.includes('AGENTS.md: builders may not change this file'), r.out);
    assert.ok(r.out.includes(`${CONFIG_FILE}: builders may not change this file`), r.out);
  }
  const missing = runChecker(root, ['--base', 'origin/nope']);
  assert.ok(!missing.ok);
  assert.ok(missing.out.includes('--base origin/nope: git has no such ref here'), missing.out);
});

test('git: a lead branch may change the settings, and its new settings apply', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'lead/settings');
  write(root, 'docs/quotes/q.md', `a quote ${EM} kept as written\n`);
  git(root, 'add', '-A');
  const before = runChecker(root, ['--staged']);
  assert.ok(!before.ok);
  assert.ok(before.out.includes('docs/quotes/q.md:1: has an em dash'), before.out);

  write(root, CONFIG_FILE, JSON.stringify({ leadPrefixes: ['head/'], emDashSkipDirs: ['docs/quotes'] }));
  write(root, 'AGENTS.md', '# Map\nLead rule.\n');
  git(root, 'add', '-A');
  const after = runChecker(root, ['--staged']);
  assert.ok(after.ok, after.out); // the skip applies, and dropping its own prefix does not lock the lead out
  git(root, 'commit', '-qm', 'settings');
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--ff-only', 'lead/settings');

  // Once the settings are on the base, they are the trusted ones.
  git(root, 'checkout', '-qb', 'lead/later');
  write(root, 'AGENTS.md', '# Map\nLead rule.\nAnother.\n');
  const old = runChecker(root);
  assert.ok(!old.ok);
  assert.ok(old.out.includes('AGENTS.md: branch "lead/later" is not a lead branch'), old.out);
  git(root, 'checkout', '-qb', 'head/later');
  const now = runChecker(root);
  assert.ok(now.ok, now.out);
});

test('git: a first install on a lead branch passes when the base has no settings file yet', () => {
  const root = makeRepo();
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-qb', 'lead/000-foundation');
  write(root, CONFIG_FILE, JSON.stringify({
    models: { headAgent: ['claude/claude-opus-5-5'], builder: 'claude/claude-opus-5-5', reviewer: 'codex/gpt-6.1-sol' },
    checks: [{ name: 'test', run: 'pnpm test', slot: true }],
  }));
  write(root, 'AGENTS.md', '# Map\nFilled in.\n');
  git(root, 'add', '-A');
  for (const args of [['--staged'], ['--staged', '--base', 'origin/main'], []]) {
    const r = runChecker(root, args);
    assert.ok(r.ok, `${args.join(' ')}: ${r.out}`);
  }
});

test('git: broken settings on the base stop every branch except a lead branch that mends them', () => {
  const root = makeRepo({ [CONFIG_FILE]: '{"buildPrefx": "build/"}' });
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, CONFIG_FILE, '{}');
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  const builder = runChecker(root, ['--staged']);
  assert.ok(!builder.ok);
  assert.ok(builder.out.includes('the settings on main are broken'), builder.out);
  assert.ok(builder.out.includes('unknown setting "buildPrefx"'), builder.out);

  git(root, 'checkout', '-qb', 'lead/mend-settings');
  const lead = runChecker(root, ['--staged']);
  assert.ok(lead.ok, lead.out);
  assert.ok(lead.out.includes('checked with its own settings so it can mend them'), lead.out);
});

test('git: --base is the exact ref the branch is compared with, not a guess', () => {
  const root = makeRepo();
  git(root, 'update-ref', 'refs/remotes/origin/release', 'HEAD');
  write(root, 'AGENTS.md', '# Map\nLead rule.\n');
  git(root, 'commit', '-qam', 'lead change on main, after the release');
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, 'src/a.ts', 'export {};\n');
  git(root, 'add', '-A');
  const guessed = runChecker(root);
  assert.ok(guessed.ok, guessed.out);
  const exact = runChecker(root, ['--base', 'origin/release']);
  assert.ok(!exact.ok, 'compared with the release, the branch carries the AGENTS.md change');
  assert.ok(exact.out.includes('AGENTS.md: builders may not change this file'), exact.out);
});

// ---------- The claim check (features.claimCheck) ----------

const CLAIMED = plan({ status: 'in_progress', builder: 'claude/claude-opus-5-5', reviewer: 'codex/gpt-6.1-sol' });

test('claims: a claim of a slice the base branch already started is refused, once, by name; anything else passes', () => {
  const P1 = 'docs/plans/active/001-app-shell.md';
  const claim = (before, after = CLAIMED, path = P1, sha = 'abc1234def5678') => ({ sha, plans: [{ path, parents: [before], after }] });
  const onBase = (files) => Object.entries(files).map(([path, text]) => ({ path, text }));
  const refused = `${P1}: this branch claims slice 1 in commit abc1234, but the base branch already has it "in_progress": another thread claimed it first. Leave this slice: start a new lead branch from the base branch without this claim`;
  assert.deepEqual(checkClaims({ commits: [claim(plan())], basePlans: onBase({ [P1]: CLAIMED }) }), [refused]);
  assert.deepEqual(checkClaims({ commits: [claim(plan()), claim(plan(), CLAIMED, P1, 'fff0000')], basePlans: onBase({ [P1]: CLAIMED }) }), [refused], 'one error per plan');
  // A new plan file written straight as in_progress is a claim too.
  assert.equal(checkClaims({ commits: [claim(null)], basePlans: onBase({ [P1]: CLAIMED }) }).length, 1);
  // The base moved it on, or finished it into completed/.
  assert.match(checkClaims({ commits: [claim(plan())], basePlans: onBase({ [P1]: plan({ status: 'in_review', builder: 'a/b', reviewer: 'c/d' }) }) })[0] ?? '', /already has it "in_review"/);
  assert.match(checkClaims({ commits: [claim(plan())], basePlans: onBase({ 'docs/plans/completed/001-app-shell.md': plan({ ...DONE }) }) })[0] ?? '', /already has it "done"/);
  // Passes: the base has it not started (todo, blocked) or not at all; or the commit is not a claim.
  for (const base of [plan(), plan({ status: 'blocked' })]) assert.deepEqual(checkClaims({ commits: [claim(plan())], basePlans: onBase({ [P1]: base }) }), []);
  assert.deepEqual(checkClaims({ commits: [claim(plan())], basePlans: onBase({}) }), []);
  assert.deepEqual(checkClaims({ commits: [claim(CLAIMED, plan({ status: 'in_review', builder: 'a/b', reviewer: 'c/d' }))], basePlans: onBase({ [P1]: CLAIMED }) }), [], 'moving its own started slice on is not a claim');
  assert.deepEqual(checkClaims({ commits: [claim(CLAIMED, plan({ status: 'in_progress', builder: 'claude/claude-opus-5-5', reviewer: 'grok/grok-5' }))], basePlans: onBase({ [P1]: CLAIMED }) }), [], 'editing a slice already in_progress is not a claim');
  assert.deepEqual(checkClaims({ commits: [claim(plan(), plan({ status: 'blocked' }))], basePlans: onBase({ [P1]: CLAIMED }) }), []);
});

// Two head agent threads claim slice 001 from the same main. The first merges; the second merges main in,
// as scripts/merge-pr.mjs does, and is checked against origin/main the way the merge script checks it.
// firstPath: where the first thread's claim puts the plan (a rename). resolution: what the second thread
// writes when the merge conflicts (default: its own claim).
function claimRace({ flag = true, second = CLAIMED, firstPath = null, resolution = second } = {}) {
  const root = makeRepo({ 'docs/plans/active/001-app-shell.md': plan(), [CONFIG_FILE]: JSON.stringify({ features: { claimCheck: flag } }) });
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const claimOn = (branch, text, date, path = 'docs/plans/active/001-app-shell.md') => {
    git(root, 'checkout', '-q', '-b', branch, 'origin/main');
    if (path !== 'docs/plans/active/001-app-shell.md') {
      git(root, 'mv', 'docs/plans/active/001-app-shell.md', path);
      write(root, 'docs/roadmap.md', ROADMAP_001.replace('001-app-shell', '001-new-name'));
      text = text.replace('code: []\n', `code: []\nlog: docs/plans/logs/001-new-name.md\n${NEW_FIELDS}`).replace(/## Progress log[^]*?## Review/, `${TASKS}## Review`);
    }
    write(root, path, text);
    git(root, 'commit', '-qam', 'Claim slice 001', `--date=${date}`);
  };
  claimOn('lead/claim-a', CLAIMED, '2026-11-15T10:01:00', firstPath ?? undefined);
  const first = runChecker(root, ['--base', 'origin/main']);
  claimOn('lead/claim-b', second, '2026-11-15T10:02:00');
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', '--no-edit', 'lead/claim-a');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-q', 'lead/claim-b');
  const merged = spawnSync('git', ['merge', '-q', '--no-edit', 'origin/main'], { cwd: root, encoding: 'utf8' }).status === 0;
  if (!merged) {
    // The near case: the second thread "fixes" the conflict by keeping its own claim.
    for (const f of git(root, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)) git(root, 'rm', '-q', '--cached', f);
    for (const f of ['docs/plans/active/001-app-shell.md', firstPath].filter(Boolean)) rmSync(join(root, f), { force: true });
    write(root, firstPath ?? 'docs/plans/active/001-app-shell.md', resolution);
    git(root, 'add', '-A');
    git(root, 'commit', '-qam', 'Merge origin/main, keep my claim');
  }
  return { root, first, merged, second: runChecker(root, ['--base', 'origin/main']) };
}

test('git: two identical claims merge cleanly, so the second is refused on the merged result', () => {
  const r = claimRace();
  assert.ok(r.first.ok, r.first.out);
  assert.ok(r.merged, 'identical claims merge with no conflict');
  assert.ok(!r.second.ok, 'the second claim must be refused');
  assert.ok(r.second.out.includes('docs/plans/active/001-app-shell.md: this branch claims slice 1 in commit'), r.second.out);
  assert.ok(r.second.out.includes('already has it "in_progress": another thread claimed it first'), r.second.out);
});

test('git: a near claim (another builder) whose conflict is resolved by keeping it is refused too; flag off, both pass', () => {
  const near = claimRace({ second: plan({ status: 'in_progress', builder: 'codex/gpt-6.1-sol', reviewer: 'grok/grok-5' }) });
  assert.ok(!near.merged, 'different claims conflict');
  assert.ok(!near.second.ok, near.second.out);
  assert.ok(near.second.out.includes('another thread claimed it first'), near.second.out);
  const off = claimRace({ flag: false });
  assert.ok(off.second.ok, `flag off, today's behavior: ${off.second.out}`);
});

test('git: a claim made only while resolving the merge is refused; taking the base claim as it is passes', () => {
  const NEAR = plan({ status: 'in_progress', builder: 'codex/gpt-6.1-sol', reviewer: 'grok/grok-5' });
  const inMerge = claimRace({ second: plan({ status: 'blocked' }), resolution: NEAR });
  assert.ok(!inMerge.merged, 'blocked and in_progress conflict');
  assert.ok(!inMerge.second.ok, 'the claim is only in the merge commit, and must still be refused');
  assert.ok(inMerge.second.out.includes('this branch claims slice 1 in commit'), inMerge.second.out);
  // The resolution keeps the other thread's claim and adds this branch's own edit, so it matches neither parent.
  const WELL = '- [ ] It works well';
  const accepted = claimRace({ second: plan({ status: 'blocked', doneWhen: WELL }), resolution: plan({ status: 'in_progress', builder: 'claude/claude-opus-5-5', reviewer: 'codex/gpt-6.1-sol', doneWhen: WELL }) });
  assert.ok(accepted.second.ok, `keeping the other thread's claim is not a claim: ${accepted.second.out}`);
});

test('git: the base renamed the plan when it claimed it; a claim under the old name is matched by slice id', () => {
  const r = claimRace({ firstPath: 'docs/plans/active/001-new-name.md' });
  assert.ok(r.first.ok, r.first.out);
  assert.ok(!r.second.ok, 'the same slice under its old file name must be refused');
  assert.ok(r.second.out.includes('this branch claims slice 1 in commit'), r.second.out);
});

// The base already has slice 001 claimed at `from`; this lead branch only moves the plan to `to`, keeping the claim.
function moveClaimed(from, to) {
  const A1 = 'docs/plans/active/001-app-shell.md';
  const link = (p) => ROADMAP_001.replace('plans/active/001-app-shell.md', p.slice('docs/'.length));
  const root = makeRepo({ [A1]: CLAIMED, [CONFIG_FILE]: JSON.stringify({ features: { claimCheck: true } }) });
  if (from !== A1) {
    mkdirSync(dirname(join(root, from)), { recursive: true });
    git(root, 'mv', A1, from);
    write(root, 'docs/roadmap.md', link(from));
    git(root, 'commit', '-qam', 'Base keeps plan 001 elsewhere');
  }
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'lead/move');
  mkdirSync(dirname(join(root, to)), { recursive: true });
  git(root, 'mv', from, to);
  write(root, 'docs/roadmap.md', link(to));
  const name = to.slice(to.lastIndexOf('/') + 1);
  if (name !== '001-app-shell.md') write(root, to, CLAIMED.replace('code: []\n', `code: []\nlog: docs/plans/logs/${name}\n${NEW_FIELDS}`).replace(/## Progress log[^]*?## Review/, `${TASKS}## Review`));
  git(root, 'commit', '-qam', 'Move plan 001');
  return runChecker(root, ['--base', 'origin/main']);
}

test('git: renaming a plan the base already claimed, with no change of owner, is not a new claim', () => {
  const r = moveClaimed('docs/plans/active/001-app-shell.md', 'docs/plans/active/001-new-name.md');
  assert.ok(r.ok, r.out);
});

test('git: moving a claimed plan into active/ from another folder, with no status change, is not a new claim', () => {
  const r = moveClaimed('docs/plans/completed/001-app-shell.md', 'docs/plans/active/001-app-shell.md');
  assert.ok(!r.out.includes('this branch claims slice'), r.out);
});

// ---------- New plan fields: invariants, risk, undo, owns, proof, and matched_plan at close ----------

test('plan fields: their values are checked whenever a plan has them', () => {
  const withField = (line) => logPlan().replace('proof: the test run\n', `proof: the test run\n${line}\n`);
  const swap = (from, to) => logPlan().replace(from, to);
  assert.deepEqual(errorsFor(swap('invariants: none', 'invariants: [INV-1, INV-12]')), []);
  assert.ok(has(errorsFor(swap('invariants: none', 'invariants: [INV1]')), '"invariants" must be none, or a list of ids'));
  assert.ok(has(errorsFor(swap('invariants: none', 'invariants: []')), '"invariants" must be none'), 'an empty list says nothing; write none');
  assert.deepEqual(errorsFor(swap('risk: normal', 'risk: high')), []);
  assert.ok(has(errorsFor(swap('risk: normal', 'risk: low')), '"risk" must be high or normal'));
  assert.ok(has(errorsFor(swap('undo: revert the merge commit', 'undo:')), '"undo" needs one line of text'));
  assert.ok(has(errorsFor(swap('proof: the test run', 'proof: ""')), '"proof" needs one line of text'));
  assert.deepEqual(errorsFor(swap('owns: none', 'owns: [src/search/, ./src/api/search.ts]')), []);
  for (const bad of ['owns: []', 'owns: [/etc/x]', 'owns: [../other]', 'owns: src/search/']) {
    assert.ok(has(errorsFor(swap('owns: none', bad)), '"owns" must be none'), bad);
  }
  assert.ok(has(errorsFor(withField('matched_plan: maybe')), '"matched_plan" must be yes, or no and one line'));
  assert.ok(has(errorsFor(withField('matched_plan: no')), '"matched_plan" must be yes, or no and one line'), 'no needs the reason');
});

test('plan fields: a new-format plan cannot be done without matched_plan; an old plan can', () => {
  const done = (extra = '') => logPlan(DONE).replace('proof: the test run\n', `proof: the test run\n${extra}`);
  const at = (text) => errorsFor(text, '001-app-shell.md', 'completed');
  assert.ok(has(at(done()), 'status is "done" but the header has no "matched_plan"'));
  assert.deepEqual(at(done('matched_plan: yes\n')), []);
  assert.deepEqual(at(done('matched_plan: no, the tabs moved to slice 12\n')), []);
  assert.deepEqual(at(plan(DONE)), [], 'a plan from before these fields closes as before');
  assert.deepEqual(errorsFor(logPlan()), [], 'not needed before the slice is done');
});

test('plan fields: checkNewPlans requires each one on a new plan, and names a missing invariant id', () => {
  const P1 = P;
  const entry = (text) => ({ folder: 'active', file: '001-app-shell.md', path: P1, header: parsePlan(text).header, tasks: parseTasks(text) });
  const added = [{ status: 'A', path: P1 }];
  const none = () => null;
  assert.deepEqual(checkNewPlans({ plans: [entry(logPlan())], changes: added, readBase: none }), []);
  const hints = {
    invariants: 'the ids from docs/invariants.md this slice touches, like [INV-1], or none',
    risk: 'high or normal',
    undo: 'one line: how to undo this slice',
    owns: 'the paths this slice owns, like [src/search/], or none for a docs-only slice',
    proof: 'one line: what will be shown to prove it works',
  };
  for (const [k, hint] of Object.entries(hints)) {
    const text = logPlan().replace(new RegExp(`^${k}:.*\\n`, 'm'), '');
    assert.deepEqual(checkNewPlans({ plans: [entry(text)], changes: added, readBase: none }), [`${P1}: a new plan needs the header field "${k}:" (${hint})`], k);
  }
  const names = entry(logPlan().replace('invariants: none', 'invariants: [INV-1, INV-2]'));
  assert.deepEqual(checkNewPlans({ plans: [names], changes: added, readBase: none, invariantIds: new Set(['INV-1']) }), [`${P1}: "invariants" names INV-2, which is not in docs/invariants.md`]);
  assert.deepEqual(checkNewPlans({ plans: [names], changes: added, readBase: none, invariantIds: new Set(['INV-1', 'INV-2']) }), []);
  assert.equal(checkNewPlans({ plans: [names], changes: added, readBase: none }).length, 2, 'no invariants file: every id it names is missing');
  // A plan already on the base is not new: an older plan with none of these fields keeps passing.
  assert.deepEqual(checkNewPlans({ plans: [entry(plan())], changes: [{ status: 'M', path: P1 }], readBase: (p) => (p === P1 ? 'x' : null) }), []);
  assert.deepEqual(checkNewPlans({ plans: [names], changes: added, readBase: (p) => (p === P1 ? 'x' : null) }), [], 'an id retired later does not break a plan that is no longer new');
});

test('git: a new plan on a lead branch needs the new fields; the plan already on the base does not', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'lead/plan-002');
  const P2 = 'docs/plans/active/002-theme.md';
  const good = logPlan({ id: 2 }).replace(LOG, 'docs/plans/logs/002-theme.md');
  write(root, 'docs/roadmap.md', `${ROADMAP_001}| 002 | Theme | [plan](plans/active/002-theme.md) |\n`);
  write(root, P2, good.replace('risk: normal\n', '').replace('owns: none\n', ''));
  git(root, 'add', '-A');
  const bad = runChecker(root, ['--staged']);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes(`${P2}: a new plan needs the header field "risk:" (high or normal)`), bad.out);
  assert.ok(bad.out.includes(`${P2}: a new plan needs the header field "owns:"`), bad.out);
  assert.ok(!bad.out.includes('001-app-shell.md'), bad.out);
  write(root, P2, good);
  git(root, 'add', '-A');
  const ok = runChecker(root, ['--staged']);
  assert.ok(ok.ok, ok.out);
});

// ---------- Path claims: two running slices may not own the same path ----------

test('owns: pathsOverlap matches the same path and one inside the other, never a mere shared start', () => {
  assert.ok(pathsOverlap('src/search/', 'src/search'));
  assert.ok(pathsOverlap('src/search', 'src/search/box.ts'));
  assert.ok(pathsOverlap('./src/search/box.ts', 'src/'));
  assert.ok(!pathsOverlap('src/search', 'src/search2'));
  assert.ok(!pathsOverlap('src/a.ts', 'src/b.ts'));
  assert.equal(ownPath('/etc'), null);
  assert.equal(ownPath('./'), null);
});

test('owns: two running plans that own the same or nested paths are refused by name; done, todo, and none pass', () => {
  const owning = (id, status, owns) => logPlan({ id, status, builder: 'claude/claude-opus-5-5', reviewer: 'codex/gpt-6.1-sol' })
    .replace(LOG, `docs/plans/logs/00${id}-s${id}.md`).replace('owns: none', `owns: ${owns}`);
  const files = (a, b) => ({
    'docs/plans/active/001-s1.md': a,
    'docs/plans/active/002-s2.md': b,
    'docs/roadmap.md': '[p](plans/active/001-s1.md) [p](plans/active/002-s2.md)\n',
  });
  const nested = checkRepo(makeDir(files(owning(1, 'in_progress', '[src/search/]'), owning(2, 'in_review', '[docs/x.md, src/search/box.ts]'))));
  assert.deepEqual(nested, ['docs/plans/active/001-s1.md and docs/plans/active/002-s2.md are both running and both own src/search/ and src/search/box.ts (one is inside the other). Two running slices may not own the same path: finish one first, or change "owns" so they do not meet']);
  const same = checkRepo(makeDir(files(owning(1, 'in_progress', '[src/a.ts]'), owning(2, 'in_progress', '[src/a.ts]'))));
  assert.ok(has(same, 'both own src/a.ts.'), same.join('\n'));
  assert.deepEqual(checkRepo(makeDir(files(owning(1, 'in_progress', '[src/a.ts]'), owning(2, 'todo', '[src/a.ts]')))), [], 'a todo slice is not running');
  assert.deepEqual(checkRepo(makeDir(files(owning(1, 'in_progress', '[src/a.ts]'), owning(2, 'in_progress', '[src/b.ts]')))), []);
  assert.deepEqual(checkRepo(makeDir(files(owning(1, 'in_progress', 'none'), owning(2, 'in_progress', 'none')))), [], 'docs-only slices own nothing');
  const old = plan({ status: 'in_progress', builder: 'a/x' });
  assert.ok(!has(checkRepo(makeDir(files(old, owning(2, 'in_progress', '[src/]')))), 'both own'), 'an old plan with no owns field owns nothing');
});

// ---------- Invariants: docs/invariants.md ----------

const INVARIANTS = (rows) => `# Invariants\n\n${INVARIANTS_MARKER}\n\n<!-- | INV-9 | a row inside a comment | x | none yet | protected | -->\n\n| Id | Rule | Area | Check | State |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;

test('invariants: a protected row needs its check file; ids are INV-N and used once; states are protected or not yet', () => {
  const exists = (p) => p === 'tests/own-data.test.ts';
  const good = checkInvariants(INVARIANTS(['| INV-1 | A user only sees their own data | src/api/ | `tests/own-data.test.ts` | protected |', '| INV-2 | Prices never go below zero | src/cart/ | none yet | not yet |']), exists);
  assert.deepEqual(good.errors, []);
  assert.deepEqual([...good.ids], ['INV-1', 'INV-2']);
  const bad = checkInvariants(INVARIANTS([
    '| INV-1 | Rule | area | tests/gone.test.ts | protected |',
    '| INV-1 | Again | area | none yet | not yet |',
    '| INV2 | Bad id | area | none yet | not yet |',
    '| INV-3 | Bad state | area | none yet | protcted |',
    '| INV-4 | Short row | area |',
  ]), exists).errors;
  assert.ok(has(bad, 'docs/invariants.md:9: INV-1 is protected, but its check tests/gone.test.ts does not exist'), bad.join('\n'));
  assert.ok(has(bad, 'docs/invariants.md:10: INV-1 is used twice'), bad.join('\n'));
  assert.ok(has(bad, 'the id "INV2" must look like INV-1'), bad.join('\n'));
  assert.ok(has(bad, 'the state of INV-3 must be "protected" or "not yet", not "protcted"'), bad.join('\n'));
  assert.ok(has(bad, 'a row needs 5 cells'), bad.join('\n'));
  assert.equal(bad.length, 5, bad.join('\n'));
});

test('invariants: the repo check reads the file; no file means no invariants and no failure', () => {
  const base = { 'docs/plans/active/001-app-shell.md': plan(), 'docs/roadmap.md': ROADMAP_001 };
  assert.deepEqual(checkRepo(makeDir(base)), []);
  const broken = checkRepo(makeDir({ ...base, [INVARIANTS_FILE]: INVARIANTS(['| INV-1 | Rule | area | tests/gone.test.ts | protected |']) }));
  assert.ok(has(broken, 'INV-1 is protected, but its check tests/gone.test.ts does not exist'), broken.join('\n'));
  const fixed = checkRepo(makeDir({ ...base, 'tests/own.test.ts': 'x', [INVARIANTS_FILE]: INVARIANTS(['| INV-1 | Rule | area | tests/own.test.ts | protected |']) }));
  assert.deepEqual(fixed, []);
});

test('git: a new plan may only name invariant ids that are in docs/invariants.md, read from the staged copy', () => {
  const root = makeRepo({ [INVARIANTS_FILE]: INVARIANTS(['| INV-1 | Rule | src/ | none yet | not yet |']) });
  git(root, 'checkout', '-qb', 'lead/plan-002');
  const P2 = 'docs/plans/active/002-theme.md';
  write(root, 'docs/roadmap.md', `${ROADMAP_001}| 002 | Theme | [plan](plans/active/002-theme.md) |\n`);
  write(root, P2, logPlan({ id: 2 }).replace(LOG, 'docs/plans/logs/002-theme.md').replace('invariants: none', 'invariants: [INV-1, INV-2]'));
  git(root, 'add', '-A');
  const bad = runChecker(root, ['--staged']);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes(`${P2}: "invariants" names INV-2, which is not in docs/invariants.md`), bad.out);
  assert.ok(!bad.out.includes('names INV-1'), bad.out);
  write(root, INVARIANTS_FILE, INVARIANTS(['| INV-1 | Rule | src/ | none yet | not yet |', '| INV-2 | Rule two | src/ | none yet | not yet |']));
  git(root, 'add', '-A');
  const ok = runChecker(root, ['--staged']);
  assert.ok(ok.ok, ok.out);
});

// ---------- --status counts open asks in the event log ----------

const ev = (e) => JSON.stringify({ at: '2026-11-18T10:00:00-07:00', branch: null, slice: null, thread: null, role: null, model: null, data: {}, ...e });

test('status: an ask is open until an answer event names it; bad lines are skipped', () => {
  const log = [
    ev({ id: 'aaaa0001', type: 'ask', data: { title: 'Pay for the domain?' } }),
    ev({ id: 'aaaa0002', type: 'ask', data: { title: 'Pick a name?' } }),
    ev({ id: 'aaaa0003', type: 'answer', data: { ask: 'aaaa0001', choice: 'A' } }),
    ev({ id: 'aaaa0004', type: 'answer', data: { ask: 'legacy-0badc0de', text: 'done' } }),
    ev({ id: 'aaaa0005', type: 'job-finished', data: {} }),
    '{ not json',
    '',
  ].join('\n');
  assert.equal(countOpenAsks(log), 1);
  assert.equal(countOpenAsks(''), 0);
  assert.equal(countOpenAsks(`${log}\n${ev({ id: 'aaaa0002', type: 'ask', data: {} })}\n`), 1, 'one id counts once');
});

test('git: --status counts open asks from the shared event log, and an unreadable log counts 0 with a note', () => {
  const root = makeRepo({ 'docs/awaiting-decisions.md': INBOX });
  const logFile = join(root, '.git', 'kit-events.jsonl');
  writeFileSync(logFile, `${ev({ id: 'bbbb0001', type: 'ask' })}\n${ev({ id: 'bbbb0002', type: 'ask' })}\n`);
  const two = runChecker(root, ['--status', '--no-fetch']);
  assert.ok(two.ok, two.out);
  assert.ok(two.out.includes('Open asks for Stephen: 2 (node scripts/ask.mjs list --open)'), two.out);
  rmSync(logFile);
  mkdirSync(logFile); // a folder where the file should be: reading it fails
  const broken = runChecker(root, ['--status', '--no-fetch']);
  assert.ok(broken.ok, broken.out);
  assert.ok(broken.out.includes('Open asks for Stephen: 0 (the event log could not be read:'), broken.out);
});

// ---------- Open review finding (docs/2026-11-15-step1-report.md, "Claim check") ----------

// The finding: the base has slice 001's plan in completed/ still in progress for builder A, and a branch puts a
// new 001 plan in active/ for builder B; the claim check alone accepts B. That base cannot pass the checker,
// so the merge script never lets it onto main, and a branch that keeps it is refused by the same rules.
test('git: claim finding: a base with an unfinished plan in completed/ fails the checker, and a second claim on top is refused', () => {
  const C1 = 'docs/plans/completed/001-app-shell.md';
  const root = makeRepo({ [P]: CLAIMED, [CONFIG_FILE]: JSON.stringify({ features: { claimCheck: true } }) });
  mkdirSync(join(root, dirname(C1)), { recursive: true });
  git(root, 'mv', P, C1);
  write(root, 'docs/roadmap.md', ROADMAP_001.replace('plans/active/', 'plans/completed/'));
  git(root, 'commit', '-qam', 'A broken base: an in-progress plan in completed/');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const base = runChecker(root);
  assert.ok(!base.ok, 'the base itself fails');
  assert.ok(base.out.includes(`${C1}: plan is in completed/ but status is "in_progress"`), base.out);

  git(root, 'checkout', '-qb', 'lead/claim-b');
  write(root, P, logPlan({ status: 'in_progress', builder: 'codex/gpt-6.1-sol', reviewer: 'grok/grok-5' }));
  write(root, 'docs/roadmap.md', `${ROADMAP_001.replace('plans/active/', 'plans/completed/')}${ROADMAP_001}`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'Claim slice 001 for builder B');
  const second = runChecker(root, ['--base', 'origin/main']);
  assert.ok(!second.ok, second.out);
  assert.ok(second.out.includes(`${C1}: plan is in completed/ but status is "in_progress"`), second.out);
  assert.ok(second.out.includes('id 1 is also used by'), second.out);
});

// ---------- Review fixes (a second model's review of the new rules) ----------

test('review 1: an invariants file without the format line is not checked, and --status says so once', () => {
  const base = { 'docs/plans/active/001-app-shell.md': plan(), 'docs/roadmap.md': ROADMAP_001 };
  const oldFile = '# Invariants\n\n| Rule | Owner |\n|---|---|\n| Users see only their data | api |\n';
  assert.deepEqual(checkRepo(makeDir({ ...base, [INVARIANTS_FILE]: oldFile })), [], 'an older two-column file keeps passing');
  const marked = checkRepo(makeDir({ ...base, [INVARIANTS_FILE]: `# Invariants\n\n${INVARIANTS_MARKER}\n\n${oldFile.slice(14)}` }));
  assert.ok(has(marked, 'a row needs 5 cells'), 'with the format line, the table is checked');
  const r = checkInvariants(oldFile, () => true);
  assert.equal(r.optedIn, false);
  const entry = { folder: 'active', file: '001-app-shell.md', path: P, header: parsePlan(logPlan().replace('invariants: none', 'invariants: [INV-1]')).header, tasks: [{ n: 1, title: 'x' }] };
  const msg = checkNewPlans({ plans: [entry], changes: [{ status: 'A', path: P }], readBase: () => null, invariantIds: null });
  assert.ok(has(msg, `${INVARIANTS_FILE} has no line "${INVARIANTS_MARKER}"`), msg.join('\n'));
  const root = makeRepo({ [INVARIANTS_FILE]: oldFile });
  const status = runChecker(root, ['--status', '--no-fetch']);
  assert.ok(status.ok, status.out);
  assert.equal(status.out.split(`has no line "${INVARIANTS_MARKER}"`).length, 2, status.out);
});

test('review 2: owned paths match under any spelling of the same file, and ".." or absolute paths are refused', () => {
  for (const other of ['././src/api.ts', 'src//api.ts', 'src/./api.ts', 'SRC/API.TS', 'src\\api.ts']) assert.ok(pathsOverlap('src/api.ts', other), other);
  assert.ok(pathsOverlap('Src/', 'src/api.ts'));
  for (const bad of ['src/../api.ts', '/src/api.ts', '..', '.', '']) assert.equal(ownPath(bad), null, bad);
  assert.equal(ownPath('./src//a/./b.ts/'), 'src/a/b.ts');
  const run = (owns) => logPlan({ status: 'in_progress', builder: 'claude/claude-opus-5-5', reviewer: 'codex/gpt-6.1-sol' }).replace('owns: none', `owns: ${owns}`);
  const errs = checkRepo(makeDir({
    'docs/plans/active/001-s1.md': run('[src/api.ts]').replace(LOG, 'docs/plans/logs/001-s1.md'),
    'docs/plans/active/002-s2.md': run('[SRC//API.TS]').replace('id: 1', 'id: 2').replace(LOG, 'docs/plans/logs/002-s2.md'),
    'docs/roadmap.md': '[p](plans/active/001-s1.md) [p](plans/active/002-s2.md)\n',
  }));
  assert.ok(has(errs, 'are both running and both own'), errs.join('\n'));
});

// Slice 001 is running and owns src/api.ts; slice 002 is running with the given owns.
function ownedRepo(owns2) {
  const running = (id, name, owns) => logPlan({ id, status: 'in_progress', builder: 'claude/claude-opus-5-5', reviewer: 'codex/gpt-6.1-sol' })
    .replace(LOG, `docs/plans/logs/${name}.md`).replace('owns: none', `owns: ${owns}`);
  const root = makeRepo({
    [P]: running(1, '001-app-shell', '[src/api.ts]'),
    'docs/plans/active/002-theme.md': running(2, '002-theme', owns2),
    'docs/roadmap.md': `${ROADMAP_001}[p](plans/active/002-theme.md)\n`,
    'src/api.ts': 'export {};\n',
  });
  git(root, 'checkout', '-qb', 'build/002-theme');
  return root;
}

test('review 3: a build branch may not change a path another running slice owns, and owns: none means paperwork only', () => {
  const none = ownedRepo('none');
  write(none, 'src/api.ts', 'export const x = 1;\n');
  git(none, 'add', '-A');
  const theirs = runChecker(none, ['--staged']);
  assert.ok(!theirs.ok, theirs.out);
  assert.ok(theirs.out.includes(`src/api.ts: ${P} owns this path (src/api.ts) and is running; build branch build/002-theme may not change it`), theirs.out);
  git(none, 'reset', '-q', '--hard');
  write(none, 'src/other.ts', 'export {};\n');
  git(none, 'add', '-A');
  const code = runChecker(none, ['--staged']);
  assert.ok(!code.ok, code.out);
  assert.ok(code.out.includes('src/other.ts: the plan for slice 002 says "owns: none", so this branch may change only paperwork'), code.out);
  rmSync(join(none, 'src/other.ts'));
  write(none, 'docs/notes.md', '# Notes\n');
  write(none, 'docs/plans/logs/002-theme.md', '# 002 log\n');
  git(none, 'add', '-A');
  const paper = runChecker(none, ['--staged']);
  assert.ok(paper.ok, paper.out);

  const listed = ownedRepo('[src/theme/]');
  write(listed, 'src/theme/a.ts', 'export {};\n');
  git(listed, 'add', '-A');
  const ok = runChecker(listed, ['--staged']);
  assert.ok(ok.ok, ok.out);
  // The pure rule: a path from an older plan with no owns field is never limited.
  const plans = [{ path: P, folder: 'active', header: { id: 1, status: 'in_progress', owns: ['src/'] } }, { path: 'x', folder: 'active', header: { id: 2, status: 'in_progress' } }];
  assert.deepEqual(checkOwnedChanges({ slice: '002', branch: 'build/002-x', plans: [plans[1]], changes: [{ status: 'M', path: 'src/a.ts' }] }), []);
  assert.equal(checkOwnedChanges({ slice: '002', branch: 'build/002-x', plans, changes: [{ status: 'R', oldPath: 'SRC/a.ts', path: 'lib/a.ts' }] }).length, 1, 'renames count on both sides');
});

test('review 4: renaming an older plan keeps it an older plan: no new fields and no tasks needed', () => {
  const OLD = 'docs/plans/active/001-original.md';
  const older = plan({ status: 'in_progress', builder: 'claude/claude-opus-5-5' }).replace('code: []\n', 'code: []\nlog: docs/plans/logs/001-original.md\n')
    .replace('## Progress log\n\n- 2026-11-02: started\n\n', '').replace('## Notes for the lead\n\n', '');
  const root = makeRepo({ [P]: null, [OLD]: older, 'docs/roadmap.md': '[p](plans/active/001-original.md)\n' });
  git(root, 'checkout', '-qb', 'lead/rename');
  const NEW = 'docs/plans/active/001-renamed.md';
  git(root, 'mv', OLD, NEW);
  write(root, NEW, older.replace('001-original.md', '001-renamed.md'));
  write(root, 'docs/roadmap.md', '[p](plans/active/001-renamed.md)\n');
  git(root, 'add', '-A');
  const r = runChecker(root, ['--staged']);
  assert.ok(r.ok, r.out);
  const entry = { folder: 'active', file: '001-renamed.md', path: NEW, header: parsePlan(older).header, tasks: [] };
  assert.deepEqual(checkNewPlans({ plans: [entry], changes: [{ status: 'R', oldPath: OLD, path: NEW }], readBase: () => null, basePlanPaths: [OLD] }), []);
  assert.equal(checkNewPlans({ plans: [entry], changes: [{ status: 'A', path: NEW }], readBase: () => null, basePlanPaths: ['docs/plans/active/0011-x.md'] }).length, 6, 'only the same three-digit id counts');
});

test('review 5: a protected check must be a file inside the repo, not a folder or nothing, on disk and staged', () => {
  const row = (check) => INVARIANTS([`| INV-1 | Rule | src/ | ${check} | protected |`]);
  const base = { 'docs/plans/active/001-app-shell.md': plan(), 'docs/roadmap.md': ROADMAP_001, 'src/a.test.ts': 'x' };
  for (const check of ['src', 'src/', '', '../outside.test.ts', '/etc/hosts', 'SRC/A.TEST.TS']) {
    assert.ok(has(checkRepo(makeDir({ ...base, [INVARIANTS_FILE]: row(check) })), 'INV-1 is protected, but its check'), `disk: "${check}"`);
  }
  assert.deepEqual(checkRepo(makeDir({ ...base, [INVARIANTS_FILE]: row('./src/a.test.ts') })), []);
  const root = makeRepo({ 'src/a.test.ts': 'x', [INVARIANTS_FILE]: row('src') });
  const staged = runChecker(root, ['--staged']);
  assert.ok(!staged.ok && staged.out.includes('INV-1 is protected, but its check src'), staged.out);
  write(root, INVARIANTS_FILE, row('src/a.test.ts'));
  git(root, 'add', '-A');
  assert.ok(runChecker(root, ['--staged']).ok);
});

test('review 6: a "#" inside quotes is kept; a comment outside quotes is still cut', () => {
  const { header, errors } = parsePlan('---\nid: 1\nproof: "Check the #settings link"   # a comment\nowns: ["docs/Issue #2.md", "a, b.md", src/a.ts] # mine\nundo: it\'s easy # cut\n---\n');
  assert.deepEqual(errors, []);
  assert.equal(header.proof, 'Check the #settings link');
  assert.deepEqual(header.owns, ['docs/Issue #2.md', 'a, b.md', 'src/a.ts']);
  assert.equal(header.undo, "it's easy", 'an apostrophe is not a quote');
  assert.equal(parsePlan(plan()).header.status, 'todo');
});

test('review 7: an answer with a bad time does not close an ask, as in the normal event reader', () => {
  const ask = ev({ id: 'cccc0001', type: 'ask' });
  assert.equal(countOpenAsks(`${ask}\n${ev({ id: 'cccc0002', type: 'answer', at: 'bad-time', data: { ask: 'cccc0001' } })}\n`), 1);
  assert.equal(countOpenAsks(`${ev({ id: 'cccc0003', type: 'ask', at: 'bad-time' })}\n`), 0, 'a bad ask is skipped too');
  assert.equal(countOpenAsks('[1]\n"text"\nnull\n'), 0);
});

// ---------- Review fixes, second round ----------

test('review2 1: owned paths match across Unicode spellings of one name (NFC and NFD)', () => {
  assert.ok(pathsOverlap('src/Café.ts', 'src/Café.ts'));
  assert.ok(pathsOverlap('src/Café/', 'SRC/CAFÉ/a.ts'));
});

test('review2 2: owns may not list a path inside the plans folder', () => {
  const owns = (v) => errorsFor(logPlan().replace('owns: none', `owns: ${v}`));
  for (const bad of ['[docs/plans/logs/001-app-shell.md]', '[docs/plans/]', '[./Docs/Plans/active/002-x.md]']) {
    assert.ok(has(owns(bad), '"owns" may not list docs/plans or anything inside it'), bad);
  }
  assert.deepEqual(owns('[docs/, src/]'), [], 'a folder that holds the plans folder is fine; plan files follow the plan rules');
  assert.ok(has(errorsFor(logPlan().replace('owns: none', 'owns: [plans/x.md]'), '001-app-shell.md', 'active', mergeConfig({ plansDir: 'plans' })), 'may not list plans or anything inside it'));
});

test('review2 3: a protected check that is a symbolic link fails on disk and staged alike', () => {
  const row = INVARIANTS(['| INV-1 | Rule | src/ | src/link.test.ts | protected |']);
  for (const target of ['missing.test.ts', 'real.test.ts']) {
    const root = makeRepo({ 'src/real.test.ts': 'x', [INVARIANTS_FILE]: row });
    symlinkSync(target, join(root, 'src/link.test.ts'));
    git(root, 'add', '-A');
    for (const args of [['--staged'], []]) {
      const r = runChecker(root, args);
      assert.ok(!r.ok && r.out.includes('INV-1 is protected, but its check src/link.test.ts'), `${target} ${args}: ${r.out}`);
    }
    write(root, INVARIANTS_FILE, row.replace('src/link.test.ts', 'src/real.test.ts'));
    git(root, 'add', '-A');
    for (const args of [['--staged'], []]) assert.ok(runChecker(root, args).ok, `${target} ${args}`);
  }
});

test('review2 4: an escaped quote inside a quoted value does not end it', () => {
  const { header, errors } = parsePlan('---\nid: 1\nproof: "say \\"hi\\" then open #settings" # a comment\nowns: ["a \\"b\\" #c.md", d.md]\n---\n');
  assert.deepEqual(errors, []);
  assert.equal(header.proof, 'say "hi" then open #settings');
  assert.deepEqual(header.owns, ['a "b" #c.md', 'd.md']);
});

test('review2 5: an answer whose time is not text that reads as a time does not close an ask, and never throws', () => {
  const ask = ev({ id: 'dddd0001', type: 'ask' });
  for (const at of [[2026], { toString: 0 }, 20261118]) {
    assert.equal(countOpenAsks(`${ask}\n${ev({ id: 'dddd0002', type: 'answer', at, data: { ask: 'dddd0001' } })}\n`), 1, JSON.stringify(at));
  }
});

test('review2 6: the format line inside an HTML comment does not switch the invariants check on', () => {
  const text = `# Invariants\n\n<!-- ${INVARIANTS_MARKER} -->\n<!--\n${INVARIANTS_MARKER}\n-->\n\n| Rule | Owner |\n|---|---|\n| x | y |\n`;
  assert.equal(checkInvariants(text, () => true).optedIn, false);
  assert.equal(checkInvariants(`${INVARIANTS_MARKER}\n`, () => true).optedIn, true);
});

test('review2 7: only real plan files on the base (NNN-name.md, right in active/ or completed/) keep an id old', () => {
  const NEW = 'docs/plans/active/001-app-shell.md';
  const entry = { folder: 'active', file: '001-app-shell.md', path: NEW, header: parsePlan(plan()).header, tasks: [] };
  const check = (basePlanPaths) => checkNewPlans({ plans: [entry], changes: [{ status: 'A', path: NEW }], readBase: () => null, basePlanPaths });
  for (const notAPlan of ['docs/plans/completed/001-not-a-plan.txt', 'docs/plans/completed/old/001-x.md', 'docs/plans/logs/001-x.md', 'docs/plans/completed/001-Bad_Name.md']) {
    assert.ok(check([notAPlan]).length > 0, notAPlan);
  }
  assert.deepEqual(check(['docs/plans/completed/001-original.md']), []);
});

// ---------- Review fixes, third round ----------

test('review3 1: a check file exists under either Unicode spelling of its name, on disk and staged', () => {
  const NFD = 'src/Café.test.ts';
  const NFC = 'src/Café.test.ts';
  const row = (check) => INVARIANTS([`| INV-1 | Rule | src/ | ${check} | protected |`]);
  assert.deepEqual(checkInvariants(row(NFD), (p) => p === NFD).errors, [], 'the path is used as written first');
  assert.deepEqual(checkInvariants(row(NFC), (p) => p === NFD).errors, [], 'then its other spelling');
  assert.deepEqual(checkInvariants(row(NFD), (p) => p === NFC).errors, []);
  const base = { 'docs/plans/active/001-app-shell.md': plan(), 'docs/roadmap.md': ROADMAP_001, [NFD]: 'x' };
  for (const check of [NFD, NFC]) assert.deepEqual(checkRepo(makeDir({ ...base, [INVARIANTS_FILE]: row(check) })), [], `disk: ${check === NFD ? 'NFD' : 'NFC'}`);
  for (const precompose of ['true', 'false']) {
    const root = makeRepo({ [INVARIANTS_FILE]: row(NFD) });
    git(root, 'config', 'core.precomposeunicode', precompose);
    write(root, NFD, 'x');
    git(root, 'add', '-A');
    for (const check of [NFD, NFC]) {
      write(root, INVARIANTS_FILE, row(check));
      git(root, 'add', INVARIANTS_FILE);
      const r = runChecker(root, ['--staged']);
      assert.ok(r.ok, `precompose ${precompose}, ${check === NFD ? 'NFD' : 'NFC'}: ${r.out}`);
    }
  }
  assert.ok(has(checkInvariants(row('src/Cafe.test.ts'), (p) => p === NFD).errors, 'INV-1 is protected'), 'a name without the accent is another file');
});

test('review3 2: an unfinished HTML comment hides everything after it, including the format line', () => {
  assert.equal(checkInvariants(`# Invariants\n\n<!-- started, never closed\n\n${INVARIANTS_MARKER}\n`, () => true).optedIn, false);
  assert.equal(checkInvariants(`<!-- closed -->\n${INVARIANTS_MARKER}\n`, () => true).optedIn, true);
  assert.equal(stripHtmlComments('a\n<!-- x\ny -->b\n<!-- open\nc\nd'), 'a\n\nb\n\n\n');
  assert.equal(stripHtmlComments('a\r\nb'), 'a\nb', 'line endings are made plain first');
});

// ---------- Kit 5.1: settings, modes, the verify recipe, the change checklist, findings files ----------

test('5.1 settings: quickReviewPaths and quickReviewMaxLines have defaults that change nothing, and are checked', () => {
  assert.deepEqual(DEFAULT_CONFIG.quickReviewPaths, []);
  assert.equal(DEFAULT_CONFIG.quickReviewMaxLines, 50);
  const ok = mergeConfig({ quickReviewPaths: ['docs/', 'src/copy/'], quickReviewMaxLines: 0 });
  assert.deepEqual(ok.quickReviewPaths, ['docs/', 'src/copy/']);
  assert.equal(ok.quickReviewMaxLines, 0);
  assert.throws(() => mergeConfig({ quickReviewPaths: [''] }), /"quickReviewPaths" must list paths/);
  assert.throws(() => mergeConfig({ quickReviewPaths: 'docs/' }), /wrong type/);
  for (const bad of [-1, 2.5]) assert.throws(() => mergeConfig({ quickReviewMaxLines: bad }), /"quickReviewMaxLines" must be a whole number of lines, 0 or more/, String(bad));
  assert.throws(() => mergeConfig({ quickReviewMaxLines: '50' }), /wrong type/);
  assert.throws(() => mergeConfig({ quickReviewLines: 50 }), /unknown setting "quickReviewLines"/, 'a typo is still refused');
});

test('5.1 settings: a check may carry observe, true or false', () => {
  const checks = [{ name: 'lint', run: 'pnpm lint', observe: true }, { name: 'test', run: 'pnpm test', observe: false }];
  assert.deepEqual(mergeConfig({ checks }).checks, checks);
  assert.throws(() => mergeConfig({ checks: [{ name: 'lint', run: 'pnpm lint', observe: 'yes' }] }), /"observe" must be true or false/);
  assert.throws(() => mergeConfig({ checks: [{ name: 'lint', run: 'pnpm lint', watch: true }] }), /unknown key "watch"/);
});

test('5.1 modes: features may hold mode words; claimCheck is on for true and "enforce", and refuses "observe"', () => {
  const all = { protectedTests: 'observe', reviewReceipts: 'enforce', duplicateNumbers: 'off', testReasons: true, mergeLock: false };
  assert.deepEqual(mergeConfig({ features: all }).features, all, 'string modes load without error');
  for (const on of [true, 'enforce']) assert.equal(claimCheckOn(mergeConfig({ features: { claimCheck: on } })), true, String(on));
  for (const off of [false, 'off', undefined]) assert.equal(claimCheckOn(mergeConfig({ features: off === undefined ? {} : { claimCheck: off } })), false, String(off));
  assert.throws(() => mergeConfig({ features: { claimCheck: 'observe' } }), /"features.claimCheck" cannot be "observe": the claim check runs in a git hook/);
});

test('git: claimCheck "enforce" refuses a lost claim like true; "off" lets it pass', () => {
  const run = (flag) => {
    const root = makeRepo({ [P]: plan(), [CONFIG_FILE]: JSON.stringify({ features: { claimCheck: flag } }) });
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'checkout', '-qb', 'lead/claim-b');
    write(root, P, CLAIMED.replace('codex/gpt-6.1-sol', 'grok/grok-5'));
    git(root, 'commit', '-qam', 'Claim 001');
    git(root, 'checkout', '-q', 'main');
    write(root, P, CLAIMED);
    git(root, 'commit', '-qam', 'Another thread claims 001 first');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'checkout', '-q', 'lead/claim-b');
    git(root, 'merge', '-q', '-X', 'ours', '--no-edit', 'origin/main');
    return runChecker(root, ['--base', 'origin/main']);
  };
  const enforce = run('enforce');
  assert.ok(!enforce.ok && enforce.out.includes('another thread claimed it first'), enforce.out);
  const off = run('off');
  assert.ok(off.ok, off.out);
});

const RECIPE = (sections) => `# How to run it\n\n${VERIFY_MARKER}\n\n<!-- ## Example in a comment\nStart: ignored -->\n\n${sections}`;
const SECTION = (name, lines = {}) => {
  const want = { Start: 'pnpm dev', Try: 'open /search and type "cat"', Look: 'three results show', Stop: 'Ctrl+C', Takes: '1 minute', ...lines };
  return `## ${name}\n\n${Object.entries(want).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n`;
};

test('5.1 verify recipe: with the format line, each section needs Start, Try, Look, Stop, and Takes, none empty', () => {
  assert.deepEqual(checkVerifyRecipe(RECIPE(SECTION('Web app') + SECTION('Phone app'))), []);
  const missing = checkVerifyRecipe(RECIPE(SECTION('Web app', { Try: null }) + SECTION('Server', { Takes: '' })));
  assert.deepEqual(missing, [
    `${VERIFY_FILE}:8: the section "## Web app" has no "Try:" line; each section needs Start, Try, Look, Stop, and Takes`,
    `${VERIFY_FILE}:15: the section "## Server" has an empty "Takes:" line; fill it in`,
  ]);
  assert.deepEqual(checkVerifyRecipe(`# How to run it\n\n## Web app\n\nStart: x\n`), [], 'no format line: an older file is not read');
  assert.deepEqual(checkVerifyRecipe(`<!-- ${VERIFY_MARKER} -->\n## Web app\n`), [], 'a format line inside a comment does not count');
  assert.ok(checkVerifyRecipe(RECIPE('## Web app\n\n<!--\nStart: a\nTry: b\nLook: c\nStop: d\nTakes: e\n-->\n')).length === 5, 'lines inside a comment do not count');
});

const CHECKLIST = (rows) => `# Change checklist\n\n${CHECKLIST_MARKER}\n\n<!-- | CL-9 | in a comment | x | y | -->\n\n| Id | When the change touches | Check this | Why |\n|---|---|---|---|\n${rows.join('\n')}\n`;

test('5.1 change checklist: with the format line, the table has four columns, CL ids used once, no empty cell, and a path in a code span', () => {
  const good = ['| CL-1 | `src/storage/**` and adds "version" | The old data still loads | PR 41 lost saved words |', '| CL-2 | `db/migrations/`, `src/db/*.ts` | A down step exists | Outage on 2026-10-02 |'];
  assert.deepEqual(checkChangeChecklist(CHECKLIST(good)), []);
  const bad = checkChangeChecklist(CHECKLIST([
    '| CL-1 | `src/a/` | Check | Why |',
    '| CL-1 | `src/b/` | Again | Why |',
    '| CL1 | `src/c/` | Bad id | Why |',
    '| CL-3 | src/d/ | No code span | Why |',
    '| CL-4 | `src/e/` |  | Empty check |',
    '| CL-5 | `src/f/` | Short row |',
    '| CL-6 | `` | Empty span | Why |',
  ]));
  assert.ok(has(bad, `${CHECKLIST_FILE}:10: CL-1 is used twice`), bad.join('\n'));
  assert.ok(has(bad, ':11: the id "CL1" must look like CL-1'), bad.join('\n'));
  assert.ok(has(bad, ':12: the "When the change touches" cell of CL-3 cannot be read'), bad.join('\n'));
  assert.ok(has(bad, ':13: CL-4 has an empty "Check this" cell'), bad.join('\n'));
  assert.ok(has(bad, ':14: a row needs 4 cells'), bad.join('\n'));
  assert.ok(has(bad, ':15: the "When the change touches" cell of CL-6 cannot be read'), bad.join('\n'));
  assert.equal(bad.length, 6, bad.join('\n'));
  const cols = checkChangeChecklist(`${CHECKLIST_MARKER}\n\n| Id | Trigger | Check this | Why |\n|---|---|---|---|\n| CL-1 | \`a/\` | b | c |\n`);
  assert.ok(has(cols, 'the table needs the columns Id, When the change touches, Check this, Why'), cols.join('\n'));
  assert.ok(has(checkChangeChecklist(`${CHECKLIST_MARKER}\n\nNo table yet.\n`), 'has the format line but no table'));
  assert.deepEqual(checkChangeChecklist('# Checklist\n\n| a | b |\n|---|---|\n| x | y |\n'), [], 'no format line: an older file is not read');
});

test('5.1 the repo check reads both files; a builder may not edit them, and may write its own findings and weakenings files', () => {
  const base = { 'docs/plans/active/001-app-shell.md': plan(), 'docs/roadmap.md': ROADMAP_001 };
  const errs = checkRepo(makeDir({ ...base, [VERIFY_FILE]: RECIPE(SECTION('Web app', { Look: null })), [CHECKLIST_FILE]: CHECKLIST(['| CL-1 | x | y | z |']) }));
  assert.ok(has(errs, 'has no "Look:" line'), errs.join('\n'));
  assert.ok(has(errs, 'cell of CL-1 cannot be read'), errs.join('\n'));
  for (const p of [VERIFY_FILE, CHECKLIST_FILE]) assert.ok(has(guard([{ status: 'M', path: p }]), 'builders may not change this file'), p);
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'build/001-app-shell');
  write(root, 'docs/findings/build-001-app-shell.md', '- R1.1 off-by-one: fixed: the loop now stops at the last item.\n');
  write(root, 'docs/weakenings/build-001-app-shell.md', '- src/a.test.ts: the old case moved to b.test.ts.\n');
  git(root, 'add', '-A');
  const r = runChecker(root, ['--staged']);
  assert.ok(r.ok, r.out);
});

// One list of rows for both readers of docs/change-checklist.md: the rule checker (checkChangeChecklist) and
// scripts/checklist.mjs (parseChecklist, which the merge reads). They must agree on every row: a row the
// checker passes but the merge cannot read would be silently ignored.
const CHECKLIST_ROWS = {
  good: [
    '| CL-1 | `src/storage/**` and adds "version" | Old data still loads | PR 41 lost saved words |',
    '| CL-2 | `db/migrations/`, `src/db/*.ts` | A down step exists | Outage on 2026-10-02 |',
    '| CL-3 | `src/x/`,`lib/` | No space after the comma | Why |',
    '| `CL-4` | `src/a.ts` | An id in a code span | Why |',
    '| CL-5 | `src/a.ts` and adds "a \\| b" | An escaped bar in the text | Why |',
    '| CL-6 | `src/a.ts` | Uses a \\| bar | Why |',
    '| CL-7 | `src/a\\|b.ts` | An escaped bar in a path | Why |',
    '| CL-10 | `**/*.sql` | Any folder | Why |',
  ],
  bad: [
    '| CL-1 | `src/` or `lib/` | Words between patterns | Why |',
    '| CL-1 | src/d/ | No code span | Why |',
    '| CL-1 | `` | An empty span | Why |',
    '| CL-1 | ` ` | A blank pattern | Why |',
    '| CL-1 | `/src/` | Starts with a slash | Why |',
    '| CL-1 | `./src/` | Starts with ./ | Why |',
    '| CL-1 | `src/` and adds "" | Empty adds text | Why |',
    '| CL-1 | `src/` and adds version | Adds text with no quotes | Why |',
    '| CL-1 | `src/` extra words | Words after the pattern | Why |',
    '| CL-1 | and adds "x" | Only adds text | Why |',
    '| CL1 | `src/` | Bad id | Why |',
    '| CL-0 | `src/` | Id zero | Why |',
    '| CL-01 | `src/` | A leading zero | Why |',
    '| CL-1 | `src/` |  | An empty Check this |',
    '| CL-1 | `src/` | An empty Why |  |',
    '| CL-1 | `src/` | Short row |',
    '| CL-1 | `src/` | a|b | An unescaped bar makes 5 cells |',
  ],
};

test('5.1 change checklist: the rule checker and scripts/checklist.mjs agree on every row', () => {
  const file = (rows) => CHECKLIST(rows);
  const disagree = [];
  for (const [want, rows] of Object.entries(CHECKLIST_ROWS)) {
    for (const row of rows) {
      const mine = checkChangeChecklist(file([row])).length > 0 ? 'bad' : 'good';
      const theirs = parseChecklist(file([row])).problems.length > 0 ? 'bad' : 'good';
      if (mine !== want || theirs !== want) disagree.push(`${row}  (want ${want}; rule checker ${mine}, checklist.mjs ${theirs})`);
    }
  }
  assert.deepEqual(disagree, [], `rows the two readers do not both judge as expected:\n${disagree.join('\n')}`);
  // A repeated id: the second row is the problem, in both.
  const twice = file([CHECKLIST_ROWS.good[0], CHECKLIST_ROWS.good[0]]);
  assert.equal(checkChangeChecklist(twice).length, 1);
  assert.equal(parseChecklist(twice).problems.length, 1);
  assert.ok(checkChangeChecklist(twice)[0].startsWith(`${CHECKLIST_FILE}:10:`) && parseChecklist(twice).problems[0].startsWith(`${CHECKLIST_FILE}:10:`));
});

// ---------- Kit 5.3: pre-flight slice size gate (maxTasksPerSlice, maxOwnsPerSlice, extraTaskSlices, maxTaskReviewRounds) ----------

test('5.3 settings: maxTasksPerSlice, maxOwnsPerSlice, extraTaskSlices, and maxTaskReviewRounds defaults and validation', () => {
  assert.equal(DEFAULT_CONFIG.maxTasksPerSlice, 3);
  assert.equal(DEFAULT_CONFIG.maxOwnsPerSlice, 10);
  assert.deepEqual(DEFAULT_CONFIG.extraTaskSlices, []);
  assert.equal(DEFAULT_CONFIG.maxTaskReviewRounds, 4);
  assert.equal(DEFAULT_CONFIG.maxReviewRounds, 12);
  assert.equal(DEFAULT_CONFIG.graceReviewRound, true);

  const ok = mergeConfig({ maxTasksPerSlice: 5, maxOwnsPerSlice: 4, extraTaskSlices: [0, 12], maxTaskReviewRounds: 6, graceReviewRound: false });
  assert.equal(ok.maxTasksPerSlice, 5);
  assert.equal(ok.maxOwnsPerSlice, 4);
  assert.deepEqual(ok.extraTaskSlices, [0, 12]);
  assert.equal(ok.maxTaskReviewRounds, 6);
  assert.equal(ok.graceReviewRound, false);
  for (const bad of ['true', 1, null, []]) {
    assert.throws(() => mergeConfig({ graceReviewRound: bad }), /wrong type/, `graceReviewRound=${JSON.stringify(bad)}`);
  }

  const disabled = mergeConfig({ maxTasksPerSlice: null, maxOwnsPerSlice: null, maxTaskReviewRounds: null });
  assert.equal(disabled.maxTasksPerSlice, null);
  assert.equal(disabled.maxOwnsPerSlice, null);
  assert.equal(disabled.maxTaskReviewRounds, null);

  const root = makeDir({
    [CONFIG_FILE]: JSON.stringify({ maxTasksPerSlice: 4, maxOwnsPerSlice: 3, extraTaskSlices: [7], maxTaskReviewRounds: 5 }),
  });
  const loaded = loadConfig(root);
  assert.equal(loaded.maxTasksPerSlice, 4);
  assert.equal(loaded.maxOwnsPerSlice, 3);
  assert.deepEqual(loaded.extraTaskSlices, [7]);
  assert.equal(loaded.maxTaskReviewRounds, 5);

  for (const key of ['maxTasksPerSlice', 'maxOwnsPerSlice', 'maxTaskReviewRounds']) {
    for (const bad of [0, -1, 2.5]) {
      assert.throws(() => mergeConfig({ [key]: bad }), new RegExp(`"${key}" must be a whole number`), `${key}=${bad}`);
    }
    for (const bad of ['3', true, [], {}]) {
      assert.throws(() => mergeConfig({ [key]: bad }), /wrong type/, `${key}=${JSON.stringify(bad)}`);
    }
  }
  for (const bad of [[-1], [1.5], ['4'], [null]]) {
    assert.throws(() => mergeConfig({ extraTaskSlices: bad }), /"extraTaskSlices" must list slice ids/, JSON.stringify(bad));
  }
  for (const bad of ['4', 4, {}]) {
    assert.throws(() => mergeConfig({ extraTaskSlices: bad }), /wrong type/, JSON.stringify(bad));
  }
});

test('5.3 slice size gate: maxTasksPerSlice fails over limit, passes at limit, spares base plans, and honors extraTaskSlices or null', () => {
  const mkTasks = (count) => Array.from({ length: count }, (_, i) => ({ n: i + 1, title: `Task ${i + 1}` }));
  const entry = (id, count, owns = 'none') => {
    const file = `${String(id).padStart(3, '0')}-slice.md`;
    const path = `docs/plans/active/${file}`;
    const text = logPlan({ id }).replace(LOG, `docs/plans/logs/${file}`).replace('owns: none', `owns: ${owns}`);
    return { folder: 'active', file, path, header: parsePlan(text).header, tasks: mkTasks(count) };
  };
  const noBase = () => null;

  const three = entry(1, 3);
  assert.deepEqual(checkNewPlans({ plans: [three], changes: [{ status: 'A', path: three.path }], readBase: noBase }), []);

  const four = entry(1, 4);
  const errs = checkNewPlans({ plans: [four], changes: [{ status: 'A', path: four.path }], readBase: noBase });
  assert.equal(errs.length, 1);
  assert.ok(errs[0].includes('new plan has 4 tasks (max 3)'), errs[0]);
  assert.ok(errs[0].includes('split the roadmap row into smaller sequential slices'), errs[0]);
  assert.ok(errs[0].includes('extraTaskSlices'), errs[0]);

  // Pre-existing plan on the base branch with 5 tasks passes (never retroactively broken).
  const five = entry(1, 5);
  assert.deepEqual(checkNewPlans({ plans: [five], changes: [{ status: 'M', path: five.path }], readBase: (p) => (p === five.path ? 'x' : null) }), []);
  assert.deepEqual(checkNewPlans({ plans: [five], changes: [{ status: 'A', path: five.path }], readBase: (p) => (p === five.path ? 'x' : null) }), []);
  const moved = { ...five, folder: 'completed', path: 'docs/plans/completed/001-slice.md' };
  assert.deepEqual(checkNewPlans({ plans: [moved], changes: [{ status: 'A', path: moved.path }], readBase: (p) => (p === five.path ? 'x' : null) }), []);

  // extraTaskSlices allows slice 1 (direct config call), but not slice 2.
  const allow1 = mergeConfig({ extraTaskSlices: [1] });
  assert.deepEqual(checkNewPlans({ plans: [four], changes: [{ status: 'A', path: four.path }], readBase: noBase, config: allow1 }), []);
  const fourSlice2 = entry(2, 4);
  assert.ok(has(checkNewPlans({ plans: [fourSlice2], changes: [{ status: 'A', path: fourSlice2.path }], readBase: noBase, config: allow1 }), 'new plan has 4 tasks (max 3)'));

  // When baseConfig is given, extraTaskSlices comes from the base branch, not proposed config.
  const deniedByBase = checkNewPlans({
    plans: [four],
    changes: [{ status: 'A', path: four.path }],
    readBase: noBase,
    config: allow1,
    baseConfig: mergeConfig({ extraTaskSlices: [] }),
  });
  assert.ok(has(deniedByBase, 'new plan has 4 tasks (max 3)'));
  const allowedByBase = checkNewPlans({
    plans: [four],
    changes: [{ status: 'A', path: four.path }],
    readBase: noBase,
    config: mergeConfig({ extraTaskSlices: [] }),
    baseConfig: allow1,
  });
  assert.deepEqual(allowedByBase, []);

  // maxTasksPerSlice: null disables the cap.
  const noCap = mergeConfig({ maxTasksPerSlice: null });
  assert.deepEqual(checkNewPlans({ plans: [five], changes: [{ status: 'A', path: five.path }], readBase: noBase, config: noCap }), []);
});

test('5.3 slice size gate: maxOwnsPerSlice fails when exceeded and passes when within limit, none, base, or overridden', () => {
  const entry = (id, owns) => {
    const file = `${String(id).padStart(3, '0')}-slice.md`;
    const path = `docs/plans/active/${file}`;
    const text = logPlan({ id }).replace(LOG, `docs/plans/logs/${file}`).replace('owns: none', `owns: ${owns}`);
    return { folder: 'active', file, path, header: parsePlan(text).header, tasks: [{ n: 1, title: 'One' }] };
  };
  const noBase = () => null;
  const cap2 = mergeConfig({ maxOwnsPerSlice: 2 });

  const ownsNone = entry(1, 'none');
  assert.deepEqual(checkNewPlans({ plans: [ownsNone], changes: [{ status: 'A', path: ownsNone.path }], readBase: noBase, config: cap2 }), []);

  const ownsTwo = entry(1, '[src/a.ts, src/b.ts]');
  assert.deepEqual(checkNewPlans({ plans: [ownsTwo], changes: [{ status: 'A', path: ownsTwo.path }], readBase: noBase, config: cap2 }), []);

  const ownsThree = entry(1, '[src/a.ts, src/b.ts, src/c.ts]');
  assert.deepEqual(checkNewPlans({ plans: [ownsThree], changes: [{ status: 'A', path: ownsThree.path }], readBase: noBase }), [], 'within the default cap of 10');
  const errs = checkNewPlans({ plans: [ownsThree], changes: [{ status: 'A', path: ownsThree.path }], readBase: noBase, config: cap2 });
  assert.equal(errs.length, 1);
  assert.ok(errs[0].includes('new plan owns 3 paths (max 2)'), errs[0]);
  assert.ok(errs[0].includes('split the slice into smaller slices with narrower ownership'), errs[0]);

  const override = mergeConfig({ maxOwnsPerSlice: 2, extraTaskSlices: [1] });
  assert.deepEqual(checkNewPlans({ plans: [ownsThree], changes: [{ status: 'A', path: ownsThree.path }], readBase: noBase, config: override }), []);

  // Pre-existing plan on base branch with 3 owns passes.
  assert.deepEqual(checkNewPlans({ plans: [ownsThree], changes: [{ status: 'A', path: ownsThree.path }], readBase: (p) => (p === ownsThree.path ? 'x' : null), config: cap2 }), []);
});

test('git: 5.3 slice size gate enforces maxTasksPerSlice and maxOwnsPerSlice on new plans only, reading extraTaskSlices from base', () => {
  const tasksOf = (n) => `## Tasks\n\n${Array.from({ length: n }, (_, i) => `${i + 1}. Step ${i + 1}`).join('\n')}\n\n`;
  const makePlan = (id, name, taskCount, owns = 'none') => logPlan({ id })
    .replace(LOG, `docs/plans/logs/${name}.md`)
    .replace(TASKS, tasksOf(taskCount))
    .replace('owns: none', `owns: ${owns}`);

  // Base already has slice 001 with 5 tasks and 4 owned paths; it must stay valid.
  const root = makeRepo({
    [P]: makePlan(1, '001-app-shell', 5, '[src/a.ts, src/b.ts, src/c.ts, src/d.ts]'),
    [CONFIG_FILE]: JSON.stringify({ maxOwnsPerSlice: 2 }),
  });
  assert.ok(runChecker(root).ok, 'existing base plan with 5 tasks and 4 owns stays valid');

  git(root, 'checkout', '-qb', 'lead/plan-002');
  const P2 = 'docs/plans/active/002-big.md';
  write(root, 'docs/roadmap.md', `${ROADMAP_001}| 002 | Big | [plan](plans/active/002-big.md) |\n`);
  write(root, P2, makePlan(2, '002-big', 4, '[src/x.ts, src/y.ts, src/z.ts]'));
  git(root, 'add', '-A');
  const bad = runChecker(root, ['--staged']);
  assert.ok(!bad.ok);
  assert.ok(bad.out.includes(`${P2}: new plan has 4 tasks (max 3)`), bad.out);
  assert.ok(bad.out.includes(`${P2}: new plan owns 3 paths (max 2)`), bad.out);
  assert.ok(!bad.out.includes('001-app-shell.md'), bad.out);

  // Adding slice 2 to extraTaskSlices on the lead branch itself does not bypass the base branch gate.
  write(root, CONFIG_FILE, JSON.stringify({ maxOwnsPerSlice: 2, extraTaskSlices: [2] }));
  git(root, 'add', CONFIG_FILE);
  const bypass = runChecker(root, ['--staged']);
  assert.ok(!bypass.ok, 'lead branch cannot grant itself extraTaskSlices');
  assert.ok(bypass.out.includes(`${P2}: new plan has 4 tasks (max 3)`), bypass.out);

  // Within limits (3 tasks, 2 owns) passes.
  write(root, CONFIG_FILE, JSON.stringify({ maxOwnsPerSlice: 2 }));
  write(root, P2, makePlan(2, '002-big', 3, '[src/x.ts, src/y.ts]'));
  git(root, 'add', '-A');
  const okSmall = runChecker(root, ['--staged']);
  assert.ok(okSmall.ok, okSmall.out);

  // Owner adds slice 2 to extraTaskSlices on main; now 4 tasks and 3 owns pass on the lead branch.
  git(root, 'reset', '-q', '--hard');
  git(root, 'checkout', '-q', 'main');
  write(root, CONFIG_FILE, JSON.stringify({ maxOwnsPerSlice: 2, extraTaskSlices: [2] }));
  git(root, 'commit', '-qam', 'allow slice 2 extra tasks');
  git(root, 'checkout', '-q', 'lead/plan-002');
  git(root, 'rebase', '-q', 'main');
  write(root, 'docs/roadmap.md', `${ROADMAP_001}| 002 | Big | [plan](plans/active/002-big.md) |\n`);
  write(root, P2, makePlan(2, '002-big', 4, '[src/x.ts, src/y.ts, src/z.ts]'));
  git(root, 'add', '-A');
  const okOverride = runChecker(root, ['--staged']);
  assert.ok(okOverride.ok, okOverride.out);
});

test('5.3 slice size gate: a lead branch cannot waive or raise maxTasksPerSlice or maxOwnsPerSlice, and tightening takes effect', () => {
  const mkTasks = (count) => Array.from({ length: count }, (_, i) => ({ n: i + 1, title: `Task ${i + 1}` }));
  const entry = (id, count, owns = 'none') => {
    const file = `${String(id).padStart(3, '0')}-slice.md`;
    const path = `docs/plans/active/${file}`;
    const text = logPlan({ id }).replace(LOG, `docs/plans/logs/${file}`).replace('owns: none', `owns: ${owns}`);
    return { folder: 'active', file, path, header: parsePlan(text).header, tasks: mkTasks(count) };
  };
  const noBase = () => null;
  const check = (planEntry, config, baseConfig) => checkNewPlans({
    plans: [planEntry],
    changes: [{ status: 'A', path: planEntry.path }],
    readBase: noBase,
    config,
    baseConfig,
  });

  // 1. Lead branch sets maxTasksPerSlice to null or 10 while base has 3: still fails on a 4-task new plan.
  const fourTasks = entry(2, 4);
  const baseTasks3 = mergeConfig({ maxTasksPerSlice: 3 });
  assert.ok(has(check(fourTasks, mergeConfig({ maxTasksPerSlice: null }), baseTasks3), 'new plan has 4 tasks (max 3)'));
  assert.ok(has(check(fourTasks, mergeConfig({ maxTasksPerSlice: 10 }), baseTasks3), 'new plan has 4 tasks (max 3)'));

  // 2. Lead branch sets maxOwnsPerSlice to null or 10 while base has 2: still fails on a 3-owns new plan.
  const threeOwns = entry(2, 1, '[src/a.ts, src/b.ts, src/c.ts]');
  const baseOwns2 = mergeConfig({ maxOwnsPerSlice: 2 });
  assert.ok(has(check(threeOwns, mergeConfig({ maxOwnsPerSlice: null }), baseOwns2), 'new plan owns 3 paths (max 2)'));
  assert.ok(has(check(threeOwns, mergeConfig({ maxOwnsPerSlice: 10 }), baseOwns2), 'new plan owns 3 paths (max 2)'));

  // 3. Lead branch tightening the cap takes effect (null -> 2, and 4 -> 2).
  const threeTasks = entry(2, 3);
  assert.ok(has(check(threeTasks, mergeConfig({ maxTasksPerSlice: 2 }), mergeConfig({ maxTasksPerSlice: null })), 'new plan has 3 tasks (max 2)'));
  assert.ok(has(check(threeTasks, mergeConfig({ maxTasksPerSlice: 2 }), mergeConfig({ maxTasksPerSlice: 4 })), 'new plan has 3 tasks (max 2)'));
  assert.ok(has(check(threeOwns, mergeConfig({ maxOwnsPerSlice: 2 }), mergeConfig({ maxOwnsPerSlice: null })), 'new plan owns 3 paths (max 2)'));
  assert.ok(has(check(threeOwns, mergeConfig({ maxOwnsPerSlice: 2 }), mergeConfig({ maxOwnsPerSlice: 4 })), 'new plan owns 3 paths (max 2)'));

  // Both null keeps the cap off.
  assert.deepEqual(check(fourTasks, mergeConfig({ maxTasksPerSlice: null }), mergeConfig({ maxTasksPerSlice: null })), []);
  assert.deepEqual(check(threeOwns, mergeConfig({ maxOwnsPerSlice: null }), mergeConfig({ maxOwnsPerSlice: null })), []);
});

test('git: 5.3 lead branch cannot waive base maxTasksPerSlice or maxOwnsPerSlice in the same PR, and tightening takes effect', () => {
  const tasksOf = (n) => `## Tasks\n\n${Array.from({ length: n }, (_, i) => `${i + 1}. Step ${i + 1}`).join('\n')}\n\n`;
  const makePlan = (id, name, taskCount, owns = 'none') => logPlan({ id })
    .replace(LOG, `docs/plans/logs/${name}.md`)
    .replace(TASKS, tasksOf(taskCount))
    .replace('owns: none', `owns: ${owns}`);

  const root = makeRepo({
    [CONFIG_FILE]: JSON.stringify({ maxTasksPerSlice: 3, maxOwnsPerSlice: 2 }),
  });
  git(root, 'checkout', '-qb', 'lead/plan-002');
  const P2 = 'docs/plans/active/002-big.md';
  write(root, 'docs/roadmap.md', `${ROADMAP_001}| 002 | Big | [plan](plans/active/002-big.md) |\n`);
  write(root, P2, makePlan(2, '002-big', 4, '[src/x.ts, src/y.ts, src/z.ts]'));

  // Trying to waive caps with null on the lead branch still fails against base (3 tasks, 2 owns).
  write(root, CONFIG_FILE, JSON.stringify({ maxTasksPerSlice: null, maxOwnsPerSlice: null }));
  git(root, 'add', '-A');
  const waivedNull = runChecker(root, ['--staged']);
  assert.ok(!waivedNull.ok, 'lead branch cannot disable base caps with null');
  assert.ok(waivedNull.out.includes(`${P2}: new plan has 4 tasks (max 3)`), waivedNull.out);
  assert.ok(waivedNull.out.includes(`${P2}: new plan owns 3 paths (max 2)`), waivedNull.out);

  // Trying to raise caps to 10 on the lead branch still fails against base (3 tasks, 2 owns).
  write(root, CONFIG_FILE, JSON.stringify({ maxTasksPerSlice: 10, maxOwnsPerSlice: 10 }));
  git(root, 'add', CONFIG_FILE);
  const raised = runChecker(root, ['--staged']);
  assert.ok(!raised.ok, 'lead branch cannot raise base caps');
  assert.ok(raised.out.includes(`${P2}: new plan has 4 tasks (max 3)`), raised.out);
  assert.ok(raised.out.includes(`${P2}: new plan owns 3 paths (max 2)`), raised.out);

  // Tightening caps on the lead branch (3 -> 2 tasks, 2 -> 1 own) enforces the stricter branch limits.
  write(root, CONFIG_FILE, JSON.stringify({ maxTasksPerSlice: 2, maxOwnsPerSlice: 1 }));
  write(root, P2, makePlan(2, '002-big', 3, '[src/x.ts, src/y.ts]'));
  git(root, 'add', '-A');
  const tightened = runChecker(root, ['--staged']);
  assert.ok(!tightened.ok, 'tighter branch caps take effect');
  assert.ok(tightened.out.includes(`${P2}: new plan has 3 tasks (max 2)`), tightened.out);
  assert.ok(tightened.out.includes(`${P2}: new plan owns 2 paths (max 1)`), tightened.out);
});

// ---------- Kit 5.3.2: broad owns, maxOwnsPerSlice default 10, screen cap ----------

const sizeEntry = (id, owns) => {
  const file = `${String(id).padStart(3, '0')}-slice.md`;
  const path = `docs/plans/active/${file}`;
  const text = logPlan({ id }).replace(LOG, `docs/plans/logs/${file}`).replace('owns: none', `owns: ${owns}`);
  return { folder: 'active', file, path, header: parsePlan(text).header, tasks: [{ n: 1, title: 'One' }] };
};
const sizeCheck = (planEntry, config = DEFAULT_CONFIG, baseConfig = null) =>
  checkNewPlans({ plans: [planEntry], changes: [{ status: 'A', path: planEntry.path }], readBase: () => null, config, baseConfig });
const ownsList = (n, prefix = 'src/f') => `[${Array.from({ length: n }, (_, i) => `${prefix}${i + 1}.ts`).join(', ')}]`;

test('5.3.2 settings: forbidBroadOwns, screenPaths, maxScreensPerSlice, and maxPrProductLines defaults and validation', () => {
  assert.equal(DEFAULT_CONFIG.forbidBroadOwns, true);
  assert.deepEqual(DEFAULT_CONFIG.screenPaths, []);
  assert.equal(DEFAULT_CONFIG.maxScreensPerSlice, 2);
  assert.equal(DEFAULT_CONFIG.maxPrProductLines, 700);

  const ok = mergeConfig({ forbidBroadOwns: false, screenPaths: ['apps/mobile/app/'], maxScreensPerSlice: 3, maxPrProductLines: 0 });
  assert.equal(ok.forbidBroadOwns, false);
  assert.deepEqual(ok.screenPaths, ['apps/mobile/app/']);
  assert.equal(ok.maxScreensPerSlice, 3);
  assert.equal(ok.maxPrProductLines, 0);
  const off = mergeConfig({ maxScreensPerSlice: null, maxPrProductLines: null });
  assert.equal(off.maxScreensPerSlice, null);
  assert.equal(off.maxPrProductLines, null);

  for (const bad of ['true', 1, null, []]) assert.throws(() => mergeConfig({ forbidBroadOwns: bad }), /wrong type/, `forbidBroadOwns=${JSON.stringify(bad)}`);
  for (const bad of ['apps/', {}, null]) assert.throws(() => mergeConfig({ screenPaths: bad }), /wrong type/, `screenPaths=${JSON.stringify(bad)}`);
  for (const bad of [[''], [3], ['/abs/app/'], ['../up/']]) assert.throws(() => mergeConfig({ screenPaths: bad }), /"screenPaths" must list/, JSON.stringify(bad));
  for (const bad of [0, -1, 1.5]) assert.throws(() => mergeConfig({ maxScreensPerSlice: bad }), /"maxScreensPerSlice" must be a whole number/, `maxScreensPerSlice=${bad}`);
  for (const bad of [-1, 2.5]) assert.throws(() => mergeConfig({ maxPrProductLines: bad }), /"maxPrProductLines" must be a whole number/, `maxPrProductLines=${bad}`);
  for (const key of ['maxScreensPerSlice', 'maxPrProductLines']) {
    for (const bad of ['3', true, [], {}]) assert.throws(() => mergeConfig({ [key]: bad }), /wrong type/, `${key}=${JSON.stringify(bad)}`);
  }
});

test('5.3.2 broadClaim: a root, a folder above one, the repo root, or a wildcard is broad; a folder inside a root is not', () => {
  const roots = ['apps/mobile/', 'apps/server/', 'packages/core/'];
  for (const [entry, root] of [
    ['apps/mobile/', 'apps/mobile/'], ['apps/mobile', 'apps/mobile/'], ['apps/server/', 'apps/server/'], ['apps/', 'apps/mobile/'],
    ['packages/', 'packages/core/'], ['packages/core', 'packages/core/'], ['.', 'apps/mobile/'], ['./', 'apps/mobile/'], ['/', 'apps/mobile/'],
    ['*', 'apps/mobile/'], ['**', 'apps/mobile/'], ['**/*.ts', 'apps/mobile/'], ['apps/*', 'apps/mobile/'], ['apps/mobile/**', 'apps/mobile/'],
    ['APPS/Mobile/', 'apps/mobile/'],
  ]) assert.equal(broadClaim(entry, roots), root, entry);
  for (const entry of ['packages/core/locales/', 'apps/mobile/components/', 'apps/mobile/app.json', 'apps/mobile/components/**', 'apps/mobile2/', 'docs/notes.md']) {
    assert.equal(broadClaim(entry, roots), null, entry);
  }
  assert.equal(broadClaim('apps/', []), null, 'no roots: nothing is broad');
});

test('5.3.2 broadClaim: a "*" anywhere in a part cuts the claim there; brackets in route names do not', () => {
  const roots = ['apps/mobile/', 'apps/mobile/app/'];
  for (const [entry, root] of [
    ['apps/mobile/*.ts', 'apps/mobile/'], ['apps/mobile/**/*.ts', 'apps/mobile/'], ['apps/**/*.tsx', 'apps/mobile/'], ['*.ts', 'apps/mobile/'],
    ['apps/*/src/', 'apps/mobile/'], ['apps/mobile/app/*.tsx', 'apps/mobile/app/'], ['apps/mobile/app/**/*.tsx', 'apps/mobile/app/'],
    ['apps/mob*/app/', 'apps/mobile/'],
  ]) assert.equal(broadClaim(entry, roots), root, entry);
  for (const entry of ['apps/mobile/app/(tabs)/[id].tsx', 'apps/mobile/app/[slug]/', 'apps/mobile/app/(auth)/login.tsx', 'apps/mobile/components/*.tsx']) {
    assert.equal(broadClaim(entry, roots), null, entry);
  }
  assert.deepEqual(screenClaims(['apps/mobile/app/(tabs)/[id].tsx', 'apps/mobile/app/*.tsx'], ['apps/mobile/app/']), ['apps/mobile/app/(tabs)/[id].tsx', 'apps/mobile/app/*.tsx']);
});

test('5.3.2 a screen root is a broad claim even when maxScreensPerSlice is null', () => {
  const cfg = mergeConfig({ screenPaths: ['apps/mobile/app/'], maxScreensPerSlice: null });
  for (const broad of ['apps/mobile/app/', 'apps/mobile/app/*.tsx', 'apps/mobile/app/**/*.tsx', 'apps/']) {
    assert.ok(has(sizeCheck(sizeEntry(6, `[${broad}]`), cfg), `"owns" lists ${broad}, which claims all of apps/mobile/app/`), broad);
  }
  assert.deepEqual(sizeCheck(sizeEntry(6, '[apps/mobile/app/(tabs)/[id].tsx, apps/mobile/app/a.tsx, apps/mobile/app/b.tsx]'), cfg), [], 'no cap: three screens pass');
});

test('5.3.2 forbidBroadOwns: a new plan may not own a whole product root or a folder above one', () => {
  const cfg = mergeConfig({ productPaths: ['apps/mobile/', 'apps/server/', 'packages/core/'] });
  for (const broad of ['apps/mobile/', 'apps/server/', 'packages/', 'apps/', '.']) {
    const errs = sizeCheck(sizeEntry(4, `[${broad}, apps/mobile/components/Card.tsx]`), cfg);
    assert.ok(has(errs, `"owns" lists ${broad}, which claims all of`), `${broad}: ${errs.join('\n')}`);
    assert.ok(has(errs, 'own the specific folders or files this slice changes'), errs.join('\n'));
    assert.ok(has(errs, 'add slice 4 to "extraTaskSlices"'), errs.join('\n'));
  }
  // Specific folders strictly inside a product root pass.
  assert.deepEqual(sizeCheck(sizeEntry(4, '[packages/core/locales/, apps/mobile/components/]'), cfg), []);
  // forbidBroadOwns: false turns the check off; no productPaths means nothing to compare with.
  assert.deepEqual(sizeCheck(sizeEntry(4, '[apps/mobile/]'), mergeConfig({ productPaths: ['apps/mobile/'], forbidBroadOwns: false })), []);
  assert.deepEqual(sizeCheck(sizeEntry(4, '[apps/]'), mergeConfig({})), []);
  // extraTaskSlices waives it, but only from the base branch when a base is given.
  assert.deepEqual(sizeCheck(sizeEntry(4, '[apps/]'), mergeConfig({ productPaths: ['apps/mobile/'], extraTaskSlices: [4] })), []);
  assert.ok(has(sizeCheck(sizeEntry(4, '[apps/]'), mergeConfig({ productPaths: ['apps/mobile/'], extraTaskSlices: [4] }), mergeConfig({ productPaths: ['apps/mobile/'] })), '"owns" lists apps/'));
  // A lead branch cannot switch it off or drop the base branch's productPaths for its own new plan.
  const base = mergeConfig({ productPaths: ['apps/mobile/'] });
  assert.ok(has(sizeCheck(sizeEntry(4, '[apps/mobile/]'), mergeConfig({ forbidBroadOwns: false }), base), '"owns" lists apps/mobile/'));
  assert.ok(has(sizeCheck(sizeEntry(4, '[apps/mobile/]'), mergeConfig({ productPaths: [] }), base), '"owns" lists apps/mobile/'));
  // A plan already on the base branch is never broken by the new rule.
  const old = sizeEntry(4, '[apps/]');
  assert.deepEqual(checkNewPlans({ plans: [old], changes: [{ status: 'A', path: old.path }], readBase: (p) => (p === old.path ? 'x' : null), config: cfg }), []);
});

test('5.3.2 maxOwnsPerSlice defaults to 10: passes at 10, fails at 11, waived by extraTaskSlices, off with null', () => {
  assert.deepEqual(sizeCheck(sizeEntry(5, ownsList(10))), []);
  const errs = sizeCheck(sizeEntry(5, ownsList(11)));
  assert.equal(errs.length, 1, errs.join('\n'));
  assert.ok(errs[0].includes('new plan owns 11 paths (max 10)'), errs[0]);
  assert.deepEqual(sizeCheck(sizeEntry(5, ownsList(11)), mergeConfig({ extraTaskSlices: [5] })), []);
  assert.deepEqual(sizeCheck(sizeEntry(5, ownsList(11)), mergeConfig({ maxOwnsPerSlice: null })), []);
  // Off on the branch but on (by default) on the base: the base's 10 still counts.
  assert.ok(has(sizeCheck(sizeEntry(5, ownsList(11)), mergeConfig({ maxOwnsPerSlice: null }), mergeConfig({})), 'new plan owns 11 paths (max 10)'));
});

test('5.3.2 screen cap: at most maxScreensPerSlice owns entries inside screenPaths, and a screen root is broad', () => {
  const cfg = mergeConfig({ screenPaths: ['apps/mobile/app/'] });
  const screens = (n) => Array.from({ length: n }, (_, i) => `apps/mobile/app/screen${i + 1}.tsx`);
  assert.deepEqual(screenClaims([...screens(2), 'apps/mobile/components/', 'apps/mobile/app2/x.tsx'], ['apps/mobile/app/']), screens(2));

  assert.deepEqual(sizeCheck(sizeEntry(6, `[${screens(2).join(', ')}, apps/mobile/components/]`), cfg), []);
  const errs = sizeCheck(sizeEntry(6, `[${screens(3).join(', ')}]`), cfg);
  assert.equal(errs.length, 1, errs.join('\n'));
  assert.ok(errs[0].includes('new plan owns 3 screen paths (max 2'), errs[0]);
  assert.ok(errs[0].includes('split the slice so each one builds at most 2 screens'), errs[0]);
  assert.ok(errs[0].includes('apps/mobile/app/screen3.tsx'), errs[0]);

  // Waived by extraTaskSlices; skipped with no screenPaths; off with maxScreensPerSlice null.
  assert.deepEqual(sizeCheck(sizeEntry(6, `[${screens(3).join(', ')}]`), mergeConfig({ screenPaths: ['apps/mobile/app/'], extraTaskSlices: [6] })), []);
  assert.deepEqual(sizeCheck(sizeEntry(6, `[${screens(3).join(', ')}]`), mergeConfig({})), []);
  assert.deepEqual(sizeCheck(sizeEntry(6, `[${screens(3).join(', ')}]`), mergeConfig({ screenPaths: ['apps/mobile/app/'], maxScreensPerSlice: null })), []);
  // A higher cap on the branch does not beat the base branch's cap.
  assert.ok(has(sizeCheck(sizeEntry(6, `[${screens(3).join(', ')}]`), mergeConfig({ screenPaths: ['apps/mobile/app/'], maxScreensPerSlice: 5 }), cfg), 'owns 3 screen paths (max 2'));

  // The whole screen folder, or a folder above it, is a broad claim even with no productPaths.
  for (const broad of ['apps/mobile/app/', 'apps/mobile/', 'apps/']) {
    assert.ok(has(sizeCheck(sizeEntry(6, `[${broad}]`), cfg), `"owns" lists ${broad}, which claims all of apps/mobile/app/`), broad);
  }
  assert.deepEqual(sizeCheck(sizeEntry(6, '[apps/mobile/app/]'), mergeConfig({ screenPaths: ['apps/mobile/app/'], forbidBroadOwns: false })), []);
});

test('git: 5.3.2 broad owns and the screen cap are enforced by the checker on a lead branch', () => {
  const root = makeRepo({ [CONFIG_FILE]: JSON.stringify({ productPaths: ['apps/mobile/'], screenPaths: ['apps/mobile/app/'] }) });
  assert.ok(runChecker(root).ok);
  git(root, 'checkout', '-qb', 'lead/plan-002');
  const P2 = 'docs/plans/active/002-wide.md';
  const plan2 = (owns) => logPlan({ id: 2 }).replace(LOG, 'docs/plans/logs/002-wide.md').replace('owns: none', `owns: ${owns}`);
  write(root, 'docs/roadmap.md', `${ROADMAP_001}| 002 | Wide | [plan](plans/active/002-wide.md) |\n`);
  write(root, P2, plan2('[apps/mobile/]'));
  git(root, 'add', '-A');
  const broad = runChecker(root, ['--staged']);
  assert.ok(!broad.ok);
  assert.ok(broad.out.includes(`${P2}: "owns" lists apps/mobile/, which claims all of apps/mobile/`), broad.out);

  write(root, P2, plan2('[apps/mobile/app/a.tsx, apps/mobile/app/b.tsx, apps/mobile/app/c.tsx]'));
  git(root, 'add', '-A');
  const wide = runChecker(root, ['--staged']);
  assert.ok(!wide.ok);
  assert.ok(wide.out.includes(`${P2}: new plan owns 3 screen paths (max 2`), wide.out);

  write(root, P2, plan2('[apps/mobile/app/a.tsx, apps/mobile/components/]'));
  git(root, 'add', '-A');
  const narrow = runChecker(root, ['--staged']);
  assert.ok(narrow.ok, narrow.out);
});

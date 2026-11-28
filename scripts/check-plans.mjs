#!/usr/bin/env node
// Rule checker for projects that use the starter kit.
// Generalized from UniLex's scripts/check-plans.mjs (2026-11-11).
//
// What it does, in plain English:
//   It reads every plan file, the roadmap, and (on any branch that is not a lead branch) what the
//   branch changed compared with the main branch. It prints every broken rule and exits with code 1
//   if any rule is broken. Git hooks treat exit code 1 as "stop", so the commit is blocked.
//
// Run it from anywhere inside the repo:
//   node scripts/check-plans.mjs            checks the files on disk
//   node scripts/check-plans.mjs --staged   checks exactly what git is about to commit (the pre-commit hook uses this)
//   node scripts/check-plans.mjs --status   prints where the project stands (about 20 lines) and exits 0
// Options:
//   --root <dir>      check that repo folder instead of the one this script sits in (a trusted copy of the
//                     checker, saved outside the repo, uses this to check a branch that may have changed its own copy)
//   --branch <name>   use this branch name instead of the one git reports
//   --base <ref>      compare with this exact ref (for example origin/main) and read the trusted settings from it
//   --no-fetch        with --status: do not fetch from the remote first
// Its own tests:
//   node --test scripts/check-plans.test.mjs
//
// Settings: optional file scripts/kit.config.json (next to this script). Every key is optional.
// Unknown keys are an error, so a typo never silently turns a rule off. Keys:
//   baseBranch             branch other branches are compared with (default "main")
//   remote                 name of the shared copy on GitHub (default "origin")
//   plansDir               folder that holds active/ and completed/ plan folders (default "docs/plans")
//   roadmap                the roadmap file (default "docs/roadmap.md")
//   inbox                  the owner's inbox file; --status counts its To review and Decided, to apply items
//                          (default "docs/awaiting-decisions.md")
//   buildPrefix            branch prefix for builders (default "build/"); the rest must look like 001-short-name
//   leadPrefixes           branch prefixes for the head agent (default ["lead/"]); these branches have no limits
//   researchPrefix         branch prefix for research workers (default "research/")
//   researchDir            the only folder a research branch may add or change files in (default "docs/research/")
//   extraLeadOnly          more lead-only paths, added to the defaults (a path ending in "/" means the whole folder)
//   lineLimits             { "file": maxLines } for files every agent reads every time (added to the defaults;
//                          a file listed here and in the defaults uses your number)
//   sameModelReviewSlices  slice ids the owner allowed to be built and reviewed by the same model
//   emDashSkipDirs         folders whose Markdown may contain em dashes (for example copied outside text)
//   models                 { "headAgent": ["tool/model-id", ...], "builder": "tool/model-id", "reviewer": "tool/model-id" }
//                          the one place the project's models are written. The reviewer must differ from the
//                          builder and from every head agent model (the head agent fixes small findings itself).
//   checks                 the project's own checks, run by scripts/merge-pr.mjs: a list of
//                          { "name": "test", "run": "pnpm test", "slot": true }. "slot": true means the command
//                          is a full test run and must hold the machine's test slot while it runs.
//   paperworkPaths         paths that count as paperwork (default ["docs/", "AGENTS.md"]). A pull request that
//                          changes only these skips the project's own checks in scripts/merge-pr.mjs.
//   staleMinutes           --status marks the last push STALE when it is older than this (default 90)
//   planMaxBytes           size limit, in bytes, for a plan in the log format (default 12288, which is 12 KB)
//   features, numberedPaths, testPaths, checkSettingsPaths, snapshotPaths, highRiskPaths  read by scripts/merge-pr.mjs, which explains and checks them
//                          (a "features" value is true, false, "off", "observe", or "enforce"; this checker reads
//                          only claimCheck: on for true or "enforce", and "observe" is refused)
//   quickReviewPaths       folders and files a small change may touch and still get a quick review (default [])
//   quickReviewMaxLines    most lines added plus removed for a quick review (default 50); both read by
//                          scripts/review-level.mjs
//   maxReviewRounds        most review rounds allowed per slice before scripts/receipt.mjs make stops
//                          (default 12, warning at round 8; 0 turns the cap off; REV-6)
//   graceReviewRound       allow 1 convergence grace round past the cap when the prior round has
//                          <= 2 important findings and converged (default true; REV-6)
//   extraReviewRoundSlices slice ids the owner allowed past maxReviewRounds (read from the base branch)
//   maxTasksPerSlice       most numbered tasks allowed in a new plan (default 3; null turns the cap off)
//   maxOwnsPerSlice        most paths allowed in a new plan's "owns" list (default 10; null turns the cap off)
//   forbidBroadOwns        refuse a new plan whose "owns" claims a whole productPaths or screenPaths root, or a
//                          folder above one, like apps/, packages/, or "." (default true; false turns it off)
//   screenPaths            folders that hold screens, like ["apps/mobile/app/"] (default [], and then no screen cap)
//   maxScreensPerSlice     most "owns" entries inside screenPaths in a new plan (default 2; null turns the cap off)
//   maxPrProductLines      lines of product code a pull request may add before scripts/merge-pr.mjs prints a
//                          warning to split it (default 700; null or 0 turns the warning off). It never blocks.
//   extraTaskSlices        slice ids the owner allowed past maxTasksPerSlice, maxOwnsPerSlice, forbidBroadOwns,
//                          or maxScreensPerSlice (read from the base branch)
//   maxTaskReviewRounds    most review rounds allowed per task before stopping (default 4; null turns the cap off)
//   A "checks" entry may also carry "observe": true: the check runs and is recorded, but does not stop a merge.
//   presets, productPaths, notYetClean  read by scripts/presets.mjs, scripts/switch-offs.mjs, and scripts/ratchets.mjs
//
// Plan formats: a plan whose header has a "log" field (log: docs/plans/logs/NNN-short-name.md) is in the
// log format. Its progress notes, handoffs, and review findings live in that log file, the plan must stay
// under planMaxBytes, and it may not have a Progress log or Notes for the lead section. A plan without the
// field is in the old format and is checked as before. A plan file added on a lead branch (neither its name
// nor its three-digit id is in a plan folder on the base branch) must be in the log format, and its
// "## Tasks" section must hold a numbered list: each task starts a line as "N. text", numbered 1, 2, 3
// with no gaps or repeats. The plan says what the tasks are; scripts/slice.mjs logs what happened to each
// one. A new plan also needs the
// header fields invariants, risk, undo, owns, and proof (NEW_PLAN_FIELDS below explains each).
//
// Path claims: two running plans (in active/, status in_progress or in_review) may not own the same path,
// or one path inside the other, in their "owns" fields.
// Invariants: if docs/invariants.md has the line "Format: kit invariants table, version 1" (a file
// without it is not read), each row's id is INV-N and used once, its state is "protected"
// or "not yet", and a protected row's check is a file in the repo. A new plan may only name ids that are in it.
// On a build branch, a changed path another running plan owns is refused, and "owns: none" allows paperwork only.
// Verify recipe and change checklist: docs/verify.md and docs/change-checklist.md are checked only when they
// hold their format lines (VERIFY_MARKER, CHECKLIST_MARKER below). Both are lead-only.
// --status counts open asks for Stephen in the event log (<git common dir>/kit-events.jsonl).
//
// Branch classes (fail closed: a branch the checker does not know gets limits, not a free pass):
//   the base branch, or a leadPrefixes branch   lead: no limits
//   a buildPrefix branch                        builder rules: no lead-only files, only its own plan's builder
//                                               sections, and only its own slice's log file
//   a researchPrefix branch                     may only add or change files under researchDir
//   anything else, or a detached HEAD           may not change lead-only files or any plan
//
// Whose settings count: a branch that is not a lead branch is checked with the settings on the base
// branch, never its own copy, so it cannot loosen a rule by editing scripts/kit.config.json (and that edit
// is reported as a lead-only change). A lead branch is checked with its own settings, so a lead can change them.
// The pre-commit hook has to guess the base from the settings being committed, so it only catches honest
// mistakes. scripts/merge-pr.mjs passes --base, and that is the check that counts.
//
// Starter kit manifest: if scripts/kit.manifest.json exists, every file it lists must still match the
// fingerprint (sha256) recorded there. Those files come from the starter kit and are never edited in a project.
//
// No outside libraries: it runs on any machine with Node.js 18 or newer.

import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { join, relative, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

// Other scripts read this to tell what a copy of the checker understands:
// 2 added --root and --branch; 3 added --base and settings read from the base branch.
export const CHECKER_API = 3;

// ---------- The rules, as data ----------

// parked: stopped on purpose (for example at a token limit), waiting for the head agent to split it or for
// the owner. It keeps its number, has no build branch, and is never the next free slice.
export const STATUSES = ['todo', 'in_progress', 'in_review', 'blocked', 'parked', 'done'];
export const HEADER_KEYS = ['id', 'status', 'depends_on', 'builder', 'reviewer', 'tests', 'code'];
export const REQUIRED_SECTIONS = ['Goal', 'Done when', 'Review'];

// A build branch may only exist for a slice in one of these statuses.
// in_review is allowed because the builder's branch keeps existing while the reviewer reads it.
export const BUILD_STATUSES = ['in_progress', 'in_review'];

// A slice in one of these statuses is being worked on right now.
export const LIVE_STATUSES = ['in_progress', 'in_review'];

// The only plan sections a builder may change. Everything else in a plan is locked for builders.
// That is for a plan in the old format. In a plan in the log format, a builder may change only LOG_BUILDER_SECTIONS;
// progress notes and handoffs go in the log file, and LOG_FORMAT_MOVED sections may not exist in the plan.
export const BUILDER_SECTIONS = ['Progress log', 'Decision log', 'Notes for the lead'];
export const LOG_BUILDER_SECTIONS = ['Decision log'];
export const LOG_FORMAT_MOVED = ['Progress log', 'Notes for the lead'];
// Header fields a new plan must have (checkNewPlans), and that an older plan may leave out:
//   invariants  the ids from docs/invariants.md this slice touches, like [INV-1, INV-3], or none
//   risk        high or normal
//   undo        one line: how to undo this slice
//   owns        the paths and folders this slice owns, like [src/search/, src/api/search.ts], or none
//   proof       one line: what will be shown to prove it works
// A plan that has any of them must also have matched_plan once it is done: yes, or no and one line on
// what differed ("no, the export moved to slice 12").
export const NEW_PLAN_FIELDS = ['invariants', 'risk', 'undo', 'owns', 'proof'];
export const RISKS = ['high', 'normal'];
// Header fields a plan may have but does not need. "log" marks a plan in the log format.
export const OPTIONAL_HEADER_KEYS = ['log', ...NEW_PLAN_FIELDS, 'matched_plan'];
export const INVARIANTS_FILE = 'docs/invariants.md';
export const INVARIANT_STATES = ['protected', 'not yet'];
// The line that tells the checker docs/invariants.md is in the table shape above (checkInvariants).
export const INVARIANTS_MARKER = 'Format: kit invariants table, version 1';
// The verify recipe: how to run each part of the app and see a change work. Read only with its format line.
export const VERIFY_FILE = 'docs/verify.md';
export const VERIFY_MARKER = 'Format: kit verify recipe, version 1';
export const VERIFY_KEYS = ['Start', 'Try', 'Look', 'Stop', 'Takes'];
// The change checklist: things to check when a change touches certain paths. Read only with its format line.
export const CHECKLIST_FILE = 'docs/change-checklist.md';
export const CHECKLIST_MARKER = 'Format: kit change checklist, version 1';
export const CHECKLIST_COLUMNS = ['Id', 'When the change touches', 'Check this', 'Why'];
const INVARIANT_ID = /^INV-\d+$/;

export const CONFIG_FILE = 'scripts/kit.config.json';
export const MANIFEST_FILE = 'scripts/kit.manifest.json';

// Starter kit scripts a project copies in. A builder must not be able to weaken any of them.
const KIT_SCRIPTS = ['merge-pr', 'slot', 'ram-health', 'clean-worktrees'];

export const DEFAULT_CONFIG = Object.freeze({
  baseBranch: 'main',
  remote: 'origin',
  plansDir: 'docs/plans',
  roadmap: 'docs/roadmap.md',
  inbox: 'docs/awaiting-decisions.md',
  buildPrefix: 'build/',
  leadPrefixes: ['lead/'],
  researchPrefix: 'research/',
  researchDir: 'docs/research/',
  extraLeadOnly: [],
  lineLimits: { 'AGENTS.md': 120, 'docs/handoff.md': 30 },
  sameModelReviewSlices: [],
  emDashSkipDirs: [],
  models: { headAgent: [], builder: '', reviewer: '' },
  checks: [],
  paperworkPaths: ['docs/', 'AGENTS.md'],
  staleMinutes: 90,
  planMaxBytes: 12288,
  features: {},
  numberedPaths: ['docs/plans/', 'docs/decisions/'],
  testPaths: ['.test.', '.spec.', '__tests__/', '__snapshots__/', 'tests/', 'test/'],
  presets: [],
  productPaths: [],
  notYetClean: [],
  highRiskPaths: [],
  checkSettingsPaths: [],
  quickReviewPaths: [],
  quickReviewMaxLines: 50,
  maxReviewRounds: 12,
  graceReviewRound: true,
  extraReviewRoundSlices: [],
  maxTasksPerSlice: 3,
  maxOwnsPerSlice: 10,
  forbidBroadOwns: true,
  screenPaths: [],
  maxScreensPerSlice: 2,
  maxPrProductLines: 700,
  extraTaskSlices: [],
  maxTaskReviewRounds: 4,
  snapshotPaths: [],
});

// Files and folders only the head agent may change, before any extraLeadOnly paths are added.
// A path ending in "/" means everything inside. The plan folder entries follow plansDir.
export function leadOnlyPaths(config = DEFAULT_CONFIG) {
  return [
    'AGENTS.md',
    'README.md',
    'docs/spec.md',
    'docs/roadmap.md',
    'docs/handoff.md',
    'docs/awaiting-decisions.md',
    'docs/planning-required.md',
    'docs/reviewed-choices.md',
    'docs/architecture.md',
    'docs/glossary.md',
    'docs/project-rules.md',
    'docs/lessons.md',
    'REVIEW.md',
    'docs/invariants.md',
    'docs/mistakes.md',
    'docs/check-trials.md',
    VERIFY_FILE,
    CHECKLIST_FILE,
    'docs/decisions/',
    'docs/agents/',
    'docs/threads/',
    // Run files hold the token limit the owner approved; a builder must not raise its own.
    'docs/runs/',
    `${config.plansDir}/completed/`,
    `${config.plansDir}/_template.md`,
    // The checker, its tests, and its settings: a builder must not be able to switch a rule off.
    'scripts/check-plans.mjs',
    'scripts/check-plans.test.mjs',
    CONFIG_FILE,
    MANIFEST_FILE,
    ...KIT_SCRIPTS.flatMap((name) => [`scripts/${name}.mjs`, `scripts/${name}.test.mjs`]),
    '.githooks/',
    '.github/',
    ...config.extraLeadOnly,
  ];
}

// Reads and checks the settings file. Missing file means defaults. Bad settings throw, so the run fails loud.
export function loadConfig(root) {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
  }
  return mergeConfig(raw);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const NULLABLE_INT_KEYS = new Set(['maxTasksPerSlice', 'maxOwnsPerSlice', 'maxTaskReviewRounds', 'maxScreensPerSlice', 'maxPrProductLines']);

export function mergeConfig(raw) {
  if (!isObject(raw)) throw new Error(`${CONFIG_FILE} must be a JSON object`);
  const bad = (msg) => {
    throw new Error(`${CONFIG_FILE}: ${msg}`);
  };
  const config = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULT_CONFIG)) throw new Error(`${CONFIG_FILE} has unknown setting "${key}" (allowed: ${Object.keys(DEFAULT_CONFIG).join(', ')})`);
    const want = DEFAULT_CONFIG[key];
    if (NULLABLE_INT_KEYS.has(key)) {
      if (value !== null && typeof value !== 'number') bad(`"${key}" has the wrong type (expected number or null)`);
    } else {
      const ok = Array.isArray(want) ? Array.isArray(value) : typeof want === typeof value && value !== null && !Array.isArray(value);
      if (!ok) bad(`"${key}" has the wrong type (expected ${Array.isArray(want) ? 'a list' : typeof want})`);
    }
    if (key === 'models') {
      for (const k of Object.keys(value)) {
        if (!(k in DEFAULT_CONFIG.models)) bad(`"models" has unknown key "${k}" (allowed: ${Object.keys(DEFAULT_CONFIG.models).join(', ')})`);
      }
    }
    // lineLimits and models add to the defaults, so listing one entry never drops the others.
    config[key] = key === 'lineLimits' || key === 'models' ? { ...want, ...value } : value;
  }

  for (const key of ['buildPrefix', 'researchPrefix', 'researchDir']) {
    if (!config[key].endsWith('/')) bad(`"${key}" must end with "/", like "${DEFAULT_CONFIG[key]}"`);
  }
  if (config.leadPrefixes.some((p) => !isText(p) || !p.endsWith('/'))) bad('"leadPrefixes" must list prefixes that end with "/", like "lead/"');
  for (const key of ['extraLeadOnly', 'emDashSkipDirs', 'paperworkPaths', 'presets', 'productPaths', 'notYetClean', 'highRiskPaths', 'checkSettingsPaths', 'snapshotPaths', 'quickReviewPaths', 'screenPaths']) {
    if (config[key].some((p) => !isText(p))) bad(`"${key}" must list paths (text, not empty)`);
  }
  if (config.sameModelReviewSlices.some((id) => !Number.isInteger(id))) bad('"sameModelReviewSlices" must list slice ids (whole numbers)');
  if (config.extraReviewRoundSlices.some((id) => !Number.isInteger(id))) bad('"extraReviewRoundSlices" must list slice ids (whole numbers)');
  if (config.extraTaskSlices.some((id) => !Number.isInteger(id) || id < 0)) bad('"extraTaskSlices" must list slice ids (whole numbers, 0 or more)');
  if (!Number.isFinite(config.staleMinutes) || config.staleMinutes < 0) bad('"staleMinutes" must be a number of minutes, 0 or more');
  if (!Number.isInteger(config.planMaxBytes) || config.planMaxBytes < 1) bad('"planMaxBytes" must be a whole number of bytes, 1 or more');
  if (!Number.isInteger(config.quickReviewMaxLines) || config.quickReviewMaxLines < 0) bad('"quickReviewMaxLines" must be a whole number of lines, 0 or more');
  if (!Number.isInteger(config.maxReviewRounds) || config.maxReviewRounds < 0) bad('"maxReviewRounds" must be a whole number of rounds, 0 or more');
  if (config.maxTasksPerSlice !== null && (!Number.isInteger(config.maxTasksPerSlice) || config.maxTasksPerSlice < 1)) {
    bad('"maxTasksPerSlice" must be a whole number of tasks, 1 or more, or null to turn the cap off');
  }
  if (config.maxOwnsPerSlice !== null && (!Number.isInteger(config.maxOwnsPerSlice) || config.maxOwnsPerSlice < 1)) {
    bad('"maxOwnsPerSlice" must be a whole number of paths, 1 or more, or null to turn the cap off');
  }
  if (config.maxScreensPerSlice !== null && (!Number.isInteger(config.maxScreensPerSlice) || config.maxScreensPerSlice < 1)) {
    bad('"maxScreensPerSlice" must be a whole number of screen paths, 1 or more, or null to turn the cap off');
  }
  if (config.maxPrProductLines !== null && (!Number.isInteger(config.maxPrProductLines) || config.maxPrProductLines < 0)) {
    bad('"maxPrProductLines" must be a whole number of lines, 0 or more, or null (0 and null turn the warning off)');
  }
  if (config.screenPaths.some((p) => ownPath(p) === null)) bad('"screenPaths" must list folders from the repo root, like "apps/mobile/app/"');
  if (config.maxTaskReviewRounds !== null && (!Number.isInteger(config.maxTaskReviewRounds) || config.maxTaskReviewRounds < 1)) {
    bad('"maxTaskReviewRounds" must be a whole number of rounds, 1 or more, or null to turn the cap off');
  }
  // The other switches and their modes are checked by scripts/merge-pr.mjs. The claim check runs in a git hook,
  // which can only stop a commit or let it through, so it has no "observe" mode.
  if (config.features.claimCheck === 'observe') bad('"features.claimCheck" cannot be "observe": the claim check runs in a git hook, which cannot watch without stopping. Use "enforce" (or true) to turn it on, or "off" (or false)');

  const { headAgent, builder, reviewer } = config.models;
  if (!Array.isArray(headAgent) || headAgent.some((m) => typeof m !== 'string' || !modelOf(m))) {
    bad('"models.headAgent" must be a list of tool/model-id, for example ["claude/claude-opus-5-5"]');
  }
  for (const [k, v] of [['builder', builder], ['reviewer', reviewer]]) {
    if (typeof v !== 'string' || (v && !modelOf(v))) bad(`"models.${k}" must look like tool/model-id, or "" if not chosen yet`);
  }
  if (reviewer) {
    const r = modelOf(reviewer);
    if (builder && modelOf(builder) === r) bad(`"models.reviewer" and "models.builder" are both the model "${r}"; the reviewer must be a different model`);
    if (headAgent.some((m) => modelOf(m) === r)) {
      bad(`"models.reviewer" is the model "${r}", which is also a head agent model; the head agent fixes small findings, so the reviewer would check its own model's code`);
    }
  }

  const names = new Set();
  config.checks.forEach((check, i) => {
    const where = `"checks" entry ${i + 1}`;
    if (!isObject(check)) bad(`${where} must be an object like { "name": "test", "run": "pnpm test", "slot": true }`);
    for (const k of Object.keys(check)) if (!['name', 'run', 'slot', 'fast', 'observe', 'protects', 'misses'].includes(k)) bad(`${where} has unknown key "${k}" (allowed: name, run, slot, fast, observe, protects, misses)`);
    if (!isText(check.name)) bad(`${where} needs a "name" (text)`);
    if (!isText(check.run)) bad(`${where} needs a "run" command (text)`);
    if ('slot' in check && typeof check.slot !== 'boolean') bad(`${where}: "slot" must be true or false`);
    for (const k of ['fast', 'observe']) if (k in check && typeof check[k] !== 'boolean') bad(`${where}: "${k}" must be true or false`);
    for (const k of ['protects', 'misses']) if (k in check && typeof check[k] !== 'string') bad(`${where}: "${k}" must be text`);
    if (names.has(check.name)) bad(`"checks" has two entries named "${check.name}"`);
    names.add(check.name);
  });
  return config;
}

const PLAN_FILE = /^(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SLICE_NAME = /^(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
// tool/model, where model is the model id exactly as your agent tool lists it, e.g. claude/claude-opus-5-5
const MODEL_FIELD = /^([a-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const REVIEW_LINE = /^Review: approved by (\S+) on (\d{4}-\d{2}-\d{2})\s*$/m;
const CHECKBOX = /^\s*- \[[ xX]\]/m;
const EM_DASH = '\u2014';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.expo', '.next', 'dist', 'build', 'coverage']);

// ---------- Reading a plan ----------

const normalize = (text) => text.replace(/\r\n/g, '\n');

// Splits a plan into its header (the fields between the --- lines) and its body.
// The header format is kept simple on purpose: one "key: value" per line,
// and lists written on one line like [1, 2] or [a.ts, b.ts].
export function parsePlan(text) {
  const errors = [];
  const match = normalize(text).match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) {
    return { header: null, body: text, errors: ['no header: the file must start with a --- line, the fields, then another --- line'] };
  }
  const [, headerText, body] = match;
  const header = {};
  for (const raw of headerText.split('\n')) {
    const line = stripComment(raw).trimEnd();
    if (!line.trim()) continue;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) {
      errors.push(`header line not understood: "${raw}"`);
      continue;
    }
    const [, key, value] = kv;
    if (key in header) errors.push(`header field "${key}" appears twice`);
    header[key] = parseValue(value);
  }
  return { header, body, errors };
}

// Walks a header line and calls at(i) for each character outside quotes. A quote (" or ') only opens
// where a value or list item starts (after ":", "[", or ","), so an apostrophe inside a word is just a letter.
function outsideQuotes(text, at) {
  let quote = null;
  let last = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++; // an escaped character, such as \", never ends the quote
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && [':', '[', ','].includes(last)) quote = c;
    else if (at(i) === false) return;
    if (!/\s/.test(c)) last = c;
  }
}

// A header line without its comment: from a space and "#" outside quotes to the end.
function stripComment(line) {
  let end = line.length;
  outsideQuotes(line, (i) => {
    if (line[i] !== '#' || !/\s/.test(line[i - 1] ?? '')) return true;
    end = i;
    return false;
  });
  return line.slice(0, end);
}

function parseValue(value) {
  const v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    // Split at each comma outside quotes. The leading "," lets a quote open the first item; it shifts
    // every index by one, so character i of the walked text is inner[i - 1].
    const items = [];
    let start = 0;
    outsideQuotes(`,${inner}`, (i) => {
      if (i > 0 && inner[i - 1] === ',') {
        items.push(inner.slice(start, i - 1));
        start = i;
      }
    });
    items.push(inner.slice(start));
    return items.map((s) => parseScalar(s.trim()));
  }
  return parseScalar(v);
}

function parseScalar(s) {
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  return s;
}

// The one place that decides what a section heading is. Every other function uses it,
// so they can never disagree. Markdown allows up to 3 leading spaces before "##".
// Returns the heading name, or null if the line is not a "## " heading.
export function headingOf(line) {
  const m = line.match(/^ {0,3}##[ \t]+(.*?)[ \t]*$/);
  return m ? m[1] : null;
}

// Returns the text under "## name", up to the next "## " heading. Null if the section is missing.
export function getSection(body, name) {
  const lines = normalize(body).split('\n');
  const start = lines.findIndex((l) => headingOf(l) === name);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => headingOf(l) !== null);
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// Section names that appear more than once, like two "## Review" headings.
export function duplicateSections(body) {
  const names = normalize(body).split('\n').map(headingOf).filter((n) => n !== null);
  return [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
}

// A task's title is cut to this many characters.
export const TASK_TITLE_MAX = 80;

// The numbered tasks under "## Tasks": [{ n, title }], in the order written. A task starts a line at
// column 0 as "N. text". title is that first line without Markdown bold markers, cut to TASK_TITLE_MAX.
// Prose before the list, indented lines, and anything inside an HTML comment are not tasks.
// The numbers come back as written, so tasksProblem can see a gap or a repeat.
export function parseTasks(planText) {
  const section = getSection(String(planText ?? ''), 'Tasks');
  if (section === null) return [];
  const tasks = [];
  for (const line of section.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const m = line.match(/^(\d+)\.[ \t]+(\S.*)$/);
    if (m) tasks.push({ n: Number(m[1]), title: m[2].replace(/\*\*/g, '').trim().slice(0, TASK_TITLE_MAX) });
  }
  return tasks;
}

// What is wrong with a task list, as one sentence, or null when it is numbered 1, 2, 3 with at least one task.
export function tasksProblem(tasks) {
  if (!tasks.length) return 'the "## Tasks" section needs at least one numbered task, each starting a line like "1. Build the search box"';
  if (tasks.every((t, i) => t.n === i + 1)) return null;
  return `the tasks under "## Tasks" are numbered ${tasks.map((t) => t.n).join(', ')}; number them 1, 2, 3 in order, with no gaps or repeats`;
}

// The part of a plan a builder may not change: the whole file minus the text under the builder sections.
// Headings are kept, so adding or removing a section heading also counts as a change.
// sections: the ones a builder may change (BUILDER_SECTIONS for an old-format plan).
export function lockedPart(text, sections = BUILDER_SECTIONS) {
  const out = [];
  let inBuilderSection = false;
  for (const line of normalize(text).trimEnd().split('\n')) {
    const heading = headingOf(line);
    if (heading !== null) {
      inBuilderSection = sections.includes(heading);
      out.push(line);
    } else if (!inBuilderSection) {
      out.push(line);
    }
  }
  return out.join('\n');
}

// "codex/gpt-6.1-sol" -> "gpt-6.1-sol". Null if the text is not in tool/model form.
export function modelOf(field) {
  const m = String(field).match(MODEL_FIELD);
  return m ? m[2] : null;
}

// ---------- Checking one plan ----------

// file: e.g. "001-app-shell.md". folder: "active" or "completed".
export function validatePlan(text, file, folder, config = DEFAULT_CONFIG) {
  const where = `${config.plansDir}/${folder}/${file}`;
  const { header, body, errors: parseErrors } = parsePlan(text);
  const errors = parseErrors.map((e) => `${where}: ${e}`);
  if (!header) return { errors, header: null };
  const err = (msg) => errors.push(`${where}: ${msg}`);

  const keys = Object.keys(header);
  for (const k of HEADER_KEYS) if (!keys.includes(k)) err(`header is missing "${k}"`);
  const allowed = [...HEADER_KEYS, ...OPTIONAL_HEADER_KEYS];
  for (const k of keys) if (!allowed.includes(k)) err(`header has unknown field "${k}" (allowed: ${allowed.join(', ')})`);

  // The log format: a size limit, and the long running notes live in the log file, not the plan.
  if ('log' in header) {
    const want = logPathFor(file, config);
    if (header.log !== want) err(`"log" must be ${want}, the log file named like the plan`);
    const size = Buffer.byteLength(normalize(text), 'utf8');
    if (size > config.planMaxBytes) {
      err(`plan is ${size} bytes; keep it at ${config.planMaxBytes} or fewer (${CONFIG_FILE}, planMaxBytes). Move progress notes, handoffs, review findings, and test tables to ${want}`);
    }
    for (const s of LOG_FORMAT_MOVED) {
      if (getSection(body, s) !== null) err(`has a "## ${s}" section, but a plan with a "log" field keeps that in ${want}`);
    }
  }

  const nameMatch = file.match(PLAN_FILE);
  if (!nameMatch) err('file name must look like 003-save-word.md (three digits, a dash, lowercase words joined by dashes)');
  if (!Number.isInteger(header.id)) err('"id" must be a whole number');
  else if (nameMatch && Number(nameMatch[1]) !== header.id) err(`"id" is ${header.id} but the file name says ${Number(nameMatch[1])}`);

  if (!STATUSES.includes(header.status)) err(`"status" must be one of: ${STATUSES.join(', ')}`);
  for (const k of ['depends_on', 'tests', 'code']) {
    if (k in header && !Array.isArray(header[k])) err(`"${k}" must be a list, like [] or [1, 2]`);
  }
  if (Array.isArray(header.depends_on) && header.depends_on.some((d) => !Number.isInteger(d))) err('"depends_on" must list slice ids (whole numbers)');

  for (const k of ['builder', 'reviewer']) {
    if (!(k in header)) continue;
    if (typeof header[k] !== 'string') err(`"${k}" must be text, like claude/claude-opus-5-5, or "" if not chosen yet`);
    else if (header[k] && !modelOf(header[k])) err(`"${k}" must look like tool/model-id, for example claude/claude-opus-5-5 or codex/gpt-6.1-sol`);
  }

  const { status, builder, reviewer } = header;
  const needsBuilder = ['in_progress', 'in_review', 'parked', 'done'].includes(status);
  const needsReviewer = ['in_review', 'done'].includes(status);
  const sameModelAllowed = config.sameModelReviewSlices.includes(header.id);
  if (needsBuilder && !builder) err(`status is "${status}" but "builder" is empty`);
  if (needsReviewer && !reviewer) err(`status is "${status}" but "reviewer" is empty`);
  if (builder && reviewer && modelOf(builder) && modelOf(builder) === modelOf(reviewer) && !sameModelAllowed) {
    err(`builder and reviewer are both the model "${modelOf(builder)}"; the reviewer must be a different model, not just a different tool`);
  }
  // The head agent fixes small review findings itself, so a reviewer on the head agent's model would be
  // checking its own model's code. Checked only while the slice is live: finished plans are not re-judged.
  const headModels = (config.models?.headAgent ?? []).map(modelOf);
  if (LIVE_STATUSES.includes(status) && typeof reviewer === 'string' && modelOf(reviewer) && headModels.includes(modelOf(reviewer)) && !sameModelAllowed) {
    err(`reviewer is the model "${modelOf(reviewer)}", which is also a head agent model (${CONFIG_FILE}, models.headAgent); the head agent fixes small findings, so pick a reviewer on a different model`);
  }

  // The new plan fields: their values are checked whenever a plan has them; checkNewPlans requires them.
  const { invariants, owns } = header;
  if ('invariants' in header && invariants !== 'none' && !(Array.isArray(invariants) && invariants.length && invariants.every((id) => INVARIANT_ID.test(String(id))))) {
    err('"invariants" must be none, or a list of ids from docs/invariants.md like [INV-1, INV-3]');
  }
  if ('risk' in header && !RISKS.includes(header.risk)) err(`"risk" must be ${RISKS.join(' or ')}`);
  for (const k of ['undo', 'proof']) if (k in header && !isText(header[k])) err(`"${k}" needs one line of text`);
  if ('owns' in header && owns !== 'none' && !(Array.isArray(owns) && owns.length && owns.every((p) => ownPath(p)))) {
    err('"owns" must be none (a docs-only slice), or a list of paths from the repo root like [src/search/, src/api/search.ts]');
  } else if (Array.isArray(owns) && owns.some((p) => insidePlans(p, config))) {
    err(`"owns" may not list ${config.plansDir} or anything inside it: plan files and logs already follow the plan rules`);
  }
  if ('matched_plan' in header && !/^(yes|no[\s,:;]+\S.*)$/.test(String(header.matched_plan))) {
    err('"matched_plan" must be yes, or no and one line on what differed, like "no, the export moved to slice 12"');
  } else if (status === 'done' && !('matched_plan' in header) && NEW_PLAN_FIELDS.some((k) => k in header)) {
    err('status is "done" but the header has no "matched_plan": write yes, or no and one line on what differed from the plan');
  }

  if (status === 'done' && folder !== 'completed') err(`status is "done", so the plan must move to ${config.plansDir}/completed/`);
  if (status !== 'done' && folder === 'completed') err(`plan is in completed/ but status is "${status}"`);

  for (const s of REQUIRED_SECTIONS) {
    if (getSection(body, s) === null) err(`missing the "## ${s}" section`);
  }
  for (const s of duplicateSections(body)) err(`the "## ${s}" section appears more than once`);
  const doneWhen = getSection(body, 'Done when');
  if (doneWhen !== null && !CHECKBOX.test(doneWhen)) err('"## Done when" needs at least one checkbox item, like "- [ ] It works"');

  if (status === 'done') {
    if (/^\s*- \[ \]/m.test(doneWhen ?? '')) err('status is "done" but some "Done when" boxes are not checked');
    const review = (getSection(body, 'Review') ?? '').match(REVIEW_LINE);
    if (!review) err('status is "done" but the Review section has no line like "Review: approved by <reviewer> on YYYY-MM-DD"');
    else if (review[1] !== reviewer) err(`Review line names "${review[1]}" but the header reviewer is "${reviewer}"`);
  }

  return { errors, header };
}

// The log file for a plan file name: "001-app-shell.md" -> "docs/plans/logs/001-app-shell.md".
export function logPathFor(file, config = DEFAULT_CONFIG) {
  return `${config.plansDir}/logs/${file}`;
}

// ---------- Path claims (owns) and invariants ----------

// A path from the repo root, tidied: "./src//a/./b.ts/" -> "src/a/b.ts", and "\" counts as "/". Letters are
// kept as written. Null when it is empty, absolute, or uses "..", so it could point outside the repo.
function repoPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/');
  if (s.startsWith('/')) return null;
  const parts = s.split('/').filter((x) => x && x !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : null;
}

// One entry of "owns", in one spelling for comparing claims: repoPath, then one Unicode form (NFC), so
// "é" written as one character or as "e" plus an accent mark is the same name.
export function ownPath(p) {
  return repoPath(String(p ?? '').normalize('NFC'));
}

// True when an owned path is the plans folder or inside it.
function insidePlans(p, config) {
  const [x, dir] = [ownPath(p)?.toLowerCase(), ownPath(config.plansDir)?.toLowerCase()];
  return Boolean(x && dir) && (x === dir || x.startsWith(`${dir}/`));
}

// True when two owned paths are the same, or one is inside the other ("src" and "src/a.ts"; not "src" and
// "src2"). Case and Unicode spelling do not count: on a Mac's disk "SRC/API.TS" is the same file as
// "src/api.ts", and "é" written as one character or as "e" plus an accent mark is one name.
export function pathsOverlap(a, b) {
  const [x, y] = [ownPath(a)?.toLowerCase(), ownPath(b)?.toLowerCase()];
  return Boolean(x && y) && (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`));
}

// Two running slices may not own the same path. plans: [{ path, folder, header }]. One error per pair of plans.
export function checkOwns(plans) {
  const running = plans.filter((p) => p.folder === 'active' && LIVE_STATUSES.includes(p.header?.status) && Array.isArray(p.header.owns));
  const errors = [];
  for (let i = 0; i < running.length; i++) {
    for (const b of running.slice(i + 1)) {
      const a = running[i];
      const pair = a.header.owns.flatMap((x) => b.header.owns.filter((y) => pathsOverlap(x, y)).map((y) => [x, y]))[0];
      if (!pair) continue;
      const [x, y] = pair;
      const what = ownPath(x).toLowerCase() === ownPath(y).toLowerCase() ? x : `${x} and ${y} (one is inside the other)`;
      errors.push(`${a.path} and ${b.path} are both running and both own ${what}. Two running slices may not own the same path: finish one first, or change "owns" so they do not meet`);
    }
  }
  return errors;
}

// What a build branch may change, given the claims. slice: "002". plans: [{ path, folder, header }].
// changes: [{ status, path, oldPath? }]. A path another running slice owns is refused, naming that plan.
// If this slice's own plan says "owns: none", the branch may change only paperwork (paperworkPaths).
// Plan files are left to checkBuilderChanges, which already decides what a builder may do there.
export function checkOwnedChanges({ slice, branch, plans, changes, config = DEFAULT_CONFIG }) {
  const errors = [];
  const isOwn = (p) => p.path.slice(p.path.lastIndexOf('/') + 1).startsWith(`${slice}-`);
  const others = plans.filter((p) => !isOwn(p) && p.folder === 'active' && LIVE_STATUSES.includes(p.header?.status) && Array.isArray(p.header.owns));
  const ownsNone = plans.some((p) => isOwn(p) && p.folder === 'active' && p.header?.owns === 'none');
  const paperwork = (path) => config.paperworkPaths.some((w) => (w.endsWith('/') ? path.startsWith(w) : path === w));
  for (const change of changes) {
    for (const path of [change.path, change.oldPath].filter(Boolean)) {
      if (path.startsWith(`${config.plansDir}/`)) continue;
      for (const other of others) {
        const owned = other.header.owns.find((o) => pathsOverlap(o, path));
        if (owned !== undefined) errors.push(`${path}: ${other.path} owns this path (${owned}) and is running; build branch ${branch} may not change it`);
      }
      if (ownsNone && !paperwork(path)) {
        errors.push(`${path}: the plan for slice ${slice} says "owns: none", so this branch may change only paperwork (${config.paperworkPaths.join(', ')}). The head agent lists the paths it needs in "owns"`);
      }
    }
  }
  return errors;
}

// A protected row's check: the path exactly as written (tidied by repoPath), or else its other Unicode
// spelling, so a real file passes whichever way its accents are stored on disk or in git.
function checkFileExists(check, isFile) {
  const p = repoPath(check);
  return p !== null && [p, p.normalize('NFC'), p.normalize('NFD')].some((x) => isFile(x));
}

// Text with every HTML comment blanked out, keeping its line breaks so line numbers stay true. A comment
// that is never closed ("<!--" with no "-->") hides everything to the end. The dashboard reads with this too.
export function stripHtmlComments(text) {
  return normalize(String(text)).replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ''));
}

// Reads the invariants table: { optedIn, ids: Set of ids, errors }. Each row: | Id | Rule | Area | Check | State |.
// A file is read only when it has the line INVARIANTS_MARKER: a project's older invariants file, in
// another shape, keeps passing (optedIn false, no ids, no errors) until the line is added.
// isFile(path) says whether a protected row's check is a file in the repo (see checkFileExists).
export function checkInvariants(text, isFile) {
  const errors = [];
  const ids = new Set();
  // A format line inside a comment is not read, and line numbers in messages stay true.
  const lines = stripHtmlComments(text).split('\n');
  if (!lines.some((l) => l.trim() === INVARIANTS_MARKER)) return { optedIn: false, ids, errors };
  const isSeparator = (l) => /^\|[\s:|-]*-[\s:|-]*$/.test(l.trim());
  lines.forEach((line, i) => {
    if (!line.trim().startsWith('|') || isSeparator(line) || isSeparator(lines[i + 1] ?? '')) return;
    const at = `${INVARIANTS_FILE}:${i + 1}`;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/^`(.*)`$/, '$1'));
    if (cells.length !== 5) {
      errors.push(`${at}: a row needs 5 cells (id, rule, area, check, state); this one has ${cells.length}`);
      return;
    }
    const [id, , , check, state] = cells;
    if (!INVARIANT_ID.test(id)) errors.push(`${at}: the id "${id}" must look like INV-1`);
    else if (ids.has(id)) errors.push(`${at}: ${id} is used twice; give each invariant its own id`);
    ids.add(id);
    if (!INVARIANT_STATES.includes(state)) errors.push(`${at}: the state of ${id} must be "protected" or "not yet", not "${state}"`);
    else if (state === 'protected' && !checkFileExists(check, isFile)) {
      errors.push(`${at}: ${id} is protected, but its check ${check || '(empty)'} does not exist as a file in this repo. Write the path of its test or script file, or set the state to "not yet"`);
    }
  });
  return { optedIn: true, ids, errors };
}

// The verify recipe, when it has its format line: each "## " section needs a Start, Try, Look, Stop, and Takes
// line, none empty. Text in HTML comments does not count. Returns the problems.
export function checkVerifyRecipe(text) {
  const lines = stripHtmlComments(text).split('\n');
  if (!lines.some((l) => l.trim() === VERIFY_MARKER)) return [];
  const sections = [];
  lines.forEach((line, i) => {
    const name = headingOf(line);
    if (name !== null) sections.push({ name, line: i + 1, found: {} });
    const m = line.match(/^\s*(?:- )?([A-Za-z]+):(.*)$/);
    if (m && sections.length && VERIFY_KEYS.includes(m[1])) sections.at(-1).found[m[1]] ??= m[2].trim();
  });
  const errors = [];
  for (const { name, line, found } of sections) {
    for (const key of VERIFY_KEYS) {
      const at = `${VERIFY_FILE}:${line}: the section "## ${name}"`;
      if (!(key in found)) errors.push(`${at} has no "${key}:" line; each section needs ${VERIFY_KEYS.slice(0, -1).join(', ')}, and ${VERIFY_KEYS.at(-1)}`);
      else if (!found[key]) errors.push(`${at} has an empty "${key}:" line; fill it in`);
    }
  }
  return errors;
}

// The change checklist, when it has its format line. The same grammar as parseChecklist in
// scripts/checklist.mjs, which the merge reads (a test feeds both the same rows); it is copied here, not
// imported, so this checker loads nothing but Node's own modules:
//   the table: the columns CHECKLIST_COLUMNS, in that order; a "|" inside a cell is written "\|".
//   Id: CL-1, CL-2, ... (no 0, no leading zero), used once; it may sit in a code span.
//   When the change touches: one or more path patterns in code spans with commas between them, then, if
//     wanted, and adds "text"; nothing else. A pattern is not blank and does not start with "/" or "./".
//   Check this, Why: not empty.
// Returns the problems.
const CHECKLIST_ID = /^CL-[1-9]\d*$/;
const CHECKLIST_TRIGGER = /^(`[^`]+`(?:\s*,\s*`[^`]+`)*)(?:\s+and adds "(.+)")?$/;
export function checkChangeChecklist(text) {
  const lines = stripHtmlComments(text).split('\n');
  if (!lines.some((l) => l.trim() === CHECKLIST_MARKER)) return [];
  const isSeparator = (l) => /^\|[\s:|-]*-[\s:|-]*$/.test(l.trim());
  const cellsOf = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const rows = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.trim().startsWith('|') && !isSeparator(l));
  if (!rows.length) return [`${CHECKLIST_FILE}: has the format line but no table; add one with the columns ${CHECKLIST_COLUMNS.join(', ')}`];
  const errors = [];
  const ids = new Set();
  for (const { l, i } of rows) {
    const at = `${CHECKLIST_FILE}:${i + 1}`;
    const cells = cellsOf(l);
    if (isSeparator(lines[i + 1] ?? '')) {
      if (cells.join('|') !== CHECKLIST_COLUMNS.join('|')) errors.push(`${at}: the table needs the columns ${CHECKLIST_COLUMNS.join(', ')}, in that order`);
      continue;
    }
    if (cells.length !== CHECKLIST_COLUMNS.length) {
      errors.push(`${at}: a row needs 4 cells (${CHECKLIST_COLUMNS.join(', ')}); this one has ${cells.length}. Write a "|" inside a cell as "\\|"`);
      continue;
    }
    const [id, trigger, check, why] = [cells[0].replace(/^`(.*)`$/, '$1'), ...cells.slice(1)];
    const name = CHECKLIST_ID.test(id) ? id : 'this row';
    if (!CHECKLIST_ID.test(id)) errors.push(`${at}: the id "${id}" must look like CL-1`);
    else if (ids.has(id)) errors.push(`${at}: ${id} is used twice; give each item its own id, and never reuse one`);
    else ids.add(id);
    const m = trigger.match(CHECKLIST_TRIGGER);
    if (!m) errors.push(`${at}: the "${CHECKLIST_COLUMNS[1]}" cell of ${name} cannot be read: write one or more path patterns in code spans with commas between them, and then, if wanted, and adds "some text". Example: \`src/storage/**\` and adds "version"`);
    for (const p of m ? [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1].trim()) : []) {
      if (!p) errors.push(`${at}: ${name} has a blank path pattern; write a path between the backticks`);
      else if (p.startsWith('/') || p.startsWith('./')) errors.push(`${at}: the path pattern ${p} of ${name} must start at the top folder of the project, with no "/" or "./" in front`);
    }
    if (!check) errors.push(`${at}: ${name} has an empty "Check this" cell`);
    if (!why) errors.push(`${at}: ${name} has an empty "Why" cell`);
  }
  return errors;
}

// ---------- Checking the whole repo ----------

function listPlans(root, config) {
  const plans = [];
  for (const folder of ['active', 'completed']) {
    const dir = join(root, config.plansDir, folder);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (file.endsWith('.md')) plans.push({ folder, file, path: `${config.plansDir}/${folder}/${file}` });
    }
  }
  return plans;
}

// Every Markdown file under root, found by walking the disk. Used only when git gave no file list
// (a plain folder in a test, or a folder that is not a git repo).
function listMarkdownOnDisk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listMarkdownOnDisk(root, full, out);
    } else if (entry.name.endsWith('.md')) {
      out.push(relative(root, full).split('\\').join('/'));
    }
  }
  return out;
}

// True for a Markdown file the em dash check leaves alone: inside a build or library folder, or inside
// a folder the settings skip.
export function isSkippedMarkdown(path, skipDirs = []) {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((part) => SKIP_DIRS.has(part))) return true;
  return skipDirs.some((dir) => path.startsWith(`${dir.replace(/\/+$/, '')}/`));
}

// Every Markdown link in the roadmap, turned into a repo path (links are relative to the roadmap's folder).
export function roadmapLinks(roadmapText, roadmapPath) {
  const dir = posix.dirname(roadmapPath);
  return [...roadmapText.matchAll(/\]\(([^)\s]+\.md)\)/g)]
    .map((m) => m[1])
    .filter((link) => !/^[a-z]+:/i.test(link) && !link.startsWith('/'))
    .map((link) => posix.normalize(posix.join(dir, link)));
}

// Which set of limits a branch gets. Fail closed: a name the checker does not know is "other", with limits.
//   lead      the base branch itself, or a head agent branch: no limits
//   build     a builder's branch
//   research  a research worker's branch
//   other     anything else, including a detached HEAD (an empty name)
export function classifyBranch(branch, config = DEFAULT_CONFIG) {
  if (branch === config.baseBranch || config.leadPrefixes.some((p) => branch.startsWith(p))) return 'lead';
  if (branch.startsWith(config.buildPrefix)) return 'build';
  if (branch.startsWith(config.researchPrefix)) return 'research';
  return 'other';
}

// Whose settings a branch is checked with. The class always comes from the TRUSTED settings (the ones on
// the base branch), so a branch cannot name itself a lead branch.
//   proposed  the settings in the files being checked     trusted  the settings on the base branch
// A lead branch is checked with the proposed settings: a lead may change them. Every other branch is
// checked with the trusted settings for everything, so it can never loosen a rule.
export function chooseConfig({ branch, proposed, trusted }) {
  const kind = classifyBranch(branch, trusted);
  return { kind, config: kind === 'lead' ? proposed : trusted };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Starter kit files are never edited in a project. The manifest lists each one with its fingerprint.
// read(path) returns the file's bytes, or null if it is missing.
export function checkManifest(read) {
  const raw = read(MANIFEST_FILE);
  if (raw === null) return [];
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return [`${MANIFEST_FILE} is not valid JSON: ${e.message}`];
  }
  if (!isObject(manifest) || manifest.kit !== 'starter-kit' || !isObject(manifest.files)) {
    return [`${MANIFEST_FILE} is broken: it must look like { "kit": "starter-kit", "kitCommit": "...", "updatedAt": "YYYY-MM-DD", "files": { "path": "sha256" } }`];
  }
  const errors = [];
  for (const [path, want] of Object.entries(manifest.files)) {
    if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want)) {
      errors.push(`${MANIFEST_FILE}: the fingerprint for ${path} is not a sha256 (64 letters and digits, a to f and 0 to 9)`);
      continue;
    }
    const bytes = read(path);
    if (bytes === null) {
      errors.push(`${path}: this file is managed by the starter kit and is missing. Restore it from the kit (node ~/dev/starter-kit/kit/sync.mjs)`);
    } else if (sha256(bytes) !== want) {
      errors.push(`${path}: this file is managed by the starter kit and was changed here. Put project changes in docs/project-rules.md, or update from the kit (node ~/dev/starter-kit/kit/sync.mjs)`);
    }
  }
  return errors;
}

// branch: the current branch name ("" for none or a detached HEAD).
// kind: the branch's class, when the caller already decided it from trusted settings (see chooseConfig).
//   Left out, it comes from the branch name and the settings passed in.
// git: a function returning { changes, readBase, readHead }, called only on branches that have limits.
// files: where to look, when the caller knows better than the disk (git does):
//   { markdown: [paths], exists(path) -> true or false, read(path) -> bytes or null }.
//   Any part left out falls back to reading the folder itself.
export function checkRepo(root, { branch = '', kind = null, git = null, config = DEFAULT_CONFIG, baseConfig = null, files = null } = {}) {
  const errors = [];
  const exists = files?.exists ?? ((p) => existsSync(join(root, p)));
  // A regular file (not a folder, link, or submodule) at exactly this path, letter case included, so disk
  // and staged checks agree.
  const isFile = files?.isFile ?? ((p) => {
    try {
      return lstatSync(join(root, p)).isFile() && relative(realpathSync.native(root), realpathSync.native(join(root, p))).split('\\').join('/') === p;
    } catch {
      return false;
    }
  });
  const read = files?.read ?? ((p) => {
    try {
      return readFileSync(join(root, p));
    } catch {
      return null;
    }
  });
  const markdown = files?.markdown ?? listMarkdownOnDisk(root);
  const plans = listPlans(root, config);
  const byId = new Map();

  for (const plan of plans) {
    const text = readFileSync(join(root, plan.path), 'utf8');
    const { errors: planErrors, header } = validatePlan(text, plan.file, plan.folder, config);
    errors.push(...planErrors);
    plan.tasks = parseTasks(text);
    if (!header) continue;
    if (byId.has(header.id)) errors.push(`${plan.path}: id ${header.id} is also used by ${byId.get(header.id).path}`);
    else byId.set(header.id, { path: plan.path, status: header.status });
    for (const k of ['tests', 'code']) {
      for (const p of Array.isArray(header[k]) ? header[k] : []) {
        if (!exists(String(p))) errors.push(`${plan.path}: "${k}" lists ${p}, but that file does not exist`);
      }
    }
    plan.header = header;
  }

  // Dependencies must exist, and must be done before a slice starts.
  for (const plan of plans) {
    const deps = Array.isArray(plan.header?.depends_on) ? plan.header.depends_on : [];
    const started = ['in_progress', 'in_review', 'done'].includes(plan.header?.status);
    for (const dep of deps) {
      const target = byId.get(dep);
      if (!target) errors.push(`${plan.path}: depends on slice ${dep}, but no plan has that id`);
      else if (started && target.status !== 'done') errors.push(`${plan.path}: is "${plan.header.status}" but slice ${dep} is not done yet`);
    }
  }

  // Roadmap: every plan is linked once, and every plan link points to a real plan.
  const roadmap = read(config.roadmap);
  if (roadmap === null) {
    errors.push(`${config.roadmap} is missing`);
  } else {
    const links = roadmapLinks(roadmap.toString('utf8'), config.roadmap).filter((l) => l.startsWith(`${config.plansDir}/`));
    for (const link of new Set(links)) {
      if (!exists(link)) errors.push(`${config.roadmap} links to ${link}, but that file does not exist`);
    }
    for (const plan of plans) {
      const count = links.filter((l) => l === plan.path).length;
      if (count === 0) errors.push(`${config.roadmap} has no link to ${plan.path}`);
      if (count > 1) errors.push(`${config.roadmap} links to ${plan.path} more than once`);
    }
  }

  for (const [file, limit] of Object.entries(config.lineLimits)) {
    const bytes = read(file);
    if (bytes === null) continue;
    const lines = bytes.toString('utf8').trimEnd().split('\n').length;
    if (lines > limit) errors.push(`${file} has ${lines} lines; keep it at ${limit} or fewer`);
  }

  for (const file of markdown) {
    if (isSkippedMarkdown(file, config.emDashSkipDirs)) continue;
    const bytes = read(file);
    if (bytes === null) continue;
    bytes.toString('utf8').split('\n').forEach((line, i) => {
      if (line.includes(EM_DASH)) errors.push(`${file}:${i + 1}: has an em dash; use a comma, colon, or new sentence`);
    });
  }

  errors.push(...checkManifest(read));

  errors.push(...checkOwns(plans));
  // No invariants file means no invariants: nothing to check, and no plan may name one.
  for (const [file, check] of [[VERIFY_FILE, checkVerifyRecipe], [CHECKLIST_FILE, checkChangeChecklist]]) {
    const bytes = read(file);
    if (bytes !== null) errors.push(...check(bytes.toString('utf8')));
  }
  const invariantsText = read(INVARIANTS_FILE);
  const invariants = invariantsText === null ? { optedIn: true, ids: new Set(), errors: [] } : checkInvariants(invariantsText.toString('utf8'), isFile);
  errors.push(...invariants.errors);

  // Branch rules. No branch and no git (a plain folder) means there is nothing to compare, so none apply.
  kind ??= classifyBranch(branch, config);
  if (kind === 'build') {
    const slice = branch.slice(config.buildPrefix.length).match(SLICE_NAME);
    if (!slice) {
      errors.push(`branch "${branch}" starts with ${config.buildPrefix} but is not named like ${config.buildPrefix}001-short-name, so the builder rules cannot run. Rename the branch.`);
    } else {
      // A build branch must belong to a real, started slice. (Its dependencies being done is checked above.)
      const own = plans.find((p) => p.folder === 'active' && p.file.startsWith(`${slice[1]}-`));
      if (!own) errors.push(`branch ${branch} has no matching plan in ${config.plansDir}/active/ starting with ${slice[1]}-`);
      else if (!BUILD_STATUSES.includes(own.header?.status)) {
        errors.push(`branch ${branch}: ${own.path} is "${own.header?.status}"; the head agent must set it to in_progress (and merge that into ${config.baseBranch}) before building starts`);
      }
      if (!git) errors.push(`on build branch ${branch} but git is not available to compare with ${config.baseBranch}`);
      else {
        const facts = git();
        errors.push(...checkBuilderChanges({ slice: slice[1], config, ...facts }));
        errors.push(...checkOwnedChanges({ slice: slice[1], branch, plans, changes: facts.changes, config }));
      }
    }
  } else if (kind === 'lead' && git) {
    // A new plan must be in the log format. When git cannot find the base (a repo with no commits yet),
    // there is nothing to compare, so the rule is skipped; the merge script names the base, so it always runs there.
    let facts = null;
    try {
      facts = git();
    } catch {
      facts = null;
    }
    if (facts) errors.push(...checkNewPlans({ plans, config, baseConfig, invariantIds: invariants.optedIn ? invariants.ids : null, ...facts }));
    if (facts?.claimCommits && claimCheckOn(config)) {
      errors.push(...checkClaims(facts.claimCommits()));
    }
  } else if (kind !== 'lead' && (branch || git)) {
    if (!git) errors.push(`on branch ${branch} but git is not available to compare with ${config.baseBranch}`);
    else if (kind === 'research') errors.push(...checkResearchChanges({ branch, config, ...git() }));
    else errors.push(...checkOtherChanges({ branch, config, ...git() }));
  }

  return errors;
}

// A plan file added on this branch must have a "log" field, and a "## Tasks" section with a numbered list
// (1, 2, 3, no gaps or repeats), so scripts/slice.mjs can log each task by its number. plan.tasks is
// parseTasks of the plan's text; a plan without it counts as having no tasks. A plan whose file name is
// already in either plan folder on the base branch is not new: a move from active/ to completed/ that git
// did not see as a rename still passes, and so does every plan a project wrote before these rules.
// A new plan also needs each of NEW_PLAN_FIELDS, and every id its "invariants" lists must be in
// invariantIds (the ids in docs/invariants.md).
// "docs/plans/completed/001-x.md" -> "001-x.md": the file name, when the path is a real plan file
// (NNN-name.md) right inside active/ or completed/. Null for anything else, such as a .txt file or a log.
function planFileIn(path, config) {
  const m = path.match(/^(.*)\/(active|completed)\/([^/]+)$/);
  return m && m[1] === config.plansDir && PLAN_FILE.test(m[3]) ? m[3] : null;
}

const FIELD_HINTS = {
  invariants: 'the ids from docs/invariants.md this slice touches, like [INV-1], or none',
  risk: 'high or normal',
  undo: 'one line: how to undo this slice',
  owns: 'the paths this slice owns, like [src/search/], or none for a docs-only slice',
  proof: 'one line: what will be shown to prove it works',
};
// Stricter of the base branch's cap and the branch's cap: a positive integer beats null/undefined,
// and two positive integers take the smaller one. Both null means the cap is off.
function stricterCap(baseVal, branchVal) {
  const baseNum = Number.isInteger(baseVal) && baseVal > 0 ? baseVal : null;
  const branchNum = Number.isInteger(branchVal) && branchVal > 0 ? branchVal : null;
  if (baseNum !== null && branchNum !== null) return Math.min(baseNum, branchNum);
  return baseNum ?? branchNum;
}

// One "owns" entry as the folder it really claims, lower case for comparing: everything from the first
// part with a "*" on is dropped, so "apps/*", "apps/**/*.tsx", and "apps/*/src/" claim apps, and
// "apps/mobile/*.ts" claims apps/mobile. "" is the whole repo: ".", "/", "*", "*.ts", "**/*.ts".
// Brackets and round brackets are plain name characters, as in "app/(tabs)/[id].tsx".
// null: not a path at all (validatePlan reports that one).
function claimRoot(p) {
  const parts = String(p ?? '').trim().replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  const wild = parts.findIndex((x) => x.includes('*'));
  if (wild >= 0) parts.length = wild;
  if (!parts.length) return '';
  return ownPath(parts.join('/'))?.toLowerCase() ?? null;
}

// The root an "owns" entry swallows whole: the first of roots that the entry equals or sits above
// ("apps/" swallows "apps/mobile/"), or null. An entry strictly inside a root is fine.
export function broadClaim(entry, roots) {
  const claim = claimRoot(entry);
  if (claim === null) return null;
  return roots.find((r) => {
    const root = ownPath(r)?.toLowerCase();
    return Boolean(root) && (claim === '' || claim === root || root.startsWith(`${claim}/`));
  }) ?? null;
}

// The "owns" entries that are inside a screen folder (or are one), so each counts as a screen.
export function screenClaims(owns, screenPaths) {
  const roots = screenPaths.map((r) => ownPath(r)?.toLowerCase()).filter(Boolean);
  return owns.filter((entry) => {
    const claim = claimRoot(entry);
    return Boolean(claim) && roots.some((root) => claim === root || claim.startsWith(`${root}/`));
  });
}

// basePlanPaths: every plan path on the base branch. A plan whose three-digit id is among them is not new
// either, so renaming an older plan keeps it an older plan. invariantIds null: the invariants file is not read.
// baseConfig: when given, extraTaskSlices is read from the base branch's settings, and every size gate uses
// the stricter of baseConfig and config (the smaller cap, forbidBroadOwns on if either has it, both lists of
// productPaths and screenPaths), so a branch cannot waive its own size gate in the same pull request.
export function checkNewPlans({ plans, changes, readBase, config = DEFAULT_CONFIG, baseConfig = null, invariantIds = new Set(), basePlanPaths = [] }) {
  const errors = [];
  const added = new Set(changes.filter((c) => c.status === 'A' || c.status === 'R').map((c) => c.path));
  const extraTaskSlices = (baseConfig ?? config).extraTaskSlices ?? [];
  const maxTasksPerSlice = baseConfig ? stricterCap(baseConfig.maxTasksPerSlice, config.maxTasksPerSlice) : config.maxTasksPerSlice;
  const maxOwnsPerSlice = baseConfig ? stricterCap(baseConfig.maxOwnsPerSlice, config.maxOwnsPerSlice) : config.maxOwnsPerSlice;
  const maxScreensPerSlice = baseConfig ? stricterCap(baseConfig.maxScreensPerSlice, config.maxScreensPerSlice) : config.maxScreensPerSlice;
  const forbidBroadOwns = config.forbidBroadOwns !== false || (baseConfig !== null && baseConfig.forbidBroadOwns !== false);
  const both = (key) => [...new Set([...(config[key] ?? []), ...(baseConfig?.[key] ?? [])])];
  const screenPaths = both('screenPaths');
  const screenCap = screenPaths.length > 0 && Number.isInteger(maxScreensPerSlice) && maxScreensPerSlice > 0;
  // A screen root is broad even with the screen cap off: owning all of it is every screen at once.
  const broadRoots = [...both('productPaths'), ...screenPaths];
  for (const plan of plans) {
    if (!added.has(plan.path) || !plan.header) continue;
    const problems = [];
    if (!('log' in plan.header)) problems.push(`a new plan needs the header field "log: ${logPathFor(plan.file, config)}" (copy ${config.plansDir}/_template.md)`);
    const tasks = plan.tasks ?? [];
    const taskProblem = tasksProblem(tasks);
    if (taskProblem) problems.push(`a new plan needs numbered tasks: ${taskProblem}`);
    const sliceId = Number.isInteger(plan.header.id) ? plan.header.id : Number(plan.file.match(/^(\d{3})-/)?.[1]);
    const sliceLabel = Number.isInteger(sliceId) ? `slice ${sliceId}` : 'this slice';
    const extraAllowed = Number.isInteger(sliceId) && extraTaskSlices.includes(sliceId);
    if (maxTasksPerSlice != null && tasks.length > maxTasksPerSlice && !extraAllowed) {
      problems.push(`new plan has ${tasks.length} tasks (max ${maxTasksPerSlice}): split the roadmap row into smaller sequential slices, or ask the user to add ${sliceLabel} to "extraTaskSlices" in ${CONFIG_FILE} on the base branch`);
    }
    const ownedPaths = Array.isArray(plan.header.owns) ? plan.header.owns.filter((p) => p !== 'none') : [];
    if (maxOwnsPerSlice != null && ownedPaths.length > maxOwnsPerSlice && !extraAllowed) {
      problems.push(`new plan owns ${ownedPaths.length} paths (max ${maxOwnsPerSlice}): split the slice into smaller slices with narrower ownership, or ask the user to add ${sliceLabel} to "extraTaskSlices" in ${CONFIG_FILE} on the base branch`);
    }
    if (forbidBroadOwns && broadRoots.length && !extraAllowed) {
      for (const entry of ownedPaths) {
        const root = broadClaim(entry, broadRoots);
        if (root !== null) problems.push(`"owns" lists ${entry}, which claims all of ${root}: own the specific folders or files this slice changes inside it, or ask the user to add ${sliceLabel} to "extraTaskSlices" in ${CONFIG_FILE} on the base branch`);
      }
    }
    const screens = screenCap ? screenClaims(ownedPaths, screenPaths) : [];
    if (screens.length > maxScreensPerSlice && !extraAllowed) {
      problems.push(`new plan owns ${screens.length} screen paths (max ${maxScreensPerSlice}: ${screens.join(', ')}): split the slice so each one builds at most ${maxScreensPerSlice} screens, or ask the user to add ${sliceLabel} to "extraTaskSlices" in ${CONFIG_FILE} on the base branch`);
    }
    for (const k of NEW_PLAN_FIELDS) if (!(k in plan.header)) problems.push(`a new plan needs the header field "${k}:" (${FIELD_HINTS[k]})`);
    const ids = Array.isArray(plan.header.invariants) ? plan.header.invariants.map(String) : [];
    if (ids.length && invariantIds === null) problems.push(`"invariants" names ${ids.join(', ')}, but ${INVARIANTS_FILE} has no line "${INVARIANTS_MARKER}", so its ids are not read. Add that line once the table has the columns Id, Rule, Area, Check, State`);
    else for (const id of ids.filter((x) => !invariantIds.has(x))) problems.push(`"invariants" names ${id}, which is not in ${INVARIANTS_FILE}`);
    if (!problems.length) continue;
    const id = plan.file.match(/^(\d{3})-/)?.[1];
    const onBase = ['active', 'completed'].some((folder) => readBase(`${config.plansDir}/${folder}/${plan.file}`) !== null)
      || (id !== undefined && basePlanPaths.some((p) => planFileIn(p, config)?.startsWith(`${id}-`)));
    if (onBase) continue;
    errors.push(...problems.map((p) => `${plan.path}: ${p}`));
  }
  return errors;
}

// True when the claim check is on: features.claimCheck is true or "enforce". false, "off", or missing is off.
export function claimCheckOn(config) {
  const mode = config.features?.claimCheck;
  return mode === true || mode === 'enforce';
}

// The claim check (features.claimCheck). Two threads that claim one slice the same way make identical edits,
// which git merges with no conflict, so both would believe they own it. The commit names who claimed: a claim
// in a commit not on the base branch, for a slice the base branch already has started, lost the race.
// A plain commit claims when it sets a plan to in_progress from a status that is not started. A merge commit
// claims when its plan is in_progress and no parent already had that slice started by the same builder, so a
// claim made while resolving a conflict counts, and taking the base's claim as it is does not.
// Slices are matched by the number in the file name, so a rename on either side does not hide a claim.
// commits: [{ sha, plans: [{ path, parents: [text per parent], after }] }], the plan files each commit on this
// branch changed (text is null when missing). basePlans: [{ path, text }], the plans on the base branch.
const STARTED = ['in_progress', 'in_review', 'parked', 'done'];
export function checkClaims({ commits, basePlans }) {
  const sliceOf = (path) => path.slice(path.lastIndexOf('/') + 1).match(/^(\d{3})-/)?.[1] ?? null;
  const headerOf = (text) => (text === null ? null : parsePlan(text).header ?? null);
  const started = (h) => STARTED.includes(h?.status);
  const onBase = new Map();
  for (const { path, text } of basePlans) {
    const h = headerOf(text);
    if (sliceOf(path) && started(h) && !onBase.has(sliceOf(path))) onBase.set(sliceOf(path), h.status);
  }
  const errors = new Map();
  for (const { sha, plans } of commits) {
    for (const { path, parents, after } of plans) {
      const slice = sliceOf(path);
      const now = headerOf(after);
      if (!onBase.has(slice) || errors.has(slice) || now?.status !== 'in_progress') continue;
      const before = parents.map(headerOf);
      const kept = before.length === 1 ? started(before[0]) : before.some((h) => started(h) && h.builder === now.builder);
      if (kept) continue;
      errors.set(slice, `${path}: this branch claims slice ${now.id ?? Number(slice)} in commit ${sha.slice(0, 7)}, but the base branch already has it "${onBase.get(slice)}": another thread claimed it first. Leave this slice: start a new lead branch from the base branch without this claim`);
    }
  }
  return [...errors.values()];
}

// ---------- Guarding files on branches that are not lead branches ----------

export function isLeadOnly(path, config = DEFAULT_CONFIG) {
  return leadOnlyPaths(config).some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

// changes: [{ status: 'A'|'M'|'D'|'R', path, oldPath? }]
// readBase(path): the file's text on the base branch (or null). readHead(path): the file's text being checked (or null).
export function checkBuilderChanges({ slice, changes, readBase, readHead, config = DEFAULT_CONFIG }) {
  const errors = [];
  const activeDir = `${config.plansDir}/active/`;
  const logsDir = `${config.plansDir}/logs/`;
  for (const change of changes) {
    for (const path of [change.path, change.oldPath].filter(Boolean)) {
      if (isLeadOnly(path, config)) errors.push(`${path}: builders may not change this file (head agent only)`);
    }
    const path = change.path;
    // Log files: a builder may add to or change its own slice's log, and no other.
    const logPaths = [change.path, change.oldPath].filter((p) => p && p.startsWith(logsDir));
    if (logPaths.length) {
      const own = ['A', 'M'].includes(change.status) && logPaths.every((p) => p.slice(logsDir.length).startsWith(`${slice}-`));
      if (!own) errors.push(`${logPaths.join(' and ')}: this build branch may only add to or change its own slice's log (${logsDir}${slice}-short-name.md), never delete or rename one`);
      continue;
    }
    if (!path.startsWith(activeDir)) continue;
    const file = path.slice(activeDir.length);
    if (!file.startsWith(`${slice}-`)) {
      errors.push(`${path}: this build branch is for slice ${slice}; it may not change another slice's plan`);
      continue;
    }
    if (change.status !== 'M') {
      errors.push(`${path}: builders may not add, delete, or rename plan files`);
      continue;
    }
    // The format comes from the base branch's copy, so a builder cannot switch it by editing the header.
    const before = readBase(path) ?? '';
    const logFormat = 'log' in (parsePlan(before).header ?? {});
    const sections = logFormat ? LOG_BUILDER_SECTIONS : BUILDER_SECTIONS;
    if (lockedPart(before, sections) !== lockedPart(readHead(path) ?? '', sections)) {
      const where = logFormat ? `; progress notes and handoffs go in ${logPathFor(file, config)}` : '';
      errors.push(`${path}: builders may only change the ${sections.join(', ')} section${sections.length > 1 ? 's' : ''} of their plan${where}`);
    }
  }
  return errors;
}

// A research branch holds research notes and nothing else.
export function checkResearchChanges({ branch, changes, config = DEFAULT_CONFIG }) {
  const errors = [];
  for (const change of changes) {
    const paths = [change.path, change.oldPath].filter(Boolean);
    const allowed = ['A', 'M'].includes(change.status) && paths.every((p) => p.startsWith(config.researchDir));
    if (!allowed) errors.push(`${paths.join(' and ')}: research branch ${branch} may only add or change files under ${config.researchDir}`);
  }
  return errors;
}

// Any branch the checker does not know, and a detached HEAD: code is fine, lead-only files and plans are not.
export function checkOtherChanges({ branch, changes, config = DEFAULT_CONFIG }) {
  const errors = [];
  const name = branch ? `branch "${branch}"` : 'a detached HEAD (no branch)';
  const lead = config.leadPrefixes[0] ?? 'lead/';
  for (const change of changes) {
    for (const path of [change.path, change.oldPath].filter(Boolean)) {
      if (isLeadOnly(path, config) || path.startsWith(`${config.plansDir}/`)) {
        errors.push(`${path}: ${name} is not a lead branch, so it may not change this file. Switch to a lead branch first: git switch -c ${lead}short-name`);
      }
    }
  }
  return errors;
}

// ---------- Where the project stands (--status) ----------

const stripComments = (text) => normalize(text).replace(/<!--[\s\S]*?-->/g, '');

// How many items wait in each section of the owner's inbox. An item is a line that starts with "- ".
export function countInbox(text) {
  const clean = stripComments(text);
  const count = (name) => (getSection(clean, name) ?? '').split('\n').filter((l) => l.startsWith('- ')).length;
  return { todo: count('Your to-do'), review: count('To review'), decided: count('Decided, to apply') };
}

// The event log (scripts/events.mjs writes it): one JSON object per line, in the repo's shared git folder.
export const EVENTS_NAME = 'kit-events.jsonl';

// How many asks for Stephen are open in the event log's text: an "ask" event is open until an "answer"
// event names its id (data.ask). A line is skipped as scripts/events.mjs skips it: not valid JSON, not an
// object, no text type, or a time that is not text that reads as a time.
export function countOpenAsks(text) {
  const asks = new Set();
  const answered = new Set();
  for (const line of String(text).split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string' || typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) continue;
    if (e.type === 'ask' && typeof e.id === 'string') asks.add(e.id);
    if (e.type === 'answer' && typeof e.data?.ask === 'string') answered.add(e.data.ask);
  }
  return [...asks].filter((id) => !answered.has(id)).length;
}

// The first roadmap table row with no plan link: the next slice that still needs a plan. Null if none.
export function firstUnplannedRow(roadmapText) {
  const isRow = (l) => l.startsWith('|');
  const isSeparator = (l) => /^\|[\s:|-]*-[\s:|-]*$/.test(l);
  const lines = stripComments(roadmapText).split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isRow(line) || isSeparator(line) || isSeparator(lines[i + 1] ?? '')) continue;
    if (/\]\([^)\s]+\.md\)/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length) return cells.join(' | ');
  }
  return null;
}

// Pure rule: turns the facts into a report. Nothing here touches git or the disk.
//   plans     [{ path, file, header }] (header may be null for a plan that could not be read)
//   order     plan paths in roadmap order
//   branches  [{ name, ahead }]: remote branches not merged into the base, with commits ahead of it
export function buildStatus({ plans, order = [], branches = [], config = DEFAULT_CONFIG }) {
  const readable = plans.filter((p) => p.header && Number.isInteger(p.header.id));
  const byId = new Map(readable.map((p) => [p.header.id, p]));
  const byPath = new Map(readable.map((p) => [p.path, p]));
  const num = (p) => p.file.slice(0, 3);

  const live = readable
    .filter((p) => [...LIVE_STATUSES, 'blocked', 'parked'].includes(p.header.status))
    .sort((a, b) => a.header.id - b.header.id)
    .map((p) => {
      const builds = branches.filter((b) => b.name.startsWith(`${config.buildPrefix}${num(p)}-`) && b.ahead > 0);
      return { slice: num(p), path: p.path, status: p.header.status, branches: builds, stalled: LIVE_STATUSES.includes(p.header.status) && builds.length === 0 };
    });

  const waiting = [];
  let next = null;
  for (const path of order) {
    const plan = byPath.get(path);
    if (!plan || plan.header.status !== 'todo') continue;
    const deps = Array.isArray(plan.header.depends_on) ? plan.header.depends_on : [];
    const notDone = deps.filter((d) => byId.get(d)?.header.status !== 'done');
    if (notDone.length === 0) {
      next = { slice: num(plan), path: plan.path };
      break;
    }
    waiting.push(`${num(plan)} waits on ${notDone.join(', ')}`);
  }
  const why = next ? null : waiting.length ? `every todo plan waits on a slice that is not done (${waiting.slice(0, 3).join('; ')})` : 'no plan in the roadmap has status todo';

  const prefixes = [...config.leadPrefixes, config.buildPrefix, config.researchPrefix];
  const open = branches.filter((b) => b.ahead > 0 && prefixes.some((p) => b.name.startsWith(p)));
  return { live, next, why, open };
}

const ago = (minutes) => (minutes < 120 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : minutes < 2880 ? `${Math.round(minutes / 60)} hours` : `${Math.round(minutes / 1440)} days`);

// Turns a report into the lines to print.
//   base      { ref, commit, behind } or null    lastPush  { ref, subject, minutes } or null
//   inbox     { review, decided } or null        unplanned a roadmap row, or null
//   asks      { open, note } or null: open asks for Stephen in the event log; note says why the count is 0
export function formatStatus({ report, config = DEFAULT_CONFIG, base = null, lastPush = null, inbox = null, asks = null, unplanned = null, notes = [] }) {
  const lines = [];
  if (!base) lines.push(`Base: not found (looked for ${config.remote}/${config.baseBranch} and ${config.baseBranch})`);
  else lines.push(`Base: ${base.ref} at ${base.commit}${base.behind > 0 ? `. Your checkout is ${base.behind} commit${base.behind === 1 ? '' : 's'} behind it: start from ${base.ref}` : ''}`);
  const { headAgent, builder, reviewer } = config.models;
  if (!headAgent.length && !builder && !reviewer) lines.push(`Models: not set (${CONFIG_FILE}, models)`);
  else lines.push(`Models: head agent ${headAgent.join(', ') || 'not set'}; builder ${builder || 'not set'}; reviewer ${reviewer || 'not set'}`);

  lines.push(`Live slices: ${report.live.length || 'none'}`);
  for (const s of report.live) {
    const builds = s.branches.map((b) => `${b.name} (+${b.ahead})`).join(', ');
    const note = s.stalled ? 'STALLED: no build branch ahead of the base. Finish it first, or start its builder' : builds;
    lines.push(`  ${s.slice} ${s.status}  ${s.path}${note ? `  ${note}` : ''}`);
  }
  lines.push(report.next ? `Next free slice: ${report.next.slice}  ${report.next.path}` : `Next free slice: none, ${report.why}`);
  if (unplanned) lines.push(`Next to plan (roadmap row with no plan yet): ${unplanned}`);

  const shown = report.open.slice(0, 12).map((b) => `${b.name} (+${b.ahead})`);
  const more = report.open.length > shown.length ? `, and ${report.open.length - shown.length} more` : '';
  lines.push(`Open branches, not merged: ${shown.length ? shown.join(', ') + more : 'none'}`);

  if (asks) lines.push(`Open asks for Stephen: ${asks.open}${asks.note ? ` (${asks.note})` : ' (node scripts/ask.mjs list --open)'}`);
  if (inbox) lines.push(`Inbox (${config.inbox}): to review ${inbox.review}, decided to apply ${inbox.decided}${inbox.decided > 0 ? ' (apply these first)' : ''}`);
  else lines.push(`Inbox: ${config.inbox} is missing`);

  if (lastPush) {
    const stale = lastPush.minutes > config.staleMinutes ? `  STALE: nothing pushed for over ${config.staleMinutes} minutes` : '';
    lines.push(`Last push: ${ago(lastPush.minutes)} ago, ${lastPush.ref} "${lastPush.subject}"${stale}`);
  } else lines.push('Last push: unknown (no remote branches found)');
  lines.push(...notes);
  return lines;
}

// ---------- Talking to git ----------

function gitRun(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
}

// Same, but returns the exact bytes (for fingerprints).
function gitBytes(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
}

function gitOk(cwd, args) {
  try {
    gitRun(cwd, args);
    return true;
  } catch {
    return false;
  }
}

const zList = (output) => output.split('\0').filter(Boolean);

// Where the base branch may be found when nobody named it: the shared copy first, then the local one.
export function baseCandidates(config) {
  return process.env.GITHUB_BASE_REF
    ? [`${config.remote}/${process.env.GITHUB_BASE_REF}`]
    : [`${config.remote}/${config.baseBranch}`, config.baseBranch];
}

const refExists = (cwd, ref) => gitOk(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);

// The ref whose settings are trusted. With --base it is exactly that ref, and it must exist.
// Without it, the names come from the settings being checked: a guess, good enough for the hook.
// Null when no base exists here yet.
function resolveBaseRef(cwd, proposed, flag) {
  if (flag) {
    if (!refExists(cwd, flag)) throw new Error(`--base ${flag}: git has no such ref here. Fetch first, and write it in full, like origin/main`);
    return flag;
  }
  return baseCandidates(proposed).find((ref) => refExists(cwd, ref)) ?? null;
}

// The settings as they are on the base branch. No settings file there (a first install) means the defaults.
// A settings file there that is broken throws: guessing would switch rules off.
function trustedConfig(cwd, baseRef, proposed) {
  // No base at all: a repo with no commits yet has nothing to protect; any other repo gets the defaults.
  if (!baseRef) return refExists(cwd, 'HEAD') ? { ...DEFAULT_CONFIG } : proposed;
  if (!gitOk(cwd, ['cat-file', '-e', `${baseRef}:${CONFIG_FILE}`])) return { ...DEFAULT_CONFIG };
  try {
    return mergeConfig(JSON.parse(gitRun(cwd, ['show', `${baseRef}:${CONFIG_FILE}`])));
  } catch (e) {
    throw new Error(`the settings on ${baseRef} are broken (${e.message}). Mend ${CONFIG_FILE} from a lead branch first`);
  }
}

// The commit this branch should be compared with: the newest shared commit with the base branch.
// We try both the local base branch and the shared copy (for example origin/main) and pick whichever
// is newer, so a builder is never blamed for the lead's accepted changes.
// During a merge (MERGE_HEAD exists, for example a builder running `git merge origin/main`),
// the commit being merged in counts too: the base branch's lead edits arriving through the merge are
// not the builder's. A merged-in branch that is not on the base branch still has its lead edits caught.
// baseRef: an exact ref from --base. When given, it is the only ref used, with no guessing.
function findBase(cwd, config, baseRef = null) {
  const refs = baseRef ? [baseRef] : baseCandidates(config);
  const heads = gitOk(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) ? ['HEAD', 'MERGE_HEAD'] : ['HEAD'];
  const bases = [];
  for (const head of heads) {
    for (const ref of refs) {
      try {
        bases.push(gitRun(cwd, ['merge-base', head, ref]).trim());
      } catch {
        // this ref does not exist here; try the next one
      }
    }
  }
  if (!bases.length) throw new Error(`cannot find ${refs.join(' or ')} to compare this branch with`);
  return bases.find((b) => bases.every((o) => o === b || gitOk(cwd, ['merge-base', '--is-ancestor', o, b]))) ?? bases[0];
}

// Reads `git diff --name-status -z` output. -z keeps file names exactly as they are (no quotes or escapes).
export function parseNameStatus(output) {
  const parts = output.split('\0');
  const changes = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const status = parts[i++][0];
    if (status === 'R') changes.push({ status: 'R', oldPath: parts[i++], path: parts[i++] });
    else if (status === 'C') {
      i++;
      changes.push({ status: 'A', path: parts[i++] });
    } else changes.push({ status, path: parts[i++] });
  }
  return changes;
}

// root: where the files being checked live (the repo, or a temp copy of the staged files).
function gitFacts(repo, root, staged, config, baseRef = null) {
  const base = findBase(repo, config, baseRef);
  const diffArgs = ['diff', ...(staged ? ['--cached'] : []), '--name-status', '-z', '-M', base];
  const changes = parseNameStatus(gitRun(repo, diffArgs));
  const readBase = (p) => {
    try {
      return gitRun(repo, ['show', `${base}:${p}`]);
    } catch {
      return null;
    }
  };
  const readHead = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
  // For the claim check: each commit on this branch (not on the base), merges too, that changed an active plan,
  // and every plan on the base. --full-history keeps a merge that matches one parent from hiding the other side.
  const claimCommits = () => {
    const dir = `${config.plansDir}/active/`;
    const show = (spec) => {
      try {
        return gitRun(repo, ['show', spec]);
      } catch {
        return null;
      }
    };
    const planDirs = [`${config.plansDir}/active/`, `${config.plansDir}/completed/`];
    const plansAt = (rev) => zList(gitRun(repo, ['ls-tree', '-r', '--name-only', '-z', rev, '--', ...planDirs]));
    const sliceOf = (path) => path.slice(path.lastIndexOf('/') + 1).match(/^(\d{3})-/)?.[1] ?? null;
    // A parent's copy of the plan: the same path, else the same slice number, so a rename or a move between
    // folders is not read as a new plan.
    const inParent = (p, path) => {
      if (!p) return null;
      const same = show(`${p}:${path}`);
      if (same !== null || !sliceOf(path)) return same;
      const match = plansAt(p).find((q) => sliceOf(q) === sliceOf(path));
      return match ? show(`${p}:${match}`) : null;
    };
    const commits = gitRun(repo, ['log', '--full-history', '--format=%H %P', `${base}..HEAD`, '--', dir]).split('\n').filter(Boolean).map((line) => {
      const [sha, ...parents] = line.split(' ');
      // -c: for a merge, only the files that differ from every parent.
      const paths = zList(gitRun(repo, ['diff-tree', '-r', '-c', '--root', '--no-commit-id', '--name-only', '-z', sha, '--', dir]));
      return { sha, plans: paths.map((path) => ({ path, parents: (parents.length ? parents : ['']).map((p) => inParent(p, path)), after: show(`${sha}:${path}`) })) };
    });
    const basePlans = plansAt(base).map((path) => ({ path, text: readBase(path) }));
    return { commits, basePlans };
  };
  const basePlanPaths = zList(gitRun(repo, ['ls-tree', '-r', '--name-only', '-z', base, '--', `${config.plansDir}/active/`, `${config.plansDir}/completed/`]));
  return { changes, readBase, readHead, claimCommits, basePlanPaths };
}

// The current branch name. "" means none: a detached HEAD, or git could not say.
function currentBranch(repo) {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  try {
    return gitRun(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).trim();
  } catch {
    // detached: fall through
  }
  // A rebase checks out a detached HEAD while it works. The branch being rebased is written in the git
  // folder, so a head agent rebasing its lead branch is still seen as a lead.
  for (const file of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
    try {
      const path = resolve(repo, gitRun(repo, ['rev-parse', '--git-path', file]).trim());
      const name = readFileSync(path, 'utf8').trim().replace(/^refs\/heads\//, '');
      if (name && name !== 'detached HEAD') return name;
    } catch {
      // no rebase of that kind is going on
    }
  }
  return '';
}

// The file lists git knows, so ignored and outside folders (libraries, build output) are never scanned.
// Null if this folder is not a git repo.
function gitFiles(repo, staged) {
  let tracked;
  try {
    tracked = new Set(zList(gitRun(repo, ['ls-files', '-z', '--cached'])));
  } catch {
    return null;
  }
  if (staged) {
    // Regular files only (git file modes 100644 and 100755): not links (120000) or submodules (160000).
    const regular = new Set(zList(gitRun(repo, ['ls-files', '-z', '--stage'])).filter((r) => /^100(644|755) /.test(r)).map((r) => r.slice(r.indexOf('\t') + 1)));
    return { tracked, regular, markdown: [...tracked].filter((p) => p.endsWith('.md')) };
  }
  const all = zList(gitRun(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  // A tracked file deleted on disk but not yet staged is still listed; skip it.
  return { tracked, markdown: [...new Set(all)].filter((p) => p.endsWith('.md') && existsSync(join(repo, p))) };
}

// Copies only what the checks read from the staged files into a temp folder: every Markdown file, the
// settings, and the manifest. Everything else is read straight from git when a check asks for it.
function stageCopy(repo, tracked) {
  const root = mkdtempSync(join(tmpdir(), 'rule-check-staged-'));
  const wanted = [...tracked].filter((p) => p.endsWith('.md') || p === CONFIG_FILE || p === MANIFEST_FILE);
  if (wanted.length) {
    execFileSync('git', ['checkout-index', '-z', '--stdin', `--prefix=${root}/`], { cwd: repo, input: wanted.join('\0'), stdio: ['pipe', 'ignore', 'ignore'] });
  }
  return root;
}

function statusFacts(repo, config, fetch) {
  const notes = [];
  if (fetch && !gitOk(repo, ['fetch', '-q', '--prune', config.remote])) notes.push(`Note: could not fetch from ${config.remote}; this report uses what is already here.`);
  const baseRef = [`${config.remote}/${config.baseBranch}`, config.baseBranch].find((ref) => gitOk(repo, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]));
  const count = (range) => {
    try {
      return Number(gitRun(repo, ['rev-list', '--count', range]).trim());
    } catch {
      return 0;
    }
  };
  const base = baseRef ? { ref: baseRef, commit: gitRun(repo, ['rev-parse', '--short', baseRef]).trim(), behind: count(`HEAD..${baseRef}`) } : null;

  const prefix = `refs/remotes/${config.remote}/`;
  const short = (ref) => ref.slice(prefix.length);
  let refs = [];
  try {
    refs = gitRun(repo, ['for-each-ref', '--format=%(refname)%09%(committerdate:unix)%09%(subject)', prefix]).split('\n').filter(Boolean).map((line) => {
      const [ref, time, ...subject] = line.split('\t');
      return { ref, time: Number(time), subject: subject.join('\t') };
    }).filter((r) => short(r.ref) !== 'HEAD');
  } catch {
    // no remote refs here
  }
  let branches = [];
  if (baseRef) {
    try {
      branches = gitRun(repo, ['for-each-ref', '--no-merged', baseRef, '--format=%(refname)', prefix]).split('\n').filter(Boolean)
        .filter((ref) => short(ref) !== 'HEAD')
        .map((ref) => ({ name: short(ref), ahead: count(`${baseRef}..${ref}`) }));
    } catch {
      // leave the list empty
    }
  }
  const newest = refs.sort((a, b) => b.time - a.time)[0];
  const lastPush = newest ? { ref: `${config.remote}/${short(newest.ref)}`, subject: newest.subject, minutes: Math.max(0, Math.round((Date.now() / 1000 - newest.time) / 60)) } : null;
  return { base, branches, lastPush, notes };
}

// Open asks in this repo's event log: { open, note }. A missing or unreadable log counts as 0, with a note.
function readOpenAsks(repo) {
  let file;
  try {
    file = resolve(repo, gitRun(repo, ['rev-parse', '--git-common-dir']).trim(), EVENTS_NAME);
  } catch {
    return { open: 0, note: 'no git folder here, so no event log to read' };
  }
  if (!existsSync(file)) return { open: 0, note: 'no event log yet' };
  try {
    return { open: countOpenAsks(readFileSync(file, 'utf8')), note: null };
  } catch (e) {
    return { open: 0, note: `the event log could not be read: ${e.message}` };
  }
}

function printStatus(repo, fetch) {
  const config = loadConfig(repo);
  const plans = listPlans(repo, config).map((plan) => ({ ...plan, header: parsePlan(readFileSync(join(repo, plan.path), 'utf8')).header }));
  const readText = (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : null);
  const roadmap = readText(config.roadmap);
  const inboxText = readText(config.inbox);
  const { base, branches, lastPush, notes } = statusFacts(repo, config, fetch);
  const invariantsText = readText(INVARIANTS_FILE);
  if (invariantsText !== null && !checkInvariants(invariantsText, () => true).optedIn) {
    notes.push(`Note: ${INVARIANTS_FILE} has no line "${INVARIANTS_MARKER}", so the checker does not read it. Add the line once its table has the columns Id, Rule, Area, Check, State.`);
  }
  const order = roadmap === null ? [] : roadmapLinks(roadmap, config.roadmap);
  const report = buildStatus({ plans, order, branches, config });
  const lines = formatStatus({
    report, config, base, lastPush, notes,
    inbox: inboxText === null ? null : countInbox(inboxText),
    asks: readOpenAsks(repo),
    unplanned: roadmap === null ? null : firstUnplannedRow(roadmap),
  });
  console.log(lines.join('\n'));
}

// ---------- Run ----------

// Reads the command line. An option it does not know is an error, never ignored.
export function parseCli(argv) {
  const cli = { staged: false, status: false, fetch: true, root: null, branch: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--staged') cli.staged = true;
    else if (arg === '--status') cli.status = true;
    else if (arg === '--no-fetch') cli.fetch = false;
    else if (arg === '--root' || arg === '--branch' || arg === '--base') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      cli[arg.slice(2)] = value;
    } else throw new Error(`unknown option "${arg}" (allowed: --staged, --status, --no-fetch, --root <dir>, --branch <name>, --base <ref>)`);
  }
  return cli;
}

function main(argv) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (e) {
    console.error(`Rule checker: ${e.message}`);
    process.exit(1);
  }
  const repo = cli.root ? resolve(cli.root) : join(fileURLToPath(import.meta.url), '../..');

  if (cli.status) {
    try {
      printStatus(repo, cli.fetch);
    } catch (e) {
      console.error(`Status could not run: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  const { staged } = cli;
  const branch = cli.branch ?? currentBranch(repo);
  let root = repo;
  let errors;
  try {
    const listed = gitFiles(repo, staged);
    let files = null;
    if (staged) {
      if (!listed) throw new Error('--staged needs a git repo');
      // Check exactly what git is about to commit: a temp copy of the staged Markdown and settings,
      // and git itself for everything else.
      root = stageCopy(repo, listed.tracked);
      const copy = root;
      const { tracked } = listed;
      files = {
        markdown: listed.markdown,
        exists: (p) => tracked.has(p) || [...tracked].some((t) => t.startsWith(`${p.replace(/\/+$/, '')}/`)),
        isFile: (p) => listed.regular.has(p),
        read: (p) => {
          if (existsSync(join(copy, p))) return readFileSync(join(copy, p));
          if (!tracked.has(p)) return null;
          try {
            return gitBytes(repo, ['show', `:${p}`]);
          } catch {
            return null;
          }
        },
      };
    } else if (listed) {
      files = { markdown: listed.markdown };
    }
    // The proposed settings come from the copy being checked. Whether they count depends on the branch:
    // see chooseConfig. A folder that is not a git repo has no base and no branch rules, so they count there.
    const proposed = loadConfig(root);
    let config = proposed;
    let baseConfig = null;
    let kind = null;
    if (listed) {
      const baseRef = resolveBaseRef(repo, proposed, cli.base);
      let trusted;
      try {
        trusted = trustedConfig(repo, baseRef, proposed);
      } catch (e) {
        // Broken settings on the base stop every branch, except one the default settings call a lead
        // branch: that is the only way left to mend them.
        if (classifyBranch(branch, DEFAULT_CONFIG) !== 'lead') throw e;
        console.error(`Note: ${e.message}. This lead branch is checked with its own settings so it can mend them.`);
        trusted = { ...DEFAULT_CONFIG };
      }
      baseConfig = trusted;
      ({ config, kind } = chooseConfig({ branch, proposed, trusted }));
    }
    const checked = config;
    errors = checkRepo(root, { branch, kind, config, baseConfig, files, git: listed ? () => gitFacts(repo, root, staged, checked, cli.base) : null });
  } catch (e) {
    errors = [`checker could not run: ${e.message}`];
  } finally {
    if (root !== repo) rmSync(root, { recursive: true, force: true });
  }
  if (errors.length) {
    console.error(`Rule checks: ${errors.length} problem${errors.length === 1 ? '' : 's'} found\n`);
    for (const e of errors) console.error(`  x ${e}`);
    console.error('\nFix these, then run: node scripts/check-plans.mjs');
    process.exit(1);
  }
  const what = staged ? 'staged files' : 'files on disk';
  console.log(`Rule checks passed (${what}, branch: ${branch || 'none'})`);
}

// Compare real paths, so the script still runs when it is started through a linked folder
// (on macOS the temp folder is one). Without this it would do nothing and exit 0.
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

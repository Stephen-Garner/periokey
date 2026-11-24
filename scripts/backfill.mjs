#!/usr/bin/env node
// backfill.mjs: loads a project's old history into the event log, in the log's own format.
//
// What it does, in plain English:
//   Old plan files hold their history as free text: a progress log, review notes. The dashboard
//   reads history from the event log (scripts/events.mjs) instead. So a reader (a person or an
//   agent) goes through each old plan and writes down the events it records in a "proposal file":
//   one file per slice, named NNN.jsonl (NNN is the slice number), one JSON object per line:
//     { "type": "review-round", "slice": 75, "at": "2026-11-11", "model": "codex/gpt-6.1-sol",
//       "data": { "task": 2, "part": "2a", "round": 1, "verdict": "approved", "findings": 2 },
//       "evidence": "a quote copied word for word from the plan" }
//   This script never trusts a proposal. It checks every line against the slice's plan file on the
//   base branch (origin/main, else main), and loads nothing at all while any line fails:
//     - type is slice-started, task-done, review-round, or slice-closed
//     - slice is the number in the file name, and a plan file with that number exists
//     - at is a real day written YYYY-MM-DD, and that day is written somewhere in the plan
//     - evidence is 10 to 240 characters and is in the plan word for word (runs of spaces and
//       line breaks count as one space)
//     - task-done: data.task is a task number from the plan's "## Tasks" list (any whole number
//       when the plan has no numbered list); data.pr is a pull request number or null
//     - review-round: data.task is null or a task number; data.part is null or a label of 8
//       characters at most; data.round is 1 or more; data.verdict is approved or changes;
//       data.findings is a count or null; model is null or tool/model-id
//     - no two lines of a file say the same thing: one slice-started, one slice-closed, one
//       task-done per task, one review-round per task, part, and round
//   A line that passes becomes one event, written through appendEvent:
//     - at: the line's day at 12:00 local time, because old plans give days, not times
//     - id: the first 8 hex characters of a SHA-1 over slice, type, task, part, and round. The same
//       line always gets the same id, so running apply twice adds nothing: an id that is already
//       in the log is skipped and counted
//     - role: "reviewer" for a review-round, else null. branch and thread: null
//     - data: the line's data plus backfilled: true, dateOnly: true, source (the plan's path), and
//       evidence (the quote). A task-done also gets the task's title from the plan
//   Events are written oldest first. The log's readers sort by time anyway (readEventsFile).
//   The contract is docs/2026-11-18-dashboard-data-contract.md, section 8 ("Backfill: loading old history").
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/backfill.mjs check <folder>
//       Checks every NNN.jsonl in the folder. Prints each problem as file:line: reason. Line 0
//       means the whole file (for example, no plan has that number).
//   node scripts/backfill.mjs apply <folder> [--dry-run]
//       Runs the same check, then writes the events. --dry-run says what it would write and writes nothing.
// Exit codes: 0 done, 1 a problem in a proposal or an error (such as no git repo here), 2 wrong usage.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTasks } from './check-plans.mjs';
import { appendEvent, readEvents } from './events.mjs';
import { projectOf } from './slice.mjs';

export const TYPES = ['slice-started', 'task-done', 'review-round', 'slice-closed'];
export const EVIDENCE_MIN = 10;
export const EVIDENCE_MAX = 240;
const FILE_NAME = /^(\d{3})\.jsonl$/;
const FOLDERS = ['active', 'completed'];
const MODEL = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/;
const USAGE = 'Usage: node scripts/backfill.mjs check <folder>\n       node scripts/backfill.mjs apply <folder> [--dry-run]';
// Where a slice's events sit among others of the same day: its start first, its close last.
const RANK = { 'slice-started': 0, 'review-round': 1, 'task-done': 1, 'slice-closed': 2 };

const usage = (msg) => Object.assign(new Error(msg), { usage: true });
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
const isInt = (v) => Number.isInteger(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Runs of spaces and line breaks count as one space, so a quote may cross a line break in the plan.
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// "2026-11-11" -> that day at 12:00 local time, in ms. null when the text is not a real day.
export function noonOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : null;
}

// What makes a line itself: two lines with the same key say the same thing.
const keyOf = (e) => [e.slice, e.type, e.data?.task ?? '', e.data?.part ?? '', e.data?.round ?? ''].join('|');

// The stable event id of a line: the same slice, type, task, part, and round always give the same id.
export const backfillId = (e) => createHash('sha1').update(keyOf(e)).digest('hex').slice(0, 8);

// Every plan file on the base ref, by slice number: Map(number -> path). The active folder wins.
function plansOnBase(root, config, baseRef) {
  const byNumber = new Map();
  for (const folder of FOLDERS) {
    let paths = [];
    try {
      paths = git(root, ['ls-tree', '--name-only', baseRef, `${config.plansDir}/${folder}/`]).split('\n');
    } catch {
      continue;
    }
    for (const path of paths) {
      const m = /^(\d{3})-[^/]*\.md$/.exec(path.slice(path.lastIndexOf('/') + 1));
      if (m && !byNumber.has(Number(m[1]))) byNumber.set(Number(m[1]), path);
    }
  }
  return byNumber;
}

// Checks one line of a proposal file. plan: { text (normalized), tasks: [{ n, title }] }.
// Returns { event, reasons }: event is the parsed line (null when it is not a JSON object), and
// reasons lists every rule it breaks, each as one plain phrase. seen holds the keys of earlier lines.
export function checkLine(line, { slice, plan, seen }) {
  const reasons = [];
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return { event: null, reasons: ['not valid JSON'] };
  }
  if (!isObject(e)) return { event: null, reasons: ['not a JSON object'] };
  if (!TYPES.includes(e.type)) return { event: null, reasons: [`type must be one of ${TYPES.join(', ')}`] };
  if (e.slice !== slice) reasons.push(`slice must be ${slice}`);
  if (typeof e.at !== 'string' || noonOf(e.at) === null) reasons.push('at must be a real day like 2026-11-11');
  else if (!plan.text.includes(e.at)) reasons.push(`the date ${e.at} is nowhere in the plan`);
  if (typeof e.evidence !== 'string' || e.evidence.length < EVIDENCE_MIN || e.evidence.length > EVIDENCE_MAX) reasons.push(`evidence must be a quote of ${EVIDENCE_MIN} to ${EVIDENCE_MAX} characters`);
  else if (!plan.text.includes(norm(e.evidence))) reasons.push('the evidence quote is not in the plan word for word');
  const d = e.data;
  if (!isObject(d)) return { event: null, reasons: [...reasons, 'data must be an object'] };
  const numbers = plan.tasks.map((t) => t.n);
  const taskOk = (t) => isInt(t) && (numbers.length === 0 || numbers.includes(t));
  if (e.type === 'task-done') {
    if (!taskOk(d.task)) reasons.push(`data.task must be a task number from the plan (${numbers.join(', ') || 'none listed'})`);
    if (!(d.pr === null || isInt(d.pr))) reasons.push('data.pr must be a pull request number or null');
  }
  if (e.type === 'review-round') {
    if (!(d.task === null || taskOk(d.task))) reasons.push('data.task must be null or a task number from the plan');
    if (!(d.part === null || (typeof d.part === 'string' && d.part.length <= 8))) reasons.push('data.part must be null or a short label like 2a');
    if (!isInt(d.round) || d.round < 1) reasons.push('data.round must be 1 or more');
    if (!['approved', 'changes'].includes(d.verdict)) reasons.push('data.verdict must be approved or changes');
    if (!(d.findings === null || (isInt(d.findings) && d.findings >= 0))) reasons.push('data.findings must be a count or null');
    if (!(e.model === null || (typeof e.model === 'string' && MODEL.test(e.model)))) reasons.push('model must be null or tool/model-id as the plan writes it');
  }
  const key = keyOf({ ...e, slice });
  if (seen.has(key)) reasons.push(`repeats an earlier line (${key})`);
  seen.add(key);
  return { event: e, reasons };
}

// Checks every NNN.jsonl in folder against the plans on the base ref of the repo that holds cwd.
// Returns { files, lines, problems, events }:
//   files     how many proposal files were read          lines   how many lines they hold
//   problems  [{ file, line, reason }], line 0 for a whole file
//   events    one per line that passed, ready for appendEvent: { id, at (ms), type, slice, role, model, data }
// Throws on what is not about one line: no such folder, no git repo, no base ref.
export function checkFolder(cwd, folder) {
  const dir = resolve(cwd, folder);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder.`);
  const { root, config, baseRef } = projectOf(cwd);
  if (!baseRef) throw new Error(`${root} has no base branch (${config.remote}/${config.baseBranch} or ${config.baseBranch}), so there are no plans to check against.`);
  const paths = plansOnBase(root, config, baseRef);
  const names = readdirSync(dir).filter((n) => FILE_NAME.test(n)).sort();
  const problems = [];
  const events = [];
  const idKeys = new Map();
  let lines = 0;
  for (const name of names) {
    const file = join(folder, name);
    const slice = Number(FILE_NAME.exec(name)[1]);
    const rows = readFileSync(join(dir, name), 'utf8').split('\n').map((text, i) => ({ text, n: i + 1 })).filter((r) => r.text.trim());
    lines += rows.length;
    const path = paths.get(slice);
    if (!path) {
      problems.push({ file, line: 0, reason: `no plan file starts with ${name.slice(0, 3)}- in ${config.plansDir}/active or ${config.plansDir}/completed on ${baseRef}` });
      continue;
    }
    const raw = git(root, ['show', `${baseRef}:${path}`]);
    const plan = { text: norm(raw), tasks: parseTasks(raw) };
    const seen = new Set();
    for (const row of rows) {
      const { event: e, reasons } = checkLine(row.text, { slice, plan, seen });
      const id = e ? backfillId(e) : null;
      if (e && !reasons.length && idKeys.has(id) && idKeys.get(id) !== keyOf(e)) reasons.push(`gets the same event id (${id}) as a different line (${idKeys.get(id)})`);
      for (const reason of reasons) problems.push({ file, line: row.n, reason });
      if (!e || reasons.length) continue;
      idKeys.set(id, keyOf(e));
      const data = { ...e.data };
      if (e.type === 'task-done') data.title = plan.tasks.find((t) => t.n === e.data.task)?.title ?? null;
      Object.assign(data, { backfilled: true, dateOnly: true, source: path, evidence: e.evidence });
      events.push({
        id, at: noonOf(e.at), type: e.type, slice, role: e.type === 'review-round' ? 'reviewer' : null,
        model: typeof e.model === 'string' && e.model ? e.model : null, data, file, line: row.n,
      });
    }
  }
  // Oldest first; within one day, slice by slice, a start before the rest and a close after it.
  events.sort((a, b) => a.at - b.at || a.slice - b.slice || RANK[a.type] - RANK[b.type] || a.line - b.line);
  return { files: names.length, lines, problems, events };
}

// Checks, then writes. Returns checkFolder's result plus { written, skipped, byType }, where byType is
// { type: { read, written, skipped } }. When problems is not empty, nothing was written.
// An id that the log already holds is skipped when that event is the same backfilled one; an id held
// by some other event is a problem, so nothing is written over or beside it.
export function applyFolder(cwd, folder, { dryRun = false } = {}) {
  const res = checkFolder(cwd, folder);
  const inLog = new Map(readEvents(cwd).events.map((e) => [e.id, e]));
  for (const e of res.events) {
    const old = inLog.get(e.id);
    if (old && !(old.type === e.type && old.slice === e.slice && old.data?.backfilled === true)) {
      res.problems.push({ file: e.file, line: e.line, reason: `its event id (${e.id}) is already in the log on a different event (${old.type}${old.slice === null || old.slice === undefined ? '' : `, slice ${old.slice}`})` });
    }
  }
  const byType = Object.fromEntries(TYPES.map((t) => [t, { read: 0, written: 0, skipped: 0 }]));
  let written = 0;
  let skipped = 0;
  if (res.problems.length) return { ...res, written, skipped, byType };
  for (const e of res.events) {
    byType[e.type].read++;
    if (inLog.has(e.id)) {
      skipped++;
      byType[e.type].skipped++;
      continue;
    }
    if (!dryRun) {
      appendEvent(cwd, { id: e.id, type: e.type, data: e.data, slice: e.slice, role: e.role, model: e.model, thread: null, branch: null }, { env: {}, now: e.at });
    }
    written++;
    byType[e.type].written++;
  }
  return { ...res, written, skipped, byType };
}

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const problemLines = (problems) => problems.map((p) => `${p.file}:${p.line}: ${p.reason}`).join('\n');

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  const [cmd, ...rest] = argv;
  try {
    if (cmd !== 'check' && cmd !== 'apply') throw usage(cmd ? `unknown command ${cmd}` : 'no command');
    const flags = rest.filter((a) => a.startsWith('--'));
    const args = rest.filter((a) => !a.startsWith('--'));
    const bad = flags.find((a) => !(cmd === 'apply' && a === '--dry-run'));
    if (bad) throw usage(`unknown option ${bad}`);
    if (args.length !== 1) throw usage(`${cmd} needs one folder of proposal files.`);
    const dryRun = flags.includes('--dry-run');
    const res = cmd === 'check' ? checkFolder(cwd, args[0]) : applyFolder(cwd, args[0], { dryRun });
    if (res.problems.length) {
      err(`${problemLines(res.problems)}\n`);
      err(`backfill: ${count(res.problems.length, 'problem')} in ${count(res.files, 'file')}.${cmd === 'apply' ? ' Nothing was written.' : ''}\n`);
      return 1;
    }
    if (cmd === 'check') {
      out(`ok: ${count(res.lines, 'line')} in ${count(res.files, 'file')}\n`);
      return 0;
    }
    out(`${dryRun ? 'dry run, nothing written: ' : ''}${count(res.lines, 'line')} read from ${count(res.files, 'file')}; ${count(res.written, 'event')} ${dryRun ? 'would be written' : 'written'}, ${res.skipped} skipped (already in the log)\n`);
    for (const t of TYPES) {
      const c = res.byType[t];
      if (c.read) out(`  ${t.padEnd(14)} ${dryRun ? 'would write' : 'written'} ${c.written}, skipped ${c.skipped}\n`);
    }
    return 0;
  } catch (e) {
    if (e.usage) {
      err(`Wrong usage: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    err(`backfill: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

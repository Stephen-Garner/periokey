#!/usr/bin/env node
// slice.mjs: the task log of a slice, a table of every slice, and a generator for a new plan.
//
// What it does, in plain English:
//   The plan says what the tasks are; the log says what happened to them.
//   A slice's plan file (docs/plans/active/NNN-short-name.md) lists its tasks under "## Tasks" as a
//   numbered list: "1. text", "2. text", each starting a line. This script records what happens to
//   each task as one event in the project's event log (scripts/events.mjs): task-started, task-done,
//   or task-dropped, with the slice number and the task number. The log is shared by every worktree,
//   so a builder on any branch can write to it at once, with no edit to the plan and no merge, and
//   the dashboard shows the progress right away.
//   A task's state is its newest event: todo (no event yet), doing, done, or dropped. Asking for the
//   state a task already has writes nothing, so every command is safe to run twice.
//   The slice comes from --slice, or else from the branch name (build/082-x is slice 82). The plan is
//   read from the working tree's plan folders (their names come from scripts/kit.config.json); a plan
//   the working tree lacks is read from the base branch (origin/main, else main).
//   The contract is docs/2026-11-18-dashboard-data-contract.md, section 7 ("Tasks: what happened to each task of a slice").
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/slice.mjs task start <n> [--slice N]
//   node scripts/slice.mjs task done <n> [--slice N] [--note "..."]
//   node scripts/slice.mjs task drop <n> --why "..." [--slice N]
//       A task number that is not in the plan is refused, with the numbers that exist.
//   node scripts/slice.mjs status [--slice N] [--json]
//       Each task of one slice with its state and the time of its newest event.
//   node scripts/slice.mjs list [--status <status>] [--json]
//       One line per plan: id, status, builder, reviewer, tasks done of total, title.
//   node scripts/slice.mjs new <short-name> --title "..."
//       Writes docs/plans/active/NNN-short-name.md from docs/plans/_template.md with the next free
//       number, the id and log header fields and the title filled in, and the plan's log file.
//       It never overwrites a file. Fill the plan in, link it from the roadmap, then run the checker.
// Exit codes: 0 done, 1 an error (such as no plan for the slice), 2 wrong usage or a refused command.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATUSES, baseCandidates, loadConfig, logPathFor, parsePlan, parseTasks } from './check-plans.mjs';
import { appendEvent, currentBranch, readEvents } from './events.mjs';
import { sliceId } from './token-ledger.mjs';

// The state each event type puts a task in. A task with no event is "todo".
export const TASK_STATE = Object.freeze({ 'task-started': 'doing', 'task-done': 'done', 'task-dropped': 'dropped' });
export const TASK_TYPES = Object.keys(TASK_STATE);
export const NOTE_MAX = 300;
const ACTIONS = { start: 'task-started', done: 'task-done', drop: 'task-dropped' };
const FOLDERS = ['active', 'completed'];
const PLAN_NAME = /^(\d{3})-[^/]*\.md$/;
const SHORT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const USAGE = 'Usage: node scripts/slice.mjs task start <n> [--slice N]\n'
  + '       node scripts/slice.mjs task done <n> [--slice N] [--note <text>]\n'
  + '       node scripts/slice.mjs task drop <n> --why <text> [--slice N]\n'
  + '       node scripts/slice.mjs status [--slice N] [--json]\n'
  + '       node scripts/slice.mjs list [--status <status>] [--json]\n'
  + '       node scripts/slice.mjs new <short-name> --title <text>';

const refuse = (msg) => Object.assign(new Error(msg), { refused: true });
const usage = (msg) => Object.assign(refuse(msg), { usage: true });
const nnn = (n) => String(n).padStart(3, '0');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });

// ---------- Task states, from events (the dashboard uses these too) ----------

// tasks: [{ n, title }] from parseTasks. events: oldest first. Returns [{ n, title, state, at }]:
// the state of a task is its newest event for this slice; at is that event's time, or null.
// An event loaded from an old plan file (scripts/backfill.mjs) counts like any other; its row also
// carries backfilled: true and dateOnly: true, so the dashboard can say where it came from.
export function taskStates(tasks, events, slice) {
  const newest = new Map();
  for (const e of events || []) {
    if (e.slice === slice && e.type in TASK_STATE) newest.set(Number(e.data?.task), e);
  }
  return tasks.map((t) => {
    const e = newest.get(t.n);
    const old = e?.data?.backfilled === true ? { backfilled: true, ...(e.data.dateOnly === true ? { dateOnly: true } : {}) } : {};
    return { n: t.n, title: t.title, state: e ? TASK_STATE[e.type] : 'todo', at: e ? e.at : null, ...old };
  });
}

// One slice's tasks with their states, and the count: { tasks, done, total, logged }.
// total leaves out dropped tasks. logged: the slice has at least one task event.
// A slice whose plan status is "done" counts as fully done: every task not dropped is done.
export function sliceTasks({ slice, status, tasks }, events) {
  const logged = (events || []).some((e) => e.slice === slice && e.type in TASK_STATE);
  let states = taskStates(tasks || [], events, slice);
  if (status === 'done') states = states.map((t) => (t.state === 'dropped' ? t : { ...t, state: 'done' }));
  const kept = states.filter((t) => t.state !== 'dropped');
  return { tasks: states, done: kept.filter((t) => t.state === 'done').length, total: kept.length, logged };
}

// ---------- Finding plans ----------

// The working tree that holds cwd, its settings, and the base ref (null when the repo has none).
export function projectOf(cwd) {
  let root;
  try {
    root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new Error(`${resolve(cwd)} is not inside a git working tree, so there are no plans to read here.`);
  }
  const config = loadConfig(root);
  const exists = (ref) => {
    try {
      git(root, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  return { root, config, baseRef: baseCandidates(config).find(exists) ?? null };
}

function planOf(text, where) {
  const title = text.match(/^#\s+\d+\s*:\s*(.+?)\s*$/m);
  return { ...where, slice: Number(where.file.slice(0, 3)), header: parsePlan(text).header || {}, title: title ? title[1] : null, tasks: parseTasks(text) };
}

// Every plan, lowest number first: the working tree's active and completed folders, plus any slice
// number found only on the base ref. Each: { slice, file, folder, path, from, header, title, tasks }.
export function readPlans(cwd) {
  const { root, config, baseRef } = projectOf(cwd);
  const plans = [];
  const seen = new Set();
  for (const folder of FOLDERS) {
    const dir = join(root, config.plansDir, folder);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!PLAN_NAME.test(file) || seen.has(file.slice(0, 3))) continue;
      seen.add(file.slice(0, 3));
      plans.push(planOf(readFileSync(join(dir, file), 'utf8'), { file, folder, path: `${config.plansDir}/${folder}/${file}`, from: 'the working tree' }));
    }
  }
  for (const folder of baseRef ? FOLDERS : []) {
    let paths = [];
    try {
      paths = git(root, ['ls-tree', '--name-only', baseRef, `${config.plansDir}/${folder}/`]).split('\n');
    } catch {
      continue;
    }
    for (const path of paths) {
      const file = path.slice(path.lastIndexOf('/') + 1);
      if (!PLAN_NAME.test(file) || seen.has(file.slice(0, 3))) continue;
      seen.add(file.slice(0, 3));
      plans.push(planOf(git(root, ['show', `${baseRef}:${path}`]), { file, folder, path, from: baseRef }));
    }
  }
  return plans.sort((a, b) => a.slice - b.slice);
}

// The slice number: --slice when given, else the number in the current branch name.
function resolveSlice(cwd, flag) {
  if (flag !== undefined && flag !== null && flag !== '') {
    if (!/^\d+$/.test(String(flag))) throw usage('--slice needs a slice number, such as 82.');
    return Number(flag);
  }
  const branch = currentBranch(cwd);
  const id = branch ? sliceId(branch) : null;
  if (id === null) throw usage(`${branch ? `The branch ${branch} has no slice number in its name (build/082-x is slice 82)` : 'There is no branch here to read the slice number from'}. Pass --slice N.`);
  return Number(id);
}

function findPlan(cwd, slice) {
  const plan = readPlans(cwd).find((p) => p.slice === slice);
  if (!plan) throw new Error(`No plan file starts with ${nnn(slice)}- in the plan folders, in the working tree or on the base branch.`);
  return plan;
}

// ---------- The commands, as functions ----------

const cleanText = (what, v) => {
  const text = v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim();
  if (text !== null && text.length > NOTE_MAX) throw refuse(`The ${what} is ${text.length} characters; shorten it to ${NOTE_MAX} or fewer.`);
  return text;
};

// Writes one task event. action: start, done, or drop. Returns { written, event, slice, task }, where
// task is { n, title, state, at } after the call. written is false, and nothing is appended, when the
// task already has that state.
export function logTask(cwd, action, n, { slice, note = null, why = null } = {}, opts) {
  const type = ACTIONS[action];
  if (!type) throw usage('task needs start, done, or drop.');
  if (!/^\d+$/.test(String(n ?? ''))) throw usage(`task ${action} needs the task number, such as 3.`);
  const num = Number(n);
  note = cleanText('note', note);
  why = cleanText('why', why);
  if (action === 'drop' && !why) throw refuse('Dropping a task needs --why "...": one sentence on why it will not be done.');
  const sl = resolveSlice(cwd, slice);
  const plan = findPlan(cwd, sl);
  const task = plan.tasks.find((t) => t.n === num);
  if (!task) {
    throw refuse(plan.tasks.length
      ? `Slice ${nnn(sl)} has no task ${num}. Its plan (${plan.path}) lists these task numbers: ${plan.tasks.map((t) => t.n).join(', ')}.`
      : `The plan for slice ${nnn(sl)} (${plan.path}) has no numbered tasks under "## Tasks", so there is nothing to log.`);
  }
  const [now] = taskStates([task], readEvents(cwd, { types: TASK_TYPES }).events, sl);
  if (now.state === TASK_STATE[type]) return { written: false, event: null, slice: sl, task: now };
  const data = { task: num, title: task.title };
  if (action === 'done') data.note = note;
  if (action === 'drop') data.why = why;
  const event = appendEvent(cwd, { type, data, slice: sl }, opts);
  return { written: true, event, slice: sl, task: { ...now, state: TASK_STATE[type], at: event.at } };
}

// One slice: { slice, title, status, path, done, total, logged, tasks: [{ n, title, state, at }] }.
export function sliceStatus(cwd, { slice } = {}) {
  const sl = resolveSlice(cwd, slice);
  const plan = findPlan(cwd, sl);
  const status = plan.header.status ?? null;
  return { slice: sl, title: plan.title, status, path: plan.path, ...sliceTasks({ slice: sl, status, tasks: plan.tasks }, readEvents(cwd, { types: TASK_TYPES }).events) };
}

// Every plan as a row: { id, status, builder, reviewer, done, total, title, path }. status filters.
export function listSlices(cwd, { status = null } = {}) {
  if (status !== null && !STATUSES.includes(status)) throw usage(`--status must be one of: ${STATUSES.join(', ')}.`);
  const { events } = readEvents(cwd, { types: TASK_TYPES });
  return readPlans(cwd)
    .filter((p) => status === null || p.header.status === status)
    .map((p) => {
      const { done, total } = sliceTasks({ slice: p.slice, status: p.header.status, tasks: p.tasks }, events);
      return { id: p.slice, status: p.header.status ?? null, builder: p.header.builder || null, reviewer: p.header.reviewer || null, done, total, title: p.title, path: p.path };
    });
}

// The template's text with the header's id and log, the title line, and every "NNN-short-name" filled in.
export function fillTemplate(template, { id, name, title, log }) {
  const m = template.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('The plan template has no header (the fields between two --- lines).');
  const setField = (header, key, value) => (new RegExp(`^${key}:.*$`, 'm').test(header)
    ? header.replace(new RegExp(`^${key}:.*$`, 'm'), () => `${key}: ${value}`)
    : `${header}\n${key}: ${value}`);
  const header = setField(setField(m[1], 'id', id), 'log', log);
  const heading = `# ${nnn(id)}: ${title}`;
  const body = /^# .*$/m.test(m[2]) ? m[2].replace(/^# .*$/m, () => heading) : `\n${heading}\n${m[2]}`;
  return `---\n${header}\n---\n${body.split('NNN-short-name').join(`${nnn(id)}-${name}`)}`;
}

// Writes a new plan and its log file. Returns { id, plan, log } (paths from the repo root).
// The number is one more than the highest plan number in the working tree and on the base ref.
export function newPlan(cwd, name, { title } = {}) {
  name = String(name ?? '');
  title = String(title ?? '').trim();
  if (!SHORT_NAME.test(name)) throw usage('new needs a short name of lowercase words joined by dashes, such as save-word.');
  if (!title) throw usage('new needs --title "...": the slice name a reader would understand.');
  if (/[\r\n]/.test(title)) throw usage('The title must be one line.');
  const { root, config } = projectOf(cwd);
  const templatePath = `${config.plansDir}/_template.md`;
  if (!existsSync(join(root, templatePath))) throw new Error(`${templatePath} is missing, so there is nothing to make the plan from.`);
  const id = readPlans(cwd).reduce((max, p) => Math.max(max, p.slice), 0) + 1;
  if (id > 999) throw new Error('Plan numbers have three digits, and 999 is taken.');
  const file = `${nnn(id)}-${name}.md`;
  const plan = `${config.plansDir}/active/${file}`;
  const log = logPathFor(file, config);
  for (const p of [plan, log]) if (existsSync(join(root, p))) throw refuse(`${p} already exists; nothing was written. Move or delete it first, or pick another name.`);
  const text = fillTemplate(readFileSync(join(root, templatePath), 'utf8'), { id, name, title, log });
  for (const p of [plan, log]) mkdirSync(dirname(join(root, p)), { recursive: true });
  // The "wx" flag makes the write itself fail if the file appeared since the check above.
  writeFileSync(join(root, plan), text, { flag: 'wx' });
  writeFileSync(join(root, log), `# ${nnn(id)}: ${title} log\n`, { flag: 'wx' });
  return { id, plan, log };
}

// ---------- The command line ----------

// Reads --name value pairs; names in bools take no value.
function parseFlags(args, bools = []) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (bools.includes(name)) {
      o[name] = true;
      continue;
    }
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) throw usage(`${a} needs a value.`);
    o[name] = v;
  }
  return o;
}

function only(o, allowed, positional) {
  for (const k of Object.keys(o)) if (k !== '_' && !allowed.includes(k)) throw usage(`unknown option --${k}`);
  if (o._.length > positional) throw usage(`unexpected ${o._[positional]}`);
}

const pad = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')).join('\n');
};
const countText = (r) => (r.total ? `${r.done} of ${r.total} tasks` : 'no tasks');

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  const opts = { env: io.env || process.env };
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'task') {
      const [action, ...more] = rest;
      if (!ACTIONS[action]) throw usage('task needs start, done, or drop.');
      const o = parseFlags(more);
      only(o, { start: ['slice'], done: ['slice', 'note'], drop: ['slice', 'why'] }[action], 1);
      const r = logTask(cwd, action, o._[0], { slice: o.slice, note: o.note, why: o.why }, opts);
      const what = `slice ${nnn(r.slice)} task ${r.task.n} (${r.task.title})`;
      out(r.written ? `${r.task.state}: ${what}\n` : `already ${r.task.state} since ${r.task.at}: ${what}; nothing written\n`);
      return 0;
    }
    if (cmd === 'status') {
      const o = parseFlags(rest, ['json']);
      only(o, ['slice', 'json'], 0);
      const s = sliceStatus(cwd, { slice: o.slice });
      if (o.json) out(`${JSON.stringify(s)}\n`);
      else {
        const head = `slice ${nnn(s.slice)}: ${s.title ?? 'no title'} (${s.status ?? 'no status'}), ${countText(s)}${s.total ? ' done' : ''}`;
        out(`${head}\n${s.tasks.length ? `${pad(s.tasks.map((t) => [`  ${t.n}`, t.state, t.at ?? '-', t.title]))}\n` : ''}`);
      }
      return 0;
    }
    if (cmd === 'list') {
      const o = parseFlags(rest, ['json']);
      only(o, ['status', 'json'], 0);
      const rows = listSlices(cwd, { status: o.status ?? null });
      if (o.json) out(`${JSON.stringify(rows)}\n`);
      else out(rows.length ? `${pad(rows.map((r) => [nnn(r.id), r.status ?? '-', r.builder ?? '-', r.reviewer ?? '-', countText(r), r.title ?? '']))}\n` : 'no plans\n');
      return 0;
    }
    if (cmd === 'new') {
      const o = parseFlags(rest);
      only(o, ['title'], 1);
      const r = newPlan(cwd, o._[0], { title: o.title });
      out(`wrote ${r.plan} and ${r.log}\nNext: fill in the plan, link it from the roadmap, then run node scripts/check-plans.mjs\n`);
      return 0;
    }
    throw usage(cmd ? `unknown command ${cmd}` : 'no command');
  } catch (e) {
    if (e.refused) {
      err(e.usage ? `Wrong usage: ${e.message}\n${USAGE}\n` : `Refused: ${e.message}\n`);
      return 2;
    }
    err(`slice: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

#!/usr/bin/env node
// experiment.mjs: small, dated tries at a better way of working, kept in the event log.
//
// What it does, in plain English:
//   An experiment asks one question ("Do two reviewers cut fix commits?"), makes one change, and
//   watches one number (the metric) for a set number of days. Its life has three steps, each one
//   event in the project's event log (scripts/events.mjs):
//     propose  an idea, not started yet                    -> experiment-proposed
//     start    begin now, with the metric's value today     -> experiment-started
//     finish   keep, drop, or unclear, with the new value   -> experiment-finished
//   The metric names a number in the dashboard's totals (fixPerFeat, revertRate,
//   tokensPerMergedCodePr) or any short label. When start has no --baseline and the last dashboard
//   build (~/.agent-dashboard/<project>/data.json) holds that totals field, its value is the baseline.
//   `export` writes one Markdown file per experiment into docs/experiments/ of the current folder,
//   so a branch can carry a record of it. Nothing else here writes into a project's files.
//   The contract is docs/2026-11-18-dashboard-data-contract.md, section 3 ("Experiments").
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/experiment.mjs propose --question "..." --change "..." --metric fixPerFeat [--days 14] [--why "..."]
//   node scripts/experiment.mjs start [<proposal id>] [--question ... --change ... --metric ... --days 14] [--baseline 10.1]
//   node scripts/experiment.mjs finish <id> --verdict keep|drop|unclear [--result 6.2] [--note "..."]
//   node scripts/experiment.mjs list [--json]
//   node scripts/experiment.mjs export [<id>]
// Exit codes: 0 done, 1 an error (such as an unknown id), 2 wrong usage or a refused field.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendEvent, commonDir, readEvents } from './events.mjs';
import { localDate } from './token-ledger.mjs';

export const VERDICTS = ['keep', 'drop', 'unclear'];
export const DEFAULT_DAYS = 14;
export const METRIC_MAX = 40;
const DAY_MS = 24 * 3600 * 1000;
const TYPES = ['experiment-proposed', 'experiment-started', 'experiment-finished'];
const USAGE = 'Usage: node scripts/experiment.mjs propose --question <text> --change <text> --metric <name> [--days N] [--why <text>]\n'
  + '       node scripts/experiment.mjs start [<proposal id>] [--question ... --change ... --metric ... --days N] [--baseline N]\n'
  + '       node scripts/experiment.mjs finish <id> --verdict keep|drop|unclear [--result N] [--note <text>]\n'
  + '       node scripts/experiment.mjs list [--json]\n'
  + '       node scripts/experiment.mjs export [<id>]';

const refuse = (msg) => Object.assign(new Error(msg), { refused: true });
const usage = (msg) => Object.assign(refuse(msg), { usage: true });
const text = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());

function number(v, what) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw refuse(`The ${what} must be a number, such as 6.2.`);
  return n;
}

function wholeDays(v) {
  if (v === null || v === undefined || v === '') return DEFAULT_DAYS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw refuse('The days must be a whole number of 1 or more.');
  return n;
}

// question, change, and metric are required; days defaults to 14.
function checkPlan({ question, change, metric, days }) {
  const q = text(question);
  const c = text(change);
  const m = text(metric);
  if (!q) throw refuse('The experiment needs a question, such as "Do two reviewers cut fix commits?".');
  if (!c) throw refuse('The experiment needs the one change it makes.');
  if (!m) throw refuse('The experiment needs a metric: a totals field such as fixPerFeat, or a short label.');
  if (m.length > METRIC_MAX) throw refuse(`The metric is ${m.length} characters; shorten it to ${METRIC_MAX} or fewer.`);
  return { question: q, change: c, metric: m, days: wholeDays(days) };
}

// Every experiment in the events, as the contract's rows: running first, then proposed, then finished.
export function experimentsFrom(events) {
  const rows = new Map();
  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'experiment-proposed' && !rows.has(e.id)) {
      rows.set(e.id, {
        id: e.id, status: 'proposed', question: d.question ?? null, change: d.change ?? null, metric: d.metric ?? null, days: d.days ?? null,
        baseline: null, startedAt: null, reviewAfter: null, verdict: null, result: null, note: null, why: d.why ?? null,
        proposedBy: { role: e.role ?? null, thread: e.thread ?? null }, _t: e.at,
      });
    } else if (e.type === 'experiment-started') {
      const id = d.experiment || e.id;
      let row = rows.get(id);
      if (row && row.status !== 'proposed') continue; // started once already
      if (!row) {
        row = { id, why: null, proposedBy: null, verdict: null, result: null, note: null };
        rows.set(id, row);
      }
      const days = d.days ?? row.days ?? null;
      Object.assign(row, {
        status: 'running',
        question: d.question ?? row.question ?? null,
        change: d.change ?? row.change ?? null,
        metric: d.metric ?? row.metric ?? null,
        days,
        baseline: typeof d.baseline === 'number' ? d.baseline : null,
        startedAt: e.at,
        reviewAfter: typeof days === 'number' ? localDate(Date.parse(e.at) + days * DAY_MS) : null,
        _t: e.at,
      });
    } else if (e.type === 'experiment-finished') {
      const row = rows.get(d.experiment);
      if (!row || row.status !== 'running') continue;
      Object.assign(row, { status: 'finished', verdict: d.verdict ?? null, result: d.result ?? null, note: d.note ?? null, _t: e.at });
    }
  }
  const rank = { running: 0, proposed: 1, finished: 2 };
  return [...rows.values()]
    .sort((a, b) => rank[a.status] - rank[b.status] || Date.parse(b._t) - Date.parse(a._t))
    .map(({ _t, ...row }) => row);
}

export const listExperiments = (cwd) => experimentsFrom(readEvents(cwd, { types: TYPES }).events);

// The project's name as the dashboard writes it: the main checkout's folder name, lowercased.
export const projectKey = (cwd) => basename(dirname(commonDir(cwd))).toLowerCase();

// totals[metric] from the last dashboard build, or null.
export function baselineFor(cwd, metric, home = homedir()) {
  try {
    const data = JSON.parse(readFileSync(join(home, '.agent-dashboard', projectKey(cwd), 'data.json'), 'utf8'));
    const v = data?.totals?.[metric];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// opts: { env, now, home } for tests.
export function proposeExperiment(cwd, fields, opts = {}) {
  const plan = checkPlan(fields);
  const why = text(fields.why);
  return appendEvent(cwd, { type: 'experiment-proposed', data: { ...plan, why }, slice: fields.slice, role: fields.role, model: fields.model }, opts);
}

// Starts a proposal (fields.proposal) or a new experiment. Returns the event; its data.experiment is the id.
export function startExperiment(cwd, fields = {}, opts = {}) {
  const all = listExperiments(cwd);
  let base = {};
  let id;
  if (text(fields.proposal)) {
    const p = all.find((x) => x.id === fields.proposal);
    if (!p) throw new Error(`No experiment has the id ${fields.proposal}.`);
    if (p.status !== 'proposed') throw new Error(`Experiment ${p.id} was already started.`);
    base = p;
    id = p.id;
  } else {
    id = randomBytes(4).toString('hex');
  }
  const plan = checkPlan({
    question: text(fields.question) ?? base.question,
    change: text(fields.change) ?? base.change,
    metric: text(fields.metric) ?? base.metric,
    days: fields.days ?? base.days,
  });
  let baseline = number(fields.baseline, 'baseline');
  if (baseline === null) baseline = baselineFor(cwd, plan.metric, opts.home);
  const data = { experiment: id, question: plan.question, change: plan.change, metric: plan.metric, baseline, days: plan.days };
  return appendEvent(cwd, { ...(base.id ? {} : { id }), type: 'experiment-started', data, slice: fields.slice, role: fields.role, model: fields.model }, opts);
}

export function finishExperiment(cwd, id, { verdict, result, note, role, model } = {}, opts = {}) {
  const x = listExperiments(cwd).find((e) => e.id === id);
  if (!x) throw new Error(`No experiment has the id ${id}.`);
  if (x.status === 'proposed') throw new Error(`Experiment ${id} was never started; start it first.`);
  if (x.status === 'finished') throw new Error(`Experiment ${id} is already finished (${x.verdict}).`);
  if (!VERDICTS.includes(verdict)) throw refuse(`The verdict must be ${VERDICTS.join(', ')}.`);
  const data = { experiment: id, verdict, result: number(result, 'result'), note: text(note) };
  return appendEvent(cwd, { type: 'experiment-finished', data, role, model }, opts);
}

export const slug = (s) => String(s || 'experiment').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '') || 'experiment';

const show = (v) => (v === null || v === undefined ? 'none yet' : String(v));

// One experiment as a short Markdown record.
export function experimentMarkdown(x) {
  return [
    `# Experiment ${x.id}: ${x.question}`,
    '',
    `- Status: ${x.status}`,
    `- Change: ${show(x.change)}`,
    `- Metric: ${show(x.metric)}`,
    `- Baseline: ${show(x.baseline)}`,
    `- Days: ${show(x.days)}`,
    `- Started: ${show(x.startedAt)}`,
    `- Review after: ${show(x.reviewAfter)}`,
    `- Verdict: ${show(x.verdict)}`,
    `- Result: ${show(x.result)}`,
    `- Note: ${show(x.note)}`,
    `- Why: ${show(x.why)}`,
    '',
    'Written by `node scripts/experiment.mjs export` from the event log.',
    '',
  ].join('\n');
}

// Writes docs/experiments/<id>-<slug>.md under folder for each experiment (or only `id`). Returns the paths.
export function exportExperiments(cwd, folder, id = null) {
  let list = listExperiments(cwd);
  if (id) {
    list = list.filter((x) => x.id === id);
    if (!list.length) throw new Error(`No experiment has the id ${id}.`);
  }
  const dir = join(folder, 'docs', 'experiments');
  const paths = [];
  for (const x of list) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, `${x.id}-${slug(x.question)}.md`);
    writeFileSync(path, experimentMarkdown(x));
    paths.push(path);
  }
  return paths;
}

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

function only(o, allowed, maxPositional) {
  for (const k of Object.keys(o)) if (k !== '_' && !allowed.includes(k)) throw usage(`unknown option --${k}`);
  if (o._.length > maxPositional) throw usage(`unexpected ${o._[maxPositional]}`);
}

const line = (x) => `${x.id}  ${x.status}${x.verdict ? ` (${x.verdict})` : ''}  ${x.metric}${x.baseline !== null ? ` from ${x.baseline}` : ''}${x.reviewAfter ? `, review after ${x.reviewAfter}` : ''}  ${x.question}`;

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  const opts = { env: io.env || process.env, home: io.home };
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'propose') {
      const o = parseFlags(rest);
      only(o, ['question', 'change', 'metric', 'days', 'why', 'slice', 'role', 'model'], 0);
      const e = proposeExperiment(cwd, o, opts);
      out(`proposed ${e.id}: ${e.data.question}\n`);
      return 0;
    }
    if (cmd === 'start') {
      const o = parseFlags(rest);
      only(o, ['question', 'change', 'metric', 'days', 'baseline', 'slice', 'role', 'model'], 1);
      const e = startExperiment(cwd, { ...o, proposal: o._[0] }, opts);
      out(`started ${e.data.experiment}: ${e.data.metric} baseline ${show(e.data.baseline)}, review after ${e.data.days} days\n`);
      return 0;
    }
    if (cmd === 'finish') {
      const o = parseFlags(rest);
      only(o, ['verdict', 'result', 'note', 'role', 'model'], 1);
      if (!o._[0]) throw usage('finish needs the experiment id.');
      const e = finishExperiment(cwd, o._[0], o, opts);
      out(`finished ${o._[0]}: ${e.data.verdict}\n`);
      return 0;
    }
    if (cmd === 'list') {
      const o = parseFlags(rest, ['json']);
      only(o, ['json'], 0);
      const all = listExperiments(cwd);
      if (o.json) out(`${JSON.stringify(all)}\n`);
      else out(all.length ? `${all.map(line).join('\n')}\n` : 'no experiments\n');
      return 0;
    }
    if (cmd === 'export') {
      const o = parseFlags(rest);
      only(o, [], 1);
      const paths = exportExperiments(cwd, cwd, o._[0] || null);
      out(paths.length ? `${paths.map((p) => `wrote ${p}`).join('\n')}\n` : 'no experiments to export\n');
      return 0;
    }
    throw usage(cmd ? `unknown command ${cmd}` : 'no command');
  } catch (e) {
    if (e.refused) {
      err(e.usage ? `Wrong usage: ${e.message}\n${USAGE}\n` : `Refused: ${e.message}\n`);
      return 2;
    }
    err(`experiment: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

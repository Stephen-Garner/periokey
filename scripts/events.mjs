#!/usr/bin/env node
// events.mjs: the project's event log. One line of JSON per thing that happened.
//
// What it does, in plain English:
//   Agents, scripts, and the dashboard's local server write small records here: an ask for
//   Stephen, his answer, a job that started or finished, an experiment. The dashboard reads them.
//   The log is one file, <git common dir>/kit-events.jsonl. The git common dir is the repo's
//   shared .git folder, so the main checkout and every worktree of a project write to the same
//   file, and nothing in the project's working files ever changes.
//   Each write is one appendFileSync call of one line that ends with a newline, so two threads
//   writing at once do not mix their lines. A line that is not valid JSON is skipped and counted.
//   The fields are in docs/2026-11-18-dashboard-data-contract.md, section 1 ("The event log").
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/events.mjs add <type> [key=value ...]
//       The keys slice, role, model, thread, and branch go on the event itself; every other key
//       goes into its data. The value null means null. Example:
//       node scripts/events.mjs add job-finished job=factory-analyst run=a1b2c3d4 status=ok summary="Two numbers look off."
//   node scripts/events.mjs list [--type <type>] [--since <YYYY-MM-DD>] [--json]
// Exit codes: 0 done, 1 an error (such as no git repo here), 2 wrong usage.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localDate, sliceId } from './token-ledger.mjs';

export const EVENTS_NAME = 'kit-events.jsonl';
export const TOP_KEYS = ['slice', 'role', 'model', 'thread', 'branch'];
export const SUMMARY_MAX = 300;
const USAGE = 'Usage: node scripts/events.mjs add <type> [key=value ...] | list [--type <type>] [--since <YYYY-MM-DD>] [--json]';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// ms -> "2026-11-18T03:10:00-07:00", in this machine's time zone.
export function isoLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const zone = `${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${zone}`;
}

// The git common dir of the repo that holds cwd, as an absolute path. Throws outside a git repo.
export function commonDir(cwd) {
  let dir;
  try {
    dir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch {
    throw new Error(`${resolve(cwd)} is not inside a git repo, so there is no event log here.`);
  }
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

export const eventsFile = (cwd) => join(commonDir(cwd), EVENTS_NAME);

// The branch checked out in cwd, or null (no branch, or not a repo).
export function currentBranch(cwd) {
  try {
    const b = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

const orNull = (v) => (v === undefined || v === '' ? null : v);

// Writes one event and returns it. id and at are filled here; branch, slice, and thread when not given.
// opts: { env, now } for tests.
export function appendEvent(cwd, { id, type, data = {}, slice, role, model, thread, branch } = {}, { env = process.env, now = Date.now() } = {}) {
  if (typeof type !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(type)) throw new Error('The event type must be a short lowercase word, such as job-finished.');
  if (id !== undefined && !/^[0-9a-f]{8}$/.test(id)) throw new Error('An event id must be 8 hex characters.');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('Event data must be an object.');
  const file = eventsFile(cwd);
  const br = branch === undefined ? currentBranch(cwd) : orNull(branch);
  let sl = slice === undefined ? (br ? sliceId(br) : null) : orNull(slice);
  if (sl !== null) {
    sl = Number(sl);
    if (!Number.isInteger(sl) || sl < 0) throw new Error('The slice must be a whole number, such as 82.');
  }
  const event = {
    id: id || randomBytes(4).toString('hex'),
    at: isoLocal(now),
    type,
    branch: br,
    slice: sl,
    thread: thread === undefined ? orNull(env.T3CODE_THREAD_ID) ?? null : orNull(thread),
    role: orNull(role) ?? null,
    model: orNull(model) ?? null,
    data,
  };
  appendFileSync(file, `${JSON.stringify(event)}\n`);
  return event;
}

// "2026-11-18" compares by local day; any other time text compares by moment.
function sinceTest(since) {
  if (!since) return () => true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) return (e) => localDate(Date.parse(e.at)) >= since;
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`--since needs a day like 2026-11-18, not "${since}".`);
  return (e) => Date.parse(e.at) >= t;
}

// Reads one log file: { events, skipped }. Missing file: no events.
export function readEventsFile(file, { types, since } = {}) {
  if (!existsSync(file)) return { events: [], skipped: 0 };
  const want = types && types.length ? new Set(types) : null;
  const after = sinceTest(since);
  const events = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string' || typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) {
      skipped++;
      continue;
    }
    if (want && !want.has(e.type)) continue;
    if (!after(e)) continue;
    events.push(e);
  }
  // Oldest first. Array sort is stable, so lines with the same time keep their file order.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { events, skipped };
}

export const readEvents = (cwd, opts = {}) => readEventsFile(eventsFile(cwd), opts);

// ["key=value", ...] -> the fields appendEvent takes. Throws on a pair with no "=".
export function parsePairs(pairs) {
  const out = { data: {} };
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`"${pair}" is not key=value.`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    const value = raw === 'null' ? null : raw;
    if (TOP_KEYS.includes(key)) out[key] = value;
    else out.data[key] = value;
  }
  return out;
}

// The rules for job-finished, the one type agents write by hand with `add`.
export function checkJobFinished(data) {
  if (!data.job || !data.run) throw new Error('job-finished needs job=<job id> and run=<run id>.');
  if (!['ok', 'failed'].includes(data.status)) throw new Error('job-finished needs status=ok or status=failed.');
  if (data.summary && data.summary.length > SUMMARY_MAX) throw new Error(`The summary is ${data.summary.length} characters; shorten it to ${SUMMARY_MAX} or fewer.`);
}

function line(e) {
  const where = [e.slice !== null && e.slice !== undefined ? `slice ${e.slice}` : null, e.role].filter(Boolean).join(', ');
  const data = Object.entries(e.data || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  return `${e.at}  ${e.type}  ${e.id}${where ? ` (${where})` : ''}${data ? `  ${data}` : ''}`;
}

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'add') {
      const [type, ...pairs] = rest;
      if (!type || type.startsWith('-')) throw Object.assign(new Error('add needs an event type.'), { usage: true });
      let fields;
      try {
        fields = parsePairs(pairs);
        if (type === 'job-finished') checkJobFinished(fields.data);
      } catch (e) {
        throw Object.assign(e, { usage: true });
      }
      const e = appendEvent(cwd, { type, ...fields }, { env: io.env || process.env });
      out(`added ${e.type} ${e.id}\n`);
      return 0;
    }
    if (cmd === 'list') {
      const o = { types: [], since: null, json: false };
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--json') o.json = true;
        else if ((a === '--type' || a === '--since') && rest[i + 1] && !rest[i + 1].startsWith('--')) {
          if (a === '--type') o.types.push(rest[++i]);
          else o.since = rest[++i];
        } else throw Object.assign(new Error(`unknown or incomplete option ${a}`), { usage: true });
      }
      const { events, skipped } = readEvents(cwd, o);
      if (o.json) out(`${JSON.stringify(events)}\n`);
      else out(events.length ? `${events.map(line).join('\n')}\n` : 'no events\n');
      if (skipped) err(`${skipped} line(s) in the log are not valid JSON and were skipped.\n`);
      return 0;
    }
    throw Object.assign(new Error(cmd ? `unknown command ${cmd}` : 'no command'), { usage: true });
  } catch (e) {
    if (e.usage) {
      err(`Wrong usage: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    err(`events: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

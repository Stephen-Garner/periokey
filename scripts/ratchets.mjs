#!/usr/bin/env node
// ratchets.mjs: counts that may only go down.
//
// What it does, in plain English:
//   A ratchet is a count of a pattern that is sometimes right, where the aim is "no more than today".
//   The saved counts live in kit.ratchets.json at the project root. This script recounts and fails
//   when a count is above its saved number. It lowers a saved number when the real count drops, and
//   never raises one: raising a ratchet is a weakening, which needs a reason and a ruling by a
//   reviewer on a different model. A raise by hand in the file would show up in git, so "check" also
//   compares the file with the base branch's copy (<remote>/<baseBranch>, from scripts/kit.config.json)
//   and refuses a saved number above the base's, or a count or counter the base has and this copy
//   dropped. A count with no saved number fails too: the kit's starting file saves every built-in
//   count at 0, so a new project starts with no room for new uses.
//   When "features.testReasons" enforces in scripts/kit.config.json (true or "enforce"), that raise is
//   not refused here: the merge script then asks for a reason line and a reviewer's ruling for it
//   (scripts/test-changes.mjs shows the line to add), so "check" prints a note instead. With it off or
//   only watching ("observe"), the raise is refused, since then nothing asks for a ruling. A real count
//   above the saved number fails either way.
//   Counted:
//     switch-offs <kind>   comments that switch a check off, one count per kind (lint, types, format,
//                          coverage, unsafe), in every tracked file a loaded preset covers, tests
//                          included, kit-managed files left out (scripts/switch-offs.mjs --count)
//     useEffect uses       "useEffect(" in product code files with a code ending ("productPaths", "notYetClean" folders
//                          included, test files left out)
//     counters             each { name, run, needs? } in the file's "counters" list: run is a shell
//                          command that prints a whole number; needs lists paths that must exist first.
//                          When one is missing, the counter is "not set up" and is skipped. The kit's
//                          template has one: "flag groups" (the kit ESLint rule kit/flag-groups).
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/ratchets.mjs check [--all]
//       Recounts and compares. Counters can be slow (ESLint over the whole project), so they run only
//       with --all; the pre-commit hook runs plain "check", the full run before a merge uses --all.
//   node scripts/ratchets.mjs update
//       Recounts everything and lowers saved numbers to the real ones. A count with no saved number
//       is saved as today's. While the base branch has no kit.ratchets.json yet, update sets every
//       count to the real one, raises included: that is the one setup step for a project that already
//       has code. Once the file is on the base branch, update only lowers.
//   node scripts/ratchets.mjs show [--json]
//       Prints the saved counts and the counters. The dashboard reads the JSON.
// Exit codes: 0 done, 1 a count is too high (or an error), 2 wrong usage.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { countAll, diskReader, isProductFile, project, trackedFiles } from './switch-offs.mjs';

export const RATCHETS_FILE = 'kit.ratchets.json';
export const USE_EFFECT = 'useEffect uses';
const USE_EFFECT_RE = /\buseEffect\s*\(/g;
const USAGE = 'Usage: node scripts/ratchets.mjs check [--all] | update | show [--json]';
const WEAKENING = 'Raising a ratchet is a weakening: it needs a reason and a ruling by a reviewer on a different model before it can merge. Put the number back.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

// Parses and checks a ratchets file's text. where names it in messages. null text means no file.
export function parseRatchets(text, where = RATCHETS_FILE) {
  if (text === null) return { counts: {}, counters: [] };
  const bad = (msg) => {
    throw new Error(`${where}: ${msg}`);
  };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    bad(`not valid JSON (${e.message})`);
  }
  if (!isObject(data)) bad('must be a JSON object');
  for (const k of Object.keys(data)) if (!['counts', 'counters'].includes(k)) bad(`unknown key "${k}" (allowed: counts, counters)`);
  const counts = data.counts ?? {};
  const counters = data.counters ?? [];
  if (!isObject(counts)) bad('"counts" must be an object of name: whole number');
  for (const [name, n] of Object.entries(counts)) if (!Number.isInteger(n) || n < 0) bad(`count "${name}" must be a whole number, 0 or more`);
  if (!Array.isArray(counters)) bad('"counters" must be a list');
  const names = new Set();
  counters.forEach((c, i) => {
    const at = `"counters" entry ${i + 1}`;
    if (!isObject(c)) bad(`${at} must be an object like { "name": "...", "run": "..." }`);
    for (const k of Object.keys(c)) if (!['name', 'run', 'needs'].includes(k)) bad(`${at} has unknown key "${k}" (allowed: name, run, needs)`);
    if (!isText(c.name) || !isText(c.run)) bad(`${at} needs a "name" and a "run" command`);
    if ('needs' in c && (!Array.isArray(c.needs) || !c.needs.every(isText))) bad(`${at}: "needs" must list paths`);
    if (c.name === USE_EFFECT || c.name.startsWith('switch-offs ') || names.has(c.name)) bad(`${at}: the name "${c.name}" is already taken`);
    names.add(c.name);
  });
  return { counts, counters };
}

// "useEffect(" uses per product file: { total, files: { path: n } }.
export function countUseEffect(files, read) {
  const out = { total: 0, files: {} };
  for (const file of files) {
    const text = read(file) ?? '';
    const n = text.includes('\0') ? 0 : text.match(USE_EFFECT_RE)?.length ?? 0;
    if (!n) continue;
    out.total += n;
    out.files[file] = n;
  }
  return out;
}

// Runs one counter's command in the project root. Returns its number; throws when it prints none.
export function runCounter(root, counter) {
  const r = spawnSync('sh', ['-c', counter.run], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
  const last = String(r.stdout ?? '').trim().split('\n').pop().trim();
  if (r.status !== 0 || !/^\d+$/.test(last)) {
    const why = r.status !== 0 ? `exited with code ${r.status}` : `printed "${last.slice(0, 60)}" instead of a whole number`;
    throw new Error(`counter "${counter.name}" ${why}. Its command: ${counter.run}`);
  }
  return Number(last);
}

// Today's counts: { counts: { name: { total, files? } }, notSetUp: [{ name, missing }] }.
export function recount(p, counters, { withCounters = true, run = runCounter } = {}) {
  const counts = {};
  for (const [kind, c] of Object.entries(countAll(p))) counts[`switch-offs ${kind}`] = c;
  const product = trackedFiles(p.root).filter((f) => isProductFile(f, p.config, p.byEnding, { includeUnclean: true }));
  counts[USE_EFFECT] = countUseEffect(product, diskReader(p.root));
  const notSetUp = [];
  if (withCounters) {
    for (const c of counters) {
      const missing = (c.needs ?? []).filter((path) => !existsSync(join(p.root, path)));
      if (missing.length) notSetUp.push({ name: c.name, missing });
      else counts[c.name] = { total: run(p.root, c) };
    }
  }
  return { counts, notSetUp };
}

// saved: { name: n }. now: { name: { total, files? } }. Sorts every counted name into one list.
export function compare(saved, now) {
  const above = [];
  const below = [];
  const unsaved = [];
  for (const [name, c] of Object.entries(now)) {
    if (!(name in saved)) unsaved.push({ name, now: c.total });
    else if (c.total > saved[name]) above.push({ name, saved: saved[name], now: c.total, files: c.files ?? {} });
    else if (c.total < saved[name]) below.push({ name, saved: saved[name], now: c.total });
  }
  return { above, below, unsaved };
}

// Saved numbers that are higher here than on the base branch, or that the base has and this copy lost.
export function raisedOverBase(saved, base) {
  const out = [];
  for (const [name, n] of Object.entries(base)) {
    if (!(name in saved)) out.push({ name, saved: null, base: n });
    else if (saved[name] > n) out.push({ name, saved: saved[name], base: n });
  }
  return out;
}

// Counters the base branch's copy runs that this copy no longer lists: [name].
export function removedCounters(counters, baseCounters) {
  const here = new Set(counters.map((c) => c.name));
  return baseCounters.map((c) => c.name).filter((name) => !here.has(name));
}

// The saved counts after an update: lowered where the real count dropped, added where none was saved.
// raise: true also raises a count to the real one (only while the base branch has no copy of the file).
export function lowered(saved, now, { raise = false } = {}) {
  const next = { ...saved };
  for (const [name, c] of Object.entries(now)) if (!(name in next) || c.total < next[name] || (raise && c.total > next[name])) next[name] = c.total;
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
function tryGit(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

// The files of one count to name: the ones changed since the base when any hold it, else all (at most 10).
export function filesToName(files, changed) {
  const holding = Object.entries(files).sort((a, b) => b[1] - a[1]);
  const mine = holding.filter(([f]) => changed.has(f));
  return (mine.length ? mine : holding).slice(0, 10).map(([f, n]) => `${f} (${n})`);
}

function save(root, data) {
  writeFileSync(join(root, RATCHETS_FILE), `${JSON.stringify(data, null, 2)}\n`);
}

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  const [cmd, ...rest] = argv;
  const allowed = { check: ['--all'], update: [], show: ['--json'] }[cmd];
  if (!allowed || rest.some((a) => !allowed.includes(a))) {
    err(`Wrong usage: ${allowed ? `unknown option ${rest.find((a) => !allowed.includes(a))}` : cmd ? `unknown command ${cmd}` : 'no command'}\n${USAGE}\n`);
    return 2;
  }
  try {
    const p = project(cwd);
    const path = join(p.root, RATCHETS_FILE);
    const file = parseRatchets(existsSync(path) ? readFileSync(path, 'utf8') : null);
    if (cmd === 'show') {
      if (rest.includes('--json')) out(`${JSON.stringify(file)}\n`);
      else {
        const rows = Object.entries(file.counts).map(([n, v]) => `${n}  ${v}`);
        out(`${rows.length ? rows.join('\n') : 'no saved counts yet'}\n${file.counters.map((c) => `counter ${c.name}: ${c.run}`).join('\n')}${file.counters.length ? '\n' : ''}`);
      }
      return 0;
    }
    const { counts, notSetUp } = recount(p, file.counters, { withCounters: cmd === 'update' || rest.includes('--all'), run: io.runCounter });
    for (const n of notSetUp) out(`${n.name}: not set up (missing ${n.missing.join(', ')}), so it was not counted.\n`);
    const { above, below, unsaved } = compare(file.counts, counts);
    const baseRef = `${p.config.remote}/${p.config.baseBranch}`;
    const baseText = tryGit(p.root, ['show', `${baseRef}:${RATCHETS_FILE}`]);
    if (cmd === 'update') {
      const setup = baseText === null;
      const next = lowered(file.counts, counts, { raise: setup });
      const changes = [
        ...below.map((b) => `${b.name}: lowered from ${b.saved} to ${b.now}`),
        ...unsaved.map((u) => `${u.name}: saved as ${u.now}`),
        ...(setup ? above.map((a) => `${a.name}: set to ${a.now} (${baseRef} has no ${RATCHETS_FILE} yet)`) : []),
      ];
      if (changes.length || !existsSync(path)) save(p.root, { counts: next, counters: file.counters });
      out(changes.length ? `${changes.join('\n')}\n` : 'Ratchets: nothing to lower; no file changed.\n');
      if (setup) return 0;
      for (const a of above) out(`${a.name} is ${a.now}, above its saved ${a.saved}. Update never raises a count: fix the code so it is back at ${a.saved} or lower.\n`);
      return above.length ? 1 : 0;
    }
    const base = baseText === null ? null : parseRatchets(baseText, `${baseRef}:${RATCHETS_FILE}`);
    const raised = base === null ? [] : raisedOverBase(file.counts, base.counts);
    const goneCounters = base === null ? [] : removedCounters(file.counters, base.counters);
    if (base === null) out(`Note: ${baseRef} has no ${RATCHETS_FILE} to compare with.\n`);
    const reasons = p.config.features?.testReasons;
    const ruled = reasons === true || reasons === 'enforce'; // only an enforcing gate asks for a ruling
    for (const name of goneCounters) {
      out(ruled
        ? `Note: counter ${name} is on ${baseRef} but removed here. That needs a reason line and a reviewer's ruling before it can merge; node scripts/test-changes.mjs shows the line to add.\n`
        : `counter ${name}: removed from ${RATCHETS_FILE}, but ${baseRef} has it. ${WEAKENING}\n`);
    }
    for (const r of raised) {
      if (ruled) {
        out(`Note: ${r.name} is ${r.saved === null ? 'removed' : `saved as ${r.saved}`} here but ${r.base} on ${baseRef}. That raise needs a reason line and a reviewer's ruling before it can merge; node scripts/test-changes.mjs shows the line to add.\n`);
        continue;
      }
      out(r.saved === null
        ? `${r.name}: removed from ${RATCHETS_FILE}, but ${baseRef} saves it as ${r.base}. ${WEAKENING}\n`
        : `${r.name}: saved as ${r.saved} here but ${r.base} on ${baseRef}. ${WEAKENING}\n`);
    }
    const changedText = above.length ? tryGit(p.root, ['diff', '--name-only', baseRef]) : null;
    const changed = new Set(String(changedText ?? '').split('\n').filter(Boolean));
    for (const a of above) {
      const files = filesToName(a.files, changed);
      out(`${a.name}: ${a.now} now, saved ${a.saved}. Remove the new one${a.now - a.saved === 1 ? '' : 's'}.${files.length ? ` In: ${files.join(', ')}` : ''}\n`);
    }
    for (const b of below) out(`${b.name}: down from ${b.saved} to ${b.now}. Run node scripts/ratchets.mjs update to save the lower number.\n`);
    for (const u of unsaved) out(`${u.name}: no saved number. Run node scripts/ratchets.mjs update once to save today's counts.\n`);
    if (above.length || unsaved.length || ((raised.length || goneCounters.length) && !ruled)) return 1;
    out(`Ratchets: every count is at or below its saved number (${Object.keys(counts).length} counted).\n`);
    return 0;
  } catch (e) {
    err(`ratchets: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

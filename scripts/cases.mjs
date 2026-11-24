#!/usr/bin/env node
// cases.mjs: builds the reviewer's case file from git history.
//
// What it does, in plain English:
//   A "fix" commit carries a line at the bottom, "Fixes: <commit id>", naming the commit that let a
//   bug through (scripts/commit-msg.mjs checks that line). The named commit is a "case": a past
//   change the reviewer should have flagged. The reviewer-score job gives the reviewer these cases
//   and some clean changes, and counts what it catches. "Fixes: unknown" names no commit, so it
//   makes no case; it is counted on its own. A "Fixes:" id that is not in this repo is counted too.
//   For each case the table shows: the short id, the date, the first line, the pull request number
//   (from "(#123)" in the first line, else from the "Merge pull request #123" merge that first
//   put the case on the main line, which is HEAD's first-parent chain; blank if neither), and the
//   fix commit or commits that named it, and the answer: the fix commit's "Bug:" line, one sentence
//   saying what the bug was ("needs an answer" when no fix has one). Cases are listed newest first.
//   The trailers are read with the functions the commit check uses (scripts/commit-msg.mjs).
//   With fewer than 10 cases it also prints one line saying the score is a hint, not a verdict.
//   The Set column splits the cases for tuning: the last character of the case's full commit id,
//   read as a hex digit, is even for "test" (the fixed test set: never tune the reviewer guides
//   against these) and odd for "tune" (tune on these). The id never changes, so a case keeps its set.
//   Controls are clean changes for the reviewer to look at beside the cases. With --controls <n> the
//   script lists n pull requests (a merge, or a commit with "(#12)" in its first line, on the main
//   line) that no "Fixes:" line points at, whose size (lines added plus lines removed) is closest
//   to the cases' sizes. The pick is made by code from the repo alone: the same repo gives the same list.
//
// How to run (Node 18 or newer), from a project or the kit:
//   node scripts/cases.mjs [--write] [--json] [--controls <n>]
//     --write  save the table in docs/review-cases.md, between the two marker lines; whatever a
//              person wrote outside them stays. A new file is made if there is none.
//     --json   print the cases as JSON instead of a table
//     --controls <n>  also list n clean controls (a whole number above 0). They are not saved by --write.
// Exit codes: 0 done, 1 git history could not be read, 2 wrong usage.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseBug, parseMessage } from './commit-msg.mjs';

const USAGE = 'Usage: node scripts/cases.mjs [--write] [--json] [--controls <n>]';
export const NEEDS_ANSWER = 'needs an answer';
export const MIN_CASES = 10;
export const CASES_FILE = 'docs/review-cases.md';
export const START = '<!-- review-cases:start (made by scripts/cases.mjs; edit outside these two lines only) -->';
export const END = '<!-- review-cases:end -->';
const FIELD = '\x1f'; // git writes these two separators for us as %x1f and %x1e
const RECORD = '\x1e';

// The fix commits and what they name. text is the output of
//   git log --format=%H%x1f%h%x1f%aI%x1f%B%x1e
// Returns [{ hash, short, date, subject, bug (the Bug: sentence or null), fixes: ["abc1234" | "unknown", ...] }]
// for commits with a Fixes trailer.
export function parseLog(text) {
  const out = [];
  for (const rec of String(text).split(RECORD)) {
    const [hash, short, date, ...rest] = rec.replace(/^\n/, '').split(FIELD);
    if (!hash) continue;
    const message = rest.join(FIELD);
    const { subject, trailers } = parseMessage(message);
    const fixes = trailers.filter((t) => t.key.toLowerCase() === 'fixes').map((t) => t.value);
    if (fixes.length) out.push({ hash, short, date: date.slice(0, 10), subject, bug: parseBug(message), fixes });
  }
  return out;
}

// The pull request number in a first line, like "fix: x (#12)", or null.
export const prInSubject = (subject) => {
  const all = [...String(subject).matchAll(/\(#(\d+)\)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
};

// The pull request number in a merge commit's first line ("Merge pull request #N from ..."), or null.
export const prInMergeSubject = (subject) => {
  const m = String(subject).match(/^Merge pull request #(\d+)/);
  return m ? Number(m[1]) : null;
};

// The pull request that put a commit on the main line (the first-parent chain of HEAD). That is the
// oldest commit on the chain that has the case in its history: its first line gives the number. A case
// committed straight onto the chain was not brought in by any merge, so it has none.
function prOfMerge(git, hash, chain) {
  if (chain.includes(hash)) return null;
  const entry = entryOf(git, hash, chain);
  return entry ? prInMergeSubject(git(['show', '-s', '--format=%s', entry]).trim()) : null;
}

// The commit on the main line (chain, newest first) that brought a commit in: the commit itself when
// it is on the chain, else the oldest chain commit that has it in its history. Null if there is none.
export function entryOf(git, hash, chain) {
  if (chain.includes(hash)) return hash;
  let below = '';
  try { below = git(['rev-list', '--ancestry-path', `${hash}..HEAD`]); } catch { /* nothing */ }
  const descendants = new Set(below.split('\n').filter(Boolean));
  return chain.slice().reverse().find((c) => descendants.has(c)) || null;
}

// "test" or "tune": the set a case belongs to, from the last character of its full commit id.
export const caseSet = (hash) => (parseInt(String(hash).slice(-1), 16) % 2 === 0 ? 'test' : 'tune');

// Everything from git: { cases, unknown, missing }. git(args) -> text. cases is newest first.
export function findCases(git) {
  let log;
  try {
    log = git(['log', `--format=%H%x1f%h%x1f%aI%x1f%B%x1e`]);
  } catch (e) {
    throw new Error(`git history could not be read: ${String(e.message).split('\n')[0]}`);
  }
  const byCase = new Map();
  let unknown = 0;
  let missing = 0;
  for (const fix of parseLog(log)) {
    for (const id of fix.fixes) {
      if (id === 'unknown') { unknown++; continue; }
      let full;
      try {
        full = git(['rev-parse', '--verify', '--quiet', `${id.toLowerCase()}^{commit}`]).trim();
      } catch {
        full = '';
      }
      if (!full) { missing++; continue; }
      if (!byCase.has(full)) byCase.set(full, []);
      const list = byCase.get(full);
      if (!list.some((f) => f.hash === fix.hash)) list.push({ hash: fix.hash, short: fix.short, subject: fix.subject, bug: fix.bug });
    }
  }
  let firstParent = null;
  const chain = () => (firstParent ??= git(['rev-list', '--first-parent', 'HEAD']).split('\n').filter(Boolean));
  const cases = [];
  for (const [hash, fixes] of byCase) {
    const [short, date, subject] = git(['show', '-s', `--format=%h%x1f%aI%x1f%s`, hash]).trim().split(FIELD);
    let pr = prInSubject(subject);
    if (pr === null) pr = prOfMerge(git, hash, chain());
    const bugs = [...new Set(fixes.map((f) => f.bug).filter(Boolean))];
    cases.push({ hash, short, date: date.slice(0, 10), subject, pr, set: caseSet(hash), answer: bugs.length ? bugs.join('; ') : null, fixes });
  }
  cases.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.hash < b.hash ? -1 : 1));
  return { cases, unknown, missing };
}

// The pull requests on the main line, newest first: [{ hash, short, date, subject, pr, size }]. size is
// lines added plus lines removed against the first parent. pr is null for a commit that is no pull request.
export function chainUnits(git) {
  const out = git(['log', '--first-parent', '--diff-merges=first-parent', '--numstat', `--format=%x1e%H%x1f%h%x1f%aI%x1f%s`, 'HEAD']);
  return out.split(RECORD).filter((r) => r.trim()).map((rec) => {
    const [head, ...stat] = rec.replace(/^\n/, '').split('\n');
    const [hash, short, date, subject] = head.split(FIELD);
    let size = 0;
    for (const line of stat) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (m) size += (Number(m[1]) || 0) + (Number(m[2]) || 0);
    }
    return { hash, short, date: date.slice(0, 10), subject, pr: prInMergeSubject(subject) ?? prInSubject(subject), size };
  });
}

// n controls from pool [{ hash, size, ... }], each as close in size as possible to a target size in
// turn (targets are cycled). Ties go to the smaller commit id, so the same input gives the same list.
export function pickControls(targets, pool, n) {
  const left = pool.slice();
  const picked = [];
  for (let i = 0; i < n && left.length && targets.length; i++) {
    const t = targets[i % targets.length];
    let best = 0;
    for (let j = 1; j < left.length; j++) {
      const dj = Math.abs(left[j].size - t);
      const db = Math.abs(left[best].size - t);
      if (dj < db || (dj === db && left[j].hash < left[best].hash)) best = j;
    }
    picked.push(left.splice(best, 1)[0]);
  }
  return picked.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.hash < b.hash ? -1 : 1));
}

// { controls, note }: up to n pull requests that no case came in with, close in size to the cases.
export function findControls(git, cases, n) {
  const units = chainUnits(git);
  const chain = units.map((u) => u.hash);
  const bySha = new Map(units.map((u) => [u.hash, u]));
  const taken = new Set();
  const targets = [];
  for (const c of cases) {
    const entry = entryOf(git, c.hash, chain);
    if (!entry) continue;
    taken.add(entry);
    targets.push(bySha.get(entry).size);
  }
  if (!targets.length) return { controls: [], note: 'There are no cases yet, so there are no sizes to match. No controls were picked.' };
  const pool = units.filter((u) => u.pr !== null && !taken.has(u.hash));
  const controls = pickControls(targets, pool, n);
  const note = controls.length < n ? `Only ${controls.length} pull request${controls.length === 1 ? '' : 's'} qualified as a control, fewer than the ${n} asked for.` : null;
  return { controls, note };
}

// The controls as a Markdown table.
export function formatControls({ controls, note }) {
  const rows = ['| Control | Date | First line | Pull request | Lines changed |', '|---|---|---|---|---|'];
  for (const c of controls) rows.push(`| \`${c.short}\` | ${c.date} | ${cell(c.subject)} | #${c.pr} | ${c.size} |`);
  if (!controls.length) rows.push('| none | | | | |');
  return `${rows.join('\n')}${note ? `\n\n${note}` : ''}\n`;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

// The Markdown table and the totals lines.
export function formatTable({ cases, unknown, missing }) {
  const rows = ['| Case | Set | Date | First line | Pull request | Named by | Answer |', '|---|---|---|---|---|---|---|'];
  for (const c of cases) {
    rows.push(`| \`${c.short}\` | ${c.set} | ${c.date} | ${cell(c.subject)} | ${c.pr === null ? '' : `#${c.pr}`} | ${c.fixes.map((f) => `\`${f.short}\` ${cell(f.subject)}`).join('; ')} | ${c.answer ? cell(c.answer) : NEEDS_ANSWER} |`);
  }
  if (!cases.length) rows.push('| none yet | | | | | | |');
  const notes = [`Cases: ${cases.length}. Fixes that said "Fixes: unknown": ${unknown}, and they make no case.`];
  if (missing) notes.push(`Fixes that named a commit this repo does not have: ${missing}, and they make no case.`);
  return `${rows.join('\n')}\n\n${notes.join('\n')}\n`;
}

export const hintLine = (n) => (n < MIN_CASES
  ? `With only ${n} case${n === 1 ? '' : 's'} (fewer than ${MIN_CASES}), the reviewer's score is a hint, not a verdict.`
  : null);

// The file text with the generated table between the two marker lines. Without markers, the block is
// added at the end; without a file (existing === null), a short heading comes first.
export function withTable(existing, table) {
  const block = `${START}\n${table.trimEnd()}\n${END}`;
  if (existing === null) return `# Review cases\n\nEach case is a past change that let a bug through, named by a "Fixes:" line in a later commit. The table is made by \`node scripts/cases.mjs --write\`; write anything else outside the two marker lines.\n\n${block}\n`;
  const a = existing.indexOf(START);
  const b = existing.indexOf(END);
  if (a >= 0 && b > a) return `${existing.slice(0, a)}${block}${existing.slice(b + END.length)}`;
  return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
}

const makeGit = (cwd) => (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });

// io: { stdout, stderr, cwd, git(args) } (all optional).
export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = resolve(io.cwd || process.cwd());
  const git = io.git || makeGit(cwd);
  let write = false;
  let json = false;
  let controls = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') write = true;
    else if (a === '--json') json = true;
    else if (a === '--controls' && /^[1-9]\d*$/.test(argv[i + 1] || '')) controls = Number(argv[++i]);
    else { err(`${USAGE}\n`); return 2; }
  }
  let found;
  try {
    found = findCases(git);
  } catch (e) {
    err(`${e.message}\n`);
    return 1;
  }
  const table = formatTable(found);
  const hint = hintLine(found.cases.length);
  let picked = null;
  if (controls !== null) {
    try {
      picked = findControls(git, found.cases, controls);
    } catch (e) {
      err(`git history could not be read: ${String(e.message).split('\n')[0]}\n`);
      return 1;
    }
  }
  if (json) out(`${JSON.stringify({ ...found, hint, ...(picked ? { controls: picked.controls, controlsNote: picked.note } : {}) }, null, 2)}\n`);
  else out(`${table}${hint ? `\n${hint}\n` : ''}${picked ? `\nControls: pull requests that no fix points at, close in size to the cases.\n\n${formatControls(picked)}` : ''}`);
  if (write) {
    const file = join(cwd, CASES_FILE);
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const after = withTable(before, table);
    if (after !== before) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, after);
    }
    (json ? err : out)(`${after === before ? 'Already up to date' : 'Wrote'}: ${CASES_FILE}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

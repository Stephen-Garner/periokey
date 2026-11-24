#!/usr/bin/env node
// checklist.mjs: which items of the project's change checklist apply to a branch.
//
// What it does, in plain English:
//   The change checklist (docs/change-checklist.md) is a table of things to check when a change
//   touches a certain part of the product. Each row came from a real mistake. This script reads the
//   table and the branch's change, and prints the rows whose trigger fits, so the reviewer rules on
//   exactly those and nobody has to remember the list.
//   The file is read only when it holds the line "Format: kit change checklist, version 1". Its table:
//     | Id | When the change touches | Check this | Why |
//     | CL-1 | `src/storage/**` and adds "version" | The saved data can still be read by the old app | The 2026 outage |
//   The trigger ("When the change touches") is one or more path patterns in backticks, with commas
//   between them, and then, if wanted: and adds "some text".
//     *            any name inside one folder       `src/*.ts` fits src/a.ts, not src/api/a.ts
//     **           any number of folders            `src/**` fits everything under src/;
//                                                   `src/**/index.ts` fits src/index.ts and src/a/b/index.ts
//     a last "/"   the whole folder                 `src/storage/` fits everything under src/storage/
//     no star      that one file exactly
//   A row fits when the branch changed, added, or deleted a file that fits one of its patterns. With
//   and adds "text", one of those files must also have a line the branch added that holds the text
//   (capital letters do not matter). A renamed file counts under its old name and its new one, and
//   every line of it counts as added under the new name. Added lines are worked out from the two
//   stored copies of a file (a line the new copy holds more often than the old one), so nothing in
//   the branch's .gitattributes or git settings can hide one.
//
// The grammar of the table, in full (scripts/check-plans.mjs accepts and refuses the same rows):
//   1. The file is read only when one line, trimmed, is exactly the format line. Text inside an HTML
//      comment is not read.
//   2. A row is a line that, trimmed, starts with "|", is not the |---|---| line, and is not the line
//      right above one (the header).
//   3. Cells: drop the first "|", and the last "|" unless a "\" stands before it; split at every "|"
//      with no "\" before it; trim each cell; then turn each "\|" into "|". There must be exactly 4.
//   4. Id: "CL-" and a whole number from 1 with no leading zero (backticks around it are fine). No
//      id twice.
//   5. Trigger: one or more code spans (a backtick, one or more characters that are not a backtick, a
//      backtick), with a comma between each two, spaces around the comma allowed. Then nothing, or:
//      one or more spaces, the words and adds, one space, and a text in straight double quotes. The
//      text holds no double quote and at least one character that is not a space. Nothing else may
//      follow or come before.
//   6. Each path pattern, trimmed, is not empty and does not start with "/" or "./".
//   7. The "Check this" cell and the "Why" cell are not empty.
//   8. A row that breaks any of 3 to 7 is a problem, with its line number, and is not an item.
//   The change is what the branch did since it left the base branch, in commits. Work that is not
//   committed yet is not read.
//   A branch cannot drop a row for its own merge: the rows come from the base branch's copy of the file
//   as it is right now, joined with the branch's copy. A row in either copy applies, and where both
//   hold the same id the base branch's row wins.
//   A row that breaks the table shape is listed with its line and what to fix, and does not apply
//   until it is fixed. The rule checker reports the same problems.
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/checklist.mjs [<branch>] [--base <ref>] [--all]
//       Prints one "kit-checklist <id> <check this>" line for each row that fits the branch's change.
//       <branch> is the current one when left out. The base is <remote>/<baseBranch> from
//       scripts/kit.config.json, else the local <baseBranch>, unless --base names another.
//       --all lists every row with its trigger, whether it fits or not.
// Exit codes: 0 done (also when there is no checklist), 1 an error or a row that breaks the table
// shape, 2 wrong usage.
//
// This file imports only Node's own modules, so the rule checker can load it without a loop of imports.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHECKLIST_FILE = 'docs/change-checklist.md';
// The line that says the file is in the table shape above. Without it the file is left alone.
export const CHECKLIST_MARKER = 'Format: kit change checklist, version 1';
const ID = /^CL-[1-9]\d*$/;
const TRIGGER = /^(`[^`]+`(?:\s*,\s*`[^`]+`)*)(?:\s+and adds "([^"]*[^"\s][^"]*)")?$/;
const TRIGGER_HELP = 'write one or more path patterns in backticks with commas between them, and then, if wanted: and adds "some text". Example: `src/storage/**` and adds "version"';
const USAGE = 'Usage: node scripts/checklist.mjs [<branch>] [--base <ref>] [--all]';

const usage = (msg) => Object.assign(new Error(msg), { usage: true });

// ---------- The table ----------

// Reads the checklist: { marker, items: [{ id, paths, adds, check, why, line, when }], problems }.
//   paths: the path patterns. adds: the text an added line must hold, or null. check, why: the
//   "Check this" and "Why" cells. line: the row's line number. when: the trigger as written.
// marker is false, with no items and no problems, when the format line is missing: an older file in
// another shape is left alone. A row with a problem is not in items. Text inside an HTML comment is
// not read, and line numbers stay true.
export function parseChecklist(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, '')).split('\n');
  const items = [];
  const problems = [];
  if (!lines.some((l) => l.trim() === CHECKLIST_MARKER)) return { marker: false, items, problems };
  const isSeparator = (l) => /^\|[\s:|-]*-[\s:|-]*$/.test(l.trim());
  const seen = new Set();
  lines.forEach((raw, i) => {
    const line = raw.trim();
    // The header row is the one right above the |---|---| line.
    if (!line.startsWith('|') || isSeparator(line) || isSeparator(lines[i + 1] ?? '')) return;
    const at = `${CHECKLIST_FILE}:${i + 1}`;
    // A "|" inside a cell is written "\|".
    const cells = line.replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cells.length !== 4) {
      problems.push(`${at}: a row needs 4 cells (id, when the change touches, check this, why); this one has ${cells.length}. Write a "|" inside a cell as "\\|"`);
      return;
    }
    const [id, when, check, why] = [cells[0].replace(/^`(.*)`$/, '$1'), cells[1], cells[2], cells[3]];
    const found = [];
    if (!ID.test(id)) found.push(`the id "${id}" must look like CL-1`);
    else if (seen.has(id)) found.push(`${id} is used twice; give each row its own id, and never reuse one`);
    const trigger = when.match(TRIGGER);
    const paths = trigger ? [...trigger[1].matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()) : [];
    const name = ID.test(id) ? id : 'this row';
    if (!trigger) found.push(`the "When the change touches" cell of ${name} cannot be read: ${TRIGGER_HELP}`);
    for (const p of paths) {
      if (!p) found.push(`${name} has an empty path pattern; write a path between the backticks`);
      else if (p.startsWith('/') || p.startsWith('./')) found.push(`the path pattern ${p} of ${name} must start at the top folder of the project, with no "/" or "./" in front, like src/storage/`);
    }
    if (!check) found.push(`the "Check this" cell of ${name} is empty; say what the reviewer must check`);
    if (!why) found.push(`the "Why" cell of ${name} is empty; name the mistake, pull request, or outage behind the row`);
    if (ID.test(id)) seen.add(id);
    if (found.length) problems.push(...found.map((f) => `${at}: ${f}`));
    else items.push({ id, paths, adds: trigger[2] ?? null, check, why, line: i + 1, when });
  });
  return { marker: true, items, problems };
}

// ---------- Matching ----------

// Whether a file's path fits one pattern (the header says what * and ** and a last "/" mean).
export function pathMatches(pattern, file) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (pattern.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (pattern[i] === '*') re += '[^/]*';
    else re += pattern[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}${pattern.endsWith('/') ? '.*' : ''}$`, 's').test(file);
}

// The items whose trigger fits a change.
//   files: every path the change touched. addedLines: { path: [the lines the change added there] }.
export function matchItems(items, { files = [], addedLines = {} } = {}) {
  return items.filter((item) => {
    const touched = files.filter((f) => item.paths.some((p) => pathMatches(p, f)));
    if (item.adds === null) return touched.length > 0;
    const want = item.adds.toLowerCase();
    // Object.hasOwn: a file may be named "constructor" or "toString", which every plain object answers to.
    return touched.some((f) => Object.hasOwn(addedLines, f) && addedLines[f].some((l) => l.toLowerCase().includes(want)));
  });
}

// The lines the new copy of a file holds more often than the old copy did. A line that only moved
// is not added; the same line written one more time is.
export function addedBetween(oldLines, newLines) {
  const left = new Map();
  for (const l of oldLines) left.set(l, (left.get(l) ?? 0) + 1);
  return newLines.filter((l) => {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    return n === 0;
  });
}

// ---------- Reading a branch (git) ----------

const gitIn = (root) => (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// The base branch when nobody named it: the shared copy first, then the local one. The two names
// come from the settings file, read here as plain JSON (the rule checker is the one that checks it).
function defaultBase(root, exists) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(join(root, 'scripts/kit.config.json'), 'utf8'));
  } catch {
    // No settings file, or one that cannot be read: the usual names are used.
  }
  const remote = typeof cfg?.remote === 'string' && cfg.remote ? cfg.remote : 'origin';
  const branch = typeof cfg?.baseBranch === 'string' && cfg.baseBranch ? cfg.baseBranch : 'main';
  const tried = [`${remote}/${branch}`, branch];
  const found = tried.find(exists);
  if (!found) throw new Error(`cannot find the base branch here (tried ${tried.join(' and ')}). Fetch first, or name it with --base, like --base origin/main.`);
  return found;
}

// The checklist for one branch: { present, items, matched, problems, base }.
//   root: the project's folder. base: the base ref (found from the settings when left out).
//   branch: the branch to read (the current one when left out).
//   present: false when neither the base branch nor the branch holds a checklist with its format line.
//   items: every row that applies, the base branch's first. matched: the rows that fit the change.
//   problems: rows that break the table shape, in the copy that would land (the branch's own, else
//   the base branch's).
// Throws, with a plain message, when git cannot find the branch, the base, or where they parted.
export function checklistFor(root, { base, branch = 'HEAD' } = {}) {
  const git = gitIn(root);
  const exists = (ref) => git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).code === 0;
  if (!exists(branch)) throw new Error(`git has no branch or commit named ${branch} here. Check the name, and fetch first if it is on the shared copy.`);
  if (base && !exists(base)) throw new Error(`git has no branch or commit named ${base} here. Fetch first, and write the base in full, like origin/main.`);
  base = base || defaultBase(root, exists);
  const copy = (ref) => {
    const shown = git(['show', `${ref}:${CHECKLIST_FILE}`]);
    return parseChecklist(shown.code === 0 ? shown.stdout : '');
  };
  const onBase = copy(base);
  const onBranch = copy(branch);
  const baseIds = new Set(onBase.items.map((i) => i.id));
  const items = [...onBase.items, ...onBranch.items.filter((i) => !baseIds.has(i.id))];
  const present = onBase.marker || onBranch.marker;
  const problems = onBranch.marker ? onBranch.problems : onBase.problems;
  if (!items.length) return { present, items, matched: [], problems, base };

  const fork = git(['merge-base', base, branch]);
  if (fork.code !== 0) throw new Error(`cannot find where ${branch} left ${base}: ${(fork.stderr || 'the two share no commit').trim()}`);
  const from = fork.stdout.trim();
  const names = git(['diff', '--name-only', '-z', '--no-renames', from, branch]);
  if (names.code !== 0) throw new Error(`cannot list the files ${branch} changed: ${names.stderr.trim()}`);
  const files = names.stdout.split('\0').filter(Boolean);
  // Added lines are read only for the files a row with and adds "..." points at. They are worked out
  // here from the two stored copies of the file, not taken from git's own comparison: a branch can
  // change what that prints (a .gitattributes line that calls the file binary, a diff setting).
  const linesAt = (ref, file) => {
    const blob = git(['cat-file', 'blob', `${ref}:${file}`]);
    return blob.code === 0 ? blob.stdout.split(/\r?\n/) : [];
  };
  // An object with no prototype: only the paths put in it are in it, even one named "__proto__".
  const addedLines = Object.create(null);
  for (const item of items.filter((i) => i.adds !== null)) {
    for (const file of files) {
      if (file in addedLines ||!item.paths.some((p) => pathMatches(p, file))) continue;
      addedLines[file] = addedBetween(linesAt(from, file), linesAt(branch, file));
    }
  }
  return { present, items, matched: matchItems(items, { files, addedLines }), problems, base };
}

// ---------- The command line ----------

function parseArgs(argv) {
  const o = { branch: undefined, base: undefined, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--base') {
      o.base = argv[++i];
      if (!o.base || o.base.startsWith('-')) throw usage('--base needs a ref, like origin/main.');
    } else if (a.startsWith('-')) throw usage(`unknown option ${a}`);
    else if (o.branch !== undefined) throw usage(`unexpected ${a}: name one branch at most.`);
    else o.branch = a;
  }
  return o;
}

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  try {
    const o = parseArgs(argv);
    const top = gitIn(cwd)(['rev-parse', '--show-toplevel']);
    if (top.code !== 0) throw new Error(`${resolve(cwd)} is not inside a git working tree, so there is no change to read here.`);
    const found = checklistFor(top.stdout.trim(), { base: o.base, branch: o.branch });
    if (!found.present) {
      out(`No change checklist here: ${CHECKLIST_FILE} is missing, or it lacks the line "${CHECKLIST_MARKER}". Nothing to check.\n`);
      return 0;
    }
    if (o.all) out(found.items.length ? found.items.map((i) => `${i.id}  when: ${i.when}  check: ${i.check}\n`).join('') : 'The change checklist has no rows yet.\n');
    else if (found.matched.length) out(found.matched.map((i) => `kit-checklist ${i.id} ${i.check}\n`).join(''));
    else out(`No row of the change checklist fits this change (compared with ${found.base}).\n`);
    if (found.problems.length) {
      err(`${found.problems.join('\n')}\nFix ${found.problems.length === 1 ? 'this row' : 'these rows'} in ${CHECKLIST_FILE} (only the head agent edits that file). A row with a problem does not apply until it is fixed.\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e.usage) {
      err(`Wrong usage: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    err(`checklist: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

#!/usr/bin/env node
// commit-msg.mjs: checks the message of a commit before git saves it.
//
// What it does, in plain English:
//   Git hands this script the file that holds the commit message. The script checks three things.
//   1. The first line looks like "type: description" or "type(scope): description". The type is one
//      of: feat, fix, docs, test, refactor, perf, chore, build, ci, style, revert. The description is
//      not empty and the line is at most 100 characters. The dashboard counts commits by this type.
//   2. A "Slice: 007" line. On a build branch (build/007-short-name; the prefix is the buildPrefix
//      setting) the script ADDS "Slice: 007" to the message itself when it is missing, in the block of
//      lines at the bottom, after a blank line. A Slice line you wrote must be a whole number and
//      must match the branch.
//   3. A "fix" commit needs "Fixes: <commit id>" at the bottom: the id (7 to 40 letters and digits)
//      of the commit that caused the bug, which must exist in this repo, or the word "unknown" when
//      nobody can name the cause. A script counts rework from this line.
//   4. A "Verified:" line says what was done to try the change: "Verified: ran, tests, checks" (any of
//      the three words, separated by commas) or "Verified: none" or "Verified: none (the reason)".
//      ran = the app was run and the change tried; tests = the test files for the change were run;
//      checks = format, lint, and types. A note in round brackets may follow any value. When the
//      line is missing, the script adds "Verified: none". A line that does not fit is refused.
//   5. A "Bug:" line is optional on a "fix" commit: one sentence, 15 to 200 characters, saying what
//      the bug was. It is the answer key for the reviewer's report card (scripts/cases.mjs).
//   Lines that start with # are git's own notes and are ignored. Merge commits, git's own reverts
//   (Revert "..."), and fixup!, squash!, and amend! commits pass untouched.
//   The Slice line is written as three digits, like the plan ids (Slice: 007).
//   Lines the script adds go at the end of the trailer block, always in this order: Slice, then
//   Verified. Lines you wrote stay where they are.
//   One exception: when the last paragraph mixes prose with trailer lines, those trailer lines move
//   into the new block (a blank line before it), so the lines other scripts read stay in the last paragraph.
//
// How to run (the hook .githooks/commit-msg does this for you):
//   node scripts/commit-msg.mjs <message-file>
// Exit codes: 0 fine (the file may have gained a Slice or Verified line), 1 refused (it says what is wrong and
// shows one correct message), 2 wrong usage.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './check-plans.mjs';

export const TYPES = Object.freeze(['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'chore', 'build', 'ci', 'style', 'revert']);
export const SUBJECT_MAX = 100;
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([^()\\s][^()]*\\))?!?: (\\S.*)$`);
const TRAILER = /^([A-Za-z][A-Za-z0-9-]*): (\S.*)$/;
const SKIPPED = /^(Merge |Revert "|(fixup|squash|amend)! )/;
// The keys the kit reads, written loosely (no space after the colon, or nothing after it).
const LOOSE_TRAILER = /^(slice|verified|bug|fixes):/i;
const SCISSORS = /^# -+ >8 -+$/;
const COMMIT_ID = /^[0-9a-f]{7,40}$/i;
const KINDS = Object.freeze(['ran', 'tests', 'checks']);
const KIND = KINDS.join('|');
const VERIFIED = new RegExp(`^(none|(?:${KIND})(?:\\s*,\\s*(?:${KIND}))*)\\s*(?:\\((.*)\\))?$`);
export const BUG_MIN = 15;
export const BUG_MAX = 200;
const USAGE = 'Usage: node scripts/commit-msg.mjs <message-file>';

const EXAMPLE = 'feat: add the save button';
const FIX_EXAMPLE = 'fix(login): stop the crash on an empty password\n\nFixes: unknown';

// The lines git will keep: no # lines, nothing after the "cut here" line that `git commit -v` adds.
export function contentLines(text) {
  const kept = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (SCISSORS.test(line)) break;
    if (!line.startsWith('#')) kept.push(line);
  }
  return kept;
}

// The paragraphs of the kept lines, as lists of lines. Blank lines separate them.
function paragraphs(lines) {
  const out = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) out.push(current);
  return out;
}

// { subject, trailers: [{key, value}], block, last } for a message. The trailers come from the last
// paragraph when it is not the first one. block is true when that paragraph is nothing but trailers.
// last is that paragraph's lines (empty when the message has one paragraph).
export function parseMessage(text) {
  const paras = paragraphs(contentLines(text));
  const subject = paras.length ? paras[0][0].trim() : '';
  const last = paras.length > 1 ? paras[paras.length - 1] : [];
  const trailers = [];
  for (const line of last) {
    const m = line.match(TRAILER);
    if (m) trailers.push({ key: m[1], value: m[2].trim() });
  }
  const block = last.length > 0 && last.every((l) => TRAILER.test(l) || /^\s/.test(l));
  return { subject, trailers, block, last };
}

// The text after "Key:" on every line of the last paragraph that starts with that key (any case).
// This also sees a line with nothing after the colon, which the trailer reader skips.
function valuesOf(last, key) {
  const found = [];
  for (const line of last) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (m && m[1].toLowerCase() === key) found.push(m[2].trim());
  }
  return found;
}

// What a Verified value says: { kinds, none, note } or null when it does not fit the grammar.
function readVerified(value) {
  const m = value.match(VERIFIED);
  if (!m) return null;
  const note = m[2] === undefined ? null : m[2].trim();
  if (note === '') return null;
  return m[1] === 'none'
    ? { kinds: [], none: true, note }
    : { kinds: [...new Set(m[1].split(',').map((k) => k.trim()))], none: false, note };
}

// The Verified line of a commit message: { kinds: [...], none: true|false, note: string|null }, or
// null when there is no such line or it does not fit the grammar.
export function parseVerified(message) {
  const values = valuesOf(parseMessage(message).last, 'verified');
  return values.length ? readVerified(values[0]) : null;
}

// The sentence on the Bug line of a commit message, or null when there is none or it is not
// 15 to 200 characters long.
export function parseBug(message) {
  const [value] = valuesOf(parseMessage(message).last, 'bug');
  return value !== undefined && value.length >= BUG_MIN && value.length <= BUG_MAX ? value : null;
}

export const isSkipped = (subject) => SKIPPED.test(subject);

// The three-digit slice number of a build branch ("build/007-x" -> "007"), else null.
export function branchSlice(branch, buildPrefix) {
  if (!branch || !branch.startsWith(buildPrefix)) return null;
  const m = branch.slice(buildPrefix.length).match(/^(\d{3})(?:-|$)/);
  return m ? m[1] : null;
}

// Checks a message. ctx: { slice: the branch's number or null, commitExists(id) -> true or false }.
// Returns { skipped, problems: [text], addSlice: "007" or null, addVerified: true or false, example }.
export function checkMessage(text, ctx) {
  const { subject, trailers, last } = parseMessage(text);
  const result = { skipped: false, problems: [], addSlice: null, addVerified: false, example: EXAMPLE };
  if (isSkipped(subject)) return { ...result, skipped: true };
  const problems = result.problems;

  const m = subject.match(SUBJECT);
  if (!subject) {
    problems.push('The message is empty.');
  } else if (!m) {
    problems.push(`The first line must look like "type: description" or "type(scope): description". The type is a one-word label for the kind of change, and it must be one of: ${TYPES.join(', ')}. Yours is: "${subject}"`);
  } else if (subject.length > SUBJECT_MAX) {
    problems.push(`The first line is ${subject.length} characters long. The most is ${SUBJECT_MAX}. Keep it short and put the detail on the lines below it.`);
  }

  const slices = trailers.filter((t) => t.key.toLowerCase() === 'slice');
  for (const t of slices) {
    if (!/^\d+$/.test(t.value)) {
      problems.push(`"Slice: ${t.value}" is not a whole number. Write the slice number, like "Slice: 007".`);
    } else if (ctx.slice !== null && Number(t.value) !== Number(ctx.slice)) {
      problems.push(`This branch is for slice ${ctx.slice}, but the message says "Slice: ${t.value}". Fix the number, or delete that line and this check adds the right one.`);
    }
  }
  if (ctx.slice !== null && slices.length === 0) result.addSlice = ctx.slice;

  const fixes = trailers.filter((t) => t.key.toLowerCase() === 'fixes');
  if (m && m[1] === 'fix' && fixes.length === 0) {
    problems.push('A "fix" commit needs a "Fixes:" line at the bottom, after a blank line. '
      + 'Write "Fixes: <id>" with the id of the commit that caused the bug (7 to 40 letters and digits; find it with "git log"), '
      + 'or write "Fixes: unknown" when nobody can name the cause. A script counts how often work has to be redone from this line.');
  }
  for (const t of fixes) {
    if (t.value === 'unknown') continue;
    if (!COMMIT_ID.test(t.value)) {
      problems.push(`"Fixes: ${t.value}" is not a commit id. Use the id of the commit that caused the bug (7 to 40 letters and digits), or the word "unknown" when nobody can name the cause.`);
    } else if (!ctx.commitExists(t.value)) {
      problems.push(`"Fixes: ${t.value}" names a commit that is not in this repo. Check the id with "git log", or write "Fixes: unknown" when nobody can name the cause.`);
    }
  }
  const verified = valuesOf(last, 'verified');
  if (verified.length > 1) {
    problems.push('The message has more than one "Verified:" line. Keep one.');
  } else if (verified.length === 1 && !readVerified(verified[0])) {
    problems.push(`"Verified: ${verified[0]}" does not fit. Write "Verified:" and then either "none" (a reason in round brackets is welcome) or a list of these words, separated by commas: ran (the app was run and the change tried), tests (the test files for the change were run), checks (format, lint, and types). A note in round brackets may follow. Two examples:\n    Verified: ran, tests (tried the save button on the simulator)\n    Verified: none (docs only, nothing to run)`);
  } else if (verified.length === 0) {
    result.addVerified = true;
  }

  const bugs = valuesOf(last, 'bug');
  if (bugs.length > 1) {
    problems.push('The message has more than one "Bug:" line. Keep one.');
  } else if (bugs.length === 1 && (bugs[0].length < BUG_MIN || bugs[0].length > BUG_MAX)) {
    problems.push(`The "Bug:" line must be one sentence of ${BUG_MIN} to ${BUG_MAX} characters saying what the bug was. Yours is ${bugs[0].length} characters. Example: "Bug: saving a word with an accent in it crashed the app".`);
  }
  if (problems.some((p) => p.includes('Fixes')) || (m && m[1] === 'fix')) result.example = FIX_EXAMPLE;
  return result;
}

// The file text with trailer lines (like "Slice: 007") added, in the order given, after the last line
// git will keep. They join the block of trailer lines at the bottom when there is one. When the last
// paragraph has prose in it as well, the new lines start a block after a blank line, and every line of
// that paragraph that looks like a trailer (Verified:, Fixes:, Bug:, Co-Authored-By:, ...) moves into
// the new block with the indented lines right after it (git folds those into the trailer), in its old
// order and before the new lines. Without that move the new block would
// become the last paragraph, and the lines the other scripts read (Verified, Fixes, Bug, Slice) would
// no longer be in it.
export function addTrailerLines(text, lines) {
  const raw = String(text).replace(/\r\n/g, '\n').split('\n');
  const kept = []; // indexes of the lines git keeps
  for (let i = 0; i < raw.length; i++) {
    if (SCISSORS.test(raw[i])) break;
    if (!raw[i].startsWith('#')) kept.push(i);
  }
  const parsed = parseMessage(text);
  const nonBlank = kept.filter((i) => raw[i].trim() !== '');
  if (parsed.block || parsed.last.length === 0) {
    raw.splice((nonBlank.length ? nonBlank[nonBlank.length - 1] : -1) + 1, 0, ...(parsed.block ? lines : ['', ...lines]));
    return raw.join('\n');
  }
  const first = nonBlank[nonBlank.length - parsed.last.length]; // where the last paragraph starts
  const moved = [];
  let following = false; // true right after a trailer line: indented lines then belong to it
  for (const i of nonBlank.filter((n) => n >= first)) {
    const isTrailer = TRAILER.test(raw[i]) || LOOSE_TRAILER.test(raw[i]);
    const continues = following && /^\s/.test(raw[i]);
    if (isTrailer || continues) moved.push(i);
    following = isTrailer || continues;
  }
  const stays = nonBlank.filter((i) => i >= first && !moved.includes(i));
  const movedLines = moved.map((i) => raw[i]);
  for (const i of [...moved].reverse()) raw.splice(i, 1);
  if (stays.length) {
    const last = stays[stays.length - 1] - moved.filter((i) => i < stays[stays.length - 1]).length;
    raw.splice(last + 1, 0, '', ...movedLines, ...lines);
  } else {
    raw.splice(first, 0, ...movedLines, ...lines); // the paragraph was only trailers: it stays one block
  }
  return raw.join('\n');
}

export const addSliceLine = (text, slice) => addTrailerLines(text, [`Slice: ${slice}`]);

const makeGit = (cwd) => (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// io: { stdout, stderr, cwd, git(args) } (all optional).
export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  const git = io.git || makeGit(cwd);
  if (argv.length !== 1) {
    err(`${USAGE}\n`);
    return 2;
  }
  const file = resolve(cwd, argv[0]);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    err(`Cannot read the message file ${file}: ${e.message}\n${USAGE}\n`);
    return 2;
  }

  let config;
  try {
    config = loadConfig(cwd);
  } catch (e) {
    err(`The commit message check could not read the settings: ${e.message}\n`);
    return 1;
  }
  let branch = null;
  try {
    branch = git(['symbolic-ref', '--short', '-q', 'HEAD']).trim() || null;
  } catch {
    // detached head: not a build branch
  }
  const commitExists = (id) => {
    try {
      git(['cat-file', '-e', `${id.toLowerCase()}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };

  const result = checkMessage(text, { slice: branchSlice(branch, config.buildPrefix), commitExists });
  if (result.problems.length) {
    err(`Commit message refused:\n${result.problems.map((p) => `- ${p}`).join('\n')}\n\nA correct message looks like this:\n\n${result.example.replace(/^/gm, '  ')}\n`);
    return 1;
  }
  const added = [];
  if (result.addSlice !== null) added.push(`Slice: ${result.addSlice}`);
  if (result.addVerified) added.push('Verified: none');
  if (added.length) {
    writeFileSync(file, addTrailerLines(text, added));
    out(`Added to the commit message: ${added.map((l) => `"${l}"`).join(', ')}.\n`);
    if (result.addVerified) out('There was no "Verified:" line. If you did run the app or the tests, say so: run "git commit --amend" and change the line to something like "Verified: ran, tests, checks".\n');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

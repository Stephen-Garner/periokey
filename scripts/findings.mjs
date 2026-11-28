#!/usr/bin/env node
// findings.mjs: what happened to each thing a reviewer found, and which ones still need an answer.
//
// What it does, in plain English:
//   A finding is one problem a reviewer names in a review. Every review of a branch is a "round":
//   the first review is round 1, the review of the fixes is round 2, and so on. After each round the
//   head agent makes a review receipt (scripts/receipt.mjs) and commits it on the branch. The receipt
//   holds "counts": how many findings the reviewer listed, as { important, nit, preExisting }.
//   The counts are read from each receipt as made again from the reviewer's session record, so a
//   receipt edited by hand cannot lower what is owed. A receipt whose record cannot be read is listed
//   as unchecked; the merge gate stops on it.
//   The builder answers every finding with one line in docs/findings/<branch name with "/" as "-">.md,
//   the same file name the branch has under docs/weakenings/:
//     - R1.2 Important: fixed: Added the check in save.ts and a test that fails without it.
//   The line is "- R<round>.<number>", the label the reviewer gave the finding (Important, Nit, or
//   Pre-existing; capital letters do not matter), then the outcome, then a note of 10 to 300
//   characters. The number is the finding's number in the reviewer's list for that round. The outcomes:
//     fixed          the code was changed
//     wrong          the reviewer was mistaken
//     intended       the code is that way on purpose
//     not worth it   true, but fixing it costs more than it gives
//     later          logged for later (the usual answer to a Pre-existing finding)
//   This script reads the receipts the branch added under docs/receipts/, oldest first by their "at"
//   time: receipt 1 is round 1, receipt 2 is round 2. A round with 3 findings needs answers
//   R<round>.1, R<round>.2, and R<round>.3. A receipt with no counts (one made before counts existed)
//   owes nothing. Everything is read from git, from the branch's commits: an answer that is not
//   committed yet does not count. A line the base branch already holds in the same file is not an
//   answer for this branch, so a branch name used twice cannot reuse its old answers.
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/findings.mjs [<branch>]
//       Prints each round with its answers, and the exact line to add for each answer still owed.
//       <branch> is the current one when left out. The base is <remote>/<baseBranch> from
//       scripts/kit.config.json, else the local <baseBranch>.
// Exit codes: 0 every finding has an answer, 1 an answer is owed, a line cannot be read, or an error,
// 2 wrong usage.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { baseCandidates, loadConfig } from './check-plans.mjs';
import { RECEIPT_DIR, branchSlice, buildReceipt, receiptMatches, roundKey } from './receipt.mjs';
import { REASON_DIR, reasonFile } from './test-changes.mjs';

export const FINDINGS_DIR = 'docs/findings/';
export const OUTCOMES = Object.freeze(['fixed', 'wrong', 'intended', 'not worth it', 'later']);
export const NOTE_MIN = 10;
export const NOTE_MAX = 300;
// The label a reviewer gives a finding, in the spelling an answer is returned with.
export const LABELS = Object.freeze(['Important', 'Nit', 'Pre-existing']);
const COUNT_KEYS = ['important', 'nit', 'preExisting'];
const ANSWER = /^[-*]\s+R(\d+)\.(\d+)\s+([^:]*?)\s*:\s*([^:]*?)\s*:\s*(.*)$/i;
const SHAPE = '"- R<round>.<number> <label>: <outcome>: <note>", like "- R1.2 Important: fixed: Added the check and a test for it."';
const USAGE = 'Usage: node scripts/findings.mjs [<branch>]';

const usage = (msg) => Object.assign(new Error(msg), { usage: true });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Where a branch's answers go: docs/findings/ and the same file name the branch has under docs/weakenings/.
export const findingsFile = (branch) => `${FINDINGS_DIR}${reasonFile(branch).slice(REASON_DIR.length)}`;

// The exact line a builder adds for one finding, with the three parts still to write.
export const answerLine = (round, n) => `- R${round}.${n} <${LABELS.join(' | ')}>: <${OUTCOMES.join(' | ')}>: <what you did, or why not, in one plain sentence>`;

// How many findings one round's counts add up to. No counts, or a count that is not a whole number, is 0.
export const totalOf = (counts) => COUNT_KEYS.reduce((sum, k) => sum + (Number.isInteger(counts?.[k]) && counts[k] > 0 ? counts[k] : 0), 0);

// Reads the answer lines of a findings file: { answers: [{ round, n, label, outcome, note, line }], problems }.
// label is one of LABELS, in that spelling, however the line wrote its capital letters.
// Only list lines that start with "R" and a digit are read; headings and other text are left alone.
// A line with a problem is not an answer. problems: plain lines, each starting "line <number>: ".
export function parseFindings(text) {
  const answers = [];
  const problems = [];
  const seen = new Set();
  String(text ?? '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!/^[-*]\s+R\d/i.test(line)) return;
    const bad = (msg) => problems.push(`line ${i + 1}: ${msg}`);
    const m = line.match(ANSWER);
    if (!m) return bad(`this answer cannot be read. Write it as ${SHAPE}`);
    const [round, n, outcome, note] = [Number(m[1]), Number(m[2]), m[4].toLowerCase(), m[5].trim()];
    const name = `R${round}.${n}`;
    const label = LABELS.find((l) => l.toLowerCase() === m[3].toLowerCase());
    if (round < 1 || n < 1) return bad(`${name}: rounds and findings are numbered from 1`);
    if (!m[3]) return bad(`${name}: the label is missing. Write the line as ${SHAPE}`);
    if (m[3].startsWith('<') || note.startsWith('<')) return bad(`${name}: the line still holds the placeholder text; write the real words in its place`);
    if (!label) return bad(`${name}: the label "${m[3]}" is not one of: ${LABELS.join(', ')}. Copy the label the reviewer gave this finding`);
    if (!OUTCOMES.includes(outcome)) return bad(`${name}: the outcome "${m[4]}" is not one of: ${OUTCOMES.join(', ')}`);
    if (note.length < NOTE_MIN) return bad(`${name}: the note is ${note.length} characters; write one full sentence (${NOTE_MIN} characters or more)`);
    if (note.length > NOTE_MAX) return bad(`${name}: the note is ${note.length} characters; shorten it to ${NOTE_MAX} or fewer`);
    if (seen.has(name)) return bad(`${name} is answered twice; keep one line for it`);
    seen.add(name);
    answers.push({ round, n, label, outcome, note, line: i + 1 });
  });
  return { answers, problems };
}

// The answers still owed: [{ round, missing: [finding numbers] }], only for rounds that owe one.
//   rounds: the counts of each round, round 1 first: [{ important, nit, preExisting } or null].
//   answers: from parseFindings. A round with a total of 3 needs answers numbered 1, 2, and 3.
export function owed(rounds, answers) {
  const out = [];
  (rounds || []).forEach((counts, i) => {
    const have = new Set((answers || []).filter((a) => a.round === i + 1).map((a) => a.n));
    const missing = [];
    for (let n = 1; n <= totalOf(counts); n++) if (!have.has(n)) missing.push(n);
    if (missing.length) out.push({ round: i + 1, missing });
  });
  return out;
}

// ---------- Reading a branch (git) ----------

const gitIn = (root) => (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// The findings of one branch: { file, rounds, answers, problems, owed, notes, unchecked }.
//   root: the project's folder. base: the base ref (found from the settings when left out).
//   branch: the ref to read (the current branch when left out). name: the branch's name, for the
//   file name; needed only when branch is not the plain name (a commit id, or origin/<name>).
//   file: the branch's findings file. rounds: [{ round, receipt, counts }], one per receipt the
//   branch added, oldest first; counts is null when the receipt holds none.
//   answers, problems: from parseFindings. owed: [{ round, missing }], from owed().
//   The counts are not taken on trust from the committed receipt: each receipt is made again from its
//   session record (readFile(path) -> text reads it), and the record's counts are used. So a receipt
//   edited by hand cannot lower what is owed.
//   notes: plain lines about receipts that do not match their record, or whose record cannot be read.
//   unchecked: the receipts whose record cannot be read. Their own counts are shown, but nobody can
//   vouch for them: the merge gate stops on these.
// Throws, with a plain message, when git cannot find the branch, the base, or where they parted, or
// when a receipt cannot be read.
export function findingsFor(root, { base, branch = 'HEAD', name, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const git = gitIn(root);
  const exists = (ref) => git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).code === 0;
  if (!exists(branch)) throw new Error(`git has no branch or commit named ${branch} here. Check the name, and fetch first if it is on the shared copy.`);
  if (base && !exists(base)) throw new Error(`git has no branch or commit named ${base} here. Fetch first, and write the base in full, like origin/main.`);
  if (!base) {
    const tried = baseCandidates(loadConfig(root));
    base = tried.find(exists);
    if (!base) throw new Error(`cannot find the base branch here (tried ${tried.join(' and ')}). Fetch first.`);
  }
  if (!name && branch === 'HEAD') {
    const head = git(['symbolic-ref', '--short', '-q', 'HEAD']);
    if (head.code !== 0) throw new Error('no branch is checked out here, so the findings file cannot be named. Name the branch: node scripts/findings.mjs <branch>');
    name = head.stdout.trim();
  }
  const file = findingsFile(name || branch);
  const fork = git(['merge-base', base, branch]);
  if (fork.code !== 0) throw new Error(`cannot find where ${branch} left ${base}: ${(fork.stderr || 'the two share no commit').trim()}`);
  const textAt = (ref, path) => {
    const shown = git(['show', `${ref}:${path}`]);
    return shown.code === 0 ? shown.stdout : null;
  };

  // The receipts the branch added, oldest first: receipt k is round k.
  const added = git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', fork.stdout.trim(), branch, '--', RECEIPT_DIR]);
  if (added.code !== 0) throw new Error(`cannot list the receipts ${branch} added: ${added.stderr.trim()}`);
  const expectedSlice = branchSlice(name || branch);
  const notes = [];
  const unchecked = [];
  const rawReceipts = added.stdout.split('\0').filter((p) => p.endsWith('.json')).map((path) => {
    try {
      const written = JSON.parse(textAt(branch, path));
      let receipt = written;
      let checked = true;
      try {
        if (typeof written.session !== 'string' || !written.session) throw new Error('it names no session record');
        receipt = buildReceipt(readFile(written.session), written.session);
        if (!receiptMatches(receipt, written, expectedSlice)) notes.push(`${path} does not match its session record, so its counts are taken from the record. Make it again: node scripts/receipt.mjs make ${written.session}`);
      } catch (e) {
        checked = false;
        unchecked.push(path);
        notes.push(`${path}: its session record cannot be read again (${e.message}), so its counts cannot be checked`);
      }
      const at = Date.parse(receipt.at);
      const counts = receipt.counts && typeof receipt.counts === 'object' ? Object.fromEntries(COUNT_KEYS.map((k) => [k, totalOf({ [k]: receipt.counts[k] })])) : null;
      const key = typeof receipt.task === 'string' && receipt.task && typeof receipt.at === 'string' && receipt.at ? roundKey(receipt) : null;
      return { path, at: Number.isNaN(at) ? Infinity : at, counts, key, checked };
    } catch (e) {
      throw new Error(`the review receipt ${path} cannot be read (${e.message}). Make it again with node scripts/receipt.mjs make <session-file>.`);
    }
  });
  // Deduplicate receipts that share the same review identity (task + at + model), keeping the newest path.
  const keyCounts = new Map();
  for (const r of rawReceipts) if (r.key) keyCounts.set(r.key, (keyCounts.get(r.key) || 0) + 1);
  const hasDuplicates = [...keyCounts.values()].some((n) => n > 1);
  let receipts = rawReceipts;
  if (hasDuplicates) {
    const recency = new Map();
    const log = git(['log', '--name-only', '--format=format:COMMIT', `${fork.stdout.trim()}..${branch}`, '--', RECEIPT_DIR]);
    if (log.code === 0) {
      let rank = 0;
      for (const rawLine of log.stdout.split('\n')) {
        if (rawLine === 'COMMIT') { rank += 1; continue; }
        const p = rawLine.trim();
        if (p.endsWith('.json') && !recency.has(p)) recency.set(p, rank);
      }
    }
    const isNewer = (cand, cur) => {
      if (cand.checked !== cur.checked) return cand.checked;
      const rCand = recency.get(cand.path) ?? Infinity;
      const rCur = recency.get(cur.path) ?? Infinity;
      if (rCand !== rCur) return rCand < rCur;
      return cand.path > cur.path;
    };
    const byKey = new Map();
    const unkeyed = [];
    for (const r of rawReceipts) {
      if (!r.key) { unkeyed.push(r); continue; }
      const prev = byKey.get(r.key);
      if (!prev || isNewer(r, prev)) byKey.set(r.key, r);
    }
    receipts = [...byKey.values(), ...unkeyed];
  }
  receipts.sort((a, b) => (a.at === b.at ? (a.path < b.path ? -1 : 1) : a.at - b.at));
  const rounds = receipts.map((r, i) => ({ round: i + 1, receipt: r.path, counts: r.counts }));

  // The answers: the branch's findings file, less any line the base branch already holds in it.
  const old = new Set((textAt(base, file) ?? '').split('\n').map((l) => l.trim()).filter(Boolean));
  const mine = (textAt(branch, file) ?? '').split('\n').map((l) => (old.has(l.trim()) ? '' : l)).join('\n');
  const { answers, problems } = parseFindings(mine);
  return { file, rounds, answers, problems, owed: owed(rounds.map((r) => r.counts), answers), notes, unchecked };
}

// The list as printed for a person: each round with its answers, then the lines still to add.
export function describe({ file, rounds, answers, owed: open, unchecked = [] }) {
  const lines = [];
  if (!rounds.length) lines.push('No review receipt has been added on this branch yet, so no answer is owed.');
  const last = Math.max(rounds.length, ...answers.map((a) => a.round));
  for (let round = 1; round <= last; round++) {
    const r = rounds[round - 1];
    if (!r) lines.push(`Round ${round}: no review receipt on this branch yet`);
    else if (!r.counts) lines.push(`Round ${round} (${r.receipt}): this receipt holds no counts, so it owes no answers`);
    else lines.push(`Round ${round} (${r.receipt}): ${r.counts.important} important, ${r.counts.nit} nit, ${r.counts.preExisting} pre-existing`);
    const missing = open.find((o) => o.round === round)?.missing ?? [];
    const rows = [
      ...answers.filter((a) => a.round === round).map((a) => [a.n, `  R${round}.${a.n} ${a.label}: ${a.outcome}: ${a.note}`]),
      ...missing.map((n) => [n, `  R${round}.${n} no answer yet`]),
    ];
    lines.push(...rows.sort((a, b) => a[0] - b[0]).map((row) => row[1]));
  }
  const count = open.reduce((sum, o) => sum + o.missing.length, 0);
  if (count) {
    lines.push(`${plural(count, 'answer')} still owed. Add one line for each to ${file} (make the file if it is not there), then commit it:`);
    for (const o of open) lines.push(...o.missing.map((n) => `  ${answerLine(o.round, n)}`));
  } else if (unchecked.length) lines.push(`Not known whether every finding has an answer: ${plural(unchecked.length, 'receipt')} cannot be checked (see below).`);
  else if (rounds.length) lines.push('Every finding has an answer.');
  return lines.join('\n');
}

// ---------- The command line ----------

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  try {
    const flag = argv.find((a) => a.startsWith('-'));
    if (flag !== undefined) throw usage(`unknown option ${flag}`);
    if (argv.length > 1) throw usage(`unexpected ${argv[1]}: name one branch at most.`);
    const top = gitIn(cwd)(['rev-parse', '--show-toplevel']);
    if (top.code !== 0) throw new Error(`${resolve(cwd)} is not inside a git working tree, so there are no findings to read here.`);
    const found = findingsFor(top.stdout.trim(), { branch: argv[0] });
    out(`${describe(found)}\n`);
    if (found.problems.length) err(`${found.problems.map((p) => `${found.file} ${p}`).join('\n')}\nA line with a problem does not count as an answer. Fix it, then commit the file.\n`);
    if (found.notes.length) err(`${found.notes.join('\n')}\n`);
    if (found.unchecked.length) err('A receipt that cannot be checked could have had its count edited down, so the merge gate stops on it. Either put the session record back at the path the receipt names (its "session" line), or make the receipt again from where the record is now (node scripts/receipt.mjs make <reviewer session file>) and delete the old receipt file in the same commit.\n');
    return found.owed.length || found.problems.length || found.unchecked.length ? 1 : 0;
  } catch (e) {
    if (e.usage) {
      err(`Wrong usage: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    err(`findings: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

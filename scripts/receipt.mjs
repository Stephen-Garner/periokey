#!/usr/bin/env node
// receipt.mjs: proof that a review happened, made by code from the reviewer's own session record.
//
// What it does, in plain English:
//   A review receipt is a small JSON file that says: this reviewer model, on this task, read these
//   commits and gave this verdict. It is built from the reviewer's session record (the JSONL file
//   Claude Code or Codex writes for every thread), never from anything an agent types to the lead.
//
//   Each commit is named by its fingerprint: `git patch-id --verbatim` of its change. The
//   fingerprint stays the same when a commit is moved without edits (a rebase), and changes when
//   even one space changes. A merge commit is fingerprinted by what was done by hand: the
//   difference between git's own automatic merge and the committed result (`git show
//   --remerge-diff`). A merge git did by itself has no such difference and needs no receipt.
//
//   1. The reviewer runs `node scripts/receipt.mjs fingerprints [<branch>]`. It prints one
//      "kit-fingerprint <fingerprint> <commit>" line per code commit and hand-resolved merge after
//      the base branch, and the protected tests to rule on. With features.testReasons on it also
//      prints one "kit-weakening <id> <kind> <file>" line per weakening (a change that makes a
//      guard weaker, sorted by scripts/test-changes.mjs), with what was spotted and the builder's
//      reason. With features.changeChecklist on it prints one "kit-checklist <id> <check this>"
//      line per row of the change checklist that fits the change (scripts/checklist.mjs). With
//      features.reviewLevels or features.securityReview on it prints one "kit-level <level> <why>"
//      line: how deep this review must go (scripts/review-level.mjs). The session record keeps
//      that output.
//   2. The reviewer ends with the reply shape in docs/agents/reviewer.md: a VERDICT line, a TASK
//      line, and one ruling line per listed file, by name: "- <file>: allowed" or
//      "- <file>: refused". The older words "still guards" and "weakened" mean the same two things.
//      The newer lines of that shape, each read only when it is there:
//        COUNT: <n> important, <n> nit, <n> pre-existing    how many findings this round has
//        LEVEL: <level>                                      copied from the kit-level line
//        SECURITY: clear | open                              at level deep: how the security pass ended
//        - CL-3: ok | does not apply, <why> | finding <n>    one per kit-checklist line, under the
//                                                            CHECKLIST heading; the reason is needed
//      A COUNT, LEVEL, SECURITY, or checklist line that is there but does not fit its form stops
//      `make` with the right form, so a typing slip never turns into "nothing to answer".
//   3. The head agent runs `node scripts/receipt.mjs make <session file>` after every review round,
//      whichever the verdict. It reads the record and writes docs/receipts/<task>-<8 hex>.json. The
//      head agent commits and pushes it on the branch. A "changes needed" receipt lets no merge
//      through; it is that round on record, and scripts/findings.mjs reads its counts to know how
//      many findings the builder must answer.
//      Receipts are paperwork: a commit that only adds receipts never needs a receipt itself.
//   4. With features.reviewReceipts on, scripts/merge-pr.mjs calls checkReceipts. Every code commit
//      and every hand-resolved merge between the base and the tip must match an approving receipt
//      whose model is neither models.builder nor any models.headAgent (scripts/kit.config.json,
//      compared by model id), and that rules on each protected test that commit touched.
//   5. With features.testReasons on, scripts/merge-pr.mjs calls checkWeakenings. Each weakening
//      must be ruled "allowed", by name, in a receipt whose reviewer saw that weakening's id (so
//      the same kind, file, reason, and file contents) and whose model is neither the builder's nor a head
//      agent's. The newest such ruling wins. A ruling of "refused", a ruling by the builder's own
//      model, or no ruling stops the merge.
//   6. With features.changeChecklist, reviewLevels, or securityReview on, scripts/merge-pr.mjs calls
//      approvals: the commits that need a review, and the receipts that count for them (approving,
//      still true to their record, by a model that is neither the builder's nor a head agent's).
//      It then looks in those receipts for the checklist answers, the level, and the security line.
//   Both gates take the models from the base branch's settings together with the branch's own, and
//   the fingerprints command reads the settings of the branch it is given and of the base branch
//   from git, the same way, so a reviewer sees the same list from any folder.
//
// What a receipt holds, and where each part comes from in the record:
//   model         the model field the record wrote with the verdict reply (Claude: the reply's
//                 message.model; Codex: the newest turn_context model). Never from reply text.
//   verdict, task the newest reply with a "VERDICT: approve" or "VERDICT: changes needed" line,
//                 and its "TASK: <id>" line.
//   fingerprints  the newest output of a tool call whose command ran "receipt.mjs fingerprints",
//                 recorded before that verdict reply. Tool output, never the reviewer's own words.
//   protectedTests the "- <file>: allowed | refused" lines of that reply (also "still guards" and
//                 "weakened"): the rulings on protected tests and on weakenings alike.
//   weakenings    the ids on the "kit-weakening" lines of that same fingerprints output. Left out of
//                 the receipt when there are none, so receipts made before this field still match.
//   counts        { important, nit, preExisting }: the three numbers on that reply's COUNT line.
//   level         "quick", "standard", or "deep": the first word after "LEVEL:" in that reply.
//   security      "clear" or "open": that reply's SECURITY line.
//   checklist     [{ id, answer }], sorted by id: that reply's "- CL-<n>: ..." lines. answer is "ok",
//                 "does not apply", or "finding".
//                 Each of these four is left out when the reply has no such line, never written
//                 empty, for the same reason: a receipt from before they existed still matches.
//   session, at   the record's path, and the time of the verdict reply.
//   At merge time the gate reads the record again and rebuilds the receipt. A receipt that no
//   longer matches (edited by hand, or the record changed) is not counted.
//
// What it cannot stop (it stops a false claim of a review, not a forger):
//   - A forged or edited session record. Any agent with shell access can write one.
//   - A reviewer that approves without reading the code. The record proves it saw the
//     fingerprints, not that it read or understood the change.
//   - Fingerprint or weakening lines faked inside a real fingerprints call, e.g. "receipt.mjs
//     fingerprints; echo kit-fingerprint ...".
//   - A reviewer that rules "allowed" without reading the test. The record proves it was shown the
//     weakening and named the file, not that the ruling is right.
//   - A reviewer that writes a level, "SECURITY: clear", or a checklist "ok" without doing that work.
//     The merge script works out the level a change needs by itself; the rest is the reviewer's word.
//   - The same model under another id or tool name (a dated id, an alias, a proxy). Models are
//     compared by exact id.
//   - A wrong TASK line. The task is what the reviewer wrote; the gate does not check it.
//   - A record deleted after the merge. Old receipts are only checked when a new merge needs them.
//   On a team, the real fix is a review from a separate GitHub account, which GitHub enforces.
//
// How to run (Node 18 or newer, git 2.36 or newer for --remerge-diff):
//   node scripts/receipt.mjs fingerprints [<branch>]   default HEAD; base is <remote>/<baseBranch>
//   node scripts/receipt.mjs make <session-file>
//       Every completed review (including "changes needed" rounds) counts toward maxReviewRounds
//       (default 10 in scripts/kit.config.json, warning at round 7; REV-6). Refuses past the cap
//       unless the slice is listed in extraReviewRoundSlices on the base branch.
// Exit codes: 0 done, 1 the record makes no receipt (or git failed, or the checklist or the level
// could not be read while its switch is on "enforce"; on "observe" that is one note and the lines
// are left out), 2 wrong usage.
//
// No outside libraries.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { modelOf } from './check-plans.mjs';

export const RECEIPT_DIR = 'docs/receipts/';
export const DEFAULT_MAX_REVIEW_ROUNDS = 10;
export const BLOAT_COMMIT_WARNING = 10;
const EXIT = { ok: 0, failed: 1, usage: 2 };
const USAGE = 'Usage:\n  node scripts/receipt.mjs fingerprints [<branch>]   reviewer: list what this review covers and must rule on\n  node scripts/receipt.mjs make <session-file>       head agent: write the receipt from the reviewer\'s record';
const FINGERPRINT = /kit-fingerprint ([0-9a-f]{40,64}) ([0-9a-f]{40,64})/g;
const FINGERPRINT_CALL = /receipt\.mjs\s+fingerprints\b/;
const VERDICT = /^\s*VERDICT:\s*(approve|changes needed)\s*$/im;
const TASK = /^\s*TASK:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*$/m;
const WEAKENING = /kit-weakening ([0-9a-f]{12})\b/g;
const RULING = /^\s*-\s+`?([^`\s][^`]*?)`?:\s+(still guards|weakened|allowed|refused)\b/gim;
// The newer lines of the reply. Each is optional: a reply without one makes a receipt without that field.
// COUNT, LEVEL, and SECURITY are read from the top of the reply only: the lines before its first section
// heading. A line there that starts with one of the three words and does not fit its form makes no
// receipt: left out quietly, a COUNT would read as "no findings to answer".
const HEAD_LINES = [
  ['counts', /^\s*COUNT\s*:/i, /^\s*COUNT:\s*(\d+)\s+important,\s*(\d+)\s+nits?,\s*(\d+)\s+pre-existing\s*$/i, 'Write it as "COUNT: 2 important, 1 nit, 0 pre-existing", with nothing after it'],
  ['level', /^\s*LEVEL\s*:/i, /^\s*LEVEL:\s*(?:kit-level\s+)?(quick|standard|deep)\b/i, 'Write it as "LEVEL: quick", "LEVEL: standard", or "LEVEL: deep"'],
  ['security', /^\s*SECURITY\s*:/i, /^\s*SECURITY:\s*(clear|open)\s*$/i, 'Write it as "SECURITY: clear" or "SECURITY: open", with nothing after it'],
];
// A section heading of the reply, like FINDINGS or QUESTIONS FOR THE LEAD: capital letters and spaces
// only, six characters or more. Marks around it ("## CHECKLIST", "**CHECKLIST**", "CHECKLIST:") are dropped.
const heading = (line) => {
  const bare = line.trim().replace(/^[#*\s]+|[*:\s]+$/g, '');
  return /^[A-Z][A-Z ]{4,}[A-Z]$/.test(bare) ? bare : null;
};
const CHECKLIST_LINE = /^\s*[-*]\s+`?(CL-[1-9]\d*)`?\s*:\s*(.*)$/i;

// The newer parts of a verdict reply: { counts?, level?, security?, checklist? }, each only when the reply
// has it. The checklist answers are read from the CHECKLIST section alone (from that heading to the next
// one), so a line quoted in a finding is never an answer, and a reply from before the section existed
// gives nothing. "does not apply" needs its reason. Throws a plain error for a line that cannot be read.
function newerLines(body) {
  const lines = String(body).split('\n');
  const first = lines.findIndex((l) => heading(l));
  const head = first === -1 ? lines : lines.slice(0, first);
  const out = {};
  for (const [key, starts, form, help] of HEAD_LINES) {
    const line = head.find((l) => starts.test(l));
    if (line === undefined) continue;
    const m = line.match(form);
    if (!m) throw new Error(`the verdict reply's ${key === 'counts' ? 'COUNT' : key.toUpperCase()} line cannot be read: "${line.trim()}". ${help}`);
    out[key] = key === 'counts' ? { important: Number(m[1]), nit: Number(m[2]), preExisting: Number(m[3]) } : m[1].toLowerCase();
  }
  const at = lines.map((l) => heading(l)).lastIndexOf('CHECKLIST');
  if (at === -1) return out;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => heading(l));
  const answers = new Map();
  for (const line of end === -1 ? rest : rest.slice(0, end)) {
    const m = line.match(CHECKLIST_LINE);
    if (!m) continue;
    const said = m[2].trim();
    const reason = said.replace(/^does not apply/i, '').replace(/^[\s,:;.()-]+/, '');
    let answer = null;
    if (/^ok\b/i.test(said)) answer = 'ok';
    else if (/^finding\s+#?\d+/i.test(said)) answer = 'finding';
    else if (/^does not apply\b/i.test(said) && reason.length >= 3) answer = 'does not apply';
    if (!answer) throw new Error(`the CHECKLIST line for ${m[1].toUpperCase()} cannot be read: "${line.trim()}". Write "- ${m[1].toUpperCase()}: ok", "- ${m[1].toUpperCase()}: does not apply, <why>" (the reason is needed), or "- ${m[1].toUpperCase()}: finding <n>"`);
    answers.set(m[1].toUpperCase(), answer);
  }
  const checklist = [...answers].sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3))).map(([id, answer]) => ({ id, answer }));
  if (checklist.length) out.checklist = checklist;
  return out;
}
// The two rulings, whichever pair of words the reviewer used.
const ALLOWS = ['allowed', 'still guards'];
// The receipt fields that are left out when the record has nothing for them, in the order they are written.
export const OPTIONAL_FIELDS = Object.freeze(['weakenings', 'counts', 'level', 'security', 'checklist']);
const SET_MODELS = 'set "models.builder" and "models.headAgent" in scripts/kit.config.json, so receipts can be checked against them';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const splitZ = (text) => String(text).split('\0').filter(Boolean);
const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

// ---------- Reading a session record ----------

// Record text (JSONL) -> { tool, task, verdict, model, at, fingerprints, protectedTests }, plus
// weakenings (a sorted list of ids) when the fingerprints output listed any, plus what the verdict
// reply's newer lines say, each only when the reply has that line:
//   counts     { important, nit, preExisting }   from "COUNT: 2 important, 1 nit, 0 pre-existing"
//   level      "quick" | "standard" | "deep"     from "LEVEL: deep" (words after the level are ignored)
//   security   "clear" | "open"                  from "SECURITY: clear"
//   checklist  [{ id, answer }], by id; answer is "ok", "does not apply", or "finding"
//              from "- CL-3: ok", "- CL-3: does not apply, <why>", "- CL-3: finding 2". The last line for an id wins.
// The first three are read from the top of the reply (before its first section heading), the answers
// from its CHECKLIST section only. One of these lines that is there but cannot be read makes no receipt.
// Throws with a plain reason when the record makes no receipt.
export function parseSession(text) {
  const calls = new Map(); // tool call id -> true when it ran "receipt.mjs fingerprints"
  const texts = new Map(); // Claude message id -> its text so far (one reply can span lines)
  let tool = null;
  let model = null; // Codex: the model in effect now
  let seen = null; // the newest fingerprints output so far
  let verdict = null;
  const onCall = (id, input) => { if (id) calls.set(id, FINGERPRINT_CALL.test(asText(input))); };
  const onOutput = (id, output) => {
    if (!calls.get(id)) return;
    seen = { fingerprints: [...asText(output).matchAll(FINGERPRINT)].map((m) => ({ fingerprint: m[1], commit: m[2] })), weakenings: [...new Set([...asText(output).matchAll(WEAKENING)].map((m) => m[1]))].sort() };
  };
  const onReply = (body, replyModel, at) => {
    if (VERDICT.test(body)) verdict = { body, model: replyModel, at: at ?? null, seen };
  };
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; } // a torn last line while the tool writes
    const p = j.payload;
    if (p && typeof p === 'object') {
      tool = tool ?? 'codex';
      if (j.type === 'turn_context' && p.model) model = p.model;
      else if (j.type === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings?.model) model = p.thread_settings.model;
      else if (j.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) onCall(p.call_id, p.arguments ?? p.input);
      else if (j.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) onOutput(p.call_id, p.output);
      else if (j.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
        onReply((Array.isArray(p.content) ? p.content : []).map((c) => c?.text ?? '').join('\n'), model, j.timestamp);
      } else if (j.type === 'event_msg' && p.type === 'agent_message') onReply(String(p.message ?? ''), model, j.timestamp);
      continue;
    }
    const m = j.message;
    if (!m || !Array.isArray(m.content)) continue;
    if (j.type === 'assistant' && m.model !== '<synthetic>') {
      tool = tool ?? 'claude';
      const id = m.id ?? j.uuid;
      for (const c of m.content) {
        if (c?.type === 'tool_use') onCall(c.id, c.input);
        else if (c?.type === 'text') {
          texts.set(id, `${texts.has(id) ? `${texts.get(id)}\n` : ''}${c.text ?? ''}`);
          onReply(texts.get(id), m.model, j.timestamp);
        }
      }
    } else if (j.type === 'user') {
      for (const c of m.content) if (c?.type === 'tool_result') onOutput(c.tool_use_id, c.content);
    }
  }
  if (!verdict) throw new Error('the record has no "VERDICT: approve" or "VERDICT: changes needed" line in any reply of the reviewer');
  if (!verdict.seen) throw new Error('the reviewer did not run "node scripts/receipt.mjs fingerprints" before its verdict');
  if (!verdict.model) throw new Error('the record does not say which model wrote the verdict');
  const task = verdict.body.match(TASK)?.[1];
  if (!task) throw new Error('the verdict reply has no "TASK: <id>" line');
  const rulings = new Map();
  for (const r of verdict.body.matchAll(RULING)) rulings.set(r[1], r[2].toLowerCase());
  const newer = newerLines(verdict.body);
  return {
    tool,
    task,
    verdict: verdict.body.match(VERDICT)[1].toLowerCase(),
    model: verdict.model,
    at: verdict.at,
    fingerprints: verdict.seen.fingerprints,
    protectedTests: [...rulings].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([file, ruling]) => ({ file, ruling })),
    ...(verdict.seen.weakenings.length ? { weakenings: verdict.seen.weakenings } : {}),
    ...newer,
  };
}

// The receipt for one record, with its keys in a fixed order (so a rebuilt one compares equal).
// A field the record has nothing for (weakenings and the four after it) is left out, never written
// empty, so a receipt made before the field existed still equals the one rebuilt from its record.
export function buildReceipt(text, sessionPath) {
  const s = parseSession(text);
  const receipt = { task: s.task, verdict: s.verdict, model: s.model, tool: s.tool, at: s.at, session: sessionPath, fingerprints: s.fingerprints, protectedTests: s.protectedTests };
  for (const key of OPTIONAL_FIELDS) if (s[key] !== undefined) receipt[key] = s[key];
  return receipt;
}

// docs/receipts/<task>-<first 8 hex of the receipt's own hash>.json: the same record, the same name.
export function receiptPath(receipt) {
  return `${RECEIPT_DIR}${receipt.task}-${sha256(JSON.stringify(receipt)).slice(0, 8)}.json`;
}

// ---------- Fingerprints (git) ----------
// git(args, input) returns { code, stdout, stderr }; input, when given, goes to git's stdin.

const SHOW = ['--format=', '--no-color', '--no-ext-diff', '--no-textconv', '--binary'];

function patchId(diff, git) {
  if (!diff.trim()) return '';
  return git(['patch-id', '--verbatim'], diff).stdout.trim().split(/\s+/)[0] || '';
}

// The commits after baseRef that a receipt must cover: each code commit (one touching a file that
// is not paperwork or a receipt), and each merge whose result differs from git's own merge.
// isPaperwork(file) -> bool. protectedTests(nameStatusZ) -> [{ file }], the change's protected tests.
// Protection is walked commit by commit, oldest first, never read from the final difference. A
// commit's protected paths are the test files of the base commits it grew from (the boundary: the
// base, and any base commit merged in before it), so a file the branch itself added is free until
// a merge brings in a base commit that holds it too. A commit that edits, deletes, or renames away
// a protected path needs a ruling on that path, and a rename passes protection to the new name. A
// path stays protected after it is deleted, so bringing it back is an edit too. A merge is read by
// what was done by hand (--remerge-diff), the same change its fingerprint covers: the base side's
// own changes were reviewed when they merged to the base. Inside a merge git compares the result
// with a file full of conflict marks, so it often misses a rename; when a hand-resolved merge
// deletes a protected path, every test file it adds takes over the protection.
// Returns { list: [{ sha, kind, subject, fingerprint, protected: [file], files: [file], why? }] } or { fail }.
// files: every path the commit touched (for a merge: by hand), so a gate can tell which commit a rule is about.
export function neededCommits({ baseRef, tip = 'HEAD', git, isPaperwork, protectedTests }) {
  const log = git(['log', '--reverse', '--topo-order', '--format=%H%x1f%P%x1f%s', `${baseRef}..${tip}`]);
  if (log.code !== 0) return { fail: `cannot list the commits after ${baseRef}: ${log.stderr.trim()}` };
  const edges = git(['rev-list', '--boundary', `${baseRef}..${tip}`]);
  if (edges.code !== 0) return { fail: `cannot list the commits the branch grew from: ${edges.stderr.trim()}` };
  const isTest = (f) => protectedTests(`M\0${f}\0`).length > 0;
  const baseTests = new Map(); // boundary commit -> its test files
  for (const edge of edges.stdout.split('\n').filter((l) => l.startsWith('-'))) {
    const files = git(['ls-tree', '-r', '-z', '--name-only', edge.slice(1)]);
    if (files.code !== 0) return { fail: `cannot list the files of ${edge.slice(1, 8)}: ${files.stderr.trim()}` };
    baseTests.set(edge.slice(1), new Set(protectedTests(splitZ(files.stdout).map((f) => `M\0${f}\0`).join('')).map((t) => t.file)));
  }
  const grewFrom = new Map(); // commit after the base -> the boundary commits in its history
  const carried = new Set(); // names that took protection over from a protected path
  const list = [];
  for (const row of log.stdout.split('\n').filter(Boolean)) {
    const [sha, parents, subject] = row.split('\x1f');
    const from = new Set();
    for (const p of parents.split(' ').filter(Boolean)) for (const b of baseTests.has(p) ? [p] : grewFrom.get(p) ?? []) from.add(b);
    grewFrom.set(sha, from);
    const guarded = { has: (f) => carried.has(f) || [...from].some((b) => baseTests.get(b).has(f)) };
    const count = parents.split(' ').filter(Boolean).length;
    if (count > 2) {
      list.push({ sha, kind: 'merge', subject, fingerprint: '', protected: [], why: 'a merge of more than two branches has no fingerprint; merge one branch at a time' });
      continue;
    }
    const merge = count === 2;
    const diff = git(['show', ...(merge ? ['--remerge-diff'] : []), ...SHOW, sha]);
    const names = merge
      ? git(['show', '--remerge-diff', '--format=', '--name-status', '-z', '-M', sha])
      : git(['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--name-status', sha]);
    if (diff.code !== 0 || names.code !== 0) return { fail: `cannot read commit ${sha.slice(0, 7)}: ${(diff.stderr || names.stderr).trim()}` };
    const parts = splitZ(names.stdout);
    const files = [];
    const moved = []; // [old name, new name] renames in this commit
    const added = [];
    let lost = false; // this commit deletes a protected path
    for (let i = 0; i < parts.length;) { // status, path, and for a rename or copy a second path
      const kind = parts[i].charAt(0);
      const old = parts[i + 1];
      const to = kind === 'R' || kind === 'C' ? parts[i + 2] : undefined;
      i += to === undefined ? 2 : 3;
      files.push(old, ...(to === undefined ? [] : [to]));
      if (kind === 'R') moved.push([old, to]);
      if (kind === 'A') added.push(old);
      if (kind === 'D' && guarded.has(old)) lost = true;
    }
    const touched = [...new Set(files.filter((f) => guarded.has(f)))].sort();
    for (const [old, to] of moved) if (guarded.has(old)) carried.add(to); // a protected test under a new name
    if (merge && lost) for (const f of added) if (isTest(f)) carried.add(f); // a rename git could not see
    if (files.every((f) => isPaperwork(f) || f.startsWith(RECEIPT_DIR))) continue; // includes git's own merges
    list.push({ sha, kind: merge ? 'merge' : 'commit', subject, fingerprint: patchId(diff.stdout, git), protected: touched, files: [...new Set(files)] });
  }
  return { list };
}

// What the reviewer's fingerprints command prints. The receipt reads the kit-fingerprint and
// kit-weakening lines back out of the session record.
// weakenings: the items from scripts/test-changes.mjs (collect), or undefined when testReasons is off.
// more.checklist: the rows of the change checklist that fit the change ([{ id, check }], from
// scripts/checklist.mjs), or undefined when changeChecklist is off. One "kit-checklist <id> <check this>"
// line each, for the reviewer to answer in the CHECKLIST part of its reply.
// more.level: { level, why } from scripts/review-level.mjs, or undefined when reviewLevels and
// securityReview are both off. One "kit-level <level> <why>" line, for the reviewer's LEVEL line.
// Text the builder wrote (a commit subject, a file name, a reason) is printed with the marker
// words broken up, so it can never add a kit- line of its own.
export function formatFingerprints(list, weakenings, more = {}) {
  const plain = (text) => String(text).replace(/kit-(fingerprint|weakening|checklist|level)/gi, 'kit $1');
  const lines = [list.length ? `Commits this review covers (${list.length}):` : 'No code commits after the base branch: nothing for a receipt to cover.'];
  for (const c of list) {
    lines.push(c.fingerprint ? `kit-fingerprint ${c.fingerprint} ${c.sha} ${c.kind.padEnd(8)}${plain(c.subject)}` : `cannot  ${c.sha} ${plain(c.subject)}: ${c.why}`);
  }
  const tests = [...new Set(list.flatMap((c) => c.protected))].sort();
  lines.push(tests.length ? `Protected tests to rule on by name (${tests.length}):` : 'Protected tests to rule on by name: none.');
  for (const t of tests) lines.push(`- ${plain(t)}`);
  if (weakenings) {
    lines.push(weakenings.length
      ? `Weakenings to rule on by name (${weakenings.length}): for each, write "- <file>: allowed" or "- <file>: refused", and why.`
      : 'Weakenings to rule on by name: none.');
  }
  for (const w of weakenings ?? []) {
    if (w.id) lines.push(`kit-weakening ${w.id} ${w.kind} ${plain(w.file)}`, `    spotted: ${plain(w.what)}`, `    builder's reason: ${plain(w.reason)}`);
    else lines.push(`not ready: ${plain(w.file)} (${w.kind}) has no reason from the builder yet (${plain(w.problem)}). A ruling made now will not count: stop and tell the head agent.`);
  }
  if (more.checklist) {
    lines.push(more.checklist.length
      ? `Change checklist rows to answer (${more.checklist.length}): under CHECKLIST in your reply, write "- <id>: ok", "- <id>: does not apply, <why>", or "- <id>: finding <n>" for each.`
      : 'Change checklist rows to answer: none.');
    for (const item of more.checklist) lines.push(`kit-checklist ${item.id} ${plain(item.check)}`);
  }
  if (more.level) {
    lines.push(`Review level: copy the level into your reply as "LEVEL: ${more.level.level}".${more.level.level === 'deep' ? ' A deep review ends with "SECURITY: clear" or "SECURITY: open".' : ''}`);
    lines.push(`kit-level ${more.level.level} ${plain(more.level.why)}`);
  }
  return lines.join('\n');
}

// ---------- The merge gate ----------

// The model ids whose receipts never count: the builder's and every head agent's. models is the
// settings' "models", or a list of them: the merge script hands in the branch's own and the base
// branch's, and a builder or head agent named in either is banned, so a branch cannot rename the
// builder and then have the old builder's model approve it. null when no version names both a
// builder and a head agent, so the gate fails loud instead of trusting everyone.
function bannedModels(models) {
  const banned = new Set();
  let named = false;
  for (const m of [models].flat()) {
    const builder = modelOf(m?.builder ?? '');
    const heads = (m?.headAgent ?? []).map(modelOf).filter(Boolean);
    if (builder && heads.length) named = true;
    for (const id of [builder, ...heads]) if (id) banned.add(id);
  }
  return named ? banned : null;
}

// Every receipt file at the tip that `about` picks and that still matches its session record, read
// again right now: { list: [{ path, receipt }] } or { fail }. Why one was left out goes into notes.
function trueReceipts({ tip, git, readFile, notes, about }) {
  const listed = git(['ls-tree', '-r', '-z', '--name-only', tip, '--', RECEIPT_DIR]);
  if (listed.code !== 0) return { fail: `cannot list ${RECEIPT_DIR}: ${listed.stderr.trim()}` };
  const list = [];
  for (const path of splitZ(listed.stdout).filter((p) => p.endsWith('.json'))) {
    let r;
    try { r = JSON.parse(git(['show', `${tip}:${path}`]).stdout); } catch { notes.push(`${path}: not readable JSON; not counted`); continue; }
    if (!about(r)) continue; // about other commits or other weakenings
    let fresh;
    try { fresh = buildReceipt(readFile(r.session), r.session); } catch (e) {
      notes.push(`${path}: its session record ${r.session} cannot be read again (${e.message}); not counted`);
      continue;
    }
    if (JSON.stringify(fresh) !== JSON.stringify(r)) {
      notes.push(`${path}: does not match its session record; not counted. Make it again: node scripts/receipt.mjs make ${r.session}`);
      continue;
    }
    list.push({ path, receipt: r });
  }
  return { list };
}

// The reviews that count for the commits after baseRef. models: the settings' models. readFile(path) ->
// text, for reading each record again.
// Returns { needed, usable, notes } or { fail, notes }. needed: the commits a receipt must cover
// (neededCommits). usable: the receipts that hold the fingerprint of at least one of them, still match
// their session record, approve, and come from a model that is neither the builder's nor a head agent's.
// The merge script asks each of its review gates about these: the receipts gate (checkReceipts below),
// the checklist answers, the review level, and the security pass.
export function approvals({ baseRef, tip = 'HEAD', git, models, isPaperwork, protectedTests, readFile = (p) => readFileSync(p, 'utf8') }) {
  const banned = bannedModels(models);
  if (!banned) return { fail: SET_MODELS, notes: [] };
  const needed = neededCommits({ baseRef, tip, git, isPaperwork, protectedTests });
  if (needed.fail) return { fail: needed.fail, notes: [] };
  const notes = [];
  const want = new Set(needed.list.map((c) => c.fingerprint).filter(Boolean));
  const usable = [];
  if (want.size) {
    const read = trueReceipts({ tip, git, readFile, notes, about: (r) => Array.isArray(r?.fingerprints) && r.fingerprints.some((f) => want.has(f?.fingerprint)) });
    if (read.fail) return { fail: read.fail, notes };
    for (const { path, receipt: r } of read.list) {
      if (r.verdict !== 'approve') continue; // a round of review, not a pass
      if (banned.has(r.model)) {
        notes.push(`${path}: written by ${r.model}, the builder's or a head agent's model; not counted`);
        continue;
      }
      usable.push(r);
    }
  }
  return { needed: needed.list, usable, notes };
}

// Returns { uncovered: [commit + why], covered, notes } or { fail, notes }.
export function checkReceipts(args) {
  const counted = approvals(args);
  if (counted.fail) return counted;
  const { usable, notes } = counted;
  const needed = { list: counted.needed };
  const uncovered = [];
  for (const c of needed.list) {
    const hits = usable.filter((r) => c.fingerprint && r.fingerprints.some((f) => f.fingerprint === c.fingerprint));
    const ruled = (r) => c.protected.filter((file) => !r.protectedTests.some((t) => t.file === file));
    if (hits.some((r) => !ruled(r).length)) continue;
    const why = c.why ?? (hits.length
      ? `the approving receipt does not rule on the protected test ${ruled(hits[0]).join(', ')}`
      : "no approving receipt from a model other than the builder's and the head agent's");
    uncovered.push({ ...c, why });
  }
  return { uncovered, covered: needed.list.length - uncovered.length, notes };
}

// The rulings on weakenings. items: [{ file, id }] from scripts/test-changes.mjs, each with its reason.
// A ruling counts when its receipt still matches its session record, the reviewer was shown that
// item's id (the same kind, file, reason, and file contents), the reply rules on the file by name, and
// the model is neither the builder's nor a head agent's. The verdict may be either one: a reviewer
// can allow a test change and still ask for other fixes. The newest ruling wins; at the same time,
// "refused" wins.
// Returns { rulings, notes } or { fail, notes }. rulings[i] goes with items[i]:
//   { ruling: 'allowed' | 'refused' | null, ruledBy: model or null, why: plain text when null }.
export function checkWeakenings({ items, tip = 'HEAD', git, models, readFile = (p) => readFileSync(p, 'utf8') }) {
  const banned = bannedModels(models);
  if (!banned) return { fail: SET_MODELS, notes: [] };
  const notes = [];
  const want = new Set(items.map((i) => i.id).filter(Boolean));
  const read = want.size ? trueReceipts({ tip, git, readFile, notes, about: (r) => Array.isArray(r?.weakenings) && r.weakenings.some((id) => want.has(id)) }) : { list: [] };
  if (read.fail) return { fail: read.fail, notes };
  const when = (r) => Date.parse(r.at) || 0;
  const rulings = items.map((item) => {
    const none = (why) => ({ ruling: null, ruledBy: null, why });
    const saw = read.list.map((x) => x.receipt).filter((r) => r.weakenings.includes(item.id));
    if (!saw.length) return none('no reviewer has ruled on this exact change and reason');
    const named = saw.map((r) => ({ r, word: r.protectedTests.find((t) => t.file === item.file)?.ruling })).filter((x) => x.word);
    if (!named.length) return none('a reviewer was shown this change but did not rule on it by name');
    const other = named.filter((x) => !banned.has(x.r.model));
    if (!other.length) return none(`the only ruling is by ${named[0].r.model}, the model that built the change or a head agent's; a different model must rule`);
    other.sort((a, b) => when(b.r) - when(a.r) || Number(ALLOWS.includes(a.word)) - Number(ALLOWS.includes(b.word)));
    return { ruling: ALLOWS.includes(other[0].word) ? 'allowed' : 'refused', ruledBy: other[0].r.model, why: '' };
  });
  return { rulings, notes };
}

// Stable identity for one review round. Refreshing a receipt after its session file moves keeps
// task, at, and model identical so it counts once, while a later review reusing the same TASK id
// has a new timestamp and counts as a new round.
export function roundKey(receipt) {
  if (!receipt || typeof receipt.task !== 'string' || !receipt.task) return null;
  if (typeof receipt.at === 'string' && receipt.at) return `round:${receipt.task}|${receipt.at}|${typeof receipt.model === 'string' ? receipt.model : ''}`;
  return `task:${receipt.task}`;
}

// Slice number (whole number) from a branch name or task id, else null.
export function sliceNumberOf(branch, task) {
  const fromBranch = String(branch || '').match(/(?:^|\/)(\d{3})(?=-|$)/);
  if (fromBranch) return Number(fromBranch[1]);
  const fromTask = String(task || '').match(/(?:^|[-/])(\d{3})(?=-|$)/);
  return fromTask ? Number(fromTask[1]) : null;
}

const cut = (s, n) => { const t = String(s ?? ''); return t.length <= n ? t : `${t.slice(0, n - 3)}...`; };

// The ask auto-filed when a branch hits the review round cap (same shape as merge-pr's parkedAsk).
export function reviewCapAsk({ branch, round, maxRounds }) {
  const where = cut(branch || 'current branch', 100);
  return {
    title: 'What should happen to a branch past the review cap?',
    why: `Review round ${round} passed the ${maxRounds}-round limit (REV-6) on ${where}, so the agent was told to stop patching it.`,
    blocks: cut(branch || 'current branch', 120),
    options: [
      'A: Simplify the design and restart on a clean branch',
      'B: Split the task into smaller pull requests',
      'C: Add the slice to extraReviewRoundSlices on main and continue',
    ],
  };
}

// Distinct review rounds already added on this branch since baseRef (committed plus uncommitted
// new files under docs/receipts/). Every completed review (including "changes needed" rounds)
// counts; replacement receipts for a moved session file share task + at + model and count once.
// excludePath and excludeKey keep re-running or replacing an existing round idempotent.
// Returns { count, hasRound } or { fail }.
export function countBranchReceipts({ baseRef, tip = 'HEAD', git, root = null, excludePath = null, excludeKey = null, includeWorkingTree = true }) {
  const paths = new Set();
  if (baseRef) {
    const fork = git(['merge-base', baseRef, tip]);
    if (fork.code !== 0 || !fork.stdout.trim()) return { fail: `cannot find where ${tip} left ${baseRef}: ${(fork.stderr || 'no common commit').trim()}` };
    const added = git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', fork.stdout.trim(), tip, '--', RECEIPT_DIR]);
    if (added.code !== 0) return { fail: `cannot list receipts after ${baseRef}: ${added.stderr.trim()}` };
    for (const p of splitZ(added.stdout)) if (p.endsWith('.json')) paths.add(p);
  }
  const deleted = new Set();
  if (includeWorkingTree) {
    const st = git(['status', '--porcelain', '-z', '--', RECEIPT_DIR]);
    if (st.code !== 0) return { fail: `cannot check working tree receipts: ${st.stderr.trim()}` };
    const entries = splitZ(st.stdout);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const p = entry.slice(3);
      if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') i++;
      if (!p.endsWith('.json')) continue;
      if (code.includes('D')) deleted.add(p);
      else paths.add(p);
    }
  }
  for (const p of deleted) paths.delete(p);
  if (excludePath) paths.delete(excludePath);
  const readKey = (p) => {
    let raw;
    if (root && existsSync(join(root, p))) {
      try {
        raw = readFileSync(join(root, p), 'utf8');
      } catch (e) {
        return { fail: `cannot read receipt ${p}: ${e.message}` };
      }
    } else {
      const shown = git(['show', `${tip}:${p}`]);
      if (shown.code !== 0) return { fail: `cannot read receipt ${p}: ${(shown.stderr || 'git show failed').trim()}` };
      raw = shown.stdout;
    }
    try {
      const parsed = JSON.parse(raw);
      return { key: roundKey(parsed) };
    } catch (e) {
      return { fail: `receipt ${p} is not valid JSON: ${e.message}` };
    }
  };
  const rounds = new Set();
  let hasRound = false;
  for (const p of paths) {
    const read = readKey(p);
    if (read.fail) return { fail: read.fail };
    const k = read.key ?? `path:${p}`;
    if (excludeKey && k === excludeKey) {
      hasRound = true;
      continue;
    }
    rounds.add(k);
  }
  return { count: rounds.size, hasRound };
}

// ---------- Command line ----------

function exec(args, cwd, input) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function cli(argv) {
  const [command, arg, extra] = argv;
  if (!['fingerprints', 'make'].includes(command) || extra !== undefined || (command === 'make' && !arg) || (arg && arg.startsWith('-'))) {
    console.error(USAGE);
    return EXIT.usage;
  }
  const top = exec(['rev-parse', '--show-toplevel'], process.cwd());
  if (top.code !== 0) {
    console.error('Run this inside a git repo.');
    return EXIT.usage;
  }
  const root = top.stdout.trim();
  const git = (args, input) => exec(args, root, input);
  if (command === 'make') {
    const session = resolve(arg);
    let receipt;
    try {
      receipt = buildReceipt(readFileSync(session, 'utf8'), session);
    } catch (e) {
      console.error(`No receipt: ${e.code === 'ENOENT' ? `${session} does not exist` : e.message}.`);
      return EXIT.failed;
    }
    const path = receiptPath(receipt);
    const there = existsSync(join(root, path));
    let maxRounds = DEFAULT_MAX_REVIEW_ROUNDS;
    let baseRef = null;
    let cands = [];
    let extraAllowed = [];
    let eventsOn = false;
    try {
      const cp = await import('./check-plans.mjs');
      const cfg = cp.loadConfig(root);
      const remote = cfg.remote || 'origin';
      const baseBranch = cfg.baseBranch || 'main';
      const exists = (ref) => git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).code === 0;
      cands = cp.baseCandidates && cfg.remote && cfg.baseBranch ? cp.baseCandidates(cfg) : [`${remote}/${baseBranch}`, baseBranch];
      baseRef = cands.find(exists) ?? null;
      let baseCfg = null;
      if (baseRef) {
        const shown = git(['show', `${baseRef}:scripts/kit.config.json`]);
        if (shown.code === 0) {
          const parsedBase = JSON.parse(shown.stdout);
          baseCfg = cp.mergeConfig ? cp.mergeConfig(parsedBase) : parsedBase;
        }
      }
      const hasLocalConfig = existsSync(join(root, 'scripts/kit.config.json'));
      const localCap = hasLocalConfig ? (cfg.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS) : null;
      const baseCap = baseCfg ? (baseCfg.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS) : null;
      // When the base branch sets a cap, a branch cannot raise or disable it locally.
      if (baseCap !== null) {
        maxRounds = baseCap > 0 && localCap !== null && localCap > 0 ? Math.min(baseCap, localCap) : baseCap;
      } else {
        maxRounds = localCap ?? DEFAULT_MAX_REVIEW_ROUNDS;
      }
      // Only the base branch's extraReviewRoundSlices counts, so a build branch cannot allow itself extra rounds.
      extraAllowed = Array.isArray(baseCfg?.extraReviewRoundSlices) ? baseCfg.extraReviewRoundSlices : [];
      const ev = baseCfg?.features?.events ?? cfg.features?.events;
      eventsOn = ev === true || ev === 'enforce';
    } catch (e) {
      console.error(`Settings could not be read: ${e.message}`);
      return EXIT.usage;
    }
    if (maxRounds > 0 && !baseRef) {
      console.error(`Cannot count review rounds: no base branch found (tried ${cands.join(' and ')}). Fetch first.`);
      return EXIT.failed;
    }
    const branchRes = git(['symbolic-ref', '--short', '-q', 'HEAD']);
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() : '';
    const slice = sliceNumberOf(branch, receipt.task);
    const sliceAllowed = slice !== null && extraAllowed.includes(slice);
    const counted = maxRounds > 0
      ? countBranchReceipts({ baseRef, git, root, excludePath: path, excludeKey: roundKey(receipt) })
      : { count: 0, hasRound: false };
    if (counted.fail) {
      console.error(`Cannot count review rounds: ${counted.fail}`);
      return EXIT.failed;
    }
    const round = counted.count + 1;
    if (!there && !counted.hasRound && maxRounds > 0 && round > maxRounds && !sliceAllowed) {
      let askNote = '';
      if (eventsOn) {
        try {
          const { listAsks, newAsk } = await import('./ask.mjs');
          const body = reviewCapAsk({ branch: branch || receipt.task, round, maxRounds });
          const existing = listAsks(root).find((a) => a.status === 'open' && a.blocks === body.blocks && a.title === body.title);
          if (existing) askNote = ` An ask for Stephen is already filed (id ${existing.id}).`;
          else {
            const filed = newAsk(root, { ...body, slice });
            askNote = ` An ask for Stephen was filed (id ${filed.id}).`;
          }
        } catch {
          // Best-effort ask filing: never hide the STOP refusal.
        }
      }
      console.error(`STOP: Review round ${round} exceeds maxReviewRounds (${maxRounds}) on this branch (REV-6). Every completed review (including "changes needed" rounds) counts. Do not keep patching or override this cap.${askNote} Park this task and move to other work until Stephen answers or adds the slice to extraReviewRoundSlices on the base branch.`);
      return EXIT.failed;
    }
    mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
    if (!there) writeFileSync(join(root, path), `${JSON.stringify(receipt, null, 2)}\n`);
    const n = receipt.fingerprints.length;
    console.log(`${there ? 'Already there' : 'Wrote'} ${path}: ${receipt.verdict} by ${receipt.model} (${receipt.tool}), task ${receipt.task}, ${n} commit${n === 1 ? '' : 's'}, ${receipt.protectedTests.length} ruling${receipt.protectedTests.length === 1 ? '' : 's'} by name.`);
    const warnAt = maxRounds > 0 ? Math.min(maxRounds, Math.max(1, Math.round(maxRounds * 0.7))) : 0;
    if (maxRounds > 0 && round >= warnAt && round <= maxRounds && receipt.verdict !== 'approve') {
      console.log(`Warning (REV-6): This branch is on review round ${round} of ${maxRounds} with changes still needed. Stop and check whether the design should be simplified before another round.`);
    }
    if (round >= 3 && receipt.verdict !== 'approve' && n >= BLOAT_COMMIT_WARNING) {
      console.log(`Warning (REV-6): This branch has ${n} code commits on review round ${round}. Avoid patch-on-patch spirals: hand fixes to a fresh builder or simplify the design.`);
    }
    const c = receipt.counts;
    if (c) console.log(`Findings counted: ${c.important} important, ${c.nit} nit, ${c.preExisting} pre-existing. The builder answers each one in the branch's findings file (node scripts/findings.mjs lists them).`);
    console.log(receipt.verdict === 'approve'
      ? 'Commit and push it on the pull request\'s branch; the merge script checks it.'
      : 'Commit and push it on the pull request\'s branch too: it is this review round on record. Only an approving receipt lets a merge through.');
    return EXIT.ok;
  }
  // Loaded here, not at the top: merge-pr.mjs loads this file, and a loop of imports would hang.
  const [{ settings, guardScope, reviewScope, stricter, protectedTestsChanged, CONFIG_FILE }, { loadConfig, mergeConfig }] = await Promise.all([import('./merge-pr.mjs'), import('./check-plans.mjs')]);
  const tip = arg ?? 'HEAD';
  let baseRef;
  let scope;
  try {
    // This folder's settings only say where the base branch is. What is protected is read from git:
    // the named branch's own settings and the base branch's, taken together, as the merge script does.
    // So the list is the same whichever branch is checked out here.
    const here = settings(loadConfig(root));
    baseRef = `${here.remote}/${here.baseBranch}`;
    const at = (ref) => {
      const shown = git(['show', `${ref}:${CONFIG_FILE}`]);
      return settings(mergeConfig(shown.code === 0 ? JSON.parse(shown.stdout) : {}));
    };
    scope = guardScope(at(tip), at(baseRef));
  } catch (e) {
    console.error(`Settings could not be read: ${e.message}`);
    return EXIT.usage;
  }
  // The change checklist and the review level, each only when its switch is on. The two scripts are
  // loaded here, like the others. scripts/findings.mjs is never loaded by this file: it loads this one.
  // A reader that cannot answer stops the command when its switch enforces. When the switch only
  // watches, the review must not be held up by it: one note, and the lines are left out.
  const more = {};
  const read = async (key, modes, what, run) => {
    const mode = modes.map((name) => scope.modes[name]).reduce((x, y) => stricter(x, y), 'off');
    if (mode === 'off') return true;
    try {
      more[key] = await run();
      return true;
    } catch (e) {
      console.error(`${mode === 'enforce' ? '' : 'Note: '}${what} cannot be read: ${e.message}`);
      return mode !== 'enforce';
    }
  };
  // A script that is not there is said in one plain line, like any other reason a reader cannot answer.
  const script = async (file) => {
    try {
      return await import(`./${file}`);
    } catch (e) {
      throw new Error(`scripts/${file} cannot be loaded (${e.code === 'ERR_MODULE_NOT_FOUND' ? 'the file is missing' : String(e.message).split('\n')[0]})`);
    }
  };
  let pathMatches;
  if (!await read('checklist', ['changeChecklist'], 'The change checklist', async () => {
    const lists = await script('checklist.mjs');
    const { matched } = lists.checklistFor(root, { base: baseRef, branch: tip });
    pathMatches = lists.pathMatches;
    return matched;
  })) return EXIT.failed;
  // With the newer gates on, a docs commit under a high-risk path, or under a checklist row that fits, needs a review too.
  const review = reviewScope(scope, { items: more.checklist ?? [], pathMatches });
  if (!await read('level', ['reviewLevels', 'securityReview'], 'The review level', async () => (await script('review-level.mjs')).levelFor(root, { base: baseRef, branch: tip }))) return EXIT.failed;
  const needed = neededCommits({ baseRef, tip, git, isPaperwork: review.isPaperwork, protectedTests: (z) => protectedTestsChanged(z, scope.testPaths) });
  if (needed.fail) {
    console.error(needed.fail);
    return EXIT.failed;
  }
  let weakenings;
  if (scope.testReasons) {
    let found;
    try {
      const { collect } = await import('./test-changes.mjs');
      // A formatter reads its settings from the files in this folder. When the named branch is not what
      // is checked out here, its answer would be a guess, and the merge might not agree: collect then
      // stops with a line that says to run this from a checkout of that branch.
      const commit = (ref) => git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).stdout.trim();
      found = collect({
        baseRef, tip, git, root, isTest: scope.isTest, extraSettingsFiles: scope.extraSettingsFiles, snapshotPaths: scope.snapshotPaths,
        presetNames: scope.presetNames, configFile: CONFIG_FILE, readSettings: (json) => mergeConfig(JSON.parse(json)), onDisk: commit(tip) === commit('HEAD'),
      });
    } catch (e) {
      found = { fail: `scripts/test-changes.mjs cannot be loaded: ${e.message}` };
    }
    if (found.fail) {
      console.error(`The weakenings cannot be listed: ${found.fail}`);
      return EXIT.failed;
    }
    // Kept off standard output, which is what the receipt is read from.
    for (const note of found.notes ?? []) console.error(`Note: ${note}.`);
    weakenings = found.items;
  }
  console.log(`Base ${baseRef}, tip ${tip}.`);
  console.log(formatFingerprints(needed.list, weakenings, more));
  return EXIT.ok;
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  // The exit code is set, not forced with process.exit: Node then finishes writing what was printed
  // before it stops. Using .then() instead of top-level await lets dynamic imports (ask.mjs ->
  // events.mjs -> token-ledger.mjs -> receipt.mjs) resolve without a module-evaluation deadlock.
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

#!/usr/bin/env node
// merge-pr.mjs: the whole "merge a pull request" ritual, done by code instead of by hand.
//
// What it does, in plain English:
//   A pull request is a request on GitHub to merge one branch into another. Before one lands, the
//   branch must hold the newest base branch (main), every check must pass on exactly those files,
//   and the results must be posted on the pull request. This script does all of that in order and
//   stops at the first problem. It never deletes a branch.
//
//   It also picks how much to check. A change that touches only docs (a "paperwork" change) cannot
//   change what code does, so it runs only the rule checker and the script tests (seconds). Any
//   other change (a "code" change) also runs every command in the settings' "checks" list.
//   The script decides the tier from the list of changed files, so no agent can talk itself into
//   the cheap one.
//
//   A check that already passed on the very same set of files is not run again. Git gives every
//   exact set of file contents a fingerprint (the tree hash); passes are remembered by it.
//
//   The tests in scripts/ run as two checks. "kit tests" are the starter kit's own test files
//   (the ones listed in scripts/kit.manifest.json). They depend only on the files in scripts/, so
//   their pass is remembered by the fingerprint of that folder alone and they rerun only when
//   something in scripts/ changes. "script tests" are the project's own scripts/*.test.mjs files,
//   remembered by the whole tree. With no manifest (inside the kit itself), all of them run as
//   one "script tests" check.
//
// How to run (from anywhere inside the repo; needs Node 18 or newer, git, and the gh CLI):
//   node scripts/merge-pr.mjs <pr-number> [--ready] [--no-cache] [--no-clean] [--who <name>] [--wait <seconds>]
//       The merge ritual for one pull request. Be on that pull request's branch (or a local
//       branch that holds it), with nothing unsaved. --ready also marks a draft ready to merge.
//       After GitHub confirms the merge, runs scripts/clean-worktrees.mjs --delete for the merged
//       branch unless --no-clean is passed (best-effort; never fails the merge).
//   node scripts/merge-pr.mjs --check [--fast] [--no-cache] [--who <name>] [--wait <seconds>]
//       Run the checks for the current branch only: no merge of the base branch, no push, no
//       comment, no merge. --fast is the quick check: it skips the checks marked "slot": true (the
//       full test suite) and the ones marked "fast": false. A check with no "fast" key still runs.
//   --no-cache   run every check even if the same files already passed
//   --no-clean   skip running scripts/clean-worktrees.mjs after the merge
//   --who        the name written on the test slot while a full test run goes (default: a name
//                made from the pull request number or the branch)
//   --wait       if the test slot is busy, wait for it in the foreground for up to this many
//                seconds (a whole number above 0) instead of exiting with 75 at once. The waiting
//                is done by `scripts/slot.mjs acquire --wait`; this script prints one line when it
//                starts waiting and one when it gets the slot.
//
// Exit codes:
//   0   merged (or, with --check, every check passed)
//   1   a check failed, or the merge has conflicts, or GitHub refused a step
//   75  the machine's one test slot, or its merge lock, is busy (with --wait: still busy when the
//       wait ran out)
//   2   wrong usage, or a precondition failed (unsaved files, a draft without --ready, ...)
//
// Settings: scripts/kit.config.json, read through loadConfig in check-plans.mjs. Keys used here:
//   baseBranch, remote   the branch pull requests merge into and the remote's name (main, origin)
//   leadPrefixes         branch prefixes the head agent uses (default ["lead/"])
//   paperworkPaths       folders (ending in "/") and files that count as docs
//                        (default ["docs/", "AGENTS.md"])
//   checks               [{ "name": "test", "run": "pnpm test", "slot": true }, ...]
//                        "slot": true means the command is a full test run: it goes through
//                        scripts/slot.mjs, so only one runs on the machine at a time.
//                        "fast": false means --check --fast leaves the check out; a merge still runs it.
//                        "observe": true means the check only watches: it runs, a failure is printed and
//                        recorded (its `check-run` event carries observed: true), and it stops neither a
//                        check run nor a merge. The pull request comment says it failed. When it also
//                        has "slot": true and the test slot is busy, it is left out with one line.
//                        A branch cannot move a check to "observe" for its own merge while the base
//                        branch still enforces that check: it enforces, and one line says so.
//   highRiskPaths        folders (ending in "/") and files where a mistake costs the most (sign-in,
//                        money, data deletion). A change that touches one is labelled "high" risk: the
//                        label and the entries that matched go in the pull request comment and in the
//                        `merged` event. It blocks nothing. Default [], and then no label is shown.
//   features             switches for the newer guards; a missing one is off. A value is true, false, or
//                        one of three mode words:
//                          "off" (the same as false)     the gate does not run.
//                          "enforce" (the same as true)  the gate runs and can stop a merge.
//                          "observe"                     the gate runs in full, but only watches. Where it
//                            would stop the merge it prints "watching only: <switch> would have stopped
//                            this merge: <reason>", writes one `would-block` event { gate, pr, reason }
//                            (gate is the switch's name; written even with the events switch off, since
//                            that record is all watching is for), says so in the pull request comment, and lets
//                            the merge go on. That holds when the gate itself breaks too (a script that
//                            cannot be loaded, a branch git cannot find). --check prints the same line
//                            with "this check" and writes no event. Use it to try a gate for two weeks
//                            before it may stop anything.
//                        Ten switches can watch: protectedTests, reviewReceipts, duplicateNumbers,
//                        testReasons, incomingCommits, verifiedStamp, changeChecklist, reviewLevels,
//                        securityReview, findingAnswers. For events, mergeLock, blockLog, and claimCheck
//                        "observe" is refused: they do not stop a merge, or they run in a git hook.
//                        For each switch that can watch, the mode used is the stricter of the base
//                        branch's and the branch's own (enforce over observe over off).
//                        mergeLock: hold the machine's `merge` slot from the last fetch of the base
//                          branch until GitHub confirms the merge, so two merges never cross. It is
//                          renewed right before the merge call; if it is no longer ours, nothing merges.
//                          The merge call is stopped after MERGE_CALL_SECONDS, half the lease, so it
//                          never runs on past the lease; then the merge state is unknown and says so.
//                        duplicateNumbers: fail when two files in one numberedPaths folder share a
//                          number, checked on the tree that will land (and on this branch by --check).
//                        protectedTests: list every test file (testPaths) that already exists on the
//                          base branch and that the change modified, deleted, or renamed away. New test
//                          files are free. Printed by both ways to run, and posted in the results
//                          comment so the reviewer rules on each file by name. It lists; it does not block.
//                        reviewReceipts: refuse the merge unless every code commit and hand-resolved
//                          merge after the base matches an approving review receipt from a model other
//                          than models.builder and models.headAgent. The rules are in scripts/receipt.mjs.
//                        blockLog: append one JSON line to <git common dir>/kit-block-log.jsonl for each
//                          refusal ("blocked": a failed check, a number clash, uncovered commits, GitHub
//                          refusing the merge as check "github"), each check that passed ("passed"), and
//                          each merge ("merged"): time, outcome, pull request, branch, check, tip, tree,
//                          and the code commits' fingerprints. A busy slot, a conflict, a setup failure,
//                          or a merge call that ran out of time is not a refusal.
//                        claimCheck: read by the rule checker (scripts/check-plans.mjs, checkClaims). A lead
//                          branch whose own commit claims a slice the base branch already started fails, so
//                          two identical claims that git merges cleanly never both land.
//                        events: write what happens to the project's event log (scripts/events.mjs), in
//                          the shapes of docs/2026-11-18-dashboard-data-contract.md, section 9: `check-run`
//                          for each check that really ran, `merge-blocked` when a merge stops with exit
//                          code 1, `merged`, `weakening`, `slice-closed`, and a `task-done` for each task
//                          nobody logged when a merge closes a slice. Also `would-block` when a gate on
//                          "observe" would have stopped a merge, and `finding` for each answer to a review
//                          finding (findingAnswers). An event that cannot be written
//                          prints one warning line and never stops a check or a merge.
//                          It also turns on the retry cap: when one check fails for the third time in a
//                          row on one branch (no pass of that check in between), the script writes
//                          `slice-parked`, files one ask for Stephen (scripts/ask.mjs), and tells the agent
//                          to stop retrying. It files one ask, not one per further failure, and it never
//                          blocks a later run.
//                        testReasons: test protection. scripts/test-changes.mjs sorts every change to a
//                          guard (an existing test, kit.ratchets.json, the checks in the settings, a lint,
//                          type, or test settings file). Each one that is a weakening needs (1) a reason
//                          line from the builder in a file under docs/weakenings/, checked by both ways to
//                          run, and (2) at a merge, a ruling of "allowed" on that exact change and reason,
//                          by name, in a review receipt from a model that is neither models.builder nor a
//                          models.headAgent (scripts/receipt.mjs). No reason, no ruling, a ruling by the
//                          builder's own model, or a ruling of "refused": no merge. With events on, each
//                          one is written as a `weakening` event.
//                          A branch cannot loosen this gate for its own merge: testReasons and events stay
//                          in force when the base branch has them on, and the paths, presets, and models
//                          of the base branch's settings count together with the branch's own.
//                        incomingCommits: one more built-in check, "incoming commits", in every tier and in
//                          both ways to run. It reads the commits on the branch that are not on the base
//                          branch. Each one that is not a merge must pass the commit message check
//                          (scripts/commit-msg.mjs; nothing is added to a message here), and a fixup!,
//                          squash!, or amend! commit that was never squashed is refused. Then the secret
//                          scan runs over exactly those commits, merge commits included, with the kit's
//                          settings: gitleaks git --log-opts="--diff-merges=first-parent <base>..HEAD"
//                          --redact --no-banner --no-color --verbose --ignore-gitleaks-allow --config
//                          <the base branch's copy of kit-lint/gitleaks.toml>. With no such file on the
//                          base branch or here, the scan is skipped with one line; with no gitleaks
//                          installed, or with a .gitleaksignore file in the folder, the check fails and
//                          says what to do. A pass is remembered for one base commit, head commit, slice,
//                          and set of scan settings, never by the files, so a secret that was added and
//                          then removed is still found. The base branch's switch stays in force for a
//                          branch that turns it off.
//                        The five below run only at a merge, after the receipts and weakenings gates and
//                        before any check. Each needs its script in scripts/; with the switch off the
//                        script is never asked.
//                        verifiedStamp: the "Verified:" line of the branch's own commits that change
//                          product code (see productPaths). The line is the last block of a commit
//                          message: "Verified: <kinds>", "Verified: none", or "Verified: none (<reason>)",
//                          with the kinds ran, tests, checks in a comma list (scripts/commit-msg.mjs reads
//                          it). The gate is met when at least one of those commits says ran or tests, or
//                          the newest one says none with a reason of 15 characters or more. A merge commit
//                          counts by what was done by hand while combining the two sides. A branch with
//                          no such commit has nothing to stamp. `merged` gains verified: { ran, tests,
//                          checks, none }: how many of those commits carry each word (no line counts as none).
//                        changeChecklist: the rows of docs/change-checklist.md that fit the change
//                          (scripts/checklist.mjs). Each needs "- CL-3: ok" or "- CL-3: does not apply, <why>"
//                          in the CHECKLIST part of a review that counts: an approving receipt, still true
//                          to its session record, that covers a commit of this change, from a model that is
//                          neither models.builder nor a models.headAgent. "finding <n>" is not an answer that
//                          lets a merge through. The receipt must cover the newest commit that touches the
//                          row's paths, so an answer given before a later edit does not cover that edit.
//                          `merged` gains checklist: [the ids that fit].
//                        reviewLevels: scripts/review-level.mjs works out the level a change needs (quick,
//                          standard, or deep). Every commit that needs a review must be covered by a review
//                          that counts at that level or above. A receipt with no LEVEL line is a standard
//                          review. `merged` gains level (also with securityReview on).
//                        securityReview: when that level is deep, every commit that needs a review must be
//                          covered by a review that counts and says "SECURITY: clear".
//                          With changeChecklist, reviewLevels, or securityReview on, a docs file under a
//                          high-risk path, or under the paths of a checklist row that fits the change, is
//                          not paperwork for the review: its commit needs a receipt like a code commit
//                          (reviewScope). A gate that only watches asks that for itself alone: it never
//                          makes an enforcing gate, the receipts gate included, ask for a receipt. A row
//                          that fits, or a deep change, is never passed with no receipt at all.
//                        findingAnswers: every finding a review round counted (the COUNT line, kept in the
//                          receipt) needs one answer line from the builder in docs/findings/<branch>.md
//                          (scripts/findings.mjs). The counts come from each receipt as made again from its
//                          session record; a receipt whose record cannot be read stops the gate, because
//                          its count could have been edited down. After the merge, one `finding` event per answer line:
//                          { pr, round, n, label, outcome }, the label in small letters.
//                        With events on, every `check-run` event also names the commit that was checked
//                        (head: its short id; null when --check ran with unsaved files).
//   productPaths         folders that hold product code, for verifiedStamp. Default []: then product code
//                        is any file that is not paperwork and not a test. A file counts when the base
//                        branch's settings or the branch's own call it product code.
//   checkSettingsPaths   more lint, type, or test settings files for testReasons, added to the list in
//                        scripts/test-changes.mjs (CHECK_SETTINGS_FILES). Default [].
//   snapshotPaths        more snapshot files for testReasons, added to SNAPSHOT_FILES in that script: an
//                        entry ending in "/" is a folder anywhere, one starting with "." a file ending,
//                        any other a piece of the file name. Default [].
//   presets, plansDir    presets: whose patterns testReasons sorts test changes with. plansDir: with
//                        events on, a plan a merge moves into <plansDir>/completed/ as done closes its slice.
//   numberedPaths        folders (ending in "/") whose files are numbered, like 090-sync.md or
//                        0026_users.sql (default ["docs/plans/", "docs/decisions/"])
//   testPaths            what counts as a test file, with no wildcards. An entry ending in "/" is a
//                        folder name anywhere in the path ("tests/" matches apps/server/tests/x.ts);
//                        any other entry is a piece of the file name (".test." matches a.test.ts).
//                        Default [".test.", ".spec.", "__tests__/", "__snapshots__/", "tests/", "test/"]:
//                        the usual test names and folders of JavaScript projects. Fixtures and snapshots
//                        in those folders count, because editing one can make a test pass.
//
// Safety, so a branch cannot weaken its own check:
//   - On a branch that is not a lead branch, the rule checker AND the settings are taken from the
//     base branch (git show <remote>/<base>:scripts/check-plans.mjs and :scripts/kit.config.json).
//     Whether a branch counts as a lead branch is decided by the base branch's settings too. A
//     lead branch uses its own copies, because the head agent may change them.
//   - The merge names the exact commit that was checked (gh pr merge --match-head-commit), so a
//     commit pushed after the checks is never merged unchecked.
//   - What a gate reads from the settings is the branch's copy joined with the base branch's in the
//     stricter direction (guardScope): test paths, numbered folders, high-risk paths, and models
//     count together; a file is paperwork only when both say so (that also picks the tier); a check
//     enforces while the base branch enforces it.
//   - A lead branch cannot turn a gate off, or move it to "observe", for its own merge: the stricter
//     of the two modes counts. With testReasons on, moving a switch off "enforce", or turning a check
//     into an observing one, is also a weakening in its own right that needs the builder's reason and
//     a reviewer's ruling. scripts/test-changes.mjs reads the modes and says which way a switch moved.
//
// Full output of each check goes to <git common dir>/kit-logs/. The screen shows one line per
// check, plus the last 30 lines of a check that failed.
//
// No outside libraries.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, busy: 75 });
export const CACHE_FILE = 'kit-check-cache.json';
export const LOG_DIR = 'kit-logs';
export const BLOCK_LOG_FILE = 'kit-block-log.jsonl';
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_TRIES = 3;
export const TAIL_LINES = 30;
export const SLOT_MINUTES = 30;
export const MERGE_LOCK_MINUTES = 10;
// The GitHub merge call's hard time limit: half the merge lock's lease, renewed right before the call.
export const MERGE_CALL_SECONDS = 300;
export const FEATURES = Object.freeze(['protectedTests', 'reviewReceipts', 'mergeLock', 'duplicateNumbers', 'blockLog', 'claimCheck', 'events', 'testReasons', 'incomingCommits', 'verifiedStamp', 'changeChecklist', 'reviewLevels', 'securityReview', 'findingAnswers']);
// The three modes of a switch, weakest first. In the settings, true means "enforce" and false means "off".
export const MODES = Object.freeze(['off', 'observe', 'enforce']);
// The switches that can watch ("observe"): each of them can stop a merge, so each can also only say
// that it would have. The other four do not stop a merge, or run in a git hook.
export const WATCHERS = Object.freeze(['protectedTests', 'reviewReceipts', 'duplicateNumbers', 'testReasons', 'incomingCommits', 'verifiedStamp', 'changeChecklist', 'reviewLevels', 'securityReview', 'findingAnswers']);
// The review levels, lightest first: the same list as LEVELS in scripts/review-level.mjs.
export const LEVEL_ORDER = Object.freeze(['quick', 'standard', 'deep']);
// The shortest reason that will do after "Verified: none".
export const VERIFIED_REASON_MIN = 15;
// The retry cap: this many failed runs of one check in a row on one branch parks the slice.
export const RETRY_CAP = 3;
export const API_MARKER = 'CHECKER_API';
export const INCOMING = 'incoming commits';
export const RESERVED_NAMES = ['rules', 'kit tests', 'script tests', INCOMING];
// The kit's own secret scan settings, as they land in a project.
export const GITLEAKS_CONFIG = 'kit-lint/gitleaks.toml';
export const MANIFEST_FILE = 'scripts/kit.manifest.json';
export const CONFIG_FILE = 'scripts/kit.config.json';

export const USAGE = [
  'Usage:',
  '  node scripts/merge-pr.mjs <pr-number> [--ready] [--no-cache] [--no-clean] [--who <name>] [--wait <seconds>]  merge one pull request',
  '  node scripts/merge-pr.mjs --check [--fast] [--no-cache] [--who <name>] [--wait <seconds>]                     only run the checks for this branch',
  '  --fast: the quick check. Skips the checks marked "slot": true or "fast": false in the settings.',
  '  --no-clean: skip removing finished worktrees after the merge.',
  '  --wait <seconds>: if the test slot or the merge lock is busy, wait up to this long for it instead of exiting with 75.',
  'Exit codes: 0 done, 1 a check failed or the merge has conflicts, 75 the test slot is busy, 2 wrong usage.',
].join('\n');

// ---------- Pure rules (tests call these with plain data) ----------

// Reads the command line. Throws on anything it does not understand, so a typo never runs a merge.
export function parseArgs(argv) {
  const opts = { mode: null, pr: null, ready: false, noCache: false, noClean: false, fast: false, who: '', wait: 0, help: false };
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--check') check = true;
    else if (arg === '--fast') opts.fast = true;
    else if (arg === '--ready') opts.ready = true;
    else if (arg === '--no-cache') opts.noCache = true;
    else if (arg === '--no-clean') opts.noClean = true;
    else if (arg === '--who') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('--who needs a name');
      opts.who = argv[++i];
    } else if (arg === '--wait') {
      const value = argv[i + 1];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 0) throw new Error('--wait needs a number of seconds: a whole number above 0');
      opts.wait = Number(argv[++i]);
    } else if (/^#?\d+$/.test(arg)) {
      if (opts.pr !== null) throw new Error('give only one pull request number');
      opts.pr = Number(arg.replace('#', ''));
    } else throw new Error(`argument not understood: "${arg}"`);
  }
  if (opts.help) return opts;
  if (check && opts.pr !== null) throw new Error('give a pull request number or --check, not both');
  if (!check && opts.pr === null) throw new Error('give a pull request number, or --check');
  if (opts.fast && !check) throw new Error('--fast works only with --check (a merge always runs every check)');
  if (opts.ready && check) throw new Error('--ready works only with a pull request number');
  if (opts.noClean && check) throw new Error('--no-clean works only with a pull request number');
  opts.mode = check ? 'check' : 'merge';
  return opts;
}

// A "features" value -> its mode: true is "enforce", false or nothing is "off", and the three mode
// words are themselves. null for anything else.
export function modeOf(value) {
  if (value === true) return 'enforce';
  if (value === false || value === undefined) return 'off';
  return MODES.includes(value) ? value : null;
}

// The stricter of two modes: enforce over observe over off.
export const stricter = (a, b) => MODES[Math.max(MODES.indexOf(a), MODES.indexOf(b))];

// Fills in defaults for the settings this script uses, and fails loud on a bad "checks" list.
// features[name] says whether a gate runs at all (true for "observe" and "enforce"); modes[name] says how.
export function settings(config = {}) {
  const out = {
    baseBranch: config.baseBranch ?? 'main',
    remote: config.remote ?? 'origin',
    leadPrefixes: config.leadPrefixes ?? ['lead/'],
    paperworkPaths: config.paperworkPaths ?? ['docs/', 'AGENTS.md'],
    checks: config.checks ?? [],
    features: {},
    numberedPaths: config.numberedPaths ?? ['docs/plans/', 'docs/decisions/'],
    testPaths: config.testPaths ?? ['.test.', '.spec.', '__tests__/', '__snapshots__/', 'tests/', 'test/'],
    models: config.models ?? { headAgent: [], builder: '', reviewer: '' },
    highRiskPaths: config.highRiskPaths ?? [],
    presets: config.presets ?? [],
    checkSettingsPaths: config.checkSettingsPaths ?? [],
    snapshotPaths: config.snapshotPaths ?? [],
    plansDir: config.plansDir ?? 'docs/plans',
    buildPrefix: config.buildPrefix ?? 'build/',
    productPaths: config.productPaths ?? [],
    modes: {},
  };
  for (const key of ['leadPrefixes', 'paperworkPaths', 'checks', 'numberedPaths', 'testPaths', 'highRiskPaths', 'presets', 'checkSettingsPaths', 'snapshotPaths', 'productPaths']) {
    if (!Array.isArray(out[key])) throw new Error(`settings: "${key}" must be a list`);
  }
  if (out.numberedPaths.some((p) => typeof p !== 'string' || p.length < 2 || !p.endsWith('/'))) {
    throw new Error('settings: "numberedPaths" must list folders that end with "/", like "docs/plans/"');
  }
  if (out.testPaths.some((p) => typeof p !== 'string' || !p.replace(/\//g, '') || p.includes('*'))) {
    throw new Error('settings: "testPaths" must list name pieces like ".test." or folders like "tests/", with no wildcards');
  }
  const flags = config.features ?? {};
  if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) throw new Error('settings: "features" must be an object of true/false flags');
  for (const [name, value] of Object.entries(flags)) {
    if (!FEATURES.includes(name)) throw new Error(`settings: unknown feature "${name}" (known: ${FEATURES.join(', ')})`);
    const mode = modeOf(value);
    if (mode === null) throw new Error(`settings: "features.${name}" must be true or false, or one of the words "off", "observe", "enforce"`);
    if (mode === 'observe' && !WATCHERS.includes(name)) {
      throw new Error(`settings: "features.${name}" cannot be "observe": ${name} does not stop a merge (or it runs in a git hook), so there is nothing to watch. Use "enforce" (or true) to turn it on, or "off" (or false)`);
    }
  }
  // features: does this gate run at all. modes: how. A gate on "observe" runs, so its flag is true.
  for (const name of FEATURES) {
    out.modes[name] = modeOf(flags[name]);
    out.features[name] = out.modes[name] !== 'off';
  }
  const seen = new Set();
  for (const check of out.checks) {
    const ok = check && typeof check.name === 'string' && check.name.trim() && typeof check.run === 'string' && check.run.trim();
    if (!ok) throw new Error('settings: every entry in "checks" needs a "name" and a "run" command');
    if ('observe' in check && typeof check.observe !== 'boolean') throw new Error(`settings: "observe" of the check "${check.name}" must be true or false`);
    if (RESERVED_NAMES.includes(check.name)) throw new Error(`settings: a check may not be named "${check.name}" (the script runs that one itself)`);
    if (seen.has(check.name)) throw new Error(`settings: two checks are named "${check.name}"`);
    seen.add(check.name);
  }
  return out;
}

// Settings text (JSON) -> checked settings. null means "no settings file": the defaults.
// The command line swaps in the checker's own loader, so both scripts apply the same rules.
export function parseSettingsText(text) {
  return settings(text === null ? {} : JSON.parse(text));
}

// Which version of the command line a checker file understands, read from its text:
//   0  no CHECKER_API in it: it takes no flags from this script
//   2  --root <folder> and --branch <name>
//   3  also --base <ref>
// The text "CHECKER_API" with no number counts as 2.
export function checkerApi(text) {
  if (!String(text).includes(API_MARKER)) return 0;
  const m = String(text).match(/CHECKER_API\s*=\s*(\d+)/);
  return m ? Number(m[1]) : 2;
}

// The flags to hand a checker, given what it understands.
export function checkerArgs({ api, root, branch, baseRef }) {
  const args = [];
  if (api >= 2) {
    args.push('--root', root);
    if (branch) args.push('--branch', branch);
  }
  if (api >= 3 && baseRef) args.push('--base', baseRef);
  return args;
}

// A path ending in "/" means everything inside that folder; any other entry is one exact file.
export function isPaperwork(file, paperworkPaths) {
  return paperworkPaths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

// "paperwork" when every changed file is a doc (or nothing changed), else "code".
export function pickTier(files, paperworkPaths) {
  return files.every((f) => isPaperwork(f, paperworkPaths)) ? 'paperwork' : 'code';
}

// A lead branch is the base branch itself or one with a head agent prefix. Lead branches may
// change the checker, so they are checked with their own copy of it.
export function isLeadBranch(branch, baseBranch, leadPrefixes) {
  if (!branch) return false;
  return branch === baseBranch || leadPrefixes.some((p) => branch.startsWith(p));
}

// Files in one numbered folder that share a number. A file counts when its name starts with 3 or
// more digits and then "-" or "_" (090-sync.md, 0026_users.sql), anywhere below the folder, so a
// plan in active/ and one in completed/ clash. Two files clash only when their names differ once
// the last extension is cut off, and then a final ".up" or ".down": a plan and its log
// (logs/090-sync.md), or 0027_x.up.sql and 0027_x.down.sql, are one numbered item, while
// 0026_add.users.sql and 0026_add.orders.sql are two. 007 and 0007 are one number.
// Returns [{ folder, number, files }], in numberedPaths order, then by number.
export function findDuplicateNumbers(files, numberedPaths) {
  const found = [];
  for (const folder of numberedPaths) {
    const byNumber = new Map();
    for (const file of files) {
      if (!file.startsWith(folder)) continue;
      const name = file.slice(file.lastIndexOf('/') + 1);
      const m = name.match(/^(\d{3,})[-_]/);
      if (!m) continue;
      const key = Number(m[1]);
      if (!byNumber.has(key)) byNumber.set(key, { number: m[1], stems: new Set(), files: [] });
      const entry = byNumber.get(key);
      entry.stems.add(name.replace(/\.[^.]*$/, '').replace(/\.(up|down)$/, ''));
      entry.files.push(file);
    }
    for (const [, entry] of [...byNumber].sort((a, b) => a[0] - b[0])) {
      if (entry.stems.size > 1) found.push({ folder, number: entry.number, files: [...entry.files].sort() });
    }
  }
  return found;
}

// A test file, by testPaths: an entry ending in "/" is a whole folder name anywhere in the path;
// any other entry is a piece of the file's own name.
export function isTestFile(file, testPaths) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return testPaths.some((p) => (p.endsWith('/') ? `/${file}`.includes(`/${p}`) : name.includes(p)));
}

// What the gates protect, from two versions of the settings taken together: the ones in use (cfg)
// and the base branch's (base). A lead branch is checked with its own settings, so without this it
// could take a file out of protection, or change who may review, in the very change that needs the
// protection. A path counts as a test, a check settings file, or a snapshot when either version says
// so, and as paperwork only when both do. models holds both versions; the receipt code refuses a
// ruling by a builder or head agent model named in either. events counts when either has it on.
// modes: for each switch that can watch, the stricter of the two versions' modes (enforce over observe
// over off), so a branch can neither turn a gate off nor move it to watching for its own merge.
// isProduct: product code, for the Verified stamp. Each version says what it counts: a file under its
// productPaths, or with that list empty any file it calls neither paperwork nor a test. A file is product
// code when either version says so, so a branch cannot name its code a test or a doc to skip the stamp.
// numberedPaths: the numbered folders of both. checks: the checks in use, where one the base branch still
// enforces cannot be moved to "observe" by the branch itself; heldChecks names those.
// scripts/receipt.mjs builds the same thing for the branch a reviewer names, so both list the same files.
export function guardScope(cfg, base = cfg) {
  const both = (key) => [...new Set([...(cfg[key] ?? []), ...(base[key] ?? [])])];
  const testPaths = both('testPaths');
  // The flag says whether the gate runs; the mode only tells watching from enforcing.
  const modeIn = (c, name) => (c.features[name] ? (c.modes?.[name] === 'observe' ? 'observe' : 'enforce') : 'off');
  const modes = Object.fromEntries(WATCHERS.map((name) => [name, stricter(modeIn(cfg, name), modeIn(base, name))]));
  const isTest = (f) => isTestFile(f, testPaths);
  const paperwork = (f) => isPaperwork(f, cfg.paperworkPaths) && isPaperwork(f, base.paperworkPaths);
  const productIn = (c, f) => (c.productPaths?.length
    ? c.productPaths.some((p) => f.startsWith(p.endsWith('/') ? p : `${p}/`))
    : !isPaperwork(f, c.paperworkPaths) && !isTestFile(f, c.testPaths));
  const enforcedOnBase = new Set((base.checks ?? []).filter((c) => c.observe !== true).map((c) => c.name));
  const heldChecks = (cfg.checks ?? []).filter((c) => c.observe === true && enforcedOnBase.has(c.name)).map((c) => c.name);
  return {
    testPaths,
    isTest,
    isPaperwork: paperwork,
    isProduct: (f) => productIn(cfg, f) || productIn(base, f),
    numberedPaths: both('numberedPaths'),
    checks: (cfg.checks ?? []).map((c) => (heldChecks.includes(c.name) ? { ...c, observe: false } : c)),
    heldChecks,
    extraSettingsFiles: both('checkSettingsPaths'),
    snapshotPaths: both('snapshotPaths'),
    presetNames: both('presets'),
    highRiskPaths: both('highRiskPaths'),
    models: [cfg.models, base.models],
    modes,
    testReasons: modes.testReasons !== 'off',
    events: cfg.features.events || base.features.events,
    incomingCommits: modes.incomingCommits !== 'off',
  };
}

// A file name as printed and posted: as it is, or, when it holds a backtick, a quote, a backslash,
// or a control character (a line break), as a JSON string with those escaped too. So a name can
// never break out of a Markdown code span or split one printed line into two.
export function showName(name) {
  // eslint-disable-next-line no-control-regex
  if (!/[`"\\\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(name)) return name;
  return JSON.stringify(name).replace(/[`\x7f-\x9f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// The test files that already exist on the base branch and that a change touched, from
// `git diff --name-status -z -M <base>...<tip>` output. Modified (M, and T for a type change),
// deleted (D), or renamed away (R: listed by the old name). Added (A) and copied (C) files are new,
// so they are free; so is a file renamed into a test path from a name that was not a test.
// Returns [{ file, change: 'modified' | 'deleted' | 'renamed', to? }], sorted by file. Piece by
// piece this is the list the reviewer must rule on by name, so keep its shape stable.
export function protectedTestsChanged(nameStatusZ, testPaths) {
  const parts = String(nameStatusZ).split('\0');
  const found = [];
  for (let i = 0; i < parts.length; i++) {
    const kind = parts[i].charAt(0);
    if (!kind) continue;
    const file = parts[++i];
    const to = kind === 'R' || kind === 'C' ? parts[++i] : undefined;
    if (!file || !isTestFile(file, testPaths)) continue;
    if (kind === 'M' || kind === 'T') found.push({ file, change: 'modified' });
    else if (kind === 'D') found.push({ file, change: 'deleted' });
    else if (kind === 'R') found.push({ file, change: 'renamed', to });
  }
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// One remembered pass is filed under: the exact files (tree hash), the check's name, its command.
export function cacheKey(tree, name, command) {
  return `${tree}|${name}|${sha256(command)}`;
}

// Missing or unreadable file means an empty record: the checks simply run.
export function readCache(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// Drops entries older than 14 days (and any that are not in the expected shape).
export function pruneCache(cache, now = Date.now()) {
  const out = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (entry && Number.isFinite(entry.passedAt) && now - entry.passedAt <= MAX_AGE_MS) out[key] = entry;
  }
  return out;
}

export function isCached(cache, key, now = Date.now()) {
  const entry = cache[key];
  return Boolean(entry && Number.isFinite(entry.passedAt) && now - entry.passedAt <= MAX_AGE_MS);
}

// Writes through a temp file and a rename, so a reader never sees half a file.
export function writeCache(path, cache) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 1)}\n`);
  renameSync(tmp, path);
}

// Reads the newest record first, so a pass another worktree just wrote is kept.
// ms: how long the check took; scripts/checks-map.mjs reads it from here.
export function recordPass(path, key, name, now = Date.now(), ms = undefined) {
  const cache = pruneCache(readCache(path), now);
  cache[key] = { name, passedAt: now, ms };
  writeCache(path, cache);
}

// Decides which checks run, which are skipped and why, and which already passed on these files.
//   tier: "paperwork" or "code". checks: the settings' list. fast: the quick check, which leaves out
//   every check marked "slot": true or "fast": false.
//   kitTests: the kit's own test files. scriptTests: the project's test files in scripts/.
//   tree: the tree hash of everything. scriptsTree: the tree hash of the scripts folder alone.
//   cache: the remembered passes, or null to ignore them.
// Each planned check carries `key`, the name its pass is remembered under (null: never remembered).
// A check from the settings with "observe": true carries `observe: true`: it runs, and a failure is
// printed and recorded but stops nothing.
export function planChecks({ tier, checks = [], fast = false, kitTests = [], scriptTests = [], tree = '', scriptsTree = '', cache = null, now = Date.now() }) {
  // The rule checker also reads the branch name and the base branch, which no tree hash covers,
  // so it always runs.
  const planned = [{ name: 'rules', kind: 'rules', command: 'check-plans', slot: false, keyTree: '' }];
  if (kitTests.length) {
    // The kit's tests read only the files in scripts/, so that folder's hash is enough.
    planned.push({ name: 'kit tests', kind: 'nodeTests', files: kitTests, command: `node --test ${kitTests.join(' ')}`, slot: false, keyTree: scriptsTree });
  }
  if (scriptTests.length) {
    planned.push({ name: 'script tests', kind: 'nodeTests', files: scriptTests, command: `node --test ${scriptTests.join(' ')}`, slot: false, keyTree: tree });
  }
  const skipped = [];
  for (const check of checks) {
    if (tier === 'paperwork') skipped.push({ name: check.name, why: 'docs-only' });
    else if (fast && (check.slot || check.fast === false)) skipped.push({ name: check.name, why: 'fast' });
    else planned.push({ name: check.name, kind: 'config', command: check.run, slot: Boolean(check.slot), keyTree: tree, ...(check.observe === true ? { observe: true } : {}) });
  }
  for (const p of planned) {
    p.key = p.kind !== 'rules' && p.keyTree ? cacheKey(p.keyTree, p.name, p.command) : null;
    p.cached = cache !== null && p.key !== null && isCached(cache, p.key, now);
    delete p.keyTree;
  }
  return { planned, skipped };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// The pull request comment. results: [{ name, cached, ms, failed?, notRun? }]; failed: true is a check on
// "observe" that failed and stopped nothing, notRun: true one that could not get the test slot.
// skipped: [{ name, why }].
// watching: [{ gate, reason }], one for each gate on "observe" that would have stopped this merge.
// protectedTests: the protectedTestsChanged list, or undefined when that flag is off.
// risk: the riskOf answer, or undefined when the settings list no high-risk paths.
// weakenings: the ruled list [{ kind, file, to?, reason, ruledBy }], or undefined when testReasons is off.
export function formatComment({ shortSha, tier, results, skipped = [], protectedTests, risk, weakenings, watching = [] }) {
  const lines = [`Local checks on ${shortSha} (tier: ${tier}, by scripts/merge-pr.mjs)`];
  if (risk) lines.push(risk.risk === 'high' ? `Risk: high (touches ${risk.riskPaths.map((p) => `\`${showName(p)}\``).join(', ')}).` : 'Risk: normal.');
  for (const r of results) {
    if (r.notRun) lines.push(`- ${r.name}: not run, the test slot was busy (watching only: it did not stop the merge)`);
    else lines.push(`- ${r.name}: ${r.failed ? 'FAILED, watching only: it did not stop the merge' : 'pass'} (${r.cached ? 'cached' : seconds(r.ms)})`);
  }
  if (tier === 'paperwork') {
    const names = skipped.filter((s) => s.why === 'docs-only').map((s) => s.name);
    lines.push(`Docs-only change: app checks skipped${names.length ? ` (${names.join(', ')})` : ''}.`);
  }
  if (protectedTests && !protectedTests.length) lines.push('Protected tests changed: none.');
  else if (protectedTests) {
    lines.push(`Protected tests changed (${protectedTests.length}): the reviewer must give a verdict on each by name.`);
    for (const t of protectedTests) lines.push(`- ${t.change}: \`${showName(t.file)}\`${t.to ? ` to \`${showName(t.to)}\`` : ''}`);
  }
  if (weakenings && !weakenings.length) lines.push('Weakenings: none.');
  else if (weakenings) {
    lines.push(`Weakenings (${weakenings.length}): each has the builder's reason and a ruling of "allowed" by a reviewer on another model.`);
    for (const w of weakenings) lines.push(`- ${w.kind}: \`${showName(w.file)}\`${w.to ? ` to \`${showName(w.to)}\`` : ''}. Reason: ${w.reason} Ruled by ${w.ruledBy}.`);
  }
  if (watching.length) {
    lines.push(`Watching only (${watching.length}): these gates are set to "observe". Each would have stopped this merge.`);
    for (const w of watching) lines.push(`- ${w.gate}: ${w.reason}`);
  }
  return lines.join('\n');
}

// The risk label for a change. highRiskPaths works like paperworkPaths: an entry ending in "/" is a
// whole folder, any other entry is one exact file. riskPaths: the entries a changed file matched.
export function riskOf(files, highRiskPaths) {
  const riskPaths = highRiskPaths.filter((p) => files.some((f) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
  return { risk: riskPaths.length ? 'high' : 'normal', riskPaths };
}

// The retry cap's count, from the event log (oldest first): how many times in a row `check` has failed
// on `branch` with no pass of that check in between, and whether the branch was already parked for
// that check in that run of failures. A branch parked for another check is not parked for this one.
// Runs marked observed (a check on "observe") are left out.
export function failStreak(events, branch, check) {
  let fails = 0;
  let parked = false;
  for (const e of events) {
    if (e.branch !== branch || e.data?.check !== check) continue;
    if (e.type === 'slice-parked') parked = true;
    // A run of a check on "observe" stops nothing, so it neither adds to the count nor clears it.
    if (e.type !== 'check-run' || e.data.observed) continue;
    if (e.data.ok === false) fails++;
    else {
      fails = 0;
      parked = false;
    }
  }
  return { fails, parked };
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

// The first line of a gate's failure text, as the reason that goes on record.
export const reasonOf = (text) => cut(String(text).split('\n')[0].replace(/^FAIL\s+/, ''), 300);

// The commits no counted review covers in the way `good` asks: a commit is covered when an approving
// receipt holds its fingerprint and good(receipt) is true. needed and usable come from approvals() in
// scripts/receipt.mjs.
export function uncoveredBy(needed, usable, good) {
  return needed.filter((c) => !usable.some((r) => c.fingerprint && r.fingerprints.some((f) => f.fingerprint === c.fingerprint) && good(r)));
}

// What needs a review, once the newer gates are on. A docs file is still not paperwork for the review
// when it is under a high-risk path (reviewLevels or securityReview) or under the paths of a row of the
// change checklist that fits this change (changeChecklist; items: the rows that fit, "and adds" part
// included, so a row that does not fit asks for nothing; pathMatches: from scripts/checklist.mjs). So a
// commit that touches one gets a fingerprint, and a receipt can hold the answer for it.
// own: the switches of the gate that is asking. A switch widens what needs a review when it enforces,
// or when it is one of own. So a gate that only watches never makes an enforcing gate ask for a receipt:
// the receipts gate asks with own [], and each newer gate with its own switch. With own left out, every
// switch that is not off counts: scripts/receipt.mjs uses that, so the reviewer is shown every commit
// any gate may ask about.
// Returns the scope with that isPaperwork.
export function reviewScope(scope, { items = [], pathMatches, own } = {}) {
  const counts = (name) => (own ? scope.modes[name] === 'enforce' || own.includes(name) : scope.modes[name] !== 'off');
  const risky = counts('reviewLevels') || counts('securityReview');
  const rows = counts('changeChecklist') && pathMatches ? items : [];
  const isPaperwork = (f) => scope.isPaperwork(f)
    && !(risky && riskOf([f], scope.highRiskPaths).riskPaths.length)
    && !rows.some((i) => i.paths.some((p) => pathMatches(p, f)));
  return { ...scope, isPaperwork };
}

// The Verified stamp rule. commits: the branch's own commits that change product code, newest first,
// each { sha, subject, verified } with verified from parseVerified in scripts/commit-msg.mjs (null: no
// line, or one that does not fit the grammar).
// Returns { counts, ok }. counts: how many of those commits carry each word; a commit with no line
// counts as none. ok: at least one says ran or tests, or the newest says none with a reason of
// VERIFIED_REASON_MIN characters or more. No such commit at all is ok too: there is nothing to stamp.
export function verifiedRule(commits) {
  const counts = { ran: 0, tests: 0, checks: 0, none: 0 };
  for (const c of commits) {
    if (!c.verified || c.verified.none) counts.none++;
    else for (const kind of c.verified.kinds) if (kind in counts) counts[kind]++;
  }
  const newest = commits[0]?.verified;
  const excused = Boolean(newest?.none && (newest.note ?? '').length >= VERIFIED_REASON_MIN);
  return { counts, ok: !commits.length || counts.ran + counts.tests > 0 || excused };
}

// The ask filed for Stephen when a slice is parked, inside the limits scripts/ask.mjs enforces.
export function parkedAsk({ branch, check, fails }) {
  return {
    title: 'What should happen to a branch whose checks keep failing?',
    why: `The check "${cut(check, 60)}" failed ${fails} times in a row on ${cut(branch, 100)}, so the agent was told to stop retrying it.`,
    blocks: cut(branch, 120),
    options: ['A: Give the agent a hint and let it try again', 'B: Split the task into smaller ones', 'C: Drop the task'],
  };
}

// `git diff --name-status -z -M` output -> [{ status, file, to? }]; file is the old name of a rename.
export function parseNameStatus(text) {
  const parts = String(text).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i].charAt(0);
    if (!status) continue;
    const file = parts[++i];
    const to = status === 'R' || status === 'C' ? parts[++i] : undefined;
    if (file) out.push(to === undefined ? { status, file } : { status, file, to });
  }
  return out;
}

// The plans a change moved into <plansDir>/completed/ (added there, or renamed into it):
// [{ slice, path }]. Whether each is done is read from its header by the caller.
export function plansMovedToCompleted(entries, plansDir) {
  const done = [];
  for (const e of entries) {
    if (e.status !== 'A' && e.status !== 'R' && e.status !== 'C') continue;
    const path = e.to ?? e.file;
    const m = path.startsWith(`${plansDir}/completed/`) && path.slice(`${plansDir}/completed/`.length).match(/^(\d{3})-[^/]*\.md$/);
    if (m && !(e.status === 'R' && e.file.startsWith(`${plansDir}/completed/`))) done.push({ slice: Number(m[1]), path });
  }
  return done;
}

// True when a plan's header (the lines between the first two "---") says status: done.
export function planIsDone(text) {
  const header = String(text).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  return Boolean(header && /^status:\s*done\s*$/m.test(header[1]));
}

// `git status --porcelain -z` output -> every path it names (both sides of a rename).
export function parseStatusZ(text) {
  const parts = String(text).split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && parts[i + 1]) files.push(parts[++i]);
  }
  return files;
}

const splitZ = (text) => String(text).split('\0').filter(Boolean);

// "2026-11-11T22:15:30.000Z" -> "20261111T221530", safe in a file name.
export function logStamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15);
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'check';

// ---------- Running the checks ----------

// The test files in scripts/, split in two: the starter kit's own (listed in the manifest) and the
// project's. With no manifest, all of them count as the project's. A manifest that cannot be read
// throws, so the run fails loud.
export function splitTests(root) {
  const dir = join(root, 'scripts');
  const onDisk = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `scripts/${f}`) : [];
  const manifestPath = join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { kitTests: [], scriptTests: onDisk };
  let files;
  try {
    files = JSON.parse(readFileSync(manifestPath, 'utf8')).files;
  } catch (e) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON: ${e.message}`);
  }
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error(`${MANIFEST_FILE} must have a "files" object`);
  // A listed test that is missing on disk stays in the list on purpose: the run then fails loud.
  const kitTests = Object.keys(files).filter((p) => /^scripts\/[^/]+\.test\.mjs$/.test(p)).sort();
  return { kitTests, scriptTests: onDisk.filter((f) => !kitTests.includes(f)) };
}

function pruneLogs(dir, now) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.log')) continue;
    try {
      if (now - statSync(join(dir, file)).mtimeMs > MAX_AGE_MS) rmSync(join(dir, file), { force: true });
    } catch {
      // another worktree removed it first; nothing to do
    }
  }
}

// Picks the copy of the rule checker to run. Returns { path, api, cleanup }.
function pickChecker({ lead, baseRef }, ctx) {
  const local = join(ctx.root, 'scripts', 'check-plans.mjs');
  const localCopy = () => {
    let text = '';
    try { text = readFileSync(local, 'utf8'); } catch { /* missing: the run itself then fails loud */ }
    return { path: local, api: checkerApi(text), cleanup: () => {} };
  };
  if (lead) return localCopy();
  const shown = ctx.git(['show', `${baseRef}:scripts/check-plans.mjs`]);
  const api = shown.code === 0 ? checkerApi(shown.stdout) : 0;
  if (api < 2) {
    ctx.print(`Warning: ${baseRef} has no rule checker this script can run from outside; using this branch's own copy.`);
    return localCopy();
  }
  const dir = mkdtempSync(join(tmpdir(), 'kit-trusted-checker-'));
  const path = join(dir, 'check-plans.mjs');
  writeFileSync(path, shown.stdout);
  return { path, api, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Decides whose settings to trust. The base branch's settings say which branches are lead
// branches. A lead branch then uses the worktree's settings (the head agent may change them);
// any other branch uses the base branch's settings for everything.
// Returns { lead, cfg, base }: cfg is the settings to use, base is the base branch's own.
// Throws with a plain message when the settings cannot be trusted.
function pickSettings({ branch, base, baseRef, checkBase = false }, ctx) {
  const shown = ctx.git(['show', `${baseRef}:${ctx.configFile ?? CONFIG_FILE}`]);
  let trusted;
  try {
    trusted = (ctx.parseSettings ?? parseSettingsText)(shown.code === 0 ? shown.stdout : null);
  } catch (e) {
    throw new Error(`The settings on ${baseRef} cannot be read: ${e.message}`);
  }
  const lead = isLeadBranch(branch, base, trusted.leadPrefixes);
  if (lead) {
    let own = ctx.config;
    if (ctx.reloadConfig) {
      try {
        own = ctx.reloadConfig();
      } catch (e) {
        throw new Error(`The settings in this folder cannot be read: ${e.message}`);
      }
    }
    return { lead, cfg: own, base: trusted };
  }
  // The remote (and, with no pull request, the base branch) came from this folder's settings to
  // find the base at all. Only a lead branch may change them.
  const changed = [];
  if (trusted.remote !== ctx.config.remote) changed.push(`"remote" (${ctx.config.remote} here, ${trusted.remote} on ${baseRef})`);
  if (checkBase && trusted.baseBranch !== ctx.config.baseBranch) changed.push(`"baseBranch" (${ctx.config.baseBranch} here, ${trusted.baseBranch} on ${baseRef})`);
  if (changed.length) throw new Error(`This branch's settings change ${changed.join(' and ')}. Only a lead branch may change settings.`);
  return { lead, cfg: trusted, base: trusted };
}

// Runs the planned checks in order and stops at the first failure of a check that is not on "observe".
// Returns { code, results }: code is 0, 1 (a check failed), or 75 (the test slot is busy).
// onRun({ name, ok, ms, observed }) is called for each check that really ran; a remembered pass is not a run.
// A check on "observe" that fails is printed and handed to onRun like any other, then the run goes on:
// its result carries failed: true. what: "merge" or "check", for that printed line.
function runChecks({ planned, branch, lead, baseRef, useCache, who, wait = 0, what = 'merge', onPass = () => {}, onRun = () => {} }, ctx) {
  const results = [];
  const logDir = join(ctx.commonDir, LOG_DIR);
  const cachePath = join(ctx.commonDir, CACHE_FILE);
  const slotScript = join(ctx.root, 'scripts', 'slot.mjs');
  pruneLogs(logDir, ctx.now());

  for (const check of planned) {
    if (check.cached) {
      ctx.print(`pass  ${check.name} (cached: these exact files already passed)`);
      results.push({ name: check.name, cached: true, ms: 0 });
      onPass(check.name);
      continue;
    }
    const logFile = join(logDir, `${logStamp(ctx.now())}-${slug(check.name)}.log`);
    const options = { cwd: ctx.root, logFile, name: check.name };
    const started = ctx.now();
    let outcome;
    if (check.kind === 'rules') {
      const checker = pickChecker({ lead, baseRef }, ctx);
      try {
        outcome = ctx.run(process.execPath, [checker.path, ...checkerArgs({ api: checker.api, root: ctx.root, branch, baseRef })], options);
      } finally {
        checker.cleanup();
      }
    } else if (check.kind === 'nodeTests') {
      outcome = ctx.run(process.execPath, ['--test', ...check.files], options);
    } else if (check.slot && existsSync(slotScript)) {
      const slotArgs = ['tests', '--who', who, '--minutes', String(SLOT_MINUTES)];
      let waited = false;
      try {
        if (wait > 0) {
          const got = waitForSlot({ check, slotScript, slotArgs, wait, logFile }, ctx);
          waited = got.taken;
          if (got.code === EXIT.busy && check.observe) outcome = { code: EXIT.busy, tail: '' };
          else if (got.code !== EXIT.ok) return { code: got.code, results };
        }
        // When the wait took the slot above, `run` sees the same name and keeps the slot for itself.
        outcome ??= ctx.run(process.execPath, [slotScript, 'run', ...slotArgs, '--', 'sh', '-c', check.command], options);
      } finally {
        // `run` gives the slot back when its command ends. This covers every other way out after a
        // wait took it (a run that never started, an error): giving back a free slot is harmless.
        if (waited) ctx.run(process.execPath, [slotScript, 'release', 'tests', '--who', who], { ...options, logFile: logFile.replace(/\.log$/, '-release.log'), name: `${check.name} slot release` });
      }
      if (outcome.code === EXIT.busy && check.observe) {
        // A check that only watches never stops anything, a busy slot included. It did not run, so no run is recorded.
        ctx.print(`watching only: the check "${check.name}" could not run, because the machine's test slot is taken. It is set to "observe", so this ${what} goes on without it.`);
        results.push({ name: check.name, cached: false, ms: 0, notRun: true });
        continue;
      }
      if (outcome.code === EXIT.busy) {
        if (outcome.tail) ctx.print(outcome.tail);
        ctx.print(`busy  ${check.name}: the machine's test slot is taken. Run this again with --wait <seconds> to wait for it.`);
        return { code: EXIT.busy, results };
      }
    } else {
      if (check.slot) ctx.print(`Warning: scripts/slot.mjs is missing, so "${check.name}" runs without taking the test slot.`);
      outcome = ctx.run('sh', ['-c', check.command], options);
    }
    const ms = ctx.now() - started;
    if (outcome.code !== 0) {
      ctx.print(`FAIL  ${check.name} (${seconds(ms)}, exit code ${outcome.code})`);
      if (outcome.tail) ctx.print(outcome.tail);
      ctx.print(`Full output: ${logFile}`);
      onRun({ name: check.name, ok: false, ms, observed: check.observe });
      if (!check.observe) return { code: EXIT.failed, results, failed: check.name };
      ctx.print(`watching only: the check "${check.name}" is set to "observe", so its failure does not stop this ${what}.`);
      results.push({ name: check.name, cached: false, ms, failed: true });
      continue;
    }
    ctx.print(`pass  ${check.name} (${seconds(ms)})`);
    results.push({ name: check.name, cached: false, ms });
    if (useCache && check.key) recordPass(cachePath, check.key, check.name, ctx.now(), ms);
    onRun({ name: check.name, ok: true, ms, observed: check.observe });
    onPass(check.name);
  }
  return { code: EXIT.ok, results };
}

// With --wait: takes the test slot before the check runs, waiting for it if it is busy. The waiting
// itself is `slot.mjs acquire --wait`, so there is one wait loop on the machine, not two.
// Returns { code, taken }: code 0 when the slot is ours, 75 when it stayed busy, 1 on an error.
function waitForSlot({ check, slotScript, slotArgs, wait, logFile }, ctx) {
  const slotLog = logFile.replace(/\.log$/, '-slot.log');
  const ask = (extra) => ctx.run(process.execPath, [slotScript, 'acquire', ...slotArgs, ...extra], { cwd: ctx.root, logFile: slotLog, name: `${check.name} slot` });
  let got = ask([]);
  if (got.code === EXIT.busy) {
    ctx.print(`wait  ${check.name}: the machine's test slot is busy. Waiting up to ${wait} seconds for it.`);
    const started = ctx.now();
    got = ask(['--wait', String(wait)]);
    if (got.code === EXIT.ok) ctx.print(`slot  ${check.name}: got the test slot after ${seconds(ctx.now() - started)}.`);
  }
  if (got.code === EXIT.ok) return { code: EXIT.ok, taken: true };
  if (got.tail) ctx.print(got.tail);
  if (got.code === EXIT.busy) {
    ctx.print(`busy  ${check.name}: waited ${wait} seconds and the machine's test slot is still taken. Run the same command once more; if it is still busy, do other work.`);
    return { code: EXIT.busy, taken: false };
  }
  ctx.print(`FAIL  ${check.name}: could not take the test slot (exit code ${got.code}). Full output: ${slotLog}`);
  // acquire can fail after it granted the slot (for example when it cannot write its health log).
  // taken: true makes the caller release it; release by --who is a no-op when we never held it.
  return { code: EXIT.failed, taken: true };
}

// The merge lock: the machine's `merge` slot, so only one merge at a time reads the remote and
// merges. Returns { code, taken } like waitForSlot: 0 when the lock is ours, 75 busy, 1 an error.
// The pid goes on record, so if this process is killed the lock is free at once, not after its lease.
function takeMergeLock({ slotScript, who, pid, wait }, ctx) {
  const logFile = join(ctx.commonDir, LOG_DIR, `${logStamp(ctx.now())}-merge-lock.log`);
  const ask = (extra) => ctx.run(process.execPath, [slotScript, 'acquire', 'merge', '--who', who, '--pid', String(pid), '--minutes', String(MERGE_LOCK_MINUTES), ...extra], { cwd: ctx.root, logFile, name: 'merge lock' });
  let got = ask([]);
  if (got.code === EXIT.busy && wait > 0) {
    ctx.print(`wait  merge lock: another merge on this machine holds it. Waiting up to ${wait} seconds for it.`);
    got = ask(['--wait', String(wait)]);
  }
  if (got.code === EXIT.ok) return { code: EXIT.ok, taken: true };
  if (got.tail) ctx.print(got.tail);
  if (got.code === EXIT.busy) {
    ctx.print(wait > 0
      ? `busy  merge lock: waited ${wait} seconds and another merge still holds it. Run the same command once more; if it is still busy, do other work.`
      : 'busy  merge lock: another merge on this machine holds it. Run this again with --wait <seconds> to wait for it.');
    return { code: EXIT.busy, taken: false };
  }
  ctx.print(`FAIL  merge lock: could not take it (exit code ${got.code}). Full output: ${logFile}`);
  // As with the test slot, an acquire can fail after it granted; giving back a free lock is harmless.
  return { code: EXIT.failed, taken: true };
}

// Right before the merge call: a fresh lease, and proof the lock is still this merge's. The slot
// refuses a renew when the lease ran out or another merge took over, and then nothing merges.
function renewMergeLock({ slotScript, who }, ctx) {
  const logFile = join(ctx.commonDir, LOG_DIR, `${logStamp(ctx.now())}-merge-lock-renew.log`);
  const r = ctx.run(process.execPath, [slotScript, 'renew', 'merge', '--who', who, '--minutes', String(MERGE_LOCK_MINUTES)], { cwd: ctx.root, logFile, name: 'merge lock renew' });
  if (r.code === 0) return '';
  return `FAIL  merge lock: this merge no longer holds it (its lease ran out, or another merge took it), so the last look at the base branch may be old. Not merged. Run this again. Full output: ${logFile}`;
}

// Only frees the lock while this merge's name is on it: the slot refuses anyone else's release.
function releaseMergeLock({ slotScript, who }, ctx) {
  const logFile = join(ctx.commonDir, LOG_DIR, `${logStamp(ctx.now())}-merge-lock-release.log`);
  const r = ctx.run(process.execPath, [slotScript, 'release', 'merge', '--who', who], { cwd: ctx.root, logFile, name: 'merge lock release' });
  if (r.code !== 0) ctx.print(`Warning: could not give back the merge lock (exit code ${r.code}). Its lease ends by itself within ${MERGE_LOCK_MINUTES} minutes. Full output: ${logFile}`);
}

// With duplicateNumbers on: the files here (tracked, plus new ones not ignored) checked for two
// files on one number. Returns '' when all is well, else the failure text.
function numberClash(numberedPaths, ctx) {
  const listed = ctx.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listed.code !== 0) return `FAIL  numbers: cannot list the files: ${listed.stderr.trim()}`;
  const found = findDuplicateNumbers(splitZ(listed.stdout), numberedPaths);
  if (!found.length) {
    ctx.print('pass  numbers (no two files in a numbered folder share a number)');
    return '';
  }
  return ['FAIL  numbers: two files in one numbered folder share a number. Renumber one, push, and run this again.',
    ...found.map((d) => `  ${d.folder} ${d.number}: ${d.files.join(', ')}`)].join('\n');
}

// With reviewReceipts on: checkReceipts from scripts/receipt.mjs (loaded by the command line), run with
// the trusted settings. Returns null when every commit is covered, else { code, text, refused }
// (refused: true when commits are uncovered, as opposed to the gate itself failing to run).
function receiptGate(baseRef, scope, ctx) {
  if (!ctx.checkReceipts) {
    return { code: EXIT.usage, text: `FAIL  receipts: the reviewReceipts flag is on, but scripts/receipt.mjs cannot be loaded${ctx.receiptsError ? `: ${ctx.receiptsError}` : ''}. Not merged.` };
  }
  const r = ctx.checkReceipts({
    baseRef,
    git: ctx.git,
    models: scope.models,
    isPaperwork: scope.isPaperwork,
    protectedTests: (z) => protectedTestsChanged(z, scope.testPaths),
  });
  for (const note of r.notes ?? []) ctx.print(`note  receipts: ${note}`);
  if (r.fail) return { code: EXIT.failed, text: `FAIL  receipts: ${r.fail}` };
  const n = r.uncovered.length;
  if (!n) {
    ctx.print(`pass  receipts (${r.covered} commit${r.covered === 1 ? '' : 's'} covered by an approving review)`);
    return null;
  }
  return { code: EXIT.failed, refused: true, text: [
    `FAIL  receipts: ${n} commit${n === 1 ? ' has' : 's have'} no approving review receipt from a model other than the builder's and the head agent's:`,
    ...r.uncovered.map((u) => `  ${u.sha.slice(0, 7)} ${u.kind === 'merge' ? 'merge: ' : ''}${u.subject}: ${u.why}`),
    'Get a review, make its receipt (node scripts/receipt.mjs make <reviewer session file>), commit and push it, then run this again.',
  ].join('\n') };
}

// With blockLog on: one JSON line per refusal ("blocked": a failed check, a number clash, an uncovered
// commit, GitHub refusing), per check that passed ("passed"), and per merge ("merged"), appended to
// <git common dir>/kit-block-log.jsonl. The fingerprints are the receipts' own (patch-ids of the code
// commits after the base), so a later pass of the same check on the same fingerprints marks a block as
// mistaken, and new fingerprints mark it as a real catch. memo keeps the tip, tree, and fingerprints
// for one try, so they are worked out once. Never throws: a log that cannot be written is a warning,
// and the refusal stands.
function logBlock({ outcome, check = null, pr, branch, base, baseRef, scope, memo }, ctx) {
  memo.facts ??= blockFacts(baseRef, scope, ctx);
  const line = { at: new Date(ctx.now()).toISOString(), outcome, pr, branch, base, check, ...memo.facts };
  try {
    appendFileSync(join(ctx.commonDir, BLOCK_LOG_FILE), `${JSON.stringify(line)}\n`);
  } catch (e) {
    ctx.print(`Warning: block log: could not write ${join(ctx.commonDir, BLOCK_LOG_FILE)}: ${e.message}`);
  }
}

function blockFacts(baseRef, scope, ctx) {
  let fingerprints = null;
  try {
    if (!ctx.neededCommits) throw new Error('scripts/receipt.mjs cannot be loaded');
    const r = ctx.neededCommits({
      baseRef,
      git: ctx.git,
      isPaperwork: scope.isPaperwork,
      protectedTests: (z) => protectedTestsChanged(z, scope.testPaths),
    });
    if (r.fail) throw new Error(r.fail);
    fingerprints = r.list.map((c) => ({ commit: c.sha, fingerprint: c.fingerprint }));
  } catch (e) {
    ctx.print(`Warning: block log: no fingerprints (${e.message})`);
  }
  return { tip: ctx.git(['rev-parse', 'HEAD']).stdout.trim(), tree: treeOf('HEAD^{tree}', ctx), fingerprints };
}

// With protectedTests on: the existing test files this change touched, printed one per line.
// Returns { list } or { fail } (the failure text) when git cannot list the changes.
function protectedTests(baseRef, testPaths, ctx) {
  const diff = ctx.git(['diff', '--name-status', '-z', '-M', `${baseRef}...HEAD`]);
  if (diff.code !== 0) return { fail: `FAIL  protected tests: cannot list the changed files: ${diff.stderr.trim()}` };
  const list = protectedTestsChanged(diff.stdout, testPaths);
  if (!list.length) ctx.print('note  protected tests: no existing test file changed');
  else {
    ctx.print(`note  protected tests: ${list.length} existing test file${list.length === 1 ? '' : 's'} changed. The reviewer must rule on each by name:`);
    for (const t of list) ctx.print(`  ${t.change.padEnd(9)} ${showName(t.file)}${t.to ? ` -> ${showName(t.to)}` : ''}`);
  }
  return { list };
}

// With testReasons on: every change that weakens a guard, sorted by scripts/test-changes.mjs (loaded by
// the command line as ctx.collectWeakenings). Each needs the builder's reason line. With needRulings (a
// merge), each also needs a ruling of "allowed" on that exact change, by name, from a reviewer on another
// model (ctx.checkWeakenings, from scripts/receipt.mjs). scope: guardScope of the settings in use and
// the base branch's, so the branch's own settings cannot shrink what is sorted or who may rule.
// Returns { items } when all is well, else { code, text, items?, refused } (refused: true when the change
// itself is refused, as opposed to the gate failing to run). An item: { file, to?, kind, what, reason, id,
// ruling?, ruledBy? }.
function weakeningGate({ baseRef, tip = 'HEAD', scope, branch, needRulings }, ctx) {
  const cannot = (file, why) => ({ code: EXIT.usage, text: `FAIL  weakenings: the testReasons flag is on, but ${file} cannot be loaded${why ? `: ${why}` : ''}. Not merged.` });
  if (!ctx.collectWeakenings) return cannot('scripts/test-changes.mjs', ctx.sorterError);
  const found = ctx.collectWeakenings({
    baseRef, tip, git: ctx.git, root: ctx.root, branch, isTest: scope.isTest, extraSettingsFiles: scope.extraSettingsFiles, snapshotPaths: scope.snapshotPaths,
    configFile: ctx.configFile ?? CONFIG_FILE, presetNames: scope.presetNames, readSettings: ctx.readSettings ?? JSON.parse,
  });
  if (found.fail) return { code: EXIT.failed, text: `FAIL  weakenings: ${found.fail}` };
  // For example: a preset taken from this branch because the base branch's copy is in an older form.
  for (const note of found.notes ?? []) ctx.print(`note  weakenings: ${note}`);
  if (found.formattingOnly) ctx.print(`note  weakenings: ${found.formattingOnly} test file${found.formattingOnly === 1 ? '' : 's'} changed in formatting only`);
  const items = found.items;
  const n = items.length;
  if (!n) {
    ctx.print('pass  weakenings (no change weakens a test, a ratchet, or a check)');
    return { items };
  }
  const name = (i) => `${showName(i.file)}${i.to ? ` -> ${showName(i.to)}` : ''}`;
  ctx.print(`note  weakenings: ${n} change${n === 1 ? '' : 's'} that weaken${n === 1 ? 's' : ''} a guard. Each needs the builder's reason and a ruling by a reviewer on another model:`);
  for (const i of items) ctx.print(`  ${i.kind.padEnd(22)} ${name(i)}: ${i.what}`);
  const open = items.filter((i) => !i.id);
  if (open.length) {
    return { code: EXIT.failed, refused: true, items, text: [
      `FAIL  weakenings: ${open.length} of them ${open.length === 1 ? 'has' : 'have'} no reason that will do. Add one line for each to ${found.reasonFile} (make the file if it is not there), commit, push, and run this again:`,
      ...open.map((i) => `  - ${i.file}: <why this change is right, in one plain sentence>   (${i.problem})`),
    ].join('\n') };
  }
  if (!needRulings) {
    ctx.print('pass  weakenings (each has a reason; the reviewer rules on each one before the merge)');
    return { items };
  }
  if (!ctx.checkWeakenings) return cannot('scripts/receipt.mjs', ctx.receiptsError);
  const ruled = ctx.checkWeakenings({ items, tip, git: ctx.git, models: scope.models });
  for (const note of ruled.notes ?? []) ctx.print(`note  weakenings: ${note}`);
  if (ruled.fail) return { code: EXIT.failed, text: `FAIL  weakenings: ${ruled.fail}` };
  const all = items.map((i, at) => ({ ...i, ...ruled.rulings[at] }));
  const stopped = all.filter((i) => i.ruling !== 'allowed');
  if (stopped.length) {
    return { code: EXIT.failed, refused: true, items: all, text: [
      `FAIL  weakenings: ${stopped.length} of them ${stopped.length === 1 ? 'is' : 'are'} not ruled "allowed" by a reviewer on another model:`,
      ...stopped.map((i) => `  ${i.kind.padEnd(22)} ${name(i)}: ${i.ruling === 'refused' ? `refused by ${i.ruledBy}` : i.why}`),
      'A refused change must be changed or taken out. For the others, a reviewer runs "node scripts/receipt.mjs fingerprints <branch>" and rules on each by name ("- <file>: allowed" or "- <file>: refused"). Then make the receipt (node scripts/receipt.mjs make <reviewer session file>), commit and push it, and run this again.',
    ].join('\n') };
  }
  ctx.print(`pass  weakenings (${n} ruled "allowed" by a reviewer on another model)`);
  return { items: all };
}

// With incomingCommits on: the commits on the branch that are not on the base branch, checked as
// commits, in every tier. A hook can be skipped (git commit --no-verify), and the other checks only see
// the final files, so this is where a bad message or a secret that was added and then removed is caught.
//   1. Each commit with one parent must pass the commit message check (ctx.checkMessage, from
//      scripts/commit-msg.mjs). Nothing is added to a message here. A fixup!, squash!, or amend! commit
//      that was never squashed is refused. Only a commit that really has two parents is let off as a
//      merge: a one-parent commit that calls itself "Merge ..." is checked like any other.
//   2. The secret scan (gitleaks) runs over exactly those commits whenever there is at least one, and
//      also reads what each merge commit changed against its first parent (--diff-merges=first-parent):
//      a conflict fixed by hand, or a line slipped into a merge. Every line a merge can add is either in
//      that difference or in a commit that is scanned on its own.
//      The scan settings are the base branch's copy of kit-lint/gitleaks.toml, written to a temp file,
//      so a branch cannot delete or loosen them for its own merge. Only when the base branch has none
//      is the branch's own copy used, and only when neither has one is the scan skipped, with one line.
//      A .gitleaksignore file in the folder would silence the scan, so the check fails while one is there.
// A pass is remembered for one base commit, one head commit, one slice, and one set of scan settings,
// never by the tree: the same files under other commits are other history.
// Returns { code, text, ran, ms, result }: text is the failure, ran says the commits were really read
// (not a remembered pass), result is the line for the pull request comment.
function incomingGate({ baseRef, branch, buildPrefix, useCache }, ctx) {
  if (!ctx.checkMessage) {
    return { code: EXIT.usage, text: `FAIL  ${INCOMING}: the incomingCommits flag is on, but scripts/commit-msg.mjs cannot be loaded${ctx.messageCheckError ? `: ${ctx.messageCheckError}` : ''}. Not merged.` };
  }
  const started = ctx.now();
  const failed = (text) => ({ code: EXIT.failed, ran: true, ms: ctx.now() - started, text });
  // Looked for before a saved pass is reused: the file may have appeared since.
  if (existsSync(join(ctx.root, '.gitleaksignore'))) {
    return failed(`FAIL  ${INCOMING}: there is a .gitleaksignore file in this folder. It tells the secret scan to keep quiet about what it lists, so the scan does not run while it is there. Delete it (rm .gitleaksignore), then remove and replace any real key it was hiding.`);
  }
  const onBase = ctx.git(['show', `${baseRef}:${GITLEAKS_CONFIG}`]);
  const local = join(ctx.root, GITLEAKS_CONFIG);
  const rules = onBase.code === 0 ? onBase.stdout : existsSync(local) ? readFileSync(local, 'utf8') : null;
  const slice = ctx.branchSlice ? ctx.branchSlice(branch, buildPrefix) : null;
  const scan = (config) => ['git', `--log-opts=--diff-merges=first-parent ${baseRef}..HEAD`, '--redact', '--no-banner', '--no-color', '--verbose', '--ignore-gitleaks-allow', '--config', config];
  const id = (ref) => ctx.git(['rev-parse', ref]).stdout.trim();
  const cachePath = join(ctx.commonDir, CACHE_FILE);
  const key = cacheKey(`${id(baseRef)}..${id('HEAD')} slice ${slice ?? 'none'}`, INCOMING, `gitleaks ${scan(rules === null ? 'none' : sha256(rules)).join(' ')}`);
  if (useCache && isCached(readCache(cachePath), key, ctx.now())) {
    ctx.print(`pass  ${INCOMING} (cached: these exact commits already passed)`);
    return { code: EXIT.ok, ran: false, result: { name: INCOMING, cached: true, ms: 0 } };
  }
  const listed = ctx.git(['log', '--format=%H%x1f%P%x1f%B%x1e', `${baseRef}..HEAD`]);
  if (listed.code !== 0) return failed(`FAIL  ${INCOMING}: cannot list the commits after ${baseRef}: ${listed.stderr.trim()}`);
  const commits = parseCommitLog(listed.stdout);
  const commitExists = (sha) => ctx.git(['cat-file', '-e', `${sha.toLowerCase()}^{commit}`]).code === 0;
  const bad = [];
  for (const c of commits.filter((x) => !x.merge)) {
    const subject = c.message.split('\n')[0];
    const who = `  ${c.sha.slice(0, 7)} ${JSON.stringify(cut(subject, 70))}:`;
    const left = subject.match(/^(fixup|squash|amend)! /);
    if (left) bad.push(`${who} a ${left[1]}! commit is still here. Squash it into the commit it belongs to first (git rebase --autosquash ${baseRef}), or give it a real message.`);
    else if (/^Merge /.test(subject)) bad.push(`${who} this commit has one parent, so it is not a merge. Its first line must look like "type: description".`);
    else for (const problem of ctx.checkMessage(c.message, { slice, commitExists }).problems) bad.push(`${who} ${problem}`);
  }
  if (bad.length) {
    const n = new Set(bad.map((line) => line.slice(0, 9))).size;
    return failed([
      `FAIL  ${INCOMING}: ${n} commit message${n === 1 ? '' : 's'} on this branch would not pass the commit message check (scripts/commit-msg.mjs):`,
      ...bad,
      'Reword each one (the newest with "git commit --amend", an older one with a rebase), push, and run this again.',
    ].join('\n'));
  }
  let what = 'messages';
  if (rules === null) {
    ctx.print(`note  ${INCOMING}: no ${GITLEAKS_CONFIG} in this project, so the secret scan of the new commits is skipped. The project has not taken the kit's lint folder yet.`);
  } else if (commits.length) {
    what = 'messages and secret scan';
    const logFile = join(ctx.commonDir, LOG_DIR, `${logStamp(ctx.now())}-${slug(INCOMING)}.log`);
    // The base branch's settings go to a temp file for the length of the scan.
    const dir = onBase.code === 0 ? mkdtempSync(join(tmpdir(), 'kit-trusted-gitleaks-')) : null;
    let scanned;
    try {
      if (dir) writeFileSync(join(dir, 'gitleaks.toml'), rules);
      scanned = ctx.run('gitleaks', scan(dir ? join(dir, 'gitleaks.toml') : GITLEAKS_CONFIG), { cwd: ctx.root, logFile, name: INCOMING });
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    const tail = `${scanned.tail ? `\n${scanned.tail}` : ''}\nFull output: ${logFile}`;
    if (scanned.code === 127) return failed(`FAIL  ${INCOMING}: the secret scan needs gitleaks, and it is not installed. Install it: brew install gitleaks`);
    if (scanned.code === 1) return failed(`FAIL  ${INCOMING}: the secret scan found a secret in the commits on this branch. The key is in git history even if a later commit removed it, so replace it at the service that issued it.${tail}`);
    if (scanned.code !== 0) return failed(`FAIL  ${INCOMING}: the secret scan could not run (gitleaks exit code ${scanned.code}).${tail}`);
  }
  const ms = ctx.now() - started;
  ctx.print(`pass  ${INCOMING} (${commits.length} commit${commits.length === 1 ? '' : 's'}: ${what}, ${seconds(ms)})`);
  if (useCache) recordPass(cachePath, key, INCOMING, ctx.now(), ms);
  return { code: EXIT.ok, ran: true, ms, result: { name: INCOMING, cached: false, ms } };
}

// `git log --format=%H%x1f%P%x1f%B%x1e` output -> [{ sha, merge, message }], newest first. merge: the
// commit really has two parents or more.
export function parseCommitLog(text) {
  return String(text).split('\x1e').map((c) => c.replace(/^\n+/, '')).filter((c) => c.trim()).map((c) => {
    const [sha, parents, ...message] = c.split('\x1f');
    return { sha, merge: parents.trim().split(/\s+/).length > 1, message: message.join('\x1f') };
  });
}

// Runs one gate under its mode. run() returns null when the gate has nothing against the change, else
// what it would stop with: { code, text, refused? }.
//   off      the gate is not run.
//   enforce  the stop goes back to the caller. An error thrown inside the gate (a reader that cannot
//            find a branch, a script that cannot be loaded) becomes a stop with exit code 1 and that message.
//   observe  nothing goes back, ever. A stop, or a thrown error, is printed as one "watching only" line
//            (then the rest of what the gate had to say) and its reason is handed to onWatch.
// name: the switch. label: the gate's short name in printed lines. what: "merge" or "check".
function underMode({ name, mode, label, what, onWatch = () => {} }, run, ctx) {
  if (mode === 'off') return null;
  let out;
  try {
    out = run();
  } catch (e) {
    out = { code: EXIT.failed, text: `FAIL  ${label}: ${e.message}` };
  }
  if (!out) return null;
  if (mode !== 'observe') return out;
  const [, ...rest] = String(out.text).split('\n');
  ctx.print([`watching only: ${name} would have stopped this ${what}: ${reasonOf(out.text)}`, ...rest].join('\n'));
  onWatch(reasonOf(out.text));
  return null;
}

// A function from another script, or a plain error when that script could not be loaded.
function loaded(fn, flag, file, why) {
  if (!fn) throw new Error(`the ${flag} switch is on, but ${file} cannot be loaded${why ? `: ${why}` : ''}`);
  return fn;
}

// fn's answer, worked out at the first call and kept. An error is kept too, and thrown again each time.
function once(fn) {
  let kept;
  return () => {
    if (!kept) {
      try {
        kept = { value: fn() };
      } catch (error) {
        kept = { error };
      }
    }
    if (kept.error) throw kept.error;
    return kept.value;
  };
}

// Says which checks this branch moved to "observe" while the base branch still enforces them.
function printHeld(scope, ctx) {
  for (const name of scope.heldChecks) ctx.print(`note  checks: "${name}" is set to "observe" on this branch, but the base branch still enforces it, so it enforces here too.`);
}

const several = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const RECEIPT_STEPS = 'Then make the receipt (node scripts/receipt.mjs make <reviewer session file>), commit and push it, and run this again.';

// With verifiedStamp on: the Verified line of the branch's own commits that change product code
// (scope.isProduct). A commit with two parents counts by what was done by hand while combining the two
// sides (the difference from git's own merge, the same change its receipt fingerprint covers): a merge
// git did by itself changed nothing by hand and is left out.
// Returns { counts, text }: counts goes into the `merged` event; text is '' when the rule in
// verifiedRule is met, else the failure. Throws a plain error when git or the reader fails.
function verifiedGate({ baseRef, scope }, ctx) {
  const parse = loaded(ctx.parseVerified, 'verifiedStamp', 'scripts/commit-msg.mjs', ctx.messageCheckError);
  const listed = ctx.git(['log', '--format=%H%x1f%P%x1f%B%x1e', `${baseRef}..HEAD`]);
  if (listed.code !== 0) throw new Error(`cannot list the commits after ${baseRef}: ${listed.stderr.trim()}`);
  const commits = [];
  const all = parseCommitLog(listed.stdout);
  for (const c of all) {
    const files = c.merge
      ? ctx.git(['show', '--remerge-diff', '--format=', '--name-only', '-z', c.sha])
      : ctx.git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', c.sha]);
    if (files.code !== 0) throw new Error(`cannot list the files of commit ${c.sha.slice(0, 7)}: ${files.stderr.trim()}`);
    if (splitZ(files.stdout).some(scope.isProduct)) commits.push({ sha: c.sha, subject: c.message.split('\n')[0], verified: parse(c.message) });
  }
  const { counts, ok } = verifiedRule(commits);
  const n = commits.length;
  if (ok) {
    ctx.print(n ? `pass  verified (${several(n, 'commit changes', 'commits change')} product code: ${counts.ran} say ran, ${counts.tests} say tests)` : 'pass  verified (no commit on this branch changes product code)');
    return { counts, text: '' };
  }
  const says = (v) => (v ? `it says "Verified: ${v.none ? 'none' : v.kinds.join(', ')}"` : 'it has no Verified line that can be read');
  const id = commits[0].sha.slice(0, 7);
  const last = all[0]; // the tip of the branch, a merge commit included: that is what "git commit --amend" rewords
  return { counts, text: [
    `FAIL  verified: ${n === 1 ? 'the one commit on this branch that changes product code does not say' : `none of the ${n} commits on this branch that change product code says`} the change was tried.`,
    ...commits.map((c) => `  ${c.sha.slice(0, 7)} ${JSON.stringify(cut(c.subject, 70))}: ${says(c.verified)}`),
    'The Verified line goes in the last block of a commit message: "Verified: <kinds>", "Verified: none", or "Verified: none (<reason>)". The kinds, in a comma list: ran (the app was run and the change tried), tests (the test files for the change were run), checks (format, lint, types).',
    `The newest commit that changes product code is ${id}. ${last?.sha === commits[0].sha
      ? `It is the last commit made on this branch, so "git commit --amend" rewords it.`
      : `It is not the last commit made on this branch${last ? ` (${last.sha.slice(0, 7)} is)` : ''}, so "git commit --amend" would reword the wrong one.`}`,
    `To pass: try the change (docs/verify.md says how). Then either end the message of your next commit that changes product code with "Verified: ran" or "Verified: tests", or reword one of the commits listed above to say so. If the change cannot be tried, ${id} itself must say why, in ${VERIFIED_REASON_MIN} characters or more: "Verified: none (<reason>)".`,
    'A new empty commit, or a commit that changes only docs, does not count: it changes no product code. Push, and run this again.',
  ].join('\n') };
}

// With changeChecklist on: the rows of the change checklist that fit this change (list: what
// ctx.checklistFor, from scripts/checklist.mjs, read; it joins the base branch's copy with the branch's).
// Each row needs "ok" or "does not apply" in a review that counts (approved() gives those), and that
// review must cover the newest commit that touches the row's paths: an answer given before a later edit
// to the same files is not an answer about that edit. With no such commit among those that need a review,
// the newest of them is asked for. With no commit to hold a review at all, the row stays open.
// Returns { ids, text }: ids goes into the `merged` event.
function checklistGate({ list, approved }, ctx) {
  const ids = list.matched.map((i) => i.id);
  if (!ids.length) {
    ctx.print(list.present ? 'pass  checklist (no row of the change checklist fits this change)' : 'note  checklist: this project has no change checklist yet (docs/change-checklist.md), so there is nothing to answer');
    return { ids, text: '' };
  }
  const fits = loaded(ctx.pathMatches, 'changeChecklist', 'scripts/checklist.mjs', ctx.checklistError);
  const { needed, usable } = approved();
  const whyOpen = (item) => {
    const trigger = [...needed].reverse().find((c) => (c.files ?? []).some((f) => item.paths.some((p) => fits(p, f)))) ?? needed.at(-1);
    if (!trigger) return 'no commit of this change has a review receipt that could hold the answer';
    const said = usable.filter((r) => trigger.fingerprint && r.fingerprints.some((f) => f.fingerprint === trigger.fingerprint))
      .flatMap((r) => r.checklist ?? []).filter((a) => a.id === item.id).map((a) => a.answer);
    if (said.some((a) => a === 'ok' || a === 'does not apply')) return '';
    if (said.includes('finding')) return 'the reviewer wrote "finding": fix it, then have it reviewed again';
    return `no answer in an approving receipt that covers ${trigger.sha.slice(0, 7)}, the newest commit that touches it`;
  };
  const open = list.matched.map((item) => ({ item, why: whyOpen(item) })).filter((o) => o.why);
  if (!open.length) {
    ctx.print(`pass  checklist (${ids.join(', ')}: answered in an approving review of the newest commit that touches each)`);
    return { ids, text: '' };
  }
  return { ids, text: [
    `FAIL  checklist: ${several(open.length, 'row of the change checklist has', 'rows of the change checklist have')} no "ok" or "does not apply" in an approving review receipt from a model other than the builder's and the head agent's:`,
    ...open.map((o) => `  ${o.item.id}: ${o.item.check}   (${o.why})`),
    `The reviewer runs "node scripts/receipt.mjs fingerprints <branch>" and answers each kit-checklist line it prints, in the CHECKLIST part of its reply: "- CL-3: ok" or "- CL-3: does not apply, <why>". ${RECEIPT_STEPS}`,
  ].join('\n') };
}

const coveredList = (open) => open.map((c) => `  ${c.sha.slice(0, 7)} ${c.kind === 'merge' ? 'merge: ' : ''}${c.subject}`);

// With reviewLevels on: every commit that needs a review must be covered by an approving receipt whose
// level is at least the level the code works out (want, from scripts/review-level.mjs). A receipt with no
// level is a standard review. Returns '' or the failure text.
function levelGate({ want, approved }, ctx) {
  const { needed, usable } = approved();
  const rank = (level) => LEVEL_ORDER.indexOf(level ?? 'standard');
  const open = uncoveredBy(needed, usable, (r) => rank(r.level) >= rank(want.level));
  // A deep change always has something to review, whatever kind of file it is in.
  const none = want.level === 'deep' && !needed.length;
  if (!open.length && !none) {
    ctx.print(`pass  review level (${want.level}: ${want.why})`);
    return '';
  }
  return [
    `FAIL  review level: this change needs a ${want.level} review, and ${none ? 'no approving receipt covers it at all. A receipt' : `${several(open.length, 'commit has', 'commits have')} no approving receipt at that level`} from a model other than the builder's and the head agent's${none ? ' is needed' : ''}.`,
    `  Why ${want.level}: ${want.why}.`,
    ...coveredList(open),
    `The reviewer runs "node scripts/receipt.mjs fingerprints <branch>", reviews at the level on the kit-level line it prints, and writes "LEVEL: ${want.level}" in its reply. ${RECEIPT_STEPS}`,
  ].join('\n');
}

// With securityReview on: when the level the code works out is deep, every commit that needs a review
// must be covered by an approving receipt that says "SECURITY: clear". Returns '' or the failure text.
function securityGate({ want, approved }, ctx) {
  if (want.level !== 'deep') {
    ctx.print(`pass  security review (not needed: the review level is ${want.level})`);
    return '';
  }
  const { needed, usable } = approved();
  const open = uncoveredBy(needed, usable, (r) => r.security === 'clear');
  // "Clear" is only ever said of a receipt that was read: no commit to cover is not a pass.
  if (needed.length && !open.length) {
    ctx.print('pass  security review (an approving review says the security pass is clear)');
    return '';
  }
  return [
    `FAIL  security review: this change needs a deep review, and ${needed.length ? several(open.length, 'commit has', 'commits have') : 'it has'} no approving receipt that says "SECURITY: clear" from a model other than the builder's and the head agent's.`,
    `  Why deep: ${want.why}.`,
    ...coveredList(open),
    `The reviewer does the security pass and writes "SECURITY: clear" in its reply. An open security finding ("SECURITY: open") must be fixed first. ${RECEIPT_STEPS}`,
  ].join('\n');
}

// With findingAnswers on: every finding a review round counted needs one answer line from the builder
// in the branch's findings file (ctx.findingsFor, from scripts/findings.mjs: the receipts the branch
// added are rounds 1, 2, 3 in time order). Returns { answers, text }: answers become `finding` events.
function findingsGate({ baseRef, branch }, ctx) {
  const found = loaded(ctx.findingsFor, 'findingAnswers', 'scripts/findings.mjs', ctx.findingsError)(ctx.root, { base: baseRef, branch: 'HEAD', name: branch });
  for (const problem of found.problems) ctx.print(`note  findings: ${found.file}, ${problem}`);
  for (const note of found.notes ?? []) ctx.print(`note  findings: ${note}`);
  const unchecked = found.unchecked ?? [];
  if (unchecked.length) {
    // The counts say how many answers are owed. A count nobody can check against the reviewer's own record could have been edited down.
    return { answers: found.answers, text: [
      `FAIL  findings: the counts of ${several(unchecked.length, 'review receipt', 'review receipts')} on this branch cannot be checked against the reviewer's session record, so how many answers are owed is not known.`,
      ...unchecked.map((path) => `  ${path}`),
      'Either put each session record back at the path its receipt names (the "session" line inside the receipt file), or make the receipt again from where the record is now (node scripts/receipt.mjs make <reviewer session file>) and delete the old receipt file in the same commit. The old file must go: while it is on the branch it still counts as a round nobody can check. Then push, and run this again.',
    ].join('\n') };
  }
  const n = found.owed.reduce((sum, o) => sum + o.missing.length, 0);
  if (!n) {
    ctx.print(`pass  findings (${several(found.rounds.length, 'review round', 'review rounds')}, ${several(found.answers.length, 'answer', 'answers')})`);
    return { answers: found.answers, text: '' };
  }
  const line = (round, k) => (ctx.answerLine ? ctx.answerLine(round, k) : `- R${round}.${k} <label>: <outcome>: <note>`);
  return { answers: found.answers, text: [
    `FAIL  findings: ${several(n, 'review finding has', 'review findings have')} no answer line in ${found.file}.`,
    ...found.owed.flatMap((o) => o.missing.map((k) => `  ${line(o.round, k)}`)),
    `The builder adds one line like these for each to ${found.file} (make the file if it is not there), commits, and pushes. Then run this again.`,
  ].join('\n') };
}

// The event writer for one run of this script. on: features.events. branch: the branch the events are
// about. Returns write(type, data, extra) -> the event, or null when nothing was written. It never
// throws: an event that cannot be written prints one line, and the check or the merge carries on.
function recorder({ on, branch }, ctx) {
  return (type, data, extra = {}) => {
    if (!on) return null;
    try {
      if (!ctx.appendEvent) throw new Error(ctx.eventsError || 'scripts/events.mjs cannot be loaded');
      return ctx.appendEvent(ctx.root, { type, data, branch: branch || null, ...extra }, { now: ctx.now() });
    } catch (e) {
      ctx.print(`Warning: event log: no ${type} event was written (${e.message}). Carrying on.`);
      return null;
    }
  };
}

// The retry cap, after a failed run of `check` was written to the event log. On the third failure in a
// row it files one ask for Stephen and writes `slice-parked`; from then on it only repeats the message.
// It blocks nothing and never throws.
function retryCap({ branch, check, slice, write }, ctx) {
  if (!branch) return;
  try {
    if (!ctx.readEvents) throw new Error(ctx.eventsError || 'scripts/events.mjs cannot be loaded');
    const { fails, parked } = failStreak(ctx.readEvents(ctx.root, { types: ['check-run', 'slice-parked'] }).events, branch, check);
    if (fails < RETRY_CAP) return;
    let filed = 'An ask for Stephen is already filed.';
    if (!parked) {
      if (!ctx.newAsk) throw new Error(ctx.askError || 'scripts/ask.mjs cannot be loaded');
      const ask = ctx.newAsk(ctx.root, { ...parkedAsk({ branch, check, fails }), slice });
      write('slice-parked', { check, ask: ask.id });
      filed = `An ask for Stephen was filed (id ${ask.id}).`;
    }
    ctx.print(`STOP  "${check}" has now failed ${fails} times in a row on ${branch}. Stop retrying it. ${filed} Move to other work until he answers.`);
  } catch (e) {
    ctx.print(`Warning: retry cap: ${e.message}. Carrying on.`);
  }
}

// After GitHub confirms a merge, with events on: the `merged` event, one `weakening` event per ruled
// weakening, and for each plan the merge moved into completed/ as done, `slice-closed` plus a `task-done`
// (auto: true) for each task nobody logged as done or dropped. Never throws.
// more: the fields the newer gates add to `merged` (verified, level, checklist), each only when its gate
// ran. answers: the builder's answers to review findings, one `finding` event each (findingAnswers on).
function recordMerge({ pr, tier, baseRef, cfg, risk, weak, testReasons, more = {}, answers = [], write }, ctx) {
  try {
    const stat = ctx.git(['diff', '--numstat', `${baseRef}...HEAD`]);
    const names = ctx.git(['diff', '--name-status', '-z', '-M', `${baseRef}...HEAD`]);
    if (stat.code !== 0 || names.code !== 0) throw new Error(`cannot read the merged change: ${(stat.stderr || names.stderr).trim()}`);
    const rows = stat.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
    const sum = (at) => rows.reduce((total, r) => total + (Number(r[at]) || 0), 0);
    const entries = parseNameStatus(names.stdout);
    const testsAdded = entries.filter((e) => (e.status === 'A' || e.status === 'C') && isTestFile(e.to ?? e.file, cfg.testPaths)).length;
    write('merged', { pr, tier, files: rows.length, added: sum(0), removed: sum(1), risk: risk.risk, riskPaths: risk.riskPaths, testsAdded, testReasons, ...more });
    for (const w of weak ?? []) write('weakening', { pr, kind: w.kind, file: w.file, reason: w.reason, ruling: w.ruling, ruledBy: w.ruledBy });
    for (const a of answers) write('finding', { pr, round: a.round, n: a.n, label: String(a.label).toLowerCase(), outcome: a.outcome });
    for (const plan of plansMovedToCompleted(entries, cfg.plansDir)) {
      const shown = ctx.git(['show', `HEAD:${plan.path}`]);
      if (shown.code !== 0 || !planIsDone(shown.stdout)) continue;
      write('slice-closed', { pr }, { slice: plan.slice });
      if (!ctx.parseTasks || !ctx.taskStates || !ctx.readEvents) throw new Error('scripts/slice.mjs cannot be loaded, so unlogged tasks were not marked done');
      const events = ctx.readEvents(ctx.root, { types: ['task-started', 'task-done', 'task-dropped'] }).events;
      for (const task of ctx.taskStates(ctx.parseTasks(shown.stdout), events, plan.slice)) {
        if (task.state !== 'done' && task.state !== 'dropped') write('task-done', { task: task.n, title: task.title, note: null, auto: true }, { slice: plan.slice });
      }
    }
  } catch (e) {
    ctx.print(`Warning: event log: ${e.message}. The merge is done.`);
  }
}

// The onRun callback for runChecks: one `check-run` event per check that really ran, and after a
// failure that was written, the retry cap. head: the short id of the commit that was checked, or null
// when unsaved files were checked with it. observed: true marks a check on "observe"; its failure
// stops nothing, so it never counts toward the retry cap.
function checkRunWriter({ tier, pr, mode, branch, head, write }, ctx) {
  return ({ name, ok, ms, observed }) => {
    const event = write('check-run', { check: name, ok, ms, tier, pr, mode, head, ...(observed ? { observed: true } : {}) });
    if (event && !ok && !observed) retryCap({ branch, check: name, slice: event.slice, write }, ctx);
  };
}

// Whether the base branch's settings have events on. False when they cannot be read: the settings
// are read again, and fail loud, right after the merge of the base branch.
function baseEvents(baseRef, ctx) {
  try {
    const shown = ctx.git(['show', `${baseRef}:${ctx.configFile ?? CONFIG_FILE}`]);
    return (ctx.parseSettings ?? parseSettingsText)(shown.code === 0 ? shown.stdout : null).features.events;
  } catch {
    return false;
  }
}

// Says the risk label, when the settings list any high-risk paths.
function printRisk(risk, scope, ctx) {
  if (!scope.highRiskPaths.length) return;
  ctx.print(risk.risk === 'high' ? `note  risk: high (touches ${risk.riskPaths.map(showName).join(', ')})` : 'note  risk: normal');
}

function printSkipped(skipped, ctx) {
  const docs = skipped.filter((s) => s.why === 'docs-only').map((s) => s.name);
  const fast = skipped.filter((s) => s.why === 'fast').map((s) => s.name);
  if (docs.length) ctx.print(`skip  ${docs.join(', ')} (docs-only change)`);
  if (fast.length) ctx.print(`skip  ${fast.join(', ')} (--fast: runs at merge time)`);
}

// A tree hash, or '' when git cannot give one (for example a repo with no scripts folder).
function treeOf(spec, ctx) {
  const r = ctx.git(['rev-parse', '-q', '--verify', spec]);
  return r.code === 0 ? r.stdout.trim() : '';
}

// ---------- The two flows ----------
// ctx: { root, commonDir, config, git(args), gh(args, { timeoutMs }), run(command, args, { cwd, logFile, name }), print(line), now() }
//   config is this folder's settings. git and gh return { code, stdout, stderr }. run returns
//   { code, tail } and writes the full output to logFile.
//   Optional: configFile (path of the settings file), parseSettings(text or null) to check settings
//   text with the checker's own loader, reloadConfig() to read this folder's settings again,
//   checkReceipts, neededCommits, and checkWeakenings (from scripts/receipt.mjs) or receiptsError (why it
//   could not be loaded). collectWeakenings (scripts/test-changes.mjs) or sorterError, and readSettings
//   (settings text -> settings with defaults, for comparing the base's with the branch's). appendEvent and
//   readEvents (scripts/events.mjs) or eventsError. newAsk (scripts/ask.mjs) or askError. parseTasks and
//   taskStates (scripts/check-plans.mjs and scripts/slice.mjs). checkMessage and branchSlice
//   (scripts/commit-msg.mjs) or messageCheckError. Each is used only when its flag is on.
//   For the newer gates: parseVerified (scripts/commit-msg.mjs), approvals (scripts/receipt.mjs),
//   checklistFor (scripts/checklist.mjs) or checklistError, levelFor (scripts/review-level.mjs) or
//   levelError, findingsFor and answerLine (scripts/findings.mjs) or findingsError.
//   git may take a second argument: text for git's stdin.

// --check: run the checks for the current branch. Changes nothing on GitHub or in git.
export function checkOnly(opts, ctx) {
  // No pull request here, so the base branch comes from this folder's settings.
  const { remote, baseBranch } = ctx.config;
  const baseRef = `${remote}/${baseBranch}`;
  const branchRead = ctx.git(['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = branchRead.code === 0 ? branchRead.stdout.trim() : '';
  let picked;
  try {
    picked = pickSettings({ branch, base: baseBranch, baseRef, checkBase: true }, ctx);
  } catch (e) {
    ctx.print(e.message);
    return EXIT.usage;
  }
  const { lead } = picked;
  // What the base branch's settings and the settings in use protect, together. A switch the base
  // branch has on stays in force for a branch that turns it off: that edit is itself ruled on.
  const scope = guardScope(picked.cfg, picked.base);
  const { checks } = scope;
  printHeld(scope, ctx);
  // Each gate runs under its mode. One on "observe" says what it would have stopped and lets the check
  // go on. No `would-block` event is written here: the merge writes it, once, with the pull request.
  const gate = (name, label, run) => underMode({ name, mode: scope.modes[name], label, what: 'check' }, run, ctx);
  const halt = (stopped) => {
    ctx.print(stopped.text);
    return stopped.code;
  };
  // No base branch is merged in here, so this sees only this branch's files; the merge sees both.
  const clash = gate('duplicateNumbers', 'numbers', () => {
    const text = numberClash(scope.numberedPaths, ctx);
    return text ? { code: EXIT.failed, text } : null;
  });
  if (clash) return halt(clash);
  // Committed changes only: unsaved edits to a test are not listed until they are committed.
  const lost = gate('protectedTests', 'protected tests', () => {
    const touched = protectedTests(baseRef, scope.testPaths, ctx);
    return touched.fail ? { code: EXIT.failed, text: touched.fail } : null;
  });
  if (lost) return halt(lost);
  // Reasons are checked here; the reviewer's rulings only at the merge, since the review comes later.
  // The newer gates (Verified stamp, checklist, review level, security review, finding answers) also
  // run only at the merge: they read the finished branch and its reviews.
  const weakened = gate('testReasons', 'weakenings', () => {
    const found = weakeningGate({ baseRef, scope, branch, needRulings: false }, ctx);
    return found.code === undefined ? null : found;
  });
  if (weakened) return halt(weakened);
  const unsaved = parseStatusZ(ctx.git(['status', '--porcelain', '-z']).stdout);

  let tier = 'code';
  // --no-renames: a renamed file is listed under both names, so the old folder still counts.
  const diff = ctx.git(['diff', '--name-only', '-z', '--no-renames', `${baseRef}...HEAD`]);
  if (diff.code === 0) {
    tier = [...splitZ(diff.stdout), ...unsaved].every(scope.isPaperwork) ? 'paperwork' : 'code';
    printRisk(riskOf([...splitZ(diff.stdout), ...unsaved], scope.highRiskPaths), scope, ctx);
  } else ctx.print(`Warning: cannot compare with ${baseRef}, so this counts as a code change.`);

  // Unsaved files are not part of the tree hash, so a remembered pass would be about other files.
  const useCache = !opts.noCache && unsaved.length === 0;
  if (!opts.noCache && unsaved.length > 0) ctx.print('Note: unsaved files here, so remembered passes are not used.');
  const tree = treeOf('HEAD^{tree}', ctx);
  const scriptsTree = treeOf('HEAD:scripts', ctx);
  const cache = useCache ? readCache(join(ctx.commonDir, CACHE_FILE)) : null;
  let tests;
  try {
    tests = splitTests(ctx.root);
  } catch (e) {
    ctx.print(e.message);
    return EXIT.usage;
  }
  const { planned, skipped } = planChecks({ tier, checks, fast: opts.fast, ...tests, tree, scriptsTree, cache, now: ctx.now() });

  ctx.print(`Checks for ${branch || 'this commit'} (tier: ${tier})`);
  const who = opts.who || `merge-pr --check ${branch || 'detached'}`;
  const write = recorder({ on: scope.events, branch }, ctx);
  // With unsaved files, what was checked is not the commit, so no commit is named.
  const checked = scope.events && !unsaved.length ? ctx.git(['rev-parse', 'HEAD']).stdout.trim().slice(0, 7) || null : null;
  const onRun = checkRunWriter({ tier, pr: null, mode: 'check', branch, head: checked, write }, ctx);
  let passed = 0;
  const incoming = gate('incomingCommits', INCOMING, () => {
    // Commits are not changed by unsaved files, so a remembered pass still counts here.
    const found = incomingGate({ baseRef, branch, buildPrefix: picked.cfg.buildPrefix, useCache: !opts.noCache }, ctx);
    if (found.ran) onRun({ name: INCOMING, ok: found.code === EXIT.ok, ms: found.ms, observed: scope.modes.incomingCommits === 'observe' });
    if (found.code !== EXIT.ok) return found;
    passed = 1;
    return null;
  });
  if (incoming) return halt(incoming);
  const ran = runChecks({ planned, branch, lead, baseRef, useCache, who, wait: opts.wait, what: 'check', onRun }, ctx);
  if (ran.code !== EXIT.ok) return ran.code;
  printSkipped(skipped, ctx);
  const watched = ran.results.filter((r) => r.failed || r.notRun).length;
  const good = passed + ran.results.length - watched;
  ctx.print(watched
    ? `${several(good, 'check', 'checks')} passed. ${several(watched, 'check on "observe"', 'checks on "observe"')} failed or could not run, and stopped nothing. Nothing was pushed or merged.`
    : `All ${good} checks passed. Nothing was pushed or merged.`);
  return EXIT.ok;
}

// <pr-number>: the merge ritual. With the merge lock on, the lock is given back on every way out.
// The lock's owner name holds this process's pid and folder, so two merges never share one name
// (two projects merging #42 at once), and neither can renew or release the other's hold.
export function mergePr(opts, ctx) {
  const pid = ctx.pid ?? process.pid;
  const lock = { held: false, slotScript: join(ctx.root, 'scripts', 'slot.mjs'), pid, who: `${opts.who || `merge-pr #${opts.pr}`} (pid ${pid}, ${ctx.root})` };
  try {
    return mergeSteps(opts, ctx, lock);
  } finally {
    if (lock.held) releaseMergeLock(lock, ctx);
  }
}

function mergeSteps(opts, ctx, lock) {
  // The remote's name comes from this folder's settings, only to find the base branch at all.
  // pickSettings refuses a branch that is not a lead branch and names a different remote.
  const { remote } = ctx.config;
  // The event writer. It is set once the pull request's branch is known, from this folder's settings,
  // and again from the settings to trust once those are picked.
  let write = () => null;
  // Every way out with exit code 1 is a merge that was stopped: one `merge-blocked` event each.
  const blocked = (reason, check = null) => write('merge-blocked', { pr: opts.pr, reason: cut(String(reason).split('\n')[0].replace(/^FAIL\s+/, ''), 300), check });
  const stop = (code, message) => {
    ctx.print(message);
    if (code === EXIT.failed) blocked(message);
    return code;
  };
  const sha = (ref) => ctx.git(['rev-parse', ref]).stdout.trim();

  // 1. The pull request must be open, and not a draft unless --ready.
  const view = ctx.gh(['pr', 'view', String(opts.pr), '--json', 'number,state,isDraft,headRefName,baseRefName']);
  if (view.code !== 0) return stop(EXIT.usage, `Cannot read pull request #${opts.pr}: ${(view.stderr || view.stdout).trim()}`);
  let pr;
  try {
    pr = JSON.parse(view.stdout);
  } catch {
    return stop(EXIT.usage, `Cannot read pull request #${opts.pr}: gh did not answer in JSON.`);
  }
  if (pr.state !== 'OPEN') return stop(EXIT.usage, `Pull request #${opts.pr} is ${String(pr.state).toLowerCase()}, not open.`);
  if (pr.isDraft && !opts.ready) return stop(EXIT.usage, `Pull request #${opts.pr} is a draft. Add --ready to mark it ready and merge it.`);
  const head = pr.headRefName;
  const base = pr.baseRefName;
  const headRef = `${remote}/${head}`;
  const baseRef = `${remote}/${base}`;
  write = recorder({ on: ctx.config.features.events, branch: head }, ctx);

  // 2. Nothing unsaved, the newest remote state, and this folder must hold the pull request's commits.
  const status = ctx.git(['status', '--porcelain']).stdout;
  if (status.trim()) return stop(EXIT.usage, `Unsaved or new files here. Commit or remove them first:\n${status.trimEnd()}`);
  const fetched = ctx.git(['fetch', '-q', remote]);
  if (fetched.code !== 0) return stop(EXIT.usage, `git fetch ${remote} failed: ${fetched.stderr.trim()}`);
  if (ctx.git(['rev-parse', '-q', '--verify', `refs/remotes/${headRef}`]).code !== 0) {
    return stop(EXIT.usage, `${headRef} does not exist. Push the branch first.`);
  }

  const who = opts.who || `merge-pr #${opts.pr}`;
  let checkedSha = '';
  let tier = 'code';
  let results = [];
  let skipped = [];
  let touchedTests;
  let settled = false;
  let log = () => {};
  let cfg = ctx.config; // the settings in use, from the last try
  let scope = guardScope(cfg); // those and the base branch's, taken together
  let risk = { risk: 'normal', riskPaths: [] };
  let weak; // the ruled weakenings, or undefined when testReasons is off or only watched and not met
  let more = {}; // what the newer gates add to the `merged` event: verified, level, checklist
  let answers = []; // the builder's answers to review findings, for the `finding` events
  let watching = []; // the gates on "observe" that would have stopped this merge: [{ gate, reason }]
  const told = new Set(); // the gates a `would-block` event was written for in this run: one each

  for (let attempt = 1; attempt <= MAX_TRIES && !settled; attempt++) {
    if (ctx.git(['merge-base', '--is-ancestor', headRef, 'HEAD']).code !== 0) {
      return stop(EXIT.usage, `This folder does not hold the newest ${headRef}. Run: git pull ${remote} ${head}`);
    }

    // The base branch's events switch is read before its files are merged in, so a conflict on a branch
    // that turned events off is still written down.
    write = recorder({ on: ctx.config.features.events || baseEvents(baseRef, ctx), branch: head }, ctx);

    // 3. Bring in the base branch, so the checks see exactly what will land.
    const merged = ctx.git(['merge', '--no-edit', baseRef]);
    if (merged.code !== 0) {
      const conflicted = ctx.git(['diff', '--name-only', '--diff-filter=U']).stdout.trim();
      ctx.git(['merge', '--abort']);
      return stop(EXIT.failed, conflicted
        ? `Merging ${baseRef} has conflicts in:\n${conflicted}\nThe merge was undone. Fix the conflicts by hand, push, and run this again.`
        : `Merging ${baseRef} failed: ${(merged.stderr || merged.stdout).trim()}`);
    }
    if (Number(ctx.git(['rev-list', '--count', `${headRef}..HEAD`]).stdout.trim() || 0) > 0) {
      const pushed = ctx.git(['push', remote, `HEAD:refs/heads/${head}`]);
      if (pushed.code !== 0) return stop(EXIT.failed, `Could not push to ${head}: ${pushed.stderr.trim()}`);
    }
    const baseSha = sha(baseRef);
    const headSha = sha('HEAD');
    checkedSha = headSha;

    // Whose settings count: the base branch's, unless the base branch's settings say this is a
    // lead branch. Read after the merge, so they match the base commit that was merged in.
    let picked;
    try {
      picked = pickSettings({ branch: head, base, baseRef }, ctx);
    } catch (e) {
      return stop(EXIT.usage, e.message);
    }
    const { lead } = picked;
    cfg = picked.cfg;
    scope = guardScope(cfg, picked.base);
    const { checks } = scope;
    printHeld(scope, ctx);
    write = recorder({ on: scope.events, branch: head }, ctx);
    // What a watching gate would have stopped is written down even with the events switch off: watching
    // has no other use than that record.
    const record = recorder({ on: true, branch: head }, ctx);
    // A refusal: logged (blockLog on), then stopped. Busy, setup failures, and conflicts are not refusals.
    // The refusal is printed first, so a log that cannot be written never hides it.
    const memo = {};
    log = (outcome, check) => picked.cfg.features.blockLog && logBlock({ outcome, check, pr: opts.pr, branch: head, base, baseRef, scope, memo }, ctx);
    const refuse = (check, text) => {
      if (text) ctx.print(text);
      log('blocked', check);
      blocked(text || `The check "${check}" failed.`, check);
      return EXIT.failed;
    };
    // Each gate runs under its mode (underMode). One on "observe" prints what it would have stopped,
    // writes one `would-block` event, and lets the merge go on, also when the gate itself breaks.
    more = {};
    answers = [];
    watching = [];
    const gate = (name, label, run) => underMode({ name, mode: scope.modes[name], label, what: 'merge', onWatch: (reason) => {
      watching.push({ gate: name, reason });
      if (!told.has(name)) record('would-block', { gate: name, pr: opts.pr, reason });
      told.add(name);
    } }, run, ctx);
    const halt = (check, stopped) => (stopped.refused ? refuse(check, stopped.text) : stop(stopped.code, stopped.text));
    // What a newer gate hands back: nothing when it passed, else a refusal.
    const verdict = (check, text) => {
      if (text) return { refused: true, text };
      log('passed', check);
      return null;
    };
    const clash = gate('duplicateNumbers', 'numbers', () => verdict('numbers', numberClash(scope.numberedPaths, ctx)));
    if (clash) return halt('numbers', clash);

    // 4. The tier comes from the list of changed files.
    // --no-renames: a renamed file is listed under both names, so a file moved out of a docs folder or
    // a high-risk folder still counts for where it was.
    const diff = ctx.git(['diff', '--name-only', '-z', '--no-renames', `${baseRef}...HEAD`]);
    if (diff.code !== 0) return stop(EXIT.failed, `Cannot list the changed files: ${diff.stderr.trim()}`);
    tier = splitZ(diff.stdout).every(scope.isPaperwork) ? 'paperwork' : 'code';
    risk = riskOf(splitZ(diff.stdout), scope.highRiskPaths);
    printRisk(risk, scope, ctx);
    touchedTests = undefined;
    const lost = gate('protectedTests', 'protected tests', () => {
      const touched = protectedTests(baseRef, scope.testPaths, ctx);
      if (touched.fail) return { code: EXIT.failed, text: touched.fail };
      touchedTests = touched.list;
      return null;
    });
    if (lost) return halt('protected tests', lost);
    // The change checklist is read once, by the first gate that needs it. once() keeps the answer, or
    // the error, so a reader that cannot answer says so in every gate that asks.
    const listed = once(() => loaded(ctx.checklistFor, 'changeChecklist', 'scripts/checklist.mjs', ctx.checklistError)(ctx.root, { base: baseRef, branch: 'HEAD' }));
    // What needs a review, as the gate with the switches `own` sees it: with the newer gates, also docs
    // under a high-risk path or under a checklist row that fits. See reviewScope.
    const reviewed = (own) => {
      let items = [];
      // A checklist that cannot be read widens nothing here; its own gate reports it.
      if (scope.modes.changeChecklist !== 'off') try { items = listed().matched ?? []; } catch { /* reported by the checklist gate */ }
      return reviewScope(scope, { items, pathMatches: ctx.pathMatches, own });
    };
    const unreviewed = gate('reviewReceipts', 'receipts', () => {
      const stopped = receiptGate(baseRef, reviewed([]), ctx);
      if (!stopped) log('passed', 'receipts');
      return stopped;
    });
    if (unreviewed) return halt('receipts', unreviewed);
    weak = undefined;
    const weakened = gate('testReasons', 'weakenings', () => {
      const found = weakeningGate({ baseRef, scope, branch: head, needRulings: true }, ctx);
      // A ruling of "refused" is on record the moment it is read.
      if (found.refused) for (const w of found.items.filter((i) => i.ruling === 'refused')) write('weakening', { pr: opts.pr, kind: w.kind, file: w.file, reason: w.reason, ruling: 'refused', ruledBy: w.ruledBy });
      if (found.code !== undefined) return found;
      weak = found.items;
      log('passed', 'weakenings');
      return null;
    });
    if (weakened) return halt('weakenings', weakened);

    // The newer gates. The reviews that count (approving, still true to their session record, by a model
    // that is neither the builder's nor a head agent's) and the review level are each read once, by the
    // first gate that asks. Both readers throw a plain error when they cannot answer.
    // Kept by which docs files need a review, so gates that see the same commits share one reading.
    const readings = new Map();
    const approved = (flag) => {
      const wide = reviewed([flag]);
      const on = (name) => scope.modes[name] === 'enforce' || name === flag;
      const key = `${on('reviewLevels') || on('securityReview')} ${on('changeChecklist')}`;
      if (!readings.has(key)) {
        const first = !readings.size;
        readings.set(key, loaded(ctx.approvals, flag, 'scripts/receipt.mjs', ctx.receiptsError)({ baseRef, git: ctx.git, models: scope.models, isPaperwork: wide.isPaperwork, protectedTests: (z) => protectedTestsChanged(z, scope.testPaths) }));
        // With the receipts gate on, it has printed these notes already.
        if (first && scope.modes.reviewReceipts === 'off') for (const note of readings.get(key).notes ?? []) ctx.print(`note  receipts: ${note}`);
      }
      const reviews = readings.get(key);
      if (reviews.fail) throw new Error(reviews.fail);
      return reviews;
    };
    let wanted;
    const level = (flag) => {
      wanted ??= loaded(ctx.levelFor, flag, 'scripts/review-level.mjs', ctx.levelError)(ctx.root, { base: baseRef, branch: 'HEAD' });
      more.level = wanted.level;
      return wanted;
    };
    const unstamped = gate('verifiedStamp', 'verified', () => {
      const found = verifiedGate({ baseRef, scope }, ctx);
      more.verified = found.counts;
      return verdict('verified', found.text);
    });
    if (unstamped) return halt('verified', unstamped);
    const unanswered = gate('changeChecklist', 'checklist', () => {
      const found = checklistGate({ list: listed(), approved: () => approved('changeChecklist') }, ctx);
      more.checklist = found.ids;
      return verdict('checklist', found.text);
    });
    if (unanswered) return halt('checklist', unanswered);
    const shallow = gate('reviewLevels', 'review level', () => verdict('review level', levelGate({ want: level('reviewLevels'), approved: () => approved('reviewLevels') }, ctx)));
    if (shallow) return halt('review level', shallow);
    const unsafe = gate('securityReview', 'security review', () => verdict('security review', securityGate({ want: level('securityReview'), approved: () => approved('securityReview') }, ctx)));
    if (unsafe) return halt('security review', unsafe);
    const owing = gate('findingAnswers', 'findings', () => {
      const found = findingsGate({ baseRef, branch: head }, ctx);
      answers = found.answers;
      return verdict('findings', found.text);
    });
    if (owing) return halt('findings', owing);

    // 5 to 7. Plan and run the checks.
    const tree = treeOf('HEAD^{tree}', ctx);
    const scriptsTree = treeOf('HEAD:scripts', ctx);
    const useCache = !opts.noCache;
    const cache = useCache ? readCache(join(ctx.commonDir, CACHE_FILE)) : null;
    let tests;
    try {
      tests = splitTests(ctx.root);
    } catch (e) {
      return stop(EXIT.usage, e.message);
    }
    const plan = planChecks({ tier, checks, ...tests, tree, scriptsTree, cache, now: ctx.now() });
    skipped = plan.skipped;
    ctx.print(`Checks for pull request #${opts.pr}, ${head} into ${base} (tier: ${tier})`);
    const onRun = checkRunWriter({ tier, pr: opts.pr, mode: 'merge', branch: head, head: headSha.slice(0, 7), write }, ctx);
    const first = [];
    const incoming = gate('incomingCommits', INCOMING, () => {
      const found = incomingGate({ baseRef, branch: head, buildPrefix: cfg.buildPrefix, useCache }, ctx);
      if (found.ran) onRun({ name: INCOMING, ok: found.code === EXIT.ok, ms: found.ms, observed: scope.modes.incomingCommits === 'observe' });
      if (found.code !== EXIT.ok) return { ...found, refused: found.code === EXIT.failed };
      log('passed', INCOMING);
      first.push(found.result);
      return null;
    });
    if (incoming) return halt(INCOMING, incoming);
    const ran = runChecks({ planned: plan.planned, branch: head, lead, baseRef, useCache, who, wait: opts.wait, onPass: (name) => log('passed', name), onRun }, ctx);
    if (ran.failed) return refuse(ran.failed, '');
    if (ran.code !== EXIT.ok) return ran.code;
    results = [...first, ...ran.results];
    printSkipped(skipped, ctx);

    // 8. If either branch moved while the checks ran, the result is about old files: start over.
    // With the merge lock on, it is taken first and kept until GitHub confirms, so no other merge
    // on this machine can land between this last look and the merge.
    if (picked.cfg.features.mergeLock) {
      if (!existsSync(lock.slotScript)) return stop(EXIT.usage, 'The merge lock is on, but scripts/slot.mjs is missing. Not merged.');
      const got = takeMergeLock({ ...lock, wait: opts.wait }, ctx);
      lock.held = got.taken;
      if (got.code !== EXIT.ok) return got.code;
    }
    const again = ctx.git(['fetch', '-q', remote]);
    if (again.code !== 0) return stop(EXIT.failed, `git fetch ${remote} failed: ${again.stderr.trim()}`);
    if (sha(baseRef) === baseSha && sha(headRef) === headSha) settled = true;
    else {
      ctx.print(`${remote} changed while the checks ran. Starting over (try ${attempt} of ${MAX_TRIES}).`);
      if (lock.held) {
        releaseMergeLock(lock, ctx);
        lock.held = false;
      }
    }
  }
  if (!settled) return stop(EXIT.failed, `${remote} kept changing through ${MAX_TRIES} tries. Run this again when it is quiet.`);

  const shortSha = ctx.git(['rev-parse', '--short', 'HEAD']).stdout.trim();
  const body = formatComment({ shortSha, tier, results, skipped, protectedTests: touchedTests, risk: scope.highRiskPaths.length ? risk : undefined, weakenings: weak, watching });
  const commented = ctx.gh(['pr', 'comment', String(opts.pr), '--body', body]);
  if (commented.code !== 0) return stop(EXIT.failed, `Could not post the results on pull request #${opts.pr}: ${commented.stderr.trim()}. Not merged.`);
  if (pr.isDraft) {
    const ready = ctx.gh(['pr', 'ready', String(opts.pr)]);
    if (ready.code !== 0) return stop(EXIT.failed, `Could not mark pull request #${opts.pr} ready: ${ready.stderr.trim()}. Not merged.`);
  }
  if (lock.held) {
    const lost = renewMergeLock(lock, ctx);
    if (lost) {
      lock.held = false;
      return stop(EXIT.failed, lost);
    }
  }
  // Name the exact commit that was checked. If anything was pushed since, GitHub refuses, and
  // that refusal is final: never merge without this flag.
  // The call has a hard time limit inside the lock's lease, so it can never finish after another
  // merge took an expired lock. A call stopped at the limit may still have merged: say so plainly.
  const done = ctx.gh(['pr', 'merge', String(opts.pr), '--merge', '--match-head-commit', checkedSha], { timeoutMs: MERGE_CALL_SECONDS * 1000 });
  if (done.timedOut) {
    // Not a `merge-blocked` event: nobody knows whether it merged.
    ctx.print(`FAIL  merge: GitHub did not answer within ${MERGE_CALL_SECONDS / 60} minutes, so the call was stopped. The merge state is unknown: GitHub may have merged it. Check with: gh pr view ${opts.pr} --json state,mergeCommit. If it is still open, run this again.`);
    return EXIT.failed;
  }
  if (done.code !== 0) {
    ctx.print(`GitHub refused the merge of pull request #${opts.pr}: ${(done.stderr || done.stdout).trim()}\nNot merged. If a new commit was pushed, run this again so it is checked.`);
    log('blocked', 'github');
    blocked(`GitHub refused the merge: ${(done.stderr || done.stdout).trim()}`, 'github');
    return EXIT.failed;
  }
  // Confirm GitHub actually transitioned the pull request to MERGED (with merge queues, `gh pr merge`
  // can exit 0 with empty stdout/stderr while the pull request remains OPEN in the queue).
  const verified = ctx.gh(['pr', 'view', String(opts.pr), '--json', 'state']);
  let finalState = null;
  if (verified.code === 0) {
    try { finalState = JSON.parse(verified.stdout).state ?? null; } catch {}
  }
  if (finalState !== 'MERGED') {
    if (lock.held) {
      releaseMergeLock(lock, ctx);
      lock.held = false;
    }
    ctx.print(`Pull request #${opts.pr} (${head} into ${base}) was accepted by GitHub (state: ${finalState ?? 'unknown'}), not merged yet.`);
    ctx.print('note  worktree cleanup skipped: pull request is not in MERGED state yet.');
    return EXIT.ok;
  }
  ctx.print(`Merged pull request #${opts.pr} (${head} into ${base}) at ${shortSha}.`);
  log('merged', null);
  // testReasons: true only when the weakening gate was met, so every weakening in this merge is on record.
  if (scope.events) recordMerge({ pr: opts.pr, tier, baseRef, cfg, risk, weak, testReasons: weak !== undefined, more, answers, write }, ctx);
  // Fetch the just-landed merge commit while still holding the merge lock so a waiting merge's
  // fetch cannot race with post-merge cleanup on refs/remotes/<remote>/<base>.
  let fetchedForClean = false;
  if (!opts.noClean && ctx.cleanWorktrees) {
    const postFetch = ctx.git(['fetch', '-q', '--prune', remote]);
    fetchedForClean = postFetch.code === 0;
  }
  if (lock.held) {
    releaseMergeLock(lock, ctx);
    lock.held = false;
  }
  if (!opts.noClean && ctx.cleanWorktrees) {
    try {
      const cleaned = ctx.cleanWorktrees({ baseRef, branch: head, commit: checkedSha, noFetch: fetchedForClean });
      if (cleaned?.line) ctx.print(cleaned.line);
    } catch (e) {
      ctx.print(`note  worktree cleanup skipped: ${e.message}`);
    }
  }
  return EXIT.ok;
}

// Runs clean-worktrees.mjs after a successful merge. Exported so tests cover argument passing,
// partial failures, timeouts, and non-zero exits without spawning a live cleanup over real repos.
export function runPostMergeCleanup({ baseRef, branch, commit = '', noFetch = false, root, scriptPath, execFn = exec }) {
  const script = scriptPath ?? join(dirname(fileURLToPath(import.meta.url)), 'clean-worktrees.mjs');
  if (!existsSync(script)) return null;
  const args = [script, '--delete'];
  if (noFetch) args.push('--no-fetch');
  args.push('--base', baseRef, '--merged-branch', branch);
  if (commit) args.push('--merged-commit', commit);
  const r = execFn(process.execPath, args, root, undefined, 120_000);
  if (r.timedOut) return { line: 'note  worktrees: cleanup timed out after 120 s (some finished worktrees may already have been removed).' };
  const lines = String(r.stdout ?? '').trim().split('\n').filter(Boolean);
  const doneLine = [...lines].reverse().find((l) => l.startsWith('Done.'));
  if (r.code === 0 && doneLine) return { line: `note  worktrees: ${doneLine}` };
  if (doneLine) {
    const detail = lines.find((l) => /^\s*(could not remove it:|not removed:)/.test(l))?.trim();
    return { line: `note  worktrees (partial): ${doneLine}${detail ? ` (${detail})` : ''}` };
  }
  const reason = (r.stderr || r.stdout || '').trim().split('\n').at(-1) || `exit ${r.code}`;
  return { line: `note  worktree cleanup skipped: ${reason}` };
}

// ---------- Talking to the real machine ----------

// timeoutMs: stop the command when it runs that long (SIGKILL), and mark the answer timedOut.
export function exec(command, args, cwd, input, timeoutMs) {
  const r = spawnSync(command, args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT') return { code: 124, stdout: r.stdout ?? '', stderr: r.error.message, timedOut: true };
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function lastLines(file, count) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-count).join('\n');
  } catch {
    return '';
  }
}

// Runs one check with its output going straight to the log file (so nothing is cut off and the
// screen stays short), then hands back the exit code and the last lines.
function runToLog(command, args, { cwd, logFile }) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'w');
  let r;
  try {
    r = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  if (r.error) return { code: 127, tail: r.error.message };
  return { code: r.status ?? 1, tail: lastLines(logFile, TAIL_LINES) };
}

async function cli(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (opts.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  const top = exec('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (top.code !== 0) {
    console.error('Run this inside a git repo.');
    return EXIT.usage;
  }
  const root = top.stdout.trim();
  const commonDir = resolve(root, exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], root).stdout.trim());
  let checker;
  let config;
  try {
    checker = await import('./check-plans.mjs');
    config = settings(checker.loadConfig(root));
  } catch (e) {
    console.error(`Settings could not be read: ${e.message}`);
    return EXIT.usage;
  }
  const configFile = checker.CONFIG_FILE ?? CONFIG_FILE;
  // The receipt rules, the sorter of test changes, the event log, the task log, and asks. Loaded here,
  // not at the top, so a project without one of the files can still merge with its flag off. With the
  // flag on and no file, a gate stops the merge, and an event prints a warning and is left out.
  const load = async (file) => {
    try {
      return [await import(file), ''];
    } catch (e) {
      return [null, e.message];
    }
  };
  const [receipts, receiptsError] = await load('./receipt.mjs');
  const [sorter, sorterError] = await load('./test-changes.mjs');
  const [eventLog, eventsError] = await load('./events.mjs');
  const [slices] = await load('./slice.mjs');
  const [asks, askError] = await load('./ask.mjs');
  const [messages, messageCheckError] = await load('./commit-msg.mjs');
  const [checklists, checklistError] = await load('./checklist.mjs');
  const [levels, levelError] = await load('./review-level.mjs');
  const [findings, findingsError] = await load('./findings.mjs');
  // Checks settings text from the base branch with the checker's own loader: the text goes into
  // a temp folder shaped like a repo, and the loader reads it there. null means no settings file.
  const parseSettings = (text) => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-trusted-settings-'));
    try {
      if (text !== null) {
        mkdirSync(dirname(join(dir, configFile)), { recursive: true });
        writeFileSync(join(dir, configFile), text);
      }
      return settings(checker.loadConfig(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const ctx = {
    root,
    commonDir,
    config,
    configFile,
    parseSettings,
    reloadConfig: () => settings(checker.loadConfig(root)),
    checkReceipts: receipts?.checkReceipts,
    neededCommits: receipts?.neededCommits,
    checkWeakenings: receipts?.checkWeakenings,
    approvals: receipts?.approvals,
    receiptsError,
    collectWeakenings: sorter?.collect,
    sorterError,
    // Settings text -> settings with the checker's defaults filled in, for comparing two versions.
    // The mode words go through as they are written: the sorter reads them and says which way a switch moved.
    readSettings: (text) => (checker.mergeConfig ? checker.mergeConfig(JSON.parse(text)) : JSON.parse(text)),
    appendEvent: eventLog?.appendEvent,
    readEvents: eventLog?.readEvents,
    eventsError,
    newAsk: asks?.newAsk,
    askError,
    checkMessage: messages?.checkMessage,
    branchSlice: messages?.branchSlice,
    parseVerified: messages?.parseVerified,
    messageCheckError,
    checklistFor: checklists?.checklistFor,
    pathMatches: checklists?.pathMatches,
    checklistError,
    levelFor: levels?.levelFor,
    levelError,
    findingsFor: findings?.findingsFor,
    answerLine: findings?.answerLine,
    findingsError,
    parseTasks: checker.parseTasks,
    taskStates: slices?.taskStates,
    git: (args, input) => exec('git', args, root, input),
    gh: (args, { timeoutMs } = {}) => exec('gh', args, root, undefined, timeoutMs),
    cleanWorktrees: ({ baseRef, branch, commit, noFetch }) => runPostMergeCleanup({ baseRef, branch, commit, noFetch, root }),
    run: runToLog,
    print: (line) => console.log(line),
    now: () => Date.now(),
  };
  return opts.mode === 'check' ? checkOnly(opts, ctx) : mergePr(opts, ctx);
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  // No `await` at the top level, on purpose: this file must finish loading before cli() loads the
  // other scripts. Some of them import this file (events.mjs does, through token-ledger.mjs), and
  // an import of a file that is still waiting at its top level never finishes: Node then exits with 13.
  // The exit code is set, not forced with process.exit: Node then finishes writing what was printed
  // before it stops, also when the output goes into a pipe.
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

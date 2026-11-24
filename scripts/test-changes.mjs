#!/usr/bin/env node
// test-changes.mjs: sorts every change to a guard into a kind, so a weakening is never silent.
//
// What it does, in plain English:
//   A guard is something that stops a mistake: a test, a saved snapshot, a ratchet (a count that may
//   only go down), a check command, a lint, type, or test settings file. Adding whole new tests is
//   always free. Any other change to a guard is a "weakening" until a reviewer says otherwise. This
//   script reads the difference between the base branch and a branch and gives each changed guard
//   file one kind:
//     test-deleted            an existing test or snapshot file was deleted, or renamed to a name that
//                             is neither (moving it into docs/weakenings/ counts too)
//     test-removed            a test name that is on the base branch is gone
//     test-skipped            a line with a skip or focus marker was added, written with a dot or
//                             with square brackets (t['skip']()), in code, not in a string or a comment
//     wait-added              a fixed wait was added, or made longer (sleep(500), waitForTimeout,
//                             time.sleep, thread::sleep)
//     timeout-raised          a time limit was added, or raised (jest.setTimeout, a timeout or
//                             testTimeout option, pytest.mark.timeout); 0, None, or Infinity is no limit
//     retry-added             automatic retries were added, or raised (retryTimes, retries,
//                             pytest.mark.flaky, --reruns)
//                             These three hide a flaky test (one that passes sometimes and fails
//                             sometimes with no code change) instead of fixing it. They are looked for
//                             in test files, new ones too, and in test settings files (with every
//                             loaded preset's patterns, since a settings file has its own ending). The
//                             patterns are the presets' "flakyWorkarounds"; a bare key such as retries
//                             or timeout counts only in a settings file, since in a test it may be
//                             sample data, and moving a fake clock forward matches none of them. A
//                             whole new test file the kit installs (listed in scripts/kit.manifest.json)
//                             is free of these three: the kit's own tests of timing need real waits. Free: a removed wait or limit, when its line held
//                             nothing else, and a line that changed only in its number when the number
//                             went down (a shorter wait, a lower limit, fewer retries) or stayed the
//                             same. A line with a new number and any other change is not let off.
//     expectation-changed     a line that holds an assertion was removed or changed; or, in a snapshot
//                             file, a line was removed, changed, or added anywhere but in a whole new
//                             saved snapshot
//     unclear                 lines were removed, changed, or moved and none of the above fits; a
//                             line was added inside a string or a comment that was already there; a
//                             test file was renamed; or a new line, in an old test file or a new
//                             one, writes to something every test shares (see below). Unclear
//                             counts as a weakening.
//     test-edited             lines were added to an old test file, nothing was removed or changed,
//                             and the added lines are not whole new tests: a statement inside an old
//                             test, a hook, an import, a helper. It needs a reason and a ruling like
//                             the others, because one added line can switch a test off, but it is
//                             its own kind so it can be shown apart from deletions and skips.
//     ratchet-raised          kit.ratchets.json: a saved count went up or was removed, or a counter
//                             (the command that recounts one) was removed or changed
//     check-removed           scripts/kit.config.json: a check was removed or its command changed
//                             (filling in a "Fill in this check" placeholder from a preset is free), or
//                             it started only watching ("observe": true: a failure no longer stops a
//                             merge); a "features" switch went from enforce to observe or off (true is
//                             "enforce"; false, "off", and no value are off; observe to off, and any
//                             move toward enforce, are free, and so is removing a check that only
//                             watched); "models" changed; an entry was taken
//                             out of testPaths, checkSettingsPaths, snapshotPaths, presets,
//                             productPaths, or extraLeadOnly; or one was added to notYetClean,
//                             paperworkPaths, sameModelReviewSlices, or leadPrefixes
//     check-settings-changed  a change to a lint, type, or test settings file, a lefthook file, or a
//                             GitHub workflow (the list is CHECK_SETTINGS_FILES below, plus the
//                             project's own). One thing is free: the first file of its family, added
//                             where the base branch, as it is right now, has none (the first lefthook
//                             file, the first ESLint file). That is setup. One more is not.
//   A file with more than one of these gets the first that fits, in the order above; the "what" line
//   names all of them.
//
//   What is free in an old test file: added lines that are whole new tests, and nothing else. A new
//   test starts at a line that names a test (the presets' patterns) and ends where its brackets close
//   or, for a header ending in ":", where the indent comes back. Comments are free. A decorator is
//   free when a new test follows it. Any other added line (a statement inside an old test, a hook, an
//   import, a helper, a lone closing bracket) makes the file "test-edited". A file with no preset (a
//   fixture, a text file) has no pattern for a new test, so every line added to it is "test-edited".
//   "Nothing was removed or changed" is decided on the exact lines, blank lines and spaces at the end
//   of a line included, because inside a string those are part of what a test expects. So a blank
//   line taken out of a template string is a change ("unclear"), never free and never "test-edited".
//   A whole new test, and a whole new test file, is free only while it keeps to itself. A new line
//   that writes to something every test shares makes the file "unclear": a property of an imported
//   name (assert.equal = ...), of globalThis, global, window, process, or module.exports, set with "=",
//   Object.assign, Object.defineProperty, setattr, or delete; or a new value for the test runner's
//   own names (expect, assert, describe, it, test). One thing is let through as ordinary setup: giving
//   one variable of the environment a value (process.env.NAME = ...).
//   A test file that changed in formatting only is free. Two proofs are needed. First: the two
//   versions are the same once layout is taken out, where layout means spacing, line breaks, commas,
//   semicolons, and round brackets in code, and nothing at all inside a string, a template, or a
//   regular expression but the quote mark and its escapes. Second: the formatter ("formatStdin") named
//   by the base branch's copy of the preset, never the branch's own, run on the base branch's version
//   of the file, prints exactly the branch's version. With no such formatter, or one that cannot run,
//   the file is sorted as usual. The formatters run a few at a time, in the project's folder, so the
//   branch must be what is checked out there: for any other branch the script stops and says so.
//   What is free in a snapshot file (ending .snap or .ambr, in a __snapshots__ folder, or on the
//   project's "snapshotPaths" list, inside "testPaths" or not): a whole new saved snapshot between
//   the old ones, in the Jest, Vitest, or syrupy layout. Snapshot lines are compared exactly: a blank
//   line or a space at the end of a line inside a saved snapshot is a change. A snapshot is never let
//   off as formatting. A new test or snapshot file is free.
//
//   The patterns for test names, skip markers, assertions, and flaky-test workarounds come from the
//   language presets (scripts/presets/<name>.json), picked by the file's ending. The preset files are
//   read from git, from the branch being sorted, else the base branch; the base branch's patterns are
//   always added in, so a branch cannot take a pattern out of its own copy to pass. A copy this version of the kit cannot load
//   (an older form, as the base branch's is on the day a project takes a kit update) is passed over
//   for the next one, with one printed line; the folder on disk is the last resort.
//
//   The builder gives a reason for each weakening: one line in a file under docs/weakenings/, by
//   habit docs/weakenings/<branch name with "/" as "-">.md:
//     - apps/web/save.test.ts: The API now answers 201 for a new word, as task 3 of the plan says.
//   The line is "- ", the file's path (backticks around it are fine), ": ", then one sentence of
//   15 to 300 characters. A line counts only when the base branch, as it is right now, holds no line
//   that says the same thing about the same file anywhere in docs/weakenings/. The path is compared
//   exactly; the sentence by its letters and digits alone, so an old reason copied into another file,
//   with backticks, other spacing, or other capitals, is still the old reason.
//   scripts/merge-pr.mjs refuses a weakening with no reason, and the reviewer rules on each one by
//   name (scripts/receipt.mjs). Each weakening has an id: a fingerprint of its kind, file, reason,
//   and the exact contents of the file before and after. A ruling counts only for the id the
//   reviewer saw. So a new reason, or any later edit to that file, by the branch or by the base
//   branch, needs a new ruling.
//
//   The callers (the merge script, the reviewer's fingerprints command, and the command below) hand
//   in what the base branch's settings and the branch's own settings protect, taken together, so a
//   branch cannot take a file out of protection in the same change that edits it.
//
// What the sorter cannot see (it reads one line at a time and knows only the presets' patterns):
//   - Product code written to pass one special test. The reviewer and mutation testing cover that.
//   - Everything a whole new test can do to the old ones. No sorter can decide this. Plain writes to
//     shared names are caught (above); a mock that answers for the real code, a call that ends the
//     test run, a write through another name (const a = assert; a.equal = ...), or a helper that does
//     the writing are not. The reviewer reads every new test for writes to shared state.
//   - A new test that checks nothing.
//   - A time limit or retry count given to a test through a name (const opts = { timeout: 9000 };
//     test('x', opts, fn)), or a wait split over several lines. Only an options object written straight
//     into the call counts, so that sample data inside a test body is never read as a runner setting.
//   - A formatter whose settings in the branch make it do more than lay code out. The command is
//     the base branch's, but it reads the branch's settings files; the other proof (same but for
//     layout, strings kept exactly) is what stops a change of words, values, or operators.
//   - A division that looks like a regular expression, or the other way round, on an odd line.
//   - A skip reached through another name: const s = t.skip, or t[name] with the name built up.
//   - A changed value on a later line of an assertion that spans lines. That file is "unclear", not
//     "expectation-changed"; it is still a weakening.
//   - Test helpers, fixtures, and setup files outside "testPaths". A project should add the folders
//     that hold them to "testPaths", and its own snapshot files to "snapshotPaths".
//   - Whether a renamed test file is still found by the test runner. A rename is "unclear".
//   - A weakening that was made and undone inside the branch: only the final difference is read.
//   - Check settings kept in files that change for other reasons (package.json, pyproject.toml,
//     Cargo.toml). They are not in the list; a project adds them with "checkSettingsPaths".
//   - Settings that are not lists of guarded paths (line limits, plan sizes, numbered folders).
//   - Its own honesty. The base branch's patterns are added to the branch's, but this script runs from
//     the branch being checked, so the branch could change the script itself. What stops a builder from editing them is the rule checker:
//     kit files must match scripts/kit.manifest.json, which only the head agent may change.
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/test-changes.mjs [--json]
//       Lists the weakenings on the current branch against the base branch, the reason each has, and
//       the exact line to add for each one that has none.
// Exit codes: 0 no weakening lacks a reason, 1 a reason is missing (or an error), 2 wrong usage.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, mergeConfig } from './check-plans.mjs';
import { ALWAYS_ON, FLAKY_KINDS, PRESETS_DIR, validatePreset } from './presets.mjs';

export const KINDS = Object.freeze(['test-deleted', 'test-removed', 'test-skipped', ...FLAKY_KINDS, 'expectation-changed', 'unclear', 'test-edited', 'ratchet-raised', 'check-removed', 'check-settings-changed']);
export const REASON_DIR = 'docs/weakenings/';
export const REASON_MIN = 15;
export const REASON_MAX = 300;
export const RATCHETS_FILE = 'kit.ratchets.json';
// Lint, type, and test settings files. An entry with no "/" is a file name anywhere in the project:
// it matches that exact name, or that name followed by "." and more ("tsconfig" matches
// tsconfig.json and tsconfig.build.json). An entry with a "/" is one exact path, or a whole folder
// when it ends in "/". A project adds its own with "checkSettingsPaths" in scripts/kit.config.json.
// The files come in families (the lines below): the first file of a family that a project adds is
// setup and is free; a file added where the base branch already has one of its family is a change.
const SETTINGS_FAMILIES = [
  ['.oxlintrc', 'oxlint.config'], ['eslint.config', '.eslintrc', '.eslintignore'], ['biome'], ['ruff.toml', '.ruff.toml'], ['.sqlfluff', '.sqlfluffignore'],
  ['clippy.toml', '.clippy.toml'], ['.squawk.toml'],
  ['tsconfig', 'jsconfig'], ['pyrefly.toml'], ['mypy.ini'], ['pyrightconfig'],
  ['jest.config'], ['vitest.config', 'vitest.workspace'], ['playwright.config'], ['pytest.ini', 'tox.ini'], ['.mocharc'],
  // What runs the checks: the commit hooks (lefthook reads lefthook.*, .lefthook.*, and .config/lefthook.*) and CI.
  ['lefthook', '.lefthook', 'lefthook-local', '.lefthook-local'], ['.github/workflows/'],
];
export const CHECK_SETTINGS_FILES = Object.freeze(SETTINGS_FAMILIES.flat());
// A check command the presets ship unfinished: it prints "Fill in this check" and fails. It never
// passed, so putting a real command in its place takes nothing away.
const isPlaceholder = (run) => /^echo 'Fill in this check\b[^']*' >&2; exit 1$/.test(String(run).trim());
// Saved snapshots (the expected output a test compares with). An entry ending in "/" is a folder name
// anywhere in the path; an entry starting with "." is a file ending; any other entry is a piece of the
// file's own name. A project adds its own with "snapshotPaths" in scripts/kit.config.json. A snapshot
// file is a guard wherever it lives, inside "testPaths" or not.
export const SNAPSHOT_FILES = Object.freeze(['.snap', '.ambr', '__snapshots__/']);
// The two snapshot layouts the sorter can read entry by entry: the first line of one saved snapshot,
// and its last. In any other layout no added line is free.
const SNAPSHOT_ENTRIES = [
  { start: /^exports\[/, end: /(^|[^\\])`;$/ }, // Jest and Vitest
  { start: /^# name: /, end: /^# ---$/ }, // syrupy (pytest)
];
// A skip reached with square brackets, on any object: t['skip'](), ctx["skip"](), it[`only`](...).
const BRACKET_SKIP = /\[\s*(['"`])(skip|only|todo|fails|skipIf|runIf)\1\s*\]/;
// Names every test in a run shares, whether or not the file imports them.
const SHARED_GLOBALS = ['globalThis', 'global', 'window', 'process', 'module', 'exports'];
// How many formatter runs go at the same time.
const FORMAT_AT_ONCE = 6;
// Settings lists in scripts/kit.config.json. Taking an entry out of the first group, or putting one
// into the second, makes the checks cover less.
const SHRINKS_WHEN_REMOVED = ['testPaths', 'checkSettingsPaths', 'snapshotPaths', 'presets', 'productPaths', 'extraLeadOnly'];
const SHRINKS_WHEN_ADDED = ['notYetClean', 'paperworkPaths', 'sameModelReviewSlices', 'leadPrefixes'];
const USAGE = 'Usage: node scripts/test-changes.mjs [--json]';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

// ---------- Pure rules (tests call these with plain text) ----------

// A file's lines with line ends and trailing spaces cut off, blank lines left out. null is no file.
export function linesOf(text) {
  return String(text ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
}

// True when every base line is still in tip, in the same order: nothing was removed, changed, or moved.
export function onlyAdded(base, tip) {
  let i = 0;
  for (const line of tip) if (i < base.length && line === base[i]) i++;
  return i === base.length;
}

// A file's exact lines: only the last line end is cut off, so blank lines and trailing spaces stay. null is no file.
const exactLines = (text) => (text === null || text === undefined ? [] : String(text).replace(/\n$/, '').split('\n'));

// The lines that are gone and the lines that are new, comparing by text and count, indents ignored.
// A line that only moved, or was only indented, is in neither list. addedAt: where each new line
// sits in tip.
export function netChange(base, tip) {
  const left = new Map();
  for (const l of base) left.set(l.trim(), (left.get(l.trim()) ?? 0) + 1);
  const addedAt = [];
  tip.forEach((l, at) => {
    const n = left.get(l.trim()) ?? 0;
    if (n > 0) left.set(l.trim(), n - 1);
    else addedAt.push(at);
  });
  const removed = [];
  for (const [l, n] of left) for (let i = 0; i < n; i++) removed.push(l);
  return { removed, added: addedAt.map((at) => tip[at].trim()), addedAt };
}

export function isSnapshot(file, more = []) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return [...SNAPSHOT_FILES, ...more].some((e) => (e.endsWith('/') ? `/${file}`.includes(`/${e}`) : e.startsWith('.') ? name.endsWith(e) : name.includes(e)));
}

export function isCheckSettings(file, entries) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return entries.some((e) => (e.includes('/') ? (e.endsWith('/') ? file.startsWith(e) : file === e) : name === e || name.startsWith(`${e}.`)));
}

// The presets' patterns for one file, picked by its ending: { testNames, skippedTests, assertions },
// each a list of regular expressions, and flaky: [{ kind, re }] from "flakyWorkarounds".
// presets: the loaded preset objects.
export function patternsFor(file, presets) {
  const mine = presets.filter((p) => p.extensions.some((e) => file.endsWith(e)));
  const pick = (field) => mine.flatMap((p) => p[field].map((e) => new RegExp(e.pattern)));
  return { testNames: pick('testNames'), skippedTests: pick('skippedTests'), assertions: pick('assertions'), flaky: flakyOf(mine, 'tests') };
}

// The "flakyWorkarounds" patterns of the given presets for one place, "tests" or "settings": [{ kind, re }].
// An entry with no "where" counts in both.
export const flakyOf = (presets, place) => presets.flatMap((p) => (p.flakyWorkarounds ?? []).filter((e) => (e.where ?? place) === place).map((e) => ({ kind: e.kind, re: new RegExp(e.pattern) })));

// The lists of a preset that decide what is a weakening. A branch's preset is read with the base
// branch's lists added in, so a branch cannot take a pattern out of its own copy to pass.
const JOINED = ['extensions', 'testNames', 'skippedTests', 'assertions', 'flakyWorkarounds'];
export function joinPresets(sets, baseSets) {
  return sets.map((p) => {
    const b = baseSets.find((x) => x.name === p.name);
    if (!b) return p;
    const out = { ...p };
    for (const field of JOINED) {
      const seen = new Set();
      out[field] = [...(p[field] ?? []), ...(b[field] ?? [])].filter((e) => !seen.has(JSON.stringify(e)) && seen.add(JSON.stringify(e)));
    }
    return out;
  });
}

// The kit's manifest (scripts/kit.manifest.json): the files the kit installs and owns in a project.
export const MANIFEST = 'scripts/kit.manifest.json';

// The number a flaky-workaround pattern captured, as one number: "2_000" is 2000, "60 * 1000" is 60000,
// None and Infinity are no limit. A time limit of 0 is no limit too. undefined when there is none.
export function limitValue(text, kind) {
  if (text === undefined) return undefined;
  if (/^(None|Infinity)$/.test(text)) return Infinity;
  const n = text.split('*').reduce((all, part) => all * Number(part.trim().replace(/_/g, '')), 1);
  if (!Number.isFinite(n)) return undefined;
  return kind === 'timeout-raised' && n === 0 ? Infinity : n;
}

// What may stand on a removed wait or limit line besides the wait or limit itself, for the removal to be free.
const ONLY_THIS = /^[\s;,()]*(?:(?:\.?await|return|new)\b[\s;,()]*)*$/;
const FLAKY_SAID = {
  'wait-added': ['a fixed wait was added', 'a fixed wait went up'],
  'timeout-raised': ['a time limit was added', 'a time limit went up'],
  'retry-added': ['automatic retries were added', 'automatic retries went up'],
};

// Waits, time limits, and retries that were added or raised between two versions of a file.
//   base, tip: the files' exact lines. entries: [{ kind, re }] (flakyOf).
// Returns { found: [{ kind, what }], base, tip }. The base and tip it gives back have every flaky edit
// it has judged taken out (a removed wait dropped from base; a line whose number changed put back as
// it was in tip), so the rest of the sorting does not read those lines a second time as "unclear".
export function sortFlaky(base, tip, file, entries) {
  if (!entries.length) return { found: [], base, tip };
  const hits = (lines, at) => {
    const code = codeOf(lines, file).map((c) => c.code);
    return at.flatMap((i) => {
      for (const e of entries) {
        const m = e.re.exec(code[i]);
        if (m) return [{ i, kind: e.kind, re: e.re, raw: lines[i].trim(), rest: code[i].replace(m[0], ''), text: m.groups?.value, value: limitValue(m.groups?.value, e.kind) }];
      }
      return [];
    });
  };
  const adds = hits(tip, netChange(base, tip).addedAt);
  const rems = hits(base, netChange(tip, base).addedAt);
  // Two lines that are the same but for the number: a changed number, nothing else.
  const sameButNumber = (a, r) => a.text !== undefined && r.text !== undefined && a.raw.replace(a.text, '#') === r.raw.replace(r.text, '#');
  const outTip = [...tip];
  const used = new Set();
  const flagged = [];
  for (const a of adds) {
    const r = rems.find((x) => !used.has(x) && x.re === a.re && sameButNumber(a, x));
    if (r) {
      used.add(r);
      outTip[a.i] = base[r.i];
      if (!(a.value <= r.value)) flagged.push({ a, from: r });
    } else if (!(a.kind !== 'timeout-raised' && a.value === 0)) flagged.push({ a });
  }
  const dropped = new Set(rems.filter((r) => !used.has(r) && ONLY_THIS.test(r.rest)).map((r) => r.i));
  const found = FLAKY_KINDS.flatMap((kind) => {
    const mine = flagged.filter((f) => f.a.kind === kind);
    if (!mine.length) return [];
    const [first] = mine;
    const said = first.from ? `${FLAKY_SAID[kind][1]} from ${first.from.text} to ${first.a.text}` : FLAKY_SAID[kind][0];
    return [{ kind, what: `${said}: ${cut(first.a.raw, 80)}${mine.length > 1 ? ` (and ${mine.length - 1} more)` : ''}` }];
  });
  return { found, base: base.filter((_, i) => !dropped.has(i)), tip: outTip };
}

// Test name -> how many lines name it.
function namesIn(lines, patterns) {
  const out = new Map();
  for (const line of lines) {
    for (const re of patterns) {
      const name = re.exec(line)?.groups?.name;
      if (name === undefined) continue;
      out.set(name, (out.get(name) ?? 0) + 1);
      break;
    }
  }
  return out;
}

// Each line as code only: comments cut out, and the inside of every string blanked unless it is one
// plain word (so 'skip' in t['skip'] stays, and a test named "prints test.skip()" does not look like
// a skip). The quote marks stay. It follows a block comment, a template literal, and a Python
// triple-quoted string across lines. Returns [{ code, open }]: open says the line ends inside one of
// those. The inside of a regular expression literal (JavaScript family) is blanked too, so a skip word
// or a lone bracket inside one is not read as code.
export function codeOf(lines, file) {
  const hash = /\.(py|pyi)$/.test(file); // "#" starts a comment
  const closeOf = (line, from, mark) => {
    for (let i = line.indexOf(mark, from); i >= 0; i = line.indexOf(mark, i + 1)) {
      let slashes = 0;
      while (i - slashes - 1 >= from && line[i - slashes - 1] === '\\') slashes++;
      if (slashes % 2 === 0) return i;
    }
    return -1;
  };
  const shown = (inside) => (/^[A-Za-z_$][\w$]*$/.test(inside) ? inside : '');
  let comment = false; // inside /* ... */
  let quote = null; // inside a string that spans lines: a template literal, or a Python triple-quoted string
  return lines.map((line) => {
    let code = '';
    let i = 0;
    while (i < line.length) {
      if (comment) {
        const end = line.indexOf('*/', i);
        if (end < 0) break;
        comment = false;
        i = end + 2;
      } else if (quote) {
        const end = closeOf(line, i, quote);
        if (end < 0) break;
        code += quote;
        i = end + quote.length;
        quote = null;
      } else if (hash ? line[i] === '#' : line.startsWith('//', i)) break;
      else if (!hash && line.startsWith('/*', i)) {
        comment = true;
        i += 2;
      } else if (!hash && line[i] === '/' && regexMayStart(code) && regexEnd(line, i) > 0) {
        code += '//';
        i = regexEnd(line, i);
      } else if ('"\'`'.includes(line[i])) {
        const triple = hash && line.startsWith(line[i].repeat(3), i);
        const mark = triple ? line[i].repeat(3) : line[i];
        const end = closeOf(line, i + mark.length, mark);
        if (end >= 0) {
          code += mark + shown(line.slice(i + mark.length, end)) + mark;
          i = end + mark.length;
        } else if (triple || mark === '`') {
          code += mark;
          quote = mark;
          break;
        } else code += line[i++]; // a lone quote mark, as in a Rust lifetime: not a string
      } else code += line[i++];
    }
    return { code, open: comment || quote !== null };
  });
}

// A "/" starts a regular expression, not a division, when the code before it cannot end a value.
const regexMayStart = (codeSoFar) => /(^|[(,=:[!&|?{};+\-*%<>~^]|\b(return|typeof|case|in|of|delete|void|throw|new|await|yield))\s*$/.test(codeSoFar);
// Where a regular expression literal that starts at `from` ends on this line (after its flags), or -1.
function regexEnd(line, from) {
  let inClass = false;
  for (let i = from + 1; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '[') inClass = true;
    else if (line[i] === ']') inClass = false;
    else if (line[i] === '/' && !inClass) {
      while (/[a-z]/i.test(line[i + 1] ?? '')) i++;
      return i + 1;
    }
  }
  return -1;
}

// The names a file brings in from other files: import, require, and Python's import and from.
function importedNames(code, hash) {
  const text = code.join('\n');
  const names = new Set();
  const word = /^[A-Za-z_$][\w$]*$/;
  // "a, b as c, d: e" -> a, c, e: the name each one has inside this file.
  const locals = (clause) => clause.split(',').map((part) => part.trim().split(/\s+as\s+|\s*:\s*/).pop().trim()).filter((n) => word.test(n));
  if (hash) {
    for (const m of text.matchAll(/^\s*import\s+(.+)$/gm)) for (const part of m[1].split(',')) names.add(/\sas\s/.test(part) ? part.split(/\s+as\s+/).pop().trim() : part.trim().split('.')[0]);
    for (const m of text.matchAll(/^\s*from\s+\S+\s+import\s+(?:\(([^)]*)\)|(.+))$/gm)) for (const n of locals(m[1] ?? m[2])) names.add(n);
  } else {
    for (const m of text.matchAll(/\bimport\s+([^;'"`]*?)\s+from\b/g)) for (const n of locals(m[1].replace(/\*\s+as\s+/, '').replace(/[{}]/g, ','))) names.add(n);
    for (const m of text.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+import|require)\s*\(/g)) for (const n of locals(m[1].replace(/[{}]/g, ''))) names.add(n);
  }
  return [...names].filter((n) => word.test(n));
}

// A test for one line of code: does it write to something every test shares? That is a property of an
// imported name or of a global (globalThis, process, module.exports, ...), set with "=", Object.assign,
// Object.defineProperty, setattr, or delete; or the test runner's own names given a new value.
function sharedWriteTest(code, hash) {
  // Setting one variable of the environment (process.env.NAME = ...) is ordinary test setup: it is
  // cut out of the line before the line is judged. process.env itself, and the rest of process, are not.
  const envSet = /\bprocess\s*\.\s*env\s*(?:\.\s*[\w$]+|\[[^\]]*\])\s*=(?![=>])/g;
  const names = [...importedNames(code, hash), ...SHARED_GLOBALS].map((n) => n.replace(/[$]/g, '\\$&')).join('|');
  const tests = [
    new RegExp(`(?:^|[^\\w$.])(?:${names})(?:\\s*\\.\\s*[\\w$]+|\\s*\\[[^\\]]*\\])+\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])`),
    new RegExp(`\\b(?:Object\\.(?:assign|definePropert(?:y|ies)|setPrototypeOf)|Reflect\\.(?:set|defineProperty)|setattr|delattr)\\s*\\(\\s*(?:${names})\\b`),
    new RegExp(`\\b(?:delete|del)\\s+(?:${names})\\s*[.\\[]`),
    /(?:^|[;{]\s*)(?:expect|assert|describe|it|test)\s*=(?![=>])/,
  ];
  return (line) => tests.some((re) => re.test(line.replace(envSet, '')));
}

// The first of the given lines (by their place in `lines`, a linesOf list) that writes to something
// every test shares, or null.
function firstSharedWrite(lines, file, at) {
  const code = codeOf(lines, file).map((c) => c.code.trim());
  const writes = sharedWriteTest(code, /\.(py|pyi)$/.test(file));
  const hit = at.find((i) => writes(code[i]));
  return hit === undefined ? null : lines[hit].trim();
}
const SHARED_WRITE = 'a new line writes to something every test shares (an imported name, a global, or the test runner)';

const indentOf = (line) => line.length - line.trimStart().length;

// Which tip lines are new, when every base line is still there in order: one true or false per tip line.
function addedFlags(base, tip) {
  let i = 0;
  return tip.map((line) => {
    if (i < base.length && line === base[i]) {
      i++;
      return false;
    }
    return true;
  });
}

// Reads one line of code that belongs to a new test's header, its decorator, or its bracketed body.
// state: { depth, seen } - the brackets open so far, and whether any has opened yet.
// Returns the text left after the last bracket closed (the tail), or null when the line holds
// something between brackets that one test cannot hold: a second statement, an operator, a comma.
// Between a closing bracket and the next opening one, only two things may stand: nothing at all,
// before "(" (a call on a call, as in it.each([1, 2])('name', fn)), or blank or "-> Type", before
// "{" (the body of a function). A ":" after the brackets (Python) starts the body: the tail is the
// rest of the line from there.
function readBrackets(code, state) {
  let between = ''; // the text since the brackets last closed
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === ':' && state.depth === 0 && state.seen) return code.slice(i);
    if ('([{'.includes(ch)) {
      if (state.depth === 0 && state.seen) {
        const call = ch === '(' && between === '';
        const fnBody = ch === '{' && /^\s*(->\s*[\w:&'<> ]+)?\s*$/.test(between);
        if (!call && !fnBody) return null;
      }
      state.depth++;
      state.seen = true;
      between = '';
    } else if (')]}'.includes(ch)) {
      if (--state.depth < 0) return null;
      between = '';
    } else if (state.depth === 0) between += ch;
  }
  return between;
}

// One run of added lines in a test file: is it nothing but whole new tests, with their comments and
// decorators? Returns '' when it is, else the first line that is not.
//   run: [{ raw, code }]. next: the old line right after the run, or null at the end of the file.
// A new test starts at a line of code that begins by naming a test. It ends where its brackets close,
// and then only ";" or "," may follow on that line; or, when ":" follows (Python), at the first line
// that is not indented deeper. Anything between new tests must be a comment, a decorator, or the next
// test; a decorator must be followed by a test.
function strayLine(run, next, names) {
  let open = null; // the test or decorator being read: { raw, header, depth, seen }
  let body = -1; // the indent of a ":" style test still open, or -1
  let owed = null; // a decorator still waiting for its test
  for (const line of run) {
    const code = line.code.trim();
    if (!open) {
      if (!code) continue; // a comment
      if (body >= 0 && indentOf(line.raw) > body) continue;
      body = -1;
      const header = names.some((re) => re.exec(code)?.index === 0);
      const decorator = !header && (code.startsWith('@') || code.startsWith('#['));
      if (!header && !decorator) return line.raw;
      owed = decorator ? line.raw : null;
      open = { raw: line.raw, header, depth: 0, seen: false };
    }
    const tail = readBrackets(code, open);
    if (tail === null) return line.raw;
    if (open.depth > 0) continue; // its brackets are still open
    // What is left after the brackets: nothing, ";" or ",", or ":" and a body. A header with no
    // brackets at all (class TestThing:) is judged by how the line ends.
    const rest = open.seen ? tail.trim() : code.endsWith(':') ? ':' : '';
    if (rest !== '' && rest !== ';' && rest !== ',' && !rest.startsWith(':')) return line.raw;
    if (open.header && rest === ':') body = indentOf(open.raw);
    open = null;
  }
  if (open) return open.raw; // it would swallow the old lines that follow
  if (owed) return owed; // it would land on an old test
  if (body >= 0 && next !== null && indentOf(next) > body) return run.at(-1).raw; // the old lines that follow would fall inside it
  return '';
}

// The first added line that is not part of a whole new test, or null when every added line is.
// base and tip are the files' exact lines, and every base line is still in tip in order.
// Returns { line, inside }: inside is true when the added lines sit in a string or a comment that
// was already there, or open one over old lines. That changes old lines, so it is never an addition.
function strayInTest(base, tip, file, names) {
  const fresh = addedFlags(base, tip);
  const code = codeOf(tip, file);
  for (let i = 0; i < tip.length; i++) {
    if (!fresh[i]) continue;
    let end = i;
    while (end + 1 < tip.length && fresh[end + 1]) end++;
    if ((i > 0 && code[i - 1].open) || code[end].open) return { line: tip.slice(i, end + 1).find((l) => l.trim()) ?? '(a blank line)', inside: true };
    const next = tip.slice(end + 1).find((l) => l.trim()) ?? null; // the next old line that is not blank
    const stray = strayLine(tip.slice(i, end + 1).map((raw, at) => ({ raw, code: code[i + at].code })), next, names);
    if (stray) return { line: stray, inside: false };
    i = end;
  }
  return null;
}

// A changed snapshot file. Free only when every added line belongs to a whole new saved snapshot that
// sits between the old ones, in a layout the sorter can read. base and tip are the files' exact lines:
// in a snapshot a blank line or a space at the end of a line is part of what is expected.
function sortSnapshot(base, tip) {
  if (!onlyAdded(base, tip)) return { kind: 'expectation-changed', what: 'a saved snapshot was changed or removed' };
  const inside = { kind: 'expectation-changed', what: 'lines were added inside a saved snapshot, or not as a whole new one' };
  const shape = SNAPSHOT_ENTRIES.find((e) => tip.some((line) => e.start.test(line)));
  if (!shape) return inside;
  const fresh = addedFlags(base, tip);
  let open = false; // inside a saved snapshot
  let openIsNew = false;
  for (let i = 0; i < tip.length; i++) {
    if (!open) {
      if (shape.start.test(tip[i])) {
        open = true;
        openIsNew = fresh[i];
      } else if (fresh[i] && tip[i] !== '') return inside; // an added line between snapshots that starts none
    } else if (fresh[i] !== openIsNew) return inside; // a new line in an old snapshot, or an old line caught in a new one
    if (open && shape.end.test(tip[i])) open = false;
  }
  return open && openIsNew ? inside : { kind: 'added', what: 'only whole new snapshots were added' };
}

// Sorts one changed test or snapshot file that is on both sides. Returns { kind, what }; kind "added"
// means free. snapshotPaths: the project's own snapshot entries.
// "Nothing was removed or changed" is decided on the files' exact lines, blank lines and spaces at
// the end of a line included: inside a string they are part of what a test expects.
export function sortTestChange({ file, baseText, tipText, patterns, snapshotPaths = [] }) {
  const exact = (text) => String(text ?? '').replace(/\n$/, '').split('\n');
  if (isSnapshot(file, snapshotPaths)) return sortSnapshot(exact(baseText), exact(tipText));
  // Waits, time limits, and retries first; the lines they explain are taken out of the rest.
  const flaky = sortFlaky(exact(baseText), exact(tipText), file, patterns.flaky ?? []);
  baseText = flaky.base.join('\n');
  tipText = flaky.tip.join('\n');
  const clean = onlyAdded(exact(baseText), exact(tipText));
  const base = linesOf(baseText);
  const tip = linesOf(tipText);
  const { removed, addedAt } = netChange(base, tip);
  const code = codeOf(tip, file).map((c) => c.code.trim());
  const found = [...flaky.found];
  const before = namesIn(base, patterns.testNames);
  const after = namesIn(tip, patterns.testNames);
  const gone = [...before].filter(([name, n]) => (after.get(name) ?? 0) < n).map(([name]) => name);
  if (gone.length) found.push({ kind: 'test-removed', what: `${plural(gone.length, 'test name')} on the base branch ${gone.length === 1 ? 'is' : 'are'} gone: ${gone.slice(0, 3).map((n) => `"${cut(n, 60)}"`).join(', ')}${gone.length > 3 ? ', and more' : ''}` });
  // Skip markers are looked for in code only, so a test name or a comment that mentions one is not a skip.
  const skips = addedAt.filter((i) => [...patterns.skippedTests, BRACKET_SKIP].some((re) => re.test(code[i])));
  if (skips.length) found.push({ kind: 'test-skipped', what: `${plural(skips.length, 'line')} with a skip or focus marker ${skips.length === 1 ? 'was' : 'were'} added: ${cut(tip[skips[0]].trim(), 80)}` });
  const asserts = removed.filter((l) => patterns.assertions.some((re) => re.test(l)));
  if (asserts.length) found.push({ kind: 'expectation-changed', what: `${plural(asserts.length, 'line')} that ${asserts.length === 1 ? 'holds' : 'hold'} an assertion ${asserts.length === 1 ? 'was' : 'were'} removed or changed: ${cut(asserts[0], 80)}` });
  // A whole new test is free only while it keeps to itself.
  const write = firstSharedWrite(tip, file, addedAt);
  if (write) found.push({ kind: 'unclear', what: `${SHARED_WRITE}: ${cut(write, 80)}` });
  const stray = clean ? strayInTest(exact(baseText), exact(tipText), file, patterns.testNames) : null;
  if (stray?.inside) found.push({ kind: 'unclear', what: `a line was added inside a string or a comment that was already there, or opens one over old lines: ${cut(stray.line.trim(), 80)}` });
  else if (stray) found.push({ kind: 'test-edited', what: `a line was added that is not part of a whole new test: ${cut(stray.line.trim(), 80)}` });
  if (!found.length) {
    if (clean) return { kind: 'added', what: 'only whole new tests were added' };
    found.push({ kind: 'unclear', what: 'lines were removed, changed, or moved, and none of them is a test name, a skip marker, or an assertion the presets know' });
  }
  found.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  return { kind: found[0].kind, what: found.map((f) => f.what).join('; ') };
}

// kit.ratchets.json, base text against tip text (null: the file is gone). null means nothing was raised.
export function sortRatchets(baseText, tipText) {
  const read = (text) => {
    const data = text === null ? {} : JSON.parse(text);
    return { counts: data?.counts ?? {}, counters: Array.isArray(data?.counters) ? data.counters : [] };
  };
  let base;
  let tip;
  try { base = read(baseText); } catch { return null; } // the base saves nothing readable, so nothing can be raised
  try { tip = read(tipText); } catch { return { kind: 'unclear', what: `${RATCHETS_FILE} is not valid JSON, so a raised count cannot be ruled out` }; }
  const parts = [];
  for (const [name, n] of Object.entries(base.counts)) {
    if (!(name in tip.counts)) parts.push(`the count "${name}" was removed (it was ${n})`);
    else if (tip.counts[name] > n) parts.push(`the count "${name}" went up from ${n} to ${tip.counts[name]}`);
  }
  // A counter is the command that recounts one saved number. Without it, or with another command or
  // another list of files it waits for, the number is never checked again.
  for (const counter of base.counters) {
    const now = tip.counters.find((c) => c?.name === counter?.name);
    if (!now) parts.push(`the counter "${counter?.name}" was removed`);
    else if (now.run !== counter.run || JSON.stringify(now.needs ?? []) !== JSON.stringify(counter.needs ?? [])) parts.push(`the counter "${counter.name}" was changed`);
  }
  return parts.length ? { kind: 'ratchet-raised', what: parts.join('; ') } : null;
}

// A switch's mode, from its value in "features": true is "enforce"; "observe" only watches; anything
// else (false, "off", no value) is off. The same rule as modeOf in scripts/merge-pr.mjs, written out
// here because this file cannot import that one (its tests copy this file into projects without it).
const modeOf = (value) => (value === true || value === 'enforce' ? 'enforce' : value === 'observe' ? 'observe' : 'off');

// scripts/kit.config.json, base text against tip text (null: the file is gone). null means the checks
// cover as much as before. read(text) turns the text into settings; the callers hand in the settings
// checker's own reader, which fills in the defaults, so a list written out for the first time is
// compared with the defaults it replaces.
export function sortSettings(baseText, tipText, read = JSON.parse) {
  if (tipText === null) return { kind: 'check-removed', what: 'the settings file is gone, and every check in it with it' };
  let base;
  let tip;
  try { base = read(baseText); } catch { return null; }
  try { tip = read(tipText); } catch { return { kind: 'unclear', what: 'the settings file cannot be read, so a removed check cannot be ruled out' }; }
  const list = (v) => (Array.isArray(v) ? v : []);
  const parts = [];
  for (const check of list(base?.checks)) {
    const now = list(tip?.checks).find((c) => c?.name === check?.name);
    // A check that only watched stopped no merge, so taking it away takes nothing away.
    if (!now && check?.observe !== true) parts.push(`the check "${check?.name}" was removed`);
    else if (!now) continue;
    else if (now.run !== check.run && !isPlaceholder(check.run)) parts.push(`the command of the check "${check.name}" changed`);
    if (now && check.observe !== true && now.observe === true) parts.push(`the check '${check.name}' now only watches: a failure no longer stops a merge`);
  }
  const missing = (from, has) => list(from).filter((e) => !list(has).includes(e));
  for (const key of SHRINKS_WHEN_REMOVED) for (const e of missing(base?.[key], tip?.[key])) parts.push(`"${e}" was taken out of "${key}"`);
  for (const key of SHRINKS_WHEN_ADDED) {
    for (const e of missing(tip?.[key], base?.[key])) parts.push(`"${e}" was added to "${key}"${key === 'notYetClean' ? ', so the strict rules are off there' : ''}`);
  }
  for (const [name, value] of Object.entries(base?.features ?? {})) {
    const now = modeOf(tip?.features?.[name]);
    if (modeOf(value) === 'enforce' && now !== 'enforce') parts.push(`the switch ${name} went from enforce to ${now}: ${now === 'observe' ? 'it now only watches' : 'it no longer runs'}`);
  }
  if (JSON.stringify(base?.models ?? null) !== JSON.stringify(tip?.models ?? null)) parts.push('"models" changed: who counts as the builder, a head agent, or the reviewer');
  return parts.length ? { kind: 'check-removed', what: parts.join('; ') } : null;
}

// The reason a file was given, from reason lines: "- path: reason" or "- `path`: reason". The last
// such line wins. null when no line names the file.
export function reasonFor(file, lines) {
  let found = null;
  for (const raw of lines) {
    const line = raw.trim();
    for (const head of [`- ${file}: `, `- \`${file}\`: `]) if (line.startsWith(head)) found = line.slice(head.length).trim();
  }
  return found;
}

// What a reason line says, for telling a copied reason from a new one: the file's path exactly (only
// backticks, quote marks, and spaces around it are dropped), then the sentence with everything but its
// letters and digits taken out and in small letters. So the same sentence about another file is another
// reason, and the same sentence about the same file is the same one however it is dressed.
export function reasonKey(line) {
  const loose = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const parts = String(line).trim().match(/^[-*]\s*(.+?)\s*:\s+(.*)$/);
  return parts ? `${parts[1].replace(/^[`'"\s]+|[`'"\s]+$/g, '')}\n${loose(parts[2])}` : loose(String(line));
}

// '' when the reason will do, else one plain line saying what is wrong with it.
export function reasonProblem(reason) {
  if (reason === null) return 'no reason line yet';
  if (reason.startsWith('<')) return 'the line still holds the placeholder text';
  if (reason.length < REASON_MIN) return `the reason is ${reason.length} characters; write one full sentence (${REASON_MIN} characters or more)`;
  if (reason.length > REASON_MAX) return `the reason is ${reason.length} characters; shorten it to ${REASON_MAX} or fewer`;
  return '';
}

// The exact line a builder adds for one file, with the sentence still to write.
export const reasonLine = (file) => `- ${file}: <why this change is right, in one plain sentence>`;

// Where a branch's reason lines go by habit. Any file in the folder is read, so a wrong guess still counts.
export const reasonFile = (branch) => `${REASON_DIR}${String(branch || 'this-branch').replace(/[^A-Za-z0-9._-]+/g, '-')}.md`;

// A weakening's id: 12 hex characters over its kind, file, reason, and the exact contents of the file
// before and after (git's blob ids; null when the file is not there). Any later edit to the file, by
// the branch or by the base branch, makes another id.
export function changeId({ kind, file, to = null, reason, before, after }) {
  return sha256(JSON.stringify([kind, file, to, reason, before, after])).slice(0, 12);
}

// A file's text with its layout taken out, for comparing two versions. Code keeps everything but
// spacing, line breaks, commas, semicolons, and round brackets. A string, a template, and a regular
// expression keep their contents exactly; only the quote mark, and the backslash before a quote mark,
// are dropped, so 'don\'t' and "don't" are the same. A comment keeps its words; runs of spaces in
// it count as one.
function withoutLayout(text, file) {
  const hash = /\.(py|pyi)$/.test(file);
  let out = '';
  let code = 'x'; // the code since the last literal, for telling a division from a regular expression
  const literal = (body) => {
    out += `\u0001${body}\u0001`;
    code = 'x';
  };
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    const lineEnd = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i);
    if (hash ? ch === '#' : text.startsWith('//', i)) {
      out += `\u0002${text.slice(i, lineEnd).replace(/\s+/g, ' ').trim()}\u0002`;
      i = lineEnd;
    } else if (!hash && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2) < 0 ? text.length : text.indexOf('*/', i + 2) + 2;
      out += `\u0002${text.slice(i, end).replace(/\s+/g, ' ')}\u0002`;
      i = end;
    } else if (!hash && ch === '/' && regexMayStart(code) && regexEnd(text.slice(i, lineEnd), 0) > 0) {
      const end = i + regexEnd(text.slice(i, lineEnd), 0);
      literal(text.slice(i, end));
      i = end;
    } else if ('"\'`'.includes(ch)) {
      const mark = hash && text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      const manyLines = mark.length === 3 || ch === '`';
      let end = i + mark.length;
      while (end < text.length && !text.startsWith(mark, end) && (manyLines || text[end] !== '\n')) end += text[end] === '\\' ? 2 : 1;
      if (!text.startsWith(mark, end) && !manyLines) {
        out += ch; // a lone quote mark: not a string
        i++;
      } else {
        literal(text.slice(i + mark.length, end).replace(/\\(['"`])/g, '$1'));
        i = Math.min(text.length, end + mark.length);
      }
    } else {
      if (!/[\s,;()]/.test(ch) && !(ch === '\\' && text[i + 1] === '\n')) out += ch;
      code += ch;
      i++;
    }
  }
  return out;
}

// True when two versions of a file differ in layout only (see withoutLayout). It is the second proof
// for a formatting-only change, beside the formatter's own output: a space added inside a string, or
// any changed word or operator, is not layout.
export function sameButLayout(a, b, file = '') {
  return withoutLayout(String(a), file) === withoutLayout(String(b), file);
}

// Formats many files at once, a few at a time, and says for each whether the result is exactly what was
// wanted. jobs: [{ command, input, want }]; command is a shell command that reads the file on standard
// input and prints the formatted file. It runs this script again as a helper, because the helper can
// run several formatters side by side while this call waits. A helper that cannot run answers false for all.
export function formatBatch(jobs, { cwd = process.cwd() } = {}) {
  const ran = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--format-batch'], { cwd, input: JSON.stringify(jobs), encoding: 'utf8', maxBuffer: 1 << 30 });
  try {
    const same = JSON.parse(ran.stdout);
    if (Array.isArray(same) && same.length === jobs.length) return same.map((v) => v === true);
  } catch {
    // no answer: nothing is let off
  }
  return jobs.map(() => false);
}

// The helper's side of formatBatch: runs each job's command, at most FORMAT_AT_ONCE at a time.
async function runFormatJobs(jobs, cwd) {
  const same = new Array(jobs.length).fill(false);
  const one = (job) => new Promise((done) => {
    const child = spawn('sh', ['-c', job.command], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.on('error', () => done(false));
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 && out === job.want);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(job.input);
  });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const at = next++;
      same[at] = await one(jobs[at]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FORMAT_AT_ONCE, jobs.length) }, worker));
  return same;
}

// `git diff --name-status -z -M` output -> [{ status, file, to? }]. A copy counts as a new file.
export function parseNameStatus(text) {
  const parts = String(text).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i].charAt(0);
    if (!status) continue;
    const file = parts[++i];
    const to = status === 'R' || status === 'C' ? parts[++i] : undefined;
    if (!file) continue;
    if (status === 'C') out.push({ status: 'A', file: to });
    else out.push(to === undefined ? { status, file } : { status, file, to });
  }
  return out;
}

// ---------- Reading a branch (git) ----------
// git(args, input) returns { code, stdout, stderr }; input, when given, goes to git's stdin.

// One preset, from the first place that holds a copy this version of the kit can load.
//   places: [{ label, read(file) -> text or null }], in the order to try them.
// A place with no copy is passed over in silence. A copy that cannot be loaded (a field the loader now
// needs is missing, a field it no longer knows, bad JSON) is passed over too, and when a later place
// then gives a good one, a line goes into notes: on the day a project takes a kit update, the base
// branch still holds the old preset files, and the merge of that very update must not be refused.
// Returns the preset, or null when no place holds a copy at all. Throws when copies were found and
// none of them loads.
function presetFrom(places, name, notes) {
  const file = `${PRESETS_DIR}/${name}.json`;
  const older = []; // the places whose copy could not be loaded
  let problem = null;
  for (const place of places) {
    const text = place.read(file);
    if (text === null) continue;
    try {
      const preset = validatePreset(JSON.parse(text), file);
      for (const label of older) notes.add(`${label} preset ${name} is in an older form; using ${place.label}`);
      return preset;
    } catch (e) {
      older.push(place.label);
      problem ??= e.message.startsWith(file) ? e.message : `${file}: not valid JSON (${e.message})`;
    }
  }
  if (problem) throw new Error(problem);
  return null;
}

// The reason lines the base branch already holds, as keys (reasonKey), read from the base branch as
// it is right now. The merge script and the reviewer's command both come through here, so a reason
// the one rejects is never offered for a ruling by the other. Returns a Set, or { fail }.
export function mergedReasons(git, baseRef) {
  const merged = git(['grep', '-h', '-I', '-e', '', baseRef, '--', REASON_DIR]);
  if (merged.code > 1) return { fail: `cannot read ${REASON_DIR} on ${baseRef}: ${merged.stderr.trim()}` };
  return new Set(linesOf(merged.stdout).map(reasonKey));
}

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

// Every weakening between the base and the tip, each with its reason.
//   isTest(file) -> bool, by the settings' "testPaths". extraSettingsFiles and snapshotPaths: the
//   project's own check settings files and snapshot files. readSettings(text) -> settings, for
//   sortSettings. presetNames: the presets to read from git; presets: already loaded ones, for tests.
//   basePresets: the base branch's presets, already loaded, for tests; the formatter command is
//   always taken from the base branch's copy of a preset, never the branch's own, because the branch
//   could bring a "formatter" made to print exactly what it wants waved through.
//   root: the folder formatters run in. format(jobs, { cwd }): formatBatch, or a stand-in.
//   onDisk: false when the tip is not what is checked out in root. A formatter reads its settings from
//   the files on disk, so its answer for another branch would be a guess: collect then fails with a
//   plain line as soon as a formatter would have to be asked.
// The callers hand in what the base branch's settings and the branch's own settings cover, taken
// together, so a branch cannot take a file out of protection in the same change that edits it.
// Returns { items: [{ file, to?, kind, what, reason, problem, id }], testsAdded, formattingOnly,
//   reasonFile, notes } or { fail }. notes: plain lines to print, such as a preset that was taken from
//   this branch because the base branch's copy is in an older form. reason is null and id is null while the reason is missing or will not do
//   (problem says why). formattingOnly: how many changed test files were let off as layout only.
export function collect({ baseRef, tip = 'HEAD', git, isTest, extraSettingsFiles = [], snapshotPaths = [], configFile = 'scripts/kit.config.json', readSettings = JSON.parse, presets, basePresets, root, presetNames = [], branch = '', format = formatBatch, onDisk = true }) {
  const fork = git(['merge-base', baseRef, tip]);
  if (fork.code !== 0) return { fail: `cannot find where ${tip} left ${baseRef}: ${(fork.stderr || 'no shared commit').trim()}` };
  const base = fork.stdout.trim();
  const notes = new Set(); // plain lines for the person running this, such as a preset taken from another place
  // Where a preset file can come from. Git first, so the answer does not depend on what is checked
  // out; the folder on disk only as the last resort, for a kit update that is not committed yet.
  const inGit = (ref) => (file) => {
    const shown = git(['show', `${ref}:${file}`]);
    return shown.code === 0 ? shown.stdout : null;
  };
  const onBranch = { label: "this branch's", read: inGit(tip) };
  const onBase = { label: "the base branch's", read: inGit(baseRef) };
  const inFolder = { label: 'the copy in this folder', read: (file) => (root && existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null) };
  const names = [...new Set([...presetNames, ALWAYS_ON])];
  let sets = presets;
  if (!sets) {
    // The patterns: this branch's copy of each preset, else the base branch's, else the folder's.
    try {
      sets = names.map((name) => {
        const preset = presetFrom([onBranch, onBase, inFolder], name, notes);
        if (!preset) throw new Error(`${PRESETS_DIR}/${name}.json is not on ${tip} or on the base branch`);
        return preset;
      });
    } catch (e) {
      return { fail: `cannot load the language presets: ${e.message}` };
    }
  }
  const diff = git(['diff', '--name-status', '-z', '-M', base, tip]);
  if (diff.code !== 0) return { fail: `cannot list the changed files: ${diff.stderr.trim()}` };
  const textAt = (rev, file) => {
    const shown = git(['show', `${rev}:${file}`]);
    return shown.code === 0 ? shown.stdout : null;
  };
  const families = [...SETTINGS_FAMILIES, ...extraSettingsFiles.map((e) => [e])];
  const settingsFiles = families.flat();
  // "First of its family" is judged against the base branch as it is right now, in the merge script
  // and in the reviewer's command alike: a file of that family may have landed there since the branch left.
  let baseFiles = null; // every file on the base branch, listed once, when a settings file was added
  const firstOfFamily = (file) => {
    if (!baseFiles) baseFiles = git(['ls-tree', '-r', '-z', '--name-only', baseRef]).stdout.split('\0').filter(Boolean);
    const family = families.find((f) => isCheckSettings(file, f));
    return !baseFiles.some((f) => isCheckSettings(f, family));
  };
  const guards = (file) => isTest(file) || isSnapshot(file, snapshotPaths);
  // The formatter command is the base branch's. Only when the base branch's copy of a preset cannot
  // be loaded (an older form) does this branch's copy stand in, with a line that says so. A base
  // branch that has no copy at all names no formatter.
  let baseSets = basePresets; // read once
  const baseNow = () => {
    baseSets ??= names.map((name) => {
      try {
        return onBase.read(`${PRESETS_DIR}/${name}.json`) === null ? null : presetFrom([onBase, onBranch, inFolder], name, notes);
      } catch {
        return null;
      }
    }).filter(Boolean);
    return baseSets;
  };
  const formatterFor = (file) => baseNow().find((p) => p.formatStdin && p.extensions.some((x) => file.endsWith(x)))?.formatStdin ?? null;
  // The base branch's patterns always count too (a base copy in an older form falls back as above).
  sets = joinPresets(sets, baseNow());
  // The files the kit installed. A whole new one of them is the kit's own test, not the project's work.
  let kitFiles = null;
  const isKitFile = (file) => {
    if (!kitFiles) {
      try {
        kitFiles = new Set(Object.keys(JSON.parse(onBranch.read(MANIFEST) ?? '{}').files ?? {}));
      } catch {
        kitFiles = new Set();
      }
    }
    return kitFiles.has(file);
  };
  const found = [];
  const layout = []; // changed test files that may differ in layout only: { item, command, input, want }
  const reasonLines = []; // every line of the reason files this change added or edited
  let testsAdded = 0;
  for (const e of parseNameStatus(diff.stdout)) {
    const now = e.to ?? e.file;
    const fresh = e.status === 'A';
    const gone = e.status === 'D';
    const before = fresh ? null : textAt(base, e.file);
    const after = gone ? null : textAt(tip, now);
    if (now.startsWith(REASON_DIR)) reasonLines.push(...linesOf(after));
    // Sorted by the old path first, whatever the new path is: a guard moved into the reasons folder,
    // or anywhere else, is still a guard that changed.
    let sorted = null;
    if (e.file === RATCHETS_FILE) sorted = fresh ? null : sortRatchets(before, e.to ? null : after);
    else if (e.file === configFile) sorted = fresh ? null : sortSettings(before, e.to ? null : after, readSettings);
    else if (isCheckSettings(e.file, settingsFiles) || isCheckSettings(now, settingsFiles)) {
      // The first settings file of its family is setup, not a change to a check that was there; but a
      // wait, time limit, or retry in it is looked for all the same, with every loaded preset's patterns.
      const parts = sortFlaky(exactLines(before), exactLines(after), now, flakyOf(sets, 'settings')).found;
      if (!(fresh && firstOfFamily(now))) parts.push({ kind: 'check-settings-changed', what: `a lint, type, or test settings file was ${fresh ? 'added' : gone ? 'deleted' : e.to ? `renamed to ${e.to}` : 'changed'}` });
      if (parts.length) sorted = { kind: parts[0].kind, what: parts.map((p) => p.what).join('; ') };
    } else if (fresh) {
      // A new test file is free, unless a line in it writes to something every test shares, or it
      // waits, sets a time limit, or retries.
      testsAdded += isTest(now) ? 1 : 0;
      const tested = isTest(now) && !isSnapshot(now, snapshotPaths);
      const lines = tested ? linesOf(after) : [];
      const write = firstSharedWrite(lines, now, lines.map((_, at) => at));
      // A whole new test file the kit installs (listed in its manifest, which only the head agent may
      // change) is free of the flaky kinds: the kit's own tests of timing need real waits.
      const parts = tested && !isKitFile(now) ? sortFlaky([], exactLines(after), now, patternsFor(now, sets).flaky).found : [];
      if (write) parts.push({ kind: 'unclear', what: `${SHARED_WRITE}: ${cut(write, 80)}` });
      if (parts.length) sorted = { kind: parts[0].kind, what: parts.map((p) => p.what).join('; ') };
    } else if (!guards(e.file)) testsAdded += e.to && isTest(e.to) ? 1 : 0;
    else if (gone) sorted = { kind: 'test-deleted', what: `the ${isTest(e.file) ? 'test' : 'snapshot'} file was deleted` };
    else if (e.to && !guards(e.to)) sorted = { kind: 'test-deleted', what: `renamed to ${e.to}, which "testPaths" does not count as a test file` };
    else {
      sorted = sortTestChange({ file: now, baseText: before, tipText: after, patterns: patternsFor(now, sets), snapshotPaths });
      if (e.to) sorted = sorted.kind === 'added' ? { kind: 'unclear', what: `renamed to ${e.to}; whether the test runner still finds it cannot be seen from here` } : { ...sorted, what: `renamed to ${e.to}; ${sorted.what}` };
    }
    if (!sorted || sorted.kind === 'added') continue;
    const item = { file: e.file, ...(e.to ? { to: e.to } : {}), ...sorted };
    found.push(item);
    // A test file that kept its name may have changed in layout only. Two proofs are asked for: the
    // two versions are the same once layout is taken out (strings kept exactly), and the formatter
    // named by the base branch's preset turns the base version into exactly the branch's version.
    // Snapshots never qualify.
    const formatter = e.status === 'M' && !isSnapshot(now, snapshotPaths) && isTest(now) && sameButLayout(before, after, now) ? formatterFor(now) : null;
    if (formatter) layout.push({ item, command: formatter.replaceAll('{file}', shellQuote(now)), input: before, want: after });
  }
  let formattingOnly = 0;
  if (layout.length && !onDisk) {
    return { fail: `cannot tell whether ${plural(layout.length, 'test file')} changed in formatting only: the formatter reads its settings from the files in this folder, and ${tip} is not what is checked out here. Run this again from a checkout of that branch.` };
  }
  if (layout.length) {
    const same = format(layout.map(({ command, input, want }) => ({ command, input, want })), { cwd: root });
    layout.forEach(({ item }, at) => {
      if (same[at] !== true) return;
      found.splice(found.indexOf(item), 1);
      formattingOnly++;
    });
  }
  if (!found.length) return { items: [], testsAdded, formattingOnly, reasonFile: reasonFile(branch), notes: [...notes] };
  // A reason counts only when the base branch does not hold it already, in any file and in any dress.
  const old = mergedReasons(git, baseRef);
  if (old.fail) return { fail: old.fail };
  const blob = (rev, file) => {
    const id = git(['rev-parse', '-q', '--verify', `${rev}:${file}`]);
    return id.code === 0 ? id.stdout.trim() : null;
  };
  const items = [];
  for (const item of found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const given = reasonFor(item.file, reasonLines.filter((l) => !old.has(reasonKey(l))));
    let problem = reasonProblem(given);
    if (given === null && reasonFor(item.file, reasonLines) !== null) problem = 'the only reason line for this file is already on the base branch, from an earlier change; write this change\'s own';
    const id = problem ? null : changeId({ ...item, reason: given, before: blob(base, item.file), after: blob(tip, item.to ?? item.file) });
    items.push({ ...item, reason: problem ? null : given, problem, id });
  }
  return { items, testsAdded, formattingOnly, reasonFile: reasonFile(branch), notes: [...notes] };
}

// The list as printed for a person: one line per weakening, its reason or the line to add.
export function describe({ items, reasonFile: file }) {
  if (!items.length) return 'No change on this branch weakens a test, a ratchet, or a check.';
  const lines = [`${plural(items.length, 'change')} on this branch ${items.length === 1 ? 'weakens' : 'weaken'} a guard. Each needs a reason from the builder and a ruling by a reviewer on another model:`];
  for (const i of items) {
    lines.push(`${i.kind}  ${i.file}`, `    spotted: ${i.what}`, `    reason: ${i.reason ?? `none (${i.problem})`}`);
  }
  const open = items.filter((i) => !i.id);
  if (open.length) lines.push(`Add one line for each to ${file} (make the file if it is not there):`, ...open.map((i) => `  ${reasonLine(i.file)}`));
  return lines.join('\n');
}

// ---------- Command line ----------

export async function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  if (argv[0] === '--format-batch' && argv.length === 1) {
    // The helper for formatBatch: the jobs come in on standard input, the answers go out as JSON.
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    out(JSON.stringify(await runFormatJobs(JSON.parse(input), cwd)));
    return 0;
  }
  const bad = argv.find((a) => a !== '--json');
  if (bad !== undefined) {
    err(`Wrong usage: unknown option ${bad}\n${USAGE}\n`);
    return 2;
  }
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // Loaded here, not at the top: merge-pr.mjs loads this file, and a loop of imports would hang.
    const { settings, guardScope, CONFIG_FILE } = await import('./merge-pr.mjs');
    const cfg = settings(loadConfig(root));
    const git = (args, input) => {
      const r = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const head = git(['symbolic-ref', '--short', '-q', 'HEAD']);
    const baseRef = `${cfg.remote}/${cfg.baseBranch}`;
    // As the merge script does: what the base branch's settings and this branch's own cover, together.
    const onBase = git(['show', `${baseRef}:${CONFIG_FILE}`]);
    const scope = guardScope(cfg, settings(mergeConfig(onBase.code === 0 ? JSON.parse(onBase.stdout) : {})));
    const found = collect({
      baseRef, git, root, isTest: scope.isTest, extraSettingsFiles: scope.extraSettingsFiles, snapshotPaths: scope.snapshotPaths,
      presetNames: scope.presetNames, readSettings: (json) => mergeConfig(JSON.parse(json)), branch: head.code === 0 ? head.stdout.trim() : '',
    });
    if (found.fail) throw new Error(found.fail);
    for (const note of found.notes) err(`Note: ${note}.\n`);
    if (found.formattingOnly && !argv.includes('--json')) out(`${plural(found.formattingOnly, 'test file')} changed in formatting only.\n`);
    out(argv.includes('--json') ? `${JSON.stringify(found)}\n` : `${describe(found)}\n`);
    return found.items.some((i) => !i.id) ? 1 : 0;
  } catch (e) {
    err(`test-changes: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}

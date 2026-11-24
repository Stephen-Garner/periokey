#!/usr/bin/env node
// checks-map.mjs: writes docs/checks-map.md, one table of every check, from the settings.
//
// What it does, in plain English:
//   It reads "checks" in scripts/kit.config.json and writes one row per check: its name, when it
//   runs, how long it last took, what it protects, and what it misses. "protects" and "misses" are
//   written by hand in the settings, one plain line each; when either is blank the script names the
//   check and fails, and writes nothing. The steps scripts/merge-pr.mjs runs itself get rows too:
//   rules, kit tests, and script tests always; incoming commits when "features.incomingCommits" is on;
//   and each of the five merge gates (verifiedStamp, changeChecklist, reviewLevels, securityReview,
//   findingAnswers) when its switch is on. A switch is on when it is true, "enforce", or "observe".
//   Their protects and misses lines are written in this script. A gate whose switch is "observe", or a
//   check marked "observe": true, has "(only watches)" after its trigger: it runs, but a failure does
//   not stop a merge.
//   When, by the same rule the merge script uses: "merge" is the full run before a merge, which runs
//   every check. "quick check" is node scripts/merge-pr.mjs --check --fast, which skips a check marked
//   "slot": true or "fast": false (a check with no "fast" key runs in it). "commit hook" is a job of
//   the same name in the lefthook settings (the rules checker always runs in the hook). The settings
//   file is the first found of lefthook, .lefthook, and .config/lefthook, each ending in .yml, .yaml,
//   .json, .jsonc, or .toml. Only the YAML ones can be read here; for the others the map and the
//   output say so in one line, and no row shows "commit hook" but rules.
//   Time: the newest time scripts/merge-pr.mjs saved for that check in its record of passed checks
//   (<git common dir>/kit-check-cache.json, the "ms" of each entry). With no saved time it says
//   "not measured".
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/checks-map.mjs            writes docs/checks-map.md
//   node scripts/checks-map.mjs --check    fails if docs/checks-map.md is not what the settings give
//                                          (the Time column is left out of the comparison, since it
//                                          changes on every run)
// Exit codes: 0 done (or up to date), 1 a blank "protects" or "misses", an old file, or an error, 2 wrong usage.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './check-plans.mjs';
import { commonDir } from './events.mjs';
import { CACHE_FILE, INCOMING, readCache } from './merge-pr.mjs';

export const MAP_FILE = 'docs/checks-map.md';
const USAGE = 'Usage: node scripts/checks-map.mjs [--check]';

// The checks scripts/merge-pr.mjs runs on its own, before the settings' list.
export const BUILT_IN = Object.freeze([
  { name: 'rules', hook: true, protects: 'The plan checker: plans and the roadmap in the right shape, and each branch changing only what its role may change.', misses: 'Whether the code works; it reads plans, branch names, and which paths changed.' },
  { name: 'kit tests', protects: 'The kit scripts in scripts/ still do what their tests say, even on a docs-only change.', misses: 'The project code; these tests cover only the kit scripts.' },
  { name: 'script tests', protects: 'The project scripts in scripts/ still do what their tests say, even on a docs-only change.', misses: 'Code outside scripts/.' },
]);

// The merge script's gates that each have a switch in "features", and run only at a merge.
export const GATE_ROWS = Object.freeze([
  { name: 'verifiedStamp', protects: 'A change to product code says how it was checked: a Verified: line naming ran, tests, or checks, or none with a reason.', misses: 'Whether the stamp is true; it reads what the commit says, not what was run.' },
  { name: 'changeChecklist', protects: 'Every row of docs/change-checklist.md that fits the change is answered in a review that counts.', misses: 'Risks the checklist has no row for, and whether an answer is right.' },
  { name: 'reviewLevels', protects: 'Each commit is reviewed at the level the change needs: quick, standard, or deep.', misses: 'How carefully the reviewer read; it checks the level, not the reading.' },
  { name: 'securityReview', protects: 'A change that needs a deep review also gets a security pass that says SECURITY: clear.', misses: 'Security problems the reviewer did not see.' },
  { name: 'findingAnswers', protects: 'Every finding a review counted gets an answer line from the builder in docs/findings/.', misses: 'Whether an answer is good; it checks that one is there.' },
]);

// A switch's mode: true is "enforce"; "observe" only watches; false, "off", or no value is off.
const modeOf = (value) => (value === true || value === 'enforce' ? 'enforce' : value === 'observe' ? 'observe' : 'off');

// The merge script's step for new commits, when "features.incomingCommits" is on.
export const INCOMING_ROW = Object.freeze({ name: INCOMING, protects: 'Every new commit on the branch has a valid message, no fixup commit left unsquashed, and no secret, even one added and later removed.', misses: 'Commits already on the base branch, and secrets in a shape the kit gitleaks settings do not know.' });

const HOOK_NAMES = ['lefthook', '.lefthook', '.config/lefthook'];
const HOOK_ENDINGS = ['.yml', '.yaml', '.json', '.jsonc', '.toml'];

// The lefthook settings in a project: { file, jobs, note }. note says when the file cannot be read here.
export function findHookFile(root) {
  for (const name of HOOK_NAMES) {
    for (const end of HOOK_ENDINGS) {
      const file = `${name}${end}`;
      if (!existsSync(join(root, file))) continue;
      if (end === '.yml' || end === '.yaml') return { file, jobs: hookJobs(readFileSync(join(root, file), 'utf8')), note: '' };
      return { file, jobs: [], note: `The commit hook settings file ${file} is a format this script cannot read (it reads only YAML), so only rules shows "commit hook".` };
    }
  }
  return { file: null, jobs: [], note: '' };
}

const blankText = (v) => typeof v !== 'string' || !v.trim();

// The names of checks with a blank "protects" or "misses": [{ name, fields: [...] }].
export function blanks(checks) {
  return checks.map((c) => ({ name: c.name, fields: ['protects', 'misses'].filter((k) => blankText(c[k])) })).filter((b) => b.fields.length);
}

// The newest saved time per check name, from the merge script's record: { name: ms }.
export function newestTimes(cache) {
  const best = {};
  for (const entry of Object.values(cache)) {
    if (!entry || typeof entry.name !== 'string' || !Number.isFinite(entry.ms) || !Number.isFinite(entry.passedAt)) continue;
    if (!best[entry.name] || entry.passedAt > best[entry.name].passedAt) best[entry.name] = entry;
  }
  return Object.fromEntries(Object.entries(best).map(([name, e]) => [name, e.ms]));
}

const cell = (text) => String(text).replace(/\|/g, '\\|').trim();

// The Markdown table, every column padded to one width so it reads well as plain text.
export function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(3, ...rows.map((r) => r[i].length)));
  const line = (r) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(rows[0]), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

// The job names of the pre-commit section of lefthook's YAML text (null: no file). Both forms count:
// "- name: x" items under "jobs:", and the keys under "commands:". Other sections (pre-push) do not.
export function hookJobs(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => /^pre-commit\s*:\s*$/.test(l));
  if (start < 0) return [];
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    section.push(line);
  }
  const indent = (l) => l.length - l.trimStart().length;
  const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const names = [];
  let commands = null;
  let keyIndent = null;
  for (const line of section) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const head = line.match(/^(\s*)(jobs|commands)\s*:\s*$/);
    if (head) {
      commands = head[2] === 'commands' ? head[1].length : null;
      keyIndent = null;
      continue;
    }
    const job = line.match(/^\s*-\s*name\s*:\s*(.+)$/);
    if (job && commands === null) names.push(unquote(job[1]));
    if (commands === null || indent(line) <= commands) {
      if (commands !== null) commands = null;
      continue;
    }
    keyIndent ??= indent(line);
    const key = line.match(/^\s*(['"]?[^'":\s][^'":]*['"]?)\s*:\s*$/);
    if (key && indent(line) === keyIndent) names.push(unquote(key[1]));
  }
  return names;
}

// When one check runs, by the merge script's rule for --fast and the hook's job names.
export function trigger(check, jobs = []) {
  const quick = !check.slot && check.fast !== false && !check.mergeOnly;
  const when = [check.hook || jobs.includes(check.name) ? 'commit hook' : '', quick ? 'quick check' : '', 'merge'].filter(Boolean).join(', ');
  return check.observe === true ? `${when} (only watches)` : when;
}

// The whole file. checks: the settings' list. times: { name: ms }. jobs: the commit hook's job names.
// features: the settings' switches, for the merge script's own steps that have one. hookNote: a line
// about an unreadable hook file.
export function buildMap(checks, times = {}, jobs = [], { features = {}, hookNote = '' } = {}) {
  const rows = [['Check', 'Trigger', 'Time', 'Protects', 'Misses']];
  const switched = (row, name, extra = {}) => {
    const mode = modeOf(features?.[name]);
    return mode === 'off' ? [] : [{ ...row, ...extra, ...(mode === 'observe' ? { observe: true } : {}) }];
  };
  const own = [...switched(INCOMING_ROW, 'incomingCommits'), ...GATE_ROWS.flatMap((g) => switched(g, g.name, { mergeOnly: true }))];
  for (const c of [...BUILT_IN, ...own, ...checks]) {
    const time = Number.isFinite(times[c.name]) ? `${(times[c.name] / 1000).toFixed(1)} s` : 'not measured';
    rows.push([c.name, trigger(c, jobs), time, c.protects, c.misses].map(cell));
  }
  return [
    '# Checks map',
    '',
    'Built by `node scripts/checks-map.mjs` from `scripts/kit.config.json`. Do not edit it by hand: change "protects" and "misses" in the settings, then run the script again.',
    '',
    'Trigger: "commit hook" runs on every commit (`lefthook.yml`), "quick check" is `node scripts/merge-pr.mjs --check --fast`, and "merge" is the full run before a merge. "(only watches)" means it runs, but a failure does not stop a merge. Time is the newest run that `scripts/merge-pr.mjs` measured.',
    '',
    ...(hookNote ? [hookNote, ''] : []),
    table(rows),
    '',
  ].join('\n');
}

// The file with the Time column and the padding taken out, for --check.
export function withoutTimes(text) {
  return String(text).split('\n').map((line) => {
    if (!line.startsWith('|')) return line;
    const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) return '|-|';
    cells[2] = '';
    return cells.join('|');
  }).join('\n');
}

function readTimes(root) {
  try {
    return newestTimes(readCache(join(commonDir(root), CACHE_FILE)));
  } catch {
    return {};
  }
}

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  if (argv.length > 1 || (argv.length && argv[0] !== '--check')) {
    err(`Wrong usage: ${argv.find((a) => a !== '--check') ?? 'too many arguments'}\n${USAGE}\n`);
    return 2;
  }
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const { checks, features } = loadConfig(root);
    const missing = blanks(checks);
    if (missing.length) {
      for (const b of missing) err(`check "${b.name}" has a blank ${b.fields.map((f) => `"${f}"`).join(' and ')} in scripts/kit.config.json\n`);
      err('Write one plain line for each: what the check catches, and what it cannot see. Nothing was written.\n');
      return 1;
    }
    const hook = findHookFile(root);
    if (hook.note) out(`${hook.note}\n`);
    const text = buildMap(checks, readTimes(root), hook.jobs, { features, hookNote: hook.note });
    const path = join(root, MAP_FILE);
    if (argv[0] === '--check') {
      const now = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (now !== null && withoutTimes(now) === withoutTimes(text)) {
        out(`${MAP_FILE} is up to date.\n`);
        return 0;
      }
      err(`${MAP_FILE} is ${now === null ? 'missing' : 'out of date'}. Run node scripts/checks-map.mjs and commit the result.\n`);
      return 1;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    const rows = text.split('\n').filter((l) => l.startsWith('| ')).length - 2;
    out(`Wrote ${MAP_FILE} (${rows} checks).\n`);
    return 0;
  } catch (e) {
    err(`checks-map: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

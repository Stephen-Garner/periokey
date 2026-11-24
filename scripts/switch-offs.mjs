#!/usr/bin/env node
// switch-offs.mjs: the switch-off guard. No comment in product code may switch a check off.
//
// What it does, in plain English:
//   Every lint, type, and format tool lets code say "skip this rule here" in a comment, such as
//   eslint-disable, @ts-ignore, # noqa, or #[allow(...)]. Most tools cannot be told to stop obeying
//   those comments, so this script finds them and fails. The patterns come from the language presets
//   (scripts/presets.mjs): each file is read with the patterns of the preset that covers its ending.
//   It looks at product code only: files under "productPaths" in scripts/kit.config.json, minus
//   folders listed in "notYetClean" (where lint is not enforced yet; formatting still is, so a switch-off
//   of kind "format" is still refused there), minus test files ("testPaths"), with a code ending: one a
//   loaded preset lists in "extensions" or "extraCodeExtensions" (such as .vue). Data files such as
//   JSON and Markdown are not scanned, and a binary file (one that holds a zero byte) is skipped. A
//   folder may be written with or without a leading "./" or a trailing "/"; "." and "./" are the whole repo. It also fails when a file that switches checks off for whole files (such as
//   eslint-suppressions.json or .gitleaksignore, listed in the presets' "switchOffFiles") is tracked
//   anywhere in the repo, in every mode but --count. There is no exceptions list, and none may be added: the code is fixed until the guard
//   passes. If a rule itself is wrong, the rule is changed in the project's lint or type settings,
//   for the whole project, in the open.
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/switch-offs.mjs [--staged] [--json] [files...]
//       With no files, it checks every file git tracks. --staged checks what git is about to commit:
//       the staged copy of each staged file (the pre-commit hook uses this), read by git object id, and
//       the staged copy of scripts/kit.config.json (else the last commit's, else the file on disk). It
//       prints each switch-off as "file:line what"; a name with a line break or a quote in it is
//       printed as a quoted, escaped string.
//   node scripts/switch-offs.mjs --count [--json]
//       Counts switch-offs in every tracked file a loaded preset covers, tests included, by kind
//       (lint, types, format, coverage, unsafe). Files the kit manages (listed in
//       scripts/kit.manifest.json) are left out. Always exits 0. scripts/ratchets.mjs uses the same count.
// Exit codes: 0 none found, 1 a switch-off found (or an error), 2 wrong usage.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILE, loadConfig, mergeConfig } from './check-plans.mjs';
import { MANIFEST_FILE, isTestFile, showName } from './merge-pr.mjs';
import { compiled, loadPresets } from './presets.mjs';

const USAGE = 'Usage: node scripts/switch-offs.mjs [--staged] [--json] [files...] | --count [--json]';
export const FIX_LINE = 'Fix the code so it passes with every check on; if the rule itself is wrong, change that rule in the project\'s lint or type settings, in the open (there is no exceptions list).';

// "./src", "src", and "src/" all mean the folder src/; "." and "./" mean the whole repo ("").
export function normalFolder(p) {
  const bare = p.replace(/^(\.\/)+/, '').replace(/^\.$/, '');
  return !bare || bare.endsWith('/') ? bare : `${bare}/`;
}
const under = (file, dirs) => dirs.some((d) => file.startsWith(normalFolder(d)));
const ending = (file) => {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};

// The switch-off patterns of every loaded preset, grouped by code ending: Map(".ts" -> [rule, ...]).
// A preset's extraCodeExtensions get its patterns too. A preset with no endings ("any") adds its
// patterns to every ending the others list. An ending missing from the map is not code.
export function rulesByEnding(presets) {
  const map = new Map();
  const endingsOf = (p) => [...p.extensions, ...p.extraCodeExtensions];
  for (const p of presets) for (const ext of endingsOf(p)) if (!map.has(ext)) map.set(ext, []);
  for (const p of presets) {
    for (const rule of compiled([p], 'switchOffs')) {
      for (const ext of endingsOf(p).length ? endingsOf(p) : [...map.keys()]) map.set(ext, [...map.get(ext), rule]);
    }
  }
  return map;
}

// Tracked files that switch checks off for whole files: [{ file, line: 0, what, kind: "file" }].
export function switchOffFiles(tracked, presets) {
  const named = new Map(presets.flatMap((p) => p.switchOffFiles.map((f) => [f.name, f.what])));
  return tracked.filter((f) => named.has(f.slice(f.lastIndexOf('/') + 1))).map((file) => ({ file, line: 0, what: named.get(file.slice(file.lastIndexOf('/') + 1)), kind: 'file' }));
}

// Product code: under productPaths, not under notYetClean, not a test file, with a code ending (a key
// of byEnding). includeUnclean: true also keeps notYetClean folders.
export function isProductFile(file, config, byEnding, { includeUnclean = false } = {}) {
  return under(file, config.productPaths) && (includeUnclean || !under(file, config.notYetClean))
    && !isTestFile(file, config.testPaths) && byEnding.has(ending(file));
}

// In a notYetClean folder lint is not enforced yet, but formatting is: only "format" switch-offs count there.
export const enforced = (found, config) => found.filter((f) => f.kind === 'format' || !under(f.file, config.notYetClean));

// Every switch-off in one file's text: [{ line, what, kind }].
export function findSwitchOffs(text, rules) {
  const found = [];
  String(text).split('\n').forEach((line, i) => {
    for (const r of rules) if (r.re.test(line)) found.push({ line: i + 1, what: r.what, kind: r.kind });
  });
  return found;
}

// files: [path]. read(path) -> text, or null when the file is gone. Returns [{ file, line, what, kind }].
// A binary file (it holds a zero byte) is skipped.
export function scanFiles(files, read, byEnding) {
  const found = [];
  for (const file of files) {
    const text = read(file);
    if (text === null || text.includes('\0')) continue;
    for (const f of findSwitchOffs(text, byEnding.get(ending(file)) ?? [])) found.push({ file, ...f });
  }
  return found;
}

// Counts by kind, with every kind the presets know (0 when none): { kind: { total, files: { path: n } } }.
export function countByKind(found, presets) {
  const counts = {};
  for (const r of compiled(presets, 'switchOffs')) counts[r.kind] ??= { total: 0, files: {} };
  for (const f of found) {
    counts[f.kind] ??= { total: 0, files: {} };
    counts[f.kind].total += 1;
    counts[f.kind].files[f.file] = (counts[f.kind].files[f.file] ?? 0) + 1;
  }
  return counts;
}

const git = (cwd, args, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 1 << 30, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
const splitZ = (text) => text.split('\0').filter(Boolean);

export const topLevel = (cwd) => git(cwd, ['rev-parse', '--show-toplevel']).trim();
export const trackedFiles = (root) => splitZ(git(root, ['ls-files', '-z']));
export const diskReader = (root) => (file) => {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return null;
  }
};

// Staged files that are added or changed, with the git object id of each staged copy:
// [{ file, id }]. Names are read split by zero bytes, so any name works.
export function stagedFiles(root) {
  const parts = git(root, ['diff', '--cached', '--raw', '-z', '--no-renames', '--diff-filter=ACM']).split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ file: parts[i + 1], id: parts[i].split(' ')[3] });
  return out;
}

// The staged copy of each file, read by object id with one git call. Returns Map(path -> text).
export function stagedTexts(root, staged) {
  const texts = new Map();
  if (!staged.length) return texts;
  const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: staged.map((s) => `${s.id}\n`).join(''), maxBuffer: 1 << 30 });
  let at = 0;
  for (const { file } of staged) {
    const nl = buf.indexOf(10, at);
    const head = buf.subarray(at, nl).toString('utf8');
    at = nl + 1;
    const size = Number(head.split(' ')[2]);
    if (!/ blob \d+$/.test(head)) continue;
    texts.set(file, buf.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return texts;
}

// The settings as git is about to commit them: the staged copy, else the last commit's, else the disk.
export function stagedConfig(root) {
  for (const ref of [`:${CONFIG_FILE}`, `HEAD:${CONFIG_FILE}`]) {
    let text;
    try {
      text = git(root, ['show', ref]);
    } catch {
      continue;
    }
    try {
      return mergeConfig(JSON.parse(text));
    } catch (e) {
      throw new Error(`${ref} (the copy of the settings git would commit): ${e.message}`);
    }
  }
  return loadConfig(root);
}

// Everything the guard needs from the project: { root, config, presets, byEnding }.
// staged: true reads the settings from git's staged copy (see stagedConfig).
export function project(cwd, { staged = false } = {}) {
  const root = topLevel(cwd);
  const config = staged ? stagedConfig(root) : loadConfig(root);
  const presets = loadPresets(root, config);
  return { root, config, presets, byEnding: rulesByEnding(presets) };
}

// The files the kit manages in this project (scripts/kit.manifest.json), which the project does not edit.
export function kitFiles(root) {
  const path = join(root, MANIFEST_FILE);
  if (!existsSync(path)) return new Set();
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(path, 'utf8')).files ?? {}));
  } catch (e) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON: ${e.message}`);
  }
}

// The ratchet count: every tracked file a preset covers, tests and notYetClean folders included.
// Files the kit manages are left out, so a kit update never moves a project's count.
export function countAll(p) {
  const kit = kitFiles(p.root);
  const files = trackedFiles(p.root).filter((f) => p.byEnding.has(ending(f)) && !kit.has(f));
  return countByKind(scanFiles(files, diskReader(p.root), p.byEnding), p.presets);
}

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const given = argv.filter((a) => !a.startsWith('--'));
  const unknown = [...flags].filter((f) => !['--staged', '--json', '--count'].includes(f));
  const wrong = unknown.length ? `unknown option ${unknown[0]}`
    : flags.has('--count') && (flags.has('--staged') || given.length) ? '--count takes no files and no --staged'
      : flags.has('--staged') && given.length ? 'give files or --staged, not both' : '';
  if (wrong) {
    err(`Wrong usage: ${wrong}\n${USAGE}\n`);
    return 2;
  }
  try {
    const p = project(cwd, { staged: flags.has('--staged') });
    if (flags.has('--count')) {
      const counts = countAll(p);
      if (flags.has('--json')) out(`${JSON.stringify(counts)}\n`);
      else out(`${Object.entries(counts).map(([k, v]) => `${k} ${v.total}`).join('\n') || 'no switch-off patterns loaded'}\n`);
      return 0;
    }
    const tracked = trackedFiles(p.root);
    const wholeFiles = switchOffFiles(tracked, p.presets);
    if (!p.config.productPaths.length) out('Switch-off guard: "productPaths" in scripts/kit.config.json is empty, so no file counts as product code yet.\n');
    let files;
    let read = diskReader(p.root);
    if (flags.has('--staged')) {
      const staged = stagedFiles(p.root).filter((s) => isProductFile(s.file, p.config, p.byEnding, { includeUnclean: true }));
      files = staged.map((s) => s.file);
      const texts = stagedTexts(p.root, staged);
      read = (f) => texts.get(f) ?? null;
    } else {
      files = (given.length ? given.map((f) => relative(p.root, resolve(realpathSync(cwd), f))) : tracked).filter((f) => isProductFile(f, p.config, p.byEnding, { includeUnclean: true }));
    }
    const found = [...wholeFiles, ...enforced(scanFiles(files, read, p.byEnding), p.config)];
    if (flags.has('--json')) out(`${JSON.stringify({ files: files.length, found })}\n`);
    else if (found.length) out(`${found.map((f) => `${showName(f.file)}${f.line ? `:${f.line}` : ''} ${f.what}`).join('\n')}\n\n${found.length} switched-off check${found.length === 1 ? '' : 's'} in product code. ${FIX_LINE}\n`);
    else out(`Switch-off guard: none in product code (${files.length} file${files.length === 1 ? '' : 's'} looked at).\n`);
    return found.length ? 1 : 0;
  } catch (e) {
    err(`switch-offs: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

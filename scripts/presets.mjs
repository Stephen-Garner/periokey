#!/usr/bin/env node
// presets.mjs: the language presets, and the loader every other script uses to read them.
//
// What it does, in plain English:
//   A preset is a named set of facts about one language, kept as data in scripts/presets/<name>.json.
//   The project turns presets on by listing their names in "presets" in scripts/kit.config.json. The
//   preset "any" is always on. This script checks each preset file and refuses a bad one with a
//   message that names the file and the field. It never runs a check itself: scripts/merge-pr.mjs
//   runs the commands in the settings' "checks" list, and "add" copies a preset's checks there.
//
// What a preset file holds (every field is required; a list may be empty):
//   name         the file's own name, without ".json"
//   extensions   file endings the preset covers, like ".ts". A file with one of these endings is read
//                with this preset's patterns.
//   extraCodeExtensions  more endings of code files the linters do not cover, like ".vue". The
//                switch-off guard and the useEffect count read these with this preset's switch-off
//                patterns too. Data files (JSON, Markdown) are never listed: they are not scanned.
//   checks       check commands for the settings, each { name, run, slot?, fast?, protects, misses }.
//                slot: true means a full test run that holds the machine's test slot. fast: true means
//                the quick check runs it too, not only the full run before a merge. protects and misses
//                are one plain line each: what the check catches, and what it cannot see.
//   switchOffs   comments that tell a tool "skip this rule here", each { pattern, kind, what }. kind is
//                one lowercase word (lint, types, format, coverage, unsafe); scripts/ratchets.mjs keeps
//                one count per kind. Read by scripts/switch-offs.mjs. A preset with no extensions ("any")
//                has its patterns used on every file the other loaded presets cover.
//   switchOffFiles files that switch checks off for whole files, each { name, what }. name is a file
//                name with no folder; scripts/switch-offs.mjs fails when a file of that name is tracked
//                anywhere in the repo.
//   skippedTests a test that is skipped or focused (so the others do not run), each { pattern, what }
//   assertions   a line that holds an assertion (a check of a value inside a test), each { pattern, what }
//   testNames    a line that names a test, each { pattern, what }; the pattern must hold a named group
//                (?<name>...) that captures the test's name
//   Three fields may be left out:
//   formatStdin  a shell command that formats one file: it reads
//                the file on standard input and prints the formatted file. "{file}" in it becomes the
//                file's path, so the formatter can pick the right rules. scripts/test-changes.mjs runs
//                it on the base branch's version of a changed test file: when the result is exactly the
//                branch's version, the change is formatting only and needs no reason.
//   propertyTests the usual property-test library for the language (a property test tries many
//                made-up inputs and checks a rule holds for all of them), such as "fast-check".
//   flakyWorkarounds lines that hide a flaky test (one that passes sometimes and fails sometimes with
//                no code change) instead of fixing it, each { kind, pattern, what, where? }. kind is
//                "wait-added" (a fixed wait), "timeout-raised" (a time limit), or "retry-added"
//                (running a failing test again). The pattern may hold a named group (?<value>...) that
//                captures the number (a time or a count; "None" and "Infinity" mean no limit). Read by
//                scripts/test-changes.mjs, which uses the number to let a lower limit or fewer retries
//                through for free. where: "tests" (only lines in test files) or "settings" (only lines
//                in test settings files, such as a bare retries key that in a test would be sample
//                data); left out, both.
//   Every pattern is a JavaScript regular expression, written as text, with no flags. It is matched
//   against one line at a time, so it cannot see across lines. skippedTests, assertions, testNames,
//   and flakyWorkarounds are for the script that sorts changes to test files: compile each with
//   new RegExp(entry.pattern), or call compiled(presets, field) below (for a field every preset has).
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/presets.mjs list            each preset's name, file endings, and number of checks
//   node scripts/presets.mjs show <name>     everything in one preset
//   node scripts/presets.mjs add <name>      adds the name to "presets" in scripts/kit.config.json, and
//       adds each of its checks (and the "any" preset's) to "checks" when no check of that name is
//       there yet. A check that is already there is never changed. It prints what it added. The file
//       is written again with two-space indents.
// Exit codes: 0 done, 1 an error (such as a bad preset file), 2 wrong usage.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, mergeConfig } from './check-plans.mjs';

export const PRESETS_DIR = 'scripts/presets';
export const CONFIG_PATH = 'scripts/kit.config.json';
export const ALWAYS_ON = 'any';
// The kinds a flakyWorkarounds entry may have; scripts/test-changes.mjs lists them among its weakenings.
export const FLAKY_KINDS = Object.freeze(['wait-added', 'timeout-raised', 'retry-added']);
const OPTIONAL = ['formatStdin', 'propertyTests', 'flakyWorkarounds'];
const FIELDS = ['name', 'extensions', 'extraCodeExtensions', 'checks', 'switchOffs', 'switchOffFiles', 'skippedTests', 'assertions', 'testNames'];
const CHECK_KEYS = ['name', 'run', 'slot', 'fast', 'protects', 'misses'];
const USAGE = 'Usage: node scripts/presets.mjs list | show <name> | add <name>';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isLine = (v) => typeof v === 'string' && v.trim().length > 0 && !/[\r\n]/.test(v);

// Checks one preset's data. file is the path shown in messages. Throws on the first problem.
export function validatePreset(data, file) {
  const bad = (msg) => {
    throw new Error(`${file}: ${msg}`);
  };
  if (!isObject(data)) bad('must be a JSON object');
  for (const k of Object.keys(data)) if (!FIELDS.includes(k) && !OPTIONAL.includes(k)) bad(`unknown field "${k}" (allowed: ${[...FIELDS, ...OPTIONAL].join(', ')})`);
  for (const k of FIELDS) if (!(k in data)) bad(`missing field "${k}"`);
  if ('formatStdin' in data && !isLine(data.formatStdin)) bad('"formatStdin" must be one line of text, not blank: a command that formats a file from standard input');
  if ('propertyTests' in data && !isLine(data.propertyTests)) bad('"propertyTests" must be one line of text, not blank: the name of a property-test library');
  if ('flakyWorkarounds' in data && !Array.isArray(data.flakyWorkarounds)) bad('"flakyWorkarounds" must be a list');
  (data.flakyWorkarounds ?? []).forEach((p, i) => {
    const where = `"flakyWorkarounds" entry ${i + 1}`;
    if (!isObject(p)) bad(`${where} must be an object`);
    for (const k of Object.keys(p)) if (!['kind', 'pattern', 'what', 'where'].includes(k)) bad(`${where} has unknown field "${k}" (allowed: kind, pattern, what, where)`);
    if ('where' in p && !['tests', 'settings'].includes(p.where)) bad(`${where}: "where" must be "tests" or "settings"`);
    if (!FLAKY_KINDS.includes(p.kind)) bad(`${where}: "kind" must be one of ${FLAKY_KINDS.join(', ')}`);
    for (const k of ['pattern', 'what']) if (!isLine(p[k])) bad(`${where}: "${k}" must be one line of text, not blank`);
    try {
      new RegExp(p.pattern);
    } catch (e) {
      bad(`${where}: "pattern" is not a valid regular expression (${e.message})`);
    }
  });
  const stem = file.replace(/^.*\//, '').replace(/\.json$/, '');
  if (data.name !== stem) bad(`"name" must be "${stem}", the file's own name`);
  if (!Array.isArray(data.extensions) || data.extensions.some((e) => typeof e !== 'string' || !/^\.[A-Za-z0-9]+$/.test(e))) {
    bad('"extensions" must list file endings like ".ts"');
  }
  if (!Array.isArray(data.extraCodeExtensions) || data.extraCodeExtensions.some((e) => typeof e !== 'string' || !/^\.[A-Za-z0-9]+$/.test(e))) {
    bad('"extraCodeExtensions" must list file endings like ".vue"');
  }
  for (const e of data.extraCodeExtensions) if (data.extensions.includes(e)) bad(`"extraCodeExtensions" lists "${e}", which is already in "extensions"`);
  if (!Array.isArray(data.checks)) bad('"checks" must be a list');
  const names = new Set();
  data.checks.forEach((c, i) => {
    const where = `"checks" entry ${i + 1}`;
    if (!isObject(c)) bad(`${where} must be an object`);
    for (const k of Object.keys(c)) if (!CHECK_KEYS.includes(k)) bad(`${where} has unknown field "${k}" (allowed: ${CHECK_KEYS.join(', ')})`);
    for (const k of ['name', 'run', 'protects', 'misses']) if (!isLine(c[k])) bad(`${where}: "${k}" must be one line of text, not blank`);
    for (const k of ['slot', 'fast']) if (k in c && typeof c[k] !== 'boolean') bad(`${where}: "${k}" must be true or false`);
    if (names.has(c.name)) bad(`"checks" has two entries named "${c.name}"`);
    names.add(c.name);
  });
  if (!Array.isArray(data.switchOffFiles)) bad('"switchOffFiles" must be a list');
  data.switchOffFiles.forEach((f, i) => {
    const where = `"switchOffFiles" entry ${i + 1}`;
    if (!isObject(f)) bad(`${where} must be an object`);
    for (const k of Object.keys(f)) if (!['name', 'what'].includes(k)) bad(`${where} has unknown field "${k}" (allowed: name, what)`);
    if (!isLine(f.name) || f.name.includes('/')) bad(`${where}: "name" must be a file name with no folder`);
    if (!isLine(f.what)) bad(`${where}: "what" must be one line of text, not blank`);
  });
  for (const field of ['switchOffs', 'skippedTests', 'assertions', 'testNames']) {
    if (!Array.isArray(data[field])) bad(`"${field}" must be a list`);
    data[field].forEach((p, i) => {
      const where = `"${field}" entry ${i + 1}`;
      const keys = field === 'switchOffs' ? ['pattern', 'kind', 'what'] : ['pattern', 'what'];
      if (!isObject(p)) bad(`${where} must be an object`);
      for (const k of Object.keys(p)) if (!keys.includes(k)) bad(`${where} has unknown field "${k}" (allowed: ${keys.join(', ')})`);
      for (const k of keys) if (!isLine(p[k])) bad(`${where}: "${k}" must be one line of text, not blank`);
      if (field === 'switchOffs' && !/^[a-z]+$/.test(p.kind)) bad(`${where}: "kind" must be one lowercase word, like "lint"`);
      try {
        new RegExp(p.pattern);
      } catch (e) {
        bad(`${where}: "pattern" is not a valid regular expression (${e.message})`);
      }
      if (field === 'testNames' && !p.pattern.includes('(?<name>')) bad(`${where}: "pattern" needs a (?<name>...) group`);
    });
  }
  return data;
}

// Every preset name that has a file, sorted.
export function presetNames(root) {
  const dir = join(root, PRESETS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function loadPreset(root, name) {
  const file = `${PRESETS_DIR}/${name}.json`;
  const path = join(root, file);
  if (!existsSync(path)) throw new Error(`${file}: no such preset (known: ${presetNames(root).join(', ') || 'none'})`);
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${e.message})`);
  }
  return validatePreset(data, file);
}

// The presets the settings turn on, plus "any", each checked. Throws with the bad file and field.
export function loadPresets(root, config) {
  const names = [...new Set([...(config.presets ?? []), ALWAYS_ON])];
  return names.map((name) => loadPreset(root, name));
}

// One field's patterns from every preset, compiled: [{ re, what, kind?, preset, extensions }].
export function compiled(presets, field) {
  return presets.flatMap((p) => p[field].map((e) => ({ ...e, re: new RegExp(e.pattern), preset: p.name, extensions: p.extensions })));
}

// The settings with the preset turned on and its checks (and "any"'s) added where the name is new.
// raw is the settings file's own JSON (not the filled-in defaults). Returns { next, added, turnedOn }.
export function addPreset(raw, preset, always) {
  const next = { ...raw, presets: [...(raw.presets ?? [])], checks: [...(raw.checks ?? [])] };
  const turnedOn = preset.name !== ALWAYS_ON && !next.presets.includes(preset.name);
  if (turnedOn) next.presets.push(preset.name);
  const have = new Set(next.checks.map((c) => c?.name));
  const added = [];
  for (const check of [...preset.checks, ...(preset.name === ALWAYS_ON ? [] : always.checks)]) {
    if (have.has(check.name)) continue;
    next.checks.push({ ...check });
    have.add(check.name);
    added.push(check.name);
  }
  return { next, added, turnedOn };
}

// Writes the settings only when the settings checker accepts them, so a refused change leaves the file as it was.
export function saveSettings(path, next, check = mergeConfig) {
  try {
    check(next);
  } catch (e) {
    throw new Error(`the settings checker refuses the new settings, so nothing was written: ${e.message}`);
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

function describe(p) {
  const lines = [`${p.name}: covers ${p.extensions.join(' ') || 'no file endings'}${p.extraCodeExtensions.length ? `; also scans ${p.extraCodeExtensions.join(' ')}` : ''}`, `property tests: ${p.propertyTests ?? 'none named'}`, 'checks:'];
  for (const c of p.checks) {
    const marks = [c.fast ? 'fast' : '', c.slot ? 'slot' : ''].filter(Boolean).join(', ');
    lines.push(`  ${c.name}${marks ? ` (${marks})` : ''}: ${c.run}`, `    protects: ${c.protects}`, `    misses: ${c.misses}`);
  }
  for (const [field, label] of [['switchOffs', 'switch-offs'], ['switchOffFiles', 'switch-off files'], ['skippedTests', 'skipped tests'], ['assertions', 'assertions'], ['testNames', 'test names'], ['flakyWorkarounds', 'flaky-test workarounds']]) {
    const list = p[field] ?? [];
    lines.push(`${label}:${list.length ? '' : ' none'}`);
    for (const e of list) lines.push(`  ${e.kind ? `[${e.kind}] ` : ''}${e.pattern ?? e.name}  ${e.what}`);
  }
  return `${lines.join('\n')}\n`;
}

const topLevel = (cwd) => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  const [cmd, name, ...extra] = argv;
  const wrong = (msg) => {
    err(`Wrong usage: ${msg}\n${USAGE}\n`);
    return 2;
  };
  if (extra.length || (cmd === 'list' && name)) return wrong('too many arguments');
  if ((cmd === 'show' || cmd === 'add') && !name) return wrong(`${cmd} needs a preset name`);
  if (!['list', 'show', 'add'].includes(cmd)) return wrong(cmd ? `unknown command ${cmd}` : 'no command');
  try {
    const root = topLevel(cwd);
    if (cmd === 'list') {
      const rows = presetNames(root).map((n) => loadPreset(root, n));
      out(rows.length ? `${rows.map((p) => `${p.name}  ${p.extensions.join(' ') || '(always on)'}  ${p.checks.length} checks`).join('\n')}\n` : 'no presets\n');
      return 0;
    }
    const preset = loadPreset(root, name);
    if (cmd === 'show') {
      out(describe(preset));
      return 0;
    }
    loadConfig(root);
    const path = join(root, CONFIG_PATH);
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    const { next, added, turnedOn } = addPreset(raw, preset, loadPreset(root, ALWAYS_ON));
    if (!turnedOn && !added.length) {
      out(`${name}: already on, and every one of its checks is already in ${CONFIG_PATH}; nothing changed\n`);
      return 0;
    }
    saveSettings(path, next);
    if (turnedOn) out(`turned on preset ${name} in ${CONFIG_PATH}\n`);
    out(added.length ? `added checks: ${added.join(', ')}\n` : 'added no checks: each name was already there\n');
    return 0;
  } catch (e) {
    err(`presets: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

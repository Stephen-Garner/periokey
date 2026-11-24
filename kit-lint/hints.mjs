#!/usr/bin/env node
// hints.mjs: prints lint problems with a one-line fix hint for each.
//
// What it does, in plain English:
//   Reads the JSON report of Oxlint ("oxlint -f json"), ESLint ("eslint -f json"), or gitleaks
//   ("--report-format json --report-path -") from standard input.
//   Prints each problem as "file:line rule message", then "fix: <hint>" when kit-lint/hints.json has a
//   hint for that rule. The kit's own rules (kit/...) already name the fix in their message.
//   A found secret prints only its file, line, and gitleaks rule: never the secret itself.
//   Lint problems in kit-owned files (listed in scripts/kit.manifest.json) are dropped: the kit tests
//   those in its own repo, and the project cannot change them. Oxlint needs this because its ignore
//   list cannot read the manifest.
//   Lint problems under the "notYetClean" folders of scripts/kit.config.json are dropped too, with one
//   closing line that says how many. A secret-scan report is never filtered.
//   Rule names are written the way the settings files write them: "eqeqeq", "typescript/no-explicit-any",
//   "react/exhaustive-deps", "kit/no-comments".
//
// How to run (Node 18 or newer), from the project root:
//   pnpm exec oxlint -f json . | node kit-lint/hints.mjs
//   pnpm exec eslint -f json . | node kit-lint/hints.mjs
//   gitleaks git --staged ... --report-format json --report-path - | node kit-lint/hints.mjs
//
// Exit codes: 0 no problems, 1 problems found (warnings count: zero warnings is the bar),
//             2 wrong usage or input that is not a lint report (for example, the lint tool crashed).

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../scripts/check-plans.mjs';

const PLUGIN_NAMES = { eslint: '', 'react-hooks': 'react', 'typescript-eslint': 'typescript', '@typescript-eslint': 'typescript' };

export function loadHints() {
  return JSON.parse(readFileSync(new URL('./hints.json', import.meta.url), 'utf8'));
}

export function kitFiles(root) {
  const path = join(root, 'scripts', 'kit.manifest.json');
  if (!existsSync(path)) return new Set();
  return new Set(Object.keys(JSON.parse(readFileSync(path, 'utf8')).files ?? {}));
}

export function normalisePath(path) {
  const folder = path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return folder === '' || folder === '.' ? '' : `${folder}/`;
}

export function ruleName(plugin, rule) {
  const name = plugin.replace(/^eslint-plugin-/, '');
  const short = name in PLUGIN_NAMES ? PLUGIN_NAMES[name] : name;
  return short ? `${short}/${rule}` : rule;
}

function fromOxlintCode(code) {
  const match = /^([^()]+)\(([^()]+)\)$/.exec(code ?? '');
  return match ? ruleName(match[1], match[2]) : 'oxlint';
}

function fromEslintId(ruleId) {
  if (!ruleId) return 'eslint';
  const slash = ruleId.lastIndexOf('/');
  return slash === -1 ? ruleId : ruleName(ruleId.slice(0, slash), ruleId.slice(slash + 1));
}

export function parseReport(text, cwd = process.cwd()) {
  const data = JSON.parse(text);
  if (Array.isArray(data) && data.every((item) => 'RuleID' in item)) {
    return data.map((leak) => ({ file: leak.File, line: leak.StartLine, rule: 'secret', message: `A secret (${leak.RuleID}) is in this line. It is hidden here.` }));
  }
  if (Array.isArray(data)) {
    return data.flatMap((file) =>
      file.messages.map((m) => ({ file: relative(cwd, file.filePath), line: m.line ?? 0, rule: fromEslintId(m.ruleId), message: m.message })),
    );
  }
  if (data && Array.isArray(data.diagnostics)) {
    return data.diagnostics.map((d) => ({ file: d.filename ?? '', line: d.labels?.[0]?.span?.line ?? 0, rule: fromOxlintCode(d.code), message: d.message }));
  }
  throw new Error('not an Oxlint, ESLint, or gitleaks JSON report');
}

export function formatProblems(problems, hints) {
  const lines = [];
  for (const p of problems) {
    lines.push(`${p.file}:${p.line} ${p.rule} ${p.message.replace(/\s+/g, ' ').trim()}`);
    if (hints[p.rule]) lines.push(`  fix: ${hints[p.rule]}`);
  }
  return lines.join('\n');
}

export function run(argv, io) {
  if (argv.length > 0) {
    io.error('Usage: <lint or gitleaks command with a JSON report> | node kit-lint/hints.mjs');
    return 2;
  }
  const text = io.readStdin();
  if (!text.trim()) {
    io.error('hints: no report came in. Check that the lint or secret-scan command ran and was asked for a JSON report.');
    return 2;
  }
  let problems;
  let notCounted = 0;
  try {
    problems = parseReport(text, io.cwd);
    if (problems.some((p) => p.rule !== 'secret')) {
      const kitOwned = kitFiles(io.cwd);
      const notYetClean = loadConfig(io.cwd).notYetClean.map(normalisePath);
      problems = problems.filter((p) => !kitOwned.has(p.file));
      const counted = problems.filter((p) => !notYetClean.some((folder) => p.file.startsWith(folder)));
      notCounted = problems.length - counted.length;
      problems = counted;
    }
  } catch (e) {
    io.error(`hints: could not read the report (${e.message}). Check that the command was asked for a JSON report.`);
    return 2;
  }
  if (problems.length > 0) {
    const what = problems[0].rule === 'secret' ? 'secret' : 'lint problem';
    io.print(formatProblems(problems, loadHints()));
    io.print(`${problems.length} ${what}${problems.length === 1 ? '' : 's'}.`);
  }
  if (notCounted > 0) {
    const one = notCounted === 1;
    io.print(`${notCounted} lint problem${one ? '' : 's'} in not-yet-clean folders ${one ? 'was' : 'were'} not counted (notYetClean in scripts/kit.config.json)`);
  }
  return problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const io = { readStdin: () => readFileSync(0, 'utf8'), print: console.log, error: console.error, cwd: process.cwd() };
  process.exitCode = run(process.argv.slice(2), io);
}

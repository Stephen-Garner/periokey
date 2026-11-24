#!/usr/bin/env node
// context-map.mjs: shows what an agent loads at the start of a thread, in order, with sizes.
//
// What it does, in plain English:
//   An agent's "context" is everything it has read before it starts work. Reading costs money and
//   attention, so this script lists each file, its size in bytes, and a rough token count ("about":
//   bytes divided by 4; a token is the unit an AI counts text in). It prints names and sizes only,
//   never what is inside a file. A file that is not there prints as "not present".
//   Two lists:
//   1. What each tool loads by itself, before any role file. Claude Code: ~/.claude/CLAUDE.md and the
//      project's CLAUDE.md or AGENTS.md. Codex: ~/.codex/AGENTS.md and the project's AGENTS.md.
//      Cursor: the project's AGENTS.md and the files in .cursor/rules/. A line that is only
//      "@path" in one of those files pulls that file in; the list shows it right under its parent
//      (one level only).
//   2. What each role reads, in order: the project's AGENTS.md, the role's guide, and each file the
//      guide's "Read first" list names, and the files those name in turn, each file once. This is the
//      same list the kit's "reading ceiling" check counts (kit/lint.mjs, check 8), so a role's total
//      here is the number that check holds down. The roles come from the "Roles" table in the core
//      rules. kit/ is not copied into projects, so the small reading functions below (stripFences,
//      readFirstItems, rolesFrom) are copies of the ones in kit/lint.mjs, not imports.
//   Run from a project, it reads the project's files (docs/agents/...). Run from the kit itself, it
//   reads the kit's (process/..., with template/AGENTS.md standing for the project's AGENTS.md).
//
// How to run (Node 18 or newer):
//   node scripts/context-map.mjs [--role <role>] [--json]
//     --role   only that role: head-agent, builder, reviewer, or researcher
//     --json   print the same facts as JSON
// Exit codes: 0 done, 1 the guides could not be read, 2 wrong usage.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: node scripts/context-map.mjs [--role <role>] [--json]';
const PATH_SPAN = /^[A-Za-z0-9_.~/@-]+\.(md|mjs|json)$/;
const HAS_BLANK = /[<*]|NNN|YYYY/;

export const tokensOf = (bytes) => Math.ceil(bytes / 4);

// ---------- Copies of the small reading functions in kit/lint.mjs ----------

const lines = (text) => text.replace(/\r\n/g, '\n').split('\n');

// Blanks out fenced code blocks but keeps the line count. A fence opens with up to 3 spaces of
// indentation, or at any indentation with anyIndent (a fence under a list item). It closes on a
// matching fence (same character, at least as long) indented no more than 3 spaces beyond the opening one.
export function stripFences(text, { anyIndent = false } = {}) {
  const open = anyIndent ? /^([ \t]*)(`{3,}|~{3,})(.*)$/ : /^( {0,3})(`{3,}|~{3,})(.*)$/;
  const out = [];
  let fence = null;
  for (const line of lines(text)) {
    const m = line.match(open);
    if (!fence) {
      if (m) { fence = { char: m[2][0], length: m[2].length, indent: m[1].length }; out.push(''); } else out.push(line);
    } else if (m && m[2][0] === fence.char && m[2].length >= fence.length && m[1].length <= fence.indent + 3 && m[3].trim() === '') {
      fence = null;
      out.push('');
    } else out.push('');
  }
  return out.join('\n');
}

// A guide's reading list: the code spans in list items of the section whose heading starts with "Read first".
export function readFirstItems(text) {
  const items = [];
  let inside = false;
  let inItem = false;
  let afterBlank = false;
  lines(stripFences(text)).forEach((line, i) => {
    if (/^ {0,3}#{1,6}[ \t]/.test(line)) { inside = /^ {0,3}#{1,6}[ \t]+Read first/.test(line); inItem = false; return; }
    if (!line.trim()) { afterBlank = true; return; }
    const blank = afterBlank;
    afterBlank = false;
    if (/^\s*(\d+\.|[-*])\s/.test(line)) inItem = true;
    else if (inItem && (!blank || /^\s/.test(line))) inItem = true;
    else inItem = false;
    if (!inside || !inItem) return;
    for (const m of line.matchAll(/`([^`]+)`/g)) items.push({ line: i + 1, span: m[1].trim() });
  });
  return items;
}

// The roles from the "Roles" table in the core rules: each row's "Guide" cell (a `docs/agents/X.md`
// code span) makes role X, whose guide is guideDir + "X.md". Returns { roles, problems }.
export function rolesFrom(coreText, coreName, guideDir) {
  const roles = {};
  const problems = [];
  let inside = false;
  let guideAt = null;
  lines(stripFences(coreText)).forEach((line, i) => {
    if (/^ {0,3}#{1,6}[ \t]/.test(line)) { inside = /^ {0,3}#{1,6}[ \t]+Roles[ \t]*$/.test(line); guideAt = null; return; }
    if (!inside || !line.trim().startsWith('|')) return;
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
    if (guideAt === null) {
      guideAt = cells.indexOf('Guide');
      if (guideAt < 0) problems.push(`${coreName}:${i + 1}: the "Roles" table has no "Guide" column`);
      return;
    }
    if (guideAt < 0 || cells.every((c) => /^:?-+:?$/.test(c))) return;
    const m = (cells[guideAt] ?? '').match(/^`docs\/agents\/([a-z0-9-]+)\.md`$/);
    if (m) roles[m[1]] = `${guideDir}${m[1]}.md`;
    else problems.push(`${coreName}:${i + 1}: the "Roles" table row for ${cells[0]} names no guide`);
  });
  if (!Object.keys(roles).length && !problems.length) problems.push(`${coreName}:1: has no "Roles" table naming each role's guide`);
  return { roles, problems };
}

// A path in a "Read first" list is a project path. In the kit, find where the kit keeps that file.
export function kitSource(path) {
  if (path.startsWith('docs/agents/')) return `process/${path.slice('docs/agents/'.length)}`;
  if (path.startsWith('.githooks/')) return `scripts/githooks/${path.slice('.githooks/'.length)}`;
  if (/^scripts\/[^/]+\.mjs$/.test(path)) return path;
  return `template/${path}`;
}

// ---------- What a role reads ----------

// read(path) -> text or null. Returns the role's files in order: [{ path, bytes }], bytes null when
// the file is not there. A listed file that is not there is shown but not followed.
export function roleFiles(read, guide, always, source = (p) => p) {
  const files = [];
  const seen = new Set();
  const queue = [...always, guide];
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    if (seen.has(path)) continue;
    seen.add(path);
    const text = read(path);
    files.push({ path, bytes: text === null ? null : Buffer.byteLength(text, 'utf8') });
    if (text === null) continue;
    for (const { span } of readFirstItems(text)) {
      if (!PATH_SPAN.test(span) || HAS_BLANK.test(span)) continue;
      queue.push(source(posix.normalize(span)));
    }
  }
  return files;
}

// ---------- What each tool loads by itself ----------

const fileEntry = (abs, shown) => {
  let bytes = null;
  try { if (statSync(abs).isFile()) bytes = statSync(abs).size; } catch { /* not present */ }
  return { path: shown, abs, bytes };
};

// The @path lines of a file (not inside a fenced code block, which only shows examples), as absolute paths. A "~/" start means the home folder; a relative path
// is relative to the file that names it.
export function includesOf(text, fromAbs, home) {
  const out = [];
  for (const line of lines(stripFences(text, { anyIndent: true }))) {
    const m = line.trim().match(/^@(\S+)$/);
    if (!m) continue;
    const p = m[1];
    out.push(p.startsWith('~/') ? join(home, p.slice(2)) : resolve(dirname(fromAbs), p));
  }
  return out;
}

// ctx: { root, home, base } where base is "" in a project and "template/" in the kit. Returns
// { "Claude Code": [entry], Codex: [entry], Cursor: [entry] }, each entry { path, bytes, included }.
export function toolFiles({ root, home, base }) {
  const show = (abs) => {
    if (abs.startsWith(root + sep)) return relative(root, abs).split(sep).join('/');
    if (abs.startsWith(home + sep)) return `~/${relative(home, abs).split(sep).join('/')}`;
    return abs;
  };
  const one = (abs) => {
    const e = fileEntry(abs, show(abs));
    const list = [{ path: e.path, bytes: e.bytes, included: false }];
    if (e.bytes !== null) {
      const seen = new Set([abs]);
      for (const inc of includesOf(readFileSync(abs, 'utf8'), abs, home)) {
        if (seen.has(inc)) continue;
        seen.add(inc);
        const c = fileEntry(inc, show(inc));
        list.push({ path: c.path, bytes: c.bytes, included: true });
      }
    }
    return list;
  };
  const projectAgents = join(root, base, 'AGENTS.md');
  const projectClaude = join(root, base, 'CLAUDE.md');
  const claudeProject = existsSync(projectClaude) ? projectClaude : projectAgents;
  const rulesDir = join(root, base, '.cursor', 'rules');
  let rules = [];
  try {
    rules = readdirSync(rulesDir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(rulesDir, d.name)).sort();
  } catch { /* no rules folder */ }
  const cursorRules = rules.length ? rules.flatMap(one) : [{ path: `${show(rulesDir)}/`, bytes: null, included: false }];
  return {
    'Claude Code': [...one(join(home, '.claude', 'CLAUDE.md')), ...one(claudeProject)],
    Codex: [...one(join(home, '.codex', 'AGENTS.md')), ...one(projectAgents)],
    Cursor: [...one(projectAgents), ...cursorRules],
  };
}

// ---------- The whole map ----------

const withTotal = (files) => {
  const total = files.reduce((sum, f) => sum + (f.bytes ?? 0), 0);
  return { files: files.map((f) => ({ ...f, tokens: f.bytes === null ? null : tokensOf(f.bytes) })), total, tokens: tokensOf(total) };
};

// Returns { mode, problems, tools, roles }. mode is "kit" or "project".
export function buildMap(root, home) {
  const read = (p) => { try { return statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : null; } catch { return null; } };
  const kit = read('kit/lint.mjs') !== null && read('process/core.md') !== null;
  const coreName = kit ? 'process/core.md' : 'docs/agents/core.md';
  const core = read(coreName);
  if (core === null) return { mode: kit ? 'kit' : 'project', problems: [`${coreName} is not here. Run this from a project that has the starter kit, or from the kit.`], tools: {}, roles: {} };
  const { roles: guides, problems } = rolesFrom(core, coreName, kit ? 'process/' : 'docs/agents/');
  const always = [kit ? 'template/AGENTS.md' : 'AGENTS.md'];
  const roles = {};
  for (const [role, guide] of Object.entries(guides)) roles[role] = withTotal(roleFiles(read, guide, always, kit ? kitSource : undefined));
  const tools = {};
  for (const [tool, files] of Object.entries(toolFiles({ root, home, base: kit ? 'template/' : '' }))) tools[tool] = withTotal(files);
  return { mode: kit ? 'kit' : 'project', problems, tools, roles };
}

// ---------- Printing ----------

const sizeText = (f) => (f.bytes === null ? 'not present' : `${f.bytes} bytes, about ${f.tokens} tokens`);
const totalText = (x) => `Total: ${x.total} bytes, about ${x.tokens} tokens`;

export function formatMap(map, root, roleNames) {
  const out = [];
  out.push(`Context map for the ${map.mode} at ${root}`);
  out.push('Sizes are in bytes. "About N tokens" is the bytes divided by 4, a rough guess.');
  out.push('');
  out.push('What each tool loads by itself, before any role file');
  for (const [tool, x] of Object.entries(map.tools)) {
    out.push(`  ${tool}`);
    for (const f of x.files) out.push(`    ${f.included ? '@ ' : ''}${f.path}: ${sizeText(f)}`);
    out.push(`    ${totalText(x)}`);
  }
  for (const role of roleNames) {
    const x = map.roles[role];
    out.push('');
    out.push(`Role ${role}: what it reads, in order (this is the list the reading ceiling counts)`);
    x.files.forEach((f, i) => out.push(`  ${i + 1}. ${f.path}: ${sizeText(f)}`));
    out.push(`  ${totalText(x)}`);
  }
  return `${out.join('\n')}\n`;
}

// io: { stdout, stderr, cwd, home } (all optional).
export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const root = resolve(io.cwd || process.cwd());
  const home = resolve(io.home || homedir());
  let role = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--role' && i + 1 < argv.length && !argv[i + 1].startsWith('--')) role = argv[++i];
    else { err(`${USAGE}\n`); return 2; }
  }
  const map = buildMap(root, home);
  if (map.problems.length) {
    err(`${map.problems.join('\n')}\n`);
    return 1;
  }
  if (role !== null && !(role in map.roles)) {
    err(`There is no role "${role}". The roles are: ${Object.keys(map.roles).join(', ')}.\n${USAGE}\n`);
    return 2;
  }
  const names = role === null ? Object.keys(map.roles) : [role];
  if (json) {
    out(`${JSON.stringify({ mode: map.mode, root, tools: map.tools, roles: Object.fromEntries(names.map((n) => [n, map.roles[n]])) }, null, 2)}\n`);
  } else out(formatMap(map, root, names));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}

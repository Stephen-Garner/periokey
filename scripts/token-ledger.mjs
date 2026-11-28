#!/usr/bin/env node
// token-ledger.mjs: shows how many AI tokens the agents spent, next to how much work got merged.
//
// What it does, in plain English:
//   Every Claude Code, Codex, and Antigravity thread leaves a transcript on this Mac: one line per event, and
//   each model reply line says how many tokens it used. This script:
//   1. finds the transcripts for this project (Claude: ~/.claude/projects/<dir with the project
//      key in its name>; Codex: ~/.codex/sessions and ~/.codex/archived_sessions, sessions whose
//      working folder contains the project key; Antigravity: ~/.t3/userdata/providers/antigravity,
//      sessions whose workspace or first prompt contains the project key);
//   2. reads each file one line at a time (never the whole file) and keeps only numbers: turns,
//      tokens per day, start-up load (the context size on the first turn, paid before any work),
//      peak context, context at the last turn, how many times the tool summarized (shrank) the
//      thread, role, slice id, how many `sleep` shell calls it made, and for each turn its time,
//      tokens, and branch (so a run is charged only for its own turns);
//   3. saves those numbers in a cache file keyed by path, size, and change time, so the next run
//      only reads new or changed transcripts;
//   4. counts merged pull requests per day from git, split into code and docs-only (docs-only as
//      the merge script defines it: every changed file is on paperworkPaths in the settings);
//   5. prints a short report: tokens per day, per role, per slice, a start-up load check, and
//      warnings for very long threads and for threads that were summarized.
//   6. with --run docs/runs/<name>.json (scripts/run-file.mjs), adds one block for that run: tokens
//      charged per branch against the run's limit, review rounds per slice (docs/receipts/), real and
//      mistaken blocks (<git common dir>/kit-block-log.jsonl), parked slices, and a rough rework
//      figure once 14 days have passed since the run ended. The method of each is above its function.
//   It never prints transcript text.
//
// How to run (from the repo root):
//   node scripts/token-ledger.mjs [--days 7] [--project unilex] [--run docs/runs/<name>.json]
//                                 [--json] [--html out.html] [--cache file.json | --no-cache]
//   Env overrides (the tests use them): LEDGER_CLAUDE_DIR (default ~/.claude/projects),
//   LEDGER_CODEX_DIR (default ~/.codex, which holds sessions/ and archived_sessions/), and
//   LEDGER_ANTIGRAVITY_DIR (default ~/.t3/userdata/providers/antigravity).
//   Exit 0 on success, 1 when the run file cannot be read, 2 on wrong usage.

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { loadConfig, parsePlan } from './check-plans.mjs';
import { BLOCK_LOG_FILE, isPaperwork, settings } from './merge-pr.mjs';
import { RECEIPT_DIR } from './receipt.mjs';
import { readRun } from './run-file.mjs';

const CACHE_VERSION = 5;
const LIMITS = { turns: 150, peak: 200_000, sleeps: 10 };
const M = (n) => (n / 1e6).toFixed(1);
const K = (n) => `${Math.round(n / 1e3)}k`;

const USAGE = `Usage: node scripts/token-ledger.mjs [--days N] [--project KEY] [--run FILE] [--json] [--html FILE] [--cache FILE | --no-cache]`;

// ---- small helpers ----

export function localDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function median(values) {
  const a = values.filter((v) => typeof v === 'number').sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

function isWorktreePath(pathStr, worktrees) {
  if (!pathStr || !worktrees) return false;
  const norm = normPath(pathStr).toLowerCase();
  if (!norm) return false;
  for (const wt of worktrees) {
    const w = normPath(wt).toLowerCase();
    if (w && (norm === w || norm.startsWith(`${w}/`))) return true;
  }
  return false;
}

export function gitWorktreePaths(cwd) {
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const paths = new Set();
  const add = (p) => {
    paths.add(p);
    if (process.platform === 'darwin' && /^\/private\/(?:tmp|var)(?:\/|$)/.test(p)) {
      paths.add(p.slice('/private'.length));
    }
  };
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue;
    const raw = line.slice('worktree '.length).trim();
    if (!raw) continue;
    const abs = resolve(cwd, raw);
    add(abs);
    try {
      add(realpathSync(abs));
    } catch {
      // worktree folder may be pruned or missing on disk
    }
  }
  return [...paths];
}

export function pathMatchesProject(pathStr, projectKey, worktrees = []) {
  if (!pathStr) return false;
  if (isWorktreePath(pathStr, worktrees)) return true;
  if (!projectKey) return false;
  return new RegExp(`(?:^|[\\\\/])${escapeRe(projectKey)}(?:[\\\\/]|$)`, 'i').test(String(pathStr));
}

function textMatchesProject(text, projectKey) {
  if (!text || !projectKey) return false;
  return new RegExp(`(?:^|[^a-z0-9_-])${escapeRe(projectKey)}(?:$|[^a-z0-9_-])`, 'i').test(String(text));
}

// The role of a thread, from its first user message. One place for every pattern.
export function classifyRole(text) {
  const t = String(text || '').replace(/\*\*/g, '');
  // "You are the <Project> head agent" is the kit's own start line (template/AGENTS.md); the other two are UniLex's.
  if (/^\s*(?:You are the (?:(?!not\b)[A-Za-z0-9._'\u2019-]+\s+){0,2}head agent\b|Start working on the next slice|Context handoff)/i.test(t)) return 'head';
  if (/\breviewer\b|review sub-agent|code auditor|audit worker|\bblind neon\b/i.test(t)) return 'reviewer';
  if (/\bbuilder\b|implementation sub-agent|test sub-agent/i.test(t)) return 'builder';
  return 'other';
}

// A 3-digit slice id from the git branch (build/072-x, lead/052-y), the folder, or the first user
// prompt (for review worktrees whose branch omits the slice number), else null.
export function sliceId(branch, cwd, firstUser = null) {
  const fromBranch = String(branch || '').match(/(?:^|\/)(\d{3})(?=-|$)/);
  if (fromBranch) return fromBranch[1];
  const fromCwd = String(cwd || '').match(/(?:^|[/-])(\d{3})(?=-|\/|$)/);
  if (fromCwd) return fromCwd[1];
  if (firstUser) {
    const text = String(firstUser);
    for (const pat of [
      /\bTASK:\s*(\d{3})(?=-|\b)/i,
      /\b(?:build|lead)\/(\d{3})(?=-|$)/,
      /docs\/plans\/(?:active|completed)\/(\d{3})-/,
      /\b(?:Slice|UniLex)\s+0?(\d{3})\b/i,
    ]) {
      const m = text.match(pat);
      if (m) return m[1];
    }
  }
  return null;
}

// Default Claude Code project folders on this Mac: ~/.claude/projects plus any secondary account
// folders like ~/.claude-acct2/projects. When LEDGER_CLAUDE_DIR is set, only that folder is used.
export function defaultClaudeDirs(env = process.env, home = homedir()) {
  if (env.LEDGER_CLAUDE_DIR) return [env.LEDGER_CLAUDE_DIR];
  const dirs = [join(home, '.claude', 'projects')];
  try {
    for (const e of readdirSync(home, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('.claude-')) continue;
      const p = join(home, e.name, 'projects');
      if (existsSync(p)) dirs.push(p);
    }
  } catch {
    // home folder unreadable: stick to the default path
  }
  return dirs;
}

// Default Antigravity transcript root on this Mac: ~/.t3/userdata/providers/antigravity.
// When LEDGER_ANTIGRAVITY_DIR is set, only that folder is used. If LEDGER_ANTIGRAVITY_DIR is unset
// while LEDGER_CLAUDE_DIR or LEDGER_CODEX_DIR is set (test isolation), return no default folders.
export function defaultAntigravityDirs(env = process.env, home = homedir()) {
  if (env.LEDGER_ANTIGRAVITY_DIR) return [env.LEDGER_ANTIGRAVITY_DIR];
  if (env.LEDGER_CLAUDE_DIR || env.LEDGER_CODEX_DIR) return [];
  return [join(home, '.t3', 'userdata', 'providers', 'antigravity')];
}

export function findAntigravityFiles(dirs) {
  const roots = Array.isArray(dirs) ? dirs : dirs ? [dirs] : [];
  const out = [];
  const seen = new Set();
  const skipDirs = new Set(['worktrees', 'node_modules', '.git', 'chunks', 'media']);
  const add = (p) => {
    if (!seen.has(p) && existsSync(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  const listDirs = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !skipDirs.has(e.name));
    } catch {
      return [];
    }
  };
  const addBrain = (brainDir) => {
    for (const conv of listDirs(brainDir)) {
      add(join(brainDir, conv.name, '.system_generated', 'logs', 'transcript.jsonl'));
    }
  };
  for (const rootDir of roots) {
    if (!rootDir) continue;
    let entries;
    try {
      entries = readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        const sub = join(rootDir, e.name);
        if (e.name === 'brain') {
          addBrain(sub);
        } else {
          add(join(sub, '.system_generated', 'logs', 'transcript.jsonl'));
          addBrain(join(sub, 'antigravity-acp', 'brain'));
        }
      } else if (e.name.endsWith('.jsonl') && e.name !== 'transcript_full.jsonl') {
        add(join(rootDir, e.name));
      }
    }
  }
  return out;
}

async function* lines(path) {
  const stream = createReadStream(path);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // a half-written last line: skip it
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function addDay(days, ts, tokens) {
  const d = localDate(ts);
  if (d) days[d] = (days[d] || 0) + tokens;
}

function topKey(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ---- parsing one transcript into a small summary (numbers only, no text) ----

export async function parseClaudeFile(path) {
  const replies = new Map(); // message id -> { ts, model, ctx, total, branch }; usage repeats across lines
  const branches = {};
  let onBranch = null; // the branch of the latest line that named one
  let cwd = null;
  let start = null;
  let last = null;
  let firstUser = null;
  let sleeps = 0;
  let boundaries = 0; // {type:"system", subtype:"compact_boundary"}: one per summary (a guessed shape)
  let summaryLines = 0; // {type:"user", isCompactSummary:true}: the summary text itself
  for await (const j of lines(path)) {
    if (j.timestamp && !start) start = j.timestamp;
    if (j.timestamp) last = j.timestamp;
    if (j.gitBranch) branches[j.gitBranch] = (branches[j.gitBranch] || 0) + 1;
    if (j.gitBranch) onBranch = j.gitBranch;
    if (j.type === 'system' && j.subtype === 'compact_boundary') boundaries++;
    if (j.type === 'user' && j.isCompactSummary) summaryLines++;
    if (j.cwd && !cwd) cwd = j.cwd;
    const m = j.message;
    if (j.type === 'user' && m && firstUser === null && !j.isMeta && !j.isCompactSummary) {
      const c = m.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
      if (text && !/^<(command|local-command)/.test(text)) firstUser = text.slice(0, 2000);
    }
    if (j.type === 'assistant' && m && m.model !== '<synthetic>') {
      const u = m.usage || {};
      const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const id = m.id || j.uuid;
      replies.set(id, { ts: j.timestamp, model: m.model, ctx, total: ctx + (u.output_tokens || 0), branch: onBranch });
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'tool_use' && c.name === 'Bash' && /\bsleep\b/.test(String(c.input?.command || ''))) sleeps++;
      }
    }
  }
  const turns = [...replies.values()];
  const days = {};
  const models = {};
  let total = 0;
  let peak = 0;
  for (const t of turns) {
    total += t.total;
    peak = Math.max(peak, t.ctx);
    models[t.model] = (models[t.model] || 0) + t.total;
    addDay(days, t.ts, t.total);
  }
  const branch = topKey(branches);
  return {
    tool: 'claude',
    id: basename(path, '.jsonl'),
    model: topKey(models),
    start,
    turns: turns.length,
    startup: turns[0]?.ctx || 0,
    peak,
    total,
    days,
    role: classifyRole(firstUser),
    slice: sliceId(branch, cwd, firstUser),
    sleeps,
    cwd,
    last,
    lastSize: turns[turns.length - 1]?.ctx || 0,
    summaries: Math.max(boundaries, summaryLines), // either shape alone still counts each summary once
    turnLog: turns.map((t) => [Date.parse(t.ts), t.total, t.branch]), // [ms, tokens, branch] per turn
  };
}

// Codex: each token_count event carries last_token_usage (one model call) and a running total.
// The same event can repeat; a call counts only when the running total moves.
// Codex input_tokens already includes the cached part.
export async function parseCodexFile(path, projectKey, worktrees = []) {
  let cwd = null;
  let branch = null;
  let start = null;
  let model = null;
  let firstUser = null;
  let lastTotal = -1;
  let sleeps = 0;
  const days = {};
  const models = {};
  let turns = 0;
  let total = 0;
  let startup = 0;
  let peak = 0;
  let lastSize = 0;
  let last = null;
  let compacted = 0; // {type:"compacted"} lines: one per summary (a guessed shape)
  let compactEvents = 0; // {type:"event_msg", payload:{type:"context_compacted"}} (a guessed shape)
  const turnLog = []; // [ms, tokens, branch] per model call
  let first = true;
  for await (const j of lines(path)) {
    const p = j.payload || {};
    if (j.timestamp && !start) start = j.timestamp;
    if (j.timestamp) last = j.timestamp;
    if (j.type === 'compacted') compacted++;
    if (j.type === 'event_msg' && p.type === 'context_compacted') compactEvents++;
    if (j.type === 'session_meta') {
      cwd = cwd || p.cwd || null;
      branch = branch || p.git?.branch || null;
      if (p.timestamp) start = p.timestamp;
    }
    if (first) {
      first = false;
      if (projectKey && !pathMatchesProject(cwd, projectKey, worktrees)) return { tool: 'codex', skip: true, cwd };
    }
    if (j.type === 'turn_context' && p.model) model = p.model;
    if (j.type === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings?.model) model = p.thread_settings.model;
    if (firstUser === null && j.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') {
      firstUser = (p.item.content || []).map((c) => c.text || '').join('\n').slice(0, 2000);
    }
    if (firstUser === null && j.type === 'event_msg' && p.type === 'user_message') firstUser = String(p.message || '').slice(0, 2000);
    if (j.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      if (/\bsleep\b/.test(String(p.input ?? p.arguments ?? ''))) sleeps++;
    }
    if (j.type === 'event_msg' && p.type === 'token_count' && p.info?.last_token_usage) {
      const running = p.info.total_token_usage?.total_tokens ?? -2;
      if (running === lastTotal) continue;
      lastTotal = running;
      const u = p.info.last_token_usage;
      const ctx = u.input_tokens || 0;
      const tokens = ctx + (u.output_tokens || 0);
      turns++;
      total += tokens;
      if (turns === 1) startup = ctx;
      peak = Math.max(peak, ctx);
      lastSize = ctx;
      models[model] = (models[model] || 0) + tokens;
      addDay(days, j.timestamp, tokens);
      turnLog.push([Date.parse(j.timestamp), tokens, branch]);
    }
  }
  const id = basename(path, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27})$/)?.[1] || basename(path, '.jsonl');
  // Codex names one branch, in session_meta: every turn counts as on it.
  return {
    tool: 'codex', id, model: topKey(models) || model, start, turns, startup, peak, total, days, role: classifyRole(firstUser), slice: sliceId(branch, cwd, firstUser), sleeps, cwd,
    last, lastSize, summaries: Math.max(compacted, compactEvents), turnLog,
  };
}

function extractAntigravityCwd(text) {
  const s = String(text || '');
  const cmdDir = s.match(/Command Working Directory:\s*([^\r\n]+)/i);
  if (cmdDir) return cmdDir[1].trim();
  const activeWs = s.match(/Active Workspaces:\s*\r?\n\s*-\s*([^\r\n]+)/i);
  if (activeWs) return activeWs[1].trim();
  return null;
}

function cleanAntigravityUserText(text) {
  return String(text || '')
    .replace(/<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>/gi, '')
    .replace(/<user_information>[\s\S]*?<\/user_information>/gi, '')
    .replace(/<runtime_info>[\s\S]*?<\/runtime_info>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/^The following is a <SYSTEM_MESSAGE>[\s\S]*?<SYSTEM_MESSAGE>\s*/i, '')
    .replace(/<\/?SYSTEM_MESSAGE>/gi, '')
    .replace(/<\/?user_request>/gi, '')
    .trim()
    .replace(/^\[Message\][^\r\n]*?\bcontent=/i, '')
    .replace(/^\[T3 Code:[^\]]*\]\s*/i, '')
    .trim();
}

function antigravitySessionId(path) {
  const base = basename(path, '.jsonl');
  if (base !== 'transcript') return base;
  const m = path.match(/[/\\]([^/\\]+)[/\\]\.system_generated[/\\]/);
  if (m) return m[1];
  const parent = basename(dirname(path));
  return parent && parent !== '.' && parent !== 'logs' ? parent : base;
}

async function readFirstFullInput(path, kind = 'user') {
  const fullPath = join(dirname(path), 'transcript_full.jsonl');
  if (basename(path) !== 'transcript.jsonl' || !existsSync(fullPath)) return null;
  for await (const j of lines(fullPath)) {
    if (kind === 'user' && (j.type === 'USER_INPUT' || j.source === 'USER_EXPLICIT') && typeof j.content === 'string' && j.content.trim()) {
      return j.content;
    }
    if (kind === 'system' && j.type === 'SYSTEM_MESSAGE' && typeof j.content === 'string' && j.content.trim()) {
      return j.content;
    }
  }
  return null;
}

const PATH_ARG_KEYS = ['Path', 'path', 'cwd', 'Cwd', 'file_path', 'filePath', 'Directory', 'directory', 'SearchPath', 'searchPath', 'TargetFile', 'targetFile'];
const IGNORED_PATH_RE = /\/(?:\.t3\/userdata|\.claude|\.codex|\.gemini)\/|^(?:\/tmp|\/var|\/private\/tmp|\/private\/var|\/dev|\/usr|\/bin|\/sbin|\/etc|\/System|\/Library|\/opt)(?:\/|$)/;

function unquoteArg(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function extractToolPaths(toolCalls, out, worktrees = []) {
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls) {
    const args = tc?.args ?? tc?.arguments ?? {};
    if (!args || typeof args !== 'object') continue;
    for (const k of PATH_ARG_KEYS) {
      const val = unquoteArg(args[k]);
      if (val.startsWith('/') && (!IGNORED_PATH_RE.test(val) || isWorktreePath(val, worktrees))) out.push(val);
    }
    const cmd = unquoteArg(args.CommandLine ?? args.command);
    if (cmd) {
      for (const m of cmd.matchAll(/(?:^|[\s"'=])(\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+)/g)) {
        if (!IGNORED_PATH_RE.test(m[1]) || isWorktreePath(m[1], worktrees)) out.push(m[1]);
      }
    }
  }
}

const GENERIC_DIR_RE = /^(?:\/|\/(?:tmp|private\/tmp)|\/(?:Users|home)(?:\/[^/]+(?:\/(?:\.t3|dev|code|projects|src|repos|work|workspace|Desktop|Documents|Downloads))?)?)$|(?:^|\/)(?:\.t3\/worktrees|worktrees)\/?$/i;

function toolPathDir(p, worktrees = []) {
  const clean = String(p || '').replace(/\/+$/, '');
  if (!clean.startsWith('/')) return null;
  if (worktrees) {
    const lower = clean.toLowerCase();
    let best = null;
    for (const wt of worktrees) {
      const w = normPath(wt);
      if (!w) continue;
      const wl = w.toLowerCase();
      if ((lower === wl || lower.startsWith(`${wl}/`)) && (!best || w.length > best.length)) best = w;
    }
    if (best) return best;
  }
  const wt = clean.match(/^(.*?\/\.t3\/worktrees\/[^/]+\/[^/]+)(?:\/|$)/);
  if (wt) return wt[1];
  const base = basename(clean);
  const dir = base.includes('.') ? dirname(clean) : clean;
  return GENERIC_DIR_RE.test(dir) ? null : dir;
}

function commonDirPrefix(dirs) {
  if (!dirs.length) return null;
  let parts = dirs[0].split('/').filter(Boolean);
  for (let i = 1; i < dirs.length && parts.length; i++) {
    const next = dirs[i].split('/').filter(Boolean);
    let k = 0;
    while (k < parts.length && k < next.length && parts[k] === next[k]) k++;
    parts = parts.slice(0, k);
  }
  return parts.length ? `/${parts.join('/')}` : '/';
}

function inferCwdFromToolPaths(toolPaths, worktrees = []) {
  let candidates = toolPaths.map((p) => toolPathDir(p, worktrees)).filter(Boolean);
  if (!candidates.length) return null;
  let lcp = commonDirPrefix(candidates);
  while (lcp && GENERIC_DIR_RE.test(lcp)) {
    const prefixDepth = lcp.split('/').filter(Boolean).length;
    const clusters = new Map();
    for (const d of candidates) {
      const parts = d.split('/').filter(Boolean);
      if (parts.length <= prefixDepth) continue;
      const key = `/${parts.slice(0, prefixDepth + 1).join('/')}`;
      const list = clusters.get(key) || [];
      list.push(d);
      clusters.set(key, list);
    }
    if (clusters.size <= 1) break;
    let best = null;
    for (const list of clusters.values()) {
      if (!best || list.length > best.length) best = list;
    }
    candidates = best;
    lcp = commonDirPrefix(candidates);
  }
  if (lcp && !GENERIC_DIR_RE.test(lcp)) return lcp;
  const counts = {};
  for (const d of candidates) counts[d] = (counts[d] || 0) + 1;
  return topKey(counts);
}

function extractChildIds(j, selfId, outSet) {
  if (j.type === 'USER_INPUT' || j.type === 'SYSTEM_MESSAGE') return;
  for (const field of [j.content, j.output, j.tool_result]) {
    if (!field) continue;
    const text = typeof field === 'string' ? field : JSON.stringify(field);
    if (!text.includes('conversationId')) continue;
    for (const m of text.matchAll(/"conversationId"\s*:\s*"([a-z0-9_-]+)"/gi)) {
      if (m[1] && m[1] !== selfId) outSet.add(m[1]);
    }
  }
}

// Antigravity: each model step reports input_tokens (uncached) + cache_read_tokens (cached) as ctx,
// plus output_tokens. Compactions have no marker line, so a drop from > 80k to < 60% of previous ctx
// counts as one summary.
export async function parseAntigravityFile(path, projectKey = null, opts = {}) {
  const worktrees = opts.worktrees || [];
  const id = antigravitySessionId(path);
  let cwd = null;
  let branch = null;
  let start = null;
  let last = null;
  let model = null;
  let firstUserRaw = null;
  let firstUserTruncated = false;
  let firstSystemRaw = null;
  let firstSystemTruncated = false;
  let sleeps = 0;
  const days = {};
  const models = {};
  const childIdSet = new Set();
  const toolPaths = [];
  let turns = 0;
  let total = 0;
  let startup = 0;
  let peak = 0;
  let lastSize = 0;
  let prevCtx = 0;
  let summaries = 0;
  const turnLog = [];
  for await (const j of lines(path)) {
    const ts = j.created_at || j.timestamp || null;
    if (ts && !start) start = ts;
    if (ts) last = ts;
    if (j.cwd && !cwd) cwd = j.cwd;
    if (j.gitBranch || j.branch) branch = j.gitBranch || j.branch;
    if (firstUserRaw === null && (j.type === 'USER_INPUT' || j.source === 'USER_EXPLICIT') && typeof j.content === 'string' && j.content.trim()) {
      firstUserRaw = j.content;
      firstUserTruncated = Array.isArray(j.truncated_fields) && j.truncated_fields.includes('content');
    }
    if (firstSystemRaw === null && j.type === 'SYSTEM_MESSAGE' && typeof j.content === 'string' && j.content.trim()) {
      firstSystemRaw = j.content;
      firstSystemTruncated = Array.isArray(j.truncated_fields) && j.truncated_fields.includes('content');
    }
    extractChildIds(j, id, childIdSet);
    if (Array.isArray(j.tool_calls)) {
      extractToolPaths(j.tool_calls, toolPaths, worktrees);
      for (const tc of j.tool_calls) {
        if (tc?.name === 'run_command') {
          const cmd = tc.args?.CommandLine ?? tc.arguments?.CommandLine ?? '';
          if (/\bsleep\b/.test(String(cmd))) sleeps++;
        }
      }
    }
    const input = j.input_tokens || 0;
    const cacheRead = j.cache_read_tokens || 0;
    const output = j.output_tokens || 0;
    const ctx = input + cacheRead;
    const tokens = ctx + output;
    if (tokens > 0) {
      if (ctx > 0) {
        if (prevCtx > 80_000 && ctx < prevCtx * 0.6) summaries++;
        prevCtx = ctx;
      }
      turns++;
      total += tokens;
      if (turns === 1) startup = ctx;
      peak = Math.max(peak, ctx);
      lastSize = ctx;
      if (j.model) {
        model = j.model;
        models[j.model] = (models[j.model] || 0) + tokens;
      }
      addDay(days, ts, tokens);
      turnLog.push([Date.parse(ts), tokens, branch]);
    }
  }
  const useUser = firstUserRaw !== null;
  let promptRaw = useUser ? firstUserRaw : firstSystemRaw;
  const promptTruncated = useUser ? firstUserTruncated : firstSystemTruncated;
  if (promptTruncated) {
    const fullContent = await readFirstFullInput(path, useUser ? 'user' : 'system');
    if (fullContent) promptRaw = fullContent;
  }
  if (!cwd && promptRaw) cwd = extractAntigravityCwd(promptRaw);
  if (!cwd && toolPaths.length) cwd = inferCwdFromToolPaths(toolPaths, worktrees);
  const firstUser = promptRaw ? cleanAntigravityUserText(promptRaw).slice(0, 2000) : null;
  const matchProject = opts.matchProject ?? projectKey;
  const promptMatch = matchProject ? textMatchesProject(firstUser, matchProject) : false;
  if (projectKey) {
    const matched = cwd ? pathMatchesProject(cwd, projectKey, worktrees) : promptMatch;
    if (!matched) return { tool: 'antigravity', skip: true, cwd };
  }
  const summary = {
    tool: 'antigravity',
    id,
    model: topKey(models) || model,
    start,
    turns,
    startup,
    peak,
    total,
    days,
    role: classifyRole(firstUser),
    slice: sliceId(branch, cwd, firstUser),
    sleeps,
    cwd,
    last,
    lastSize,
    summaries,
    turnLog,
    childIds: [...childIdSet],
  };
  if (opts.matchProject) summary.promptMatch = promptMatch;
  return summary;
}

// ---- finding files and the cache ----

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const claudeSlug = (p) => normPath(p).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

export function findFiles({ claudeDir, claudeDirs, codexDir, antigravityDir, antigravityDirs, project, worktrees = [] }) {
  const claude = [];
  const roots = Array.isArray(claudeDirs) ? claudeDirs : Array.isArray(claudeDir) ? claudeDir : claudeDir ? [claudeDir] : [];
  const wtSlugs = [...(worktrees || [])].map(claudeSlug).filter(Boolean);
  const claudeDirMatches = (name) => {
    if (project && name.includes(project)) return true;
    const lower = name.toLowerCase();
    return wtSlugs.some((slug) => lower === slug || lower.startsWith(`${slug}-`));
  };
  for (const rootDir of roots) {
    let dirs = [];
    try {
      dirs = readdirSync(rootDir, { withFileTypes: true });
    } catch {
      // no Claude folder: nothing to read
    }
    for (const d of dirs) if (d.isDirectory() && claudeDirMatches(d.name)) walk(join(rootDir, d.name), claude);
  }
  const seen = new Set();
  const codex = [];
  if (codexDir) {
    for (const sub of ['sessions', 'archived_sessions']) {
      for (const f of walk(join(codexDir, sub))) {
        if (!/^rollout-.*\.jsonl$/.test(basename(f)) || seen.has(basename(f))) continue;
        seen.add(basename(f));
        codex.push(f);
      }
    }
  }
  const agyRoots = Array.isArray(antigravityDirs)
    ? antigravityDirs
    : Array.isArray(antigravityDir)
      ? antigravityDir
      : antigravityDir
        ? [antigravityDir]
        : [];
  const antigravity = findAntigravityFiles(agyRoots);
  return { claude, codex, antigravity };
}

function normalizeWorktrees(worktrees = []) {
  return [...new Set([...(worktrees || [])].map((w) => normPath(w)).filter(Boolean))].sort();
}

function readCache(file, project, worktreeKey = []) {
  if (!file || !existsSync(file)) return {};
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    // A cache written for another project or worktree set holds that set's Codex and Antigravity filter results: never reuse it.
    if (
      c &&
      c.version === CACHE_VERSION &&
      c.project === project &&
      Array.isArray(c.worktrees) &&
      JSON.stringify(normalizeWorktrees(c.worktrees)) === JSON.stringify(worktreeKey) &&
      c.files &&
      typeof c.files === 'object'
    ) {
      return c.files;
    }
    return {};
  } catch {
    return {}; // corrupt cache: ignore it and rebuild
  }
}

// Summaries for every transcript; only new or changed files are parsed.
export async function loadSessions({ claudeDir, claudeDirs, codexDir, antigravityDir, antigravityDirs, project, worktrees = [], cacheFile = null }) {
  const worktreeKey = normalizeWorktrees(worktrees);
  const old = readCache(cacheFile, project, worktreeKey);
  const fresh = {};
  let parsed = 0;
  let reused = 0;
  const { claude, codex, antigravity } = findFiles({ claudeDir, claudeDirs, codexDir, antigravityDir, antigravityDirs, project, worktrees });
  const jobs = [
    ...claude.map((f) => [f, 'claude']),
    ...codex.map((f) => [f, 'codex']),
    ...antigravity.map((f) => [f, 'antigravity']),
  ];
  for (const [file, tool] of jobs) {
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const hit = old[file];
    // A summary cached before the run fields existed (no "turnLog") is read again.
    const current = hit?.summary && (hit.summary.skip || hit.summary.turnLog);
    if (current && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      fresh[file] = hit;
      reused++;
      continue;
    }
    const summary =
      tool === 'claude'
        ? await parseClaudeFile(file)
        : tool === 'codex'
          ? await parseCodexFile(file, project, worktrees)
          : await parseAntigravityFile(file, null, { matchProject: project, worktrees });
    fresh[file] = { size: st.size, mtimeMs: st.mtimeMs, summary };
    parsed++;
  }
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, project, worktrees: worktreeKey, files: fresh }));
  const agyById = new Map();
  const childToParent = new Map();
  for (const { summary: s } of Object.values(fresh)) {
    if (s && s.tool === 'antigravity' && !s.skip && s.id) agyById.set(s.id, s);
  }
  for (const s of agyById.values()) {
    for (const cid of s.childIds || []) {
      if (cid && cid !== s.id && !childToParent.has(cid)) childToParent.set(cid, s.id);
    }
  }
  const resolveAgy = (s) => {
    let cwd = s.cwd || null;
    let slice = s.slice || null;
    let promptMatch = Boolean(s.promptMatch);
    const seenIds = new Set([s.id]);
    let curId = childToParent.get(s.id);
    while (curId && !seenIds.has(curId)) {
      seenIds.add(curId);
      const parent = agyById.get(curId);
      if (!parent) break;
      const ownCwd = cwd;
      if (!cwd && parent.cwd) cwd = parent.cwd;
      if (!slice && parent.slice && (!ownCwd || !parent.cwd || !project || pathMatchesProject(ownCwd, project, worktrees) === pathMatchesProject(parent.cwd, project, worktrees))) {
        slice = parent.slice;
      }
      if (!cwd && !promptMatch && parent.promptMatch) promptMatch = true;
      if (cwd && slice) break;
      curId = childToParent.get(curId);
    }
    return { cwd, slice, promptMatch };
  };
  const sessions = [];
  for (const { summary: s } of Object.values(fresh)) {
    if (!s || s.skip || !(s.turns > 0)) continue;
    if (s.tool === 'claude') {
      if (project && s.cwd && !pathMatchesProject(s.cwd, project, worktrees)) continue;
      sessions.push(s);
    } else if (s.tool === 'antigravity') {
      const { cwd, slice, promptMatch } = resolveAgy(s);
      if (project) {
        const matched = cwd ? pathMatchesProject(cwd, project, worktrees) : promptMatch;
        if (!matched) continue;
      }
      const out = { ...s, cwd, slice };
      delete out.promptMatch;
      sessions.push(out);
    } else {
      if (project && s.cwd && !pathMatchesProject(s.cwd, project, worktrees)) continue;
      sessions.push(s);
    }
  }
  return { sessions, parsed, reused };
}

// ---- progress from git ----

// Merged pull requests per local day on the first-parent line of ref: { day: { code, docs } }.
// Docs-only means what the merge script means by it: every changed file is on the settings'
// paperworkPaths list (scripts/kit.config.json). Returns null if git fails.
export function paperworkPathsFor(cwd) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const paths = settings(JSON.parse(readFileSync(join(top, 'scripts', 'kit.config.json'), 'utf8'))).paperworkPaths;
    if (!paths.every((p) => typeof p === 'string' && p)) throw new Error('paperworkPaths must hold only paths');
    return paths;
  } catch {
    return settings().paperworkPaths; // no settings file, or a broken one: the merge script's default
  }
}

export function isDocsOnly(files, paperworkPaths = settings().paperworkPaths) {
  return files.length > 0 && files.every((f) => isPaperwork(f, paperworkPaths));
}

export function mergedPrs(cwd, refs = ['origin/main', 'main'], paperworkPaths = paperworkPathsFor(cwd)) {
  for (const ref of refs) {
    let out;
    try {
      out = execFileSync('git', ['log', '--first-parent', '--merges', '--diff-merges=first-parent', '--name-only', '--format=@@%ct', ref], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    const perDay = {};
    for (const block of out.split('@@').filter((b) => b.trim())) {
      const [head, ...rest] = block.split('\n');
      const day = localDate(Number(head.trim()) * 1000);
      const files = rest.map((s) => s.trim()).filter(Boolean);
      perDay[day] = perDay[day] || { code: 0, docs: 0 };
      perDay[day][isDocsOnly(files, paperworkPaths) ? 'docs' : 'code']++;
    }
    return perDay;
  }
  return null;
}

// ---- the report ----

export function buildReport({ sessions, prs, days = 7, now = new Date() }) {
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12)));
  const inPeriod = new Set(dayList);
  const recent = sessions.filter((s) => inPeriod.has(localDate(s.start)));
  const perDay = dayList.map((date) => {
    let claude = 0;
    let codex = 0;
    let antigravity = 0;
    for (const s of sessions) {
      const t = s.days?.[date] || 0;
      if (s.tool === 'claude') claude += t;
      else if (s.tool === 'antigravity') antigravity += t;
      else codex += t;
    }
    const dayTokens = claude + codex + antigravity;
    const p = prs ? prs[date] || { code: 0, docs: 0 } : null;
    return {
      date,
      claude,
      codex,
      antigravity,
      sessions: recent.filter((s) => localDate(s.start) === date).length,
      codePrs: p ? p.code : null,
      docsPrs: p ? p.docs : null,
      perCodePr: p && p.code ? dayTokens / p.code : null,
    };
  });
  const tokens = perDay.reduce((a, d) => a + d.claude + d.codex + d.antigravity, 0);
  const codePrs = prs ? perDay.reduce((a, d) => a + d.codePrs, 0) : null;
  const docsPrs = prs ? perDay.reduce((a, d) => a + d.docsPrs, 0) : null;
  const recentTotal = recent.reduce((a, s) => a + s.total, 0);
  const roles = ['head', 'builder', 'reviewer', 'other'].map((role) => {
    const ss = recent.filter((s) => s.role === role);
    const total = ss.reduce((a, s) => a + s.total, 0);
    return {
      role,
      sessions: ss.length,
      medianTurns: median(ss.map((s) => s.turns)),
      medianStartup: median(ss.map((s) => s.startup)),
      medianPeak: median(ss.map((s) => s.peak)),
      total,
      share: recentTotal ? total / recentTotal : 0,
    };
  });
  const slices = {};
  for (const s of recent) {
    if (!s.slice) continue;
    slices[s.slice] = slices[s.slice] || { slice: s.slice, sessions: 0, total: 0 };
    slices[s.slice].sessions++;
    slices[s.slice].total += s.total;
  }
  const dayMs = 24 * 3600 * 1000;
  const claudeStarts = sessions.filter((s) => s.tool === 'claude' && s.start);
  const last24 = claudeStarts.filter((s) => now - new Date(s.start) <= dayMs && now - new Date(s.start) >= 0);
  const before = claudeStarts.filter((s) => now - new Date(s.start) > dayMs && now - new Date(s.start) <= 8 * dayMs);
  const worst = (key, over) => {
    const hits = recent.filter(over).sort((a, b) => b[key] - a[key]);
    return { count: hits.length, worst: hits.slice(0, 5).map((s) => ({ id: s.id, value: s[key] })) };
  };
  return {
    days,
    from: dayList[0],
    to: dayList[dayList.length - 1],
    tokens,
    codePrs,
    docsPrs,
    perCodePr: codePrs ? tokens / codePrs : null,
    perDay,
    roles,
    slices: Object.values(slices).sort((a, b) => b.total - a.total).slice(0, 8),
    startup: {
      last24h: { sessions: last24.length, median: median(last24.map((s) => s.startup)) },
      prior7d: { sessions: before.length, median: median(before.map((s) => s.startup)) },
    },
    warnings: {
      longThreads: worst('turns', (s) => s.turns > LIMITS.turns),
      bigContext: worst('peak', (s) => s.peak > LIMITS.peak),
      sleepy: worst('sleeps', (s) => s.sleeps >= LIMITS.sleeps),
    },
    summarized: worst('summaries', (s) => s.summaries > 0), // threads the tool shrank at least once
  };
}

const na = (v, f = String) => (v === null || v === undefined ? 'n/a' : f(v));
const pad = (cells, widths) => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');

export function renderText(r) {
  const out = [];
  out.push(`Tokens, last ${r.days} days (${r.from} to ${r.to}): ${M(r.tokens)}M (Claude Code + Codex + Antigravity). Merged PRs: ${na(r.codePrs)} code, ${na(r.docsPrs)} docs-only. M tokens per code PR: ${na(r.perCodePr, M)}.`);
  out.push('');
  const w1 = [10, 9, 9, 8, 8, 8, 8, 10];
  out.push(pad(['date', 'Claude M', 'Codex M', 'AGY M', 'sessions', 'code PRs', 'docs PRs', 'M per code'], w1));
  for (const d of r.perDay) out.push(pad([d.date, M(d.claude), M(d.codex), M(d.antigravity || 0), d.sessions, na(d.codePrs), na(d.docsPrs), na(d.perCodePr, M)], w1));
  out.push('');
  out.push('By role (sessions started in the period):');
  const w2 = [8, 8, 12, 13, 12, 9, 6];
  out.push(pad(['role', 'sessions', 'median turns', 'median start', 'median peak', 'total M', 'share'], w2));
  for (const x of r.roles) out.push(pad([x.role, x.sessions, x.medianTurns, K(x.medianStartup), K(x.medianPeak), M(x.total), `${Math.round(x.share * 100)}%`], w2));
  out.push('');
  out.push('Top slices by tokens:');
  if (!r.slices.length) out.push('  none');
  for (const s of r.slices) out.push(`  ${s.slice}  ${s.sessions} sessions  ${M(s.total)}M`);
  out.push('');
  const su = r.startup;
  out.push(`Start-up load check (Claude, median first-turn context): last 24 hours ${K(su.last24h.median)} (${su.last24h.sessions} sessions), the 7 days before ${K(su.prior7d.median)} (${su.prior7d.sessions} sessions).`);
  out.push('');
  const warn = (title, w, unit) => {
    out.push(`${title}: ${w.count}${w.count ? `. Worst: ${w.worst.map((x) => `${x.id} (${unit(x.value)})`).join(', ')}` : ''}`);
  };
  out.push('Warnings:');
  warn(`  Over ${LIMITS.turns} turns`, r.warnings.longThreads, (v) => `${v} turns`);
  warn(`  Peak context over ${K(LIMITS.peak)}`, r.warnings.bigContext, K);
  warn(`  ${LIMITS.sleeps} or more sleep calls`, r.warnings.sleepy, (v) => `${v} sleeps`);
  warn('  Threads summarized at least once', r.summarized, (v) => `${v} summaries`);
  return out.join('\n');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function table(head, rows) {
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

export function renderHtml(r) {
  const max = Math.max(1, ...r.perDay.map((d) => d.claude + d.codex + (d.antigravity || 0)));
  const bars = r.perDay
    .map((d) => {
      const agy = d.antigravity || 0;
      const c = (100 * d.claude) / max;
      const x = (100 * d.codex) / max;
      const a = (100 * agy) / max;
      return `<div class="row"><span class="lbl">${esc(d.date.slice(5))}</span><div class="track"><div class="bar c1" style="width:${c.toFixed(2)}%"></div><div class="bar c2" style="width:${x.toFixed(2)}%"></div><div class="bar c3" style="width:${a.toFixed(2)}%"></div></div><span class="val">${M(d.claude + d.codex + agy)}M</span></div>`;
    })
    .join('');
  const su = r.startup;
  const w = r.warnings;
  const warnLine = (t, x) => `<li>${esc(t)}: ${x.count}${x.count ? `. Worst: ${esc(x.worst.map((y) => `${y.id} (${y.value})`).join(', '))}` : ''}</li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Token ledger</title>
<style>
body{color:var(--foreground,#1a1a1a);font:14px/1.45 system-ui,-apple-system,sans-serif;margin:0;padding:16px;max-width:900px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 8px}
.muted,th{color:var(--muted-foreground,#666)}
.legend span{display:inline-block;width:10px;height:10px;margin:0 4px 0 10px;vertical-align:middle}
.row{display:flex;align-items:center;gap:8px;margin:3px 0}.lbl{width:44px;flex:none;font-variant-numeric:tabular-nums}
.track{flex:1;display:flex;min-width:0;height:14px;border-bottom:1px solid var(--border,#ddd)}.val{width:64px;flex:none;text-align:right;font-variant-numeric:tabular-nums}
.c1{background:var(--chart-1,#4f7cff)}.c2{background:var(--chart-2,#f59e0b)}.c3{background:var(--chart-3,#10b981)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:4px 6px;border-bottom:1px solid var(--border,#ddd);white-space:nowrap}th:first-child,td:first-child{text-align:left}
ul{padding-left:18px}li{overflow-wrap:anywhere}
</style></head><body>
<h1>Token ledger</h1>
<p>${esc(`Last ${r.days} days (${r.from} to ${r.to}): ${M(r.tokens)}M tokens (Claude Code + Codex + Antigravity). Merged PRs: ${na(r.codePrs)} code, ${na(r.docsPrs)} docs-only. M tokens per code PR: ${na(r.perCodePr, M)}.`)}</p>
<h2>Tokens per day</h2>
<p class="muted legend"><span class="c1"></span>Claude<span class="c2"></span>Codex<span class="c3"></span>Antigravity</p>
${bars}
<div class="scroll">${table(['date', 'Claude M', 'Codex M', 'AGY M', 'sessions', 'code PRs', 'docs PRs', 'M per code PR'], r.perDay.map((d) => [d.date, M(d.claude), M(d.codex), M(d.antigravity || 0), d.sessions, na(d.codePrs), na(d.docsPrs), na(d.perCodePr, M)]))}</div>
<h2>By role</h2>
<div class="scroll">${table(['role', 'sessions', 'median turns', 'median start-up', 'median peak', 'total M', 'share'], r.roles.map((x) => [x.role, x.sessions, x.medianTurns, K(x.medianStartup), K(x.medianPeak), M(x.total), `${Math.round(x.share * 100)}%`]))}</div>
<h2>Top slices</h2>
<div class="scroll">${table(['slice', 'sessions', 'M tokens'], r.slices.map((s) => [s.slice, s.sessions, M(s.total)]))}</div>
<h2>Start-up load check</h2>
<p>${esc(`Claude median first-turn context: last 24 hours ${K(su.last24h.median)} (${su.last24h.sessions} sessions), the 7 days before ${K(su.prior7d.median)} (${su.prior7d.sessions} sessions).`)}</p>
<h2>Warnings</h2>
<ul>${warnLine(`Over ${LIMITS.turns} turns`, w.longThreads)}${warnLine(`Peak context over ${K(LIMITS.peak)}`, w.bigContext)}${warnLine(`${LIMITS.sleeps} or more sleep calls`, w.sleepy)}${r.summarized ? warnLine('Threads summarized at least once', r.summarized) : ''}</ul>
</body></html>
`;
}

// ---- one run (decision 012, part 1e): --run docs/runs/<name>.json ----
// A run's window is its start to its end (or now, while it goes on). Everything below is counted
// inside that window only.

const DAY_MS = 24 * 3600 * 1000;
export const REWORK_DAYS = 14;
const windowOf = (run, now = Date.now()) => [Date.parse(run.start), run.end ? Date.parse(run.end) : now];
const inWindow = (ts, [from, to]) => Date.parse(ts) >= from && Date.parse(ts) <= to;

// Sessions with turns in the window, grouped by those turns only: a session's tokens before the
// start or after the end are never charged here. A head agent thread with a turn on the lead branch
// is charged to the run. Any other session goes to the first listed branch one of its turns in the
// window was on. The rest are "unassigned" (shown, not charged). total = head + listed branches.
// A turn with no time cannot be placed in the window: when it is on one of the run's branches, its
// tokens go on a "no time" line (shown, not charged) instead of being dropped.
export function groupRun(run, sessions, now = Date.now()) {
  const [from, to] = windowOf(run, now);
  const blank = () => ({ sessions: 0, total: 0, summaries: 0, maxLast: 0 });
  const listed = [run.leadBranch, ...run.sliceBranches];
  const out = { branches: Object.fromEntries(listed.map((b) => [b, blank()])), head: blank(), unassigned: blank(), noTime: blank(), total: 0 };
  for (const s of sessions) {
    const untimed = (s.turnLog || []).filter(([t, , b]) => !Number.isFinite(t) && listed.includes(b)); // NaN, or null once cached
    if (untimed.length) {
      out.noTime.sessions++;
      out.noTime.total += untimed.reduce((a, [, n]) => a + n, 0);
    }
    const inside = (s.turnLog || []).filter(([t]) => t >= from && t <= to);
    if (!inside.length) continue;
    const on = new Set(inside.map(([, , b]) => b));
    const g = s.role === 'head' ? (on.has(run.leadBranch) ? out.head : out.unassigned) : out.branches[listed.find((b) => on.has(b))] ?? out.unassigned;
    const tokens = inside.reduce((a, [, n]) => a + n, 0);
    g.sessions++;
    g.total += tokens;
    g.summaries += s.summaries || 0;
    g.maxLast = Math.max(g.maxLast, s.lastSize || 0);
    if (g !== out.unassigned) out.total += tokens;
  }
  return out;
}

// Review rounds: receipts (docs/receipts/*.json) made inside the window whose task is one of the
// run's slice numbers. [[task, n]], by task.
export function reviewRounds(receipts, run, now = Date.now()) {
  const win = windowOf(run, now);
  const ids = runSliceIds(run);
  const n = {};
  for (const r of receipts) if (r?.task && ids.has(sliceId(r.task)) && inWindow(r.at, win)) n[r.task] = (n[r.task] || 0) + 1;
  return Object.entries(n).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// The block log (<git common dir>/kit-block-log.jsonl), lines in the order written. Each refusal in
// the window is settled by the next later line of the same pull request that is a "passed" line of
// the same check, or a "merged" line. A merge settles what no "passed" line can: a "github" block,
// and a check that a later docs-only try skipped. New fingerprints mean the code changed (a real
// catch); the same ones mean the block was mistaken. Neither yet: open. No fingerprints: unknown.
export function blockStats(lines, run, now = Date.now()) {
  const win = windowOf(run, now);
  const key = (l) => (Array.isArray(l.fingerprints) ? l.fingerprints.map((f) => f.fingerprint).sort().join(' ') : null);
  const out = { catches: 0, mistaken: 0, open: 0, unknown: 0 };
  lines.forEach((b, i) => {
    if (b.outcome !== 'blocked' || !inWindow(b.at, win)) return;
    const pass = lines.slice(i + 1).find((l) => l.pr === b.pr && (l.outcome === 'merged' || (l.outcome === 'passed' && l.check === b.check)));
    if (!pass) out.open++;
    else if (key(b) === null || key(pass) === null) out.unknown++;
    else if (key(b) === key(pass)) out.mistaken++;
    else out.catches++;
  });
  return out;
}

const runSliceIds = (run) => new Set(run.sliceBranches.map((b) => sliceId(b)).filter(Boolean));

// Parked slices: plans ({ file, status }) marked parked whose number is one of the run's slices.
export function parkedCount(plans, run) {
  const ids = runSliceIds(run);
  return plans.filter((p) => p.status === 'parked' && ids.has(p.file.slice(0, 3))).length;
}

// Rough rework. Method: take each merge of one of the run's branches (the subject ends with the
// branch name, as in "Merge pull request #7 from owner/build/012-x", the subject the merge script's
// "gh pr merge --merge" writes) on ref's first-parent line inside the window. Any other commit on
// that line in the window (a squash, an edited subject) is counted as unmatched. Any unmatched commit
// may be a run branch's merge (its first, or a second one), so then share is null.
// For each matched merge, count the code lines it added (paperwork left out). At the last commit on
// ref before that merge's own time + 14 days, ask git blame how many lines still come from the
// merge's own commits. Rework = the share no longer theirs: changed or deleted by a later commit (any later
// branch, the same slice's next merge included). null while the run is open or 14 days have not
// passed since its end. git(args) returns stdout.
export function reworkShare({ git, run, ref, paperworkPaths, now = Date.now() }) {
  if (!run.end) return null;
  if (Date.parse(run.end) + REWORK_DAYS * DAY_MS > now) return null;
  const [from, to] = windowOf(run, now).map((t) => t / 1000);
  const listed = [run.leadBranch, ...run.sliceBranches];
  const ours = (subject, b) => [' ', '/', "'"].some((c) => subject.endsWith(c + b) || subject.endsWith(`${c}${b}'`));
  const merges = [];
  const seen = new Set();
  let unmatched = 0;
  for (const line of git(['log', '--first-parent', '--format=%H %ct %P%x09%s', ref]).split('\n').filter(Boolean)) {
    const [head, subject = ''] = line.split('\t');
    const [m, t, ...parents] = head.split(' ');
    if (Number(t) < from || Number(t) > to) continue;
    const branch = parents.length === 2 && listed.find((b) => ours(subject, b));
    if (!branch) unmatched++;
    else {
      merges.push([m, t]);
      seen.add(branch);
    }
  }
  let added = 0;
  let kept = 0;
  for (const [m, t] of merges) {
    const tip = git(['rev-list', '-1', '--first-parent', `--before=${Number(t) + (REWORK_DAYS * DAY_MS) / 1000}`, ref]).trim();
    const own = new Set(git(['rev-list', `${m}^1..${m}^2`]).split('\n').filter(Boolean));
    const rows = git(['diff', '--numstat', '-z', '--no-renames', `${m}^1`, m]).split('\0').filter(Boolean);
    for (const row of rows) {
      const [adds, , file] = row.split('\t');
      if (adds === '-' || !Number(adds) || isPaperwork(file, paperworkPaths)) continue;
      let blame = '';
      try {
        blame = git(['blame', '--porcelain', tip, '--', file]);
      } catch {
        // the file is gone at the cutoff: none of its lines are kept
      }
      const still = blame.split('\n').filter((l) => /^[0-9a-f]{40} \d+ \d+/.test(l) && own.has(l.slice(0, 40))).length;
      added += Number(adds);
      kept += Math.min(still, Number(adds));
    }
  }
  const missing = listed.filter((b) => !seen.has(b));
  const share = unmatched ? null : added ? (added - kept) / added : 0;
  return { merges: merges.length, added, changed: added - kept, share, unmatched, missing };
}

export function renderRun(r) {
  const { run, groups: g } = r;
  const out = [`Run ${run.name} (${run.start} to ${run.end ?? 'now, still open'}): ${M(g.total)}M of the ${M(run.tokenLimit)}M limit.`];
  const w = [24, 8, 8, 9, 9];
  out.push(pad(['charged to', 'sessions', 'M tokens', 'summaries', 'last size'], w));
  const row = (name, x) => out.push(pad([name, x.sessions, M(x.total), x.summaries, K(x.maxLast)], w));
  row('head agent', g.head);
  for (const [b, x] of Object.entries(g.branches)) row(b, x);
  row('unassigned', g.unassigned);
  if (g.noTime?.sessions) row('no time, not charged', g.noTime);
  out.push(`Review rounds per task: ${r.rounds.length ? r.rounds.map(([t, n]) => `${t} ${n}`).join(', ') : 'none'}.`);
  const b = r.blocks;
  out.push(`Blocks: ${b.catches} real catches, ${b.mistaken} mistaken, ${b.open} not passed yet, ${b.unknown} without fingerprints.`);
  out.push(`Parked slices: ${r.parked}.`);
  const rw = r.rework;
  out.push(!rw
    ? `Rework: not shown until ${REWORK_DAYS} days after the run ends.`
    : rw.share === null
      ? `Rework: unknown. ${rw.unmatched} commits in the window could not be matched to a run branch (only subjects ending in the branch name match), and any of them may be a run branch's merge.${rw.missing.length ? ` No merge found for ${rw.missing.join(', ')}.` : ''}`
      : `Rework: ${Math.round(rw.share * 100)}% of ${rw.added} merged code lines (${rw.merges} merges) changed again within ${REWORK_DAYS} days.`);
  return out.join('\n');
}

// ---- command line ----

export function parseArgs(argv) {
  const o = { days: 7, project: null, json: false, html: null, cache: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--days') {
      o.days = Number(next());
      if (!Number.isInteger(o.days) || o.days < 1) throw new Error('--days must be a whole number of 1 or more');
    } else if (a === '--project') o.project = next();
    else if (a === '--json') o.json = true;
    else if (a === '--html') o.html = next();
    else if (a === '--cache') o.cache = next();
    else if (a === '--no-cache') o.cache = null;
    else if (a === '--run') o.run = next();
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

// Gathers one run's records from the repo at root. No receipts, block log, or plans counts as none.
function runReport({ root, runFile, sessions }) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  const cfg = loadConfig(root);
  const run = readRun(runFile, { leadPrefixes: cfg.leadPrefixes });
  const files = (dir, ext) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f)) : []);
  const json = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null; // a broken line or file is left out
    }
  };
  const receipts = files(join(root, RECEIPT_DIR), '.json').map((f) => json(readFileSync(f, 'utf8'))).filter(Boolean);
  const logFile = join(resolve(root, git(['rev-parse', '--git-common-dir']).trim()), BLOCK_LOG_FILE);
  const blocks = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').map(json).filter(Boolean) : [];
  const plans = files(join(root, cfg.plansDir, 'active'), '.md').map((f) => ({ file: basename(f), status: parsePlan(readFileSync(f, 'utf8')).header?.status }));
  let ref = `${cfg.remote}/${cfg.baseBranch}`;
  try {
    git(['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    ref = cfg.baseBranch;
  }
  let rework = null;
  try {
    rework = reworkShare({ git, run, ref, paperworkPaths: cfg.paperworkPaths });
  } catch (e) {
    console.error(`Warning: rework not counted: git failed (${e.message.split('\n')[0]})`);
  }
  return { run, groups: groupRun(run, sessions), rounds: reviewRounds(receipts, run), blocks: blockStats(blocks, run), parked: parkedCount(plans, run), rework };
}

function projectKey(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return basename(dirname(isAbsolute(common) ? common : resolve(cwd, common)));
  } catch {
    return basename(cwd);
  }
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`Wrong usage: ${e.message}\n${USAGE}`);
    process.exit(2);
  }
  const detectedProject = projectKey(process.cwd());
  const project = o.project || detectedProject;
  const worktrees = !o.project || o.project.toLowerCase() === detectedProject.toLowerCase()
    ? gitWorktreePaths(process.cwd())
    : [];
  const cacheFile = o.cache === undefined ? join(tmpdir(), `token-ledger-${project}.json`) : o.cache;
  const { sessions, parsed, reused } = await loadSessions({
    claudeDirs: defaultClaudeDirs(),
    codexDir: process.env.LEDGER_CODEX_DIR || join(homedir(), '.codex'),
    antigravityDirs: defaultAntigravityDirs(),
    project,
    worktrees,
    cacheFile,
  });
  const report = buildReport({ sessions, prs: mergedPrs(process.cwd()), days: o.days });
  let run = null;
  if (o.run) {
    try {
      run = runReport({ root: process.cwd(), runFile: o.run, sessions });
    } catch (e) {
      console.error(`Cannot report the run: ${e.message}`);
      process.exit(1);
    }
  }
  if (o.html) writeFileSync(o.html, renderHtml(report));
  if (o.json) console.log(JSON.stringify({ project, parsed, reused, ...report, run }, null, 2));
  else {
    if (run) console.log(`${renderRun(run)}\n`);
    console.log(renderText(report));
    console.log(`\nProject "${project}": ${sessions.length} sessions in all; read ${parsed} transcript file(s), ${reused} from cache.${o.html ? ` Page written to ${o.html}.` : ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

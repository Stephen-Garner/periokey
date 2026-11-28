import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blockStats,
  buildReport,
  classifyRole,
  defaultAntigravityDirs,
  findAntigravityFiles,
  gitWorktreePaths,
  groupRun,
  loadSessions,
  mergedPrs,
  paperworkPathsFor,
  parkedCount,
  parseAntigravityFile,
  parseClaudeFile,
  parseCodexFile,
  pathMatchesProject,
  renderHtml,
  renderRun,
  renderText,
  reviewRounds,
  reworkShare,
  sliceId,
} from './token-ledger.mjs';

// Each test builds a tiny fake transcript tree in a temp folder and runs the real code on it.

const SECRET = 'PRIVATE-TRANSCRIPT-TEXT-xyzzy';
const TS = '2026-11-12T12:00:00.000Z';

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  const claudeDir = join(root, 'claude');
  const codexDir = join(root, 'codex');
  const write = (path, events) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return path;
  };
  const done = () => rmSync(root, { recursive: true, force: true });
  return { root, claudeDir, codexDir, write, done };
}

const user = (text, extra = {}) => ({ type: 'user', timestamp: TS, cwd: '/w/unilex/t3-abc', gitBranch: 'build/072-cleanup', message: { role: 'user', content: text }, ...extra });
const reply = (id, u, content = [], ts = TS) => ({
  type: 'assistant',
  timestamp: ts,
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] }, content },
});
const bash = (command) => ({ type: 'tool_use', id: Math.random().toString(36), name: 'Bash', input: { command } });

function claudeSession(t, name = 's1.jsonl', dir = '-w-unilex-t3-abc') {
  return t.write(join(t.claudeDir, dir, name), [
    user(`You are a **builder** for UniLex. ${SECRET}`),
    reply('m1', [10, 1000, 2000, 5], [{ type: 'text', text: SECRET }]),
    reply('m1', [10, 1000, 2000, 5], [bash('sleep 30 && gh pr view')]), // same id: one turn
    reply('m2', [5, 100, 4000, 7], [bash('git status')]),
  ]);
}

function codexSession(t, cwd = '/w/unilex/t3-def', name = 'rollout-2026-11-12T10-00-00-01a1b2c3-0000-7000-8000-000000000001.jsonl') {
  const count = (last, running) => ({
    type: 'event_msg',
    timestamp: TS,
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: last[0], cached_input_tokens: last[1], output_tokens: last[2] }, total_token_usage: { total_tokens: running } } },
  });
  return t.write(join(t.codexDir, 'sessions', '2026', '11', '12', name), [
    { type: 'session_meta', timestamp: TS, payload: { cwd, timestamp: TS, git: { branch: 'build/084-welcome' } } },
    { type: 'turn_context', timestamp: TS, payload: { model: 'gpt-6-astra' } },
    { type: 'event_msg', timestamp: TS, payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: `You are a **reviewer** for UniLex. ${SECRET}` }] } } },
    { type: 'event_msg', timestamp: TS, payload: { type: 'token_count', info: null } },
    count([1000, 400, 10], 1010),
    count([1000, 400, 10], 1010), // repeated event, same running total: not a new call
    { type: 'response_item', timestamp: TS, payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'tools.exec_command({cmd:"sleep 60; gh pr checks"})' } },
    count([3000, 2500, 20], 4030),
  ]);
}

test('a Claude reply repeated across lines is counted once', async () => {
  const t = tree();
  const s = await parseClaudeFile(claudeSession(t));
  assert.equal(s.turns, 2);
  assert.equal(s.total, 1010 + 2000 + 5 + 5 + 100 + 4000 + 7);
  assert.equal(s.startup, 3010);
  assert.equal(s.peak, 4105);
  t.done();
});

test('roles come from the first user message', () => {
  assert.equal(classifyRole('You are the UniLex head agent in an automated loop.'), 'head');
  assert.equal(classifyRole('Start working on the next slice.'), 'head');
  assert.equal(classifyRole('Act as the implementation sub-agent for this task. You are a **builder** for UniLex.'), 'builder');
  assert.equal(classifyRole('Act as the review sub-agent for this task. You are a **reviewer** for UniLex.'), 'reviewer');
  assert.equal(classifyRole('Can you explain the roadmap to me?'), 'other');
  assert.equal(classifyRole(null), 'other');
});

test('slice id from the branch first, then from the folder', () => {
  assert.equal(sliceId('build/072-cleanup-pass', '/w/unilex/t3-abc'), '072');
  assert.equal(sliceId('lead/052-dict-v8', null), '052');
  assert.equal(sliceId('HEAD', '/Users/x/.t3/worktrees/unilex/slice-084-welcome'), '084');
  assert.equal(sliceId('main', '/Users/x/.t3/worktrees/unilex/t3-12d504f0'), null); // hex is not a slice
  assert.equal(sliceId(null, null), null);
  assert.equal(sliceId('t3/review-gender-availability', '/w/unilex/t3-abc', 'You are the reviewer for UniLex Slice 099 Task 4.'), '099');
  assert.equal(sliceId('t3/review-check', '/w/unilex/t3-abc', 'Write TASK: 098-t1-r2 in your reply.'), '098');
  assert.equal(sliceId('t3/review-check', '/w/unilex/t3-abc', 'Inspect origin/build/096-i18n against origin/main.'), '096');
  assert.equal(sliceId('t3/review-check', '/w/unilex/t3-abc', 'Read docs/plans/active/095-slang.md.'), '095');
  assert.equal(sliceId('t3/review-check', '/w/unilex/t3-abc', 'Review origin/build/099-privacy. Follow Slice 098 as the example. TASK: 099-t4-r1'), '099');
  assert.equal(sliceId('t3/review-check', '/w/unilex/t3-abc', 'Follow Slice 098 as the example while checking origin/build/099-privacy.'), '099');
});

test('Codex: tokens from token_count events, repeats skipped, cached part not added twice', async () => {
  const t = tree();
  const s = await parseCodexFile(codexSession(t), 'unilex');
  assert.equal(s.turns, 2);
  assert.equal(s.total, 1010 + 3020);
  assert.equal(s.startup, 1000);
  assert.equal(s.peak, 3000);
  assert.equal(s.model, 'gpt-6-astra');
  assert.equal(s.role, 'reviewer');
  assert.equal(s.slice, '084');
  assert.equal(s.sleeps, 1);
  t.done();
});

test('Codex sessions from another project are left out', async () => {
  const t = tree();
  codexSession(t, '/w/aimline/t3-x');
  const { sessions } = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, project: 'unilex' });
  assert.equal(sessions.length, 0);
  t.done();
});

test('cache: a cache written for one project is not reused for another', async () => {
  const t = tree();
  codexSession(t); // a UniLex session
  const cacheFile = join(t.root, 'shared-cache.json');
  const dirs = { claudeDir: t.claudeDir, codexDir: t.codexDir, cacheFile };
  const other = await loadSessions({ ...dirs, project: 'aimline' });
  assert.equal(other.sessions.length, 0); // not Aimline's session
  const ours = await loadSessions({ ...dirs, project: 'unilex' });
  assert.equal(ours.reused, 0); // the Aimline answers are thrown away
  assert.equal(ours.sessions.length, 1); // so the UniLex session is found
  t.done();
});

test('sleep calls are counted in Claude shell commands', async () => {
  const t = tree();
  const s = await parseClaudeFile(claudeSession(t));
  assert.equal(s.sleeps, 1);
  assert.equal(s.role, 'builder');
  assert.equal(s.slice, '072');
  t.done();
});

test('cache: unchanged file reused, changed file read again, corrupt cache rebuilt', async () => {
  const t = tree();
  const file = claudeSession(t);
  codexSession(t);
  const cacheFile = join(t.root, 'cache.json');
  const opts = { claudeDir: t.claudeDir, codexDir: t.codexDir, project: 'unilex', cacheFile };
  const first = await loadSessions(opts);
  assert.deepEqual([first.parsed, first.reused, first.sessions.length], [2, 0, 2]);
  const second = await loadSessions(opts);
  assert.deepEqual([second.parsed, second.reused], [0, 2]);
  appendFileSync(file, JSON.stringify(reply('m3', [1, 1, 5000, 1])) + '\n');
  const third = await loadSessions(opts);
  assert.deepEqual([third.parsed, third.reused], [1, 1]);
  assert.equal(third.sessions.find((s) => s.tool === 'claude').turns, 3);
  writeFileSync(cacheFile, '{not json');
  const fourth = await loadSessions(opts);
  assert.deepEqual([fourth.parsed, fourth.reused], [2, 0]);
  assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).version, 5);
  t.done();
});

test('merged pull requests split into code and docs-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-git-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const put = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const pr = (name, files, n) => {
    git('checkout', '-q', '-b', name, 'main');
    for (const f of files) put(f, name);
    git('add', '-A');
    git('commit', '-q', '-m', name);
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', `Merge pull request #${n}`, name);
  };
  git('init', '-q', '-b', 'main');
  put('README.md', 'x');
  // The same settings file the merge script reads: design files are left off, because tests read them.
  put('scripts/kit.config.json', JSON.stringify({ paperworkPaths: ['docs/plans/', 'docs/handoff.md', 'AGENTS.md'] }));
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  pr('docs-a', ['docs/handoff.md', 'docs/plans/x.md'], 1); // every file on the list: docs-only
  pr('design-a', ['docs/design/x.html'], 2); // under docs/ but not on the list: code
  pr('readme-a', ['README.md'], 3); // a .md file that is not on the list: code
  pr('code-a', ['docs/plans/y.md', 'scripts/x.mjs'], 4); // one code file: code
  const days = mergedPrs(dir, ['origin/main', 'main']);
  const sum = Object.values(days).reduce((a, d) => ({ code: a.code + d.code, docs: a.docs + d.docs }), { code: 0, docs: 0 });
  assert.deepEqual(sum, { code: 3, docs: 1 });
  assert.equal(mergedPrs(dir, ['no-such-ref']), null);
  rmSync(dir, { recursive: true, force: true });
});

const session = (id, over = {}) => ({ tool: 'claude', id, model: 'm', start: TS, turns: 10, startup: 50_000, peak: 100_000, total: 1e6, days: { '2026-11-12': 1e6 }, role: 'builder', slice: '072', sleeps: 0, ...over });

test('a broken settings file falls back to the default docs list instead of crashing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-cfg-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, 'scripts'));
  for (const bad of ['{"paperworkPaths": [42]}', '{"paperworkPaths": [""]}', '{"paperworkPaths": "docs/"}', '{not json']) {
    writeFileSync(join(dir, 'scripts', 'kit.config.json'), bad);
    assert.deepEqual(paperworkPathsFor(dir), ['docs/', 'AGENTS.md'], bad);
  }
  writeFileSync(join(dir, 'scripts', 'kit.config.json'), '{"paperworkPaths": ["notes/"]}');
  assert.deepEqual(paperworkPathsFor(dir), ['notes/']); // a good file is still used
  rmSync(dir, { recursive: true, force: true });
});

test('warnings fire just past each limit, not at it', () => {
  const sessions = [
    session('at-limit', { turns: 150, peak: 200_000, sleeps: 9 }),
    session('over', { turns: 151, peak: 200_001, sleeps: 10 }),
  ];
  const r = buildReport({ sessions, prs: {}, days: 3, now: new Date(2026, 10, 12, 18) });
  for (const w of Object.values(r.warnings)) {
    assert.equal(w.count, 1);
    assert.equal(w.worst[0].id, 'over');
  }
});

test('report: tokens per code PR, n/a when git is missing, start-up load check', () => {
  const now = new Date(2026, 10, 12, 18);
  const recent = new Date(now - 3600 * 1000).toISOString();
  const older = new Date(now - 3 * 24 * 3600 * 1000).toISOString();
  const sessions = [session('a', { start: recent, startup: 30_000 }), session('b', { start: older, startup: 60_000 })];
  const day = Object.keys(sessions[0].days)[0];
  const r = buildReport({ sessions, prs: { [day]: { code: 2, docs: 1 } }, days: 7, now });
  assert.equal(r.tokens, 2e6);
  assert.equal(r.perCodePr, 1e6);
  assert.equal(r.startup.last24h.median, 30_000);
  assert.equal(r.startup.prior7d.median, 60_000);
  const noGit = buildReport({ sessions, prs: null, days: 7, now });
  assert.match(renderText(noGit), /Merged PRs: n\/a code/);
  assert.match(renderText(noGit), /2\.0M/);
});

test('HTML page holds no transcript text and no em dash', async () => {
  const t = tree();
  claudeSession(t);
  codexSession(t);
  const { sessions } = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, project: 'unilex' });
  const html = renderHtml(buildReport({ sessions, prs: null, days: 3, now: new Date(2026, 10, 12, 18) }));
  assert.ok(html.includes('<table>'));
  assert.ok(!html.includes(SECRET));
  assert.ok(!html.includes('sleep 30'));
  assert.ok(!html.includes(String.fromCharCode(0x2014)));
  assert.ok(html.includes('var(--chart-1, #4f7cff)') || html.includes('var(--chart-1,#4f7cff)'));
  t.done();
});

// ---- run records (decision 012, part 1e) ----

const at = (h) => `2026-11-16T${String(h).padStart(2, '0')}:00:00.000Z`;

test('per session: size at the last turn, and summaries counted once each (Claude and Codex)', async () => {
  const t = tree();
  const claude = t.write(join(t.claudeDir, '-w-unilex-t3-abc', 'c.jsonl'), [
    user('You are a **builder** for UniLex.'),
    reply('m1', [10, 1000, 190000, 5]),
    { type: 'system', subtype: 'compact_boundary', timestamp: TS, compactMetadata: { trigger: 'auto', preTokens: 191010 } },
    user('This session is being continued from a previous conversation.', { isCompactSummary: true }),
    reply('m2', [5, 100, 4000, 7]),
    { type: 'system', subtype: 'compact_boundary', timestamp: TS },
    user('Summary again.', { isCompactSummary: true }),
    reply('m3', [1, 0, 900, 3]),
  ]);
  const c = await parseClaudeFile(claude);
  assert.deepEqual([c.lastSize, c.summaries, c.peak], [901, 2, 191010]);
  const plain = await parseClaudeFile(claudeSession(t));
  assert.deepEqual([plain.lastSize, plain.summaries], [4105, 0]);
  const codexFile = codexSession(t);
  const more = [
    { type: 'compacted', timestamp: TS, payload: { message: '' } },
    { type: 'event_msg', timestamp: TS, payload: { type: 'context_compacted' } },
    { type: 'event_msg', timestamp: TS, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 700, output_tokens: 1 }, total_token_usage: { total_tokens: 4731 } } } },
  ];
  appendFileSync(codexFile, more.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const x = await parseCodexFile(codexFile, 'unilex');
  assert.deepEqual([x.lastSize, x.summaries, x.peak], [700, 1, 3000]);
  t.done();
});

test('per session: each turn with its time, tokens, and branch (Claude and Codex)', async () => {
  const t = tree();
  const file = t.write(join(t.claudeDir, '-w-unilex-t3-abc', 'b.jsonl'), [
    user('You are a **builder** for UniLex.', { timestamp: at(8), gitBranch: 'main' }),
    { ...reply('m1', [1, 1, 1, 1], [], at(9)), gitBranch: 'build/012-x' },
    { ...reply('m2', [1, 1, 1, 1], [], at(11)), gitBranch: 'build/012-x' },
    reply('m3', [2, 0, 0, 1], [], at(12)), // no branch on the line: the last one seen
  ]);
  const s = await parseClaudeFile(file);
  assert.deepEqual(s.turnLog, [[Date.parse(at(9)), 4, 'build/012-x'], [Date.parse(at(11)), 4, 'build/012-x'], [Date.parse(at(12)), 3, 'build/012-x']]);
  assert.equal(s.last, at(12));
  const x = await parseCodexFile(codexSession(t), 'unilex');
  assert.deepEqual(x.turnLog, [[Date.parse(TS), 1010, 'build/084-welcome'], [Date.parse(TS), 3020, 'build/084-welcome']]);
  t.done();
});

test('report: threads summarized at least once are counted and the worst named', () => {
  const sessions = [session('calm', { summaries: 0 }), session('busy', { summaries: 3 }), session('old')];
  const r = buildReport({ sessions, prs: {}, days: 3, now: new Date(2026, 10, 12, 18) });
  assert.deepEqual(r.summarized, { count: 1, worst: [{ id: 'busy', value: 3 }] });
  assert.match(renderText(r), /Threads summarized at least once: 1\. Worst: busy \(3 summaries\)/);
});

const RUN = { name: 'wave-1', start: at(9), end: at(17), tokenLimit: 100e6, leadBranch: 'lead/wave-1', sliceBranches: ['build/012-x', 'build/013-y'] };
// A session made from its turns: [hour or ISO time, tokens, branch]. The other fields follow from them.
const runSession = (id, turnList, over = {}) => {
  const turnLog = turnList.map(([h, n, b]) => [Date.parse(typeof h === 'number' ? at(h) : h), n, b]);
  const iso = (ms) => new Date(ms).toISOString();
  const branches = {};
  for (const [ms, , b] of turnLog) branches[b] = iso(ms);
  return session(id, { start: iso(turnLog[0][0]), last: iso(turnLog.at(-1)[0]), total: turnLog.reduce((a, [, n]) => a + n, 0), summaries: 0, lastSize: 50_000, branches, turnLog, ...over });
};

test('groupRun: by branch inside the window; head threads on the lead branch to the run; the rest unassigned', () => {
  const sessions = [
    runSession('b1', [[11, 3e6, 'build/012-x']], { summaries: 2, lastSize: 150_000 }),
    runSession('b2', [[10, 5e5, 'main'], [12, 5e5, 'build/012-x']]),
    runSession('early', [[6, 4e6, 'build/013-y'], [10, 1e6, 'main']]), // on 013 only before the start
    runSession('h', [[12, 2e6, 'lead/wave-1']], { role: 'head' }),
    runSession('lead', [[13, 4e6, 'lead/wave-1']], { role: 'other' }),
    runSession('after', [[18, 9e6, 'build/012-x']]),
  ];
  const g = groupRun(RUN, sessions);
  assert.deepEqual(g.branches['build/012-x'], { sessions: 2, total: 4e6, summaries: 2, maxLast: 150_000 });
  assert.deepEqual(g.branches['build/013-y'], { sessions: 0, total: 0, summaries: 0, maxLast: 0 });
  assert.equal(g.branches['lead/wave-1'].total, 4e6);
  assert.deepEqual(g.head, { sessions: 1, total: 2e6, summaries: 0, maxLast: 50_000 });
  assert.deepEqual(g.unassigned, { sessions: 1, total: 1e6, summaries: 0, maxLast: 50_000 });
  assert.equal(g.total, 10e6); // head and listed branches; unassigned is shown, not charged
});

test('groupRun: a head thread on another run\'s lead branch is not charged to this run', () => {
  const g = groupRun(RUN, [runSession('h2', [[12, 7e6, 'lead/wave-2']], { role: 'head' })]);
  assert.deepEqual([g.head.total, g.unassigned.total, g.total], [0, 7e6, 0]);
});

test('groupRun: only tokens from turns inside the window are charged, so an ended run stops growing', () => {
  const span = runSession('span', [[8, 6e6, 'build/013-y'], [10, 1e6, 'build/013-y'], [19, 8e6, 'build/013-y']]);
  const g = groupRun(RUN, [span]);
  assert.deepEqual([g.branches['build/013-y'].total, g.total], [1e6, 1e6]);
});

test('groupRun: a branch first touched after the run ended does not pull the session into it', () => {
  const tuesday = runSession('tue', [[12, 1e6, 'main'], ['2026-11-17T10:00:00.000Z', 5e6, 'build/012-x']]);
  const g = groupRun(RUN, [tuesday]);
  assert.deepEqual([g.branches['build/012-x'].total, g.unassigned.total, g.total], [0, 1e6, 0]);
});

test('groupRun: turns with no time on a run branch are shown on a "no time" line, never dropped and never charged', () => {
  const g = groupRun(RUN, [
    session('nt', { turnLog: [[NaN, 100, 'build/012-x'], [NaN, 40, 'main']] }), // only the run branch turn counts
    session('nth', { role: 'head', turnLog: [[NaN, 30, 'lead/wave-1'], [Date.parse(at(12)), 5, 'lead/wave-1']] }),
    session('other', { turnLog: [[NaN, 900, 'build/099-z']] }), // not this run's branch
  ]);
  assert.deepEqual(g.noTime, { sessions: 2, total: 130, summaries: 0, maxLast: 0 });
  assert.deepEqual([g.head.total, g.branches['build/012-x'].total, g.unassigned.total, g.total], [5, 0, 0, 5]);
});

test('groupRun: a turn with no time still shows on the "no time" line after the cache is saved and read back', async () => {
  const t = tree();
  t.write(join(t.claudeDir, '-w-unilex-t3-abc', 'nt.jsonl'), [user('You are a **builder** for UniLex.'), { ...reply('m1', [10, 0, 0, 5]), timestamp: undefined }]); // the reply line has no time
  const opts = { claudeDir: t.claudeDir, codexDir: t.codexDir, project: 'unilex', cacheFile: join(t.root, 'cache.json') };
  const run = { ...RUN, sliceBranches: ['build/072-cleanup'] };
  const first = await loadSessions(opts);
  const second = await loadSessions(opts);
  assert.deepEqual([first.parsed, second.reused], [1, 1]);
  assert.deepEqual(groupRun(run, first.sessions).noTime, { sessions: 1, total: 15, summaries: 0, maxLast: 0 });
  assert.deepEqual(groupRun(run, second.sessions).noTime, { sessions: 1, total: 15, summaries: 0, maxLast: 0 });
  t.done();
});

test('reviewRounds: receipts per task, inside the run and for its slices only', () => {
  const r = (task, h) => ({ task, verdict: 'approve', at: at(h) });
  assert.deepEqual(reviewRounds([r('012', 10), r('013', 11), r('012', 12), r('012', 8), r('014', 18), r('099', 12)], RUN), [['012', 2], ['013', 1]]);
});

test('blockStats: a pass on new fingerprints is a real catch; on the same ones, a mistaken block', () => {
  const fp = (...f) => f.map((x) => ({ commit: `c${x}`, fingerprint: `f${x}` }));
  const line = (outcome, pr, h, fingerprints) => ({ at: at(h), outcome, pr, branch: `b${pr}`, fingerprints });
  const lines = [
    line('blocked', 1, 10, fp(1, 2)), line('merged', 1, 11, fp(1, 3)), // fixed: a real catch
    line('blocked', 2, 10, fp(4)), line('blocked', 2, 11, fp(4)), line('merged', 2, 12, fp(4)), // passed unchanged, twice
    line('blocked', 3, 12, fp(5)), // never passed
    line('blocked', 4, 12, null), line('merged', 4, 13, fp(6)), // no fingerprints: cannot say
    line('blocked', 5, 7, fp(7)), line('merged', 5, 13, fp(8)), // the block came before the run
    line('merged', 6, 12, fp(1, 2)), // a pass of another pull request never settles pull request 1
  ];
  assert.deepEqual(blockStats(lines, RUN), { catches: 1, mistaken: 2, open: 1, unknown: 1 });
});

test('blockStats: a block is settled by the next pass of the same check; a merge passes every check', () => {
  const fp = (...f) => f.map((x) => ({ commit: `c${x}`, fingerprint: `f${x}` }));
  const line = (outcome, pr, h, check, fingerprints) => ({ at: at(h), outcome, pr, branch: `b${pr}`, check, fingerprints });
  const lines = [
    // lint blocks, then passes unchanged while tests block; the tests fix changes the code before the merge
    line('blocked', 1, 10, 'lint', fp(1)), line('passed', 1, 11, 'lint', fp(1)), line('blocked', 1, 11, 'tests', fp(1)),
    line('passed', 1, 12, 'lint', fp(2)), line('passed', 1, 12, 'tests', fp(2)), line('merged', 1, 12, null, fp(2)),
    line('blocked', 2, 10, 'tests', fp(3)), line('passed', 2, 11, 'lint', fp(3)), // another check's pass settles nothing
    line('passed', 3, 10, 'tests', fp(3)), // another pull request's pass settles nothing
    line('blocked', 4, 10, 'github', fp(4)), line('merged', 4, 11, null, fp(4)), // no "passed" line for github: the merge
  ];
  assert.deepEqual(blockStats(lines, RUN), { catches: 1, mistaken: 2, open: 1, unknown: 0 });
});

test('parkedCount: parked plans whose number is one of the run slices', () => {
  const plans = [{ file: '012-x.md', status: 'parked' }, { file: '013-y.md', status: 'in_progress' }, { file: '020-z.md', status: 'parked' }];
  assert.equal(parkedCount(plans, RUN), 1);
});

// A throwaway repo whose main gets one merge per pull request, made at the given time.
function reworkRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-rework-'));
  const run = (args, when) => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const git = (args) => run(args, '2026-11-01T00:00:00Z');
  const put = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const pr = (name, files, when, subject = `Merge ${name}`) => {
    run(['checkout', '-q', '-b', name, 'main'], when);
    for (const [f, text] of Object.entries(files)) put(f, text);
    run(['add', '-A'], when);
    run(['commit', '-q', '-m', name], when);
    run(['checkout', '-q', 'main'], when);
    run(['merge', '-q', '--no-ff', '-m', subject, name], when);
  };
  run(['init', '-q', '-b', 'main'], '2026-11-01T00:00:00Z');
  put('a.js', 'old\n');
  run(['add', '-A'], '2026-11-01T00:00:00Z');
  run(['commit', '-q', '-m', 'start'], '2026-11-01T00:00:00Z');
  return { dir, git, pr, run, put };
}
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';

test('reworkShare: the run\'s merged code lines changed again within 14 days of each merge, shown only after 14 full days', () => {
  const { dir, git, pr } = reworkRepo();
  pr('lead/wave-1', { 'docs/runs/wave-1.json': '{}\n' }, '2026-11-16T09:30:00Z'); // paperwork only
  pr('build/012-x', { 'a.js': lines(10, 'a'), 'docs/plans/012.md': lines(50, 'p') }, '2026-11-16T10:00:00Z'); // 10 code lines (old line replaced); plans are paperwork
  pr('build/013-y', { 'b.js': lines(10, 'b') }, '2026-11-16T11:00:00Z');
  pr('build/020-z', { 'a.js': lines(10, 'a').replace('a0\na1\n', 'A0\nA1\n') }, '2026-11-20T10:00:00Z'); // 2 lines changed again
  pr('build/099-other', { 'c.js': lines(10, 'c') }, '2026-11-16T12:00:00Z'); // inside the window, but not one of the run's branches
  pr('build/025-v', { 'a.js': lines(10, 'a').replace('a0\na1\n', 'A0\nA1\n').replace('a5\n', 'A5\n') }, '2026-11-30T12:00:00Z'); // before the run's end + 14 days, after 012's merge + 14 days
  pr('build/030-w', { 'b.js': lines(10, 'B') }, '2026-12-25T10:00:00Z'); // after the 14 days: not counted
  const opts = { git, run: RUN, ref: 'main', paperworkPaths: ['docs/'] };
  assert.equal(reworkShare({ ...opts, now: Date.parse('2026-11-30T00:00:00Z') }), null); // 14 days not yet behind it
  assert.equal(reworkShare({ ...opts, run: { ...RUN, end: null }, now: Date.parse('2027-01-30T00:00:00Z') }), null); // still open
  // 099-other is the one commit in the window not matched to a run branch: it might be a run branch's merge, so no share
  assert.deepEqual(reworkShare({ ...opts, now: Date.parse('2027-01-30T00:00:00Z') }), { merges: 3, added: 20, changed: 2, share: null, unmatched: 1, missing: [] });
  // a run that ends before 099-other's merge has nothing unmatched: the share stands (cutoffs are per merge, so the same lines)
  assert.deepEqual(reworkShare({ ...opts, run: { ...RUN, end: '2026-11-16T11:30:00.000Z' }, now: Date.parse('2027-01-30T00:00:00Z') }), { merges: 3, added: 20, changed: 2, share: 0.1, unmatched: 0, missing: [] });
  rmSync(dir, { recursive: true, force: true });
});

test('reworkShare: GitHub merge subjects match; a run branch with no matched merge makes the share unknown while other commits are unmatched', () => {
  const { dir, git, pr } = reworkRepo();
  pr('lead/wave-1', { 'docs/runs/wave-1.json': '{}\n' }, '2026-11-16T09:30:00Z', 'Merge pull request #6 from owner/lead/wave-1');
  pr('build/012-x', { 'a.js': lines(10, 'a') }, '2026-11-16T10:00:00Z', 'Merge pull request #7 from owner/build/012-x');
  pr('build/013-y', { 'b.js': lines(10, 'b') }, '2026-11-16T11:00:00Z', 'Add feature (#8)'); // merged another way
  const opts = { git, run: RUN, ref: 'main', paperworkPaths: ['docs/'], now: Date.parse('2027-01-30T00:00:00Z') };
  assert.deepEqual(reworkShare(opts), { merges: 2, added: 10, changed: 0, share: null, unmatched: 1, missing: ['build/013-y'] });
  // with nothing unmatched in the window, a run branch with no merge was simply not merged: the share stands
  assert.deepEqual(reworkShare({ ...opts, run: { ...RUN, end: at(10), sliceBranches: ['build/012-x', 'build/014-z'] } }), { merges: 2, added: 10, changed: 0, share: 0, unmatched: 0, missing: ['build/014-z'] });
  rmSync(dir, { recursive: true, force: true });
});

test('reworkShare: a second merge of a run branch with a hand-written subject makes the share unknown, even with every branch matched', () => {
  const { dir, git, pr, run, put } = reworkRepo();
  pr('lead/wave-1', { 'docs/runs/wave-1.json': '{}\n' }, '2026-11-16T09:30:00Z');
  pr('build/012-x', { 'a.js': lines(10, 'a') }, '2026-11-16T10:00:00Z');
  pr('build/013-y', { 'b.js': lines(10, 'b') }, '2026-11-16T11:00:00Z');
  // 012 merged again, with a subject that does not end in the branch name: its 10 lines are not matched
  const when = '2026-11-16T12:00:00Z';
  run(['checkout', '-q', 'build/012-x'], when);
  put('c.js', lines(10, 'c'));
  run(['add', '-A'], when);
  run(['commit', '-q', '-m', 'more'], when);
  run(['checkout', '-q', 'main'], when);
  run(['merge', '-q', '--no-ff', '-m', 'Fix the welcome screen', 'build/012-x'], when);
  const out = reworkShare({ git, run: RUN, ref: 'main', paperworkPaths: ['docs/'], now: Date.parse('2027-01-30T00:00:00Z') });
  assert.deepEqual(out, { merges: 3, added: 20, changed: 0, share: null, unmatched: 1, missing: [] });
  rmSync(dir, { recursive: true, force: true });
});

test('renderRun: one short block; rework only when it can be shown', () => {
  const r = {
    run: RUN,
    groups: {
      branches: { 'lead/wave-1': { sessions: 1, total: 1e6, summaries: 0, maxLast: 90_000 }, 'build/012-x': { sessions: 2, total: 4e6, summaries: 2, maxLast: 150_000 } },
      head: { sessions: 1, total: 2e6, summaries: 1, maxLast: 120_000 },
      unassigned: { sessions: 1, total: 5e5, summaries: 0, maxLast: 10_000 },
      noTime: { sessions: 0, total: 0, summaries: 0, maxLast: 0 },
      total: 7e6,
    },
    rounds: [['012', 2]],
    blocks: { catches: 1, mistaken: 2, open: 1, unknown: 0 },
    parked: 1,
    rework: null,
  };
  const text = renderRun(r);
  assert.match(text, /^Run wave-1 \(2026-11-16T09:00:00\.000Z to 2026-11-16T17:00:00\.000Z\): 7\.0M of the 100\.0M limit\./);
  assert.match(text, /head agent +1 +2\.0 +1 +120k/);
  assert.match(text, /build\/012-x +2 +4\.0 +2 +150k/);
  assert.match(text, /unassigned +1 +0\.5 /);
  assert.match(text, /Review rounds per task: 012 2\./);
  assert.match(text, /Blocks: 1 real catches, 2 mistaken, 1 not passed yet, 0 without fingerprints\./);
  assert.match(text, /Parked slices: 1\./);
  assert.match(text, /Rework: not shown until 14 days after the run ends\./);
  assert.doesNotMatch(text, /no time/);
  const noTime = renderRun({ ...r, groups: { ...r.groups, noTime: { sessions: 1, total: 3e5, summaries: 0, maxLast: 0 } } });
  assert.match(noTime, /no time, not charged +1 +0\.3 /);
  const rework = (x) => renderRun({ ...r, rework: { merges: 2, added: 20, changed: 2, share: 0.1, unmatched: 0, missing: [], ...x } });
  assert.match(rework({}), /Rework: 10% of 20 merged code lines \(2 merges\) changed again within 14 days\.$/m);
  assert.match(rework({ unmatched: 3, missing: ['build/013-y'], share: null }), /Rework: unknown\. 3 commits in the window could not be matched to a run branch \(only subjects ending in the branch name match\), and any of them may be a run branch's merge\. No merge found for build\/013-y\.$/m);
  assert.match(rework({ unmatched: 1, share: null }), /any of them may be a run branch's merge\.$/m); // every branch matched: no "No merge found"
  assert.ok(text.split('\n').length <= 12);
});

test('loadSessions scans multiple claudeDirs and keeps slice ids found in prompts', async () => {
  const t = tree();
  try {
    const claudeDir2 = join(t.root, 'claude2');
    t.write(join(t.claudeDir, '-w-unilex-a', 'a.jsonl'), [
      user('Review Slice 099 Task 4.', { gitBranch: 't3/review-gender' }),
      reply('m1', [100, 0, 0, 50]),
    ]);
    t.write(join(claudeDir2, '-w-unilex-b', 'b.jsonl'), [
      user('Build Slice 098 Task 1.', { gitBranch: 't3/oled-work' }),
      reply('m2', [200, 0, 0, 50]),
    ]);
    const res = await loadSessions({ claudeDirs: [t.claudeDir, claudeDir2], codexDir: t.codexDir, project: 'unilex' });
    assert.equal(res.sessions.length, 2);
    assert.deepEqual(res.sessions.map((s) => s.slice).sort(), ['098', '099']);
  } finally {
    t.done();
  }
});

// ---- Antigravity / Gemini Neon transcripts ----

function agyStep(u, extra = {}) {
  return {
    step_index: extra.step_index ?? 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: extra.created_at ?? TS,
    model: extra.model ?? 'gemini-4-neon-high',
    input_tokens: u[0],
    cache_read_tokens: u[1],
    output_tokens: u[2],
    ...extra,
  };
}

test('Antigravity: defaultAntigravityDirs isolates tests and findAntigravityFiles supports all layouts', () => {
  assert.deepEqual(defaultAntigravityDirs({}, '/fake/home'), ['/fake/home/.t3/userdata/providers/antigravity']);
  assert.deepEqual(defaultAntigravityDirs({ LEDGER_ANTIGRAVITY_DIR: '/tmp/agy' }, '/fake/home'), ['/tmp/agy']);
  assert.deepEqual(defaultAntigravityDirs({ LEDGER_CLAUDE_DIR: '/tmp/c' }, '/fake/home'), []);
  assert.deepEqual(defaultAntigravityDirs({ LEDGER_CODEX_DIR: '/tmp/x' }, '/fake/home'), []);
  assert.deepEqual(defaultAntigravityDirs({ LEDGER_CLAUDE_DIR: '/tmp/c', LEDGER_ANTIGRAVITY_DIR: '/tmp/agy' }, '/fake/home'), ['/tmp/agy']);

  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    const nested = t.write(join(agyDir, 'hash123', 'antigravity-acp', 'brain', 'conv-a', '.system_generated', 'logs', 'transcript.jsonl'), []);
    t.write(join(agyDir, 'hash123', 'antigravity-acp', 'brain', 'conv-a', '.system_generated', 'logs', 'transcript_full.jsonl'), []);
    t.write(join(agyDir, 'hash123', 'antigravity-acp', 'brain', 'conv-a', '.system_generated', 'logs', 'chunks', '00000000.jsonl'), []);
    const shortNested = t.write(join(agyDir, 'conv-b', '.system_generated', 'logs', 'transcript.jsonl'), []);
    const flat = t.write(join(agyDir, 'conv-c.jsonl'), []);
    const found = findAntigravityFiles([agyDir, join(t.root, 'does-not-exist')]).sort();
    assert.deepEqual(found, [nested, shortNested, flat].sort());
  } finally {
    t.done();
  }
});

test('Antigravity: parses ctx = input + cache_read, total = ctx + output, and detects compaction', async () => {
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    const file = t.write(join(agyDir, 'conv-compaction', '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: TS,
        content: `<user_information>\nActive Workspaces:\n- /Users/dev/unilex\nCommand Working Directory: /Users/dev/unilex\n</user_information>\n<user_request>\nYou are the UniLex head agent. Work on Slice 091.\n</user_request>`,
      },
      agyStep([30_000, 10_000, 500], { step_index: 1 }), // ctx 40k, total 40,500
      agyStep([14_000, 500_000, 1_000], { step_index: 2 }), // ctx 514k, total 515,000
      agyStep([8_000, 150_000, 750], { step_index: 3, tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 5 && echo ok' } }] }), // ctx 158k (< 514k * 0.6): compaction!
      agyStep([20_000, 158_000, 250], { step_index: 4 }), // ctx 178k: no compaction
    ]);
    const s = await parseAntigravityFile(file, 'unilex');
    assert.equal(s.tool, 'antigravity');
    assert.equal(s.id, 'conv-compaction');
    assert.equal(s.model, 'gemini-4-neon-high');
    assert.equal(s.turns, 4);
    assert.equal(s.startup, 40_000);
    assert.equal(s.peak, 514_000);
    assert.equal(s.lastSize, 178_000);
    assert.equal(s.total, 40_500 + 515_000 + 158_750 + 178_250);
    assert.equal(s.summaries, 1);
    assert.equal(s.role, 'head');
    assert.equal(s.slice, '091');
    assert.equal(s.cwd, '/Users/dev/unilex');
    assert.equal(s.sleeps, 1);
    assert.equal(s.turnLog.length, 4);
  } finally {
    t.done();
  }
});

test('Antigravity: strips <t3_code_instructions> before classifyRole and sliceId, and classifies Blind Neon reviewers', async () => {
  assert.equal(classifyRole('You are the Starter Kit head agent.'), 'head');
  assert.equal(classifyRole('Run a Blind Neon pass on Slice 099.'), 'reviewer');
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    const headFile = t.write(join(agyDir, 'head-session.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: `<t3_code_instructions>\nNever act as a reviewer for Slice 001. Do not invoke builder tools.\n</t3_code_instructions>\n<user_request>\n[T3 Code: the agent in T3 thread "abc" sent this message, not the user.]\n\nYou are the UniLex head agent working on Slice 099.\n</user_request>`,
      },
      agyStep([12_000, 8_000, 300]),
    ]);
    const head = await parseAntigravityFile(headFile, 'unilex');
    assert.equal(head.role, 'head');
    assert.equal(head.slice, '099');

    const reviewFile = t.write(join(agyDir, 'blind-neon.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: `<t3_code_instructions>\nGeneric T3 instructions.\n</t3_code_instructions>\n<user_request>\nAct as the Blind Neon audit for UniLex Slice 088.\n</user_request>`,
      },
      agyStep([5_000, 15_000, 200]),
    ]);
    const rev = await parseAntigravityFile(reviewFile, 'unilex');
    assert.equal(rev.role, 'reviewer');
    assert.equal(rev.slice, '088');
  } finally {
    t.done();
  }
});

test('Antigravity: sessions from other projects are filtered out cleanly', async () => {
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    t.write(join(agyDir, 'other-cwd.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: `<user_information>\nCommand Working Directory: /Users/dev/aimline\n</user_information>\n<user_request>\nCompare aimline with unilex.\n</user_request>`,
      },
      agyStep([10_000, 5_000, 100]),
    ]);
    t.write(join(agyDir, 'other-prompt.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: 'Build dashboard widgets for aimline.',
      },
      agyStep([10_000, 5_000, 100]),
    ]);
    t.write(join(agyDir, 'match-prompt.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: 'You are the UniLex head agent.',
      },
      agyStep([10_000, 5_000, 100]),
    ]);
    const { sessions } = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'unilex' });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'match-prompt');
  } finally {
    t.done();
  }
});

test('Antigravity: totals appear in daily, role, slice, warning, text, HTML, and CLI LEDGER_ANTIGRAVITY_DIR outputs', async () => {
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    const now = new Date();
    const todayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0).toISOString();
    const steps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: todayTs,
        content: `<user_information>\nActive Workspaces:\n- /Users/dev/unilex\n</user_information>\n<user_request>\nYou are the UniLex head agent on Slice 095.\n</user_request>`,
      },
    ];
    // 151 turns, hitting > 150 turns, peak > 200k, and 1 compaction
    for (let i = 1; i <= 149; i++) {
      steps.push(agyStep([1_000, 9_000, 100], { step_index: i, created_at: todayTs }));
    }
    steps.push(agyStep([14_000, 500_000, 1_000], { step_index: 150, created_at: todayTs }));
    steps.push(agyStep([8_000, 150_000, 500], { step_index: 151, created_at: todayTs }));
    t.write(join(agyDir, 'conv-heavy', '.system_generated', 'logs', 'transcript.jsonl'), steps);

    const out = execFileSync(process.execPath, ['scripts/token-ledger.mjs', '--days', '2', '--project', 'unilex', '--json', '--no-cache'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        LEDGER_CLAUDE_DIR: t.claudeDir,
        LEDGER_CODEX_DIR: t.codexDir,
        LEDGER_ANTIGRAVITY_DIR: agyDir,
      },
    });
    const r = JSON.parse(out);
    const todayRow = r.perDay[r.perDay.length - 1];
    const expectedTotal = 149 * 10_100 + 515_000 + 158_500;
    assert.equal(todayRow.antigravity, expectedTotal);
    assert.equal(todayRow.claude, 0);
    assert.equal(todayRow.codex, 0);
    assert.equal(r.tokens, expectedTotal);
    assert.equal(r.roles.find((x) => x.role === 'head').total, expectedTotal);
    assert.equal(r.slices.find((x) => x.slice === '095').total, expectedTotal);
    assert.equal(r.warnings.longThreads.count, 1);
    assert.equal(r.warnings.longThreads.worst[0].id, 'conv-heavy');
    assert.equal(r.warnings.bigContext.count, 1);
    assert.equal(r.warnings.bigContext.worst[0].id, 'conv-heavy');
    assert.equal(r.summarized.count, 1);
    assert.equal(r.summarized.worst[0].id, 'conv-heavy');

    const text = renderText(r);
    assert.match(text, /Claude Code \+ Codex \+ Antigravity/);
    assert.match(text, /AGY M/);
    const html = renderHtml(r);
    assert.match(html, /Claude Code \+ Codex \+ Antigravity/);
    assert.match(html, /<th>AGY M<\/th>/);
    assert.match(html, /Antigravity/);
    assert.ok(!html.includes(String.fromCharCode(0x2014)));
  } finally {
    t.done();
  }
});

test('Antigravity: findAntigravityFiles skips worktrees, node_modules, .git, chunks, media and reads brain layout', () => {
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    const nested = t.write(join(agyDir, 'hash123', 'antigravity-acp', 'brain', 'conv-ok', '.system_generated', 'logs', 'transcript.jsonl'), []);
    const directBrain = t.write(join(agyDir, 'brain', 'conv-brain', '.system_generated', 'logs', 'transcript.jsonl'), []);
    t.write(join(agyDir, 'hash123', 'antigravity-acp', 'worktrees', 'wt-1', '.system_generated', 'logs', 'transcript.jsonl'), []);
    t.write(join(agyDir, 'hash123', 'antigravity-acp', 'worktrees', 'wt-2', 'transcript.jsonl'), []);
    t.write(join(agyDir, 'worktrees', 'wt-3', '.system_generated', 'logs', 'transcript.jsonl'), []);
    t.write(join(agyDir, 'node_modules', 'pkg', '.system_generated', 'logs', 'transcript.jsonl'), []);
    t.write(join(agyDir, '.git', 'conv-git', '.system_generated', 'logs', 'transcript.jsonl'), []);
    t.write(join(agyDir, 'media', 'conv-media', '.system_generated', 'logs', 'transcript.jsonl'), []);
    t.write(join(agyDir, 'chunks', 'conv-chunks', '.system_generated', 'logs', 'transcript.jsonl'), []);
    t.write(join(agyDir, 'transcript_full.jsonl'), []);
    const found = findAntigravityFiles([agyDir]).sort();
    assert.deepEqual(found, [directBrain, nested].sort());
  } finally {
    t.done();
  }
});

test('Antigravity: SYSTEM_MESSAGE-only child sessions (including truncated ones) are parsed and classified', async () => {
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    const childFile = t.write(join(agyDir, 'conv-sys', '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: TS,
        content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-22T11:43:01Z sender=parent-1 priority=MESSAGE_PRIORITY_HIGH content=You are a secondary Blind Neon reviewer for UniLex Slice 093.\n</SYSTEM_MESSAGE>',
      },
      agyStep([8_000, 12_000, 500]),
    ]);
    const s = await parseAntigravityFile(childFile, 'unilex');
    assert.equal(s.skip, undefined);
    assert.equal(s.role, 'reviewer');
    assert.equal(s.slice, '093');
    assert.equal(s.total, 20_500);

    const truncFile = t.write(join(agyDir, 'conv-sys-trunc', '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: TS,
        content: 'The following is a <SYSTEM_MESSAGE>...',
        truncated_fields: ['content'],
      },
      agyStep([4_000, 6_000, 200]),
    ]);
    t.write(join(agyDir, 'conv-sys-trunc', '.system_generated', 'logs', 'transcript_full.jsonl'), [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: TS,
        content: 'You are a secondary Blind Neon reviewer for UniLex Slice 094.',
      },
    ]);
    const st = await parseAntigravityFile(truncFile, 'unilex');
    assert.equal(st.skip, undefined);
    assert.equal(st.role, 'reviewer');
    assert.equal(st.slice, '094');
    assert.equal(st.total, 10_200);
  } finally {
    t.done();
  }
});

test('Antigravity: parent -> child conversationId linking propagates project and slice once without double-counting', async () => {
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    const cacheFile = join(t.root, 'cache.json');
    const parentId = '11111111-1111-1111-1111-111111111111';
    const childId = '22222222-2222-2222-2222-222222222222';
    const grandChildId = '33333333-3333-3333-3333-333333333333';
    const otherParentId = '44444444-4444-4444-4444-444444444444';
    const otherChildId = '55555555-5555-5555-5555-555555555555';
    const cycA = '66666666-6666-6666-6666-666666666666';
    const cycB = '77777777-7777-7777-7777-777777777777';

    // Parent in unilex, Slice 095, mentions childId twice in subagent responses
    t.write(join(agyDir, parentId, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: '<user_information>\nActive Workspaces:\n- /Users/dev/unilex\n</user_information>\n<user_request>\nYou are the UniLex head agent on Slice 095.\n</user_request>',
      },
      agyStep([10_000, 5_000, 100], { step_index: 1 }),
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        created_at: TS,
        content: `Created the following subagent:\n{\n  "conversationId":  "${childId}"\n}`,
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        created_at: TS,
        content: `You have 1 active subagent(s):\n[{"conversationId":"${childId}"}]`,
      },
    ]);

    // Child has NO cwd, NO project name, NO slice in its prompt, and spawns grandChildId
    t.write(join(agyDir, childId, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: TS,
        content: 'Review the staged diff and report bugs.',
      },
      agyStep([20_000, 30_000, 500], { step_index: 1 }),
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        created_at: TS,
        content: `Created the following subagent:\n{"conversationId": "${grandChildId}"}`,
      },
    ]);

    // Grandchild also has NO cwd, NO project name, NO slice
    t.write(join(agyDir, grandChildId, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: TS,
        content: 'Check edge cases as a reviewer.',
      },
      agyStep([5_000, 5_000, 200], { step_index: 1 }),
    ]);

    // Other project parent + child must NOT leak into unilex
    t.write(join(agyDir, otherParentId, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: '<user_information>\nActive Workspaces:\n- /Users/dev/aimline\n</user_information>\n<user_request>\nBuild feature.\n</user_request>',
      },
      agyStep([10_000, 0, 100], { step_index: 1 }),
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        created_at: TS,
        content: `{"conversationId": "${otherChildId}"}`,
      },
    ]);
    t.write(join(agyDir, otherChildId, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: TS,
        content: 'Inspect the diff.',
      },
      agyStep([9_000, 0, 100], { step_index: 1 }),
    ]);

    // Cycle between two unlinked sessions must terminate cleanly without hanging
    t.write(join(agyDir, cycA, '.system_generated', 'logs', 'transcript.jsonl'), [
      { step_index: 0, type: 'SYSTEM_MESSAGE', created_at: TS, content: 'Loop A.' },
      agyStep([1_000, 0, 10]),
      { step_index: 2, type: 'GENERIC', created_at: TS, content: `{"conversationId": "${cycB}"}` },
    ]);
    t.write(join(agyDir, cycB, '.system_generated', 'logs', 'transcript.jsonl'), [
      { step_index: 0, type: 'SYSTEM_MESSAGE', created_at: TS, content: 'Loop B.' },
      agyStep([1_000, 0, 10]),
      { step_index: 2, type: 'GENERIC', created_at: TS, content: `{"conversationId": "${cycA}"}` },
    ]);

    const first = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'unilex', cacheFile });
    assert.deepEqual(first.sessions.map((s) => s.id).sort(), [parentId, childId, grandChildId].sort());
    assert.equal(first.sessions.reduce((a, s) => a + s.total, 0), 15_100 + 50_500 + 10_200);
    for (const s of first.sessions) {
      assert.equal(s.cwd, '/Users/dev/unilex');
      assert.equal(s.slice, '095');
    }

    // Re-running with cache produces identical results without double-counting
    const second = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'unilex', cacheFile });
    assert.equal(second.parsed, 0);
    assert.deepEqual(second.sessions.map((s) => s.id).sort(), [parentId, childId, grandChildId].sort());
    assert.equal(second.sessions.reduce((a, s) => a + s.total, 0), 15_100 + 50_500 + 10_200);
  } finally {
    t.done();
  }
});

test('project matching: aimline does not match aimline-archive, and starter-kit cwd/tool paths reject unilex prose mentions', async () => {
  assert.equal(pathMatchesProject('/Users/dev/aimline/src', 'aimline'), true);
  assert.equal(pathMatchesProject('/Users/stephen/.t3/worktrees/aimline/t3-abc', 'aimline'), true);
  assert.equal(pathMatchesProject('/Users/dev/aimline-archive/src', 'aimline'), false);
  assert.equal(pathMatchesProject('/Users/dev/my-aimline/src', 'aimline'), false);

  const t = tree();
  try {
    // Claude, Codex, and Antigravity sessions in aimline vs aimline-archive
    t.write(join(t.claudeDir, '-Users-dev-aimline', 'a1.jsonl'), [
      user('Build Aimline.', { cwd: '/Users/dev/aimline' }),
      reply('m1', [100, 0, 0, 50]),
    ]);
    t.write(join(t.claudeDir, '-Users-dev-aimline-archive', 'a2.jsonl'), [
      user('Old archive work.', { cwd: '/Users/dev/aimline-archive' }),
      reply('m2', [200, 0, 0, 50]),
    ]);
    codexSession(t, '/Users/dev/aimline', 'rollout-2026-11-12T10-00-00-01a1b2c3-0000-7000-8000-000000000011.jsonl');
    codexSession(t, '/Users/dev/aimline-archive', 'rollout-2026-11-12T10-00-00-01a1b2c3-0000-7000-8000-000000000012.jsonl');

    const agyDir = join(t.root, 'agy');
    t.write(join(agyDir, 'aimline-real.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', created_at: TS, content: '<user_information>\nActive Workspaces:\n- /Users/dev/aimline\n</user_information>\n<user_request>Work.</user_request>' },
      agyStep([1_000, 0, 10]),
    ]);
    t.write(join(agyDir, 'aimline-archive.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', created_at: TS, content: '<user_information>\nActive Workspaces:\n- /Users/dev/aimline-archive\n</user_information>\n<user_request>Archive work.</user_request>' },
      agyStep([2_000, 0, 10]),
    ]);
    // Starter-kit session inferred from tool_calls whose prompt mentions ~/dev/unilex
    t.write(join(agyDir, 'starter-kit-mentions-unilex.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: 'Review starter-kit token-ledger changes that will later sync into ~/dev/unilex.',
      },
      agyStep([5_000, 10_000, 200], {
        step_index: 1,
        tool_calls: [
          { name: 'read_file', args: { Path: '"/Users/stephengarner/dev/starter-kit/scripts/token-ledger.mjs"' } },
          { name: 'run_command', args: { CommandLine: '"cd /Users/stephengarner/dev/starter-kit && node --test"' } },
        ],
      }),
    ]);

    const aimline = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'aimline' });
    assert.equal(aimline.sessions.length, 3);
    assert.ok(aimline.sessions.every((s) => pathMatchesProject(s.cwd, 'aimline')));

    const unilex = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'unilex' });
    assert.equal(unilex.sessions.length, 0);

    const starterKit = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'starter-kit' });
    assert.equal(starterKit.sessions.length, 1);
    assert.equal(starterKit.sessions[0].id, 'starter-kit-mentions-unilex');
  } finally {
    t.done();
  }
});

test('classifyRole: head-agent regex allows apostrophes and rejects negation and comma clauses', () => {
  assert.equal(classifyRole('You are the head agent.'), 'head');
  assert.equal(classifyRole('You are the UniLex head agent.'), 'head');
  assert.equal(classifyRole('You are the Starter Kit head agent.'), 'head');
  assert.equal(classifyRole("You are the Mary's Land head agent. Follow AGENTS.md."), 'head');
  assert.equal(classifyRole('You are the Mary\u2019s Land head agent. Follow AGENTS.md.'), 'head');
  assert.equal(classifyRole('You are the builder, not the head agent'), 'builder');
  assert.equal(classifyRole('You are the builder, not the head agent.'), 'builder');
  assert.equal(classifyRole('You are the **builder**, not the head agent.'), 'builder');
  assert.equal(classifyRole('You are the reviewer, not the head agent.'), 'reviewer');
  assert.equal(classifyRole('You are the not head agent.'), 'other');
});

test('Antigravity: tool-call cwd inference preserves nested project folders and handles stray paths', async () => {
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    t.write(join(agyDir, 'nested-multi.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', created_at: TS, content: 'Fix the flight telemetry parser.' },
      agyStep([3_000, 7_000, 100], {
        step_index: 1,
        tool_calls: [
          { name: 'read_file', args: { Path: '/Users/dev/hired_work/ElectraFly/src/app.ts' } },
          { name: 'read_file', args: { Path: '/Users/dev/hired_work/ElectraFly/package.json' } },
        ],
      }),
    ]);
    t.write(join(agyDir, 'nested-single.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', created_at: TS, content: 'Inspect one file.' },
      agyStep([2_000, 3_000, 50], {
        step_index: 1,
        tool_calls: [
          { name: 'read_file', args: { Path: '/Users/stephen/dev/hired_work/ElectraFly/src/app.ts' } },
        ],
      }),
    ]);
    t.write(join(agyDir, 'nested-with-stray.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', created_at: TS, content: 'Compare with another repo.' },
      agyStep([2_000, 4_000, 50], {
        step_index: 1,
        tool_calls: [
          { name: 'read_file', args: { Path: '/Users/stephen/dev/hired_work/ElectraFly/src/a.ts' } },
          { name: 'read_file', args: { Path: '/Users/stephen/dev/hired_work/ElectraFly/tests/b.ts' } },
          { name: 'read_file', args: { Path: '/Users/stephen/dev/other-repo/README.md' } },
        ],
      }),
    ]);

    const matched = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'ElectraFly' });
    assert.deepEqual(matched.sessions.map((s) => s.id).sort(), ['nested-multi', 'nested-single', 'nested-with-stray']);
    assert.equal(matched.sessions.find((s) => s.id === 'nested-multi').cwd, '/Users/dev/hired_work/ElectraFly');
    assert.equal(matched.sessions.find((s) => s.id === 'nested-single').cwd, '/Users/stephen/dev/hired_work/ElectraFly/src');
    assert.equal(matched.sessions.find((s) => s.id === 'nested-with-stray').cwd, '/Users/stephen/dev/hired_work/ElectraFly');

    const wrong = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'hired_work_other' });
    assert.equal(wrong.sessions.length, 0);

    const stray = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'other-repo' });
    assert.equal(stray.sessions.length, 0);
  } finally {
    t.done();
  }
});

test('Antigravity: tool-call cwd inference clusters below .t3/worktrees when reads span two projects', async () => {
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    t.write(join(agyDir, 'wt-cross-project.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', created_at: TS, content: 'Inspect the mobile file and compare with another worktree.' },
      agyStep([4_000, 8_000, 150], {
        step_index: 1,
        tool_calls: [
          { name: 'read_file', args: { Path: '/Users/stephen/.t3/worktrees/unilex/t3-abc/apps/mobile/a.ts' } },
          { name: 'read_file', args: { Path: '/Users/stephen/.t3/worktrees/unilex/t3-abc/apps/mobile/a.ts' } },
          { name: 'read_file', args: { Path: '/Users/stephen/.t3/worktrees/aimline/t3-xyz/src/b.ts' } },
        ],
      }),
    ]);

    const unilex = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'unilex' });
    assert.equal(unilex.sessions.length, 1);
    assert.equal(unilex.sessions[0].id, 'wt-cross-project');
    assert.equal(unilex.sessions[0].cwd, '/Users/stephen/.t3/worktrees/unilex/t3-abc');

    const aimline = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'aimline' });
    assert.equal(aimline.sessions.length, 0);
  } finally {
    t.done();
  }
});

test('registered git worktrees match Claude, Codex, and Antigravity sessions while unrelated folders stay excluded', async () => {
  const wt = '/private/tmp/unilex-kit-530';
  assert.equal(pathMatchesProject(wt, 'unilex'), false);
  assert.equal(pathMatchesProject(wt, 'unilex', [wt]), true);
  assert.equal(pathMatchesProject(`${wt}/apps/mobile`, 'unilex', new Set([`${wt}/`])), true);
  assert.equal(pathMatchesProject(`${wt}-other`, 'unilex', [wt]), false);
  assert.equal(pathMatchesProject('/Users/dev/aimline-archive', 'unilex', [wt]), false);
  assert.equal(pathMatchesProject('/Users/dev/aimline-archive', 'aimline', [wt]), false);

  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    const cacheFile = join(t.root, 'cache.json');

    // Claude session in registered worktree and one in unrelated archive
    t.write(join(t.claudeDir, '-private-tmp-unilex-kit-530', 'c-wt.jsonl'), [
      user('You are a **builder** for UniLex.', { cwd: wt }),
      reply('m1', [100, 0, 0, 50]),
    ]);
    t.write(join(t.claudeDir, '-Users-dev-aimline-archive', 'c-other.jsonl'), [
      user('Archive work.', { cwd: '/Users/dev/aimline-archive' }),
      reply('m2', [100, 0, 0, 50]),
    ]);

    // Codex sessions in registered worktree vs unrelated archive
    codexSession(t, wt, 'rollout-2026-11-12T10-00-00-01a1b2c3-0000-7000-8000-000000000021.jsonl');
    codexSession(t, '/Users/dev/aimline-archive', 'rollout-2026-11-12T10-00-00-01a1b2c3-0000-7000-8000-000000000022.jsonl');

    // Antigravity sessions: explicit cwd in worktree, tool-call inferred cwd in worktree, and unrelated archive
    t.write(join(agyDir, 'agy-wt-cwd.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: `<user_information>\nCommand Working Directory: ${wt}\n</user_information>\n<user_request>Work on task.</user_request>`,
      },
      agyStep([2_000, 3_000, 100]),
    ]);
    t.write(join(agyDir, 'agy-wt-tools.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: 'Inspect files in the worktree.',
      },
      agyStep([1_500, 2_500, 50], {
        step_index: 1,
        tool_calls: [{ name: 'read_file', args: { Path: `${wt}/scripts/merge-pr.mjs` } }],
      }),
    ]);
    t.write(join(agyDir, 'agy-archive.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: '<user_information>\nCommand Working Directory: /Users/dev/aimline-archive\n</user_information>\n<user_request>Archive work.</user_request>',
      },
      agyStep([4_000, 1_000, 50]),
    ]);

    // Without worktrees, none of these match project "unilex" (and Codex skip gets cached).
    const withoutWt = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'unilex', cacheFile });
    assert.equal(withoutWt.sessions.length, 0);

    // With registered worktree, Claude, Codex, and both Antigravity sessions match; aimline-archive stays excluded.
    const withWt = await loadSessions({ claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'unilex', worktrees: [wt], cacheFile });
    assert.equal(withWt.sessions.length, 4);
    assert.deepEqual(
      withWt.sessions.map((s) => s.tool).sort(),
      ['antigravity', 'antigravity', 'claude', 'codex'],
    );
    assert.ok(withWt.sessions.every((s) => s.cwd === wt));

    // Also verify real git worktree discovery via gitWorktreePaths (and non-git fallback).
    const nonGit = mkdtempSync(join(tmpdir(), 'ledger-nogit-'));
    try {
      assert.deepEqual(gitWorktreePaths(nonGit), []);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }

    const repoRoot = mkdtempSync(join(tmpdir(), 'ledger-wt-repo-'));
    const extraWt = join(tmpdir(), `unilex-kit-530-${process.pid}-${Date.now()}`);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git('init', '-q', '-b', 'main');
      writeFileSync(join(repoRoot, 'README.md'), 'hi\n');
      git('add', 'README.md');
      git('commit', '-q', '-m', 'init');
      git('worktree', 'add', '-q', '-b', 'wt-530', extraWt);
      const discovered = gitWorktreePaths(repoRoot);
      assert.equal(pathMatchesProject(extraWt, 'unilex', discovered), true);
      assert.equal(pathMatchesProject(join(extraWt, 'sub', 'file.js'), 'unilex', discovered), true);
      assert.equal(pathMatchesProject('/Users/dev/aimline-archive', 'unilex', discovered), false);
    } finally {
      rmSync(extraWt, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  } finally {
    t.done();
  }
});

test('cache: Antigravity inferred cwd is invalidated when registered worktrees change and matches no-cache', async () => {
  const wt = '/private/tmp/unilex-kit-530';
  const t = tree();
  try {
    const agyDir = join(t.root, 'agy');
    const cacheFile = join(t.root, 'cache.json');
    t.write(join(agyDir, 'agy-stale-guess.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: TS,
        content: 'Inspect the updated files and compare with starter-kit.',
      },
      agyStep([2_000, 3_000, 100], {
        step_index: 1,
        tool_calls: [
          { name: 'read_file', args: { Path: `${wt}/apps/mobile/a.ts` } },
          { name: 'read_file', args: { Path: `${wt}/apps/mobile/b.ts` } },
          { name: 'read_file', args: { Path: '/Users/dev/starter-kit/scripts/token-ledger.mjs' } },
        ],
      }),
    ]);

    const baseOpts = { claudeDir: t.claudeDir, codexDir: t.codexDir, antigravityDir: agyDir, project: 'unilex' };

    // Run 1: before wt is registered, the cache stores an inferred starter-kit cwd and drops the session for unilex.
    const run1 = await loadSessions({ ...baseOpts, worktrees: [], cacheFile });
    assert.equal(run1.sessions.length, 0);
    const cachedAfterRun1 = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.deepEqual(cachedAfterRun1.worktrees, []);
    assert.equal(Object.values(cachedAfterRun1.files)[0].summary.cwd, '/Users/dev/starter-kit/scripts');

    // Run 2: after wt is registered, the same cache file must invalidate and match a --no-cache run identically.
    const run2Cached = await loadSessions({ ...baseOpts, worktrees: [wt], cacheFile });
    const run2NoCache = await loadSessions({ ...baseOpts, worktrees: [wt], cacheFile: null });
    assert.equal(run2Cached.sessions.length, 1);
    assert.equal(run2NoCache.sessions.length, 1);
    assert.equal(run2Cached.reused, 0);
    assert.equal(run2Cached.sessions[0].cwd, wt);
    assert.deepEqual(run2Cached.sessions, run2NoCache.sessions);

    // Run 3: unchanged worktree set reuses the cache and still matches --no-cache.
    const run3Reused = await loadSessions({ ...baseOpts, worktrees: [`${wt}/`], cacheFile });
    assert.equal(run3Reused.parsed, 0);
    assert.equal(run3Reused.reused, 1);
    assert.deepEqual(run3Reused.sessions, run2NoCache.sessions);

    // Run 4: removing wt invalidates the cache again and matches --no-cache.
    const run4Removed = await loadSessions({ ...baseOpts, worktrees: [], cacheFile });
    const run4NoCache = await loadSessions({ ...baseOpts, worktrees: [], cacheFile: null });
    assert.equal(run4Removed.sessions.length, 0);
    assert.deepEqual(run4Removed.sessions, run4NoCache.sessions);

    // Run 5: stale version 4 cache carrying the new worktree list with an old wrong cwd guess
    // is rebuilt once on upgrade to version 5 and matches --no-cache.
    const staleV4 = JSON.parse(readFileSync(cacheFile, 'utf8'));
    staleV4.version = 4;
    staleV4.worktrees = [wt];
    writeFileSync(cacheFile, JSON.stringify(staleV4));
    const run5Upgrade = await loadSessions({ ...baseOpts, worktrees: [wt], cacheFile });
    assert.equal(run5Upgrade.parsed, 1);
    assert.equal(run5Upgrade.reused, 0);
    assert.equal(run5Upgrade.sessions.length, 1);
    assert.deepEqual(run5Upgrade.sessions, run2NoCache.sessions);
    assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).version, 5);
  } finally {
    t.done();
  }
});

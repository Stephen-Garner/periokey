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
  groupRun,
  loadSessions,
  mergedPrs,
  paperworkPathsFor,
  parkedCount,
  parseClaudeFile,
  parseCodexFile,
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
  assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).version, 2);
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

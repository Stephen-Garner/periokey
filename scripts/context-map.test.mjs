// Tests for context-map.mjs. Run: node --test scripts/context-map.test.mjs
// Every project, kit, and home folder here is a throwaway in the temp folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { includesOf, readFirstItems, rolesFrom, roleFiles, run, tokensOf } from './context-map.mjs';

const SECRET = 'TOPSECRET-WORDS-INSIDE-A-FILE';
const CORE = `# Core\n\n## Roles\n\n| Role | Guide |\n|---|---|\n| Head agent | \`docs/agents/head-agent.md\` |\n| Builder | \`docs/agents/builder.md\` |\n\n## Other\n\n| Role | Guide |\n| Ignored | \`docs/agents/ignored.md\` |\n`;
const BUILDER = `# Builder\n\n## Read first\n\n1. \`docs/project-rules.md\`\n2. \`docs/missing.md\`\n3. \`docs/plans/active/NNN-x.md\`\n\nYour tool loads \`docs/skipped.md\` by itself. ${SECRET}\n`;
const HEAD = `# Head\n\n## Read first\n\n1. \`docs/agents/core.md\`\n2. \`docs/project-rules.md\`\n`;
const RULES = `# Rules\n\n## Read first\n\n- \`docs/agents/builder.md\`\n`; // loops back: each file counts once

const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function sandbox(layout = 'project') {
  const dir = mkdtempSync(join(tmpdir(), 'context-map-'));
  const root = join(dir, 'proj');
  const home = join(dir, 'home');
  mkdirSync(root);
  mkdirSync(home);
  const agents = `# Agents\n@docs/extra.md\n${SECRET}\n`;
  if (layout === 'project') {
    put(root, 'AGENTS.md', agents);
    put(root, 'docs/agents/core.md', CORE);
    put(root, 'docs/agents/head-agent.md', HEAD);
    put(root, 'docs/agents/builder.md', BUILDER);
    put(root, 'docs/project-rules.md', RULES);
  } else {
    put(root, 'kit/lint.mjs', '// lint\n');
    put(root, 'template/AGENTS.md', agents);
    put(root, 'process/core.md', CORE);
    put(root, 'process/head-agent.md', HEAD);
    put(root, 'process/builder.md', BUILDER);
    put(root, 'template/docs/project-rules.md', RULES);
  }
  return { dir, root, home, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function go(argv, s) {
  let out = '';
  let err = '';
  const code = run(argv, { cwd: s.root, home: s.home, stdout: (t) => { out += t; }, stderr: (t) => { err += t; } });
  return { code, out, err };
}

test('tokens are the bytes divided by 4, rounded up', () => {
  assert.deepEqual([0, 1, 4, 5, 9726].map(tokensOf), [0, 1, 1, 2, 2432]);
});

test('a reading list is the code spans in list items of "Read first", and nothing else', () => {
  assert.deepEqual(readFirstItems(BUILDER).map((i) => i.span), ['docs/project-rules.md', 'docs/missing.md', 'docs/plans/active/NNN-x.md']);
  assert.deepEqual(readFirstItems('# G\n\n```\n## Read first\n1. `a.md`\n```\n'), []);
});

test('the roles come from the Roles table only, and a missing Guide column is a problem', () => {
  const { roles, problems } = rolesFrom(CORE, 'core.md', 'docs/agents/');
  assert.deepEqual(roles, { 'head-agent': 'docs/agents/head-agent.md', builder: 'docs/agents/builder.md' });
  assert.deepEqual(problems, []);
  assert.match(rolesFrom('## Roles\n\n| Role | Who |\n|---|---|\n| A | b |\n', 'core.md', 'x/').problems[0], /no "Guide" column/);
  assert.match(rolesFrom('# nothing\n', 'core.md', 'x/').problems[0], /no "Roles" table/);
});

test('@path lines are found: "~/" is the home folder, other paths start from the file that names them', () => {
  const text = '# x\n@~/.codex/AGENTS.md\n  @sub/a.md  \nnot @this.md\n@two words\n';
  assert.deepEqual(includesOf(text, '/proj/AGENTS.md', '/home/me'), ['/home/me/.codex/AGENTS.md', '/proj/sub/a.md']);
});

test('an @path line inside a fenced code block is an example, not an include', () => {
  const text = '# x\n@real.md\n\n```\n@example-only.md\n```\n\n~~~md\n@also-example.md\n~~~\n@after.md\n';
  assert.deepEqual(includesOf(text, '/proj/AGENTS.md', '/home/me'), ['/proj/real.md', '/proj/after.md']);
});

test('a fence indented under a list item also hides its @path lines; it closes only on a matching fence at the same or lesser indentation', () => {
  const text = '- step\n\n    ```\n    @in-list-example.md\n    ```\n\n  ~~~~\n  @tilde-example.md\n    ~~~\n  @still-inside.md\n  ~~~~\n@real.md\n\n```\n    ```\n@inside-outer.md\n```\n@after.md\n';
  assert.deepEqual(includesOf(text, '/proj/AGENTS.md', '/home/me'), ['/proj/real.md', '/proj/after.md']);
});

test('a closing fence may be indented up to three spaces more than the opening one; four or more does not close', () => {
  const closed = '1. step\n\n   ```\n   @example.md\n    ```\n@real.md\n';
  assert.deepEqual(includesOf(closed, '/proj/AGENTS.md', '/home/me'), ['/proj/real.md']);
  const open = '```\n@example.md\n    ```\n@still-example.md\n```\n@real.md\n';
  assert.deepEqual(includesOf(open, '/proj/AGENTS.md', '/home/me'), ['/proj/real.md']);
});

test('a role reads: the always file, its guide, each Read-first file once (a loop stops), a missing file is shown but not followed', () => {
  const files = { 'AGENTS.md': 'aa', 'g.md': '# G\n\n## Read first\n\n1. `a.md`\n2. `gone.md`\n', 'a.md': '## Read first\n\n1. `g.md`\n2. `b.md`\n', 'b.md': 'bbbb' };
  const got = roleFiles((p) => files[p] ?? null, 'g.md', ['AGENTS.md']);
  assert.deepEqual(got.map((f) => [f.path, f.bytes]), [['AGENTS.md', 2], ['g.md', bytes(files['g.md'])], ['a.md', bytes(files['a.md'])], ['gone.md', null], ['b.md', 4]]);
});

test('in a project: each role lists its files in order with sizes and a total; names only, never contents', () => {
  const s = sandbox();
  try {
    const r = go(['--json'], s);
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.mode, 'project');
    assert.deepEqual(Object.keys(j.roles), ['head-agent', 'builder']);
    const agents = bytes(`# Agents\n@docs/extra.md\n${SECRET}\n`);
    assert.deepEqual(j.roles.builder.files.map((f) => [f.path, f.bytes]), [
      ['AGENTS.md', agents], ['docs/agents/builder.md', bytes(BUILDER)], ['docs/project-rules.md', bytes(RULES)], ['docs/missing.md', null],
    ]);
    assert.equal(j.roles.builder.total, agents + bytes(BUILDER) + bytes(RULES));
    assert.equal(j.roles.builder.tokens, tokensOf(j.roles.builder.total));
    assert.deepEqual(j.roles['head-agent'].files.map((f) => f.path), ['AGENTS.md', 'docs/agents/head-agent.md', 'docs/agents/core.md', 'docs/project-rules.md', 'docs/agents/builder.md', 'docs/missing.md']);
    const text = go([], s);
    assert.equal(text.code, 0);
    assert.match(text.out, /docs\/missing\.md: not present/);
    assert.match(text.out, /Total: \d+ bytes, about \d+ tokens/);
    assert.doesNotMatch(text.out + r.out, new RegExp(SECRET));
  } finally { s.done(); }
});

test('--role shows one role; an unknown role or an unknown option exits 2', () => {
  const s = sandbox();
  try {
    const only = JSON.parse(go(['--role', 'builder', '--json'], s).out);
    assert.deepEqual(Object.keys(only.roles), ['builder']);
    assert.ok(only.tools['Claude Code'], 'the tool list stays');
    const bad = go(['--role', 'cook'], s);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /no role "cook"[\s\S]*head-agent, builder/);
    for (const argv of [['--what'], ['--role'], ['--role', '--json'], ['extra']]) assert.equal(go(argv, s).code, 2, argv.join(' '));
  } finally { s.done(); }
});

test('tools: global and project files, one level of @ includes under their parent, "not present" for the rest', () => {
  const s = sandbox();
  try {
    put(s.home, '.claude/CLAUDE.md', '@~/.codex/AGENTS.md\n');
    put(s.home, '.codex/AGENTS.md', '@deeper.md\nglobal rules\n');
    put(s.home, '.codex/deeper.md', 'must not be followed');
    put(s.root, 'docs/extra.md', '12345678');
    put(s.root, '.cursor/rules/style.mdc', 'abcd');
    const t = JSON.parse(go(['--json'], s).out).tools;
    const row = (x) => x.files.map((f) => [f.path, f.bytes, f.included]);
    assert.deepEqual(row(t['Claude Code']), [
      ['~/.claude/CLAUDE.md', 20, false], ['~/.codex/AGENTS.md', bytes('@deeper.md\nglobal rules\n'), true],
      ['AGENTS.md', bytes(`# Agents\n@docs/extra.md\n${SECRET}\n`), false], ['docs/extra.md', 8, true],
    ]);
    assert.deepEqual(row(t.Codex).map((r) => r[0]), ['~/.codex/AGENTS.md', '~/.codex/deeper.md', 'AGENTS.md', 'docs/extra.md']);
    assert.equal(t.Codex.files[1].bytes, 'must not be followed'.length, 'a file a global file names is listed; what it names is not');
    assert.deepEqual(row(t.Cursor), [['AGENTS.md', bytes(`# Agents\n@docs/extra.md\n${SECRET}\n`), false], ['docs/extra.md', 8, true], ['.cursor/rules/style.mdc', 4, false]]);
    assert.equal(t.Cursor.total, t.Cursor.files.reduce((n, f) => n + f.bytes, 0));
  } finally { s.done(); }
});

test('with no global files, no CLAUDE.md, and no cursor rules, each prints "not present" and the run still succeeds', () => {
  const s = sandbox();
  try {
    const r = go([], s);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /~\/\.claude\/CLAUDE\.md: not present/);
    assert.match(r.out, /~\/\.codex\/AGENTS\.md: not present/);
    assert.match(r.out, /\.cursor\/rules\/: not present/);
  } finally { s.done(); }
});

test('Claude Code takes the project CLAUDE.md when there is one, else AGENTS.md', () => {
  const s = sandbox();
  try {
    put(s.root, 'CLAUDE.md', 'hi');
    const t = JSON.parse(go(['--json'], s).out).tools['Claude Code'];
    assert.deepEqual(t.files.map((f) => f.path).filter((p) => !p.startsWith('~')), ['CLAUDE.md']);
  } finally { s.done(); }
});

test('in the kit: roles read process/, template/AGENTS.md stands for the project AGENTS.md, paths are mapped', () => {
  const s = sandbox('kit');
  try {
    const j = JSON.parse(go(['--json'], s).out);
    assert.equal(j.mode, 'kit');
    assert.deepEqual(j.roles.builder.files.map((f) => f.path), ['template/AGENTS.md', 'process/builder.md', 'template/docs/project-rules.md', 'template/docs/missing.md']);
    assert.deepEqual(j.roles['head-agent'].files.map((f) => f.path), ['template/AGENTS.md', 'process/head-agent.md', 'process/core.md', 'template/docs/project-rules.md', 'process/builder.md', 'template/docs/missing.md']);
    assert.ok(j.tools.Codex.files.some((f) => f.path === 'template/AGENTS.md'));
  } finally { s.done(); }
});

test('a folder with no core rules fails with a plain message; a Roles table with no Guide column fails', () => {
  const s = sandbox();
  try {
    const empty = mkdtempSync(join(tmpdir(), 'context-map-empty-'));
    const r = run([], { cwd: empty, home: s.home, stdout: () => {}, stderr: (t) => { s.err = t; } });
    assert.equal(r, 1);
    assert.match(s.err, /docs\/agents\/core\.md is not here/);
    rmSync(empty, { recursive: true, force: true });
    put(s.root, 'docs/agents/core.md', '## Roles\n\n| Role | Who |\n|---|---|\n| A | b |\n');
    const bad = go([], s);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /no "Guide" column/);
  } finally { s.done(); }
});

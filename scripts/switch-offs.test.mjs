// Tests for switch-offs.mjs. Run: node --test scripts/switch-offs.test.mjs
// Each CLI test makes a throwaway git repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPresets } from './presets.mjs';
import { mergeConfig } from './check-plans.mjs';
import { FIX_LINE, countByKind, findSwitchOffs, isProductFile, normalFolder, rulesByEnding, run, scanFiles, switchOffFiles } from './switch-offs.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS = loadPresets(KIT, { presets: ['typescript', 'python', 'rust'] });
const BY_ENDING = rulesByEnding(PRESETS);
const CONFIG = { productPaths: ['src/'], notYetClean: ['src/old/'], testPaths: ['.test.', 'tests/'] };

const SETTINGS = { presets: ['typescript', 'python'], productPaths: ['src'], notYetClean: ['src/old/'] };

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function repo(files, settings = SETTINGS) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-switch-offs-'));
  git(dir, 'init', '-q', '-b', 'main');
  cpSync(join(KIT, 'scripts/presets'), join(dir, 'scripts/presets'), { recursive: true });
  write(dir, { 'scripts/kit.config.json': JSON.stringify(settings), ...files });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  return dir;
}

function cli(argv, cwd) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { cwd, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { code, stdout, stderr };
}

test('product code is productPaths, minus notYetClean, minus tests, with a code ending', () => {
  assert.equal(isProductFile('src/a.ts', CONFIG, BY_ENDING), true);
  assert.equal(isProductFile('src/deep/b.py', CONFIG, BY_ENDING), true);
  assert.equal(isProductFile('src/App.vue', CONFIG, BY_ENDING), true, 'an extra code ending of the TypeScript preset');
  assert.equal(isProductFile('src/help.json', CONFIG, BY_ENDING), false, 'data, not code');
  assert.equal(isProductFile('src/readme.md', CONFIG, BY_ENDING), false);
  assert.equal(isProductFile('src/old/c.ts', CONFIG, BY_ENDING), false);
  assert.equal(isProductFile('src/old/c.ts', CONFIG, BY_ENDING, { includeUnclean: true }), true);
  assert.equal(isProductFile('src/a.test.ts', CONFIG, BY_ENDING), false);
  assert.equal(isProductFile('src/tests/helper.ts', CONFIG, BY_ENDING), false);
  assert.equal(isProductFile('lib/a.ts', CONFIG, BY_ENDING), false);
  assert.equal(isProductFile('srcx/a.ts', CONFIG, BY_ENDING), false);
});

test('normalFolder: "." and "./" are the whole repo, and empty text is refused by the settings checker', () => {
  assert.equal(normalFolder('.'), '');
  assert.equal(normalFolder('./'), '');
  assert.equal(normalFolder(''), '');
  assert.equal(normalFolder('./src'), 'src/');
  assert.equal(isProductFile('deep/a.ts', { ...CONFIG, productPaths: ['./'], notYetClean: [] }, BY_ENDING), true);
  assert.equal(isProductFile('deep/a.ts', { ...CONFIG, productPaths: ['./'], notYetClean: ['./'] }, BY_ENDING), false, 'notYetClean "./" is the whole repo too');
  assert.throws(() => mergeConfig({ notYetClean: [''] }), /"notYetClean" must list paths/);
  assert.throws(() => mergeConfig({ productPaths: [''] }), /"productPaths" must list paths/);
});

test('product paths are read the same with or without a leading ./ or a trailing /', () => {
  for (const productPaths of [['./src'], ['src'], ['./src/'], ['src/']]) {
    assert.equal(isProductFile('src/a.ts', { ...CONFIG, productPaths, notYetClean: ['./src/old'] }, BY_ENDING), true, productPaths[0]);
    assert.equal(isProductFile('src/old/b.ts', { ...CONFIG, productPaths, notYetClean: ['./src/old'] }, BY_ENDING), false, productPaths[0]);
  }
  assert.equal(isProductFile('a.ts', { ...CONFIG, productPaths: ['.'] }, BY_ENDING), true, '"." is the whole repo');
  assert.equal(isProductFile('deep/a.ts', { ...CONFIG, productPaths: ['./'] }, BY_ENDING), true, '"./" is the whole repo');
});

test('an extra code ending is read with its preset patterns; a binary file is skipped', () => {
  const texts = { 'src/App.vue': '<!-- prettier-ignore -->\n<script>\n// @ts-ignore\n# noqa\n</script>\n', 'src/logo.ts': 'PNG\0\0// eslint-disable\n' };
  const found = scanFiles(Object.keys(texts), (f) => texts[f], BY_ENDING);
  assert.deepEqual(found.map((f) => `${f.file}:${f.line} ${f.kind}`), ['src/App.vue:1 format', 'src/App.vue:3 types']);
});

test('CLI: data files under the product folders are not scanned, even when their text names a switch-off', () => {
  const dir = repo({ 'src/help.json': '{"tip": "never add eslint-disable or @ts-ignore"}\n', 'src/notes.md': 'Do not use # noqa.\n', 'src/a.ts': 'export const a = 1;\n' });
  try {
    const r = cli([], dir);
    assert.equal(r.code, 0, r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: in a notYetClean folder, format switch-offs are still refused and the other kinds are skipped', () => {
  const dir = repo({ 'src/old/View.vue': '<template>\n<!-- prettier-ignore -->\n<div   ></div>\n</template>\n<script>\n// @ts-ignore\n</script>\n' });
  try {
    const r = cli([], dir);
    assert.equal(r.code, 1);
    const lines = r.stdout.split('\n').filter((l) => /^\S+:\d+ /.test(l));
    assert.deepEqual(lines, ['src/old/View.vue:2 prettier-ignore switches off the formatter']);
    write(dir, { 'src/old/b.ts': '// prettier-ignore\nconst x   = 1;\n' });
    git(dir, 'add', 'src/old/b.ts');
    const staged = cli(['--staged'], dir);
    assert.equal(staged.code, 1);
    assert.match(staged.stdout, /^src\/old\/b\.ts:1 prettier-ignore/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each file is read with the patterns of the preset that covers its ending', () => {
  const texts = { 'src/a.ts': '#[allow(x)]\n// eslint-disable-line\n', 'src/b.rs': '// eslint-disable-line\n#[allow(dead_code)]\n' };
  const found = scanFiles(Object.keys(texts), (f) => texts[f], BY_ENDING);
  assert.deepEqual(found.map((f) => `${f.file}:${f.line} ${f.kind}`), ['src/a.ts:2 lint', 'src/b.rs:2 lint']);
});

test('the "any" patterns apply to every ending the other presets cover', () => {
  for (const ext of ['.ts', '.py', '.rs']) assert.ok(BY_ENDING.get(ext).some((r) => r.kind === 'secrets'), ext);
  const found = scanFiles(['src/a.py'], () => 'KEY = "x"  # gitleaks:allow\n', BY_ENDING);
  assert.deepEqual(found.map((f) => f.kind), ['secrets']);
});

test('switchOffFiles finds whole-file switch-offs by name, in any folder', () => {
  const found = switchOffFiles(['eslint-suppressions.json', 'app/oxlint-suppressions.json', 'deep/x/.gitleaksignore', '.gitleaks.toml', 'src/eslint-suppressions.json.bak', 'kit-lint/gitleaks.toml', 'a.ts'], PRESETS);
  assert.deepEqual(found.map((f) => f.file), ['eslint-suppressions.json', 'app/oxlint-suppressions.json', 'deep/x/.gitleaksignore', '.gitleaks.toml']);
});

test('findSwitchOffs gives the line number and every kind on a line', () => {
  const rules = BY_ENDING.get('.ts');
  const found = findSwitchOffs('const a = 1;\n// @ts-ignore\nfoo(); // eslint-disable-line\n', rules);
  assert.deepEqual(found.map((f) => [f.line, f.kind]), [[2, 'types'], [3, 'lint']]);
  assert.deepEqual(findSwitchOffs('const ok = true;\n', rules), []);
});

test('countByKind lists every known kind, with per-file numbers', () => {
  const counts = countByKind([{ file: 'a.ts', kind: 'lint' }, { file: 'a.ts', kind: 'lint' }, { file: 'b.ts', kind: 'types' }], PRESETS);
  assert.deepEqual(counts.lint, { total: 2, files: { 'a.ts': 2 } });
  assert.deepEqual(counts.types, { total: 1, files: { 'b.ts': 1 } });
  assert.deepEqual(counts.coverage, { total: 0, files: {} });
  assert.deepEqual(Object.keys(counts).sort(), ['coverage', 'format', 'lint', 'secrets', 'types']);
});

const FILES = {
  'src/a.ts': 'export const a = 1;\n// eslint-disable-next-line no-console\nconsole.log(a);\n',
  'src/a.test.ts': '// @ts-expect-error testing a bad call\nf(1);\n',
  'src/old/b.ts': '// @ts-ignore\nexport const b = 1;\n',
  'lib/c.ts': '// @ts-nocheck\n',
  'src/d.py': 'import os  # noqa: F401\n',
  'src/e.rs': '#[allow(dead_code)]\n',
  'src/clean.ts': 'export const c = 2;\n',
};

test('CLI: finds switch-offs in product code only, prints file:line what and the fix, exits 1', () => {
  const dir = repo(FILES);
  try {
    const r = cli([], dir);
    assert.equal(r.code, 1);
    const lines = r.stdout.split('\n').filter((l) => /^\S+:\d+ /.test(l));
    assert.deepEqual(lines, ['src/a.ts:2 eslint-disable comment switches off an ESLint rule', 'src/d.py:1 noqa comment switches off Ruff rules on this line']);
    assert.ok(r.stdout.includes(FIX_LINE));
    assert.match(FIX_LINE, /no exceptions list/);
    const json = JSON.parse(cli(['--json'], dir).stdout);
    assert.deepEqual(json.found.map((f) => f.file), ['src/a.ts', 'src/d.py']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: named files are checked alone, by the same product-code rule', () => {
  const dir = repo(FILES);
  try {
    const clean = cli(['src/clean.ts', 'src/old/b.ts', 'lib/c.ts'], dir);
    assert.equal(clean.code, 0, clean.stdout);
    assert.match(clean.stdout, /none in product code \(2 files looked at\)/, 'src/clean.ts, and src/old/b.ts for format switch-offs only; lib/ is not product code');
    assert.equal(cli(['src/a.ts'], dir).code, 1);
    assert.equal(cli(['a.ts'], join(dir, 'src')).code, 1, 'a path from a subfolder is read from there');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --staged finds a staged file whose name holds a line break', () => {
  const dir = repo({ 'src/clean.ts': 'export const c = 2;\n' });
  try {
    write(dir, { 'src/we\nird.ts': '// @ts-ignore\nexport const w = 1;\n' });
    git(dir, 'add', '-A');
    const r = cli(['--staged'], dir);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^"src\/we\\nird\.ts":1 @ts-ignore/m, 'the name is printed escaped, on one line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --staged reads the settings from the staged copy, then the last commit, not the working copy', () => {
  const dir = repo({ 'src/clean.ts': 'export const c = 2;\n' });
  try {
    write(dir, { 'src/new.ts': '// @ts-ignore\nexport const n = 1;\n' });
    git(dir, 'add', 'src/new.ts');
    write(dir, { 'scripts/kit.config.json': JSON.stringify({ ...SETTINGS, productPaths: [] }) });
    assert.equal(cli(['--staged'], dir).code, 1, 'an unstaged edit to the settings does not count');
    git(dir, 'add', 'scripts/kit.config.json');
    assert.equal(cli(['--staged'], dir).code, 0, 'the staged settings count');
    write(dir, { 'lib/x.ts': '// @ts-ignore\n', 'scripts/kit.config.json': JSON.stringify({ ...SETTINGS, productPaths: ['lib/'] }) });
    git(dir, 'add', 'lib/x.ts', 'scripts/kit.config.json');
    write(dir, { 'scripts/kit.config.json': JSON.stringify(SETTINGS) });
    const r = cli(['--staged'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^lib\/x\.ts:1 @ts-ignore/m);
    assert.doesNotMatch(r.stdout, /src\/new\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --staged reads the staged copy, not the working copy', () => {
  const dir = repo({ 'src/clean.ts': 'export const c = 2;\n' });
  try {
    write(dir, { 'src/new.ts': 'export const n = 1;\n' });
    git(dir, 'add', 'src/new.ts');
    write(dir, { 'src/new.ts': '// @ts-ignore\nexport const n = 1;\n' });
    assert.equal(cli(['--staged'], dir).code, 0, 'the switch-off is only in the working copy');
    assert.equal(cli([], dir).code, 1, 'without --staged the working copy is read');
    git(dir, 'add', 'src/new.ts');
    write(dir, { 'src/new.ts': 'export const n = 1;\n' });
    const r = cli(['--staged'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^src\/new\.ts:1 @ts-ignore/m);
    git(dir, 'rm', '-q', '--cached', 'src/clean.ts');
    assert.equal(cli(['--staged'], dir).code, 1, 'a staged delete is skipped, not an error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --count counts every covered tracked file, tests and other folders included', () => {
  const dir = repo(FILES);
  try {
    const r = cli(['--count', '--json'], dir);
    assert.equal(r.code, 0);
    const counts = JSON.parse(r.stdout);
    assert.equal(counts.lint.total, 2, 'a.ts and d.py; the .rs file has no preset on');
    assert.equal(counts.types.total, 3);
    assert.deepEqual(counts.types.files, { 'src/a.test.ts': 1, 'src/old/b.ts': 1, 'lib/c.ts': 1 });
    assert.match(cli(['--count'], dir).stdout, /^types 3$/m);
    write(dir, { 'scripts/kit.manifest.json': JSON.stringify({ files: { 'lib/c.ts': 'abc' } }) });
    assert.equal(JSON.parse(cli(['--count', '--json'], dir).stdout).types.total, 2, 'a file the kit manages is left out');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a tracked whole-file switch-off fails in every mode but --count, with a line saying why', () => {
  const dir = repo({ 'src/clean.ts': 'export const c = 2;\n' });
  try {
    assert.equal(cli([], dir).code, 0);
    write(dir, { 'apps/web/eslint-suppressions.json': '{}\n' });
    git(dir, 'add', 'apps/web/eslint-suppressions.json');
    const staged = cli(['--staged'], dir);
    assert.equal(staged.code, 1);
    assert.match(staged.stdout, /^apps\/web\/eslint-suppressions\.json eslint-suppressions\.json switches ESLint rules off for whole files; delete it and fix the code$/m);
    assert.equal(cli([], dir).code, 1);
    assert.equal(cli(['src/clean.ts'], dir).code, 1);
    assert.equal(cli(['--count'], dir).code, 0);
    git(dir, 'rm', '-q', '--cached', 'apps/web/eslint-suppressions.json');
    assert.equal(cli([], dir).code, 0, 'an untracked copy is not counted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: empty productPaths still fails on a tracked .gitleaksignore', () => {
  const dir = repo({ '.gitleaksignore': 'abc\n' }, { presets: ['typescript'] });
  try {
    const r = cli([], dir);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^\.gitleaksignore \.gitleaksignore hides found secrets/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: empty productPaths says so and passes; wrong usage exits 2', () => {
  const dir = repo(FILES, { presets: ['typescript'] });
  try {
    const r = cli([], dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /"productPaths" .* is empty/);
    assert.equal(cli(['--frob'], dir).code, 2);
    assert.equal(cli(['--count', '--staged'], dir).code, 2);
    assert.equal(cli(['--staged', 'src/a.ts'], dir).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a bad preset name in the settings fails loud', () => {
  const dir = repo(FILES, { presets: ['go'], productPaths: ['src/'] });
  try {
    const r = cli([], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /scripts\/presets\/go\.json: no such preset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

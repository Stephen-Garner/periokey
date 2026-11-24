// Tests for test-changes.mjs. Run: node --test scripts/test-changes.test.mjs
// The sorting rules are pure functions fed plain text, with the kit's real language presets.
// The branch reader runs against real git repos made in temp folders.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeConfig } from './check-plans.mjs';
import { loadPresets } from './presets.mjs';
import {
  CHECK_SETTINGS_FILES, KINDS, REASON_DIR, REASON_MAX, changeId, collect, describe, isCheckSettings, isSnapshot, linesOf, netChange, onlyAdded,
  parseNameStatus, patternsFor, reasonFile, reasonFor, reasonKey, reasonLine, reasonProblem, sameButLayout, sortRatchets, sortSettings, sortTestChange,
} from './test-changes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'test-changes.mjs');
const PRESETS = loadPresets(join(HERE, '..'), { presets: ['typescript', 'python', 'rust'] });
const sort = (file, baseText, tipText) => sortTestChange({ file, baseText, tipText, patterns: patternsFor(file, PRESETS) });
const text = (...lines) => `${lines.join('\n')}\n`;

// ---------- Lines ----------

test('linesOf, onlyAdded, netChange: blank lines and line ends never count; a moved or indented line is neither removed nor added', () => {
  assert.deepEqual(linesOf('a\r\n\n  b  \n\n'), ['a', '  b']);
  assert.deepEqual(linesOf(null), []);
  assert.equal(onlyAdded(['a', 'b'], ['x', 'a', 'y', 'b', 'z']), true);
  assert.equal(onlyAdded(['a', 'b'], ['b', 'a']), false, 'the same lines in another order are not only added');
  assert.equal(onlyAdded(['a', 'b'], ['a']), false);
  assert.equal(onlyAdded(['a'], ['  a']), false, 'an indented line is a changed line');
  assert.deepEqual(netChange(['a', 'b', 'b'], ['b', '  a', 'c']), { removed: ['b'], added: ['c'], addedAt: [2] });
});

// ---------- Jest ----------

const JEST = text(
  "import { save } from './save';",
  "describe('save', () => {",
  "  it('saves a word', () => {",
  "    expect(save('hola')).toBe(1);",
  '  });',
  "  it('refuses an empty word', () => {",
  "    expect(() => save('')).toThrow();",
  '  });',
  '});',
);

test('Jest: a new test in an old file is free', () => {
  const tip = JEST.replace('});\n});', "});\n  it('trims spaces', () => {\n    expect(save(' a ')).toBe(1);\n  });\n});");
  assert.notEqual(tip, JEST);
  assert.deepEqual(sort('src/save.test.ts', JEST, tip), { kind: 'added', what: 'only whole new tests were added' });
});

test('Jest: a test that is gone is test-removed, and so is one whose name changed', () => {
  const removed = JEST.replace("  it('refuses an empty word', () => {\n    expect(() => save('')).toThrow();\n  });\n", '');
  const out = sort('src/save.test.ts', JEST, removed);
  assert.equal(out.kind, 'test-removed');
  assert.match(out.what, /1 test name on the base branch is gone: "refuses an empty word"/);
  assert.match(out.what, /1 line that holds an assertion was removed or changed/, 'the what line names every kind that fits');
  assert.equal(sort('src/save.test.ts', JEST, JEST.replace('refuses an empty word', 'takes any word')).kind, 'test-removed');
});

test('Jest: it.skip, describe.only, and it.todo are test-skipped, and the test name is not counted as gone', () => {
  for (const [from, to] of [["it('saves a word'", "it.skip('saves a word'"], ["describe('save'", "describe.only('save'"], ["it('refuses an empty word'", "it.todo('refuses an empty word'"]]) {
    const out = sort('src/save.test.ts', JEST, JEST.replace(from, to));
    assert.equal(out.kind, 'test-skipped', to);
    assert.match(out.what, /^1 line with a skip or focus marker was added/);
  }
});

// The typescript preset's test name pattern does not read a name after xit( or after a call such as
// test.skipIf(cond)(, so these also count the name as gone. Either kind is a weakening; the skip is named.
test('Jest and Vitest: xit, fit, test.skipIf(...) and test.runIf(...) are a weakening that names the skip marker', () => {
  for (const [file, base, from, to] of [
    ['src/save.test.ts', JEST, "it('saves a word'", "xit('saves a word'"],
    ['src/save.test.ts', JEST, "it('saves a word'", "fit('saves a word'"],
    ['src/price.spec.ts', VITEST, "test('adds tax'", "test.skipIf(isCI)('adds tax'"],
    ['src/price.spec.ts', VITEST, "test('adds tax'", "test.runIf(isMac)('adds tax'"],
  ]) {
    const out = sort(file, base, base.replace(from, to));
    assert.ok(['test-removed', 'test-skipped'].includes(out.kind), `${to}: ${out.kind}`);
    assert.match(out.what, /1 line with a skip or focus marker was added/, to);
  }
});

test('Jest: a changed or removed expect line is expectation-changed', () => {
  const changed = sort('src/save.test.ts', JEST, JEST.replace('toBe(1)', 'toBe(2)'));
  assert.equal(changed.kind, 'expectation-changed');
  assert.match(changed.what, /1 line that holds an assertion was removed or changed: expect\(save\('hola'\)\)\.toBe\(1\);/);
  assert.equal(sort('src/save.test.ts', JEST, JEST.replace("    expect(save('hola')).toBe(1);\n", '')).kind, 'expectation-changed');
});

test('Jest: a changed line that is no test name, skip marker, or assertion is unclear; so is a block that was only indented', () => {
  assert.equal(sort('src/save.test.ts', JEST, JEST.replace("from './save'", "from './save-v2'")).kind, 'unclear');
  const wrapped = text("describe('all', () => {", ...linesOf(JEST).map((l) => `  ${l}`), '});');
  assert.equal(sort('src/save.test.ts', JEST, wrapped).kind, 'unclear', 'wrapping old tests could hide them in a block that never runs');
});

test('one kind per file: the first that fits in the fixed order, with every finding in the what line', () => {
  const tip = JEST.replace("  it('refuses an empty word', () => {\n    expect(() => save('')).toThrow();\n  });\n", '').replace("it('saves a word'", "it.skip('saves a word'");
  const out = sort('src/save.test.ts', JEST, tip);
  assert.equal(out.kind, 'test-removed');
  assert.match(out.what, /is gone.*; 1 line with a skip or focus marker was added.*; 1 line that holds an assertion/);
  assert.deepEqual(KINDS.slice(0, 3), ['test-deleted', 'test-removed', 'test-skipped']);
});

// ---------- Vitest ----------

const VITEST = text(
  "import { describe, expect, test } from 'vitest';",
  "describe('price', () => {",
  "  test('adds tax', () => {",
  '    expect(price(100)).toEqual(108);',
  '  });',
  '  test(`rounds ${n} down`, () => {',
  '    expect(price(0.4)).toMatchInlineSnapshot(`0`);',
  '  });',
  '});',
);

test('Vitest: fails, todo, and a focused test are test-skipped; a new test.each block is free', () => {
  for (const marker of ['test.fails', 'test.todo', 'test.only']) {
    assert.equal(sort('src/price.spec.ts', VITEST, VITEST.replace("test('adds tax'", `${marker}('adds tax'`)).kind, 'test-skipped', marker);
  }
  const more = VITEST.replace(/\}\);\n$/, "  test.each([1, 2])('takes %i', (n) => {\n    expect(price(n)).toBeGreaterThan(0);\n  });\n});\n");
  assert.equal(sort('src/price.spec.ts', VITEST, more).kind, 'added');
});

test('Vitest: a changed expected value and a removed template-string test name are both seen', () => {
  assert.equal(sort('src/price.spec.ts', VITEST, VITEST.replace('toEqual(108)', 'toEqual(110)')).kind, 'expectation-changed');
  const out = sort('src/price.spec.ts', VITEST, VITEST.replace('  test(`rounds ${n} down`, () => {\n    expect(price(0.4)).toMatchInlineSnapshot(`0`);\n  });\n', ''));
  assert.equal(out.kind, 'test-removed');
  assert.match(out.what, /"rounds \$\{n\} down"/);
});

// ---------- Node's test runner ----------

const NODE = text(
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('adds', () => {",
  '  assert.equal(add(1, 2), 3);',
  '});',
  "test('subtracts', async (t) => {",
  '  assert.deepEqual(sub(3, 1), 2);',
  '});',
);

test('Node test runner: a skip or todo option, t.skip(), and test.skip are test-skipped', () => {
  for (const tip of [
    NODE.replace("test('adds', () => {", "test('adds', { skip: true }, () => {"),
    NODE.replace("test('adds', () => {", "test('adds', { todo: 'later' }, () => {"),
    NODE.replace('  assert.deepEqual(sub(3, 1), 2);', '  t.skip();\n  assert.deepEqual(sub(3, 1), 2);'),
    NODE.replace("test('subtracts'", "test.skip('subtracts'"),
  ]) {
    assert.notEqual(tip, NODE);
    assert.equal(sort('scripts/math.test.mjs', NODE, tip).kind, 'test-skipped', tip);
  }
});

test('Node test runner: a changed assert line is expectation-changed, a removed test is test-removed, a new one is free', () => {
  assert.equal(sort('scripts/math.test.mjs', NODE, NODE.replace('add(1, 2), 3', 'add(1, 2), 4')).kind, 'expectation-changed');
  assert.equal(sort('scripts/math.test.mjs', NODE, NODE.replace("test('adds', () => {\n  assert.equal(add(1, 2), 3);\n});\n", '')).kind, 'test-removed');
  assert.equal(sort('scripts/math.test.mjs', NODE, `${NODE}test('multiplies', () => {\n  assert.equal(mul(2, 2), 4);\n});\n`).kind, 'added');
});

// ---------- pytest ----------

const PYTEST = text(
  'import pytest',
  'from shop import total',
  '',
  'def test_total_adds_items():',
  '    assert total([1, 2]) == 3',
  '',
  'class TestEmpty:',
  '    def test_empty_basket_raises(self):',
  '        with pytest.raises(ValueError):',
  '            total([])',
);

test('pytest: a skip mark added above an old test is test-skipped even though only lines were added', () => {
  for (const mark of ['@pytest.mark.skip(reason="slow")', '@pytest.mark.xfail', '@pytest.mark.skipif(True, reason="x")']) {
    const out = sort('tests/test_shop.py', PYTEST, PYTEST.replace('def test_total_adds_items', `${mark}\ndef test_total_adds_items`));
    assert.equal(out.kind, 'test-skipped', mark);
  }
  const inBody = PYTEST.replace('    assert total([1, 2]) == 3', '    pytest.skip("later")\n    assert total([1, 2]) == 3');
  assert.equal(sort('tests/test_shop.py', PYTEST, inBody).kind, 'test-skipped');
});

test('pytest: a changed assert, a removed raises check, a removed test function or class, and a new test', () => {
  assert.equal(sort('tests/test_shop.py', PYTEST, PYTEST.replace('== 3', '== 4')).kind, 'expectation-changed');
  assert.equal(sort('tests/test_shop.py', PYTEST, PYTEST.replace('        with pytest.raises(ValueError):\n            total([])', '        total([])')).kind, 'expectation-changed');
  const noFn = sort('tests/test_shop.py', PYTEST, PYTEST.replace('def test_total_adds_items():\n    assert total([1, 2]) == 3\n', ''));
  assert.equal(noFn.kind, 'test-removed');
  assert.match(noFn.what, /"test_total_adds_items"/);
  assert.equal(sort('tests/test_shop.py', PYTEST, PYTEST.replace('class TestEmpty:', 'class Empty:')).kind, 'test-removed', 'pytest no longer collects a class without the Test prefix');
  assert.equal(sort('tests/test_shop.py', PYTEST, `${PYTEST}\ndef test_total_of_one():\n    assert total([5]) == 5\n`).kind, 'added');
});

// ---------- Rust, snapshots, and files with no preset ----------

test('Rust: an ignore attribute is test-skipped and a changed assert_eq! is expectation-changed', () => {
  const rust = text('#[test]', 'fn adds() {', '    assert_eq!(add(1, 2), 3);', '}');
  assert.equal(sort('tests/math.rs', rust, rust.replace('#[test]', '#[test]\n#[ignore]')).kind, 'test-skipped');
  assert.equal(sort('tests/math.rs', rust, rust.replace('3);', '4);')).kind, 'expectation-changed');
});

const SNAP = text('// Jest Snapshot v1, https://goo.gl/fbAQLP', '', 'exports[`card renders a word 1`] = `', '<div>', '  hola', '</div>', '`;');

test('snapshot file: a changed or removed line is expectation-changed; a new snapshot at the end is free', () => {
  const file = 'src/__snapshots__/card.test.tsx.snap';
  assert.equal(isSnapshot(file), true);
  assert.equal(isSnapshot('tests/__snapshots__/test_shop.ambr'), true);
  assert.equal(isSnapshot('src/card.test.tsx'), false);
  const out = sort(file, SNAP, SNAP.replace('  hola', '  adios'));
  assert.deepEqual(out, { kind: 'expectation-changed', what: 'a saved snapshot was changed or removed' });
  assert.equal(sort(file, SNAP, text('// Jest Snapshot v1, https://goo.gl/fbAQLP')).kind, 'expectation-changed');
  assert.equal(sort(file, SNAP, `${SNAP}\nexports[\`card renders two words 1\`] = \`\n<div>\n  dos\n</div>\n\`;\n`).kind, 'added');
});

test('a test file no preset covers: a changed line is unclear and an added line is test-edited, because no line can be read as a new test', () => {
  const fixture = text('{', '  "word": "hola",', '  "count": 1', '}');
  assert.equal(sort('tests/fixtures/word.json', fixture, fixture.replace('"count": 1', '"count": 2')).kind, 'unclear');
  assert.equal(sort('tests/notes.txt', 'one\n', 'one\ntwo\n').kind, 'test-edited');
  assert.equal(sort('tests/notes.txt', 'one\n', 'one\n\n').kind, 'added', 'a blank line is no change');
  assert.deepEqual(patternsFor('tests/fixtures/word.json', PRESETS), { testNames: [], skippedTests: [], assertions: [], flaky: [] });
});

// ---------- Ratchets, settings, and check settings files ----------

const ratchets = (counts, counters = [{ name: 'flag groups', run: 'pnpm exec eslint --rule kit/flag-groups' }]) => JSON.stringify({ counts, counters }, null, 2);

test('sortRatchets: a count that went up or was removed is ratchet-raised; a lower or new count is free', () => {
  const base = ratchets({ 'useEffect uses': 3, 'switch-offs lint': 2 });
  assert.equal(sortRatchets(base, ratchets({ 'useEffect uses': 2, 'switch-offs lint': 2, 'switch-offs types': 9 })), null, 'lower, the same, and a new count are all free');
  assert.deepEqual(sortRatchets(base, ratchets({ 'useEffect uses': 4, 'switch-offs lint': 2 })), { kind: 'ratchet-raised', what: 'the count "useEffect uses" went up from 3 to 4' });
  assert.match(sortRatchets(base, ratchets({ 'useEffect uses': 3 })).what, /the count "switch-offs lint" was removed \(it was 2\)/);
  assert.match(sortRatchets(base, null).what, /"useEffect uses" was removed.*"switch-offs lint" was removed/, 'a deleted file drops every count');
  assert.equal(sortRatchets(base, '{ not json').kind, 'unclear', 'a file that cannot be read is a weakening too');
  assert.equal(sortRatchets('{ not json', base), null, 'a base that saves nothing readable has nothing to raise');
});

test('sortSettings: a removed check, a folder added to notYetClean, or a switch turned off is check-removed', () => {
  const base = { checks: [{ name: 'lint', run: 'pnpm lint' }, { name: 'test', run: 'pnpm test', slot: true }], notYetClean: ['apps/old/'], features: { events: true, mergeLock: false } };
  const s = (over) => JSON.stringify({ ...base, ...over });
  assert.equal(sortSettings(s({}), s({ checks: [...base.checks, { name: 'types', run: 'tsc' }], notYetClean: [], features: { events: true, mergeLock: true }, numberedPaths: ['docs/plans/'] })), null, 'a new check, a shorter notYetClean, and a switch turned on are free');
  assert.deepEqual(sortSettings(s({}), s({ checks: [base.checks[0]] })), { kind: 'check-removed', what: 'the check "test" was removed' });
  assert.match(sortSettings(s({}), s({ checks: [], notYetClean: ['apps/old/', 'apps/web/'] })).what, /^the check "lint" was removed; the check "test" was removed; "apps\/web\/" was added/, 'every finding is named');
  assert.match(sortSettings(s({}), s({ notYetClean: ['apps/old/', 'apps/web/'] })).what, /"apps\/web\/" was added to "notYetClean"/);
  assert.match(sortSettings(s({}), s({ features: { mergeLock: false } })).what, /the switch events went from enforce to off: it no longer runs/);
  assert.equal(sortSettings(s({}), null).kind, 'check-removed', 'a deleted settings file drops every check');
  assert.equal(sortSettings(s({}), '{ not json').kind, 'unclear');
});

test('isCheckSettings: the default lint, type, and test settings names anywhere in the tree, plus the project\'s own entries', () => {
  for (const file of ['.oxlintrc.json', 'apps/web/eslint.config.mjs', '.eslintrc', '.eslintrc.cjs', 'tsconfig.json', 'apps/web/tsconfig.build.json', 'jest.config.ts', 'vitest.config.mts', 'playwright.config.ts', 'pytest.ini', 'ruff.toml', 'biome.jsonc', 'mypy.ini', 'pyrefly.toml', '.sqlfluff']) {
    assert.equal(isCheckSettings(file, CHECK_SETTINGS_FILES), true, file);
  }
  for (const file of ['package.json', 'pyproject.toml', 'Cargo.toml', 'src/tsconfig-notes.md', 'src/jest.configuration.ts', 'docs/eslint.md']) {
    assert.equal(isCheckSettings(file, CHECK_SETTINGS_FILES), false, file);
  }
  const more = [...CHECK_SETTINGS_FILES, 'pyproject.toml', 'apps/web/package.json', 'config/lint/'];
  assert.equal(isCheckSettings('services/api/pyproject.toml', more), true, 'a bare name matches anywhere');
  assert.equal(isCheckSettings('apps/web/package.json', more), true, 'a path matches that one file');
  assert.equal(isCheckSettings('package.json', more), false);
  assert.equal(isCheckSettings('config/lint/rules.json', more), true, 'a path ending in "/" is a whole folder');
});

// ---------- Reasons and ids ----------

test('reasons: the printed line to add parses back, and a blank, short, long, or placeholder reason will not do', () => {
  const file = 'apps/web/save.test.ts';
  assert.equal(reasonLine(file), '- apps/web/save.test.ts: <why this change is right, in one plain sentence>');
  assert.equal(reasonFor(file, [reasonLine(file)]), '<why this change is right, in one plain sentence>');
  assert.match(reasonProblem(reasonFor(file, [reasonLine(file)])), /placeholder/);
  const good = 'The API now answers 201 for a new word, as task 3 says.';
  assert.equal(reasonFor(file, ['# Weakenings', `- ${file}: ${good}`]), good);
  assert.equal(reasonFor(file, [`  - \`${file}\`:   ${good}  `]), good, 'backticks and spaces are fine');
  assert.equal(reasonFor(file, [`- ${file}: first try at a reason`, `- ${file}: ${good}`]), good, 'the last line wins');
  assert.equal(reasonFor(file, ['- apps/web/save.test.tsx: another file entirely', `- ${file}:`]), null);
  assert.equal(reasonProblem(good), '');
  assert.match(reasonProblem(null), /no reason line yet/);
  assert.match(reasonProblem('needed'), /6 characters; write one full sentence/);
  assert.match(reasonProblem('x'.repeat(REASON_MAX + 1)), /shorten it to 300 or fewer/);
  assert.equal(reasonFile('build/084-welcome'), 'docs/weakenings/build-084-welcome.md');
  assert.equal(reasonFile(''), 'docs/weakenings/this-branch.md');
});

test('parseNameStatus: every status with its paths; a copy counts as a new file', () => {
  assert.deepEqual(parseNameStatus('M\0a.ts\0D\0b c.ts\0R087\0old.ts\0new.ts\0C100\0src.ts\0copy.ts\0A\0d.ts\0'), [
    { status: 'M', file: 'a.ts' }, { status: 'D', file: 'b c.ts' }, { status: 'R', file: 'old.ts', to: 'new.ts' }, { status: 'A', file: 'copy.ts' }, { status: 'A', file: 'd.ts' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

// ---------- A real branch ----------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TEST_PATHS = ['.test.', '.spec.', '__tests__/', '__snapshots__/', 'tests/', 'test/'];
const isTest = (file) => TEST_PATHS.some((p) => (p.endsWith('/') ? `/${file}`.includes(`/${p}`) : file.slice(file.lastIndexOf('/') + 1).includes(p)));
const write = (cwd, file, body) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), body);
};
const commit = (cwd, message) => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
};

// A repo whose main holds tests in four languages, a snapshot, a ratchets file, settings, and a lint settings file.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'test-changes-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
  write(dir, 'src/save.test.ts', JEST);
  write(dir, 'src/price.spec.ts', VITEST);
  write(dir, 'scripts/math.test.mjs', NODE);
  write(dir, 'tests/test_shop.py', PYTEST);
  write(dir, 'src/__snapshots__/card.test.tsx.snap', SNAP);
  write(dir, 'src/old.test.ts', "it('is old', () => {\n  expect(old()).toBe(true);\n});\n");
  write(dir, 'src/moved.test.ts', "it('will move', () => {\n  expect(moved()).toBe(true);\n});\n");
  write(dir, 'src/app.ts', 'export const one = 1;\n');
  write(dir, 'kit.ratchets.json', ratchets({ 'useEffect uses': 3 }));
  write(dir, 'scripts/kit.config.json', JSON.stringify({ checks: [{ name: 'lint', run: 'pnpm lint' }, { name: 'test', run: 'pnpm test' }] }, null, 2));
  write(dir, 'eslint.config.mjs', 'export default [];\n');
  commit(dir, 'Start');
  git(dir, 'switch', '-q', '-c', 'build/084-welcome');
  const run = (args, input) => {
    const r = spawnSync('git', args, { cwd: dir, input, encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const read = (over = {}) => collect({ baseRef: 'main', git: run, isTest, presets: PRESETS, branch: 'build/084-welcome', ...over });
  return { dir, run, read, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('collect: every kind is found on one branch, new tests and added lines are free, and each item waits for its reason', () => {
  const r = repo();
  try {
    write(r.dir, 'src/new.test.ts', "it('is new', () => {\n  expect(fresh()).toBe(1);\n});\n"); // a new test file: free
    write(r.dir, 'scripts/math.test.mjs', `${NODE}test('multiplies', () => {\n  assert.equal(mul(2, 2), 4);\n});\n`); // only added lines: free
    write(r.dir, 'src/app.ts', 'export const one = 2;\n'); // product code: not a guard
    git(r.dir, 'rm', '-q', 'src/old.test.ts'); // test-deleted
    git(r.dir, 'mv', 'src/moved.test.ts', 'src/moved.ts.bak'); // renamed out of the test names: test-deleted
    write(r.dir, 'tests/test_shop.py', PYTEST.replace('def test_total_adds_items():\n    assert total([1, 2]) == 3\n', '')); // test-removed
    write(r.dir, 'src/save.test.ts', JEST.replace("it('saves a word'", "it.skip('saves a word'")); // test-skipped
    write(r.dir, 'src/price.spec.ts', VITEST.replace('toEqual(108)', 'toEqual(110)')); // expectation-changed
    write(r.dir, 'src/__snapshots__/card.test.tsx.snap', SNAP.replace('  hola', '  adios')); // expectation-changed
    write(r.dir, 'kit.ratchets.json', ratchets({ 'useEffect uses': 4 })); // ratchet-raised
    write(r.dir, 'scripts/kit.config.json', JSON.stringify({ checks: [{ name: 'lint', run: 'pnpm lint' }] }, null, 2)); // check-removed
    write(r.dir, 'eslint.config.mjs', 'export default [{ rules: {} }];\n'); // check-settings-changed
    write(r.dir, '.eslintignore', 'src/legacy/\n'); // one more settings file of a family main already has counts too
    commit(r.dir, 'Change many guards');
    const out = r.read();
    assert.equal(out.fail, undefined);
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [
      ['.eslintignore', 'check-settings-changed'],
      ['eslint.config.mjs', 'check-settings-changed'],
      ['kit.ratchets.json', 'ratchet-raised'],
      ['scripts/kit.config.json', 'check-removed'],
      ['src/__snapshots__/card.test.tsx.snap', 'expectation-changed'],
      ['src/moved.test.ts', 'test-deleted'],
      ['src/old.test.ts', 'test-deleted'],
      ['src/price.spec.ts', 'expectation-changed'],
      ['src/save.test.ts', 'test-skipped'],
      ['tests/test_shop.py', 'test-removed'],
    ]);
    assert.equal(out.testsAdded, 1, 'src/new.test.ts');
    assert.equal(out.reasonFile, 'docs/weakenings/build-084-welcome.md');
    assert.ok(out.items.every((i) => i.reason === null && i.id === null && /no reason line yet/.test(i.problem)));
    assert.match(out.items.find((i) => i.file === 'src/moved.test.ts').what, /renamed to src\/moved\.ts\.bak, which "testPaths" does not count as a test file/);
    assert.match(describe(out), /Add one line for each to docs\/weakenings\/build-084-welcome\.md \(make the file if it is not there\):\n {2}- \.eslintignore: <why/);
  } finally { r.cleanup(); }
});

test('collect: a reason line gives the item its reason and id; a new reason or a further edit gives a new id', () => {
  const r = repo();
  try {
    write(r.dir, 'src/price.spec.ts', VITEST.replace('toEqual(108)', 'toEqual(110)'));
    commit(r.dir, 'Change the tax');
    write(r.dir, `${REASON_DIR}build-084-welcome.md`, '# Weakenings\n\n- src/price.spec.ts: too short\n');
    commit(r.dir, 'A reason that will not do');
    assert.match(r.read().items[0].problem, /9 characters; write one full sentence/);
    assert.equal(r.read().items[0].id, null);
    write(r.dir, `${REASON_DIR}build-084-welcome.md`, '# Weakenings\n\n- src/price.spec.ts: Tax went from 8 to 10 percent in the spec.\n');
    commit(r.dir, 'A real reason');
    const [first] = r.read().items;
    assert.deepEqual([first.kind, first.reason, first.problem], ['expectation-changed', 'Tax went from 8 to 10 percent in the spec.', '']);
    assert.match(first.id, /^[0-9a-f]{12}$/);
    assert.equal(describe(r.read()).includes('Add one line'), false);
    write(r.dir, `${REASON_DIR}build-084-welcome.md`, '# Weakenings\n\n- src/price.spec.ts: Tax went from 8 to 10 percent, see the spec.\n');
    commit(r.dir, 'Reword the reason');
    const reworded = r.read().items[0].id;
    assert.notEqual(reworded, first.id, 'a ruling on the old reason must not carry over');
    write(r.dir, 'src/price.spec.ts', VITEST.replace('toEqual(108)', 'toEqual(110)').replace('toMatchInlineSnapshot(`0`)', 'toMatchInlineSnapshot(`1`)'));
    commit(r.dir, 'Weaken it further');
    assert.notEqual(r.read().items[0].id, reworded, 'a ruling on the old lines must not carry over');
  } finally { r.cleanup(); }
});

test('collect: a reason line that is already on the base branch does not count again', () => {
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, `${REASON_DIR}lead-settings.md`, '- eslint.config.mjs: Turned the old import rule off, Oxlint runs it now.\n');
    commit(r.dir, 'An old merged weakening');
    git(r.dir, 'switch', '-q', '-c', 'lead/settings');
    write(r.dir, 'eslint.config.mjs', 'export default [{ rules: {} }];\n');
    commit(r.dir, 'Change lint settings again');
    assert.equal(r.read().items[0].reason, null, 'the old line is not this change\'s reason');
    write(r.dir, `${REASON_DIR}lead-settings.md`, '- eslint.config.mjs: Turned the old import rule off, Oxlint runs it now.\n- src/other.test.ts: A new line about some other file entirely.\n');
    commit(r.dir, 'Touch the reason file without a new line for this change');
    assert.equal(r.read().items[0].reason, null, 'still not: the file changed, but the line for this file was already on the base branch');
    write(r.dir, `${REASON_DIR}lead-settings.md`, '- eslint.config.mjs: Turned the old import rule off, Oxlint runs it now.\n- eslint.config.mjs: The rules block is empty on purpose until slice 90.\n');
    commit(r.dir, 'This change\'s reason');
    assert.equal(r.read().items[0].reason, 'The rules block is empty on purpose until slice 90.');
  } finally { r.cleanup(); }
});

test('collect: the id stays the same when the base branch changes other files and is merged in; when it changes that very file, a new ruling is needed', () => {
  const r = repo();
  const long = (first, last) => text("describe('words', () => {", ...['a', 'b', 'c', 'd'].flatMap((w, n) => [`  it('saves ${n === 3 ? last : w}', () => {`, `    expect(save('${w}')).toBe(${n === 0 ? first : n + 1});`, '  });']), '});');
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'src/save.test.ts', long(1, 'd'));
    commit(r.dir, 'A longer test file');
    git(r.dir, 'switch', '-q', '-c', 'build/090-map');
    write(r.dir, 'src/save.test.ts', long(2, 'd'));
    write(r.dir, 'kit.ratchets.json', ratchets({ 'useEffect uses': 4 }));
    write(r.dir, `${REASON_DIR}build-090-map.md`, '- src/save.test.ts: The first word now has id 2, as the plan says.\n- kit.ratchets.json: The map screen needs one more effect to load tiles.\n');
    commit(r.dir, 'Weaken two guards, with reasons');
    const before = r.read().items.map((i) => [i.file, i.kind, i.id]);
    assert.deepEqual(before.map((b) => b.slice(0, 2)), [['kit.ratchets.json', 'ratchet-raised'], ['src/save.test.ts', 'expectation-changed']]);
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'src/app.ts', 'export const one = 11;\n');
    write(r.dir, 'src/price.spec.ts', `${VITEST}// main edits another test file\n`);
    commit(r.dir, 'Main changes other files');
    git(r.dir, 'switch', '-q', 'build/090-map');
    git(r.dir, 'merge', '-q', '--no-edit', 'main');
    assert.deepEqual(r.read().items.map((i) => [i.file, i.kind, i.id]), before, 'a ruling made before the merge still counts');
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'src/save.test.ts', long(1, 'the last word'));
    commit(r.dir, 'Main changes the ruled test file, far from the ruled lines');
    git(r.dir, 'switch', '-q', 'build/090-map');
    git(r.dir, 'merge', '-q', '--no-edit', 'main');
    const after = r.read().items.map((i) => [i.file, i.kind, i.id]);
    assert.deepEqual(after[0], before[0], 'the ratchets file did not change on main');
    assert.equal(after[1][1], 'expectation-changed');
    assert.notEqual(after[1][2], before[1][2], 'the test file is not what the reviewer saw any more');
  } finally { r.cleanup(); }
});

test('collect: a renamed test file is unclear even when no line changed; a bad base fails loud', () => {
  const r = repo();
  try {
    mkdirSync(join(r.dir, 'src', 'disabled'));
    git(r.dir, 'mv', 'src/moved.test.ts', 'src/disabled/moved.test.ts');
    commit(r.dir, 'Move a test');
    const [item] = r.read().items;
    assert.deepEqual([item.file, item.to, item.kind], ['src/moved.test.ts', 'src/disabled/moved.test.ts', 'unclear']);
    assert.match(item.what, /renamed to src\/disabled\/moved\.test\.ts; whether the test runner still finds it cannot be seen/);
    assert.match(r.read({ baseRef: 'nope' }).fail, /cannot find where HEAD left nope/);
  } finally { r.cleanup(); }
});

// ---------- Review round 2: ways around the sorter that a reviewer found ----------

test('#1 collect: a test or the settings file moved into the reasons folder is still a weakening', () => {
  const r = repo();
  try {
    mkdirSync(join(r.dir, 'docs', 'weakenings'), { recursive: true });
    git(r.dir, 'mv', 'src/old.test.ts', 'docs/weakenings/old.md');
    git(r.dir, 'mv', 'scripts/kit.config.json', 'docs/weakenings/settings.md');
    commit(r.dir, 'Hide two guards in the reasons folder');
    const out = r.read();
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['scripts/kit.config.json', 'check-removed'], ['src/old.test.ts', 'test-deleted']]);
    assert.match(out.items[1].what, /renamed to docs\/weakenings\/old\.md, which "testPaths" does not count as a test file/);
  } finally { r.cleanup(); }
});

test('#2 collect: moving a line inside a ruled test gives a new id, so the old ruling is not about it', () => {
  const r = repo();
  const body = (...lines) => text("test('adds', () => {", '  const actual = add(1, 1);', ...lines, '});');
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'scripts/add.test.mjs', body('  assert.equal(actual, 1 + 1);'));
    commit(r.dir, 'A test on main');
    git(r.dir, 'switch', '-q', '-c', 'build/091-add');
    write(r.dir, 'scripts/add.test.mjs', body('  assert.equal(actual, 2);', '  if (actual !== 2) return;'));
    write(r.dir, `${REASON_DIR}build-091-add.md`, '- scripts/add.test.mjs: The sum is written out as 2, and the guard line is dead code.\n');
    commit(r.dir, 'The change a reviewer rules on');
    const ruled = r.read().items[0];
    assert.match(ruled.id, /^[0-9a-f]{12}$/);
    write(r.dir, 'scripts/add.test.mjs', body('  if (actual !== 2) return;', '  assert.equal(actual, 2);'));
    commit(r.dir, 'Move the return above the assertion');
    const moved = r.read().items[0];
    assert.equal(moved.reason, ruled.reason, 'the same reason line');
    assert.notEqual(moved.id, ruled.id, 'the same lines in another order are another change');
  } finally { r.cleanup(); }
});

test('#3 an early return, a dummy test with a stray line, a hook, or a closer added to an old test file is test-edited: it needs a reason and a ruling', () => {
  const early = JEST.replace("    expect(save('hola')).toBe(1);", "    if (save('hola') !== 1) return;\n    expect(save('hola')).toBe(1);");
  const out = sort('src/save.test.ts', JEST, early);
  assert.equal(out.kind, 'test-edited');
  assert.match(out.what, /a line was added that is not part of a whole new test: if \(save\('hola'\) !== 1\) return;/);
  const dummy = JEST.replace("  it('refuses an empty word'", "  it('x', () => {});\n  return;\n  it('refuses an empty word'");
  const hook = JEST.replace("  it('saves a word'", "  beforeEach((ctx) => ctx.skip());\n  it('saves a word'");
  const closer = JEST.replace("    expect(save('hola')).toBe(1);", "  });\n  it.each([])('never runs', () => {\n    expect(save('hola')).toBe(1);");
  const open = JEST.replace("  it('refuses an empty word'", "  it('swallows the next test', () => {\n  it('refuses an empty word'");
  for (const tip of [dummy, hook, closer, open]) {
    assert.notEqual(tip, JEST);
    assert.equal(sort('src/save.test.ts', JEST, tip).kind, 'test-edited', tip);
  }
});

test('#3 a line that only looks like a new test (a statement after it, an operator, a name in a comment) is test-edited: it needs a reason and a ruling', () => {
  const before = "    expect(save('hola')).toBe(1);";
  for (const line of [
    "    it('x'); if (save('hola') !== 1) return;",
    "    return; // it('fake', () => {})",
    "    it('x', () => {}) || done();",
    "    it('x', () => {}), done();",
    "    it('x', () => {\n    }); return;",
    "    it('x', () => {}).skip, done();",
    "    it('x', () => {})});",
  ]) {
    const out = sort('src/save.test.ts', JEST, JEST.replace(before, `${line}\n${before}`));
    assert.equal(out.kind, 'test-edited', line);
  }
  // Still whole new tests: a curried table, a one-line test, a Python one-liner, a class, and a Rust fn with a return type.
  assert.equal(sort('src/save.test.ts', JEST, `${JEST}it.each([1, 2])('takes %i', (n) => {\n  expect(n).toBeGreaterThan(0);\n});\nit('is short', () => expect(1).toBe(1));\n`).kind, 'added');
  assert.equal(sort('tests/test_shop.py', PYTEST, `${PYTEST}\ndef test_one_line(): assert total([1]) == 1\n\nclass TestMore:\n    def test_two(self):\n        assert total([1, 1]) == 2\n`).kind, 'added');
  const rust = text('#[test]', 'fn adds() {', '    assert_eq!(add(1, 2), 3);', '}');
  assert.equal(sort('tests/math.rs', rust, `${rust}\n#[test]\nfn subtracts() -> bool {\n    sub(3, 1) == 2\n}\n`).kind, 'added');
});

test('#3 pytest: a decorator alone above an old test, or a new test wedged into an old test\'s body, is test-edited: it needs a reason and a ruling', () => {
  const decorated = PYTEST.replace('def test_total_adds_items', '@pytest.mark.usefixtures("fake_total")\ndef test_total_adds_items');
  const wedged = PYTEST.replace('    assert total([1, 2]) == 3', 'def test_new():\n    return\n    assert total([1, 2]) == 3');
  for (const tip of [decorated, wedged]) {
    assert.notEqual(tip, PYTEST);
    assert.equal(sort('tests/test_shop.py', PYTEST, tip).kind, 'test-edited', tip);
  }
});

test('#3 a comment or a string opened by one added line and closed by another cannot hide an old test: unclear', () => {
  const commented = JEST.replace("  it('refuses an empty word'", "  /*\n  it('refuses an empty word'").replace('  });\n});', '  });\n  */\n});');
  assert.equal(sort('src/save.test.ts', JEST, commented).kind, 'unclear');
  const quoted = PYTEST.replace('def test_total_adds_items', '"""\ndef test_total_adds_items').replace('class TestEmpty:', '"""\nclass TestEmpty:');
  assert.equal(sort('tests/test_shop.py', PYTEST, quoted).kind, 'unclear');
  const wanted = text('const WANT = `', 'hello', '`;', "test('greets', () => {", '  assert.equal(greet(), WANT);', '});');
  assert.equal(sort('scripts/greet.test.mjs', wanted, wanted.replace('hello\n', 'hello\nworld\n')).kind, 'unclear', 'a line added inside an old string changes an expected value');
});

test('#3 whole new tests stay free: between old tests, with a comment, in a new describe with its own hook, with a decorator, and in Rust', () => {
  const between = JEST.replace("  it('refuses an empty word'", "  // a new case\n  it('trims spaces', () => {\n    expect(save(' a ')).toBe(1);\n  });\n  it('refuses an empty word'");
  assert.notEqual(between, JEST);
  assert.equal(sort('src/save.test.ts', JEST, between).kind, 'added');
  const group = `${JEST}describe('more', () => {\n  beforeEach(() => reset());\n  it('saves twice', () => {\n    expect(save('a')).toBe(2);\n  });\n});\n`;
  assert.equal(sort('src/save.test.ts', JEST, group).kind, 'added');
  const table = `${PYTEST}\n@pytest.mark.parametrize(\n    "items,want",\n    [([1], 1), ([2, 2], 4)],\n)\ndef test_total_table(items, want):\n    assert total(items) == want\n`;
  assert.equal(sort('tests/test_shop.py', PYTEST, table).kind, 'added');
  const middle = PYTEST.replace('class TestEmpty:', 'def test_total_of_none():\n    assert total([]) == 0\n\nclass TestEmpty:');
  assert.equal(sort('tests/test_shop.py', PYTEST, middle).kind, 'added');
  const rust = text('#[test]', 'fn adds() {', '    assert_eq!(add(1, 2), 3);', '}');
  assert.equal(sort('tests/math.rs', rust, `${rust}\n#[test]\nfn subtracts() {\n    assert_eq!(sub(3, 1), 2);\n}\n`).kind, 'added');
});

test('#3 a skip written with square brackets is seen as a skip', () => {
  const inBody = NODE.replace('  assert.deepEqual(sub(3, 1), 2);', "  return t['skip']('later');\n  assert.deepEqual(sub(3, 1), 2);");
  const out = sort('scripts/math.test.mjs', NODE, inBody);
  assert.equal(out.kind, 'test-skipped');
  assert.match(out.what, /1 line with a skip or focus marker was added: return t\['skip'\]\('later'\);/);
  // On any object, not only the names the presets list, and in a language whose preset has no such pattern.
  assert.equal(sort('scripts/math.test.mjs', NODE, NODE.replace("test('subtracts', async (t) => {", "test('subtracts', async (ctx) => {\n  ctx['skip']();")).kind, 'test-skipped');
  assert.equal(sort('tests/test_shop.py', PYTEST, PYTEST.replace('        with pytest.raises(ValueError):', '        self["skip"]()\n        with pytest.raises(ValueError):')).kind, 'test-skipped');
  const focused = sort('scripts/math.test.mjs', NODE, NODE.replace("test('adds', () => {", 'test["only"](\'adds\', () => {'));
  assert.match(focused.what, /1 line with a skip or focus marker was added/);
});

test('#11 a test whose name, or a comment, only mentions test.skip() is not a skipped test', () => {
  const named = `${NODE}test('prints the text test.skip() and it.only(', () => {\n  // t.skip() used to be here\n  assert.equal(show(), 'test.skip()');\n});\n`;
  assert.deepEqual(sort('scripts/math.test.mjs', NODE, named), { kind: 'added', what: 'only whole new tests were added' });
  const py = `${PYTEST}\ndef test_help_text():\n    # pytest.skip() is named in the help\n    assert "pytest.skip(" in help_text()\n`;
  assert.equal(sort('tests/test_shop.py', PYTEST, py).kind, 'added');
});

const AMBR = text('# serializer version: 1', '# name: test_home', '  <div>', '    hola', '  </div>', '# ---');

test('#6 snapshot files are known by their ending, by the __snapshots__ folder alone, and by the project\'s own list', () => {
  assert.equal(isSnapshot('fixtures/ui.ambr'), true);
  assert.equal(isSnapshot('src/__snapshots__/card.json'), true, 'the folder alone is enough');
  assert.equal(isSnapshot('src/card.snapshot.ts'), false);
  assert.equal(isSnapshot('goldens/home.txt'), false);
  assert.equal(isSnapshot('app/goldens/home.txt', ['goldens/']), true, 'an entry ending in "/" is a folder anywhere');
  assert.equal(isSnapshot('out/home.golden', ['.golden']), true, 'an entry starting with "." is a file ending');
  assert.deepEqual(sort('src/__snapshots__/card.json', '{\n  "word": "hola"\n}\n', '{\n  "word": "adios"\n}\n'), { kind: 'expectation-changed', what: 'a saved snapshot was changed or removed' });
});

test('#6 a line added inside a saved snapshot is expectation-changed; only a whole new snapshot is free', () => {
  const jest = 'src/__snapshots__/card.test.tsx.snap';
  const inside = { kind: 'expectation-changed', what: 'lines were added inside a saved snapshot, or not as a whole new one' };
  assert.deepEqual(sort(jest, SNAP, SNAP.replace('  hola', '  hola\n  adios')), inside);
  assert.deepEqual(sort(jest, SNAP, SNAP.replace('<div>\n', '<div>\nexports[`sneaky 1`] = `x`;\n')), inside, 'a whole entry wedged into an old one still changes the old one');
  assert.equal(sort(jest, SNAP, `${SNAP}\nexports[\`count 1\`] = \`2\`;\n`).kind, 'added', 'a one-line snapshot');
  assert.deepEqual(sort('tests/__snapshots__/test_home.ambr', AMBR, AMBR.replace('    hola', '    hola\n    adios')), inside);
  assert.deepEqual(sort('tests/__snapshots__/test_home.ambr', AMBR, `${AMBR}  a line that belongs to no snapshot\n`), inside);
  assert.deepEqual(sort(jest, SNAP, SNAP.replace('exports[`card', 'something new\nexports[`card')), inside, 'a line added between the snapshots');
  assert.equal(sort('tests/__snapshots__/test_home.ambr', AMBR, `${AMBR}# name: test_about\n  <p>about</p>\n# ---\n`).kind, 'added');
  assert.equal(sort('tests/__snapshots__/test_home.ambr', AMBR, AMBR.replace('# name: test_home', '# name: test_about\n  <p>about</p>\n# ---\n# name: test_home')).kind, 'added', 'a new one before the old one');
  assert.deepEqual(sort('src/__snapshots__/card.json', '{\n  "word": "hola"\n}\n', '{\n  "word": "hola",\n  "count": 2\n}\n').kind, 'expectation-changed', 'a snapshot in a shape the sorter does not know is never free to grow');
});

test('#6 collect: a snapshot outside "testPaths", and one the project lists itself, are guards too', () => {
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'fixtures/ui.ambr', AMBR);
    write(r.dir, 'goldens/home.txt', 'hola\n');
    commit(r.dir, 'Snapshots outside the test folders');
    git(r.dir, 'switch', '-q', '-c', 'build/092-ui');
    write(r.dir, 'fixtures/ui.ambr', AMBR.replace('    hola', '    adios'));
    write(r.dir, 'goldens/home.txt', 'adios\n');
    commit(r.dir, 'Edit both');
    assert.deepEqual(r.read().items.map((i) => [i.file, i.kind]), [['fixtures/ui.ambr', 'expectation-changed']]);
    assert.deepEqual(r.read({ snapshotPaths: ['goldens/'] }).items.map((i) => [i.file, i.kind]), [['fixtures/ui.ambr', 'expectation-changed'], ['goldens/home.txt', 'expectation-changed']]);
  } finally { r.cleanup(); }
});

test('#7 collect: a reason copied from another, already merged reason file does not count', () => {
  const r = repo();
  const old = '- eslint.config.mjs: Turned the old import rule off, Oxlint runs it now.\n';
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, `${REASON_DIR}lead-first.md`, old);
    commit(r.dir, 'An old merged weakening');
    git(r.dir, 'switch', '-q', '-c', 'lead/again');
    write(r.dir, 'eslint.config.mjs', 'export default [{ rules: {} }];\n');
    write(r.dir, `${REASON_DIR}lead-again.md`, old);
    commit(r.dir, 'Weaken it again, with the old line in a new file');
    const [item] = r.read().items;
    assert.equal(item.reason, null);
    assert.match(item.problem, /the only reason line for this file is already on the base branch, from an earlier change/);
    write(r.dir, `${REASON_DIR}lead-again.md`, `${old}- eslint.config.mjs: The rules block stays empty until slice 90 fills it.\n`);
    commit(r.dir, 'This change\'s own reason');
    assert.equal(r.read().items[0].reason, 'The rules block stays empty until slice 90 fills it.');
  } finally { r.cleanup(); }
});

test('#4 sortSettings: a changed command, a path taken out of what is protected, a path added to what is skipped, or changed models is check-removed', () => {
  const base = {
    checks: [{ name: 'lint', run: 'pnpm lint' }], testPaths: ['.test.', 'specimens/'], checkSettingsPaths: ['pyproject.toml'], snapshotPaths: ['goldens/'],
    presets: ['typescript', 'python'], productPaths: ['apps/'], paperworkPaths: ['docs/'], models: { builder: 'claude/a', headAgent: ['claude/a'], reviewer: 'codex/b' },
  };
  const s = (over) => JSON.stringify({ ...base, ...over });
  assert.equal(sortSettings(s({}), s({ testPaths: [...base.testPaths, 'e2e/'], paperworkPaths: [], presets: [...base.presets, 'rust'], checks: [{ name: 'lint', run: 'pnpm lint', fast: true }] })), null, 'more protection is free');
  for (const [over, want] of [
    [{ checks: [{ name: 'lint', run: 'true' }] }, /^the command of the check "lint" changed$/],
    [{ testPaths: ['.test.'] }, /^"specimens\/" was taken out of "testPaths"$/],
    [{ testPaths: [] }, /"\.test\." was taken out of "testPaths"; "specimens\/" was taken out of "testPaths"/],
    [{ checkSettingsPaths: [] }, /^"pyproject\.toml" was taken out of "checkSettingsPaths"$/],
    [{ snapshotPaths: [] }, /^"goldens\/" was taken out of "snapshotPaths"$/],
    [{ presets: ['typescript'] }, /^"python" was taken out of "presets"$/],
    [{ productPaths: [] }, /^"apps\/" was taken out of "productPaths"$/],
    [{ paperworkPaths: ['docs/', 'src/'] }, /^"src\/" was added to "paperworkPaths"$/],
    [{ sameModelReviewSlices: [84] }, /^"84" was added to "sameModelReviewSlices"$/],
    [{ leadPrefixes: ['build/'] }, /^"build\/" was added to "leadPrefixes"$/],
    [{ models: { ...base.models, builder: 'codex/b' } }, /^"models" changed: who counts as the builder, a head agent, or the reviewer$/],
  ]) {
    const out = sortSettings(s({}), s(over));
    assert.equal(out?.kind, 'check-removed', JSON.stringify(over));
    assert.match(out.what, want);
  }
  // With a reader that fills in the defaults, a list written out for the first time is compared with the defaults it replaces.
  const read = (json) => ({ testPaths: ['.test.', 'tests/'], ...JSON.parse(json) });
  assert.match(sortSettings('{}', '{"testPaths": [".test."]}', read).what, /^"tests\/" was taken out of "testPaths"$/);
});

// ---------- The command line ----------

test('command line: exit 1 with the lines to add while a reason is missing, 0 once it is there, 2 on wrong usage', () => {
  const r = repo();
  try {
    cpSync(join(HERE, 'presets'), join(r.dir, 'scripts', 'presets'), { recursive: true });
    git(r.dir, 'switch', '-q', 'main');
    writeFileSync(join(r.dir, 'scripts', 'kit.config.json'), JSON.stringify({ presets: ['typescript'] }));
    commit(r.dir, 'Turn the typescript preset on');
    git(r.dir, 'remote', 'add', 'origin', r.dir);
    git(r.dir, 'fetch', '-q', 'origin');
    git(r.dir, 'switch', '-q', '-c', 'build/085-tax');
    write(r.dir, 'src/price.spec.ts', VITEST.replace('toEqual(108)', 'toEqual(110)'));
    commit(r.dir, 'Change the tax');
    const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: r.dir, encoding: 'utf8' });
    const open = cli();
    assert.equal(open.status, 1, open.stderr);
    assert.match(open.stdout, /1 change on this branch weakens a guard/);
    assert.match(open.stdout, /expectation-changed {2}src\/price\.spec\.ts\n {4}spotted: 1 line that holds an assertion/);
    assert.match(open.stdout, /Add one line for each to docs\/weakenings\/build-085-tax\.md[^\n]*\n {2}- src\/price\.spec\.ts: <why/);
    write(r.dir, `${REASON_DIR}build-085-tax.md`, '- src/price.spec.ts: Tax went from 8 to 10 percent in the spec.\n');
    commit(r.dir, 'Reason');
    const done = cli('--json');
    assert.equal(done.status, 0, done.stderr);
    assert.equal(JSON.parse(done.stdout).items[0].reason, 'Tax went from 8 to 10 percent in the spec.');
    const bad = cli('--nope');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Usage:/);
  } finally { r.cleanup(); }
});

// ---------- Review round 3: found by a trial install ----------

test('round 3: each of these needs a reason: a product folder or a preset dropped, a counter deleted, a lefthook file, a GitHub workflow', () => {
  const r = repo();
  const counter = { name: 'flag groups', run: 'pnpm exec eslint --rule kit/flag-groups', needs: ['kit-lint/eslint.base.mjs'] };
  const saved = (counts, counters) => JSON.stringify({ counts, counters }, null, 2);
  const kinds = (make) => {
    git(r.dir, 'switch', '-q', '-C', 'lead/try', 'main');
    make();
    commit(r.dir, 'Try one change');
    return r.read().items.map((i) => [i.file, i.kind, i.what]);
  };
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'scripts/kit.config.json', JSON.stringify({ checks: [{ name: 'lint', run: 'pnpm lint' }], productPaths: ['apps/', 'packages/'], presets: ['typescript', 'python'] }, null, 2));
    write(r.dir, 'kit.ratchets.json', saved({ 'flag groups': 2, 'useEffect uses': 3 }, [counter]));
    write(r.dir, 'lefthook.yml', 'pre-commit:\n  commands:\n    lint:\n      run: pnpm lint\n');
    write(r.dir, '.github/workflows/ci.yml', 'name: ci\non: push\n');
    commit(r.dir, 'Guards on main');
    const settings = (over) => () => write(r.dir, 'scripts/kit.config.json', JSON.stringify({ checks: [{ name: 'lint', run: 'pnpm lint' }], productPaths: ['apps/', 'packages/'], presets: ['typescript', 'python'], ...over }, null, 2));
    assert.deepEqual(kinds(settings({ productPaths: ['apps/'] })), [['scripts/kit.config.json', 'check-removed', '"packages/" was taken out of "productPaths"']]);
    assert.deepEqual(kinds(settings({ presets: ['typescript'] })), [['scripts/kit.config.json', 'check-removed', '"python" was taken out of "presets"']]);
    assert.deepEqual(kinds(() => write(r.dir, 'kit.ratchets.json', saved({ 'flag groups': 2, 'useEffect uses': 3 }, []))), [['kit.ratchets.json', 'ratchet-raised', 'the counter "flag groups" was removed']], 'the counter goes, its saved number stays');
    assert.deepEqual(kinds(() => write(r.dir, 'kit.ratchets.json', saved({ 'useEffect uses': 3 }, []))), [['kit.ratchets.json', 'ratchet-raised', 'the count "flag groups" was removed (it was 2); the counter "flag groups" was removed']], 'the counter and its saved number both go');
    assert.deepEqual(kinds(() => write(r.dir, 'kit.ratchets.json', saved({ 'flag groups': 2, 'useEffect uses': 3 }, [{ ...counter, run: 'echo 0' }]))), [['kit.ratchets.json', 'ratchet-raised', 'the counter "flag groups" was changed']]);
    assert.deepEqual(kinds(() => write(r.dir, 'kit.ratchets.json', saved({ 'flag groups': 2, 'useEffect uses': 3 }, [{ ...counter, needs: ['no/such/file'] }]))), [['kit.ratchets.json', 'ratchet-raised', 'the counter "flag groups" was changed']], 'a counter that waits for a file that never comes is never counted');
    const changed = (what) => `a lint, type, or test settings file was ${what}`;
    assert.deepEqual(kinds(() => write(r.dir, 'lefthook.yml', 'pre-commit:\n  commands: {}\n')), [['lefthook.yml', 'check-settings-changed', changed('changed')]]);
    assert.deepEqual(kinds(() => git(r.dir, 'rm', '-q', 'lefthook.yml')), [['lefthook.yml', 'check-settings-changed', changed('deleted')]]);
    assert.deepEqual(kinds(() => git(r.dir, 'mv', 'lefthook.yml', 'hooks-off.yml')), [['lefthook.yml', 'check-settings-changed', changed('renamed to hooks-off.yml')]]);
    for (const added of ['.lefthook.toml', '.config/lefthook.jsonc', 'lefthook.yaml', 'lefthook.json', 'lefthook-local.yml']) {
      assert.deepEqual(kinds(() => write(r.dir, added, 'skip_output: true\n')), [[added, 'check-settings-changed', changed('added')]], added);
    }
    assert.deepEqual(kinds(() => write(r.dir, '.github/workflows/ci.yml', 'name: ci\non: workflow_dispatch\n')), [['.github/workflows/ci.yml', 'check-settings-changed', changed('changed')]]);
    assert.deepEqual(kinds(() => write(r.dir, '.github/workflows/extra.yml', 'name: extra\n')), [['.github/workflows/extra.yml', 'check-settings-changed', changed('added')]]);
    assert.deepEqual(kinds(() => write(r.dir, '.github/CODEOWNERS', '* @me\n')), [], 'only the workflows folder');
  } finally { r.cleanup(); }
});

test('round 3: filling in a placeholder check command is free; any other command change is a weakening', () => {
  const ts = PRESETS.find((p) => p.name === 'typescript').checks.find((c) => /Fill in this check/.test(c.run));
  assert.ok(ts, 'the typescript preset ships a placeholder test command');
  const s = (run) => JSON.stringify({ checks: [{ name: 'lint', run: 'pnpm lint' }, { name: ts.name, run }] });
  assert.equal(sortSettings(s(ts.run), s('pnpm test')), null, 'the placeholder always failed, so nothing is lost');
  assert.equal(sortSettings(s("echo 'Fill in this check: a command that applies every migration to an empty test database' >&2; exit 1"), s('pnpm migrate:test')), null);
  assert.match(sortSettings(s('pnpm test'), s('pnpm test || true')).what, /the command of the check "test" changed/);
  assert.match(sortSettings(s('pnpm test'), s(ts.run)).what, /the command of the check "test" changed/, 'back to a placeholder is a change');
  assert.match(sortSettings(s("echo 'Fill in this check' && true"), s('true')).what, /the command of the check "test" changed/, 'a command that only mentions the words, and passes, is no placeholder');
});

// ---------- Review round 4 ----------

test('A collect: the same edit moved to another test with the same lines around it is another change, with another id', () => {
  const r = repo();
  const one = (name, want) => [`test('${name}', () => {`, '  const a = 1;', '  const b = 1;', '  const actual = add(a, b);', `  assert.equal(actual, ${want});`, '  done();', '  done();', '  done();', '});'];
  const file = (first, second) => text(...one('first', first), ...one('second', second));
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'scripts/add.test.mjs', file(2, 2));
    commit(r.dir, 'Two tests with the same body');
    git(r.dir, 'switch', '-q', '-c', 'build/093-add');
    write(r.dir, 'scripts/add.test.mjs', file(3, 2));
    write(r.dir, `${REASON_DIR}build-093-add.md`, '- scripts/add.test.mjs: The first sum is 3 now, as the plan says.\n');
    commit(r.dir, 'The edit a reviewer rules on');
    const ruled = r.read().items[0];
    write(r.dir, 'scripts/add.test.mjs', file(2, 3));
    commit(r.dir, 'The same edit, in the other test');
    const moved = r.read().items[0];
    assert.deepEqual([moved.kind, moved.reason], [ruled.kind, ruled.reason]);
    assert.notEqual(moved.id, ruled.id);
  } finally { r.cleanup(); }
});

test('A changeId: made from the kind, the file, the reason, and the exact contents before and after', () => {
  const item = { kind: 'expectation-changed', file: 'a.test.ts', reason: 'The API changed as planned.', before: 'a'.repeat(40), after: 'b'.repeat(40) };
  const id = changeId(item);
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(changeId({ ...item }), id);
  for (const other of [{ kind: 'unclear' }, { file: 'b.test.ts' }, { reason: 'Another reason entirely.' }, { before: 'c'.repeat(40) }, { after: 'c'.repeat(40) }, { after: null }, { to: 'c.test.ts' }]) {
    assert.notEqual(changeId({ ...item, ...other }), id, JSON.stringify(other));
  }
});

test('B a new test, or a new top-level line, that writes to something every test shares is unclear', () => {
  const whole = (line) => `${NODE}test('quiet', () => {\n  ${line}\n});\n`;
  for (const line of [
    'assert.equal = () => {};',
    "assert['equal'] = () => {};",
    'Object.assign(assert, { equal() {} });',
    "Object.defineProperty(assert, 'equal', { value() {} });",
    'globalThis.fetch = () => ({ ok: true });',
    'global.setTimeout = (fn) => fn();',
    'process.exitCode = 0;',
    'module.exports = {};',
    'exports.add = () => 3;',
    'delete assert.equal;',
    'test = () => {};',
  ]) {
    const out = sort('scripts/math.test.mjs', NODE, whole(line));
    assert.equal(out.kind, 'unclear', line);
    assert.match(out.what, /a new line writes to something every test shares \(an imported name, a global, or the test runner\): /, line);
  }
  assert.equal(sort('scripts/math.test.mjs', NODE, whole('const local = {}; local.equal = 1; assert.equal(local.equal, 1);')).kind, 'added', 'a write to the test\'s own object is its own business');
  assert.equal(sort('scripts/math.test.mjs', NODE, whole('assert.equal(add(1, 1) === 2, true);')).kind, 'added', 'a comparison is not a write');
  const py = (line) => `${PYTEST}\ndef test_quiet():\n    ${line}\n`;
  for (const line of ['pytest.raises = fake_raises', 'total.cache = {}', 'setattr(pytest, "raises", fake_raises)']) assert.equal(sort('tests/test_shop.py', PYTEST, py(line)).kind, 'unclear', line);
  assert.equal(sort('tests/test_shop.py', PYTEST, py('assert total([2]) == 2')).kind, 'added');
  const cjs = "const { strictEqual: eq, ok } = require('node:assert');\nconst helpers = require('./helpers');\ntest('a', () => {\n  eq(1, 1);\n});\n";
  assert.equal(sort('scripts/a.test.cjs', cjs, `${cjs}test('b', () => {\n  helpers.check = () => true;\n});\n`).kind, 'unclear', 'a name brought in with require counts as imported');
  assert.equal(sort('scripts/a.test.cjs', cjs, `${cjs}test('b', () => {\n  eq.strict = false;\n});\n`).kind, 'unclear', 'so does one renamed on the way in');
});

test('C snapshot lines are compared exactly: a blank line or a space at the end of a line inside a saved snapshot is a change', () => {
  const jest = 'src/__snapshots__/card.test.tsx.snap';
  assert.equal(sort(jest, SNAP, SNAP.replace('  hola\n', '  hola\n\n')).kind, 'expectation-changed', 'a blank line inside');
  assert.equal(sort(jest, SNAP, SNAP.replace('  hola\n', '  hola \n')).kind, 'expectation-changed', 'a space at the end of a line');
  assert.equal(sort(jest, SNAP, SNAP.replace('<div>\n', '<div>\r\n')).kind, 'expectation-changed', 'another line end');
  assert.equal(sort(jest, SNAP, `${SNAP}\nexports[\`card renders two words 1\`] = \`\n<div>\n\n  dos\n</div>\n\`;\n`).kind, 'added', 'a whole new snapshot, blank lines and all, with a blank line before it');
  assert.equal(sort('tests/__snapshots__/test_home.ambr', AMBR, AMBR.replace('    hola\n', '    hola\n\n')).kind, 'expectation-changed');
});

test('D collect: a merged reason copied with backticks, other spacing, or other capitals does not count as new', () => {
  assert.equal(reasonKey('- `eslint.config.mjs`:  Turned the OLD import rule off,   Oxlint runs it now'), reasonKey('- eslint.config.mjs: Turned the old import rule off, Oxlint runs it now.'));
  assert.notEqual(reasonKey('- eslint.config.mjs: Turned the old import rule off.'), reasonKey('- eslint.config.mjs: Turned the new import rule off.'));
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, `${REASON_DIR}lead-first.md`, '- eslint.config.mjs: Turned the old import rule off, Oxlint runs it now.\n');
    commit(r.dir, 'An old merged weakening');
    git(r.dir, 'switch', '-q', '-c', 'lead/again');
    write(r.dir, 'eslint.config.mjs', 'export default [{ rules: {} }];\n');
    write(r.dir, `${REASON_DIR}lead-again.md`, '- `eslint.config.mjs`:  turned the old import rule off,  oxlint runs it now\n');
    commit(r.dir, 'The old reason, dressed up');
    const [item] = r.read().items;
    assert.equal(item.reason, null);
    assert.match(item.problem, /already on the base branch/);
  } finally { r.cleanup(); }
});

test('E collect: a reason the base branch gained after the branch left it does not count, before any merge', () => {
  const r = repo();
  const line = '- eslint.config.mjs: The rules block stays empty until slice 90 fills it.\n';
  try {
    git(r.dir, 'switch', '-q', '-c', 'lead/first');
    write(r.dir, 'eslint.config.mjs', 'export default [{ rules: {} }];\n');
    write(r.dir, `${REASON_DIR}lead-first.md`, line);
    commit(r.dir, 'A weakening with a reason');
    assert.match(r.read().items[0].id, /^[0-9a-f]{12}$/, 'ready to rule on');
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, `${REASON_DIR}lead-other.md`, line);
    commit(r.dir, 'Main gains the same line from another merge');
    git(r.dir, 'switch', '-q', 'lead/first');
    const [item] = r.read().items;
    assert.equal(item.id, null, 'the merge would reject this reason, so no id is offered for a ruling');
    assert.match(item.problem, /already on the base branch/);
  } finally { r.cleanup(); }
});

test('E collect: the presets are read from the named branch in git, not from the folder that happens to be checked out', () => {
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', '-c', 'lead/presets');
    for (const name of ['any', 'typescript']) write(r.dir, `scripts/presets/${name}.json`, readFileSync(join(HERE, 'presets', `${name}.json`), 'utf8'));
    write(r.dir, 'src/price.spec.ts', VITEST.replace('toEqual(108)', 'toEqual(110)'));
    commit(r.dir, 'Bring the presets in, and change a test');
    git(r.dir, 'switch', '-q', 'main');
    const out = r.read({ presets: undefined, presetNames: ['typescript'], tip: 'lead/presets', root: r.dir });
    assert.equal(out.fail, undefined);
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['src/price.spec.ts', 'expectation-changed']], 'sorted with the typescript patterns, which main\'s folder does not hold');
    assert.match(r.read({ presets: undefined, presetNames: ['nope'], tip: 'lead/presets', root: r.dir }).fail, /cannot load the language presets: scripts\/presets\/nope\.json is not on lead\/presets or on the base branch/);
  } finally { r.cleanup(); }
});

test('M a regular expression that mentions a skip, or holds a lone bracket, does not confuse the reader', () => {
  const skip = `${NODE}test('reads the help', () => {\n  assert.match(help(), /test.skip/);\n  assert.match(help(), /it\\.only\\(/);\n});\n`;
  assert.equal(sort('scripts/math.test.mjs', NODE, skip).kind, 'added');
  const bracket = `${NODE}test('finds a brace', () => {\n  assert.match(text(), /[{]/);\n  const half = 6 / 2 / 1;\n  assert.equal(half, 3);\n});\n`;
  assert.equal(sort('scripts/math.test.mjs', NODE, bracket).kind, 'added');
  const hidden = `${NODE}test('x', () => { const r = /[{]/; });\n  process.exitCode = 0;\n/[}]/;\n`;
  assert.notEqual(sort('scripts/math.test.mjs', NODE, hidden).kind, 'added', 'a bracket inside a regular expression no longer hides the lines after the test');
});

test('N collect: the first settings file of its family is setup and is free; one more where the base branch already has one needs a reason', () => {
  const r = repo();
  const added = (...files) => {
    git(r.dir, 'switch', '-q', '-C', 'lead/setup', 'main');
    for (const f of files) write(r.dir, f, 'x: 1\n');
    commit(r.dir, 'Add settings files');
    return r.read().items.map((i) => [i.file, i.kind]);
  };
  try {
    assert.deepEqual(added('lefthook.yml', '.oxlintrc.json', 'tsconfig.json', 'apps/web/tsconfig.json', 'vitest.config.ts', '.github/workflows/ci.yml'), [], 'main has none of these families yet, however many files the first setup brings');
    assert.deepEqual(added('.eslintignore'), [['.eslintignore', 'check-settings-changed']], 'main already has eslint.config.mjs: this is the same family');
    assert.deepEqual(added('apps/web/eslint.config.mjs', '.eslintrc.json'), [['.eslintrc.json', 'check-settings-changed'], ['apps/web/eslint.config.mjs', 'check-settings-changed']]);
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'lefthook.yml', 'x: 1\n');
    write(r.dir, 'pyproject.toml', '[tool.ruff]\n');
    commit(r.dir, 'Main gets its first lefthook file and a pyproject');
    assert.deepEqual(added('.config/lefthook.toml', 'lefthook-local.yml'), [['.config/lefthook.toml', 'check-settings-changed'], ['lefthook-local.yml', 'check-settings-changed']], 'a second lefthook file can switch the first one off');
    git(r.dir, 'switch', '-q', '-C', 'lead/setup', 'main');
    write(r.dir, 'services/api/pyproject.toml', '[tool.ruff]\n');
    write(r.dir, 'deno.json', '{}\n');
    commit(r.dir, 'The project\'s own settings names');
    assert.deepEqual(r.read({ extraSettingsFiles: ['pyproject.toml', 'deno.json'] }).items.map((i) => i.file), ['services/api/pyproject.toml'], 'each name the project lists is its own family');
  } finally { r.cleanup(); }
});

test('N collect: when the base branch has no settings file at all, the first one weakens nothing', () => {
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', 'main');
    git(r.dir, 'rm', '-q', 'scripts/kit.config.json');
    commit(r.dir, 'A project before the kit');
    git(r.dir, 'switch', '-q', '-c', 'lead/install');
    write(r.dir, 'scripts/kit.config.json', JSON.stringify({ checks: [], testPaths: ['.test.'], paperworkPaths: ['docs/', 'notes/'], features: { testReasons: true } }));
    commit(r.dir, 'Install the kit');
    const filled = (json) => ({ testPaths: ['.test.', 'tests/'], paperworkPaths: ['docs/'], ...JSON.parse(json) });
    assert.deepEqual(r.read({ readSettings: filled }).items, []);
  } finally { r.cleanup(); }
});

// A stand-in formatter: tabs become two spaces and spaces at the end of a line go. "--drop" also
// deletes every line with "expect(" in it, which no real formatter would do.
const FORMATTER = `const drop = process.argv.includes('--drop');
let text = '';
process.stdin.on('data', (d) => { text += d; }).on('end', () => {
  const lines = text.split('\\n').map((l) => l.replace(/\\t/g, '  ').replace(/\\s+$/, ''));
  process.stdout.write(lines.filter((l) => !(drop && l.includes('expect('))).join('\\n'));
});
`;
const TABBED = JEST.replace(/^( {2})+/gm, (m) => '\t'.repeat(m.length / 2)).replace("from './save';", "from './save';   ");
const withFormatter = (dir, flags = '') => PRESETS.map((p) => (p.name === 'typescript' ? { ...p, formatStdin: `node ${JSON.stringify(join(dir, 'fmt.cjs'))} ${flags} {file}` } : p));

test('O sameButLayout: true only when nothing but spacing, line breaks, quotes, commas, semicolons, and round brackets differ', () => {
  assert.equal(sameButLayout("it('a', () => {\n\texpect(f(1,2)).toBe(1)\n})\n", 'it("a", () => {\n  expect(f(1, 2)).toBe(1);\n});\n'), true);
  assert.equal(sameButLayout('expect(a).toBe(1);\n', 'expect(a).toBe(2);\n'), false);
  assert.equal(sameButLayout('expect(a === b).toBe(true);\n', 'expect(a !== b).toBe(true);\n'), false);
  assert.equal(sameButLayout('a();\nexpect(b).toBe(1);\n', 'a();\n'), false);
});

test('O collect: a test file that only changed in formatting is free, counted, and proved by running the preset\'s formatter on the base version', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'fmt.cjs'), FORMATTER);
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'src/save.test.ts', TABBED);
    write(r.dir, 'src/price.spec.ts', VITEST.replace(/^ {2}/gm, '\t'));
    write(r.dir, 'src/__snapshots__/card.test.tsx.snap', SNAP.replace('  hola', '\thola'));
    write(r.dir, 'src/__snapshots__/shot.ts', 'export default {\n\tword: 1,\n};\n');
    commit(r.dir, 'Files laid out the old way');
    git(r.dir, 'switch', '-q', '-c', 'lead/format');
    write(r.dir, 'src/save.test.ts', JEST);
    write(r.dir, 'src/price.spec.ts', VITEST.replace('toEqual(108)', 'toEqual(110)'));
    write(r.dir, 'src/__snapshots__/card.test.tsx.snap', SNAP);
    write(r.dir, 'src/__snapshots__/shot.ts', 'export default {\n  word: 1,\n};\n');
    commit(r.dir, 'Format everything, and slip in one changed expectation');
    const plain = r.read({ root: r.dir });
    assert.deepEqual(plain.items.map((i) => i.file), ['src/__snapshots__/card.test.tsx.snap', 'src/__snapshots__/shot.ts', 'src/price.spec.ts', 'src/save.test.ts'], 'with no formatter in the preset, every one is flagged');
    assert.equal(plain.formattingOnly, 0);
    assert.equal(r.read({ root: r.dir, presets: withFormatter(r.dir) }).formattingOnly, 0, 'a formatter only the branch\'s preset names is not used');
    const out = r.read({ root: r.dir, basePresets: withFormatter(r.dir) });
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['src/__snapshots__/card.test.tsx.snap', 'expectation-changed'], ['src/__snapshots__/shot.ts', 'expectation-changed'], ['src/price.spec.ts', 'expectation-changed']], 'a snapshot is never let off, even one the formatter knows; the file with a real change is not what the formatter gives');
    assert.equal(out.formattingOnly, 1);
    const missing = r.read({ root: r.dir, basePresets: PRESETS.map((p) => (p.name === 'typescript' ? { ...p, formatStdin: 'no-such-formatter-here {file}' } : p)) });
    assert.equal(missing.items.length, 4, 'a formatter that cannot run lets nothing off');
    assert.equal(missing.formattingOnly, 0);
  } finally { r.cleanup(); }
});

test('O collect: a "formatter" that changes more than layout lets nothing off, even when its output is exactly the branch\'s file', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'fmt.cjs'), FORMATTER);
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'src/save.test.ts', TABBED);
    commit(r.dir, 'A file laid out the old way');
    git(r.dir, 'switch', '-q', '-c', 'lead/format');
    write(r.dir, 'src/save.test.ts', JEST.split('\n').filter((l) => !l.includes('expect(')).join('\n'));
    commit(r.dir, 'What a formatter that drops assertions would write');
    const out = r.read({ root: r.dir, basePresets: withFormatter(r.dir, '--drop') });
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['src/save.test.ts', 'expectation-changed']]);
    assert.equal(out.formattingOnly, 0);
  } finally { r.cleanup(); }
});

test('P a line added to an old test file that is not a whole new test is test-edited, its own kind; unclear stays for what fits nothing', () => {
  const early = sort('src/save.test.ts', JEST, JEST.replace("    expect(save('hola')).toBe(1);", "    if (save('hola') !== 1) return;\n    expect(save('hola')).toBe(1);"));
  assert.equal(early.kind, 'test-edited');
  assert.match(early.what, /^a line was added that is not part of a whole new test: if \(save\('hola'\) !== 1\) return;$/);
  assert.equal(sort('src/save.test.ts', JEST, JEST.replace("import { save }", "import { reset } from './reset';\nimport { save }")).kind, 'test-edited', 'an import');
  assert.equal(sort('src/save.test.ts', JEST, JEST.replace("describe('save'", "const word = () => 'hola';\ndescribe('save'")).kind, 'test-edited', 'a helper');
  assert.equal(sort('tests/notes.txt', 'one\n', 'one\ntwo\n').kind, 'test-edited', 'a file with no preset');
  assert.equal(sort('src/save.test.ts', JEST, JEST.replace("from './save'", "from './save-v2'")).kind, 'unclear', 'a changed line that fits nothing');
  assert.deepEqual(KINDS, ['test-deleted', 'test-removed', 'test-skipped', 'wait-added', 'timeout-raised', 'retry-added', 'expectation-changed', 'unclear', 'test-edited', 'ratchet-raised', 'check-removed', 'check-settings-changed']);
});

// ---------- Review round 5: the last pass ----------

test('1 sameButLayout: strings, templates, and regular expressions must match exactly; only the quote mark, with its escapes, may change', () => {
  const same = (a, b, file = 'a.test.ts') => sameButLayout(a, b, file);
  assert.equal(same("it('a', () => {\n\texpect(f(1,2)).toBe(1)\n})\n", 'it("a", () => {\n  expect(f(1, 2)).toBe(1);\n});\n'), true, 'layout and quote marks');
  assert.equal(same("say('don\\'t')\n", 'say("don\'t");\n'), true, 'a quote mark changed, with its escape');
  assert.equal(same('say("he said \\"hi\\"")\n', "say('he said \"hi\"');\n"), true);
  assert.equal(same("expect(f('a  b')).toBe(1);\n", "expect(f('a b')).toBe(1);\n"), false, 'a space inside a string is a change of meaning');
  assert.equal(same('const t = `one\n\ntwo`;\n', 'const t = `one\ntwo`;\n'), false, 'a blank line inside a template');
  assert.equal(same('const t = `a,b;(c)`;\n', 'const t = `abc`;\n'), false, 'layout characters inside a template are text');
  assert.equal(same('expect(s).toMatch(/a  b/);\n', 'expect(s).toMatch(/a b/);\n'), false, 'inside a regular expression');
  assert.equal(same('expect(a).toBe(1);\n', 'expect(a).toBe(2);\n'), false);
  assert.equal(same('a();\nexpect(b).toBe(1);\n', 'a();\n'), false);
  assert.equal(same('a(); // why  this\n/* one\n   two */\n', 'a(); // why this\n/* one\n  two */\n'), true, 'spacing inside a comment is layout');
  assert.equal(same("assert total('a  b') == 1\n", "assert total('a b') == 1\n", 'tests/test_a.py'), false);
  assert.equal(same("x = {  'a':1 }\n", 'x = {"a": 1}\n', 'tests/test_a.py'), true);
});

test('1 collect: the formatter command is the base branch\'s, so a branch cannot bring its own "formatter" to wave its change through', () => {
  const r = repo();
  const preset = (command) => JSON.stringify({ ...JSON.parse(readFileSync(join(HERE, 'presets', 'typescript.json'), 'utf8')), formatStdin: command });
  const original = "it('joins', () => {\n  expect(join('a', 'b')).toBe('a  b');\n});\n";
  try {
    writeFileSync(join(r.dir, 'fmt.cjs'), FORMATTER);
    // A "formatter" that turns two spaces into one, everywhere, strings included.
    writeFileSync(join(r.dir, 'squeeze.cjs'), "let t = '';\nprocess.stdin.on('data', (d) => { t += d; }).on('end', () => process.stdout.write(t.replace(/(\\S) {2}(\\S)/g, '$1 $2')));\n");
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'scripts/presets/any.json', readFileSync(join(HERE, 'presets', 'any.json'), 'utf8'));
    write(r.dir, 'scripts/presets/typescript.json', preset(`node ${JSON.stringify(join(r.dir, 'fmt.cjs'))} {file}`));
    write(r.dir, 'src/join.test.ts', original);
    write(r.dir, 'src/wide.test.ts', "it('adds', () => {\n  expect(add(1,  2)).toBe(3);\n});\n");
    commit(r.dir, 'Presets and two tests on main');
    git(r.dir, 'switch', '-q', '-c', 'build/094-join');
    write(r.dir, 'scripts/presets/typescript.json', preset(`node ${JSON.stringify(join(r.dir, 'squeeze.cjs'))} {file}`));
    write(r.dir, 'src/join.test.ts', original.replace("'a  b'", "'a b'"));
    write(r.dir, 'src/wide.test.ts', "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n");
    commit(r.dir, 'Change the expected text, and the formatter to match');
    const out = r.read({ presets: undefined, presetNames: ['typescript'], root: r.dir });
    assert.equal(out.fail, undefined);
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['src/join.test.ts', 'expectation-changed'], ['src/wide.test.ts', 'expectation-changed']], 'the second file changed in layout only, but main\'s formatter does not give that layout: only the branch\'s would');
    assert.equal(out.formattingOnly, 0);
  } finally { r.cleanup(); }
});

test('2 a removed or altered line is judged on the exact lines: a blank line taken out of a template string is unclear, never free and never test-edited', () => {
  const base = text("test('prints', () => {", '  const want = `one', '', 'two`;', '  assert.equal(print(), want);', '});');
  const file = 'scripts/print.test.mjs';
  assert.equal(sort(file, base, base.replace('one\n\ntwo', 'one\ntwo')).kind, 'unclear', 'a blank line deleted inside the string');
  assert.equal(sort(file, base, base.replace('one\n\ntwo', 'one\ntwo').replace('  assert.equal(print(), want);', '  assert.equal(print(), want);\n  assert.ok(want);')).kind, 'unclear', 'the same, with an assertion added beside it');
  assert.equal(sort(file, base, base.replace('one\n\ntwo', 'one \n\ntwo')).kind, 'unclear', 'a space added at the end of a line of the string');
  assert.equal(sort(file, base, base.replace('one\n\ntwo', 'one\n\n\ntwo')).kind, 'unclear', 'a blank line added inside the string');
  assert.equal(sort(file, base, base.replace('one\n\ntwo', 'one\n\nmore\ntwo')).kind, 'unclear', 'a line added inside the string');
  assert.equal(sort(file, base, `${base}\ntest('more', () => {\n\n  assert.ok(print());\n});\n`).kind, 'added', 'blank lines in and around a whole new test are free');
  assert.equal(sort(file, base, base.replace("test('prints'", "\ntest('prints'")).kind, 'added', 'a blank line added between tests is free');
});

test('3 collect: when the branch is not what is checked out, a formatting check is not guessed: it stops with a plain line', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'fmt.cjs'), FORMATTER);
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'src/save.test.ts', TABBED);
    commit(r.dir, 'A file laid out the old way');
    git(r.dir, 'switch', '-q', '-c', 'lead/format');
    write(r.dir, 'src/save.test.ts', JEST);
    commit(r.dir, 'Format it');
    const sets = withFormatter(r.dir);
    assert.equal(r.read({ root: r.dir, presets: sets, basePresets: sets }).formattingOnly, 1, 'checked out: the formatter is run');
    const away = r.read({ root: r.dir, presets: sets, basePresets: sets, onDisk: false });
    assert.match(away.fail, /cannot tell whether 1 test file changed in formatting only: the formatter reads its settings from the files in this folder, and HEAD is not what is checked out here\. Run this again from a checkout of that branch\./);
    write(r.dir, 'src/save.test.ts', JEST.replace('toBe(1)', 'toBe(2)'));
    commit(r.dir, 'A real change on top');
    assert.equal(r.read({ root: r.dir, presets: sets, basePresets: sets, onDisk: false }).fail, undefined, 'with nothing to ask the formatter, it goes on');
  } finally { r.cleanup(); }
});

test('4 collect: "the first settings file of its family" is judged against the base branch as it is now, not as it was when the branch left it', () => {
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', '-c', 'lead/hooks');
    write(r.dir, '.lefthook.toml', 'x = 1\n');
    commit(r.dir, 'The first lefthook file, as far as this branch knows');
    assert.deepEqual(r.read().items, [], 'main has none: setup');
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'lefthook.yml', 'x: 1\n');
    commit(r.dir, 'Main gets a lefthook file of its own first');
    git(r.dir, 'switch', '-q', 'lead/hooks');
    assert.deepEqual(r.read().items.map((i) => [i.file, i.kind]), [['.lefthook.toml', 'check-settings-changed']], 'before any merge, as the merge will see it');
    git(r.dir, 'merge', '-q', '--no-edit', 'main');
    assert.deepEqual(r.read().items.map((i) => [i.file, i.kind]), [['.lefthook.toml', 'check-settings-changed']]);
  } finally { r.cleanup(); }
});

test('5 a write to a shared name needs a ruling in a new test file too; setting process.env.NAME is ordinary setup and is free', () => {
  const r = repo();
  try {
    write(r.dir, 'src/quiet.test.ts', "import assert from 'node:assert/strict';\nassert.equal = () => {};\ntest('quiet', () => {\n  assert.equal(1, 2);\n});\n");
    write(r.dir, 'src/env.test.ts', "process.env.API_URL = 'http://localhost';\nprocess.env['MODE'] = 'test';\ntest('reads the address', () => {\n  expect(address()).toBe('http://localhost');\n});\n");
    write(r.dir, 'src/exit.test.ts', "test('passes whatever happens', () => {\n  process.exitCode = 0;\n});\n");
    commit(r.dir, 'Three new test files');
    const out = r.read();
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['src/exit.test.ts', 'unclear'], ['src/quiet.test.ts', 'unclear']]);
    assert.match(out.items[1].what, /a new line writes to something every test shares \(an imported name, a global, or the test runner\): assert\.equal = \(\) => \{\};/);
    assert.equal(out.testsAdded, 3);
  } finally { r.cleanup(); }
  const whole = (line) => `${NODE}test('setup', () => {\n  ${line}\n});\n`;
  for (const line of ["process.env.SKIP_SLOW = '1';", "process.env['SKIP_SLOW'] = '1';"]) assert.equal(sort('scripts/math.test.mjs', NODE, whole(line)).kind, 'added', line);
  for (const line of ['process.exitCode = 0;', 'process.env = {};', 'process.exit = () => {};', "process.env.A = '1'; assert.equal = () => {};"]) assert.equal(sort('scripts/math.test.mjs', NODE, whole(line)).kind, 'unclear', line);
});

test('6 reasons: the path is compared exactly, the sentence loosely', () => {
  const sentence = 'The old value was wrong, as the plan says.';
  assert.notEqual(reasonKey(`- foo-bar.test.js: ${sentence}`), reasonKey(`- foobar.test.js: ${sentence}`), 'two different files');
  assert.notEqual(reasonKey(`- src/A.test.js: ${sentence}`), reasonKey(`- src/a.test.js: ${sentence}`), 'capitals in a path count');
  assert.equal(reasonKey(`-  \`foo-bar.test.js\` :   the OLD value was wrong,  as the plan says`), reasonKey(`- foo-bar.test.js: ${sentence}`), 'backticks, spacing, capitals, and the full stop do not');
  assert.equal(reasonKey(`- "foo-bar.test.js": ${sentence}`), reasonKey(`- foo-bar.test.js: ${sentence}`));
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'src/foobar.test.ts', JEST);
    write(r.dir, 'src/foo-bar.test.ts', JEST);
    write(r.dir, `${REASON_DIR}lead-first.md`, `- src/foobar.test.ts: ${sentence}\n`);
    commit(r.dir, 'Two tests with like names, and a merged reason for one');
    git(r.dir, 'switch', '-q', '-c', 'lead/second');
    write(r.dir, 'src/foo-bar.test.ts', JEST.replace('toBe(1)', 'toBe(2)'));
    write(r.dir, `${REASON_DIR}lead-second.md`, `- src/foo-bar.test.ts: ${sentence}\n`);
    commit(r.dir, 'The other file, with the same sentence');
    assert.equal(r.read().items[0].reason, sentence, 'not a copy: it is about another file');
  } finally { r.cleanup(); }
});

// ---------- A kit update must always be able to merge ----------

// The kit's typescript and "any" presets as text; `change` edits the typescript one first.
const presetText = (name, change = (p) => p) => JSON.stringify(change(JSON.parse(readFileSync(join(HERE, 'presets', `${name}.json`), 'utf8'))), null, 2);
const OLDER_FORMS = [
  ['a field the loader now needs is missing', (p) => { const { extensions, ...rest } = p; return { ...rest, exts: extensions }; }],
  ['a field the loader no longer knows', (p) => ({ ...p, retiredField: true })],
];

test('kit update: when the base branch\'s preset is in an older form, this branch\'s copy is used, for the patterns and for the formatter, with one plain line', () => {
  for (const [what, older] of [...OLDER_FORMS, ['not valid JSON', null]]) {
    const r = repo();
    try {
      writeFileSync(join(r.dir, 'fmt.cjs'), FORMATTER);
      const fmt = `node ${JSON.stringify(join(r.dir, 'fmt.cjs'))} {file}`;
      git(r.dir, 'switch', '-q', 'main');
      write(r.dir, 'scripts/presets/any.json', presetText('any'));
      write(r.dir, 'scripts/presets/typescript.json', older ? presetText('typescript', older) : '{ this is not JSON');
      write(r.dir, 'src/save.test.ts', TABBED);
      commit(r.dir, 'A project whose kit files are one version behind');
      git(r.dir, 'switch', '-q', '-c', 'lead/kit-update');
      write(r.dir, 'scripts/presets/typescript.json', presetText('typescript', (p) => ({ ...p, formatStdin: fmt })));
      write(r.dir, 'src/save.test.ts', JEST);
      write(r.dir, 'src/price.spec.ts', VITEST.replace('toEqual(108)', 'toEqual(110)'));
      commit(r.dir, 'Take the kit update: new preset files, a reformatted test, and one real change');
      const out = r.read({ presets: undefined, presetNames: ['typescript'], root: r.dir });
      assert.equal(out.fail, undefined, what);
      assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['src/price.spec.ts', 'expectation-changed']], `${what}: sorted with this branch's patterns`);
      assert.equal(out.formattingOnly, 1, `${what}: the formatter command comes from this branch's copy too`);
      assert.deepEqual(out.notes, ["the base branch's preset typescript is in an older form; using this branch's"], what);
    } finally { r.cleanup(); }
  }
});

test('kit update: a base branch whose preset still loads keeps its say: no line, and its own formatter command', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'fmt.cjs'), FORMATTER);
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'scripts/presets/any.json', presetText('any'));
    write(r.dir, 'scripts/presets/typescript.json', presetText('typescript', (p) => { const { formatStdin, ...rest } = p; return rest; }));
    write(r.dir, 'src/save.test.ts', TABBED);
    commit(r.dir, 'Presets that load, with no formatter');
    git(r.dir, 'switch', '-q', '-c', 'build/095-format');
    write(r.dir, 'scripts/presets/typescript.json', presetText('typescript', (p) => ({ ...p, formatStdin: `node ${JSON.stringify(join(r.dir, 'fmt.cjs'))} {file}` })));
    write(r.dir, 'src/save.test.ts', JEST);
    commit(r.dir, 'Bring a formatter and use it');
    const out = r.read({ presets: undefined, presetNames: ['typescript'], root: r.dir });
    assert.deepEqual([out.formattingOnly, out.notes], [0, []], 'the fallback is only for a copy that cannot be loaded');
    assert.equal(out.items.length, 1);
  } finally { r.cleanup(); }
});

test('kit update: before the update is committed, when no committed copy of a preset loads, the copy in the folder is used, with a line', () => {
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'scripts/presets/any.json', presetText('any', OLDER_FORMS[0][1]));
    write(r.dir, 'scripts/presets/typescript.json', presetText('typescript', OLDER_FORMS[0][1]));
    commit(r.dir, 'Kit files one version behind');
    git(r.dir, 'switch', '-q', '-c', 'lead/kit-update');
    write(r.dir, 'src/price.spec.ts', VITEST.replace('toEqual(108)', 'toEqual(110)'));
    commit(r.dir, 'A change, while the new kit files are still unsaved in the folder');
    write(r.dir, 'scripts/presets/any.json', presetText('any'));
    write(r.dir, 'scripts/presets/typescript.json', presetText('typescript'));
    const out = r.read({ presets: undefined, presetNames: ['typescript'], root: r.dir });
    assert.equal(out.fail, undefined);
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['src/price.spec.ts', 'expectation-changed']]);
    assert.deepEqual(out.notes, [
      "this branch's preset typescript is in an older form; using the copy in this folder",
      "the base branch's preset typescript is in an older form; using the copy in this folder",
      "this branch's preset any is in an older form; using the copy in this folder",
      "the base branch's preset any is in an older form; using the copy in this folder",
    ], 'one line for each committed copy that was passed over');
    rmSync(join(r.dir, 'scripts', 'presets'), { recursive: true });
    assert.match(r.read({ presets: undefined, presetNames: ['typescript'], root: r.dir }).fail, /cannot load the language presets: scripts\/presets\/typescript\.json: /, 'with no copy that loads anywhere, it still fails loud');
  } finally { r.cleanup(); }
});

test('first sync: a base branch with no preset files at all works: the branch\'s presets sort the change, and nothing is waved through as formatting', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'fmt.cjs'), FORMATTER);
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'src/save.test.ts', TABBED);
    commit(r.dir, 'A project before its first kit sync');
    git(r.dir, 'switch', '-q', '-c', 'lead/first-sync');
    write(r.dir, 'scripts/presets/any.json', presetText('any'));
    write(r.dir, 'scripts/presets/typescript.json', presetText('typescript', (p) => ({ ...p, formatStdin: `node ${JSON.stringify(join(r.dir, 'fmt.cjs'))} {file}` })));
    write(r.dir, 'src/save.test.ts', JEST);
    write(r.dir, 'src/price.spec.ts', VITEST.replace('toEqual(108)', 'toEqual(110)'));
    commit(r.dir, 'First sync, a reformatted test, and one real change');
    const out = r.read({ presets: undefined, presetNames: ['typescript'], root: r.dir });
    assert.equal(out.fail, undefined);
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['src/price.spec.ts', 'expectation-changed'], ['src/save.test.ts', 'unclear']]);
    assert.deepEqual([out.formattingOnly, out.notes], [0, []], 'a base branch with no preset names no formatter, and that is not an older form');
  } finally { r.cleanup(); }
});

// ---------- Flaky-test workarounds: a fixed wait, a raised time limit, retries ----------

// An old Jest file whose second test already waits, sets a time limit, and retries.
const SLOW = text(
  "import { load } from './load';",
  'jest.setTimeout(10000);',
  'jest.retryTimes(2);',
  "describe('load', () => {",
  "  it('loads a page', async () => {",
  '    await load();',
  '    expect(page()).toBe(1);',
  '  });',
  "  it('loads twice', async () => {",
  '    await sleep(200);',
  '    expect(await load()).toBe(2);',
  '  }, 5000);',
  '});',
);
const inSlow = (from, to) => sort('src/load.test.ts', SLOW, SLOW.replace(from, to));

test('wait-added: a fixed wait added to a test is a weakening; a removed or shorter wait is free', () => {
  for (const wait of ['await sleep(500);', 'await new Promise((resolve) => setTimeout(resolve, 500));', 'await page.waitForTimeout(500);', 'await setTimeout(500);']) {
    const out = inSlow('    await load();\n', `    await load();\n    ${wait}\n`);
    assert.equal(out.kind, 'wait-added', wait);
    assert.match(out.what, /a fixed wait was added: /);
  }
  const longer = inSlow('await sleep(200);', 'await sleep(900);');
  assert.equal(longer.kind, 'wait-added');
  assert.match(longer.what, /a fixed wait went up from 200 to 900/);
  assert.equal(longer.what.includes('unclear'), false);
  assert.equal(inSlow('await sleep(200);', 'await sleep(50);').kind, 'added', 'a shorter wait is free');
  assert.equal(inSlow('    await sleep(200);\n', '').kind, 'added', 'a removed wait is free');
  const busy = SLOW.replace('await sleep(200);', 'await sleep(200); reset();');
  assert.equal(sort('src/load.test.ts', busy, busy.replace('    await sleep(200); reset();\n', '')).kind, 'unclear', 'a removed wait line that also did something else is not let off');
  assert.equal(inSlow('    await sleep(200);\n    expect(await load()).toBe(2);\n', '    expect(await load()).toBe(2);\n').kind, 'added');
  assert.equal(sort('tests/test_shop.py', PYTEST, PYTEST.replace('    assert total([1, 2]) == 3', '    time.sleep(1)\n    assert total([1, 2]) == 3')).kind, 'wait-added');
});

test('wait-added false alarm: a whole new test that moves a fake clock forward is free', () => {
  const tip = `${SLOW.slice(0, -4)}  it('fires later', () => {\n    vi.useFakeTimers();\n    setTimeout(done, 1000);\n    vi.advanceTimersByTime(1000);\n    expect(done).toHaveBeenCalled();\n  });\n});\n`;
  assert.ok(tip.startsWith(SLOW.slice(0, -4)) && tip.endsWith('});\n'));
  assert.deepEqual(sort('src/load.test.ts', SLOW, tip), { kind: 'added', what: 'only whole new tests were added' });
});

test('timeout-raised: a time limit raised or newly added is a weakening; a lowered one is free', () => {
  const up = inSlow('jest.setTimeout(10000);', 'jest.setTimeout(60000);');
  assert.equal(up.kind, 'timeout-raised');
  assert.match(up.what, /a time limit went up from 10000 to 60000/);
  assert.equal(inSlow('}, 5000);', '}, 30_000);').kind, 'timeout-raised', 'the limit given after a test');
  assert.equal(inSlow('jest.setTimeout(10000);', 'jest.setTimeout(0);').kind, 'timeout-raised', '0 means no limit at all');
  assert.equal(inSlow('jest.setTimeout(10000);', 'jest.setTimeout(10 * 1000 * 6);').kind, 'timeout-raised', 'a product is read as one number');
  const added = inSlow("  it('loads a page', async () => {", "  it('loads a page', { timeout: 20000 }, async () => {");
  assert.equal(added.kind, 'timeout-raised');
  assert.equal(sort('tests/test_shop.py', PYTEST, PYTEST.replace('def test_total_adds_items():', '@pytest.mark.timeout(60)\ndef test_total_adds_items():')).kind, 'timeout-raised');
});

test('timeout-raised false alarm: a lowered or unchanged time limit is free', () => {
  assert.equal(inSlow('jest.setTimeout(10000);', 'jest.setTimeout(2000);').kind, 'added');
  assert.equal(inSlow('}, 5000);', '}, 1000);').kind, 'added');
  assert.equal(inSlow('jest.setTimeout(10000);', 'jest.setTimeout(10_000);').kind, 'added', 'the same number written another way');
  assert.equal(inSlow('jest.setTimeout(10000);\n', '').kind, 'added', 'a removed limit is free');
  const other = inSlow('jest.setTimeout(10000);', 'jest.setTimeout(2000); done();');
  assert.notEqual(other.kind, 'added', 'a lowered limit on a line that also changed in other ways is not let off');
});

test('retry-added: retries added or raised are a weakening; fewer retries are free', () => {
  assert.equal(inSlow('jest.retryTimes(2);', 'jest.retryTimes(5);').kind, 'retry-added');
  assert.match(inSlow('jest.retryTimes(2);', 'jest.retryTimes(5);').what, /automatic retries went up from 2 to 5/);
  const fresh = sort('src/save.test.ts', JEST, `jest.retryTimes(3);\n${JEST}`);
  assert.equal(fresh.kind, 'retry-added');
  assert.match(fresh.what, /automatic retries were added: jest\.retryTimes\(3\);/);
  assert.equal(sort('tests/test_shop.py', PYTEST, PYTEST.replace('def test_total_adds_items():', '@pytest.mark.flaky(reruns=3)\ndef test_total_adds_items():')).kind, 'retry-added');
});

test('retry-added false alarm: fewer retries, or retries switched off, are free', () => {
  assert.equal(inSlow('jest.retryTimes(2);', 'jest.retryTimes(1);').kind, 'added');
  assert.equal(inSlow('jest.retryTimes(2);', 'jest.retryTimes(0);').kind, 'added');
  assert.equal(inSlow('jest.retryTimes(2);\n', '').kind, 'added', 'removed retries are free');
  assert.equal(sort('src/load.test.ts', `${SLOW}it('waits', async () => {\n  await page.waitForTimeout(500);\n});\n`, SLOW).kind, 'test-removed', 'a removed test is still a removed test');
  const zero = sort('src/save.test.ts', JEST, `jest.retryTimes(0);\n${JEST}`);
  assert.notEqual(zero.kind, 'retry-added', 'no retries is not a retry (the added line is still an edit to an old file)');
});

test('the flaky kinds come right after test-skipped in the fixed order, and every finding is in the what line', () => {
  assert.deepEqual(KINDS.slice(0, 8), ['test-deleted', 'test-removed', 'test-skipped', 'wait-added', 'timeout-raised', 'retry-added', 'expectation-changed', 'unclear']);
  const out = inSlow('    await load();\n    expect(page()).toBe(1);\n', '    await load();\n    await sleep(100);\n    expect(page()).toBe(2);\n');
  assert.equal(out.kind, 'wait-added');
  assert.match(out.what, /a fixed wait was added: await sleep\(100\);.*; 1 line that holds an assertion was removed or changed/);
});

test('collect: flaky workarounds in a new test file and in test settings files, each with an id once it has a reason', () => {
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'vitest.config.ts', 'export default { test: { testTimeout: 5000 } };\n');
    commit(r.dir, 'Vitest settings');
    git(r.dir, 'switch', '-q', '-c', 'build/085-slow');
    write(r.dir, 'vitest.config.ts', 'export default { test: { testTimeout: 60000 } };\n');
    write(r.dir, 'pytest.ini', '[pytest]\naddopts = --reruns 2\n');
    write(r.dir, 'playwright.config.ts', 'export default { retries: 0 };\n');
    write(r.dir, 'src/fresh.test.ts', "it('waits', async () => {\n  await sleep(300);\n  expect(x()).toBe(1);\n});\n");
    write(r.dir, 'src/calm.test.ts', "it('is calm', () => {\n  vi.useFakeTimers();\n  vi.advanceTimersByTime(300);\n  expect(x()).toBe(1);\n});\n");
    write(r.dir, 'docs/weakenings/build-085-slow.md', '- vitest.config.ts: The import job reads a slow fixture, so the limit was raised on purpose.\n');
    commit(r.dir, 'Slow things down');
    const out = r.read({ branch: 'build/085-slow' });
    assert.equal(out.fail, undefined);
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['pytest.ini', 'retry-added'], ['src/fresh.test.ts', 'wait-added'], ['vitest.config.ts', 'timeout-raised']]);
    const vitest = out.items.find((i) => i.file === 'vitest.config.ts');
    assert.match(vitest.what, /a time limit went up from 5000 to 60000.*; a lint, type, or test settings file was changed/);
    assert.match(vitest.id, /^[0-9a-f]{12}$/, 'a reason makes an id, as for every kind');
    assert.equal(out.items.find((i) => i.file === 'pytest.ini').id, null);
    const shown = describe(out);
    assert.match(shown, /^retry-added {2}pytest\.ini$/m);
    assert.match(shown, /^ {2}- src\/fresh\.test\.ts: <why/m, 'the line still owed is printed for the new kinds too');
  } finally { r.cleanup(); }
});

test('collect: a test file that changed in formatting only is still free when a wait line was only laid out again', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'fmt2.cjs'), "let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',()=>process.stdout.write(s.replace(/\\( /g,'(').replace(/ \\)/g,')')));\n");
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'src/load.test.ts', SLOW.replace('await sleep(200);', 'await sleep( 200 );'));
    commit(r.dir, 'Spaced');
    git(r.dir, 'switch', '-q', '-c', 'lead/format-waits');
    write(r.dir, 'src/load.test.ts', SLOW);
    commit(r.dir, 'Format');
    const sets = PRESETS.map((p) => (p.name === 'typescript' ? { ...p, formatStdin: `node ${JSON.stringify(join(r.dir, 'fmt2.cjs'))}` } : p));
    assert.deepEqual(r.read({ root: r.dir }).items.map((i) => [i.file, i.kind]), [['src/load.test.ts', 'wait-added']], 'without the formatter proof, the respaced wait is flagged');
    const out = r.read({ root: r.dir, basePresets: sets });
    assert.deepEqual([out.items, out.formattingOnly], [[], 1]);
  } finally { r.cleanup(); }
});

// ---------- Modes: a switch can enforce, only watch (observe), or be off ----------

const modes = (features, checks = [{ name: 'tests', run: 'pnpm test' }]) => JSON.stringify({ features, checks });

test('modes: true and "enforce" are the same, false and "off" and missing are the same; no change is no weakening', () => {
  assert.equal(sortSettings(modes({ testReasons: true }), modes({ testReasons: 'enforce' })), null);
  assert.equal(sortSettings(modes({ testReasons: 'enforce' }), modes({ testReasons: true })), null);
  assert.equal(sortSettings(modes({ testReasons: false }), modes({ testReasons: 'off' })), null);
  assert.equal(sortSettings(modes({ testReasons: 'off' }), modes({})), null);
});

test('modes: enforce to observe, and enforce to off, are weakenings, said in plain words', () => {
  assert.deepEqual(sortSettings(modes({ testReasons: true }), modes({ testReasons: 'observe' })), { kind: 'check-removed', what: 'the switch testReasons went from enforce to observe: it now only watches' });
  assert.deepEqual(sortSettings(modes({ testReasons: 'enforce' }), modes({ testReasons: false })), { kind: 'check-removed', what: 'the switch testReasons went from enforce to off: it no longer runs' });
  assert.match(sortSettings(modes({ testReasons: true }), modes({})).what, /the switch testReasons went from enforce to off/, 'a switch taken out is off');
});

test('modes: observe to off is free, and any move toward stricter is free', () => {
  assert.equal(sortSettings(modes({ testReasons: 'observe' }), modes({ testReasons: 'off' })), null);
  assert.equal(sortSettings(modes({ testReasons: 'observe' }), modes({})), null);
  for (const [from, to] of [['off', 'observe'], ['observe', 'enforce'], [false, true], ['off', 'enforce'], ['observe', true]]) {
    assert.equal(sortSettings(modes({ testReasons: from }), modes({ testReasons: to })), null, `${from} to ${to}`);
  }
});

test('modes: a check that starts only watching is a weakening; one that stops watching, or a watching one removed, is free', () => {
  const watching = [{ name: 'tests', run: 'pnpm test', observe: true }];
  assert.deepEqual(sortSettings(modes({}), modes({}, watching)), { kind: 'check-removed', what: "the check 'tests' now only watches: a failure no longer stops a merge" });
  assert.equal(sortSettings(modes({}, watching), modes({})), null, 'losing "observe" is free');
  assert.equal(sortSettings(modes({}, watching), modes({}, [])), null, 'a check that only watched stopped nothing, so removing it is free');
  assert.equal(sortSettings(modes({}), modes({}, [{ name: 'tests', run: 'pnpm test', observe: false }])), null, '"observe": false is the same as none');
  assert.match(sortSettings(modes({}, watching), modes({}, [{ name: 'tests', run: 'pnpm test || true', observe: true }])).what, /the command of the check "tests" changed/, 'a watching check whose command changed is still a change');
});

test('modes: settings the gate hands in through guardView (switches as true or false, watching checks left out) still sort the same way', () => {
  const view = (features, checks) => JSON.stringify({ features, checks });
  assert.equal(sortSettings(view({ testReasons: true }, [{ name: 'tests', run: 'x' }]), view({ testReasons: false }, [])).kind, 'check-removed');
  assert.equal(sortSettings(view({ testReasons: false }, []), view({ testReasons: false }, [])), null);
});

test('collect: the command line reads the settings itself, so a mode change is listed and true to "enforce" is not', () => {
  const r = repo();
  try {
    const read = (json) => mergeConfig(JSON.parse(json));
    const settingsWith = (features, observe) => JSON.stringify({ checks: [{ name: 'lint', run: 'pnpm lint' }, { name: 'test', run: 'pnpm test', ...(observe ? { observe: true } : {}) }], features }, null, 2);
    git(r.dir, 'switch', '-q', 'main');
    write(r.dir, 'scripts/kit.config.json', settingsWith({ testReasons: true }));
    commit(r.dir, 'Enforce');
    git(r.dir, 'switch', '-q', '-c', 'lead/modes');
    write(r.dir, 'scripts/kit.config.json', settingsWith({ testReasons: 'enforce' }));
    commit(r.dir, 'Same thing, other word');
    assert.deepEqual(r.read({ readSettings: read }).items, []);
    write(r.dir, 'scripts/kit.config.json', settingsWith({ testReasons: 'observe' }, true));
    commit(r.dir, 'Only watch');
    const out = r.read({ readSettings: read });
    assert.deepEqual(out.items.map((i) => [i.file, i.kind]), [['scripts/kit.config.json', 'check-removed']]);
    assert.equal(out.items[0].what, "the check 'test' now only watches: a failure no longer stops a merge; the switch testReasons went from enforce to observe: it now only watches");
  } finally { r.cleanup(); }
});

// ---------- Review round: a branch's own presets, kit files, sample data ----------

test('collect: a branch that takes the flaky patterns out of its own preset is still judged by the base branch patterns', () => {
  const r = repo();
  try {
    git(r.dir, 'switch', '-q', 'main');
    for (const name of ['typescript', 'any']) write(r.dir, `scripts/presets/${name}.json`, readFileSync(join(HERE, 'presets', `${name}.json`), 'utf8'));
    commit(r.dir, 'Presets');
    git(r.dir, 'switch', '-q', '-c', 'build/086-quiet');
    write(r.dir, 'scripts/presets/typescript.json', presetText('typescript', (p) => ({ ...p, flakyWorkarounds: [], skippedTests: [] })));
    write(r.dir, 'src/slow.test.ts', "it('waits', async () => {\n  await sleep(500);\n  expect(x()).toBe(1);\n});\n");
    write(r.dir, 'src/save.test.ts', JEST.replace("it('saves a word'", "it.skip('saves a word'"));
    commit(r.dir, 'Quiet the presets');
    const out = r.read({ presets: undefined, presetNames: ['typescript'], branch: 'build/086-quiet' });
    assert.equal(out.fail, undefined);
    const kinds = Object.fromEntries(out.items.map((i) => [i.file, i.kind]));
    assert.equal(kinds['src/slow.test.ts'], 'wait-added', 'the base branch flaky patterns still apply');
    assert.equal(kinds['src/save.test.ts'], 'test-skipped', 'and so do its skip patterns');
  } finally { r.cleanup(); }
});

test('collect: a whole new test file the kit manages (in the kit manifest) is free of the flaky kinds; any other is not', () => {
  const r = repo();
  try {
    const body = "test('lease ends', async () => {\n  await new Promise((r) => setTimeout(r, 25));\n  assert.equal(held(), false);\n});\n";
    write(r.dir, 'scripts/slot.test.mjs', body);
    write(r.dir, 'scripts/own.test.mjs', body);
    write(r.dir, 'scripts/kit.manifest.json', JSON.stringify({ files: { 'scripts/slot.test.mjs': 'abc', 'scripts/shared.test.mjs': 'def' } }));
    write(r.dir, 'scripts/shared.test.mjs', "import assert from 'node:assert';\nassert.equal = () => {};\n");
    commit(r.dir, 'Kit install');
    const kinds = Object.fromEntries(r.read().items.map((i) => [i.file, i.kind]));
    assert.equal(kinds['scripts/slot.test.mjs'], undefined, 'a kit file: free');
    assert.equal(kinds['scripts/own.test.mjs'], 'wait-added', 'the project\'s own file: flagged');
    assert.equal(kinds['scripts/shared.test.mjs'], 'unclear', 'a kit file is still checked for writes to shared names');
  } finally { r.cleanup(); }
});

test('sample data in a test is not a runner setting; the same keys in a test settings file are', () => {
  const sample = `${SLOW.slice(0, -4)}  it('reads a job', () => {\n    const example = { retry: 2, timeout: 5000 };\n    expect(read(example)).toBe(1);\n  });\n});\n`;
  assert.ok(sample.startsWith(SLOW.slice(0, -4)));
  assert.deepEqual(sort('src/load.test.ts', SLOW, sample), { kind: 'added', what: 'only whole new tests were added' });
  const py = `${PYTEST}\ntimeout = 300\n`;
  assert.notEqual(sort('tests/test_shop.py', PYTEST, py).kind, 'timeout-raised', 'a module value in a Python test is not a pytest setting');
});

test('collect: the kit test files copied on install pass as whole new files (backfill.test.mjs has nothing owed)', () => {
  const r = repo();
  try {
    write(r.dir, 'scripts/backfill.test.mjs', readFileSync(join(HERE, 'backfill.test.mjs'), 'utf8'));
    commit(r.dir, 'Install');
    assert.deepEqual(r.read().items, []);
  } finally { r.cleanup(); }
});

// Tests for presets.mjs. Run: node --test scripts/presets.test.mjs
// The CLI tests make a throwaway git repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPreset, compiled, loadPreset, loadPresets, presetNames, run, saveSettings, validatePreset } from './presets.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALL = presetNames(KIT).map((n) => loadPreset(KIT, n));
const byName = (name) => ALL.find((p) => p.name === name);


function repo(config) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-presets-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  cpSync(join(KIT, 'scripts/presets'), join(dir, 'scripts/presets'), { recursive: true });
  if (config) writeFileSync(join(dir, 'scripts/kit.config.json'), JSON.stringify(config));
  return dir;
}

function cli(argv, cwd) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { cwd, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { code, stdout, stderr };
}

const good = () => ({
  name: 'x', extensions: ['.x'],
  checks: [{ name: 'lint', run: 'x lint', protects: 'catches a', misses: 'cannot see b' }],
  switchOffs: [{ pattern: 'x-off', kind: 'lint', what: 'x-off comment' }],
  switchOffFiles: [{ name: 'x-ignore.json', what: 'switches x off for whole files' }],
  extraCodeExtensions: ['.xv'],
  skippedTests: [], assertions: [], testNames: [{ pattern: 'test (?<name>\\w+)', what: 'a test' }],
});

test('every shipped preset is valid, and the five named in the design exist', () => {
  assert.deepEqual(ALL.map((p) => p.name), ['any', 'python', 'rust', 'sql', 'typescript']);
  for (const p of ALL) for (const c of p.checks) assert.ok(c.protects && c.misses, `${p.name}: ${c.name}`);
});

test('lint and secret checks use the commands the kit lint settings ship, and nothing formats Markdown', () => {
  const run = (preset, check) => byName(preset).checks.find((c) => c.name === check).run;
  assert.equal(run('typescript', 'format'), 'pnpm exec prettier --check .');
  assert.equal(run('typescript', 'oxlint'), 'pnpm exec oxlint -f json . | node kit-lint/hints.mjs');
  assert.equal(run('typescript', 'eslint'), 'pnpm exec eslint -f json . | node kit-lint/hints.mjs');
  assert.equal(run('any', 'secrets'), 'gitleaks git --redact --no-banner --ignore-gitleaks-allow --config kit-lint/gitleaks.toml');
  assert.equal(run('rust', 'clippy'), 'cargo clippy --all-targets -- -D warnings -F unsafe_code', 'unsafe code is forbidden by the compiler, which an allow cannot undo, in test builds too');
  assert.deepEqual(byName('typescript').extraCodeExtensions, ['.vue', '.svelte', '.astro', '.mdx']);
  for (const p of ALL) for (const e of p.extraCodeExtensions) assert.ok(!['.json', '.md', '.yml', '.yaml', '.txt'].includes(e), `${p.name}: ${e} is data, not code`);
  assert.ok(compiled([byName('typescript')], 'switchOffs').some((r) => r.re.test('<!-- prettier-ignore -->') && r.kind === 'format'), 'the HTML comment form of prettier-ignore');
  assert.ok(!byName('rust').switchOffs.some((s) => /unsafe/.test(s.pattern)), 'no text pattern guesses at unsafe code');
  for (const p of ALL) for (const c of p.checks) assert.doesNotMatch(c.run, /\.md\b|markdown/i, `${p.name}: ${c.name}`);
  assert.deepEqual(byName('any').switchOffFiles.map((f) => f.name), ['oxlint-suppressions.json', 'eslint-suppressions.json', '.gitleaksignore', '.gitleaks.toml']);
});

test('the Squawk check fails when .sqlfluff is missing, and skips plainly when the database is not Postgres', () => {
  const squawk = byName('sql').checks.find((c) => c.name === 'squawk').run;
  const dir = mkdtempSync(join(tmpdir(), 'kit-squawk-'));
  try {
    const sh = () => spawnSync('sh', ['-c', squawk], { cwd: dir, encoding: 'utf8' });
    const missing = sh();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /\.sqlfluff is missing/);
    writeFileSync(join(dir, '.sqlfluff'), '[sqlfluff]\ndialect = sqlite\n');
    const other = sh();
    assert.equal(other.status, 0);
    assert.match(other.stdout, /not run, the database is not Postgres/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check names never repeat across presets, so two presets can be on together', () => {
  const names = ALL.flatMap((p) => p.checks.map((c) => c.name));
  assert.equal(new Set(names).size, names.length);
});

test('a bad preset is refused with the file and the field named', () => {
  const file = 'scripts/presets/x.json';
  assert.equal(validatePreset(good(), file).name, 'x');
  const cases = [
    [(d) => { delete d.checks[0].protects; }, /x\.json: "checks" entry 1: "protects" must be one line/],
    [(d) => { d.checks[0].misses = '  '; }, /"misses" must be one line/],
    [(d) => { d.checks[0].misses = 'two\nlines'; }, /"misses" must be one line/],
    [(d) => { d.checks[0].fast = 'yes'; }, /"fast" must be true or false/],
    [(d) => { d.checks[0].extra = 1; }, /unknown field "extra"/],
    [(d) => { d.checks.push({ ...d.checks[0] }); }, /two entries named "lint"/],
    [(d) => { d.switchOffs[0].pattern = '('; }, /"switchOffs" entry 1: "pattern" is not a valid regular expression/],
    [(d) => { d.switchOffs[0].kind = 'Lint Checks'; }, /"kind" must be one lowercase word/],
    [(d) => { d.testNames[0].pattern = 'test (\\w+)'; }, /"testNames" entry 1: "pattern" needs a \(\?<name>/],
    [(d) => { d.name = 'y'; }, /"name" must be "x"/],
    [(d) => { delete d.assertions; }, /missing field "assertions"/],
    [(d) => { d.extensions = ['ts']; }, /"extensions" must list file endings/],
    [(d) => { d.switchOffFiles[0].name = 'src/x-ignore.json'; }, /"switchOffFiles" entry 1: "name" must be a file name with no folder/],
    [(d) => { d.switchOffFiles[0].what = ''; }, /"switchOffFiles" entry 1: "what" must be one line/],
    [(d) => { delete d.switchOffFiles; }, /missing field "switchOffFiles"/],
    [(d) => { d.extraCodeExtensions = ['vue']; }, /"extraCodeExtensions" must list file endings/],
    [(d) => { d.extraCodeExtensions = ['.x']; }, /"extraCodeExtensions" lists "\.x", which is already in "extensions"/],
    [(d) => { d.flakyWorkarounds = {}; }, /"flakyWorkarounds" must be a list/],
    [(d) => { d.flakyWorkarounds = [{ kind: 'slow-test', pattern: 'x', what: 'y' }]; }, /"flakyWorkarounds" entry 1: "kind" must be one of wait-added, timeout-raised, retry-added/],
    [(d) => { d.flakyWorkarounds = [{ kind: 'wait-added', pattern: '(', what: 'y' }]; }, /"flakyWorkarounds" entry 1: "pattern" is not a valid regular expression/],
    [(d) => { d.flakyWorkarounds = [{ kind: 'wait-added', pattern: 'x' }]; }, /"flakyWorkarounds" entry 1: "what" must be one line/],
    [(d) => { d.flakyWorkarounds = [{ kind: 'wait-added', pattern: 'x', what: 'y', extra: 1 }]; }, /"flakyWorkarounds" entry 1 has unknown field "extra"/],
    [(d) => { d.flakyWorkarounds = [{ kind: 'wait-added', pattern: 'x', what: 'y', where: 'both' }]; }, /"flakyWorkarounds" entry 1: "where" must be "tests" or "settings"/],
    [(d) => { d.propertyTests = ''; }, /"propertyTests" must be one line of text/],
    [(d) => { d.propertyTests = ['fast-check']; }, /"propertyTests" must be one line of text/],
  ];
  for (const [change, message] of cases) {
    const d = good();
    change(d);
    assert.throws(() => validatePreset(d, file), (e) => e.message.startsWith(file) && message.test(e.message), String(message));
  }
  const both = { ...good(), propertyTests: 'fast-check', flakyWorkarounds: [{ kind: 'retry-added', pattern: 'retries: (?<value>\\d+)', what: 'retries' }] };
  assert.equal(validatePreset(both, file).propertyTests, 'fast-check', 'the two new fields are optional, and accepted when right');
});

test('propertyTests names the usual property-test library, and only where there is one', () => {
  assert.deepEqual(ALL.map((p) => [p.name, p.propertyTests ?? null]), [['any', null], ['python', 'hypothesis'], ['rust', 'proptest'], ['sql', null], ['typescript', 'fast-check']]);
});

// Each flaky-workaround pattern, tried on lines it must match (with the number it must read) and lines it must not.
// where: "tests" (a line in a test file) or "settings" (a line in a test settings file).
const flaky = (preset, line, where = 'tests') => {
  for (const e of (byName(preset).flakyWorkarounds ?? []).filter((x) => (x.where ?? where) === where)) {
    const m = new RegExp(e.pattern).exec(line);
    if (m) return [e.kind, m.groups?.value ?? null];
  }
  return null;
};

test('flaky-workaround patterns find waits, time limits, and retries, and read their numbers', () => {
  const yes = [
    ['typescript', '    await sleep(100);', 'wait-added', '100'],
    ['typescript', '    await delay(2_000);', 'wait-added', '2_000'],
    ['typescript', '    await new Promise((resolve) => setTimeout(resolve, 500));', 'wait-added', '500'],
    ['typescript', '    await new Promise(r => setTimeout(r, 50));', 'wait-added', '50'],
    ['typescript', '    await new Promise((done) => { setTimeout(done, 500); });', 'wait-added', '500'],
    ['typescript', '    test.describe.configure({ retries: 2 });', 'retry-added', '2'],
    ['typescript', '    test.describe.configure({ timeout: 90000 });', 'timeout-raised', '90000'],
    ['typescript', '    await setTimeout(250);', 'wait-added', '250'],
    ['typescript', '    await page.waitForTimeout(1000);', 'wait-added', '1000'],
    ['typescript', 'jest.setTimeout(30000);', 'timeout-raised', '30000'],
    ['typescript', 'vi.setConfig({ testTimeout: 60 * 1000 });', 'timeout-raised', '60 * 1000'],
    ['typescript', "  it('loads', { timeout: 10_000 }, async () => {", 'timeout-raised', '10_000'],
    ['typescript', "describe('io', { retry: 3 }, () => {", 'retry-added', '3'],
    ['typescript', "test(name, { timeout: 2000 }, () => {", 'timeout-raised', '2000'],
    ['typescript', '  "testTimeout": 20000,', 'timeout-raised', '20000'],
    ['typescript', '  }, 15000);', 'timeout-raised', '15000'],
    ['typescript', "it('loads', async () => { await load(); }, 15000);", 'timeout-raised', '15000'],
    ['typescript', '    this.timeout(8000);', 'timeout-raised', '8000'],
    ['typescript', '    test.setTimeout(120000);', 'timeout-raised', '120000'],
    ['typescript', '    page.setDefaultTimeout(9000);', 'timeout-raised', '9000'],
    ['typescript', 'jest.retryTimes(3);', 'retry-added', '3'],

    ['typescript', '    this.retries(2);', 'retry-added', '2'],
    ['python', '    time.sleep(0.5)', 'wait-added', '0.5'],
    ['python', '    time.sleep(.5)', 'wait-added', '.5'],
    ['python', '    await asyncio.sleep(1)', 'wait-added', '1'],
    ['python', '    sleep(2)', 'wait-added', '2'],
    ['python', '@pytest.mark.timeout(60)', 'timeout-raised', '60'],
    ['python', 'addopts = --timeout=120', 'timeout-raised', '120'],
    ['python', '@settings(deadline=None)', 'timeout-raised', 'None'],
    ['python', '@pytest.mark.flaky(reruns=3)', 'retry-added', '3'],
    ['python', '@pytest.mark.flaky', 'retry-added', null],
    ['python', '@flaky(max_runs=5)', 'retry-added', '5'],
    ['python', 'addopts = --reruns 2', 'retry-added', '2'],
    ['rust', '    thread::sleep(Duration::from_millis(100));', 'wait-added', '100'],
    ['rust', '    std::thread::sleep(std::time::Duration::from_secs(1));', 'wait-added', '1'],
    ['rust', '    tokio::time::sleep(Duration::from_millis(20)).await;', 'wait-added', '20'],
    ['rust', '    timeout(Duration::from_secs(30), work()).await.unwrap();', 'timeout-raised', '30'],
  ];
  for (const [preset, line, kind, value] of yes) assert.deepEqual(flaky(preset, line), [kind, value], line);
  // Keys that set how the runner works count only in a test settings file, where they cannot be sample data.
  const settingsOnly = [
    ['typescript', '  retries: 2,', 'retry-added', '2'],
    ['typescript', '  retry: 4,', 'retry-added', '4'],
    ['typescript', "  retries: process.env.CI ? 2 : 0,", 'retry-added', null],
    ['typescript', '  timeout: 30000,', 'timeout-raised', '30000'],
    ['python', 'timeout = 300', 'timeout-raised', '300'],
    ['python', 'reruns = 2', 'retry-added', '2'],
  ];
  for (const [preset, line, kind, value] of settingsOnly) {
    assert.deepEqual(flaky(preset, line, 'settings'), [kind, value], `${line} in a settings file`);
    assert.equal(flaky(preset, line), null, `${line} in a test file is sample data, not a setting`);
  }
  assert.deepEqual(flaky('typescript', '  testTimeout: 20000,', 'settings'), ['timeout-raised', '20000'], 'the runner\'s own key counts in a settings file too');
  const no = [
    ['typescript', '    vi.advanceTimersByTime(1000);'],
    ['typescript', '    jest.advanceTimersByTime(500);'],
    ['typescript', '    clock.tick(1000);'],
    ['typescript', '    vi.useFakeTimers();'],
    ['typescript', '    setTimeout(callback, 1000);'],
    ['typescript', '    await waitFor(() => expect(x).toBe(1));'],
    ['typescript', '    const sleepy = true;'],
    ['typescript', '    navigationTimeout: 1000,'],
    ['typescript', '    const example = { retry: 2, timeout: 5000 };'],
    ['typescript', "    expect(parse('retries: 3')).toEqual({ retries: 3 });"],
    ['typescript', '    const job = { name: "sync", timeout: 30 };'],
    ['typescript', "test('reads job', () => assert.equal(read({ retry: 2, timeout: 5000 }), 1));"],
    ['typescript', "  it('reads job', async () => { expect(await read({ timeout: 5000 })).toBe(1); });"],
    ['python', '    freezer.tick(60)'],
    ['python', '    frozen.move_to("2026-01-01")'],
    ['python', '    def timeout_for(seconds):'],
    ['python', '        timeout = 30'],
    ['rust', '    let sleepy = true;'],
    ['rust', '    tokio::time::advance(Duration::from_secs(5)).await;'],
  ];
  for (const [preset, line] of no) assert.equal(flaky(preset, line), null, line);
  assert.equal(byName('sql').flakyWorkarounds, undefined);
});

test('loadPresets gives the named presets plus "any", and names a missing preset file', () => {
  assert.deepEqual(loadPresets(KIT, { presets: ['python'] }).map((p) => p.name), ['python', 'any']);
  assert.deepEqual(loadPresets(KIT, { presets: [] }).map((p) => p.name), ['any']);
  assert.throws(() => loadPresets(KIT, { presets: ['go'] }), /scripts\/presets\/go\.json: no such preset \(known: any, python/);
});

// Each pattern list, tried on lines it must match and lines it must not.
const hits = (preset, field, line) => compiled([byName(preset)], field).filter((r) => r.re.test(line)).map((r) => r.kind ?? r.what);

test('switch-off patterns find each comment kind and miss look-alikes', () => {
  const yes = [
    ['typescript', '// eslint-disable-next-line no-console', 'lint'],
    ['typescript', '/* oxlint-disable no-debugger */', 'lint'],
    ['typescript', '// @ts-ignore', 'types'],
    ['typescript', '// @ts-expect-error the library types are wrong', 'types'],
    ['typescript', '// @ts-nocheck', 'types'],
    ['typescript', '// prettier-ignore', 'format'],
    ['typescript', '/* istanbul ignore next */', 'coverage'],
    ['typescript', '/* c8 ignore next 3 */', 'coverage'],
    ['python', 'x = 1  # noqa: E501', 'lint'],
    ['python', '# ruff: noqa', 'lint'],
    ['python', '# ruff: disable[E501]', 'lint'],
    ['python', 'y = f()  # type: ignore[attr-defined]', 'types'],
    ['python', 'y = f()  # pyrefly: ignore[bad-return]', 'types'],
    ['python', '# fmt: off', 'format'],
    ['python', 'def f():  # pragma: no cover', 'coverage'],
    ['sql', 'select * from t -- noqa: AM04', 'lint'],
    ['sql', '-- squawk-ignore ban-drop-column', 'lint'],
    ['rust', '#[allow(dead_code)]', 'lint'],
    ['rust', '#![allow(unused)]', 'lint'],
    ['rust', '#[expect(clippy::unwrap_used)]', 'lint'],
    ['any', 'const key = "abc"; // gitleaks:allow', 'secrets'],
    ['python', 'x = 1  # NOQA', 'lint'],
    ['python', 'x = 1  #noqa:E501', 'lint'],
    ['python', '# flake8: noqa', 'lint'],
    ['python', '# ruff : noqa', 'lint'],
    ['python', '#ruff:NoQA: F401', 'lint'],
    ['python', 'x = 1  # ruff: ignore[E501]', 'lint'],
    ['python', '# ruff:file-ignore[F401]', 'lint'],
    ['python', '# ruff : disable[E501]', 'lint'],
    ['python', 'y = f()  #type:ignore', 'types'],
    ['rust', '#[allow (dead_code)]', 'lint'],
    ['rust', '#[ allow(dead_code)]', 'lint'],
    ['rust', '#[cfg_attr(all(), allow(dead_code))]', 'lint'],
    ['rust', '#![cfg_attr(test, expect(unused))]', 'lint'],
  ];
  for (const [preset, line, kind] of yes) assert.deepEqual(hits(preset, 'switchOffs', line), [kind], line);
  const no = [
    ['typescript', 'const ignore = true; // ts check later'],
    ['python', 'name = "noqa_tool"'],
    ['python', 'kind = type(ignore)'],
    ['rust', 'let unsafe_mode = 1;'],
    ['rust', '#[cfg_attr(test, derive(Debug))]'],
    ['python', '# ruff: enable[E501]'],
    ['rust', '#[derive(Debug)]'],
    ['sql', 'select noqa from t'],
  ];
  for (const [preset, line] of no) assert.deepEqual(hits(preset, 'switchOffs', line), [], line);
});

test('skipped-test, assertion, and test-name patterns match the test tools', () => {
  const skipped = [
    ['typescript', "it.skip('adds', () => {})"], ['typescript', "describe.only('math', () => {})"],
    ['typescript', "xit('adds', () => {})"], ['typescript', "test('adds', { skip: true }, () => {})"],
    ['typescript', "test('adds', { todo: 'later' }, () => {})"], ['typescript', "  t.skip('no network');"],
    ['typescript', 'test["skip"]("adds", () => {})'], ['typescript', "describe['only']('math', () => {})"],
    ['typescript', 'it[`todo`]("adds")'], ['typescript', 'test [ "skipIf" ](isCI)("adds", () => {})'],
    ['typescript', 't["skip"]("no network");'], ['typescript', 'test("adds", { "skip": true }, () => {})'],
    ['python', '@pytest.mark.skip(reason="slow")'], ['python', '    pytest.skip("no db")'],
    ['python', '@unittest.expectedFailure'], ['rust', '#[ignore]'],
  ];
  for (const [preset, line] of skipped) assert.ok(hits(preset, 'skippedTests', line).length, line);
  for (const [preset, line] of [['typescript', "it('adds', () => {})"], ['typescript', 'const skip = 1;'], ['typescript', 'test["each"]([1])("adds", () => {})'], ['python', '@pytest.mark.parametrize("a", [1])'], ['rust', '#[test]']]) {
    assert.deepEqual(hits(preset, 'skippedTests', line), [], line);
  }
  const asserts = [
    ['typescript', 'expect(sum(1, 2)).toBe(3);'], ['typescript', 'assert.equal(sum(1, 2), 3);'],
    ['typescript', 'assert(ok);'], ['typescript', '  t.assert.deepEqual(a, b);'],
    ['python', '    assert total == 3'], ['python', '        self.assertEqual(a, 3)'], ['python', '    with pytest.raises(ValueError):'],
    ['rust', '    assert_eq!(sum(1, 2), 3);'], ['rust', '    assert!(ok);'], ['rust', '#[should_panic]'],
  ];
  for (const [preset, line] of asserts) assert.ok(hits(preset, 'assertions', line).length, line);
  for (const [preset, line] of [['typescript', 'const expected = 3;'], ['python', 'assertion_count = 0'], ['rust', 'let asserted = true;']]) {
    assert.deepEqual(hits(preset, 'assertions', line), [], line);
  }
  const name = (preset, line) => compiled([byName(preset)], 'testNames').map((r) => r.re.exec(line)?.groups.name).find(Boolean);
  assert.equal(name('typescript', "test('adds two numbers', () => {"), 'adds two numbers');
  assert.equal(name('typescript', 'describe.skip("math", () => {'), 'math');
  for (const form of ['xit', 'fit', 'xdescribe', 'fdescribe', 'xtest', 'test.skipIf(isCI)', 'it.runIf(process.env.DB)', 'it.each([1, 2])', 'test["skip"]', "describe['only']"]) {
    assert.equal(name('typescript', `${form}('adds two', () => {`), 'adds two', form);
  }
  assert.equal(name('typescript', "profit('not a test')"), undefined);
  assert.equal(name('typescript', "emit('not a test')"), undefined);
  assert.equal(name('python', 'def test_adds():'), 'test_adds');
  assert.equal(name('python', 'class TestMath:'), 'TestMath');
  assert.equal(name('rust', 'fn adds_two() {'), 'adds_two');
  assert.equal(name('python', 'def helper():'), undefined);
});

test('addPreset turns the preset on, adds new checks with "any", and never changes a check already there', () => {
  const mine = { name: 'test', run: 'pnpm vitest run', slot: true };
  const raw = { presets: [], checks: [mine], models: { builder: '' } };
  const { next, added, turnedOn } = addPreset(raw, byName('typescript'), byName('any'));
  assert.equal(turnedOn, true);
  assert.deepEqual(next.presets, ['typescript']);
  assert.deepEqual(next.checks[0], mine);
  assert.ok(!added.includes('test'));
  assert.deepEqual(added, ['format', 'oxlint', 'eslint', 'tsc', 'pnpm audit', 'secrets', 'switch-offs', 'ratchets']);
  assert.deepEqual(next.models, { builder: '' });
  assert.deepEqual(raw.checks, [mine], 'the input is not changed');
  const again = addPreset(next, byName('typescript'), byName('any'));
  assert.equal(again.turnedOn, false);
  assert.deepEqual(again.added, []);
});

test('CLI: list and show print the presets; wrong usage exits 2', () => {
  const dir = repo();
  try {
    const list = cli(['list'], dir);
    assert.equal(list.code, 0);
    assert.match(list.stdout, /^python {2}\.py \.pyi {2}5 checks$/m);
    const show = cli(['show', 'rust'], dir);
    assert.equal(show.code, 0);
    assert.match(show.stdout, /clippy \(fast\): cargo clippy --all-targets -- -D warnings -F unsafe_code/);
    assert.match(show.stdout, /-F unsafe_code/);
    assert.match(show.stdout, /^property tests: proptest$/m);
    assert.match(show.stdout, /^ {2}\[wait-added\] /m, 'the flaky-workaround patterns are listed');
    assert.match(cli(['show', 'sql'], dir).stdout, /^property tests: none named$/m);
    const missing = cli(['show', 'go'], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /scripts\/presets\/go\.json: no such preset/);
    assert.equal(cli(['add'], dir).code, 2);
    assert.equal(cli(['frob'], dir).code, 2);
    assert.equal(cli([], dir).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: add writes the settings once and keeps an existing check as it was', () => {
  const dir = repo({ checks: [{ name: 'test', run: 'pnpm vitest run', slot: true }] });
  try {
    const first = cli(['add', 'typescript'], dir);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /turned on preset typescript/);
    assert.match(first.stdout, /added checks: format, oxlint, eslint, tsc, pnpm audit, secrets/);
    const saved = JSON.parse(readFileSync(join(dir, 'scripts/kit.config.json'), 'utf8'));
    assert.deepEqual(saved.presets, ['typescript']);
    assert.deepEqual(saved.checks[0], { name: 'test', run: 'pnpm vitest run', slot: true });
    const second = cli(['add', 'typescript'], dir);
    assert.equal(second.code, 0);
    assert.match(second.stdout, /nothing changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: add with a bad preset file names it and leaves the settings alone', () => {
  const dir = repo({ checks: [] });
  const before = readFileSync(join(dir, 'scripts/kit.config.json'), 'utf8');
  try {
    const bad = JSON.parse(readFileSync(join(dir, 'scripts/presets/sql.json'), 'utf8'));
    bad.checks[0].name = 'rules';
    bad.checks[0].run = '';
    writeFileSync(join(dir, 'scripts/presets/sql.json'), JSON.stringify(bad));
    const r = cli(['add', 'sql'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /sql\.json: "checks" entry 1: "run" must be one line/);
    assert.equal(readFileSync(join(dir, 'scripts/kit.config.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveSettings writes nothing when the settings checker refuses the new settings', () => {
  const dir = repo({ checks: [] });
  const path = join(dir, 'scripts/kit.config.json');
  const before = readFileSync(path, 'utf8');
  try {
    const refuse = () => {
      throw new Error('scripts/kit.config.json: "checks" entry 1 has unknown key "x"');
    };
    assert.throws(() => saveSettings(path, { checks: [{ name: 'a', run: 'b', x: 1 }] }, refuse), /the settings checker refuses the new settings, so nothing was written: .*unknown key "x"/);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.throws(() => saveSettings(path, { checks: [{ name: 'a', run: 'b', x: 1 }] }), /unknown key "x"/, 'the real checker is used by default');
    assert.equal(readFileSync(path, 'utf8'), before);
    saveSettings(path, { checks: [{ name: 'a', run: 'b', fast: true, protects: 'p', misses: 'm' }] });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).checks[0].protects, 'p');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatStdin: the one field a preset may leave out; when present it is one line of text; TypeScript and Python ship one, Rust does not', () => {
  const base = () => JSON.parse(JSON.stringify(loadPreset(KIT, 'typescript')));
  assert.equal(validatePreset(base(), 'scripts/presets/typescript.json').formatStdin, 'pnpm exec prettier --stdin-filepath {file}');
  const without = base();
  delete without.formatStdin;
  assert.equal(validatePreset(without, 'scripts/presets/typescript.json').formatStdin, undefined);
  for (const bad of ['', '   ', 7, 'two\nlines', ['prettier']]) {
    assert.throws(() => validatePreset({ ...base(), formatStdin: bad }, 'scripts/presets/typescript.json'), /"formatStdin" must be one line of text/, JSON.stringify(bad));
  }
  assert.equal(loadPreset(KIT, 'python').formatStdin, 'uv run ruff format --stdin-filename {file} -');
  assert.equal('formatStdin' in loadPreset(KIT, 'rust'), false);
});

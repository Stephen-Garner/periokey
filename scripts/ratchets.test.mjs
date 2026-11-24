// Tests for ratchets.mjs. Run: node --test scripts/ratchets.test.mjs
// Each CLI test makes a throwaway git repo (and a bare "origin" beside it) in the temp folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATCHETS_FILE, compare, countUseEffect, filesToName, lowered, parseRatchets, raisedOverBase, run } from './ratchets.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = { presets: ['typescript'], productPaths: ['src/'], notYetClean: ['src/old/'] };

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
}

// A project with an "origin" remote whose main holds the same first commit.
function repo(files) {
  const top = mkdtempSync(join(tmpdir(), 'kit-ratchets-'));
  const dir = join(top, 'work');
  mkdirSync(dir);
  git(top, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', join(top, 'origin.git'));
  cpSync(join(KIT, 'scripts/presets'), join(dir, 'scripts/presets'), { recursive: true });
  write(dir, { 'scripts/kit.config.json': SETTINGS, ...files });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  git(dir, 'push', '-q', 'origin', 'main');
  return { dir, done: () => rmSync(top, { recursive: true, force: true }) };
}

function push(dir) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'more');
  git(dir, 'push', '-q', 'origin', 'main');
}

function cli(argv, cwd, io = {}) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { cwd, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, ...io });
  return { code, stdout, stderr };
}

const saved = (dir) => JSON.parse(readFileSync(join(dir, RATCHETS_FILE), 'utf8'));

test('parseRatchets checks the file and names the bad part', () => {
  assert.deepEqual(parseRatchets(null), { counts: {}, counters: [] });
  assert.deepEqual(parseRatchets('{"counts":{"a":2}}').counts, { a: 2 });
  for (const [text, message] of [
    ['nope', /not valid JSON/],
    ['{"extra":1}', /unknown key "extra"/],
    ['{"counts":{"a":-1}}', /count "a" must be a whole number/],
    ['{"counts":{"a":1.5}}', /count "a" must be a whole number/],
    ['{"counters":[{"name":"x"}]}', /"counters" entry 1 needs a "name" and a "run"/],
    ['{"counters":[{"name":"x","run":"echo 1","needs":"a"}]}', /"needs" must list paths/],
    ['{"counters":[{"name":"useEffect uses","run":"echo 1"}]}', /already taken/],
    ['{"counters":[{"name":"switch-offs lint","run":"echo 1"}]}', /already taken/],
  ]) assert.throws(() => parseRatchets(text), message, text);
});

test('compare sorts counts into above, below, and not saved yet', () => {
  const r = compare({ a: 2, b: 5, c: 1 }, { a: { total: 3, files: { 'x.ts': 3 } }, b: { total: 4 }, c: { total: 1 }, d: { total: 7 } });
  assert.deepEqual(r.above, [{ name: 'a', saved: 2, now: 3, files: { 'x.ts': 3 } }]);
  assert.deepEqual(r.below, [{ name: 'b', saved: 5, now: 4 }]);
  assert.deepEqual(r.unsaved, [{ name: 'd', now: 7 }]);
});

test('lowered only lowers, and saves a missing count as today', () => {
  assert.deepEqual(lowered({ a: 2, b: 5 }, { a: { total: 9 }, b: { total: 4 }, c: { total: 0 } }), { a: 2, b: 4, c: 0 });
});

test('raisedOverBase catches a number raised by hand and a count removed', () => {
  assert.deepEqual(raisedOverBase({ a: 3, b: 1 }, { a: 2, b: 1, c: 4 }), [{ name: 'a', saved: 3, base: 2 }, { name: 'c', saved: null, base: 4 }]);
  assert.deepEqual(raisedOverBase({ a: 1 }, { a: 2 }), []);
});

test('filesToName names the changed files when any hold the count, else the biggest', () => {
  const files = { 'a.ts': 1, 'b.ts': 4, 'c.ts': 2 };
  assert.deepEqual(filesToName(files, new Set(['c.ts'])), ['c.ts (2)']);
  assert.deepEqual(filesToName(files, new Set()), ['b.ts (4)', 'c.ts (2)', 'a.ts (1)']);
});

test('CLI: the useEffect count reads code files only, not data that mentions it', () => {
  const { dir, done } = repo({ 'src/view.tsx': 'useEffect(() => {});\n', 'src/help.json': '{"tip": "avoid useEffect() here"}\n', 'src/notes.md': 'useEffect() is rare\n' });
  try {
    cli(['update'], dir);
    assert.equal(saved(dir).counts['useEffect uses'], 1);
  } finally {
    done();
  }
});

test('countUseEffect counts each call, React.useEffect too', () => {
  const texts = { 'a.tsx': 'useEffect(() => {});\nReact.useEffect (() => {});\n', 'b.tsx': 'const useEffectLike = 1;\n' };
  assert.deepEqual(countUseEffect(Object.keys(texts), (f) => texts[f]), { total: 2, files: { 'a.tsx': 2 } });
});

const FILES = {
  'src/a.ts': '// eslint-disable-next-line\nexport const a = 1;\n',
  'src/a.test.ts': '// @ts-expect-error bad call on purpose\nf(1);\n',
  'src/view.tsx': 'useEffect(() => {});\n',
  'src/old/view.tsx': 'useEffect(() => {});\n',
  'src/view.test.tsx': 'useEffect(() => {});\n',
};

test('CLI: update saves today, check passes, a new switch-off fails with its file, and update never raises', () => {
  const { dir, done } = repo(FILES);
  try {
    const first = cli(['update'], dir);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /switch-offs lint: saved as 1/);
    const counts = saved(dir).counts;
    assert.equal(counts['switch-offs lint'], 1);
    assert.equal(counts['switch-offs types'], 1, 'tests are counted');
    assert.equal(counts['useEffect uses'], 2, 'notYetClean counted, tests left out');
    assert.match(cli(['update'], dir).stdout, /nothing to lower/);
    assert.equal(cli(['check'], dir).code, 0);
    push(dir);

    write(dir, { 'src/b.ts': '// oxlint-disable\n// eslint-disable\nexport const b = 1;\n' });
    git(dir, 'add', 'src/b.ts');
    const bad = cli(['check'], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /switch-offs lint: 3 now, saved 1\. Remove the new ones\. In: src\/b\.ts \(2\)/);
    const up = cli(['update'], dir);
    assert.equal(up.code, 1);
    assert.match(up.stdout, /never raises/);
    assert.equal(saved(dir).counts['switch-offs lint'], 1);

    rmSync(join(dir, 'src/b.ts'));
    rmSync(join(dir, 'src/a.ts'));
    git(dir, 'add', '-A');
    const down = cli(['check'], dir);
    assert.equal(down.code, 0);
    assert.match(down.stdout, /switch-offs lint: down from 1 to 0\. Run node scripts\/ratchets\.mjs update/);
    assert.match(cli(['update'], dir).stdout, /switch-offs lint: lowered from 1 to 0/);
    assert.equal(saved(dir).counts['switch-offs lint'], 0);
  } finally {
    done();
  }
});

test('CLI: a number raised by hand, or a count removed, is refused against the base branch copy', () => {
  const { dir, done } = repo(FILES);
  try {
    cli(['update'], dir);
    push(dir);
    const file = saved(dir);
    file.counts['switch-offs lint'] = 5;
    write(dir, { [RATCHETS_FILE]: file });
    const raised = cli(['check'], dir);
    assert.equal(raised.code, 1);
    assert.match(raised.stdout, /switch-offs lint: saved as 5 here but 1 on origin\/main\. Raising a ratchet is a weakening/);
    delete file.counts['switch-offs lint'];
    write(dir, { [RATCHETS_FILE]: file });
    const removed = cli(['check'], dir);
    assert.equal(removed.code, 1);
    assert.match(removed.stdout, /switch-offs lint: removed from kit\.ratchets\.json, but origin\/main saves it as 1/);
    rmSync(join(dir, RATCHETS_FILE));
    assert.equal(cli(['check'], dir).code, 1, 'deleting the whole file is refused too');
  } finally {
    done();
  }
});

test('CLI: with features.testReasons on, a raise over the base is a note (the merge script rules on it), but a real count over the saved one still fails', () => {
  const { dir, done } = repo(FILES);
  try {
    cli(['update'], dir);
    write(dir, { 'scripts/kit.config.json': { ...SETTINGS, features: { testReasons: true } } });
    push(dir);
    const file = saved(dir);
    file.counts['switch-offs lint'] = 5;
    write(dir, { [RATCHETS_FILE]: file });
    const raised = cli(['check'], dir);
    assert.equal(raised.code, 0, raised.stdout + raised.stderr);
    assert.match(raised.stdout, /Note: switch-offs lint is saved as 5 here but 1 on origin\/main\. That raise needs a reason line and a reviewer's ruling before it can merge; node scripts\/test-changes\.mjs shows the line to add\./);
    write(dir, { 'src/b.ts': Array(5).fill('// eslint-disable\n').join('') });
    git(dir, 'add', 'src/b.ts');
    const over = cli(['check'], dir);
    assert.equal(over.code, 1);
    assert.match(over.stdout, /switch-offs lint: 6 now, saved 5/);
  } finally {
    done();
  }
});

test('CLI: a count with no saved number fails and says to run update once', () => {
  const { dir, done } = repo(FILES);
  try {
    const none = cli(['check'], dir);
    assert.equal(none.code, 1, 'no ratchets file at all');
    assert.match(none.stdout, /switch-offs lint: no saved number\. Run node scripts\/ratchets\.mjs update once to save today's counts\./);
    write(dir, { [RATCHETS_FILE]: { counts: { 'switch-offs types': 1, 'useEffect uses': 2 }, counters: [] } });
    const some = cli(['check'], dir);
    assert.equal(some.code, 1);
    assert.match(some.stdout, /switch-offs lint: no saved number/);
    assert.doesNotMatch(some.stdout, /switch-offs types: no saved number/);
    cli(['update'], dir);
    assert.equal(cli(['check'], dir).code, 0);
  } finally {
    done();
  }
});

test('CLI: while the base branch has no ratchets file, update sets the real counts, raises included (the setup for a project that already has code)', () => {
  const zero = { 'switch-offs lint': 0, 'useEffect uses': 0 };
  const { dir, done } = repo(FILES);
  try {
    write(dir, { [RATCHETS_FILE]: { counts: zero, counters: [] } });
    assert.equal(cli(['check'], dir).code, 1, 'the starting zeros are below the real counts');
    const up = cli(['update'], dir);
    assert.equal(up.code, 0, up.stdout);
    assert.match(up.stdout, /switch-offs lint: set to 1 \(origin\/main has no kit\.ratchets\.json yet\)/);
    assert.equal(saved(dir).counts['switch-offs lint'], 1);
    assert.equal(saved(dir).counts['useEffect uses'], 2);
    push(dir);
    write(dir, { 'src/b.ts': '// eslint-disable\n' });
    git(dir, 'add', 'src/b.ts');
    assert.equal(cli(['update'], dir).code, 1, 'once the base has the file, update never raises');
    assert.equal(saved(dir).counts['switch-offs lint'], 1);
  } finally {
    done();
  }
});

test('CLI: a new project saved at zero fails on its first switch-off', () => {
  const zero = { 'switch-offs coverage': 0, 'switch-offs format': 0, 'switch-offs lint': 0, 'switch-offs secrets': 0, 'switch-offs types': 0, 'useEffect uses': 0 };
  const { dir, done } = repo({ 'src/clean.ts': 'export const c = 1;\n', [RATCHETS_FILE]: { counts: zero, counters: [] } });
  try {
    assert.equal(cli(['check'], dir).code, 0);
    write(dir, { 'src/b.ts': '// eslint-disable\n' });
    git(dir, 'add', 'src/b.ts');
    const r = cli(['check'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /switch-offs lint: 1 now, saved 0/);
  } finally {
    done();
  }
});

test('CLI: removing a counter that the base branch has is refused, or a note with testReasons on', () => {
  const counters = [{ name: 'sevens', run: 'echo 7' }];
  const { dir, done } = repo({ ...FILES, [RATCHETS_FILE]: { counts: {}, counters } });
  try {
    cli(['update'], dir);
    push(dir);
    const kept = saved(dir);
    write(dir, { [RATCHETS_FILE]: { counts: kept.counts, counters: [] } });
    const off = cli(['check'], dir);
    assert.equal(off.code, 1, 'the saved number is still there, but the counter is gone');
    assert.match(off.stdout, /counter sevens: removed from kit\.ratchets\.json, but origin\/main has it\. Raising a ratchet is a weakening/);
    const { sevens, ...rest } = kept.counts;
    assert.equal(sevens, 7);
    write(dir, { [RATCHETS_FILE]: { counts: rest, counters: [] } });
    assert.equal(cli(['check'], dir).code, 1, 'counter and saved number both gone');
    write(dir, { 'scripts/kit.config.json': { ...SETTINGS, features: { testReasons: true } } });
    const on = cli(['check'], dir);
    assert.equal(on.code, 0, on.stdout);
    assert.match(on.stdout, /Note: counter sevens is on origin\/main but removed here\. That needs a reason line and a reviewer's ruling before it can merge; node scripts\/test-changes\.mjs shows the line to add\./);
  } finally {
    done();
  }
});

test('CLI: counters run with --all and update, are "not set up" when a needed path is missing, and fail loud on bad output', () => {
  const counters = [
    { name: 'sevens', run: 'echo 7' },
    { name: 'flag groups', run: 'exit 1', needs: ['kit-lint/eslint.base.mjs'] },
  ];
  const { dir, done } = repo({ ...FILES, [RATCHETS_FILE]: { counts: {}, counters } });
  try {
    const up = cli(['update'], dir);
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /flag groups: not set up \(missing kit-lint\/eslint\.base\.mjs\)/);
    assert.equal(saved(dir).counts.sevens, 7);
    assert.ok(!('flag groups' in saved(dir).counts));
    assert.deepEqual(saved(dir).counters, counters, 'update keeps the counters list');

    write(dir, { [RATCHETS_FILE]: { counts: { ...saved(dir).counts, sevens: 6 }, counters } });
    assert.equal(cli(['check'], dir).code, 0, 'plain check does not run counters');
    const all = cli(['check', '--all'], dir);
    assert.equal(all.code, 1);
    assert.match(all.stdout, /sevens: 7 now, saved 6/);

    write(dir, { [RATCHETS_FILE]: { counts: {}, counters: [{ name: 'junk', run: 'echo lots' }] } });
    const junk = cli(['check', '--all'], dir);
    assert.equal(junk.code, 1);
    assert.match(junk.stderr, /counter "junk" printed "lots" instead of a whole number/);
  } finally {
    done();
  }
});

test('CLI: show prints the saved counts, as JSON too; wrong usage exits 2', () => {
  const { dir, done } = repo({ [RATCHETS_FILE]: { counts: { 'useEffect uses': 3 }, counters: [{ name: 'n', run: 'echo 1' }] } });
  try {
    assert.match(cli(['show'], dir).stdout, /^useEffect uses {2}3$/m);
    assert.deepEqual(JSON.parse(cli(['show', '--json'], dir).stdout), { counts: { 'useEffect uses': 3 }, counters: [{ name: 'n', run: 'echo 1' }] });
    assert.equal(cli([], dir).code, 2);
    assert.equal(cli(['check', '--json'], dir).code, 2);
    assert.equal(cli(['update', '--all'], dir).code, 2);
  } finally {
    done();
  }
});


test('CLI: testReasons as true or "enforce" leaves a raise to review; "observe" or off refuses it, since only an enforcing gate asks for a ruling', () => {
  const { dir, done } = repo(FILES);
  try {
    cli(['update'], dir);
    push(dir);
    const file = saved(dir);
    file.counts['switch-offs lint'] = 5;
    write(dir, { [RATCHETS_FILE]: file });
    for (const [mode, code] of [[true, 0], ['enforce', 0], ['observe', 1], ['off', 1], [false, 1]]) {
      write(dir, { 'scripts/kit.config.json': { ...SETTINGS, features: { testReasons: mode } } });
      const r = cli(['check'], dir);
      assert.equal(r.code, code, `testReasons ${JSON.stringify(mode)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, code === 0 ? /^Note: switch-offs lint is saved as 5/m : /Raising a ratchet is a weakening/);
    }
  } finally {
    done();
  }
});

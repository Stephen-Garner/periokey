// Tests for checklist.mjs. Run: node --test scripts/checklist.test.mjs
// The git tests make a throwaway repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKLIST_FILE, CHECKLIST_MARKER, checklistFor, matchItems, parseChecklist, pathMatches, run } from './checklist.mjs';

const table = (...rows) => `# Change checklist\n\n${CHECKLIST_MARKER}\n\n| Id | When the change touches | Check this | Why |\n|---|---|---|---|\n${rows.join('\n')}\n`;
const STORAGE = '| CL-1 | `src/storage/**` and adds "version" | Old saved data still loads | The March outage |';
const API = '| CL-2 | `src/api/`, `src/routes/*.ts` | Every new route checks who is calling | Pull request 41 |';
const item = (paths, adds = null) => ({ id: 'CL-9', paths, adds, check: 'c', why: 'w', line: 1, when: '' });

// ---------- parseChecklist ----------

test('a file without the format line is left alone: no items and no problems, whatever it holds', () => {
  const text = '# Our old checklist\n\n| Id | Something |\n|---|---|\n| nonsense | row |\n';
  assert.deepEqual(parseChecklist(text), { marker: false, items: [], problems: [] });
  assert.deepEqual(parseChecklist(''), { marker: false, items: [], problems: [] });
});

test('a format line inside an HTML comment does not switch the file on', () => {
  assert.equal(parseChecklist(`<!-- ${CHECKLIST_MARKER} -->\n| bad | row |\n`).marker, false);
});

test('each row becomes an item with its id, paths, added text, check, why, and line number', () => {
  const { marker, items, problems } = parseChecklist(table(STORAGE, API));
  assert.equal(marker, true);
  assert.deepEqual(problems, []);
  assert.deepEqual(items, [
    { id: 'CL-1', paths: ['src/storage/**'], adds: 'version', check: 'Old saved data still loads', why: 'The March outage', line: 7, when: '`src/storage/**` and adds "version"' },
    { id: 'CL-2', paths: ['src/api/', 'src/routes/*.ts'], adds: null, check: 'Every new route checks who is calling', why: 'Pull request 41', line: 8, when: '`src/api/`, `src/routes/*.ts`' },
  ]);
});

test('the header row is not an item, a row in a comment is not read, and an id may sit in backticks', () => {
  const { items, problems } = parseChecklist(table('<!-- | CL-7 | `a` | hidden | hidden | -->', '| `CL-3` | `a.txt` | Check it | A reason |'));
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((i) => [i.id, i.line]), [['CL-3', 8]]);
});

test('a "|" inside a cell is written "\\|" and comes out as a plain "|"', () => {
  const { items, problems } = parseChecklist(table('| CL-1 | `src/**` and adds "a \\| b" | Check the pipe | Reason here |'));
  assert.deepEqual(problems, []);
  assert.equal(items[0].adds, 'a | b');
});

test('a row that breaks the shape is a problem with its line, and is not an item', () => {
  const bad = (row, want) => {
    const { items, problems } = parseChecklist(table(row));
    assert.deepEqual(items, [], row);
    assert.equal(problems.length, 1, `${row} -> ${problems.join(' / ')}`);
    assert.match(problems[0], new RegExp(`^${CHECKLIST_FILE.replace(/[.]/g, '\\.')}:7: `));
    assert.match(problems[0], want);
  };
  bad('| CL-1 | `src/` | Check it |', /needs 4 cells.*has 3/);
  bad('| C-1 | `src/` | Check it | Why |', /the id "C-1" must look like CL-1/);
  bad('| CL-0 | `src/` | Check it | Why |', /must look like CL-1/);
  bad('| CL-1 | src/storage | Check it | Why |', /cannot be read.*backticks/);
  bad('| CL-1 | `src/` and adds version | Check it | Why |', /cannot be read/);
  bad('| CL-1 | `src/` and adds "" | Check it | Why |', /cannot be read/);
  bad('| CL-1 | `src/` or `lib/` | Check it | Why |', /cannot be read/);
  bad('| CL-1 | `/src/` | Check it | Why |', /must start at the top folder/);
  bad('| CL-1 | `./src/` | Check it | Why |', /must start at the top folder/);
  bad('| CL-1 | `src/` |  | Why |', /"Check this" cell of CL-1 is empty/);
  bad('| CL-1 | `src/` | Check it |  |', /"Why" cell of CL-1 is empty/);
});

test('the one grammar: what the trigger cell may and may not hold', () => {
  const read = (when) => parseChecklist(table(`| CL-1 | ${when} | Check it | Why |`));
  // Accepted.
  for (const [when, paths, adds] of [
    ['`src/`', ['src/'], null],
    ['`src/`,`lib/`', ['src/', 'lib/'], null],
    ['`src/` , `lib/`', ['src/', 'lib/'], null],
    ['` src/ `', ['src/'], null],
    ['`src/`  and adds "a version, or two"', ['src/'], 'a version, or two'],
    ['`src/` and adds "a \\| b"', ['src/'], 'a | b'],
  ]) {
    const { items, problems } = read(when);
    assert.deepEqual(problems, [], when);
    assert.deepEqual([items[0].paths, items[0].adds], [paths, adds], when);
  }
  // Refused: each is a problem, and the row is not an item.
  for (const when of [
    '`src/` or `lib/`', '`src/` and `lib/`', '`src/` `lib/`', '`src/`; `lib/`', 'src/', '`src/`,', ', `src/`', '` `', '``',
    '`src/` and adds version', "`src/` and adds 'version'", '`src/` and adds ""', '`src/` and adds " "', '`src/` and adds "a" b"', '`src/` and adds "a" and adds "b"',
    '`src/` AND ADDS "version"', '`src/` adds "version"', '`src/` and adds "version" too', 'and adds "version"',
  ]) {
    const { items, problems } = read(when);
    assert.deepEqual(items, [], when);
    assert.equal(problems.length, 1, when);
  }
});

test('only a last "|" that is not escaped closes the row', () => {
  const { items, problems } = parseChecklist(table('| CL-1 | `src/` | Check it | Why a \\|', '| CL-2 | `lib/` | Check it | No bar at the end'));
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((i) => i.why), ['Why a |', 'No bar at the end']);
});

test('an id used twice is a problem; the first row keeps the id', () => {
  const { items, problems } = parseChecklist(table(STORAGE, '| CL-1 | `docs/` | Another check | Another why |'));
  assert.deepEqual(items.map((i) => i.check), ['Old saved data still loads']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /:8: CL-1 is used twice/);
});

// ---------- pathMatches and matchItems ----------

test('* stays inside one folder', () => {
  assert.equal(pathMatches('src/*.ts', 'src/a.ts'), true);
  assert.equal(pathMatches('src/*.ts', 'src/api/a.ts'), false);
  assert.equal(pathMatches('src/*.ts', 'src/a.tsx'), false);
  assert.equal(pathMatches('*.sql', 'db/a.sql'), false);
});

test('** crosses folders, and "**/" also fits no folder at all', () => {
  assert.equal(pathMatches('src/storage/**', 'src/storage/a/b/c.ts'), true);
  assert.equal(pathMatches('src/storage/**', 'src/storage.ts'), false);
  assert.equal(pathMatches('src/**/index.ts', 'src/index.ts'), true);
  assert.equal(pathMatches('src/**/index.ts', 'src/a/b/index.ts'), true);
  assert.equal(pathMatches('src/**/index.ts', 'lib/index.ts'), false);
  assert.equal(pathMatches('**/*.sql', 'a.sql'), true);
  assert.equal(pathMatches('**/*.sql', 'db/old/a.sql'), true);
});

test('a last "/" means the whole folder, and a pattern with no star is that one file', () => {
  assert.equal(pathMatches('src/storage/', 'src/storage/deep/a.ts'), true);
  assert.equal(pathMatches('src/storage/', 'src/storage-old/a.ts'), false);
  assert.equal(pathMatches('package.json', 'package.json'), true);
  assert.equal(pathMatches('package.json', 'web/package.json'), false);
  assert.equal(pathMatches('a.ts', 'abts'), false, 'a dot is a dot, not any character');
});

test('an item fits when any of its patterns fits a changed file', () => {
  const items = [item(['src/api/', 'src/routes/*.ts'])];
  assert.equal(matchItems(items, { files: ['README.md', 'src/routes/home.ts'] }).length, 1);
  assert.equal(matchItems(items, { files: ['README.md', 'src/app.ts'] }).length, 0);
  assert.equal(matchItems(items, { files: [] }).length, 0);
});

test('and adds "text" needs an added line that holds the text, in a file the patterns fit', () => {
  const items = [item(['src/storage/**'], 'version')];
  const files = ['src/storage/save.ts', 'src/app.ts'];
  assert.equal(matchItems(items, { files, addedLines: { 'src/storage/save.ts': ['const version = 2;'] } }).length, 1);
  assert.equal(matchItems(items, { files, addedLines: { 'src/storage/save.ts': ['const SCHEMA_VERSION = 2;'] } }).length, 1, 'capital letters do not matter');
  assert.equal(matchItems(items, { files, addedLines: { 'src/storage/save.ts': ['const size = 2;'] } }).length, 0, 'no added line holds the text');
  assert.equal(matchItems(items, { files, addedLines: { 'src/app.ts': ['const version = 2;'] } }).length, 0, 'the text was added in a file outside the patterns');
  assert.equal(matchItems(items, { files }).length, 0, 'the path alone is not enough');
});

// ---------- checklistFor and the command line, with real git ----------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo(checklist = table(STORAGE, API)) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-checklist-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
  const write = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const commit = (message) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-verify', '-m', message);
  };
  write('README.md', 'A project.\n');
  write('src/storage/save.ts', 'export const save = 1;\nconst version = 1;\n');
  if (checklist !== null) write(CHECKLIST_FILE, checklist);
  commit('Start');
  git(dir, 'checkout', '-q', '-b', 'build/001-x');
  const cli = (...argv) => {
    let stdout = '';
    let stderr = '';
    const code = run(argv, { cwd: dir, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
    return { code, stdout, stderr };
  };
  return { dir, write, commit, cli, git: (...args) => git(dir, ...args), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const ids = (list) => list.map((i) => i.id);

test('a row fits by path, read from what the branch changed since it left the base', () => {
  const r = repo();
  try {
    r.write('src/api/users.ts', 'export const users = [];\n');
    r.commit('Add an api file');
    // The base branch moves on in another folder: that is not this branch's change.
    r.git('checkout', '-q', 'main');
    r.write('src/storage/save.ts', 'export const save = 1;\nconst version = 2;\n');
    r.commit('Main changes storage');
    r.git('checkout', '-q', 'build/001-x');
    const found = checklistFor(r.dir, { base: 'main', branch: 'build/001-x' });
    assert.equal(found.present, true);
    assert.deepEqual(ids(found.items), ['CL-1', 'CL-2']);
    assert.deepEqual(ids(found.matched), ['CL-2']);
    assert.deepEqual(found.problems, []);
  } finally {
    r.cleanup();
  }
});

test('and adds "text" reads only the lines the branch added, not removed or untouched ones', () => {
  const r = repo();
  try {
    // "version" is on an old line of this file. A new line without the word does not fit the row.
    r.write('src/storage/save.ts', 'export const save = 1;\nconst version = 1;\nconst size = 3;\n');
    r.commit('Add a line');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), []);
    // Removing the line that holds the word does not fit either.
    r.write('src/storage/save.ts', 'export const save = 1;\nconst size = 3;\n');
    r.commit('Remove the old line');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), []);
    // Adding a line that holds it does.
    r.write('src/storage/save.ts', 'export const save = 1;\nconst size = 3;\nconst dataVersion = 2;\n');
    r.commit('Add the word');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), ['CL-1']);
  } finally {
    r.cleanup();
  }
});

test('the file\'s own name in git\'s header lines is not an added line', () => {
  const r = repo(table('| CL-6 | `src/storage/**` and adds "save.ts" | The import still resolves | A reason |'));
  try {
    r.write('src/storage/save.ts', 'export const save = 1;\nconst version = 1;\nconst size = 3;\n');
    r.commit('Add a line that does not hold the text');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), []);
    r.write('src/storage/save.ts', 'export const save = 1;\nconst version = 1;\nconst size = 3;\n// see save.ts\n');
    r.commit('Add a line that holds it');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), ['CL-6']);
  } finally {
    r.cleanup();
  }
});

test('the branch\'s git attributes and git settings cannot hide an added line', () => {
  const row = '| CL-8 | `src/` and adds "version" | Old data still loads | A reason |';
  const hide = [
    ['.gitattributes', 'src/*.js -diff\n'],
    ['.gitattributes', 'src/*.js binary\n'],
    ['.gitattributes', 'src/*.js diff=hide\n'],
    ['src/.gitattributes', '*.js -text -diff\n'],
  ];
  for (const [file, text] of hide) {
    const r = repo(table(row));
    try {
      r.git('config', 'diff.hide.textconv', 'true');
      r.git('config', 'diff.hide.binary', 'true');
      r.git('config', 'diff.external', 'true');
      r.git('config', 'diff.noprefix', 'true');
      r.write(file, text);
      r.write('src/a.js', 'const version = 1;\n');
      r.commit('Add the word and hide it');
      assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), ['CL-8'], `${file}: ${text.trim()}`);
    } finally {
      r.cleanup();
    }
  }
});

test('a renamed file, a file whose mode changed, and a very long line are read rightly', () => {
  const r = repo(table('| CL-8 | `src/` and adds "version" | Old data still loads | A reason |'));
  try {
    // A mode change alone adds no line, though the file holds the word on an old line.
    r.git('update-index', '--chmod=+x', 'src/storage/save.ts');
    r.git('commit', '-q', '--no-verify', '-m', 'Make it runnable');
    const mode = checklistFor(r.dir, { base: 'main' });
    assert.deepEqual(ids(mode.matched), []);
    // A line of 300,000 characters with the word at its end is still an added line.
    r.write('src/long.js', `${'x'.repeat(300000)} version\n`);
    r.commit('A very long line');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), ['CL-8']);
  } finally {
    r.cleanup();
  }
  // A file moved into the folder is new there: every line of it counts as added under its new name.
  const moved = repo(table('| CL-8 | `src/` and adds "version" | Old data still loads | A reason |'));
  try {
    moved.git('checkout', '-q', 'main');
    moved.write('lib/old.js', 'const version = 1;\nconst other = 2;\n');
    moved.commit('A file outside src');
    moved.git('checkout', '-q', '-B', 'build/001-x', 'main');
    moved.git('mv', 'lib/old.js', 'src/new.js');
    moved.commit('Move it into src');
    assert.deepEqual(ids(checklistFor(moved.dir, { base: 'main' }).matched), ['CL-8']);
  } finally {
    moved.cleanup();
  }
});

test('a line that was only moved, or that the file already held as many times, is not an added line', () => {
  const r = repo(table('| CL-8 | `src/` and adds "version" | Old data still loads | A reason |'));
  try {
    r.write('src/storage/save.ts', 'const version = 1;\nexport const save = 1;\n');
    r.commit('Swap two lines');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), []);
    r.write('src/storage/save.ts', 'const version = 1;\nexport const save = 1;\nconst version = 1;\n');
    r.commit('Add the same line a second time');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), ['CL-8']);
  } finally {
    r.cleanup();
  }
});

test('a file named like a built-in part of every object (constructor, __proto__, toString) is read like any other', () => {
  const names = ['constructor', '__proto__', 'toString'];
  // matchItems: a file with no added lines listed has none, whatever its name.
  for (const name of names) {
    const items = [item([name], 'version')];
    assert.deepEqual(matchItems(items, { files: [name], addedLines: {} }), [], name);
    assert.deepEqual(matchItems(items, { files: [name] }), [], name);
    assert.equal(matchItems(items, { files: [name], addedLines: JSON.parse(`{ "${name}": ["version 1"] }`) }).length, 1, name);
    assert.deepEqual(matchItems(items, { files: [name], addedLines: JSON.parse(`{ "${name}": ["size 1"] }`) }), [], name);
  }
  // With real git: each row fits only once its own file gains the text.
  const rows = names.map((name, i) => `| CL-${i + 1} | \`${name}\` and adds "version" | Check ${name} | A reason |`);
  const r = repo(table(...rows));
  try {
    for (const name of names) r.write(name, 'size 1\n');
    r.commit('Add the three files without the text');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), []);
    names.forEach((name, i) => {
      r.write(name, 'size 1\nversion 1\n');
      r.commit(`Add the text to ${name}`);
      assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), names.slice(0, i + 1).map((_, k) => `CL-${k + 1}`), name);
    });
    const res = r.cli();
    assert.equal(res.code, 0);
    assert.equal(res.stderr, '');
    assert.equal(res.stdout, 'kit-checklist CL-1 Check constructor\nkit-checklist CL-2 Check __proto__\nkit-checklist CL-3 Check toString\n');
  } finally {
    r.cleanup();
  }
});

test('a deleted file counts as touched, and work that is not committed is not read', () => {
  const r = repo(table('| CL-4 | `src/storage/` | Nothing still reads the file | A reason |'));
  try {
    r.write('src/storage/extra.ts', 'not committed\n');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), []);
    rmSync(join(r.dir, 'src/storage/extra.ts'));
    r.git('rm', '-q', 'src/storage/save.ts');
    r.commit('Delete the file');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), ['CL-4']);
  } finally {
    r.cleanup();
  }
});

test('a branch cannot drop or loosen a row for its own merge: the base branch\'s copy still applies', () => {
  const r = repo();
  try {
    // The branch rewrites CL-2 so it fits nothing, deletes CL-1, and adds a row of its own.
    r.write(CHECKLIST_FILE, table('| CL-2 | `nowhere/` | Nothing | Loosened |', '| CL-3 | `src/api/` | A new check | A new mistake |'));
    r.write('src/api/users.ts', 'export const users = [];\n');
    r.write('src/storage/save.ts', 'export const save = 1;\nconst version = 3;\n');
    r.commit('Change the checklist and the code');
    const found = checklistFor(r.dir, { base: 'main' });
    assert.deepEqual(ids(found.items), ['CL-1', 'CL-2', 'CL-3']);
    assert.equal(found.items[1].check, 'Every new route checks who is calling', 'where both copies hold an id, the base branch wins');
    assert.deepEqual(ids(found.matched), ['CL-1', 'CL-2', 'CL-3']);
    // Deleting the whole file changes nothing either.
    r.git('rm', '-q', CHECKLIST_FILE);
    r.commit('Delete the checklist');
    assert.deepEqual(ids(checklistFor(r.dir, { base: 'main' }).matched), ['CL-1', 'CL-2']);
  } finally {
    r.cleanup();
  }
});

test('a checklist that only the branch holds applies to that branch', () => {
  const r = repo(null);
  try {
    assert.equal(checklistFor(r.dir, { base: 'main' }).present, false);
    r.write(CHECKLIST_FILE, table(API));
    r.write('src/api/users.ts', 'export const users = [];\n');
    r.commit('Add the checklist');
    const found = checklistFor(r.dir, { base: 'main' });
    assert.equal(found.present, true);
    assert.deepEqual(ids(found.matched), ['CL-2']);
  } finally {
    r.cleanup();
  }
});

test('the base is found without --base, and a base or branch git does not know is a plain error', () => {
  const r = repo();
  try {
    assert.equal(checklistFor(r.dir).base, 'main');
    assert.throws(() => checklistFor(r.dir, { base: 'origin/nope' }), /git has no branch or commit named origin\/nope/);
    assert.throws(() => checklistFor(r.dir, { base: 'main', branch: 'build/nope' }), /git has no branch or commit named build\/nope/);
    // With the base named in the settings file missing, the message says what to do.
    r.write('scripts/kit.config.json', '{ "baseBranch": "trunk" }\n');
    assert.throws(() => checklistFor(r.dir), /cannot find the base branch here \(tried origin\/trunk and trunk\).*--base/);
  } finally {
    r.cleanup();
  }
});

test('the command prints one kit-checklist line per row that fits, and exits 0', () => {
  const r = repo();
  try {
    r.write('src/routes/home.ts', 'export const home = 1;\n');
    r.commit('Add a route');
    assert.deepEqual(r.cli(), { code: 0, stdout: 'kit-checklist CL-2 Every new route checks who is calling\n', stderr: '' });
    assert.deepEqual(r.cli('build/001-x', '--base', 'main'), { code: 0, stdout: 'kit-checklist CL-2 Every new route checks who is calling\n', stderr: '' });
    const none = r.cli('main', '--base', 'main');
    assert.equal(none.code, 0);
    assert.match(none.stdout, /^No row of the change checklist fits this change/);
    assert.doesNotMatch(none.stdout, /kit-checklist/);
  } finally {
    r.cleanup();
  }
});

test('--all lists every row with its trigger, whether it fits or not', () => {
  const r = repo();
  try {
    const all = r.cli('--all');
    assert.equal(all.code, 0);
    assert.equal(all.stdout, 'CL-1  when: `src/storage/**` and adds "version"  check: Old saved data still loads\nCL-2  when: `src/api/`, `src/routes/*.ts`  check: Every new route checks who is calling\n');
  } finally {
    r.cleanup();
  }
});

test('with no checklist file, or no format line, the command prints one plain line and exits 0', () => {
  for (const text of [null, '# Notes\n\n| CL-1 | broken |\n']) {
    const r = repo(text);
    try {
      const res = r.cli();
      assert.equal(res.code, 0);
      assert.equal(res.stderr, '');
      assert.match(res.stdout, /^No change checklist here: docs\/change-checklist\.md is missing, or it lacks the line "Format: kit change checklist, version 1"\. Nothing to check\.\n$/);
    } finally {
      r.cleanup();
    }
  }
});

test('a row that breaks the shape makes the command exit 1 and say where; the good rows are still printed', () => {
  const r = repo(table(API, '| CL-5 | src/ | No backticks | Why |'));
  try {
    r.write('src/api/users.ts', 'export const users = [];\n');
    r.commit('Add an api file');
    const res = r.cli();
    assert.equal(res.code, 1);
    assert.equal(res.stdout, 'kit-checklist CL-2 Every new route checks who is calling\n');
    assert.match(res.stderr, /docs\/change-checklist\.md:8: the "When the change touches" cell of CL-5 cannot be read/);
    assert.match(res.stderr, /Fix this row in docs\/change-checklist\.md/);
  } finally {
    r.cleanup();
  }
});

test('wrong usage exits 2 with the usage line; a git error exits 1', () => {
  const r = repo();
  try {
    for (const argv of [['--nope'], ['--base'], ['--base', '--all'], ['a', 'b']]) {
      const res = r.cli(...argv);
      assert.equal(res.code, 2, argv.join(' '));
      assert.match(res.stderr, /^Wrong usage: .*\nUsage: node scripts\/checklist\.mjs \[<branch>\] \[--base <ref>\] \[--all\]\n$/);
    }
    const res = r.cli('--base', 'origin/nope');
    assert.equal(res.code, 1);
    assert.match(res.stderr, /^checklist: git has no branch or commit named origin\/nope/);
  } finally {
    r.cleanup();
  }
  const outside = mkdtempSync(join(tmpdir(), 'kit-checklist-none-'));
  try {
    let stderr = '';
    assert.equal(run([], { cwd: outside, stdout: () => {}, stderr: (s) => (stderr += s) }), 1);
    assert.match(stderr, /is not inside a git working tree/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the script imports only Node\'s own modules, so the rule checker can load it with no loop', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'checklist.mjs'), 'utf8');
  const froms = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.ok(froms.length > 0);
  assert.deepEqual(froms.filter((f) => !f.startsWith('node:')), []);
  assert.doesNotMatch(source, /import\(/);
  assert.doesNotMatch(source, /^\s*(?:process\.exitCode = )?await\b/m);
});

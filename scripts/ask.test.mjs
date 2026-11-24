// Tests for ask.mjs. Run: node --test scripts/ask.test.mjs
// Each test makes a throwaway git repo in the temp folder; nothing touches a real project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MESSAGE_MAX, answerAsk, answerMessage, asksFrom, checkAsk, deliverAnswer, listAsks, newAsk, run } from './ask.mjs';
import { eventsFile, readEvents } from './events.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-ask-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const OPTS = { env: {} };
const GOOD = { title: 'Move the live key out of reach?', why: 'Agents hold it today.', blocks: 'Unattended runs', options: ['A: Move it now', 'B: Leave it'], recommend: 'A' };

test('a good ask passes and keeps its fields', () => {
  assert.deepEqual(checkAsk(GOOD), { title: GOOD.title, why: GOOD.why, blocks: 'Unattended runs', options: [{ key: 'A', text: 'Move it now' }, { key: 'B', text: 'Leave it' }], recommend: 'A' });
  assert.equal(checkAsk({ ...GOOD, title: 'Approve the key move' }).title, 'Approve the key move');
  assert.deepEqual(checkAsk({ title: 'Sign the license', why: 'Only you can.' }).options, []);
});

test('every limit is enforced with one sentence that says what to shorten', () => {
  const cases = [
    [{ title: 'x'.repeat(80) + '?' }, /title is 81 characters; shorten it to 80/],
    [{ title: 'The key is exposed' }, /question mark or start with a verb/],
    [{ title: '' }, /needs a title/],
    [{ why: 'w'.repeat(301) }, /why is 301 characters; shorten it to 300/],
    [{ why: '' }, /needs a why/],
    [{ blocks: 'b'.repeat(121) }, /blocks text is 121 characters; shorten it to 120/],
    [{ options: ['A: 1', 'B: 2', 'C: 3', 'D: 4', 'E: 5'], recommend: null }, /5 options; cut them to 4/],
    [{ options: ['A: ' + 't'.repeat(121), 'B: ok'] }, /text of option A is 121 characters; shorten it to 120/],
    [{ options: ['no colon here'] }, /must look like "A: what that choice does"/],
    [{ options: ['A: one', 'A: two'] }, /Two options use the key A/],
    [{ options: ['A:  '] }, /Option A needs text/],
    [{ recommend: 'C' }, /must be one of the option keys: A, B/],
    [{ options: [], recommend: 'A' }, /needs options/],
  ];
  for (const [over, msg] of cases) {
    assert.throws(() => checkAsk({ ...GOOD, ...over }), (e) => e.refused && msg.test(e.message) && !e.message.includes('\n'), String(msg));
  }
  assert.doesNotThrow(() => checkAsk({ ...GOOD, title: 'x'.repeat(79) + '?', why: 'w'.repeat(300), blocks: 'b'.repeat(120), options: ['A: ' + 't'.repeat(120), 'B: 2', 'C: 3', 'D: 4'] }));
});

test('a refused ask writes nothing; the command exits 2 and says why', () => {
  const r = repo();
  try {
    let err = '';
    const code = run(['new', '--title', 'x'.repeat(90) + '?', '--why', 'y'], { cwd: r.dir, env: {}, stdout: () => {}, stderr: (s) => (err += s) });
    assert.equal(code, 2);
    assert.equal(err, 'Refused: The title is 91 characters; shorten it to 80 or fewer.\n');
    assert.ok(!existsSync(eventsFile(r.dir)));
  } finally {
    r.cleanup();
  }
});

test('an ask with options takes a typed reply with no option picked, and the message says so', () => {
  const r = repo();
  try {
    const c = newAsk(r.dir, GOOD, OPTS);
    assert.throws(() => answerAsk(r.dir, c.id, {}, OPTS), /needs a choice or some text/);
    answerAsk(r.dir, c.id, { text: 'Neither. Do a third thing.' }, OPTS);
    const own = listAsks(r.dir).find((x) => x.id === c.id);
    assert.deepEqual([own.status, own.answer.choice, own.answer.text], ['answered', null, 'Neither. Do a third thing.']);
    assert.match(answerMessage(own), /Chosen: none of the options/);
    assert.match(answerMessage(own), /Reply: Neither\. Do a third thing\./);
  } finally {
    r.cleanup();
  }
});

test('answer joins the ask; unknown and already answered asks are errors', () => {
  const r = repo();
  try {
    const a = newAsk(r.dir, { ...GOOD, slice: 84, role: 'head' }, OPTS);
    const b = newAsk(r.dir, { title: 'Sign the license', why: 'Only you can.' }, OPTS);
    assert.deepEqual(listAsks(r.dir).map((x) => [x.id, x.status]), [[a.id, 'open'], [b.id, 'open']]);
    assert.deepEqual(listAsks(r.dir)[0].askedBy, { role: 'head', slice: 84, thread: null });
    assert.throws(() => answerAsk(r.dir, a.id, { choice: 'Z' }, OPTS), /Pick one of the options: A, B/);
    assert.throws(() => answerAsk(r.dir, b.id, { choice: 'A' }, OPTS), /no options; answer it with --text/);
    assert.throws(() => answerAsk(r.dir, b.id, {}, OPTS), /needs a choice or some text/);
    const ans = answerAsk(r.dir, a.id, { choice: 'A', text: 'Do it today.' }, OPTS);
    assert.equal(ans.role, 'stephen');
    const joined = listAsks(r.dir).find((x) => x.id === a.id);
    assert.equal(joined.status, 'answered');
    assert.deepEqual(joined.answer, { choice: 'A', text: 'Do it today.', at: ans.at, role: 'stephen' });
    assert.throws(() => answerAsk(r.dir, a.id, { choice: 'B' }, OPTS), /already answered/);
    assert.throws(() => answerAsk(r.dir, 'deadbeef', { choice: 'A' }, OPTS), /No ask has the id deadbeef/);
    answerAsk(r.dir, b.id, { text: 'Signed.' }, OPTS);
    assert.deepEqual(listAsks(r.dir).map((x) => x.status), ['answered', 'answered']);
  } finally {
    r.cleanup();
  }
});

test('asksFrom keeps only the first answer and ignores answers to unknown asks', () => {
  const ask = { id: 'aaaa0001', at: '2026-11-18T01:00:00Z', type: 'ask', data: { title: 'T?', why: 'w', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }] } };
  const ans = (choice, at, to = 'aaaa0001') => ({ id: `x${choice}`, at, type: 'answer', role: 'stephen', data: { ask: to, choice, text: null } });
  const [a] = asksFrom([ask, ans('B', '2026-11-18T02:00:00Z'), ans('A', '2026-11-18T03:00:00Z'), ans('A', '2026-11-18T04:00:00Z', 'zzzz')]);
  assert.equal(a.answer.choice, 'B');
});

test('the commands: new, list --open and --answered, answer', () => {
  const r = repo();
  try {
    let out = '';
    const io = { cwd: r.dir, env: {}, stdout: (s) => (out += s), stderr: () => {} };
    assert.equal(run(['new', '--title', 'Pick a name?', '--why', 'The app needs one.', '--option', 'A: Lexi', '--option', 'B: Uni', '--recommend', 'B', '--slice', '84'], io), 0);
    const id = out.match(/^asked ([0-9a-f]{8}):/)[1];
    out = '';
    assert.equal(run(['list', '--open', '--json'], io), 0);
    assert.deepEqual(JSON.parse(out).map((a) => [a.id, a.askedBy.slice, a.recommend]), [[id, 84, 'B']]);
    assert.equal(run(['answer', id, '--choice', 'B'], io), 0);
    out = '';
    run(['list', '--open', '--json'], io);
    assert.deepEqual(JSON.parse(out), []);
    out = '';
    run(['list', '--answered'], io);
    assert.match(out, new RegExp(`^${id}  answered B  Pick a name\\?`));
    assert.equal(run(['answer', 'deadbeef', '--choice', 'A'], io), 1);
    assert.equal(run(['list', '--open', '--answered'], io), 2);
  } finally {
    r.cleanup();
  }
});

test('a legacy to-do item is answerable by its id with no ask event, once, with text only', () => {
  const r = repo();
  try {
    const ans = answerAsk(r.dir, 'legacy-c020ffc3', { text: 'Moved it.', legacyTitle: 'Approve the key move.' }, OPTS);
    assert.deepEqual(ans.data, { ask: 'legacy-c020ffc3', choice: null, text: 'Moved it.', legacyTitle: 'Approve the key move.' });
    assert.equal(ans.role, 'stephen');
    const [row] = listAsks(r.dir);
    assert.deepEqual([row.id, row.title, row.status, row.legacy, row.answer.text], ['legacy-c020ffc3', 'Approve the key move.', 'answered', true, 'Moved it.']);
    assert.throws(() => answerAsk(r.dir, 'legacy-c020ffc3', { text: 'Again.' }, OPTS), /already answered/);
    assert.throws(() => answerAsk(r.dir, 'legacy-0000aaaa', { choice: 'A' }, OPTS), /no options; answer it with --text/);
    assert.throws(() => answerAsk(r.dir, 'legacy-zz', { text: 'x' }, OPTS), /"legacy-" and 8 hex characters/);

    let out = '';
    const io = { cwd: r.dir, env: {}, stdout: (s) => (out += s), stderr: () => {} };
    assert.equal(run(['answer', 'legacy-0000aaaa', '--text', 'Done by hand.'], io), 0);
    out = '';
    assert.equal(run(['list', '--answered'], io), 0);
    assert.deepEqual(out.trim().split('\n'), ['legacy-c020ffc3  answered  Approve the key move.', 'legacy-0000aaaa  answered  an item of the old to-do list']);
  } finally {
    r.cleanup();
  }
});

const THREAD = 'da49a143-0000-4000-8000-00000000fake';
// A stand-in for T3 Code's command line: it records each call and answers what the test says.
const fakeT3 = (reply = { code: 0, stdout: '{}', stderr: '' }) => {
  const calls = [];
  return { calls, run: async (cmd, args, { input }) => (calls.push({ cmd, args, input }), reply) };
};

test('the message to the asking thread: who answered, the question and its id, the choice in full or the typed reply, how to read it again', () => {
  const ask = { id: '9f2c41ab', title: 'Pick a name?', options: [{ key: 'A', text: 'Lexi' }, { key: 'B', text: 'Uni' }] };
  assert.equal(answerMessage({ ...ask, answer: { choice: 'B', text: null, role: 'stephen' } }),
    'Stephen answered your question.\nQuestion: Pick a name? (ask 9f2c41ab)\nChosen: B: Uni\nTo read it again: node scripts/ask.mjs list --answered --json');
  assert.equal(answerMessage({ ...ask, options: [], answer: { choice: null, text: 'Call it Uni.', role: 'head' } }).split('\n').slice(0, 3).join('|'),
    'The head answered your question.|Question: Pick a name? (ask 9f2c41ab)|Reply: Call it Uni.');
  const long = answerMessage({ ...ask, title: 'T'.repeat(79) + '?', options: [{ key: 'A', text: 'o'.repeat(120) }], answer: { choice: 'A', text: 'word '.repeat(400), role: 'stephen' } });
  assert.equal(long.length, MESSAGE_MAX, 'a long note is cut so the whole message fits');
  assert.match(long, /\.\.\.\nTo read it again: node scripts\/ask\.mjs list --answered --json$/);
  assert.ok(long.includes(`Chosen: A: ${'o'.repeat(120)}`), 'the chosen option is never the part that is cut');
});

test('deliverAnswer: sent and failed are recorded as answer-delivered; no thread sends and writes nothing; the newest record wins', async () => {
  const r = repo();
  try {
    const plain = newAsk(r.dir, GOOD, OPTS);
    const none = fakeT3();
    assert.deepEqual(await deliverAnswer(r.dir, answerAsk(r.dir, plain.id, { choice: 'A' }, OPTS), { run: none.run, cli: '/fake/t3' }, OPTS), { status: 'none' });
    assert.deepEqual([none.calls.length, readEvents(r.dir, { types: ['answer-delivered'] }).events.length], [0, 0]);
    assert.deepEqual(listAsks(r.dir)[0].delivery, { status: 'none' });

    const asked = newAsk(r.dir, { ...GOOD, thread: THREAD, slice: 84 }, OPTS);
    assert.equal(listAsks(r.dir)[1].delivery, null, 'an open ask has no delivery yet');
    const ans = answerAsk(r.dir, asked.id, { choice: 'B' }, OPTS);
    assert.deepEqual(listAsks(r.dir)[1].delivery, { status: 'unknown', thread: THREAD }, 'answered, a thread asked, and the log has no record of a message');

    const bad = fakeT3({ code: 2, stdout: '', stderr: 'no such thread' });
    assert.deepEqual(await deliverAnswer(r.dir, ans, { run: bad.run, cli: '/fake/t3' }, OPTS), { status: 'failed', thread: THREAD, error: 't3 stopped with code 2 and said: no such thread' });
    assert.deepEqual(listAsks(r.dir)[1].delivery, { status: 'failed', thread: THREAD, error: 't3 stopped with code 2 and said: no such thread' });

    const good = fakeT3();
    assert.deepEqual(await deliverAnswer(r.dir, ans, { run: good.run, cli: '/fake/t3' }, { env: {}, now: Date.now() + 1000 }), { status: 'sent', thread: THREAD });
    assert.deepEqual(good.calls.map((c) => [c.cmd, c.args]), [['/fake/t3', ['thread', 'send', '--json', THREAD, '-']]]);
    assert.match(good.calls[0].input, /^Stephen answered your question\.\n.*\nChosen: B: Leave it\n/);
    assert.deepEqual(listAsks(r.dir)[1].delivery, { status: 'sent', thread: THREAD }, 'the later try that worked replaces the one that failed');
    const records = readEvents(r.dir, { types: ['answer-delivered'] }).events;
    assert.deepEqual(records.map((e) => [e.data.ask, e.data.answer, e.data.status, e.slice]), [[asked.id, ans.id, 'failed', 84], [asked.id, ans.id, 'sent', 84]]);
  } finally {
    r.cleanup();
  }
});

test('a thread id that could be read as an option is refused before t3 is run', async () => {
  const r = repo();
  try {
    const asked = newAsk(r.dir, { ...GOOD, thread: '--base-dir=/tmp/x' }, OPTS);
    const t3 = fakeT3();
    const d = await deliverAnswer(r.dir, answerAsk(r.dir, asked.id, { choice: 'A' }, OPTS), { run: t3.run, cli: '/fake/t3' }, OPTS);
    assert.deepEqual([d.status, t3.calls.length], ['failed', 0]);
    assert.match(d.error, /does not look like a T3 Code thread id/);
  } finally {
    r.cleanup();
  }
});

test('the answer command tells the asking thread and says where the answer went; a failed send still exits 0 with the answer saved', async () => {
  const r = repo();
  try {
    const one = newAsk(r.dir, { ...GOOD, thread: THREAD }, OPTS);
    const two = newAsk(r.dir, { title: 'Sign the license', why: 'Only you can.', thread: THREAD }, OPTS);
    const three = newAsk(r.dir, { title: 'Rotate the key', why: 'It is old.' }, OPTS);
    let out = '';
    let err = '';
    const ok = fakeT3();
    const io = { cwd: r.dir, env: {}, stdout: (s) => (out += s), stderr: (s) => (err += s), runCommand: ok.run, cli: '/fake/t3' };
    assert.equal(await run(['answer', one.id, '--choice', 'A'], io), 0);
    assert.equal(out, `answered ${one.id} with A\nAnswer saved and sent to the thread that asked.\n`);
    assert.deepEqual(ok.calls[0].args, ['thread', 'send', '--json', THREAD, '-']);

    out = '';
    const down = fakeT3({ code: null, stdout: '', stderr: '', error: new Error('it did not finish within 60 seconds') });
    assert.equal(await run(['answer', two.id, '--text', 'Signed.'], { ...io, runCommand: down.run }), 0);
    assert.equal(err, 'Answer saved, but it could not be sent to the thread: it did not finish within 60 seconds.\n');
    assert.equal(listAsks(r.dir).find((a) => a.id === two.id).answer.text, 'Signed.');

    out = '';
    const idle = fakeT3();
    assert.equal(run(['answer', three.id, '--text', 'Done.'], { ...io, runCommand: idle.run }), 0);
    assert.equal(out, `answered ${three.id}\nAnswer saved. No thread is waiting on it, so it sits in the list until an agent reads it.\n`);
    assert.equal(idle.calls.length, 0);
  } finally {
    r.cleanup();
  }
});

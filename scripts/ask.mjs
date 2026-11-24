#!/usr/bin/env node
// ask.mjs: how an agent puts a decision in front of Stephen, and how the answer is recorded.
//
// What it does, in plain English:
//   An "ask" is one short question for Stephen, with a reason, what it holds up, up to four
//   options, and the agent's pick. It is written to the project's event log (scripts/events.mjs)
//   as an `ask` event; the answer is an `answer` event that names the ask's id. The dashboard
//   shows open asks first. Anything long or vague is refused with one sentence that says what to
//   shorten, so the dashboard never shows a wall of text. The limits:
//     title     80 characters at most; ends with a question mark or starts with a verb
//     why       300 at most        blocks   120 at most
//     options   at most 4, each "KEY: text", text 120 at most   recommend   one of the option keys
//   When an answer is saved, the thread that asked is told: a short message is sent to it with T3
//   Code's command line (scripts/t3.mjs), so the agent does not have to keep checking. The answer
//   is saved first and stays saved when the message cannot be sent. What happened to the message
//   is written as an `answer-delivered` event, so the dashboard can show it later.
//   The contract is docs/2026-11-18-dashboard-data-contract.md, section 2 ("Asks: what waits on Stephen").
//
// How to run (Node 18 or newer), from the project's main checkout or any of its worktrees:
//   node scripts/ask.mjs new --title "Move the live key out of agents' reach?" --why "..." \
//     [--blocks "..."] [--option "A: Move it now" --option "B: Leave it"] [--recommend A] [--slice 84] [--role head]
//   node scripts/ask.mjs answer <id> [--choice A] [--text "..."] [--role stephen]
//       The id may also be "legacy-" and 8 hex characters: an item of the old docs/awaiting-decisions.md,
//       as the dashboard shows it. Such an item has no options, so answer it with --text.
//       It then says where the answer went: sent to the thread that asked, not sent (with the reason,
//       on standard error), or that no thread is waiting on it. The exit code is 0 in all three:
//       the answer is saved.
//   node scripts/ask.mjs list [--open | --answered] [--json]
// Exit codes: 0 done, 1 an error (such as an unknown ask id), 2 wrong usage or a refused ask.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendEvent, readEvents } from './events.mjs';
import { sendToThread } from './t3.mjs';

export const ASK_LIMITS = Object.freeze({ title: 80, why: 300, blocks: 120, options: 4, optionText: 120 });
// The id of an item of the old docs/awaiting-decisions.md: "legacy-" and 8 hex characters.
export const LEGACY_ID = /^legacy-[0-9a-f]{8}$/;
// The message that tells a thread about an answer is never longer than this.
export const MESSAGE_MAX = 600;
const USAGE = 'Usage: node scripts/ask.mjs new --title <text> --why <text> [--blocks <text>] [--option "A: text" ...] [--recommend A] [--slice N] [--role R]\n'
  + '       node scripts/ask.mjs answer <id> [--choice A] [--text <text>] [--role R]\n'
  + '       node scripts/ask.mjs list [--open | --answered] [--json]';

// Verbs a title may start with when it is not a question. A short list on purpose: a title should ask.
export const TITLE_VERBS = [
  'accept', 'add', 'allow', 'answer', 'approve', 'buy', 'cancel', 'check', 'choose', 'confirm', 'connect', 'create', 'decide',
  'delete', 'deploy', 'drop', 'enable', 'disable', 'give', 'install', 'keep', 'log', 'merge', 'move', 'open', 'pay', 'pick',
  'publish', 'read', 'reject', 'remove', 'rename', 'renew', 'reply', 'review', 'rotate', 'run', 'send', 'set', 'share', 'sign',
  'start', 'stop', 'test', 'try', 'turn', 'update', 'upgrade',
];

const refuse = (msg) => Object.assign(new Error(msg), { refused: true });
const usage = (msg) => Object.assign(refuse(msg), { usage: true });
const tooLong = (what, text, max) => {
  if (text.length > max) throw refuse(`The ${what} is ${text.length} characters; shorten it to ${max} or fewer.`);
};

// "A: Move it now" or { key, text } -> { key, text }.
export function parseOption(o) {
  if (o && typeof o === 'object') return { key: String(o.key ?? '').trim(), text: String(o.text ?? '').trim() };
  const m = String(o).match(/^\s*([A-Za-z0-9]{1,3})\s*:\s*(.*?)\s*$/);
  if (!m) throw refuse(`The option "${o}" must look like "A: what that choice does".`);
  return { key: m[1], text: m[2] };
}

// Checks every limit and returns the clean fields. Throws one plain sentence on the first problem.
export function checkAsk({ title, why, blocks = null, options = [], recommend = null }) {
  title = String(title ?? '').trim();
  why = String(why ?? '').trim();
  if (!title) throw refuse('The ask needs a title: one short question.');
  tooLong('title', title, ASK_LIMITS.title);
  const first = title.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!title.endsWith('?') && !TITLE_VERBS.includes(first)) throw refuse('The title must end with a question mark or start with a verb, such as "Approve the key move".');
  if (!why) throw refuse('The ask needs a why: one or two sentences on why it matters.');
  tooLong('why', why, ASK_LIMITS.why);
  blocks = blocks === null || blocks === undefined || String(blocks).trim() === '' ? null : String(blocks).trim();
  if (blocks !== null) tooLong('blocks text', blocks, ASK_LIMITS.blocks);
  const opts = (options || []).map(parseOption);
  if (opts.length > ASK_LIMITS.options) throw refuse(`The ask has ${opts.length} options; cut them to ${ASK_LIMITS.options} or fewer.`);
  const keys = new Set();
  for (const o of opts) {
    if (!/^[A-Za-z0-9]{1,3}$/.test(o.key)) throw refuse(`The option key "${o.key}" must be a short label such as A or 1.`);
    if (!o.text) throw refuse(`Option ${o.key} needs text after the colon.`);
    tooLong(`text of option ${o.key}`, o.text, ASK_LIMITS.optionText);
    if (keys.has(o.key)) throw refuse(`Two options use the key ${o.key}; give each its own key.`);
    keys.add(o.key);
  }
  recommend = recommend === null || recommend === undefined || recommend === '' ? null : String(recommend).trim();
  if (recommend !== null && !keys.has(recommend)) {
    throw refuse(opts.length ? `The recommendation "${recommend}" must be one of the option keys: ${[...keys].join(', ')}.` : 'A recommendation needs options to pick from.');
  }
  return { title, why, blocks, options: opts, recommend };
}

// Writes an `ask` event and returns it. fields: title, why, blocks, options, recommend, and slice, role, model, thread.
export function newAsk(cwd, fields, opts) {
  const data = checkAsk(fields);
  const { slice, role, model, thread } = fields;
  return appendEvent(cwd, { type: 'ask', data, slice, role, model, thread }, opts);
}

// Every ask in the events, each joined with its first answer. Oldest first.
// delivery says what happened to the message that tells the asking thread about the answer:
// null while the ask is open; { status: 'none' } when no thread asked; { status: 'sent', thread };
// { status: 'failed', thread, error }; { status: 'unknown', thread } when a thread asked but the
// log has no `answer-delivered` event (an answer from before this existed, or a program that stopped).
export function asksFrom(events) {
  const asks = [];
  const byId = new Map();
  for (const e of events) {
    if (e.type === 'ask' && !byId.has(e.id)) {
      const d = e.data || {};
      const ask = {
        id: e.id,
        at: e.at,
        title: d.title ?? null,
        why: d.why ?? null,
        blocks: d.blocks ?? null,
        options: Array.isArray(d.options) ? d.options : [],
        recommend: d.recommend ?? null,
        askedBy: { role: e.role ?? null, slice: e.slice ?? null, thread: e.thread ?? null },
        status: 'open',
        answer: null,
        delivery: null,
      };
      asks.push(ask);
      byId.set(e.id, ask);
    }
  }
  for (const e of events) {
    if (e.type !== 'answer') continue;
    let ask = byId.get(e.data?.ask);
    if (!ask && LEGACY_ID.test(e.data?.ask ?? '')) {
      // An answer to an item of the old docs/awaiting-decisions.md: there is no ask event, only the answer.
      ask = {
        id: e.data.ask, at: null, title: e.data.legacyTitle ?? null, why: null, blocks: null, options: [], recommend: null,
        askedBy: null, status: 'open', answer: null, delivery: null, legacy: true,
      };
      asks.push(ask);
      byId.set(ask.id, ask);
    }
    if (!ask || ask.answer) continue;
    ask.status = 'answered';
    ask.answer = { choice: e.data.choice ?? null, text: e.data.text ?? null, at: e.at, role: e.role ?? null };
    const thread = ask.askedBy?.thread ?? null;
    ask.delivery = thread ? { status: 'unknown', thread } : { status: 'none' };
  }
  // The newest record wins, so a later try that worked replaces one that failed.
  for (const e of events) {
    if (e.type !== 'answer-delivered') continue;
    const ask = byId.get(e.data?.ask);
    if (!ask?.answer || !['sent', 'failed'].includes(e.data.status)) continue;
    ask.delivery = { status: e.data.status, thread: e.data.thread ?? null };
    if (e.data.status === 'failed') ask.delivery.error = e.data.error ?? null;
  }
  return asks;
}

export const listAsks = (cwd) => asksFrom(readEvents(cwd, { types: ['ask', 'answer', 'answer-delivered'] }).events);

// Writes an `answer` event. Unknown ids, answered asks, and choices that are not option keys are errors.
// An ask with options may also be answered with text alone: none of the options, a reply in his own words.
// An id like "legacy-1a2b3c4d" names an item of the old docs/awaiting-decisions.md (dashboard/collect/inbox.mjs
// makes it from the item's text). It needs no ask event; legacyTitle, when given, is kept in the answer's data.
export function answerAsk(cwd, id, { choice = null, text = null, role = 'stephen', legacyTitle = null } = {}, opts) {
  id = String(id ?? '');
  const legacy = id.startsWith('legacy-');
  if (legacy && !LEGACY_ID.test(id)) throw refuse(`The id ${id} is not a to-do item id; those are "legacy-" and 8 hex characters.`);
  const ask = listAsks(cwd).find((a) => a.id === id);
  if (!ask && !legacy) throw new Error(`No ask has the id ${id}.`);
  if (ask?.answer) throw new Error(`Ask ${id} was already answered at ${ask.answer.at}.`);
  choice = choice === null || choice === undefined || choice === '' ? null : String(choice).trim();
  text = text === null || text === undefined || String(text).trim() === '' ? null : String(text).trim();
  const keys = (ask?.options || []).map((o) => o.key);
  if (choice !== null && keys.length && !keys.includes(choice)) throw refuse(`Pick one of the options: ${keys.join(', ')}.`);
  if (!keys.length && choice !== null) throw refuse('This ask has no options; answer it with --text instead.');
  if (choice === null && text === null) throw refuse('An answer needs a choice or some text.');
  const data = { ask: id, choice, text };
  if (legacy && legacyTitle) data.legacyTitle = String(legacyTitle).trim().slice(0, ASK_LIMITS.title);
  return appendEvent(cwd, { type: 'answer', data, role }, opts);
}

// The short message that tells the asking thread about an answer. ask: a row of listAsks, with its answer.
// Plain text, MESSAGE_MAX characters at most: a long typed reply is cut, and the last line says how to read all of it.
export function answerMessage(ask) {
  const a = ask.answer || {};
  const who = !a.role || a.role === 'stephen' ? 'Stephen' : `The ${a.role}`;
  const option = a.choice === null ? null : (ask.options || []).find((o) => o.key === a.choice);
  const lines = (text) => [
    `${who} answered your question.`,
    `Question: ${ask.title ?? 'an item of the old to-do list'} (ask ${ask.id})`,
    a.choice !== null ? `Chosen: ${a.choice}${option ? `: ${option.text}` : ''}` : null,
    a.choice === null && (ask.options || []).length ? 'Chosen: none of the options. He wrote his own reply.' : null,
    text !== null ? `${a.choice !== null ? 'Note' : 'Reply'}: ${text}` : null,
    'To read it again: node scripts/ask.mjs list --answered --json',
  ].filter((l) => l !== null).join('\n');
  const reply = a.text ?? null;
  if (reply === null) return lines(null);
  const room = MESSAGE_MAX - lines('').length;
  return lines(reply.length > room ? `${reply.slice(0, Math.max(0, room - 3))}...` : reply);
}

// Tells the thread that asked about an answer, and records what happened. answer: the event answerAsk returned.
// Resolves { status: 'none' } when no thread asked (nothing is sent, nothing is written), else
// { status: 'sent', thread } or { status: 'failed', thread, error }, after writing an `answer-delivered`
// event with the same fields. Never throws: the answer is already saved, and it stays saved.
// io: { run, cli, env }, how t3 is run (scripts/t3.mjs); tests pass a fake run.
export async function deliverAnswer(cwd, answer, io = {}, opts) {
  const ask = listAsks(cwd).find((a) => a.id === answer?.data?.ask);
  const thread = ask?.askedBy?.thread ?? null;
  if (!ask?.answer || !thread) return { status: 'none' };
  const sent = await sendToThread(thread, answerMessage(ask), io);
  const delivery = sent.ok ? { status: 'sent', thread } : { status: 'failed', thread, error: sent.error };
  try {
    appendEvent(cwd, { type: 'answer-delivered', data: { ask: ask.id, answer: answer.id, ...delivery }, role: answer.role, slice: ask.askedBy.slice, branch: null }, opts);
  } catch {
    // The message went (or did not); only the record of it is missing. The page then shows "no record".
  }
  return delivery;
}

// One line for the command line and the page: where the answer went.
export function deliveryLine(d) {
  if (d?.status === 'sent') return 'Answer saved and sent to the thread that asked.';
  if (d?.status === 'failed') return `Answer saved, but it could not be sent to the thread: ${d.error}.`;
  return 'Answer saved. No thread is waiting on it, so it sits in the list until an agent reads it.';
}

// Reads --name value pairs; repeatable names collect into lists.
function parseFlags(args, { repeat = [], bools = [] } = {}) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (bools.includes(name)) {
      o[name] = true;
      continue;
    }
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) throw usage(`${a} needs a value.`);
    if (repeat.includes(name)) (o[name] = o[name] || []).push(v);
    else o[name] = v;
  }
  return o;
}

function only(o, allowed) {
  for (const k of Object.keys(o)) if (k !== '_' && !allowed.includes(k)) throw usage(`unknown option --${k}`);
}

const askLine = (a) => `${a.id}  ${a.status}${a.answer?.choice ? ` ${a.answer.choice}` : ''}  ${a.title ?? 'an item of the old to-do list'}${a.recommend ? `  (recommend ${a.recommend})` : ''}`;

// Returns the exit code. One case returns a promise of it instead: `answer` on an ask that a thread
// asked, because the message to that thread has to finish first. io.runCommand and io.cli fake t3 in tests.
export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const cwd = io.cwd || process.cwd();
  const opts = { env: io.env || process.env };
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'new') {
      const o = parseFlags(rest, { repeat: ['option'] });
      only(o, ['title', 'why', 'blocks', 'option', 'recommend', 'slice', 'role', 'model']);
      if (o._.length) throw usage(`unexpected ${o._[0]}`);
      const e = newAsk(cwd, { title: o.title, why: o.why, blocks: o.blocks, options: o.option || [], recommend: o.recommend, slice: o.slice, role: o.role, model: o.model }, opts);
      out(`asked ${e.id}: ${e.data.title}\n`);
      return 0;
    }
    if (cmd === 'answer') {
      const o = parseFlags(rest);
      only(o, ['choice', 'text', 'role']);
      if (o._.length !== 1) throw usage('answer needs the ask id.');
      const e = answerAsk(cwd, o._[0], { choice: o.choice, text: o.text, role: o.role || 'stephen' }, opts);
      out(`answered ${o._[0]}${e.data.choice ? ` with ${e.data.choice}` : ''}\n`);
      const asker = listAsks(cwd).find((a) => a.id === e.data.ask)?.askedBy?.thread ?? null;
      if (!asker) {
        out(`${deliveryLine({ status: 'none' })}\n`);
        return 0;
      }
      return deliverAnswer(cwd, e, { run: io.runCommand, cli: io.cli, env: opts.env }, opts).then((d) => {
        (d.status === 'failed' ? err : out)(`${deliveryLine(d)}\n`);
        return 0;
      });
    }
    if (cmd === 'list') {
      const o = parseFlags(rest, { bools: ['open', 'answered', 'json'] });
      only(o, ['open', 'answered', 'json']);
      if (o.open && o.answered) throw usage('use --open or --answered, not both');
      let asks = listAsks(cwd);
      if (o.open) asks = asks.filter((a) => a.status === 'open');
      if (o.answered) asks = asks.filter((a) => a.status === 'answered');
      if (o.json) out(`${JSON.stringify(asks)}\n`);
      else out(asks.length ? `${asks.map(askLine).join('\n')}\n` : 'no asks\n');
      return 0;
    }
    throw usage(cmd ? `unknown command ${cmd}` : 'no command');
  } catch (e) {
    if (e.refused) {
      err(e.usage ? `Wrong usage: ${e.message}\n${USAGE}\n` : `Refused: ${e.message}\n`);
      return 2;
    }
    err(`ask: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve(run(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
}

// t3.mjs: how the kit runs T3 Code's command line, in one place.
//
// What it does, in plain English:
//   T3 Code is the app the agent threads run in. Its command line tool (the program at
//   $T3CODE_CLI_PATH, else ~/.t3/bin/t3) can start a thread and send a message to one.
//   This file holds the one way the kit runs it: with an argument list and no shell, the long text
//   on standard input, and a time limit. So no text from a prompt, a question, or an answer can run
//   as a command. Two callers use it:
//   - dashboard/server/start-job.mjs starts an agent job as a new thread (`t3 thread start`);
//   - scripts/ask.mjs tells the thread that asked a question that Stephen answered it:
//       t3 thread send --json <thread id> -      with the message on standard input.
//     A busy thread gets the message as its next turn; nothing is interrupted.
//
// How to run: imported, never run by itself. Tests pass a fake in place of runCommand, so they
// never reach a real thread.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const COMMAND_TIMEOUT_MS = 60_000;
// A thread id as T3 Code writes it: letters, digits, and a few marks. Never a leading dash, which
// the command line would read as an option.
export const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

export const t3Path = (env = process.env, home = homedir()) => env.T3CODE_CLI_PATH || join(home, '.t3', 'bin', 't3');

// Runs a program with an argument list and no shell, writes input to its standard input, and
// resolves { code, stdout, stderr }. A program that cannot start resolves { code: null, error }.
export function runCommand(cmd, args, { input = '', timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: e });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: null, stdout, stderr, error: new Error(`it did not finish within ${timeoutMs / 1000} seconds`) });
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (e) => finish({ code: null, stdout, stderr, error: e }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
    child.stdin.on('error', () => {}); // a program that exits early closes its input; the exit code tells the story
    child.stdin.end(input);
  });
}

// Any text as one line, cut to max characters.
export const oneLine = (s, max = 300) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

// The argument list for `t3 thread send`, in order. The message itself goes on standard input.
export const sendArgs = (thread) => ['thread', 'send', '--json', thread, '-'];

// Sends one message to a thread. Never throws: resolves { ok: true } or { ok: false, error }, where
// error is one plain sentence without its full stop. opts: { cli, run } (both fakeable), env.
export async function sendToThread(thread, message, { cli, run = runCommand, env = process.env } = {}) {
  const id = String(thread ?? '');
  if (!THREAD_ID.test(id)) return { ok: false, error: 'the thread id on the question does not look like a T3 Code thread id' };
  const program = cli || t3Path(env);
  let res;
  try {
    res = await run(program, sendArgs(id), { input: message });
  } catch (e) {
    return { ok: false, error: oneLine(e?.message || e) };
  }
  if (res.error) return { ok: false, error: res.error.code === 'ENOENT' ? `T3 Code's command line was not found at ${program}` : oneLine(res.error.message) };
  if (res.code !== 0) return { ok: false, error: `t3 stopped with code ${res.code} and said: ${oneLine(res.stderr || res.stdout) || 'nothing'}` };
  return { ok: true };
}

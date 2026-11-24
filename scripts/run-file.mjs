#!/usr/bin/env node
// run-file.mjs: the shape of a run file, a reader for it, and a command line that checks one.
//
// A run is one wave of work Stephen approves at once, with one token limit. Its file is
// docs/runs/<name>.json (lead-only: a builder must not raise its own limit). The head agent writes
// it by hand when the run starts, adds each slice's branch as it starts, and sets "end" when it ends:
//   {
//     "name": "2026-11-16-wave-1",              the file name without .json
//     "start": "2026-11-16T09:00:00Z",          a time with its zone (Z or +02:00)
//     "end": null,                               null while the run goes on, then a time
//     "tokenLimit": 120000000,                   the limit Stephen approved, in tokens
//     "leadBranch": "lead/wave-1",               the head agent's branch for this run
//     "sliceBranches": ["build/012-save-word"]   each slice's branch, as it starts
//   }
// A token ledger imports readRun (or validateRun) to tie sessions to a run by branch and time.
//
// How to run (Node 18 or newer):
//   node scripts/run-file.mjs <file>...   check each run file; exit 0 when all are sound, 1 when
//                                         one is not (every error is listed), 2 with no file named
//
// No outside libraries.

import { readFileSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNS_DIR = 'docs/runs/';
export const RUN_KEYS = ['name', 'start', 'end', 'tokenLimit', 'leadBranch', 'sliceBranches'];

const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/;
const isTime = (v) => typeof v === 'string' && TIME.test(v) && !Number.isNaN(Date.parse(v))
  && new Date(Date.parse(v.slice(0, 10))).toISOString().slice(0, 10) === v.slice(0, 10); // no 2026-02-31
// git's rules for a branch name (git check-ref-format --branch), written out so this reader stays pure
// and needs no git: no "..", no "//", no part that starts with "." or ends with ".lock", no "/" or "."
// at the end, no "-" at the start, not HEAD. Letters are narrower than git's: A-Z, a-z, 0-9, . _ / -.
const isBranch = (v) => typeof v === 'string' && /^[A-Za-z0-9._/-]+$/.test(v) && v !== 'HEAD' && !v.startsWith('-')
  && !v.includes('..') && !v.endsWith('.') && v.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));

// Every error in one run, as plain sentences. [] means sound.
// file: the run file's name, to match "name" against. leadPrefixes: from the settings (default lead/).
export function validateRun(run, { file = '', leadPrefixes = ['lead/'] } = {}) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return ['the run file must be a JSON object'];
  const errors = [];
  for (const key of Object.keys(run)) if (!RUN_KEYS.includes(key)) errors.push(`unknown key "${key}"`);
  const stem = basename(file).replace(/\.json$/, '');
  if (typeof run.name !== 'string' || !run.name) errors.push('"name" must be the file name without .json');
  else if (file && run.name !== stem) errors.push(`name "${run.name}" must match the file name "${stem}"`);
  if (!isTime(run.start)) errors.push('"start" must be a time like 2026-11-16T09:00:00Z (with its zone)');
  if (run.end === undefined) errors.push('"end" must be null while the run goes on, then a time like 2026-11-16T17:00:00Z');
  else if (run.end !== null && !isTime(run.end)) errors.push('"end" must be null or a time like 2026-11-16T17:00:00Z (with its zone)');
  else if (run.end !== null && isTime(run.start) && Date.parse(run.end) < Date.parse(run.start)) errors.push('"end" is before "start"');
  if (!Number.isInteger(run.tokenLimit) || run.tokenLimit <= 0) errors.push('"tokenLimit" must be a whole number above 0');
  if (!isBranch(run.leadBranch) || !leadPrefixes.some((p) => run.leadBranch.startsWith(p))) {
    errors.push(`"leadBranch" must start with ${leadPrefixes.join(' or ')}`);
  }
  if (!Array.isArray(run.sliceBranches)) errors.push('"sliceBranches" must be a list of branch names');
  else {
    const seen = new Set();
    for (const b of run.sliceBranches) {
      if (!isBranch(b)) errors.push(`"sliceBranches" lists ${JSON.stringify(b)}, which is not a branch name`);
      else if (b === run.leadBranch) errors.push('"sliceBranches" lists the lead branch; it belongs in "leadBranch" only');
      else if (seen.has(b)) errors.push(`"sliceBranches" lists ${b} twice`);
      seen.add(b);
    }
  }
  return errors;
}

// Reads one run file. Gives back the run, or throws one error naming the file and listing every problem.
export function readRun(path, { leadPrefixes } = {}) {
  let run;
  try {
    run = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof SyntaxError ? 'not valid JSON' : 'cannot be read'}: ${e.message}`);
  }
  const errors = validateRun(run, { file: path, leadPrefixes });
  if (errors.length) throw new Error(`${path}:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  return run;
}

function cli(files) {
  if (!files.length) {
    console.error('Usage: node scripts/run-file.mjs <file>...   (check run files, such as docs/runs/<name>.json)');
    return 2;
  }
  let code = 0;
  for (const file of files) {
    try {
      readRun(file);
      console.log(`ok    ${file}`);
    } catch (e) {
      console.log(`FAIL  ${e.message}`);
      code = 1;
    }
  }
  return code;
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exit(cli(process.argv.slice(2)));

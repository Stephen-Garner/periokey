# Review Guide

The reviewer reads this first. Only the head agent edits it. Replace each example with this project's own.

## What failure looks like here

| Area | Failure | Look hardest at |
|---|---|---|
| `src/parser.ts` | Part of a bad phrase is typed, so the chart cursor drifts | Every reject path returns before any action; glued digits like "110" or "123" |
| `src/keymap.ts`, `profiles/` | A key is wrong for the dental program | Keys that no source confirms, stated as fact |
| `src/server.ts`, `src/injector.ts` | Keys typed into the wrong window | The focus check before each phrase; late phrases after pause |
| `src/stt.ts`, `src/server.ts` | Patient speech saved or logged | Any `console.log`, file write, or error message holding a transcript or key |
| `src/win-helper.ps1` | SendKeys special characters not escaped | `+ ^ % ~ ( ) { } [ ]` |

## Do not flag

- Formatting. The formatter owns it.
- Missing code comments. The kit bans them in product code.

## Evidence and summary

Every finding gives a file and line, and how you saw it, never a guess from a name. The summary leads with the COUNT line, and says so plainly when there is nothing to fix.

## Traps reviewers miss

- A test that checks the encoder with a profile built inside the test, instead of loading the real file in `profiles/`.

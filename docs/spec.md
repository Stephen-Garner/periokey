# PerioKey: Spec

Last changed: 2026-11-24.

## 1. What it is

A small program that listens to a dental hygienist say perio chart numbers and types them into the dental office's software, as if someone pressed the keys.

## 2. Who it is for

A hygienist at Stephen's father's dental office, which uses Patterson Eaglesoft on Windows. Today she charts with an assistant typing, or stops to type with gloved hands.

## 3. The problem

A full perio chart is 6 sites on up to 32 teeth: 192 numbers. Typing them alone means taking gloves off or touching the keyboard between probes.

## 4. What it does

- Hears 1 to 48 depths per phrase (1 to 15 mm); chatter is ignored unless it holds a run of 3+ depths, plus bleeding, back or undo, skip, and pause.
- Types them into the dental software using that software's keys (one profile file each).
- Practice mode: a built-in chart to try it with no dental software.
- Start and stop with one key or a foot pedal.
- A tick when a phrase is accepted, a buzz and "Repeat" when it is refused.

## 5. Hard rules

1. **All or nothing.** A phrase is typed whole or not at all. Why: a half-typed phrase moves the chart's cursor, and every later number lands on the wrong site.
2. **No AI in the parser.** Fixed rules only, each with a unit test. Why: the same words must always give the same keys.
3. **Nothing is saved.** No audio or transcript goes to disk or a log. Why: it is patient health data.
4. **Type only into the dental software.** In live mode, check the window in front before every phrase; pause if focus moves. Why: keys typed into the wrong window can do harm.
5. **No real patient use before a BAA** with the speech provider. Why: HIPAA.

## 6. Not in scope

Tooth-tracking state machines, databases, cloud servers, AI clean-up of transcripts, reading the screen (OCR), and user accounts.

## 7. How we know it works

A hygienist charts a full mouth by voice in a practice patient with no wrong site, and every refused phrase typed nothing.

## 8. Tech choices

Node 22.18+ running TypeScript directly, one dependency (`ws`), a plain web page, and OS tools for typing (PowerShell SendKeys on Windows, osascript on macOS). Deepgram Nova-3 streaming by default; OpenAI live transcription as the other choice.

## 9. Open questions

- Eaglesoft's key for 10 to 15 mm, and which key marks bleeding (`b`, `g`, or `Alt+g`; the button reads `Bleedin_g_`). Check on-site (README, "At the dental office"). Already confirmed: the window title `New Perio Exam for - <Patient> (<ID>)`, the process order `1-16,16-1,32-17,17-32`, and plain number keys typing into the chart.
- Does Eaglesoft run as administrator at the office? If so, PerioKey must too.
- Which provider gets the BAA: Deepgram or OpenAI.
- The OpenAI model `gpt-4o-transcribe` and its session format have not been tried with a real key.

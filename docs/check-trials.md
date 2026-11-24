# Check Trials

Each new check gets a two-week trial, so a check that never catches anything, or raises false alarms, does not stay out of habit. Only the head agent edits this file. How the file is used: `docs/agents/procedures/weekly-review.md`.

- Add a row the day a check lands. Leave the last three cells empty.
- **Catches:** real mistakes it stopped. **False alarms:** times it refused good work. Count both from the block log (`docs/agents/glossary.md`) and the events.
- **Verdict**, after two weeks: `keep`, `fix`, or `remove`. Removing a check is a weakening: it needs a written reason and a reviewer's ruling, like a weakened test.

| Id | Check | Added | Should catch | Catches | False alarms | Verdict |
|---|---|---|---|---|---|---|
| TRIAL-1 | Example, delete this row: scripts/no-real-clock.mjs | 2026-11-18 | tests that read the real clock | | | |

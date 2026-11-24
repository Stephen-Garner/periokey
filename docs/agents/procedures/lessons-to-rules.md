# Turning Lessons into Rules

A mistake that can happen twice should be stopped by the system, not by memory. Rules written only as instructions get skipped; scripts do not.

## The ladder

Each kind of mistake gets a row in `docs/mistakes.md`, and its state climbs with it. The row also says which layer should have caught it: the commit hook, the checks, the review, the verify run, the merge gate, or nothing yet. The layer that should have caught it is the one to fix.

1. **First time:** write the trap under "Watch out for" in `docs/handoff.md`, one line, with how to avoid it. Add a row in state `note`.
2. **Second time:** make it a rule, but only when it showed up in at least two changes and can be seen from the change itself. A rule nobody can check from a diff gets skipped. If the risk comes with certain paths, add a row to `docs/change-checklist.md`: the reviewer is shown it whenever a change touches them. If only reviewers miss it, add it to `REVIEW.md`. If builders or reviewers must know it, add it to "Known traps" in `docs/project-rules.md`, with how to test for it. If every role must know it, add it to the project's rules in `AGENTS.md`. Set the row to `rule`.
3. **Must never break, or 3 repeats:** make it a check, with a test that fails when the rule is broken. Before it lands, a reviewer on a model that did not write it tries to find a good change the check would wrongly stop; fix the check until none is found. A project check goes in the project's own lint rules or tests. A check every project needs goes in the kit. Set the row to `check`, add a row to `docs/check-trials.md`, and delete the written rule: a lesson a check holds does not stay in the prose.
4. **Prune:** the weekly review drops rules, checklist rows, and checks that no longer earn their place (`docs/agents/procedures/weekly-review.md`).
5. **Always:** record the lesson in `docs/lessons.md`: the date, what happened, the rule it made, and where the rule lives.

## Where custom rules, scripts, and tests go

Never edit `docs/agents/`, `kit-lint/`, or any file under `files` in `scripts/kit.manifest.json` inside a project (CORE-14); `templates` in the manifest belong to the project. Put new checks and rules here:

| Kind | Where it goes | How it runs or syncs |
|---|---|---|
| Project-specific ESLint rule | `tooling/eslint/<name>.mjs` and `tooling/eslint/<name>.test.mjs` | Wire into `eslint.config.mjs` (never edit `kit-lint/`); make sure the project's test command or a `checks` entry in `scripts/kit.config.json` runs these tests (head agent edits `scripts/kit.config.json`) |
| Project-specific script or check | `scripts/<name>.mjs` (or `.ts`) and `scripts/<name>.test.mjs` | Add to `"checks"` in `scripts/kit.config.json` if it must run before merge |
| Project-specific app or feature test | Alongside app code (`src/`, `apps/`, `packages/`) | Runs with the project's test command |
| Project-specific prose trap or invariant | `docs/project-rules.md`, `REVIEW.md`, `docs/change-checklist.md`, `docs/invariants.md`, or outside the kit markers in `AGENTS.md` | Checked by reviewers and `scripts/check-plans.mjs` |
| Every-project (universal) rule, script, or lint rule | `~/dev/starter-kit/` (`process/`, `scripts/`, `lint/eslint-plugin-kit/`) | Check status with `node ~/dev/starter-kit/kit/sync-all.mjs`; sync each project in a `lead/` worktree with `node ~/dev/starter-kit/kit/sync.mjs --write` |

Outside the loop, tell Stephen what should change in the kit and why. In the loop, write it under "To review".

## New kinds of loop

Any process that repeats in rounds (scoring, critique, tuning) needs a decision file before it starts, with a stop rule someone can check. Before every round, check the stop rule and log the result as a dated note in the plan log. If it is met, stop.

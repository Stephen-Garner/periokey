# Builder Guide

You are a builder. You do one task, or one chunk of a task, on your own branch, then stop. Stephen is not in your chat.

## Read first, in this order

1. `docs/project-rules.md`, above all "Known traps"
2. Your plan, all of it, and the newest note in its plan log, `docs/plans/logs/NNN-short-name.md` (the last `## ` heading to the end)
3. `docs/architecture.md`, the index only, then only the part files your task touches
4. Anything the plan links to that your task needs

Your tool loads `AGENTS.md` by itself.

## Rules

- Work only in your own worktree and branch (CORE-2). Change only your own code and tests, plus your plan's Decision log and its plan log (CORE-4). The checker blocks the rest (CORE-3, CORE-14); propose those changes in your plan log note. Never skip the hooks with `--no-verify`.
- **Work alone (CORE-6).** Do not ask, wait for approval, or start another worker. Unclear on a small point: pick the simplest choice that meets the plan, log it in the Decision log, go on. Unclear on what gets built: write the question in the plan log and stop.
- Write tests that would fail if the behavior broke (which kind: `docs/agents/procedures/kinds-of-tests.md`). Pin dates and other outside inputs. Prove each review fix: commit it, remove it, watch a test fail, put it back (CORE-9). Answer every review finding with one line in `docs/findings/`.
- Run every check in the foreground: nothing wakes you after a background job (CORE-11). Run single test files, never a full run. A device needs the slot first (CORE-12, `docs/agents/ram-rules.md`).
- Commit and push to your branch, never to the base branch. Messages are `type: description`; a `fix` also needs `Fixes: <commit id>` or `Fixes: unknown`.
- Run `node scripts/slice.mjs task start N` as you begin task N, `task done N` at the end.
- **Do only the chunk in your message, all of it, in one run.**
- Never switch a check off in product code: `node scripts/switch-offs.mjs` fails on it. Fix the code, or change the rule project-wide (a weakening). A lint problem prints a `fix:` line: do that.
- A weakening needs one reason line: `node scripts/test-changes.mjs` prints those owed. Counts in `kit.ratchets.json` only go down: after removing uses, run `node scripts/ratchets.mjs update`.

## Apps that talk to a server

Skip this if the project has no server or screens. A **wait** is any time code waits for an answer, such as a network call.

- After every wait, check that the same account is still signed in, and act for and notify only it.
- A closed screen shows no message and opens no other screen.
- Number requests whose replies can arrive out of order, and use only the newest answer.
- A guessed value, shown before the server answers, stays marked unconfirmed until it does.
- A failed check leaves a working way to retry.
- Test each with a fake server that answers late or out of order.
- Screens: no fixed height on any control that holds text. Check every screen at the largest text size.

## Definition of done

- [ ] **Checks pass:** `node scripts/merge-pr.mjs --check --fast`, plus the test files for what you built.
- [ ] **Proof attached:** run the `docs/verify.md` section for what changed, and stamp the commit (`docs/agents/procedures/before-you-stop.md`). One note at the end of the plan log, headed `## YYYY-MM-DD builder: <task>`: each item done, partly done, or not started, with what the run showed and the test that proves it. Then a handoff: files changed and why, what is left, traps, setup.
- [ ] **Decision logged:** every choice you made is in the Decision log.
- [ ] **Review approved:** by a fresh reviewer, after you stop (CORE-5).

Then commit (plan log included), push, and stop any server, watcher, or device you started (CORE-13).

## Report

What changed (files, one line each), each check command with its result line, and anything skipped or unsure ("none" only if true, CORE-8).

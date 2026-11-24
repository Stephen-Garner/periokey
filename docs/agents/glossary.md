# Glossary

Every word the agent guides use, defined once. Other files point here instead of defining a word again. Words about the product go in the project's own `docs/glossary.md`.

## People and agents

- **Agent:** an AI model working in a thread with tools: it can read files, run commands, and edit code.
- **Thread:** one conversation with an AI tool, such as one Claude Code or Codex chat.
- **Role:** the job one agent does in one thread. See `docs/agents/core.md`.
- **Head agent:** the thread Stephen talks to. It plans, hands out tasks, checks work, merges, and keeps the memory files true.
- **Worker:** an agent the head agent starts for one job. Builders, reviewers, and research workers are workers.
- **Fresh:** started new, with no memory of earlier chats. A fresh worker knows only what its brief and the repo tell it.
- **Blind:** a reviewer that never sees the builder's chat, report, or summary.
- **Brief:** the task a worker gets: a guide file to read, plus a few lines naming its plan, task, and branch.
- **Context:** an agent's working memory for one thread. When it fills, the tool shortens it to a summary and detail is lost.
- **Token:** the unit AI usage is counted and billed in. Roughly four characters of text.

## Work

- **Slice:** one small feature that works end to end, with one plan file. Example: "save a word" covers the button, the logic, and the stored row.
- **Plan:** the file for one slice, in `docs/plans/active/` and later `docs/plans/completed/`. Its header holds the slice's status as data the scripts read. It holds only what a worker needs every turn: header, Goal, Done when, Tasks, Decision log, Review. The checker keeps a plan with a `log` header field at 12 KB or less (`planMaxBytes` in `scripts/kit.config.json`), and requires that field on every new plan.
- **Plan log:** the file beside a plan, `docs/plans/logs/NNN-short-name.md` (the plan's own file name), for progress notes, handoff notes, review findings, and test tables. Each note starts with a dated heading, `## YYYY-MM-DD <who>: <what>`, added at the end, so the newest is last. Nobody reads it whole: the next worker reads only from the last `## ` heading to the end. An older plan with no `log` field may still hold a Progress log and Notes for the lead; its builders may still edit those, and new notes go in the plan log.
- **Parked:** a plan status for a slice stopped on purpose, for example at its token limit. It keeps its number and builder, and nobody builds it until the head agent splits it or Stephen decides. See `docs/agents/procedures/blocked-slice.md`.
- **Run:** one batch of slices Stephen approves at once, with one token limit. Its file, `docs/runs/<name>.json`, holds its start, end, limit, and branches (its `lead/` branch and each slice's branch). `node scripts/run-file.mjs <file>` checks one.
- **Task:** one part of a slice, small enough for one fresh worker. A **chunk** is one part of a task: one screen or one focus.
- **Roadmap:** `docs/roadmap.md`, every slice in build order.
- **Memory files:** the docs a new thread reads to know where things stand: `docs/handoff.md`, `docs/roadmap.md`, `docs/awaiting-decisions.md`, and the plans. Chat is never the only copy of anything that matters.
- **Inbox:** how agents reach Stephen: asks for what only he can do or decide, and `docs/awaiting-decisions.md` for choices to review and answers to apply. See `docs/agents/procedures/inbox.md`.
- **Ask:** one short question for Stephen, filed with `node scripts/ask.mjs new`, with a reason, what it holds up, up to four options, and the agent's pick. It is kept in the event log. His answer is sent back to the thread that asked.
- **Stop list:** the few things agents never do without asking Stephen first (`docs/agents/core.md`, "What only Stephen does").
- **Definition of done:** the four things a task needs before it counts as done: checks pass, proof attached, review approved, decision logged. The checklist is in `docs/agents/builder.md`.
- **Proof:** what shows a Done when item is met: a test name, a command and its output, or a screenshot path.
- **Weekly review:** a short session Stephen starts by hand once a week (`docs/agents/procedures/weekly-review.md`).
- **Factory analyst:** an agent job Stephen starts from the dashboard. It reads the numbers, proposes a few changes to try, and changes nothing else. The design calls it the gardener.
- **Dashboard:** one page that shows the project's numbers, open asks, and jobs. It is built by `~/dev/starter-kit/dashboard/build.mjs` from git, the plans, and the event log.
- **Job:** a task an agent does for Stephen outside the slices, started from the dashboard's Jobs page, with a token limit.
- **Experiment:** one change tried for a set number of days, with one number that shows whether it helped (`scripts/experiment.mjs`).
- **Invariant:** a rule that must always be true in the product, such as "a user only sees their own data". Each is a row in `docs/invariants.md`, protected by a check or marked "not yet".
- **Mistakes list:** `docs/mistakes.md`, each kind of mistake agents made, with its state (note, rule, or check) and the layer that should have caught it.
- **Verify recipe:** `docs/verify.md`, how to start each part of the project, try a change as a user would, see the result, and stop it. Builders run it before the last commit of a task (`docs/agents/procedures/before-you-stop.md`).
- **Verified stamp:** the `Verified:` line at the end of a commit message, saying how the change was checked: `ran` (the recipe was run), `tests`, `checks`, or `none` with a reason.
- **User path:** what a person does from start to finish, such as "sign in, save a word, see it in the list". The plan's `proof:` line names the one that proves the slice.
- **Change checklist:** `docs/change-checklist.md`, things to check whenever a change touches certain paths, each learned from a real mistake. `node scripts/checklist.mjs` prints the rows a branch matches, and the reviewer answers each.
- **Review level:** quick, standard, or deep: how hard a review looks, set by code from the change (`docs/agents/procedures/review-levels.md`).
- **Security pass:** the questions a deep review asks about who can call the code, whose data it reaches, and where secrets go (`docs/agents/procedures/security-pass.md`).
- **Finding answer:** one line per review finding, in `docs/findings/`, saying what happened to it: fixed, wrong, intended, not worth it, or later.
- **Observe mode, or on watch:** the same thing, in the settings word and the plain word. A gate setting, `"observe"`, where the gate runs fully, records what it would have stopped, and stops nothing. `"enforce"` makes it stop the merge; `"off"` skips it.
- **Flaky test:** a test that passes sometimes and fails sometimes with no code change (`docs/agents/procedures/flaky-test.md`).
- **End-to-end, property, and differential tests:** a test of a whole user path; a test of a rule over many made-up inputs; a test that compares old and new code on the same inputs (`docs/agents/procedures/kinds-of-tests.md`).
- **Trial log:** `docs/check-trials.md`, each new check's two-week trial: what it should catch, what it really caught, its false alarms, and the verdict.
- **Thread record:** a short file in `docs/threads/` saying which thread did what and which thread came next.
- **Decision file:** one short file in `docs/decisions/` for a big choice: the options, the reason, and what would change our mind. Also called an ADR (architecture decision record).
- **Lead-only file:** a file only the head agent may change, such as the roadmap, `REVIEW.md`, `docs/invariants.md`, `docs/mistakes.md`, `docs/check-trials.md`, `docs/verify.md`, and `docs/change-checklist.md`. A builder proposes a change in its plan log note; the head agent makes it.
- **Owns:** a plan header field that lists the paths a slice will change. The checker refuses two running slices that own the same path (spelling and case do not count), and a builder's change to a path another running slice owns. `owns: none` means the branch may change only paperwork.
- **Snapshot:** one finished week's or month's numbers, saved into `docs/metrics/` by `dashboard/snapshot.mjs` so the history is in git.
- **Alert:** a line the dashboard prints when a plain rule is broken, such as a thread past its token limit or a slice that is parked. Agents see them with `--alerts`.
- **Case file:** docs/review-cases.md, the past commits that let a bug through, built by `node scripts/cases.mjs --write` from `Fixes:` lines. The "Reviewer score" job tests the reviewer on them.
- **Managed file:** a file the starter kit copied in and updates, such as everything in `docs/agents/`. Never edited in the project.
- **Paperwork change:** a change that touches only docs. **Code change:** anything else.
- **Automated loop:** a chain of head agent threads, each building one slice and starting the next, while Stephen is away.
- **Sweep:** a review of one area of the whole project instead of one branch.

## Git and GitHub

- **Branch:** a separate line of work in git. Changes on a branch do not touch the base branch until merged.
- **Base branch:** the branch everything merges into, usually `main`. `origin/main` is GitHub's copy of it, and the one to trust: a local `main` may be stale.
- **Worktree:** an extra working copy of the repo in its own folder, on its own branch. Two agents in two worktrees cannot overwrite each other's files.
- **Project root:** the main copy of the repo, where Stephen works. Agents never work there.
- **Pull request:** a request on GitHub to merge one branch into another. It shows every changed line, so the change can be checked first. A **draft** pull request is one marked not ready to merge.
- **Hook:** a script git runs on its own before a commit or a push.
- **Rule checker:** `scripts/check-plans.mjs`, the script that blocks a commit or merge when a rule is broken.
- **Commit message format:** `type: description`, where the type is a word such as `feat` (a feature), `fix`, `docs`, or `test`. `scripts/commit-msg.mjs` checks it on every commit.
- **Trailer:** a `Name: value` line at the bottom of a commit message. On a build branch the hook adds `Slice: NNN`. A `fix` commit needs `Fixes: <commit id>`, naming the commit that caused the bug, or `Fixes: unknown`.
- **Tree hash:** git's fingerprint of the exact contents of every file. Two identical sets of files always have the same one, so a check that passed on one need not run again on the other.
- **CI:** continuous integration, checks that a server runs before code lands. When there is none, the merge script is the CI.

## Checks

- **Typecheck:** a check that the code's data types fit together.
- **Lint:** a check for style and common mistakes.
- **Protected test:** a test file that already exists on the base branch. A change that edits, deletes, or renames one away needs the reviewer's verdict on that file by name; new test files are free, except that a fixed wait, a time limit, or retries in them still need a reason and a ruling. What counts as a test file is `testPaths` in `scripts/kit.config.json`.
- **Fingerprint (of a commit):** `git patch-id --verbatim` of its change. Moving a commit without edits keeps it; changing even one space changes it. For a merge, it is taken from what was done by hand beyond git's own merge.
- **Review receipt:** a small file in `docs/receipts/<task>-<id>.json`, made by `scripts/receipt.mjs` from the reviewer's own session record: its model, verdict, task, the fingerprints it was shown, and its protected test rulings. With `features.reviewReceipts` on, the merge script needs one for every code commit. It records an agent's approval, never Stephen's.
- **Finding:** one problem a reviewer reports, with a label. **Important** blocks the merge. **Nit** is small and never blocks; a review has at most five. **Pre-existing** is a problem in old code the branch did not change; it never blocks and is logged for later.
- **`REVIEW.md`:** the project's notes for reviewers: what matters in each area, what not to flag, traps reviewers miss. The reviewer reads it first.
- **Weakening:** any change that lets more through than before: a test deleted, skipped, moved, or loosened, or a line added inside an old test; a lint rule loosened or removed; a ratchet raised; a check removed or its command changed. It needs a reason line and a ruling. `node scripts/test-changes.mjs` lists the weakenings on a branch.
- **Reason line:** one line from the builder for each weakening, in a file under `docs/weakenings/`: `- path: why`. No reason, no merge.
- **Ruling:** a reviewer's verdict on one weakening or protected test, by name: allowed or refused. The review receipt records it. It must come from a model that wrote no code on the branch.
- **Lint hint:** the `fix:` line printed under a lint problem, saying what to change.
- **Ratchet:** a count that may only go down, such as the number of switched-off checks, kept in `kit.ratchets.json`. `node scripts/ratchets.mjs update` lowers the saved counts after uses are removed. A script lowers it when the real count drops; raising it is a weakening.
- **Switch-off:** a comment in code that tells a check to skip a line, such as `eslint-disable` or `@ts-expect-error`. A kit script fails on any switch-off in product code.
- **Preset:** a named set of check commands and file patterns for one language, such as TypeScript or Python, listed in `presets` in `scripts/kit.config.json`.
- **Risk label:** high or normal, given to each change by the paths it touches. `highRiskPaths` in `scripts/kit.config.json` lists the high-risk paths, such as sign-in, money, and database changes. It is recorded; it blocks nothing.
- **Event log:** `kit-events.jsonl` in git's shared folder, one line per thing that happened (an ask, an answer, a job, a review round), written by scripts through `scripts/events.mjs`. Every worktree writes to the same file.
- **Block log:** with `features.blockLog` on, the merge script adds one line per refusal (a failed check, a number clash, uncovered commits) and per merge to `kit-block-log.jsonl` in git's shared folder (`git rev-parse --git-common-dir`). Each line holds the fingerprints, so a later count can tell a real catch (the code changed) from a mistaken block (the same fingerprints later passed).
- **Fast checks:** the rule checker, the script tests, and every project check that needs no test slot. Run before a review.
- **Full checks:** the fast checks plus the full test suite. Run once, by the merge script.
- **Tier:** which set of checks a pull request gets. A paperwork change gets the rule checker and script tests only; a code change gets the full checks.

## Machine

- **RAM:** the computer's fast short-term memory. **Swap:** slow disk space the computer borrows when RAM is full.
- **Device:** an iPhone Simulator or an Android emulator, a fake phone running on the computer.
- **Dev server:** a program that serves the app's code while you work (Metro, Vite). It listens on a **port**, a numbered door such as 8081.
- **Fixture server:** a small fake server that tests or screenshots talk to instead of the real one.
- **Test run and workers:** a test runner starts helper programs called workers that run test files side by side. A **full run** runs all of a project's tests.
- **Watchman:** a program that watches folders for file changes. Every watched folder costs memory.
- **Slot:** permission to use something only one thread may use at a time: the device, a full test run, or a merge. `scripts/slot.mjs` hands them out.
- **Lease:** a slot held until a stated time, so a thread that died cannot hold it forever.
- **Settle:** in T3 Code, to file a thread away as finished. T3 settles a thread on its own once every pull request linked to it is merged.

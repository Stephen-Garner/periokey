# Head Agent Guide

You are the head agent: the project lead. You plan, hand out tasks, check work, merge, and keep the memory files true. You write little code yourself: only small fixes from a review. Words: `docs/agents/glossary.md`. Tool names for each step: `docs/agents/tools/t3-code.md`, or `docs/agents/tools/plain.md` outside T3 Code.

## Read first

1. `docs/agents/core.md`
2. `docs/project-rules.md`
3. `docs/handoff.md` and `docs/awaiting-decisions.md`

## The slice, in one picture

```mermaid
flowchart TD
  A[Start: status command, handoff, inbox] --> B[Pick one free slice]
  B --> C[Thread record draft, then opening pull request: plan and claim]
  C --> D[Fresh builder for one task]
  D --> E[Fast checks yourself]
  E --> F[Fresh reviewer, different model]
  F -->|changes needed| G[Fix small ones yourself, or a new builder]
  G --> E
  F -->|approve| H[Merge script: full checks, then merge]
  H -->|more tasks| D
  H -->|slice done| I[Closing pull request: done, handoff, inbox]
  I --> J[Next thread, then merge your thread record last]
```

A slice needs two paperwork pull requests, the opening and the closing, plus one code pull request per task. Paperwork merges take seconds: a docs-only change skips the app's tests.

## Start of a thread

1. Work in your own worktree, on a new lead branch: `git fetch -q origin && git switch -c lead/short-name origin/main`.
2. Run `node scripts/check-plans.mjs --status` (slices, open branches, open asks, the last push), then `node ~/dev/starter-kit/dashboard/build.mjs --project . --alerts`. Act on each alert line.
3. Apply anything under "Decided, to apply" in `docs/awaiting-decisions.md` first.
4. A **stalled slice** (live, but no open build branch) comes first: finish it.
5. Tell Stephen in five lines or fewer: where things stand, what you propose, what is blocked. In the loop, write that in your thread record instead.

## Picking work: the gates

Take slices in roadmap order. A slice may start only when all of these hold. The status command checks 1 to 3.

1. Every slice in its `depends_on` is `done`.
2. No other thread holds it (status `in_progress` or `in_review`, or an open branch for it).
3. It is not `blocked`.
4. It does not wait on a design that is not final, and Stephen approved the design if `AGENTS.md` says designs need his approval.
5. It is not a topic in `docs/planning-required.md`.

Skip a slice that fails a gate and take the next that passes.

## Steps of a slice

| Step | What you do | How |
|---|---|---|
| Open | Open your thread record as a draft. Then one pull request, merged before any builder starts: the plan, the roadmap row, `in_progress`, and the models. | `docs/agents/procedures/plan-a-slice.md` |
| Hand out | One fresh worker per task, in its own worktree, with a four-line message. | `docs/agents/procedures/hand-out-a-task.md` |
| Check | When a builder reports done, run the fast checks yourself: `node scripts/merge-pr.mjs --check --fast`, plus the test files the plan lists. A report does not count. | `docs/agents/reviews.md` |
| Review | Set `in_review`. Fresh reviewer on a different model. Fix small findings yourself; larger ones go to a new builder; every re-check is a new reviewer. | `docs/agents/reviews.md` |
| Merge | `node scripts/merge-pr.mjs <number> --wait 240` (a code change waits for a busy test slot in the same command). It merges the base in, runs the full checks once, posts the results, and merges. | `docs/agents/procedures/merge.md` |
| Close | Review line, `done`, plan moved, handoff and inbox rewritten. One pull request. Then cleanup, the next thread, and your thread record last. | `docs/agents/procedures/close-a-slice.md` |

## Rules that are easy to break

- **Claim before you delegate.** A worker's worktree starts from the last merged commit, and the checker rejects a build branch whose plan is not `in_progress` on the base branch.
- **Lead edits go on a `lead/` branch,** never a `build/` branch: the checker rejects them there no matter who makes them.
- **Wait on a worker only through its finished notice.** Never poll it. The one message you may send a running worker is a nudge to finish, with nothing that would bias it.
- **A re-check is always a new worker,** never a message to the old one.
- **At most two builders at once,** and only one at a time may add a package that needs a fresh install or app build.
- **Read the changed file list before every code merge:** `git diff --stat origin/main...<branch>`. A lead-only path in that list is a finding.
- **Ending a turn.** End a turn only while a worker you started is still running, or after the next thread is confirmed running. Otherwise nothing wakes you (CORE-11).
- **Files git ignores** (secrets, big built data) live only in the project root. Read them there by full path; never edit them there.

## When something else comes up

| Situation | Read |
|---|---|
| A slice waits on Stephen | `docs/agents/procedures/blocked-slice.md` |
| Another head agent is working at the same time | `docs/agents/procedures/parallel-threads.md` |
| You need the device or a full test run | `docs/agents/ram-rules.md` |
| Something for Stephen to do, review, or decide | `docs/agents/procedures/inbox.md` |
| The thread is getting long, or Stephen says stop | `docs/agents/procedures/close-a-slice.md` |
| What and when to tell Stephen | `docs/agents/procedures/report-to-stephen.md` |
| A trap came up twice, or proposing a new rule, script, or test | `docs/agents/procedures/lessons-to-rules.md` |
| Stephen says "start the loop" or "stop the loop" | `docs/agents/loop.md` |
| Stephen starts the weekly review | `docs/agents/procedures/weekly-review.md` |
| A choice that affects more than one slice | Write a decision file from `docs/decisions/000-template.md` |
| A plan needs a fact before it can choose | Start a research worker with `docs/agents/researcher.md` |

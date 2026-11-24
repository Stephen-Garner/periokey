---
id: 0
status: todo
depends_on: []
builder: ""
reviewer: ""
tests: []
code: []
log: docs/plans/logs/NNN-short-name.md
invariants: none
risk: normal
undo: revert the merge commit
owns: none
proof: the user path that shows it works, run from docs/verify.md, plus the tests
---

# NNN: Slice name

<!--
Make a plan with `node scripts/slice.mjs new <short-name> --title "..."`: it writes docs/plans/active/NNN-short-name.md (three digits, a dash, lowercase words joined by dashes) with the next free number, and its log file. Then link it from docs/roadmap.md.

Header fields (only the head agent edits them; the checker reads them):
  id          the number in the file name, without leading zeros
  status      todo, in_progress, in_review, blocked, parked (stopped on purpose), or done
  depends_on  ids of slices that must be done first, like [1, 2]
  builder     model that builds it, as tool/model-id, for example claude/claude-opus-5-5
  reviewer    model that reviews it; its model id must differ from the builder's and the head agent's
  tests       test file paths from the repo root (only files that exist)
  code        main code file paths from the repo root (only files that exist)
  log         this plan's log file: docs/plans/logs/ plus the plan's file name. Required on a new plan.
  invariants  ids from docs/invariants.md this slice touches, like [INV-1], or none
  risk        high or normal (high: it touches a path listed in highRiskPaths in scripts/kit.config.json)
  undo        one line: how to undo this slice
  owns        paths and folders this slice owns, like [src/search/]; none for a docs-only slice.
              The checker refuses two running slices that own the same path, or one inside the other.
  proof       one line: what will be shown to prove it works. Where a user can see the slice, name the
              user path that proves it (for example "sign in, save a word, see it in the list").
  matched_plan  added at close: yes, or no and one line on what differed
The fields from log to proof are required on a new plan, each on one line.

Sections: the checker requires Goal, Done when (with at least one checkbox), and Review, and on a new plan a numbered list under Tasks.
Builders may change only the Decision log. Everything else is locked for them.
The plan must stay at 12 KB or less (planMaxBytes in scripts/kit.config.json). Progress notes, handoffs,
review findings, and test tables go in the log file, never here (docs/agents/glossary.md, "Plan log").
Delete this comment when filled.
-->

## Goal

One sentence a user would understand.

## Done when

<!-- Each item must be testable: a test, a command, or a screenshot can prove it. -->

- [ ] A testable outcome

## Not in this slice

<!-- What a reader might expect here but is left out, and which slice takes it. Optional. -->

## Parallel work

<!-- Optional. Other slices running at the same time, and the shared files this one may touch. -->

## Tasks

<!-- A numbered list: each task starts a line as "N. text", numbered 1, 2, 3 with no gaps or repeats (the checker requires it on a new plan). A sentence before the list is fine.
Each task small enough for one fresh builder; split big ones into chunks of one screen or one focus. Name the branch for each: build/NNN-short-name, then -2, -3.
The plan says what the tasks are; the event log says what happened to them. A builder never edits this list. It runs, from its own branch:
  node scripts/slice.mjs task start N     when it begins task N
  node scripts/slice.mjs task done N      when all of task N is done -->

1. Task small enough for one fresh worker

## Decision log

<!-- Choices made during this slice that affect only this slice, and why. Bigger choices get a file in docs/decisions/. -->

- Choice made during this slice, and why

## Review

<!-- Head agent only. One line per review round, then the approval line when the slice closes:
Round 1: reviewed abc1234, changes needed, 3 findings
Review: approved by <reviewer> on YYYY-MM-DD
-->

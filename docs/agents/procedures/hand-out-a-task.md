# Hand Out a Task

How the head agent starts a builder, a reviewer, or a research worker. Tool names: `docs/agents/tools/t3-code.md`.

## Before you start a worker

1. The slice's opening pull request is merged: the plan is `in_progress` on the base branch.
2. The job is small: one task, or one chunk of a task (one screen or one focus). Each chunk gets its own fresh builder on the same branch; the next one reads only the previous one's handoff note, the newest note in the plan log.
3. Known traps are written down where the worker will read them: "Known traps" in `docs/project-rules.md`, and anything about this slice in the plan. Do not put them in the message.

## The message

Send only this. The worker's guide file holds everything else, so the message stays the same four or five lines every time.

Builder:

```
You are a builder for <Project>. Read docs/agents/builder.md and follow it.
Plan: docs/plans/active/<NNN-short-name>.md
Task: <number and one-line name from the plan's Tasks list; for a chunk, which part>
Branch: build/<NNN-short-name>
Earlier note: <"none", or "docs/plans/logs/<NNN-short-name>.md, dated YYYY-MM-DD">
```

Reviewer (first round):

```
You are a reviewer for <Project>. Read docs/agents/reviewer.md and follow it.
Plan: docs/plans/active/<NNN-short-name>.md
Branch: build/<NNN-short-name>
Round: 1
```

For a re-check, the last line is: `Round: <N>. Last reviewed commit: <short commit>. Earlier findings: docs/plans/logs/<NNN-short-name>.md, dated YYYY-MM-DD.`

Sweep reviewer (one area of the whole project, not one branch):

```
You are a sweep reviewer for <Project>. Read docs/agents/reviewer.md and follow round 1, on an area instead of a branch.
Area: <for example "tests that cannot fail">
Folders to read: <paths>
```

Research worker: the message block is in `docs/agents/researcher.md`.

## While a worker runs

- Each worker gets its own worktree.
- Wait only through its finished notice. Never poll it, and never wait on a background shell job.
- If a worker stops before its job is done, send it one message in its own thread asking it to finish, with nothing that would bias it. This nudge is the only message you send a running worker.
- A re-check after fixes is never sent to the old worker. It is always a new worker.
- Stop any worker you no longer need (its job changed, or you replaced it).
- Replace a worker whose context is filling up. Its notes go in the plan log first.

## Limits

- Write briefs in plain bug words. Another company's safety filter can refuse a task that says attack, exploit, bypass, cheat, evil, or fake key. Write "a made-up placeholder in the scanner's format" or "an unusual case" instead.
- At most two builders at once on one machine. Reviewers run after builders, not beside them.
- Only one builder at a time may add a package that needs a fresh install or an app build.
- A worker on another company's model, such as the reviewer, needs a tool that can start that model (`docs/agents/tools/t3-code.md`). If yours cannot, give Stephen the message block and ask him to start it.

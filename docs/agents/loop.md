# The Automated Loop

How to keep building while Stephen is away. Words: `docs/agents/glossary.md`.

## What the loop is

The loop is a chain of head agent threads. Each thread builds one slice, hands off, and starts the next thread with the same starting prompt. Nothing else drives it.

- **It is not a scheduler.** No cron job, scheduled task, or auto-restart starts or restarts it. If the chain breaks, it stays broken until someone looks.
- **It is off unless Stephen turns it on.** A thread is in the loop only when its starting prompt says so.
- **It needs a tool that can start threads** (`docs/agents/tools/t3-code.md`). Without one, each head agent finishes its slice and tells Stephen the handoff is ready.

Outside the loop, the default, Stephen is at the computer: ask him when something is unclear, and start no new thread unless he says to.

## Starting it

When Stephen says "start the loop" (or "keep building without me"):

1. Finish your current step and close your thread (`docs/agents/procedures/close-a-slice.md`, from step 5).
2. Check the stop conditions below. If one already holds, tell him and do not start.
3. Start a new head agent thread in its own worktree from the base branch's shared copy, with the head agent model from `scripts/kit.config.json`, the thread name from `AGENTS.md`, and the loop prompt from `AGENTS.md`.
4. Give Stephen its link.

## Rules inside a loop thread

1. **LOOP-1. Do not ask Stephen questions in the chat,** and never stop to wait for an answer. What only he can do becomes an ask, and you carry on.
2. **LOOP-2. Decide, then write it down.** When the plan or spec is unclear, make the best choice and keep going. Log it under "To review" in the inbox: what, why, where it lives, how to undo it.
3. **LOOP-3. Blocked work goes to Stephen and you move on** (`docs/agents/procedures/blocked-slice.md`).
4. **LOOP-4. One slice per thread, in roadmap order.** Take the next slice that passes the gates (`docs/agents/head-agent.md`).
5. **LOOP-5. Hand off at the end of each slice:** closing pull request, next thread with the same prompt, confirm it is running, your thread record last.
6. **LOOP-6. Models are fixed** in `scripts/kit.config.json`. If one is unavailable (usage limit, payment error, model removed), stop: file an ask with the reason (`docs/agents/procedures/inbox.md`), update the handoff, start no new thread. Never switch to another model or provider on your own.
7. **LOOP-7. If Stephen writes in a loop thread,** answer him and follow his guidance. The thread stays in the loop. Only his clear word to stop ends it.
8. **LOOP-8. All other rules still hold.**

## Stop conditions

A loop thread stops, and starts no new thread, when any of these holds:

1. Every slice is done.
2. Everything left is blocked on Stephen, on a design that is not final, or on a topic in `docs/planning-required.md`.
3. A model is unavailable (LOOP-6).
4. Stephen says "stop the loop" in any thread. From then on, no loop thread starts another.
5. The next thread fails to start twice. Write why in your thread record and leave its draft open, so your thread stays visible.
6. The merge script or the slot script is broken. File an ask that says what you saw.

When the loop stops, write one line at the top of the inbox: the date, why it stopped, and what Stephen should look at first.

## Keeping it alive

A loop dies quietly when a thread ends its turn with nothing to wake it.

- Run checks, builds, and deploys in the foreground (CORE-11).
- End a turn only while a worker you started is still running, or after the next thread is confirmed running.
- Keep your thread record's draft open until the very last step (CORE-16).
- A busy test slot (exit code 75) is not a reason to stop: do other work for this slice, then run the merge script again with `--wait 240`, which waits for the slot in the foreground (`docs/agents/procedures/merge.md`).
- To see whether a loop is alive, run `node scripts/check-plans.mjs --status`: the last line shows the newest push and marks it stale when it is old.

## Cost limits

The loop spends tokens while nobody watches.

- One slice per thread, and small worker chunks: small contexts cost less and forget less.
- At most two builders at once. Reviewers run after builders.
- Fixed models. No bigger model, and no extra critic or judge agents, unless Stephen put them in the settings.
- A "payment required" or "usage limit reached" message means stop (LOOP-6), not retry with another provider.
- No new kind of loop without a decision file and a stop rule checked before every round (`docs/agents/procedures/lessons-to-rules.md`).
- Three review rounds on one task, then stop and rethink or split it (REV-6). Every completed review (including `changes needed` rounds) counts toward `maxReviewRounds`. Never override `maxReviewRounds` or edit `extraReviewRoundSlices` in the loop: if `scripts/receipt.mjs make` prints `STOP`, park the slice, ensure an ask is filed for Stephen, log it under "To review", and move on to the next free slice.

## Records that make the work better

The head agent keeps these three files true, in the loop and out of it. They are lead-only: a builder proposes a row in its plan log note.

- **`docs/invariants.md`:** rules that must always hold. A plan lists the invariant ids it touches, and the change keeps each one's check passing. A rule with no check yet stays `not yet`: an open gap.
- **`docs/mistakes.md`:** each kind of mistake agents made, and its state: note, rule, or check (`docs/agents/procedures/lessons-to-rules.md`). When a listed mistake happens again, record the repeat as the file says. At 3 repeats, make it a check.
- **`docs/check-trials.md`:** a row for each new check, added by the head agent the day it lands. Its verdict comes at the weekly review (`docs/agents/procedures/weekly-review.md`).

## What Stephen sees when he comes back

- **Top of the inbox:** loop running, or stopped and why.
- **Open asks** on the dashboard: only what he can do, with exact steps.
- **To review:** one short item per choice the loop made, each with how to undo it.
- **`docs/handoff.md`:** where things stand and what is next.
- **Thread records** in `docs/threads/`: which thread built what, and the next thread's link.

## Stopping it

Stephen says "stop the loop" in any thread. That thread finishes its current step, closes (`docs/agents/procedures/close-a-slice.md`, from step 5), writes "loop stopped by Stephen" in its thread record and at the top of the inbox, merges its record last, and starts no new thread. To check nothing is still running, list open threads and tell Stephen the links of any loop threads that are not settled. Do not stop another thread yourself unless he asks.

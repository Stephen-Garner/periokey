# Close a Slice and End a Thread

The closing of a slice is one pull request on a `lead/` branch. Do the steps in this order.

## The closing pull request

1. Every Done when box is checked, and the last code pull request is merged.
2. In the plan's Review section, write `Review: approved by <reviewer> on YYYY-MM-DD`. The name must match the header's `reviewer`.
3. Set `status: done` and, if the header has `owns`, add `matched_plan: yes` (or `no, ` and what differed). Move the plan to `docs/plans/completed/`, and change its roadmap link to match. Add the files the slice created to the header's `tests` and `code` lists.
4. Update `docs/architecture.md` and the project's `docs/glossary.md` if the slice added parts or terms.
5. Rewrite `docs/handoff.md` (30 lines or fewer): Current state, Open branches, Next step, Watch out for.
6. Update the inbox (`docs/agents/procedures/inbox.md`).
7. If other head agents are working, merge the base branch in first and keep their lines in the handoff and inbox.
8. Commit, push, and run `node scripts/merge-pr.mjs <number>`.

## Clean up

9. Stop any server, test watcher, or device you started, and release any slot you hold (`node scripts/slot.mjs status` shows them).
10. List the threads you started and settle any that are done but still open.
11. Check for leftover worktrees. `scripts/merge-pr.mjs` already runs `scripts/clean-worktrees.mjs --delete` after every merge, but it keeps its own folder and any folder owned by an unsettled thread, so settling threads first lets this pass catch them. Run `node scripts/clean-worktrees.mjs --fetch` (a dry run that only lists; `--fetch` first updates git's copy of the base branch), check the list, then run it again with `--delete`. The script asks git and GitHub what is merged, the Mac which programs have a file open in each folder, and T3 Code which threads name them, so you do not list open threads first. It removes only folders whose work is safe elsewhere, with no program using them, no ignored file that may be the only copy, and no file changed for 15 minutes (0 minutes for a branch and commit passed with `--merged-branch` and `--merged-commit`), and it checks each one again just before removing it. It leaves unmerged worktrees alone: decide about each one it lists. To keep one more folder, add `--in-use <path>`. Never delete a worktree by hand.

## Hand off

12. Teach Stephen with a short brief in plain English, four bullets. In the loop, skip this.
    - What changed for a user, with one concrete example.
    - The file tree or the short data path, for example from a button to where the data is stored.
    - The test or rule that proves it works.
    - One quick question Stephen should be able to answer from the brief.
13. Start the next head agent thread: on your own inside the loop, only when Stephen says so outside it. Then finish your thread record and merge it last (`docs/agents/procedures/thread-record.md`).

## Ending a thread early

You cannot see how full your context is, so use stopping points.

- At each natural stop (a task merged, a review round finished), check whether the thread has run long. Signs: two or more tasks finished in this thread, or the conversation was already summarized once.
- If so, outside the loop, ask: "This is a good stopping point and this thread is getting long. Want me to update the handoff so you can start a fresh thread?" Inside the loop, hand off on your own.
- Never stop in the middle of a task without asking.
- To end early, do steps 5 to 13 with the slice still `in_progress`. The handoff says exactly where the slice stands.

# Parallel Head Agents

Stephen may run more than one head agent at once. Two slices that each pass their checks can still break the base branch once both merge. These steps keep them apart.

1. **Look before you pick.** Run `node scripts/check-plans.mjs --status`. A slice it lists as live, or that has an open branch, is never yours. Also look at your tool's list of open threads.
2. **Claim it early.** Merge your opening pull request (plan `in_progress`) before anything else. Write a "Parallel work" note in the plan: what runs beside it and which shared files it may touch.
3. **Pick for little overlap.** Compare the files your slice will change with what running slices change: `git diff --stat origin/main...origin/<their branch>`. Prefer slices that mostly add new files. Keep edits to shared hot spots (theme files, dependency lists, route files) small, and name them in the plan.
4. **Numbered things** (plan ids, decision files, database migrations): check the base branch and open branches for the next free number, and rename yours if another lands first.
5. **The merge script merges the base branch in before every merge** and runs the checks on the result. If the other slice's change breaks yours, fix it on your branch. Never edit the other slice's files or plan.
6. **Shared memory files.** When you rewrite `docs/handoff.md` or `docs/awaiting-decisions.md`, merge the base branch first and keep the other threads' lines.
7. **Slots are shared by every thread on the machine.** A busy test slot is normal with parallel threads: do other work, then run the merge script again with `--wait 240` (`docs/agents/procedures/merge.md`).

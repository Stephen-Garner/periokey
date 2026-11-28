# Merge a Pull Request

Every merge goes through one script. It does the steps a person would forget, and it picks the cheapest safe set of checks.

```sh
node scripts/merge-pr.mjs <number>          # merge ritual for one pull request
node scripts/merge-pr.mjs <number> --ready  # same, for a draft: marks it ready first
node scripts/merge-pr.mjs --check --fast    # quick checks on the current branch: skips checks marked "slot" or "fast": false
node scripts/merge-pr.mjs --check           # full checks on the current branch, no merge
node scripts/merge-pr.mjs <number> --wait 240  # if the test slot is busy, wait up to 240 s for it
node scripts/merge-pr.mjs <number> --no-clean  # skip post-merge worktree cleanup
```

## Before you run it

1. Be in your own worktree, on the pull request's branch (or a local `-N` branch that contains it, if another worktree holds the branch), with nothing uncommitted.
2. For a code pull request, read the changed file list yourself: `git diff --stat origin/main...<branch>`. A lead-only path in that list is a finding.
3. After every review round, approving or not, run `node scripts/receipt.mjs make <reviewer session file>` (Codex keeps them under `~/.codex/sessions/`, Claude Code under `~/.claude/projects/`; the file name holds the thread id). Commit and push `docs/receipts/<task>-<id>.json` on the branch. Every completed review counts toward `maxReviewRounds` (default 12, warning at 8, REV-6); past it, `make` allows at most one convergence grace round when `graceReviewRound` is on, then stops unless Stephen listed the slice in `extraReviewRoundSlices` on the base branch.
4. With `features.testReasons` on: `node scripts/test-changes.mjs` lists each weakening on the branch and prints the reason line the builder still owes. The rule is REV-7 in `docs/agents/reviews.md`.

## What it does

1. Fetches, merges the base branch into the branch, and pushes, so the checks run on exactly what will land. A conflict stops it: fix the conflict on the branch, then run it again.
2. Picks the tier from the changed files. Only paths in `paperworkPaths` (`scripts/kit.config.json`): paperwork tier, which runs the rule checker and the script tests. Anything else: code tier, which also runs every command in `checks`. A docs folder that tests or builds read from must not be in `paperworkPaths`.
3. For a branch that is not `lead/`, uses the rule checker and the settings as they exist on the base branch, so a branch cannot loosen its own rules.
4. Takes the machine's test slot for any check marked `slot`, and gives it back after.
5. Skips a check that already passed on the same tree hash.
6. With `features.incomingCommits` on, checks the commits the branch brings in, in every tier: each message must pass the commit message check (a leftover `fixup!` commit must be squashed first), and the secret scan runs over exactly those commits. A found key is in git history even after a later commit removes it: replace it at the service that issued it.
7. With `features.mergeLock` on (`scripts/kit.config.json`), takes the machine's merge lock just before its last fetch and holds it until GitHub merges, so two merges never cross. If the lock is lost on the way (its lease ran out), nothing merges: run it again.
8. With `features.duplicateNumbers` on, fails when two files in one `numberedPaths` folder share a number on the merged result. Renumber yours, push, and run it again.
9. With `features.reviewReceipts` on, refuses (exit 1, listing each commit) unless every code commit and hand-resolved merge after the base matches an approving review receipt from a model that is neither the builder's nor a head agent's (`models`), ruling on each protected test that commit touched. Before any check runs.
10. With `features.testReasons` on, refuses unless each weakening has the builder's reason line and a ruling of "allowed", by name, from a reviewer on such a model. `--check` checks the reasons only. Before any check runs. A settings change that makes the checks cover less is a weakening too, and takes effect only after it has merged.
11. At a merge only (not with `--check`), five more switches each refuse when their rule is broken: `verifiedStamp` (a code change needs a commit stamped `Verified: ran` or `tests`, or the newest one `Verified: none (<reason>)`), `changeChecklist` (each matched checklist row answered), `reviewLevels` (a receipt at the computed level or deeper), `securityReview` (at level deep, `SECURITY: clear`), and `findingAnswers` (an answer line for every finding of every round).
12. Labels the change high risk when it touches a path in `highRiskPaths`, and prints a `WARNING:` line, also with `--check`, when the branch adds more than `maxPrProductLines` lines of product code (default 700; tests by `testPaths`, `docs/`, and paperwork not counted). Split such a task before spending review rounds on it. Neither blocks anything.
13. Posts the result lines, the risk label, and the weakenings as a pull request comment, then merges exactly the commit it checked. A push that lands in between stops the merge: run it again.
14. With `features.events` on, writes each check run, each stopped merge, and the merge to the event log (`scripts/events.mjs`). A merge that moves a plan to `completed/` as done closes the slice there and marks its unlogged tasks done.
15. After GitHub confirms the merge, runs `scripts/clean-worktrees.mjs --delete --no-fetch --merged-branch <branch> --merged-commit <sha>` from the main checkout to remove finished worktrees (best-effort; never deletes a branch or fails the merge). Run from inside the merged worktree, it adds `--ignore-pid` for itself and for a one-shot `sh -c` shell that started it, so that worktree goes too; an open terminal or editor in it still keeps it. Pass `--no-clean` to skip.

A switch set to `"observe"` (on watch) only watches: where it would have refused, the merge prints `watching only: <switch> would have stopped this merge: <reason>`, records it, and goes on. Treat that line as a finding, not a pass: fix it, or report it at the weekly review (`docs/agents/procedures/weekly-review.md`).

Full output of each check goes to a log file; the screen shows one line per check, and the last lines of a failure.

## Exit codes

| Code | Meaning | What you do |
|---|---|---|
| 0 | Merged, or checks passed | Carry on |
| 1 | A check failed, or the merge has conflicts | Fix it on the branch, run again |
| 75 | The test slot or the merge lock is busy | Run the same command again with `--wait 240`. If that also ends in 75, run it once more, then do other work. Never loop on it, and never start the full run by hand instead |
| 2 | Wrong usage, or the worktree is not clean | Read the message |

## Rules

- `--wait` waits in the foreground. Give that shell call the tool's longest time limit (600 seconds in T3 Code and Claude Code). The wait and the full test run share that limit, so keep `--wait` at 240 or less. `--wait` works with `--check` too.

- Never merge with `gh pr merge` by hand, and never wait on GitHub's own check results unless `docs/project-rules.md` says the project uses them.
- A timing test can fail when the machine is busy. Before you call it a real failure, rerun that one file alone and report both results (RAM-8).
- When the script prints `STOP`, one check has failed three times in a row on the branch and an ask for Stephen is filed (needs `features.events`). Stop retrying that check and do other work.
- If the script itself is broken, say so to Stephen, or in the loop file an ask. Do not work around it.

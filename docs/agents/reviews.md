# Reviews

How work gets checked before it lands on the base branch. Words: `docs/agents/glossary.md`.

## Why reviews work this way

An agent that checks its own work repeats its own blind spots. A fresh reviewer on the same model shares the model's habits. A fresh reviewer on a different model misses different things, so that is what this project uses. Rules that must never break are also checks in `scripts/check-plans.mjs`, because agents skip instructions and scripts do not.

## Who reviews

1. **REV-1. Fresh every round.** A new reviewer for every review. A re-check after fixes is a new reviewer too, never the old one sent another message.
2. **REV-2. A different model** from every model that wrote code on the branch: the builder, and the head agent, because it fixes small findings itself. The checker compares model ids, so the same model through another tool counts as the same. The only exception: slices Stephen lists in `sameModelReviewSlices` in `scripts/kit.config.json`.
3. **REV-3. Blind.** The reviewer gets the plan path, the branch name, and the round number. Never the builder's chat, report, or summary: a reviewer that reads the builder's story tends to agree with it.
4. **REV-4. Edits nothing.** It reports. Fixes come from the head agent or a new builder.

## Before the reviewer starts

The head agent runs the fast checks itself on the builder's branch: `node scripts/merge-pr.mjs --check --fast`, plus the test files the plan header lists (how to run one test file is in `AGENTS.md`). A builder's "all tests pass" does not count. The full test suite runs once, later, inside the merge script. Then the head agent sets the plan `status: in_review` and starts the reviewer (`docs/agents/procedures/hand-out-a-task.md`).

## What the reviewer checks

The order, the labels, the report shape, and the rule for approving are in the reviewer's own guide, `docs/agents/reviewer.md`. In short: Done when, bugs, tests that cannot fail, rules, and fit with the plan and design. It rules by name on each protected test the branch touched and on each weakening. It answers each matched item of `docs/change-checklist.md`. How deep it goes follows the review level, set by code from the change (`docs/agents/procedures/review-levels.md`). It reports only what it can reproduce. It reads `REVIEW.md` first: what failure looks like in each area, what not to flag, the evidence it must give, and traps reviewers miss. The head agent keeps that file true: a false alarm that comes back goes under "Do not flag", and a bug a review missed goes under the traps.

## Fixing findings

Each finding has a label. **Important** blocks the merge. **Nit** never blocks; fix it only when it is cheap. **Pre-existing** (a problem in old code) never blocks: answer it `later`, and add it to `docs/roadmap.md` as a draft row with no plan link.

When you write a round's findings into the plan log note, number them R<round>.<n> in the reviewer's order (R1.1, R1.2, R2.1), so each answer can cite its finding.

1. **Small findings** (under about 40 lines, clear fix, at most one or two quick passes): the head agent fixes them itself, on the builder's branch or a `-N` branch from it. Never run multi-round state, persistence, or concurrency rewrites in the head thread: hand them to a fresh builder or simplify the design. If the head agent shares a model with any blind reviewer on the project, it never edits code on the branch: send every fix to a fresh builder, so no reviewer checks its own model's code.
2. **Larger findings:** a new fresh builder on a new `-N` branch, with the findings written as a dated note at the end of the plan log (`docs/agents/glossary.md`), never in the plan.
3. **Every finding gets one answer line** in `docs/findings/<branch file name>.md` (named like `docs/weakenings/`), from whoever fixes it: `- R<round>.<n> <label>: <outcome>: <note>`, for example `- R1.2 Important: fixed: the save now waits for the reply`. Outcomes: `fixed`, `wrong` (the reviewer was mistaken), `intended` (on purpose), `not worth it`, `later`. The note is 10 to 300 characters. A fixed Important finding has a test that fails without the fix (CORE-9). The next round's reviewer rules on each answer. Nothing is closed by silence: `node scripts/findings.mjs` lists the answers still owed, and with `features.findingAnswers` on the merge script refuses while any is.
4. **Make a receipt after every round,** approving or not (`docs/agents/procedures/merge.md`, step 3). The branch's receipts in time order are rounds 1, 2, 3.
5. **Record the round** in the plan's Review section: `Round N: reviewed <short commit>, <verdict>, <count> findings`.

An approval is always an agent's. A review receipt records which model approved; it never stands for Stephen's approval.

## Re-checks look at the fix, not the whole branch

6. **REV-5. Round 1 reviews the whole branch. Later rounds review the fix.** A re-check reviewer gets the earlier findings and the commit the last round reviewed. It does two jobs only: rule on each answer to an earlier finding, and check the fix itself (`git diff <last reviewed commit>..HEAD`) for new bugs. It is still fresh and still blind to the builder's chat. This keeps rounds from finding a different handful of things each time.
7. **REV-6. Three rounds, then stop and think.** If a task has been through three rounds and still has an Important finding, the plan is probably wrong or the task too big. Stop patching symptoms and check whether the design should be simplified. Outside the loop, ask Stephen. Inside the loop, split the task and log it under "To review". Every completed review counts toward `maxReviewRounds` (default 10 in `scripts/kit.config.json`, warning at round 7), including `changes needed` rounds and re-checks: never skip `scripts/receipt.mjs make` after a `changes needed` round. A reviewer that crashes or stops before giving a verdict does not count, and refreshing a receipt after a session log moves does not double-count. Past `maxReviewRounds`, `scripts/receipt.mjs make` refuses with `STOP` (and files an ask when `features.events` is on). Only Stephen may lift the cap for a slice by adding its number to `extraReviewRoundSlices` in `scripts/kit.config.json` on the base branch.
8. **On approval,** merge with the merge script, then write the review line when you close the slice (`docs/agents/procedures/close-a-slice.md`).

## Weakenings

Adding whole new tests is free, with one exception: a fixed wait (such as `sleep(500)`), a new or raised time limit, or automatic retries need a reason and a ruling even inside a brand-new test or test file (`docs/agents/procedures/flaky-test.md`). A weakening is a change that makes a guard weaker: an existing test deleted, a test case removed or skipped, an expected value or a saved snapshot changed, a line added to an old test file that is not a whole new test, a ratchet raised, a check removed or its command changed, the settings made to cover less, a wait, time limit, or retry added or raised, or a lint, type, test, commit hook, or CI workflow settings file changed. `scripts/test-changes.mjs` sorts them; its header says what it cannot see. A test file that changed in formatting only is free: the script proves it with the formatter the base branch's preset names. It sees only the paths the settings name: add the folders that hold test helpers and fixtures to `testPaths`, and the project's own snapshot files to `snapshotPaths` (`scripts/kit.config.json`).

9. **REV-7. Every weakening has a reason and a ruling.** With `features.testReasons` on (`scripts/kit.config.json`) the merge script enforces both, and neither waits for Stephen:
   - **The builder gives the reason:** one line per file in `docs/weakenings/<branch name, "/" written as "-">.md`, shaped `- path/to/file: one plain sentence`. `node scripts/test-changes.mjs` lists the weakenings and prints each line still owed. A line already in that folder on the base branch does not count again.
   - **The reviewer rules on each by name:** allowed, or refused. A ruling counts only for the reason and the exact file contents that reviewer was shown, so any later edit to that file needs a new ruling, and so does a change to it on the base branch. The reviewer also reads every whole new test for writes to shared state (an imported name, a global, the test runner): the script catches the plain ones only. A ruling by the builder's model or a head agent's never counts, in the base branch's settings or the branch's own, and refused stops the merge.
   - **The script records it** as a `weakening` event with the kind, file, reason, ruling, and the reviewer's model.

A branch cannot loosen this for its own merge: the switch, the protected paths, and the models of the base branch stay in force until the change that edits them has merged. A wrong ruling can still merge. It stays on record, and git can undo it.

## When reviews keep finding new things

The cause is often one kind of bug, repeated. In apps that talk to a server it is usually replies arriving late or out of order.

- Once a kind of bug shows up twice, add it to "Known traps" in `docs/project-rules.md`, with how to test for it. Builders and reviewers both read that list.
- **REV-8. A guard that would go blind is a bug now.** When a test or check is right for today's code but would quietly stop checking anything as the code grows, fix it in this slice. Do not log it for later, even when the plan asked for the narrow version. Prove the fix both ways: break the code once to show the guard fails, and show it still passes on good code. Do not ask Stephen again about a new case of this.
- Reviewers report only what they reproduce: they install dependencies the locked way, run the slice's tests, and open the screenshots.

## Sweeps

A sweep checks one area of the whole project, not one branch. For example, four fresh reviewers at once, one area each: screens against the design, database code, tests that cannot fail, and docs that no longer match the code.

1. Start each with the sweep message in `docs/agents/procedures/hand-out-a-task.md`.
2. Their findings become tasks in a new plan. Docs fixes are lead-only. Code fixes go to builders, then normal reviews.
3. A good time: after the first few slices, before a lot more is built on top.

## Reviewing screens

For slices that change how screens look or move:

1. The builder opens each screen it built on the project's device, in light and dark mode and at the largest text size, and names where the screenshots are saved in its plan log note.
2. The reviewer compares them with the design, and takes its own screenshots of anything missing or doubtful.
3. The head agent looks at the screenshots itself before merging.
4. The device needs the device slot (`docs/agents/ram-rules.md`).

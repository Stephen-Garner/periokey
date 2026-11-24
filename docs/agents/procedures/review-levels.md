# Review Levels

How deep a review goes. Code sets the level from the change, never the builder or the reviewer. `node scripts/review-level.mjs <branch>` prints `kit-level <level> <why>`. With `features.reviewLevels` on, `node scripts/receipt.mjs fingerprints <branch>` prints that line for the reviewer, who copies the level into the reply's `LEVEL:` line. With it off there is no line: write no LEVEL line, or `LEVEL: standard`. Both count as standard.

## How the level is set

- **deep:** the change touches a path in `highRiskPaths` (`scripts/kit.config.json`), such as sign-in, money, or deleting data.
- **quick:** every changed file is under `quickReviewPaths`, and the change adds and removes at most `quickReviewMaxLines` lines in all (50 unless the settings say otherwise). A binary file or an empty change is never quick.
- **standard:** everything else.

A branch cannot lower its own level: high-risk paths from the base branch and the branch both count, a quick path counts only when both list it, and the smaller line limit wins.

## What each level asks of the reviewer

| Level | Do |
|---|---|
| quick | Done when, and bugs in the changed lines only. No nits, no screenshots. |
| standard | The whole round 1 list in `docs/agents/reviewer.md`. For a screen change, compare the builder's screenshots with the design, and take your own of anything doubtful (a device needs its slot: `docs/agents/ram-rules.md`). |
| deep | All of standard, plus three things: the security pass (`docs/agents/procedures/security-pass.md`); run the `docs/verify.md` section for the change yourself; and for each invariant the plan lists, check that the rule still holds and its check still guards it. |

At deep, the reply has `SECURITY: clear` or `SECURITY: open`. An open security finding is always Important.

## Rules

- A deeper review than the computed level is always allowed. A shallower one is not: with `features.reviewLevels` on, the merge script refuses unless every commit that needs review is covered by a receipt at that level or deeper. With `features.securityReview` on, a deep change also needs a receipt that says `SECURITY: clear`. Both run at a merge only, not with `--check`.
- With both switches off, every review is a standard one.
- Later rounds look at the fix only (REV-5, `docs/agents/reviews.md`), at the same level.

# Handoff

Rewritten by the head agent at the end of each thread. Keep it to 30 lines or fewer (the checker enforces this).

## Current state
- 2026-11-24: Slice 000 built on branch `lead/000-foundation` (worktree `~/dev/periokey-000`), not yet committed, reviewed, or merged. Parser, profiles, Windows and macOS typing, Deepgram and OpenAI speech, and the page all exist; 43 unit tests pass.
- Not yet checked: real Eaglesoft typing on Windows, and either speech service with a real key.
- No GitHub remote yet. Creating one needs Stephen's go-ahead.

## Open branches
- `lead/000-foundation`: slice 000, waiting for commit and review.

## Next step
- Finish slice 000 review (docs/plans/active/000-foundation.md), then plan slice 001, the on-site Eaglesoft check.

## Watch out for
- Raw `oxlint .` reports errors in the kit's own `scripts/merge-pr.test.mjs`. Use the check command in `scripts/kit.config.json`, which passes.
- The kit bans code comments in `src/`, `public/`, and `profiles/`.

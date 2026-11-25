# Handoff

Rewritten by the head agent at the end of each thread. Keep it to 30 lines or fewer (the checker enforces this).

## Current state
- 2026-11-24: Slice 000 is `in_progress`. The Tauri desktop app is on `build/000-tauri-desktop`, PR #1, head 32ba48b (worktree `~/dev/periokey-tauri`). 97 tests and fast checks pass; Windows code compiles but has never run on Windows.
- Review round 2 (Astra, 2026-11-24): changes needed, 5 important, 2 nit. All 6 weakenings ruled allowed. Findings are in `docs/plans/logs/000-foundation.md`.
- GitHub secret `TAURI_SIGNING_PRIVATE_KEY` is set. The key has no password, so no password secret is needed.

## Open branches
- `build/000-tauri-desktop` (PR #1): waiting on round 2 fixes.
- `lead/000-thread` (PR #2): the old thread's record, merged once you are running.

## Next step
1. Ask Stephen two product questions (Astra findings 4 and 5) with `scripts/ask.mjs`: may the desktop app keep API keys in its settings file (AGENTS.md says `.env` only), and may AI-chosen corrections type in Live mode (spec section 5)?
2. Start a fresh builder on PR #1 for findings 1, 2, 3, 6, 7, then whatever Stephen answers on 4 and 5. Then a new Astra review round, then merge PR #1.
3. After PR #1 merges, commit `docs/drafts/release.yml` as `.github/workflows/release.yml` and apply `docs/drafts/readme-prev-tooth.patch` (head agent only paths), then delete `docs/drafts/`.

## Watch out for
- `~/dev/periokey-tauri` holds an untracked copy of `release.yml`; it is saved in `docs/drafts/` too.
- Builders may not edit `README.md` or `.github/`.
- Raw `oxlint .` reports errors in kit scripts. Use the check commands in `scripts/kit.config.json`.
- The kit bans code comments in `src/`, `public/`, and `profiles/` unless they start with `why:` on one line.

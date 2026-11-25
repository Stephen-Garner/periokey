# 000: Foundation log

## 2026-11-24 builder: kit installed

Kit installed with `node ~/dev/starter-kit/kit/sync.mjs --write`.

## 2026-11-24 builder: first working PerioKey

Built the parser, profiles (Eaglesoft default), key encoder, Windows and macOS typing, Deepgram and OpenAI speech adapters, the server, and the page. Eaglesoft's 10 to 15 key is unknown, so it refuses those depths until checked on-site.

| Check | Result |
|---|---|
| `pnpm test` | 43 of 43 pass |
| `pnpm exec tsc --noEmit` | pass |
| eslint and oxlint checks from `scripts/kit.config.json` | pass |
| Practice-mode smoke test on port 4399 | pass |
| Real Eaglesoft, real speech key | not run (no Windows PC or keys here) |

Proposed for `docs/change-checklist.md`: when `profiles/` changes, ask who checked the key in the real software.

## 2026-11-24: review round 2 of the Tauri app (Astra, codex gpt-6.2-astra)

Verdict: changes needed on 32ba48b. 5 important, 2 nit, level deep, security open. All 6 weakenings ruled allowed.

1. Important, `src-tauri/src/keys.rs`: any program whose title holds `Perio Exam` passes. Also check the owning program, and refuse Live typing until the office has checked the target.
2. Important, `src-tauri/src/keys.rs`: Stop cannot reach the Rust typing loop. Pass a cancel flag in, check it before each key, report keys sent.
3. Important, `src/desktop/pill.ts`: Start, Stop, Start during a pending mic request can leave the mic off while the pill says listening. Recheck when the request settles; add a test.
4. Important, `src-tauri/src/lib.rs`: API keys are saved in `settings.json` and sent to both windows; the project says keys live only in `.env`. Needs Stephen.
5. Important, `src/engine.ts`: AI-chosen corrections type in Live mode, against spec section 5 (same words, same keys). Keep them Practice-only unless Stephen changes the rule.
6. Nit, `src/desktop/host.ts`: valid JSON with a wrong type (`{"env":{"STT_PROVIDER":42}}`) still crashes startup. Keep only string values.
7. Nit, README: note that `prev_tooth` Left is unverified (patch in `docs/drafts/`).

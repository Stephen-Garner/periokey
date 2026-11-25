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

## 2026-11-24 builder: Tauri desktop app

Turned PerioKey into a Tauri v2 Windows app. The pill window runs the TypeScript engine (`src/engine.ts`, moved out of `src/server.ts`) and the mic. Rust does only typing (SendInput, front window checked before every key), the PHI-free focus check (MATCH, EMPTY, MISMATCH, with MDI child search), the tray, the global hotkey, settings storage, and updates.

| Check | Result |
|---|---|
| `pnpm test` (through the slot) | 91 of 91 pass |
| tsc, eslint, oxlint, prettier, switch-offs, ratchets | pass |
| `cargo check` (macOS) | pass, no warnings |
| `cargo check --target x86_64-pc-windows-msvc` | full app blocked: `ring` (updater TLS) needs Windows SDK headers; `src-tauri/src/keys.rs` alone compiles clean for Windows |
| actionlint on the release workflow | pass |
| Real Windows, real Eaglesoft | not run (no Windows PC here) |

Not verified, needs an on-site check: `prev_tooth` = Left (it may jump a whole tooth); whether clicking the WebView2 pill takes focus despite WS_EX_NOACTIVATE (the focus check and LOST_FOCUS pause safely if it does); the WebView2 mic prompt.

Head agent only: `.github/workflows/release.yml` is written in the worktree but not committed (builders may not change `.github/`). Stephen must add the repo secrets `TAURI_SIGNING_PRIVATE_KEY` (contents of `~/.tauri/periokey.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty).

Duplicates to clean up later: `public/app.js` still has its own copies of the chart, cadence, and audio code now in `src/chart.ts`, `src/audio.ts`, and `src/desktop/settings.ts`.

## 2026-11-24: review fixes for the Tauri app (builder)

Astra graded the first build D and Neon graded it C-. Both accepted the 6 weakening reasons. Fixed:

- Typing checks the control that has keyboard focus and the windows that hold it, not any child window, so a Perio Exam left open behind another Eaglesoft window does not match.
- Every key is resolved before the first one is sent. Typing stops if Ctrl, Alt, Shift, or Windows is held. Keys carry scan codes.
- The pill never takes focus: `focusable: false`, a WM_MOUSEACTIVATE handler, and a style refresh. It is shown and hidden the same way.
- Stop during the focus check means nothing is typed (test proven to fail without the guard).
- "Redo that tooth" is Practice-only, since the Left key is unverified. A profile may leave `prev_tooth` out.
- The mic cannot start twice, and a late mic stream is closed. Settings asks for the mic first so names show.
- Settings save atomically. A corrupt settings file or bad profile edit falls back to defaults. Pasted keys are cleaned or refused. A key that breaks the WebSocket gives a fixed message that never quotes the key. Saved keys can be cleared.
- The AI filter runs only with an OpenAI key. A failed hotkey change keeps the old hotkey.
- Copy stats copies counts and timings only, never words.

Not fixed, for the head agent: keys reach both windows (needs a token design); the gap between the focus check and SendInput; another app with a matching title passes the check; Rust cannot stop mid-phrase; no Windows code signing; GitHub release secrets not added; WebView2 click and focus not yet tried on Windows; repeated code in public/app.js.

## 2026-11-24: review round 2 of the Tauri app (Astra, codex gpt-6.2-astra)

Verdict: changes needed on 32ba48b. 5 important, 2 nit, level deep, security open. All 6 weakenings ruled allowed.

1. Important, `src-tauri/src/keys.rs`: any program whose title holds `Perio Exam` passes. Also check the owning program, and refuse Live typing until the office has checked the target.
2. Important, `src-tauri/src/keys.rs`: Stop cannot reach the Rust typing loop. Pass a cancel flag in, check it before each key, report keys sent.
3. Important, `src/desktop/pill.ts`: Start, Stop, Start during a pending mic request can leave the mic off while the pill says listening. Recheck when the request settles; add a test.
4. Important, `src-tauri/src/lib.rs`: API keys are saved in `settings.json` and sent to both windows; the project says keys live only in `.env`. Needs Stephen.
5. Important, `src/engine.ts`: AI-chosen corrections type in Live mode, against spec section 5 (same words, same keys). Keep them Practice-only unless Stephen changes the rule.
6. Nit, `src/desktop/host.ts`: valid JSON with a wrong type (`{"env":{"STT_PROVIDER":42}}`) still crashes startup. Keep only string values.
7. Nit, README: note that `prev_tooth` Left is unverified (patch in `docs/drafts/`).

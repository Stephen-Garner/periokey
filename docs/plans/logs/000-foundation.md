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

## 2026-11-24 builder: Astra round 2 fixes (R2.1, R2.2, R2.3, R2.6)

Merged `origin/main` into the PR branch first; the plan log keeps both the builder notes and the round 2 review.

| Item | State | Proof |
|---|---|---|
| R2.1 a copied title passes | done | Rust checks the owning program's file name too (`target_matches`, `program_is`). Live in the desktop app refuses until "program file name" is set. Tests: `cargo test` `a_matching_title_in_another_program_does_not_pass`, `program_must_match_by_file_name`; `src/engine.test.ts` "refuses to start until the office sets the program file name" and "the program file name goes with every focus check" |
| R2.2 Stop cannot reach Rust | done | Each phrase carries a number; Stop calls `stop_typing`; the loop (`type_each`) checks before every key and replies `STOPPED n`, shown as "Paused: stopped after n of m keys". Tests: `cargo test` `stop_during_typing_halts_before_the_next_key_and_reports_keys_sent`, `stop_covers_every_phrase_at_or_below_its_number`; `src/engine.test.ts` "Stop while keys are being typed"; `src/desktop/host.test.ts` "Stop tells Rust" |
| R2.3 mic off after Start, Stop, Start | done | `src/desktop/mic-sync.ts` checks again when each open settles. Test: `src/desktop/mic-sync.test.ts` (3 tests) |
| R2.6 wrong-type settings crash | done | `settingsFrom` keeps only text values in `env`. Test: `src/desktop/host.test.ts` "a number where text belongs" |
| R2.4, R2.5 | not started | waiting on Stephen, as told |
| R2.7 README | not started | patch already in `docs/drafts/`; answered `later` |

CORE-9: I undid each fix one at a time (program check in Rust, Stop check in Rust, engine program refusal, engine stop call, mic recheck, text-only env) and each made its test fail; then restored.

Checks: `node scripts/merge-pr.mjs --check --fast` all 11 pass. `node --test` on `src/desktop/mic-sync.test.ts` (3), `src/desktop/host.test.ts` (9), `src/engine.test.ts` (8), `src/keymap.test.ts` (12), `src/injector.test.ts` (11): all pass. `cargo test` 5 pass; `cargo check` (macOS) clean, no warnings. Windows: `keys.rs` compiled clean for `x86_64-pc-windows-msvc` in a scratch crate; the full app is still blocked by `ring` needing Windows SDK headers. `pnpm build:desktop` builds.

Run: the verify recipe's web page section on port 4318 showed 3, 2, B, then 12, then ⌫, with "Keys sent: ⌫" and no server errors. No recipe section covers the desktop app; proposed for the head agent: "Start: `pnpm build:desktop && pnpm tauri dev`; Try: Settings, Practice, say a phrase; Look: chart fills, pill shows Listening; Stop: Quit from the tray." Real Windows and real Eaglesoft: not run (no Windows PC).

Handoff:
- `src-tauri/src/keys.rs`: program check, stop counter, pure helpers with Rust tests. `src-tauri/src/lib.rs`: `send_keys` takes `program_match` and `token`; new `stop_typing` command. `src-tauri/Cargo.toml`: `Win32_System_Threading` for the process name.
- `src/focus.ts`: optional `stop()` on the injector, program argument, `STOPPED n` replies. `src/engine.ts`: passes the program, calls `stop()` on every stop, `noProgramNote` refusal. `src/keymap.ts`: optional `program_match`.
- `src/desktop/host.ts`: text-only env, injector numbers phrases and takes an `invoke` for tests. `src/desktop/mic-sync.ts` (new), `src/desktop/pill.ts` uses it. `desktop/settings.html`: "program file name" field, marked unverified.
- Left: R2.4 and R2.5 (Stephen), R2.7 (head agent). Someone on-site must find Eaglesoft's program file name (Task Manager, Details tab) and enter it before Live mode works in the desktop app.
- Trap: the web page path (`src/win-helper.ps1`) still matches the title only; worth the same program check later.

## 2026-11-24 builder: Astra round 2 findings R2.4 and R2.5

Merged `origin/main` into the PR branch first, to get decisions 001 and 002 and the updated spec.

| Item | State | Proof |
|---|---|---|
| R2.4 keys in `settings.json` and sent to both windows | done | New `src-tauri/src/secrets.rs`: keys live in Windows Credential Manager (`CredReadW`/`CredWriteW`/`CredDeleteW`) or the macOS Keychain. `save_settings` and `load_settings` strip keys; an old file that holds keys is rewritten without them. `read_api_keys` answers the `pill` window only; `set_api_key` and `clear_api_keys` answer `settings` only; `api_key_status` gives two booleans. `settings-changed` still carries no payload. Errors never quote a key. Rust tests: `keys_are_stripped_from_settings_json_and_the_rest_is_kept`, `bad_settings_json_is_refused_without_quoting_it`, `only_the_pill_window_may_read_raw_keys`, `status_says_saved_or_unset_and_nothing_more`, `settings_sets_and_clears_keys_and_the_pill_cannot`, `bad_names_and_values_are_refused_without_quoting_the_value`. TS tests in `src/desktop/host.test.ts`: "saved settings never carry an API key", "keys left in an old settings file are ignored", "Settings sees only saved or unset", "the pill's keys come from the credential store", "setting and clearing keys go to the credential store commands" |
| R2.5 AI corrections type in Live mode | done (intended, decision 002) | No product change. Live already refuses `prev_tooth` and tooth jumps from the AI. New tests in `src/engine.test.ts`: "live: an AI reply with goto_tooth / set_tooth is refused with a buzz and types nothing" (they check the tooth-jump message, since a second guard, no keys for tooth actions, would also buzz). The existing "live: a whole-tooth redo is refused" test already covers `prev_tooth` from the AI |

CORE-9: I removed each guard one at a time and watched its test fail, then restored: pill-only read, settings-only set, known key names only, stripping `env` keys (Rust); stripping keys on save, ignoring keys in an old file, booleans-only status (TS); the Live tooth-jump refusal (engine, 2 tests fail).

Checks: `node scripts/merge-pr.mjs --check --fast` all 11 pass. `node --test` on `src/engine.test.ts` (10), `src/desktop/host.test.ts` (14), `src/desktop/mic-sync.test.ts` (3): all pass. `cargo test` 11 pass; `cargo check` (macOS) clean, no warnings; `cargo fmt --check` clean. Windows: `secrets.rs` compiled clean for `x86_64-pc-windows-msvc` in a scratch crate (the full app is still blocked by `ring` needing Windows SDK headers). `pnpm build:desktop` builds. `node scripts/test-changes.mjs`: the same 6 weakenings, all with reasons; none new.

Run: not run. The verify recipe covers only the web page, which this change does not touch. I did not start the desktop app, because it would write to the real Keychain on this Mac. Not yet tried on a real machine: saving, reading, and clearing a key in Windows Credential Manager and in the macOS Keychain.

Handoff:
- `src-tauri/src/secrets.rs` (new): key store trait, OS stores for Windows and macOS, window checks, settings stripping, tests with an in-memory store.
- `src-tauri/src/lib.rs`: `load_settings` and `save_settings` strip keys; new commands `read_api_keys`, `api_key_status`, `set_api_key`, `clear_api_keys`.
- `src-tauri/Cargo.toml`: `Win32_Security`, `Win32_Security_Credentials` features; `security-framework` on macOS.
- `src/desktop/host.ts`: `KEY_NAMES`, `loadKeys`, `loadKeyStatus`, `saveKey`, `clearKeys`; `settingsFrom` and `saveSettings` drop key names; `configOf(settings, keys)`. Each takes an `invoke` for tests.
- `src/desktop/pill.ts`: reads keys from Rust at start and on `settings-changed`. `src/desktop/settings.ts`: saves and clears keys through Rust, shows saved or unset only.
- `src/engine.test.ts`: two R2.5 tests.
- Left: an on-site check that keys save, survive a restart, and clear in Windows Credential Manager. A key saved by an older build in `settings.json` is wiped, not moved; the office must paste it again.
- Trap: a macOS Keychain prompt may appear the first time an unsigned dev build reads a key.

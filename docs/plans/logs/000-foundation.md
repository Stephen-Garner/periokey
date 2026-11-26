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

## 2026-11-25 builder: Astra round 3 findings R3.1 to R3.4

Astra round 3 (head 6784691) found 4 Important problems: R3.1 a clean lone depth ("three", "10") still called the AI filter, against decision 002; R3.2 keys in an old `settings.json` were wiped, not moved; R3.3 if audio setup failed after the mic opened, the mic stayed on and the open retried in a loop; R3.4 a late "stopped after 0" reply from a phrase typed before Stop paused the new session after Stop then Start.

| Item | State | Proof |
|---|---|---|
| R3.1 clean lone depths skip the AI | done | `needsAiFilter` now sends an accepted, cue-free, known-word phrase to the AI only when it is one sound-alike ("to", "for"). Tests: `src/ai-filter.test.ts` "clean runs, lone depths, and lone commands take the instant path, with no AI call"; `src/engine.test.ts` "live: a clean single depth types it with fixed rules and never calls the AI" |
| R3.2 old keys move before the file is rewritten | done | `secrets::move_old_keys` moves each old key into the store and keeps a key already stored. `load_settings_at` rewrites the file only when every move worked; `save_settings_at` moves old keys first and refuses the save if a move fails. Rust tests: `old_keys_move_to_the_store_and_a_saved_key_is_kept`, `an_old_key_moves_to_the_store_then_the_file_loses_it_and_a_second_launch_is_quiet`, `a_key_already_in_the_store_is_kept_over_the_old_file`, `a_failed_move_leaves_the_old_settings_file_untouched` |
| R3.3 failed mic setup closes the mic | done | `handle.start()` failing closes the handle, reports once, and sets a latch that clears only when `wanted()` goes false. Test: `src/desktop/mic-sync.test.ts` "audio setup failing after the mic opens closes it, reports once, and waits for the next Start" |
| R3.4 stale Stop reply | done | The typing job catches its own error and drops "stopped after 0" when its session is no longer the current one. New `stoppedCount` in `src/focus.ts`. Tests: `src/engine.test.ts` 'live: a late "stopped after 0" from before Stop leaves the new session listening' and 'live: a late "stopped after 2" from before Stop pauses the new session with the count' |

CORE-9: I removed each fix one at a time and watched its tests fail, then restored: the AI routing (2 tests fail), the stale STOPPED 0 guard (1 fails), the mic close-on-setup-failure and the retry latch (1 fails each), load's move-before-rewrite (2 fail), keeping a stored key (2 fail), save's move-first (1 fails). The "stopped after 2" test pins behavior that was already right, so it passes either way.

Checks: `node scripts/merge-pr.mjs --check --fast` all 11 pass. `node --test` on `src/engine.test.ts`, `src/ai-filter.test.ts`, `src/desktop/mic-sync.test.ts`, `src/desktop/host.test.ts`, `src/parser.test.ts`: 62 pass. `cargo test` 15 pass; `cargo check` (macOS) clean; `cargo fmt --check` clean. Windows: `secrets.rs` compiled for `x86_64-pc-windows-msvc` in a scratch crate (only "never used" warnings, since nothing calls it there). `keys.rs` was not changed and was not cross-checked: it needs `tauri`, which does not build for Windows on this Mac (`ring` needs Windows SDK headers). `pnpm build:desktop` builds. `node scripts/test-changes.mjs`: the same 6 weakenings; the `src/ai-filter.test.ts` and `src/engine.test.ts` reasons were updated for this round. `docs/findings/`: R3.1 to R3.4 answered, R2.4 and R2.5 shortened to 300 characters or fewer.

Run: not run. The verify recipe covers only the web page, and I did not start the desktop app, since it would touch the real Keychain on this Mac. Not yet tried on a real machine: moving an old key from `settings.json` into Windows Credential Manager.

Handoff:
- `src/ai-filter.ts`: `needsAiFilter` keeps clean accepted phrases on fixed rules; `src/ai-filter.test.ts` lists moved.
- `src/engine.ts`, `src/focus.ts`: the typing job ignores a stale "stopped after 0"; `stoppedCount` reads the count.
- `src/desktop/mic-sync.ts`: close on setup failure, one report, latch until the next Start.
- `src-tauri/src/secrets.rs`: `move_old_keys`. `src-tauri/src/lib.rs`: `load_settings_at` and `save_settings_at` (testable with any store), plus file tests.
- `docs/findings/`, `docs/weakenings/`, the plan's Decision log: updated.
- Left: on-site check that an old key moves into Windows Credential Manager on first launch.
- Trap: the Rust file tests write under the system temp folder and remove their folder at the end.

## 2026-11-25: review round 4 of the Tauri app (Astra, codex gpt-6.2-astra)

Verdict: changes needed on 8a1faba. 2 important.

1. Important, `src-tauri/src/lib.rs:84`: `save_settings_at` reads an unreadable `settings.json` as empty, so it skips moving old keys and then replaces the file, losing them. Treat only `NotFound` as absent; stop on any other read error.
2. Important, `src-tauri/src/lib.rs:66`: clearing keys deletes them from the credential store only. A key still in an old `settings.json` moves back on the next launch. Remove it from the file too, and say done only when both work.

## 2026-11-25 builder: Astra round 4 findings R4.1 and R4.2

| Item | State | Proof |
|---|---|---|
| R4.1 unreadable settings file stops a save | done | New `read_existing` in `lib.rs`: a missing file reads as empty; any other read error returns "could not read the saved settings file" and nothing is written. `save_settings_at` uses it. Tests: `an_unreadable_settings_file_stops_a_save_and_is_kept` (file set to mode 000, save fails, file unchanged), `a_missing_settings_file_still_saves` |
| R4.2 clearing removes the old copy too | done | New `clear_api_keys_at(label, path, store, names)`: checks the window, deletes each named key from the store, then removes only those keys from `settings.json` (rest kept), and returns `Ok` only after both. `secrets::clear_for` now takes the names; new `secrets::strip_named`. The `clear_api_keys` command calls it with both names. Tests: `clearing_a_key_also_removes_its_old_copy_so_a_later_launch_cannot_restore_it` (failing store keeps both old keys in the file, store recovers, OpenAI cleared, Deepgram and other settings kept, next load moves only Deepgram), `clearing_fails_when_the_old_copy_cannot_be_removed` |

CORE-9: with `save_settings_at` reading through `unwrap_or_default` again, the unreadable-save test fails. With the file step of `clear_api_keys_at` removed, both clearing tests fail. Both fixes put back; all pass.

Checks: `node scripts/merge-pr.mjs --check --fast` all 11 pass. `cargo test` 19 pass; `cargo check` (macOS) clean; `cargo fmt --check` clean. `node scripts/test-changes.mjs`: the same 6 weakenings as round 3, none new. Windows was not cross-compiled this round (no Windows-only code changed). The unreadable-file tests use Unix file modes, so they run on macOS and Linux only.

Run: not run. The verify recipe covers only the web page, and starting the desktop app would touch the real Keychain on this Mac.

Handoff:
- `src-tauri/src/lib.rs`: `read_existing`, `save_settings_at` uses it, new `clear_api_keys_at`, `clear_api_keys` command now takes the app handle for the settings path; 4 new tests and a `Flaky` test store.
- `src-tauri/src/secrets.rs`: `strip_keys` shares a `strip` helper with new `strip_named`; `clear_for` takes the key names. The task said lib.rs only; this small change avoids copying the key-stripping code.
- Decision log: `load_settings_at` stays lenient on read errors (it never writes after a failed read); TS caller unchanged.
- Left: none from round 4. Still open from round 3: on-site check of the key move into Windows Credential Manager.
- Trap: the unreadable-file tests set mode 000 and set it back before reading; a test run as root would read the file anyway and fail.

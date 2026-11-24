# PerioKey

A hygienist says pocket depths out loud ("three two three"), and PerioKey types them into the dental software's perio chart. It only types keys, the same as a person at the keyboard. It works with any dental software that takes keyboard input.

Speech goes to one speech-to-text service (Deepgram or OpenAI). Fixed rules then turn the words into numbers; there is no AI guessing. Audio and words stay in memory. Nothing is saved to disk or written to a log.

## Run it today in Practice mode (no dental software needed)

You need Node 22.18 or newer and pnpm.

```sh
pnpm install
cp .env.example .env      # then paste a key in .env (see below), or leave it blank
pnpm start
```

Open http://localhost:4317 in Chrome or Edge.

- **No key yet?** Type a phrase in the box ("three two bleeding", "back") and press **Say it**. The practice chart fills in, and you see the exact keys PerioKey would send. Eaglesoft's 10 to 15 mm key is not set yet, so "twelve" buzzes there; switch the profile to **Generic** to try "twelve".
- **With a key:** press **Start listening** (or F9) and speak. The page says **Connecting…** until the speech service is ready, then a soft ready tone plays and it says **Listening**. Wait for that tone before your first number. A soft tick means a phrase was accepted. A low buzz and **Repeat** mean it was refused and nothing was typed.
- **Hands-free:** click **Start listening** once in this tab so the browser allows the microphone. After that, F9 or the foot pedal starts and pauses listening while Eaglesoft is in front. If the browser still blocks the mic, PerioKey pauses and asks you to click once.

## Add your speech key

Open `.env` and fill in **one** line:

```
DEEPGRAM_API_KEY=your-key-here      # the default: Deepgram Nova-3 streaming
OPENAI_API_KEY=your-key-here        # the other choice: OpenAI gpt-4o-transcribe
```

Restart with `pnpm start`. The page shows "Deepgram key set" or "OpenAI key set". It never shows the key. `.env` is in `.gitignore`, so the key never goes into git.

## What you can say

| Say | What happens |
|---|---|
| 1 to 48 depths, like "three two three" | Each one is typed, in order |
| "ten" to "fifteen" | Typed as one depth, using the software's own key for 10 or more |
| "bleeding" or "bleed" after a depth | Marks that site as bleeding |
| "back" or "undo" | Undoes the last site |
| "skip" | Moves to the next site without typing a number |
| "pause" or "stop" | Stops listening |

Sound-alike words count too: "to/too" = 2, "for/fore" = 4, "ate" = 8, "won" = 1, "tree" = 3.

**All or nothing.** If any part of a phrase is wrong (a number over 15, a 0, 7 or more depths, or a run like "123" that could be 1-2-3 or 12-3), PerioKey types nothing and buzzes. So the chart's cursor never drifts. Ordinary talk with no perio words ("how was your weekend") is ignored with no buzz.

## At the dental office: Patterson Eaglesoft

Eaglesoft is the default profile: `profiles/eaglesoft.json`. Each line is one setting you can change in any text editor:

| Setting | Now | What it means |
|---|---|---|
| `window_match` | `Perio Exam` | PerioKey types only while a window with this in its title is in front. Eaglesoft's perio window is titled `New Perio Exam for - <Patient> (<ID>)` |
| `ten_to_fifteen` | `not_set` | How to type 10 to 15. **Not known yet**, so PerioKey refuses 10 to 15 (buzz, nothing typed) |
| `bleeding` | `b` | Key that marks bleeding. Not checked yet (see step 3) |
| `undo` | `backspace` | Key for "back" |
| `skip` | `right` | Key for "skip" |
| `after_each_depth` | `none` | Extra key after each depth: none, tab, enter, or space |
| `inter_key_delay_ms` | `40` | Wait between keys, in milliseconds. Raise it if keys get lost |
| `bleeding_steps_back_first` | `false` | If true, bleeding presses Left, then the bleeding key, then Right |

Checked on-site in Eaglesoft:

- The perio window title is `New Perio Exam for - <Patient> (<ID>)`, inside `Chart for - <Patient>`. So `window_match` is `Perio Exam`.
- Set the exam's process order to `1-16,16-1,32-17,17-32`. Missing teeth are skipped by Eaglesoft itself.
- Normal number keys and the number pad type straight into the chart. No buttons need clicking.

Still to check by hand, once, in a **practice patient's** perio chart (about 30 seconds):

1. **Single digits.** Type `3`. Does the cursor jump to the next site by itself? If it needs Tab or Enter, set `after_each_depth`.
2. **10 mm or more.** Find how Eaglesoft takes 12 (Ctrl+2? a key and then 2?). Set `ten_to_fifteen` to the match: `ctrl_digit` (Ctrl+2), `minus_then_digit` (- then 2), `slash_then_digit` (/ then 2), `alt_equals_digit` (Alt+= then 2), `shift_one_digit` (Shift+1 then 2), or `two_digits` (1 then 2).
3. **Bleeding.** Eaglesoft's button reads `Bleedin_g_`, with the `g` underlined. An underlined letter is a keyboard shortcut. After typing a depth, try `b`, then `g`, then `Alt+g`. Use the one that marks the site. For `g`, set `bleeding` to `g`. `Alt+g` needs a small code change first (a profile key cannot hold Alt yet), so tell the builder. If it marks the next site instead of the one just typed, set `bleeding_steps_back_first` to `true`.
4. **Undo and skip.** Check that Backspace clears the last site and Right arrow skips one.
The only other profile is `generic` (any notepad or grid, for testing). It types 10 to 15 as two digits.

## Live mode on Windows

1. Install Node 22.18 or newer from https://nodejs.org, then clone or copy this folder to the office PC.
2. Double-click `start-periokey.bat`. The first time, it installs what PerioKey needs. Then it opens http://localhost:4317 and starts PerioKey. Keep its black window open while you work. If Eaglesoft runs as administrator, right-click the file and pick **Run as administrator** instead.
3. In `.env`, set `PERIOKEY_MODE=live` (or click **Live** on the page).
4. Open the perio chart in Eaglesoft and click into the first site.
5. Press F9 (or the foot pedal) to start, and speak.

- **Updating:** automatic. Each time `start-periokey.bat` starts, it pulls the newest version from GitHub (`git pull --ff-only`) and reinstalls packages if `package.json` changed. If the PC is offline, it prints one warning and starts the current version. `update-periokey.bat` still updates without starting.
- **PowerShell errors about `npm.ps1`:** PowerShell's ExecutionPolicy (a Windows setting that blocks scripts) can block `npm`. Use `npm.cmd install --omit=dev` and `node src/server.ts` instead, or just use the `.bat` files, which already do this.
- **Start it from a normal window.** Windows can run a program on a separate, hidden "desktop" (for example, a sandboxed terminal used by an AI tool). Keys and the floating pill never reach Eaglesoft from there. PerioKey checks this when Live mode starts: if its desktop is not `Default`, the page and the terminal show a warning. Start it with `start-periokey.bat` instead.
- **Perio Exam inside the Chart window:** Eaglesoft can show `New Perio Exam for - <Patient>` as a window inside the `Chart for - <Patient>` window. PerioKey checks the front window and the visible windows inside it, so both layouts work. It never prints or logs window titles, since they hold patient names.

- **Foot pedal:** set the pedal's own software to send F9, or set `PERIOKEY_HOTKEY` to the key it sends (F1 to F24). On Windows the key works even while Eaglesoft is in front.
- **Focus guard:** if another window comes to the front, PerioKey stops listening and drops any half-heard phrase. Before every phrase it checks again that Eaglesoft is in front. It also checks before every single key. If focus moves partway through a phrase, it stops typing at once and says how many keys were sent, so you can fix that spot in the chart.
- **Speech drops:** if the speech connection closes on its own (a network drop or a long silence), PerioKey pauses and says "Speech connection closed. Press F9 to reconnect."
- **Admin rights:** Windows blocks a normal program from typing into a program run as administrator. If Eaglesoft runs as administrator, PerioKey must too: right-click `start-periokey.bat` and pick "Run as administrator". If keys never appear, check this first.
- macOS can run live mode too (for testing in TextEdit). It needs Accessibility permission for the terminal, in System Settings, Privacy and Security.

## Before real patients: HIPAA

Speech about a patient's mouth is health information. Before live use with real patients:

- Sign a **Business Associate Agreement (BAA)** with the speech provider you use (Deepgram or OpenAI). A BAA is a contract where the company promises to protect health data the way HIPAA requires.
- For OpenAI, also ask for **Zero Data Retention** on the account, so OpenAI keeps no copy of the audio.
- PerioKey already asks Deepgram not to use the audio for model training (`mip_opt_out=true`), and saves nothing itself. That is not a substitute for a BAA.

## Checks

```sh
pnpm test                    # unit tests: parser, key encoding, speech adapters, settings
pnpm exec tsc --noEmit       # type check
node scripts/merge-pr.mjs --check --fast   # every kit check
```

How the code fits together: `docs/architecture.md`.

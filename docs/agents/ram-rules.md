# RAM Rules

These rules keep many agent threads from filling one computer's memory. They apply to every role. Words: `docs/agents/glossary.md`. The project's own facts (device name, ports, test commands) are in `AGENTS.md`. The stories behind the rules are in the starter kit's `history/lessons.md`.

## The slots

Two things may be used by only one thread at a time on the whole machine. A script hands them out, so the answer is instant and two threads can never both win.

| Slot | What it covers | Default lease |
|---|---|---|
| `device` | The one iPhone Simulator or Android emulator allowed to run | 20 minutes |
| `tests` | The one full test run allowed at a time | 30 minutes |

```sh
node scripts/slot.mjs status                                          # who holds what, who waits
node scripts/slot.mjs acquire device --who "<thread name>" --minutes 20
node scripts/slot.mjs renew device --who "<thread name>" --minutes 10
node scripts/slot.mjs release device --who "<thread name>"
node scripts/slot.mjs run tests --who "<thread name>" -- <full test command>
```

The two slots take turns on this machine: a device and a full test run at the same time overload 16 GB, so `tests` waits while someone holds `device`, and the other way round. On a bigger machine, `SLOT_SHARED_OK=1` turns that off. The `merge` slot takes no turns: it only keeps out another merge.

Exit code 0 means the slot is yours. Exit code 75 means busy: you are in line; do other work and ask again within 10 minutes to keep your place. A lease that runs out frees the slot, so renew if you need longer. The merge script takes the `tests` slot for you; you rarely call `run tests` yourself. When the merge script exits 75, follow `docs/agents/procedures/merge.md` ("Exit codes").

## The rules

1. **RAM-1. Take the device slot before you boot a device.** Ask only when you are nearly ready. While you wait, do work that needs no device.
2. **RAM-2. Boot late, shut down early.** The moment your check is done:
   - Shut the device down: `xcrun simctl shutdown <id>` for a Simulator, `adb -s <serial> emu kill` for an emulator. In T3 Code, also close your device session, so the device is not left marked in use.
   - Confirm none is booted: `xcrun simctl list devices booted`.
   - Stop your dev server and fixture servers, and confirm each port is free: `lsof -nP -iTCP:<port> -sTCP:LISTEN` prints nothing.
   - Put the device back as you found it: settings you changed (light or dark mode, text size) and app data you changed (back it up before you change it).
   - Release the slot.
3. **RAM-3. One full test run at a time,** and only through the `tests` slot. Never start a full run by hand without it. A single test file is fine and needs no slot. Limit workers in the test runner's settings (below).
4. **RAM-4. Leave nothing running when you finish.** Stop your dev servers, fixture servers, test watchers, and any browser your tests opened. Run full test runs and builds in the foreground.
5. **RAM-5. Each worktree gets its own ports.** Default ports collide. Use a port from the project's range in `AGENTS.md`, and stop the server when you finish.
6. **RAM-6. Look, don't kill.** Never stop another thread's test run, dev server, or device. Never close T3 Code, Claude, or Codex. The one exception: a device that is on while nobody holds the device slot is a leftover; the slot script tells you so, and you shut it down before you take the slot. If anything else looks stuck or wasteful, report it.
7. **RAM-7. Clean up when your branch merges.** `scripts/merge-pr.mjs` runs `scripts/clean-worktrees.mjs` after each merge; never use `rm`. It removes finished worktrees quiet for 15 minutes (0 for `--merged-branch`), keeping unmerged ones. It runs from the main checkout, so a merge run inside the merged worktree removes that worktree too, unless another program (an open terminal, an editor) still uses it. Lock a folder to keep it: `git worktree lock --reason "why" <path>`. Leftover worktrees waste disk and watchman memory.
8. **RAM-8. A timing test can fail under load.** Before you call it a real failure, rerun that file alone. Report both results. Never hide the first failure.
9. **RAM-9. Report memory flags; do not act on them.** Each grant prints the machine's memory flags. Outside the loop, tell Stephen once. In the loop, file an ask if a flag is new (`docs/agents/procedures/inbox.md`). `node scripts/ram-health.mjs` prints the full report.

## The numbers

Tuned for a 16 GB Mac. Change one only after you measure: run `node scripts/ram-health.mjs` during a normal busy hour, a few times. Each flag is an environment variable listed at the top of `scripts/ram-health.mjs`.

| Setting | Value | Where it came from |
|---|---|---|
| Devices at once | 1 | Four Simulators once filled swap |
| Full test runs at once | 1 | Two runs once used about 15 GB |
| Device and full test run at the same time | Not allowed | A full run with a Simulator booted took 763 s instead of 285 s, and 9 tests timed out |
| Workers per test run | 2 | Measured on UniLex |
| Worker restart limit | 1 GB | A full run fell from about 8 GB to 3.5 GB |
| Flag: free memory under | 40% | Stephen's machine rules |
| Flag: swap used over | 5 GB | Stephen's machine rules |
| Flag: one test worker over | 2 GB | Stephen's machine rules |
| Flag: watchman over | 1 GB | Watchman once reached 3.4 GB |
| Worktree quiet time before cleanup | 15 minutes | Cleanup script (0 with --merged-branch) |

What things cost, measured: one iPhone Simulator about 1.4 GB; one full Jest run with 2 workers about 7.8 GB without the restart limit and about 3.5 GB with it; watchman watching 108 worktrees 3.4 GB; one Claude session 150 to 340 MB.

## Test runner settings

**Jest** (version 29 or newer), in its config file:

```js
module.exports = {
  // At most 2 workers on a developer's machine. On a 2-CPU CI machine, Jest's own choice was faster.
  ...(process.env.CI ? {} : { maxWorkers: 2 }),
  // Jest restarts a worker that passes this limit before its next file.
  workerIdleMemoryLimit: '1GB',
  // Without this, Jest makes watchman watch the whole worktree forever.
  watchman: false,
};
```

The restart limit is checked between test files, so one worker can still pass 1 GB during a single big file. That is why the flag is 2 GB.

**Other runners,** not measured yet; check your version's docs. Vitest: `maxWorkers: 2`, and set `RAM_TEST_WORKER_PATTERN` to match its workers. Playwright: `workers: 2`; a full browser test run counts as a full test run. pytest with pytest-xdist: `-n 2`. Gradle: `org.gradle.workers.max=2`, and run `./gradlew --stop` when you finish. xcodebuild: `-parallel-testing-worker-count 2`.

## By kind of project

- **Web app:** each worktree gets its own dev server port. A full browser test run counts as a full test run. Close every browser your tests open.
- **React Native or Expo:** everything applies. Start Metro on your worktree's port (`npx expo start --port <port>`). With a development build, open the app at your Metro port by its full link (`<scheme>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<port>`): a shortcut flag once reopened an old bundle from another worktree's Metro.
- **Native iOS:** one Simulator at a time; cap xcodebuild test workers at 2.
- **Android:** the emulator is the heaviest device. Never run it beside a Simulator. Stop Gradle daemons when you finish. A project may ban the emulator for agents in its `docs/project-rules.md`.

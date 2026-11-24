# A Flaky Test

A flaky test passes sometimes and fails sometimes with no code change. It teaches everyone to ignore a failure, so it is fixed or removed, never worked around.

## Never

- Skip it.
- Add a fixed wait (a sleep). Advancing a fake clock is fine: that is not a wait.
- Raise or add a time limit.
- Retry it until it passes, by hand or with a retry setting.

`node scripts/test-changes.mjs` sorts an added or longer wait, an added or raised time limit, and added or raised retries as weakenings, in old test files, in brand-new ones, and in test settings files: each needs a reason line and a reviewer's ruling. A shorter wait, a lower limit, or fewer retries is free.

## Do

1. **Rerun that one file alone** a few times, and note every result (RAM-8, `docs/agents/ram-rules.md`). A failure that shows only when the machine is busy still counts.
2. **Find the cause.** The usual ones:
   - **Shared state:** one test leaves data, a file, or a setting that another test reads.
   - **The real clock:** the test reads today's date or waits on real time. Pin the date, or use a fake clock.
   - **Order:** it passes alone and fails after another test, or the other way round.
   - **A slow machine:** it waits a fixed time for something. Wait for the event itself instead.
   - **The network:** it calls a real outside service. Use a fake server.
3. **Fix the cause, and prove it:** run the file many times in a row, for example 20, with no failure.
4. **If the cause cannot be found** in a set effort (about an hour of looking), delete the test, with a reason line the reviewer rules on like any weakening. Propose a row for `docs/mistakes.md` in your plan log note (the head agent adds it). Then write a better test for the same behavior if you can.

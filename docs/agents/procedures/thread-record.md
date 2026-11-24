# Thread Record: Keeping Your Thread Open

**Why this exists.** T3 Code settles a thread as soon as every pull request linked to it is merged, and it links the pull requests a thread creates. Without care, your first merge files your thread away while it still has work. The fix: keep one small draft pull request open until your last step.

That draft changes only your thread record, `docs/threads/NNN.md`. Nothing else touches that file, so it never conflicts. All real paperwork still merges through normal lead pull requests, because the next thread reads it from the base branch.

Outside T3 Code nothing settles threads, so the draft is optional. Keep the record anyway: it is how a later thread traces what happened.

## Steps

1. **At the start,** on branch `lead/NNN-thread`, create `docs/threads/NNN.md` from `docs/threads/_template.md` (slice, this thread's link, date). Open it as a draft pull request and link it to your thread. Never merge it mid-slice.
2. **During the slice,** link every pull request you create or push to. Linking twice does no harm.
3. **At the end,** after your closing pull request has merged, start the next thread if there is one.
4. **Confirm the next thread is running:** read it until it is running and has written at least one message. If it failed, try once more. If it still fails, write why in the record, leave the draft open so your thread stays visible to Stephen, and stop.
5. **Finish the record:** add the next thread's link and "confirmed running", or "none" and why. Then run `node scripts/merge-pr.mjs <number> --ready`. This is your thread's last action.

## Who else needs one

- **Any thread that opens a pull request,** not only slice threads. A side-job or design thread opens `docs/threads/<name>.md` before its first pull request.
- **Threads you start that cannot open their own** (they never touch the repo): open the placeholder yourself, link it to that thread, and merge it only after you have checked its work.
- **Before you end,** list the threads you started and settle any that are done but still open.

A worker that the head agent started with its tool's worker feature needs no record: it ends with its task.

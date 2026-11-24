# Before You Stop

A builder's last steps on a task, in this order. They make the proof note true and the review cheaper. The checklist they end in is the definition of done in `docs/agents/builder.md`.

1. **Run the change.** Open `docs/verify.md` and run the section for what you changed: start it, try the change as a user would, look for the result, and stop it. A device needs the device slot first (`docs/agents/ram-rules.md`). Write in your plan log note what the run showed. If no section fits, say so in the note and propose one; the head agent adds it.
2. **Reread a big change.** If you added more than about 300 lines, read your own diff once (`git diff origin/main...HEAD`), asking: can this be smaller or plainer and do the same job? If so, make it so.
3. **Run the checks:** `node scripts/merge-pr.mjs --check --fast`, plus the test files for what you built.
4. **Answer every review finding,** when your task follows a review. One line each, in `docs/findings/<branch>.md`, where `<branch>` is your branch name with `/` as `-` (the same naming as `docs/weakenings/`):

   ```
   - R<round>.<n> <label>: <outcome>: <note>
   - R1.2 Important: fixed: the save now waits for the server's reply
   ```

   The round and number come from the review note in the plan log. Outcomes: `fixed`, `wrong` (the reviewer was mistaken), `intended` (it is on purpose), `not worth it`, `later` (logged for later; the usual answer to Pre-existing). The note is 10 to 300 characters. A `fixed` Important finding has a test that fails without the fix (CORE-9). `node scripts/findings.mjs` lists the answers still owed.
5. **Stamp the last commit.** Its message ends with a `Verified:` line that says what you really did:
   - `Verified: ran, tests`: you ran the recipe and the test files. Add `checks` when you also ran format, lint, and types.
   - `Verified: tests` or `Verified: checks` when you did only that.
   - `Verified: none (<reason>)` when nothing could be run, with the reason in round brackets.

   The hook adds `Verified: none` when the line is missing, and refuses a line it cannot read. If it added `none` and you meant `ran`, fix the message with `git commit --amend`. A `fix` commit may also carry `Bug: <one sentence>` (15 to 200 characters): the bug in plain words, which the reviewer's report card uses as its answer key.

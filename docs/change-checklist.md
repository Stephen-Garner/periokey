# Change Checklist

Format: kit change checklist, version 1

Things to check whenever a change touches certain paths, each learned from a real mistake. `node scripts/checklist.mjs` prints the rows that match a branch, and the reviewer answers each one. Only the head agent edits this file; a builder proposes a row in its plan log note. When a row is added: `docs/agents/procedures/lessons-to-rules.md`.

- **Id:** CL-1, CL-2, and so on. Never reuse one.
- **When the change touches:** one or more path patterns in code spans, separated by commas. `*` matches within one folder, `**` across folders, and a trailing `/` means the whole folder. It may end with `and adds "<text>"`: then the row applies only when the change adds a line holding that text under those paths.
- **Check this:** one plain question or instruction.
- **Why:** the mistake, pull request, or outage behind it.

| Id | When the change touches | Check this | Why |
|---|---|---|---|
| CL-1 | `profiles/` | Was each changed key checked in the real dental software? If not, is it marked unverified in the README? | A guessed key moves the chart cursor to the wrong site |

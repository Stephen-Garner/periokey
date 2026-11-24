# Mistakes List

Each kind of mistake agents have made in this project, and how far it has climbed toward a check. Only the head agent edits this file. How a mistake climbs: `docs/agents/procedures/lessons-to-rules.md`.

- **Id:** MIS-1, MIS-2, and so on. Never reuse or renumber one.
- **State:** `note` (written down once), `rule` (a written rule in `docs/project-rules.md` or `AGENTS.md`), or `check` (a test or script catches it, and the written rule is deleted).
- **Should have been caught by:** the layer that should have stopped it: `commit hook`, `checks`, `review`, `verify run`, `merge gate`, or `nothing yet`.
- **Repeats** are not kept here. Each time a listed mistake happens again, record it in the event log: `node scripts/events.mjs add mistake-repeat mistake=MIS-1 layer=review summary="what happened"`. At 3 repeats it should become a check.

| Id | Mistake | State | Lives in | Should have been caught by |
|---|---|---|---|---|
| MIS-1 | Example, delete this row: a test read the real clock, so it failed at midnight | rule | docs/project-rules.md, "Known traps" | review |

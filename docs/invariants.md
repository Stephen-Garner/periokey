# Invariants

Rules that must always be true in this product, such as "a user only sees their own data". Only the head agent edits this file. Stephen adds rows as the product grows. How the file is used: `docs/agents/loop.md`.

Format: kit invariants table, version 1

- **Id:** INV-1, INV-2, and so on. Never reuse or renumber one. A slice plan lists the ids it touches.
- **Check:** the path of the test or script that fails when the rule breaks, or "none yet".
- **State:** `protected` (the check exists and the checker finds its file) or `not yet` (an open gap; the dashboard lists it).

| Id | Rule | Area | Check | State |
|---|---|---|---|---|
| INV-1 | Example, delete this row: a user only sees their own data | src/api/ | none yet | not yet |

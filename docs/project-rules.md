# Project Rules

Rules, traps, and procedures only this project has. Anything this project does differently from `docs/agents/` goes here. Only the head agent edits it. Every role reads it.

## Known traps

- None yet.

## Differences from the standard guides

- 2026-11-24: **The head agent never fixes review findings itself.** Every fix, however small, goes to a fresh builder. Why: the head agent's model must never review or write code its own reviewer checks (CORE-5).
- 2026-11-24: **No real dental software for agents.** Agents test in practice mode and with unit tests only. Real Eaglesoft typing is checked by a person on-site (README, "At the dental office").

## Project procedures

- **Changing a profile key.** Change the JSON in `profiles/`, add or update the matching test in `src/keymap.test.ts`, and note in the plan log who checked the key in the real software and when.

# Awaiting Decisions

Stephen's inbox, kept by the agents: what agents chose for him to review, and his answers waiting to be applied. What only he can do or decide is an ask instead (`docs/agents/procedures/inbox.md`). Only the head agent edits this file. Newest items go at the top of each section. If Stephen says he wants to look into an item more deeply first, the head agent moves it to his own list, `docs/planning-required.md`.

Status: loop stopped (2026-11-24, never started). Look first at the Eaglesoft 10 to 15 choice below.

## To review

Choices agents made without Stephen since his last review, each with where it lives and how to undo it. When he has read one, the head agent moves it to `docs/reviewed-choices.md` (or, if he wants a change, into Decided, to apply).

- 2026-11-24, slice 000, **Eaglesoft refuses 10 to 15 for now** (builder). No public source gives Eaglesoft's key for 10 mm or more, so the profile says `not_set` and PerioKey buzzes instead of guessing. Lives in `profiles/eaglesoft.json`. Undo: set `ten_to_fifteen` to the key found on-site.
- 2026-11-24, slice 000, **Deepgram is the default speech service** (builder). Fast streaming with keyterms, and a training opt-out. Lives in `src/config.ts`. Undo: set `STT_PROVIDER=openai` in `.env`.
- 2026-11-24, slice 000, **A local web page, not a desktop app** (builder). One Node program and a browser page; no installer. Lives in `src/server.ts` and `public/`. Undo: a later slice could wrap it.

## Decided, to apply

Stephen's answers, waiting for an agent to put them into a plan, the roadmap, or a decision file. Deleted once applied.

- None.

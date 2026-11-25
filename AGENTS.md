# PerioKey: Agent Map

PerioKey lets a dental hygienist speak perio chart numbers, and types them into the office's dental software (Patterson Eaglesoft on Windows) as keystrokes. What and why: `docs/spec.md`.

<!-- kit:start (managed by starter kit; never edit inside these markers) -->
## Your role

If no one gave you a role, you are the head agent. Head agents and research workers: read `docs/agents/core.md` first, then your guide. Builders and reviewers: read only your guide; it lists the rest.

| Role | Guide |
|---|---|
| Head agent (the thread Stephen talks to) | `docs/agents/head-agent.md` |
| Builder | `docs/agents/builder.md` |
| Reviewer | `docs/agents/reviewer.md` |
| Research worker | `docs/agents/researcher.md` |

`docs/agents/`, `kit-lint/`, and `files` in `scripts/kit.manifest.json` come from the kit and are never edited here. Where shared vs. custom rules, scripts, and lint rules go: `docs/agents/procedures/lessons-to-rules.md`. Project traps: `docs/project-rules.md`.

## Kit rules and checks

- **Merge last** (CORE-16): a merge closes your thread, so first ask Stephen every last question and start any next thread.
- Before a review: `node scripts/merge-pr.mjs --check --fast`. To merge: `node scripts/merge-pr.mjs <number>`.
- Status and slots: `node scripts/check-plans.mjs --status` and `node scripts/slot.mjs status`. Hooks once per clone: `git config core.hooksPath .githooks`.
<!-- kit:end -->

## Project facts

| Fact | Value |
|---|---|
| Models and check commands | `scripts/kit.config.json` (`models`, `checks`) |
| Launch provider and model (T3 Code) | Head agent: provider `antigravity`, model `gemini-4-neon`. Builder: `claudeAgent`, `claude-opus-5-5`. Reviewer: `codex`, `gpt-6.2-astra` |
| Base branch | `main` (shared copy: `origin/main`) |
| Thread names | `PerioKey NNN head agent` (NNN is the slice) |
| Designs need Stephen's approval | no (one plain control page) |
| Device | none (a Node program and a browser page) |
| Dev server | `pnpm start` (plain Node), port 4317; worktrees set `PORT` from 4318 to 4339; fixtures 8790 to 8899 |
| Run one test file | `node --test src/parser.test.ts` |
| Project root (Stephen's; agents never work there) | `~/dev/periokey` |

## Where things live

| Path | What it holds | When to read it |
|---|---|---|
| `docs/handoff.md` | Current state and next step | Head agent, at start |
| `docs/awaiting-decisions.md` | Stephen's inbox | Head agent, at start and end |
| `docs/roadmap.md`, `docs/plans/` | Slices in order; one plan per slice | Choosing or doing work |
| `docs/spec.md`, `docs/architecture.md` | What we build; how the code fits | Before planning or coding |
| `docs/decisions/`, `docs/research/` | Big decisions; research notes | When a task touches one |
| `docs/glossary.md` | Product words (agent words: `docs/agents/glossary.md`) | When a word is unclear |
| `docs/planning-required.md`, `docs/reviewed-choices.md` | Stephen's topics; reviewed choices | Only when pointed there |
| `docs/threads/`, `docs/lessons.md` | Thread records; lessons and rules | Tracing a handoff or rule |
| `REVIEW.md` | What to check hardest here | Reviewer, first |
| `docs/invariants.md`, `docs/mistakes.md`, `docs/check-trials.md` | Invariants, repeated mistakes, trial checks | Planning or adding checks |

## Project rules

1. The hard rules in `docs/spec.md` section 5 are strict: all or nothing per phrase, fixed-rule parser (optional AI filter only for spoken corrections, strictly chart actions), nothing saved, type only into the dental software, no real patients before a BAA.
2. Never log, print, or save audio, transcripts, or API keys in plain text. Keys live only in `.env` (local server) or the OS credential store (Windows Credential Manager in the desktop app, never written to `settings.json` and never sent to the Settings window).
3. A profile key that has not been checked in the real dental software stays marked unverified; never guess it as fact.
4. The head agent never fixes review findings itself; a fresh builder does (`docs/project-rules.md`).

## Automated loop

Off unless Stephen turns it on (`docs/agents/loop.md`). Loop prompt:

> You are the PerioKey head agent in an automated loop. Follow AGENTS.md, docs/agents/core.md, docs/agents/head-agent.md, and docs/agents/loop.md. Run `node scripts/check-plans.mjs --status`, read docs/handoff.md and docs/awaiting-decisions.md from origin/main, then do the next step without asking Stephen anything.

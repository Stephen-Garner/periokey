---
id: 0
status: in_progress
depends_on: []
builder: "claude/claude-opus-5-5"
reviewer: "codex/gpt-6.2-astra"
tests: [src/parser.test.ts, src/keymap.test.ts, src/injector.test.ts, src/stt.test.ts, src/config.test.ts]
code: [src/parser.ts, src/keymap.ts, src/injector.ts, src/win-helper.ps1, src/stt.ts, src/config.ts, src/server.ts, public/, profiles/]
log: docs/plans/logs/000-foundation.md
invariants: none
risk: high
undo: revert the merge commit, then turn the hooks off with git config --unset core.hooksPath
owns: [AGENTS.md, docs/, scripts/, .githooks/]
proof: the output of node scripts/merge-pr.mjs --check, and a blocked commit and push
---

# 000: Foundation

## Goal

Any new AI thread can open the repo, learn the project and its rules from the files alone, and pick up the next slice, with checks that block rule-breaking changes.

## Done when

- [ ] `AGENTS.md` is filled in (project facts, project rules) with no `<...>` left.
- [ ] `scripts/kit.config.json` names the models and the check commands, and marks the full test command with `"slot": true`.
- [ ] `docs/spec.md` holds what we build and why, with open questions in its last section.
- [ ] `docs/roadmap.md`, `docs/handoff.md`, `docs/architecture.md`, `docs/glossary.md`, and `docs/project-rules.md` are filled in.
- [ ] The test runner's worker limits are set as `docs/agents/ram-rules.md` says, or the project has no test runner.
- [ ] `node scripts/check-plans.mjs` passes, and `node --test scripts/*.test.mjs` passes.
- [ ] `node scripts/merge-pr.mjs --check` passes on this branch.
- [ ] The git hooks are on (`git config core.hooksPath .githooks`): a commit with an em dash in a Markdown file is blocked, and a push straight to `main` is refused.
- [ ] A fresh reviewer on a different model approved the foundation.

## Tasks

1. Fill in the project's own files: `AGENTS.md`, the settings, and the docs.
2. Set the test runner's limits and pick port ranges.
3. Run every check, and prove the hooks block a bad commit and a push to `main`.
4. Blind review by a different model.

## Decision log

- 2026-11-24 (builder, Astra R2.1): the Eaglesoft profile ships with no `program_match`, because its program file name has not been checked on-site (project rule 3). The desktop app refuses Live mode until the office enters it in Settings. The local web page path (`win-helper.ps1`) is unchanged and still checks the title only.
- 2026-11-24 (builder, Astra R2.2): Stop uses a rising phrase number in Rust (`fetch_max`), not an on/off flag, so a Stop that reaches Rust before its phrase starts still stops it, and the next phrase is never blocked.
- 2026-11-24 (builder, Astra R2.3): the mic start and stop logic moved from `pill.ts` into `src/desktop/mic-sync.ts` so a test can drive it without a browser.
- 2026-11-24 (builder, Astra R2.4): keys go to the OS credential store through Win32 `CredReadW`/`CredWriteW`/`CredDeleteW` (windows-sys, already a dependency) and the `security-framework` crate on macOS (already in Cargo.lock), not the `keyring` crate, to add no new dependency tree. Each key is a generic credential named `PerioKey/<KEY_NAME>`. Raw keys go to the `pill` window only; setting and clearing keys is `settings` only. `load_settings` rewrites an old file that still holds keys, so plain-text keys do not stay on disk.
- 2026-11-24 (builder, Astra R2.4): the Settings speech service list now shows the saved `STT_PROVIDER` choice, since Settings no longer knows the keys and so cannot work out the fallback provider.
- 2026-11-25 (builder, Astra R3.1): a lone sound-alike word ("to" as 2, "for" as 4) still goes to the AI filter, because alone it is more likely chatter than a depth; every other clean phrase the fixed rules accept, including a lone strong depth ("three", "10") or filler plus a depth ("okay ten"), never calls the AI.
- 2026-11-25 (builder, Astra R3.2): an old key moves to the credential store trimmed but otherwise as saved (not through the paste cleaner), so a key the old build used is never refused and stuck. `save_settings` also moves old keys before it replaces a file that still holds them, and refuses the save if a move fails, so a Settings save cannot wipe an unmoved key.
- 2026-11-25 (builder, Astra R3.3): after an open or setup failure, mic-sync waits until `wanted()` is false again (the next Stop/Start) before it opens the mic again, even if the engine has not paused yet.
- 2026-11-25 (builder, Astra R3.4): a stale Stop reply is told apart by the phrase's session number; only "stopped after 0" from an older session is dropped. Any reply that sent keys still pauses, with the count, so the hygienist checks the chart.

## Review

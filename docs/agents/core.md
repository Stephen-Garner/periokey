# Core Rules

The head agent and research workers read this file first. Builders and reviewers read only their own guide, which cites the core rules they need. Words are defined once, in `docs/agents/glossary.md`. Rules only this project has are in `docs/project-rules.md`. Project settings (models, check commands) are data in `scripts/kit.config.json`.

## Roles

A role is the job one agent does in one thread. If nobody gave you a role, you are the head agent.

| Role | Started by | May change | Never | Guide |
|---|---|---|---|---|
| Head agent | Stephen, or the previous head agent in the loop | Lead-only files, plan headers and Review sections, small review fixes | Big feature code; work in the project root | `docs/agents/head-agent.md` |
| Builder | Head agent | Its own code and tests, plus three sections of its plan | Lead-only files, merging, asking Stephen | `docs/agents/builder.md` |
| Reviewer | Head agent | Nothing | Seeing the builder's chat; checking its own model's code | `docs/agents/reviewer.md` |
| Research worker | Head agent, on a question a plan or Stephen raised | One research note | Code, lead-only files, deciding for Stephen | `docs/agents/researcher.md` |

Kinds of head agent, all under the head agent guide:

- **Loop thread:** a head agent whose starting prompt says it is in the automated loop. Rules: `docs/agents/loop.md`.
- **Design thread:** works live with Stephen on how something should look or work, mockups first. It builds nothing until he says the design is final. Then it writes the design notes, adds the build slice to the roadmap, and ends.
- **Side-job thread:** one job that is not a slice, such as cleaning up the inbox. Same rules, including its own thread record.
- **Backup head agent:** a second model in `scripts/kit.config.json` that may lead when the first is not available.

A **sweep reviewer** is a reviewer that checks one area of the whole project instead of one branch (`docs/agents/reviews.md`).

## What only Stephen does

If it can be undone, do it and record how to undo it. Agents stop and ask Stephen only for these:

- Spending money, or anything that needs a login, a password, or a new account.
- Deploying to live users, or changing a live database.
- Deleting anything that has no copy elsewhere: branches not on GitHub, user data, backups.
- Sending or publishing anything outside this Mac and the project's GitHub repo.
- Reading or moving secrets.
- Changing this list.

Agents keep the Cloudflare and GitHub logins, and no script hides them: this list is the only guard, so ask first. An agent that hits it files an ask and carries on with all work that does not need the answer (`docs/agents/procedures/inbox.md`).

Stephen also picks the models, approves designs when `AGENTS.md` says so, adds topics to `docs/planning-required.md` (no agent adds one), allows extra review rounds (`extraReviewRoundSlices`), and starts and stops the automated loop.

## Rules for every role

1. **CORE-1. One role per thread.** A thread that changes jobs starts a fresh thread for the new job.
2. **CORE-2. Your own worktree.** Every agent works in its own worktree, head agents included. The project root is Stephen's: never edit, commit, or switch branches there.
3. **CORE-3. Lead-only files.** Only the head agent changes plan headers, the Review section of plans, and the lead-only paths (the list is `leadOnlyPaths` in `scripts/check-plans.mjs`, plus `extraLeadOnly` in the settings). The checker blocks everyone else.
4. **CORE-4. Branch names carry the rules.** Head agents work on `lead/short-name`. Builders work on `build/NNN-short-name` and change only their own code and tests, plus the Decision log in their own plan and their own slice's plan log (in an older plan with no `log` field, also its Progress log and Notes for the lead). Research workers work on `research/YYYY-MM-DD-topic` and change only their note. Any other branch name gets the strictest rules.
5. **CORE-5. Done means reviewed.** A slice is `done` only after the checks pass and a fresh, blind reviewer approves. The reviewer is a different model from every model that wrote code on the branch: the builder, and the head agent, because it fixes small findings.
6. **CORE-6. Workers work alone.** A worker never starts another thread or worker, and never asks Stephen anything. It picks the simplest choice that meets the plan, logs it, and keeps going. A question that changes what gets built goes in the plan log, and the worker stops.
7. **CORE-7. Point, don't paste.** Each fact lives in one place. Briefs and docs name the file to read; they do not copy its text.
8. **CORE-8. Fail loud.** Never say "done" or "tests pass" if anything was skipped. Say what was skipped and why.
9. **CORE-9. Tests check intent.** A test must fail if the behavior it guards breaks. Prove every review fix: commit it, remove it, watch a test fail, put it back. Pin the date and any other outside input a test depends on.
10. **CORE-10. Changes reach the base branch only through a pull request, merged by the script.** Run `node scripts/merge-pr.mjs <number>`; it runs the right checks and merges (`docs/agents/procedures/merge.md`). Never push to the base branch. Never skip the hooks with `--no-verify`. Commit or push only when Stephen asks or your guide says to.
11. **CORE-11. Foreground only.** Run checks, builds, and deploys in the foreground. Never end your turn while a background job runs: nothing wakes you, so the work is lost. Before ending a turn, ask "what will wake me up?"
12. **CORE-12. Slots.** Only one device (iPhone Simulator or Android emulator) and one full test run may go at a time on the whole machine. Take the slot with `scripts/slot.mjs` first (`docs/agents/ram-rules.md`). A single test file needs no slot.
13. **CORE-13. Leave nothing running.** Stop your dev servers, test watchers, and devices when you finish. Never stop another thread's.
14. **CORE-14. Managed files stay as the kit wrote them.** Everything in `docs/agents/`, `kit-lint/`, and the kit's scripts is listed under `files` in `scripts/kit.manifest.json`. Never edit them here; the checker fails if you do. Project differences go in `docs/project-rules.md`. Shared vs. custom rules: `docs/agents/procedures/lessons-to-rules.md`.
15. **CORE-15. One slice per thread.** When the slice is done, the head agent hands off to a fresh thread: on its own inside the loop, only with Stephen's go-ahead outside it.
16. **CORE-16. Keep your thread open until your last step.** A merge settles (closes) the T3 Code thread. Every thread that opens a pull request first opens its thread record as a draft, then asks Stephen every last question, starts any next thread (passing this rule on), and merges last (`docs/agents/procedures/thread-record.md`).
17. **CORE-17. No em dashes** in any Markdown file. The checker fails on them.
18. **CORE-18. Plain English for Stephen.** Follow the rules for talking to Stephen in `~/.codex/AGENTS.md`. Short replies; long material goes in files.

## What the checker enforces

`scripts/check-plans.mjs` runs before every commit (a git hook) and inside the merge script. It blocks: a lead-only file changed from a branch that is not `lead/`; a build branch whose plan has not started; a `done` slice with no review line or with unchecked boxes; a reviewer on a model that wrote code; a broken roadmap link; an em dash; an edited managed file; and unknown settings. For a branch that is not `lead/`, the merge script uses the checker and the settings as they exist on the base branch, so a branch cannot weaken its own check.

It catches honest mistakes. It is not a lock against an agent set on getting around it, which is why the head agent still reads the list of changed files before a merge (`docs/agents/reviews.md`).

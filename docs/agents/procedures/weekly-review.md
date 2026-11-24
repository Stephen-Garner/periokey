# Weekly Review

Once a week Stephen starts this by hand. Nothing schedules it. Its aim: turn the week's mistakes into checks, and drop checks and words that no longer earn their place. Edits to project files go through a head agent thread on a `lead/` branch, as usual.

## Steps

1. **Open the dashboard:** double-click `~/.agent-dashboard/<project>/open-dashboard.command`, or run `node ~/dev/starter-kit/dashboard/serve.mjs --project <path>`. Answer the open asks first.
2. **Start the factory analyst.** On the Jobs page, start the "Factory analyst" job (`~/dev/starter-kit/dashboard/jobs/factory-analyst.md`). It reads the numbers and the event log, checks a few against git, and proposes at most three experiments in a report. It changes nothing else. Starting an experiment is Stephen's call, on the Experiments page.
3. **Gates on watch.** A switch set to `"observe"` in `scripts/kit.config.json` runs fully but stops nothing; the Quality page's "Gates on watch" panel lists what it would have stopped. Read each reason. After two weeks with no false alarm, the head agent sets the switch to `"enforce"`. A false alarm means fix the gate or the settings first.
4. **Score the reviewer.** The head agent runs `node scripts/cases.mjs --write`: it rebuilds docs/review-cases.md, the past bugs that got through, from the `Fixes:` lines. Then start the "Reviewer score" job on the Jobs page. Under 10 cases the score is a hint, not a verdict.
5. **Repeated mistakes.** The dashboard alerts on each row of `docs/mistakes.md` with 3 or more repeats ("make this a check"). Ask the head agent to make it one (`docs/agents/procedures/lessons-to-rules.md`, step 3).
6. **Close out trials.** In `docs/check-trials.md`, each row two weeks old or more gets its catches, its false alarms, and a verdict: keep, fix, or remove. Removing a check is a weakening: it needs a written reason and a reviewer's ruling, like a weakened test.
7. **Prune.** For each row in `docs/mistakes.md` in state `check`, the head agent deletes the matching written rule from `docs/project-rules.md`, `AGENTS.md`, and `REVIEW.md`. It also drops rows of `docs/change-checklist.md` that have not matched in months (the Quality page counts matches), and steps in `docs/verify.md` that no longer fit. Fewer words to read means the rest get followed.
8. **Save the week's numbers.** The head agent runs `node ~/dev/starter-kit/dashboard/snapshot.mjs <project folder>`. It writes the last finished week's numbers to `docs/metrics/` (and the last finished month's, if missing). It never commits: land the files through a normal lead pull request.
9. **Note the result** in the head agent's thread: what was changed, and what was left for next week.

## What Stephen decides

- Which proposed experiments to start, if any.
- Whether a check stays, gets fixed, or goes, when the counts do not settle it.
- Nothing else waits for him. A head agent makes the edits and merges them through the merge script.

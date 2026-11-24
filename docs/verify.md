# Verify Recipe

Format: kit verify recipe, version 1

How to run each part of this project and see a change work, the way a user would. Before the last commit of a task, a builder runs the section for what changed and stamps the commit `Verified: ran` (`docs/agents/procedures/before-you-stop.md`). Only the head agent edits this file; a builder proposes a change in its plan log note.

Keep it fast and reliable. Fix the recipe the moment it lies: a recipe that passes while the app is broken is worse than none.

One `##` section per part that can be run. Each has five lines, none empty: `Start:` (how to start it), `Try:` (what to do), `Look:` (what you should see), `Stop:` (how to stop it), `Takes:` (about how long).

## The PerioKey page in practice mode

Start: run `PORT=4318 pnpm start`, then open http://localhost:4318
Try: pick the generic profile, type "three two bleeding", then "twelve", then "back", pressing Say it after each
Look: "Keys sent" shows 3 2 B for the first phrase, then 1 2, then ⌫ for "back"; the terminal shows no error
Stop: press Ctrl-C in the terminal that runs `pnpm start`
Takes: about 1 minute

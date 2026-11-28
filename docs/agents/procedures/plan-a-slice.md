# Plan and Open a Slice

The opening of a slice is one pull request on your `lead/` branch. It holds the plan, the roadmap row, and the claim. Merge it before any builder starts.

**First, open your thread record** as a draft pull request on its own branch (`docs/agents/procedures/thread-record.md`, step 1). It must exist before your first merge, or that merge files your thread away.

## Write the plan

1. Run `node scripts/slice.mjs new <short-name> --title "..."`. It copies `docs/plans/_template.md` to `docs/plans/active/NNN-short-name.md` with the next free number, and sets `id` and `log` in the header (`docs/plans/logs/NNN-short-name.md`, the same file name; the checker requires it on a new plan). `node scripts/slice.mjs list` shows every slice with its status and tasks done. Fill in Goal and Done when. Every Done when item must be testable: a test, a command, or a screenshot can prove it.
2. Split the slice into tasks, each small enough for one fresh worker, and list them under Tasks, numbered 1, 2, 3 (the checker enforces `maxTasksPerSlice`, default 3; split larger roadmap rows into sequential slices before opening, unless Stephen lists the slice in `extraTaskSlices` on the base branch). Give stateful sync, Undo, concurrency, or parser/security logic its own task separate from UI, and list its edge cases upfront.
3. In the header, list under `tests` and `code` only files that exist today; add new ones when the slice is done. Fill `invariants` (ids from `docs/invariants.md`, or `none`), `risk`, `undo`, `owns`, and `proof` as the template says. The checker fails on a missing field or a listed file that does not exist.
   In `owns`, name the specific folders or files the slice changes. On a new plan the checker refuses more than `maxOwnsPerSlice` entries (default 10), and, with `forbidBroadOwns` on (the default), any entry that is or holds a `productPaths` or `screenPaths` root, like `apps/mobile/`, `packages/`, `.`, or a wildcard such as `apps/mobile/*.ts` (a part with `*` claims its whole folder); a folder inside one, like `packages/core/locales/`, is fine. When `screenPaths` lists screen folders, it also refuses more than `maxScreensPerSlice` entries inside them (default 2): split the slice. `extraTaskSlices` on the base branch waives all three.
4. Add or update the slice's row in `docs/roadmap.md`, with a link to the plan.
5. A choice that affects only this slice goes in its Decision log. A choice that affects other slices gets a decision file.

## Claim it

6. Set `status: in_progress` in the header, and fill `builder` and `reviewer` from `scripts/kit.config.json` (`models`). Write them as `tool/model-id`, with the model id exactly as your tool lists it. The reviewer must differ from the builder and from every head agent model; the checker compares model ids only, so the same model through another tool counts as the same. It also refuses the claim while another running slice owns one of the same paths (`owns`): wait for it, or narrow `owns`.
7. Outside the loop, if the settings name no models, ask Stephen which to use and suggest a pair. In the loop, a missing model is a stop condition (`docs/agents/loop.md`).

## Merge the opening

8. Commit, push, open the pull request, and run `node scripts/merge-pr.mjs <number>`. It is a paperwork change, so it merges in seconds.
9. With `features.claimCheck` on, the checker refuses your claim if another thread's claim of the same slice landed first, even when git merged both cleanly. The slice is theirs: start a new `lead/` branch from the base branch and pick another slice.

## Numbered things

Plan ids, decision files, and database migrations take the next free number. Check both the base branch and open branches before you pick one, and rename yours if another lands first.

## Moving or renaming files

Do the move alone, on a `lead/` branch. In the same change, fix every plan header, active and completed, whose `tests` or `code` list names an old path. Merge it before builders start on top of it.

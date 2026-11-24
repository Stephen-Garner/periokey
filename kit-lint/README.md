# Kit lint: shared lint and format settings for TypeScript projects

This folder is the one place in the kit that uses npm packages. Everything in `scripts/` and `kit/` uses only Node's built-in modules. In a project, this folder lands as `kit-lint/`. The kit owns it: a project never edits it.

## What is here

| File | What it is |
|---|---|
| `eslint-plugin-kit/` | The kit's ESLint rules (plain ES modules, no build step) |
| `eslint.base.mjs` | Shared ESLint settings. The project's `eslint.config.mjs` imports `kitConfig` from it |
| `oxlintrc.base.json` | Shared Oxlint settings. The project's `.oxlintrc.json` extends it |
| `hints.json`, `hints.mjs` | A fix hint per common rule, and the command that prints lint and secret-scan reports with them |
| `gitleaks.toml` | Secret scan settings: gitleaks' default rules, plus one narrow allowance for the kit manifest's fingerprint lines. Commands pass `--config kit-lint/gitleaks.toml`, so a project's own `.gitleaks.toml` is never read, and the switch-off guard refuses one |
| `fixtures/`, `*.test.mjs`, `package.json` | Tests and test tools. Kit only: not copied into a project |

The tests live in the starter kit, not in a project. In the kit, run them from inside its `lint/` folder: `pnpm install`, then `node --test`. The hook tests also need lefthook and gitleaks installed (`brew install lefthook gitleaks`).

## Who runs what

- **Oxlint** runs the built-in rules. It is fast enough for every commit.
- **ESLint** runs only the kit's rules and any project-only rules. Its last settings blocks, from `eslint-plugin-oxlint`, switch off each rule Oxlint really runs, read from the kit's `oxlintrc.base.json` and the project's `.oxlintrc.json`, so no rule runs twice. A rule Oxlint knows but does not run, such as `no-restricted-imports`, still runs in ESLint.
- **Prettier** formats code and settings files. Markdown is left out (see `template/.prettierignore`).
- **Kit-owned files** (every file `scripts/kit.manifest.json` lists) are not the project's to fix. ESLint skips them (`eslint.base.mjs` reads the manifest). Oxlint cannot read the manifest, so it checks them and `hints.mjs` drops their lint problems. A project's own scripts are checked like any code. The secret scan is never filtered: a secret in a kit-owned file still fails.
- **Not-yet-clean folders** (`notYetClean` in `scripts/kit.config.json`) hold old code being cleaned up in chunks. Lint is not enforced there yet: ESLint skips them, and `hints.mjs` drops Oxlint problems there and prints one closing line with how many it left out. Prettier and the secret scan still cover them, so a project can format everything in one commit first. The list may only shrink.
- **`.gitleaksignore`** stops the secret job with a plain line: delete it. gitleaks reads it whether git tracks it or not.

## Kit rules

| Rule | Where | What fails |
|---|---|---|
| `kit/no-comments` | product code | Any comment, JSDoc and license headers included. Allowed: a note starting with `why:` and a reason after it, a tool switch with a reason (`eslint-disable ... -- reason`), a `#!` line, a `/// <reference />` line |
| `kit/ts-directive-needs-reason` | product code | `@ts-expect-error` or `@ts-ignore` with no reason after it; `@ts-nocheck` always |
| `kit/no-skipped-tests` | everywhere but not-yet-clean folders | `.skip`, `.only`, `.todo`, `skipIf`, `xit`, `fit` and the like, also with brackets (`test["skip"]`), and Node's `{ skip: true }`, `t.skip()` |
| `kit/no-uninstalled-import` | everywhere but not-yet-clean folders | An import of a package missing from the nearest `package.json`. Paths, Node built-ins, schemes such as `cloudflare:`, and `tsconfig` path aliases are fine |
| `kit/flag-groups` | off | Three or more `is`/`has` names in one type or component's props. Used only for a count |

"Product code" means the folders in `productPaths` (`./src`, `src`, and `src/` are the same folder) of `scripts/kit.config.json`, minus test files (`testPaths`). Folders in `notYetClean` are not linted at all yet (see above). ESLint's own switch-off comments do nothing (`noInlineConfig`).

The import plugin's `no-extraneous-dependencies` rule was not used: it skips any import it cannot find on disk, so a made-up package passes. Oxlint has no such rule.

**Counting flag groups.** The ratchet script runs ESLint with the rule switched on for that one run and counts its reports. The command is in `template/kit.ratchets.json`:
`pnpm exec eslint --rule '{"kit/flag-groups":"error"}' --format json .`

## Oxlint rule groups

Zero warnings is the bar, so every rule is either `error` or `off`.

| On | Why |
|---|---|
| `correctness` group | Code that is wrong or does nothing |
| `suspicious` group | Code that is most likely wrong |
| Plugins: `typescript`, `unicorn`, `oxc`, `react`, `import`, `promise`, `node`, `jest` | The first project is an Expo app and a Cloudflare Workers server. The Jest rules also cover Vitest files; the Vitest plugin is left off because it reports the same problems a second time |
| Extra rules | `eqeqeq`, `no-var`, `prefer-const`, `no-throw-literal`; for TypeScript `no-explicit-any`, `no-non-null-assertion`, `prefer-ts-expect-error`, `consistent-type-imports`, `no-namespace`; `react/no-array-index-key`, `import/no-cycle`, `import/no-duplicates`, `unicorn/prefer-node-protocol` |
| Unused switch-off comments | Reported as errors |

| Off | Why |
|---|---|
| `pedantic`, `style`, `perf`, `restriction`, `nursery` groups | Too many false alarms, or taste. Single rules from them are switched on above |
| `jsx-a11y` plugin | Written for web pages; wrong for React Native |
| `react/react-in-jsx-scope` | Not needed with the current JSX transform |
| `import/no-unassigned-import` | Expo needs bare imports such as `import "react-native-gesture-handler"` |
| `promise/always-return` | Fails on a normal `.then()` that only sets state |
| `jest/no-disabled-tests`, `jest/no-focused-tests` | `kit/no-skipped-tests` covers them, for every test runner |
| `react/exhaustive-effect-dependencies` | Reports the same problem as `react/exhaustive-deps` |

Type-aware rules (such as no floating promises) need the extra package `oxlint-tsgolint` and are not on yet.

## Prettier

Prettier's own defaults, written out so a future Prettier release cannot change them: 80 columns, 2 spaces, semicolons, double quotes, trailing commas everywhere, LF line endings.

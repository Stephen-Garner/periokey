// ESLint settings for this project. From the starter kit; the project owns this file.
// The shared kit settings live in kit-lint/eslint.base.mjs (kit-managed, never edited here).
// ESLint runs only what Oxlint cannot: the kit's rules and project-only rules. Oxlint runs the rest.
import { kitConfig } from "./kit-lint/eslint.base.mjs";

// Project-only rules go here, as flat config blocks, for example:
//   { files: ["app/**/*.tsx"], rules: { "no-restricted-imports": ["error", "lodash"] } }
// Custom project ESLint rules live in tooling/eslint/ (see docs/agents/procedures/lessons-to-rules.md).
// A rule that Oxlint already runs is switched off after this list, so it never runs twice.
// Loosening or removing a rule is a weakening: record it (docs/agents/core.md).
const projectRules = [];

export default kitConfig(import.meta.dirname, projectRules);

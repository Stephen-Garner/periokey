// The kit's shared ESLint settings (flat config). A project's own eslint.config.mjs imports it:
//
//   import { kitConfig } from './kit-lint/eslint.base.mjs';
//   export default kitConfig(import.meta.dirname, [ ...project-only rules... ]);
//
// What it does, in plain English:
//   - ESLint here runs only what Oxlint cannot: the kit's own rules, plus any project-only rules.
//     The last blocks (from eslint-plugin-oxlint) switch off each rule Oxlint really runs, so no rule
//     runs twice, even if a project-only block turns one on. "Really runs" comes from the project's
//     .oxlintrc.json (JSON or JSON with comments) merged with every file it "extends" (a later file
//     wins for each rule, category, and plugin list). Rules from inactive plugins, rules Oxlint knows
//     but does not run (no-restricted-imports), or rules turned "off" stay on in ESLint. Oxlint's
//     "ignorePatterns" and per-file "overrides" that turn rules off are applied only to the switch-off
//     blocks, so ESLint still lints those files with every rule Oxlint skipped. With no .oxlintrc.json,
//     nothing is switched off.
//   - Inline switch-off comments ("eslint-disable") do nothing (noInlineConfig), and leftover ones
//     are reported as errors.
//   - kit/no-comments and kit/ts-directive-needs-reason run only inside the folders listed in
//     "productPaths" of scripts/kit.config.json, minus test files (the "testPaths" patterns).
//     The other kit rules run on every file.
//   - The "notYetClean" folders are not linted at all yet (old code being cleaned up in chunks).
//     Prettier and the secret scan still cover them.
//   - Kit-owned code is not linted here: kit-lint/, and every file scripts/kit.manifest.json lists.
//     The kit tests those in its own repo. A project's own new scripts are linted like any code.
//   - Folder names in the settings are read the same way everywhere: "./src", "src", and "src/" are one folder.
//   - kit/flag-groups is off; the ratchet script switches it on for its own count (kit-lint/README.md).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import tsParser from '@typescript-eslint/parser';
import oxlint from 'eslint-plugin-oxlint';
import { loadConfig } from '../scripts/check-plans.mjs';
import kit from './eslint-plugin-kit/index.mjs';
import { kitFiles, normalisePath } from './hints.mjs';

export const CODE_EXTENSIONS = '{js,mjs,cjs,jsx,ts,mts,cts,tsx}';
const CODE_FILES = [`**/*.${CODE_EXTENSIONS}`];
export { normalisePath };

export function productGlobs(productPaths) {
  return productPaths.map((path) => `${normalisePath(path)}**/*.${CODE_EXTENSIONS}`);
}

export function skipGlobs(notYetClean, testPaths) {
  const tests = testPaths.map((pattern) => (pattern.endsWith('/') ? `**/${pattern}**` : `**/*${pattern}*`));
  return [...notYetClean.map((path) => `${normalisePath(path)}**`), ...tests];
}

const OFF = new Set(['off', 'allow', 0]);
const isOff = (value) => OFF.has(Array.isArray(value) ? value[0] : value);
const DEFAULT_OXLINT_PLUGINS = ['eslint', 'unicorn', 'typescript', 'oxc'];
const PLUGIN_ALIAS = {
  '@typescript-eslint': 'typescript',
  'react-hooks': 'react',
  'import-x': 'import',
  n: 'node',
  '@next/next': 'nextjs',
  next: 'nextjs',
};

function stripJsonc(text) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      if (i < text.length) out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < text.length) {
        if (/\s/.test(text[j])) j += 1;
        else if (text[j] === '/' && text[j + 1] === '/') {
          while (j < text.length && text[j] !== '\n') j += 1;
        } else if (text[j] === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j += 1;
          j += 2;
        } else break;
      }
      if (text[j] !== '}' && text[j] !== ']') out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function eslintIgnorePattern(pattern) {
  return pattern.includes('/') ? pattern : `**/${pattern}`;
}

function rulePlugin(rule) {
  const slash = rule.indexOf('/');
  if (slash === -1) return 'eslint';
  if (rule.startsWith('@next/next/')) return 'nextjs';
  const prefix = rule.slice(0, slash);
  return PLUGIN_ALIAS[prefix] ?? prefix;
}

const ruleNameCache = new Map();
function eslintNamesFor(rule) {
  if (!ruleNameCache.has(rule)) {
    const names = oxlint.buildFromOxlintConfig({ categories: {}, rules: { [rule]: 'error' } }).flatMap((b) => Object.keys(b.rules ?? {}));
    ruleNameCache.set(rule, names);
  }
  return ruleNameCache.get(rule);
}

function readOxlintChain(file, seen = []) {
  if (seen.includes(file)) throw new Error(`kit-lint: ${file} extends itself (through ${seen.join(' -> ')})`);
  let config;
  try {
    config = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`kit-lint: cannot read ${file} as JSON: ${error.message}`);
  }
  const { extends: parents = [], ...own } = config;
  return [...parents.flatMap((parent) => readOxlintChain(resolve(dirname(file), parent), [...seen, file])), own];
}

function oxlintRunsTheseRules(root) {
  const project = join(root, '.oxlintrc.json');
  if (!existsSync(project)) return [];
  const chain = readOxlintChain(project);
  const categories = Object.assign({}, ...chain.map((c) => c.categories));
  const ignorePatterns = [...new Set(chain.flatMap((c) => c.ignorePatterns ?? []))];
  const overrides = chain.flatMap((c) => c.overrides ?? []);

  // In Oxlint, setting plugins replaces optional plugins, while core eslint rules stay active.
  let activePlugins = new Set(DEFAULT_OXLINT_PLUGINS);
  for (const part of chain) {
    if (Array.isArray(part.plugins)) activePlugins = new Set(['eslint', ...part.plugins]);
  }

  // Walk rules in extends order so a later alias (e.g. @typescript-eslint/...) overrides an earlier one.
  const activeRules = {};
  const turnedOffNames = new Set();
  for (const part of chain) {
    for (const [rule, value] of Object.entries(part.rules ?? {})) {
      if (!activePlugins.has(rulePlugin(rule))) continue;
      const names = eslintNamesFor(rule);
      if (isOff(value)) {
        for (const name of names) turnedOffNames.add(name);
        delete activeRules[rule];
      } else {
        for (const name of names) turnedOffNames.delete(name);
        activeRules[rule] = value;
      }
    }
  }

  const config = { plugins: [...activePlugins], rules: activeRules };
  if (Object.keys(categories).length) config.categories = categories;

  const eslintIgnores = ignorePatterns.map(eslintIgnorePattern);
  const blocks = oxlint
    .buildFromOxlintConfig(structuredClone(config))
    .filter((block) => block.rules)
    .map((block) => ({
      ...block,
      rules: { ...block.rules },
      ...(eslintIgnores.length ? { ignores: [...(block.ignores ?? []), ...eslintIgnores] } : {}),
    }));

  // Remove any rule explicitly turned off, or from a plugin not in activePlugins.
  for (const block of blocks) {
    for (const name of Object.keys(block.rules)) {
      if (turnedOffNames.has(name) || !activePlugins.has(rulePlugin(name))) delete block.rules[name];
    }
  }

  // If a per-file override disables a rule, scope that rule's switch-off to exclude those files.
  const overrideDisabledFiles = new Map();
  for (const ov of overrides) {
    const files = Array.isArray(ov.files) ? ov.files : [];
    if (!files.length) continue;
    for (const [rule, value] of Object.entries(ov.rules ?? {})) {
      if (!isOff(value)) continue;
      for (const name of eslintNamesFor(rule)) {
        if (!overrideDisabledFiles.has(name)) overrideDisabledFiles.set(name, new Set());
        for (const pattern of files) overrideDisabledFiles.get(name).add(pattern);
      }
    }
  }

  const scopedBlocks = [];
  for (const [name, fileSet] of overrideDisabledFiles.entries()) {
    let wasDisabled = false;
    for (const block of blocks) {
      if (block.rules[name] === 'off') {
        delete block.rules[name];
        wasDisabled = true;
      }
    }
    if (wasDisabled) {
      scopedBlocks.push({
        name: `oxlint/override-scoped:${name}`,
        files: CODE_FILES,
        ignores: [...eslintIgnores, ...[...fileSet].map(eslintIgnorePattern)],
        rules: { [name]: 'off' },
      });
    }
  }

  return [...blocks.filter((b) => Object.keys(b.rules).length > 0), ...scopedBlocks];
}

export function kitConfig(root, projectRules = []) {
  const { productPaths, notYetClean, testPaths } = loadConfig(root);
  const productBlock = productPaths.length
    ? [
        {
          name: 'kit/product-code',
          files: productGlobs(productPaths),
          ignores: skipGlobs(notYetClean, testPaths),
          rules: { 'kit/no-comments': 'error', 'kit/ts-directive-needs-reason': 'error' },
        },
      ]
    : [];
  return [
    { name: 'kit/ignores', ignores: ['kit-lint/**', ...kitFiles(root), ...notYetClean.map((path) => `${normalisePath(path)}**`)] },
    {
      name: 'kit/all-code',
      files: CODE_FILES,
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' },
      languageOptions: { parser: tsParser, sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { kit },
      rules: { 'kit/no-skipped-tests': 'error', 'kit/no-uninstalled-import': 'error', 'kit/flag-groups': 'off' },
    },
    ...productBlock,
    ...projectRules,
    ...oxlintRunsTheseRules(root),
  ];
}

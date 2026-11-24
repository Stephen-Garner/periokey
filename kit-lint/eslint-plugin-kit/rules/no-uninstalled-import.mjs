// no-uninstalled-import: every package a file imports must be listed in the nearest package.json.
//
// What it does, in plain English:
//   An agent sometimes imports a package that is not part of the project, or one that does not exist.
//   This rule reads the nearest package.json above the file and fails on any import of a package
//   that is not in its dependencies, devDependencies, peerDependencies, or optionalDependencies.
//   Always fine: relative paths ("./x", "../x"), absolute paths, Node built-ins ("fs", "node:fs"),
//   other schemes ("cloudflare:workers", "bun:test"), "#" subpath imports, the package's own name,
//   and the project's path aliases: the keys of "compilerOptions.paths" in the nearest tsconfig.json
//   ("@/*" allows "@/anything"). A type-only import may also be covered by "@types/<name>".
//   It checks import, export ... from, import(), and require().
//   Why not the import plugin's "no-extraneous-dependencies": it skips any import it cannot find on
//   disk, so a made-up package that is not installed passes. That is the case this rule is for.

import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative } from 'node:path';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

export function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function typesName(name) {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
}

export function needsListing(spec, aliases = []) {
  if (spec === '' || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || isBuiltin(spec)) return false;
  return !aliases.some((key) => (key.endsWith('*') ? spec.startsWith(key.slice(0, -1)) : spec === key));
}

export function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function findUp(startDir, name) {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
    if (dirname(dir) === dir) return null;
  }
}

const cache = new Map();
function cached(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}

export function readListing(fileDir) {
  return cached(`pkg:${fileDir}`, () => {
    const path = findUp(fileDir, 'package.json');
    if (!path) return { path: null, names: new Set() };
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    const names = new Set(DEP_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})));
    if (pkg.name) names.add(pkg.name);
    return { path, names };
  });
}

export function readAliases(fileDir) {
  return cached(`ts:${fileDir}`, () => {
    const path = findUp(fileDir, 'tsconfig.json');
    if (!path) return [];
    const tsconfig = JSON.parse(stripJsonComments(readFileSync(path, 'utf8')));
    return Object.keys(tsconfig.compilerOptions?.paths ?? {});
  });
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'No import of a package that is not listed in the nearest package.json.' },
    schema: [],
    messages: {
      notListed:
        '"{{name}}" is not listed in {{where}}. Fix: if the code needs it, install it with "pnpm add {{name}}" (or "pnpm add -D {{name}}" for tests and tools); if not, remove the import. A made-up package name never works.',
    },
  },
  create(context) {
    const fileDir = dirname(context.physicalFilename);
    const check = (source, typeOnly) => {
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
      if (!needsListing(source.value, readAliases(fileDir))) return;
      const name = packageName(source.value);
      const { path, names } = readListing(fileDir);
      if (names.has(name) || (typeOnly && names.has(typesName(name)))) return;
      const where = path ? relative(context.cwd, path) || 'package.json' : 'any package.json (none was found above this file)';
      context.report({ node: source, messageId: 'notListed', data: { name, where } });
    };
    return {
      ImportDeclaration: (node) => check(node.source, node.importKind === 'type'),
      ExportNamedDeclaration: (node) => check(node.source, node.exportKind === 'type'),
      ExportAllDeclaration: (node) => check(node.source, node.exportKind === 'type'),
      ImportExpression: (node) => check(node.source, false),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) check(node.arguments[0], false);
      },
    };
  },
};

// no-skipped-tests: no skipped, focused, or to-do tests (Jest, Vitest, Node's test runner).
//
// What it does, in plain English:
//   A skipped test proves nothing, and a focused test (.only) silently skips all the others.
//   It fails on:
//   - test.skip, it.only, describe.skip, test.todo, test.skipIf, test.runIf, and longer chains such
//     as it.concurrent.skip or describe.skip.each
//   - xit, xtest, xdescribe, fit, ftest, fdescribe
//   - Node's test runner options: test("name", { skip: true }, ...), { only: ... }, { todo: ... }
//   - Node's in-test switches: t.skip() and t.todo(), where t is the test's own context

const TEST_NAMES = new Set(['test', 'it', 'describe', 'suite', 'context', 'bench']);
const BANNED_PARTS = new Set(['skip', 'only', 'todo', 'skipIf', 'runIf']);
const SHORT_FORMS = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'ftest', 'fdescribe']);
const NODE_OPTIONS = new Set(['skip', 'only', 'todo']);
const IN_TEST = new Set(['skip', 'todo']);

function propertyName(member) {
  const { property } = member;
  if (!member.computed) return property.type === 'Identifier' ? property.name : null;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0) return property.quasis[0].value.cooked;
  return null;
}

export function calleeChain(callee) {
  const parts = [];
  let node = callee;
  while (node.type === 'MemberExpression' && propertyName(node) !== null) {
    parts.unshift(propertyName(node));
    node = node.object;
  }
  return node.type === 'Identifier' ? { root: node.name, parts } : null;
}

function isTestCall(node) {
  if (node?.type !== 'CallExpression') return false;
  let callee = node.callee;
  while (callee.type === 'CallExpression') callee = callee.callee;
  const chain = calleeChain(callee);
  return Boolean(chain && TEST_NAMES.has(chain.root));
}

function isTestContext(context, node, name) {
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(name);
    if (variable) {
      const def = variable.defs[0];
      return def?.type === 'Parameter' && def.node.params[0]?.type === 'Identifier' && def.node.params[0].name === name && isTestCall(def.node.parent);
    }
    scope = scope.upper;
  }
  return false;
}

const optionValueIsOn = (prop) => !(prop.value.type === 'Literal' && prop.value.value === false);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'No skipped, focused, or to-do tests.' },
    schema: [],
    messages: {
      skipped:
        '"{{what}}" skips or focuses tests, so some tests stop running. Fix: remove it and make the test pass; if the test is wrong, fix or delete it in the open.',
    },
  },
  create(context) {
    const report = (node, what) => context.report({ node, messageId: 'skipped', data: { what } });
    return {
      CallExpression(node) {
        const chain = calleeChain(node.callee);
        if (!chain) return;
        const { root, parts } = chain;
        if (parts.length === 0 && SHORT_FORMS.has(root)) return report(node.callee, root);
        if (TEST_NAMES.has(root)) {
          const banned = parts.find((part) => BANNED_PARTS.has(part));
          if (banned) return report(node.callee, `${root}.${parts.join('.')}`);
          for (const arg of node.arguments) {
            if (arg.type !== 'ObjectExpression') continue;
            const prop = arg.properties.find((p) => p.type === 'Property' && p.key.type === 'Identifier' && NODE_OPTIONS.has(p.key.name) && optionValueIsOn(p));
            if (prop) return report(prop, `${prop.key.name}:`);
          }
          return;
        }
        if (parts.length === 1 && IN_TEST.has(parts[0]) && isTestContext(context, node, root)) report(node.callee, `${root}.${parts[0]}()`);
      },
    };
  },
};

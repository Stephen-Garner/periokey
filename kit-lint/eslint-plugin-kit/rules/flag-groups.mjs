// flag-groups: finds three or more is/has flags in one type, interface, or component's props.
//
// What it does, in plain English:
//   Names like isLoading, isError, hasData side by side usually mean one state spread over several
//   true/false values, which lets impossible mixes happen (loading and error at once).
//   This rule reports each type literal, interface, or untyped component props pattern that holds three
//   or more names starting with "is" or "has" followed by a capital letter.
//   It is a count, not a strict rule: the shared settings ship it switched off, and the ratchet script
//   switches it on for one run to count the groups (kit-lint/README.md says how).

const FLAG = /^(is|has)[A-Z0-9_]/;
export const MIN_FLAGS = 3;

export function flagNames(keys) {
  return keys.filter((key) => key?.type === 'Identifier' && FLAG.test(key.name)).map((key) => key.name);
}

const isComponentName = (name) => typeof name === 'string' && /^[A-Z]/.test(name);

function functionName(fn) {
  if (fn.id) return fn.id.name;
  if (fn.parent?.type === 'VariableDeclarator' && fn.parent.id.type === 'Identifier') return fn.parent.id.name;
  return null;
}

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Counts groups of three or more is/has flags in one place.' },
    schema: [],
    messages: {
      flags:
        '{{count}} true/false flags in one place ({{names}}). Fix: replace them with one field that names the states, like status: "loading" | "error" | "ready".',
    },
  },
  create(context) {
    const check = (node, keys) => {
      const names = flagNames(keys);
      if (names.length >= MIN_FLAGS) context.report({ node, messageId: 'flags', data: { count: names.length, names: names.join(', ') } });
    };
    const members = (list) => list.filter((m) => m.type === 'TSPropertySignature' || m.type === 'TSMethodSignature').map((m) => m.key);
    const props = (fn) => {
      const first = fn.params[0];
      if (first?.type !== 'ObjectPattern' || first.typeAnnotation || !isComponentName(functionName(fn))) return;
      check(first, first.properties.filter((p) => p.type === 'Property').map((p) => p.key));
    };
    return {
      TSTypeLiteral: (node) => check(node, members(node.members)),
      TSInterfaceBody: (node) => check(node.parent, members(node.body)),
      FunctionDeclaration: props,
      FunctionExpression: props,
      ArrowFunctionExpression: props,
    };
  },
};

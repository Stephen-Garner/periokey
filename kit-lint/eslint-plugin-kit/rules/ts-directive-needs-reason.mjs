// ts-directive-needs-reason: a TypeScript switch-off must say why.
//
// What it does, in plain English:
//   "@ts-expect-error" and "@ts-ignore" tell TypeScript to skip the next line's type check. Each one
//   must give a reason after it, like "// @ts-expect-error: the library's types miss this option".
//   "@ts-nocheck" skips type checks for a whole file and is always refused.
//   The shared settings (kit-lint/eslint.base.mjs) switch this rule on only inside productPaths.

const TS_DIRECTIVE = /^@ts-(expect-error|ignore|nocheck)\b(.*)$/s;

export function directiveProblem(commentValue) {
  const match = TS_DIRECTIVE.exec(commentValue.replace(/^[\s*/]+/, ''));
  if (!match) return null;
  if (match[1] === 'nocheck') return 'noCheck';
  const reason = match[2].replace(/^[\s:-]+/, '').trim();
  return /[A-Za-z]{2}/.test(reason) ? null : 'needsReason';
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A TypeScript switch-off must give a reason; @ts-nocheck is refused.' },
    schema: [],
    messages: {
      needsReason:
        'This TypeScript switch-off gives no reason, and product code may not switch type checks off at all. Fix: remove it and fix the type. In a test file, "// @ts-expect-error: <reason>" is allowed.',
      noCheck:
        '@ts-nocheck switches off type checks for the whole file. Fix: remove it and fix the type errors it hides. In a test file, "// @ts-expect-error: <reason>" is allowed on the one line that needs it.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const messageId = directiveProblem(comment.value);
          if (messageId) context.report({ loc: comment.loc, messageId });
        }
      },
    };
  },
};

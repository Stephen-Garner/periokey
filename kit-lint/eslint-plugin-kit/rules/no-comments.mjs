// no-comments: bans comments in product code.
//
// What it does, in plain English:
//   Every comment fails, JSDoc included, with three exceptions:
//   1. A note whose text starts with "why:" and gives the reason after it. It says why the code is the way it is, which code cannot say.
//   2. A tool switch the tools need, when it gives a reason: "eslint-disable... -- reason" or
//      "oxlint-disable... -- reason". TypeScript's @ts-expect-error, @ts-ignore, and @ts-nocheck are left
//      to the rule kit/ts-directive-needs-reason, so one problem gets one message.
//   3. Lines the language needs: a "#!" first line and a "/// <reference ... />" line.
//   License headers are comments too, and fail.
//   The shared settings (kit-lint/eslint.base.mjs) switch this rule on only inside productPaths.

const SWITCH_WITH_REASON = /^(eslint|oxlint)-(disable|enable)(-line|-next-line)?\b.*\s--\s*\S/s;
const TS_DIRECTIVE = /^@ts-(expect-error|ignore|nocheck)\b/;
const REFERENCE = /^\/\s*<reference\b/;

export function isAllowedComment(comment) {
  if (comment.type === 'Shebang') return true;
  const text = comment.value.trim();
  if (text.startsWith('why:') && /\w/.test(text.slice(4))) return true;
  if (comment.type === 'Line' && REFERENCE.test(comment.value)) return true;
  const bare = comment.value.replace(/^[\s*/]+/, '');
  return TS_DIRECTIVE.test(bare) || SWITCH_WITH_REASON.test(bare);
}

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Comments are banned in product code, except notes that start with "why:".' },
    schema: [],
    messages: {
      comment:
        'Comment in product code. Fix: delete it and let the code say it (a clearer name, a smaller function, a named constant). If the code cannot show the reason behind it, start the comment with "why:".',
      jsdoc:
        'JSDoc comment in product code. Fix: delete it; types and names carry this. If the code cannot show the reason behind it, write a "// why: ..." note instead.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (isAllowedComment(comment)) continue;
          const jsdoc = comment.type === 'Block' && comment.value.startsWith('*');
          context.report({ loc: comment.loc, messageId: jsdoc ? 'jsdoc' : 'comment' });
        }
      },
    };
  },
};

// The kit's ESLint plugin. Plain ES modules, no build step. Loaded as "kit" by kit-lint/eslint.base.mjs,
// so its rules are named kit/no-comments, kit/no-skipped-tests, and so on.

import flagGroups from './rules/flag-groups.mjs';
import noComments from './rules/no-comments.mjs';
import noSkippedTests from './rules/no-skipped-tests.mjs';
import noUninstalledImport from './rules/no-uninstalled-import.mjs';
import tsDirectiveNeedsReason from './rules/ts-directive-needs-reason.mjs';

export default {
  meta: { name: 'eslint-plugin-kit', version: '1.0.0' },
  rules: {
    'no-comments': noComments,
    'no-skipped-tests': noSkippedTests,
    'ts-directive-needs-reason': tsDirectiveNeedsReason,
    'no-uninstalled-import': noUninstalledImport,
    'flag-groups': flagGroups,
  },
};

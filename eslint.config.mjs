import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';

// Start with correctness and security rules that have actionable findings.
// Stylistic migrations are intentionally separate from production hardening.
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '.local-data/**', '.aws-sam/**', 'coverage/**'] },
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { security },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-constant-binary-expression': 'error',
      'no-debugger': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-prototype-builtins': 'error',
      'no-script-url': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-sparse-arrays': 'error',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'security/detect-bidi-characters': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['zod/v3', 'zod/v3/*', 'zod/v4-mini'], message: 'Use the patched Zod v4 root import so runtime validation and its resource limits are consistent.' }],
      }],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    // These literals are attack fixtures used to verify URL sanitization.
    rules: { 'no-script-url': 'off' },
  },
];

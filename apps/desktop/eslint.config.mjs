import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Existing violations are recorded in eslint-suppressions.json (`npx eslint . --suppress-all`), so only new code is held
// to the rules. Fix a suppressed one and run `npx eslint . --prune-suppressions` to shrink the baseline.
export default tseslint.config(
  { ignores: ['dist', 'src-tauri', 'public', 'src/canvas/generated', 'sidecar/node_modules', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    // TypeScript already reports undefined names.
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['**/*.mjs', 'scripts/**', 'tests/**', 'sidecar/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['**/*.{ts,tsx,mjs}'],
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);

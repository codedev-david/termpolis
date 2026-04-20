module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist',
    'dist-electron',
    'dist-electron-builder',
    'out',
    'coverage',
    'node_modules',
    '.eslintrc.cjs',
    'e2e/screenshots',
    'e2e/visual-regression.spec.ts-snapshots',
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh', 'react-hooks'],
  rules: {
    // Core correctness — must stay as error. The PaneRenderer Split
    // Right/Down bug (Apr 2026) shipped because a hook was declared
    // after a conditional early return — rules-of-hooks catches that.
    'react-hooks/rules-of-hooks': 'error',
    // Missing-deps tend to be false-positives that require refactoring
    // to silence; keep visible as warn but don't block CI.
    'react-hooks/exhaustive-deps': 'warn',
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    // Style / low-signal rules — demoted to avoid noise drowning out
    // real findings. Revisit individually if a class of bug shows up.
    'no-extra-semi': 'off',
    '@typescript-eslint/no-extra-semi': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-var-requires': 'off',
    'no-inner-declarations': 'off',
    'no-console': 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-control-regex': 'off',
    'no-useless-escape': 'warn',
    'prefer-const': 'warn',
  },
  overrides: [
    {
      // Tests and e2e specs legitimately need `any` for DOM/fixture
      // mocking and don't need the same strictness as production code.
      files: ['tests/**/*.{ts,tsx}', 'e2e/**/*.{ts,tsx}', 'vitest.config.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/ban-types': 'off',
        'react-hooks/exhaustive-deps': 'off',
        'no-empty': 'off',
      },
    },
    {
      // .cjs / .js preload/adapter scripts legitimately use require().
      files: ['**/*.{cjs,js}', 'src/mcp-adapter/**/*.{cjs,js,ts}'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        'no-empty': 'off',
      },
    },
  ],
}

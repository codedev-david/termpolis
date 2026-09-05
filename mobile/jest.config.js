const preset = require('jest-expo/jest-preset')

// `@noble/*` is ESM-only. jest-expo's default allowlist does not include it, so
// without this the wire modules fail to parse -- and they fail at import time,
// which reads as "the module does not exist" rather than "the transform skipped
// it". Extend the preset's pattern rather than replacing it: dropping the React
// Native entries would break every screen test.
const transformIgnorePatterns = preset.transformIgnorePatterns.map((p) =>
  p.startsWith('/node_modules/(?!') ? p.replace('(?!(', '(?!(@noble|') : p,
)

module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    // Type-only. Babel emits an empty module for it, which istanbul reports as
    // 0% of nothing and drags the total down for a file that cannot be tested.
    '!src/navigation/routes.ts',
  ],
  // Raised to just under what the suite achieves as each task lands, in the
  // relay/vitest.config.ts style. Starting at zero and never revisiting is how a
  // gate becomes decoration.
  coverageThreshold: { global: { lines: 95, functions: 88, branches: 92, statements: 94 } },
}

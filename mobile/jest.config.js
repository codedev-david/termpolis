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
  collectCoverageFrom: ['src/**/*.{ts,tsx}'],
  // Raised to just under what the suite achieves as each task lands, in the
  // relay/vitest.config.ts style. Starting at zero and never revisiting is how a
  // gate becomes decoration.
  coverageThreshold: { global: { lines: 0, functions: 0, branches: 0, statements: 0 } },
}

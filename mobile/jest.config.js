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
  // The app is at 100 on all four counters, so the gate sits there too. It can,
  // because the two branches that genuinely could not be reached were deleted
  // rather than ignored -- an unreachable branch is dead code, and an
  // istanbul-ignore comment only hides that. This phone talks to a machine over
  // a relay it does not trust; an untested line here is one nobody has run.
  coverageThreshold: { global: { lines: 100, functions: 100, branches: 100, statements: 100 } },
}

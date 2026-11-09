// The per-message router evaluation (npm run router:eval). Kept out of the test suite and coverage:
// it loads the real bge-small model and reads the local Claude Code transcripts.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/routerEval/**/*.eval.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
})

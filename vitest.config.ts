import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    exclude: ['**/node_modules/**', '**/.worktrees/**', '**/e2e/**'],
    environmentMatchGlobs: [
      ['tests/electron/**', 'node'],
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/renderer/src/lib/**/*.ts',
        'src/renderer/src/components/**/*.tsx',
        'src/renderer/src/store/**/*.ts',
        'src/main/**/*.ts',
        'src/preload/**/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        '**/node_modules/**',
        '**/types/**',
        'src/renderer/src/lib/sentry.ts',
        'src/main/sentry.ts',
        'src/renderer/src/lib/terminalDefaults.ts',
        'src/renderer/src/lib/outputPatterns.ts',
        'src/renderer/src/lib/homedir.ts',
      ],
      thresholds: {
        lines: 45,
        functions: 45,
        branches: 37,
        statements: 43,
      },
    },
  },
})

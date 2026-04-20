import { defineConfig } from 'vitest/config'
import { createLogger } from 'vite'
import react from '@vitejs/plugin-react'

// Suppress known deprecation warnings from @vitejs/plugin-react 4.x
// (uses esbuild API deprecated in Vite 6 bundled by vitest 4.x)
const logger = createLogger()
const origWarn = logger.warn.bind(logger)
logger.warn = (msg, ...args) => {
  if (typeof msg === 'string' && (
    (msg.includes('esbuild') && msg.includes('deprecated')) ||
    msg.includes('Both esbuild and oxc options were set')
  )) return
  origWarn(msg, ...args)
}

// Vite's option resolver also writes directly to stderr — intercept that too
const origStderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: any, ...rest: any[]) => {
  const str = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? ''
  if (str.includes('esbuild') && str.includes('oxc')) return true
  return (origStderrWrite as any)(chunk, ...rest)
}) as typeof process.stderr.write

export default defineConfig({
  plugins: [react()],
  customLogger: logger,
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
        'src/main/types.ts',
        'src/renderer/src/lib/sentry.ts',
        'src/main/sentry.ts',
        'src/main/autoUpdater.ts',
        'src/renderer/src/lib/terminalDefaults.ts',
        'src/renderer/src/lib/outputPatterns.ts',
        'src/renderer/src/lib/homedir.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
})

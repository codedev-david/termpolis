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
        'src/main/embedWorker.ts', // BB11: worker_thread + real spawner — integration, exercised in-app not in vitest
        'src/renderer/src/lib/terminalDefaults.ts',
        'src/renderer/src/lib/outputPatterns.ts',
        'src/renderer/src/lib/homedir.ts',
        'src/renderer/src/components/TitleBar/TitleBar.tsx',
      ],
      thresholds: {
        // Gates apply to Windows CI only (see .github/workflows/test.yml).
        // src/main has ~19 `process.platform === 'win32'` checks whose
        // win32 side never executes on Linux/macOS — running the gate on
        // every platform would flap at ~1% drift. Windows is the one
        // platform that hits every branch, so these are the real ceilings
        // the project enforces.
        //
        // Hard floors. Anything below means we stopped writing tests, not that the codebase got
        // harder. Backfill tests on the offending file(s) — NEVER lower the gate.
        //
        // RAISED in v1.25.5. The old floors (90/90/85/90) had stopped doing their job: actual
        // coverage was 91.39 / 85.41 / 90.08 / 93.78 — i.e. FUNCTIONS cleared its gate by 0.08 and
        // branches by 0.41. A gate you clear by a rounding error is not a gate; it is a tripwire
        // that goes off on the next commit, and the cheapest way to make it green is to delete a
        // test. So ~1,000 real tests went in (the worst offender by far was src/main/index.ts: 162
        // uncovered functions, 43.7% branch coverage — ~100 IPC handlers that nothing invoked),
        // taking coverage to 96.63 / 93.27 / 96.02 / 97.78.
        //
        // These floors sit ~1-2 points under that: high enough that a regression is caught, with
        // enough slack that normal drift does not flap the build.
        //
        // RAISED AGAIN in v1.25.7 to 96/93/96/97. Coverage is now 97.59 / 94.53 / 97.10 / 98.56. The
        // holes that remain are genuinely hard, not laziness: require('fs') paths that vi.mock cannot
        // reach, platform-gated arms that only run on the other OS, and provably dead defensive code.
        lines: 97,
        functions: 96,
        branches: 93,
        statements: 96,
      },
    },
  },
})

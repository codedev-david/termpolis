import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  // vitest-pool-workers 0.22 dropped `defineWorkersConfig`/`./config` in favour of
  // a Vite plugin. Same thing: it stands the tests up inside workerd rather than
  // Node, so `WebSocketPair`, Durable Objects and the runtime's own WebSocket
  // semantics are the real ones and not a mock we would have to trust.
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // A 4 MiB per-connection budget so a test can actually exhaust it. Production
      // is 256 MiB (quota.ts), which no test can reach without tripping the
      // frame-rate limit first -- and a limit no test can reach is a limit no test
      // has checked.
      miniflare: { bindings: { CONNECTION_BYTE_BUDGET: '4194304' } },
    }),
  ],
  test: {
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      // The Workers runtime edges this once could not reach (hibernation, DO
      // eviction, socket teardown races) are covered now, and the suite sits at
      // 100 on all four counters. Held there: this is a few hundred lines with
      // one job, and it is the piece a phone cannot pair without. Any line that
      // arrives without a test is a line nobody has run.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
})

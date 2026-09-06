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
    // The rate-limit suite drives a REAL workerd through 40 sequential
    // `SELF.fetch` round-trips -- it has to be sequential, because the assertion
    // is on the ORDER in which requests flip from accepted to refused, and it has
    // to exceed 30, because that is the limit being proved. At ~125ms per
    // round-trip on a loaded CI runner that lands within a rounding error of
    // vitest's 5000ms default, which is why it passed locally and on three CI
    // runs and then timed out on the fourth.
    //
    // Raised rather than retried on purpose: a retry would hide a test that is
    // still one slow runner away from failing, and would hide a genuine
    // slowdown in the limiter behind a green tick.
    testTimeout: 30_000,
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

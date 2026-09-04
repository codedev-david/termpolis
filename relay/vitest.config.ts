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
      // Lower than the app's 97/96/95/96: Workers runtime edges (hibernation,
      // DO eviction, socket teardown races) are not all reachable in-process.
      // Set just under what the suite actually achieves (98.88/97.56/100/100), so a
      // regression trips the gate rather than quietly eroding a generous margin.
      thresholds: { lines: 97, functions: 100, branches: 95, statements: 97 },
    },
  },
})

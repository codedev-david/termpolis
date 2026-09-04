import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  // vitest-pool-workers 0.22 dropped `defineWorkersConfig`/`./config` in favour of
  // a Vite plugin. Same thing: it stands the tests up inside workerd rather than
  // Node, so `WebSocketPair`, Durable Objects and the runtime's own WebSocket
  // semantics are the real ones and not a mock we would have to trust.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
  test: {
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      // Lower than the app's 97/96/95/96: Workers runtime edges (hibernation,
      // DO eviction, socket teardown races) are not all reachable in-process.
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
})

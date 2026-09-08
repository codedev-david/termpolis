import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

// Injected so Sentry and the About modal always report the shipped version.
process.env.VITE_APP_VERSION = pkg.version

// Bake the Sentry DSN into the bundle. The user's machine has no env vars
// set, so we replace `process.env.SENTRY_DSN` references at build time with
// the literal string. Empty string when SENTRY_DSN isn't set in CI, which
// makes Sentry init a no-op (see src/main/sentry.ts).
const sentryDsn = JSON.stringify(process.env.SENTRY_DSN || '')

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // BB11: embedding worker_thread — a second main-process entry, emitted next to
          // index.js so it can be spawned off the UI thread for ONNX inference.
          embedWorker: resolve(__dirname, 'src/main/embedWorker.ts'),
          // v1.26: the memory brain's utilityProcess entry — a third main-process entry, emitted
          // next to index.js so memoryClient can utilityProcess.fork() it. initSwarmMemory() costs
          // ~4,276ms on a real store; in this child that cost is ZERO on the main (PTY/paint) thread.
          memoryHost: resolve(__dirname, 'src/main/memoryHost.ts'),
          // v1.29: the Headroom compression proxy's utilityProcess entry — emitted next to
          // index.js so proxySupervisor can utilityProcess.fork() it. Compresses Claude's
          // tool_result/image bytes off the main (PTY/paint) thread.
          headroomProxy: resolve(__dirname, 'src/main/headroomProxy/proxyMain.ts'),
          // Remote bridge, forked by remoteBridgeSupervisor. Its whole input is
          // an untrusted network, so a crash there must not take the app down, and
          // main stays free to pump PTY.
          remoteBridge: resolve(__dirname, 'src/main/remoteBridge/entry.ts'),
        },
      },
    },
    define: {
      'process.env.SENTRY_DSN': sentryDsn,
    },
    // Bundle pngjs INTO the child entry (headroomProxy) rather than externalize it, so the
    // utilityProcess never has to resolve it from node_modules at runtime — a missing/unresolvable
    // dep would crash the child (and silently disable the whole proxy).
    //
    // @xterm/headless is here for a second reason on top of that one. This bundle is ESM
    // (package.json says "type": "module") and @xterm/headless is CommonJS with no exports
    // map, so an externalized `import { Terminal } from '@xterm/headless'` throws
    // "Named export 'Terminal' not found" the moment the child starts — cjs-module-lexer
    // cannot see through its bundle to the named export. The child died before it could mint
    // a pairing code, so Settings opened a modal that never filled in a QR. Nothing in the
    // unit suite can catch that: vitest interops the import happily, and only the built
    // child is ESM. Bundling it converts the require at build time and removes both the
    // resolution and the interop from the runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['pngjs', '@xterm/headless'] })]
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    // The Whisper voice worker pulls in Transformers.js, which code-splits via
    // dynamic import. Vite's default IIFE worker format can't do code-splitting;
    // ES module workers can (Electron 30 / Chromium supports module workers).
    worker: {
      format: 'es'
    },
    plugins: [react()]
  }
})

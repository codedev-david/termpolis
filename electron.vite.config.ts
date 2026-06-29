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
        },
      },
    },
    define: {
      'process.env.SENTRY_DSN': sentryDsn,
    },
    plugins: [externalizeDepsPlugin()]
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

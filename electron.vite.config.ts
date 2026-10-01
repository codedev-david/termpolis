import { resolve } from 'path'
import { build as viteBuild, type Plugin } from 'vite'
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

// The Linux .deb's prerm (build/linux/before-remove.sh) disconnects the agents by running
// resources/disconnect-agents.cjs in the app's own Electron in Node mode. That file has to
// stand alone. It sits outside app.asar, next to the binary, and nothing resolves node_modules
// or the main bundle's ESM chunks for it. So once main is written, this builds
// src/main/disconnectAgentsEntry.ts again on its own, as one CommonJS file. It is an SSR (Node)
// build with every dependency inlined, so only Node's builtins are left as requires. It lands
// in out/linux/, next to out/main/, and package.json build.linux.extraResources ships it.
function disconnectAgentsBundle(): Plugin {
  let outDir = ''
  let watching = false
  return {
    name: 'termpolis:disconnect-agents-bundle',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir, '..', 'linux')
      watching = !!config.build.watch
    },
    async closeBundle() {
      // `electron-vite dev` rebuilds main on every save. Only a real build ships this file.
      if (watching) return
      await viteBuild({
        configFile: false,
        root: __dirname,
        publicDir: false,
        logLevel: 'warn',
        build: {
          ssr: resolve(__dirname, 'src/main/disconnectAgentsEntry.ts'),
          outDir,
          emptyOutDir: true,
          target: 'node20',
          minify: false,
          sourcemap: false,
          reportCompressedSize: false,
          rollupOptions: {
            output: { format: 'cjs', entryFileNames: 'disconnect-agents.cjs', inlineDynamicImports: true },
          },
        },
        ssr: { noExternal: true, target: 'node' },
      })
    },
  }
}

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
          // v1.47.1: the process host. Main is the thread that pumps every PTY, and uv_spawn
          // (CreateProcess on Windows) blocks the thread that calls it — measured at 48-623 ms per
          // git spawn, which is where ten seconds of typing lag came from. Every child process main
          // wants is forked from HERE instead.
          procHost: resolve(__dirname, 'src/main/procHost.ts'),
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
    plugins: [externalizeDepsPlugin({ exclude: ['pngjs', '@xterm/headless'] }), disconnectAgentsBundle()]
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

// Standalone Lumopolis bundles (npm run build:world-viewer), for termpolis.com and anything else
// that embeds the world view outside the Electron app:
//   dist-world/world-viewer.js   ESM, Three.js inlined: createWorldViewer, hasWebGL, the cards,
//                                renderFallback and validateWorld. One self-contained file.
//   dist-world/world-validate.js ESM, validateWorld only, no Three.js, importable from Node
//                                (the website's validator script).
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'

const VALIDATE = resolve(__dirname, 'src/shared/world/validate.ts')
const ENGINE_INDEX = resolve(__dirname, 'src/renderer/src/world/engine/index.ts')
// A path that does not exist on disk, ending in .ts so the TypeScript transform still applies.
const COPY = VALIDATE.replace(/\.ts$/, '.viewer-copy.ts')

// Both entries need validate.ts. Left alone, Rollup would keep one copy in world-validate.js and
// make world-viewer.js import it from there, so the viewer would no longer stand alone. This
// gives the viewer entry its own private copy of the module instead.
function privateValidateCopy(): Plugin {
  return {
    name: 'termpolis:world-viewer-private-validate',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!importer || resolve(importer) !== ENGINE_INDEX || !/shared\/world\/validate$/.test(source)) return null
      return COPY
    },
    load(id) {
      return id === COPY ? readFileSync(VALIDATE, 'utf8') : null
    },
  }
}

export default defineConfig({
  publicDir: false,
  plugins: [privateValidateCopy()],
  build: {
    outDir: 'dist-world',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    reportCompressedSize: false,
    lib: {
      entry: { 'world-viewer': ENGINE_INDEX, 'world-validate': VALIDATE },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
  },
})

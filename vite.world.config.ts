// Standalone Lumopolis bundles (npm run build:world-viewer), for termpolis.com and anything else
// that embeds the world view outside the Electron app. Each file is built in its OWN vite pass, so
// Rollup can never share a chunk between two of them, whatever module they come to have in common:
//   (default mode)  dist-world/world-viewer.js   ESM, Three.js inlined: createWorldViewer, hasWebGL,
//                                                the cards, renderFallback and validateWorld. One
//                                                self-contained file. The only pass that empties
//                                                dist-world, so it must run first.
//   --mode validate dist-world/world-validate.js ESM, validateWorld only, no Three.js, importable
//                                                from Node (the website's validator script).
//   --mode export   dist-world/world-export.js   one classic IIFE, the runtime an exported world page
//                                                inlines (src/world-export/boot.ts): engine,
//                                                Three.js, controls, Ask and onnxruntime-web's wasm
//                                                glue.
// The validate and export passes never empty dist-world. scripts/checkWorldExportBundle.cjs checks
// the export file can sit inside an inline <script>; scripts/checkWorldStandalone.cjs checks that
// dist-world holds exactly those three .js files and that the two ESM files have no import.
import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'

const VALIDATE = resolve(__dirname, 'src/shared/world/validate.ts')
const ENGINE_INDEX = resolve(__dirname, 'src/renderer/src/world/engine/index.ts')
const EXPORT_ENTRY = resolve(__dirname, 'src/world-export/boot.ts')

// onnxruntime-web's wasm bundle (ort.wasm.bundle.min.mjs, what 'onnxruntime-web/wasm' resolves to) keeps one
// non-literal dynamic import: the loader that fetches the wasm glue module from a URL when the glue is not
// embedded. Rollup cannot inline an import of a runtime string, so it would survive into the IIFE as `import(n)`,
// which a classic inline script under the page's CSP can never use. The page never reaches it: with
// env.wasm.wasmBinary set, numThreads 1 and import.meta.url defined as "" (below), ORT picks the glue embedded
// in the same bundle. The loader is replaced by a throw, so the bundle holds no import( at all and the check
// script can keep refusing one. The exact text must be found: an ORT upgrade that changes it fails the build
// here rather than shipping a page that tries to load a module.
const ORT_WASM_BUNDLE = /onnxruntime-web[\\/]dist[\\/]ort\.wasm\.bundle\.min\.mjs$/
const ORT_GLUE_IMPORT = 'await import(/*webpackIgnore:true*/ /*@vite-ignore*/n)'
const ORT_GLUE_THROW = 'await (()=>{throw new Error("The exported page has no module loader")})()'
export function ortNoDynamicImport(): Plugin {
  return {
    name: 'termpolis:world-export-ort-no-dynamic-import',
    transform(code, id) {
      if (!ORT_WASM_BUNDLE.test(id.replace(/\?.*$/, ''))) return null
      if (code.split(ORT_GLUE_IMPORT).length !== 2) {
        throw new Error(`world-export: expected exactly one "${ORT_GLUE_IMPORT}" in ${id}; onnxruntime-web changed, update ortNoDynamicImport`)
      }
      return { code: code.replace(ORT_GLUE_IMPORT, ORT_GLUE_THROW), map: null }
    },
  }
}

// The exported page's runtime: one classic script, so nothing may be split off or loaded later.
const exportPass = defineConfig({
  publicDir: false,
  plugins: [ortNoDynamicImport()],
  // A classic script has no import.meta. ORT reads import.meta.url to find its files; an empty URL keeps
  // it on the bytes the page hands it (env.wasm.wasmBinary) and stops the wasm being emitted as an asset.
  define: { 'import.meta.url': '""' },
  build: {
    outDir: 'dist-world',
    emptyOutDir: false,
    target: 'es2020',
    sourcemap: false,
    reportCompressedSize: false,
    lib: {
      entry: EXPORT_ENTRY,
      formats: ['iife'],
      name: 'TermpolisWorldExport',
      fileName: () => 'world-export.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

// One ESM single-entry pass. A lone entry cannot be split into chunks.
function esmPass(entry: string, file: string, emptyOutDir: boolean) {
  return defineConfig({
    publicDir: false,
    build: {
      outDir: 'dist-world',
      emptyOutDir,
      target: 'es2020',
      sourcemap: false,
      reportCompressedSize: false,
      lib: { entry, formats: ['es'], fileName: () => file },
    },
  })
}

const viewerPass = esmPass(ENGINE_INDEX, 'world-viewer.js', true)
const validatePass = esmPass(VALIDATE, 'world-validate.js', false)

export default defineConfig(({ mode }) => (mode === 'export' ? exportPass : mode === 'validate' ? validatePass : viewerPass))

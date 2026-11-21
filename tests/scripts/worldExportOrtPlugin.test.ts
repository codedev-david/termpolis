// @vitest-environment node
// vite.world.config.ts ortNoDynamicImport: the export pass replaces onnxruntime-web's one dead `import(n)` (its
// glue loader) with a throw, so the classic inline script holds no import(. It touches only ORT's wasm bundle and
// fails the build when the text is not there exactly once (an ORT upgrade changed it).
import { describe, expect, it } from 'vitest'
import { ortNoDynamicImport } from '../../vite.world.config'

const ORT_ID = '/repo/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'
const IMPORT = 'await import(/*webpackIgnore:true*/ /*@vite-ignore*/n)'
type Transform = (code: string, id: string) => { code: string; map: null } | null
const transform = ortNoDynamicImport().transform as unknown as Transform

describe('ortNoDynamicImport', () => {
  it('leaves every other module alone, even one holding the same text', () => {
    expect(transform(`x=${IMPORT}`, '/repo/src/world-export/boot.ts')).toBeNull()
    expect(transform(`x=${IMPORT}`, '/repo/node_modules/onnxruntime-web/dist/ort.bundle.min.mjs')).toBeNull()
  })

  it.each([ORT_ID, `${ORT_ID}?v=1`, 'C:\\repo\\node_modules\\onnxruntime-web\\dist\\ort.wasm.bundle.min.mjs'])('replaces the one import in %s with a throw', (id) => {
    const out = transform(`a();const m=${IMPORT};b()`, id)
    expect(out).toEqual({ code: 'a();const m=await (()=>{throw new Error("The exported page has no module loader")})();b()', map: null })
    expect(out!.code).not.toContain('import(')
  })

  it.each([['no', ''], ['two', `${IMPORT};${IMPORT}`]])('fails the build when ORT holds %s copies of the import', (_, code) => {
    expect(() => transform(code, ORT_ID)).toThrow(/expected exactly one .* onnxruntime-web changed, update ortNoDynamicImport/)
  })
})

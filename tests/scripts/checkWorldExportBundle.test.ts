// scripts/checkWorldExportBundle.cjs: the exported page's runtime must be one classic inline script, so it may
// not hold "</script" (any case), "import(" or "import.meta", must stay under its size bound, and no .wasm may sit
// beside it.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- untyped CJS script
import { checkBundle, main, MAX_BYTES } from '../../scripts/checkWorldExportBundle.cjs'

const dirs: string[] = []
function dist(text: string | null, extra: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-export-check-'))
  dirs.push(dir)
  if (text !== null) fs.writeFileSync(path.join(dir, 'world-export.js'), text)
  for (const name of extra) fs.writeFileSync(path.join(dir, name), 'x')
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('checkBundle', () => {
  it('passes clean text', () => {
    expect(checkBundle(dist('(function(){var a="<\\/script>";console.log(a)})();'))).toEqual([])
  })

  it.each([
    ['</SCRIPT', 'x="</SCRIPT>"', '</script'],
    ['</script', 'x="</script>"', '</script'],
    ['import(', 'await import(n)', 'import('],
    ['import.meta', 'var u=import.meta.url', 'import.meta'],
  ])('fails on %s', (_, text, word) => {
    const problems = checkBundle(dist(text))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(`"${word}"`)
  })

  it('fails when the script is over its size bound', () => {
    expect(checkBundle(dist('x'.repeat(11)), 10)).toEqual(['world-export.js is 11 bytes, over the 10-byte bound'])
    expect(checkBundle(dist('x'.repeat(10)), 10)).toEqual([])
    expect(MAX_BYTES).toBeGreaterThan(100_000)
  })

  it('fails when a .wasm file sits beside the script', () => {
    const problems = checkBundle(dist('ok', ['ort-wasm-simd-threaded.wasm', 'world-viewer.js']))
    expect(problems).toEqual(['ort-wasm-simd-threaded.wasm was emitted beside the script: the page carries the wasm itself'])
  })

  it('fails when the script is missing', () => {
    expect(checkBundle(dist(null))[0]).toContain('world-export.js is missing')
  })
})

describe('main', () => {
  it('returns 0 and says the script is fine', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(main(dist('ok'))).toBe(0)
    expect(log.mock.calls[0][0]).toContain('is fine')
  })

  it('returns 1 and prints each problem', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(main(dist('import.meta; import(x)'))).toBe(1)
    expect(err).toHaveBeenCalledTimes(2)
  })
})

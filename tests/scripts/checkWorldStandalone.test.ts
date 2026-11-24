// scripts/checkWorldStandalone.cjs: dist-world may hold only the three bundles, and the two ESM ones may not import.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- untyped CJS script
import { checkStandalone, main } from '../../scripts/checkWorldStandalone.cjs'

const dirs: string[] = []
function dist(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-standalone-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  return dir
}
const OK = { 'world-viewer.js': 'const a=1;export{a as createWorldViewer};', 'world-validate.js': 'export{a as validateWorld};', 'world-export.js': '(function(){})();' }

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('checkStandalone', () => {
  it('passes the three bundles', () => expect(checkStandalone(dist(OK))).toEqual([]))
  it('fails on a stray chunk, at any depth', () => {
    expect(checkStandalone(dist({ ...OK, 'safeColor-abc.js': 'x' }))).toHaveLength(1)
    expect(checkStandalone(dist({ ...OK, 'assets/x.js': 'x' }))).toHaveLength(1)
  })
  it.each([
    'import { s } from "./safeColor-DxMXfLIl.js";const a=1;',
    'import"./x.js";const a=1;',
    'const a=1;\nimport x from"./x.js";',
    'export { s } from "./x.js";',
    'const a=await import("./x.js");',
  ])('fails on an import in the viewer: %s', (text) => {
    const problems = checkStandalone(dist({ ...OK, 'world-viewer.js': text }))
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]).toContain('world-viewer.js')
  })
  it('fails on an import in the validator and on a missing file', () => {
    expect(checkStandalone(dist({ ...OK, 'world-validate.js': 'import{a}from"./c.js";' }))[0]).toContain('world-validate.js')
    expect(checkStandalone(dist({ 'world-export.js': 'x' }))).toEqual(['world-viewer.js is missing', 'world-validate.js is missing'])
  })
  it('fails on a missing directory', () => expect(checkStandalone(path.join(os.tmpdir(), 'no-such-world-dir'))).toHaveLength(1))
})

describe('main', () => {
  it('returns 0 and 1', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(main(dist(OK))).toBe(0)
    expect(main(dist({ ...OK, 'c.js': 'x' }))).toBe(1)
  })
})

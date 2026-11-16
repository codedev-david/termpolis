import { describe, expect, it } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import { relativeImports, withImports } from '../../src/main/world/imports'

const snap = (fileImports: Record<string, string[]>): GraphSnapshot => ({
  root: '/r',
  files: Object.keys(fileImports),
  symbols: [],
  callEdges: [],
  fileImports
})

describe('relativeImports', () => {
  it('reads static, side-effect, re-export, dynamic and require specifiers in order', () => {
    const text = [
      "import { a } from './a'",
      "import './side.css'",
      "export * from '../up/b'",
      "const c = await import('./c')",
      'const d = require( "./d" )',
      'import e from `./e`',
      "import { a as again } from './a'",
      "import x from 'pkg'",
      "import y from '@scope/y'"
    ].join('\n')
    expect(relativeImports('src/x.ts', text)).toEqual(['./a', './side.css', '../up/b', './c', './d', './e'])
  })

  it('reads a bare dot specifier', () => {
    expect(relativeImports('src/x.mjs', "import all from '.'\nimport up from '..'")).toEqual(['.', '..'])
  })

  it('ignores imports inside comments', () => {
    const text = "// import a from './a'\n/* require('./b') */\nimport c from './c'"
    expect(relativeImports('src/x.tsx', text)).toEqual(['./c'])
  })

  it('scans only JavaScript and TypeScript files', () => {
    expect(relativeImports('src/x.py', "from './a' import b")).toEqual([])
    expect(relativeImports('src/x.cts', "import a = require('./a')")).toEqual(['./a'])
  })
})

describe('withImports', () => {
  it('returns the snapshot itself when nothing was found', () => {
    const s = snap({ 'a.ts': [] })
    expect(withImports(s, new Map())).toBe(s)
  })

  it('appends new specifiers after the graph’s own, without duplicates, and leaves the input alone', () => {
    const s = snap({ 'a.ts': ['./b'], 'c.ts': ['./d'] })
    const out = withImports(s, new Map([['a.ts', ['./b', './e']], ['new.ts', ['./a']]]))
    expect(out.fileImports).toEqual({ 'a.ts': ['./b', './e'], 'c.ts': ['./d'], 'new.ts': ['./a'] })
    expect(s.fileImports).toEqual({ 'a.ts': ['./b'], 'c.ts': ['./d'] })
    expect(out.files).toBe(s.files)
  })

  it('does not read inherited keys as a file’s imports', () => {
    const out = withImports(snap({}), new Map([['constructor', ['./x']]]))
    expect(out.fileImports.constructor).toEqual(['./x'])
  })
})

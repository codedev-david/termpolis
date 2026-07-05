import { describe, it, expect } from 'vitest'
import { extractFile, languageForFile, type CodeSymbol } from '../../src/main/codeGraphExtract'

const names = (syms: CodeSymbol[]) => syms.map((s) => s.name)
const byName = (syms: CodeSymbol[], n: string) => syms.find((s) => s.name === n)

describe('codeGraphExtract', () => {
  describe('languageForFile', () => {
    it('maps known extensions to a language', () => {
      expect(languageForFile('a/b/x.ts')).toBe('ts')
      expect(languageForFile('x.tsx')).toBe('ts')
      expect(languageForFile('x.py')).toBe('python')
      expect(languageForFile('x.go')).toBe('go')
      expect(languageForFile('x.rs')).toBe('rust')
      expect(languageForFile('Main.java')).toBe('java')
    })
    it('returns null for unknown extensions', () => {
      expect(languageForFile('x.md')).toBeNull()
      expect(languageForFile('x.png')).toBeNull()
      expect(languageForFile('noext')).toBeNull()
    })
  })

  describe('extractFile — guards', () => {
    it('returns null for an unsupported extension', () => {
      expect(extractFile('readme.md', '# hi')).toBeNull()
    })
    it('returns null for empty content', () => {
      expect(extractFile('x.ts', '')).toBeNull()
    })
  })

  describe('TypeScript / JavaScript', () => {
    const src = [
      "import { helper } from './util'",
      "import fs from 'fs'",
      "const dyn = require('path')",
      '',
      'export function alpha(x: number): number {',
      '  return beta(x) + helper(x)',
      '}',
      '',
      'export const bravo = (n: number) => alpha(n) * 2',
      '',
      'export class Widget {',
      '  render() { return alpha(1) }',
      '}',
      '',
      'export interface Shape { kind: string }',
      'export type Id = string',
      'export enum Color { Red, Green }',
      'function beta(x: number) { return x + 1 }',
    ].join('\n')

    const ex = extractFile('src/thing.ts', src)!

    it('extracts top-level symbols with kinds', () => {
      expect(ex).not.toBeNull()
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['alpha', 'bravo', 'Widget', 'Shape', 'Id', 'Color', 'beta']))
      expect(byName(ex.symbols, 'alpha')!.kind).toBe('function')
      expect(byName(ex.symbols, 'bravo')!.kind).toBe('const')
      expect(byName(ex.symbols, 'Widget')!.kind).toBe('class')
      expect(byName(ex.symbols, 'Shape')!.kind).toBe('interface')
      expect(byName(ex.symbols, 'Id')!.kind).toBe('type')
      expect(byName(ex.symbols, 'Color')!.kind).toBe('enum')
    })

    it('records accurate start lines and brace-matched end lines', () => {
      const alpha = byName(ex.symbols, 'alpha')!
      expect(alpha.startLine).toBe(5)
      expect(alpha.endLine).toBe(7) // matching closing brace
    })

    it('collects de-duplicated import specifiers (import / require / dynamic)', () => {
      expect(ex.imports).toEqual(expect.arrayContaining(['./util', 'fs', 'path']))
    })

    it('collects references (callable names) and drops control-flow keywords', () => {
      expect(ex.references).toEqual(expect.arrayContaining(['beta', 'helper', 'alpha']))
      expect(ex.references).not.toContain('if')
      expect(ex.references).not.toContain('return')
      expect(ex.references).not.toContain('function')
    })

    it('handles a dynamic import() specifier', () => {
      const ex2 = extractFile('m.ts', "const x = import('./lazy')")!
      expect(ex2.imports).toContain('./lazy')
    })
  })

  describe('Python', () => {
    const src = ['from os import path', 'import sys', '', 'def outer():', '    return inner()', '', 'class Thing:', '    pass', '', 'def inner():', '    return 1'].join('\n')
    const ex = extractFile('m.py', src)!

    it('extracts def + class with indent-based end lines', () => {
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['outer', 'Thing', 'inner']))
      const outer = byName(ex.symbols, 'outer')!
      expect(outer.kind).toBe('function')
      expect(outer.startLine).toBe(4)
      expect(outer.endLine).toBe(5) // last indented line before the dedent
    })
    it('collects from/import specifiers and references', () => {
      expect(ex.imports).toEqual(expect.arrayContaining(['os', 'sys']))
      expect(ex.references).toContain('inner')
    })
  })

  describe('Go / Rust / Java', () => {
    it('extracts Go func + struct', () => {
      const ex = extractFile('m.go', 'func Handle(w http.ResponseWriter) {\n  parse()\n}\ntype User struct {\n  Name string\n}')!
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['Handle', 'User']))
      expect(byName(ex.symbols, 'User')!.kind).toBe('struct')
    })
    it('extracts Rust fn + struct + trait + enum', () => {
      const ex = extractFile('m.rs', 'pub fn run() {}\nstruct Cfg {}\ntrait Draw {}\nenum State {}')!
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['run', 'Cfg', 'Draw', 'State']))
      expect(byName(ex.symbols, 'Draw')!.kind).toBe('trait')
    })
    it('extracts Java class/interface + import', () => {
      const ex = extractFile('M.java', 'import java.util.List;\npublic class M {\n}\ninterface I {}')!
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['M', 'I']))
      expect(ex.imports).toContain('java.util.List')
    })
  })

  describe('robustness', () => {
    it('an unterminated brace block ends at EOF, not a crash', () => {
      const ex = extractFile('m.ts', 'function open() {\n  return 1\n')!
      expect(byName(ex.symbols, 'open')!.endLine).toBe(3)
    })
    it('a Python block that runs to EOF ends at the last line', () => {
      const ex = extractFile('m.py', 'def only():\n    return 1\n    x = 2')!
      expect(byName(ex.symbols, 'only')!.endLine).toBe(3)
    })

    it('inline object types in param/return annotations do NOT truncate the block (real-repo bug)', () => {
      // Before the fix, the return-type `{ ok: boolean }` closed the block on line 1, so the symbol
      // spanned only its signature — and since the store attributes calls by scanning a symbol's
      // start→end body slice, every reference below the signature was lost (under-counted edges).
      const src = 'export function f(o: { a: number }): { ok: boolean } {\n  return doThing(o)\n}'
      const f = byName(extractFile('x.ts', src)!.symbols, 'f')!
      expect(f.startLine).toBe(1)
      expect(f.endLine).toBe(3) // was 1 before the fix
    })

    it('a MULTI-LINE signature with an inline object param type is not truncated', () => {
      const src = ['export async function g(', '  items: string[],', '  opts: { flag?: boolean } = {},', '): Promise<number> {', '  return compute(items)', '}'].join('\n')
      const g = byName(extractFile('x.ts', src)!.symbols, 'g')!
      expect(g.startLine).toBe(1)
      expect(g.endLine).toBe(6) // param-type `{}` on a continuation line no longer ends the block
    })
  })
})

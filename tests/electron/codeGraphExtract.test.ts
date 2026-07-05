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

  describe('class methods (limitation fix)', () => {
    it('extracts TS/JS class methods, not just top-level symbols', () => {
      const src = 'export class Svc {\n  async load(): Promise<void> { fetchIt() }\n  private compute(x: number) { return x }\n  get size() { return 1 }\n}'
      const ex = extractFile('svc.ts', src)!
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['Svc', 'load', 'compute', 'size']))
      expect(byName(ex.symbols, 'load')!.kind).toBe('method')
    })
    it('does NOT capture control-flow blocks as methods', () => {
      const ex = extractFile('a.ts', 'function f() {\n  if (x) { go() }\n  for (const y of z) { hop() }\n  while (a) { spin() }\n}')!
      const n = names(ex.symbols)
      expect(n).toContain('f')
      expect(n).not.toContain('if')
      expect(n).not.toContain('for')
      expect(n).not.toContain('while')
    })
  })

  describe('deep languages — C# / Ruby / Swift (symbols + methods + refs)', () => {
    it('C# — types, methods, using, references', () => {
      const src = 'using System.Threading.Tasks;\npublic class Service {\n  public async Task<int> GetAsync(int id) { return Fetch(id); }\n  private int Fetch(int id) { return id; }\n}\npublic interface IRepo {}\npublic record Person(string Name);\nenum Color { Red }'
      const ex = extractFile('Service.cs', src)!
      expect(languageForFile('Service.cs')).toBe('csharp')
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['Service', 'GetAsync', 'Fetch', 'IRepo', 'Person', 'Color']))
      expect(byName(ex.symbols, 'GetAsync')!.kind).toBe('method')
      expect(byName(ex.symbols, 'IRepo')!.kind).toBe('interface')
      expect(ex.imports).toContain('System.Threading.Tasks')
      expect(ex.references).toContain('Fetch')
    })
    it('Ruby — def/class/module, require, references, indent blocks', () => {
      const src = "require 'json'\nclass Parser\n  def parse(input)\n    validate(input)\n  end\n  def valid?\n    true\n  end\nend\nmodule Util\nend"
      const ex = extractFile('parser.rb', src)!
      expect(languageForFile('parser.rb')).toBe('ruby')
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['Parser', 'parse', 'valid?', 'Util']))
      expect(byName(ex.symbols, 'Util')!.kind).toBe('module')
      expect(byName(ex.symbols, 'parse')!.kind).toBe('function')
      expect(ex.imports).toContain('json')
      expect(ex.references).toContain('validate')
    })
    it('Swift — func (incl. methods), class/struct/enum/protocol, import, references', () => {
      const src = 'import Foundation\nclass Downloader {\n  func start() { fetch() }\n  private func fetch() {}\n}\nstruct Point {}\nenum State { case idle }\nprotocol Drawable {}'
      const ex = extractFile('dl.swift', src)!
      expect(languageForFile('dl.swift')).toBe('swift')
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['Downloader', 'start', 'fetch', 'Point', 'State', 'Drawable']))
      expect(byName(ex.symbols, 'Drawable')!.kind).toBe('interface') // protocol → interface
      expect(byName(ex.symbols, 'start')!.kind).toBe('function') // func covers methods
      expect(ex.imports).toContain('Foundation')
      expect(ex.references).toContain('fetch')
    })
  })

  describe('surface IaC — Terraform / Bicep (symbol discovery)', () => {
    it('Terraform — resource/variable/output/module symbols', () => {
      const src = 'variable "region" {\n  default = "us-east-1"\n}\nresource "aws_instance" "web" {\n  ami = var.ami\n}\noutput "ip" {\n  value = aws_instance.web.private_ip\n}\nmodule "vpc" {\n  source = "./vpc"\n}'
      const ex = extractFile('main.tf', src)!
      expect(languageForFile('main.tf')).toBe('terraform')
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['region', 'web', 'ip', 'vpc']))
      expect(byName(ex.symbols, 'web')!.kind).toBe('resource')
      expect(byName(ex.symbols, 'vpc')!.kind).toBe('module')
    })
    it('Bicep — resource/param/var/output/module symbols', () => {
      const src = "param location string = 'eastus'\nvar appName = 'app'\nresource site 'Microsoft.Web/sites@2021-01-01' = {\n  name: appName\n}\noutput endpoint string = site.properties.defaultHostName\nmodule vpc './vpc.bicep' = {\n  name: 'vpc'\n}"
      const ex = extractFile('main.bicep', src)!
      expect(languageForFile('main.bicep')).toBe('bicep')
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['location', 'appName', 'site', 'endpoint', 'vpc']))
      expect(byName(ex.symbols, 'site')!.kind).toBe('resource')
      expect(byName(ex.symbols, 'vpc')!.kind).toBe('module')
    })
  })
})

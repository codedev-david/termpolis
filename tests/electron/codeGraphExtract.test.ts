import { describe, it, expect } from 'vitest'
import { extractFile, languageForFile, type CodeSymbol } from '../../src/main/codeGraphExtract'
import { fill, linear, TIMED } from './_linearTime'

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
    it('maps Kotlin and extracts its classes, objects, interfaces, functions and imports', () => {
      expect(languageForFile('app/Main.kt')).toBe('kotlin')
      const src = [
        'package com.acme.app',
        'import com.acme.store.Repo',
        'data class User(val name: String)',
        'sealed class State',
        'object Registry {',
        '  companion object Factory {}',
        '  @JvmStatic fun create(): Registry = this',
        '}',
        'fun interface Handler { fun handle() }',
        'interface Store {',
        '  suspend fun load(id: String): User',
        '}',
        'fun <T> List<T>.second(): T = this[1]',
        'private fun helper(x: Int) {',
        '  helper(x)',
        '}'
      ].join('\n')
      const ex = extractFile('Main.kt', src)!
      expect(ex.lang).toBe('kotlin')
      expect(names(ex.symbols)).toEqual(expect.arrayContaining(['User', 'State', 'Registry', 'Factory', 'create', 'Handler', 'Store', 'load', 'second', 'helper']))
      expect(byName(ex.symbols, 'Store')!.kind).toBe('interface')
      expect(byName(ex.symbols, 'Registry')!.kind).toBe('class')
      expect(byName(ex.symbols, 'second')!.kind).toBe('function')
      expect(ex.imports).toEqual(['com.acme.store.Repo'])
    })
  })

  describe('robustness', TIMED, () => {
    it('an unterminated brace block ends at EOF, not a crash', () => {
      const ex = extractFile('m.ts', 'function open() {\n  return 1\n')!
      expect(byName(ex.symbols, 'open')!.endLine).toBe(3)
    })
    it('a Python block that runs to EOF ends at the last line', () => {
      const ex = extractFile('m.py', 'def only():\n    return 1\n    x = 2')!
      expect(byName(ex.symbols, 'only')!.endLine).toBe(3)
    })

    it('reads each symbol its line from the line index, first line, last line and CRLF alike', () => {
      const ex = extractFile('m.ts', 'function a() {}\r\n\r\nfunction b() {}\r\n\nfunction c() {}')!
      expect(ex.symbols.map((s) => [s.name, s.startLine])).toEqual([['a', 1], ['b', 3], ['c', 5]])
    })

    describe('extracts a large or hostile Kotlin file in time linear in its size', () => {
      // Reading 8 times the text takes under 24 times as long (see _linearTime); each took seconds before at these sizes.
      // One test per input, so each stays well inside the test timeout on a loaded runner with coverage on.
      const N = 64 * 1024
      const big = (size: number): string => {
        const lines: string[] = ['package a']
        let length = 0
        for (let n = 0; length < size; n++) {
          const add = [`data class User${n}(val name: String)`, `fun helper${n}(x: Int): Int = x`, `class Service${n} {`, '  @JvmStatic fun op(id: String): Int {', '    return 1', '  }', '}']
          lines.push(...add)
          length += add.join('\n').length + 1
        }
        return lines.join('\n')
      }
      const symbols = (file: string) => (src: string): CodeSymbol[] => extractFile(file, src)!.symbols
      const none = (syms: CodeSymbol[]): void => expect(syms).toEqual([])
      it.each<[string, (n: number) => string, (syms: CodeSymbol[], src: string) => void]>([
        ['Big.kt', big, (syms, src) => expect(syms.length).toBeGreaterThan(src.length / 100)],
        ['Blank.kt', (n) => '\n'.repeat(n) + 'class A', (syms, src) => expect(byName(syms, 'A')!.startLine).toBe(src.length - 6)],
        ['Ann.kt', (n) => fill('@a\n', n), none],
        ['AnnLine.kt', (n) => fill('@a ', n), none],
        ['AnnArgs.kt', (n) => fill('@a(b) ', n) + '\n', none],
        ['AnnUse.kt', (n) => fill('@get:a ', n), none],
        ['AnnUseLines.kt', (n) => fill('@field:a\n', n), none],
        ['Mods.kt', (n) => fill('public\n', n), none],
        ['Long.kt', (n) => 'fun ' + 'a'.repeat(n), none]
      ])('%s', (file, make, check) => linear(make, symbols(file), N, file, check))
      it('joins an annotation above a declaration, but no longer a modifier', () => {
        expect(names(extractFile('Split.kt', 'public\nclass A\n@Inject\nfun b() {}')!.symbols)).toEqual(['A', 'b'])
      })
      it('finds a function after nine or more annotations on its line or above it (WP7 #89 N5)', () => {
        const nine = Array.from({ length: 9 }, (_, i) => `@A${i}`)
        const same = extractFile('Same.kt', nine.join(' ') + ' fun f() {\n}')!.symbols
        expect(same.map((s) => [s.name, s.startLine, s.endLine])).toEqual([['f', 1, 2]])
        const mixed = extractFile('Mixed.kt', '@A\n@B(x = 1) ' + nine.join(' ') + ' private fun g() {}')!.symbols
        expect(mixed.map((s) => [s.name, s.startLine])).toEqual([['g', 1]])
        expect(names(extractFile('Above.kt', nine.join('\n') + '\nfun h() {}')!.symbols)).toEqual(['h'])
      })
      it('finds a function after use-site annotations (`@get:`, `@field:`), as the world reads them (minors review m7)', () => {
        expect(names(extractFile('Use.kt', '@get:JvmName("x") fun h() {}\n@field:Inject @param:Named("p") fun i() {}')!.symbols)).toEqual(['h', 'i'])
        expect(names(extractFile('Use.kt', '@file:JvmName("U")\n  @set:JvmStatic internal fun j() {}')!.symbols)).toEqual(['j'])
      })
    })

    it('finds the same call names as a name-then-paren regex, a long word run included', () => {
      const ex = extractFile('m.ts', 'function f() {\n  a1 (x); 9b(y); $c\n(z); if (q) {}; obj.d(); 1e2(); 42(w); f()\n}')!
      expect(ex.references).toEqual(['f', 'a1', 'b', '$c', 'd', 'e2'])
      // A word run with a `(` at its end: reading 8 times the run takes under 24 times as long (see _linearTime).
      linear((n) => 'x'.repeat(n) + '(', (src) => extractFile('m.ts', src)!.references, 64 * 1024, 'word run', (refs, src) => expect(refs).toEqual([src.slice(0, -1)]))
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

  // Every rule reads a file in time linear in its size. Each pin below is what the rule found before it was rewritten,
  // so a rewrite that drifts on ordinary code shows here; each timing input took seconds (or never finished) before.
  describe('linear-time rules', TIMED, () => {
    const J = (...l: string[]): string => l.join('\n')
    const show = (file: string, src: string): { s: (string | number)[][]; i: string[] } => {
      const ex = extractFile(file, src)!
      return { s: ex.symbols.map((x) => [x.name, x.kind, x.startLine, x.endLine]), i: ex.imports }
    }
    // Each hostile input is read at n and at 8n characters, and the larger must take under 24 times as long: a rule
    // that is quadratic in the input takes about 64 (see _linearTime). Every rule these tests guard took seconds at
    // 50k characters before its fix, so its quadratic part is far past the timer's noise at n.
    const N = 64 * 1024
    type Make = (n: number) => string
    // What is timed, and what is then asserted on its result once, outside the timed runs.
    interface Probe<R> { read: (src: string) => R; check?: (result: R, src: string) => void }
    const unit = (u: string): Make => (n) => fill(u, n)
    const grows = <R>(make: Make, probe: Probe<R>, label = ''): void => linear(make, probe.read, N, label, probe.check)
    // A labelled input, so a test per input can name it; a unit's label is the unit as JSON.
    type Case = [string, Make]
    const named = (...units: string[]): Case[] => units.map((u) => [JSON.stringify(u), unit(u)])
    // What a large or odd file can hold with no declaration in it: runs of blank lines, spaces, CRLF and tabs.
    const empty = named(' ', '\n', '\r\n', '\n ', '\t')
    // The checks below that time several inputs run one test per input (`it.each` over Cases), so that each test
    // stays well inside the test timeout on a loaded runner with coverage on, re-measuring included.
    const none = (found: unknown[]): void => expect(found).toEqual([])
    const noSymbols = (file: string): Probe<CodeSymbol[]> => ({ read: (src) => extractFile(file, src)!.symbols, check: none })
    const noImports = (file: string): Probe<string[]> => ({ read: (src) => extractFile(file, src)!.imports, check: none })
    const extract = (file: string): Probe<unknown> => ({ read: (src) => extractFile(file, src) })

    it('Java: modifiers in any order, generic returns, annotations, multi-line parameters, constructors', () => {
      const src = J(
        'package a;',
        'import java.util.List;',
        'import static java.lang.Math.max;',
        '@Service',
        'public final class Repo<T extends Base> implements Store {',
        '  @Override',
        '  public static synchronized <K, V> Map<K, V> index(List<K> keys, Function<K, V> f) throws IOException {',
        '    return null;',
        '  }',
        '  final protected static String name(',
        '      int a,',
        '      String b) {',
        '    return "";',
        '  }',
        '  abstract void hook();',
        '  Repo() {',
        '  }',
        '  private List<String>[] grid(int n) { return null; }',
        '  if (x) {',
        '  }',
        '}',
        'interface Store {}',
        'enum Mode { A }'
      )
      expect(show('Repo.java', src)).toEqual({
        s: [['Repo', 'class', 5, 21], ['name', 'method', 10, 14], ['hook', 'method', 15, 17], ['grid', 'method', 18, 20], ['Store', 'interface', 22, 22], ['Mode', 'enum', 23, 23]],
        i: ['java.util.List', 'java.lang.Math.max']
      })
    })

    // 30k `public` or `static ` lines and a long where run.
    const modifierRuns: Case[] = [...empty, ...named('public\n', 'static \n', '  a b(x)\n'), ['" a b(" then ") where "', (n) => ' a b(' + fill(') where ', n)]]
    it.each(modifierRuns)('Java: %s reads as no symbol, in time linear in its size', (label, make) => grows(make, noSymbols('A.java'), label))

    it('Java: a 5000-method interface is one symbol, in time linear in its size', () => {
      const big = (n: number): string => 'public interface Big {\n' + fill('  void method(int x, String y);\n', n) + '}\n'
      // A method with no body is no symbol.
      grows(big, { read: (src) => names(extractFile('Big.java', src)!.symbols), check: (found) => expect(found).toEqual(['Big']) })
    })

    it('Java: a declaration after a blank run is found on its own line, in time linear in the run', () => {
      grows((n) => '\n'.repeat(n) + 'public class B {}', { read: (src) => show('B.java', src).s, check: (s, src) => expect(s).toEqual([['B', 'class', src.length - 16, src.length - 16]]) })
    })

    it('C#: records, constructors with `: base(a)`, where clauses, a brace on the next line', () => {
      const src = J(
        'using System;',
        'using static System.Math;',
        'namespace Acme {',
        '  public sealed record Person(string Name);',
        '  public record class Point(int X, int Y);',
        '  public readonly record struct Money(decimal Amount);',
        '  public partial class Repo<T> : Base where T : class {',
        '    public Repo(int a) : base(a) {',
        '    }',
        '    public async Task<List<T>> LoadAsync<TKey>(TKey id) where TKey : notnull {',
        '      return await Fetch(id);',
        '    }',
        '    static void Main(string[] args)',
        '    {',
        '    }',
        '    internal static async Task Run() { }',
        '  }',
        '  public interface IStore {}',
        '}'
      )
      expect(show('Repo.cs', src)).toEqual({
        s: [['Person', 'class', 4, 17], ['Point', 'class', 5, 17], ['Repo', 'class', 7, 17], ['Repo', 'method', 8, 9], ['Main', 'method', 13, 15], ['Run', 'method', 16, 16], ['IStore', 'interface', 18, 18]],
        i: ['System', 'System.Math']
      })
      const where = J('class W {', '  public T Get<T>(int id) where T : new() {', '    return default;', '  }', '  void Put(T x) where T : class, IDisposable', '  {', '  }', '}')
      expect(names(extractFile('W.cs', where)!.symbols)).toEqual(['W', 'Put'])
      // CRLF: `^` also matches after a `\r`, and a modifier run that crossed the line break put every declaration on
      // the line above (the namespace's `{`), so it ended where the namespace ended.
      const crlf = 'namespace A\r\n{\r\n    public interface IProbe\r\n    {\r\n        Task<bool> PingAsync();\r\n    }\r\n}\r\n'
      expect(show('P.cs', crlf).s).toEqual([['IProbe', 'interface', 3, 6]])
      // A primary-constructor class is one symbol, no longer also a method on the line above.
      expect(show('T.cs', 'class X {\n\n    public sealed class Tests(int a)\n        : Base(a)\n    {\n    }\n}').s).toEqual([['X', 'class', 1, 7], ['Tests', 'class', 3, 6]])
    })

    it('a byte-order mark before a declaration on line 1 hides nothing (C#, Java, Swift)', () => {
      const bom = '﻿'
      expect(show('A.cs', bom + 'public class A {}').s).toEqual([['A', 'class', 1, 1]])
      expect(show('A.cs', bom + 'public sealed record R(int A);\npublic interface IA {}').s).toEqual([['R', 'class', 1, 1], ['IA', 'interface', 2, 2]])
      expect(show('A.java', bom + 'public class A {\n  void m() {\n  }\n}').s).toEqual([['A', 'class', 1, 4], ['m', 'method', 2, 3]])
      expect(show('A.swift', bom + 'public class A {}\nfunc f() {}').s).toEqual([['A', 'class', 1, 1], ['f', 'function', 2, 2]])
      // A file that is only a mark reads as an empty one. TS classes and Python's first import, which never read past
      // a mark, are found too.
      expect(show('A.cs', bom)).toEqual({ s: [], i: [] })
      expect(show('a.ts', bom + 'class A {}\n').s).toEqual([['A', 'class', 1, 1]])
      expect(show('a.py', bom + 'from os import path\nimport sys\n').i).toEqual(['os', 'sys'])
    })

    it.each(modifierRuns)('C#: %s reads as no symbol, in time linear in its size', (label, make) => grows(make, noSymbols('A.cs'), label))

    it('Swift: attributes before func and class, on their own line or the same one', () => {
      const src = J(
        'import UIKit',
        '@objc @MainActor',
        'public final class View: UIView {',
        '  @IBAction',
        '  @objc(tap:) private func tap(_ s: Any) {',
        '  }',
        '  @discardableResult public static func make() -> View { View() }',
        '  override func layout() {',
        '  }',
        '}',
        'struct P {}',
        'protocol Q {}'
      )
      expect(show('View.swift', src)).toEqual({
        s: [['View', 'class', 3, 10], ['make', 'function', 7, 9], ['layout', 'function', 8, 9], ['P', 'struct', 11, 11], ['Q', 'interface', 12, 12]],
        i: ['UIKit']
      })
      expect(names(extractFile('A.swift', '@available(iOS 13, *)\n@MainActor\nfunc run() {}\n@objc func go() {}')!.symbols)).toEqual(['run', 'go'])
      // Nine or more attributes on the func's own line (WP7 #89 N5, as Kotlin).
      const nine = Array.from({ length: 9 }, (_, i) => `@a${i}`).join(' ')
      expect(show('N.swift', nine + ' public func many() {\n}').s).toEqual([['many', 'function', 1, 2]])
    })

    it.each([...empty, ...named('@a\n', '@a ', 'public\n', 'static \n')])('Swift: %s reads as no symbol, in time linear in its size', (label, make) => grows(make, noSymbols('A.swift'), label))

    it('JS imports: default, named, multi-line, side-effect, type-only, namespace, a list over 2000 characters', () => {
      const long = 'import {' + Array.from({ length: 400 }, (_, i) => ` name${i}`).join(',') + "\n} from './long'"
      expect(long.length).toBeGreaterThan(2000)
      const src = J(
        "import x from './x'",
        'import {a,b} from "./ab"',
        'import { c as d,',
        "  e } from './ce'",
        "import './side.css'",
        "import type { T } from './types'",
        "import * as ns from 'ns'",
        "import def, { f } from '@scope/pkg'",
        long,
        "const r = require('./r')"
      )
      expect(extractFile('imports.ts', src)!.imports).toEqual(['./x', './ab', './ce', './side.css', './types', 'ns', '@scope/pkg', './long', './r'])
    })

    const importRuns: Case[] = [...empty, ['"import" then spaces then "!"', (n) => 'import' + ' '.repeat(n) + '!'], ...named('import x\n'), ['"export" then spaces', (n) => 'export' + ' '.repeat(n)]]
    it.each(importRuns)('JS imports: %s reads as no import, in time linear in its size', (label, make) => grows(make, noImports('a.ts'), label))

    it('JS functions: plain, generator, async, default export, a name on the next line', () => {
      const src = J('function plain() {}', 'function* gen() {}', 'async function later() {}', 'export default function named() {}', 'export function', '  split() {}', 'functionX() {}')
      expect(show('f.ts', src).s.filter((x) => x[1] === 'function')).toEqual([
        ['plain', 'function', 1, 1], ['gen', 'function', 2, 2], ['later', 'function', 3, 3], ['named', 'function', 4, 4], ['split', 'function', 5, 5]
      ])
      grows((n) => 'function' + ' '.repeat(n), noSymbols('a.ts'))
      grows(unit('function\n'), extract('a.ts')) // each `function` names the next, as before
    })

    it('TS methods: return types, getters, generics, multi-line parameters, keywords and long or assigned types', () => {
      const src = J(
        'class A {',
        '  render() {',
        '  }',
        '  async load(): Promise<void> {',
        '  }',
        '  private get name(): string {',
        "    return ''",
        '  }',
        '  static create<T>(o: { a: T }): A {',
        '  }',
        '  m(',
        '    a: number,',
        '  ): Map<string, number> {',
        '  }',
        '  public static override build(): void {',
        '  }',
        '  if (x) {',
        '  }',
        '  f(): x = 1 {',
        '  long(): ' + 'T'.repeat(130) + ' {',
        '  }',
        '}'
      )
      expect(show('methods.ts', src).s).toEqual([['A', 'class', 1, 22], ['render', 'method', 2, 3], ['load', 'method', 4, 5], ['name', 'method', 6, 8], ['m', 'method', 11, 14], ['build', 'method', 15, 16]])
    })

    // Calls with no body, `public` lines, typed calls and blank runs.
    it.each([...empty, ...named('  a(x)\n', '  public\n', '  a(x): T\n', '  a(x)}\n')])('TS methods: %s reads as no symbol, in time linear in its size', (label, make) => grows(make, noSymbols('a.ts'), label))

    it('TS methods: thousands of blocks that never close are each found, and the scans for where they end stay linear', () => {
      // At half of N: every block here gives a symbol, so a read is slow, and at N this one test took up to 18 s of
      // its 30 on two loaded cores with coverage on. The parser before the fix still measures a ratio of 62 at this size.
      const read = (src: string) => extractFile('a.ts', src)!.symbols
      linear(unit('  a() {\n'), read, N / 2, '  a() {', (syms, src) => expect(syms.length).toBe(src.length / 8))
    })

    // Each head here has a `}` first, so its facts are read afresh; the `{` the clause needs was searched for again
    // from each one, to the end of the file.
    it.each([['a.ts', '  a(x)}\n'], ['A.cs', '  a b(x)}\n'], ['a.ts', '  a(x): T}\n'], ['A.cs', '  a b(x) where }\n']])(
      'method heads after a `}` with no `{` past it share the scan for the next `{`, up to 512 KB (%s %j)',
      (file, line) => grows(unit(line), noSymbols(file), line)
    )

    it('method heads sharing a `{` still end where they did', () => {
      // b's return type runs past its `}` to c's `{`, as before.
      expect(show('a.ts', 'class K {\n  a(x)}\n  b(x): T}\n  c(): T {\n  }\n}\n').s).toEqual([['K', 'class', 1, 2], ['b', 'method', 3, 5]])
    })

    it('const arrows: async, typed, untyped single parameter, multi-line parameters; values are not arrows', () => {
      const src = J(
        'const a = () => 1',
        'export const b = async (x: number) => x',
        'let c = x => x',
        'const d: Handler = async e => e',
        'const f = (',
        '  a,',
        '  b,',
        ') => a',
        'const g = 5',
        'const h: (a: number) => void = () => {}',
        'const async = async => 1'
      )
      expect(show('consts.ts', src).s).toEqual([['a', 'const', 1, 1], ['b', 'const', 2, 2], ['c', 'const', 3, 3], ['d', 'const', 4, 4], ['f', 'const', 5, 5], ['async', 'const', 11, 11]])
    })

    it.each(named('const a: x\n', 'const a = (\n', 'const a = async\n'))('const arrows: %s reads as no symbol, in time linear in its size', (label, make) => grows(make, noSymbols('a.ts'), label))

    it('Go: an import block reads quoted paths at the start of a line', () => {
      const src = J('package m', 'import (', '  "fmt"', '  alias "net/http"', '  _ "embed"', '\t"os"', ')', 'import "strings"', 'func Run() {', '}')
      expect(show('m.go', src)).toEqual({ s: [['Run', 'function', 9, 10]], i: ['fmt', 'os'] })
    })

    it.each(empty)('Go: %s reads as no import, in time linear in its size', (label, make) => grows(make, noImports('m.go'), label))

    it('Go: a method receiver closes within four lines', () => {
      const src = J('package m', 'func Plain() {', '}', 'func (s *Server) Handle(w http.ResponseWriter) {', '}', 'func (Server)  Bare() {}', 'func\tTabbed() {}', 'func (s *S[T]) Gen() {}')
      expect(show('m.go', src).s).toEqual([['Plain', 'function', 2, 3], ['Handle', 'function', 4, 5], ['Bare', 'function', 6, 6], ['Tabbed', 'function', 7, 7], ['Gen', 'function', 8, 8]])
      // A receiver split over lines is read as before (from its `func` line), up to four lines; past that it names nothing.
      expect(show('m.go', 'func (\n\ts *Server,\n) Handle() {}\nfunc (a\nb) Far() {}').s).toEqual([['Handle', 'function', 1, 1], ['Far', 'function', 4, 4]])
      expect(show('m.go', 'func (\n\ta,\n\tb,\n) Four() {}\nfunc (\n\ta,\n\tb,\n\tc,\n) Five() {}').s).toEqual([['Four', 'function', 1, 1]])
      // A `func` with no name names nothing: the `func` on the next line is not its name but a head of its own.
      expect(show('m.go', 'func\nfunc Named() {}\nfunc\nfunc\n').s).toEqual([['Named', 'function', 2, 2]])
      expect(show('m.go', 'func (s *S)\nfunc M() {}\nfunc (s *S) funcy() {}').s).toEqual([['M', 'function', 2, 2], ['funcy', 'function', 3, 3]])
    })

    it.each(named('func (\n', 'func (a\n', 'func  (a b\n'))('Go: unclosed %s lines read as no symbol, in time linear in their number, up to 512 KB', (label, make) => grows(make, noSymbols('m.go'), label))

    it('Rust: `pub(...)` visibility closes on its line; an open `pub(` per line stays linear', () => {
      const src = J('pub(crate) fn a() {}', 'pub(super) async fn b() {}', 'pub fn c() {}', 'fn d() {}', 'pub(in crate::x) struct S;', 'pub(crate) trait T {}', 'use crate::x::y;')
      expect(show('m.rs', src)).toEqual({
        s: [['a', 'function', 1, 1], ['b', 'function', 2, 2], ['c', 'function', 3, 3], ['d', 'function', 4, 4], ['S', 'struct', 5, 5], ['T', 'trait', 6, 6]],
        i: ['crate::x::y']
      })
      grows(unit('pub(\n'), noSymbols('m.rs'))
    })

    it('block ends: a long file of one-line symbols reads each line about once, and ordinary nesting is unchanged', () => {
      // Each one-line const scans on for a later block; the scans share what they found.
      const many = 'const a = () => 1\n'.repeat(5000) + 'function last() {\n  x()\n}\n'
      const ex = extractFile('many.ts', many)!
      expect(ex.symbols).toHaveLength(5001)
      expect(ex.symbols[0].endLine).toBe(5003) // as before: an arrow with no braces runs to the next multi-line block
      expect(byName(ex.symbols, 'last')!.endLine).toBe(5003)
      grows(unit('const a = () => 1\n'), extract('many.ts'))
      // A class holding methods holding blocks: each symbol still ends at its own closing brace.
      const nested = J('class A {', '  m() {', '    if (x) {', '    }', '  }', '  n() {', '  }', '}', 'function g() {', '}')
      expect(show('n.ts', nested).s).toEqual([['A', 'class', 1, 8], ['m', 'method', 2, 5], ['n', 'method', 6, 7], ['g', 'function', 9, 10]])
    })

    it('block ends: Python defs nested deeper on every line stop scanning once the file has been read 16 times over', () => {
      // Each def's body runs to the end of the file, so 800 of them would read it hundreds of times over.
      const deep = Array.from({ length: 800 }, (_, i) => ' '.repeat(i) + 'def f' + i + '():').join('\n')
      const ends = extractFile('deep.py', deep)!.symbols.map((s) => s.endLine)
      expect(ends).toHaveLength(800)
      expect(ends[0]).toBe(800)
      // Past the budget a scan stops where it is, so a later def ends early, and the last ones on their own line.
      const cut = ends.findIndex((end) => end < 800)
      expect(cut).toBeGreaterThan(0)
      expect(ends[cut]).toBeGreaterThan(cut + 1)
      expect(ends[798]).toBe(799)
    })

    it('the hand-read matchers agree with the old regexes where a remembered fact is reused or a clause is empty', () => {
      // const heads with no `=` or `:` after them, and two heads sharing one `=` or one `)` that are no arrow.
      expect(show('a.ts', 'let x\nlet y;\nconst z\n')).toEqual({ s: [], i: [] })
      expect(show('a.ts', 'const a: T\nconst b = 1\n')).toEqual({ s: [], i: [] })
      expect(show('a.ts', 'const a = (x\nconst b = (y) + 1\n')).toEqual({ s: [], i: [] })
      // A `:` right before the `{` is an empty return type; an earlier `):` then decides it.
      expect(show('a.ts', 'class K {\n  a():{ }\n  b(x): y():{ }\n}\n').s).toEqual([['K', 'class', 1, 4], ['b', 'method', 3, 3]])
      // import lines with no source before one that has it, and the same source twice.
      expect(show('a.ts', "import a\nimport b\nimport 'x'\nimport 'x'\n").i).toEqual(['x'])
      expect(show('a.ts', "import a\nimport b from 'y'\n").i).toEqual(['y'])
    })

    // Long blank runs, spaces, tabs or CRLF, and lines no language declares anything with: one test per language and input.
    const odd: Case[] = [...empty, ...named('public\n', '@a\n'), ['"from" then spaces', (n) => 'from' + ' '.repeat(n)], ['"import" then spaces', (n) => 'import' + ' '.repeat(n)], ...named('resource "a\n')]
    const exts = ['ts', 'py', 'go', 'rs', 'java', 'kt', 'cs', 'rb', 'tf', 'swift', 'bicep']
    it.each(exts.flatMap((ext) => odd.map(([label, make]) => [ext, label, make] as const)))('%s reads %s in time linear in its size', (ext, label, make) => {
      grows(make, extract(`f.${ext}`), `${ext} ${label}`)
    })
  })
})

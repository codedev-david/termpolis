// Technology chips (film bug 1): read from the code and from the model, each named by a glossary key.
import { describe, expect, it } from 'vitest'
import { BUILTIN_TECH, canonicalTech, detectStack, MAX_STACK, packageImports, techChips } from '../../src/main/world/techStack'

describe('techStack', () => {
  it('every builtin technology has a definition', () => {
    for (const [k, v] of Object.entries(BUILTIN_TECH)) {
      expect(k.trim()).toBe(k)
      expect(v.length).toBeGreaterThan(10)
    }
  })

  it('names a technology by its key whatever its case or spelling', () => {
    expect(canonicalTech('typescript')).toBe('TypeScript')
    expect(canonicalTech(' NODE ')).toBe('Node.js')
    expect(canonicalTech('nodejs')).toBe('Node.js')
    expect(canonicalTech('threejs')).toBe('Three.js')
    expect(canonicalTech('better-sqlite3')).toBe('SQLite')
    expect(canonicalTech('Electron')).toBe('Electron')
    expect(canonicalTech('Hand-rolled')).toBeUndefined()
  })

  it('reads the packages a script imports, without subpaths, node: or relative imports, ignoring comments and other files', () => {
    const text = [
      "import { app } from 'electron'",
      "import * as THREE from 'three/examples/jsm/controls/OrbitControls.js'",
      "import Database from 'better-sqlite3'",
      "import { readFile } from 'node:fs/promises'",
      "import { Terminal } from '@xterm/xterm'",
      "import './local'",
      "const x = require('child_process')",
      "const y = await import('react')",
      "// import nope from 'vue'",
      "import { a } from '../up'"
    ].join('\n')
    expect(packageImports('src/a.ts', text)).toEqual(['electron', 'three', 'better-sqlite3', 'fs', '@xterm/xterm', 'child_process', 'react'])
    expect(packageImports('README.md', text)).toEqual([])
  })

  it('detects the languages and technologies of a building, in a fixed order', () => {
    const pk: Record<string, string[]> = {
      'src/main/index.ts': ['electron', 'node:path', 'better-sqlite3'],
      'src/main/view.tsx': ['react', 'react-dom/client', 'three', '@xterm/xterm'],
      'src/main/util.js': ['left-pad'],
      'tools/run.py': ['os', 'flask'],
      Makefile: [],
      'docs/v1.0/notes': []
    }
    const of = (f: string): string[] => pk[f] ?? []
    expect(detectStack(Object.keys(pk), of)).toEqual(['TypeScript', 'JavaScript', 'Python', 'Node.js', 'Electron', 'React', 'Three.js', 'SQLite', 'xterm.js', 'Flask'])
    // A Python `os` is not Node.js.
    expect(detectStack(['a.py'], () => ['os'])).toEqual(['Python'])
    expect(detectStack([], of)).toEqual([])
  })

  it('a type-only import names no technology the code runs (fix wave M5)', () => {
    const text = [
      "import type { WebContents } from 'electron'",
      "export type { Mesh } from 'three'",
      "import { type Database, type Statement as S } from 'better-sqlite3'",
      "import type * as X from '@xterm/xterm'",
      "import type Flask from 'flask'",
      "import { type Root, createRoot } from 'react-dom/client'",
      "export { pick } from 'lodash'",
      "import {} from 'zod'"
    ].join('\n')
    expect(packageImports('src/a.ts', text)).toEqual(['react-dom', 'lodash', 'zod'])
  })

  it('a type alias never swallows the import or re-export after it, and a multi-line type-only import is still types only (round 2 N2)', () => {
    const text = [
      'export type A = number',
      "export { x } from 'electron'",
      'import type B = C.D',
      "import { useState } from 'react'",
      'import type {',
      '  Mesh,',
      '  Scene',
      "} from 'three'",
      "export type Big = { a: string; b: 'x' }",
      "import ws from 'ws'"
    ].join('\n')
    expect(packageImports('src/a.ts', text)).toEqual(['electron', 'react', 'ws'])
  })

  it('a type-only import with a long list, and a bare type-only re-export, are still types only (round 5 M1, M2)', () => {
    const names = Array.from({ length: 300 }, (_, i) => `  ModelType${i}`).join(',\n')
    expect(names.length).toBeGreaterThan(3000)
    const text = [
      `import type {\n${names}\n} from '@azure/arm-compute'`,
      `import {\n${names.replace(/ {2}/g, '  type ')}\n} from 'three'`,
      "export type * from 'electron'",
      "export type * as Wire from 'ws'",
      "import zod from 'zod'"
    ].join('\n')
    expect(packageImports('src/a.ts', text)).toEqual(['zod'])
  })

  it('reads a huge file of type aliases, open braces and braced imports in linear time (round 2 N3)', () => {
    const lines = (line: string, n: number): string => Array.from({ length: n }, () => line).join('\n') + "\nimport 'zod'"
    const plain = (length: number): string => lines('const value = 12345678', Math.ceil(length / 23))
    // No wall-clock bound: a busy CI runner stalls for hundreds of ms. Two ratios measured in the same run instead,
    // which load moves on both sides alike. 4N lines against N: a linear read takes about 4 times as long, a
    // quadratic scan about 16. 4N lines against plain code of the same length (about 1): a scan that runs on past
    // its line to its 20,000-character cap is linear but hundreds of times slower. Each side is the best of
    // interleaved samples of enough calls to last milliseconds, so one stall moves neither.
    const sample = (text: string, calls: number): number => {
      const start = performance.now()
      for (let i = 0; i < calls; i++) packageImports('src/gen.ts', text)
      return performance.now() - start
    }
    for (const line of ['export type A = number', 'export type {', 'import {', 'import type A']) {
      const small = lines(line, 2_000)
      const big = lines(line, 8_000)
      const same = plain(big.length)
      expect(packageImports('src/gen.ts', small)).toEqual(['zod'])
      expect(packageImports('src/gen.ts', big)).toEqual(['zod'])
      let calls = 1
      while (sample(small, calls) < 10 && calls < 1 << 12) calls *= 2
      let bestSmall = Infinity
      let bestBig = Infinity
      let bestPlain = Infinity
      for (let run = 0; run < 7; run++) {
        bestSmall = Math.min(bestSmall, sample(small, calls))
        bestBig = Math.min(bestBig, sample(big, calls))
        bestPlain = Math.min(bestPlain, sample(same, calls))
      }
      expect(bestBig / bestSmall, `${line}: 4N lines against N`).toBeLessThan(8)
      expect(bestBig / bestPlain, `${line}: against plain code as long`).toBeLessThan(4)
    }
  })

  it('a Node built-in imported by code in the renderer is a browser polyfill, not Node.js (fix wave M5)', () => {
    const of = (): string[] => ['events', 'buffer', 'electron']
    expect(detectStack(['src/preload/index.ts'], of, { browser: true })).toEqual(['TypeScript', 'Electron'])
    expect(detectStack(['src/main/index.ts'], of, { browser: false })).toEqual(['TypeScript', 'Node.js', 'Electron'])
  })

  it('techChips puts the detected ones first, names terms by their glossary key and drops terms with no definition', () => {
    const glossary = { ...BUILTIN_TECH, 'Event bus': 'Passes events around' }
    expect(techChips(['TypeScript', 'Electron'], ['typescript', 'react', 'event BUS', 'Hand-rolled', 'Node'], glossary)).toEqual([
      'TypeScript', 'Electron', 'React', 'Event bus', 'Node.js'
    ])
    const many = Object.keys(BUILTIN_TECH)
    expect(techChips([], many, glossary)).toHaveLength(MAX_STACK)
    expect(techChips([], many, glossary, 2)).toEqual(many.slice(0, 2))
  })
})

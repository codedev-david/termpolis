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

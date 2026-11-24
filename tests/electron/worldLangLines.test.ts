// Lumopolis lines for Python, Go, Rust, Java and Kotlin, through the compile: the scenario fixtures on the real disk
// with the world host's snapshot, and small in-memory projects for the go.mod reading and the stage cache.
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import { compileWorld, compileWorldStaged, scanFile, type CompileDeps } from '../../src/main/world/compile'
import { snapshotFromFiles } from '../../src/main/world/fileSnapshot'
import type { LabelDeps } from '../../src/main/world/label'
import { isStageCache, STAGE_CACHE_VERSION } from '../../src/main/world/stageCache'
import type { WorldDoc } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import { type MadeScenario, type ScenarioName, withScenario } from '../helpers/worldScenario'

const made: MadeScenario[] = []
afterAll(async () => {
  for (const m of made) await m.cleanup()
})

function labelDeps(): LabelDeps {
  const store = new Map<string, string>()
  return { llm: null, cache: { get: async (h) => store.get(h) ?? null, set: async (h, v) => void store.set(h, v) }, excerpt: async (f) => `code of ${f}` }
}

const HEAD = { head: 'abc123', dirty: false }
const ROOT = '/repo'

function expectValid(doc: WorldDoc): void {
  const v = validateWorld(doc)
  expect(v.ok ? [] : v.errors).toEqual([])
}

/** The world's lines as `from -> to` building ids, sorted. */
const pairs = (doc: WorldDoc): string[] => doc.edges.map((e) => `${e.from} -> ${e.to}`).sort()
/** The building a file is in. */
const home = (doc: WorldDoc, file: string): string | undefined => doc.buildings.find((b) => b.members.includes(file))?.id

async function scenarioWorld(name: ScenarioName): Promise<WorldDoc> {
  const m = await withScenario(name)
  made.push(m)
  const read = (p: string): Promise<string> => readFile(p, 'utf8')
  const snap = await snapshotFromFiles(m.dir, { read })
  const root = m.dir.replace(/\\/g, '/')
  const deps: CompileDeps = {
    readFile: (p) => readFile(p, 'utf8').catch(() => null),
    glob: async () => [],
    label: labelDeps(),
    now: () => 1
  }
  const doc = await compileWorld({ snap, projectKey: name, head: HEAD, previous: null }, deps)
  expectValid(doc)
  return doc
}

function memDeps(files: Record<string, string>, over: Partial<CompileDeps> = {}): CompileDeps & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    readFile: async (p) => {
      reads.push(p)
      const rel = p.slice(ROOT.length + 1)
      return Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null
    },
    glob: async () => [],
    label: labelDeps(),
    now: () => 1,
    ...over
  }
}

const snapOf = (files: Record<string, string>): GraphSnapshot => ({
  root: ROOT,
  files: Object.keys(files).filter((f) => !f.endsWith('go.mod')).sort(),
  symbols: [],
  callEdges: [],
  fileImports: {}
})

const compileMem = (files: Record<string, string>, over: Partial<CompileDeps> = {}): Promise<WorldDoc> =>
  compileWorld({ snap: snapOf(files), projectKey: 'mem', head: HEAD, previous: null }, memDeps(files, over))

describe('scenario worlds draw their lines', () => {
  it('python-only: relative imports between the app modules become lines', async () => {
    const doc = await scenarioWorld('python-only')
    expect(doc.edges.length).toBeGreaterThan(0)
    const at = (f: string): string => home(doc, `app/${f}.py`) as string
    // main imports service and config; service imports store (store sits with models); every line ends in a part of the world.
    expect(pairs(doc)).toEqual(expect.arrayContaining([`${at('main')} -> ${at('service')}`, `${at('main')} -> ${at('config')}`, `${at('service')} -> ${at('store')}`]))
    const ids = new Set(doc.buildings.map((b) => b.id))
    expect(doc.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true)
  })

  it('go-only: imports under the go.mod module path become lines', async () => {
    const doc = await scenarioWorld('go-only')
    const at = (f: string): string => home(doc, f) as string
    expect(pairs(doc)).toEqual(
      expect.arrayContaining([
        `${at('main.go')} -> ${at('server/server.go')}`,
        `${at('server/server.go')} -> ${at('store/store.go')}`,
        `${at('store/store.go')} -> ${at('models/note.go')}`,
        `${at('config/config.go')} -> ${at('util/strings.go')}`
      ])
    )
  })
})

describe('compile: Rust, Java and Kotlin lines', () => {
  it('links mod declarations and crate paths', async () => {
    const doc = await compileMem({
      'src/main.rs': 'mod net;\nmod store;\nuse crate::store::Db;\nuse std::io;\nfn main() {}\n',
      'src/net/mod.rs': 'pub mod http;\n',
      'src/net/http.rs': 'use crate::store::Db;\n',
      'src/store.rs': 'pub struct Db;\n'
    })
    expectValid(doc)
    expect(pairs(doc)).toEqual(expect.arrayContaining([`${home(doc, 'src/net/http.rs')} -> ${home(doc, 'src/store.rs')}`]))
  })

  it('links Java and Kotlin imports through declared packages; Kotlin files are parts of the world', async () => {
    const doc = await compileMem({
      'app/src/App.java': 'package com.acme.app;\nimport com.acme.store.Repo;\nimport java.util.List;\nclass App {}\n',
      'store/src/Repo.kt': 'package com.acme.store\nimport com.acme.model.Note\nclass Repo\n',
      'model/src/Note.java': 'package com.acme.model;\nclass Note {}\n'
    })
    expectValid(doc)
    expect(home(doc, 'store/src/Repo.kt')).toBeDefined()
    expect(pairs(doc)).toEqual(
      expect.arrayContaining([
        `${home(doc, 'app/src/App.java')} -> ${home(doc, 'store/src/Repo.kt')}`,
        `${home(doc, 'store/src/Repo.kt')} -> ${home(doc, 'model/src/Note.java')}`
      ])
    )
  })

  it('an import of the standard library or a third-party package draws no line and makes no part', async () => {
    const files = { 'a/one.py': 'import os\nimport requests\nfrom django.db import models\n', 'b/two.py': 'import json\n' }
    const doc = await compileMem(files)
    expect(doc.edges).toEqual([])
    expect(doc.buildings.flatMap((b) => b.members).sort()).toEqual(['a/one.py', 'b/two.py'])
  })
})

describe('compile: go.mod', () => {
  const GO = {
    'cmd/main.go': 'package main\nimport "example.com/app/lib"\nimport "example.com/tools/gen"\n',
    'lib/lib.go': 'package lib\n',
    'tools/gen/gen.go': 'package gen\nimport "example.com/tools/lint"\n',
    'tools/lint/lint.go': 'package lint\n'
  }
  const goModReads = (reads: string[]): string[] => reads.filter((p) => p.endsWith('go.mod')).sort()

  it('looks for go.mod in each folder of Go files and every folder above it, nested modules too, with no glob', async () => {
    const files = { ...GO, 'go.mod': 'module example.com/app\n', 'tools/go.mod': 'module example.com/tools\n' }
    const deps = memDeps(files, { glob: async () => [] })
    const doc = await compileWorld({ snap: snapOf(files), projectKey: 'mem', head: HEAD, previous: null }, deps)
    expect(pairs(doc)).toEqual(
      expect.arrayContaining([
        `${home(doc, 'cmd/main.go')} -> ${home(doc, 'lib/lib.go')}`,
        `${home(doc, 'cmd/main.go')} -> ${home(doc, 'tools/gen/gen.go')}`
      ])
    )
    // Each folder once, the root's too; never a folder without Go files below it.
    expect(goModReads(deps.reads)).toEqual(['cmd', '', 'lib', 'tools', 'tools/gen', 'tools/lint'].map((d) => `${ROOT}/${d === '' ? '' : `${d}/`}go.mod`).sort())
  })

  it('finds the root go.mod for a Go file at the root, the shallowest folders looked in first', async () => {
    const files = {
      'main.go': 'package main\nimport "example.com/app/z/z"\n',
      'z/z/z.go': 'package z\n',
      'a/a.go': 'package a\nimport "example.com/app/z/z"\n',
      'web/app.ts': 'export const app = 1\n',
      'go.mod': 'module example.com/app\n'
    }
    const deps = memDeps(files)
    const doc = await compileMem(files)
    await compileWorld({ snap: snapOf(files), projectKey: 'mem', head: HEAD, previous: null }, deps)
    expect(pairs(doc)).toEqual([`${home(doc, 'a/a.go')} -> ${home(doc, 'z/z/z.go')}`, `${home(doc, 'main.go')} -> ${home(doc, 'z/z/z.go')}`].sort())
    expect(goModReads(deps.reads)).toEqual([`${ROOT}/a/go.mod`, `${ROOT}/go.mod`, `${ROOT}/z/go.mod`, `${ROOT}/z/z/go.mod`])
  })

  it('reads no go.mod when no Go file imports anything', async () => {
    const plain = memDeps({ 'main.go': 'package main\n', 'go.mod': 'module example.com/app\n' })
    await compileWorld({ snap: snapOf({ 'main.go': '' }), projectKey: 'mem', head: HEAD, previous: null }, plain)
    expect(plain.reads.some((p) => p.endsWith('go.mod'))).toBe(false)
  })

  it('skips a go.mod that is unreadable, too long or without a module line, and never looks under node_modules', async () => {
    const files: Record<string, string> = { ...GO, 'tools/go.mod': 'go 1.22\n', 'node_modules/x/x.go': 'package x\nimport "example.com/app/lib"\n' }
    const deps = memDeps(files, {
      readFile: async (p) => {
        deps.reads.push(p)
        if (p === `${ROOT}/go.mod`) throw new Error('locked')
        if (p === `${ROOT}/cmd/go.mod`) return `module example.com/app\n${' '.repeat(300 * 1024)}`
        const rel = p.slice(ROOT.length + 1)
        return Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null
      }
    })
    const doc = await compileWorld({ snap: snapOf(files), projectKey: 'mem', head: HEAD, previous: null }, deps)
    expect(doc.edges).toEqual([])
    expect(goModReads(deps.reads)).toContain(`${ROOT}/go.mod`)
    expect(deps.reads.some((p) => p.includes('node_modules') && p.endsWith('go.mod'))).toBe(false)
  })
})

describe('stage cache', () => {
  it('keeps the scan of each file, its references and its package, and a recompile from the cache draws the same lines', async () => {
    const files = {
      'app/src/App.java': 'package com.acme.app;\nimport com.acme.store.Repo;\nclass App {}\n',
      'store/src/Repo.java': 'package com.acme.store;\nclass Repo {}\n',
      'py/a.py': 'from .b import c\n',
      'py/b.py': ''
    }
    const input = { snap: snapOf(files), projectKey: 'mem', head: HEAD, previous: null }
    const first = await compileWorldStaged(input, memDeps(files))
    expect(first.cache.version).toBe(STAGE_CACHE_VERSION)
    expect(first.cache.files['app/src/App.java']).toMatchObject({ refs: ['jv:com.acme.store.Repo'], pkg: 'com.acme.app' })
    expect(first.cache.files['py/b.py'].refs).toBeUndefined()
    expect(isStageCache(JSON.parse(JSON.stringify(first.cache)))).toBe(true)
    const deps = memDeps(files)
    const again = await compileWorldStaged({ ...input, cache: first.cache, changed: [] }, deps)
    expect(deps.reads.filter((p) => !p.endsWith('go.mod'))).toEqual([])
    expect(pairs(again.doc)).toEqual(pairs(first.doc))
    expect(again.doc.edges.length).toBeGreaterThan(0)
  })

  it('rejects a cached file whose references, package or declarations are not strings', () => {
    const file = { hash: 'h', boundaries: [], imports: [] }
    const cache = (f: object): unknown => ({ version: STAGE_CACHE_VERSION, files: { 'a.py': f }, structureHash: 's' })
    expect(isStageCache(cache({ ...file, refs: ['py:i:x'], pkg: 'a' }))).toBe(true)
    expect(isStageCache(cache({ ...file, refs: [1] }))).toBe(false)
    expect(isStageCache(cache({ ...file, pkg: 2 }))).toBe(false)
    expect(isStageCache(cache({ ...file, decls: ['helper'] }))).toBe(true)
    expect(isStageCache(cache({ ...file, decls: [3] }))).toBe(false)
  })

  it('scanFile records references and a package only when the file has them', () => {
    expect(scanFile('a.ts', "import x from './x'\n")).not.toHaveProperty('refs')
    expect(scanFile('A.java', 'package p;\nclass A {}\n')).toMatchObject({ pkg: 'p' })
    expect(scanFile('A.java', 'package p;\nclass A {}\n')).not.toHaveProperty('refs')
    expect(scanFile('a.py', 'import os\n')).toMatchObject({ refs: ['py:i:os'] })
    expect(scanFile('U.kt', 'package k\nfun helper() = 1\n')).toMatchObject({ pkg: 'k', decls: ['helper'] })
    expect(scanFile('A.java', 'package p;\nclass A {}\n')).not.toHaveProperty('decls')
  })

  it("draws a Kotlin top-level import to the file that declares it, from the cache too, and nothing for a name no file declares", async () => {
    const files = {
      'k/Utils.kt': '﻿package k\r\nfun helper() = 1\r\n',
      'k/Other.kt': 'package k\nfun other() = 2\n',
      'app/App.kt': 'package app\nimport k.helper\nimport k.Nope\nfun main() {}\n',
      'app/Main.java': 'package app;\nimport com.missing.Gone;\nimport k.Missing;\nclass Main {}\n'
    }
    const input = { snap: snapOf(files), projectKey: 'mem', head: HEAD, previous: null }
    const first = await compileWorldStaged(input, memDeps(files))
    const from = (doc: WorldDoc, f: string): string => home(doc, f) as string
    expect(pairs(first.doc)).toEqual([`${from(first.doc, 'app/App.kt')} -> ${from(first.doc, 'k/Utils.kt')}`])
    expect(first.cache.files['k/Utils.kt']).toMatchObject({ pkg: 'k', decls: ['helper'] })
    const again = await compileWorldStaged({ ...input, cache: first.cache, changed: [] }, memDeps(files))
    expect(pairs(again.doc)).toEqual(pairs(first.doc))
  })

  it('a cache written before declarations were recorded is ignored, so the Kotlin top-level line still appears', async () => {
    const files = { 'k/Utils.kt': 'package k\nfun helper() = 1\n', 'app/App.kt': 'package app\nimport k.helper\nfun main() {}\n' }
    const input = { snap: snapOf(files), projectKey: 'mem', head: HEAD, previous: null }
    const first = await compileWorldStaged(input, memDeps(files))
    expect(pairs(first.doc)).toHaveLength(1)
    // The previous version's layout: the same files with no decls.
    const stripped = Object.fromEntries(Object.entries(first.cache.files).map(([f, v]) => {
      const { decls: _gone, ...rest } = v
      return [f, rest]
    }))
    const old = { ...first.cache, version: STAGE_CACHE_VERSION - 1, files: stripped }
    expect(isStageCache(old)).toBe(false)
    const deps = memDeps(files)
    const out = await compileWorldStaged({ ...input, cache: old, changed: [] }, deps)
    expect(deps.reads.filter((p) => p.endsWith('.kt')).length).toBe(2)
    expect(out.cache.version).toBe(STAGE_CACHE_VERSION)
    expect(out.cache.files['k/Utils.kt']).toMatchObject({ decls: ['helper'] })
    expect(pairs(out.doc)).toEqual(pairs(first.doc))
  })
})

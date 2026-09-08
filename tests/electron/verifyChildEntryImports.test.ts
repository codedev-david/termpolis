/**
 * The guard that would have caught the v1.39.2 bridge crash before e2e did.
 *
 * `import { Terminal } from '@xterm/headless'` in an externalized, ESM-built
 * utilityProcess entry throws at child startup and takes the Remote bridge with
 * it -- silently, because a dead child simply stops answering. Vitest cannot see
 * it (it interops the import happily) and neither can the type checker. This
 * suite covers the script that reads the BUILT output, where the failure is
 * real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const guard = require('../../scripts/verifyChildEntryImports.cjs')

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `child-imports-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function entry(name: string, source: string): void {
  writeFileSync(join(dir, name), source, 'utf8')
}

/** A module registry standing in for the real resolver, so a package that cannot
 *  be imported can be described without publishing a broken one. */
function loader(modules: Record<string, Record<string, unknown>>) {
  return async (specifier: string): Promise<Record<string, unknown>> => {
    if (!(specifier in modules)) throw new Error(`Cannot find package '${specifier}'`)
    return modules[specifier]
  }
}

describe('reading the imports out of a built bundle', () => {
  it('finds the named bindings a statement asks for', () => {
    const found = guard.readImports('import { Terminal, IBuffer } from "@xterm/headless";')
    expect(found).toEqual([{ specifier: '@xterm/headless', names: ['Terminal', 'IBuffer'] }])
  })

  it('reads through a rename to the name the module must actually export', () => {
    const found = guard.readImports('import { Terminal as Term } from "@xterm/headless";')
    expect(found[0].names).toEqual(['Terminal'])
  })

  it('asks nothing by name of a default import', () => {
    // Default interop against CommonJS always works, so there is nothing here
    // that can fail and nothing worth checking.
    expect(guard.readImports('import jpeg from "jpeg-js";')[0].names).toEqual([])
  })

  it('asks nothing by name of a namespace import', () => {
    expect(guard.readImports('import * as http from "http";')[0].names).toEqual([])
  })

  it('ignores `default` inside a brace list, which interop always provides', () => {
    expect(guard.namedBindings('{ default as x, Terminal }')).toEqual(['Terminal'])
  })

  it('still records a side-effect import, which has to resolve even so', () => {
    expect(guard.readImports('import "./polyfill.js";')).toEqual([
      { specifier: './polyfill.js', names: [] },
    ])
  })

  it('does not read the word import inside a string literal as a package', () => {
    // The first draft did, and reported a dependency called `', event: level === '`.
    expect(guard.readImports(`const msg = "please import { x } from 'somewhere'";`)).toEqual([])
  })

  it('does not read a dynamic import call as a static one', () => {
    expect(guard.readImports('const m = await import("./chunk.js");')).toEqual([])
  })

  it('reads every import in a multi-import file', () => {
    const found = guard.readImports(
      ['import * as http from "http";', 'import { Terminal } from "@xterm/headless";'].join('\n'),
    )
    expect(found.map((f: { specifier: string }) => f.specifier)).toEqual([
      'http',
      '@xterm/headless',
    ])
  })
})

describe('deciding what is somebody else to resolve', () => {
  it('treats node builtins as provided, plain and prefixed', () => {
    expect(guard.isProvided('crypto')).toBe(true)
    expect(guard.isProvided('node:buffer')).toBe(true)
  })

  it('treats electron as provided -- it does not exist outside an electron process', () => {
    expect(guard.isProvided('electron')).toBe(true)
    expect(guard.isProvided('electron/main')).toBe(true)
  })

  it('does not treat a real package as provided', () => {
    expect(guard.isProvided('@xterm/headless')).toBe(false)
  })

  it("treats the bundle's own chunks as internal", () => {
    expect(guard.isInternal('./chunks/deviceLabel-C3a1Bbva.js')).toBe(true)
    expect(guard.isInternal('/abs/path.js')).toBe(true)
    expect(guard.isInternal('ws')).toBe(false)
  })
})

describe('listing the entries to check', () => {
  it('takes the javascript files and leaves everything else', () => {
    entry('remoteBridge.js', '')
    entry('remoteBridge.js.map', '')
    expect(guard.entryFiles(dir)).toEqual([join(dir, 'remoteBridge.js')])
  })
})

describe('verifying a build directory', () => {
  it('passes a build whose imports all resolve and export what is asked', async () => {
    entry('remoteBridge.js', 'import { Terminal } from "@xterm/headless";')
    const problems = await guard.verify(dir, loader({ '@xterm/headless': { Terminal: class {} } }))
    expect(problems).toEqual([])
  })

  it('fails the exact bug this exists for: CommonJS with no readable named export', async () => {
    entry('remoteBridge.js', 'import { Terminal } from "@xterm/headless";')
    // What Node really hands back for a CJS module it cannot lex: a default, and
    // nothing else. The child then throws before its first line of work.
    const problems = await guard.verify(dir, loader({ '@xterm/headless': { default: {} } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("'@xterm/headless' has no export named 'Terminal'")
    expect(problems[0]).toContain('externalizeDepsPlugin exclude')
  })

  it('names every missing binding, not just the first', async () => {
    entry('remoteBridge.js', 'import { Terminal, IBuffer } from "@xterm/headless";')
    const problems = await guard.verify(dir, loader({ '@xterm/headless': { default: {} } }))
    expect(problems[0]).toContain("'Terminal', 'IBuffer'")
  })

  it('fails a package that does not resolve at all', async () => {
    entry('remoteBridge.js', 'import { thing } from "never-installed";')
    const problems = await guard.verify(dir, loader({}))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('fails at runtime')
    expect(problems[0]).toContain('never-installed')
  })

  it('skips builtins and internal chunks rather than trying to load them', async () => {
    entry('memoryHost.js', 'import * as fs from "fs";\nimport { x } from "./chunks/a.js";')
    // An empty registry: anything the script tried to load would fail loudly.
    expect(await guard.verify(dir, loader({}))).toEqual([])
  })

  it('checks every entry in the directory, not only the first', async () => {
    entry('a.js', 'import { good } from "pkg-a";')
    entry('b.js', 'import { bad } from "pkg-b";')
    const problems = await guard.verify(dir, loader({ 'pkg-a': { good: 1 }, 'pkg-b': {} }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('pkg-b')
  })

  it('loads a repeated specifier once', async () => {
    entry('a.js', 'import { good } from "pkg-a";')
    entry('b.js', 'import { good } from "pkg-a";')
    let loads = 0
    const counting = async (): Promise<Record<string, unknown>> => {
      loads += 1
      return { good: 1 }
    }
    expect(await guard.verify(dir, counting)).toEqual([])
    expect(loads).toBe(1)
  })
})

describe('running it as a command', () => {
  it('reports success on a clean directory', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    entry('a.js', 'import * as fs from "fs";')
    expect(await guard.main([dir])).toBe(0)
    expect(log.mock.calls[0][0]).toContain('OK:')
  })

  it('refuses a directory that was never built, rather than passing vacuously', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Exit 2, not 1: "you did not build" is a different answer from "your build
    // is broken", and a green run against a missing directory is the worst of
    // the three.
    expect(await guard.main([join(dir, 'not-built')])).toBe(2)
    expect(err.mock.calls[0][0]).toContain('npm run build')
  })

  it('fails, against the real resolver, on an import nothing can satisfy', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    entry('a.js', 'import { nope } from "termpolis-package-that-does-not-exist";')
    expect(await guard.main([dir])).toBe(1)
    expect(err.mock.calls[0][0]).toContain('FAIL:')
  })
})

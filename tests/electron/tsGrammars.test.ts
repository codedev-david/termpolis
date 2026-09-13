import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadGrammar, grammarAvailable, newParser, _resetGrammarCacheForTests } from '../../src/main/tsGrammars'

describe('tsGrammars — WASM grammar loader', () => {
  it('grammarAvailable reflects the on-disk grammars', () => {
    expect(grammarAvailable('typescript')).toBe(true)
    expect(grammarAvailable('python')).toBe(true)
    expect(grammarAvailable('nonexistent-lang')).toBe(false)
  })

  it('loads a known grammar and returns null for an unknown one', async () => {
    expect(await loadGrammar('typescript')).toBeTruthy()
    expect(await loadGrammar('nonexistent-lang')).toBeNull()
  })

  it('caches a loaded grammar (same instance) and reloads after a reset', async () => {
    const a = await loadGrammar('python')
    const b = await loadGrammar('python')
    expect(a).toBe(b) // cached
    _resetGrammarCacheForTests()
    expect(await loadGrammar('python')).toBeTruthy() // reloads
    expect(await loadGrammar('nonexistent-lang')).toBeNull() // negative cache path
  })

  it('newParser returns a usable parser instance', () => {
    const p = newParser()
    expect(typeof p.parse).toBe('function')
  })
})

/** The real grammar blob this machine ships — used to plant a grammar where the loader looks. */
function realGrammarWasm(): string {
  const found = [
    path.join(process.cwd(), 'resources', 'grammars', 'tree-sitter-typescript.wasm'),
    path.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-typescript.wasm'),
  ].find((p) => fs.existsSync(p))
  if (!found) throw new Error('no bundled grammar to copy from')
  return found
}

/** Run `fn` with process.resourcesPath (Electron-only, absent under vitest) pointed at `dir`. */
async function withResourcesPath(dir: string, fn: () => Promise<void>): Promise<void> {
  const prev = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: dir, configurable: true, writable: true })
  try {
    await fn()
  } finally {
    if (prev) Object.defineProperty(process, 'resourcesPath', prev)
    else delete (process as unknown as { resourcesPath?: string }).resourcesPath
    _resetGrammarCacheForTests()
  }
}

describe('tsGrammars — packaged-app resolution and negative caching', () => {
  it('resolves grammars out of process.resourcesPath when the app is packaged', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgram-res-'))
    try {
      fs.mkdirSync(path.join(dir, 'grammars'))
      // A name that exists NOWHERE in the repo, so a hit can only come from resourcesPath.
      fs.copyFileSync(realGrammarWasm(), path.join(dir, 'grammars', 'tree-sitter-packagedlang.wasm'))
      await withResourcesPath(dir, async () => {
        _resetGrammarCacheForTests()
        expect(grammarAvailable('packagedlang')).toBe(true)
        expect(await loadGrammar('packagedlang')).toBeTruthy()
      })
      // Once resourcesPath is gone the same grammar is unresolvable again.
      _resetGrammarCacheForTests()
      expect(grammarAvailable('packagedlang')).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      _resetGrammarCacheForTests()
    }
  })

  it('negatively caches a missing grammar — a later on-disk blob does not change the answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgram-neg-'))
    const wasmPath = path.join(dir, 'grammars', 'tree-sitter-latecomer.wasm')
    try {
      fs.mkdirSync(path.join(dir, 'grammars'))
      await withResourcesPath(dir, async () => {
        _resetGrammarCacheForTests()

        // Nothing on disk yet → null, and the miss is remembered.
        expect(grammarAvailable('latecomer')).toBe(false)
        expect(await loadGrammar('latecomer')).toBeNull()

        // Plant a REAL grammar exactly where the loader would find it…
        fs.copyFileSync(realGrammarWasm(), wasmPath)
        expect(grammarAvailable('latecomer')).toBe(true) // the file IS resolvable now…

        // …yet loadGrammar still answers null: the cached miss short-circuits the disk scan.
        expect(await loadGrammar('latecomer')).toBeNull()

        // Only dropping the cache lets the new blob through.
        _resetGrammarCacheForTests()
        expect(await loadGrammar('latecomer')).toBeTruthy()
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      _resetGrammarCacheForTests()
    }
  })

  it('degrades to null (never throws) when a resolvable grammar blob is not valid WASM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgram-bad-'))
    try {
      fs.mkdirSync(path.join(dir, 'grammars'))
      fs.writeFileSync(
        path.join(dir, 'grammars', 'tree-sitter-corrupt.wasm'),
        Buffer.from('this is definitely not a WebAssembly module'),
      )
      await withResourcesPath(dir, async () => {
        _resetGrammarCacheForTests()
        expect(grammarAvailable('corrupt')).toBe(true) // found on disk…
        await expect(loadGrammar('corrupt')).resolves.toBeNull() // …but Language.load fails → null
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      _resetGrammarCacheForTests()
    }
  })

  it('the cache reset is a no-op before any grammar has been loaded', () => {
    const g = globalThis as unknown as { __termpolisTS?: { init?: Promise<boolean>; cache?: Map<string, unknown> } }
    const saved = g.__termpolisTS
    // Keep the one-time runtime init promise (re-running Parser.init would abort the process),
    // but present a store that has never created a grammar cache.
    g.__termpolisTS = { init: saved?.init }
    try {
      expect(() => _resetGrammarCacheForTests()).not.toThrow()
      expect(g.__termpolisTS!.cache).toBeUndefined()
    } finally {
      g.__termpolisTS = saved
    }
  })

  it('still resolves the repo-bundled grammars after all of the above', async () => {
    _resetGrammarCacheForTests()
    expect(grammarAvailable('typescript')).toBe(true)
    expect(await loadGrammar('typescript')).toBeTruthy()
  })
})

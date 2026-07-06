// tsGrammars.ts — loads the web-tree-sitter WASM runtime + language grammars, lazily and cached.
//
// Native-free: web-tree-sitter is a WASM library; the grammar blobs are pre-built (tree-sitter-wasms)
// and copied into resources/grammars by scripts/copy-grammars.cjs. We resolve the WASMs from, in
// order: the packaged app's resources, the dev resources dir, and finally node_modules (so the test
// runner works without the copy step). If nothing resolves, callers fall back to the heuristic
// extractor — the code graph degrades, it never breaks.

import Parser from 'web-tree-sitter'
import * as fs from 'fs'
import * as path from 'path'

// The web-tree-sitter runtime can only be initialised ONCE per process — a second Parser.init()
// aborts the emscripten module and takes the whole process down. Test runners re-import this module
// per test file, which would reset a module-local guard, so the init promise + grammar cache live on
// globalThis: exactly one init and one load-per-grammar for the life of the process.
interface TSGlobal {
  init?: Promise<boolean>
  cache?: Map<string, Parser.Language | null>
}
const G = globalThis as unknown as { __termpolisTS?: TSGlobal }
function tsStore(): TSGlobal {
  return (G.__termpolisTS ??= {})
}

function candidateDirs(): string[] {
  const dirs: string[] = []
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'grammars'))
  dirs.push(path.join(process.cwd(), 'resources', 'grammars'))
  dirs.push(path.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out'))
  return dirs
}

function findWasm(fileName: string): string | null {
  for (const dir of candidateDirs()) {
    const p = path.join(dir, fileName)
    if (fs.existsSync(p)) return p
  }
  return null
}

function coreWasmPath(): string | null {
  const bundled = findWasm('tree-sitter.wasm')
  if (bundled) return bundled
  const nm = path.join(process.cwd(), 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
  return fs.existsSync(nm) ? nm : null
}

async function ensureInit(): Promise<boolean> {
  const s = tsStore()
  if (!s.init) {
    s.init = (async () => {
      const core = coreWasmPath()
      if (!core) return false // grammars not bundled → heuristic fallback
      try {
        await Parser.init({ locateFile: () => core })
        return true
      } catch {
        return false
      }
    })()
  }
  return s.init
}

/** Load a grammar by name (e.g. 'typescript'). Returns null if unavailable — caller falls back. */
export async function loadGrammar(grammar: string): Promise<Parser.Language | null> {
  const cache = (tsStore().cache ??= new Map())
  if (cache.has(grammar)) return cache.get(grammar) ?? null
  if (!(await ensureInit())) {
    cache.set(grammar, null)
    return null
  }
  const wasm = findWasm(`tree-sitter-${grammar}.wasm`)
  if (!wasm) {
    cache.set(grammar, null)
    return null
  }
  try {
    // Pass the PATH (not the bytes): web-tree-sitter reads it with its own fs, avoiding a
    // cross-realm Uint8Array check that fails under the vitest worker.
    const lang = await Parser.Language.load(wasm)
    cache.set(grammar, lang)
    return lang
  } catch {
    cache.set(grammar, null)
    return null
  }
}

/** A fresh parser instance. Callers set the language and parse. */
export function newParser(): Parser {
  return new Parser()
}

/** True when a grammar WASM for `grammar` is present on disk (does not init the runtime). */
export function grammarAvailable(grammar: string): boolean {
  return findWasm(`tree-sitter-${grammar}.wasm`) !== null
}

/** Test seam: drop cached grammars (the one-time runtime init is intentionally NOT reset). */
export function _resetGrammarCacheForTests(): void {
  tsStore().cache?.clear()
}

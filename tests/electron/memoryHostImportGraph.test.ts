// GUARD TEST — the memory utilityProcess's import graph must stay loadable inside a utilityProcess.
//
// This exists because the failure it prevents is SILENT and total.
//
// An Electron utilityProcess exposes only `{ default, net, systemPreferences }` from 'electron' —
// there is no `app`, no `safeStorage`. Under CJS a missing export is merely `undefined`. Under ESM —
// and this app is `"type": "module"`, so the built main bundle IS ESM — a missing NAMED export is a
// LINK-TIME SyntaxError. The module never runs. The child dies with exit code 1 before executing a
// single line, memoryClient falls back to the in-process store, and the app carries on looking
// perfectly healthy while the entire point of v1.26 (a 4,276 ms main-thread stall moved off-thread)
// quietly evaporates.
//
// That is exactly what happened during the port: `telemetry.ts` carried a DEAD `import { app } from
// 'electron'` — `app` was never referenced — and it alone killed the host. `aiSecurity.ts` (reachable
// via swarmMemory -> memoryAudit) did the same. Neither is visible to TypeScript, to the linter, or
// to any unit test that imports the module in-process. Only a real fork reveals it.
//
// So: walk memoryHost's transitive graph and fail the build if any module takes a NAMED import from
// 'electron'. A `default` import is fine (it links everywhere; the property is simply undefined in the
// child, and main-only code paths never run there). A `type`-only import is fine (erased at build).
// Need a real Electron API in a module the memory graph reaches? Inject it — the way secureKeyStore
// takes setSafeStorage(), and the way the memory scrubber is injected rather than imported.

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const MAIN_DIR = path.resolve(__dirname, '../../src/main')
const ENTRY = path.join(MAIN_DIR, 'memoryHost.ts')

/** Resolve a relative import specifier to a .ts file in src/main, or null if it is external. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const c of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(c)) return c
  }
  return null
}

interface ElectronImport { file: string; line: number; text: string }

/** BFS memoryHost's transitive src/main graph, collecting every `from 'electron'` import. */
function walkGraph(): { visited: Set<string>; electronImports: ElectronImport[] } {
  const visited = new Set<string>()
  const electronImports: ElectronImport[] = []
  const queue = [ENTRY]

  while (queue.length > 0) {
    const file = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)
    const src = fs.readFileSync(file, 'utf8')

    // Strip block comments so the explanatory notes in telemetry.ts / aiSecurity.ts (which QUOTE the
    // banned form) don't trip the scanner. Line comments are handled per-match below.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')

    const importRe = /^[ \t]*import\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm
    let m: RegExpExecArray | null
    while ((m = importRe.exec(code)) !== null) {
      const clause = m[1]
      const spec = m[2]
      const line = code.slice(0, m.index).split('\n').length
      if (spec === 'electron') {
        electronImports.push({ file: path.relative(MAIN_DIR, file), line, text: m[0].trim() })
        continue
      }
      const local = resolveLocal(file, spec)
      if (local) queue.push(local)
    }
  }
  return { visited, electronImports }
}

describe('memoryHost import graph — must load inside a utilityProcess', () => {
  const { visited, electronImports } = walkGraph()

  it('actually walked a real graph (a broken walker must not pass vacuously)', () => {
    expect(visited.size).toBeGreaterThan(15)
    // The modules that carried the two real landmines must genuinely be in scope.
    const rel = [...visited].map((f) => path.relative(MAIN_DIR, f).replace(/\\/g, '/'))
    expect(rel).toContain('swarmMemory.ts')
    expect(rel).toContain('telemetry.ts')
    expect(rel).toContain('aiSecurity.ts') // via memoryAudit — the one that is easy to miss
    expect(rel).toContain('secureKeyStore.ts')
  })

  it('NO module in the graph takes a NAMED import from electron (it is a link-time SyntaxError there)', () => {
    const named = electronImports.filter((i) => {
      const clause = i.text.replace(/^import\s+/, '').replace(/\s*from\s*['"]electron['"].*$/, '')
      if (/^type\b/.test(clause)) return false      // `import type {...}` — erased at build
      if (/^\*\s+as\b/.test(clause)) return false   // namespace import — links fine
      return /\{/.test(clause)                       // `import { app } from 'electron'` — FATAL
    })
    expect(
      named,
      `These modules are reachable from memoryHost.ts and take a NAMED import from 'electron'.\n` +
      `A utilityProcess exports only { default, net, systemPreferences } — a named import of anything\n` +
      `else is a LINK-TIME SyntaxError in ESM, so the memory host dies at load (exit 1) and the store\n` +
      `silently falls back onto the main thread.\n\n` +
      `Fix: use a DEFAULT import (\`import electron from 'electron'\`) and access the property lazily\n` +
      `inside a main-only function, or inject the dependency (see secureKeyStore.setSafeStorage).\n\n` +
      named.map((i) => `  ${i.file}:${i.line}  ${i.text}`).join('\n'),
    ).toEqual([])
  })

  it('memoryClient (MAIN-side) is NOT in the child graph — it may import electron freely', () => {
    // The client is what forks the child; it must never be loaded BY the child. If it ever ends up in
    // this graph, its `import { utilityProcess } from 'electron'` becomes the next silent killer.
    const rel = [...visited].map((f) => path.relative(MAIN_DIR, f).replace(/\\/g, '/'))
    expect(rel).not.toContain('memoryClient.ts')
    expect(rel).not.toContain('index.ts')
  })
})

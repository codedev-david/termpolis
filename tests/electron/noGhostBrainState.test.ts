// The brain's state lives in ANOTHER PROCESS. A main-side value-import of it reads an empty ghost.
//
// v1.26.0 moved swarmMemory + memoryGraph into a utilityProcess (memoryHost). The STORE was
// repointed at memoryClient everywhere. The GRAPH was not — the belief "the graph is still in main"
// got written down three separate times, and every one of them was wrong:
//
//     src/main/index.ts:187       import { graphStats, graphRelationStats } from './memoryGraph'
//     src/main/brainIpc.ts:41     graphSnapshot: exportGraphEdges,   // "the graph is still in main"
//     src/main/brainExport.ts:81  importGraph: (jsonl) => number     // "the graph stays in main"
//
// initMemoryGraph() is called from exactly ONE place — initSwarmMemory (swarmMemory.ts:533) — and
// that runs in the CHILD. So main's `adjacency` Map is empty for the entire life of the app, and
// each of those reads was scrupulously honest about a graph that was not there:
//
//   - the dashboard reported "Connections mapped: 0 — 0 nodes, 0 relation types", against a live
//     4.4 MB memory-graph.jsonl that the child was appending to as it drew
//   - buildBrainArchive() exported a brain .zip containing ZERO edges
//   - mergeBrainArchive() imported edges into a graph nothing reads, then dropped them on exit
//
// Nothing failed. 7,139 tests stayed green, because a behavioural test CANNOT see this:
//   - the unit tests vi.mock('./memoryGraph'), so main gets a populated fake;
//   - brainIpc.test.ts brings the client up with `inProcess: true`, which collapses the two
//     processes into one and makes main's ghost graph and the child's real graph the SAME object.
//
// So the guard is STATIC, and it guards the CLASS, not the three instances: no main-side module may
// value-import the brain's state. Types are fine (erased at compile). The seam — memoryClient (which
// owns the in-process fallback) and memoryHost (which IS the child) — is the only thing allowed to
// reach in.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { HOST_HANDLERS } from '../../src/main/memoryHost'

const MAIN = path.join(__dirname, '..', '..', 'src', 'main')

/** The modules whose state now lives in the memory process. */
const BRAIN_STATE = ['memoryGraph', 'swarmMemory']

/** The seam. memoryClient owns the inproc fallback; memoryHost IS the child; the two modules are
 *  allowed to import each other. Everything else in main talks to the brain through memoryClient. */
const SEAM = new Set(['memoryClient.ts', 'memoryHost.ts', 'memoryGraph.ts', 'swarmMemory.ts'])

function mainSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  }
  walk(MAIN)
  return out
}

/** Every `import ... from './memoryGraph'|'./swarmMemory'` in a source file, with whether it was
 *  type-only (`import type { X } from ...`, erased at compile — harmless). */
function brainImports(src: string): Array<{ typeOnly: boolean; spec: string }> {
  const re = new RegExp(`import\\s+(type\\s+)?([\\s\\S]*?)\\s*from\\s*'\\./(${BRAIN_STATE.join('|')})'`, 'g')
  const out: Array<{ typeOnly: boolean; spec: string }> = []
  for (const m of src.matchAll(re)) out.push({ typeOnly: Boolean(m[1]), spec: m[3] })
  return out
}

describe('no main-side module may value-import the brain’s state', () => {
  it('main talks to the store and the graph through memoryClient — never the modules directly', () => {
    const offenders: string[] = []
    for (const file of mainSources()) {
      const name = path.basename(file)
      if (SEAM.has(name)) continue
      for (const imp of brainImports(fs.readFileSync(file, 'utf8'))) {
        if (!imp.typeOnly) offenders.push(`${name} value-imports './${imp.spec}'`)
      }
    }
    // Each of these reads an empty module singleton in the wrong process. Route it via memoryClient.
    expect(offenders).toEqual([])
  })

  it('type-only imports are still allowed — they are erased and carry no state', () => {
    // Guards the guard: if the regex ever stops distinguishing these, the rule above becomes noise
    // and someone will "fix" a real violation by deleting a type import.
    const client = fs.readFileSync(path.join(MAIN, 'memoryClient.ts'), 'utf8')
    expect(brainImports(client).some((i) => i.typeOnly)).toBe(true)
  })
})

describe('the memory process exposes the whole graph, not just a sample of it', () => {
  // If the child cannot answer these, main has nowhere to route to and the ghost import is the only
  // thing that "works" — which is exactly how it survived the v1.26.0 port.
  it.each(['graphStats', 'graphRelationStats', 'exportGraphEdges', 'importGraphEdges'])(
    'HOST_HANDLERS exposes %s',
    (fn) => {
      expect(typeof HOST_HANDLERS[fn]).toBe('function')
    },
  )
})

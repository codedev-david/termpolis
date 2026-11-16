// Lumopolis acceptance (spec 5.3, quality bar for compiler stages 1 to 6): compile a world for this
// repository's own src/ with no model (llm: null) and check that it recovers the buildings and
// connections of the hand-made v2 prototype (.superpowers/brainstorm/.../world-relationships.html):
// the screen, the gatekeeper, the terminal host, the memory host, the proxy, the gateway, the code
// graph and the remote bridge, as distinct buildings, joined by the connections between them.
//
// The code graph is built in-test from src/ with the real extractor (tree-sitter, heuristic
// fallback), exactly as buildCodeGraph builds it in the app, then snapshotted the way worldClient
// snapshots it for the utility process.
import { readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _resetCodeGraphForTests, buildCodeGraph, graphSnapshot } from '../../src/main/codeGraph'
import { compileWorld } from '../../src/main/world/compile'
import type { Building, WorldDoc, WorldEdge } from '../../src/shared/world/types'

const REPO = resolve(__dirname, '../..').replace(/\\/g, '/')
const KEY = 'lumopolis-acceptance'
const COMPILE_BUDGET_MS = 20_000

/** Every file under src/, absolute and `/`-separated (buildCodeGraph skips what it cannot index). */
function srcFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p)
      } else out.push(p)
    }
  }
  walk(`${REPO}/src`)
  return out.sort()
}

let world: WorldDoc
let compileMs = 0

beforeAll(async () => {
  _resetCodeGraphForTests()
  await buildCodeGraph({ listFiles: async () => srcFiles(), readFile: (f) => readFile(f, 'utf8') }, KEY)
  const snap = graphSnapshot(KEY, REPO)
  const started = performance.now()
  world = await compileWorld(
    { snap, projectKey: KEY, head: { head: '', dirty: false }, previous: null },
    {
      readFile: async (p) => {
        try {
          return await readFile(p, 'utf8')
        } catch {
          return null
        }
      },
      glob: async () => [],
      label: { llm: null, cache: { get: async () => null, set: async () => undefined }, excerpt: async () => '' },
      now: () => 0
    }
  )
  compileMs = performance.now() - started
  // The numbers the task report quotes.
  console.log(
    JSON.stringify(
      {
        compileMs: Math.round(compileMs),
        files: snap.files.length,
        districts: world.districts.map((d) => `${d.id} (${d.members.length})`),
        parts: PROTOTYPE_PARTS.map((p) => `${p} -> ${ownerOf(p)?.id}`),
        boundaryEdges: world.edges.filter((e) => e.label !== 'imports').length,
        buildings: world.buildings.map((b) => `${b.id} [${b.process}] ${b.members.length}`)
      },
      null,
      1
    )
  )
}, 300_000)

afterAll(() => _resetCodeGraphForTests())

/** The building holding `path`: a file, or for a folder ending in '/' the building holding most of its files. */
function ownerOf(path: string): Building | undefined {
  const count = (b: Building): number => b.members.filter((m) => (path.endsWith('/') ? m.startsWith(path) : m === path)).length
  return [...world.buildings].sort((a, z) => count(z) - count(a)).find((b) => count(b) > 0)
}

/** True when the edge carries a boundary of `kind` (fallback labels read "kind key, kind key"). */
function carries(e: WorldEdge, kind: string): boolean {
  return e.label.split(', ').some((part) => part.startsWith(`${kind} `))
}

const processOf = (id: string): string | undefined => world.buildings.find((b) => b.id === id)?.process

const PTY_HOST = 'src/main/ptyHost.ts'
const MAIN = 'src/main/index.ts'
const PRELOAD = 'src/preload/index.ts'

const PROTOTYPE_PARTS = [
  'src/main/memoryHost.ts',
  'src/main/headroomProxy/',
  'src/main/mcpGateway/',
  'src/main/codeGraph.ts',
  'src/main/remoteBridgeSupervisor.ts',
  PRELOAD,
  PTY_HOST
]

describe('Lumopolis acceptance on the Termpolis repository', () => {
  it('has a building for each part of the v2 prototype', () => {
    for (const p of PROTOTYPE_PARTS) expect(ownerOf(p), p).toBeDefined()
  })

  it('keeps those parts in distinct buildings', () => {
    const ids = PROTOTYPE_PARTS.map((p) => ownerOf(p)?.id)
    expect(new Set(ids).size).toBe(PROTOTYPE_PARTS.length)
  })

  // Electron loads the preload into the renderer process, so the preload's ipcRenderer calls are
  // renderer -> main edges; the page reaches the preload over its contextBridge (window.<name>).
  it('joins the renderer and main over IPC', () => {
    const renderer = world.buildings.filter((b) => b.process === 'renderer')
    const main = world.buildings.filter((b) => b.process === 'main')
    expect(renderer.length).toBeGreaterThan(0)
    expect(main.length).toBeGreaterThan(0)
    const ipc = world.edges.filter(
      (e) => carries(e, 'ipc') && [processOf(e.from), processOf(e.to)].sort().join() === 'main,renderer'
    )
    expect(ipc.length).toBeGreaterThan(0)
  })

  it('has main fork the memory host', () => {
    const host = ownerOf('src/main/memoryHost.ts') as Building
    const forks = world.edges.filter((e) => e.to === host.id && carries(e, 'fork'))
    expect(forks.length).toBeGreaterThan(0)
    expect(forks.some((e) => processOf(e.from) === 'main')).toBe(true)
  })

  it('has main reach the proxy by fork or by handing over ANTHROPIC_BASE_URL', () => {
    const proxy = ownerOf('src/main/headroomProxy/') as Building
    const reach = world.edges.filter(
      (e) => e.to === proxy.id && (carries(e, 'fork') || e.label.includes('env ANTHROPIC_BASE_URL'))
    )
    expect(reach.length).toBeGreaterThan(0)
    expect(reach.some((e) => processOf(e.from) === 'main')).toBe(true)
  })

  it('stays within 12 districts and 60 buildings', () => {
    expect(world.districts.length).toBeLessThanOrEqual(12)
    expect(world.buildings.length).toBeLessThanOrEqual(60)
  })

  it('compiles in under 20 seconds', () => {
    expect(compileMs).toBeLessThan(COMPILE_BUDGET_MS)
  })

  it('names the main process entry', () => {
    expect(ownerOf(MAIN)?.process).toBe('main')
  })
})

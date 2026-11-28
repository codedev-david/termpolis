// DSN R5: two processes on one design, every interleaving a seed picks (signoff-decisions.md, "DSN R5"). Each process has
// its own stores and designer, as the world host and main do, and they meet only on disk. Every file read yields a number
// of turns the seed picks, and a lock's pause moves only that process's clock (a fresh one per operation, so a live lock
// never looks stale). The operations: a note on a part the process alone annotates (cold), a note on the part both do
// (hot, past its cap), service names by annotation and by design op, a rename, a removal, a load, a write that fails, and
// a third holder that takes the lock, or leaves a dead one. A design from before DSN R3-2 starts it, its notes unmoved.
import { readFile, rm, stat, utimes, writeFile, mkdtemp, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAnnotationStore, withAnnotations } from '../../src/main/world/annotations'
import { createDesigner, layoutPlacer } from '../../src/main/world/designer'
import { createWorldStore, type WorldStore } from '../../src/main/world/worldStore'
import { createSourceRegistry } from '../../src/main/world/sources'
import { applyDesignPatch, emptyDesignDoc, type DesignOp } from '../../src/shared/world/designPatch'
import { runtimeText } from '../../src/shared/world/runtimeNames'
import type { Claim, WorldDoc } from '../../src/shared/world/types'

const SEEDS = 200
const OPS_PER_PROCESS = 8
const KEY = 'design:id1'
const HOT = 'e-api--db'
const OWN = { A: { part: 'api', spare: 'spareA' }, B: { part: 'db', spare: 'spareB' } } as const
type Name = keyof typeof OWN

/** mulberry32: a small seeded generator, so a failing seed runs again the same. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const turn = (): Promise<void> => new Promise<void>((r) => { setImmediate(r) })
const agentNote = (text: string): Claim => ({ text, state: 'observed', evidence: [{ kind: 'transcriptStep', ref: 'noted by an agent through world_annotate' }] })
const personNote = (text: string): Claim => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] })

const LEGACY_OPS: DesignOp[] = [
  { op: 'addDistrict', id: 'core', name: 'Core' },
  { op: 'addBuilding', id: 'api', districtId: 'core', name: 'Orders API' },
  { op: 'addBuilding', id: 'db', districtId: 'core', name: 'Database' },
  { op: 'addBuilding', id: 'spareA', districtId: 'core', name: 'Spare A' },
  { op: 'addBuilding', id: 'spareB', districtId: 'core', name: 'Spare B' },
  { op: 'addEdge', from: 'api', to: 'db', label: 'stores orders' }
]
const legacyNotes = (part: string, n: number): string[] => Array.from({ length: n }, (_, i) => `legacy-${part}-${i}`)

/** The design as a version before DSN R3-2 saved it: its notes in the file, a part's names set by hand, no store. */
async function legacyDesign(dir: string): Promise<void> {
  const doc = applyDesignPatch(emptyDesignDoc(KEY, 1), LEGACY_OPS, layoutPlacer).doc
  const notesOf: Record<string, string[]> = { api: legacyNotes('api', 3), db: legacyNotes('db', 3), [HOT]: legacyNotes('hot', 22), spareA: legacyNotes('spareA', 1) }
  doc.buildings = doc.buildings.map((b) => ({ ...b, claims: (notesOf[b.id] ?? []).map(agentNote) }))
  doc.edges = doc.edges.map((e) => ({ ...e, claims: (notesOf[e.id] ?? []).map(agentNote) }))
  doc.runtimeNames = { api: ['legacy-api'] }
  doc.runtimeHandSet = ['api']
  await createWorldStore(dir).save(doc)
}

interface Process {
  name: Name
  store: WorldStore
  designer: ReturnType<typeof createDesigner>
  failNextWrite: { on: boolean }
  /** Acknowledged, in order: notes on its cold part, notes on the hot part, names, building names. */
  acked: { cold: string[]; hot: string[]; names: string[][]; title: string[]; removed: boolean }
  /** Edits that reported failure after the last acknowledged one (a failed edit's undo is best effort). */
  failedNames: string[][]
  failedTitles: string[]
  failedNotes: string[]
  /** Hot notes seen gone after this process saw them (the cap took them). */
  evicted: Set<string>
}

function makeProcess(name: Name, dir: string, random: () => number): Process {
  let slept = 0
  const opClock = { start: Date.now() }
  const now = (): number => opClock.start + slept
  const sleep = async (ms: number): Promise<void> => { slept += ms; await turn() }
  const yieldSome = async (): Promise<void> => { for (let i = Math.floor(random() * 4); i > 0; i--) await turn() }
  const failNextWrite = { on: false }
  const annotationsDeps = {
    now, sleep,
    readFile: async (file: string, enc: 'utf8'): Promise<string> => { await yieldSome(); const text = await readFile(file, enc); await yieldSome(); return text },
    writeFileAtomic: async (file: string, text: string, write: (file: string, text: string) => Promise<void>): Promise<void> => {
      if (failNextWrite.on) { failNextWrite.on = false; throw Object.assign(new Error('EIO'), { code: 'EIO' }) }
      await yieldSome()
      return write(file, text)
    }
  }
  const annotations = createAnnotationStore(dir, annotationsDeps)
  const worldDeps = { readFile: (async (file: string, enc: 'utf8') => { await yieldSome(); return readFile(file, enc) }) as never }
  const store = withAnnotations(createWorldStore(dir, worldDeps), annotations)
  const registry = createSourceRegistry(dir, { exists: async () => true, now: () => 7 })
  const designer = createDesigner({
    exec: (async () => { throw new Error('no agent run') }) as never, execDeps: { deliver: () => undefined } as never, store, registry,
    agent: () => 'claude', runEnv: async () => ({ env: {} }), designsDir: join(dir, 'world', 'designs'), newId: () => `${name}-new`,
    annotations
  })
  const p: Process = {
    name, store, designer, failNextWrite,
    acked: { cold: [], hot: [], names: [], title: [], removed: false }, failedNames: [], failedTitles: [], failedNotes: [], evicted: new Set()
  }
  // Each operation starts on a fresh clock: a lock's age is real time, its deadline this operation's pauses.
  ;(p as Process & { fresh: () => void }).fresh = () => { slept = 0; opClock.start = Date.now() }
  return p
}

const textsOn = (doc: WorldDoc, id: string): string[] => ([...doc.buildings, ...doc.edges].find((x) => x.id === id)?.claims ?? []).map((c) => c.text)
const ok = async (p: Promise<unknown>): Promise<boolean> => p.then(() => true, () => false)

async function third(dir: string, random: () => number): Promise<void> {
  const lockFile = `${join(dir, 'world', 'annotations', createHash('sha256').update(KEY).digest('hex'))}.json.lock`
  const mine = `third holder ${random()}`
  await mkdir(join(dir, 'world', 'annotations'), { recursive: true })
  // Takes the lock over a holder (as one that broke it would), or makes it, or leaves one a dead holder left.
  // Windows refuses a write over a lock a holder is deleting just then (EPERM): this take-over then did not happen.
  if (!(await writeFile(lockFile, mine).then(() => true, () => false))) return
  if (random() < 0.3) {
    const old = new Date(Date.now() - 60_000)
    // A holder releasing just then may have removed it: there is then no dead holder to leave.
    await utimes(lockFile, old, old).catch(() => undefined)
    return
  }
  for (let i = 1 + Math.floor(random() * 6); i > 0; i--) await turn()
  if ((await readFile(lockFile, 'utf8').catch(() => '')) === mine) await rm(lockFile, { force: true })
}

async function run(p: Process, other: Process, dir: string, random: () => number, seed: number): Promise<void> {
  const own = OWN[p.name]
  for (let i = 0; i < OPS_PER_PROCESS; i++) {
    ;(p as Process & { fresh: () => void }).fresh()
    const pick = Math.floor(random() * 9)
    const tag = `${p.name}${seed}-${i}`
    if (pick === 0) {
      const text = `cold-${tag}`
      if (await ok(p.designer.annotate(KEY, own.part, agentNote(text)))) p.acked.cold.push(text)
      else p.failedNotes.push(text)
    } else if (pick === 1) {
      const text = `hot-${tag}`
      const doc = await p.designer.annotate(KEY, HOT, agentNote(text)).catch(() => null)
      if (doc) {
        p.acked.hot.push(text)
        const shown = textsOn(doc, HOT)
        for (const t of [...p.acked.hot, ...other.acked.hot]) if (!shown.includes(t) && t !== text) p.evicted.add(t)
      } else p.failedNotes.push(text)
    } else if (pick === 2) {
      const names = [`via-note-${tag}`]
      if (await ok(p.designer.annotate(KEY, own.part, personNote(runtimeText(names))))) { p.acked.names.push(names); p.failedNames = [] }
      else p.failedNames.push(names)
    } else if (pick === 3) {
      const names = [`via-op-${tag}`]
      if (await ok(p.designer.propose({ key: KEY }, [{ op: 'setRuntimeNames', id: own.part, names }]))) { p.acked.names.push(names); p.failedNames = [] }
      else p.failedNames.push(names)
    } else if (pick === 4) {
      const title = `Title ${tag}`
      if (await ok(p.designer.propose({ key: KEY }, [{ op: 'rename', id: own.part, name: title }]))) { p.acked.title.push(title); p.failedTitles = [] }
      else p.failedTitles.push(title)
    } else if (pick === 5) {
      if (!p.acked.removed && (await ok(p.designer.propose({ key: KEY }, [{ op: 'remove', id: own.spare }])))) p.acked.removed = true
    } else if (pick === 6) {
      const doc = (await p.store.load(KEY).catch(() => null)) as WorldDoc | null
      if (doc) for (const part of [...doc.buildings, ...doc.edges]) expect(new Set(part.claims.map((c) => JSON.stringify(c))).size, `seed ${seed}: a note twice on ${part.id}`).toBe(part.claims.length)
    } else if (pick === 7) {
      p.failNextWrite.on = true
      const text = `failed-${tag}`
      expect(await ok(p.designer.annotate(KEY, own.part, agentNote(text))), `seed ${seed}: a failing write was acknowledged`).toBe(false)
      p.failNextWrite.on = false
      p.failedNotes.push(text)
    } else {
      await third(dir, random)
    }
  }
}

describe('two processes on one design, any interleaving (DSN R5)', () => {
  let root = ''
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'world-interleave-')) })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it(`loses no acknowledged note, brings back no evicted one, keeps each note once and every acknowledged edit (${SEEDS} seeds)`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const dir = join(root, `s${seed}`)
      await mkdir(dir, { recursive: true })
      await legacyDesign(dir)
      const random = rng(seed)
      const a = makeProcess('A', dir, random)
      const b = makeProcess('B', dir, random)
      await Promise.all([run(a, b, dir, random, seed), run(b, a, dir, random, seed)])
      // A dead holder's lock is taken over by the next writer; the check reads with a fresh store, and no lock left.
      await rm(join(dir, 'world', 'annotations', `${createHash('sha256').update(KEY).digest('hex')}.json.lock`), { force: true })
      const doc = (await withAnnotations(createWorldStore(dir), createAnnotationStore(dir)).load(KEY)) as WorldDoc
      const at = `seed ${seed}`
      for (const part of [...doc.buildings, ...doc.edges]) {
        expect(new Set(part.claims.map((c) => JSON.stringify(c))).size, `${at}: a note twice on ${part.id}`).toBe(part.claims.length)
      }
      const hot = textsOn(doc, HOT)
      for (const p of [a, b]) {
        const own = OWN[p.name]
        const cold = textsOn(doc, own.part)
        for (const t of p.acked.cold) expect(cold, `${at}: ${p.name}'s acknowledged note ${t} lost`).toContain(t)
        for (const t of p.evicted) expect(hot, `${at}: evicted ${t} came back`).not.toContain(t)
        for (const t of p.failedNotes.filter((n) => n.startsWith('failed-'))) expect([...cold, ...hot], `${at}: ${t} shows`).not.toContain(t)
        if (p.acked.names.length > 0) {
          const last = p.acked.names[p.acked.names.length - 1]
          expect([last, ...p.failedNames], `${at}: ${p.name}'s names ${JSON.stringify(last)} stripped`).toContainEqual(doc.runtimeNames[own.part] ?? [])
        }
        if (p.acked.title.length > 0) {
          const title = doc.buildings.find((x) => x.id === own.part)!.name
          expect([p.acked.title[p.acked.title.length - 1], ...p.failedTitles], `${at}: ${p.name}'s title stripped`).toContain(title)
        }
        if (p.acked.removed) expect(doc.buildings.some((x) => x.id === own.spare), `${at}: removed ${own.spare} came back`).toBe(false)
      }
      // The legacy notes past the cap (the hot part's oldest two) never show.
      expect(hot, `${at}: a note past the cap shows`).not.toContain('legacy-hot-0')
      expect(hot, `${at}: a note past the cap shows`).not.toContain('legacy-hot-1')
      expect(hot.length).toBeLessThanOrEqual(20)
      // The lock file is never left by either process.
      expect(await stat(join(dir, 'world', 'annotations')).then(() => true, () => false)).toBe(true)
    }
  }, 600_000)
})

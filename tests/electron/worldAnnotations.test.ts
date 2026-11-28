import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cardText } from '../../src/main/world/cardText'
import { filterWorld } from '../../src/main/world/worldHost'
import { minimal } from '../renderer/world/helpers'
import {
  addClaim,
  createAnnotationStore,
  hasPart,
  MAX_ANNOTATION_EVIDENCE,
  MAX_ANNOTATION_TEXT,
  MAX_EVIDENCE_EXCERPT,
  MAX_EVIDENCE_REF,
  MAX_ANNOTATIONS_PER_ITEM,
  MIGRATED_KEY,
  mergeAnnotations,
  mergeDesign,
  MOVED_SUFFIX,
  withAnnotations,
  withClaim,
  withoutStored
} from '../../src/main/world/annotations'
import { CLAIM_TRIES } from '../../src/main/world/storeFiles'
import { createWorldStore, WORLD_READ_FAILED, WorldReadError, worldFileName } from '../../src/main/world/worldStore'
import type { Claim, WorldDoc } from '../../src/shared/world/types'
import { runtimeText } from '../../src/shared/world/runtimeNames'

const person = (text: string): Claim => ({
  text,
  state: 'verified',
  evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }]
})

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-annot-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const hashOf = (key: string): string => createHash('sha256').update(key).digest('hex')
const folder = (): string => join(dir, 'world', 'annotations')
const fileFor = (key: string): string => join(folder(), `${hashOf(key)}.json`)

describe('annotation store', () => {
  it('lists nothing before any add, and stores under a sha256 file name', async () => {
    const store = createAnnotationStore(dir)
    expect(await store.list('../evil key')).toEqual({})
    await store.add('../evil key', 'b1', person('ok'))
    expect(await store.list('../evil key')).toEqual({ b1: [person('ok')] })
    expect(await readdir(folder())).toEqual([`${hashOf('../evil key')}.json`])
    expect(await store.list('other')).toEqual({})
  })

  it('caps text at 400 and evidence at 8, and keeps an excerpt', async () => {
    const store = createAnnotationStore(dir)
    expect(MAX_ANNOTATION_TEXT).toBe(400)
    expect(MAX_ANNOTATION_EVIDENCE).toBe(8)
    const evidence = Array.from({ length: 12 }, (_, i) => ({ kind: 'file' as const, ref: `f${i}.ts:1`, ...(i === 0 ? { excerpt: 'x' } : {}) }))
    await store.add('k', 'b1', { text: 'a'.repeat(900), state: 'verified', evidence })
    const [c] = (await store.list('k')).b1
    expect(c.text).toHaveLength(400)
    expect(c.evidence).toHaveLength(8)
    expect(c.evidence[0]).toEqual({ kind: 'file', ref: 'f0.ts:1', excerpt: 'x' })
  })

  // HOLD-B #92: a test's excerpt is where its result came from ("from a test report", testStatus.ts), shown on the card
  // (cardFacts evidenceText). Only the test status may say that: a note an agent wrote never carries one.
  it('keeps no excerpt on a note\'s test evidence, written or read back, and keeps every other kind\'s', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'b1', {
      text: 'the tests pass', state: 'verified',
      evidence: [{ kind: 'test', ref: 'a.test.ts', excerpt: 'from a test report' }, { kind: 'file', ref: 'a.ts:1', excerpt: 'x' }],
    })
    expect((await store.list('k')).b1[0].evidence).toEqual([{ kind: 'test', ref: 'a.test.ts' }, { kind: 'file', ref: 'a.ts:1', excerpt: 'x' }])
    expect(JSON.parse(await readFile(fileFor('k'), 'utf8')).b1[0].evidence[0]).toEqual({ kind: 'test', ref: 'a.test.ts' })
    // One an older build wrote is read back without it.
    await writeFile(fileFor('k'), JSON.stringify({ b2: [{ text: 'old', state: 'verified', evidence: [{ kind: 'test', ref: 't', excerpt: 'from CI (gh)' }] }] }))
    expect((await store.list('k')).b2[0].evidence).toEqual([{ kind: 'test', ref: 't' }])
  })

  it('caps an evidence ref at 512 and an excerpt at 400, ending in an ellipsis, and leaves shorter ones alone', async () => {
    const store = createAnnotationStore(dir)
    expect([MAX_EVIDENCE_REF, MAX_EVIDENCE_EXCERPT]).toEqual([512, 400])
    await store.add('k', 'b1', {
      text: 't', state: 'observed',
      evidence: [
        { kind: 'file', ref: 'r'.repeat(900), excerpt: 'e'.repeat(900) },
        { kind: 'file', ref: 'r'.repeat(512), excerpt: 'e'.repeat(400) },
        { kind: 'file', ref: 'r'.repeat(900) }
      ]
    })
    const ev = (await store.list('k')).b1[0].evidence
    expect(ev[0].ref).toBe(`${'r'.repeat(511)}…`)
    expect(ev[0].excerpt).toBe(`${'e'.repeat(399)}…`)
    expect(ev[1]).toEqual({ kind: 'file', ref: 'r'.repeat(512), excerpt: 'e'.repeat(400) })
    expect(ev[2]).toEqual({ kind: 'file', ref: `${'r'.repeat(511)}…` })
  })

  it('cardText and world_read echo only the capped evidence', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'b1', { text: 'noted', state: 'observed', evidence: [{ kind: 'file', ref: 'r'.repeat(900), excerpt: 'e'.repeat(900) }] })
    const world = minimal()
    world.buildings[0].how = (await store.list('k')).b1
    const id = world.buildings[0].id
    const text = cardText(world, id)
    expect(text).toContain('r'.repeat(511) + '…')
    expect(text).not.toContain('r'.repeat(512))
    const read = filterWorld(world, { ids: [id] })
    const echoed = read.evidence.find((e) => e.ref.startsWith('rrrr'))
    expect(echoed?.ref).toHaveLength(512)
    expect(echoed?.excerpt).toHaveLength(400)
  })

  it('keeps 20 per item, dropping the oldest', async () => {
    const store = createAnnotationStore(dir)
    expect(MAX_ANNOTATIONS_PER_ITEM).toBe(20)
    for (let i = 0; i < 23; i++) await store.add('k', 'b1', person(`n${i}`))
    const list = (await store.list('k')).b1
    expect(list).toHaveLength(20)
    expect(list[0].text).toBe('n3')
    expect(list[19].text).toBe('n22')
  })

  it('concurrent adds on one world all land', async () => {
    const store = createAnnotationStore(dir)
    await Promise.all(Array.from({ length: 6 }, (_, i) => store.add('k', `b${i % 2}`, person(`n${i}`))))
    const all = await store.list('k')
    expect(all.b0).toHaveLength(3)
    expect(all.b1).toHaveLength(3)
  })

  it('rejects a claim without text, a known state or usable evidence', async () => {
    const store = createAnnotationStore(dir)
    const bads: unknown[] = [
      null,
      'x',
      { text: 1, state: 'verified', evidence: [] },
      { text: 'a', state: 'weird', evidence: [{ kind: 'person', ref: 'r' }] },
      { text: 'a', state: 'verified', evidence: 'no' },
      { text: 'a', state: 'verified', evidence: [] },
      { text: 'a', state: 'verified', evidence: [{ kind: 'bogus', ref: 'r' }, null, { kind: 'file', ref: 3 }] }
    ]
    for (const bad of bads) {
      await expect(store.add('k', 'b1', bad as Claim)).rejects.toThrow('annotation needs text, a state and evidence')
    }
    expect(await store.list('k')).toEqual({})
  })

  it('a corrupt file reads as empty; the next add moves it aside to a numbered backup first, then starts fresh (X1)', async () => {
    const at = Date.UTC(2026, 10, 23, 1, 2, 3, 4)
    const store = createAnnotationStore(dir, { now: () => at })
    await mkdir(folder(), { recursive: true })
    await writeFile(fileFor('k'), '{"b1":[{"text":"made by a person"', 'utf8')
    expect(await store.list('k')).toEqual({})
    await store.add('k', 'b1', person('fresh'))
    expect(await store.list('k')).toEqual({ b1: [person('fresh')] })
    expect(await readFile(`${fileFor('k')}.2026-11-23T01-02-03-004Z-1.bad`, 'utf8')).toBe('{"b1":[{"text":"made by a person"')
  })

  it('a corrupt file that cannot be moved aside refuses the add and stays as it was (X1)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const at = Date.UTC(2026, 10, 23, 1, 2, 3, 4)
      const file = fileFor('k')
      // every backup name is taken by the time the store claims one
      const crowded = (): number => {
        for (let n = 1; n <= CLAIM_TRIES; n++) writeFileSync(`${file}.2026-11-23T01-02-03-004Z-${n}.bad`, 'taken')
        return at
      }
      const store = createAnnotationStore(dir, { now: crowded })
      await mkdir(folder(), { recursive: true })
      await writeFile(file, '{broken', 'utf8')
      const err = await store.add('k', 'b1', person('fresh')).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(WorldReadError)
      expect(err).toMatchObject({ code: 'ANNOTATIONS_READ_FAILED', message: WORLD_READ_FAILED })
      expect(await readFile(file, 'utf8')).toBe('{broken')
      expect(warn).toHaveBeenCalledWith("[world annotations] a world's annotations do not parse and could not be moved aside, so nothing was added")
    } finally {
      warn.mockRestore()
    }
  })

  describe('a file that parses but holds notes this version cannot read is backed up before an add (N1)', () => {
    const at = Date.UTC(2026, 10, 23, 1, 2, 3, 4)
    const backup = (): string => `${fileFor('k')}.2026-11-23T01-02-03-004Z-1.bad`
    const older = (over: Record<string, unknown>): Record<string, unknown> => ({ text: 'made by a person', state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }], ...over })
    const cases: Array<[string, unknown]> = [
      ['an unknown evidence kind', { b1: [older({ evidence: [{ kind: 'review', ref: 'a later kind' }] })] }],
      ['an unknown claim state', { b1: [older({ state: 'disputed' })] }],
      ['another top-level shape', { version: 2, items: { b1: [older({})] } }],
    ]
    for (const [what, onDisk] of cases) {
      it(`${what}: the file as it was goes to a numbered backup, then the add lands`, async () => {
        const store = createAnnotationStore(dir, { now: () => at })
        await mkdir(folder(), { recursive: true })
        const bytes = JSON.stringify(onDisk)
        await writeFile(fileFor('k'), bytes, 'utf8')
        await store.add('k', 'b2', person('fresh'))
        expect(await readFile(backup(), 'utf8')).toBe(bytes)
        expect((await store.list('k')).b2).toEqual([person('fresh')])
        // the file is clean now: a second add makes no second backup
        await store.add('k', 'b2', person('again'))
        expect((await readdir(folder())).filter((f) => f.endsWith('.bad'))).toEqual([`${hashOf('k')}.json.2026-11-23T01-02-03-004Z-1.bad`])
      })
    }

    it('a file this version reads in full makes no backup', async () => {
      const store = createAnnotationStore(dir, { now: () => at })
      await store.add('k', 'b1', person('first'))
      await store.add('k', 'b1', person('second'))
      expect((await readdir(folder())).filter((f) => f.endsWith('.bad'))).toEqual([])
    })

    it('a backup that cannot be made refuses the add and leaves the file as it was', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const file = fileFor('k')
        const crowded = (): number => {
          for (let n = 1; n <= CLAIM_TRIES; n++) writeFileSync(`${file}.2026-11-23T01-02-03-004Z-${n}.bad`, 'taken')
          return at
        }
        const store = createAnnotationStore(dir, { now: crowded })
        await mkdir(folder(), { recursive: true })
        const bytes = JSON.stringify(cases[0][1])
        await writeFile(file, bytes, 'utf8')
        const err = await store.add('k', 'b2', person('fresh')).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(WorldReadError)
        expect(err).toMatchObject({ code: 'ANNOTATIONS_READ_FAILED', message: WORLD_READ_FAILED })
        expect(await readFile(file, 'utf8')).toBe(bytes)
        expect(warn).toHaveBeenCalledWith("[world annotations] a world's annotations hold notes this version cannot read and could not be backed up, so nothing was added")
      } finally {
        warn.mockRestore()
      }
    })
  })

  it('a file another program holds is read again; held through every try, the add is refused and nothing is wiped (X1)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await createAnnotationStore(dir).add('k', 'b1', person('first'))
      const before = await readFile(fileFor('k'), 'utf8')
      const held = (): Error => Object.assign(new Error(`EBUSY: resource busy, open '${fileFor('k')}'`), { code: 'EBUSY' })
      // held for a moment: read again, and the add lands beside the first
      let refusals = 2
      const waits: number[] = []
      const brief = createAnnotationStore(dir, {
        sleep: async (ms) => { waits.push(ms) },
        readFile: async (file, enc) => { if (refusals-- > 0) throw held(); return readFile(file, enc) }
      })
      await brief.add('k', 'b1', person('second'))
      expect(waits).toEqual([100, 200])
      expect((await brief.list('k')).b1.map((c) => c.text)).toEqual(['first', 'second'])
      const kept = await readFile(fileFor('k'), 'utf8')
      // held through every try: refused with the fixed, path-free error, the raw one only in the log
      const stuck = createAnnotationStore(dir, { sleep: async () => undefined, readFile: async () => { throw held() } })
      const err = await stuck.add('k', 'b1', person('third')).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(WorldReadError)
      expect(err).toMatchObject({ code: 'ANNOTATIONS_READ_FAILED', message: WORLD_READ_FAILED })
      expect(String((err as Error).message)).not.toContain(dir)
      expect(warn.mock.calls[0][0]).toMatch(/^\[world annotations\] a world's annotations could not be read, so nothing was added: Error: EBUSY/)
      expect(await readFile(fileFor('k'), 'utf8')).toBe(kept)
      expect(kept).not.toBe(before)
      // a display read of the held file shows nothing, and writes nothing
      expect(await stuck.list('k')).toEqual({})
      expect(await readFile(fileFor('k'), 'utf8')).toBe(kept)
    } finally {
      warn.mockRestore()
    }
  })

  it('any other read error (a folder in the file\'s place) refuses the add at once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const store = createAnnotationStore(dir, { sleep: async () => { throw new Error('no wait expected') } })
      await mkdir(fileFor('k'), { recursive: true })
      await writeFile(join(fileFor('k'), 'keep'), 'x', 'utf8')
      await expect(store.add('k', 'b1', person('x'))).rejects.toBeInstanceOf(WorldReadError)
      expect(await readFile(join(fileFor('k'), 'keep'), 'utf8')).toBe('x')
    } finally {
      warn.mockRestore()
    }
  })

  it('drops what is malformed inside a readable file', async () => {
    const store = createAnnotationStore(dir)
    await mkdir(folder(), { recursive: true })
    await writeFile(fileFor('arr'), '[1,2]', 'utf8')
    expect(await store.list('arr')).toEqual({})
    await writeFile(fileFor('mixed'), JSON.stringify({ b1: [person('good'), { text: 'bad' }, 4], b2: 'not a list', b3: [{ text: 'bad' }] }), 'utf8')
    expect(await store.list('mixed')).toEqual({ b1: [person('good')] })
  })

  it('a failed write leaves no temp file and reports the error', async () => {
    // the read finds the file empty; the final rename onto the folder in its place then fails
    const store = createAnnotationStore(dir, { readFile: async () => '{}' })
    // A non-empty folder where the file should go makes the final rename fail.
    await mkdir(fileFor('k'), { recursive: true })
    await writeFile(join(fileFor('k'), 'keep'), 'x', 'utf8')
    await expect(store.add('k', 'b1', person('x'))).rejects.toBeTruthy()
    expect((await readdir(folder())).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(await readFile(join(fileFor('k'), 'keep'), 'utf8')).toBe('x')
  })
})

const doc = (): WorldDoc =>
  ({
    buildings: [
      { id: 'b1', claims: [{ text: 'seen', state: 'observed', evidence: [{ kind: 'file', ref: 'a.ts:1' }] }, person('stale')] },
      { id: 'b2', claims: [] }
    ],
    edges: [{ id: 'e1', claims: [] }]
  }) as unknown as WorldDoc

describe('mergeAnnotations and hasPart', () => {
  it('replaces person claims with the stored ones, by item id, idempotently', () => {
    const once = mergeAnnotations(doc(), { b1: [person('fresh')], e1: [person('edge')] })
    expect(once.buildings[0].claims.map((c) => c.text)).toEqual(['seen', 'fresh'])
    expect(once.buildings[1].claims).toEqual([])
    expect(once.edges[0].claims).toEqual([person('edge')])
    expect(mergeAnnotations(once, { b1: [person('fresh')], e1: [person('edge')] })).toEqual(once)
    expect(mergeAnnotations(once, {}).buildings[0].claims.map((c) => c.text)).toEqual(['seen'])
  })

  it('drops only a claim exactly equal to a stored one: the same words with other evidence or another state stay (DSN R2, F1)', () => {
    const agent: Claim = { text: 'Calls the bank.', state: 'observed', evidence: [{ kind: 'transcriptStep', ref: 'noted by an agent' }] }
    const inFile: Claim = { text: 'Calls the bank.', state: 'observed', evidence: [{ kind: 'file', ref: 'bank.ts:1' }] }
    const otherState: Claim = { ...agent, state: 'inferred' }
    const d = doc()
    d.buildings[1].claims = [inFile, otherState, agent, { ...agent, evidence: [{ ...agent.evidence[0] }] }]
    expect(mergeAnnotations(d, { b2: [agent] }).buildings[1].claims).toEqual([inFile, otherState, agent])
  })

  it('an id like "constructor" or "__proto__" picks up nothing from the prototype', () => {
    const d = doc()
    d.buildings[1].id = 'constructor'
    d.edges[0].id = '__proto__'
    const m = mergeAnnotations(d, {})
    expect(m.buildings[1].claims).toEqual([])
    expect(m.edges[0].claims).toEqual([])
  })

  it('hasPart is true for buildings and edges only', () => {
    expect(hasPart(doc(), 'b2')).toBe(true)
    expect(hasPart(doc(), 'e1')).toBe(true)
    expect(hasPart(doc(), 'd1')).toBe(false)
  })
})

describe('runtime-names claims', () => {
  const rt = (names: string): Claim => ({ ...person(`runtime:${names}`) })

  it('are kept out of the card and out of the 20-claim cap, one per item, with checked names', async () => {
    const store = createAnnotationStore(dir)
    for (let i = 0; i < MAX_ANNOTATIONS_PER_ITEM + 3; i++) await store.add('k', 'b1', person(`n${i}`))
    await store.add('k', 'b1', rt('a,b'))
    await store.add('k', 'b1', rt('c d,ok.1,' + 'x'.repeat(70)))
    const list = (await store.list('k')).b1
    expect(list.filter((c) => !c.text.startsWith('runtime:'))).toHaveLength(MAX_ANNOTATIONS_PER_ITEM)
    expect(list.filter((c) => c.text.startsWith('runtime:')).map((c) => c.text)).toEqual(['runtime:ok.1'])
    const long = Array.from({ length: 30 }, (_, i) => `service-name-${i}`).join(',')
    await store.add('k', 'b2', rt(long))
    expect((await store.list('k')).b2[0].text.split(',')).toHaveLength(10)
    // The same rules apply to what a file holds.
    await writeFile(fileFor('f'), JSON.stringify({ b1: [rt('a'), rt('b'), person('n')] }))
    expect((await store.list('f')).b1.map((c) => c.text)).toEqual(['n', 'runtime:b'])
  })

  it('merge into runtimeNames, not into claims; an empty claim clears; design worlds and idempotence hold', () => {
    const d = doc()
    d.runtimeNames = { b1: ['from-otel'], b2: ['keep'] }
    const m = mergeAnnotations(d, { b1: [person('n'), rt('hand-1,hand-2')], b2: [rt('')], e1: [rt('edge-x')] })
    expect(m.runtimeNames).toEqual({ b1: ['hand-1', 'hand-2'], e1: ['edge-x'] })
    expect(m.buildings[0].claims.map((c) => c.text)).toEqual(['seen', 'n'])
    expect(m.buildings[1].claims).toEqual([])
    expect(mergeAnnotations(m, { b1: [person('n'), rt('hand-1,hand-2')], b2: [rt('')], e1: [rt('edge-x')] })).toEqual(m)
    expect(d.runtimeNames.b1).toEqual(['from-otel'])
    expect(mergeAnnotations(doc(), {}).runtimeNames).toEqual({})
    // hand-set parts are marked (sorted), an unedited doc has no marker, and a stale marker is dropped
    expect(m.runtimeHandSet).toEqual([...(m.runtimeHandSet ?? [])].sort())
    expect(m.runtimeHandSet?.length).toBeGreaterThan(0)
    expect('runtimeHandSet' in mergeAnnotations(doc(), {})).toBe(false)
    expect('runtimeHandSet' in mergeAnnotations({ ...doc(), runtimeHandSet: ['old'] }, {})).toBe(false)
  })
})

// WP5: ids that collided are renamed once, and the annotations made under the old ids are copied to them (fix I2: copied, so a
// migration that stops part way loses nothing; the old ids keep theirs).
describe('annotation store copyRenamed (WP5)', () => {
  it('copies an item to its new id, after any it has there already, a claim held under both kept once, the old id keeping its own', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'x-api-foo-com', person('old note'))
    await store.add('k', 'x-api-foo-com', person('shared'))
    await store.add('k', 'x-api-foo-com--abc123', person('shared'))
    await store.add('k', 'b-keep', person('untouched'))
    await store.copyRenamed('k', { 'x-api-foo-com': 'x-api-foo-com--abc123', 'b-gone': 'b-new' })
    // The file keeps the old id's claims (an older build still finds them); HOLD-B #37: this build no longer shows them there.
    expect(JSON.parse(await readFile(fileFor('k'), 'utf8'))).toEqual({
      'x-api-foo-com': [person('old note'), person('shared')],
      'x-api-foo-com--abc123': [person('shared'), person('old note')],
      'b-keep': [person('untouched')],
    })
    expect(await store.list('k')).toEqual({
      'x-api-foo-com--abc123': [person('shared'), person('old note')],
      'b-keep': [person('untouched')],
    })
  })

  it('writes nothing when no id it holds is renamed, nor when every claim is under its new id already, nor when there is no file', async () => {
    const store = createAnnotationStore(dir)
    await store.copyRenamed('none', { a: 'b' })
    expect(await readdir(dir)).toEqual([])
    await store.add('k', 'b1', person('n'))
    await store.add('k', 'b2', person('n'))
    const before = await readFile(fileFor('k'), 'utf8')
    await writeFile(fileFor('k'), before.replace('{', '{ ')) // a mark a rewrite would remove
    await store.copyRenamed('k', { b3: 'b4' })
    await store.copyRenamed('k', { b1: 'b2', b2: 'b2' })
    expect(await readFile(fileFor('k'), 'utf8')).toBe(before.replace('{', '{ '))
  })

  it('caps the merged item as an add caps it', async () => {
    const store = createAnnotationStore(dir)
    for (let i = 0; i < MAX_ANNOTATIONS_PER_ITEM; i++) await store.add('k', 'old', person(`o${i}`))
    for (let i = 0; i < 5; i++) await store.add('k', 'new', person(`n${i}`))
    await store.copyRenamed('k', { old: 'new' })
    const list = (await store.list('k')).new
    expect(list).toHaveLength(MAX_ANNOTATIONS_PER_ITEM)
    expect(list[list.length - 1]).toEqual(person('o19'))
    expect(JSON.parse(await readFile(fileFor('k'), 'utf8')).old).toHaveLength(MAX_ANNOTATIONS_PER_ITEM)
  })

  it('copies once when another writer (the other world host store) copies at the same time', async () => {
    await createAnnotationStore(dir).add('k', 'old', person('n'))
    const [a, b] = [createAnnotationStore(dir), createAnnotationStore(dir)]
    await Promise.all([a.copyRenamed('k', { old: 'new' }), b.copyRenamed('k', { old: 'new' })])
    expect(JSON.parse(await readFile(fileFor('k'), 'utf8'))).toEqual({ old: [person('n')], new: [person('n')] })
    expect(await a.list('k')).toEqual({ new: [person('n')] })
  })

  // HOLD-B #37 (WP5 M4/N3): the old id keeps its claims in the file, so a different part that later gets that id must not
  // show them. The case that happens: a namesake folder comes (A's id gets a suffix), then A goes (its namesake takes the
  // plain id back). A's notes stayed under the plain id, and showed on the namesake.
  it('a part that later gets an id renamed away does not show the claims that were copied from it', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'b-foo', person('about A'))
    await store.copyRenamed('k', { 'b-foo': 'b-foo--a1' }) // B comes: A takes a suffix
    await store.add('k', 'b-foo--b2', person('about B'))
    await store.copyRenamed('k', { 'b-foo--b2': 'b-foo' }) // A goes: B takes the plain id back
    expect((await store.list('k'))['b-foo']).toEqual([person('about B')])
    expect(JSON.parse(await readFile(fileFor('k'), 'utf8'))['b-foo']).toEqual([person('about A'), person('about B')])
  })

  // holdb-codex-review MAJOR: a rename copies only the claims the old id shows. Those the record hides under it were copied
  // away from it before and belong to another part, which must not show them twice.
  it('a part moved off an id that another part left copies only its own claims, not the hidden ones of the part before', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'foo', person('about A'))
    await store.copyRenamed('k', { foo: 'foo--a' }) // A moves off foo
    await store.add('k', 'foo', person('about B')) // B, which took foo, gets a note
    await store.copyRenamed('k', { foo: 'foo--b' }) // and B moves off foo too
    expect(await store.list('k')).toEqual({ 'foo--a': [person('about A')], 'foo--b': [person('about B')] })
    // The old id keeps both in the file, for an older build.
    expect(JSON.parse(await readFile(fileFor('k'), 'utf8')).foo).toEqual([person('about A'), person('about B')])
    // A third part moved off foo, with nothing of its own, takes nothing, and nothing is written.
    const before = await readFile(fileFor('k'), 'utf8')
    await store.copyRenamed('k', { foo: 'foo--c' })
    expect(await readFile(fileFor('k'), 'utf8')).toBe(before)
    expect((await store.list('k'))['foo--c']).toBeUndefined()
  })

  it('a part renamed back to its old id shows its claims there again, and a swap shows each part its own', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'x', person('about A'))
    await store.copyRenamed('k', { x: 'y' })
    await store.copyRenamed('k', { y: 'x' })
    expect(await store.list('k')).toEqual({ x: [person('about A')] })
    await store.add('k', 'p', person('about P'))
    await store.add('k', 'q', person('about Q'))
    await store.add('k', 'q', person('shared'))
    await store.add('k', 'p', person('shared'))
    await store.copyRenamed('k', { p: 'q', q: 'p' })
    const shown = await store.list('k')
    expect(shown.p).toEqual([person('shared'), person('about Q')])
    expect(shown.q).toEqual([person('shared'), person('about P')])
  })

  it('a note added again on an id renamed away shows there, and so does a new one', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'b-foo', person('about A'))
    await store.copyRenamed('k', { 'b-foo': 'b-foo--a1' })
    await store.add('k', 'b-foo', person('new part'))
    expect((await store.list('k'))['b-foo']).toEqual([person('new part')])
    // Added again on this part: it is this part's now, once, as the newest.
    await store.add('k', 'b-foo', person('about A'))
    expect((await store.list('k'))['b-foo']).toEqual([person('new part'), person('about A')])
    expect((await store.list('k'))['b-foo--a1']).toEqual([person('about A')])
    // Another note copied away from the id stays out of sight when one is added again.
    await store.add('k', 'c', person('one'))
    await store.add('k', 'c', person('two'))
    await store.copyRenamed('k', { c: 'c--x' })
    await store.add('k', 'c', person('two'))
    expect((await store.list('k')).c).toEqual([person('two')])
  })

  it('a record beside the annotations that is missing, broken or odd hides nothing it does not name', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'a', person('one'))
    await store.add('k', 'b', person('two'))
    const record = `${fileFor('k')}${MOVED_SUFFIX}`
    await writeFile(record, '{ not json')
    expect(await store.list('k')).toEqual({ a: [person('one')], b: [person('two')] })
    await writeFile(record, JSON.stringify([JSON.stringify(person('one'))]))
    expect(await store.list('k')).toEqual({ a: [person('one')], b: [person('two')] })
    await writeFile(record, JSON.stringify({ a: JSON.stringify(person('one')), b: [7, JSON.stringify(person('two'))], c: [] }))
    expect(await store.list('k')).toEqual({ a: [person('one')] })
  })

  it('a rename whose record cannot be written rejects after the copy, and the next one records it', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'b-foo', person('about A'))
    const record = `${fileFor('k')}${MOVED_SUFFIX}`
    await mkdir(join(record, 'held'), { recursive: true }) // a folder where the record goes: it cannot be written
    await expect(store.copyRenamed('k', { 'b-foo': 'b-foo--a1' })).rejects.toThrow()
    // The copy is in; the old id still shows its claims, as before the record.
    expect(await store.list('k')).toEqual({ 'b-foo': [person('about A')], 'b-foo--a1': [person('about A')] })
    await rm(record, { recursive: true, force: true })
    await store.copyRenamed('k', { 'b-foo': 'b-foo--a1' })
    expect(await store.list('k')).toEqual({ 'b-foo--a1': [person('about A')] })
    // Run again, nothing changes and nothing is written.
    const before = await readFile(record, 'utf8')
    await store.copyRenamed('k', { 'b-foo': 'b-foo--a1' })
    expect(await readFile(record, 'utf8')).toBe(before)
  })
})

describe('withAnnotations', () => {
  it('a design save over a newer world marks the caller\'s doc, not only the merged copy (M7)', async () => {
    const inner = createWorldStore(dir)
    const store = withAnnotations(inner, createAnnotationStore(dir))
    const design = { ...minimal(), projectKey: 'design:x' } as WorldDoc
    await mkdir(join(dir, 'world'), { recursive: true })
    const newer = JSON.stringify({ ...design, version: 99 })
    await writeFile(join(dir, 'world', worldFileName('design:x')), newer)
    const out = { ...design }
    await store.save(out)
    expect(out.savedByNewer).toBe(true)
    expect(await readFile(join(dir, 'world', worldFileName('design:x')), 'utf8')).toBe(newer)
    // a design save over one of ours leaves the caller's doc unmarked
    const own = { ...minimal(), projectKey: 'design:y' } as WorldDoc
    await store.save(own)
    expect(own.savedByNewer).toBeUndefined()
  })

  const agent: Claim = { text: 'Calls the bank.', state: 'observed', evidence: [{ kind: 'transcriptStep', ref: 'noted by an agent through world_annotate' }] }
  const onB1 = (d: WorldDoc): Claim[] => d.buildings.find((b) => b.id === 'b1')!.claims

  it('an agent note is shown once through three saves and loads; person and runtime notes are as before (DSN R2, F1)', async () => {
    const annotations = createAnnotationStore(dir)
    const store = withAnnotations(createWorldStore(dir), annotations)
    // The design is saved before its notes are stored, as the designer saves it; each save after saves what a load showed.
    let d = { ...minimal(), projectKey: 'design:x' } as WorldDoc
    await store.save(d)
    await annotations.add('design:x', 'b1', agent)
    await annotations.add('design:x', 'b1', person('Takes orders.'))
    await annotations.add('design:x', 'b1', person(runtimeText(['orders-api'])))
    const before = onB1(minimal())
    for (let i = 0; i < 3; i++) {
      d = (await store.load('design:x')) as WorldDoc
      await store.save(d)
    }
    d = (await store.load('design:x')) as WorldDoc
    expect(onB1(d)).toEqual([...before, agent, person('Takes orders.')])
    expect(d.runtimeNames.b1).toEqual(['orders-api'])
    expect(d.runtimeHandSet).toEqual(['b1'])
    const disk = JSON.parse(await readFile(join(dir, 'world', worldFileName('design:x')), 'utf8')) as WorldDoc
    // The file holds none of what the store holds (DSN R3-2): not the note, the person's claim or the service names.
    expect(onB1(disk)).toEqual(before)
    expect(disk.runtimeNames.b1).toBeUndefined()
    expect(disk.runtimeHandSet).toBeUndefined()
  })

  it('a design file already holding four copies of an agent note loads as one and saves none, the store holding it (DSN R2, F1; R3-2)', async () => {
    const annotations = createAnnotationStore(dir)
    const store = withAnnotations(createWorldStore(dir), annotations)
    await annotations.add('design:x', 'b1', agent)
    const copies = { ...minimal(), projectKey: 'design:x' } as WorldDoc
    copies.buildings = copies.buildings.map((b) => (b.id === 'b1' ? { ...b, claims: [...b.claims, agent, agent, agent, agent] } : b))
    await mkdir(join(dir, 'world'), { recursive: true })
    const file = join(dir, 'world', worldFileName('design:x'))
    await writeFile(file, JSON.stringify(copies))
    const loaded = (await store.load('design:x')) as WorldDoc
    expect(onB1(loaded).filter((c) => c.text === agent.text)).toEqual([agent])
    await store.save(loaded)
    expect(onB1(JSON.parse(await readFile(file, 'utf8')) as WorldDoc).filter((c) => c.text === agent.text)).toEqual([])
    expect((await annotations.list('design:x')).b1).toEqual([agent])
  })
})

describe('addClaim: one more stored note, as a merge with it shows it (DSN Round 1, item 9)', () => {
  const person = (text: string): Claim => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'pane' }] })

  it('a note goes on the card of the building or line it names, and on no other part', () => {
    const doc = minimal()
    const onBuilding = addClaim(doc, 'b1', person('Takes orders.'))
    expect(onBuilding.buildings.find((b) => b.id === 'b1')?.claims.slice(-1)).toEqual([person('Takes orders.')])
    expect(onBuilding.buildings.filter((b) => b.id !== 'b1')).toEqual(doc.buildings.filter((b) => b.id !== 'b1'))
    expect(onBuilding.edges).toEqual(doc.edges)
    const onLine = addClaim(doc, doc.edges[0].id, person('Every order.'))
    expect(onLine.edges[0].claims.slice(-1)).toEqual([person('Every order.')])
    expect(onLine.buildings).toEqual(doc.buildings)
    expect(doc.buildings.find((b) => b.id === 'b1')?.claims).not.toContainEqual(person('Takes orders.'))
  })

  it('a runtime-names note sets the service names by hand, and an empty one clears them; the cards are left alone', () => {
    const doc = { ...minimal(), runtimeNames: { b2: ['other'] }, runtimeHandSet: ['b2'] }
    const set = addClaim(doc, 'b1', person(runtimeText(['orders-api', 'orders'])))
    expect(set.runtimeNames).toEqual({ b2: ['other'], b1: ['orders-api', 'orders'] })
    expect(set.runtimeHandSet).toEqual(['b1', 'b2'])
    expect(set.buildings).toEqual(doc.buildings)
    const cleared = addClaim(set, 'b2', person(runtimeText([])))
    expect(cleared.runtimeNames).toEqual({ b1: ['orders-api', 'orders'] })
    expect(cleared.runtimeHandSet).toEqual(['b1', 'b2'])
    expect(addClaim(minimal(), 'b1', person(runtimeText(['x']))).runtimeHandSet).toEqual(['b1'])
  })
})

describe('a design file without the notes the store holds (DSN R3-2)', () => {
  const person = (text: string): Claim => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'pane' }] })
  const agent = (text: string): Claim => ({ text, state: 'observed', evidence: [{ kind: 'transcriptStep', ref: 'noted by an agent through world_annotate' }] })
  const design = (claims: Record<string, Claim[]>): WorldDoc => {
    const doc = { ...minimal(), projectKey: 'design:x' } as WorldDoc
    doc.buildings = doc.buildings.map((b) => ({ ...b, claims: claims[b.id] ?? b.claims }))
    doc.edges = doc.edges.map((e) => ({ ...e, claims: claims[e.id] ?? e.claims }))
    return doc
  }

  describe('addMissing', () => {
    it('adds after a part its own the claims it lacks, each once, and leaves out a held, a copied-away or a malformed one', async () => {
      const store = createAnnotationStore(dir)
      await store.add('k', 'b1', person('one'))
      await writeFile(`${fileFor('k')}${MOVED_SUFFIX}`, JSON.stringify({ b1: [JSON.stringify(person('gone'))] }))
      const malformed = { text: 'x', state: 'verified', evidence: [] } as unknown as Claim
      await store.addMissing('k', { b1: [person('one'), person('two'), person('two'), person('gone'), malformed], b2: [agent('three')], e1: [] })
      expect(await store.list('k')).toEqual({ b1: [person('one'), person('two')], b2: [agent('three')] })
      expect(await readFile(fileFor('k'), 'utf8')).not.toContain('gone')
    })

    it('caps a part as an add caps it, keeping the newest', async () => {
      const store = createAnnotationStore(dir)
      for (let n = 1; n < MAX_ANNOTATIONS_PER_ITEM; n++) await store.add('k', 'b1', agent(`n${n}`))
      await store.addMissing('k', { b1: [agent('a'), agent('b'), agent('c')] })
      const texts = (await store.list('k')).b1.map((c) => c.text)
      expect(texts).toHaveLength(MAX_ANNOTATIONS_PER_ITEM)
      expect(texts.slice(0, 2)).toEqual(['n3', 'n4'])
      expect(texts.slice(-3)).toEqual(['a', 'b', 'c'])
    })

    it('writes nothing when every claim is held already and the key is marked; a first move marks it, even with nothing to add (DSN R4, D4-4)', async () => {
      const store = createAnnotationStore(dir)
      await store.add('k', 'b1', person('one'))
      expect(await store.listStrict('k')).toEqual({ byItem: { b1: [person('one')] }, migrated: false })
      await store.addMissing('k', { b1: [person('one')] })
      expect(await store.listStrict('k')).toEqual({ byItem: { b1: [person('one')] }, migrated: true })
      // Laid out as the store never writes it: a write, even of the same claims, would show.
      const before = JSON.stringify(JSON.parse(await readFile(fileFor('k'), 'utf8')), null, 2)
      await writeFile(fileFor('k'), before)
      const writes = (await readdir(folder())).length
      await store.addMissing('k', { b1: [person('one')] })
      expect(await readFile(fileFor('k'), 'utf8')).toBe(before)
      expect((await readdir(folder())).length).toBe(writes)
      // A world with no annotations yet: the move writes only the mark.
      await store.addMissing('fresh', { b1: [] })
      expect(JSON.parse(await readFile(fileFor('fresh'), 'utf8'))).toEqual({ [MIGRATED_KEY]: true })
      expect(await store.listStrict('fresh')).toEqual({ byItem: {}, migrated: true })
    })

    it('rejects, writing nothing, when the stored annotations cannot be read', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const store = createAnnotationStore(dir)
        await mkdir(join(fileFor('k'), 'held'), { recursive: true }) // a folder where the file goes: it cannot be read
        await expect(store.addMissing('k', { b1: [person('one')] })).rejects.toThrow(WORLD_READ_FAILED)
        expect(await readdir(fileFor('k'))).toEqual(['held'])
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('withoutStored', () => {
    it('leaves out person and runtime-names claims, the stored notes, the stored service names and the hand-set list', () => {
      const names = person(runtimeText(['orders-api']))
      const doc = design({ b1: [agent('stored'), person('Takes orders.'), names, agent('only in the file')], e1: [agent('on a line')] })
      doc.runtimeNames = { b1: ['orders-api'], b2: ['orders-db'] }
      doc.runtimeHandSet = ['b1', 'b2']
      const out = withoutStored(doc, { b1: [agent('stored'), names], e1: [agent('on a line')] })
      expect(out.buildings.find((b) => b.id === 'b1')!.claims).toEqual([agent('only in the file')])
      expect(out.edges[0].claims).toEqual([])
      // b2's names are not stored: they stay, for the store has no claim to make them again, and so does its hand-set
      // mark (DSN R4, D4-5), for a load to move them into the store.
      expect(out.runtimeNames).toEqual({ b2: ['orders-db'] })
      expect(out.runtimeHandSet).toEqual(['b2'])
      // The doc given is left as it was.
      expect(doc.runtimeHandSet).toEqual(['b1', 'b2'])
      expect(doc.buildings.find((b) => b.id === 'b1')!.claims).toHaveLength(4)
    })

    it('gives a doc without service names an empty list of them', () => {
      const doc = design({})
      delete (doc as Partial<WorldDoc>).runtimeNames
      expect(withoutStored(doc, {}).runtimeNames).toEqual({})
    })
  })

  describe('withAnnotations', () => {
    it('moves a note on a part the store holds nothing for into the store, and the next save leaves it out', async () => {
      const annotations = createAnnotationStore(dir)
      const inner = createWorldStore(dir)
      await inner.save(design({ b2: [agent('Holds the orders.')] }))
      const store = withAnnotations(inner, annotations)
      const loaded = (await store.load('design:x')) as WorldDoc
      expect(loaded.buildings.find((b) => b.id === 'b2')!.claims).toEqual([agent('Holds the orders.')])
      expect(await annotations.list('design:x')).toEqual({ b2: [agent('Holds the orders.')] })
      await store.save(loaded)
      expect(((await inner.load('design:x')) as WorldDoc).buildings.find((b) => b.id === 'b2')!.claims).toEqual([])
    })

    it('a move that fails leaves the note in the file and shows it from there, and the next load moves it', async () => {
      const annotations = createAnnotationStore(dir)
      const inner = createWorldStore(dir)
      await inner.save(design({ b2: [agent('Holds the orders.')] }))
      const failing = withAnnotations(inner, { listStrict: annotations.listStrict, addMissing: async () => { throw new Error('EIO') } })
      const loaded = (await failing.load('design:x')) as WorldDoc
      expect(loaded.buildings.find((b) => b.id === 'b2')!.claims).toEqual([agent('Holds the orders.')])
      await failing.save(loaded)
      expect(((await inner.load('design:x')) as WorldDoc).buildings.find((b) => b.id === 'b2')!.claims).toEqual([agent('Holds the orders.')])
      expect(await annotations.list('design:x')).toEqual({})
      await withAnnotations(inner, annotations).load('design:x')
      expect(await annotations.list('design:x')).toEqual({ b2: [agent('Holds the orders.')] })
    })

    it('leaves service names out of a save only while the store holds a claim for them, never because it once did', async () => {
      const annotations = createAnnotationStore(dir)
      const inner = createWorldStore(dir)
      await inner.save(design({}))
      await annotations.add('design:x', 'b1', person(runtimeText(['orders-api'])))
      const store = withAnnotations(inner, annotations)
      const loaded = (await store.load('design:x')) as WorldDoc
      expect(loaded.runtimeNames.b1).toEqual(['orders-api'])
      // The stored claim goes with the part's notes to another id: b1's names are the design's own again.
      await annotations.copyRenamed('design:x', { b1: 'b1--a' })
      await store.save({ ...loaded, runtimeNames: { b1: ['set-in-the-design'] } })
      expect(((await inner.load('design:x')) as WorldDoc).runtimeNames).toEqual({ b1: ['set-in-the-design'] })
      expect(((await store.load('design:x')) as WorldDoc).runtimeNames.b1).toEqual(['set-in-the-design'])
    })

    it('passes a project world through on a load and a save, untouched', async () => {
      const inner = createWorldStore(dir)
      const store = withAnnotations(inner, createAnnotationStore(dir))
      const project = { ...design({ b1: [agent('kept')] }), projectKey: 'C:/proj' }
      await store.save(project)
      expect(((await store.load('C:/proj')) as WorldDoc).buildings.find((b) => b.id === 'b1')!.claims).toEqual([agent('kept')])
    })
  })
})

describe("a design's notes move into the store once, and the store is then their only source (DSN R4)", () => {
  const person = (text: string): Claim => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] })
  const agent = (text: string): Claim => ({ text, state: 'observed', evidence: [{ kind: 'transcriptStep', ref: 'noted by an agent through world_annotate' }] })
  const design = (claims: Record<string, Claim[]>, over: Partial<WorldDoc> = {}): WorldDoc => {
    const doc = { ...minimal(), projectKey: 'design:x', ...over } as WorldDoc
    doc.buildings = doc.buildings.map((b) => ({ ...b, claims: claims[b.id] ?? b.claims }))
    doc.edges = doc.edges.map((e) => ({ ...e, claims: claims[e.id] ?? e.claims }))
    return doc
  }
  const on = (doc: WorldDoc, id: string): Claim[] => [...doc.buildings, ...doc.edges].find((p) => p.id === id)!.claims
  const notesOn = (doc: WorldDoc, id: string): string[] => on(doc, id).filter((c) => c.evidence.some((e) => e.kind === 'transcriptStep')).map((c) => c.text)
  const worldFile = (): string => join(dir, 'world', worldFileName('design:x'))
  const onDisk = async (): Promise<WorldDoc> => JSON.parse(await readFile(worldFile(), 'utf8')) as WorldDoc
  const texts = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `Note ${from + i}.`)
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const unreadable = async (): Promise<never> => {
    throw new WorldReadError('ANNOTATIONS_READ_FAILED')
  }
  const failed = async (): Promise<never> => {
    throw new Error('EIO')
  }

  describe('listStrict', () => {
    it('shows what list shows, with the mark, and none for a world with no annotations yet', async () => {
      const store = createAnnotationStore(dir)
      expect(await store.listStrict('k')).toEqual({ byItem: {}, migrated: false })
      await store.add('k', 'b1', person('one'))
      await store.add('k', 'b2', agent('copied away'))
      await store.copyRenamed('k', { b2: 'b2--a' })
      expect(await store.listStrict('k')).toEqual({ byItem: await store.list('k'), migrated: false })
      expect(Object.keys((await store.listStrict('k')).byItem).sort()).toEqual(['b1', 'b2--a'])
    })

    it('reads a file that does not parse as none (DSN R5, T5) and rejects, where list shows none, for one that cannot be read; it writes nothing', async () => {
      const warn = quiet()
      try {
        const store = createAnnotationStore(dir)
        await mkdir(folder(), { recursive: true })
        await writeFile(fileFor('broken'), '{ not json')
        await mkdir(join(fileFor('folder'), 'held'), { recursive: true })
        expect(await store.listStrict('broken')).toEqual({ byItem: {}, migrated: false })
        await expect(store.listStrict('folder')).rejects.toMatchObject({ name: 'WorldReadError', code: 'ANNOTATIONS_READ_FAILED', message: WORLD_READ_FAILED })
        for (const key of ['broken', 'folder']) expect(await store.list(key)).toEqual({})
        expect(String(warn.mock.calls[0][0])).toContain("a world's annotations could not be read")
        // Nothing was moved aside or written: a read never writes.
        expect(await readFile(fileFor('broken'), 'utf8')).toBe('{ not json')
        expect((await readdir(folder())).sort()).toEqual([`${hashOf('broken')}.json`, `${hashOf('folder')}.json`].sort())
      } finally {
        warn.mockRestore()
      }
    })

    it('reads a file held for a moment again, and rejects one still held after every retry', async () => {
      const warn = quiet()
      try {
        let fails = 1
        const readHeld = async (file: string): Promise<string> => {
          if (file.endsWith(MOVED_SUFFIX)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          if (fails-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
          return JSON.stringify({ b1: [person('one')], [MIGRATED_KEY]: true })
        }
        const sleep = async (): Promise<void> => undefined
        expect(await createAnnotationStore(dir, { readFile: readHeld, sleep }).listStrict('k')).toEqual({ byItem: { b1: [person('one')] }, migrated: true })
        fails = Infinity
        await expect(createAnnotationStore(dir, { readFile: readHeld, sleep }).listStrict('k')).rejects.toBeInstanceOf(WorldReadError)
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('the mark', () => {
    it('is written by addMissing with the claims, kept through an add and a copy, with no backup made, and is never a part', async () => {
      const store = createAnnotationStore(dir)
      await store.addMissing('k', { b1: [person('one')] })
      expect(JSON.parse(await readFile(fileFor('k'), 'utf8'))).toEqual({ b1: [person('one')], [MIGRATED_KEY]: true })
      await store.add('k', 'b1', person('two'))
      await store.copyRenamed('k', { b1: 'b1--a' })
      expect(await store.listStrict('k')).toEqual({ byItem: { 'b1--a': [person('one'), person('two')] }, migrated: true })
      // A file this version wrote reads back the same: none of those writes backed it up first (N1).
      expect((await readdir(folder())).filter((f) => !f.endsWith(MOVED_SUFFIX))).toEqual([`${hashOf('k')}.json`])
      expect(await store.list('k')).not.toHaveProperty(MIGRATED_KEY)
    })

    it('a mark that is not `true` marks nothing', async () => {
      await mkdir(folder(), { recursive: true })
      await writeFile(fileFor('k'), JSON.stringify({ b1: [person('one')], [MIGRATED_KEY]: 'yes' }))
      expect(await createAnnotationStore(dir).listStrict('k')).toEqual({ byItem: { b1: [person('one')] }, migrated: false })
    })
  })

  describe('the same note added again (D4-6)', () => {
    it('is stored once, taking no second slot under the cap (probe :125)', async () => {
      const store = createAnnotationStore(dir)
      for (const text of texts(1, MAX_ANNOTATIONS_PER_ITEM)) await store.add('k', 'b1', agent(text))
      const before = await readFile(fileFor('k'), 'utf8')
      await store.add('k', 'b1', agent('Note 1.'))
      await store.add('k', 'b1', agent('Note 20.'))
      expect((await store.list('k')).b1.map((c) => c.text)).toEqual(texts(1, 20))
      expect(await readFile(fileFor('k'), 'utf8')).toBe(before)
      // The same words in another state are another note.
      await store.add('k', 'b1', { ...agent('Note 20.'), state: 'verified' })
      expect((await store.list('k')).b1).toHaveLength(MAX_ANNOTATIONS_PER_ITEM)
      expect((await store.list('k')).b1[0].text).toBe('Note 2.')
    })

    it('a note copied away from the part and added there again is shown there again, as before (HOLD-B #37)', async () => {
      const store = createAnnotationStore(dir)
      await store.add('k', 'b1', agent('Calls the bank.'))
      await store.copyRenamed('k', { b1: 'b2' })
      expect((await store.list('k')).b1).toBeUndefined()
      await store.add('k', 'b1', agent('Calls the bank.'))
      expect((await store.list('k')).b1).toEqual([agent('Calls the bank.')])
    })

    it('addClaim and withClaim show it once, the cap keeping the newest, and change nothing they are given', () => {
      const doc = design({ b1: [agent('Calls the bank.')] })
      expect(addClaim(doc, 'b1', agent('Calls the bank.'))).toEqual(doc)
      const byItem = { b1: texts(1, 20).map(agent) }
      expect(withClaim(byItem, 'b1', agent('Note 3.'))).toBe(byItem)
      const more = withClaim(byItem, 'b1', agent('Note 21.'))
      expect(more.b1.map((c) => c.text)).toEqual(texts(2, 21))
      expect(byItem.b1).toHaveLength(20)
      expect(withClaim({}, 'e1', agent('On a line.'))).toEqual({ e1: [agent('On a line.')] })
    })
  })

  describe('service names the design set (D4-5)', () => {
    const stored = (names: string[]): Record<string, Claim[]> => ({ b1: [person(runtimeText(names))] })

    it("withoutStored leaves names out only when they equal the stored claim's; other names stay, an empty list for none", () => {
      const same = withoutStored(design({}, { runtimeNames: { b1: ['orders-api'] }, runtimeHandSet: ['b1'] }), stored(['orders-api']))
      expect(same.runtimeNames).toEqual({})
      expect(same.runtimeHandSet).toBeUndefined()
      const edited = withoutStored(design({}, { runtimeNames: { b1: ['edited'] } }), stored(['orders-api']))
      expect(edited.runtimeNames).toEqual({ b1: ['edited'] })
      const cleared = withoutStored(design({}, { runtimeNames: {} }), stored(['orders-api']))
      expect(cleared.runtimeNames).toEqual({ b1: [] })
      // A part with no stored claim keeps its names and its hand-set mark, whatever the others do.
      const legacy = withoutStored(design({}, { runtimeNames: { b1: ['orders-api'], b2: ['legacy'] }, runtimeHandSet: ['b1', 'b2'] }), stored(['orders-api']))
      expect(legacy.runtimeNames).toEqual({ b2: ['legacy'] })
      expect(legacy.runtimeHandSet).toEqual(['b2'])
    })

    it("mergeDesign shows the file's names where they differ from the stored claim's, and the claim's, hand-set, where they do not", () => {
      const claimShown = mergeDesign(design({}, { runtimeNames: {} }), stored(['orders-api']))
      expect(claimShown.runtimeNames).toEqual({ b1: ['orders-api'] })
      expect(claimShown.runtimeHandSet).toEqual(['b1'])
      const same = mergeDesign(design({}, { runtimeNames: { b1: ['orders-api'] } }), stored(['orders-api']))
      expect(same.runtimeNames).toEqual({ b1: ['orders-api'] })
      expect(same.runtimeHandSet).toEqual(['b1'])
      const edited = mergeDesign(design({}, { runtimeNames: { b1: ['edited'] } }), { b1: [person(runtimeText(['orders-api'])), person('Takes orders.')] })
      expect(edited.runtimeNames).toEqual({ b1: ['edited'] })
      expect(edited.runtimeHandSet).toBeUndefined()
      expect(on(edited, 'b1')).toContainEqual(person('Takes orders.'))
      const cleared = mergeDesign(design({}, { runtimeNames: { b1: [] } }), stored(['orders-api']))
      expect(cleared.runtimeNames).toEqual({})
      expect(cleared.runtimeHandSet).toBeUndefined()
      // An empty stored claim clears names, and an empty list in the file then agrees with it.
      expect(mergeDesign(design({}, { runtimeNames: { b1: [] } }), stored([])).runtimeNames).toEqual({})
    })

    it("mergeDesign keeps the file's hand-set marks only when asked, and only for parts with no stored claim", () => {
      const doc = design({}, { runtimeNames: { b1: ['orders-api'], b2: ['legacy'] }, runtimeHandSet: ['b1', 'b2'] })
      expect(mergeDesign(doc, {}).runtimeHandSet).toBeUndefined()
      expect(mergeDesign(doc, {}, true).runtimeHandSet).toEqual(['b1', 'b2'])
      // A part with a stored claim is never hand-set from the file: names the design set since (a design op) show, its own.
      expect(mergeDesign(doc, { b2: [person(runtimeText(['other']))] }, true).runtimeHandSet).toEqual(['b1'])
      // Names equal to the stored claim's show as the claim makes them, hand-set.
      expect(mergeDesign({ ...doc, runtimeHandSet: ['b1'] }, { b2: [person(runtimeText(['legacy']))] }, true).runtimeHandSet).toEqual(['b1', 'b2'])
      expect(mergeDesign(doc, { b2: [person(runtimeText(['other']))] }, true).runtimeNames).toEqual({ b1: ['orders-api'], b2: ['legacy'] })
    })

    it('an edit of a stored service name is saved and shown after a reload; a clear too, and an unchanged save leaves the names out (probe :111)', async () => {
      const annotations = createAnnotationStore(dir)
      const inner = createWorldStore(dir)
      await inner.save(design({}))
      await annotations.add('design:x', 'b1', person(runtimeText(['orders-api'])))
      const store = withAnnotations(inner, annotations)
      const loaded = (await store.load('design:x')) as WorldDoc
      expect(loaded.runtimeNames.b1).toEqual(['orders-api'])
      await store.save(loaded)
      expect((await onDisk()).runtimeNames).toEqual({})
      await store.save({ ...loaded, runtimeNames: { ...loaded.runtimeNames, b1: ['edited'] } })
      expect((await onDisk()).runtimeNames).toEqual({ b1: ['edited'] })
      const edited = (await withAnnotations(createWorldStore(dir), createAnnotationStore(dir)).load('design:x')) as WorldDoc
      expect(edited.runtimeNames.b1).toEqual(['edited'])
      // Saved again as loaded, the edit stays.
      await store.save(edited)
      expect((await onDisk()).runtimeNames).toEqual({ b1: ['edited'] })
      const rest = { ...edited.runtimeNames }
      delete rest.b1
      await store.save({ ...edited, runtimeNames: rest })
      expect((await onDisk()).runtimeNames).toEqual({ b1: [] })
      const cleared = (await withAnnotations(createWorldStore(dir), createAnnotationStore(dir)).load('design:x')) as WorldDoc
      expect(cleared.runtimeNames.b1).toBeUndefined()
      expect(await annotations.list('design:x')).toEqual({ b1: [person(runtimeText(['orders-api']))] })
    })

    it('a hand-set name in a file from before moves into the store, and survives a load, a save and a reload', async () => {
      const inner = createWorldStore(dir)
      await inner.save(design({}, { runtimeNames: { b1: ['legacy-api'] }, runtimeHandSet: ['b1', 'ghost'] }))
      const annotations = createAnnotationStore(dir)
      const store = withAnnotations(inner, annotations)
      const loaded = (await store.load('design:x')) as WorldDoc
      expect(loaded.runtimeNames.b1).toEqual(['legacy-api'])
      expect(loaded.runtimeHandSet).toEqual(['b1'])
      expect(await annotations.listStrict('design:x')).toEqual({ byItem: { b1: [person(runtimeText(['legacy-api']))] }, migrated: true })
      await store.save(loaded)
      expect((await onDisk()).runtimeNames).toEqual({})
      expect((await onDisk()).runtimeHandSet).toBeUndefined()
      const again = (await withAnnotations(createWorldStore(dir), createAnnotationStore(dir)).load('design:x')) as WorldDoc
      expect(again.runtimeNames.b1).toEqual(['legacy-api'])
      expect(again.runtimeHandSet).toEqual(['b1'])
    })

    it('a part a person cleared by hand in a file from before (hand-set, no names) moves as an empty claim and stays clear', async () => {
      const inner = createWorldStore(dir)
      await inner.save(design({}, { runtimeNames: {}, runtimeHandSet: ['b1'] }))
      const annotations = createAnnotationStore(dir)
      const loaded = (await withAnnotations(inner, annotations).load('design:x')) as WorldDoc
      expect(loaded.runtimeNames.b1).toBeUndefined()
      expect(await annotations.listStrict('design:x')).toEqual({ byItem: { b1: [person(runtimeText([]))] }, migrated: true })
      const again = (await withAnnotations(createWorldStore(dir), createAnnotationStore(dir)).load('design:x')) as WorldDoc
      expect(again.runtimeNames.b1).toBeUndefined()
    })

    it('mergeDesign takes a design with no service names at all as one with none', () => {
      const bare = { ...design({}), runtimeNames: undefined } as unknown as WorldDoc
      const shown = mergeDesign(bare, stored(['orders-api']))
      expect(shown.runtimeNames).toEqual({ b1: ['orders-api'] })
      expect(shown.runtimeHandSet).toEqual(['b1'])
    })

    it('a hand-set name whose move fails stays in the file and shown hand-set, through a save and a reload, and moves on a later load', async () => {
      const inner = createWorldStore(dir)
      await inner.save(design({}, { runtimeNames: { b1: ['legacy-api'] }, runtimeHandSet: ['b1'] }))
      const annotations = createAnnotationStore(dir)
      const failing = withAnnotations(inner, { listStrict: annotations.listStrict, addMissing: failed })
      const loaded = (await failing.load('design:x')) as WorldDoc
      expect(loaded.runtimeNames.b1).toEqual(['legacy-api'])
      expect(loaded.runtimeHandSet).toEqual(['b1'])
      await failing.save(loaded)
      expect((await onDisk()).runtimeNames).toEqual({ b1: ['legacy-api'] })
      expect((await onDisk()).runtimeHandSet).toEqual(['b1'])
      expect(((await failing.load('design:x')) as WorldDoc).runtimeHandSet).toEqual(['b1'])
      expect(await annotations.listStrict('design:x')).toEqual({ byItem: {}, migrated: false })
      await withAnnotations(createWorldStore(dir), annotations).load('design:x')
      expect(await annotations.listStrict('design:x')).toEqual({ byItem: { b1: [person(runtimeText(['legacy-api']))] }, migrated: true })
    })
  })

  describe('the move (D4-3, D4-4)', () => {
    it('a design a newer Termpolis saved moves nothing and writes nothing, its notes shown from the file (probe :100)', async () => {
      const annotations = createAnnotationStore(dir)
      await annotations.add('design:x', 'b1', agent('stored'))
      await annotations.add('design:x', 'b2', agent('copied away'))
      await annotations.copyRenamed('design:x', { b2: 'b2--a' })
      await mkdir(join(dir, 'world'), { recursive: true })
      const newer = design({ b1: [agent('only in the file')], e1: [agent('on a line')] }, { version: 99, runtimeNames: { b1: ['legacy'] }, runtimeHandSet: ['b1'] } as Partial<WorldDoc>)
      await writeFile(worldFile(), JSON.stringify(newer))
      const notes = await readFile(fileFor('design:x'))
      const sidecar = await readFile(`${fileFor('design:x')}${MOVED_SUFFIX}`)
      const names = await readdir(folder())
      const loaded = (await withAnnotations(createWorldStore(dir), annotations).load('design:x')) as WorldDoc
      expect(loaded.savedByNewer).toBe(true)
      expect(notesOn(loaded, 'b1')).toEqual(['only in the file', 'stored'])
      expect(notesOn(loaded, 'e1')).toEqual(['on a line'])
      expect(await readFile(fileFor('design:x'))).toEqual(notes)
      expect(await readFile(`${fileFor('design:x')}${MOVED_SUFFIX}`)).toEqual(sidecar)
      expect(await readdir(folder())).toEqual(names)
      expect((await annotations.listStrict('design:x')).migrated).toBe(false)
    })

    it('happens once: 20 moved, one more evicting the oldest, then a restart and an open re-add nothing and evict nothing (probe :86)', async () => {
      await createWorldStore(dir).save(design({ b1: texts(1, 20).map(agent) }))
      const first = createAnnotationStore(dir)
      const opened = (await withAnnotations(createWorldStore(dir), first).load('design:x')) as WorldDoc
      expect(notesOn(opened, 'b1')).toEqual(texts(1, 20))
      expect(await first.listStrict('design:x')).toMatchObject({ migrated: true })
      await first.add('design:x', 'b1', agent('Note 21.'))
      expect((await first.list('design:x')).b1.map((c) => c.text)).toEqual(texts(2, 21))
      // A restart: a new store and wrapper, the design file still holding its 20 notes.
      expect(notesOn(await onDisk(), 'b1')).toEqual(texts(1, 20))
      const later = createAnnotationStore(dir)
      const reopened = (await withAnnotations(createWorldStore(dir), later).load('design:x')) as WorldDoc
      expect(notesOn(reopened, 'b1')).toEqual(texts(2, 21))
      expect((await later.list('design:x')).b1.map((c) => c.text)).toEqual(texts(2, 21))
    })

    it("a marked key shows none of the file's notes, even while the store cannot be read, and a save leaves them all out", async () => {
      const annotations = createAnnotationStore(dir)
      await createWorldStore(dir).save(design({ b1: [agent('moved')] }))
      const store = withAnnotations(createWorldStore(dir), annotations)
      await store.load('design:x')
      // An older Termpolis writes notes into the file afterwards, and the store drops what it moved (its cap, say).
      await createWorldStore(dir).save(design({ b1: [agent('moved'), agent('written by an older version'), person('By hand.')] }, { runtimeHandSet: ['b1'] }))
      await writeFile(fileFor('design:x'), JSON.stringify({ [MIGRATED_KEY]: true }))
      const shown = (await store.load('design:x')) as WorldDoc
      expect(on(shown, 'b1')).toEqual([])
      expect(shown.runtimeHandSet).toBeUndefined()
      // Marked, then the store held past every retry: still the store's alone, so nothing of the file's shows.
      const listStrict = vi.fn(annotations.listStrict).mockImplementationOnce(annotations.listStrict).mockImplementation(unreadable)
      const held = withAnnotations(createWorldStore(dir), { listStrict, addMissing: annotations.addMissing })
      await held.load('design:x')
      expect(on((await held.load('design:x')) as WorldDoc, 'b1')).toEqual([])
      await held.save(design({ b1: [agent('written by an older version')] }))
      expect(on(await onDisk(), 'b1')).toEqual([])
      await store.save(design({ b1: [agent('written by an older version')] }))
      expect(on(await onDisk(), 'b1')).toEqual([])
      expect(await annotations.listStrict('design:x')).toEqual({ byItem: {}, migrated: true })
    })

    it('a move that fails marks nothing, the notes shown from the file, and the next load moves them and marks the key', async () => {
      await createWorldStore(dir).save(design({ b1: [agent('Calls the bank.')] }))
      const annotations = createAnnotationStore(dir)
      const failing = withAnnotations(createWorldStore(dir), { listStrict: annotations.listStrict, addMissing: failed })
      expect(notesOn((await failing.load('design:x')) as WorldDoc, 'b1')).toEqual(['Calls the bank.'])
      expect(await annotations.listStrict('design:x')).toEqual({ byItem: {}, migrated: false })
      const store = withAnnotations(createWorldStore(dir), annotations)
      expect(notesOn((await store.load('design:x')) as WorldDoc, 'b1')).toEqual(['Calls the bank.'])
      expect(await annotations.listStrict('design:x')).toEqual({ byItem: { b1: [agent('Calls the bank.')] }, migrated: true })
    })

    it("a move whose read back fails shows the file's notes, and the key is marked", async () => {
      await createWorldStore(dir).save(design({ b1: [agent('Calls the bank.')] }))
      const annotations = createAnnotationStore(dir)
      const listStrict = vi.fn(annotations.listStrict).mockImplementationOnce(annotations.listStrict).mockImplementation(unreadable)
      const store = withAnnotations(createWorldStore(dir), { listStrict, addMissing: annotations.addMissing })
      expect(notesOn((await store.load('design:x')) as WorldDoc, 'b1')).toEqual(['Calls the bank.'])
      expect((await annotations.listStrict('design:x')).migrated).toBe(true)
    })

    it('a design whose file holds no notes is not marked by a load, and a store that cannot be read moves nothing', async () => {
      await createWorldStore(dir).save(design({}))
      const annotations = createAnnotationStore(dir)
      await withAnnotations(createWorldStore(dir), annotations).load('design:x')
      expect(await readdir(join(dir, 'world'))).not.toContain('annotations')
      await createWorldStore(dir).save(design({ b1: [agent('Calls the bank.')] }))
      const addMissing = vi.fn(annotations.addMissing)
      const unread = withAnnotations(createWorldStore(dir), { listStrict: unreadable, addMissing })
      expect(notesOn((await unread.load('design:x')) as WorldDoc, 'b1')).toEqual(['Calls the bank.'])
      expect(addMissing).not.toHaveBeenCalled()
      await unread.save(design({ b1: [agent('Calls the bank.')] }))
      expect(notesOn(await onDisk(), 'b1')).toEqual(['Calls the bank.'])
    })
  })
})

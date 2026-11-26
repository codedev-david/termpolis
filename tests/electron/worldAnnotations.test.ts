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
  createAnnotationStore,
  hasPart,
  MAX_ANNOTATION_EVIDENCE,
  MAX_ANNOTATION_TEXT,
  MAX_EVIDENCE_EXCERPT,
  MAX_EVIDENCE_REF,
  MAX_ANNOTATIONS_PER_ITEM,
  mergeAnnotations,
  MOVED_SUFFIX,
  withAnnotations
} from '../../src/main/world/annotations'
import { CLAIM_TRIES } from '../../src/main/world/storeFiles'
import { createWorldStore, WORLD_READ_FAILED, WorldReadError, worldFileName } from '../../src/main/world/worldStore'
import type { Claim, WorldDoc } from '../../src/shared/world/types'

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
})

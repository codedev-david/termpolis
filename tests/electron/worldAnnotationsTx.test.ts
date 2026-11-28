// DSN R5: one transaction for every change to a design's notes, claims or names. Each Codex R2 probe and each Opus R5
// case is a named test here (signoff-decisions.md, "DSN R5").
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { minimal } from '../renderer/world/helpers'
import { AnnotationLockError, createAnnotationStore, MIGRATED_KEY, withAnnotations } from '../../src/main/world/annotations'
import { createWorldStore, WORLD_READ_FAILED, WorldReadError, worldFileName } from '../../src/main/world/worldStore'
import type { Claim, WorldDoc } from '../../src/shared/world/types'
import { runtimeText } from '../../src/shared/world/runtimeNames'

const person = (text: string): Claim => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] })
const agent = (text: string): Claim => ({ text, state: 'observed', evidence: [{ kind: 'transcriptStep', ref: 'noted by an agent through world_annotate' }] })
const notes = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `note${from + i}`)

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-annot-tx-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const annotationsFile = (key = 'design:x'): string => join(dir, 'world', 'annotations', `${createHash('sha256').update(key).digest('hex')}.json`)
const worldFile = (): string => join(dir, 'world', worldFileName('design:x'))
const raw = async (): Promise<WorldDoc> => JSON.parse(await readFile(worldFile(), 'utf8')) as WorldDoc
const design = (claims: Record<string, Claim[]>, over: Partial<WorldDoc> = {}): WorldDoc => {
  const doc = { ...minimal(), projectKey: 'design:x', ...over } as WorldDoc
  doc.buildings = doc.buildings.map((b) => ({ ...b, claims: claims[b.id] ?? b.claims }))
  doc.edges = doc.edges.map((e) => ({ ...e, claims: claims[e.id] ?? e.claims }))
  return doc
}
const on = (doc: WorldDoc, id: string): string[] => [...doc.buildings, ...doc.edges].find((p) => p.id === id)!.claims.map((c) => c.text)
const exists = async (file: string): Promise<boolean> => readFile(file).then(() => true, () => false)
/** A clock that a pause moves on at once, for a lock's deadline and age. */
const clock = (start = Date.now()): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let t = start
  return { now: () => t, sleep: async (ms) => { t += ms; await new Promise<void>((r) => { setImmediate(r) }) } }
}
const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)

describe('T3: a read never writes', () => {
  it("a load of a design from before shows the file's notes, writing no note and no mark (Codex R2 :27)", async () => {
    await createWorldStore(dir).save(design({ b1: [agent('note1')] }))
    const annotations = createAnnotationStore(dir)
    const loaded = (await withAnnotations(createWorldStore(dir), annotations).load('design:x')) as WorldDoc
    expect(on(loaded, 'b1')).toEqual(['note1'])
    expect(await exists(annotationsFile())).toBe(false)
    expect(await annotations.listStrict('design:x')).toEqual({ byItem: {}, migrated: false })
  })

  it('a newer world put in place after the load is never moved: the save that would move the notes finds it and writes no note and no mark (Codex R2 :37)', async () => {
    await createWorldStore(dir).save(design({ b1: [agent('note1')] }))
    const annotations = createAnnotationStore(dir)
    const store = withAnnotations(createWorldStore(dir), annotations)
    const loaded = (await store.load('design:x')) as WorldDoc
    const newer = JSON.stringify({ ...design({ b1: [agent('newer note')] }), version: 99 })
    await writeFile(worldFile(), newer)
    await store.save(loaded)
    expect(loaded.savedByNewer).toBe(true)
    expect(await readFile(worldFile(), 'utf8')).toBe(newer)
    expect(await exists(annotationsFile())).toBe(false)
  })

  it("an unmarked design's load shows the store's notes and the file's newest 20 the store lacks, as the move would, in memory", async () => {
    await createWorldStore(dir).save(design({ b1: notes(0, 21).map(agent), e1: [person('By hand.')] }, { runtimeNames: { b1: ['legacy'] }, runtimeHandSet: ['b1'] }))
    const annotations = createAnnotationStore(dir)
    await annotations.add('design:x', 'b2', agent('stored'))
    const before = await readFile(annotationsFile(), 'utf8')
    const loaded = (await withAnnotations(createWorldStore(dir), annotations).load('design:x')) as WorldDoc
    expect(on(loaded, 'b1')).toEqual(notes(2, 21))
    expect(on(loaded, 'b2')).toEqual(['stored'])
    expect(loaded.runtimeNames.b1).toEqual(['legacy'])
    expect(loaded.runtimeHandSet).toEqual(['b1'])
    expect(await readFile(annotationsFile(), 'utf8')).toBe(before)
  })

  it('the move happens in the first write instead, from the file as read then, and marks the key', async () => {
    await createWorldStore(dir).save(design({ b1: [agent('note1')] }))
    const annotations = createAnnotationStore(dir)
    const store = withAnnotations(createWorldStore(dir), annotations)
    const loaded = (await store.load('design:x')) as WorldDoc
    await store.save(loaded)
    expect(await annotations.listStrict('design:x')).toEqual({ byItem: { b1: [agent('note1')] }, migrated: true })
    expect(on(await raw(), 'b1')).toEqual([])
    expect(on((await withAnnotations(createWorldStore(dir), createAnnotationStore(dir)).load('design:x')) as WorldDoc, 'b1')).toEqual(['note1'])
  })
})

describe('T2: migration is computed inside the transaction, and skipped once the key is marked', () => {
  it('a delayed move of a stale batch, after another process marked the key and added note 21, resurrects nothing (Codex R2 :53)', async () => {
    await createWorldStore(dir).save(design({ b1: notes(0, 19).map(agent) }))
    // Process A reads the design before any move.
    const a = createAnnotationStore(dir)
    const storeA = withAnnotations(createWorldStore(dir), a)
    const seenByA = (await storeA.load('design:x')) as WorldDoc
    expect(on(seenByA, 'b1')).toEqual(notes(0, 19))
    // Process B moves the notes (its first write) and adds note20, evicting note0.
    const b = createAnnotationStore(dir)
    const storeB = withAnnotations(createWorldStore(dir), b)
    await storeB.save((await storeB.load('design:x')) as WorldDoc)
    await b.add('design:x', 'b1', agent('note20'))
    // A's stale batch, and A's save of what it read, move nothing more.
    await a.addMissing('design:x', { b1: notes(0, 19).map(agent) })
    await storeA.save(seenByA)
    const texts = (await a.listStrict('design:x')).byItem.b1.map((c) => c.text)
    expect(texts).toEqual(notes(1, 20))
    expect(texts).not.toContain('note0')
  })

  it('a second addMissing for a marked key is skipped, writing nothing', async () => {
    const store = createAnnotationStore(dir)
    await store.addMissing('design:x', { b1: [agent('first')] })
    const before = await readFile(annotationsFile(), 'utf8')
    await store.addMissing('design:x', { b1: [agent('second')] })
    expect(await readFile(annotationsFile(), 'utf8')).toBe(before)
    expect(await store.listStrict('design:x')).toEqual({ byItem: { b1: [agent('first')] }, migrated: true })
  })
})

describe('T1: never a write without the lock', () => {
  it("a lock another holder keeps past the deadline refuses the add, which writes nothing (no lock, no write)", async () => {
    const { now, sleep } = clock()
    const store = createAnnotationStore(dir, { now, sleep })
    await store.add('k', 'b1', person('note1'))
    await writeFile(`${annotationsFile('k')}.lock`, 'another holder')
    await expect(store.add('k', 'b1', person('note2'))).rejects.toBeInstanceOf(AnnotationLockError)
    expect((await store.list('k')).b1.map((c) => c.text)).toEqual(['note1'])
    expect(await readFile(`${annotationsFile('k')}.lock`, 'utf8')).toBe('another holder')
  })

  it("a writer that waited past the deadline never writes over the holder's note (Codex R2 :108)", async () => {
    await createAnnotationStore(dir).add('k', 'b1', person('note0'))
    let release = (): void => undefined
    const gate = new Promise<void>((r) => { release = r })
    let held = (): void => undefined
    const holding = new Promise<void>((r) => { held = r })
    // Process A reads the file under the lock and stops there until released.
    const a = createAnnotationStore(dir, {
      readFile: async (file, enc) => {
        const text = await readFile(file, enc)
        if (file === annotationsFile('k')) { held(); await gate }
        return text
      }
    })
    const first = a.add('k', 'b1', person('note1'))
    await holding
    const { now, sleep } = clock()
    const b = createAnnotationStore(dir, { now, sleep })
    await expect(b.add('k', 'b1', person('note2'))).rejects.toBeInstanceOf(AnnotationLockError)
    release()
    await first
    expect((await b.list('k')).b1.map((c) => c.text)).toEqual(['note0', 'note1'])
  })

  it('a transaction whose file another writer changed after its read starts again from a fresh read, keeping both notes (the fence)', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'b1', person('note0'))
    let tries = 0
    await store.transact('k', async () => {
      tries++
      if (tries === 1) await writeFile(annotationsFile('k'), JSON.stringify({ b1: [person('note0'), person('foreign')] }))
      await store.add('k', 'b1', person('mine'))
    })
    expect(tries).toBe(2)
    expect((await store.list('k')).b1.map((c) => c.text)).toEqual(['note0', 'foreign', 'mine'])
  })

  it('a transaction whose lock was broken and taken by another writes nothing under it, and starts again once it can lock', async () => {
    const lockFile = `${annotationsFile('k')}.lock`
    let tries = 0
    let foreign = false
    const store = createAnnotationStore(dir, {
      // The other holder lets go at the first pause.
      sleep: async () => { if (foreign) { foreign = false; await rm(lockFile, { force: true }) } }
    })
    await store.add('k', 'b1', person('note0'))
    await store.transact('k', async () => {
      tries++
      if (tries === 1) { await writeFile(lockFile, 'broken and taken by another'); foreign = true }
      await store.add('k', 'b1', person('mine'))
    })
    expect(tries).toBe(2)
    expect((await store.list('k')).b1.map((c) => c.text)).toEqual(['note0', 'mine'])
  })

  it('a transaction that cannot keep its lock after every try fails with the lock error, its added note taken back', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'b1', person('note0'))
    let tries = 0
    const run = store.transact('k', async () => {
      tries++
      await store.add('k', 'b1', person(`mine${tries}`))
      // A writer outside the lock changes the file after every add, each time.
      await writeFile(annotationsFile('k'), JSON.stringify({ b1: [person('note0'), person(`mine${tries}`), person(`foreign${tries}`)] }))
      await store.add('k', 'b2', person('after'))
    })
    await expect(run).rejects.toBeInstanceOf(AnnotationLockError)
    expect(tries).toBe(3)
    const left = (await store.list('k')).b1.map((c) => c.text)
    expect(left).not.toContain('mine3')
    expect(await store.list('k')).not.toHaveProperty('b2')
  })
})

describe('T5: a malformed annotations file reads as empty, and the next write keeps a backup (Opus R5-1)', () => {
  it('an add over `{not json` succeeds and keeps the bytes in a .bad backup', async () => {
    const store = createAnnotationStore(dir)
    await mkdir(join(dir, 'world', 'annotations'), { recursive: true })
    await writeFile(annotationsFile('k'), '{not json')
    expect(await store.listStrict('k')).toEqual({ byItem: {}, migrated: false })
    await store.add('k', 'b1', person('ok'))
    expect(await store.list('k')).toEqual({ b1: [person('ok')] })
    const backups = (await readdir(join(dir, 'world', 'annotations'))).filter((n) => n.endsWith('.bad'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dir, 'world', 'annotations', backups[0]), 'utf8')).toBe('{not json')
  })
})

describe('T4: a store that cannot be read fails closed (Opus R5-3)', () => {
  it('a marked key, after a restart with its store held, shows no note of the file, gives the read-failure words, and a save writes no note', async () => {
    const warn = quiet()
    try {
      await createWorldStore(dir).save(design({ b1: [agent('moved')] }))
      const first = withAnnotations(createWorldStore(dir), createAnnotationStore(dir))
      await first.save((await first.load('design:x')) as WorldDoc)
      expect((await createAnnotationStore(dir).listStrict('design:x')).migrated).toBe(true)
      // An older Termpolis writes a note into the file afterwards.
      await createWorldStore(dir).save(design({ b1: [agent('moved'), agent('written by an older version')] }))
      const held = async (file: string, enc: 'utf8'): Promise<string> => {
        if (file === annotationsFile()) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        return readFile(file, enc)
      }
      const restarted = withAnnotations(createWorldStore(dir), createAnnotationStore(dir, { readFile: held, sleep: async () => undefined }))
      const e = await restarted.load('design:x').then(() => null, (x: unknown) => x)
      expect(e).toBeInstanceOf(WorldReadError)
      expect((e as Error).message).toBe(WORLD_READ_FAILED)
      const before = await readFile(worldFile(), 'utf8')
      await expect(restarted.save(design({ b1: [agent('written by an older version')] }))).rejects.toThrow()
      expect(await readFile(worldFile(), 'utf8')).toBe(before)
    } finally {
      warn.mockRestore()
    }
  })

  it('an unmarked key whose store cannot be read gives the read-failure words too, never the file alone', async () => {
    const warn = quiet()
    try {
      await createWorldStore(dir).save(design({ b1: [agent('note1')] }))
      await mkdir(join(annotationsFile(), 'held'), { recursive: true })
      await expect(withAnnotations(createWorldStore(dir), createAnnotationStore(dir)).load('design:x')).rejects.toBeInstanceOf(WorldReadError)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('NIT R5-4: a marked key ignores the hand-set mark of a file from before', () => {
  it("names a file from before set by hand never win over the store's newer names for that part", async () => {
    await createWorldStore(dir).save(design({}, { runtimeNames: { b1: ['old-name'] }, runtimeHandSet: ['b1'] }))
    const annotations = createAnnotationStore(dir)
    await annotations.addMissing('design:x', { b1: [person(runtimeText(['old-name']))] })
    await annotations.add('design:x', 'b1', person(runtimeText(['new-name'])))
    const loaded = (await withAnnotations(createWorldStore(dir), annotations).load('design:x')) as WorldDoc
    expect(loaded.runtimeNames.b1).toEqual(['new-name'])
    expect(loaded.runtimeHandSet).toEqual(['b1'])
  })

  it('a marked file of claims only reads back its mark as set', async () => {
    const store = createAnnotationStore(dir)
    await mkdir(join(dir, 'world', 'annotations'), { recursive: true })
    await writeFile(annotationsFile(), JSON.stringify({ [MIGRATED_KEY]: true }))
    expect(await store.listStrict('design:x')).toEqual({ byItem: {}, migrated: true })
  })
})

describe('the undo an add answers', () => {
  it('takes back only the note it added, and puts back what the add evicted, the old runtime-names claim included', async () => {
    const store = createAnnotationStore(dir)
    for (const t of notes(1, 20)) await store.add('k', 'b1', person(t))
    await store.add('k', 'b1', person(runtimeText(['old'])))
    const undoNote = await store.add('k', 'b1', person('note21'))
    const undoNames = await store.add('k', 'b1', person(runtimeText(['new'])))
    await store.add('k', 'b2', person('another'))
    expect(typeof undoNote).toBe('function')
    await undoNames!()
    await undoNote!()
    expect((await store.list('k')).b1.map((c) => c.text)).toEqual([...notes(1, 20), runtimeText(['old'])])
    expect((await store.list('k')).b2).toEqual([person('another')])
    // Run again, it changes nothing.
    const before = await readFile(annotationsFile('k'), 'utf8')
    await undoNote!()
    expect(await readFile(annotationsFile('k'), 'utf8')).toBe(before)
  })

  it('an add of a note the part holds already answers an undo that changes nothing', async () => {
    const store = createAnnotationStore(dir)
    await store.add('k', 'b1', person('once'))
    const undo = await store.add('k', 'b1', person('once'))
    await undo!()
    expect(await store.list('k')).toEqual({ b1: [person('once')] })
  })
})

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createAnnotationStore,
  hasPart,
  MAX_ANNOTATION_EVIDENCE,
  MAX_ANNOTATION_TEXT,
  MAX_ANNOTATIONS_PER_ITEM,
  mergeAnnotations
} from '../../src/main/world/annotations'
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

  it('a corrupt file reads as empty and the next add overwrites it', async () => {
    const store = createAnnotationStore(dir)
    await mkdir(folder(), { recursive: true })
    await writeFile(fileFor('k'), '{not json', 'utf8')
    expect(await store.list('k')).toEqual({})
    await store.add('k', 'b1', person('fresh'))
    expect(await store.list('k')).toEqual({ b1: [person('fresh')] })
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
    const store = createAnnotationStore(dir)
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

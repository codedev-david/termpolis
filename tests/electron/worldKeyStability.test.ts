// WPA fix M2: what keys on a folder's project key keeps its key for a normal Windows root, and the annotations a person made
// under a key WPA changed follow the folder to its new key.
import * as crypto from 'crypto'
import { mkdtemp, readFile, readdir, rm, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Faults the adoption must survive: a rename that fails, and lock files that cannot be made (the codes, one per try).
const faults = vi.hoisted(() => ({ rename: false, open: null as string[] | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const fail = (code: string): Error => Object.assign(new Error(code), { code })
  return {
    ...real,
    rename: async (from: string, to: string) => { if (faults.rename) throw fail('EBUSY'); return real.rename(from, to) },
    open: async (...a: Parameters<typeof real.open>) => {
      const code = faults.open?.shift()
      if (code) throw code === 'none' ? new Error('no code at all') : fail(code)
      return real.open(...a)
    },
  }
})

import {
  adoptAnnotationAliases, createAnnotationStore, ANNOTATION_LOCK_RETRY_MS, ANNOTATION_LOCK_STALE_MS, MAX_ANNOTATIONS_PER_ITEM,
} from '../../src/main/world/annotations'
import { graphKeyForRoot } from '../../src/main/codeGraph'
import { entityDedupHash } from '../../src/main/swarmMemory'
import { legacyProjectKeyOf, projectKeyAliases, projectKeyOf } from '../../src/main/projectKey'
import type { Claim } from '../../src/shared/world/types'

const sha1 = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')
const claim = (text: string): Claim => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] })

// Normal Windows roots, spelled as the folder picker and the terminals (shared/cwdPath) hand them over.
const ROOTS = [
  'C:\\Users\\DavidEngelhart\\repos\\termpolis',
  'C:\\Users\\X\\My Repo',
  'D:\\work\\api',
  '\\\\server\\share\\repo',
]

describe('keys that must not move for a normal Windows root', () => {
  it.runIf(process.platform === 'win32')('world stores, code graphs and annotations (graphKeyForRoot) keep the key they had before WPA', () => {
    for (const r of ROOTS) {
      expect(graphKeyForRoot(r)).toBe(legacyProjectKeyOf(r))
      expect(graphKeyForRoot(r)).toBe(projectKeyOf(r))
    }
    expect(graphKeyForRoot('C:\\Users\\DavidEngelhart\\repos\\termpolis')).toBe(sha1('c:/users/davidengelhart/repos/termpolis'))
  })
  it('on any platform, the Windows spelling keeps its pre-WPA key', () => {
    for (const r of ROOTS) expect(projectKeyOf(r, 'win32')).toBe(legacyProjectKeyOf(r))
  })
  it('entity dedup hashes (index.ts: entityDedupHash with projectKeyOf) are unchanged', () => {
    const r = 'C:\\Users\\DavidEngelhart\\repos\\termpolis'
    expect(entityDedupHash('MemoryClient', projectKeyOf(r, 'win32'))).toBe(entityDedupHash('MemoryClient', legacyProjectKeyOf(r)))
  })
  it('a key WPA did change (a Git Bash root) still lists its old key among the aliases', () => {
    const r = '/c/Users/X/repo'
    expect(projectKeyOf(r, 'win32')).not.toBe(legacyProjectKeyOf(r))
    expect(projectKeyAliases(r, 'win32')).toContain(legacyProjectKeyOf(r))
  })
})

describe('adoptAnnotationAliases', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'world-annot-alias-')); faults.rename = false; faults.open = null })
  afterEach(async () => { faults.rename = false; faults.open = null; await rm(dir, { recursive: true, force: true }) })
  const folder = (): string => join(dir, 'world', 'annotations')
  const fileFor = (key: string): string => join(folder(), `${sha256(key)}.json`)
  const ms = (n: number): Promise<void> => new Promise((r) => { setTimeout(r, n) })

  it('copies the annotations of an older key to the new one, once, and keeps the old file', async () => {
    const store = createAnnotationStore(dir)
    await store.add('old-key', 'b1', claim('the billing door'))
    expect(await adoptAnnotationAliases(dir, 'new-key', ['new-key', 'missing', 'old-key'])).toEqual(['old-key'])
    expect((await store.list('new-key')).b1[0].text).toBe('the billing door')
    expect((await store.list('old-key')).b1[0].text).toBe('the billing door')
    // The new key has its own file now: a second open copies nothing, and never overwrites what was added since.
    await store.add('new-key', 'b2', claim('added after'))
    expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual([])
    expect(Object.keys(await store.list('new-key')).sort()).toEqual(['b1', 'b2'])
    expect((await readdir(folder())).filter((f) => !f.endsWith('.json'))).toEqual([]) // no temp or lock file is left behind
  })
  it('takes every older spelling: their items merged in the order given, a claim under two keys kept once, each item capped (R-M2)', async () => {
    const store = createAnnotationStore(dir)
    await store.add('git-bash', 'b1', claim('the billing door'))
    await store.add('git-bash', 'b2', claim('from git bash'))
    await store.add('cygwin', 'b1', claim('the billing door')) // the same claim under a second key
    await store.add('cygwin', 'b1', claim('from cygwin'))
    await store.add('cygwin', 'e1', claim('a line'))
    for (let n = 0; n < MAX_ANNOTATIONS_PER_ITEM; n++) await store.add('wsl', 'b2', claim(`wsl ${n}`))
    expect(await adoptAnnotationAliases(dir, 'new-key', ['git-bash', 'empty', 'cygwin', 'cygwin', 'wsl'])).toEqual(['git-bash', 'cygwin', 'wsl'])
    const got = await store.list('new-key')
    expect(got.b1.map((c) => c.text)).toEqual(['the billing door', 'from cygwin'])
    expect(got.e1.map((c) => c.text)).toEqual(['a line'])
    expect(got.b2).toHaveLength(MAX_ANNOTATIONS_PER_ITEM) // the oldest (git bash's) dropped past the cap, as an add drops it
    expect(got.b2[MAX_ANNOTATIONS_PER_ITEM - 1].text).toBe(`wsl ${MAX_ANNOTATIONS_PER_ITEM - 1}`)
  })
  it('a root whose key did not change, no aliases, an empty key, or no older file with claims: nothing is written', async () => {
    expect(await adoptAnnotationAliases(dir, 'k', ['k'])).toEqual([])
    expect(await adoptAnnotationAliases(dir, 'k', [])).toEqual([])
    expect(await adoptAnnotationAliases(dir, '', ['a'])).toEqual([])
    expect(await adoptAnnotationAliases(dir, 'k', ['a', ''])).toEqual([])
    await mkdir(folder(), { recursive: true })
    await writeFile(fileFor('torn'), '{"b1": [', 'utf8') // an older file that does not parse
    await writeFile(fileFor('blank'), '{}', 'utf8')
    expect(await adoptAnnotationAliases(dir, 'k', ['torn', 'blank'])).toEqual([])
    await expect(readFile(fileFor('k'), 'utf8')).rejects.toThrow()
  })
  it('an older "file" that cannot be read leaves everything as it was and never throws', async () => {
    await mkdir(fileFor('old-key'), { recursive: true }) // it exists, but it is a folder
    expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual([])
    await expect(readFile(fileFor('new-key'), 'utf8')).rejects.toThrow()
  })
  it('a copy that cannot be written leaves no temp file and no new file behind, and never throws', async () => {
    await createAnnotationStore(dir).add('old-key', 'b1', claim('kept'))
    faults.rename = true
    expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual([])
    expect((await readdir(folder())).sort()).toEqual([`${sha256('old-key')}.json`])
  })

  describe('the annotation store lock holds across processes (R-M2)', () => {
    it('the copy waits while another process holds the lock on the new key, and never overwrites the file that one saved', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      await writeFile(`${fileFor('new-key')}.lock`, '', 'utf8') // the world host is adding to the new key
      const adopt = adoptAnnotationAliases(dir, 'new-key', ['old-key'])
      await ms(ANNOTATION_LOCK_RETRY_MS * 4)
      await expect(readFile(fileFor('new-key'), 'utf8')).rejects.toThrow() // still waiting: nothing written
      // The host's add lands and lets go: its file is the newer one.
      await writeFile(fileFor('new-key'), JSON.stringify({ b2: [claim('added in the host')] }), 'utf8')
      await rm(`${fileFor('new-key')}.lock`)
      expect(await adopt).toEqual([])
      expect(Object.keys(await createAnnotationStore(dir).list('new-key'))).toEqual(['b2'])
    })
    it('an add waits while the copy holds the lock, then adds on top of the copy', async () => {
      const store = createAnnotationStore(dir)
      await store.add('old-key', 'b1', claim('older'))
      await writeFile(`${fileFor('new-key')}.lock`, '', 'utf8') // main is adopting (another process: another store instance)
      let added = false
      const add = createAnnotationStore(dir).add('new-key', 'b2', claim('newer')).then(() => { added = true })
      await ms(ANNOTATION_LOCK_RETRY_MS * 4)
      expect(added).toBe(false)
      await writeFile(fileFor('new-key'), JSON.stringify({ b1: [claim('older')] }), 'utf8') // the copy lands
      await rm(`${fileFor('new-key')}.lock`)
      await add
      expect(Object.keys(await store.list('new-key')).sort()).toEqual(['b1', 'b2'])
    })
    it('a lock older than ANNOTATION_LOCK_STALE_MS (its holder died) is taken over', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      const lock = `${fileFor('new-key')}.lock`
      await writeFile(lock, '', 'utf8')
      const past = new Date(Date.now() - ANNOTATION_LOCK_STALE_MS - 1_000)
      await utimes(lock, past, past)
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual(['old-key'])
      await expect(readFile(lock, 'utf8')).rejects.toThrow() // released after
    })
    it('a lock let go between the try and the look at its age is tried again at once; EPERM (a lock being deleted) is waited out', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      faults.open = ['EEXIST', 'EPERM'] // the first try sees a lock that is gone by the stat; the second, one being deleted
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual(['old-key'])
      expect(faults.open).toEqual([])
    })
    it('when no lock file can be made at all, the work runs without one, as every write did before', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      faults.open = ['EACCES']
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual(['old-key'])
      expect((await readdir(folder())).filter((f) => f.endsWith('.lock'))).toEqual([])
    })
    it('an error with no code at all is read the same way: the work runs without a lock', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      faults.open = ['none']
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual(['old-key'])
      expect(faults.open).toEqual([])
    })
  })
})

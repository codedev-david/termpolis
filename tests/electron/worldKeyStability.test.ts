// WPA fix M2: what keys on a folder's project key keeps its key for a normal Windows root, and the annotations a person made
// under a key WPA changed follow the folder to its new key.
import * as crypto from 'crypto'
import { mkdtemp, readFile, readdir, rm, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Faults the adoption must survive: a rename that fails; lock files that cannot be made (`lock`: the codes, one per try;
// `lockAlways`: every try); a lock made whose nonce cannot be written (`lockWrite`: how many times, a full disk); a lock file
// that cannot be removed (`rmLock` 'EPERM'), or that another stale-breaker removed first (`rmLock` 'ENOENT', once); a file
// another program holds (`busy`: reads of a path ending so refused with EBUSY, `busyReads` times); a rename onto a path ending
// in `refuseTo` (EIO). `renames` counts every rename tried, so a retry test asserts attempts, never the wall clock, and
// `renamedTo` lists where each rename that landed went, in order.
const faults = vi.hoisted(() => ({
  rename: false, renameOnce: null as string[] | null, lock: null as string[] | null, lockAlways: null as string | null, lockWrite: 0, rmLock: null as 'EPERM' | 'ENOENT' | null,
  busy: '', busyReads: 0, renames: 0, refuseTo: '', renamedTo: [] as string[],
}))
const resetFaults = (): void => {
  Object.assign(faults, { rename: false, renameOnce: null, lock: null, lockAlways: null, lockWrite: 0, rmLock: null, busy: '', busyReads: 0, renames: 0, refuseTo: '', renamedTo: [] })
}
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const fail = (code: string): Error => (code === 'none' ? new Error('no code at all') : Object.assign(new Error(code), { code }))
  const isLock = (p: unknown): boolean => String(p).endsWith('.lock')
  return {
    ...real,
    readFile: async (...a: Parameters<typeof real.readFile>) => {
      if (faults.busy && String(a[0]).endsWith(faults.busy) && faults.busyReads > 0) {
        faults.busyReads--
        throw fail('EBUSY')
      }
      return real.readFile(...a)
    },
    rename: async (from: string, to: string) => {
      faults.renames++
      const once = faults.renameOnce?.shift()
      if (once || faults.rename) throw fail(once ?? 'EBUSY')
      if (faults.refuseTo && to.endsWith(faults.refuseTo)) throw fail('EIO')
      await real.rename(from, to)
      faults.renamedTo.push(to)
    },
    open: async (...a: Parameters<typeof real.open>) => {
      if (!isLock(a[0])) return real.open(...a)
      const code = faults.lockAlways ?? faults.lock?.shift()
      if (code) throw fail(code)
      const made = await real.open(...a)
      if (faults.lockWrite <= 0) return made
      faults.lockWrite--
      return { writeFile: async () => { throw fail('ENOSPC') }, close: () => made.close() }
    },
    rm: async (...a: Parameters<typeof real.rm>) => {
      const code = isLock(a[0]) ? faults.rmLock : null
      if (!code) return real.rm(...a)
      if (code === 'ENOENT') { faults.rmLock = null; await real.rm(...a) } // the other breaker's delete landed first
      throw fail(code)
    },
  }
})

import {
  adoptAnnotationAliases, createAnnotationStore, withAnnotationFileLock, ANNOTATION_LOCK_DEADLINE_MS, ANNOTATION_LOCK_RETRY_MS,
  ANNOTATION_LOCK_RETRY_MAX_MS, ANNOTATION_LOCK_STALE_MS, MAX_ANNOTATIONS_PER_ITEM, ANNOTATION_RENAME_RETRY_CODES,
  ANNOTATION_RENAME_RETRY_TOTAL_MS, ADOPT_PENDING_SUFFIX,
} from '../../src/main/world/annotations'
import { CLAIM_TRIES, LOCKED_ATTEMPTS } from '../../src/main/world/storeFiles'
import { writeFileSync } from 'node:fs'
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
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'world-annot-alias-')); resetFaults() })
  afterEach(async () => { resetFaults(); await rm(dir, { recursive: true, force: true }) })
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
  describe('an older file another program holds through every retry (WP3 round 2)', () => {
    const quick = { sleep: async () => undefined }
    const pending = (): string => `${fileFor('new-key')}${ADOPT_PENDING_SUFFIX}`
    const holdOld = (opens = 1): void => { faults.busy = `${sha256('old-key')}.json`; faults.busyReads = LOCKED_ATTEMPTS * opens }

    it('is not given up on: the next open adopts it, and the record of it goes', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('the billing door'))
      holdOld()
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], quick)).toEqual([])
      await expect(readFile(fileFor('new-key'), 'utf8')).rejects.toThrow()
      expect(JSON.parse(await readFile(pending(), 'utf8'))).toEqual(['old-key'])
      // the next open: the file reads now
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], quick)).toEqual(['old-key'])
      expect((await createAnnotationStore(dir).list('new-key')).b1[0].text).toBe('the billing door')
      await expect(readFile(pending(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      // and every open after that is the common case again
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], quick)).toEqual([])
    })

    it('an add to the new key meanwhile is kept: the older claims go in before it on a later open, which may be held again first', async () => {
      const store = createAnnotationStore(dir)
      await store.add('old-key', 'b1', claim('older'))
      await store.add('old-key', 'b2', claim('shared'))
      holdOld()
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key', 'other'], quick)).toEqual([])
      await store.add('new-key', 'b2', claim('shared'))
      await store.add('new-key', 'b2', claim('added since'))
      holdOld() // still held on the next open: nothing is written, the record stays
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key', 'other'], quick)).toEqual([])
      expect(JSON.parse(await readFile(pending(), 'utf8'))).toEqual(['old-key'])
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key', 'other'], quick)).toEqual(['old-key'])
      const got = await store.list('new-key')
      expect(got.b1.map((c) => c.text)).toEqual(['older'])
      expect(got.b2.map((c) => c.text)).toEqual(['shared', 'added since'])
      await expect(readFile(pending(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('a new key file that does not read keeps the record and is left as it was; a record that is not a list is dropped', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      await writeFile(fileFor('new-key'), '{"b1": [', 'utf8')
      await writeFile(pending(), JSON.stringify(['old-key']), 'utf8')
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], quick)).toEqual([])
      expect(await readFile(fileFor('new-key'), 'utf8')).toBe('{"b1": [')
      expect(JSON.parse(await readFile(pending(), 'utf8'))).toEqual(['old-key'])
      await writeFile(fileFor('new-key'), '{}', 'utf8')
      await writeFile(pending(), '{"not":"a list"}', 'utf8')
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], quick)).toEqual([])
      expect(await readFile(fileFor('new-key'), 'utf8')).toBe('{}')
      await expect(readFile(pending(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it("a new key file holding notes this version cannot read is backed up before the merge writes it, or left as it was (N1)", async () => {
      const at = Date.UTC(2026, 10, 23, 1, 2, 3, 4)
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      await mkdir(folder(), { recursive: true })
      const later = JSON.stringify({ b2: [{ text: 'a later note', state: 'verified', evidence: [{ kind: 'review', ref: 'a later kind' }] }] })
      await writeFile(fileFor('new-key'), later, 'utf8')
      await writeFile(pending(), JSON.stringify(['old-key']), 'utf8')
      // every backup name taken: the merge is held back, the file and the record stay
      const crowded = (): number => {
        for (let n = 1; n <= CLAIM_TRIES; n++) writeFileSync(`${fileFor('new-key')}.2026-11-23T01-02-03-004Z-${n}.bad`, 'taken')
        return at
      }
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], { ...quick, now: crowded })).toEqual([])
      expect(await readFile(fileFor('new-key'), 'utf8')).toBe(later)
      expect(JSON.parse(await readFile(pending(), 'utf8'))).toEqual(['old-key'])
      for (let n = 1; n <= CLAIM_TRIES; n++) await rm(`${fileFor('new-key')}.2026-11-23T01-02-03-004Z-${n}.bad`)
      // a backup can be made: it holds the file as it was, and the merge lands
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], { ...quick, now: () => at })).toEqual(['old-key'])
      expect(await readFile(`${fileFor('new-key')}.2026-11-23T01-02-03-004Z-1.bad`, 'utf8')).toBe(later)
      expect((await createAnnotationStore(dir).list('new-key')).b1[0].text).toBe('older')
    })

    it('a record that cannot be written costs only the retry, and never throws', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      holdOld()
      faults.rename = true
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], quick)).toEqual([])
      expect((await readdir(folder())).sort()).toEqual([`${sha256('old-key')}.json`])
    })

    it('on a first adoption the record of a held key is written before the merged file (M2)', async () => {
      const store = createAnnotationStore(dir)
      await store.add('old-key', 'b1', claim('held'))
      await store.add('other', 'b2', claim('read fine'))
      holdOld()
      faults.renamedTo = []
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key', 'other'], quick)).toEqual(['other'])
      expect(faults.renamedTo).toEqual([pending(), fileFor('new-key')]) // the record first: a crash after it still retries
      expect(JSON.parse(await readFile(pending(), 'utf8'))).toEqual(['old-key'])
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key', 'other'], quick)).toEqual(['old-key'])
      expect(Object.keys(await store.list('new-key')).sort()).toEqual(['b1', 'b2'])
    })

    it('a record that cannot be written on a first adoption means nothing is written, so the next open tries every key again (M2)', async () => {
      const store = createAnnotationStore(dir)
      await store.add('old-key', 'b1', claim('held'))
      await store.add('other', 'b2', claim('read fine'))
      holdOld()
      faults.refuseTo = ADOPT_PENDING_SUFFIX
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key', 'other'], quick)).toEqual([])
      await expect(readFile(fileFor('new-key'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(pending(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      faults.refuseTo = ''
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key', 'other'], quick)).toEqual(['old-key', 'other'])
      expect(Object.keys(await store.list('new-key')).sort()).toEqual(['b1', 'b2'])
      await expect(readFile(pending(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('a record that only shrinks goes after the merged file: one a crash left behind only merges the same claims again (M2)', async () => {
      const store = createAnnotationStore(dir)
      await store.add('old-key', 'b1', claim('held'))
      holdOld()
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], quick)).toEqual([])
      await store.add('new-key', 'b2', claim('since'))
      faults.renamedTo = []
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], quick)).toEqual(['old-key'])
      expect(faults.renamedTo).toEqual([fileFor('new-key')]) // the merged file; the record is then removed
      const once = await readFile(fileFor('new-key'), 'utf8')
      await writeFile(pending(), JSON.stringify(['old-key']), 'utf8') // as a crash before the removal would leave it
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], quick)).toEqual(['old-key'])
      expect(await readFile(fileFor('new-key'), 'utf8')).toBe(once)
      await expect(readFile(pending(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('waits between the reads of a held file with the real pause when no sleep is given', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      faults.busy = `${sha256('old-key')}.json`
      faults.busyReads = 1
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual(['old-key'])
    })
  })

  it('a copy that cannot be written leaves no temp file and no new file behind, and never throws', async () => {
    await createAnnotationStore(dir).add('old-key', 'b1', claim('kept'))
    faults.rename = true
    expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual([])
    expect((await readdir(folder())).sort()).toEqual([`${sha256('old-key')}.json`])
  })

  describe('a save the OS refuses for a moment (Defender or the indexer holding the file)', () => {
    it('a rename refused with EPERM, EACCES or EBUSY is tried again after a short pause, and the save lands', async () => {
      for (const code of ANNOTATION_RENAME_RETRY_CODES) {
        faults.renameOnce = [code]
        await createAnnotationStore(dir).add('k', `b-${code}`, claim(`saved through ${code}`))
        expect(faults.renameOnce).toEqual([])
      }
      expect(Object.keys(await createAnnotationStore(dir).list('k')).sort()).toEqual(['b-EACCES', 'b-EBUSY', 'b-EPERM'])
      expect((await readdir(folder())).filter((f) => f.endsWith('.tmp'))).toEqual([])
    })
    it('a rename that keeps being refused is tried five times, pausing about a second in all, then throws and leaves no temp file', async () => {
      faults.rename = true
      const t0 = Date.now()
      await expect(createAnnotationStore(dir).add('k', 'b1', claim('never saved'))).rejects.toMatchObject({ code: 'EBUSY' })
      // the pauses are real timers, which never fire early: only a lower bound on the time is safe under load
      expect(Date.now() - t0).toBeGreaterThanOrEqual(ANNOTATION_RENAME_RETRY_TOTAL_MS - 20)
      expect(faults.renames).toBe(5)
      expect((await readdir(folder())).filter((f) => f.endsWith('.tmp'))).toEqual([])
    })
    it('any other rename error is not tried again', async () => {
      faults.renameOnce = ['ENOENT']
      await expect(createAnnotationStore(dir).add('k', 'b1', claim('gone'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(faults.renames).toBe(1)
    })
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
    it('a lock let go between the try and the look at its age is tried again after a pause, each pause longer than the last (R2-I1)', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      faults.lock = ['EEXIST', 'EEXIST'] // two tries see a lock that is gone by the stat
      const pauses: number[] = []
      const lock = { sleep: async (ms: number) => { pauses.push(ms) } }
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], { lock })).toEqual(['old-key'])
      expect(faults.lock).toEqual([])
      expect(pauses).toEqual([ANNOTATION_LOCK_RETRY_MS, ANNOTATION_LOCK_RETRY_MS * 2]) // 25 ms, then 50 ms
      expect(ANNOTATION_LOCK_RETRY_MAX_MS).toBeLessThan(ANNOTATION_LOCK_DEADLINE_MS)
    })
    it('EPERM or EACCES on making the lock (what Windows answers for a folder it will not let us write in) means no lock here: the work runs at once, without one (R2-I1)', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      for (const code of ['EPERM', 'EACCES']) {
        faults.lockAlways = code
        const pauses: number[] = []
        await rm(fileFor('new-key'), { force: true })
        expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], { lock: { sleep: async (ms) => { pauses.push(ms) } } })).toEqual(['old-key'])
        expect(pauses).toEqual([]) // no wait for a lock: the work ran on the first try
        await createAnnotationStore(dir).add('new-key', 'b2', claim(`an add with ${code}`)) // an add ends too
      }
      expect((await readdir(folder())).filter((f) => f.endsWith('.lock'))).toEqual([])
      expect(Object.keys(await createAnnotationStore(dir).list('new-key')).sort()).toEqual(['b1', 'b2'])
    })
    it('an error with no code at all is read the same way: the work runs without a lock', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      faults.lock = ['none']
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'])).toEqual(['old-key'])
      expect(faults.lock).toEqual([])
    })
    it('a stale lock that cannot be removed means no lock here: the work runs without one, and the lock is left as found (R2-I1)', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      const lock = `${fileFor('new-key')}.lock`
      await writeFile(lock, 'a dead holder', 'utf8')
      const past = new Date(Date.now() - ANNOTATION_LOCK_STALE_MS - 1_000)
      await utimes(lock, past, past)
      faults.rmLock = 'EPERM'
      const pauses: number[] = []
      expect(await adoptAnnotationAliases(dir, 'new-key', ['old-key'], { lock: { sleep: async (ms) => { pauses.push(ms) } } })).toEqual(['old-key'])
      expect(pauses).toEqual([]) // no wait: the work ran on the first try
      expect(await readFile(lock, 'utf8')).toBe('a dead holder')
    })
    it('a lock held past ANNOTATION_LOCK_DEADLINE_MS: the world open and an add both go on without it, and leave the holder its lock (R2-I1)', async () => {
      await createAnnotationStore(dir).add('old-key', 'b1', claim('older'))
      const lock = `${fileFor('new-key')}.lock`
      await writeFile(lock, 'a live holder that never lets go', 'utf8') // fresh: not stale for another 5 s
      // An injected clock that moves only by the pauses taken: the deadline is reached on it, not on the wall clock.
      let at = Date.now()
      const start = at
      const order: string[] = []
      const clock = { now: () => at, sleep: async (ms: number) => { order.push(`pause ${ms}`); at += ms } }
      const [adopted] = await Promise.all([
        adoptAnnotationAliases(dir, 'new-key', ['old-key'], { lock: clock }).then((r) => { order.push('adopted'); return r }),
        createAnnotationStore(dir).add('other-key', 'b9', claim('unrelated')), // another file's lock: never waits
      ])
      expect(adopted).toEqual(['old-key'])
      // 25, 50 and 100 ms, then 200 ms each until the deadline has passed, and only then the work, without the lock.
      const expected = [ANNOTATION_LOCK_RETRY_MS, ANNOTATION_LOCK_RETRY_MS * 2, ANNOTATION_LOCK_RETRY_MS * 4, ...Array<number>(10).fill(ANNOTATION_LOCK_RETRY_MAX_MS)]
      expect(order).toEqual([...expected.map((ms) => `pause ${ms}`), 'adopted'])
      expect(at - start).toBeGreaterThanOrEqual(ANNOTATION_LOCK_DEADLINE_MS)
      expect(at - start - ANNOTATION_LOCK_RETRY_MAX_MS).toBeLessThan(ANNOTATION_LOCK_DEADLINE_MS) // the last pause was the first past it
      await createAnnotationStore(dir).add('new-key', 'b2', claim('newer'))
      expect(Object.keys(await createAnnotationStore(dir).list('new-key')).sort()).toEqual(['b1', 'b2'])
      expect(await readFile(lock, 'utf8')).toBe('a live holder that never lets go')
    }, 15_000)
    it('two writers break the same stale lock: the one whose delete finds it already gone (ENOENT) takes the lock after all, never runs without it (R3-M2)', async () => {
      await mkdir(folder(), { recursive: true })
      const file = fileFor('k')
      const lock = `${file}.lock`
      await writeFile(lock, 'a dead holder', 'utf8')
      const past = new Date(Date.now() - ANNOTATION_LOCK_STALE_MS - 1_000)
      await utimes(lock, past, past)
      faults.rmLock = 'ENOENT'
      let inside = ''
      expect(await withAnnotationFileLock(file, async () => { inside = await readFile(lock, 'utf8'); return 1 })).toBe(1)
      expect(faults.rmLock).toBeNull()
      expect(inside).toMatch(/^\d+:\S{8,}$/) // held, with its nonce
      await expect(readFile(lock, 'utf8')).rejects.toThrow()
    })
    it('a lock made but never written (a full disk) is removed and the take tried once more; failing twice, the work runs without one and leaves no empty lock behind (R3-M2)', async () => {
      await mkdir(folder(), { recursive: true })
      const file = fileFor('k')
      const lock = `${file}.lock`
      faults.lockWrite = 1
      let inside = ''
      await withAnnotationFileLock(file, async () => { inside = await readFile(lock, 'utf8') })
      expect(faults.lockWrite).toBe(0)
      expect(inside).toMatch(/^\d+:\S{8,}$/)
      await expect(readFile(lock, 'utf8')).rejects.toThrow()

      faults.lockWrite = 2
      const pauses: number[] = []
      expect(await withAnnotationFileLock(file, async () => { await expect(readFile(lock, 'utf8')).rejects.toThrow(); return 5 }, { sleep: async (ms) => { pauses.push(ms) } })).toBe(5)
      expect(faults.lockWrite).toBe(0)
      expect(pauses).toEqual([ANNOTATION_LOCK_RETRY_MS]) // one pause, the take tried once more, then no lock: not a wait to the deadline
      expect((await readdir(folder())).filter((f) => f.endsWith('.lock'))).toEqual([]) // no orphan for others to wait 2 s on

      // An empty lock of ours that cannot be removed either: no lock here, at once (not tried again on top of it).
      faults.lockWrite = 1
      faults.rmLock = 'EPERM'
      expect(await withAnnotationFileLock(file, async () => 6)).toBe(6)
      expect(faults.lockWrite).toBe(0)
      expect(await readFile(lock, 'utf8')).toBe('')
    })
    it('a holder lets go of its lock only while the lock is still its own (its nonce), never a successor that broke it (R2-M2)', async () => {
      await mkdir(folder(), { recursive: true })
      const file = fileFor('k')
      const lock = `${file}.lock`
      const nonces: string[] = []
      // Ours: written with a nonce of its own each time, and removed after.
      for (let n = 0; n < 2; n++) await withAnnotationFileLock(file, async () => { nonces.push(await readFile(lock, 'utf8')) })
      expect(nonces[0]).toMatch(/\S{8,}/)
      expect(nonces[0]).not.toBe(nonces[1])
      await expect(readFile(lock, 'utf8')).rejects.toThrow()
      // A slow holder: another process found the lock stale, broke it and took its own. The holder leaves that one alone.
      expect(await withAnnotationFileLock(file, async () => { await writeFile(lock, 'the successor', 'utf8'); return 7 })).toBe(7)
      expect(await readFile(lock, 'utf8')).toBe('the successor')
      await rm(lock)
      // Broken and let go again before the holder ends: nothing to remove, nothing thrown.
      expect(await withAnnotationFileLock(file, async () => { await rm(lock); return 8 })).toBe(8)
    })
  })
})

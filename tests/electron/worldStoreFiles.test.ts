import { mkdtemp, mkdir, readdir, readFile, rename as realRename, rm, writeFile } from 'node:fs/promises'
import { writeFileSync, type PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BAD_KEEP, CLAIM_TRIES, copyAside, LOCKED_ATTEMPTS, moveAside, retryLocked, sleepMs } from '../../src/main/world/storeFiles'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'store-files-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const coded = (code: string): Error => Object.assign(new Error(code), { code })

describe('retryLocked', () => {
  it('runs again while the file is held (EPERM, EACCES, EBUSY), waiting 100 ms times the attempt', async () => {
    const waits: number[] = []
    const codes = ['EPERM', 'EACCES', 'EBUSY']
    let calls = 0
    const result = await retryLocked(async () => {
      calls++
      const code = codes.shift()
      if (code) throw coded(code)
      return 'done'
    }, async (ms) => { waits.push(ms) })
    expect(result).toBe('done')
    expect(calls).toBe(4)
    expect(waits).toEqual([100, 200, 300])
  })

  it('gives up after the last attempt with the last error, about a second of waiting in all', async () => {
    const waits: number[] = []
    let calls = 0
    await expect(retryLocked(async () => { calls++; throw coded('EBUSY') }, async (ms) => { waits.push(ms) })).rejects.toThrow('EBUSY')
    expect(calls).toBe(LOCKED_ATTEMPTS)
    expect(waits).toEqual([100, 200, 300, 400])
  })

  it('throws any other error at once', async () => {
    const waits: number[] = []
    for (const err of [coded('ENOENT'), new Error('plain'), 'not an error']) {
      await expect(retryLocked(async () => { throw err }, async (ms) => { waits.push(ms) })).rejects.toBe(err)
    }
    expect(waits).toEqual([])
  })

  it('sleepMs waits', async () => {
    const at = Date.now()
    await sleepMs(20)
    expect(Date.now() - at).toBeGreaterThanOrEqual(15)
  })
})

const STAMP = '2026-11-23T01-02-03-004Z'
const now = (): number => Date.UTC(2026, 10, 23, 1, 2, 3, 4)
const numberOf = (name: string): number => Number(/-(\d+)\.bad$/.exec(name)?.[1])
const numbered = (names: string[]): string[] => names.filter((n) => /-\d+\.bad$/.test(n)).sort((a, b) => numberOf(a) - numberOf(b))
const crowd = (file: string): (() => number) => () => {
  for (let n = 1; n <= CLAIM_TRIES; n++) writeFileSync(`${file}.${STAMP}-${n}.bad`, 'theirs')
  return now()
}

describe('moveAside', () => {
  it('moves the file to <file>.<stamp>-<n>.bad, n one past the highest number there', async () => {
    const file = join(dir, 'w.json')
    for (const text of ['one', 'two', 'three']) {
      await writeFile(file, text)
      expect(await moveAside(file, { now })).toBe(true)
    }
    expect((await readdir(dir)).sort()).toEqual([`w.json.${STAMP}-1.bad`, `w.json.${STAMP}-2.bad`, `w.json.${STAMP}-3.bad`])
    expect(await readFile(join(dir, `w.json.${STAMP}-1.bad`), 'utf8')).toBe('one')
    expect(await readFile(join(dir, `w.json.${STAMP}-3.bad`), 'utf8')).toBe('three')
  })

  it(`keeps the ${BAD_KEEP} highest-numbered backups and never prunes the old fixed-name .bad (M3)`, async () => {
    const file = join(dir, 'w.json')
    await writeFile(`${file}.bad`, 'legacy')
    await writeFile(join(dir, 'other.json.2026-01-01T00-00-00-000Z-1.bad'), 'another file')
    let clock = Date.UTC(2026, 0, 1)
    for (let i = 0; i < BAD_KEEP + 2; i++) {
      await writeFile(file, String(i))
      await moveAside(file, { now: () => clock })
      clock += 1000
    }
    const names = await readdir(dir)
    expect(await readFile(`${file}.bad`, 'utf8')).toBe('legacy')
    expect(names).toContain('other.json.2026-01-01T00-00-00-000Z-1.bad')
    const kept = numbered(names.filter((n) => n.startsWith('w.json.')))
    expect(kept).toHaveLength(BAD_KEEP)
    expect(await Promise.all(kept.map((n) => readFile(join(dir, n), 'utf8')))).toEqual(['2', '3', '4', '5', '6'])
  })

  it('orders by number, not by clock: a clock that goes back never gets the newest backup pruned (M4)', async () => {
    const file = join(dir, 'w.json')
    let clock = Date.UTC(2026, 5, 1)
    for (let i = 0; i < BAD_KEEP + 1; i++) {
      await writeFile(file, String(i))
      await moveAside(file, { now: () => clock })
      clock -= 86_400_000 // each backup stamped a day earlier than the last
    }
    const kept = numbered(await readdir(dir))
    expect(await Promise.all(kept.map((n) => readFile(join(dir, n), 'utf8')))).toEqual(['1', '2', '3', '4', '5'])
  })

  it('a rename a held file refuses for a moment is tried again (M2)', async () => {
    const file = join(dir, 'w.json')
    await writeFile(file, 'x')
    const waits: number[] = []
    let refusals = 2
    const rename = async (from: PathLike, to: PathLike): Promise<void> => {
      if (refusals-- > 0) throw coded('EBUSY')
      await realRename(from, to)
    }
    expect(await moveAside(file, { now, rename, sleep: async (ms) => { waits.push(ms) } })).toBe(true)
    expect(waits).toEqual([100, 200])
    expect(await readdir(dir)).toEqual([`w.json.${STAMP}-1.bad`])
  })

  it('a refused rename leaves the file where it was with no empty backup; a missing file or folder is a quiet false', async () => {
    const file = join(dir, 'w.json')
    await writeFile(file, 'x')
    expect(await moveAside(file, { now, rename: async () => { throw coded('EINVAL') } })).toBe(false)
    expect(await readdir(dir)).toEqual(['w.json'])
    expect(await moveAside(join(dir, 'missing.json'), { now })).toBe(false)
    expect(await readdir(dir)).toEqual(['w.json'])
    expect(await moveAside(join(dir, 'nowhere', 'w.json'), { now })).toBe(false)
  })

  it('a name another process takes between the look at the folder and the claim is skipped for the next number (M5)', async () => {
    const file = join(dir, 'w.json')
    await writeFile(file, 'mine')
    const racing = (): number => {
      writeFileSync(`${file}.${STAMP}-1.bad`, 'theirs')
      return now()
    }
    expect(await moveAside(file, { now: racing })).toBe(true)
    expect(await readFile(`${file}.${STAMP}-1.bad`, 'utf8')).toBe('theirs')
    expect(await readFile(`${file}.${STAMP}-2.bad`, 'utf8')).toBe('mine')
  })

  it(`gives up after ${CLAIM_TRIES} taken names and leaves the file where it was`, async () => {
    const file = join(dir, 'w.json')
    await writeFile(file, 'mine')
    expect(await moveAside(file, { now: crowd(file) })).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('mine')
  })

  it('a folder it cannot list, or a backup it cannot remove, is left alone', async () => {
    // the rename lands but the folder is gone by the time pruning lists it
    const gone = join(dir, 'gone')
    await mkdir(gone)
    await writeFile(join(gone, 'w.json'), 'x')
    expect(await moveAside(join(gone, 'w.json'), { now, rename: async () => { await rm(gone, { recursive: true }) } })).toBe(true)
    expect(await readdir(dir)).toEqual([])
    // a non-empty folder named like the oldest backup cannot be removed by a plain rm
    const file = join(dir, 'w.json')
    const stuck = `${file}.2026-01-01T00-00-00-000Z-1.bad`
    await mkdir(stuck)
    await writeFile(join(stuck, 'inside'), 'x')
    for (let i = 0; i < BAD_KEEP; i++) {
      await writeFile(file, String(i))
      await moveAside(file, { now })
    }
    const names = await readdir(dir)
    expect(names).toContain('w.json.2026-01-01T00-00-00-000Z-1.bad')
    expect(names).toHaveLength(BAD_KEEP + 1)
  })
})

describe('copyAside', () => {
  it('copies the file byte for byte, leaving it in place', async () => {
    const file = join(dir, 'w.json')
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x0d, 0x0a, 0x7d, 0xff])
    await writeFile(file, bytes)
    expect(await copyAside(file, { now })).toBe(true)
    expect((await readFile(file)).equals(bytes)).toBe(true)
    expect((await readFile(`${file}.${STAMP}-1.bad`)).equals(bytes)).toBe(true)
  })

  it('makes one backup per distinct content: the same bytes again, or bytes the old .bad holds, make none', async () => {
    const file = join(dir, 'w.json')
    await writeFile(`${file}.bad`, 'old')
    await writeFile(file, 'old')
    expect(await copyAside(file, { now })).toBe(true)
    expect(await readdir(dir)).toHaveLength(2)
    await writeFile(file, 'new')
    for (let i = 0; i < 3; i++) expect(await copyAside(file, { now })).toBe(true)
    expect((await readdir(dir)).sort()).toEqual(['w.json', `w.json.${STAMP}-1.bad`, 'w.json.bad'])
    await writeFile(file, 'newer')
    expect(await copyAside(file, { now })).toBe(true)
    expect(await readFile(`${file}.${STAMP}-2.bad`, 'utf8')).toBe('newer')
  })

  it(`prunes to the ${BAD_KEEP} newest copies, never the one just made`, async () => {
    const file = join(dir, 'w.json')
    for (let i = 0; i < BAD_KEEP + 1; i++) {
      await writeFile(file, `v${i}`)
      await copyAside(file, { now })
    }
    const kept = numbered(await readdir(dir))
    expect(await Promise.all(kept.map((n) => readFile(join(dir, n), 'utf8')))).toEqual(['v1', 'v2', 'v3', 'v4', 'v5'])
  })

  it('a file it cannot read, a name it cannot claim, or a copy it cannot write is false, with no backup left', async () => {
    const file = join(dir, 'w.json')
    expect(await copyAside(file, { now, sleep: async () => undefined })).toBe(false)
    await writeFile(file, 'x')
    expect(await copyAside(file, { now, writeFile: async () => { throw coded('ENOSPC') } })).toBe(false)
    expect(await readdir(dir)).toEqual(['w.json'])
    expect(await copyAside(file, { now: crowd(file) })).toBe(false)
    expect(numbered(await readdir(dir))).toHaveLength(CLAIM_TRIES)
  })
})

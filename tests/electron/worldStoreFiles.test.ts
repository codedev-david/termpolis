import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BAD_KEEP, LOCKED_ATTEMPTS, moveAside, retryLocked, sleepMs } from '../../src/main/world/storeFiles'

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

describe('moveAside', () => {
  const now = (): number => Date.UTC(2026, 10, 23, 1, 2, 3, 4)

  it('moves the file to <file>.<stamp>.bad, numbering same-millisecond backups', async () => {
    const file = join(dir, 'w.json')
    for (const text of ['one', 'two', 'three']) {
      await writeFile(file, text)
      await moveAside(file, { now })
    }
    expect((await readdir(dir)).sort()).toEqual(['w.json.2026-11-23T01-02-03-004Z-1.bad', 'w.json.2026-11-23T01-02-03-004Z-2.bad', 'w.json.2026-11-23T01-02-03-004Z.bad'])
    expect(await readFile(join(dir, 'w.json.2026-11-23T01-02-03-004Z.bad'), 'utf8')).toBe('one')
    expect(await readFile(join(dir, 'w.json.2026-11-23T01-02-03-004Z-2.bad'), 'utf8')).toBe('three')
  })

  it(`keeps the ${BAD_KEEP} newest backups, the old fixed name counting as the oldest`, async () => {
    const file = join(dir, 'w.json')
    await writeFile(`${file}.bad`, 'legacy')
    let clock = Date.UTC(2026, 0, 1)
    for (let i = 0; i < BAD_KEEP; i++) {
      await writeFile(file, String(i))
      await moveAside(file, { now: () => clock })
      clock += 1000
    }
    const names = (await readdir(dir)).sort()
    expect(names).toHaveLength(BAD_KEEP)
    expect(names).not.toContain('w.json.bad')
  })

  it('a refused rename leaves the file where it was, and a missing file is a quiet no-op', async () => {
    const file = join(dir, 'w.json')
    await writeFile(file, 'x')
    await moveAside(file, { now, rename: async () => { throw coded('EPERM') } })
    expect(await readdir(dir)).toEqual(['w.json'])
    await moveAside(join(dir, 'missing.json'), { now })
    expect(await readdir(dir)).toEqual(['w.json'])
  })

  it('a folder it cannot list, or a backup it cannot remove, is left alone', async () => {
    // the rename lands but the folder is gone by the time pruning lists it
    const gone = join(dir, 'gone')
    await mkdir(gone)
    await moveAside(join(gone, 'w.json'), { now, rename: async () => { await rm(gone, { recursive: true }) } })
    expect(await readdir(dir)).toEqual([])
    // a non-empty folder named like the oldest backup cannot be removed by a plain rm
    const file = join(dir, 'w.json')
    await mkdir(`${file}.bad`)
    await writeFile(join(`${file}.bad`, 'inside'), 'x')
    let clock = Date.UTC(2026, 0, 1)
    for (let i = 0; i < BAD_KEEP; i++) {
      await writeFile(file, String(i))
      await moveAside(file, { now: () => clock })
      clock += 1000
    }
    expect(await readdir(dir)).toContain('w.json.bad')
    expect((await readdir(dir)).filter((n) => n !== 'w.json.bad')).toHaveLength(BAD_KEEP)
  })
})

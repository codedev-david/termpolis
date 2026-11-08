import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { offMainFiles } from '../../src/main/offMainFiles'
import { loadElisionFromDisk, saveElisionToDisk, ELISION_FILE } from '../../src/main/headroom/elisionStore'
import { recordElision, recordRedemption, elisionState, resetElisionLedger } from '../../src/main/headroom/elisionLedger'

/**
 * The lifetime counts survive a relaunch, or the redemption rate would restart from nothing each
 * time the app does. A missing or damaged file starts the count over; it must never throw into boot.
 */

let dir: string
beforeEach(() => { resetElisionLedger(); dir = mkdtempSync(join(tmpdir(), 'tp-r1-elision-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const meta = { kind: 'compact' as const, tool: 'Read', chars: 5000, view: 1100 }

describe('elision persistence', () => {
  it('round-trips the lifetime counts through one small file', async () => {
    recordElision('hr_0000000000000001', meta)
    recordElision('hr_0000000000000002', meta)
    recordRedemption('hr_0000000000000001', meta)
    recordRedemption('hr_0000000000000009')
    const before = elisionState()
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    expect(ELISION_FILE).toBe('elision-ledger.json')
    expect(existsSync(join(dir, ELISION_FILE))).toBe(true)
    resetElisionLedger()
    loadElisionFromDisk(dir)
    expect(elisionState()).toEqual(before)
  })

  it('creates the directory when it is not there yet', async () => {
    const nested = join(dir, 'a', 'b')
    recordElision('hr_0000000000000001', meta)
    saveElisionToDisk(nested)
    await offMainFiles.idle()
    expect(existsSync(join(nested, ELISION_FILE))).toBe(true)
  })

  it('writes plain JSON a person can read', async () => {
    recordElision('hr_0000000000000001', meta)
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    const raw = JSON.parse(readFileSync(join(dir, ELISION_FILE), 'utf8')) as { classes: Record<string, { elided: number }> }
    expect(raw.classes['compact|Read|4-10k'].elided).toBe(1)
  })

  it('starts at zero when there is no file, and when the file is not JSON', async () => {
    loadElisionFromDisk(dir)
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
    recordElision('hr_0000000000000001', meta)
    writeFileSync(join(dir, ELISION_FILE), '{ not json', 'utf8')
    expect(() => loadElisionFromDisk(dir)).not.toThrow()
    // an unreadable file changes nothing that was already counted
    expect(elisionState().classes['compact|Read|4-10k'].elided).toBe(1)
  })

  it('reads a file with an unexpected shape as empty', async () => {
    recordElision('hr_0000000000000001', meta)
    writeFileSync(join(dir, ELISION_FILE), JSON.stringify([1, 2, 3]), 'utf8')
    loadElisionFromDisk(dir)
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
  })

  it('never throws when the directory cannot be written', async () => {
    const blocker = join(dir, 'file-in-the-way')
    writeFileSync(blocker, 'x', 'utf8')
    expect(() => saveElisionToDisk(join(blocker, 'sub'))).not.toThrow()
    await offMainFiles.idle()
    // the failed write cleared the saved mark, so the same dir is tried again rather than skipped
    rmSync(blocker)
    saveElisionToDisk(join(blocker, 'sub'))
    await offMainFiles.idle()
    expect(existsSync(join(blocker, 'sub', ELISION_FILE))).toBe(true)
  })
})

describe('the save runs on the debounce that already writes the totals, so it writes only what is new', () => {
  const file = (): string => join(dir, ELISION_FILE)

  it('writes nothing when the counts have not changed since the last save', async () => {
    recordElision('hr_0000000000000001', meta)
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    rmSync(file()) // were it written again, it would be back
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    saveElisionToDisk(dir)
    expect(existsSync(file())).toBe(false)
  })

  it('writes again as soon as a count changes, whichever kind of change it is', async () => {
    recordElision('hr_0000000000000001', meta)
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    for (const change of [
      () => recordElision('hr_0000000000000002', meta),
      () => recordRedemption('hr_0000000000000001', meta),
      () => recordRedemption(undefined),
    ]) {
      rmSync(file(), { force: true })
      change()
      saveElisionToDisk(dir)
      await offMainFiles.idle()
      expect(existsSync(file())).toBe(true)
    }
  })

  it('writes the first time even when the ledger is empty, so the file exists from then on', async () => {
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    expect(existsSync(file())).toBe(true)
  })

  it('writes to a directory it has not written to, whatever the counts', async () => {
    recordElision('hr_0000000000000001', meta)
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    const other = join(dir, 'other')
    saveElisionToDisk(other)
    await offMainFiles.idle()
    expect(existsSync(join(other, ELISION_FILE))).toBe(true)
  })

  it('writes after a reset to zero, which is a change a skipped save must not hide', async () => {
    recordElision('hr_0000000000000001', meta)
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    resetElisionLedger()
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ classes: {}, legacyRedeemed: 0 })
  })

  it('retries a write that failed instead of taking it for saved', async () => {
    recordElision('hr_0000000000000001', meta)
    const blocker = join(dir, 'file-in-the-way')
    writeFileSync(blocker, 'x', 'utf8')
    saveElisionToDisk(join(blocker, 'sub')) // cannot be created
    await offMainFiles.idle()
    await new Promise((r) => setImmediate(r)) // the failed write's catch clears the mark
    rmSync(blocker)
    saveElisionToDisk(join(blocker, 'sub')) // now it can, and nothing has changed since
    await offMainFiles.idle()
    expect(existsSync(join(blocker, 'sub', ELISION_FILE))).toBe(true)
  })

  it('treats what a load adopted as already saved, and a file it could not read as not', async () => {
    recordElision('hr_0000000000000001', meta)
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    resetElisionLedger()
    loadElisionFromDisk(dir)
    rmSync(file())
    saveElisionToDisk(dir) // the file held exactly this
    expect(existsSync(file())).toBe(false)
    writeFileSync(file(), '{ not json', 'utf8')
    loadElisionFromDisk(dir) // unreadable: the ledger keeps what it had, and the file is not what it holds
    recordRedemption(undefined)
    saveElisionToDisk(dir)
    await offMainFiles.idle()
    expect(JSON.parse(readFileSync(file(), 'utf8')).legacyRedeemed).toBe(1)
  })
})

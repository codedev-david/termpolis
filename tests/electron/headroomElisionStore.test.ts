import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  it('round-trips the lifetime counts through one small file', () => {
    recordElision('hr_0000000000000001', meta)
    recordElision('hr_0000000000000002', meta)
    recordRedemption('hr_0000000000000001', meta)
    recordRedemption('hr_0000000000000009')
    const before = elisionState()
    saveElisionToDisk(dir)
    expect(ELISION_FILE).toBe('elision-ledger.json')
    expect(existsSync(join(dir, ELISION_FILE))).toBe(true)
    resetElisionLedger()
    loadElisionFromDisk(dir)
    expect(elisionState()).toEqual(before)
  })

  it('creates the directory when it is not there yet', () => {
    const nested = join(dir, 'a', 'b')
    recordElision('hr_0000000000000001', meta)
    saveElisionToDisk(nested)
    expect(existsSync(join(nested, ELISION_FILE))).toBe(true)
  })

  it('writes plain JSON a person can read', () => {
    recordElision('hr_0000000000000001', meta)
    saveElisionToDisk(dir)
    const raw = JSON.parse(readFileSync(join(dir, ELISION_FILE), 'utf8')) as { classes: Record<string, { elided: number }> }
    expect(raw.classes['compact|Read|4-10k'].elided).toBe(1)
  })

  it('starts at zero when there is no file, and when the file is not JSON', () => {
    loadElisionFromDisk(dir)
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
    recordElision('hr_0000000000000001', meta)
    writeFileSync(join(dir, ELISION_FILE), '{ not json', 'utf8')
    expect(() => loadElisionFromDisk(dir)).not.toThrow()
    // an unreadable file changes nothing that was already counted
    expect(elisionState().classes['compact|Read|4-10k'].elided).toBe(1)
  })

  it('reads a file with an unexpected shape as empty', () => {
    recordElision('hr_0000000000000001', meta)
    writeFileSync(join(dir, ELISION_FILE), JSON.stringify([1, 2, 3]), 'utf8')
    loadElisionFromDisk(dir)
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
  })

  it('never throws when the directory cannot be written', () => {
    const blocker = join(dir, 'file-in-the-way')
    writeFileSync(blocker, 'x', 'utf8')
    expect(() => saveElisionToDisk(join(blocker, 'sub'))).not.toThrow()
  })
})

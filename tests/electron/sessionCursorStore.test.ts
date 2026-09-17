import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initSessionCursors,
  getSessionCursor,
  setSessionCursor,
  sessionCursorKey,
  flushSessionCursors,
  resetSessionCursors,
} from '../../src/main/sessionCursorStore'

// Solo-session reflection tracks how far into a terminal's transcript it has already
// learned. Through v1.46 that cursor lived in a plain in-memory Map keyed by terminalId:
//
//   * quitting inside the 60s idle window dropped the pending delta, and
//   * terminalId is minted fresh every launch, so even the POSITION was gone — the next
//     run started from zero on a transcript it had already read.
//
// The durable key is the transcript's own identity (cwd + agent), not the terminal that
// happened to be showing it.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-cursor-'))
  initSessionCursors(dir)
})

afterEach(() => {
  resetSessionCursors()
  rmSync(dir, { recursive: true, force: true })
})

describe('sessionCursorStore', () => {
  it('keys on the transcript, not on the terminal showing it', () => {
    // Two panes on the same repo running the same agent read ONE transcript. Keying by
    // terminalId made the second pane re-reflect turns the first had already learned.
    expect(sessionCursorKey('C:\\repos\\termpolis', 'claude')).toBe(
      sessionCursorKey('C:/repos/Termpolis/', 'claude'),
    )
    expect(sessionCursorKey('C:/repos/termpolis', 'claude')).not.toBe(
      sessionCursorKey('C:/repos/termpolis', 'codex'),
    )
    expect(sessionCursorKey('C:/repos/other', 'claude')).not.toBe(
      sessionCursorKey('C:/repos/termpolis', 'claude'),
    )
  })

  it('survives a restart, so a quit costs the delta but never the position', () => {
    const k = sessionCursorKey('C:/repos/termpolis', 'claude')
    setSessionCursor(k, { count: 12, hash: 'abc' })
    flushSessionCursors()

    resetSessionCursors()
    initSessionCursors(dir)
    expect(getSessionCursor(k)).toEqual({ count: 12, hash: 'abc' })
  })

  it('returns undefined for a transcript it has never reflected', () => {
    expect(getSessionCursor(sessionCursorKey('C:/repos/new', 'claude'))).toBeUndefined()
  })

  it('starts clean when the file is corrupt rather than refusing to learn', () => {
    writeFileSync(join(dir, 'session-cursors.json'), '{not json', 'utf8')
    resetSessionCursors()
    initSessionCursors(dir)
    expect(getSessionCursor(sessionCursorKey('C:/repos/termpolis', 'claude'))).toBeUndefined()
    // ...and it can still record new progress over the bad file.
    setSessionCursor(sessionCursorKey('C:/repos/termpolis', 'claude'), { count: 1, hash: 'h' })
    flushSessionCursors()
    expect(JSON.parse(readFileSync(join(dir, 'session-cursors.json'), 'utf8'))).toHaveProperty(
      sessionCursorKey('C:/repos/termpolis', 'claude'),
    )
  })

  it('evicts the oldest transcripts rather than growing without bound', () => {
    for (let i = 0; i < 600; i++) setSessionCursor(sessionCursorKey(`C:/repos/r${i}`, 'claude'), { count: i, hash: 'h' })
    flushSessionCursors()
    const onDisk = JSON.parse(readFileSync(join(dir, 'session-cursors.json'), 'utf8'))
    expect(Object.keys(onDisk).length).toBeLessThanOrEqual(500)
    // The most recent writes are the ones worth keeping.
    expect(onDisk[sessionCursorKey('C:/repos/r599', 'claude')]).toEqual({ count: 599, hash: 'h' })
    expect(onDisk[sessionCursorKey('C:/repos/r0', 'claude')]).toBeUndefined()
  })

  it('is a silent no-op before init, so a missing userData never breaks reflection', () => {
    resetSessionCursors()
    expect(() => setSessionCursor('k', { count: 1, hash: 'h' })).not.toThrow()
    expect(getSessionCursor('k')).toEqual({ count: 1, hash: 'h' })
    expect(() => flushSessionCursors()).not.toThrow()
  })
})

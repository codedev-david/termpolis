import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock electron's app.getPath('userData') to a per-test tmp dir (aiSecurity pattern).
let tmpDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
  },
}))

// resetModules + dynamic import gives a fresh module (cache cleared) per call —
// which is how we simulate an app restart while the on-disk file persists.
async function freshModule() {
  vi.resetModules()
  return await import('../../src/main/memorySettings')
}

const settingsFile = () => join(tmpDir, 'memory-settings.json')

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'termpolis-memset-'))
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('memorySettings — primer limit', () => {
  it('defaults to 10 when nothing is persisted', async () => {
    const m = await freshModule()
    expect(m.getPrimerLimit()).toBe(10)
    expect(m.getMemorySettings()).toEqual({ primerLimit: 10, vectorQuantize: false, indexClaudeNotes: true, shareNotesAcrossProjects: false })
    expect(m.PRIMER_LIMIT_MIN).toBe(1)
    expect(m.PRIMER_LIMIT_MAX).toBe(50)
  })

  it('persists a set value to disk and returns it', async () => {
    const m = await freshModule()
    expect(m.setPrimerLimit(20)).toEqual({ primerLimit: 20, vectorQuantize: false, indexClaudeNotes: true, shareNotesAcrossProjects: false })
    expect(m.getPrimerLimit()).toBe(20)
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8')).primerLimit).toBe(20)
  })

  it('clamps below min, above max, and rounds fractional input', async () => {
    const m = await freshModule()
    expect(m.setPrimerLimit(0).primerLimit).toBe(1)
    expect(m.setPrimerLimit(-9).primerLimit).toBe(1)
    expect(m.setPrimerLimit(999).primerLimit).toBe(50)
    expect(m.setPrimerLimit(12.7).primerLimit).toBe(13)
  })

  it('falls back to the default on a non-numeric value', async () => {
    const m = await freshModule()
    expect(m.setPrimerLimit(NaN as unknown as number).primerLimit).toBe(10)
    expect(m.setPrimerLimit('abc' as unknown as number).primerLimit).toBe(10)
  })

  it('reloads a persisted value after a restart (fresh module, same dir)', async () => {
    const m1 = await freshModule()
    m1.setPrimerLimit(15)
    const m2 = await freshModule() // simulates restart: new module instance, file remains
    expect(m2.getPrimerLimit()).toBe(15)
  })

  it('ignores a corrupt settings file and uses the default', async () => {
    writeFileSync(settingsFile(), '{ not json', 'utf8')
    const m = await freshModule()
    expect(m.getPrimerLimit()).toBe(10)
  })

  it('clamps an out-of-range persisted value on load', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ primerLimit: 9999 }), 'utf8')
    const m = await freshModule()
    expect(m.getPrimerLimit()).toBe(50)
  })

  it('ignores a valid-JSON non-object settings file', async () => {
    writeFileSync(settingsFile(), 'null', 'utf8')
    const m = await freshModule()
    expect(m.getPrimerLimit()).toBe(10)
  })

  it('recreates the settings directory if it is missing on persist', async () => {
    rmSync(tmpDir, { recursive: true, force: true }) // userData dir vanished
    const m = await freshModule()
    expect(m.setPrimerLimit(22).primerLimit).toBe(22)
    expect(existsSync(settingsFile())).toBe(true)
  })
})

// --------------------------------------------------------------------------------------------
// vectorQuantize — the persisted half of the int8 toggle.
//
// This module only REMEMBERS the choice; applying it (rebuilding the packed store) is
// swarmMemory's job. The thing that matters here is the DEFAULT: a memory system defaults to
// exact, and you opt in to the approximation. An absent key must never be read as "on".
// --------------------------------------------------------------------------------------------
describe('vectorQuantize', () => {
  it('defaults to OFF — exactness is the default, approximation is opt-in', async () => {
    const m = await freshModule()
    expect(m.getVectorQuantize()).toBe(false)
    expect(m.getMemorySettings().vectorQuantize).toBe(false)
  })

  it('persists ON, and survives a reload', async () => {
    const m = await freshModule()
    expect(m.setVectorQuantize(true).vectorQuantize).toBe(true)
    expect(existsSync(settingsFile())).toBe(true)
    const reloaded = await freshModule()
    expect(reloaded.getVectorQuantize()).toBe(true)
  })

  it('persists OFF again — the user can revert and it sticks', async () => {
    let m = await freshModule()
    m.setVectorQuantize(true)
    m = await freshModule()
    expect(m.getVectorQuantize()).toBe(true)
    m.setVectorQuantize(false)
    const reloaded = await freshModule()
    expect(reloaded.getVectorQuantize()).toBe(false)
  })

  it('an absent key in an existing settings file reads as OFF, never as ON', async () => {
    // The upgrade path: everyone already has a memory-settings.json with only primerLimit in it.
    // If a missing key defaulted to `true`, upgrading would silently degrade every user's recall.
    writeFileSync(settingsFile(), JSON.stringify({ primerLimit: 12 }))
    const m = await freshModule()
    expect(m.getVectorQuantize()).toBe(false)
    expect(m.getPrimerLimit()).toBe(12) // and the existing setting is preserved
  })

  it('only a literal true enables it — a truthy string does not', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ vectorQuantize: 'yes' }))
    const m = await freshModule()
    expect(m.getVectorQuantize()).toBe(false)
  })

  it('setting it does not clobber the primer limit', async () => {
    const m = await freshModule()
    m.setPrimerLimit(19)
    const s = m.setVectorQuantize(true)
    expect(s.primerLimit).toBe(19)
    expect(s.vectorQuantize).toBe(true)
  })
})

// --------------------------------------------------------------------------------------------
// Claude Code's saved notes (1.55.0). Two switches with opposite defaults, and the asymmetry is the
// point: bringing a user's own notes into their own memory is on (and disclosed, and gated on the agents
// being connected); letting a note cross from one project to another is off until they say so.
// --------------------------------------------------------------------------------------------
describe('indexClaudeNotes and shareNotesAcrossProjects', () => {
  it('read the notes: ON by default. lend them to other projects: OFF by default', async () => {
    const m = await freshModule()
    expect(m.getIndexClaudeNotes()).toBe(true)
    expect(m.getShareNotesAcrossProjects()).toBe(false)
  })

  it('an existing settings file from before they existed reads the same way: notes on, sharing off', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ primerLimit: 12, vectorQuantize: true }))
    const m = await freshModule()
    expect(m.getIndexClaudeNotes()).toBe(true)
    expect(m.getShareNotesAcrossProjects()).toBe(false)
    expect(m.getPrimerLimit()).toBe(12)
  })

  it('persist, survive a restart, and do not disturb the other settings', async () => {
    const m = await freshModule()
    m.setPrimerLimit(14)
    expect(m.setIndexClaudeNotes(false)).toMatchObject({ indexClaudeNotes: false, primerLimit: 14 })
    expect(m.setShareNotesAcrossProjects(true)).toMatchObject({ shareNotesAcrossProjects: true, indexClaudeNotes: false })
    const again = await freshModule()
    expect(again.getIndexClaudeNotes()).toBe(false)
    expect(again.getShareNotesAcrossProjects()).toBe(true)
    expect(again.getPrimerLimit()).toBe(14)
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toMatchObject({ indexClaudeNotes: false, shareNotesAcrossProjects: true })
  })

  it('only a literal true turns either on: anything else is off, so a bad value never agrees for the user', async () => {
    const m = await freshModule()
    for (const junk of ['true', 1, 'yes', null, undefined, {}]) {
      expect(m.setIndexClaudeNotes(junk).indexClaudeNotes).toBe(false)
      expect(m.setShareNotesAcrossProjects(junk).shareNotesAcrossProjects).toBe(false)
    }
    expect(m.setIndexClaudeNotes(true).indexClaudeNotes).toBe(true)
    expect(m.setShareNotesAcrossProjects(true).shareNotesAcrossProjects).toBe(true)
  })

  it('in a saved file, only a literal false turns the notes off and only a literal true turns sharing on', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: 'no', shareNotesAcrossProjects: 'yes' }))
    const a = await freshModule()
    expect(a.getIndexClaudeNotes()).toBe(true)
    expect(a.getShareNotesAcrossProjects()).toBe(false)
    writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: false, shareNotesAcrossProjects: true }))
    const b = await freshModule()
    expect(b.getIndexClaudeNotes()).toBe(false)
    expect(b.getShareNotesAcrossProjects()).toBe(true)
  })

  it('an unreadable settings file leaves the defaults', async () => {
    writeFileSync(settingsFile(), '{ nope')
    const m = await freshModule()
    expect(m.getIndexClaudeNotes()).toBe(true)
    expect(m.getShareNotesAcrossProjects()).toBe(false)
  })

  it('a second call on the same module answers from what it already loaded', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ vectorQuantize: true, indexClaudeNotes: false, shareNotesAcrossProjects: true }))
    const m = await freshModule()
    expect([m.getVectorQuantize(), m.getVectorQuantize()]).toEqual([true, true])
    expect([m.getIndexClaudeNotes(), m.getIndexClaudeNotes()]).toEqual([false, false])
    expect([m.getShareNotesAcrossProjects(), m.getShareNotesAcrossProjects()]).toEqual([true, true])
    // The file is read once: changing it behind the module's back changes nothing until the next start.
    writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: true, shareNotesAcrossProjects: false }))
    expect(m.getIndexClaudeNotes()).toBe(false)
    expect(m.getShareNotesAcrossProjects()).toBe(true)
  })

  it('every accessor loads the saved file by itself when it is the first call on the module', async () => {
    // Each line is a fresh module, as after a restart: whichever accessor runs first has to read the file.
    writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: false, shareNotesAcrossProjects: true, primerLimit: 17 }))
    expect((await freshModule()).getShareNotesAcrossProjects()).toBe(true)
    expect((await freshModule()).getIndexClaudeNotes()).toBe(false)
    expect((await freshModule()).getMemorySettings()).toMatchObject({ indexClaudeNotes: false, shareNotesAcrossProjects: true, primerLimit: 17 })
    expect((await freshModule()).setShareNotesAcrossProjects(false)).toMatchObject({ shareNotesAcrossProjects: false, indexClaudeNotes: false, primerLimit: 17 })
    expect((await freshModule()).setIndexClaudeNotes(true)).toMatchObject({ indexClaudeNotes: true, shareNotesAcrossProjects: false, primerLimit: 17 })
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toMatchObject({ indexClaudeNotes: true, shareNotesAcrossProjects: false, primerLimit: 17 })
  })
})

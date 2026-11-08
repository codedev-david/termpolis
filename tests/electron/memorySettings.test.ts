import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
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
    expect(m.getMemorySettings()).toEqual({ primerLimit: 10, vectorQuantize: false, learnFromConversations: true, indexClaudeNotes: true, shareNotesAcrossProjects: false })
    expect(m.PRIMER_LIMIT_MIN).toBe(1)
    expect(m.PRIMER_LIMIT_MAX).toBe(50)
  })

  it('persists a set value to disk and returns it', async () => {
    const m = await freshModule()
    expect(m.setPrimerLimit(20)).toEqual({ primerLimit: 20, vectorQuantize: false, learnFromConversations: true, indexClaudeNotes: true, shareNotesAcrossProjects: false })
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
// learnFromConversations — the pause switch for conversation ingest ("Learn from conversations").
//
// The DEFAULT is the point: it is ON, and anything that is not an explicit `false` reads as ON, so
// upgrading, a damaged file or a hand-edited value can never silently stop Termpolis from learning.
// --------------------------------------------------------------------------------------------
describe('a settings file that is valid JSON but not an object', () => {
  // A damaged file is somebody's file: the notes import stays off until the user turns it on (see the notes switches below).
  it('reads as the defaults, except that the notes import stays off (null, a number, a string)', async () => {
    for (const text of ['null', '7', '"x"']) {
      writeFileSync(settingsFile(), text)
      const m = await freshModule()
      expect(m.getMemorySettings(), text).toEqual({ primerLimit: 10, vectorQuantize: false, learnFromConversations: true, indexClaudeNotes: false, shareNotesAcrossProjects: false })
    }
  })
})

describe('learnFromConversations', () => {
  it('is ON when nothing is persisted', async () => {
    const m = await freshModule()
    expect(m.getLearnFromConversations()).toBe(true)
    expect(m.getMemorySettings().learnFromConversations).toBe(true)
  })

  it('persists OFF to memory-settings.json and survives a restart; and ON again sticks too', async () => {
    let m = await freshModule()
    expect(m.setLearnFromConversations(false).learnFromConversations).toBe(false)
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8')).learnFromConversations).toBe(false)
    m = await freshModule()
    expect(m.getLearnFromConversations()).toBe(false)
    m.setLearnFromConversations(true)
    m = await freshModule()
    expect(m.getLearnFromConversations()).toBe(true)
  })

  it('an existing settings file from before this switch (no such key) reads as ON', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ primerLimit: 12, vectorQuantize: true }))
    const m = await freshModule()
    expect(m.getLearnFromConversations()).toBe(true)
    expect(m.getPrimerLimit()).toBe(12)
    expect(m.getVectorQuantize()).toBe(true)
  })

  it('only a literal false turns it off: null, 0, "false", garbage and a damaged file all read as ON', async () => {
    for (const bad of [null, 0, 'false', 'off', 1, {}, []]) {
      writeFileSync(settingsFile(), JSON.stringify({ learnFromConversations: bad }))
      expect((await freshModule()).getLearnFromConversations(), JSON.stringify(bad)).toBe(true)
    }
    writeFileSync(settingsFile(), '{ not json')
    expect((await freshModule()).getLearnFromConversations()).toBe(true)
  })

  it('setting it to anything but a literal false turns it ON (the safe direction), true or not', async () => {
    const m = await freshModule()
    m.setLearnFromConversations(false)
    expect(m.setLearnFromConversations('nope').learnFromConversations).toBe(true)
    m.setLearnFromConversations(false)
    expect(m.setLearnFromConversations(undefined).learnFromConversations).toBe(true)
  })

  it('does not clobber the other settings, and they do not clobber it', async () => {
    const m = await freshModule()
    m.setPrimerLimit(19)
    m.setVectorQuantize(true)
    const s = m.setLearnFromConversations(false)
    expect(s).toEqual({ primerLimit: 19, vectorQuantize: true, learnFromConversations: false, indexClaudeNotes: true, shareNotesAcrossProjects: false })
    m.setPrimerLimit(7)
    m.setVectorQuantize(false)
    expect(m.getLearnFromConversations()).toBe(false)
    const reloaded = await freshModule()
    expect(reloaded.getMemorySettings()).toEqual({ primerLimit: 7, vectorQuantize: false, learnFromConversations: false, indexClaudeNotes: true, shareNotesAcrossProjects: false })
  })

  // NEGATIVE CONTROL: the switch is read live, so flipping it takes effect on the very next question.
  it('control: the value read after a set is the value set (no stale copy)', async () => {
    const m = await freshModule()
    for (const v of [false, true, false, false, true]) {
      m.setLearnFromConversations(v)
      expect(m.getLearnFromConversations()).toBe(v)
    }
  })
})

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

  // The import is on by default because nobody has been asked yet. A saved file is somebody's answer: an absent key is "never asked",
  // and anything present has to be a literal true to be a yes, or a damaged or hand-edited file would agree for the user.
  it('in a saved file, an absent key is the default (on), and a key that is there must be a literal true to turn the import on', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ primerLimit: 12 }))
    expect((await freshModule()).getIndexClaudeNotes()).toBe(true)
    writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: true }))
    expect((await freshModule()).getIndexClaudeNotes()).toBe(true)
    for (const junk of ['no', 'false', 'true', 0, 1, null, [], {}, false]) {
      writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: junk }))
      expect((await freshModule()).getIndexClaudeNotes(), JSON.stringify(junk)).toBe(false)
    }
  })

  it('in a saved file, only a literal true turns sharing on', async () => {
    for (const [junk, want] of [['yes', false], [1, false], [null, false], [false, false], [true, true]] as const) {
      writeFileSync(settingsFile(), JSON.stringify({ shareNotesAcrossProjects: junk }))
      expect((await freshModule()).getShareNotesAcrossProjects(), JSON.stringify(junk)).toBe(want)
    }
    writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: false, shareNotesAcrossProjects: true }))
    const b = await freshModule()
    expect(b.getIndexClaudeNotes()).toBe(false)
    expect(b.getShareNotesAcrossProjects()).toBe(true)
  })

  // A truncated file (a crash or an antivirus lock in the middle of a write) is not an answer either way. The panel shows what
  // is held, so the import stays OFF and the user turns it back on, rather than the file's damage agreeing for them.
  it('a settings file that is there and cannot be read leaves the notes OFF, and sharing off', async () => {
    for (const bad of ['{ nope', '', '{"indexClaudeNotes": tru', 'null', '42', '"on"', '[]', '[true]']) {
      writeFileSync(settingsFile(), bad)
      const m = await freshModule()
      expect(m.getIndexClaudeNotes(), JSON.stringify(bad)).toBe(false)
      expect(m.getShareNotesAcrossProjects(), JSON.stringify(bad)).toBe(false)
      expect(m.getPrimerLimit()).toBe(10) // everything else is the default
    }
  })

  it('a settings file that is not there is a first run: the import is on, as it is by default', async () => {
    expect(existsSync(settingsFile())).toBe(false)
    expect((await freshModule()).getIndexClaudeNotes()).toBe(true)
  })

  it('when the settings folder cannot even be resolved, the answer is unknown and the import stays off', async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({ app: { getPath: () => { throw new Error('not ready') } } }))
    try {
      const m = await import('../../src/main/memorySettings')
      expect(m.getIndexClaudeNotes()).toBe(false)
      expect(m.getShareNotesAcrossProjects()).toBe(false)
    } finally {
      vi.doMock('electron', () => ({ app: { getPath: () => tmpDir } })) // the mock every other test in this file runs against
      vi.resetModules()
    }
  })

  it('a folder where the settings file should be reads as unreadable too, and the user can still turn the import on', async () => {
    mkdirSync(settingsFile())
    const m = await freshModule()
    expect(m.getIndexClaudeNotes()).toBe(false)
    expect(() => m.setIndexClaudeNotes(true)).toThrow() // and nothing can be saved there: said below
  })

  // A choice the panel shows has to be a choice that is kept. persist() used to swallow a failed write, so the panel answered ok
  // with OFF while the file still said ON, and the next start imported again.
  describe('a switch that could not be saved', () => {
    const breakTheFile = (m: { getPrimerLimit(): number }): void => {
      m.getPrimerLimit() // loaded first, so the module holds the good file
      rmSync(settingsFile(), { force: true })
      mkdirSync(settingsFile()) // from here on, writing the settings file fails
    }

    it('turning the import off throws, says why, and leaves the module holding what is on disk', async () => {
      writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: true, primerLimit: 14 }))
      const m = await freshModule()
      breakTheFile(m)
      expect(() => m.setIndexClaudeNotes(false)).toThrow(/could not be saved/i)
      expect(m.getIndexClaudeNotes()).toBe(true) // not the unsaved choice
      expect(m.getMemorySettings()).toMatchObject({ indexClaudeNotes: true, primerLimit: 14 })
    })

    it('turning sharing on throws too, and sharing stays off', async () => {
      const m = await freshModule()
      breakTheFile(m)
      expect(() => m.setShareNotesAcrossProjects(true)).toThrow(/could not be saved/i)
      expect(m.getShareNotesAcrossProjects()).toBe(false)
    })

    it('a switch that is saved is kept in memory and on disk, as before', async () => {
      const m = await freshModule()
      expect(m.setIndexClaudeNotes(false).indexClaudeNotes).toBe(false)
      expect(JSON.parse(readFileSync(settingsFile(), 'utf8')).indexClaudeNotes).toBe(false)
    })

    // "Remove imported notes" turns the import off first. When it is already off there is nothing for the file to hold, so a file
    // that cannot be written must not stand in the way of taking the notes out of memory.
    it('a switch that is already what is asked for is not refused because the file cannot be written', async () => {
      writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: false, shareNotesAcrossProjects: false, primerLimit: 14 }))
      const m = await freshModule()
      breakTheFile(m)
      expect(m.setIndexClaudeNotes(false).indexClaudeNotes).toBe(false)
      expect(m.setShareNotesAcrossProjects(false).shareNotesAcrossProjects).toBe(false)
      expect(m.getMemorySettings()).toMatchObject({ indexClaudeNotes: false, shareNotesAcrossProjects: false, primerLimit: 14 })
    })

    it('...yet it still writes the file when it can, so a file changed behind the module\'s back is put right', async () => {
      writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: false }))
      const m = await freshModule()
      expect(m.getIndexClaudeNotes()).toBe(false)
      writeFileSync(settingsFile(), JSON.stringify({ indexClaudeNotes: true }))
      m.setIndexClaudeNotes(false)
      expect(JSON.parse(readFileSync(settingsFile(), 'utf8')).indexClaudeNotes).toBe(false)
    })

    // A crash in the middle of a write is what leaves the unreadable file the import then fails closed on. The file is replaced
    // whole, from a copy written beside it first (agentConfigIO.atomicWriteText), so it is never found cut short.
    it('a write that fails leaves the settings file as it was', async () => {
      const before = JSON.stringify({ indexClaudeNotes: true, primerLimit: 14 })
      writeFileSync(settingsFile(), before)
      const m = await freshModule()
      m.getPrimerLimit()
      mkdirSync(`${settingsFile()}.termpolis-${process.pid}.tmp`) // where the new copy goes first: the write cannot get that far
      expect(() => m.setIndexClaudeNotes(false)).toThrow(/could not be saved/i)
      expect(readFileSync(settingsFile(), 'utf8')).toBe(before)
    })

    it('leaves no copy of the file beside it after a save', async () => {
      const m = await freshModule()
      m.setIndexClaudeNotes(false)
      m.setPrimerLimit(20)
      expect(readdirSync(tmpDir)).toEqual(['memory-settings.json'])
    })

    it('the other settings stay best effort: a failed write does not throw, as it never did', async () => {
      const m = await freshModule()
      breakTheFile(m)
      expect(() => m.setPrimerLimit(20)).not.toThrow()
      expect(() => m.setVectorQuantize(true)).not.toThrow()
      expect(m.getPrimerLimit()).toBe(20)
    })
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

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
    expect(m.getMemorySettings()).toEqual({ primerLimit: 10, vectorQuantize: false, learnFromConversations: true })
    expect(m.PRIMER_LIMIT_MIN).toBe(1)
    expect(m.PRIMER_LIMIT_MAX).toBe(50)
  })

  it('persists a set value to disk and returns it', async () => {
    const m = await freshModule()
    expect(m.setPrimerLimit(20)).toEqual({ primerLimit: 20, vectorQuantize: false, learnFromConversations: true })
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
  it('reads as the defaults (null, a number, a string)', async () => {
    for (const text of ['null', '7', '"x"']) {
      writeFileSync(settingsFile(), text)
      const m = await freshModule()
      expect(m.getMemorySettings(), text).toEqual({ primerLimit: 10, vectorQuantize: false, learnFromConversations: true })
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
    expect(s).toEqual({ primerLimit: 19, vectorQuantize: true, learnFromConversations: false })
    m.setPrimerLimit(7)
    m.setVectorQuantize(false)
    expect(m.getLearnFromConversations()).toBe(false)
    const reloaded = await freshModule()
    expect(reloaded.getMemorySettings()).toEqual({ primerLimit: 7, vectorQuantize: false, learnFromConversations: false })
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

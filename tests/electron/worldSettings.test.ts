import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_SETTINGS, WORLD_SETTINGS_FILE, createWorldSettings } from '../../src/main/world/worldSettings'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'world-settings-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('worldSettings', () => {
  it('defaults to labelling on when there is no file', () => {
    expect(DEFAULT_WORLD_SETTINGS).toEqual({ worldLabelling: true, worldSpeakAnswers: false, worldAgent: 'claude' })
    expect(WORLD_SETTINGS_FILE).toBe('world-settings.json')
    expect(createWorldSettings(join(dir, WORLD_SETTINGS_FILE)).get()).toEqual({ worldLabelling: true, worldSpeakAnswers: false, worldAgent: 'claude' })
  })

  it('only a literal false turns labelling off', () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    writeFileSync(file, JSON.stringify({ worldLabelling: false }))
    expect(createWorldSettings(file).get().worldLabelling).toBe(false)
    for (const v of ['false', 0, null, 'no']) {
      writeFileSync(file, JSON.stringify({ worldLabelling: v }))
      expect(createWorldSettings(file).get().worldLabelling).toBe(true)
    }
  })

  it('speaking answers is off by default and only a literal true turns it on', () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    writeFileSync(file, JSON.stringify({ worldSpeakAnswers: true }))
    expect(createWorldSettings(file).get().worldSpeakAnswers).toBe(true)
    for (const v of ['true', 1, null, 'yes']) {
      writeFileSync(file, JSON.stringify({ worldSpeakAnswers: v }))
      expect(createWorldSettings(file).get().worldSpeakAnswers).toBe(false)
    }
  })

  it('set applies worldSpeakAnswers on its own, with the other field unchanged', () => {
    const s = createWorldSettings(join(dir, WORLD_SETTINGS_FILE))
    expect(s.set({ worldSpeakAnswers: true, worldAgent: 'claude' })).toEqual({ worldLabelling: true, worldSpeakAnswers: true, worldAgent: 'claude' })
    expect(s.set({ worldSpeakAnswers: 'x' } as never)).toEqual({ worldLabelling: true, worldSpeakAnswers: true, worldAgent: 'claude' })
    expect(s.set({ worldLabelling: false, worldSpeakAnswers: false, worldAgent: 'claude' })).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldAgent: 'claude' })
  })

  it('worldAgent defaults to claude; codex round-trips; llama on disk reads as claude', () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    const s = createWorldSettings(file)
    expect(s.get().worldAgent).toBe('claude')
    expect(s.set({ worldAgent: 'codex' }).worldAgent).toBe('codex')
    expect(createWorldSettings(file).get().worldAgent).toBe('codex')
    expect(s.set({ worldAgent: 'llama' } as never).worldAgent).toBe('codex')
    expect(s.set({ worldLabelling: false }).worldAgent).toBe('codex')
    writeFileSync(file, JSON.stringify({ worldAgent: 'llama' }))
    expect(createWorldSettings(file).get().worldAgent).toBe('claude')
  })

  it('keeps the defaults for a broken file, an array or a non-object', () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    for (const text of ['{ broken', '[false]', 'false', '"x"']) {
      writeFileSync(file, text)
      expect(createWorldSettings(file).get()).toEqual({ worldLabelling: true, worldSpeakAnswers: false, worldAgent: 'claude' })
    }
  })

  it('reads lazily once and caches; set writes the file and returns a copy', () => {
    const file = join(dir, 'nested', WORLD_SETTINGS_FILE)
    let reads = 0
    const s = createWorldSettings(() => {
      reads++
      return file
    })
    expect(reads).toBe(0)
    const a = s.get()
    s.get()
    expect(reads).toBe(1)
    a.worldLabelling = false // a copy: the store is unchanged
    expect(s.get().worldLabelling).toBe(true)
    expect(s.set({ worldLabelling: false })).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldAgent: 'claude' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldAgent: 'claude' })
    expect(createWorldSettings(file).get().worldLabelling).toBe(false)
    // unknown or mistyped fields change nothing
    expect(s.set({ worldLabelling: 'yes' } as never)).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldAgent: 'claude' })
    expect(s.set(undefined as never)).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldAgent: 'claude' })
  })

  it('a write that fails still applies for this run', () => {
    // The target path is a non-empty folder, so the write fails.
    const file = join(dir, WORLD_SETTINGS_FILE)
    mkdirSync(join(file, 'x'), { recursive: true })
    const s = createWorldSettings(file)
    expect(s.set({ worldLabelling: false })).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldAgent: 'claude' })
    expect(s.get().worldLabelling).toBe(false)
  })

  it('a path function that throws leaves the defaults', () => {
    const s = createWorldSettings(() => {
      throw new Error('no userData yet')
    })
    expect(s.get()).toEqual({ worldLabelling: true, worldSpeakAnswers: false, worldAgent: 'claude' })
    expect(s.set({ worldLabelling: false })).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldAgent: 'claude' })
  })
})

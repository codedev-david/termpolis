import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import * as fsp from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORLD_SETTINGS, WORLD_SETTINGS_FILE, createWorldSettings } from '../../src/main/world/worldSettings'

vi.mock('fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs/promises')>()
  return { ...orig, writeFile: vi.fn(orig.writeFile), readFile: vi.fn(orig.readFile) }
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'world-settings-'))
  vi.mocked(fsp.writeFile).mockClear()
  vi.mocked(fsp.readFile).mockClear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function loaded(file: string | (() => string)) {
  const s = createWorldSettings(file)
  await s.ready()
  return s
}

describe('worldSettings', () => {
  it('defaults to labelling on when there is no file', async () => {
    expect(DEFAULT_WORLD_SETTINGS).toEqual({ worldLabelling: true, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
    expect(WORLD_SETTINGS_FILE).toBe('world-settings.json')
    expect((await loaded(join(dir, WORLD_SETTINGS_FILE))).get()).toEqual({ worldLabelling: true, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
  })

  it('the worldSettings module imports none of existsSync, readFileSync, mkdirSync', () => {
    const src = readFileSync(join(__dirname, '../../src/main/world/worldSettings.ts'), 'utf8')
    expect(src).not.toMatch(/Sync\b/)
    expect(src).not.toMatch(/agentConfigIO/)
  })

  it('worldSettings uses no sync fs: get() returns defaults before ready(); ready() loads; three quick sets write once', async () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    writeFileSync(file, JSON.stringify({ worldLabelling: false, worldAgent: 'codex' }))
    const s = createWorldSettings(file)
    expect(s.get()).toEqual(DEFAULT_WORLD_SETTINGS) // nothing read yet
    const first = s.ready()
    expect(s.ready()).toBe(first) // one load, shared
    await first
    expect(vi.mocked(fsp.readFile)).toHaveBeenCalledTimes(1)
    expect(s.get()).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'codex' })
    s.set({ worldLabelling: true })
    s.set({ worldSpeakAnswers: true })
    expect(s.set({ worldAgent: 'claude' })).toEqual({ worldLabelling: true, worldSpeakAnswers: true, worldCiResults: true, worldAgent: 'claude' })
    await s.flush()
    expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ worldLabelling: true, worldSpeakAnswers: true, worldCiResults: true, worldAgent: 'claude' })
    expect(readdirSync(dir)).toEqual([WORLD_SETTINGS_FILE]) // no temp file left behind
    // A set while a write is in flight queues one more write, with the newest values.
    s.set({ worldLabelling: false })
    await new Promise((r) => setTimeout(r, 0))
    s.set({ worldSpeakAnswers: false })
    await s.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
  })

  it('a set before the file has loaded keeps its field and the file keeps the others', async () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    writeFileSync(file, JSON.stringify({ worldLabelling: false, worldAgent: 'codex' }))
    const s = createWorldSettings(file)
    expect(s.set({ worldSpeakAnswers: true })).toEqual({ worldLabelling: true, worldSpeakAnswers: true, worldCiResults: true, worldAgent: 'claude' })
    await s.flush() // the write waits for the load
    expect(s.get()).toEqual({ worldLabelling: false, worldSpeakAnswers: true, worldCiResults: true, worldAgent: 'codex' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ worldLabelling: false, worldSpeakAnswers: true, worldCiResults: true, worldAgent: 'codex' })
  })

  it('only a literal false turns labelling off', async () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    writeFileSync(file, JSON.stringify({ worldLabelling: false }))
    expect((await loaded(file)).get().worldLabelling).toBe(false)
    for (const v of ['false', 0, null, 'no']) {
      writeFileSync(file, JSON.stringify({ worldLabelling: v }))
      expect((await loaded(file)).get().worldLabelling).toBe(true)
    }
  })

  it('speaking answers is off by default and only a literal true turns it on', async () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    writeFileSync(file, JSON.stringify({ worldSpeakAnswers: true }))
    expect((await loaded(file)).get().worldSpeakAnswers).toBe(true)
    for (const v of ['true', 1, null, 'yes']) {
      writeFileSync(file, JSON.stringify({ worldSpeakAnswers: v }))
      expect((await loaded(file)).get().worldSpeakAnswers).toBe(false)
    }
  })

  it('CI results are on by default, only a literal false turns them off, and set takes a boolean only', async () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    expect(DEFAULT_WORLD_SETTINGS.worldCiResults).toBe(true)
    writeFileSync(file, JSON.stringify({ worldCiResults: false }))
    expect((await loaded(file)).get().worldCiResults).toBe(false)
    for (const v of ['false', 0, null, 'no']) {
      writeFileSync(file, JSON.stringify({ worldCiResults: v }))
      expect((await loaded(file)).get().worldCiResults).toBe(true)
    }
    const s = await loaded(join(dir, 'other.json'))
    expect(s.set({ worldCiResults: false }).worldCiResults).toBe(false)
    expect(s.set({ worldCiResults: 'x' } as never).worldCiResults).toBe(false)
    expect(s.set({ worldCiResults: true }).worldCiResults).toBe(true)
    await s.flush()
  })

  it('set applies worldSpeakAnswers on its own, with the other field unchanged', async () => {
    const s = await loaded(join(dir, WORLD_SETTINGS_FILE))
    expect(s.set({ worldSpeakAnswers: true, worldCiResults: false, worldAgent: 'claude' })).toEqual({ worldLabelling: true, worldSpeakAnswers: true, worldCiResults: false, worldAgent: 'claude' })
    expect(s.set({ worldSpeakAnswers: 'x' } as never)).toEqual({ worldLabelling: true, worldSpeakAnswers: true, worldCiResults: false, worldAgent: 'claude' })
    expect(s.set({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: false, worldAgent: 'claude' })).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: false, worldAgent: 'claude' })
    await s.flush()
  })

  it('worldAgent defaults to claude; codex round-trips; llama on disk reads as claude', async () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    const s = await loaded(file)
    expect(s.get().worldAgent).toBe('claude')
    expect(s.set({ worldAgent: 'codex' }).worldAgent).toBe('codex')
    await s.flush()
    expect((await loaded(file)).get().worldAgent).toBe('codex')
    expect(s.set({ worldAgent: 'llama' } as never).worldAgent).toBe('codex')
    expect(s.set({ worldLabelling: false }).worldAgent).toBe('codex')
    await s.flush()
    writeFileSync(file, JSON.stringify({ worldAgent: 'llama' }))
    expect((await loaded(file)).get().worldAgent).toBe('claude')
  })

  it('keeps the defaults for a broken file, an array or a non-object', async () => {
    const file = join(dir, WORLD_SETTINGS_FILE)
    for (const text of ['{ broken', '[false]', 'false', '"x"', 'null']) {
      writeFileSync(file, text)
      expect((await loaded(file)).get()).toEqual({ worldLabelling: true, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
    }
  })

  it('get returns a copy; set writes into a missing folder; mistyped fields change nothing', async () => {
    const file = join(dir, 'nested', WORLD_SETTINGS_FILE)
    const s = await loaded(file)
    const a = s.get()
    a.worldLabelling = false // a copy: the store is unchanged
    expect(s.get().worldLabelling).toBe(true)
    expect(s.set({ worldLabelling: false })).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
    await s.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
    expect((await loaded(file)).get().worldLabelling).toBe(false)
    expect(s.set({ worldLabelling: 'yes' } as never)).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
    expect(s.set(undefined as never)).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
    await s.flush()
  })

  it('a write that fails still applies for this run and leaves no temp file', async () => {
    // The target path is a non-empty folder, so the rename fails.
    const file = join(dir, WORLD_SETTINGS_FILE)
    mkdirSync(join(file, 'x'), { recursive: true })
    const s = await loaded(file)
    expect(s.set({ worldLabelling: false })).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
    await expect(s.flush()).resolves.toBeUndefined()
    expect(s.get().worldLabelling).toBe(false)
    expect(readdirSync(dir)).toEqual([WORLD_SETTINGS_FILE])
  })

  it('a path function that throws leaves the defaults', async () => {
    const s = await loaded(() => {
      throw new Error('no userData yet')
    })
    expect(s.get()).toEqual({ worldLabelling: true, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
    expect(s.set({ worldLabelling: false })).toEqual({ worldLabelling: false, worldSpeakAnswers: false, worldCiResults: true, worldAgent: 'claude' })
    await expect(s.flush()).resolves.toBeUndefined()
  })
})

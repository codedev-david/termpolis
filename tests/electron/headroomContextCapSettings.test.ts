import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { readFileSync } from 'fs'
import { getSettings, setSettings, resetSettings } from '../../src/main/headroom/config'
import { loadSettingsFromDisk, saveSettingsToDisk } from '../../src/main/headroom/persist'
import { CONTEXT_CAP_CHOICES } from '../../src/main/headroom/shapingEnv'
import { offMainFiles } from '../../src/main/offMainFiles'

/**
 * The context cap as a setting (R3 criterion 5): its default (Off, by decision D6, revised), how it is
 * validated, and how it is carried through the settings file, which a version before this release wrote
 * without it.
 */

describe('the context cap setting', () => {
  beforeEach(() => resetSettings())

  it('ships Off: nobody\'s sessions change unless they choose it', () => {
    expect(getSettings().contextCap).toBe(0)
  })

  it('takes 0 and every window Settings offers', () => {
    for (const cap of CONTEXT_CAP_CHOICES) {
      setSettings({ contextCap: cap })
      expect(getSettings().contextCap, String(cap)).toBe(cap)
    }
  })

  it('takes any whole number of tokens inside Anthropic\'s documented range, and the ends of it', () => {
    for (const cap of [100_000, 100_001, 250_000, 999_999, 1_000_000]) {
      setSettings({ contextCap: cap })
      expect(getSettings().contextCap, String(cap)).toBe(cap)
    }
  })

  it('ignores everything else and keeps what it had, never coercing a garbled value into a real window', () => {
    const bad: unknown[] = [
      -1, 1, 99_999, 1_000_001, 2_000_000, 1e21, 250_000.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      '300000', '300k', '', 'on', true, false, null, undefined, {}, [], [300_000], BigInt(300_000),
    ]
    setSettings({ contextCap: 400_000 })
    for (const v of bad) {
      setSettings({ contextCap: v as never })
      expect(getSettings().contextCap, String(typeof v === 'bigint' ? `${v}n` : v)).toBe(400_000)
    }
    // And from Off, a garbled value does not turn it on.
    resetSettings()
    for (const v of bad) {
      setSettings({ contextCap: v as never })
      expect(getSettings().contextCap, String(typeof v === 'bigint' ? `${v}n` : v)).toBe(0)
    }
  })

  it('turns Off with an explicit 0, and not with anything else that is falsy', () => {
    setSettings({ contextCap: 300_000 })
    for (const v of [null, undefined, false, '', Number.NaN]) {
      setSettings({ contextCap: v as never })
      expect(getSettings().contextCap, String(v)).toBe(300_000)
    }
    setSettings({ contextCap: 0 })
    expect(getSettings().contextCap).toBe(0)
  })

  it('is left alone by a partial that is about something else', () => {
    setSettings({ contextCap: 300_000 })
    setSettings({ mode: 'balanced', prefixDecay: false, floorControl: false, firstSightElision: 'legacy', thinkingCap: 4000 })
    expect(getSettings().contextCap).toBe(300_000)
  })

  it('leaves the other settings alone when it changes', () => {
    setSettings({ mode: 'balanced', thinkingCap: 4000 })
    setSettings({ contextCap: 200_000 })
    expect(getSettings()).toMatchObject({ mode: 'balanced', thinkingCap: 4000, contextCap: 200_000, firstSightElision: 'late', wireProxy: true })
  })

  it('is restored to Off by a reset', () => {
    setSettings({ contextCap: 300_000 })
    resetSettings()
    expect(getSettings().contextCap).toBe(0)
  })

  it('does not hand out a reference: changing a copy changes nothing', () => {
    const s = getSettings()
    s.contextCap = 300_000
    expect(getSettings().contextCap).toBe(0)
  })

  it('is independent of the proxy\'s own switches: it does not depend on them and they do not depend on it', () => {
    setSettings({ wireProxy: false, enabled: false })
    setSettings({ contextCap: 300_000 })
    expect(getSettings()).toMatchObject({ wireProxy: false, enabled: false, contextCap: 300_000 })
    setSettings({ contextCap: 0 })
    expect(getSettings()).toMatchObject({ wireProxy: false, enabled: false, contextCap: 0 })
  })
})

describe('the context cap in the settings file', () => {
  let dir: string
  beforeEach(() => {
    resetSettings()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-contextcap-'))
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const write = (obj: unknown): void => fs.writeFileSync(path.join(dir, 'headroom-settings.json'), JSON.stringify(obj), 'utf8')
  const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, 'headroom-settings.json'), 'utf8'))

  // Exactly what v1.54.4 writes: no firstSightElision, no contextCap.
  const V1_54_4 = { enabled: true, wireProxy: true, mode: 'aggressive', steering: true, thinkingCap: 0, adaptiveSteering: true, floorControl: true, prefixDecay: true }

  it('migrates a file written by v1.54.4, which has no such field, to Off and keeps what it had', () => {
    write({ ...V1_54_4, mode: 'balanced', steering: false, thinkingCap: 4000, adaptiveSteering: false, floorControl: false, prefixDecay: false })
    loadSettingsFromDisk(dir)
    const s = getSettings()
    expect(s.contextCap).toBe(0)
    expect(s).toMatchObject({ mode: 'balanced', steering: false, thinkingCap: 4000, adaptiveSteering: false, floorControl: false, prefixDecay: false })
  })

  it('migrates an untouched v1.54.4 file to the defaults of this release, the cap Off among them', () => {
    write(V1_54_4)
    loadSettingsFromDisk(dir)
    expect(getSettings()).toEqual({ ...V1_54_4, firstSightElision: 'late', contextCap: 0 })
  })

  it('keeps a choice across a restart', async () => {
    setSettings({ contextCap: 300_000, mode: 'conservative' })
    saveSettingsToDisk(dir)
    await offMainFiles.idle()
    expect(onDisk().contextCap).toBe(300_000)
    resetSettings()
    expect(getSettings().contextCap).toBe(0)
    loadSettingsFromDisk(dir)
    expect(getSettings()).toMatchObject({ contextCap: 300_000, mode: 'conservative' })
  })

  it('writes Off into the file too, so the file says what the app does', async () => {
    saveSettingsToDisk(dir)
    await offMainFiles.idle()
    expect(onDisk().contextCap).toBe(0)
  })

  it('reads a damaged value as Off rather than as a choice, and keeps the rest of the file', () => {
    for (const bad of ['banana', '300000', 5, 50_000, 5_000_000, 250_000.5, null, {}, [], false, true, -300_000]) {
      resetSettings()
      write({ mode: 'max', contextCap: bad })
      loadSettingsFromDisk(dir)
      expect(getSettings().contextCap, JSON.stringify(bad)).toBe(0)
      expect(getSettings().mode).toBe('max')
    }
  })

  it('keeps the defaults when the file is not JSON at all', () => {
    fs.writeFileSync(path.join(dir, 'headroom-settings.json'), '{ nope', 'utf8')
    loadSettingsFromDisk(dir)
    expect(getSettings().contextCap).toBe(0)
  })

  it('does not let a file written by a newer release with a window we do not offer turn into a different one', () => {
    // A hand edit or a later release may hold a window outside the select; it is a valid window, so it is kept as it is
    write({ contextCap: 250_000 })
    loadSettingsFromDisk(dir)
    expect(getSettings().contextCap).toBe(250_000)
  })
})

describe('where the cap is declared', () => {
  const SRC = path.join(__dirname, '..', '..', 'src')
  const read = (rel: string): string => readFileSync(path.join(SRC, rel), 'utf8')

  it('is a headroom setting held beside the others, validated in one place', () => {
    const config = read('main/headroom/config.ts')
    expect(config).toContain('contextCap: number')
    expect(config).toContain('isContextCapSetting(p.contextCap)')
    // The default is written once, in DEFAULTS, as Off.
    expect(config.match(/contextCap: 0\b/g)?.length).toBe(1)
  })

  it('is sent by the preload bridge and typed for the renderer, both as a number', () => {
    expect(read('preload/index.ts')).toContain('contextCap?: number')
    expect(read('renderer/src/types/index.ts')).toContain('contextCap?: number')
  })
})

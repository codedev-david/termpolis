import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { getSettings, setSettings, resetSettings } from '../../src/main/headroom/config'
import { loadSettingsFromDisk, saveSettingsToDisk } from '../../src/main/headroom/persist'
import { resolveWireMode, FLOOR_MIN_REQUESTS } from '../../src/main/headroom/savingsFloor'
import type { Mode } from '../../src/main/headroom/config'

/**
 * The first-sight policy as a setting: its default, how it is validated and carried through the
 * settings file (a file written before this release has no such field), and how it switches the
 * savings-floor controller off.
 */

describe('the first-sight setting', () => {
  beforeEach(() => resetSettings())

  it('ships on: late', () => {
    expect(getSettings().firstSightElision).toBe('late')
  })

  it('takes late and legacy, and nothing else', () => {
    setSettings({ firstSightElision: 'legacy' })
    expect(getSettings().firstSightElision).toBe('legacy')
    setSettings({ firstSightElision: 'late' })
    expect(getSettings().firstSightElision).toBe('late')
    setSettings({ firstSightElision: 'legacy' })
    for (const bad of ['Late', 'LEGACY', '', 'off', 'on', null, undefined, 0, 1, true, {}, []]) {
      setSettings({ firstSightElision: bad as never })
      expect(getSettings().firstSightElision, String(bad)).toBe('legacy')
    }
  })

  it('is left alone by a partial that is about something else', () => {
    setSettings({ firstSightElision: 'legacy' })
    setSettings({ mode: 'balanced', prefixDecay: false, floorControl: false })
    expect(getSettings().firstSightElision).toBe('legacy')
  })

  it('is restored to late by a reset', () => {
    setSettings({ firstSightElision: 'legacy' })
    resetSettings()
    expect(getSettings().firstSightElision).toBe('late')
  })

  it('does not hand out a reference: changing a copy changes nothing', () => {
    const s = getSettings()
    s.firstSightElision = 'legacy'
    expect(getSettings().firstSightElision).toBe('late')
  })
})

describe('the first-sight setting in the settings file', () => {
  let dir: string
  beforeEach(() => {
    resetSettings()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-firstsight-'))
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const write = (obj: unknown): void => fs.writeFileSync(path.join(dir, 'headroom-settings.json'), JSON.stringify(obj), 'utf8')

  it('migrates a file written before this release, which has no such field, to late and keeps what it had', () => {
    write({ enabled: true, wireProxy: true, mode: 'balanced', steering: false, thinkingCap: 4000, adaptiveSteering: false, floorControl: false, prefixDecay: false })
    loadSettingsFromDisk(dir)
    const s = getSettings()
    expect(s.firstSightElision).toBe('late')
    expect(s).toMatchObject({ mode: 'balanced', steering: false, thinkingCap: 4000, adaptiveSteering: false, floorControl: false, prefixDecay: false })
  })

  it('keeps a legacy choice across a restart', () => {
    setSettings({ firstSightElision: 'legacy', mode: 'conservative' })
    saveSettingsToDisk(dir)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'headroom-settings.json'), 'utf8')).firstSightElision).toBe('legacy')
    resetSettings()
    expect(getSettings().firstSightElision).toBe('late')
    loadSettingsFromDisk(dir)
    expect(getSettings()).toMatchObject({ firstSightElision: 'legacy', mode: 'conservative' })
  })

  it('writes late into the file too, so the file says what the app does', () => {
    saveSettingsToDisk(dir)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'headroom-settings.json'), 'utf8')).firstSightElision).toBe('late')
  })

  it('reads a damaged value as the default rather than as a choice', () => {
    for (const bad of ['banana', 5, null, {}, [], false]) {
      resetSettings()
      write({ mode: 'max', firstSightElision: bad })
      loadSettingsFromDisk(dir)
      expect(getSettings().firstSightElision, JSON.stringify(bad)).toBe('late')
      expect(getSettings().mode).toBe('max')
    }
  })

  it('keeps the defaults when the file is not JSON at all', () => {
    fs.writeFileSync(path.join(dir, 'headroom-settings.json'), '{ nope', 'utf8')
    loadSettingsFromDisk(dir)
    expect(getSettings().firstSightElision).toBe('late')
  })
})

describe('the savings-floor controller under the first-sight policy', () => {
  const MODES: Mode[] = ['conservative', 'balanced', 'aggressive', 'max']
  const ev = (savedPct: number, below: number, eligible: number, floorSavedPct?: number) =>
    ({ savedPct, belowFloorRequests: below, floorEligibleRequests: eligible, ...(floorSavedPct === undefined ? {} : { floorSavedPct }) })
  const ELIGIBLE = FLOOR_MIN_REQUESTS * 4

  it('returns the configured tier under late for any evidence: it measures how much tool text goes away, and late removes less on purpose', () => {
    for (const mode of MODES) {
      for (const savedPct of [0, 20, 49]) {
        expect(resolveWireMode(mode, ev(savedPct, Math.floor(ELIGIBLE * 0.9), ELIGIBLE), 'late'), `${mode} ${savedPct}`).toBe(mode)
      }
    }
    // The lifetime numbers of the research's install: 77% saved, 8% of eligible requests under 50%.
    expect(resolveWireMode('aggressive', ev(77, 28_540, 354_967), 'late')).toBe('aggressive')
  })

  it('still escalates under legacy, exactly as before', () => {
    expect(resolveWireMode('aggressive', ev(20, ELIGIBLE, ELIGIBLE), 'legacy')).toBe('max')
    expect(resolveWireMode('balanced', ev(47, 0, ELIGIBLE), 'legacy')).toBe('aggressive')
    expect(resolveWireMode('conservative', ev(49, Math.floor(ELIGIBLE * 0.9), ELIGIBLE), 'legacy')).toBe('max')
  })

  it('is legacy when no policy is given, so a caller that predates the policy behaves as before', () => {
    expect(resolveWireMode('aggressive', ev(20, ELIGIBLE, ELIGIBLE))).toBe('max')
    expect(resolveWireMode('aggressive', ev(20, ELIGIBLE, ELIGIBLE), undefined)).toBe('max')
  })

  it('reads a policy it does not know as legacy: only the exact word late switches it off', () => {
    for (const bad of ['Late', 'off', '', null, 1, {}]) {
      expect(resolveWireMode('aggressive', ev(20, ELIGIBLE, ELIGIBLE), bad as never), String(bad)).toBe('max')
    }
  })

  it('judges the floor by the requests the old policy shortened, so a stint on late cannot push a later Legacy run to Maximum', () => {
    // After a long run on late the lifetime figure is low (late removes less on purpose), but the
    // requests the old policy handled held the floor. Legacy must see those.
    expect(resolveWireMode('aggressive', ev(30, 0, ELIGIBLE, 77), 'legacy')).toBe('aggressive')
    expect(resolveWireMode('aggressive', ev(77, 0, ELIGIBLE, 30), 'legacy')).toBe('max')
  })

  it('falls back to the lifetime figure for evidence that carries no such field, or a damaged one', () => {
    expect(resolveWireMode('aggressive', ev(20, ELIGIBLE, ELIGIBLE), 'legacy')).toBe('max')
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveWireMode('aggressive', ev(20, ELIGIBLE, ELIGIBLE, bad), 'legacy')).toBe('max')
    }
  })
})

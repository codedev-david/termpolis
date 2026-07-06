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
    expect(m.getMemorySettings()).toEqual({ primerLimit: 10 })
    expect(m.PRIMER_LIMIT_MIN).toBe(1)
    expect(m.PRIMER_LIMIT_MAX).toBe(50)
  })

  it('persists a set value to disk and returns it', async () => {
    const m = await freshModule()
    expect(m.setPrimerLimit(20)).toEqual({ primerLimit: 20 })
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

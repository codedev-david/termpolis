import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Capture what Sentry receives without pulling in the native binding.
// vi.mock can't intercept the lazy require() inside telemetry.ts, so we
// inject a fake Sentry via __setSentryProviderForTests instead.
const mockAddBreadcrumb = vi.fn()
const mockCaptureMessage = vi.fn()
const fakeSentry = {
  addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
  captureMessage: (...args: any[]) => mockCaptureMessage(...args),
}

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
}))

let tmpDir: string

async function loadFreshModule() {
  vi.resetModules()
  const mod = await import('../../src/main/telemetry')
  mod.__resetTelemetryForTests()
  mod.__setSentryProviderForTests(() => fakeSentry)
  return mod
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'termpolis-telemetry-'))
  mockAddBreadcrumb.mockReset()
  mockCaptureMessage.mockReset()
  delete process.env.SENTRY_DSN
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('initTelemetry', () => {
  it('starts disabled when no telemetry.json exists', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.isEnabled()).toBe(false)
  })

  it('hydrates persisted opt-in from telemetry.json', async () => {
    const filePath = join(tmpDir, 'telemetry.json')
    writeFileSync(filePath, JSON.stringify({ optIn: true, lastLaunchPingDate: '2026-01-01' }))
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.isEnabled()).toBe(true)
  })

  it('treats malformed telemetry.json as disabled (does not crash)', async () => {
    const filePath = join(tmpDir, 'telemetry.json')
    writeFileSync(filePath, '{ not json')
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.isEnabled()).toBe(false)
  })

  it('treats non-object JSON as disabled', async () => {
    const filePath = join(tmpDir, 'telemetry.json')
    writeFileSync(filePath, 'null')
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.isEnabled()).toBe(false)
  })
})

describe('setOptIn', () => {
  it('flips state and persists to disk', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    expect(mod.isEnabled()).toBe(true)

    const filePath = join(tmpDir, 'telemetry.json')
    expect(existsSync(filePath)).toBe(true)
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(persisted.optIn).toBe(true)
  })

  it('coerces non-boolean truthy values to false (strict gate)', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    // setOptIn must require an explicit `true`; "1" or 1 should not enable.
    mod.setOptIn('1' as unknown as boolean)
    expect(mod.isEnabled()).toBe(false)
    mod.setOptIn(1 as unknown as boolean)
    expect(mod.isEnabled()).toBe(false)
  })

  it('round-trips across initTelemetry calls', async () => {
    let mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)

    mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.isEnabled()).toBe(true)
  })

  it('creates the userData dir if it does not yet exist', async () => {
    const mod = await loadFreshModule()
    const nestedDir = join(tmpDir, 'nested', 'data')
    mod.initTelemetry(nestedDir)
    mod.setOptIn(true)
    expect(existsSync(join(nestedDir, 'telemetry.json'))).toBe(true)
  })
})

describe('recordUpdaterEvent', () => {
  it('is a no-op when opt-in is false', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    // opt-in stays false
    mod.recordUpdaterEvent({ status: 'checking' })
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
    expect(mockCaptureMessage).not.toHaveBeenCalled()
  })

  it('is a no-op when DSN is empty even if opted in', async () => {
    delete process.env.SENTRY_DSN
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUpdaterEvent({ status: 'available', version: '1.0.0' })
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
  })

  it('routes to addBreadcrumb when opted in + DSN set', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUpdaterEvent({ status: 'available', version: '1.2.3' })
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1)
    const arg = mockAddBreadcrumb.mock.calls[0][0]
    expect(arg.category).toBe('updater')
    expect(arg.message).toContain('available')
    expect(arg.message).toContain('1.2.3')
    expect(arg.data.version).toBe('1.2.3')
    expect(arg.level).toBe('info')
  })

  it('marks error events with error level and emits captureMessage', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUpdaterEvent({ status: 'error', error: 'sha512 mismatch' })
    const breadcrumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(breadcrumb.level).toBe('error')
    expect(breadcrumb.data.error).toBe('sha512 mismatch')
    expect(mockCaptureMessage).toHaveBeenCalledWith('updater error: sha512 mismatch', 'error')
  })

  it('omits undefined fields from breadcrumb data', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUpdaterEvent({ status: 'checking' })
    const data = mockAddBreadcrumb.mock.calls[0][0].data
    expect(data).toEqual({ status: 'checking' })
  })
})

describe('recordEvent', () => {
  it('is a no-op when opt-in is false', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.recordEvent('feature.click')
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
  })

  it('emits breadcrumb with name + props when opted in', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordEvent('swarm.start', { agentCount: 3 })
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1)
    const arg = mockAddBreadcrumb.mock.calls[0][0]
    expect(arg.message).toBe('swarm.start')
    expect(arg.data).toEqual({ agentCount: 3 })
    expect(arg.category).toBe('event')
  })

  it('handles missing props (undefined → empty object)', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordEvent('boot')
    expect(mockAddBreadcrumb.mock.calls[0][0].data).toEqual({})
  })
})

describe('todayKey', () => {
  it('returns YYYY-MM-DD UTC', async () => {
    const mod = await loadFreshModule()
    expect(mod.todayKey(new Date('2026-04-26T03:00:00Z'))).toBe('2026-04-26')
    expect(mod.todayKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01')
  })

  it('zero-pads single digit months and days', async () => {
    const mod = await loadFreshModule()
    expect(mod.todayKey(new Date('2026-03-05T12:00:00Z'))).toBe('2026-03-05')
  })
})

describe('dailyLaunchPing', () => {
  it('returns false when opted out', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.dailyLaunchPing('1.11.16')).toBe(false)
    expect(mockCaptureMessage).not.toHaveBeenCalled()
  })

  it('emits captureMessage once per UTC day', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    const day = new Date('2026-04-26T10:00:00Z')
    expect(mod.dailyLaunchPing('1.11.16', day)).toBe(true)
    expect(mockCaptureMessage).toHaveBeenCalledWith('launch 1.11.16', 'info')
    // Same day, should NOT fire again
    expect(mod.dailyLaunchPing('1.11.16', day)).toBe(false)
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1)
  })

  it('fires again on a new UTC day', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))
    mod.dailyLaunchPing('1.11.16', new Date('2026-04-27T01:00:00Z'))
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2)
  })

  it('persists lastLaunchPingDate so de-dupe survives relaunches', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    let mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))

    // Reload — lastLaunchPingDate must come back from disk
    mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T20:00:00Z'))).toBe(false)
  })

  it('still marks the day on disk even if Sentry is unavailable (no DSN)', async () => {
    delete process.env.SENTRY_DSN
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    expect(mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))).toBe(false)
    const persisted = JSON.parse(readFileSync(join(tmpDir, 'telemetry.json'), 'utf-8'))
    expect(persisted.lastLaunchPingDate).toBe('2026-04-26')
  })
})

describe('persistence robustness', () => {
  it('does not crash when telemetry directory cannot be created', async () => {
    const mod = await loadFreshModule()
    // Without calling initTelemetry, file path is null — setOptIn should
    // still update in-memory state without throwing.
    expect(() => mod.setOptIn(true)).not.toThrow()
    expect(mod.isEnabled()).toBe(true)
  })

  it('survives a corrupted telemetry.json on subsequent writes', async () => {
    const filePath = join(tmpDir, 'telemetry.json')
    writeFileSync(filePath, 'garbage{')
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    // Hydration treats garbage as disabled, but writes should still work
    mod.setOptIn(true)
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(persisted.optIn).toBe(true)
  })
})

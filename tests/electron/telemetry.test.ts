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

  it('keeps a report:false error (a full disk) as a warning breadcrumb, never a captureMessage', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUpdaterEvent({ status: 'error', error: 'Not enough free disk space', report: false })
    const breadcrumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(breadcrumb.level).toBe('warning')
    expect(breadcrumb.data).toEqual({ status: 'error', error: 'Not enough free disk space' })
    expect(mockCaptureMessage).not.toHaveBeenCalled()
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

// ── The Sentry surface we do NOT control ─────────────────────────────────────────────────────────
// Every suite above injects a fake that has every method and never throws. A real @sentry/electron
// is not that: the lazy require() can fail outright, a version skew can hand back an object without
// the method being called, and the whole point of the `?.` / try/catch armour in telemetry.ts is
// that a telemetry failure never surfaces at the call site — which is, by design, inside somebody
// else's catch block or on the startup path.

const mockCaptureException = vi.fn()
const fullSentry = {
  addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
  captureMessage: (...args: any[]) => mockCaptureMessage(...args),
  captureException: (...args: any[]) => mockCaptureException(...args),
}

beforeEach(() => { mockCaptureException.mockReset() })

async function loadWithProvider(provider: () => any) {
  vi.resetModules()
  const mod = await import('../../src/main/telemetry')
  mod.__resetTelemetryForTests()
  mod.__setSentryProviderForTests(provider)
  return mod
}

describe('sentryOrNull — the resolver is not trusted', () => {
  it('a provider that THROWS is treated as "no Sentry", never as a crash in the caller', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(() => { throw new Error('@sentry/electron failed to load') })
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)

    // All four tiers have to survive it. An import failure inside telemetry must not take down the
    // auto-updater, a feature call site, the swarm's error reporting, or startup.
    expect(() => mod.recordUpdaterEvent({ status: 'error', error: 'boom' })).not.toThrow()
    expect(() => mod.recordEvent('feature.click')).not.toThrow()
    expect(() => mod.recordSwarmError('swarm.test', new Error('x'))).not.toThrow()
    expect(() => mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_000 })).not.toThrow()
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
    expect(mockCaptureException).not.toHaveBeenCalled()

    // ...and the launch ping still marks the day, so a resolver that is broken on this machine is
    // not retried on every single relaunch.
    expect(mod.dailyLaunchPing('1.2.3', new Date('2026-04-26T10:00:00Z'))).toBe(false)
    const persisted = JSON.parse(readFileSync(join(tmpDir, 'telemetry.json'), 'utf-8'))
    expect(persisted.lastLaunchPingDate).toBe('2026-04-26')
  })

  it('uses the real lazy require() when no test provider was installed', async () => {
    // The shipped default is `try { return require('@sentry/electron/main') } catch { return null }`.
    // Under vitest's ESM transform that require is not even defined — which is precisely the shape
    // of failure the try/catch exists for: however Sentry fails to resolve, telemetry degrades to a
    // no-op rather than throwing out of a call site that cannot handle it.
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    vi.resetModules()
    const mod = await import('../../src/main/telemetry')
    mod.__resetTelemetryForTests() // deliberately NO __setSentryProviderForTests here
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)

    expect(() => mod.recordEvent('boot')).not.toThrow()
    expect(() => mod.recordUpdaterEvent({ status: 'checking' })).not.toThrow()
    expect(mockAddBreadcrumb).not.toHaveBeenCalled() // the fake is NOT wired on this instance
    expect(mod.isEnabled()).toBe(true) // the gate itself is unaffected by Sentry being absent
    // This test gets its own budget because it is genuinely the most expensive one in the suite,
    // and for a reason that is the whole point of it. Every OTHER test here injects a stub through
    // __setSentryProviderForTests, so @sentry/electron is never actually loaded. This one
    // deliberately does not — and @sentry/electron IS a real installed dependency (7.10.0), so the
    // shipped `require('@sentry/electron/main')` RESOLVES and drags the entire real Sentry SDK
    // through vite's transform pipeline, cold, on first touch.
    //
    // Uncontended that costs ~5s. With 344 files competing for the transformer it went past the 30s
    // global budget, failed, and looked exactly like a flake — the same lie the global testTimeout
    // comment in vitest.config.ts was written about. It was never flaky: it was being cut off
    // part-way through work it was always going to do. Raising the GLOBAL budget to cover one
    // known-expensive test would blunt it for the other ~11,000, so the budget goes here instead.
  }, 180_000)
})

describe('a Sentry module that lacks the method being called', () => {
  // @sentry/electron's surface has moved across majors. The `?.` on every call is what stops a
  // version skew from turning a breadcrumb into a TypeError in the middle of someone's catch block.
  const bareModule = () => ({}) as any

  it('every tier no-ops instead of throwing', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(bareModule)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)

    expect(() => mod.recordUpdaterEvent({ status: 'error', error: 'sha512 mismatch' })).not.toThrow()
    expect(() => mod.recordEvent('swarm.start', { agentCount: 2 })).not.toThrow()
    expect(() => mod.recordSwarmError('swarm.test', new Error('x'))).not.toThrow()
    expect(() => mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_000 })).not.toThrow()
  })

  it('dailyLaunchPing still reports sent and still marks the day', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(bareModule)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)

    // Sentry WAS resolved here — this is not the missing-DSN case — so the ping counts as taken.
    // Re-attempting it on every relaunch would be a worse failure than one ping that went nowhere.
    expect(mod.dailyLaunchPing('1.2.3', new Date('2026-04-26T10:00:00Z'))).toBe(true)
    expect(mod.dailyLaunchPing('1.2.3', new Date('2026-04-26T23:00:00Z'))).toBe(false)
    const persisted = JSON.parse(readFileSync(join(tmpDir, 'telemetry.json'), 'utf-8'))
    expect(persisted.lastLaunchPingDate).toBe('2026-04-26')
  })
})

describe('recordUpdaterEvent — the download counters', () => {
  it('carries downloadedBytes/totalBytes when they are numbers, including a legitimate 0', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUpdaterEvent({ status: 'downloading', version: '1.2.3', downloadedBytes: 0, totalBytes: 91_000_000 })

    // `typeof === 'number'`, not truthiness: the first progress tick is 0 bytes, and a truthy gate
    // would drop exactly the sample that tells us a download STARTED and then stalled.
    expect(mockAddBreadcrumb.mock.calls[0][0].data).toEqual({
      status: 'downloading', version: '1.2.3', downloadedBytes: 0, totalBytes: 91_000_000,
    })
  })

  it('drops byte counters that are not numbers', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUpdaterEvent({
      status: 'downloading',
      downloadedBytes: '12' as unknown as number,
      totalBytes: null as unknown as number,
    })
    expect(mockAddBreadcrumb.mock.calls[0][0].data).toEqual({ status: 'downloading' })
  })

  it('an error status with NO error string breadcrumbs at error level but sends no captureMessage', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUpdaterEvent({ status: 'error' })

    expect(mockAddBreadcrumb.mock.calls[0][0].level).toBe('error')
    // A captureMessage of "updater error: undefined" would be a Sentry issue with no content —
    // the breadcrumb already carries everything we actually know.
    expect(mockCaptureMessage).not.toHaveBeenCalled()
  })
})

describe('setOptIn — the launch-ping de-dupe survives a toggle', () => {
  it('keeps lastLaunchPingDate on disk when the user opts out and back in', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const filePath = join(tmpDir, 'telemetry.json')
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    expect(mod.dailyLaunchPing('1.2.3', new Date('2026-04-26T10:00:00Z'))).toBe(true)

    mod.setOptIn(false)
    // setOptIn rewrites the WHOLE file. Dropping the date here would re-arm the ping, so a user who
    // flips the switch twice would send a second "launch" for the same day and inflate the count.
    expect(JSON.parse(readFileSync(filePath, 'utf-8')))
      .toEqual({ optIn: false, lastLaunchPingDate: '2026-04-26' })

    mod.setOptIn(true)
    expect(mod.dailyLaunchPing('1.2.3', new Date('2026-04-26T20:00:00Z'))).toBe(false)
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1)
  })
})

describe('persistence robustness — the write itself fails', () => {
  it('a userData path that is really a FILE cannot be written, and setOptIn still updates in memory', async () => {
    const blocker = join(tmpDir, 'blocker')
    writeFileSync(blocker, 'i am a file, not a directory')
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(blocker) // telemetry.json would have to live INSIDE a regular file

    // mkdirSync on an existing file throws. Losing the persisted opt-in only means onboarding asks
    // again next launch; throwing out of setOptIn would take down the IPC handler that called it.
    expect(() => mod.setOptIn(true)).not.toThrow()
    expect(mod.isEnabled()).toBe(true)
    expect(existsSync(join(blocker, 'telemetry.json'))).toBe(false)
  })
})

describe('recordUncleanExit — a native fatal leaves no JS exception to catch', () => {
  it('is a no-op when opted out', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(tmpDir)
    mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_000 })
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('is a no-op with no DSN even when opted in', async () => {
    delete process.env.SENTRY_DSN
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_000 })
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('reports the crash as an ordinary EXCEPTION so the existing Sentry→GitHub alert files it', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_240 })

    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    const [err, opts] = mockCaptureException.mock.calls[0]
    // A native abort never becomes a JS exception, so the "Auto-file Production crashes" alert —
    // which matches catchable JS errors — files nothing for it. Hence a synthesised Error.
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('UncleanExit')
    expect(err.message).toContain('~3s') // 3,240 ms rounds to 3 s — the v1.27.4 crash-loop signature
    expect(err.message).toContain('v1.27.4')
    expect(opts.tags).toEqual({ uncleanExit: 'true', prevVersion: '1.27.4' })
    expect(opts.extra.prevVersion).toBe('1.27.4')
    expect(opts.extra.uptimeMs).toBe(3_240)
    expect(opts.extra.hint).toContain('native fatal')
  })

  it('rounds the uptime to whole seconds rather than printing raw milliseconds', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mod.recordUncleanExit({ prevVersion: '2.0.0', uptimeMs: 95_500 })
    expect(mockCaptureException.mock.calls[0][0].message).toContain('~96s')
  })

  it('never throws when captureException itself blows up — it runs on the startup path', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadWithProvider(() => fullSentry)
    mod.initTelemetry(tmpDir)
    mod.setOptIn(true)
    mockCaptureException.mockImplementationOnce(() => { throw new Error('sentry transport is down') })
    expect(() => mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_000 })).not.toThrow()
  })
})

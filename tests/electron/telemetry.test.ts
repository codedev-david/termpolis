import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CONSENT_VERSION } from '../../src/shared/telemetryConsent'
import { normalizeUpdaterSignature } from '../../src/shared/sentryScrub'

// Capture what Sentry receives without pulling in the native binding.
// vi.mock can't intercept the lazy require() inside telemetry.ts, so we
// inject a fake Sentry via __setSentryProviderForTests instead.
const mockAddBreadcrumb = vi.fn()
const mockCaptureMessage = vi.fn()
const mockCaptureException = vi.fn()
const fakeSentry = {
  addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
  captureMessage: (...args: any[]) => mockCaptureMessage(...args),
  captureException: (...args: any[]) => mockCaptureException(...args),
}

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
}))

const DSN = 'https://fake@sentry.io/1'
const NOT_ASKED = { crash: false, usage: false, consentVersion: 0, needsReview: true }
let tmpDir: string

async function loadWithProvider(provider: () => any) {
  vi.resetModules()
  const mod = await import('../../src/main/telemetry')
  mod.__resetTelemetryForTests()
  mod.__setSentryProviderForTests(provider)
  return mod
}

const loadFreshModule = () => loadWithProvider(() => fakeSentry)

// A machine with a DSN whose user has answered `choice` on app `version`.
async function loadConsented(
  choice: { crash?: boolean; usage?: boolean } = { crash: true, usage: true },
  version = '1.48.0',
  provider: () => any = () => fakeSentry,
) {
  process.env.SENTRY_DSN = DSN
  const mod = await loadWithProvider(provider)
  mod.initTelemetry(tmpDir, version)
  mod.setConsent(choice)
  return mod
}

function writeTelemetryFile(content: unknown): void {
  writeFileSync(join(tmpDir, 'telemetry.json'), typeof content === 'string' ? content : JSON.stringify(content))
}

function readTelemetryFile(): any {
  return JSON.parse(readFileSync(join(tmpDir, 'telemetry.json'), 'utf-8'))
}

// Set (or unset) one env var for the length of fn. Assigning `undefined` would store "undefined".
function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    fn()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

// The launch ping builds a client of its own, so its fake needs the constructors too.
function makePingSdk() {
  const clients: any[] = []
  const pings: Array<{ message: string; level: string; client: any }> = []
  class NodeClient {
    options: any
    initialized = false
    constructor(options: any) {
      this.options = options
      clients.push(this)
    }
    init() {
      this.initialized = true
    }
  }
  class Scope {
    client: any = null
    setClient(client: any) {
      this.client = client
    }
    captureMessage(message: string, level: string) {
      pings.push({ message, level, client: this.client })
    }
  }
  const sdk = {
    ...fakeSentry,
    NodeClient,
    Scope,
    makeElectronTransport: () => ({}),
    defaultStackParser: () => [],
  }
  return { sdk, clients, pings }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'termpolis-telemetry-'))
  mockAddBreadcrumb.mockReset()
  mockCaptureMessage.mockReset()
  mockCaptureException.mockReset()
  delete process.env.SENTRY_DSN
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('initTelemetry — the answer on file', () => {
  it('re-exports the consent version the renderer mirrors', async () => {
    const mod = await loadFreshModule()
    expect(mod.CONSENT_VERSION).toBe(CONSENT_VERSION)
    expect(CONSENT_VERSION).toBe(2)
  })

  it('no telemetry.json: nothing is on, and the user has to be asked', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsent()).toEqual(NOT_ASKED)
    expect(mod.isCrashEnabled()).toBe(false)
    expect(mod.isUsageEnabled()).toBe(false)
  })

  it('a v1 file is never honoured: optIn:true was the tour\'s pre-ticked box, not an answer', async () => {
    writeTelemetryFile({ optIn: true, lastLaunchPingDate: '2026-01-01' })
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsent()).toEqual({ crash: false, usage: false, consentVersion: 1, needsReview: true })
  })

  it('a v1 file with optIn:false reads the same way — re-asked, both off', async () => {
    writeTelemetryFile({ optIn: false })
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsent()).toEqual({ crash: false, usage: false, consentVersion: 1, needsReview: true })
  })

  it('a current answer is honoured tier by tier', async () => {
    writeTelemetryFile({ crash: true, usage: false, consentVersion: CONSENT_VERSION })
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsent()).toEqual({ crash: true, usage: false, consentVersion: CONSENT_VERSION, needsReview: false })
    expect(mod.isCrashEnabled()).toBe(true)
    expect(mod.isUsageEnabled()).toBe(false)
  })

  it('flags stamped with an older consent version switch nothing on', async () => {
    writeTelemetryFile({ crash: true, usage: true, consentVersion: CONSENT_VERSION - 1 })
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsent()).toEqual({
      crash: false, usage: false, consentVersion: CONSENT_VERSION - 1, needsReview: true,
    })
  })

  it('a newer consent version (after a downgrade) still counts as answered', async () => {
    writeTelemetryFile({ crash: false, usage: true, consentVersion: CONSENT_VERSION + 1 })
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsent()).toEqual({
      crash: false, usage: true, consentVersion: CONSENT_VERSION + 1, needsReview: false,
    })
  })

  it('only a literal true on disk turns a tier on', async () => {
    writeTelemetryFile({ crash: 'true', usage: 1, consentVersion: CONSENT_VERSION })
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsent()).toEqual({ crash: false, usage: false, consentVersion: CONSENT_VERSION, needsReview: false })
  })

  it.each([
    ['malformed JSON', '{ not json'],
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"crash"'],
    ['an array', '[true]'],
    ['an empty object', '{}'],
  ])('%s reads as not asked (and does not crash)', async (_label, raw) => {
    writeTelemetryFile(raw)
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsent()).toEqual(NOT_ASKED)
  })

  it('ignores a lastLaunchPingDate that is not a string', async () => {
    writeTelemetryFile({ crash: false, usage: true, consentVersion: CONSENT_VERSION, lastLaunchPingDate: 20260426 })
    const { sdk } = makePingSdk()
    process.env.SENTRY_DSN = DSN
    const mod = await loadWithProvider(() => sdk)
    mod.initTelemetry(tmpDir)
    expect(mod.dailyLaunchPing('1.2.3', new Date('2026-04-26T10:00:00Z'))).toBe(true)
  })
})

describe('setConsent', () => {
  it('stamps the answer with CONSENT_VERSION and persists it', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.setConsent({ crash: true, usage: false }))
      .toEqual({ crash: true, usage: false, consentVersion: CONSENT_VERSION, needsReview: false })
    expect(readTelemetryFile()).toEqual({ crash: true, usage: false, consentVersion: CONSENT_VERSION })
  })

  it('"Not now" — both off — is an answer too: the next launch does not ask again', async () => {
    let mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setConsent({ crash: false, usage: false })

    mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsent()).toEqual({ crash: false, usage: false, consentVersion: CONSENT_VERSION, needsReview: false })
  })

  it('round-trips a yes across initTelemetry calls', async () => {
    let mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setConsent({ crash: true, usage: true })

    mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.isCrashEnabled()).toBe(true)
    expect(mod.isUsageEnabled()).toBe(true)
  })

  it('a tier left out keeps its current effective value', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setConsent({ crash: true, usage: true })
    expect(mod.setConsent({ usage: false })).toMatchObject({ crash: true, usage: false })
    expect(mod.setConsent({ crash: false })).toMatchObject({ crash: false, usage: false })
    expect(mod.setConsent({ usage: true })).toMatchObject({ crash: false, usage: true })
    expect(mod.setConsent({})).toMatchObject({ crash: false, usage: true })
  })

  it('a tier left out of a first answer does not inherit a stale pre-v2 flag', async () => {
    // The old flag is on disk but was never effective, so "keep the current value" keeps it OFF.
    writeTelemetryFile({ crash: true, usage: true, consentVersion: CONSENT_VERSION - 1 })
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.setConsent({ crash: true }))
      .toEqual({ crash: true, usage: false, consentVersion: CONSENT_VERSION, needsReview: false })
  })

  it('anything but a literal true is off (strict gate)', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setConsent({ crash: '1' as unknown as boolean, usage: 1 as unknown as boolean })
    expect(mod.isCrashEnabled()).toBe(false)
    expect(mod.isUsageEnabled()).toBe(false)
  })

  it('creates the userData dir if it does not yet exist', async () => {
    const mod = await loadFreshModule()
    const nestedDir = join(tmpDir, 'nested', 'data')
    mod.initTelemetry(nestedDir)
    mod.setConsent({ crash: true })
    expect(existsSync(join(nestedDir, 'telemetry.json'))).toBe(true)
  })

  it('keeps the launch-ping date and updater reports when the answer changes', async () => {
    const { sdk } = makePingSdk()
    const mod = await loadConsented({ crash: true, usage: true }, '1.48.0', () => sdk)
    expect(mod.dailyLaunchPing('1.48.0', new Date('2026-04-26T10:00:00Z'))).toBe(true)
    mod.recordUpdaterEvent({ status: 'error', error: 'net::ERR_CONNECTION_RESET' })

    mod.setConsent({ crash: false, usage: false })
    // setConsent rewrites the WHOLE file. Dropping the date would re-arm the ping, so a user who
    // flips the switch twice would send a second "launch" for the same day and inflate the count.
    expect(readTelemetryFile()).toEqual({
      crash: false,
      usage: false,
      consentVersion: CONSENT_VERSION,
      lastLaunchPingDate: '2026-04-26',
      updaterReports: { version: '1.48.0', signatures: [normalizeUpdaterSignature('net::ERR_CONNECTION_RESET')] },
    })

    mod.setConsent({ crash: true, usage: true })
    expect(mod.dailyLaunchPing('1.48.0', new Date('2026-04-26T20:00:00Z'))).toBe(false)
    mod.recordUpdaterEvent({ status: 'error', error: 'net::ERR_CONNECTION_RESET' })
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1)
  })
})

describe('onConsentChange', () => {
  it('tells a listener the new consent, and stops after unsubscribe', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    const seen: unknown[] = []
    const off = mod.onConsentChange((consent) => seen.push(consent))
    mod.setConsent({ crash: true })
    off()
    mod.setConsent({ crash: false })
    expect(seen).toEqual([{ crash: true, usage: false, consentVersion: CONSENT_VERSION, needsReview: false }])
  })

  it('a listener that throws does not keep the others, or the caller, from the answer', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    const after = vi.fn()
    mod.onConsentChange(() => { throw new Error('sentry init blew up') })
    mod.onConsentChange(after)
    expect(mod.setConsent({ crash: true }).crash).toBe(true)
    expect(after).toHaveBeenCalledWith(expect.objectContaining({ crash: true }))
  })
})

describe('getConsentForRenderer', () => {
  it('passes needsReview through outside the e2e bridge', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsentForRenderer({ NODE_ENV: 'production' })).toEqual(NOT_ASKED)
  })

  it('never asks for the review under the e2e bridge — a modal would block every spec', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsentForRenderer({ NODE_ENV: 'test' })).toEqual({ ...NOT_ASKED, needsReview: false })
    // ...and it changes nothing but the question: main still has both tiers off.
    expect(mod.getConsent().needsReview).toBe(true)
  })

  it('TERMPOLIS_E2E_CONSENT_REVIEW=1 lets a spec that is about the review see it', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    expect(mod.getConsentForRenderer({ NODE_ENV: 'test', TERMPOLIS_E2E_CONSENT_REVIEW: '1' })).toEqual(NOT_ASKED)
  })

  it('reports the tiers as they are under the bridge', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.setConsent({ crash: true, usage: false })
    expect(mod.getConsentForRenderer({ NODE_ENV: 'test' }))
      .toEqual({ crash: true, usage: false, consentVersion: CONSENT_VERSION, needsReview: false })
  })

  it('reads process.env by default', async () => {
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    withEnv('TERMPOLIS_E2E_CONSENT_REVIEW', undefined, () => {
      withEnv('NODE_ENV', 'production', () => expect(mod.getConsentForRenderer().needsReview).toBe(true))
      withEnv('NODE_ENV', 'test', () => expect(mod.getConsentForRenderer().needsReview).toBe(false))
    })
  })
})

describe('recordUpdaterEvent', () => {
  it('is a no-op when nothing was ever answered', async () => {
    process.env.SENTRY_DSN = DSN
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.recordUpdaterEvent({ status: 'error', error: 'boom' })
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
    expect(mockCaptureMessage).not.toHaveBeenCalled()
  })

  it('is a no-op with crash reports off — the usage tier does not carry it', async () => {
    const mod = await loadConsented({ crash: false, usage: true })
    mod.recordUpdaterEvent({ status: 'error', error: 'boom' })
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
    expect(mockCaptureMessage).not.toHaveBeenCalled()
  })

  it('is a no-op when DSN is empty even with crash reports on', async () => {
    const mod = await loadConsented({ crash: true })
    delete process.env.SENTRY_DSN
    mod.recordUpdaterEvent({ status: 'available', version: '1.0.0' })
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
  })

  it('routes to addBreadcrumb with crash reports on', async () => {
    const mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({ status: 'available', version: '1.2.3' })
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1)
    const arg = mockAddBreadcrumb.mock.calls[0][0]
    expect(arg.category).toBe('updater')
    expect(arg.message).toBe('updater: available -> 1.2.3')
    expect(arg.data).toEqual({ status: 'available', version: '1.2.3' })
    expect(arg.level).toBe('info')
    expect(mockCaptureMessage).not.toHaveBeenCalled()
  })

  it('omits undefined fields from breadcrumb data', async () => {
    const mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({ status: 'checking' })
    expect(mockAddBreadcrumb.mock.calls[0][0].message).toBe('updater: checking')
    expect(mockAddBreadcrumb.mock.calls[0][0].data).toEqual({ status: 'checking' })
  })

  it('files a hard error, fingerprinted by its normalized signature and keeping the drop-filter prefix', async () => {
    const mod = await loadConsented({ crash: true })
    const error = 'Cannot download "https://github.com/x/termpolis/releases/download/v1.48.0/Termpolis-Setup-1.48.0.exe", status 404'
    mod.recordUpdaterEvent({ status: 'error', error })
    const breadcrumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(breadcrumb.level).toBe('error')
    expect(breadcrumb.data.error).toBe(error)
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1)
    // `updater error: ` is what updaterErrors.shouldDropSentryEvent keys on.
    expect(mockCaptureMessage).toHaveBeenCalledWith(`updater error: ${error}`, {
      level: 'error',
      fingerprint: ['updater', 'Cannot download "<url>", status <n>'],
      tags: { updater: 'error' },
    })
  })

  it('reports a failure once per app version — the 4-hourly retry and its changing numbers file nothing new', async () => {
    const mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({ status: 'error', error: 'net::ERR_CONNECTION_RESET after 41943040 of 91000000 bytes' })
    mod.recordUpdaterEvent({ status: 'error', error: 'net::ERR_CONNECTION_RESET after 1048576 of 91000000 bytes' })
    mod.recordUpdaterEvent({ status: 'error', error: 'net::ERR_CONNECTION_RESET after 41943040 of 91000000 bytes' })
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1)
    // The breadcrumb history still has every attempt: it rides along with the next real crash.
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(3)
  })

  it('a different failure is its own report', async () => {
    const mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({ status: 'error', error: 'net::ERR_CONNECTION_RESET' })
    mod.recordUpdaterEvent({ status: 'error', error: 'sha512 checksum mismatch' })
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2)
    expect(readTelemetryFile().updaterReports).toEqual({
      version: '1.48.0',
      signatures: ['net::ERR_CONNECTION_RESET', 'sha<n> checksum mismatch'],
    })
  })

  it('the de-dup survives a relaunch of the same version', async () => {
    let mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({ status: 'error', error: 'EPERM: operation not permitted' })

    mod = await loadFreshModule()
    mod.initTelemetry(tmpDir, '1.48.0')
    mod.recordUpdaterEvent({ status: 'error', error: 'EPERM: operation not permitted' })
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1)
  })

  it('a new app version may report the same failure again, and starts a fresh list', async () => {
    let mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({ status: 'error', error: 'EPERM: operation not permitted' })

    mod = await loadFreshModule()
    mod.initTelemetry(tmpDir, '1.48.1')
    mod.recordUpdaterEvent({ status: 'error', error: 'EPERM: operation not permitted' })
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2)
    expect(readTelemetryFile().updaterReports).toEqual({ version: '1.48.1', signatures: ['EPERM: operation not permitted'] })
  })

  it('caps the distinct failures one version may report', async () => {
    const mod = await loadConsented({ crash: true })
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    for (let i = 0; i < 21; i++) mod.recordUpdaterEvent({ status: 'error', error: `failure ${letters[i]}` })
    expect(mockCaptureMessage).toHaveBeenCalledTimes(20)
    expect(readTelemetryFile().updaterReports.signatures).toHaveLength(20)
  })

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a numeric version', { version: 1, signatures: [] }],
    ['non-array signatures', { version: '1.48.0', signatures: 'x' }],
    ['a non-string signature', { version: '1.48.0', signatures: [7] }],
  ])('ignores updaterReports on disk that are %s', async (_label, updaterReports) => {
    writeTelemetryFile({ crash: true, usage: false, consentVersion: CONSENT_VERSION, updaterReports })
    process.env.SENTRY_DSN = DSN
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir, '1.48.0')
    mod.recordUpdaterEvent({ status: 'error', error: 'x' })
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1)
    expect(readTelemetryFile().updaterReports).toEqual({ version: '1.48.0', signatures: ['x'] })
  })

  it('honours well-formed updaterReports on disk', async () => {
    writeTelemetryFile({
      crash: true, usage: false, consentVersion: CONSENT_VERSION,
      updaterReports: { version: '1.48.0', signatures: ['x'] },
    })
    process.env.SENTRY_DSN = DSN
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir, '1.48.0')
    mod.recordUpdaterEvent({ status: 'error', error: 'x' })
    expect(mockCaptureMessage).not.toHaveBeenCalled()
  })

  it('keeps a report:false error (a full disk) as a warning breadcrumb, never a captureMessage', async () => {
    const mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({ status: 'error', error: 'Not enough free disk space', report: false })
    const breadcrumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(breadcrumb.level).toBe('warning')
    expect(breadcrumb.data).toEqual({ status: 'error', error: 'Not enough free disk space' })
    expect(mockCaptureMessage).not.toHaveBeenCalled()
    // ...and it does not use up one of the version's report slots.
    expect(readTelemetryFile().updaterReports).toBeUndefined()
  })

  it('an error status with NO error string breadcrumbs at error level but sends no captureMessage', async () => {
    const mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({ status: 'error' })
    expect(mockAddBreadcrumb.mock.calls[0][0].level).toBe('error')
    // A captureMessage of "updater error: undefined" would be a Sentry issue with no content —
    // the breadcrumb already carries everything we actually know.
    expect(mockCaptureMessage).not.toHaveBeenCalled()
  })

  it('carries downloadedBytes/totalBytes when they are numbers, including a legitimate 0', async () => {
    const mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({ status: 'downloading', version: '1.2.3', downloadedBytes: 0, totalBytes: 91_000_000 })
    // `typeof === 'number'`, not truthiness: the first progress tick is 0 bytes, and a truthy gate
    // would drop exactly the sample that tells us a download STARTED and then stalled.
    expect(mockAddBreadcrumb.mock.calls[0][0].data).toEqual({
      status: 'downloading', version: '1.2.3', downloadedBytes: 0, totalBytes: 91_000_000,
    })
  })

  it('drops byte counters that are not numbers', async () => {
    const mod = await loadConsented({ crash: true })
    mod.recordUpdaterEvent({
      status: 'downloading',
      downloadedBytes: '12' as unknown as number,
      totalBytes: null as unknown as number,
    })
    expect(mockAddBreadcrumb.mock.calls[0][0].data).toEqual({ status: 'downloading' })
  })

  it('never throws when the Sentry calls do — the updater calls it from its own error path', async () => {
    const mod = await loadConsented({ crash: true })
    mockAddBreadcrumb.mockImplementationOnce(() => { throw new Error('breadcrumb blew up') })
    expect(() => mod.recordUpdaterEvent({ status: 'checking' })).not.toThrow()
    mockCaptureMessage.mockImplementationOnce(() => { throw new Error('transport is down') })
    expect(() => mod.recordUpdaterEvent({ status: 'error', error: 'boom' })).not.toThrow()
  })
})

describe('recordEvent', () => {
  it('is a no-op with usage statistics off, even with crash reports on', async () => {
    const mod = await loadConsented({ crash: true, usage: false })
    mod.recordEvent('feature.click')
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
  })

  it('is a no-op when nothing was ever answered', async () => {
    process.env.SENTRY_DSN = DSN
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    mod.recordEvent('feature.click')
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
  })

  it('emits breadcrumb with name + props with usage statistics on', async () => {
    const mod = await loadConsented({ usage: true })
    mod.recordEvent('swarm.start', { agentCount: 3 })
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1)
    expect(mockAddBreadcrumb.mock.calls[0][0]).toEqual({
      category: 'event', level: 'info', message: 'swarm.start', data: { agentCount: 3 },
    })
  })

  it('handles missing props (undefined → empty object)', async () => {
    const mod = await loadConsented({ usage: true })
    mod.recordEvent('boot')
    expect(mockAddBreadcrumb.mock.calls[0][0].data).toEqual({})
  })

  it('never throws when addBreadcrumb does', async () => {
    const mod = await loadConsented({ usage: true })
    mockAddBreadcrumb.mockImplementationOnce(() => { throw new Error('sentry blew up') })
    expect(() => mod.recordEvent('boot')).not.toThrow()
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

  it('defaults to now', async () => {
    const mod = await loadFreshModule()
    expect(mod.todayKey()).toBe(new Date().toISOString().slice(0, 10))
  })
})

describe('launchPingOnly', () => {
  it('keeps only what a launch ping needs, and tags it as usage', async () => {
    const mod = await loadFreshModule()
    const event = {
      event_id: 'e1', timestamp: 1, platform: 'node', level: 'info', message: 'launch 1.2.3',
      logentry: { message: 'launch 1.2.3' }, release: 'termpolis@1.2.3', environment: 'production',
      sdk: { name: 'sentry.javascript.electron', settings: { infer_ip: 'never' } },
      breadcrumbs: [{ message: 'C:\\Users\\alice\\repo' }], contexts: { os: { name: 'Windows' } },
      tags: { os: 'win32' }, user: { id: 'u1' }, server_name: 'ALICE-PC', extra: { cwd: '/home/alice' },
      exception: { values: [] }, request: { url: 'file:///C:/Users/alice' }, modules: { a: '1' },
    }
    expect(mod.launchPingOnly(event)).toEqual({
      event_id: 'e1', timestamp: 1, platform: 'node', level: 'info', message: 'launch 1.2.3',
      logentry: { message: 'launch 1.2.3' }, release: 'termpolis@1.2.3', environment: 'production',
      sdk: { name: 'sentry.javascript.electron', settings: { infer_ip: 'never' } },
      tags: { tier: 'usage' },
    })
  })

  it('does not invent fields the event did not have', async () => {
    const mod = await loadFreshModule()
    expect(mod.launchPingOnly({ message: 'launch 1.2.3' })).toEqual({ message: 'launch 1.2.3', tags: { tier: 'usage' } })
  })
})

describe('dailyLaunchPing', () => {
  it('returns false with usage statistics off — crash consent alone sends no ping', async () => {
    const { sdk, clients } = makePingSdk()
    const mod = await loadConsented({ crash: true, usage: false }, '1.48.0', () => sdk)
    expect(mod.dailyLaunchPing('1.11.16')).toBe(false)
    expect(clients).toHaveLength(0)
    // Not even the day is marked: nothing was due.
    expect(readTelemetryFile().lastLaunchPingDate).toBeUndefined()
  })

  it('returns false when nothing was ever answered', async () => {
    const { sdk, clients } = makePingSdk()
    process.env.SENTRY_DSN = DSN
    const mod = await loadWithProvider(() => sdk)
    mod.initTelemetry(tmpDir)
    expect(mod.dailyLaunchPing('1.11.16')).toBe(false)
    expect(clients).toHaveLength(0)
  })

  it('sends one "launch" message per UTC day, on a client of its own', async () => {
    const { sdk, clients, pings } = makePingSdk()
    const mod = await loadConsented({ usage: true }, '1.11.16', () => sdk)
    const day = new Date('2026-04-26T10:00:00Z')
    expect(mod.dailyLaunchPing('1.11.16', day)).toBe(true)
    expect(pings).toEqual([{ message: 'launch 1.11.16', level: 'info', client: clients[0] }])
    expect(clients[0].initialized).toBe(true)
    // Not through the crash SDK's global scope: that one would attach breadcrumbs and contexts.
    expect(mockCaptureMessage).not.toHaveBeenCalled()
    // Same day, should NOT fire again
    expect(mod.dailyLaunchPing('1.11.16', day)).toBe(false)
    expect(pings).toHaveLength(1)
  })

  it('configures the ping client to collect nothing', async () => {
    const { sdk, clients } = makePingSdk()
    const mod = await loadConsented({ usage: true }, '1.11.16', () => sdk)
    withEnv('NODE_ENV', 'test', () => {
      mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))
    })
    expect(clients[0].options).toMatchObject({
      dsn: DSN,
      release: 'termpolis@1.11.16',
      environment: 'test',
      integrations: [],
      transport: sdk.makeElectronTransport,
      stackParser: sdk.defaultStackParser,
      sendDefaultPii: false,
      includeServerName: false,
      sendClientReports: false,
    })
    expect(clients[0].options.beforeBreadcrumb()).toBeNull()
  })

  it('reports environment "production" when NODE_ENV is unset', async () => {
    const { sdk, clients } = makePingSdk()
    const mod = await loadConsented({ usage: true }, '1.11.16', () => sdk)
    withEnv('NODE_ENV', undefined, () => {
      mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))
    })
    expect(clients[0].options.environment).toBe('production')
  })

  it('beforeSend cuts the event to the whitelist, drops attachments, and re-checks consent', async () => {
    const { sdk, clients } = makePingSdk()
    const mod = await loadConsented({ usage: true }, '1.11.16', () => sdk)
    mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))
    const { beforeSend } = clients[0].options
    const hint: { attachments?: unknown[] } = { attachments: [{ filename: 'main.log' }] }
    expect(beforeSend({
      message: 'launch 1.11.16', level: 'info', breadcrumbs: [{ message: 'updater: checking' }],
      contexts: { device: { cpu_description: 'x' } }, user: { id: 'u1' },
    }, hint)).toEqual({ message: 'launch 1.11.16', level: 'info', tags: { tier: 'usage' } })
    expect(hint.attachments).toEqual([])

    // Withdrawn while the event was still queued: it must not go.
    mod.setConsent({ usage: false })
    expect(beforeSend({ message: 'launch 1.11.16' }, {})).toBeNull()
  })

  it('fires again on a new UTC day', async () => {
    const { sdk, pings } = makePingSdk()
    const mod = await loadConsented({ usage: true }, '1.11.16', () => sdk)
    mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))
    mod.dailyLaunchPing('1.11.16', new Date('2026-04-27T01:00:00Z'))
    expect(pings).toHaveLength(2)
  })

  it('persists lastLaunchPingDate so de-dupe survives relaunches', async () => {
    const { sdk, pings } = makePingSdk()
    let mod = await loadConsented({ usage: true }, '1.11.16', () => sdk)
    mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))

    // Reload — lastLaunchPingDate must come back from disk
    mod = await loadWithProvider(() => sdk)
    mod.initTelemetry(tmpDir)
    expect(mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T20:00:00Z'))).toBe(false)
    expect(pings).toHaveLength(1)
  })

  it('a v1 file\'s ping date still counts once the user says yes the same day', async () => {
    writeTelemetryFile({ optIn: true, lastLaunchPingDate: '2026-04-26' })
    const { sdk, pings } = makePingSdk()
    process.env.SENTRY_DSN = DSN
    const mod = await loadWithProvider(() => sdk)
    mod.initTelemetry(tmpDir)
    mod.setConsent({ usage: true })
    expect(mod.dailyLaunchPing('1.48.0', new Date('2026-04-26T20:00:00Z'))).toBe(false)
    expect(pings).toHaveLength(0)
  })

  it('still marks the day on disk even if Sentry is unavailable (no DSN)', async () => {
    const mod = await loadConsented({ usage: true })
    delete process.env.SENTRY_DSN
    expect(mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))).toBe(false)
    expect(readTelemetryFile().lastLaunchPingDate).toBe('2026-04-26')
  })

  it('a send that throws reports false but still marks the day, so it is not retried on every relaunch', async () => {
    const { sdk } = makePingSdk()
    const broken = {
      ...sdk,
      NodeClient: class { constructor() { throw new Error('transport init failed') } },
    }
    const mod = await loadConsented({ usage: true }, '1.11.16', () => broken)
    expect(mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T10:00:00Z'))).toBe(false)
    expect(readTelemetryFile().lastLaunchPingDate).toBe('2026-04-26')
    expect(mod.dailyLaunchPing('1.11.16', new Date('2026-04-26T11:00:00Z'))).toBe(false)
  })
})

describe('persistence robustness', () => {
  it('setConsent before initTelemetry updates memory without throwing', async () => {
    const mod = await loadFreshModule()
    // Without calling initTelemetry, file path is null — setConsent should
    // still update in-memory state without throwing.
    expect(() => mod.setConsent({ crash: true })).not.toThrow()
    expect(mod.isCrashEnabled()).toBe(true)
  })

  it('survives a corrupted telemetry.json on subsequent writes', async () => {
    writeTelemetryFile('garbage{')
    const mod = await loadFreshModule()
    mod.initTelemetry(tmpDir)
    // Hydration treats garbage as not asked, but writes should still work
    mod.setConsent({ crash: true })
    expect(readTelemetryFile()).toEqual({ crash: true, usage: false, consentVersion: CONSENT_VERSION })
  })

  it('a userData path that is really a FILE cannot be written, and setConsent still updates in memory', async () => {
    const blocker = join(tmpDir, 'blocker')
    writeFileSync(blocker, 'i am a file, not a directory')
    const mod = await loadFreshModule()
    mod.initTelemetry(blocker) // telemetry.json would have to live INSIDE a regular file

    // mkdirSync on an existing file throws. Losing the persisted answer only means the user is asked
    // again next launch; throwing out of setConsent would take down the IPC handler that called it.
    expect(() => mod.setConsent({ crash: true })).not.toThrow()
    expect(mod.isCrashEnabled()).toBe(true)
    expect(existsSync(join(blocker, 'telemetry.json'))).toBe(false)
  })
})

// ── The Sentry surface we do NOT control ─────────────────────────────────────────────────────────
// Every suite above injects a fake that has every method and never throws. A real @sentry/electron
// is not that: the lazy require() can fail outright, a version skew can hand back an object without
// the method being called, and the whole point of the `?.` / try/catch armour in telemetry.ts is
// that a telemetry failure never surfaces at the call site — which is, by design, inside somebody
// else's catch block or on the startup path.

describe('sentryOrNull — the resolver is not trusted', () => {
  it('a provider that THROWS is treated as "no Sentry", never as a crash in the caller', async () => {
    const mod = await loadConsented({ crash: true, usage: true }, '1.48.0', () => {
      throw new Error('@sentry/electron failed to load')
    })

    // Every record* has to survive it. An import failure inside telemetry must not take down the
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
    expect(readTelemetryFile().lastLaunchPingDate).toBe('2026-04-26')
  })

  it('uses the real lazy require() when no test provider was installed', async () => {
    // The shipped default is `() => require('@sentry/electron/main')`, and sentryOrNull catches it
    // throwing: however Sentry fails to resolve, telemetry degrades to a no-op rather than throwing
    // out of a call site that cannot handle it.
    process.env.SENTRY_DSN = DSN
    vi.resetModules()
    const mod = await import('../../src/main/telemetry')
    mod.__resetTelemetryForTests() // deliberately NO __setSentryProviderForTests here
    mod.initTelemetry(tmpDir)
    mod.setConsent({ crash: true, usage: true })

    expect(() => mod.recordEvent('boot')).not.toThrow()
    expect(() => mod.recordUpdaterEvent({ status: 'checking' })).not.toThrow()
    expect(mockAddBreadcrumb).not.toHaveBeenCalled() // the fake is NOT wired on this instance
    expect(mod.isCrashEnabled()).toBe(true) // the gate itself is unaffected by Sentry being absent
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

  it('every record* no-ops instead of throwing', async () => {
    const mod = await loadConsented({ crash: true, usage: true }, '1.48.0', bareModule)
    expect(() => mod.recordUpdaterEvent({ status: 'error', error: 'sha512 mismatch' })).not.toThrow()
    expect(() => mod.recordEvent('swarm.start', { agentCount: 2 })).not.toThrow()
    expect(() => mod.recordSwarmError('swarm.test', new Error('x'))).not.toThrow()
    expect(() => mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_000 })).not.toThrow()
  })

  it('dailyLaunchPing reports not sent, but still marks the day', async () => {
    const mod = await loadConsented({ usage: true }, '1.48.0', bareModule)
    // No NodeClient to build the ping on: nothing went out, and re-attempting it on every relaunch
    // today would not change that.
    expect(mod.dailyLaunchPing('1.2.3', new Date('2026-04-26T10:00:00Z'))).toBe(false)
    expect(mod.dailyLaunchPing('1.2.3', new Date('2026-04-26T23:00:00Z'))).toBe(false)
    expect(readTelemetryFile().lastLaunchPingDate).toBe('2026-04-26')
  })
})

describe('recordUncleanExit — a native fatal leaves no JS exception to catch', () => {
  it('is a no-op with crash reports off', async () => {
    const mod = await loadConsented({ crash: false, usage: true })
    mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_000 })
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('is a no-op with no DSN even with crash reports on', async () => {
    const mod = await loadConsented({ crash: true })
    delete process.env.SENTRY_DSN
    mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_000 })
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('reports the crash as an ordinary EXCEPTION so the existing Sentry→GitHub alert files it', async () => {
    const mod = await loadConsented({ crash: true })
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
    expect(opts.extra.hint).toContain('minidumps are not uploaded')
  })

  it('rounds the uptime to whole seconds rather than printing raw milliseconds', async () => {
    const mod = await loadConsented({ crash: true })
    mod.recordUncleanExit({ prevVersion: '2.0.0', uptimeMs: 95_500 })
    expect(mockCaptureException.mock.calls[0][0].message).toContain('~96s')
  })

  it('never throws when captureException itself blows up — it runs on the startup path', async () => {
    const mod = await loadConsented({ crash: true })
    mockCaptureException.mockImplementationOnce(() => { throw new Error('sentry transport is down') })
    expect(() => mod.recordUncleanExit({ prevVersion: '1.27.4', uptimeMs: 3_000 })).not.toThrow()
  })
})

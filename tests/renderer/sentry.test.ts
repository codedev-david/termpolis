// The renderer's Sentry wiring: the consent mirror that gates it, starting and stopping it as
// consent changes, the scrubbing beforeSend/beforeBreadcrumb, and the recordSwarmError helper.
// The real Sentry SDK is replaced with a stub via vi.mock so we can assert call shape.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockInit = vi.fn()
const mockAddBreadcrumb = vi.fn()
const mockCaptureException = vi.fn()
const mockClose = vi.fn(() => Promise.resolve(true))
let clientOptions: { enabled?: boolean } = {}
let hasClient = true

vi.mock('@sentry/react', () => ({
  init: (...args: any[]) => mockInit(...args),
  addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
  captureException: (...args: any[]) => mockCaptureException(...args),
  getClient: () => (hasClient ? { getOptions: () => clientOptions } : undefined),
  close: () => mockClose(),
}))

type Mod = typeof import('../../src/renderer/src/lib/sentry')

const DSN = 'https://public@example.invalid/1'

/** A fresh copy of the module (its DSN is read at import, and it remembers whether it started). */
async function load(dsn = DSN): Promise<Mod> {
  vi.resetModules()
  vi.stubEnv('VITE_SENTRY_DSN', dsn)
  return import('../../src/renderer/src/lib/sentry')
}

/** What main answers once the user has chosen. */
const view = (crash: boolean, usage = false) => ({ crash, usage, consentVersion: 2, needsReview: false })

/** The mirror as main last left it. */
function seed(crash: boolean, usage = false, version = '2'): void {
  localStorage.setItem('termpolis.consent.version', version)
  localStorage.setItem('termpolis.telemetry.crash', String(crash))
  localStorage.setItem('termpolis.telemetry.usage', String(usage))
}

function setBridge(api: Record<string, unknown> | undefined): void {
  ;(window as any).termpolis = api
}

let listeners: Record<string, (e: any) => void>

beforeEach(() => {
  localStorage.clear()
  mockInit.mockReset()
  mockAddBreadcrumb.mockReset()
  mockCaptureException.mockReset()
  mockClose.mockReset()
  clientOptions = {}
  hasClient = true
  listeners = {}
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, handler: (e: any) => void) => {
    listeners[type] = handler
  }) as any)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  delete (window as any).termpolis
  localStorage.clear()
})

describe('the consent mirror', () => {
  it('reads both tiers off until an answer is recorded under this consent version', async () => {
    const mod = await load()
    expect(mod.readConsentMirror()).toEqual({ crash: false, usage: false })
    seed(true, true, '1')
    expect(mod.readConsentMirror()).toEqual({ crash: false, usage: false })
    // A garbled version reads NaN, which must not count as current.
    seed(true, true, 'v2')
    expect(mod.readConsentMirror()).toEqual({ crash: false, usage: false })
    seed(true, false)
    expect(mod.readConsentMirror()).toEqual({ crash: true, usage: false })
    seed(false, true, '3')
    expect(mod.readConsentMirror()).toEqual({ crash: false, usage: true })
  })

  it('ignores the pre-v2 opt-in, which the old onboarding ticked for the user', async () => {
    const mod = await load()
    localStorage.setItem(mod.LEGACY_OPT_IN_KEY, '1')
    expect(mod.crashReportingAllowed()).toBe(false)
  })

  it('reads both off when storage cannot be read', async () => {
    const mod = await load()
    seed(true, true)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(mod.readConsentMirror()).toEqual({ crash: false, usage: false })
  })
})

describe('applyRendererConsent', () => {
  it('mirrors what main holds and removes the legacy opt-in', async () => {
    const mod = await load()
    localStorage.setItem(mod.LEGACY_OPT_IN_KEY, '1')
    mod.applyRendererConsent(view(false, true))
    expect(localStorage.getItem(mod.CONSENT_VERSION_KEY)).toBe('2')
    expect(localStorage.getItem(mod.CRASH_KEY)).toBe('false')
    expect(localStorage.getItem(mod.USAGE_KEY)).toBe('true')
    expect(localStorage.getItem(mod.LEGACY_OPT_IN_KEY)).toBeNull()
  })

  it('stores anything but true as off', async () => {
    const mod = await load()
    mod.applyRendererConsent({ crash: 'yes', usage: 1, consentVersion: 2, needsReview: false } as any)
    expect(mod.readConsentMirror()).toEqual({ crash: false, usage: false })
  })

  it('survives storage that refuses writes, and starts nothing', async () => {
    const mod = await load()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => mod.applyRendererConsent(view(true))).not.toThrow()
    expect(mod.crashReportingAllowed()).toBe(false)
    expect(mockInit).not.toHaveBeenCalled()
  })

  it('starts Sentry when crash reports turn on, and stops it the moment they turn off', async () => {
    const mod = await load()
    mod.applyRendererConsent(view(true))
    expect(mockInit).toHaveBeenCalledTimes(1)
    mod.applyRendererConsent(view(true, true))
    expect(mockInit).toHaveBeenCalledTimes(1)

    clientOptions.enabled = true
    mod.applyRendererConsent(view(false))
    expect(clientOptions.enabled).toBe(false)
    expect(mockClose).toHaveBeenCalledTimes(1)
    mod.applyRendererConsent(view(false, true))
    expect(mockClose).toHaveBeenCalledTimes(1)

    // On again: a new client, rather than reviving the one being closed.
    mod.applyRendererConsent(view(true))
    expect(mockInit).toHaveBeenCalledTimes(2)
  })
})

describe('syncConsentFromMain', () => {
  it('follows the consent main holds', async () => {
    const mod = await load()
    const consent = view(true, true)
    setBridge({ telemetryGetConsent: vi.fn().mockResolvedValue({ success: true, data: consent }) })
    await expect(mod.syncConsentFromMain()).resolves.toEqual(consent)
    expect(mod.readConsentMirror()).toEqual({ crash: true, usage: true })
    expect(mockInit).toHaveBeenCalledTimes(1)
  })

  it('stops reporting when main no longer has crash reports on', async () => {
    const mod = await load()
    seed(true)
    mod.initSentry()
    setBridge({
      telemetryGetConsent: vi.fn().mockResolvedValue({
        success: true,
        data: { crash: false, usage: false, consentVersion: 0, needsReview: true },
      }),
    })
    await mod.syncConsentFromMain()
    expect(mockClose).toHaveBeenCalledTimes(1)
    expect(mod.crashReportingAllowed()).toBe(false)
  })

  it('leaves the mirror alone when main cannot say', async () => {
    const mod = await load()
    seed(true)
    setBridge({ telemetryGetConsent: vi.fn().mockResolvedValue({ success: false, error: 'boom' }) })
    await expect(mod.syncConsentFromMain()).resolves.toBeNull()
    setBridge({ telemetryGetConsent: vi.fn().mockRejectedValue(new Error('no ipc')) })
    await expect(mod.syncConsentFromMain()).resolves.toBeNull()
    setBridge(undefined)
    await expect(mod.syncConsentFromMain()).resolves.toBeNull()
    expect(mod.crashReportingAllowed()).toBe(true)
  })
})

describe('saveConsent', () => {
  it('sends the choice to main and follows what main then holds', async () => {
    const mod = await load()
    const set = vi.fn().mockResolvedValue({ success: true, data: view(true, false) })
    setBridge({ telemetrySetConsent: set })
    await expect(mod.saveConsent({ crash: true })).resolves.toEqual(view(true, false))
    expect(set).toHaveBeenCalledWith({ crash: true })
    expect(mod.readConsentMirror()).toEqual({ crash: true, usage: false })
    expect(mockInit).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['refuses it', () => vi.fn().mockResolvedValue({ success: false, error: 'crash and usage must be booleans' })],
    ['cannot be reached', () => vi.fn().mockRejectedValue(new Error('no ipc'))],
  ])('reads both off when main %s', async (_label, makeSet) => {
    const mod = await load()
    seed(true, true)
    mod.initSentry()
    setBridge({ telemetrySetConsent: makeSet() })
    const saved = await mod.saveConsent({ usage: true })
    expect(saved).toEqual({ crash: false, usage: false, consentVersion: 0, needsReview: true })
    expect(mod.readConsentMirror()).toEqual({ crash: false, usage: false })
    expect(mockClose).toHaveBeenCalledTimes(1)
    // A fresh answer each time: changing one can't change the next.
    saved.crash = true
    await expect(mod.saveConsent({})).resolves.toMatchObject({ crash: false })
  })
})

describe('initSentry', () => {
  it('does not start without a DSN, even with crash reports on', async () => {
    const mod = await load('')
    seed(true)
    mod.initSentry()
    expect(mockInit).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Sentry: no DSN configured (set VITE_SENTRY_DSN to enable crash reporting)')
  })

  it('does not start with crash reports off, or on the legacy opt-in alone', async () => {
    const mod = await load()
    localStorage.setItem(mod.LEGACY_OPT_IN_KEY, '1')
    mod.initSentry()
    seed(false, true)
    mod.initSentry()
    expect(mockInit).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('Sentry: crash reports are off')
    expect(listeners).toEqual({})
  })

  it('starts with crash reports on: errors only, no PII, and every event and breadcrumb through the gate', async () => {
    vi.stubEnv('VITE_APP_VERSION', '1.48.0')
    const mod = await load()
    seed(true)
    mod.initSentry()
    expect(mockInit).toHaveBeenCalledTimes(1)
    expect(mockInit.mock.calls[0][0]).toMatchObject({
      dsn: DSN,
      environment: 'test',
      release: 'termpolis@1.48.0',
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      sendDefaultPii: false,
      sendClientReports: false,
      beforeSend: mod.rendererBeforeSend,
      beforeBreadcrumb: mod.rendererBeforeBreadcrumb,
    })
    expect(console.log).toHaveBeenCalledWith('Sentry initialized for crash reporting')
  })

  it('reports production and an unknown release when the build does not say', async () => {
    vi.stubEnv('MODE', '')
    vi.stubEnv('VITE_APP_VERSION', '')
    const mod = await load()
    seed(true)
    mod.initSentry()
    expect(mockInit.mock.calls[0][0]).toMatchObject({ environment: 'production', release: 'termpolis@unknown' })
  })

  it("drops session pings and the user's locale and time zone from the SDK's real defaults", async () => {
    const real = await vi.importActual<typeof import('@sentry/react')>('@sentry/react')
    const defaults = real.getDefaultIntegrations({}).map((integration) => integration.name)
    // The names must be the installed SDK's own, or the filter silently drops nothing.
    expect(defaults).toEqual(expect.arrayContaining(['BrowserSession', 'CultureContext', 'GlobalHandlers']))

    const mod = await load()
    seed(true)
    mod.initSentry()
    const { integrations } = mockInit.mock.calls[0][0]
    const kept = integrations(defaults.map((name) => ({ name }))).map((integration: { name: string }) => integration.name)
    expect(kept).toEqual(defaults.filter((name) => name !== 'BrowserSession' && name !== 'CultureContext'))
  })

  it('initialises once, and installs its window handlers once across restarts', async () => {
    const mod = await load()
    seed(true)
    mod.initSentry()
    mod.initSentry()
    expect(mockInit).toHaveBeenCalledTimes(1)
    mod.stopSentry()
    mod.initSentry()
    expect(mockInit).toHaveBeenCalledTimes(2)
    expect(window.addEventListener).toHaveBeenCalledTimes(2)
    expect(Object.keys(listeners).sort()).toEqual(['error', 'unhandledrejection'])
  })

  it('reports unhandled rejections and window errors, and skips a rejection with nothing in it', async () => {
    const mod = await load()
    seed(true)
    mod.initSentry()
    const lost = new Error('lost')
    listeners.unhandledrejection({ reason: lost })
    expect(mockCaptureException).toHaveBeenLastCalledWith(lost)
    listeners.unhandledrejection({ reason: new Event('error') })
    expect(mockCaptureException).toHaveBeenCalledTimes(1)

    const thrown = new Error('thrown')
    listeners.error({ error: thrown, message: 'thrown' })
    expect(mockCaptureException).toHaveBeenLastCalledWith(thrown)
    listeners.error({ message: 'Script error.' })
    expect(mockCaptureException.mock.lastCall![0].message).toBe('Script error.')
    listeners.error({ message: '' })
    expect(mockCaptureException.mock.lastCall![0].message).toBe('window.onerror')
  })

  it('its window handlers never throw, even when the SDK does', async () => {
    const mod = await load()
    seed(true)
    mod.initSentry()
    mockCaptureException.mockImplementation(() => {
      throw new Error('SDK exploded')
    })
    expect(() => listeners.unhandledrejection({ reason: 'x' })).not.toThrow()
    expect(() => listeners.error({ error: new Error('y') })).not.toThrow()
  })
})

describe('stopSentry', () => {
  it('does nothing when Sentry never started', async () => {
    const mod = await load()
    mod.stopSentry()
    expect(mockClose).not.toHaveBeenCalled()
  })

  it('still closes when the SDK has no client to switch off', async () => {
    const mod = await load()
    seed(true)
    mod.initSentry()
    hasClient = false
    mod.stopSentry()
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  it('a close that fails is not an error', async () => {
    const mod = await load()
    seed(true)
    mod.initSentry()
    mockClose.mockImplementationOnce(() => Promise.reject(new Error('flush failed')))
    mod.stopSentry()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockClose).toHaveBeenCalledTimes(1)
  })
})

describe('rendererBeforeSend', () => {
  it('sends nothing with crash reports off', async () => {
    const mod = await load()
    expect(mod.rendererBeforeSend({ message: 'boom' } as any)).toBeNull()
    seed(false, true)
    expect(mod.rendererBeforeSend({ message: 'boom' } as any)).toBeNull()
  })

  it('sends nothing while offline', async () => {
    const mod = await load()
    seed(true)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(mod.rendererBeforeSend({ message: 'boom' } as any)).toBeNull()
  })

  it('keeps a genuine error', async () => {
    const mod = await load()
    seed(true)
    expect(mod.rendererBeforeSend({ message: 'boom' } as any)).toEqual({ message: 'boom' })
  })

  it('an event it cannot scrub is not sent', async () => {
    const mod = await load()
    seed(true)
    const event: any = { message: 'boom' }
    Object.defineProperty(event, 'extra', {
      enumerable: true,
      get() {
        throw new Error('unreadable')
      },
    })
    expect(mod.rendererBeforeSend(event)).toBeNull()
  })

  it('drops the machine name, the user and console breadcrumbs', async () => {
    const mod = await load()
    seed(true)
    const event: any = mod.rendererBeforeSend({
      message: 'boom',
      server_name: 'JDOE-LAPTOP',
      user: { id: 'u1', ip_address: '10.0.0.1' },
      breadcrumbs: [
        { category: 'console', message: 'PS C:\\Users\\jdoe> claude' },
        { category: 'ui.click', message: 'button[aria-label="x"]' },
      ],
    } as any)
    expect(event).toEqual({ message: 'boom', breadcrumbs: [{ category: 'ui.click', message: 'button[aria-label="x"]' }] })
  })

  it('rewrites stack frames to app:/// paths and reduces the request to a query-less app URL', async () => {
    const mod = await load()
    seed(true)
    const asar = 'file:///C:/Users/jdoe/AppData/Local/Programs/Termpolis/resources/app.asar/out/renderer'
    const event: any = mod.rendererBeforeSend({
      exception: {
        values: [{
          type: 'TypeError',
          value: 'x is undefined',
          stacktrace: {
            frames: [
              { filename: `${asar}/assets/index-abc.js`, abs_path: `${asar}/assets/index-abc.js`, context_line: 'secret()' },
              { filename: 'file:///Applications/Termpolis.app/Contents/Resources/app.asar/out/renderer/assets/x.js' },
            ],
          },
        }],
      },
      request: {
        url: `${asar}/index.html?token=abc#terminal`,
        headers: { 'User-Agent': 'Mozilla/5.0 Electron/41' },
        cookies: { session: 's' },
        query_string: 'token=abc',
      },
    } as any)
    const frames = event.exception.values[0].stacktrace.frames
    expect(frames[0]).toEqual({
      filename: 'app:///out/renderer/assets/index-abc.js',
      abs_path: 'app:///out/renderer/assets/index-abc.js',
    })
    expect(frames[1].filename).toBe('app:///out/renderer/assets/x.js')
    expect(event.request).toEqual({ url: 'app:///out/renderer/index.html', headers: { 'User-Agent': 'Mozilla/5.0 Electron/41' } })
  })
})

describe('rendererBeforeSend — every user-path form, everywhere an event carries one', () => {
  const FORMS: Array<[string, string]> = [
    ['C:\\Users\\jdoe\\repo\\a.ts', '<home>\\repo\\a.ts'],
    ['c:\\users\\jdoe\\repo', '<home>\\repo'],
    ['C:\\\\Users\\\\jdoe\\\\repo', '<home>\\\\repo'],
    ['C:/Users/jdoe/repo', '<home>/repo'],
    ['file:///C:/Users/jdoe/repo/a.html', '<home>/repo/a.html'],
    ['/C:/Users/jdoe/repo', '<home>/repo'],
    ['C:\\Users\\Jane Doe\\repo', '<home>\\repo'],
    ['C:\\Documents and Settings\\jdoe\\x', '<home>\\x'],
    ['/Users/jdoe/repo', '<home>/repo'],
    ['file:///Users/jdoe/repo', '<home>/repo'],
    ['/home/jdoe/repo', '<home>/repo'],
    ['/c/Users/jdoe/repo', '<home>/repo'],
    ['/mnt/c/Users/jdoe/repo', '<home>/repo'],
  ]

  it.each(FORMS)('%s', async (raw, clean) => {
    const mod = await load()
    seed(true)
    const event: any = mod.rendererBeforeSend({
      message: `open failed: ${raw}`,
      exception: { values: [{ type: 'Error', value: `ENOENT '${raw}'` }] },
      extra: { cwd: raw, nested: { list: [raw] } },
      tags: { cwd: raw },
      contexts: { shell: { cwd: raw } },
      breadcrumbs: [{ category: 'swarm', message: `cd ${raw}`, data: { path: raw } }],
    } as any)
    expect(event.message).toBe(`open failed: ${clean}`)
    expect(event.exception.values[0].value).toBe(`ENOENT '${clean}'`)
    expect(event.extra).toEqual({ cwd: clean, nested: { list: [clean] } })
    expect(event.tags).toEqual({ cwd: clean })
    expect(event.contexts.shell).toEqual({ cwd: clean })
    expect(event.breadcrumbs[0]).toMatchObject({ message: `cd ${clean}`, data: { path: clean } })
  })
})

describe('rendererBeforeBreadcrumb', () => {
  it('records nothing with crash reports off', async () => {
    const mod = await load()
    expect(mod.rendererBeforeBreadcrumb({ category: 'ui.click', message: 'button' })).toBeNull()
  })

  it('never records console output', async () => {
    const mod = await load()
    seed(true)
    expect(mod.rendererBeforeBreadcrumb({ category: 'console', message: 'hello' })).toBeNull()
  })

  it("drops the clicked element's copied attributes, and scrubs every path", async () => {
    const mod = await load()
    seed(true)
    expect(mod.rendererBeforeBreadcrumb({ category: 'ui.click', message: 'div > button[aria-label="Open C:\\Users\\jdoe\\x"]' }))
      .toEqual({ category: 'ui.click', message: 'div > button[…]' })
    expect(mod.rendererBeforeBreadcrumb({ category: 'swarm', message: 'persist C:\\Users\\jdoe\\m.json', data: { dir: '/home/jdoe/x' } }))
      .toEqual({ category: 'swarm', message: 'persist <home>\\m.json', data: { dir: '<home>/x' } })
  })

  it('strips query strings from request and navigation URLs', async () => {
    const mod = await load()
    seed(true)
    expect(mod.rendererBeforeBreadcrumb({ category: 'fetch', data: { url: 'https://api.github.com/repos?access_token=abc', method: 'GET' } }))
      .toEqual({ category: 'fetch', data: { url: 'https://api.github.com/repos', method: 'GET' } })
    expect(mod.rendererBeforeBreadcrumb({
      category: 'navigation',
      data: { from: 'file:///C:/Users/jdoe/AppData/Local/Programs/Termpolis/resources/app.asar/out/renderer/index.html?a=1', to: '/home/jdoe/x' },
    })).toEqual({ category: 'navigation', data: { from: 'app:///out/renderer/index.html', to: '<home>/x' } })
  })

  it('a breadcrumb it cannot scrub is not recorded', async () => {
    const mod = await load()
    seed(true)
    const crumb: any = { category: 'swarm' }
    Object.defineProperty(crumb, 'data', {
      enumerable: true,
      get() {
        throw new Error('unreadable')
      },
    })
    expect(mod.rendererBeforeBreadcrumb(crumb)).toBeNull()
  })
})

describe('renderer recordSwarmError', () => {
  let recordSwarmError: Mod['recordSwarmError']

  beforeEach(async () => {
    ;({ recordSwarmError } = await load())
    seed(true)
  })

  it('records nothing with crash reports off', () => {
    seed(false, true)
    recordSwarmError('swarmBridge.poll.failed', new Error('bus dead'))
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('emits a swarm-categorized breadcrumb with the error message', () => {
    recordSwarmError('swarmBridge.poll.failed', new Error('bus dead'), {
      terminalId: 't1',
    })
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1)
    const crumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(crumb.category).toBe('swarm')
    expect(crumb.level).toBe('error')
    expect(crumb.message).toBe('swarmBridge.poll.failed')
    expect(crumb.data.terminalId).toBe('t1')
    expect(crumb.data.errorMessage).toBe('bus dead')
  })

  it('captures the original Error so stack traces survive', () => {
    const original = new Error('original')
    recordSwarmError('conductor.monitor.failed', original)
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    const [captured, opts] = mockCaptureException.mock.calls[0]
    expect(captured).toBe(original)
    expect(opts.tags.swarm).toBe('conductor.monitor.failed')
  })

  it('coerces a string error to a real Error', () => {
    recordSwarmError('swarm.test', 'oh no')
    const captured = mockCaptureException.mock.calls[0][0]
    expect(captured).toBeInstanceOf(Error)
    expect(captured.message).toContain('oh no')
  })

  it('coerces a non-Error object to a JSON-stringified message', () => {
    recordSwarmError('swarm.test', { code: 7, where: 'x' })
    const crumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(crumb.data.errorMessage).toContain('code')
    expect(crumb.data.errorMessage).toContain('7')
  })

  it('handles unstringifiable circular objects', () => {
    const c: any = {}; c.self = c
    expect(() => recordSwarmError('swarm.test', c)).not.toThrow()
    expect(mockAddBreadcrumb).toHaveBeenCalled()
  })

  it('never throws if the Sentry SDK throws', () => {
    mockAddBreadcrumb.mockImplementationOnce(() => { throw new Error('SDK exploded') })
    expect(() => recordSwarmError('swarm.test', new Error('inner'))).not.toThrow()
  })

  it('handles undefined ctx without crashing', () => {
    recordSwarmError('swarm.test', new Error('inner'))
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1)
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
  })

  it('passes ctx through as Sentry "extra" so it shows up in the issue', () => {
    recordSwarmError('swarm.test', new Error('inner'), { agent: 'claude', taskId: 'abc' })
    const opts = mockCaptureException.mock.calls[0][1]
    expect(opts.extra).toEqual({ agent: 'claude', taskId: 'abc' })
  })
})

describe('normalizeRejection', () => {
  let normalizeRejection: Mod['normalizeRejection']

  beforeEach(async () => {
    ;({ normalizeRejection } = await load())
  })

  it('passes Error instances through unchanged', () => {
    const err = new Error('boom')
    expect(normalizeRejection(err)).toBe(err)
  })

  it('coerces strings to Error', () => {
    const e = normalizeRejection('something failed')
    expect(e).toBeInstanceOf(Error)
    expect(e!.message).toBe('something failed')
  })

  it('coerces null/undefined to a labeled Error', () => {
    expect(normalizeRejection(null)?.message).toMatch(/no reason/)
    expect(normalizeRejection(undefined)?.message).toMatch(/no reason/)
  })

  it('drops empty DOM "error" events with no target (the GH issue #3 case)', () => {
    // jsdom Event has no target unless dispatched against an element
    const e = new Event('error')
    expect(normalizeRejection(e)).toBeNull()
  })

  it('extracts target tag and src from an image-load failure event', () => {
    const img = document.createElement('img')
    img.src = 'https://example.com/x.png'
    const evt = new Event('error')
    Object.defineProperty(evt, 'target', { value: img })
    const e = normalizeRejection(evt)
    expect(e).toBeInstanceOf(Error)
    expect(e!.message).toContain('error')
    expect(e!.message).toContain('<img>')
    expect(e!.message).toContain('example.com/x.png')
  })

  it("falls back to a link's href, and names an element that has neither", () => {
    const link = document.createElement('a')
    link.href = 'https://example.com/page'
    const onLink = new Event('error')
    Object.defineProperty(onLink, 'target', { value: link })
    expect(normalizeRejection(onLink)!.message).toBe('DOM error event on <a> (https://example.com/page)')
    const onDiv = new Event('error')
    Object.defineProperty(onDiv, 'target', { value: document.createElement('div') })
    expect(normalizeRejection(onDiv)!.message).toBe('DOM error event on <div>')
  })

  it('treats a target without a tag name like no target', () => {
    const evt = new Event('error')
    Object.defineProperty(evt, 'target', { value: {} })
    expect(normalizeRejection(evt)).toBeNull()
  })

  it('keeps non-error event types even without a target', () => {
    const evt = new Event('abort')
    const e = normalizeRejection(evt)
    expect(e).toBeInstanceOf(Error)
    expect(e!.message).toContain('abort')
  })

  it('still normalises where there is no DOM Event type', () => {
    vi.stubGlobal('Event', undefined)
    expect(normalizeRejection('no DOM here')!.message).toBe('no DOM here')
  })

  it('json-stringifies plain objects', () => {
    const e = normalizeRejection({ code: 42, where: 'bridge' })
    expect(e!.message).toContain('42')
    expect(e!.message).toContain('bridge')
  })

  it('falls back to String() for unstringifiable values', () => {
    const c: any = {}; c.self = c
    const e = normalizeRejection(c)
    expect(e).toBeInstanceOf(Error)
    expect(e!.message).toMatch(/unhandledrejection/)
  })
})

describe('scrubUiBreadcrumb', () => {
  let scrubUiBreadcrumb: Mod['scrubUiBreadcrumb']
  const click = (message: string) => ({ category: 'ui.click', message })

  beforeEach(async () => {
    ;({ scrubUiBreadcrumb } = await load())
  })

  it('drops the attributes Sentry copies verbatim from a clicked element', () => {
    expect(
      scrubUiBreadcrumb(click('div.settings-section > button.text-xs[type="button"][aria-label="Select git.exe (pid 777)"]'))
        .message,
    ).toBe('div.settings-section > button.text-xs[type="button"][…]')
    expect(scrubUiBreadcrumb(click(String.raw`li > div[title="node cli.js -p "triage C:\Users\me""]`)).message).toBe(
      'li > div[…]',
    )
    expect(scrubUiBreadcrumb(click('img[alt="Jane Doe"]')).message).toBe('img[…]')
    expect(scrubUiBreadcrumb({ category: 'ui.input', message: 'input[name="password"]' }).message).toBe('input[…]')
  })

  it('takes everything up to the last quoted attribute, since the values are not escaped', () => {
    // A value holding `"]` would end a lazy match early and leak the rest of itself.
    expect(scrubUiBreadcrumb(click('span[title="a"] > b"][aria-label="secret tail"]')).message).toBe('span[…]')
    // An ancestor's attribute takes the path after it along — losing the path is the cheaper mistake.
    expect(
      scrubUiBreadcrumb(click(String.raw`div[title="C:\Users\me\notes.txt"] > ul.ml-5 > button[aria-label="x"]`)).message,
    ).toBe('div[…]')
  })

  it('leaves alone a path that carries nothing copied from the page', () => {
    for (const message of [
      'div.settings-section > button.text-xs[type="button"]',
      'ProcessesSettings > process-command',
      'button#refresh.px-2',
      'div[data-x="1"]',
    ]) {
      expect(scrubUiBreadcrumb(click(message)).message).toBe(message)
    }
  })

  it('touches only UI breadcrumbs that have a message', () => {
    const other = { category: 'console', message: 'button[title="x"]' }
    expect(scrubUiBreadcrumb(other).message).toBe('button[title="x"]')
    const uncategorised = { message: 'button[title="x"]' }
    expect(scrubUiBreadcrumb(uncategorised).message).toBe('button[title="x"]')
    const silent = { category: 'ui.click' }
    expect(scrubUiBreadcrumb(silent)).toEqual({ category: 'ui.click' })
    // The same breadcrumb comes back, edited in place.
    const crumb = click('a[title="t"]')
    expect(scrubUiBreadcrumb(crumb)).toBe(crumb)
  })
})

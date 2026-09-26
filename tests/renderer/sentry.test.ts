// Coverage for the renderer-side recordSwarmError helper. The real Sentry
// SDK is replaced with a stub via vi.mock so we can assert call shape.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAddBreadcrumb = vi.fn()
const mockCaptureException = vi.fn()

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
  captureException: (...args: any[]) => mockCaptureException(...args),
  browserTracingIntegration: vi.fn(() => ({})),
}))

import { recordSwarmError, normalizeRejection, scrubUiBreadcrumb } from '../../src/renderer/src/lib/sentry'

beforeEach(() => {
  mockAddBreadcrumb.mockReset()
  mockCaptureException.mockReset()
})

describe('renderer recordSwarmError', () => {
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

  it('keeps non-error event types even without a target', () => {
    const evt = new Event('abort')
    const e = normalizeRejection(evt)
    expect(e).toBeInstanceOf(Error)
    expect(e!.message).toContain('abort')
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
  const click = (message: string) => ({ category: 'ui.click', message })

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

describe('initSentry', () => {
  it('scrubs every breadcrumb before Sentry records it', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.invalid/1')
    localStorage.setItem('termpolis.telemetry.optIn', '1')
    const listen = vi.spyOn(window, 'addEventListener').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const sdk = await import('@sentry/react')
      const mod = await import('../../src/renderer/src/lib/sentry')
      mod.initSentry()
      expect(sdk.init).toHaveBeenCalledWith(expect.objectContaining({ beforeBreadcrumb: mod.scrubUiBreadcrumb }))
    } finally {
      listen.mockRestore()
      log.mockRestore()
      localStorage.removeItem('termpolis.telemetry.optIn')
      vi.unstubAllEnvs()
    }
  })
})

// Coverage for recordSwarmError — the helper that catches block sites use to
// surface real swarm bugs to Sentry. Same injectable provider trick as
// telemetry.test.ts (vi.mock can't intercept lazy require()).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAddBreadcrumb = vi.fn()
const mockCaptureException = vi.fn()
const fakeSentry = {
  addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
  captureException: (...args: any[]) => mockCaptureException(...args),
}

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))

async function loadFreshModule() {
  vi.resetModules()
  const mod = await import('../../src/main/telemetry')
  mod.__resetTelemetryForTests()
  mod.__setSentryProviderForTests(() => fakeSentry)
  return mod
}

beforeEach(() => {
  mockAddBreadcrumb.mockReset()
  mockCaptureException.mockReset()
  delete process.env.SENTRY_DSN
})

describe('recordSwarmError', () => {
  it('is a no-op when opt-in is false', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.recordSwarmError('swarm.test', new Error('boom'))
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('is a no-op when DSN is empty', async () => {
    delete process.env.SENTRY_DSN
    const mod = await loadFreshModule()
    mod.setOptIn(true)
    mod.recordSwarmError('swarm.test', new Error('boom'))
    expect(mockAddBreadcrumb).not.toHaveBeenCalled()
  })

  it('emits a breadcrumb + captureException with stack trace', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.setOptIn(true)
    const err = new Error('thing exploded')
    mod.recordSwarmError('swarm.memory.persist.failed', err, { entryId: 'mem-1' })

    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1)
    const crumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(crumb.category).toBe('swarm')
    expect(crumb.level).toBe('error')
    expect(crumb.message).toBe('swarm.memory.persist.failed')
    expect(crumb.data.entryId).toBe('mem-1')
    expect(crumb.data.errorMessage).toBe('thing exploded')

    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    const [captured, opts] = mockCaptureException.mock.calls[0]
    expect(captured).toBe(err)
    expect(opts.tags.swarm).toBe('swarm.memory.persist.failed')
    expect(opts.extra).toEqual({ entryId: 'mem-1' })
  })

  it('coerces a string error into a real Error so we get a stack trace', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.setOptIn(true)
    mod.recordSwarmError('swarm.bridge.poll.failed', 'string-only error')
    const captured = mockCaptureException.mock.calls[0][0]
    expect(captured).toBeInstanceOf(Error)
    expect(captured.message).toContain('swarm.bridge.poll.failed')
    expect(captured.message).toContain('string-only error')
  })

  it('coerces an object error and JSON-stringifies it', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.setOptIn(true)
    mod.recordSwarmError('swarm.test', { code: 42 })
    const crumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(crumb.data.errorMessage).toBe('{"code":42}')
  })

  it('handles unstringifiable objects without crashing', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.setOptIn(true)
    const circular: any = {}
    circular.self = circular
    expect(() => mod.recordSwarmError('swarm.test', circular)).not.toThrow()
    // Falls through to String(err) which is "[object Object]"
    const crumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(typeof crumb.data.errorMessage).toBe('string')
  })

  it('never throws even if the Sentry provider throws', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.setOptIn(true)
    mockAddBreadcrumb.mockImplementationOnce(() => { throw new Error('sentry blew up') })
    expect(() => mod.recordSwarmError('swarm.test', new Error('inner'))).not.toThrow()
  })

  it('handles undefined ctx without crashing', async () => {
    process.env.SENTRY_DSN = 'https://fake@sentry.io/1'
    const mod = await loadFreshModule()
    mod.setOptIn(true)
    mod.recordSwarmError('swarm.test', new Error('inner'))
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1)
    const crumb = mockAddBreadcrumb.mock.calls[0][0]
    expect(crumb.data.errorMessage).toBe('inner')
  })
})

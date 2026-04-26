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

import { recordSwarmError } from '../../src/renderer/src/lib/sentry'

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

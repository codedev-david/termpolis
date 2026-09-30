import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Saving a choice starts or stops renderer Sentry; keep the real SDK out of it.
vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  getClient: vi.fn(() => undefined),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}))

import {
  ConsentReviewModal,
  consentNeedsReview,
} from '../../src/renderer/src/components/ConsentReview/ConsentReviewModal'

function view(needsReview: boolean) {
  return { crash: false, usage: false, consentVersion: needsReview ? 0 : 2, needsReview }
}

function bridge(over: Record<string, unknown> = {}) {
  const api = {
    telemetryGetConsent: vi.fn(async () => ({ success: true, data: view(true) })),
    telemetrySetConsent: vi.fn(async (c: { crash?: boolean; usage?: boolean }) => ({
      success: true,
      data: { crash: c.crash === true, usage: c.usage === true, consentVersion: 2, needsReview: false },
    })),
    tokenSavingsGetSettings: vi.fn(async () => ({ success: true, data: { wireProxy: true } })),
    tokenSavingsSetSettings: vi.fn(async (p: { wireProxy: boolean }) => ({ success: true, data: { wireProxy: p.wireProxy } })),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

const crashBox = () => screen.getByRole('checkbox', { name: 'Send crash reports' }) as HTMLInputElement
const usageBox = () => screen.getByRole('checkbox', { name: 'Send anonymous usage statistics' }) as HTMLInputElement

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as any).termpolis
  localStorage.clear()
})

describe('consentNeedsReview', () => {
  it('passes on main’s needsReview', async () => {
    bridge()
    expect(await consentNeedsReview()).toBe(true)
    bridge({ telemetryGetConsent: vi.fn(async () => ({ success: true, data: view(false) })) })
    expect(await consentNeedsReview()).toBe(false)
  })

  it('is false when main refuses or the bridge is missing', async () => {
    bridge({ telemetryGetConsent: vi.fn(async () => ({ success: false, error: 'nope' })) })
    expect(await consentNeedsReview()).toBe(false)
    delete (window as any).termpolis
    expect(await consentNeedsReview()).toBe(false)
  })
})

describe('ConsentReviewModal', () => {
  it('renders under a stable test id with both tiers off, the proxy and the slot', () => {
    bridge()
    render(<ConsentReviewModal onDone={() => {}} />)
    expect(screen.getByTestId('consent-review-modal')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Review your privacy choices' })).toBeInTheDocument()
    expect(crashBox().checked).toBe(false)
    expect(usageBox().checked).toBe(false)
    expect(screen.getByTestId('privacy-proxy')).toBeInTheDocument()
    expect(screen.getByTestId('consent-review-agent-integrations-slot')).toBeInTheDocument()
    expect(screen.getByText('Privacy policy').closest('a')).toHaveAttribute('href', expect.stringContaining('PRIVACY.md'))
  })

  it('does not pre-tick anything from a pre-v2 opt-in', () => {
    localStorage.setItem('termpolis.telemetry.optIn', '1')
    localStorage.setItem('termpolis.telemetry.crash', 'true')
    bridge()
    render(<ConsentReviewModal onDone={() => {}} />)
    expect(crashBox().checked).toBe(false)
    expect(usageBox().checked).toBe(false)
  })

  it('Save records the values shown and closes', async () => {
    const api = bridge()
    const onDone = vi.fn()
    render(<ConsentReviewModal onDone={onDone} />)
    fireEvent.click(crashBox())
    fireEvent.click(usageBox())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: true, usage: true })
    expect(onDone).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(localStorage.getItem('termpolis.telemetry.usage')).toBe('true'))
    expect(localStorage.getItem('termpolis.consent.version')).toBe('2')
  })

  it('Not now records the values shown (both off) so it never asks again', () => {
    const api = bridge()
    const onDone = vi.fn()
    render(<ConsentReviewModal onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: false, usage: false })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('Not now after ticking one still records exactly what is shown', () => {
    const api = bridge()
    render(<ConsentReviewModal onDone={() => {}} />)
    fireEvent.click(usageBox())
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: false, usage: true })
  })

  it('Escape answers like Not now; other keys do nothing; unmounting stops listening', () => {
    const api = bridge()
    const onDone = vi.fn()
    const { unmount } = render(<ConsentReviewModal onDone={onDone} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(crashBox())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: true, usage: false })
    expect(onDone).toHaveBeenCalledTimes(1)
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('still closes, leaving the renderer mirror off, when main can’t be reached', async () => {
    const onDone = vi.fn()
    render(<ConsentReviewModal onDone={onDone} />)
    fireEvent.click(crashBox())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onDone).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(localStorage.getItem('termpolis.telemetry.crash')).toBe('false'))
  })

  it('clicks inside the dialog do not reach the backdrop', () => {
    bridge()
    const onBackdrop = vi.fn()
    render(
      <div onClick={onBackdrop}>
        <ConsentReviewModal onDone={() => {}} />
      </div>,
    )
    fireEvent.click(screen.getByRole('dialog'))
    expect(onBackdrop).not.toHaveBeenCalled()
  })
})

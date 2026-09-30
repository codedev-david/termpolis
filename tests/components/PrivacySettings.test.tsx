import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Saving a choice starts or stops renderer Sentry; keep the real SDK out of it.
vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  getClient: vi.fn(() => undefined),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}))

import { PrivacySettings } from '../../src/renderer/src/components/SettingsPane/PrivacySettings'

function view(crash: boolean, usage: boolean) {
  return { crash, usage, consentVersion: 2, needsReview: false }
}

// Main as a store: answers get with what it holds, set merges the tiers it is given.
function bridge(start = view(false, false), over: Record<string, unknown> = {}) {
  let held = { ...start }
  const api = {
    telemetryGetConsent: vi.fn(async () => ({ success: true, data: held })),
    telemetrySetConsent: vi.fn(async (c: { crash?: boolean; usage?: boolean }) => {
      held = { ...held, ...c, consentVersion: 2, needsReview: false }
      return { success: true, data: held }
    }),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

const crashSwitch = () => screen.getByRole('button', { name: 'Toggle crash reporting' })
const usageSwitch = () => screen.getByRole('button', { name: 'Toggle usage statistics' })

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as any).termpolis
  localStorage.clear()
})

describe('PrivacySettings', () => {
  it('shows both tiers with the shared wording and no relaunch caveat', () => {
    bridge()
    render(<PrivacySettings onOpenTokenSavings={() => {}} />)
    const section = screen.getByTestId('settings-privacy')
    expect(section).toHaveTextContent('Privacy')
    expect(section).toHaveTextContent('Send crash reports')
    expect(section).toHaveTextContent('Send anonymous usage statistics')
    expect(section).toHaveTextContent(/applies at once/)
    expect(section).not.toHaveTextContent(/next launch/i)
    expect(screen.getByTestId('settings-agent-integrations-slot')).toBeInTheDocument()
  })

  it('paints the mirrored consent at once, then shows what main holds', async () => {
    localStorage.setItem('termpolis.consent.version', '2')
    localStorage.setItem('termpolis.telemetry.crash', 'true')
    bridge(view(false, true))
    render(<PrivacySettings onOpenTokenSavings={() => {}} />)
    expect(crashSwitch()).toHaveAttribute('aria-pressed', 'true')
    expect(usageSwitch()).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(usageSwitch()).toHaveAttribute('aria-pressed', 'true'))
    expect(crashSwitch()).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps the mirror when main can’t be asked', async () => {
    localStorage.setItem('termpolis.consent.version', '2')
    localStorage.setItem('termpolis.telemetry.usage', 'true')
    render(<PrivacySettings onOpenTokenSavings={() => {}} />)
    await act(async () => {})
    expect(usageSwitch()).toHaveAttribute('aria-pressed', 'true')
  })

  it('applies each tier live, sending only the tier that changed', async () => {
    const api = bridge()
    render(<PrivacySettings onOpenTokenSavings={() => {}} />)
    await act(async () => {})
    fireEvent.click(crashSwitch())
    expect(crashSwitch()).toHaveAttribute('aria-pressed', 'true')
    expect(api.telemetrySetConsent).toHaveBeenLastCalledWith({ crash: true })
    await waitFor(() => expect(localStorage.getItem('termpolis.telemetry.crash')).toBe('true'))

    fireEvent.click(usageSwitch())
    expect(api.telemetrySetConsent).toHaveBeenLastCalledWith({ usage: true })
    await waitFor(() => expect(usageSwitch()).toHaveAttribute('aria-pressed', 'true'))
    expect(crashSwitch()).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(crashSwitch())
    expect(api.telemetrySetConsent).toHaveBeenLastCalledWith({ crash: false })
    await waitFor(() => expect(localStorage.getItem('termpolis.telemetry.crash')).toBe('false'))
    expect(crashSwitch()).toHaveAttribute('aria-pressed', 'false')
  })

  it('falls back to both off when main refuses the change', async () => {
    bridge(view(false, true), {
      telemetrySetConsent: vi.fn(async () => ({ success: false, error: 'disk full' })),
    })
    render(<PrivacySettings onOpenTokenSavings={() => {}} />)
    await waitFor(() => expect(usageSwitch()).toHaveAttribute('aria-pressed', 'true'))
    fireEvent.click(crashSwitch())
    await waitFor(() => expect(crashSwitch()).toHaveAttribute('aria-pressed', 'false'))
    expect(usageSwitch()).toHaveAttribute('aria-pressed', 'false')
  })

  it('points to Token Savings for the compression proxy', () => {
    bridge()
    const onOpen = vi.fn()
    render(<PrivacySettings onOpenTokenSavings={onOpen} />)
    expect(screen.getByTestId('settings-privacy')).toHaveTextContent(/127\.0\.0\.1.*api\.anthropic\.com/)
    fireEvent.click(screen.getByTestId('settings-privacy-open-token-savings'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

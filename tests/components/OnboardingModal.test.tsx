import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OnboardingModal,
  hasSeenOnboarding,
  getTelemetryOptIn,
  resetOnboarding,
  TELEMETRY_KEY,
} from '../../src/renderer/src/components/Onboarding/OnboardingModal'

const SEEN_KEY = 'termpolis.onboarding.seen.v1'

beforeEach(() => {
  localStorage.clear()
})

/** Click Next three times to reach the final (telemetry + Get-started) step. */
function gotoFinalStep() {
  const next = screen.getAllByRole('button', { name: /Next/ })[0]
  fireEvent.click(next)
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
}

describe('hasSeenOnboarding', () => {
  it('returns false when flag is missing', () => {
    expect(hasSeenOnboarding()).toBe(false)
  })

  it('returns true when flag is set to "1"', () => {
    localStorage.setItem(SEEN_KEY, '1')
    expect(hasSeenOnboarding()).toBe(true)
  })

  it('returns false for any other value', () => {
    localStorage.setItem(SEEN_KEY, '0')
    expect(hasSeenOnboarding()).toBe(false)
  })
})

describe('resetOnboarding', () => {
  it('removes the seen flag so the tour can re-open', () => {
    localStorage.setItem(SEEN_KEY, '1')
    expect(hasSeenOnboarding()).toBe(true)
    resetOnboarding()
    expect(hasSeenOnboarding()).toBe(false)
  })
})

describe('getTelemetryOptIn', () => {
  it('returns false by default', () => {
    expect(getTelemetryOptIn()).toBe(false)
  })

  it('returns true when user opted in', () => {
    localStorage.setItem(TELEMETRY_KEY, '1')
    expect(getTelemetryOptIn()).toBe(true)
  })

  it('returns false when user opted out', () => {
    localStorage.setItem(TELEMETRY_KEY, '0')
    expect(getTelemetryOptIn()).toBe(false)
  })
})

describe('OnboardingModal', () => {
  it('renders the welcome heading', () => {
    render(<OnboardingModal onDone={() => {}} />)
    expect(screen.getByText('Welcome to Termpolis')).toBeInTheDocument()
  })

  it('starts on step 1 with the step indicator visible', () => {
    render(<OnboardingModal onDone={() => {}} />)
    expect(screen.getByLabelText('Step 1 of 4')).toBeInTheDocument()
  })

  it('mentions the Ctrl+K command palette shortcut on step 1', () => {
    render(<OnboardingModal onDone={() => {}} />)
    expect(screen.getByText(/Ctrl\+K/)).toBeInTheDocument()
  })

  it('Next advances to step 2 (API keys)', () => {
    render(<OnboardingModal onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByText(/Set an API key/i)).toBeInTheDocument()
    expect(screen.getByText('ANTHROPIC_API_KEY')).toBeInTheDocument()
  })

  it('Back from step 2 returns to step 1', () => {
    render(<OnboardingModal onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByLabelText('Step 1 of 4')).toBeInTheDocument()
  })

  it('renders the Get started button only on the final step', () => {
    render(<OnboardingModal onDone={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Get started' })).not.toBeInTheDocument()
    gotoFinalStep()
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument()
  })

  it('progress dots are clickable to jump to a step', () => {
    render(<OnboardingModal onDone={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Go to step 4' }))
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument()
  })

  it('defaults telemetry checkbox to checked on first run', () => {
    render(<OnboardingModal onDone={() => {}} />)
    gotoFinalStep()
    const cb = screen.getByRole('checkbox', { name: /Send anonymous crash reports/i })
    expect((cb as HTMLInputElement).checked).toBe(true)
  })

  it('respects a previously-stored telemetry opt-out', () => {
    localStorage.setItem(TELEMETRY_KEY, '0')
    render(<OnboardingModal onDone={() => {}} />)
    gotoFinalStep()
    const cb = screen.getByRole('checkbox', { name: /Send anonymous crash reports/i })
    expect((cb as HTMLInputElement).checked).toBe(false)
  })

  it('respects a previously-stored telemetry opt-in', () => {
    localStorage.setItem(TELEMETRY_KEY, '1')
    render(<OnboardingModal onDone={() => {}} />)
    gotoFinalStep()
    const cb = screen.getByRole('checkbox', { name: /Send anonymous crash reports/i })
    expect((cb as HTMLInputElement).checked).toBe(true)
  })

  it('toggles the checkbox on click', () => {
    render(<OnboardingModal onDone={() => {}} />)
    gotoFinalStep()
    const cb = screen.getByRole('checkbox', { name: /Send anonymous crash reports/i }) as HTMLInputElement
    expect(cb.checked).toBe(true)
    fireEvent.click(cb)
    expect(cb.checked).toBe(false)
  })

  it('persists seen flag and telemetry=1 on finish when opted in', () => {
    const onDone = vi.fn()
    render(<OnboardingModal onDone={onDone} />)
    gotoFinalStep()
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    expect(localStorage.getItem(SEEN_KEY)).toBe('1')
    expect(localStorage.getItem(TELEMETRY_KEY)).toBe('1')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('persists telemetry=0 on finish when opted out', () => {
    const onDone = vi.fn()
    render(<OnboardingModal onDone={onDone} />)
    gotoFinalStep()
    fireEvent.click(screen.getByRole('checkbox', { name: /Send anonymous crash reports/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    expect(localStorage.getItem(TELEMETRY_KEY)).toBe('0')
    expect(onDone).toHaveBeenCalled()
  })

  it('Skip tour persists seen flag and calls onDone', () => {
    const onDone = vi.fn()
    render(<OnboardingModal onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: /Skip the tour/ }))
    expect(localStorage.getItem(SEEN_KEY)).toBe('1')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('mirrors opt-in choice to main process via setTelemetryOptIn IPC', () => {
    const setTelemetryOptIn = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).termpolis = { setTelemetryOptIn }
    render(<OnboardingModal onDone={() => {}} />)
    gotoFinalStep()
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    expect(setTelemetryOptIn).toHaveBeenCalledWith(true)
    delete (window as any).termpolis
  })

  it('mirrors opt-out choice to main process', () => {
    const setTelemetryOptIn = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).termpolis = { setTelemetryOptIn }
    render(<OnboardingModal onDone={() => {}} />)
    gotoFinalStep()
    fireEvent.click(screen.getByRole('checkbox', { name: /Send anonymous crash reports/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    expect(setTelemetryOptIn).toHaveBeenCalledWith(false)
    delete (window as any).termpolis
  })

  it('does not throw when window.termpolis bridge is missing', () => {
    delete (window as any).termpolis
    const onDone = vi.fn()
    expect(() => {
      render(<OnboardingModal onDone={onDone} />)
      gotoFinalStep()
      fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    }).not.toThrow()
    expect(onDone).toHaveBeenCalled()
  })

  it('links to the privacy policy, terms, and license on the final step', () => {
    render(<OnboardingModal onDone={() => {}} />)
    gotoFinalStep()
    const privacy = screen.getByText('Privacy policy').closest('a')
    const terms = screen.getByText('Terms of use').closest('a')
    const license = screen.getByText('License').closest('a')
    expect(privacy).toHaveAttribute('href', expect.stringContaining('PRIVACY.md'))
    expect(terms).toHaveAttribute('href', expect.stringContaining('TERMS.md'))
    expect(license).toHaveAttribute('href', expect.stringContaining('LICENSE'))
  })
})

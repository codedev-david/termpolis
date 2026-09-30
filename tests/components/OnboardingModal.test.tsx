import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentIntegrationStatus } from '../../src/shared/agentIntegration'

// Saving a choice starts or stops renderer Sentry; keep the real SDK out of it.
vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  getClient: vi.fn(() => undefined),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}))

import {
  OnboardingModal,
  hasSeenOnboarding,
  resetOnboarding,
} from '../../src/renderer/src/components/Onboarding/OnboardingModal'

const SEEN_KEY = 'termpolis.onboarding.seen.v1'

/** An agent-integration status; by default there is no answer on record. */
function agentStatus(over: Partial<AgentIntegrationStatus> = {}): AgentIntegrationStatus {
  return {
    consent: null,
    legacyDetected: false,
    connected: false,
    primerHook: true,
    agents: {
      claude: { installed: true, configPath: '/home/me/.claude/settings.json', registered: false },
      codex: { installed: false, configPath: '/home/me/.codex/config.toml', registered: false },
      gemini: { installed: false, configPath: '/home/me/.gemini/settings.json', registered: false },
    },
    autoAllowedTools: [],
    trustedFolders: [],
    codexHomeTrusted: false,
    ...over,
  }
}

function bridge(over: Record<string, unknown> = {}) {
  const api = {
    telemetrySetConsent: vi.fn(async (c: { crash?: boolean; usage?: boolean }) => ({
      success: true,
      data: { crash: c.crash === true, usage: c.usage === true, consentVersion: 2, needsReview: false },
    })),
    tokenSavingsGetSettings: vi.fn(async () => ({ success: true, data: { wireProxy: true } })),
    tokenSavingsSetSettings: vi.fn(async (p: { wireProxy: boolean }) => ({ success: true, data: { wireProxy: p.wireProxy } })),
    agentIntegrationStatus: vi.fn(async () => ({ success: true, data: agentStatus() })),
    agentIntegrationSet: vi.fn(async (req: { connect: boolean; primerHook?: boolean }) => ({
      success: true,
      data: { status: agentStatus({ consent: req.connect ? 'granted' : 'declined', connected: req.connect }), changes: [] },
    })),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

/** Answers main has on record, as the status call returns them. */
const onRecord = (over: Partial<AgentIntegrationStatus>) =>
  vi.fn(async () => ({ success: true, data: agentStatus(over) }))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

/** Let every pending promise (the status read, the save after closing) run its course. */
const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as any).termpolis
  localStorage.clear()
})

/** Click Next five times to reach the final (privacy + Get-started) step. */
function gotoFinalStep() {
  for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: /Next/ }))
}

const skip = () => fireEvent.click(screen.getByRole('button', { name: /Skip the tour/ }))
const crashBox = () => screen.getByRole('checkbox', { name: 'Send crash reports' }) as HTMLInputElement
const usageBox = () => screen.getByRole('checkbox', { name: 'Send anonymous usage statistics' }) as HTMLInputElement
const connectBox = () => screen.getByTestId('agent-connect-toggle') as HTMLInputElement
const hookBox = () => screen.getByTestId('agent-primer-hook-toggle') as HTMLInputElement

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

  it('returns false when storage is unreadable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
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

  it('does not throw when storage is unwritable', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => resetOnboarding()).not.toThrow()
  })
})

describe('OnboardingModal', () => {
  it('renders the welcome heading', () => {
    render(<OnboardingModal onDone={() => {}} />)
    expect(screen.getByText('Welcome to Termpolis')).toBeInTheDocument()
  })

  it('starts on step 1 of 6 with the step indicator visible', () => {
    render(<OnboardingModal onDone={() => {}} />)
    expect(screen.getByLabelText('Step 1 of 6')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(6)
  })

  it('opens on the agent step', () => {
    render(<OnboardingModal onDone={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Connect your coding agents' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-writes-list')).toBeInTheDocument()
    expect(screen.queryByText(/Ctrl\+K/)).not.toBeInTheDocument()
  })

  it('mentions the Ctrl+K command palette shortcut on step 2', () => {
    render(<OnboardingModal onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByRole('heading', { name: 'What Termpolis is' })).toBeInTheDocument()
    expect(screen.getByText(/Ctrl\+K/)).toBeInTheDocument()
  })

  it('says truthfully on step 2 what Termpolis itself sends', () => {
    render(<OnboardingModal onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByText(/only checks\s+GitHub for updates/)).toBeInTheDocument()
    expect(screen.getByText(/stay off unless you turn them on/)).toBeInTheDocument()
    expect(screen.queryByText(/no telemetry by default/)).not.toBeInTheDocument()
  })

  it('Next advances to step 3 (API keys)', () => {
    render(<OnboardingModal onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByText(/Set an API key/i)).toBeInTheDocument()
    expect(screen.getByText('ANTHROPIC_API_KEY')).toBeInTheDocument()
  })

  it('step 3 lists only the three US agent providers (no Alibaba / DashScope)', () => {
    render(<OnboardingModal onDone={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Go to step 3' }))
    expect(screen.getByText('ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('OPENAI_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('GEMINI_API_KEY')).toBeInTheDocument()
    // Qwen Code was removed — its Alibaba DashScope key must not appear.
    expect(screen.queryByText('DASHSCOPE_API_KEY')).not.toBeInTheDocument()
    expect(screen.queryByText(/Alibaba/i)).not.toBeInTheDocument()
  })

  it('Back from step 2 returns to the agent step', () => {
    render(<OnboardingModal onDone={() => {}} />)
    expect(screen.queryByRole('button', { name: /Back/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByLabelText('Step 1 of 6')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Connect your coding agents' })).toBeInTheDocument()
  })

  it('step 5 points to the Security Center', () => {
    render(<OnboardingModal onDone={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Go to step 5' }))
    expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument()
    expect(screen.getByText(/AI Security Center/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('renders the Get started button only on the final step', () => {
    render(<OnboardingModal onDone={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Get started' })).not.toBeInTheDocument()
    gotoFinalStep()
    expect(screen.getByLabelText('Step 6 of 6')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Next/ })).not.toBeInTheDocument()
  })

  it('progress dots are clickable to jump to a step', () => {
    render(<OnboardingModal onDone={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Go to step 6' }))
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Go to step 6' })).toHaveAttribute('aria-selected', 'true')
  })

  describe('privacy step', () => {
    it('shows both tiers unchecked on a first run, with the proxy and the slot', () => {
      render(<OnboardingModal onDone={() => {}} />)
      gotoFinalStep()
      expect(screen.getByRole('heading', { name: 'Your privacy choices' })).toBeInTheDocument()
      expect(crashBox().checked).toBe(false)
      expect(usageBox().checked).toBe(false)
      expect(screen.getByTestId('privacy-proxy')).toBeInTheDocument()
      expect(screen.getByTestId('onboarding-agent-integrations-slot')).toBeInTheDocument()
    })

    it('ignores the pre-v2 opt-in, so a legacy yes does not pre-tick anything', () => {
      localStorage.setItem('termpolis.telemetry.optIn', '1')
      render(<OnboardingModal onDone={() => {}} />)
      gotoFinalStep()
      expect(crashBox().checked).toBe(false)
      expect(usageBox().checked).toBe(false)
    })

    it('shows the choices already made when the tour is re-run', () => {
      localStorage.setItem('termpolis.consent.version', '2')
      localStorage.setItem('termpolis.telemetry.crash', 'true')
      localStorage.setItem('termpolis.telemetry.usage', 'false')
      render(<OnboardingModal onDone={() => {}} />)
      gotoFinalStep()
      expect(crashBox().checked).toBe(true)
      expect(usageBox().checked).toBe(false)
    })

    it('toggles each checkbox on click', () => {
      render(<OnboardingModal onDone={() => {}} />)
      gotoFinalStep()
      fireEvent.click(crashBox())
      expect(crashBox().checked).toBe(true)
      fireEvent.click(usageBox())
      expect(usageBox().checked).toBe(true)
      fireEvent.click(crashBox())
      expect(crashBox().checked).toBe(false)
    })

    it('links to the privacy policy, terms, and license', () => {
      render(<OnboardingModal onDone={() => {}} />)
      gotoFinalStep()
      const privacy = screen.getByText('Privacy policy').closest('a')
      const terms = screen.getByText('Terms of use').closest('a')
      const license = screen.getByText('License').closest('a')
      expect(privacy).toHaveAttribute('href', expect.stringContaining('PRIVACY.md'))
      expect(terms).toHaveAttribute('href', expect.stringContaining('TERMS.md'))
      expect(license).toHaveAttribute('href', expect.stringContaining('LICENSE'))
    })

    it('drives the proxy switch from Token Savings settings', async () => {
      const api = bridge()
      render(<OnboardingModal onDone={() => {}} />)
      gotoFinalStep()
      const sw = screen.getByTestId('privacy-proxy-toggle') as HTMLInputElement
      await waitFor(() => expect(sw.disabled).toBe(false))
      fireEvent.click(sw)
      await waitFor(() => expect(sw.checked).toBe(false))
      expect(api.tokenSavingsSetSettings).toHaveBeenCalledWith({ wireProxy: false })
    })
  })

  describe('agent step', () => {
    it('connects with the hook on when there is no answer on record', async () => {
      // Main's own view of an unanswered install is not what the step offers.
      bridge({ agentIntegrationStatus: onRecord({ consent: null, connected: false, primerHook: false }) })
      render(<OnboardingModal onDone={() => {}} />)
      expect(connectBox().checked).toBe(true)
      expect(hookBox().checked).toBe(true)
      await settle()
      expect(connectBox().checked).toBe(true)
      expect(hookBox().checked).toBe(true)
      expect(hookBox()).toBeEnabled()
    })

    it('sends the choice shown when there is no answer on record, even for a legacy install', async () => {
      const api = bridge({ agentIntegrationStatus: onRecord({ legacyDetected: true, connected: true, primerHook: false }) })
      const onDone = vi.fn()
      render(<OnboardingModal onDone={onDone} />)
      await settle()
      skip()
      expect(onDone).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: true, primerHook: true }))
      await settle()
      expect(api.agentIntegrationSet).toHaveBeenCalledTimes(1)
    })

    it('sends the ticks as edited, from Get started', async () => {
      const api = bridge()
      render(<OnboardingModal onDone={() => {}} />)
      fireEvent.click(hookBox())
      expect(hookBox().checked).toBe(false)
      gotoFinalStep()
      fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
      await waitFor(() => expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: true, primerHook: false }))
    })

    it('greys out the hook when not connecting, and sends the disconnect', async () => {
      const api = bridge()
      render(<OnboardingModal onDone={() => {}} />)
      fireEvent.click(connectBox())
      expect(connectBox().checked).toBe(false)
      expect(hookBox()).toBeDisabled()
      skip()
      await waitFor(() => expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: false, primerHook: true }))
    })

    it('sends the choice shown when main cannot say what is on record', async () => {
      const refused = bridge({ agentIntegrationStatus: vi.fn(async () => ({ success: false, error: 'boom' })) })
      const first = render(<OnboardingModal onDone={() => {}} />)
      skip()
      await waitFor(() => expect(refused.agentIntegrationSet).toHaveBeenCalledWith({ connect: true, primerHook: true }))
      first.unmount()

      const thrown = bridge({ agentIntegrationStatus: vi.fn(async () => { throw new Error('ipc gone') }) })
      render(<OnboardingModal onDone={() => {}} />)
      skip()
      await waitFor(() => expect(thrown.agentIntegrationSet).toHaveBeenCalledWith({ connect: true, primerHook: true }))
    })

    it('shows the answer on record, and sends nothing when it is left alone', async () => {
      const api = bridge({ agentIntegrationStatus: onRecord({ consent: 'declined', connected: false, primerHook: false }) })
      render(<OnboardingModal onDone={() => {}} />)
      await waitFor(() => expect(connectBox().checked).toBe(false))
      expect(hookBox().checked).toBe(false)
      expect(hookBox()).toBeDisabled()
      skip()
      await settle()
      expect(api.agentIntegrationSet).not.toHaveBeenCalled()
    })

    it('sends nothing when the edits end where the answer on record is', async () => {
      const api = bridge({ agentIntegrationStatus: onRecord({ consent: 'granted', connected: true, primerHook: false }) })
      render(<OnboardingModal onDone={() => {}} />)
      await waitFor(() => expect(hookBox().checked).toBe(false))
      fireEvent.click(connectBox())
      fireEvent.click(connectBox())
      skip()
      await settle()
      expect(api.agentIntegrationSet).not.toHaveBeenCalled()
    })

    it('sends a changed connection', async () => {
      const api = bridge({ agentIntegrationStatus: onRecord({ consent: 'granted', connected: true, primerHook: false }) })
      render(<OnboardingModal onDone={() => {}} />)
      await waitFor(() => expect(hookBox().checked).toBe(false))
      fireEvent.click(connectBox())
      skip()
      await waitFor(() => expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: false, primerHook: false }))
    })

    it('sends a changed hook while connected', async () => {
      const api = bridge({ agentIntegrationStatus: onRecord({ consent: 'granted', connected: true, primerHook: false }) })
      render(<OnboardingModal onDone={() => {}} />)
      await waitFor(() => expect(hookBox().checked).toBe(false))
      fireEvent.click(hookBox())
      skip()
      await waitFor(() => expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: true, primerHook: true }))
    })

    it('does not count a hook tick as a change while staying disconnected', async () => {
      const api = bridge({ agentIntegrationStatus: onRecord({ consent: 'declined', connected: false, primerHook: true }) })
      render(<OnboardingModal onDone={() => {}} />)
      await waitFor(() => expect(connectBox().checked).toBe(false))
      fireEvent.click(connectBox())
      fireEvent.click(hookBox())
      fireEvent.click(connectBox())
      expect(hookBox().checked).toBe(false)
      skip()
      await settle()
      expect(api.agentIntegrationSet).not.toHaveBeenCalled()
    })

    it("never lets a late answer from main overwrite the user's ticks", async () => {
      const pending = deferred<unknown>()
      const api = bridge({ agentIntegrationStatus: vi.fn(() => pending.promise) })
      render(<OnboardingModal onDone={() => {}} />)
      fireEvent.click(connectBox())
      await act(async () => { pending.resolve({ success: true, data: agentStatus({ consent: 'granted', connected: true, primerHook: true }) }) })
      await settle()
      expect(connectBox().checked).toBe(false)
      skip()
      await waitFor(() => expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: false, primerHook: true }))
    })

    it('closing before main answers waits for it, and an untouched step never overrides the answer on record', async () => {
      const pending = deferred<unknown>()
      const api = bridge({ agentIntegrationStatus: vi.fn(() => pending.promise) })
      const onDone = vi.fn()
      render(<OnboardingModal onDone={onDone} />)
      skip()
      expect(onDone).toHaveBeenCalledTimes(1)
      await settle()
      expect(api.agentIntegrationSet).not.toHaveBeenCalled()
      await act(async () => { pending.resolve({ success: true, data: agentStatus({ consent: 'declined', connected: false }) }) })
      await settle()
      expect(api.agentIntegrationSet).not.toHaveBeenCalled()
    })

    it('closing before main answers sends the choice shown when main has no answer either', async () => {
      const pending = deferred<unknown>()
      const api = bridge({ agentIntegrationStatus: vi.fn(() => pending.promise) })
      render(<OnboardingModal onDone={() => {}} />)
      skip()
      await settle()
      expect(api.agentIntegrationSet).not.toHaveBeenCalled()
      await act(async () => { pending.resolve({ success: true, data: agentStatus() }) })
      await waitFor(() => expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: true, primerHook: true }))
    })

    it('closes even when main refuses or fails to save the agent choice', async () => {
      const refused = bridge({ agentIntegrationSet: vi.fn(async () => ({ success: false, error: 'locked' })) })
      const onDone = vi.fn()
      const first = render(<OnboardingModal onDone={onDone} />)
      skip()
      expect(onDone).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(refused.agentIntegrationSet).toHaveBeenCalledTimes(1))
      first.unmount()

      // A rejected save must not surface as an unhandled rejection.
      const thrown = bridge({ agentIntegrationSet: vi.fn(async () => { throw new Error('ipc gone') }) })
      render(<OnboardingModal onDone={onDone} />)
      skip()
      expect(onDone).toHaveBeenCalledTimes(2)
      await waitFor(() => expect(thrown.agentIntegrationSet).toHaveBeenCalledTimes(1))
      await settle()
    })
  })

  describe('leaving the tour', () => {
    it('Get started saves the values shown, marks the tour seen and calls onDone', async () => {
      const api = bridge()
      const onDone = vi.fn()
      render(<OnboardingModal onDone={onDone} />)
      gotoFinalStep()
      fireEvent.click(crashBox())
      fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
      expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: true, usage: false })
      expect(localStorage.getItem(SEEN_KEY)).toBe('1')
      expect(onDone).toHaveBeenCalledTimes(1)
      // Main's answer is mirrored for renderer Sentry.
      await waitFor(() => expect(localStorage.getItem('termpolis.telemetry.crash')).toBe('true'))
      expect(localStorage.getItem('termpolis.consent.version')).toBe('2')
    })

    it('Get started with nothing ticked saves both tiers off', () => {
      const api = bridge()
      render(<OnboardingModal onDone={() => {}} />)
      gotoFinalStep()
      fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
      expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: false, usage: false })
    })

    it('Skip tour closes at once from the first step, saving the values shown', () => {
      const api = bridge()
      const onDone = vi.fn()
      render(<OnboardingModal onDone={onDone} />)
      skip()
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: false, usage: false })
      expect(localStorage.getItem(SEEN_KEY)).toBe('1')
      expect(screen.queryByRole('heading', { name: 'Your privacy choices' })).not.toBeInTheDocument()
    })

    it('Skip tour closes at once from a middle step too', () => {
      const api = bridge()
      const onDone = vi.fn()
      render(<OnboardingModal onDone={onDone} />)
      fireEvent.click(screen.getByRole('tab', { name: 'Go to step 3' }))
      skip()
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: false, usage: false })
      expect(localStorage.getItem(SEEN_KEY)).toBe('1')
    })

    it('Skip tour on a re-run keeps the privacy choices already made', () => {
      localStorage.setItem('termpolis.consent.version', '2')
      localStorage.setItem('termpolis.telemetry.crash', 'true')
      localStorage.setItem('termpolis.telemetry.usage', 'false')
      const api = bridge()
      render(<OnboardingModal onDone={() => {}} />)
      skip()
      expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: true, usage: false })
    })

    it('Skip tour on the privacy step saves the values shown and closes', () => {
      const api = bridge()
      const onDone = vi.fn()
      render(<OnboardingModal onDone={onDone} />)
      gotoFinalStep()
      fireEvent.click(usageBox())
      skip()
      expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: false, usage: true })
      expect(localStorage.getItem(SEEN_KEY)).toBe('1')
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    it('Escape works like Skip tour: closes at once from any step with the values shown', async () => {
      const api = bridge()
      const onDone = vi.fn()
      render(<OnboardingModal onDone={onDone} />)
      fireEvent.click(connectBox())
      fireEvent.click(screen.getByRole('button', { name: /Next/ }))
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(screen.getByLabelText('Step 2 of 6')).toBeInTheDocument()
      expect(onDone).not.toHaveBeenCalled()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: false, usage: false })
      expect(localStorage.getItem(SEEN_KEY)).toBe('1')
      await waitFor(() => expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: false, primerHook: true }))
    })

    it('Escape on the privacy step saves the ticks shown', () => {
      const api = bridge()
      const onDone = vi.fn()
      render(<OnboardingModal onDone={onDone} />)
      gotoFinalStep()
      fireEvent.click(crashBox())
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(api.telemetrySetConsent).toHaveBeenCalledWith({ crash: true, usage: false })
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    it('stops listening for Escape once unmounted', () => {
      const onDone = vi.fn()
      const { unmount } = render(<OnboardingModal onDone={onDone} />)
      fireEvent.click(screen.getByRole('tab', { name: 'Go to step 6' }))
      unmount()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onDone).not.toHaveBeenCalled()
    })

    it('still closes, with both tiers off in the mirror, when the bridge is missing', async () => {
      const onDone = vi.fn()
      localStorage.setItem('termpolis.telemetry.optIn', '1')
      render(<OnboardingModal onDone={onDone} />)
      gotoFinalStep()
      expect((screen.getByTestId('privacy-proxy-toggle') as HTMLInputElement).disabled).toBe(true)
      fireEvent.click(crashBox())
      expect(() => fireEvent.click(screen.getByRole('button', { name: 'Get started' }))).not.toThrow()
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem(SEEN_KEY)).toBe('1')
      // Main never heard the answer, so the renderer must not act on it.
      await waitFor(() => expect(localStorage.getItem('termpolis.telemetry.crash')).toBe('false'))
      expect(localStorage.getItem('termpolis.telemetry.optIn')).toBeNull()
      await settle()
    })

    it('still calls onDone when the seen flag cannot be stored', async () => {
      bridge()
      const onDone = vi.fn()
      render(<OnboardingModal onDone={onDone} />)
      gotoFinalStep()
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Get started' })) })
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })
})

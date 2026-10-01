import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AgentIntegrationStatus } from '../../src/shared/agentIntegration'
import {
  AgentReviewModal,
  agentReviewNeeded,
  noteAgentAnswerSaved,
} from '../../src/renderer/src/components/AgentIntegration/AgentReviewModal'

function status(over: Partial<AgentIntegrationStatus> = {}): AgentIntegrationStatus {
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
    agentIntegrationStatus: vi.fn(async () => ({ success: true, data: status() })),
    agentIntegrationSet: vi.fn(async () => ({ success: true, data: { status: status(), changes: [] } })),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const connectButton = () => screen.getByTestId('agent-review-connect') as HTMLButtonElement
const disconnectButton = () => screen.getByTestId('agent-review-disconnect') as HTMLButtonElement
const hookBox = () => screen.getByTestId('agent-review-primer-hook') as HTMLInputElement

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as any).termpolis
  localStorage.clear()
})

describe('agentReviewNeeded', () => {
  const needed = async (s: AgentIntegrationStatus, seen: boolean) => {
    bridge({ agentIntegrationStatus: vi.fn(async () => ({ success: true, data: s })) })
    return agentReviewNeeded(seen)
  }

  it('asks an upgrade from a version that wrote agent configs without asking', async () => {
    const s = status({ legacyDetected: true, connected: true })
    expect(await needed(s, false)).toBe(s)
    expect(await needed(s, true)).toBe(s)
  })

  it('asks someone who saw a tour that had no agent step', async () => {
    const s = status()
    expect(await needed(s, true)).toBe(s)
  })

  it('asks no one else', async () => {
    expect(await needed(status(), false)).toBeNull()
  })

  it('never asks again once there is an answer on record', async () => {
    expect(await needed(status({ consent: 'granted', legacyDetected: true, connected: true }), true)).toBeNull()
    expect(await needed(status({ consent: 'declined' }), true)).toBeNull()
  })

  it('asks nothing when main cannot say', async () => {
    bridge({ agentIntegrationStatus: vi.fn(async () => ({ success: false, error: 'boom' })) })
    expect(await agentReviewNeeded(true)).toBeNull()
    bridge({ agentIntegrationStatus: vi.fn(async () => { throw new Error('ipc gone') }) })
    expect(await agentReviewNeeded(true)).toBeNull()
    delete (window as any).termpolis
    expect(await agentReviewNeeded(true)).toBeNull()
  })

  it('asks again, over any answer on record, after one main could not save, until one is saved', async () => {
    const granted = status({ consent: 'granted', connected: true })
    const declined = status({ consent: 'declined' })
    noteAgentAnswerSaved(false)
    expect(await needed(granted, true)).toBe(granted)
    expect(await needed(declined, false)).toBe(declined)
    noteAgentAnswerSaved(true)
    expect(await needed(granted, true)).toBeNull()
    expect(await needed(declined, false)).toBeNull()
  })

  it('counts storage it cannot use as nothing unsaved, and never throws noting it', async () => {
    noteAgentAnswerSaved(false)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => noteAgentAnswerSaved(false)).not.toThrow()
    expect(() => noteAgentAnswerSaved(true)).not.toThrow()
    expect(await needed(status({ consent: 'granted', connected: true }), true)).toBeNull()
  })
})

describe('AgentReviewModal', () => {
  it('is a labelled modal dialog', () => {
    bridge()
    render(<AgentReviewModal status={status()} onDone={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Termpolis and your coding agents' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'agent-review-title')
    expect(dialog).toHaveTextContent('Asked once. Change it any time in Settings ▸ Agent Integration.')
    // The list shows what is installed on this machine.
    expect(screen.getByTestId('agent-writes-claude-installed')).toHaveTextContent('Installed')
    expect(screen.getByTestId('agent-writes-claude-path').textContent).toBe('~/.claude/settings.json')
  })

  it('tells a legacy install what earlier versions did, and offers to keep or undo it', () => {
    bridge()
    render(<AgentReviewModal status={status({ legacyDetected: true, connected: true })} onDone={vi.fn()} />)
    expect(screen.getByTestId('agent-review-legacy')).toHaveTextContent('Earlier versions changed Claude Code, Codex and Gemini CLI settings without asking.')
    expect(screen.queryByTestId('agent-review-intro')).toBeNull()
    expect(connectButton()).toHaveTextContent('Keep connected')
    expect(disconnectButton()).toHaveTextContent('Disconnect')
  })

  it('offers to keep or undo a connection that is already in place', () => {
    bridge()
    render(<AgentReviewModal status={status({ connected: true })} onDone={vi.fn()} />)
    expect(screen.getByTestId('agent-review-intro')).toBeInTheDocument()
    expect(connectButton()).toHaveTextContent('Keep connected')
    expect(disconnectButton()).toHaveTextContent('Disconnect')
  })

  it('offers to connect someone who is not connected', () => {
    bridge()
    render(<AgentReviewModal status={status()} onDone={vi.fn()} />)
    expect(screen.getByTestId('agent-review-intro')).toHaveTextContent('Connecting writes exactly the list below')
    expect(screen.queryByTestId('agent-review-legacy')).toBeNull()
    expect(connectButton()).toHaveTextContent('Connect')
    expect(disconnectButton()).toHaveTextContent('Not now')
  })

  it('starts the hook box from the status', () => {
    bridge()
    const { unmount } = render(<AgentReviewModal status={status({ primerHook: false })} onDone={vi.fn()} />)
    expect(hookBox().checked).toBe(false)
    unmount()
    render(<AgentReviewModal status={status({ primerHook: true })} onDone={vi.fn()} />)
    expect(hookBox().checked).toBe(true)
  })

  it('connects with the hook choice on screen, then closes', async () => {
    const api = bridge()
    const onDone = vi.fn()
    render(<AgentReviewModal status={status({ legacyDetected: true, connected: true })} onDone={onDone} />)
    fireEvent.click(hookBox())
    expect(hookBox().checked).toBe(false)
    fireEvent.click(connectButton())
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: true, primerHook: false })
  })

  it('disconnects without a hook choice, then closes', async () => {
    const api = bridge()
    const onDone = vi.fn()
    render(<AgentReviewModal status={status({ legacyDetected: true, connected: true })} onDone={onDone} />)
    fireEvent.click(disconnectButton())
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: false })
  })

  it('locks its controls while the answer is being saved', async () => {
    const pending = deferred<{ success: true; data: unknown }>()
    const api = bridge({ agentIntegrationSet: vi.fn(() => pending.promise) })
    const onDone = vi.fn()
    render(<AgentReviewModal status={status()} onDone={onDone} />)
    fireEvent.click(connectButton())
    await waitFor(() => expect(connectButton()).toBeDisabled())
    expect(disconnectButton()).toBeDisabled()
    expect(hookBox()).toBeDisabled()
    fireEvent.click(disconnectButton())
    expect(api.agentIntegrationSet).toHaveBeenCalledTimes(1)
    pending.resolve({ success: true, data: { status: status(), changes: [] } })
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('shows why an answer could not be saved and lets the user close or retry', async () => {
    const api = bridge({ agentIntegrationSet: vi.fn(async () => ({ success: false, error: 'settings.json is locked' })) })
    const onDone = vi.fn()
    render(<AgentReviewModal status={status()} onDone={onDone} />)
    fireEvent.click(disconnectButton())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't save your answer, so you'll be asked again next launch.")
    expect(alert).toHaveTextContent('settings.json is locked')
    expect(onDone).not.toHaveBeenCalled()
    // Still answerable: the buttons unlock again.
    expect(connectButton()).toBeEnabled()
    expect(disconnectButton()).toBeEnabled()
    // A second try clears the old error first.
    api.agentIntegrationSet.mockImplementationOnce(async () => ({ success: false, error: 'still locked' }))
    fireEvent.click(connectButton())
    await waitFor(() => expect(screen.getByTestId('agent-review-error')).toHaveTextContent('still locked'))
    expect(screen.getByTestId('agent-review-error')).not.toHaveTextContent('settings.json is locked')
    fireEvent.click(screen.getByTestId('agent-review-close'))
    expect(screen.getByTestId('agent-review-close')).toHaveTextContent('Close')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['connect', connectButton],
    ['disconnect', disconnectButton],
  ])('stays open when main took the %s answer but could not save it', async (_label, button) => {
    const saveError = 'EACCES: permission denied'
    bridge({ agentIntegrationSet: vi.fn(async () => ({ success: true, data: { status: status(), changes: [], saveError } })) })
    const onDone = vi.fn()
    render(<AgentReviewModal status={status({ legacyDetected: true, connected: true })} onDone={onDone} />)
    fireEvent.click(button())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't save your answer, so you'll be asked again next launch.")
    expect(alert).toHaveTextContent(saveError)
    expect(onDone).not.toHaveBeenCalled()
    expect(connectButton()).toBeEnabled()
    fireEvent.click(screen.getByTestId('agent-review-close'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('once an answer is saved, stops asking for one that was not', async () => {
    const granted = status({ consent: 'granted', connected: true })
    bridge({ agentIntegrationStatus: vi.fn(async () => ({ success: true, data: granted })) })
    noteAgentAnswerSaved(false)
    expect(await agentReviewNeeded(true)).toBe(granted)
    const onDone = vi.fn()
    render(<AgentReviewModal status={granted} onDone={onDone} />)
    fireEvent.click(connectButton())
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(await agentReviewNeeded(true)).toBeNull()
  })

  it('shows a thrown error, whatever was thrown', async () => {
    bridge({ agentIntegrationSet: vi.fn(async () => { throw new Error('ipc gone') }) })
    const { unmount } = render(<AgentReviewModal status={status()} onDone={vi.fn()} />)
    fireEvent.click(connectButton())
    expect(await screen.findByTestId('agent-review-error')).toHaveTextContent('ipc gone')
    unmount()
    bridge({ agentIntegrationSet: vi.fn(() => Promise.reject('plain string')) })
    render(<AgentReviewModal status={status()} onDone={vi.fn()} />)
    fireEvent.click(connectButton())
    expect(await screen.findByTestId('agent-review-error')).toHaveTextContent('plain string')
  })

  it('does not close on a click inside the dialog', () => {
    bridge()
    const onDone = vi.fn()
    render(<AgentReviewModal status={status()} onDone={onDone} />)
    fireEvent.click(screen.getByRole('dialog'))
    fireEvent.click(screen.getByTestId('agent-review-modal'))
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

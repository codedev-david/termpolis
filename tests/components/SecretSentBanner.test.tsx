import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SecretSentBanner } from '../../src/renderer/src/components/SecretSentBanner/SecretSentBanner'

type Hit = { rule: string; label: string; name?: string }
type Cb = (data: { id: string; hits: Hit[]; agent: string | null }) => void

let captured: Cb | null = null
let unsubSpy: () => void

beforeEach(() => {
  captured = null
  unsubSpy = vi.fn()
  ;(window as any).aiSecurity = {
    onSecretSent: (cb: Cb) => {
      captured = cb
      return unsubSpy
    },
  }
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  delete (window as any).aiSecurity
  vi.useRealTimers()
})

const text = () => screen.getByTestId('secret-sent-banner').textContent || ''

describe('SecretSentBanner', () => {
  it('renders nothing when no event has fired', () => {
    render(<SecretSentBanner />)
    expect(screen.queryByTestId('secret-sent-banner')).toBeNull()
  })

  it('renders when an event fires and shows hit count + labels', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({
        id: 't1',
        hits: [
          { rule: 'aws_access_key', label: 'AWS Access Key ID' },
          { rule: 'gh_pat', label: 'GitHub PAT (ghp/gho/ghu/ghs/ghr)' },
        ],
        agent: 'claude',
      })
    })
    expect(screen.getByTestId('secret-sent-banner')).toBeInTheDocument()
    expect(text()).toMatch(/2 secrets sent/)
    expect(text()).toMatch(/to claude/)
    expect(text()).toMatch(/AWS Access Key ID/)
    expect(text()).toMatch(/GitHub PAT/)
  })

  // The whole point of the rename. The old banner claimed credit for a save that never happened.
  it('never claims the secret was redacted, blocked or withheld', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT' }], agent: 'claude' })
    })
    expect(text()).not.toMatch(/redact|blocked|withheld|prevent|never received|caught/i)
  })

  it('tells you the secret is already gone and to rotate it', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT' }], agent: 'claude' })
    })
    expect(text()).toMatch(/already delivered/i)
    expect(text()).toMatch(/rotate it/i)
  })

  // Names are what you act on: you rotate DB_PASSWORD, not "a .env-style assignment".
  it('prefers the secret NAME over the rule label when one was captured', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({
        id: 't1',
        hits: [{ rule: 'env_secret', label: '.env-style SECRET/TOKEN/KEY assignment', name: 'DB_PASSWORD' }],
        agent: 'claude',
      })
    })
    expect(text()).toMatch(/DB_PASSWORD/)
    expect(text()).not.toMatch(/\.env-style/)
  })

  it('falls back to the label for a bare, nameless match', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'aws_access_key', label: 'AWS Access Key ID' }], agent: null })
    })
    expect(text()).toMatch(/AWS Access Key ID/)
  })

  it('mixes named and nameless hits, names first', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({
        id: 't1',
        hits: [
          { rule: 'aws_access_key', label: 'AWS Access Key ID' },
          { rule: 'env_secret', label: '.env-style assignment', name: 'STRIPE_KEY' },
        ],
        agent: null,
      })
    })
    expect(text()).toMatch(/STRIPE_KEY.*AWS Access Key ID/)
  })

  it('dedupes a name repeated across hits', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({
        id: 't1',
        hits: [
          { rule: 'env_secret', label: 'env', name: 'API_KEY' },
          { rule: 'json_secret', label: 'json', name: 'API_KEY' },
        ],
        agent: null,
      })
    })
    expect(text()).toMatch(/2 secrets sent/)
    expect(text()!.match(/API_KEY/g)!).toHaveLength(1)
  })

  it('uses singular "secret" for a single hit', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'openai_key', label: 'OpenAI API key' }], agent: null })
    })
    expect(text()).toMatch(/1 secret sent\b/)
  })

  it('summarizes more than 3 distinct rules', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({
        id: 't1',
        hits: [
          { rule: 'a', label: 'Rule A' },
          { rule: 'b', label: 'Rule B' },
          { rule: 'c', label: 'Rule C' },
          { rule: 'd', label: 'Rule D' },
        ],
        agent: null,
      })
    })
    expect(text()).toMatch(/\+1 more/)
  })

  it('omits "to <agent>" when agent is null', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT' }], agent: null })
    })
    expect(text()).not.toMatch(/ to /)
  })

  it('dismisses on close button click', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT' }], agent: null })
    })
    expect(screen.getByTestId('secret-sent-banner')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Dismiss secret-sent warning'))
    expect(screen.queryByTestId('secret-sent-banner')).toBeNull()
  })

  it('auto-dismisses after 12 seconds', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT' }], agent: null })
    })
    expect(screen.getByTestId('secret-sent-banner')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(8001) })
    expect(screen.queryByTestId('secret-sent-banner')).toBeInTheDocument() // a leak warning outlives the old 8s toast
    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByTestId('secret-sent-banner')).toBeNull()
  })

  it('replaces a stale banner when a new event fires', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT' }], agent: 'claude' })
    })
    act(() => { vi.advanceTimersByTime(4000) })
    act(() => {
      captured!({ id: 't2', hits: [{ rule: 'aws_access_key', label: 'AWS Access Key ID' }], agent: 'codex' })
    })
    // Still visible because the new event resets the timer.
    act(() => { vi.advanceTimersByTime(9000) })
    expect(text()).toMatch(/AWS Access Key ID/)
  })

  it('is an assertive alert, not a polite status — a leak is not an FYI', () => {
    render(<SecretSentBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT' }], agent: null })
    })
    const el = screen.getByTestId('secret-sent-banner')
    expect(el.getAttribute('role')).toBe('alert')
    expect(el.getAttribute('aria-live')).toBe('assertive')
  })

  it('handles a missing aiSecurity bridge gracefully', () => {
    delete (window as any).aiSecurity
    expect(() => render(<SecretSentBanner />)).not.toThrow()
    expect(screen.queryByTestId('secret-sent-banner')).toBeNull()
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<SecretSentBanner />)
    unmount()
    expect(unsubSpy).toHaveBeenCalled()
  })
})

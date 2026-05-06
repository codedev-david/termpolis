import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SecretsRedactedBanner } from '../../src/renderer/src/components/SecretsRedactedBanner/SecretsRedactedBanner'

type Cb = (data: { id: string; hits: { rule: string; label: string; sample: string }[]; agent: string | null }) => void

let captured: Cb | null = null
let unsubSpy: () => void

beforeEach(() => {
  captured = null
  unsubSpy = vi.fn()
  ;(window as any).aiSecurity = {
    onSecretsRedacted: (cb: Cb) => {
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

describe('SecretsRedactedBanner', () => {
  it('renders nothing when no event has fired', () => {
    render(<SecretsRedactedBanner />)
    expect(screen.queryByTestId('secrets-redacted-banner')).toBeNull()
  })

  it('renders when an event fires and shows hit count + labels', () => {
    render(<SecretsRedactedBanner />)
    act(() => {
      captured!({
        id: 't1',
        hits: [
          { rule: 'aws_access_key', label: 'AWS Access Key ID', sample: 'AKIA…AB' },
          { rule: 'gh_pat', label: 'GitHub PAT (ghp/gho/ghu/ghs/ghr)', sample: 'ghp_…CD' },
        ],
        agent: 'claude',
      })
    })
    const banner = screen.getByTestId('secrets-redacted-banner')
    expect(banner).toBeInTheDocument()
    expect(banner.textContent).toMatch(/redacted 2 secrets/)
    expect(banner.textContent).toMatch(/to claude/)
    expect(banner.textContent).toMatch(/AWS Access Key ID/)
    expect(banner.textContent).toMatch(/GitHub PAT/)
  })

  it('uses singular "secret" for a single hit', () => {
    render(<SecretsRedactedBanner />)
    act(() => {
      captured!({
        id: 't1',
        hits: [{ rule: 'openai_key', label: 'OpenAI API key', sample: 'sk-p…' }],
        agent: null,
      })
    })
    expect(screen.getByTestId('secrets-redacted-banner').textContent).toMatch(/redacted 1 secret\b/)
  })

  it('summarizes more than 3 distinct rules', () => {
    render(<SecretsRedactedBanner />)
    act(() => {
      captured!({
        id: 't1',
        hits: [
          { rule: 'a', label: 'Rule A', sample: 'a' },
          { rule: 'b', label: 'Rule B', sample: 'b' },
          { rule: 'c', label: 'Rule C', sample: 'c' },
          { rule: 'd', label: 'Rule D', sample: 'd' },
        ],
        agent: null,
      })
    })
    expect(screen.getByTestId('secrets-redacted-banner').textContent).toMatch(/\+1 more/)
  })

  it('omits "to <agent>" when agent is null', () => {
    render(<SecretsRedactedBanner />)
    act(() => {
      captured!({
        id: 't1',
        hits: [{ rule: 'jwt', label: 'JWT', sample: 'eyJ…' }],
        agent: null,
      })
    })
    expect(screen.getByTestId('secrets-redacted-banner').textContent || '').not.toMatch(/ to /)
  })

  it('dismisses on close button click', () => {
    render(<SecretsRedactedBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT', sample: 'eyJ…' }], agent: null })
    })
    expect(screen.getByTestId('secrets-redacted-banner')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Dismiss redaction banner'))
    expect(screen.queryByTestId('secrets-redacted-banner')).toBeNull()
  })

  it('auto-dismisses after 8 seconds', () => {
    render(<SecretsRedactedBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT', sample: 'eyJ…' }], agent: null })
    })
    expect(screen.getByTestId('secrets-redacted-banner')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(8001) })
    expect(screen.queryByTestId('secrets-redacted-banner')).toBeNull()
  })

  it('replaces a stale banner when a new event fires', () => {
    render(<SecretsRedactedBanner />)
    act(() => {
      captured!({ id: 't1', hits: [{ rule: 'jwt', label: 'JWT', sample: 'a' }], agent: 'claude' })
    })
    act(() => { vi.advanceTimersByTime(4000) })
    act(() => {
      captured!({ id: 't2', hits: [
        { rule: 'aws_access_key', label: 'AWS Access Key ID', sample: 'a' },
      ], agent: 'codex' })
    })
    // Still visible because the new event resets the timer.
    act(() => { vi.advanceTimersByTime(7000) })
    expect(screen.getByTestId('secrets-redacted-banner').textContent).toMatch(/AWS Access Key ID/)
  })

  it('handles a missing aiSecurity bridge gracefully', () => {
    delete (window as any).aiSecurity
    expect(() => render(<SecretsRedactedBanner />)).not.toThrow()
    expect(screen.queryByTestId('secrets-redacted-banner')).toBeNull()
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<SecretsRedactedBanner />)
    unmount()
    expect(unsubSpy).toHaveBeenCalled()
  })
})

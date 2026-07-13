import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ShieldScanFailedBanner } from '../../src/renderer/src/components/ShieldScanFailedBanner/ShieldScanFailedBanner'

// Fail-open is deliberate: a git or scanner error must never wedge your commit for a reason that has
// nothing to do with secrets. But fail-open must never be fail-SILENT. A security control whose
// failure is indistinguishable from success is worse than no control, because you go on believing
// you are protected — which is exactly what made the gpg-private watcher rule useless for so long.

type Cb = (data: { op: 'commit' | 'push'; cwd: string; error: string }) => void

let captured: Cb | null = null
let unsubSpy: () => void

beforeEach(() => {
  captured = null
  unsubSpy = vi.fn()
  ;(window as any).aiSecurity = {
    onShieldScanFailed: (cb: Cb) => {
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

const text = () => screen.getByTestId('shield-scan-failed-banner').textContent || ''

describe('ShieldScanFailedBanner', () => {
  it('renders nothing until the shield actually fails', () => {
    render(<ShieldScanFailedBanner />)
    expect(screen.queryByTestId('shield-scan-failed-banner')).toBeNull()
  })

  it('says plainly that the operation went through UNSCANNED', () => {
    render(<ShieldScanFailedBanner />)
    act(() => {
      captured!({ op: 'push', cwd: 'C:/repos/termpolis', error: 'stdout maxBuffer length exceeded' })
    })
    expect(text()).toMatch(/could not scan/i)
    expect(text()).toMatch(/allowed through unscanned/i)
    // The actionable part: it tells you what the consequence is.
    expect(text()).toMatch(/would not have been caught/i)
  })

  it('names the operation and the repository', () => {
    render(<ShieldScanFailedBanner />)
    act(() => {
      captured!({ op: 'commit', cwd: '/home/u/work/api-server', error: 'timed out' })
    })
    expect(text()).toMatch(/commit/)
    expect(text()).toMatch(/api-server/)
  })

  it('surfaces the underlying error so the failure is diagnosable, not just scary', () => {
    render(<ShieldScanFailedBanner />)
    act(() => {
      captured!({ op: 'push', cwd: '/x/y', error: 'stdout maxBuffer length exceeded' })
    })
    expect(text()).toMatch(/maxBuffer length exceeded/)
  })

  // The point of the whole component.
  it('NEVER claims the operation was clean or protected', () => {
    render(<ShieldScanFailedBanner />)
    act(() => {
      captured!({ op: 'push', cwd: '/x/y', error: 'boom' })
    })
    expect(text()).not.toMatch(/\bclean\b|\bprotected\b|\bsafe\b|no secrets found/i)
  })

  it('does NOT auto-dismiss — "your commit was not scanned" is not a toast', () => {
    render(<ShieldScanFailedBanner />)
    act(() => {
      captured!({ op: 'commit', cwd: '/x/y', error: 'boom' })
    })
    act(() => { vi.advanceTimersByTime(120_000) })
    // Still there two minutes later. The user has to actually see this and decide what to do.
    expect(screen.getByTestId('shield-scan-failed-banner')).toBeInTheDocument()
  })

  it('is an assertive alert — an unscanned push is not an FYI', () => {
    render(<ShieldScanFailedBanner />)
    act(() => {
      captured!({ op: 'push', cwd: '/x/y', error: 'boom' })
    })
    const el = screen.getByTestId('shield-scan-failed-banner')
    expect(el.getAttribute('role')).toBe('alert')
    expect(el.getAttribute('aria-live')).toBe('assertive')
  })

  it('can be dismissed by the user, but only by the user', () => {
    render(<ShieldScanFailedBanner />)
    act(() => {
      captured!({ op: 'push', cwd: '/x/y', error: 'boom' })
    })
    fireEvent.click(screen.getByLabelText('Dismiss shield warning'))
    expect(screen.queryByTestId('shield-scan-failed-banner')).toBeNull()
  })

  it('a cwd with no basename does not render a stray separator', () => {
    render(<ShieldScanFailedBanner />)
    act(() => {
      captured!({ op: 'push', cwd: '', error: 'boom' })
    })
    expect(text()).toMatch(/could not scan/i)
    expect(text()).not.toMatch(/ in \b\s*—/)
  })

  it('handles a missing bridge without exploding', () => {
    delete (window as any).aiSecurity
    expect(() => render(<ShieldScanFailedBanner />)).not.toThrow()
    expect(screen.queryByTestId('shield-scan-failed-banner')).toBeNull()
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<ShieldScanFailedBanner />)
    unmount()
    expect(unsubSpy).toHaveBeenCalled()
  })
})

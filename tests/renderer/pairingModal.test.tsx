// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PairingModal } from '../../src/renderer/src/components/SettingsPane/PairingModal'
import { buildQrPath } from '../../src/renderer/src/lib/qrPath'

/** Fixed clock: the countdown is the point of this component, and a real one
 *  makes "2:00" flake to "1:59" whenever the machine is busy. */
const NOW = 1_780_000_000_000

const offer = (over: Partial<{ qrPayload: string; expiresAt: number }> = {}) => ({
  qrPayload: JSON.stringify({ v: 2, pk: 'a'.repeat(64), room: 'b'.repeat(32), s: 'c'.repeat(64) }),
  expiresAt: NOW + 120_000,
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('buildQrPath', () => {
  it('encodes a payload as one path over a square module grid', () => {
    const built = buildQrPath('hello termpolis')
    expect(built).not.toBeNull()
    expect(built!.size).toBeGreaterThan(20)
    // Every module is four path commands; a grid this size cannot be blank.
    expect(built!.d).toMatch(/^M\d+ \d+h1v1h-1z/)
  })

  it('gives up rather than throwing when the payload outgrows version 40', () => {
    expect(buildQrPath('x'.repeat(4000))).toBeNull()
  })
})

describe('PairingModal', () => {
  it('draws the live offer and counts down', () => {
    render(<PairingModal pairing={offer()} awaiting={false} paired={null} onClose={() => {}} />)
    const path = screen.getByTestId('pairing-qr').querySelector('path')
    expect(path?.getAttribute('d')?.length ?? 0).toBeGreaterThan(200)
    expect(screen.getByTestId('pairing-countdown').textContent).toContain('2:00')
    expect(screen.queryByTestId('pairing-expired')).toBeNull()
  })

  it('ticks the countdown down and pads the seconds', () => {
    render(<PairingModal pairing={offer()} awaiting={false} paired={null} onClose={() => {}} />)
    act(() => { vi.advanceTimersByTime(61_000) })
    expect(screen.getByTestId('pairing-countdown').textContent).toContain('0:59')
    act(() => { vi.advanceTimersByTime(54_000) })
    expect(screen.getByTestId('pairing-countdown').textContent).toContain('0:05')
  })

  it('replaces the code with an explanation once it expires', () => {
    render(<PairingModal pairing={offer()} awaiting={false} paired={null} onClose={() => {}} />)
    act(() => { vi.advanceTimersByTime(121_000) })
    expect(screen.getByTestId('pairing-expired')).toBeTruthy()
    // A dead code is worse than none: scanning it just gets the phone refused.
    expect(screen.queryByTestId('pairing-qr')).toBeNull()
  })

  it('shows the expired state when there is no offer at all', () => {
    render(<PairingModal pairing={null} awaiting={false} paired={null} onClose={() => {}} />)
    expect(screen.getByTestId('pairing-expired')).toBeTruthy()
    expect(screen.queryByTestId('pairing-qr')).toBeNull()
  })

  it('falls back to the raw payload when the code cannot be drawn', () => {
    render(<PairingModal pairing={offer({ qrPayload: 'x'.repeat(4000) })} paired={null} onClose={() => {}} />)
    expect(screen.getByTestId('pairing-qr-fallback')).toBeTruthy()
    expect(screen.queryByTestId('pairing-qr')).toBeNull()
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'x'.repeat(4000))
  })

  it('shows the safety words to compare once a phone has paired', () => {
    render(
      <PairingModal
        pairing={offer()}
        paired={{ label: 'Pixel', phrase: 'anchor basil cobra delta' }}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('pairing-phrase').textContent).toBe('anchor basil cobra delta')
    expect(screen.getByTestId('pairing-paired').textContent).toContain('Pixel is paired')
    expect(screen.getByText(/Compare these words with the ones on your phone/)).toBeTruthy()
    // The offer is spent, so the code is gone even though it has not timed out.
    expect(screen.queryByTestId('pairing-qr')).toBeNull()
  })

  it('closes from the header and from the footer', () => {
    const onClose = vi.fn()
    render(<PairingModal pairing={offer()} awaiting={false} paired={null} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('pairing-close'))
    fireEvent.click(screen.getByTestId('pairing-dismiss'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('labels the footer Done once paired', () => {
    render(
      <PairingModal pairing={null} awaiting={false} paired={{ label: 'Pixel', phrase: 'a b c d' }} onClose={() => {}} />,
    )
    expect(screen.getByTestId('pairing-dismiss').textContent).toBe('Done')
  })
  it('says it is asking the desktop rather than claiming the code expired', () => {
    // Same null offer, opposite meaning. The bridge mints the code in a forked
    // child, so there is always a round trip between opening this dialog and
    // having something to draw -- and "this pairing code has expired" during
    // that gap sends the user back to the button that just worked.
    render(<PairingModal pairing={null} awaiting={true} paired={null} onClose={() => {}} />)

    expect(screen.getByTestId('pairing-waiting')).toBeTruthy()
    expect(screen.queryByTestId('pairing-expired')).toBeNull()
  })

  it('draws the code as soon as one exists, waiting flag or not', () => {
    render(<PairingModal pairing={offer()} awaiting={true} paired={null} onClose={() => {}} />)

    expect(screen.getByTestId('pairing-qr')).toBeTruthy()
    expect(screen.queryByTestId('pairing-waiting')).toBeNull()
  })

  it('shows the safety words even if a code request was still outstanding', () => {
    // The phone can answer an offer before the desktop's own status round trip
    // lands. Pairing succeeded; nothing here should still be asking for a code.
    render(
      <PairingModal
        pairing={null}
        awaiting={true}
        paired={{ label: 'Pixel', phrase: 'a b c d' }}
        onClose={() => {}}
      />,
    )

    expect(screen.getByTestId('pairing-paired')).toBeTruthy()
    expect(screen.queryByTestId('pairing-waiting')).toBeNull()
  })
})

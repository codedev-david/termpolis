import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SensitiveFileReadBanner,
  SENSITIVE_READ_NOTICE_MS,
} from '../../src/renderer/src/components/SensitiveFileReadBanner/SensitiveFileReadBanner'

type Ev = {
  id: string
  agent: string
  tool: string
  rule: string
  label: string
  filePath: string
  source: 'path' | 'command'
  ts: number
}

let captured: ((d: Ev) => void) | null = null
let unsubSpy: ReturnType<typeof vi.fn>

const ev = (over: Partial<Ev> = {}): Ev => ({
  id: 't1',
  agent: 'claude',
  tool: 'Read',
  rule: 'dotenv',
  label: 'Dotenv file',
  filePath: '/repo/.env',
  source: 'path',
  ts: 1,
  ...over,
})

beforeEach(() => {
  captured = null
  unsubSpy = vi.fn()
  ;(window as any).aiSecurity = {
    onSensitiveFileRead: (cb: (d: Ev) => void) => {
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

const text = () => screen.getByTestId('sensitive-file-read-banner').textContent || ''

describe('SensitiveFileReadBanner', () => {
  it('renders nothing until main reports a read', () => {
    render(<SensitiveFileReadBanner />)
    expect(screen.queryByTestId('sensitive-file-read-banner')).toBeNull()
  })

  it('names the agent, the rule label and the path when a read is reported', () => {
    render(<SensitiveFileReadBanner />)
    act(() => captured!(ev()))
    expect(text()).toMatch(/claude read a sensitive file: Dotenv file \(\/repo\/\.env\)/)
    expect(text()).toMatch(/ignore file/)
  })

  it('falls back to "An agent" and the bare label when agent or path is empty', () => {
    render(<SensitiveFileReadBanner />)
    act(() => captured!(ev({ agent: '', filePath: '' })))
    expect(text()).toMatch(/^An agent read a sensitive file: Dotenv file\./)
  })

  it('clears itself after the timeout, and a new read restarts it', () => {
    render(<SensitiveFileReadBanner />)
    act(() => captured!(ev()))
    act(() => { vi.advanceTimersByTime(SENSITIVE_READ_NOTICE_MS - 1000) })
    act(() => captured!(ev({ filePath: '/repo/id_rsa', label: 'SSH private key' })))
    act(() => { vi.advanceTimersByTime(SENSITIVE_READ_NOTICE_MS - 1000) })
    expect(text()).toMatch(/SSH private key/)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.queryByTestId('sensitive-file-read-banner')).toBeNull()
  })

  it('the dismiss button hides it', () => {
    render(<SensitiveFileReadBanner />)
    act(() => captured!(ev()))
    fireEvent.click(screen.getByRole('button', { name: /Dismiss sensitive-file notice/ }))
    expect(screen.queryByTestId('sensitive-file-read-banner')).toBeNull()
  })

  it('unsubscribes on unmount, and an unsubscribe that throws is swallowed', () => {
    const { unmount } = render(<SensitiveFileReadBanner />)
    unmount()
    expect(unsubSpy).toHaveBeenCalledTimes(1)
    unsubSpy.mockImplementation(() => { throw new Error('gone') })
    const r2 = render(<SensitiveFileReadBanner />)
    expect(() => r2.unmount()).not.toThrow()
  })

  it('tolerates a subscriber that returns no unsubscribe', () => {
    ;(window as any).aiSecurity = { onSensitiveFileRead: () => undefined }
    const { unmount } = render(<SensitiveFileReadBanner />)
    expect(() => unmount()).not.toThrow()
  })

  it('does nothing without the bridge', () => {
    delete (window as any).aiSecurity
    render(<SensitiveFileReadBanner />)
    expect(screen.queryByTestId('sensitive-file-read-banner')).toBeNull()
  })
})

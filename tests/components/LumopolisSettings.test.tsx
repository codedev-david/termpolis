import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { LumopolisSettings } from '../../src/renderer/src/components/SettingsPane/LumopolisSettings'

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) })
const toggle = () => screen.getByTestId('settings-world-labelling-toggle')

function api(over: Record<string, unknown>) {
  ;(window as any).termpolis = { ...over }
}

afterEach(() => { delete (window as any).termpolis })

describe('LumopolisSettings', () => {
  it('shows the stored setting and names the cost', async () => {
    api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: false } })) })
    render(<LumopolisSettings />)
    // Honest about the model: labelling always runs on Claude's cheapest model, whatever the default agent is.
    expect(screen.getByText(/Describe parts with AI \(uses Claude's cheapest model, Haiku\)/)).toBeInTheDocument()
    expect(screen.queryByText(/default agent/)).toBeNull()
    expect(toggle()).toHaveAttribute('aria-checked', 'true') // ON until main answers
    await settle()
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
  })

  it('keeps ON when the read fails, is refused, or the bridge has no such call', async () => {
    api({ worldSettingsGet: vi.fn(async () => ({ success: false, error: 'boom' })) })
    const a = render(<LumopolisSettings />)
    await settle()
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    a.unmount()

    api({ worldSettingsGet: vi.fn(async () => { throw new Error('ipc down') }) })
    const b = render(<LumopolisSettings />)
    await settle()
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    b.unmount()

    api({})
    render(<LumopolisSettings />)
    await settle()
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    // Clicking with no bridge call flips the switch locally and does not throw.
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
  })

  it('ignores a read that lands after unmount', async () => {
    let resolve!: (v: unknown) => void
    api({ worldSettingsGet: vi.fn(() => new Promise(r => { resolve = r })) })
    const view = render(<LumopolisSettings />)
    view.unmount()
    resolve({ success: true, data: { worldLabelling: false } })
    await settle()
    expect(screen.queryByTestId('settings-world-labelling-toggle')).toBeNull()
  })

  it('writes the flip, and takes the value main stored', async () => {
    const set = vi.fn(async () => ({ success: true, data: { worldLabelling: false } }))
    api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true } })), worldSettingsSet: set })
    render(<LumopolisSettings />)
    await settle()
    fireEvent.click(toggle())
    expect(set).toHaveBeenCalledWith({ worldLabelling: false })
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
    await settle()
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
  })

  it('puts the old value back when the write is refused or fails', async () => {
    const set = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'disk full' })
      .mockRejectedValueOnce(new Error('ipc down'))
    api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true } })), worldSettingsSet: set })
    render(<LumopolisSettings />)
    await settle()
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
    await settle()
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle())
    await settle()
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    expect(set).toHaveBeenCalledTimes(2)
  })
})

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
  it('explains the cost', () => {
    api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true } })) })
    render(<LumopolisSettings />)
    expect(screen.getByText(/Lumopolis shows an estimate after each one/)).toBeInTheDocument()
    expect(screen.getByText('Describing parts and asking questions use tokens on your own agent account. Lumopolis shows an estimate after each one.')).toBeInTheDocument()
  })

  it('shows the stored setting and names the cost', async () => {
    api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: false } })) })
    render(<LumopolisSettings />)
    // Honest about the model: labelling runs on the cheapest model of the agent chosen below.
    expect(screen.getByText(/Describe parts with AI \(uses your agent's cheapest model\)/)).toBeInTheDocument()
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

  describe('read answers aloud', () => {
    const speakToggle = () => screen.getByTestId('settings-world-speak-toggle')

    it('is off until main says otherwise, and shows the stored value', async () => {
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldSpeakAnswers: true } })) })
      render(<LumopolisSettings />)
      expect(screen.getByText(/Read Lumopolis answers aloud/)).toBeInTheDocument()
      expect(speakToggle()).toHaveAttribute('aria-checked', 'false')
      await settle()
      expect(speakToggle()).toHaveAttribute('aria-checked', 'true')
    })

    it('treats anything but a literal true as off', async () => {
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true } })) })
      render(<LumopolisSettings />)
      await settle()
      expect(speakToggle()).toHaveAttribute('aria-checked', 'false')
    })

    it('writes only its own field, and takes the value main stored', async () => {
      const set = vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldSpeakAnswers: true } }))
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldSpeakAnswers: false } })), worldSettingsSet: set })
      render(<LumopolisSettings />)
      await settle()
      fireEvent.click(speakToggle())
      expect(set).toHaveBeenCalledWith({ worldSpeakAnswers: true })
      expect(speakToggle()).toHaveAttribute('aria-checked', 'true')
      await settle()
      expect(speakToggle()).toHaveAttribute('aria-checked', 'true')
    })

    it('puts the old value back when the write is refused, fails or has no bridge', async () => {
      const set = vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'disk full' })
        .mockRejectedValueOnce(new Error('ipc down'))
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldSpeakAnswers: false } })), worldSettingsSet: set })
      render(<LumopolisSettings />)
      await settle()
      fireEvent.click(speakToggle())
      await settle()
      expect(speakToggle()).toHaveAttribute('aria-checked', 'false')
      fireEvent.click(speakToggle())
      await settle()
      expect(speakToggle()).toHaveAttribute('aria-checked', 'false')
    })

    it('flips locally when the bridge has no write call', async () => {
      api({})
      render(<LumopolisSettings />)
      fireEvent.click(speakToggle())
      expect(speakToggle()).toHaveAttribute('aria-checked', 'true')
    })
  })

  describe('read CI results with GitHub CLI', () => {
    const ciToggle = () => screen.getByTestId('settings-world-ci-toggle')

    it('is labelled, says it runs the gh command, and is on until main says otherwise', async () => {
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldCiResults: false } })) })
      render(<LumopolisSettings />)
      expect(screen.getByText('Read CI results with GitHub CLI')).toBeInTheDocument()
      const copy = screen.getByTestId('lumopolis-ci-settings').textContent
      expect(copy).toContain('runs the gh command')
      expect(copy).toContain('On by default')
      expect(copy).toContain('never runs gh')
      expect(ciToggle()).toHaveAttribute('aria-checked', 'true')
      await settle()
      expect(ciToggle()).toHaveAttribute('aria-checked', 'false')
    })

    it('stays on when main sends no CI field', async () => {
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true } })) })
      render(<LumopolisSettings />)
      await settle()
      expect(ciToggle()).toHaveAttribute('aria-checked', 'true')
    })

    it('writes only its own field and takes the stored value; a refused or failed write puts it back', async () => {
      const set = vi.fn()
        .mockResolvedValueOnce({ success: true, data: { worldLabelling: true, worldCiResults: true } })
        .mockResolvedValueOnce({ success: false, error: 'disk full' })
        .mockRejectedValueOnce(new Error('ipc down'))
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldCiResults: false } })), worldSettingsSet: set })
      render(<LumopolisSettings />)
      await settle()
      fireEvent.click(ciToggle())
      expect(set).toHaveBeenLastCalledWith({ worldCiResults: true })
      await settle()
      expect(ciToggle()).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(ciToggle())
      await settle()
      expect(ciToggle()).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(ciToggle())
      await settle()
      expect(ciToggle()).toHaveAttribute('aria-checked', 'true')
    })

    it('flips locally when the bridge has no write call', async () => {
      api({})
      render(<LumopolisSettings />)
      fireEvent.click(ciToggle())
      expect(ciToggle()).toHaveAttribute('aria-checked', 'false')
    })
  })

  describe('your agent', () => {
    const pick = () => screen.getByTestId('settings-world-agent') as HTMLSelectElement
    const note = () => screen.queryByTestId('lumopolis-gemini-note')

    it('offers Claude Code, Codex and Gemini CLI, defaults to Claude, shows the stored agent', async () => {
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldAgent: 'codex' } })) })
      render(<LumopolisSettings />)
      expect(Array.from(pick().options).map((o) => o.textContent)).toEqual(['Claude Code', 'Codex', 'Gemini CLI'])
      expect(pick().value).toBe('claude')
      await settle()
      expect(pick().value).toBe('codex')
      expect(note()).toBeNull()
    })

    it('ignores an unknown stored agent', async () => {
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldAgent: 'llama' } })) })
      render(<LumopolisSettings />)
      await settle()
      expect(pick().value).toBe('claude')
    })

    it('saves worldAgent and shows the Gemini note only for Gemini', async () => {
      const set = vi.fn(async (p: { worldAgent: string }) => ({ success: true, data: { worldLabelling: true, worldAgent: p.worldAgent } }))
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldAgent: 'claude' } })), worldSettingsSet: set })
      render(<LumopolisSettings />)
      await settle()
      fireEvent.change(pick(), { target: { value: 'gemini' } })
      expect(set).toHaveBeenCalledWith({ worldAgent: 'gemini' })
      await settle()
      expect(pick().value).toBe('gemini')
      expect(note()).toHaveTextContent('Gemini: not compressed (no proxy route)')
      fireEvent.change(pick(), { target: { value: 'codex' } })
      await settle()
      expect(note()).toBeNull()
    })

    it('puts the old agent back when the write is refused, answers oddly, fails or has no bridge', async () => {
      const set = vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'disk full' })
        .mockResolvedValueOnce({ success: true, data: { worldLabelling: true, worldAgent: 'llama' } })
        .mockRejectedValueOnce(new Error('ipc down'))
      api({ worldSettingsGet: vi.fn(async () => ({ success: true, data: { worldLabelling: true, worldAgent: 'claude' } })), worldSettingsSet: set })
      render(<LumopolisSettings />)
      await settle()
      for (let i = 0; i < 3; i++) {
        fireEvent.change(pick(), { target: { value: 'codex' } })
        expect(pick().value).toBe('codex')
        await settle()
        expect(pick().value).toBe('claude')
      }
    })

    it('flips locally without a bridge call, and ignores a value that is no agent', async () => {
      api({})
      render(<LumopolisSettings />)
      fireEvent.change(pick(), { target: { value: 'codex' } })
      expect(pick().value).toBe('codex')
      fireEvent.change(pick(), { target: { value: 'nonsense' } })
      expect(pick().value).toBe('codex')
    })
  })
})

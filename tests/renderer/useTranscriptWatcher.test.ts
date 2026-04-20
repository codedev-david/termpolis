import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTranscriptWatcher } from '../../src/renderer/src/hooks/useTranscriptWatcher'

type AgentActivityAPI = {
  attachWatcher: ReturnType<typeof vi.fn>
  detachWatcher: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  stats: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
}

let api: AgentActivityAPI

beforeEach(() => {
  api = {
    attachWatcher: vi.fn().mockResolvedValue({ success: true, data: { attached: true } }),
    detachWatcher: vi.fn().mockResolvedValue({ success: true }),
    query: vi.fn(),
    stats: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  }
  ;(window as any).agentActivity = api
})

describe('useTranscriptWatcher', () => {
  it('does nothing when agent is null', () => {
    renderHook(() => useTranscriptWatcher('t1', '/cwd', null))
    expect(api.attachWatcher).not.toHaveBeenCalled()
  })

  it('does nothing when terminalId is empty', () => {
    renderHook(() =>
      useTranscriptWatcher('', '/cwd', { name: 'Claude Code', icon: '', color: '' }),
    )
    expect(api.attachWatcher).not.toHaveBeenCalled()
  })

  it('does nothing when cwd is empty', () => {
    renderHook(() =>
      useTranscriptWatcher('t1', '', { name: 'Claude Code', icon: '', color: '' }),
    )
    expect(api.attachWatcher).not.toHaveBeenCalled()
  })

  it('does nothing for unknown agent name', () => {
    renderHook(() =>
      useTranscriptWatcher('t1', '/cwd', { name: 'Unknown', icon: '', color: '' }),
    )
    expect(api.attachWatcher).not.toHaveBeenCalled()
  })

  it('attaches claude watcher for Claude Code', () => {
    renderHook(() =>
      useTranscriptWatcher('t1', '/cwd', { name: 'Claude Code', icon: '', color: '' }),
    )
    expect(api.attachWatcher).toHaveBeenCalledWith('t1', '/cwd', 'claude')
  })

  it('attaches codex watcher for Codex', () => {
    renderHook(() =>
      useTranscriptWatcher('t1', '/cwd', { name: 'Codex', icon: '', color: '' }),
    )
    expect(api.attachWatcher).toHaveBeenCalledWith('t1', '/cwd', 'codex')
  })

  it('attaches gemini watcher for Gemini CLI', () => {
    renderHook(() =>
      useTranscriptWatcher('t1', '/cwd', { name: 'Gemini CLI', icon: '', color: '' }),
    )
    expect(api.attachWatcher).toHaveBeenCalledWith('t1', '/cwd', 'gemini')
  })

  it('attaches aider watcher for Aider', () => {
    renderHook(() =>
      useTranscriptWatcher('t1', '/cwd', { name: 'Aider', icon: '', color: '' }),
    )
    expect(api.attachWatcher).toHaveBeenCalledWith('t1', '/cwd', 'aider')
  })

  it('detaches on unmount', () => {
    const { unmount } = renderHook(() =>
      useTranscriptWatcher('t1', '/cwd', { name: 'Claude Code', icon: '', color: '' }),
    )
    unmount()
    expect(api.detachWatcher).toHaveBeenCalledWith('t1')
  })

  it('detaches old and attaches new when agent changes', () => {
    const { rerender } = renderHook(
      ({ agent }: { agent: any }) => useTranscriptWatcher('t1', '/cwd', agent),
      { initialProps: { agent: { name: 'Claude Code', icon: '', color: '' } } },
    )
    api.attachWatcher.mockClear()
    rerender({ agent: { name: 'Codex', icon: '', color: '' } })
    expect(api.detachWatcher).toHaveBeenCalledWith('t1')
    expect(api.attachWatcher).toHaveBeenCalledWith('t1', '/cwd', 'codex')
  })

  it('swallows attach errors silently', () => {
    api.attachWatcher.mockRejectedValueOnce(new Error('boom'))
    expect(() => {
      renderHook(() =>
        useTranscriptWatcher('t1', '/cwd', { name: 'Claude Code', icon: '', color: '' }),
      )
    }).not.toThrow()
  })

  it('tolerates missing window.agentActivity', () => {
    ;(window as any).agentActivity = undefined
    expect(() => {
      renderHook(() =>
        useTranscriptWatcher('t1', '/cwd', { name: 'Claude Code', icon: '', color: '' }),
      )
    }).not.toThrow()
  })
})

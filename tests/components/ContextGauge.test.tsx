import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ContextGauge } from '../../src/renderer/src/components/ContextGauge/ContextGauge'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

// Seam for the gauge's palette FALLBACK. pressureLevel only ever returns one of the four
// mapped levels, so `LEVEL_COLOR[level] ?? '#98c379'` is unreachable through the real lib.
// While `levelOverride.value` is null every test below runs against the REAL implementation;
// exactly one test flips it to an unmapped level.
const levelOverride = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('../../src/renderer/src/lib/contextPressure', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../src/renderer/src/lib/contextPressure')
  return {
    ...actual,
    pressureLevel: (w: Parameters<typeof actual.pressureLevel>[0]) =>
      (levelOverride.value ?? actual.pressureLevel(w)) as ReturnType<typeof actual.pressureLevel>,
  }
})

type AgentActivityAPI = {
  query: ReturnType<typeof vi.fn>
  stats: ReturnType<typeof vi.fn>
  attachWatcher: ReturnType<typeof vi.fn>
  detachWatcher: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
}

let api: AgentActivityAPI

function mkEvent(over: Partial<AgentActivityEvent>): AgentActivityEvent {
  return {
    id: over.id ?? 'e1',
    ts: over.ts ?? 1,
    terminalId: over.terminalId ?? 't1',
    agentType: over.agentType ?? 'claude',
    kind: over.kind ?? 'message',
    summary: over.summary ?? '',
    payload: over.payload ?? {},
  }
}

beforeEach(() => {
  api = {
    query: vi.fn().mockResolvedValue({ success: true, data: [] }),
    stats: vi.fn(),
    attachWatcher: vi.fn(),
    detachWatcher: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  }
  ;(window as any).agentActivity = api
})

describe('ContextGauge', () => {
  it('renders 0% when no events', async () => {
    render(<ContextGauge terminalId="t1" model="claude" />)
    await waitFor(() => expect(api.query).toHaveBeenCalled())
    expect(screen.getByTestId('context-gauge')).toHaveTextContent('0%')
  })

  it('reflects token_update events for its terminal', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({
          id: 'a',
          kind: 'token_update',
          terminalId: 't1',
          payload: { inputTokens: 50_000, outputTokens: 50_000 },
        }),
      ],
    })
    render(<ContextGauge terminalId="t1" model="claude-opus-4-7" />)
    await waitFor(() => expect(screen.getByTestId('context-gauge')).toHaveTextContent(/50%/))
  })

  it('scopes to terminalId', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [
        mkEvent({
          id: 'other',
          kind: 'token_update',
          terminalId: 't2',
          payload: { inputTokens: 199_000 },
        }),
      ],
    })
    render(<ContextGauge terminalId="t1" model="claude-opus-4-7" />)
    await waitFor(() => expect(screen.getByTestId('context-gauge')).toHaveTextContent('0%'))
  })

  it('calls onClick when pressed', () => {
    const onClick = vi.fn()
    render(<ContextGauge terminalId="t1" onClick={onClick} />)
    fireEvent.click(screen.getByTestId('context-gauge'))
    expect(onClick).toHaveBeenCalled()
  })

  it('marks heuristic source with ~', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [mkEvent({ kind: 'message', payload: { length: 400_000 } })],
    })
    render(<ContextGauge terminalId="t1" model="gpt-4" />)
    await waitFor(() => expect(screen.getByTestId('context-gauge')).toHaveTextContent('~'))
  })

  it('omits the ~ marker when the reading came from real transcript tokens', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [mkEvent({ kind: 'token_update', payload: { inputTokens: 20_000 } })],
    })
    render(<ContextGauge terminalId="t1" model="claude-opus-4-7" />)
    await waitFor(() => expect(screen.getByTestId('context-gauge')).toHaveTextContent('10%'))
    expect(screen.getByTestId('context-gauge')).not.toHaveTextContent('~')
    expect(screen.getByTestId('context-gauge').title).toContain('(transcript)')
  })

  it('paints the bar with the palette colour for the resolved pressure level', async () => {
    api.query.mockResolvedValueOnce({
      success: true,
      data: [mkEvent({ kind: 'token_update', payload: { inputTokens: 196_000 } })],
    })
    render(<ContextGauge terminalId="t1" model="claude-opus-4-7" />)
    await waitFor(() => expect(screen.getByTestId('context-gauge')).toHaveTextContent('98%'))
    const bar = screen.getByTestId('context-gauge').querySelector('div > div') as HTMLElement
    expect(bar.style.width).toBe('98%')
    expect(bar.style.backgroundColor).toBe('rgb(224, 108, 117)') // critical → #e06c75
    expect(screen.getByTestId('context-gauge')).toHaveAttribute('aria-label', 'Context pressure 98 percent')
  })

  it('falls back to the ok colour when the level has no palette entry', async () => {
    levelOverride.value = 'meltdown' // a level LEVEL_COLOR does not know about
    try {
      api.query.mockResolvedValueOnce({
        success: true,
        data: [mkEvent({ kind: 'token_update', payload: { inputTokens: 196_000 } })],
      })
      render(<ContextGauge terminalId="t1" model="claude-opus-4-7" />)
      await waitFor(() => expect(screen.getByTestId('context-gauge')).toHaveTextContent('98%'))
      const bar = screen.getByTestId('context-gauge').querySelector('div > div') as HTMLElement
      // The width still tracks the real ratio; only the colour falls back.
      expect(bar.style.width).toBe('98%')
      expect(bar.style.backgroundColor).toBe('rgb(152, 195, 121)') // #98c379, not the critical red
    } finally {
      levelOverride.value = null
    }
  })
})

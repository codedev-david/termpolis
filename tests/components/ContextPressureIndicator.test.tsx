import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ContextPressureIndicator } from '../../src/renderer/src/components/StatusBar/ContextPressureIndicator'
import type { ContextWindow } from '../../src/renderer/src/lib/contextPressure'

const cw = (
  used: number,
  total = 200_000,
  source: 'transcript' | 'heuristic' = 'transcript',
  model = 'Claude 4',
): ContextWindow => ({ total, used, source, model })

describe('ContextPressureIndicator', () => {
  it('renders nothing when there is no pressure', () => {
    render(<ContextPressureIndicator pressure={null} />)
    expect(screen.queryByTestId('context-pressure-indicator')).not.toBeInTheDocument()
  })

  it('renders nothing when total or used is non-positive', () => {
    const { rerender } = render(<ContextPressureIndicator pressure={cw(0)} />)
    expect(screen.queryByTestId('context-pressure-indicator')).not.toBeInTheDocument()
    rerender(<ContextPressureIndicator pressure={cw(50_000, 0)} />)
    expect(screen.queryByTestId('context-pressure-indicator')).not.toBeInTheDocument()
  })

  it('shows ok level + percentage at low usage', () => {
    render(<ContextPressureIndicator pressure={cw(20_000)} />) // 10%
    const el = screen.getByTestId('context-pressure-indicator')
    expect(el).toHaveAttribute('data-level', 'ok')
    expect(el).toHaveTextContent('ctx 10%')
    expect(el).toHaveAttribute('aria-label', expect.stringContaining('10% full'))
  })

  it('escalates warn → danger → critical at the right thresholds', () => {
    const { rerender } = render(<ContextPressureIndicator pressure={cw(130_000)} />) // 65%
    expect(screen.getByTestId('context-pressure-indicator')).toHaveAttribute('data-level', 'warn')
    rerender(<ContextPressureIndicator pressure={cw(170_000)} />) // 85%
    expect(screen.getByTestId('context-pressure-indicator')).toHaveAttribute('data-level', 'danger')
    rerender(<ContextPressureIndicator pressure={cw(196_000)} />) // 98%
    expect(screen.getByTestId('context-pressure-indicator')).toHaveAttribute('data-level', 'critical')
  })

  it('marks heuristic pressure as estimated in the tooltip', () => {
    render(<ContextPressureIndicator pressure={cw(40_000, 200_000, 'heuristic')} />)
    expect(screen.getByTestId('context-pressure-indicator').title).toMatch(/estimated/i)
  })

  it('does not mark transcript pressure as estimated', () => {
    render(<ContextPressureIndicator pressure={cw(40_000, 200_000, 'transcript')} />)
    expect(screen.getByTestId('context-pressure-indicator').title).not.toMatch(/estimated/i)
  })

  it('tooltip surfaces the model, the formatted usage, and the memory-brain hook', () => {
    render(<ContextPressureIndicator pressure={cw(100_000, 200_000, 'transcript', 'Claude 4')} />)
    const { title } = screen.getByTestId('context-pressure-indicator')
    expect(title).toContain('Claude 4')
    expect(title).toContain('50%')
    expect(title).toContain('100.0K')
    expect(title).toMatch(/memory brain/i)
  })
})

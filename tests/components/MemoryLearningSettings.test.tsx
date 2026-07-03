import React from 'react'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { MemoryLearningSettings } from '../../src/renderer/src/components/SettingsPane/MemoryLearningSettings'
import type { MemoryMetrics } from '../../src/renderer/src/types'

function metrics(over: Partial<MemoryMetrics> = {}): MemoryMetrics {
  return {
    ledger: {
      generatedTs: 0,
      recalls: 0, recallFiredRate: 0, avgHits: 0, avgTopScore: 0, avgLatencyMs: 0,
      byPath: { vector: 0, keyword: 0, cache: 0 },
      embedAvailability: 1, writes: 0, writeDurability: 1,
      injects: 0, tokensInjected: 0, reusedSolutions: 0, tokensSavedEstimate: 0,
      feedbackCount: 0, feedbackHelpfulRate: 0,
      lessonsLearned: 0, crossAgentRecalls: 0, teachingMatrix: {},
      ...(over.ledger || {}),
    },
    store: { total: 0, capacity: 500000, byType: {}, bySource: {}, lessons: 0, ...(over.store || {}) },
    graph: { nodes: 0, edges: 0, byRelation: {}, ...(over.graph || {}) },
    competence: over.competence || [],
  }
}

function stub(data: MemoryMetrics | null, ok = true, error = ''): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => (ok ? { success: true, data } : { success: false, error }))
  ;(window as unknown as { termpolis: unknown }).termpolis = { memoryMetrics: fn }
  return fn
}

describe('MemoryLearningSettings', () => {
  it('renders the populated dashboard with real receipt numbers', async () => {
    stub(metrics({
      store: { total: 12847, capacity: 500000, byType: { episodic: 9000, semantic: 2000 }, bySource: { claude: 6000, codex: 2000 }, lessons: 2920 },
      graph: { nodes: 12847, edges: 18431, byRelation: { 'relates-to': 9000, solves: 100 } },
      ledger: { ...metrics().ledger, recalls: 40, recallFiredRate: 0.99, avgLatencyMs: 12 },
    }))
    render(<MemoryLearningSettings />)
    const receipts = await screen.findByTestId('ml-receipts')
    expect(within(receipts).getByText('12.8k')).toBeInTheDocument() // memories stored
    expect(within(receipts).getByText('2.9k')).toBeInTheDocument()  // lessons learned
    expect(screen.getByTestId('ml-bytype')).toBeInTheDocument()
    expect(screen.getByTestId('ml-connections')).toBeInTheDocument()
    expect(screen.getByTestId('ml-reliability')).toBeInTheDocument()
    expect(screen.getByTestId('ml-cross')).toBeInTheDocument()
  })

  it('shows the empty-brain onboarding note when nothing is stored', async () => {
    stub(metrics())
    render(<MemoryLearningSettings />)
    expect(await screen.findByTestId('ml-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('ml-receipts')).not.toBeInTheDocument()
  })

  it('renders a directional teaching row when cross-agent reuse exists', async () => {
    stub(metrics({
      store: { total: 3, capacity: 10, byType: { semantic: 3 }, bySource: { gemini: 2, claude: 1 }, lessons: 3 },
      ledger: { ...metrics().ledger, crossAgentRecalls: 1, teachingMatrix: { gemini: { claude: 5 } } },
    }))
    render(<MemoryLearningSettings />)
    const cross = await screen.findByTestId('ml-cross')
    expect(within(cross).getByText('gemini')).toBeInTheDocument()
    expect(within(cross).getByText('claude')).toBeInTheDocument()
  })

  it('surfaces an error when the metrics IPC fails', async () => {
    stub(null, false, 'ipc down')
    render(<MemoryLearningSettings />)
    expect(await screen.findByTestId('ml-error')).toHaveTextContent('ipc down')
  })

  it('re-reads metrics when Refresh is clicked', async () => {
    const fn = stub(metrics({ store: { total: 5, capacity: 10, byType: { semantic: 5 }, bySource: { mneme: 5 }, lessons: 5 } }))
    render(<MemoryLearningSettings />)
    await screen.findByTestId('ml-receipts')
    const before = fn.mock.calls.length
    fireEvent.click(screen.getByTestId('ml-refresh'))
    await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThan(before))
  })
})

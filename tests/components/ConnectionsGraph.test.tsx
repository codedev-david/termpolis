import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConnectionsGraph } from '../../src/renderer/src/components/SettingsPane/ConnectionsGraph'

// jsdom has no canvas 2d context, so the force-sim useEffect would early-return. We mock
// a no-op 2d context + a fixed 600×360 bounding box so the sim, draw loop, hit-testing
// and interaction handlers all execute (and are covered).
function fakeCtx(): Record<string, unknown> {
  return {
    clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
    setTransform: vi.fn(), measureText: vi.fn(() => ({ width: 12 })),
    strokeStyle: '', fillStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: 'start',
  }
}
const RECT = { width: 600, height: 360, left: 0, top: 0, right: 600, bottom: 360, x: 0, y: 0, toJSON: () => ({}) }

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx() as unknown as CanvasRenderingContext2D)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT as DOMRect)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const nodes = [
  { id: 'a', label: 'session: fix scroll', type: 'episodic', degree: 3 },
  { id: 'b', label: 'AES at rest', type: 'semantic', degree: 2 },
  { id: 'c', label: 'index.ts:1-9', type: 'entity', degree: 1 },
  { id: 'd', label: 'release.yml', type: 'entity', degree: 1 },
]
const edges = [
  { from: 'a', to: 'b', relation: 'relates-to' },
  { from: 'a', to: 'c', relation: 'follows' },
  { from: 'b', to: 'd', relation: 'solves' },
]

describe('ConnectionsGraph', () => {
  it('renders the empty state when there are no nodes', () => {
    render(<ConnectionsGraph nodes={[]} edges={[]} totalNodes={0} totalEdges={0} />)
    expect(screen.getByText(/no connections yet/i)).toBeInTheDocument()
  })

  it('renders the canvas, the "N of M" overlay and a type legend for a real subgraph', () => {
    render(<ConnectionsGraph nodes={nodes} edges={edges} totalNodes={3272} totalEdges={3119} />)
    expect(screen.getByTestId('ml-graph-canvas')).toBeInTheDocument()
    expect(screen.getByText(/4 of 3,272 nodes/)).toBeInTheDocument()
    expect(screen.getByText('episodic')).toBeInTheDocument()
    expect(screen.getByText('entity')).toBeInTheDocument()
    expect(screen.getByText('semantic')).toBeInTheDocument()
  })

  it('runs the sim, draw and hover hit-testing without error', () => {
    render(<ConnectionsGraph nodes={nodes} edges={edges} totalNodes={4} totalEdges={3} />)
    const canvas = screen.getByTestId('ml-graph-canvas')
    fireEvent.mouseMove(canvas, { clientX: 300, clientY: 180 })
    fireEvent.mouseMove(canvas, { clientX: 5, clientY: 5 }) // likely a miss → covers the no-hit branch
    fireEvent.mouseLeave(canvas)
    expect(canvas).toBeInTheDocument()
  })

  it('selects a node on click and shows its connection detail card, then closes it', () => {
    // a single node is centering-pulled to the canvas centre (300,180) → deterministic hit
    render(<ConnectionsGraph nodes={[{ id: 'solo', label: 'lonely memory', type: 'summary', degree: 0 }]} edges={[]} totalNodes={1} totalEdges={0} />)
    const canvas = screen.getByTestId('ml-graph-canvas')
    fireEvent.click(canvas, { clientX: 300, clientY: 180 })
    const card = screen.getByTestId('ml-graph-card')
    expect(card).toHaveTextContent('lonely memory')
    expect(card).toHaveTextContent(/no edges|0 connection/i)
    fireEvent.click(screen.getByRole('button', { name: '✕' }))
    expect(screen.queryByTestId('ml-graph-card')).not.toBeInTheDocument()
  })
})

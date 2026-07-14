import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConnectionsGraph } from '../../src/renderer/src/components/SettingsPane/ConnectionsGraph'
import { Memory } from '../../src/renderer/src/components/Memory/Memory'

// The Code Graph browser is a sibling feature with its own suite; stub it so this file
// exercises Memory.tsx's own async surface without its effects racing our assertions.
vi.mock('../../src/renderer/src/components/Memory/CodeGraphPanel', () => ({
  CodeGraphPanel: () => <div data-testid="code-graph-panel-stub" />,
}))

// ---------------------------------------------------------------------------
// ConnectionsGraph harness
// ---------------------------------------------------------------------------
// jsdom has no canvas 2d context, no matchMedia and (in the existing suite) a no-op
// requestAnimationFrame — which means the component's draw() only ever ran ONCE, at mount,
// with nothing selected or hovered. Every selection/hover drawing branch was therefore dead.
// Here we (a) fake a 2d context we can assert against, (b) capture the rAF callback so a test
// can advance exactly one frame after interacting, and (c) leave matchMedia absent by default
// (jsdom parity) but stub it where reduced-motion is under test.

type Ctx2D = {
  clearRect: ReturnType<typeof vi.fn>; beginPath: ReturnType<typeof vi.fn>
  moveTo: ReturnType<typeof vi.fn>; lineTo: ReturnType<typeof vi.fn>
  stroke: ReturnType<typeof vi.fn>; arc: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>
  fillText: ReturnType<typeof vi.fn>; setTransform: ReturnType<typeof vi.fn>
  measureText: ReturnType<typeof vi.fn>
  strokeStyle: string; fillStyle: string; lineWidth: number
  globalAlpha: number; font: string; textAlign: string
}

/** Every stroke(), with the pen state it was drawn with — how we observe what the canvas painted. */
interface Stroke { alpha: number; width: number; color: string }
let strokes: Stroke[]

/** Node rings are stroked in the fixed panel background colour; everything else is an edge. */
const NODE_RING = '#161b26'
const edgeStrokes = (): Stroke[] => strokes.filter((s) => s.color !== NODE_RING)

function makeCtx(): Ctx2D {
  const c: Ctx2D = {
    clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
    setTransform: vi.fn(), measureText: vi.fn(() => ({ width: 12 })),
    strokeStyle: '', fillStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: 'start',
  }
  c.stroke = vi.fn(() => { strokes.push({ alpha: c.globalAlpha, width: c.lineWidth, color: c.strokeStyle }) })
  return c
}

let ctx: Ctx2D
let rafCb: FrameRequestCallback | null
let rafSpy: ReturnType<typeof vi.fn>
let rectWidth: number

/** Advance exactly one animation frame (the component re-registers itself; we do not auto-run). */
function tick(): void {
  const cb = rafCb
  rafCb = null
  if (cb) cb(16)
}

function rect(width: number): DOMRect {
  return { width, height: 360, left: 0, top: 0, right: width, bottom: 360, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
}

/**
 * Discover where the force-sim actually put each node, rather than hard-coding coordinates
 * (which would duplicate the physics). We sweep the canvas with real mousemove events and
 * use the component's own observable hover feedback — it sets cursor:'pointer' over a node —
 * as the probe. Adjacent grid hits are flood-filled into one blob per node; we return each
 * blob's centroid, which is a reliable click target for that node.
 */
function nodeHitPoints(canvas: HTMLCanvasElement): Array<{ x: number; y: number }> {
  const STEP = 4
  const pts: Array<{ x: number; y: number }> = []
  for (let y = 6; y < 360; y += STEP) {
    for (let x = 6; x < rectWidth; x += STEP) {
      canvas.style.cursor = ''
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }))
      if (canvas.style.cursor === 'pointer') pts.push({ x, y })
    }
  }
  const seen = new Array<boolean>(pts.length).fill(false)
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i < pts.length; i++) {
    if (seen[i]) continue
    seen[i] = true
    const blob = [i]
    for (let k = 0; k < blob.length; k++) {
      for (let j = 0; j < pts.length; j++) {
        if (seen[j]) continue
        const a = pts[blob[k]]
        if (Math.hypot(a.x - pts[j].x, a.y - pts[j].y) <= STEP * 1.5) { seen[j] = true; blob.push(j) }
      }
    }
    out.push({
      x: Math.round(blob.reduce((s, k) => s + pts[k].x, 0) / blob.length),
      y: Math.round(blob.reduce((s, k) => s + pts[k].y, 0) / blob.length),
    })
  }
  canvas.dispatchEvent(new MouseEvent('mouseleave')) // don't leave a stale hover behind
  return out
}

/** Click node centroids until the detail card's title is `label`; returns the card. */
function clickNodeTitled(canvas: HTMLCanvasElement, label: string): HTMLElement {
  for (const p of nodeHitPoints(canvas)) {
    fireEvent.click(canvas, { clientX: p.x, clientY: p.y })
    const card = screen.queryByTestId('ml-graph-card')
    if (card?.querySelector(`span[title="${label}"]`)) return card
  }
  throw new Error(`no clickable node titled "${label}"`)
}

const fillTexts = (): string[] => ctx.fillText.mock.calls.map((c) => String(c[0]))

// A hub with one outgoing + one incoming edge, plus an unconnected node so that
// "dim the non-neighbours" and "skip the unlabelled" have something to act on.
const HUB_NODES = [
  { id: 'h', label: 'HUB', type: 'episodic', degree: 2 },
  { id: 'o', label: 'OUTBOUND', type: 'semantic', degree: 1 },
  { id: 'i', label: 'INBOUND', type: 'procedural', degree: 1 },
  { id: 'l', label: 'LONER', type: 'summary', degree: 0 },
]
const HUB_EDGES = [
  { from: 'h', to: 'o', relation: 'solves' },
  { from: 'i', to: 'h', relation: 'caused-by' },
]

describe('ConnectionsGraph — draw, selection and layout branches', () => {
  beforeEach(() => {
    strokes = []
    ctx = makeCtx()
    rafCb = null
    rectWidth = 600
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => rect(rectWidth))
    rafSpy = vi.fn((cb: FrameRequestCallback) => { rafCb = cb; return 1 })
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('empty graph reads as "no connections" — no canvas, no legend, no animation loop', () => {
    render(<ConnectionsGraph nodes={[]} edges={[]} totalNodes={0} totalEdges={0} />)
    expect(screen.getByText(/no connections yet/i)).toBeInTheDocument()
    // the important part: it is an explanatory empty state, not a blank/broken canvas
    expect(screen.queryByTestId('ml-graph-canvas')).not.toBeInTheDocument()
    expect(screen.queryByText(/click a node to trace/i)).not.toBeInTheDocument()
    expect(rafSpy).not.toHaveBeenCalled()
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it('bails out safely when the canvas has no 2d context (no listeners, no frames)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={4} totalEdges={2} />)
    const canvas = screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement
    expect(rafSpy).not.toHaveBeenCalled()
    // no interaction handlers were wired, so hovering cannot change the cursor
    fireEvent.mouseMove(canvas, { clientX: 300, clientY: 180 })
    expect(canvas.style.cursor).toBe('')
    fireEvent.click(canvas, { clientX: 300, clientY: 180 })
    expect(screen.queryByTestId('ml-graph-card')).not.toBeInTheDocument()
  })

  it('honours prefers-reduced-motion: draws one static frame and never starts the rAF loop', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={4} totalEdges={2} />)
    expect(ctx.arc).toHaveBeenCalled()       // it did render the nodes…
    expect(rafSpy).not.toHaveBeenCalled()    // …but it is not animating
  })

  // v1.25.16: this used to drive requestAnimationFrame FOREVER — ~60 fps of up to 600 stroked edges
  // and 160 node arcs, for as long as the Memory tab stayed mounted, even scrolled out of sight. All
  // of it existed to animate a 1.3-pixel cosmetic "bob", and it landed on exactly the frames that
  // scrolling needed. A settled force layout is a static image: paint it once, repaint only when a
  // viewer-visible thing changes. Idle cost must be zero.
  it('paints once and then leaves the main thread alone — no perpetual rAF loop', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={4} totalEdges={2} />)
    expect(rafSpy).not.toHaveBeenCalled()   // the first paint is synchronous; nothing is scheduled
    expect(ctx.stroke).toHaveBeenCalled()   // ...but it definitely drew
  })

  it('falls back to DPR 1 when devicePixelRatio is unset, and clamps a retina DPR to 2', () => {
    vi.stubGlobal('devicePixelRatio', 0)
    const { unmount } = render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={4} totalEdges={2} />)
    const canvas = screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement
    expect(canvas.width).toBe(600)          // 600 CSS px * DPR 1
    expect(canvas.style.width).toBe('600px')
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
    unmount()

    ctx = makeCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    vi.stubGlobal('devicePixelRatio', 3)
    render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={4} totalEdges={2} />)
    const retina = screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement
    expect(retina.width).toBe(1200)         // 600 * min(3, 2)
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
  })

  it('re-lays out the graph to the new width when the window resizes', () => {
    vi.useFakeTimers()
    render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={4} totalEdges={2} />)
    const canvas = screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement
    expect(canvas.style.width).toBe('600px')

    rectWidth = 900
    // Resize re-runs the O(N^2) relaxation, so it is DEBOUNCED — a window drag emits resize events
    // continuously, and running the settle on each one is a hard main-thread block per event.
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(canvas.style.width).toBe('600px') // ...not yet: still coalescing
    act(() => { vi.advanceTimersByTime(150) })
    vi.useRealTimers()

    expect(canvas.style.width).toBe('900px')
    expect(canvas.width).toBe(900)

    // and the layout is re-settled inside the new bounds: every node stays on-canvas
    for (const p of nodeHitPoints(canvas)) {
      expect(p.x).toBeGreaterThan(0)
      expect(p.x).toBeLessThan(900)
      expect(p.y).toBeLessThan(360)
    }
  })

  it('places every sampled node somewhere hoverable on the canvas', () => {
    render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={4} totalEdges={2} />)
    const canvas = screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement
    expect(nodeHitPoints(canvas)).toHaveLength(HUB_NODES.length)
  })

  it('selecting a node lists its typed connections with direction, and dims/hides the rest', () => {
    render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={99} totalEdges={2} />)
    const canvas = screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement
    const card = clickNodeTitled(canvas, 'HUB')

    expect(card).toHaveTextContent('2 connections')
    expect(card).toHaveTextContent('→ solves →')      // outgoing edge, hub → OUTBOUND
    expect(card).toHaveTextContent('OUTBOUND')
    expect(card).toHaveTextContent('← caused-by ←')   // incoming edge, INBOUND → hub
    expect(card).toHaveTextContent('INBOUND')
    expect(card).not.toHaveTextContent('LONER')       // unconnected node is not a connection
    expect(card).not.toHaveTextContent('no edges')

    // advance one frame so the canvas redraws with the selection applied
    ctx.fillText.mockClear()
    tick()
    // the selected node and its two neighbours get labels; the unconnected node does not
    expect(fillTexts().sort()).toEqual(['HUB', 'INBOUND', 'OUTBOUND'])
  })

  it('emphasises the selected node\'s edges and fades the ones that do not touch it', () => {
    // two disjoint pairs, so selecting P leaves the R—S edge as a genuine non-incident edge
    const nodes = [
      { id: 'p', label: 'P', type: 'episodic', degree: 1 },
      { id: 'q', label: 'Q', type: 'semantic', degree: 1 },
      { id: 'r', label: 'R', type: 'entity', degree: 1 },
      { id: 's', label: 'S', type: 'summary', degree: 1 },
    ]
    const edges = [
      { from: 'p', to: 'q', relation: 'solves' },   // incident to P  → #22D3EE
      { from: 'r', to: 's', relation: 'follows' },  // not incident   → #f472b6
    ]
    render(<ConnectionsGraph nodes={nodes} edges={edges} totalNodes={4} totalEdges={2} />)
    const canvas = screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement

    // with nothing selected both edges are drawn at the same, ordinary emphasis
    expect(edgeStrokes()).toEqual([
      { alpha: 0.5, width: 1.2, color: '#22D3EE' },
      { alpha: 0.5, width: 1.2, color: '#f472b6' },
    ])

    clickNodeTitled(canvas, 'P')
    strokes = []
    tick()

    expect(edgeStrokes()).toEqual([
      { alpha: 0.95, width: 1.8, color: '#22D3EE' },  // P—Q lights up
      { alpha: 0.05, width: 0.5, color: '#f472b6' },  // R—S recedes into the background
    ])
  })

  it('drops self-loops and edges that dangle outside the sampled subgraph', () => {
    const nodes = [
      { id: 'h', label: 'HUB', type: 'episodic', degree: 1 },
      { id: 'o', label: 'OUTBOUND', type: 'semantic', degree: 1 },
    ]
    const edges = [
      { from: 'h', to: 'h', relation: 'refers-to' },   // self-loop
      { from: 'h', to: 'ghost', relation: 'solves' },  // target not in the sample
      { from: 'ghost', to: 'h', relation: 'causes' },  // source not in the sample
      { from: 'h', to: 'o', relation: 'supersedes' },  // the only real one
    ]
    render(<ConnectionsGraph nodes={nodes} edges={edges} totalNodes={2} totalEdges={4} />)
    const card = clickNodeTitled(screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement, 'HUB')

    expect(card).toHaveTextContent('1 connection')     // singular, and exactly one
    expect(card).not.toHaveTextContent('1 connections')
    expect(card).toHaveTextContent('→ supersedes →')
    expect(card).not.toHaveTextContent('refers-to')
    expect(card).not.toHaveTextContent('ghost')
  })

  it('clicking the selected node again deselects it; clicking empty space also clears it', () => {
    render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={4} totalEdges={2} />)
    const canvas = screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement
    const points = nodeHitPoints(canvas)

    const hub = points.find((p) => {
      fireEvent.click(canvas, { clientX: p.x, clientY: p.y })
      return !!screen.queryByTestId('ml-graph-card')?.querySelector('span[title="HUB"]')
    })
    expect(hub).toBeDefined()

    fireEvent.click(canvas, { clientX: hub!.x, clientY: hub!.y })   // same node → toggle off
    expect(screen.queryByTestId('ml-graph-card')).not.toBeInTheDocument()

    fireEvent.click(canvas, { clientX: hub!.x, clientY: hub!.y })   // re-select…
    expect(screen.getByTestId('ml-graph-card')).toBeInTheDocument()

    // …then click a spot that is not a node at all
    const empty = { x: 2, y: 2 }
    expect(points.some((p) => Math.hypot(p.x - empty.x, p.y - empty.y) < 20)).toBe(false)
    fireEvent.click(canvas, { clientX: empty.x, clientY: empty.y })
    expect(screen.queryByTestId('ml-graph-card')).not.toBeInTheDocument()
  })

  it('hovering a node labels just that node; leaving the canvas clears the label', () => {
    render(<ConnectionsGraph nodes={HUB_NODES} edges={HUB_EDGES} totalNodes={4} totalEdges={2} />)
    const canvas = screen.getByTestId('ml-graph-canvas') as HTMLCanvasElement
    const points = nodeHitPoints(canvas)

    fireEvent.mouseMove(canvas, { clientX: points[0].x, clientY: points[0].y })
    expect(canvas.style.cursor).toBe('pointer')
    ctx.fillText.mockClear()
    tick()
    expect(fillTexts()).toHaveLength(1)                          // exactly one hovered label
    expect(HUB_NODES.map((n) => n.label)).toContain(fillTexts()[0])

    fireEvent.mouseLeave(canvas)
    ctx.fillText.mockClear()
    tick()
    expect(ctx.fillText).not.toHaveBeenCalled()                  // hover label gone

    fireEvent.mouseMove(canvas, { clientX: 2, clientY: 2 })      // a miss
    expect(canvas.style.cursor).toBe('default')
  })
})

// ---------------------------------------------------------------------------
// Memory panel
// ---------------------------------------------------------------------------

type Api = Record<string, ReturnType<typeof vi.fn>>
let api: Api

const SYNC_ON = { syncing: true, dir: '/d', deviceId: 'dev01', devices: 2, count: 42, encrypted: false, locked: false }

beforeEach(() => {
  api = {
    memoryStats: vi.fn().mockResolvedValue({ success: true, data: { count: 42, capacity: 50000 } }),
    memorySearch: vi.fn().mockResolvedValue({ success: true, data: [] }),
    memoryIngestConversations: vi.fn().mockResolvedValue({ success: true, data: { chunksWritten: 5 } }),
    memoryIngestCode: vi.fn().mockResolvedValue({ success: true, data: { filesScanned: 10, chunksWritten: 20 } }),
    memoryBuildPrimer: vi.fn().mockResolvedValue({ success: true, data: 'PRIMER' }),
    memorySyncStatus: vi.fn().mockResolvedValue({ success: true, data: { ...SYNC_ON, syncing: false, dir: null, devices: 0 } }),
    memorySetSyncDir: vi.fn().mockResolvedValue({ success: true, data: { ...SYNC_ON, syncing: false, dir: null, devices: 0 } }),
    memoryChooseSyncDir: vi.fn().mockResolvedValue({ success: true, data: SYNC_ON }),
    memorySetSyncPassphrase: vi.fn().mockResolvedValue({ success: true, data: { ...SYNC_ON, encrypted: true } }),
    memoryDisableSyncEncryption: vi.fn().mockResolvedValue({ success: true, data: SYNC_ON }),
    writeToTerminal: vi.fn(),
  }
  ;(window as unknown as { termpolis: Api }).termpolis = api
})
afterEach(() => cleanup())

function renderMemory(over: { activeTerminalId?: string | null; activeCwd?: string } = {}) {
  render(
    <Memory
      onClose={vi.fn()}
      activeTerminalId={over.activeTerminalId === undefined ? 't1' : over.activeTerminalId}
      activeCwd={over.activeCwd === undefined ? '/repo' : over.activeCwd}
    />,
  )
}

/** Wait for the two mount effects to settle so later assertions aren't racing them. */
async function settled(): Promise<void> {
  await waitFor(() => expect(api.memoryStats).toHaveBeenCalled())
}

const query = () => screen.getByLabelText('Memory query')

describe('Memory panel — degraded responses and edge inputs', () => {
  it('survives a preload without memorySyncStatus (older build) and shows sync as off', async () => {
    delete api.memorySyncStatus
    renderMemory()
    await settled()
    expect(screen.getByTestId('memory-sync-choose')).toBeInTheDocument()
    expect(screen.queryByTestId('memory-sync-off')).not.toBeInTheDocument()
  })

  it('ignores a successful sync-status response that carries no data', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: null })
    renderMemory()
    await waitFor(() => expect(api.memorySyncStatus).toHaveBeenCalled())
    expect(screen.getByTestId('memory-sync-choose')).toBeInTheDocument()
  })

  it('stays on "Loading…" when stats succeed but return no payload', async () => {
    api.memoryStats.mockResolvedValueOnce({ success: true, data: null })
    renderMemory()
    await settled()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('does not search on a key other than Enter', async () => {
    renderMemory()
    await settled()
    fireEvent.change(query(), { target: { value: 'auth' } })
    fireEvent.keyDown(query(), { key: 'a' })
    fireEvent.keyDown(query(), { key: 'Escape' })
    expect(api.memorySearch).not.toHaveBeenCalled()
  })

  it('does not search a whitespace-only query', async () => {
    renderMemory()
    await settled()
    fireEvent.change(query(), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
    fireEvent.keyDown(query(), { key: 'Enter' })   // Enter bypasses the disabled button
    expect(api.memorySearch).not.toHaveBeenCalled()
  })

  it('reports "0 results" and renders no list when nothing matches', async () => {
    renderMemory()
    await settled()
    fireEvent.change(query(), { target: { value: 'nothing at all' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('0 results')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('treats a successful search with no payload as no results', async () => {
    api.memorySearch.mockResolvedValueOnce({ success: true, data: undefined })
    renderMemory()
    await settled()
    fireEvent.change(query(), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('0 results')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('labels a result by its kind when it has no source', async () => {
    api.memorySearch.mockResolvedValueOnce({
      success: true,
      data: [{ id: 'm1', kind: 'code', source: '', content: 'export function auth() {}', score: 0.5 }],
    })
    renderMemory()
    await settled()
    fireEvent.change(query(), { target: { value: 'auth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('code')).toBeInTheDocument()
    expect(screen.getByText('export function auth() {}')).toBeInTheDocument()
  })

  it('never asks the backend to index an empty path when no repo is open', async () => {
    renderMemory({ activeCwd: '' })
    await settled()
    const btn = screen.getByRole('button', { name: /Index this repo/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Open a terminal in a repo first')
    // force the event through anyway — React must not run the handler for a disabled button,
    // so no memoryIngestCode('') ever reaches the main process
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await act(async () => { await Promise.resolve() })
    expect(api.memoryIngestCode).not.toHaveBeenCalled()
  })

  it('disables every action while a request is in flight, then re-enables them', async () => {
    let release!: (v: unknown) => void
    api.memorySearch.mockImplementationOnce(() => new Promise((r) => { release = r }))
    renderMemory()
    await settled()
    fireEvent.change(query(), { target: { value: 'auth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Inject primer' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Index past conversations/i })).toBeDisabled()
    expect(screen.getByTestId('memory-sync-choose')).toBeDisabled()

    await act(async () => { release({ success: true, data: [] }) })
    expect(screen.getByRole('button', { name: 'Search' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Inject primer' })).not.toBeDisabled()
  })
})

describe('Memory panel — primer injection', () => {
  it('normalises every newline flavour to CR and wraps the primer as one bracketed paste', async () => {
    api.memoryBuildPrimer.mockResolvedValueOnce({ success: true, data: 'a\nb\r\nc\rd' })
    renderMemory({ activeTerminalId: 't7' })
    await settled()
    fireEvent.change(query(), { target: { value: 'auth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Inject primer' }))
    await waitFor(() => expect(api.writeToTerminal).toHaveBeenCalled())
    // one paste, no stray LFs — a lone \n would submit the line early in the agent's TUI
    expect(api.writeToTerminal).toHaveBeenCalledWith('t7', '\x1b[200~a\rb\rc\rd\x1b[201~')
  })

  it('reports no relevant memory when the primer build fails outright', async () => {
    api.memoryBuildPrimer.mockResolvedValueOnce({ success: false, error: 'index offline' })
    renderMemory()
    await settled()
    fireEvent.change(query(), { target: { value: 'auth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Inject primer' }))
    expect(await screen.findByText(/No relevant memory found/i)).toBeInTheDocument()
    expect(api.writeToTerminal).not.toHaveBeenCalled()
  })
})

describe('Memory panel — ingest failures', () => {
  it('falls back to a generic message when a conversation ingest fails with no reason', async () => {
    api.memoryIngestConversations.mockResolvedValueOnce({ success: false })
    renderMemory()
    await settled()
    fireEvent.click(screen.getByRole('button', { name: /Index past conversations/i }))
    expect(await screen.findByText('Ingest failed')).toBeInTheDocument()
  })

  it('surfaces the reason a code ingest failed', async () => {
    api.memoryIngestCode.mockResolvedValueOnce({ success: false, error: 'permission denied' })
    renderMemory({ activeCwd: '/work/app' })
    await settled()
    fireEvent.click(screen.getByRole('button', { name: /Index this repo/i }))
    await waitFor(() => expect(api.memoryIngestCode).toHaveBeenCalledWith('/work/app'))
    expect(await screen.findByText('permission denied')).toBeInTheDocument()
  })

  it('falls back to a generic message when a code ingest returns no payload', async () => {
    api.memoryIngestCode.mockResolvedValueOnce({ success: true, data: null })
    renderMemory({ activeCwd: '/work/app' })
    await settled()
    fireEvent.click(screen.getByRole('button', { name: /Index this repo/i }))
    expect(await screen.findByText('Ingest failed')).toBeInTheDocument()
  })
})

describe('Memory panel — sync failures and singular/plural wording', () => {
  it('says "Sync unchanged." when the folder picker is dismissed', async () => {
    api.memoryChooseSyncDir.mockResolvedValueOnce({ success: true, data: { ...SYNC_ON, syncing: false, dir: null, devices: 0 } })
    renderMemory()
    await settled()
    fireEvent.click(screen.getByTestId('memory-sync-choose'))
    expect(await screen.findByText('Sync unchanged.')).toBeInTheDocument()
    expect(screen.getByTestId('memory-sync-choose')).toBeInTheDocument()   // still off
  })

  it('uses the singular "1 device" when this is the only machine on the brain', async () => {
    api.memoryChooseSyncDir.mockResolvedValueOnce({ success: true, data: { ...SYNC_ON, dir: '/Dropbox/mem', devices: 1 } })
    renderMemory()
    await settled()
    fireEvent.click(screen.getByTestId('memory-sync-choose'))
    expect(await screen.findByText('Syncing via /Dropbox/mem (1 device)')).toBeInTheDocument()
    expect(screen.getByText(/1 device sharing this brain/)).toBeInTheDocument()
  })

  it('falls back to a generic message when enabling sync fails with no reason', async () => {
    api.memoryChooseSyncDir.mockResolvedValueOnce({ success: false })
    renderMemory()
    await settled()
    fireEvent.click(screen.getByTestId('memory-sync-choose'))
    expect(await screen.findByText('Could not enable sync.')).toBeInTheDocument()
  })

  it('leaves sync on when turning it off fails', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: SYNC_ON })
    api.memorySetSyncDir.mockResolvedValueOnce({ success: false, error: 'store busy' })
    renderMemory()
    await waitFor(() => expect(screen.getByTestId('memory-sync-off')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('memory-sync-off'))
    await waitFor(() => expect(api.memorySetSyncDir).toHaveBeenCalledWith(null))
    expect(screen.getByTestId('memory-sync-off')).toBeInTheDocument()          // still syncing
    expect(screen.queryByText(/Sync turned off/i)).not.toBeInTheDocument()
  })

  it('warns that entries are still locked when the passphrase does not unlock them', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { ...SYNC_ON, locked: true } })
    api.memorySetSyncPassphrase.mockResolvedValueOnce({ success: true, data: { ...SYNC_ON, locked: true } })
    renderMemory()
    await waitFor(() => expect(screen.getByTestId('memory-sync-unlock')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('memory-sync-passphrase'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByTestId('memory-sync-unlock'))
    await waitFor(() => expect(api.memorySetSyncPassphrase).toHaveBeenCalledWith('wrong'))
    expect(await screen.findByText(/Some entries are still locked/i)).toBeInTheDocument()
    // the field is cleared so the next attempt starts clean
    expect(screen.getByTestId('memory-sync-passphrase')).toHaveValue('')
  })

  it('surfaces the reason a passphrase could not be applied', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: SYNC_ON })
    api.memorySetSyncPassphrase.mockResolvedValueOnce({ success: false, error: 'key derivation failed' })
    renderMemory()
    await waitFor(() => expect(screen.getByTestId('memory-sync-encrypt')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('memory-sync-passphrase'), { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByTestId('memory-sync-encrypt'))
    expect(await screen.findByText('key derivation failed')).toBeInTheDocument()
    expect(screen.getByTestId('memory-sync-encrypt')).toBeInTheDocument()      // still not encrypted
  })

  it('falls back to a generic message when a passphrase fails with no reason', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: SYNC_ON })
    api.memorySetSyncPassphrase.mockResolvedValueOnce({ success: false })
    renderMemory()
    await waitFor(() => expect(screen.getByTestId('memory-sync-encrypt')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('memory-sync-passphrase'), { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByTestId('memory-sync-encrypt'))
    expect(await screen.findByText('Could not apply passphrase.')).toBeInTheDocument()
  })

  it('stays encrypted when disabling encryption fails', async () => {
    api.memorySyncStatus.mockResolvedValueOnce({ success: true, data: { ...SYNC_ON, encrypted: true } })
    api.memoryDisableSyncEncryption.mockResolvedValueOnce({ success: false, error: 'nope' })
    renderMemory()
    await waitFor(() => expect(screen.getByTestId('memory-sync-disable-enc')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('memory-sync-disable-enc'))
    await waitFor(() => expect(api.memoryDisableSyncEncryption).toHaveBeenCalled())
    expect(screen.getByTestId('memory-sync-disable-enc')).toBeInTheDocument()  // still encrypted
    expect(screen.queryByText(/Encryption disabled/i)).not.toBeInTheDocument()
  })
})

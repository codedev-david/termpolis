import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { rightInset } from '../../../src/renderer/src/world/engine/viewMath'
import type { WorldDoc } from '../../../src/shared/world/types'
import { WorldLegend, LEGEND_ASIDE_PX, LEGEND_MAX_CARGO, LEGEND_RESERVE, LEGEND_CHIP_RESERVE, legendDefaultOpen, legendMaxHeight, legendReserve, legendReserveFrom, legendReserveScaled } from '../../../src/renderer/src/components/World/WorldLegend'
import { WorldPaneOpening, worldPaneStyle, WORLD_OPENING_BACKGROUND } from '../../../src/renderer/src/components/World/worldPane'
import { THEMES } from '../../../src/renderer/src/world/engine'
import { edge, minimal, rich } from './helpers'

/** WorldView owns the open state; this stands in for it. */
function Legend({ doc, processes, start = true }: { doc: WorldDoc; processes: boolean; start?: boolean }): JSX.Element {
  const [open, setOpen] = useState(start)
  return <WorldLegend doc={doc} processes={processes} open={open} onToggle={() => setOpen((o) => !o)} />
}

describe('the legend state', () => {
  it('starts expanded from 732 px and as a chip below it, and reserves only what it covers', () => {
    expect(legendDefaultOpen(732)).toBe(true)
    expect(legendDefaultOpen(731)).toBe(false)
    expect(legendReserve(true, 1000)).toBe(LEGEND_RESERVE)
    expect(legendReserve(true, 520)).toBe(LEGEND_CHIP_RESERVE) // opened over the map by choice: no refit
    // Opened by choice in a pane with room beside it (a w640 pane at 1366x768): the city is fitted clear of it.
    expect(LEGEND_ASIDE_PX).toBe(600)
    expect(legendReserve(true, 640)).toBe(LEGEND_RESERVE)
    expect(legendReserve(true, LEGEND_ASIDE_PX)).toBe(LEGEND_RESERVE)
    expect(legendReserve(true, LEGEND_ASIDE_PX - 1)).toBe(LEGEND_CHIP_RESERVE)
    expect(legendReserve(false, 640)).toBe(LEGEND_CHIP_RESERVE)
    expect(legendDefaultOpen(640)).toBe(false) // and it starts as the chip there
    expect(legendReserve(false, 1000)).toBe(LEGEND_CHIP_RESERVE)
    expect(LEGEND_CHIP_RESERVE).toBeLessThan(LEGEND_RESERVE)
    expect(rightInset(360, LEGEND_CHIP_RESERVE)).toBe(LEGEND_CHIP_RESERVE) // a chip is kept clear even in the narrowest pane
  })
  it('at a big monitor scale, judges the width in its own pixels and reserves its zoomed strip', () => {
    expect(legendReserveScaled(true, 1600, 1)).toBe(LEGEND_RESERVE)
    expect(legendReserveScaled(true, 1600, 1.5)).toBe(Math.ceil(LEGEND_RESERVE * 1.5))
    expect(legendReserveScaled(true, 1000, 1.5)).toBe(Math.ceil(LEGEND_RESERVE * 1.5)) // 667 of its own pixels: room beside it
    expect(legendReserveScaled(true, 870, 1.5)).toBe(Math.ceil(LEGEND_CHIP_RESERVE * 1.5)) // 580 of its own pixels: narrow
    expect(legendReserveScaled(false, 1600, 1.5)).toBe(Math.ceil(LEGEND_CHIP_RESERVE * 1.5))
  })
  it('names the width its strip is kept from (under three times the strip) only for the expanded legend with room', () => {
    expect(legendReserveFrom(true, 640, 1)).toBe(LEGEND_ASIDE_PX)
    expect(legendReserveFrom(true, 1000, 1.5)).toBe(LEGEND_ASIDE_PX * 1.5)
    // The kept strip passes rightInset with it, and only with it, in a 640 px canvas.
    expect(rightInset(640, legendReserveScaled(true, 640, 1), legendReserveFrom(true, 640, 1))).toBe(LEGEND_RESERVE)
    expect(rightInset(640, legendReserveScaled(true, 640, 1))).toBe(0)
    expect(legendReserveFrom(true, 580, 1)).toBeUndefined() // narrow: the chip's footprint, the default rule
    expect(legendReserveFrom(false, 1600, 1)).toBeUndefined()
  })
  it('stops above the ask bar, keeping at least the 120 px it kept before the bar was measured', () => {
    expect(legendMaxHeight(0)).toBe('calc(100% - 120px)')
    expect(legendMaxHeight(100)).toBe('calc(100% - 120px)')
    expect(legendMaxHeight(212.4)).toBe('calc(100% - 225px)') // 12 of top gap + the bar's reserve, rounded up
    render(<WorldLegend doc={minimal()} processes={false} open onToggle={() => {}} bottom={300} />)
    expect(screen.getByTestId('world-legend').style.maxHeight).toBe('calc(100% - 312px)')
  })
  it('a collapsed legend is a chip as wide as its reserve says', () => {
    render(<Legend doc={minimal()} processes={false} start={false} />)
    const panel = screen.getByTestId('world-legend')
    expect(parseFloat(panel.style.width) + 2 * parseFloat(panel.style.right)).toBe(LEGEND_CHIP_RESERVE)
    expect(screen.queryByTestId('world-legend-body')).toBeNull()
  })
})

describe('WorldLegend', () => {
  it('lists the cargo the lines carry, the line and building meanings, and collapses', () => {
    const doc = minimal()
    doc.cargo.jobs = { shape: 'cube', color: '#ff0000', label: 'Jobs' } // in the map but on no line
    render(<Legend doc={doc} processes={false} />)
    const cargo = screen.getAllByTestId('world-legend-cargo')
    expect(cargo.map((c) => c.textContent)).toEqual(['Memory'])
    expect((cargo[0].firstChild as SVGElement).getAttribute('fill')).toBe('#6aa9ff')
    for (const t of ['Solid: a built connection', 'Dashed: planned, or a guess the code does not show', 'Green ring: tests pass', 'Amber: no tests', 'Wireframe: planned only', 'Fog: partly unknown']) {
      expect(screen.getByText(t)).toBeInTheDocument()
    }
    expect(screen.queryByText('What runs where')).toBeNull() // processes layer off
    const toggle = screen.getByTestId('world-legend-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('world-legend-body')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByTestId('world-legend-body')).toBeInTheDocument()
  })

  it('reserves its width and both margins on the right of the map', () => {
    render(<Legend doc={minimal()} processes={false} />)
    const panel = screen.getByTestId('world-legend')
    expect(LEGEND_RESERVE).toBe(parseFloat(panel.style.width) + 2 * parseFloat(panel.style.right))
  })

  it('with the processes layer on, names the programs the buildings run in, in their colours', () => {
    const doc = minimal()
    doc.processes.unused = { label: 'Nobody', color: '#000000' }
    render(<Legend doc={doc} processes />)
    expect(screen.getByText('What runs where')).toBeInTheDocument()
    const procs = screen.getAllByTestId('world-legend-process')
    expect(procs.map((p) => p.textContent)).toEqual(['Main process', 'Memory host'])
    expect((procs[0].lastChild as HTMLElement).style.color).toBe('rgb(136, 136, 255)')
  })

  it('on a big project lists the busiest cargo, up to the cap, and counts the rest', () => {
    const doc = minimal()
    doc.edges = []
    doc.cargo = {}
    // c0..c13: cargo ck rides on k + 1 lines, so c13 is the busiest; c0 and c1 tie at the bottom.
    for (let k = 0; k < 14; k++) {
      doc.cargo[`c${k}`] = { shape: 'cube', color: '#123456', label: `Cargo ${k}` }
      for (let n = 0; n <= k; n++) doc.edges.push(edge(`e${k}-${n}`, 'b1', 'b2', { cargo: `c${k}` }))
    }
    doc.cargo.tie = { shape: 'cube', color: '#123456', label: 'Tie' }
    doc.edges.push(edge('t1', 'b1', 'b2', { cargo: 'tie' }), edge('t2', 'b1', 'b2', { cargo: 'tie' }))
    render(<Legend doc={doc} processes={false} />)
    const cargo = screen.getAllByTestId('world-legend-cargo').map((c) => c.textContent)
    expect(cargo).toHaveLength(LEGEND_MAX_CARGO)
    expect(cargo[0]).toBe('Cargo 13')
    expect(cargo[LEGEND_MAX_CARGO - 1]).toBe('Cargo 4')
    expect(screen.getByTestId('world-legend-cargo-more')).toHaveTextContent('+5 more on fewer lines')
  })

  it('leaves out the cargo heading when no line carries known cargo, and the programs when none is known', () => {
    const doc = rich()
    doc.edges = [edge('e9', 'b1', 'b2', { cargo: 'nope' })]
    doc.processes = {}
    render(<Legend doc={doc} processes />)
    expect(screen.queryByText("What's moving on the lines")).toBeNull()
    expect(screen.queryByText('What runs where')).toBeNull()
    expect(screen.getByText('Lines')).toBeInTheDocument()
  })
})

describe('worldPane', () => {
  it('frames the pane as a column of the given width with the given opaque background', () => {
    expect(worldPaneStyle('#123456', 480)).toMatchObject({ position: 'relative', width: 480, background: '#123456' })
  })

  it('opens in the Neon background, the theme the pane starts in', () => {
    expect(WORLD_OPENING_BACKGROUND).toBe(THEMES.neon.background)
    render(<WorldPaneOpening width={500} overlay={null} onClose={() => {}} />)
    expect(screen.getByTestId('world-view-opening')).toHaveStyle({ width: '500px', background: '#03050a' })
    expect(screen.getByRole('status')).toHaveTextContent('Opening Lumopolis…')
  })
})

describe('WorldLegend cargo shapes', () => {
  it('draws each cargo shape in its colour', () => {
    const doc = minimal()
    doc.cargo = {
      a: { shape: 'cube', color: '#111111', label: 'A' }, b: { shape: 'sphere', color: '#222222', label: 'B' },
      c: { shape: 'octa', color: '#333333', label: 'C' }, d: { shape: 'tetra', color: '#444444', label: 'D' },
    }
    doc.edges = ['a', 'b', 'c', 'd'].map((k) => edge('e' + k, 'b1', 'b2', { cargo: k }))
    const { container } = render(<Legend doc={doc} processes={false} />)
    for (const [shape, color] of [['cube', '#111111'], ['sphere', '#222222'], ['octa', '#333333'], ['tetra', '#444444']]) {
      expect(container.querySelector(`[data-shape="${shape}"]`)?.getAttribute('fill')).toBe(color)
    }
  })
})

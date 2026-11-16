import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorldLegend, LEGEND_MAX_CARGO } from '../../../src/renderer/src/components/World/WorldLegend'
import { WorldPaneOpening, worldPaneStyle, WORLD_OPENING_BACKGROUND } from '../../../src/renderer/src/components/World/worldPane'
import { THEMES } from '../../../src/renderer/src/world/engine'
import { TITLE_BAR_HEIGHT } from '../../../src/renderer/src/components/TitleBar/constants'
import { edge, minimal, rich } from './helpers'

describe('WorldLegend', () => {
  it('lists the cargo the lines carry, the line and building meanings, and collapses', () => {
    const doc = minimal()
    doc.cargo.jobs = { shape: 'cube', color: '#ff0000', label: 'Jobs' } // in the map but on no line
    render(<WorldLegend doc={doc} processes={false} />)
    const cargo = screen.getAllByTestId('world-legend-cargo')
    expect(cargo.map((c) => c.textContent)).toEqual(['Memory'])
    expect((cargo[0].firstChild as HTMLElement).style.background).toBe('rgb(106, 169, 255)')
    for (const t of ['Solid: a built connection', 'Dashed: planned or a guess', 'Green ring: tests pass', 'Amber: no tests', 'Wireframe: planned only', 'Fog: partly unknown']) {
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

  it('with the processes layer on, names the programs the buildings run in, in their colours', () => {
    const doc = minimal()
    doc.processes.unused = { label: 'Nobody', color: '#000000' }
    render(<WorldLegend doc={doc} processes />)
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
    render(<WorldLegend doc={doc} processes={false} />)
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
    render(<WorldLegend doc={doc} processes />)
    expect(screen.queryByText("What's moving on the lines")).toBeNull()
    expect(screen.queryByText('What runs where')).toBeNull()
    expect(screen.getByText('Lines')).toBeInTheDocument()
  })
})

describe('worldPane', () => {
  it('frames the pane below the title bar with the given opaque background', () => {
    expect(worldPaneStyle('#123456')).toMatchObject({ position: 'fixed', top: TITLE_BAR_HEIGHT, left: 0, right: 0, bottom: 0, background: '#123456' })
  })

  it('opens in the Neon background, the theme the pane starts in', () => {
    expect(WORLD_OPENING_BACKGROUND).toBe(THEMES.neon.background)
    render(<WorldPaneOpening />)
    expect(screen.getByTestId('world-view-opening')).toHaveStyle({ top: '40px', background: '#03050a' })
    expect(screen.getByRole('status')).toHaveTextContent('Opening Lumopolis…')
  })
})

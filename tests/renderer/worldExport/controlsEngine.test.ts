// The page's theme list and first layer states come from the engine (THEMES, DEFAULT_LAYERS), not a copy in
// controls.ts: here the engine's constants are changed, and the controls must follow them.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldViewer } from '../../../src/renderer/src/world/engine'
import { buildPage } from '../../../src/world-export/controls'
import { rich } from '../world/helpers'

vi.mock('../../../src/renderer/src/world/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/src/world/engine')>()
  return {
    ...real,
    THEMES: { ...real.THEMES, midnight: real.THEMES.neon },
    DEFAULT_LAYERS: { labels: 'tech', processes: true, allLineLabels: true, planned: false, proposal: null },
  }
})

afterEach(() => { document.body.innerHTML = ''; document.head.innerHTML = '' })

describe('controls follow the engine constants', () => {
  it('lists every engine theme and starts each layer control on DEFAULT_LAYERS', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const page = buildPage(parent, rich(), { project: 'P', exportedOn: '2026-11-21', head7: 'abc1234', dirty: false })
    const viewer = { setLayers: vi.fn(), setTheme: vi.fn(), setRightReserve: vi.fn(), setBottomReserve: vi.fn(), setCardReserve: vi.fn(), setPaused: vi.fn(), resetView: vi.fn(), setLabelScale: vi.fn(), setPanels: vi.fn() }
    page.attach(viewer as unknown as WorldViewer)
    const theme = parent.querySelector('[data-control="theme"]') as HTMLSelectElement
    expect(Array.from(theme.options, (o) => [o.value, o.textContent])).toEqual([['neon', 'Neon'], ['blueprint', 'Blueprint'], ['glass', 'Glass'], ['midnight', 'Midnight']])
    expect(theme.value).toBe('neon')
    expect((parent.querySelector('[data-control="labels"]') as HTMLSelectElement).value).toBe('tech')
    const box = (layer: string): boolean => (parent.querySelector(`[data-layer="${layer}"]`) as HTMLInputElement).checked
    expect([box('processes'), box('allLineLabels'), box('planned')]).toEqual([true, true, false])
  })
})

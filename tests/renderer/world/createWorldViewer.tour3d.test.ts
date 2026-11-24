// The first-run tour "How it fits together" over the real 3D renderer (three.js on a stand-in WebGL renderer): each
// step names a district, as compile builds it (compile.ts buildTours). Before T1 the camera could not frame a district
// id (it stayed still) and the lit set held only the district id, which dims every building.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as THREE from 'three'
import { createWorldViewer } from '../../../src/renderer/src/world/engine/createWorldViewer'
import { ACTION_GAP_MS } from '../../../src/renderer/src/world/engine/actionQueue'
import { boxCanvas, sceneOf, withHarness } from './threeHarness'
import { rich } from './helpers'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

const h = withHarness()
afterEach(() => { vi.useRealTimers() })

/** How many of the building materials the focus leaves at full strength (1), and how many it dims. */
function litAndDimmed(): { lit: number; dimmed: number } {
  let lit = 0
  let dimmed = 0
  sceneOf().traverse((o) => {
    const mats = (o as THREE.Mesh).material
    for (const m of mats === undefined ? [] : Array.isArray(mats) ? mats : [mats]) {
      const f = (m as THREE.Material).userData.f as number | undefined
      if (f === 1) lit++
      else if (f !== undefined && f < 0.5) dimmed++
    }
  })
  return { lit, dimmed }
}

describe('the tour "How it fits together" on the 3D map', () => {
  it('moves the camera to each district and lights its buildings, never dimming them all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // WebGL is there (hasWebGL's probe); jsdom's 2D canvas is not, as the harness has it.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) => (type === '2d' ? null : { getExtension: () => null })) as never)
    const doc = rich()
    doc.districts.push({ id: 'd3', name: 'Store', subtitle: 'Keeps things', hue: 200, members: [], nameState: 'observed' })
    doc.buildings.find((b) => b.id === 'b3')!.districtId = 'd3'
    const cards: (string | null)[] = []
    const viewer = createWorldViewer(h.host, { reducedMotion: true, renderCard: (html) => { cards.push(html) } })
    boxCanvas(h.host.querySelector('canvas') as HTMLCanvasElement, 800, 600)
    viewer.load(doc)
    h.frames.run(30)
    const overview = viewer.cameraState()
    expect(overview).not.toBeNull()

    const done = viewer.apply({ type: 'tour', steps: [{ ids: ['d1'], caption: 'Main' }, { ids: ['d2'], caption: 'Empty' }, { ids: ['d3'], caption: 'Store' }] })
    await vi.advanceTimersByTimeAsync(0)
    h.frames.run(5)
    const atD1 = viewer.cameraState()
    expect(atD1).not.toEqual(overview) // the camera moved
    expect(cards[cards.length - 1]).toBe('<p class="tour-caption">Main</p>')
    const d1 = litAndDimmed()
    expect(d1.lit).toBeGreaterThan(0) // d1's buildings stay lit
    expect(d1.dimmed).toBeGreaterThan(0) // and b3 (in d3) is dimmed

    await vi.advanceTimersByTimeAsync(ACTION_GAP_MS * 2) // d2 has no buildings: passed over, on to d3
    h.frames.run(5)
    expect(cards[cards.length - 1]).toBe('<p class="tour-caption">Store</p>')
    expect(viewer.cameraState()).not.toEqual(atD1)
    expect(litAndDimmed().lit).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(ACTION_GAP_MS * 2)
    await done
    h.frames.run(5)
    expect(cards[cards.length - 1]).toBeNull() // the finished tour takes its caption down
    expect(litAndDimmed().dimmed).toBe(0) // and its highlight
    viewer.dispose()
  })
})

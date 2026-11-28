import { describe, it, expect, vi, afterEach } from 'vitest'
import { forgetHardwareWebgl, hasHardwareWebgl, warmHardwareWebgl } from '../../src/renderer/src/lib/webglSupport'

/**
 * Builds a fake WebGL2 context. `loseContext` is the assertion target for the leak fix:
 * the probe must hand its context back rather than leaving it live until GC.
 */
function fakeGl(opts: { renderer?: string | null; noDebugExt?: boolean; noLoseExt?: boolean } = {}) {
  const loseContext = vi.fn()
  const gl = {
    getExtension: vi.fn((name: string) => {
      if (name === 'WEBGL_debug_renderer_info') return opts.noDebugExt ? null : { UNMASKED_RENDERER_WEBGL: 37446 }
      if (name === 'WEBGL_lose_context') return opts.noLoseExt ? null : { loseContext }
      return null
    }),
    getParameter: vi.fn(() => opts.renderer ?? 'NVIDIA GeForce RTX 4080'),
  }
  return { gl, loseContext }
}

function stubContext(gl: unknown) {
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => gl) as any)
}

afterEach(() => { vi.restoreAllMocks(); forgetHardwareWebgl() })

describe('hasHardwareWebgl', () => {
  it('accepts a real GPU renderer', () => {
    const { gl } = fakeGl({ renderer: 'ANGLE (NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)' })
    stubContext(gl)
    expect(hasHardwareWebgl()).toBe(true)
  })

  it.each([
    ['SwiftShader', 'Google SwiftShader'],
    ['llvmpipe', 'Mesa/X.org llvmpipe (LLVM 15.0.7, 256 bits)'],
    ['softpipe', 'Mesa softpipe'],
    ['ANGLE software', 'ANGLE (Software Adapter Direct3D11)'],
    ['Microsoft Basic Render', 'Microsoft Basic Render Driver'],
  ])('rejects the %s software rasterizer', (_label, renderer) => {
    const { gl } = fakeGl({ renderer })
    stubContext(gl)
    expect(hasHardwareWebgl()).toBe(false)
  })

  it('treats a host with no debug extension as hardware, preserving shipped behaviour', () => {
    const { gl } = fakeGl({ noDebugExt: true })
    stubContext(gl)
    expect(hasHardwareWebgl()).toBe(true)
  })

  it('returns false when the host has no WebGL2 at all', () => {
    stubContext(null)
    expect(hasHardwareWebgl()).toBe(false)
  })

  it('returns false when getContext throws', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
      throw new Error('getContext blew up')
    }) as any)
    expect(hasHardwareWebgl()).toBe(false)
  })

  // The leak this module exists to prevent: browsers cap live WebGL contexts and evict the
  // oldest, so a probe context left alive can push a real terminal's renderer out and drop
  // that pane to the slow DOM renderer mid-session.
  it('releases the probe context on the hardware path', () => {
    const { gl, loseContext } = fakeGl({ renderer: 'NVIDIA GeForce RTX 4080' })
    stubContext(gl)
    hasHardwareWebgl()
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  it('releases the probe context on the software-rasterizer path too', () => {
    const { gl, loseContext } = fakeGl({ renderer: 'Google SwiftShader' })
    stubContext(gl)
    hasHardwareWebgl()
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  it('still answers when the host cannot release the context', () => {
    const { gl } = fakeGl({ renderer: 'NVIDIA GeForce RTX 4080', noLoseExt: true })
    stubContext(gl)
    expect(hasHardwareWebgl()).toBe(true)
  })

  // BUILDFLAKE: every terminal pane probed at mount, and each probe is a context made on the main thread with a
  // dozen round trips to the GPU process. With the GPU busy (software GL drawing the map) that was 2.5 to 4.6 s with
  // the page frozen, right as Build it opened its agent's terminal. The answer holds for the page: one probe.
  it('makes one context for the page: later probes answer from the first', () => {
    const { gl, loseContext } = fakeGl({ renderer: 'NVIDIA GeForce RTX 4080' })
    const spy = stubContext(gl)
    expect(hasHardwareWebgl()).toBe(true)
    expect(hasHardwareWebgl()).toBe(true)
    expect(hasHardwareWebgl()).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  it('keeps a software answer for the page too', () => {
    const spy = stubContext(fakeGl({ renderer: 'Google SwiftShader' }).gl)
    expect(hasHardwareWebgl()).toBe(false)
    expect(hasHardwareWebgl()).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('probes again after forgetHardwareWebgl', () => {
    const spy = stubContext(fakeGl({ renderer: 'NVIDIA GeForce RTX 4080' }).gl)
    expect(hasHardwareWebgl()).toBe(true)
    spy.mockImplementation((() => fakeGl({ renderer: 'Google SwiftShader' }).gl) as any)
    forgetHardwareWebgl()
    expect(hasHardwareWebgl()).toBe(false)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  // A lost context anywhere in the page (a terminal's, the map's) can mean the GPU process restarted, perhaps in
  // software, where the WebGL addon crashes: the next pane asks again.
  it('probes again once any canvas in the page loses its context', () => {
    const spy = stubContext(fakeGl({ renderer: 'NVIDIA GeForce RTX 4080' }).gl)
    expect(hasHardwareWebgl()).toBe(true)
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    try {
      canvas.dispatchEvent(new Event('webglcontextlost'))
    } finally {
      canvas.remove()
    }
    spy.mockImplementation((() => fakeGl({ renderer: 'Google SwiftShader' }).gl) as any)
    expect(hasHardwareWebgl()).toBe(false)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not keep an answer it got without a context: no WebGL2, or getContext throwing', () => {
    const spy = stubContext(null)
    expect(hasHardwareWebgl()).toBe(false)
    spy.mockImplementation((() => { throw new Error('getContext blew up') }) as any)
    expect(hasHardwareWebgl()).toBe(false)
    spy.mockImplementation((() => fakeGl({ renderer: 'NVIDIA GeForce RTX 4080' }).gl) as any)
    expect(hasHardwareWebgl()).toBe(true)
    expect(spy).toHaveBeenCalledTimes(3)
  })
})

// BUILDFLAKE, part two: keeping the answer does nothing for the page's FIRST pane, and with no terminal open (the
// Lumopolis home first, then Build it) that first pane is the agent's, mounted as the map draws in software. So the
// page asks once at start, while the GPU has nothing else to draw, and every pane after finds the answer kept.
describe('warmHardwareWebgl', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); forgetHardwareWebgl() })

  it('asks when the page is first idle, within a second, and a pane after asks nothing', () => {
    const idle = vi.fn()
    vi.stubGlobal('requestIdleCallback', idle)
    const spy = stubContext(fakeGl({ renderer: 'Google SwiftShader' }).gl)
    warmHardwareWebgl()
    expect(spy).not.toHaveBeenCalled()
    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 })
    idle.mock.calls[0][0]()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(hasHardwareWebgl()).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('falls back to a timer where there is no idle callback', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const spy = stubContext(fakeGl({ renderer: 'NVIDIA GeForce RTX 4080' }).gl)
    warmHardwareWebgl()
    expect(spy).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

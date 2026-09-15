import { describe, it, expect, vi, afterEach } from 'vitest'
import { hasHardwareWebgl } from '../../src/renderer/src/lib/webglSupport'

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

afterEach(() => { vi.restoreAllMocks() })

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

  it('does not leak a context per call across repeated probes', () => {
    const { gl, loseContext } = fakeGl({ renderer: 'NVIDIA GeForce RTX 4080' })
    stubContext(gl)
    hasHardwareWebgl()
    hasHardwareWebgl()
    hasHardwareWebgl()
    expect(loseContext).toHaveBeenCalledTimes(3)
  })
})

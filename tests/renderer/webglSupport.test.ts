import { describe, it, expect, vi, afterEach } from 'vitest'
import { askHardwareWebgl, forgetHardwareWebgl, hardwareWebglNow, hasHardwareWebgl, probeRenderer, resetHardwareWebglForTests, warmHardwareWebgl } from '../../src/renderer/src/lib/webglSupport'

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

afterEach(() => { vi.restoreAllMocks(); resetHardwareWebglForTests() })

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

// BUILDFLAKE, part two: keeping the answer did nothing for the page's first pane (Build it's agent terminal, with the
// Lumopolis home opened first), and asking on the page's thread at start froze the launch instead (the command
// palette missed its 5 s twice in 32 tries, soak 46174111555). So the app asks in a worker, off the main thread.
class FakeWorker {
  static made: FakeWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  terminate = vi.fn()
  constructor() { FakeWorker.made.push(this) }
  answer(data: unknown): void { this.onmessage?.({ data } as MessageEvent) }
  fail(): void { this.onerror?.(new Event('error')) }
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the probe worker', () => {
  afterEach(() => { FakeWorker.made = [] })

  it('warmHardwareWebgl asks the worker at once, keeps its answer, and makes no context on the page', async () => {
    const spy = stubContext(fakeGl({ renderer: 'NVIDIA GeForce RTX 4080' }).gl)
    warmHardwareWebgl(FakeWorker as unknown as new () => Worker)
    expect(FakeWorker.made).toHaveLength(1)
    expect(hardwareWebglNow()).toBeNull() // still asking: no second worker
    expect(FakeWorker.made).toHaveLength(1)
    FakeWorker.made[0].answer('ANGLE (Apple M2)')
    await flush()
    expect(FakeWorker.made[0].terminate).toHaveBeenCalled()
    expect(hardwareWebglNow()).toBe(true)
    expect(await askHardwareWebgl()).toBe(true)
    expect(FakeWorker.made).toHaveLength(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a software answer is kept as false', async () => {
    warmHardwareWebgl(FakeWorker as unknown as new () => Worker)
    const asked = askHardwareWebgl()
    FakeWorker.made[0].answer('Google SwiftShader')
    expect(await asked).toBe(false)
    expect(hardwareWebglNow()).toBe(false)
  })

  it('no context, a worker error, or a worker that cannot start is false and not kept', async () => {
    warmHardwareWebgl(FakeWorker as unknown as new () => Worker)
    const first = askHardwareWebgl()
    FakeWorker.made[0].answer(null)
    expect(await first).toBe(false)
    expect(hardwareWebglNow()).toBeNull() // the null was not kept: asked again
    expect(FakeWorker.made).toHaveLength(2)
    FakeWorker.made[1].fail()
    await flush()
    expect(hardwareWebglNow()).toBeNull() // the error was not kept either: a third ask is under way
    expect(FakeWorker.made).toHaveLength(3)
    FakeWorker.made[2].answer('')
    await flush()
    expect(hardwareWebglNow()).toBe(true) // a hidden renderer counts as hardware
    resetHardwareWebglForTests()
    warmHardwareWebgl(class { constructor() { throw new Error('no workers here') } } as unknown as new () => Worker)
    expect(await askHardwareWebgl()).toBe(false)
  })

  it('a worker whose terminate throws still answers', async () => {
    warmHardwareWebgl(FakeWorker as unknown as new () => Worker)
    FakeWorker.made[0].terminate.mockImplementation(() => { throw new Error('gone') })
    FakeWorker.made[0].answer('NVIDIA')
    expect(await askHardwareWebgl()).toBe(true)
  })

  it('an answer asked before a forget goes to its caller but is not kept', async () => {
    warmHardwareWebgl(FakeWorker as unknown as new () => Worker)
    const asked = askHardwareWebgl()
    forgetHardwareWebgl()
    FakeWorker.made[0].answer('NVIDIA')
    expect(await asked).toBe(true)
    expect(hardwareWebglNow()).toBeNull()
    expect(FakeWorker.made).toHaveLength(2)
  })

  it("a canvas in the page losing its context drops the worker's answer too", async () => {
    warmHardwareWebgl(FakeWorker as unknown as new () => Worker)
    FakeWorker.made[0].answer('NVIDIA')
    await flush()
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    canvas.dispatchEvent(new Event('webglcontextlost'))
    canvas.remove()
    expect(hardwareWebglNow()).toBeNull()
  })

  it('with no worker given, both asks probe on the page', async () => {
    const spy = stubContext(fakeGl({ renderer: 'NVIDIA GeForce RTX 4080' }).gl)
    expect(await askHardwareWebgl()).toBe(true)
    forgetHardwareWebgl()
    expect(hardwareWebglNow()).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('outside a page', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it('is false with no document, and keeps nothing', () => {
    vi.stubGlobal('document', undefined)
    expect(hasHardwareWebgl()).toBe(false)
    vi.unstubAllGlobals()
    stubContext(fakeGl({ renderer: 'NVIDIA' }).gl)
    expect(hasHardwareWebgl()).toBe(true)
  })
})

describe('probeRenderer', () => {
  it("names the renderer, '' when hidden, null with no context or a throw, and hands the context back", () => {
    const { gl, loseContext } = fakeGl({ renderer: 'Apple M2' })
    expect(probeRenderer(() => gl as never)).toBe('Apple M2')
    expect(loseContext).toHaveBeenCalledTimes(1)
    expect(probeRenderer(() => fakeGl({ noDebugExt: true }).gl as never)).toBe('')
    expect(probeRenderer(() => null)).toBeNull()
    expect(probeRenderer(() => { throw new Error('no') })).toBeNull()
  })
})

describe('webglProbe.worker', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('posts the renderer an OffscreenCanvas context names', async () => {
    const { gl } = fakeGl({ renderer: 'Google SwiftShader' })
    const getContext = vi.fn(() => gl)
    vi.stubGlobal('OffscreenCanvas', class { getContext = getContext })
    const post = vi.fn()
    vi.stubGlobal('postMessage', post)
    await import('../../src/renderer/src/lib/webglProbe.worker')
    expect(getContext).toHaveBeenCalledWith('webgl2')
    expect(post).toHaveBeenCalledWith('Google SwiftShader')
  })
})

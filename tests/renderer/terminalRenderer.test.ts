import { describe, it, expect, vi } from 'vitest'
import { setupTerminalRenderer } from '../../src/renderer/src/lib/terminalRenderer'

// A minimal Terminal stand-in: we only care that loadAddon is called (and can
// be made to throw to simulate a renderer whose activate() fails — e.g. WebGL2
// not available).
function makeTerm(loadAddon = vi.fn()) {
  return { loadAddon } as any
}

function makeWebgl() {
  return { onContextLoss: vi.fn(), dispose: vi.fn() }
}
function makeCanvas() {
  return { dispose: vi.fn() }
}

describe('setupTerminalRenderer ladder', () => {
  it('uses WebGL (fastest) when it loads cleanly', () => {
    const term = makeTerm()
    const webgl = makeWebgl()
    const onFallback = vi.fn()
    const kind = setupTerminalRenderer(term, {
      createWebgl: () => webgl,
      createCanvas: () => makeCanvas(),
      onFallback,
    })
    expect(kind).toBe('webgl')
    expect(term.loadAddon).toHaveBeenCalledTimes(1)
    expect(term.loadAddon).toHaveBeenCalledWith(webgl)
    expect(webgl.onContextLoss).toHaveBeenCalledTimes(1) // wired for runtime loss
    expect(onFallback).not.toHaveBeenCalled()
  })

  it('falls back to Canvas when WebGL activate() throws (no WebGL2)', () => {
    const webgl = makeWebgl()
    const canvas = makeCanvas()
    // loadAddon throws for the webgl addon, succeeds for canvas — mirrors xterm
    // throwing inside activate() when the GL context cannot be created.
    const loadAddon = vi.fn((addon: any) => {
      if (addon === webgl) throw new Error('WebGL2 not supported')
    })
    const term = makeTerm(loadAddon)
    const onFallback = vi.fn()
    const kind = setupTerminalRenderer(term, {
      createWebgl: () => webgl,
      createCanvas: () => canvas,
      onFallback,
    })
    expect(kind).toBe('canvas')
    expect(term.loadAddon).toHaveBeenLastCalledWith(canvas)
    expect(onFallback).toHaveBeenCalledWith('webgl', expect.any(Error))
  })

  it('falls back to DOM when both WebGL and Canvas fail', () => {
    const term = makeTerm(vi.fn(() => { throw new Error('no context') }))
    const onFallback = vi.fn()
    const kind = setupTerminalRenderer(term, {
      createWebgl: () => makeWebgl(),
      createCanvas: () => makeCanvas(),
      onFallback,
    })
    expect(kind).toBe('dom')
    expect(onFallback).toHaveBeenCalledWith('webgl', expect.any(Error))
    expect(onFallback).toHaveBeenCalledWith('canvas', expect.any(Error))
  })

  it('skips the WebGL tier when GPU is disabled, going straight to Canvas', () => {
    const term = makeTerm()
    const createWebgl = vi.fn(makeWebgl)
    const canvas = makeCanvas()
    const kind = setupTerminalRenderer(term, {
      createWebgl,
      createCanvas: () => canvas,
      disableGpu: true,
    })
    expect(kind).toBe('canvas')
    expect(createWebgl).not.toHaveBeenCalled()
    expect(term.loadAddon).toHaveBeenCalledWith(canvas)
  })

  it('uses the DOM floor when no renderer addons are provided', () => {
    const term = makeTerm()
    expect(setupTerminalRenderer(term)).toBe('dom')
    expect(term.loadAddon).not.toHaveBeenCalled()
  })

  it('disposes the WebGL addon when the GL context is lost (reverts to DOM)', () => {
    const term = makeTerm()
    const webgl = makeWebgl()
    setupTerminalRenderer(term, { createWebgl: () => webgl })
    // Fire the registered context-loss handler.
    const handler = webgl.onContextLoss.mock.calls[0][0]
    handler(new Event('webglcontextlost'))
    expect(webgl.dispose).toHaveBeenCalledTimes(1)
  })
})

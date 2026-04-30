// Verifies the Monaco bootstrap that fixes the Shell Config Files
// "Loading..." bug. The CSP-blocked-CDN regression is invisible to
// jsdom (no actual editor renders), so these tests narrowly assert
// that the configuration plumbing happens — loader.config receives a
// monaco object and MonacoEnvironment.getWorker returns a Worker
// instance — without depending on Vite's runtime worker plumbing.

import { describe, it, expect, vi } from 'vitest'
import { configureMonaco } from '../../src/renderer/src/lib/monaco-setup'

class FakeWorker {
  static instances: FakeWorker[] = []
  constructor() { FakeWorker.instances.push(this) }
}

function makeOpts() {
  const config = vi.fn()
  const monaco = { __marker: 'fake-monaco' } as const
  const scope: { MonacoEnvironment?: any } = {}
  return {
    config,
    monaco,
    scope,
    opts: {
      loader: { config },
      monaco,
      WorkerCtor: FakeWorker as unknown as new () => Worker,
      globalScope: scope as { MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker } },
    },
  }
}

describe('configureMonaco', () => {
  it('routes loader.config to the locally-bundled monaco (no CDN)', () => {
    const { config, monaco, opts } = makeOpts()
    configureMonaco(opts)
    expect(config).toHaveBeenCalledTimes(1)
    expect(config).toHaveBeenCalledWith({ monaco })
  })

  it('installs MonacoEnvironment.getWorker on the global scope', () => {
    const { scope, opts } = makeOpts()
    configureMonaco(opts)
    expect(scope.MonacoEnvironment).toBeDefined()
    expect(typeof scope.MonacoEnvironment.getWorker).toBe('function')
  })

  it('getWorker returns a fresh worker instance per call', () => {
    FakeWorker.instances.length = 0
    const { scope, opts } = makeOpts()
    configureMonaco(opts)
    const a = scope.MonacoEnvironment.getWorker('id1', 'editorWorkerService')
    const b = scope.MonacoEnvironment.getWorker('id2', 'editorWorkerService')
    expect(a).toBeInstanceOf(FakeWorker)
    expect(b).toBeInstanceOf(FakeWorker)
    expect(a).not.toBe(b)
    expect(FakeWorker.instances).toHaveLength(2)
  })

  it('falls back to self when no globalScope override is provided', () => {
    const { config, monaco } = makeOpts()
    const original = (self as any).MonacoEnvironment
    try {
      configureMonaco({
        loader: { config },
        monaco,
        WorkerCtor: FakeWorker as unknown as new () => Worker,
      })
      expect((self as any).MonacoEnvironment).toBeDefined()
      expect(typeof (self as any).MonacoEnvironment.getWorker).toBe('function')
    } finally {
      ;(self as any).MonacoEnvironment = original
    }
  })

  it('overwrites a stale MonacoEnvironment so HMR re-runs configure correctly', () => {
    const { scope, opts } = makeOpts()
    scope.MonacoEnvironment = { getWorker: () => ({} as Worker) }
    configureMonaco(opts)
    const w = scope.MonacoEnvironment.getWorker('x', 'editorWorkerService')
    expect(w).toBeInstanceOf(FakeWorker)
  })
})

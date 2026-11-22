// The leftover-temp sweep that the first prepare starts is never awaited by that prepare, so it must never reject:
// the sweep resolves on its own on every path, and the call site still answers [] if something it did not foresee
// (here, a folder listing that throws as it is walked) made it reject anyway.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'

const H = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  return { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-sweep-catch-')) }
})

vi.mock('electron', () => ({ app: { getPath: () => H.userData, isPackaged: false } }))

afterAll(() => { rmSync(H.userData, { recursive: true, force: true }) })

describe('the sweep the first prepare starts', () => {
  it('answers [] when the sweep rejects, so nothing is left unhandled', async () => {
    const fs = require('fs') as typeof import('fs')
    const walkFails = new Proxy([] as string[], {
      get: (t, k) => (k === Symbol.iterator ? () => { throw new Error('listing broke while walked') } : Reflect.get(t, k)),
    })
    const real = fs.promises.readdir
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(((dir: string, ...rest: unknown[]) =>
      dir === H.userData ? Promise.resolve(walkFails) : (real as (...a: unknown[]) => unknown)(dir, ...rest)) as typeof fs.promises.readdir)
    try {
      const { ensureIntegrationScriptAsync, integrationTempSweep, sweepStaleIntegrationTemps } = await import('../../src/main/terminalSpawnPrep')
      await expect(sweepStaleIntegrationTemps(H.userData)).rejects.toThrow('listing broke while walked') // the case the guard is for
      expect(integrationTempSweep()).toBeUndefined()
      expect(await ensureIntegrationScriptAsync()).toBe(join(H.userData, 'termpolis-shell-integration.ps1'))
      expect(await integrationTempSweep()).toEqual([])
    } finally { spy.mockRestore() }
  })
})

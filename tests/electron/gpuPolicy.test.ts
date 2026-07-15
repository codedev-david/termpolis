import { describe, it, expect } from 'vitest'
import { gpuPolicy } from '../../src/main/gpuPolicy'

const env = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv

describe('gpuPolicy — Linux GPU is no longer force-disabled for everyone', () => {
  it('Linux default: VAAPI off (the targeted black-window fix), GPU ON so WebGL works', () => {
    const p = gpuPolicy('linux', env())
    expect(p.disableVaapi).toBe(true)
    expect(p.disableHardwareAcceleration).toBe(false)
    expect(p.disableGpuSwitch).toBe(false)
  })

  it('Linux with TERMPOLIS_DISABLE_GPU=1: full software fallback (the escape hatch is now LIVE)', () => {
    const p = gpuPolicy('linux', env({ TERMPOLIS_DISABLE_GPU: '1' }))
    expect(p.disableVaapi).toBe(true)
    expect(p.disableHardwareAcceleration).toBe(true)
    expect(p.disableGpuSwitch).toBe(true)
  })

  it('Windows/macOS: no VAAPI switch, GPU untouched by default', () => {
    for (const plat of ['win32', 'darwin']) {
      const p = gpuPolicy(plat, env())
      expect(p).toEqual({ disableVaapi: false, disableHardwareAcceleration: false, disableGpuSwitch: false })
    }
  })

  it('the escape hatch is honoured off-Linux too', () => {
    const p = gpuPolicy('win32', env({ TERMPOLIS_DISABLE_GPU: '1' }))
    expect(p.disableHardwareAcceleration).toBe(true)
    expect(p.disableGpuSwitch).toBe(true)
  })
})

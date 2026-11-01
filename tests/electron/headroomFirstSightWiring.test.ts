import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * How the main process hands the first-sight policy to the proxy. The boot block that does it sits
 * behind `fileURLToPath(new URL(..., import.meta.url))`, which throws under vitest, so no suite can
 * run it (the launch tier log is held the same way, in headroomTierLogWiring.test.ts); what it does
 * is tested where it lands (headroomFirstSightTransport, headroomFirstSightSettings) and its shape is
 * held here at the source. The settings-change handler and the status handler ARE run, in
 * cov-main-index.test.ts.
 */

const SRC = join(__dirname, '..', '..', 'src', 'main')
const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
const count = (needle: string): number => index.split(needle).length - 1

describe('the first-sight policy in the boot block', () => {
  const PUSH = 'setProxyFirstSight(hs.firstSightElision)'

  it('is pushed once, from the settings the block has just read', () => {
    expect(count('setProxyFirstSight(')).toBe(1)
    expect(index).toContain(PUSH)
  })

  it('is pushed before anything is resolved from it and before the proxy can start', () => {
    const settings = index.indexOf('const hs = getHeadroomSettings()\n        let wireMode = hs.mode')
    const pushed = index.indexOf(PUSH)
    const resolved = index.indexOf('wireMode = resolveWireMode(wireMode, cum, getProxyFirstSight())')
    const tier = index.indexOf('setProxyMode(wireMode)')
    const logged = index.indexOf('describeWireTier(')
    const started = index.indexOf('if (getHeadroomSettings().wireProxy) ensureHeadroomProxy()')
    expect(settings).toBeGreaterThan(0)
    expect(pushed).toBeGreaterThan(settings)
    expect(resolved).toBeGreaterThan(pushed)
    expect(tier).toBeGreaterThan(resolved)
    expect(logged).toBeGreaterThan(tier)
    expect(started).toBeGreaterThan(logged)
  })

  it('is pushed whether or not floor control is on, and whether or not the proxy is switched on', () => {
    // Not inside the `if (hs.floorControl)` block, and before the wireProxy check.
    const pushed = index.indexOf(PUSH)
    const floorBlock = index.indexOf('if (hs.floorControl) {')
    expect(pushed).toBeLessThan(floorBlock)
  })

  it('is logged with the launch tier, as the policy in force rather than the one selected', () => {
    expect(index).toContain("logToApp('info', 'main', [describeWireTier(hs.mode, wireMode, hs.floorControl, getProxyFirstSight())])")
  })
})

describe('the savings-floor controller is given the policy in force at both of its call sites', () => {
  it('has exactly two calls, both passing getProxyFirstSight()', () => {
    expect(count('resolveWireMode(')).toBe(2)
    expect(count('resolveWireMode(next.mode, summarizeProxySavings().cumulative, getProxyFirstSight())')).toBe(1)
    expect(count('resolveWireMode(wireMode, cum, getProxyFirstSight())')).toBe(1)
  })
})

describe('the proxy status', () => {
  it('reports the policy selected in Settings and the one the proxy runs, which may differ until a restart', () => {
    expect(index).toContain('selectedFirstSight: hs.firstSightElision, effectiveFirstSight: getProxyFirstSight()')
  })
})

describe('a Settings change to the policy', () => {
  it('is not pushed to the running proxy: it is frozen for the run and takes effect at the next start', () => {
    // The only push is the boot one. The settings handler saves the choice and changes nothing live.
    const handler = index.slice(index.indexOf("ipcMain.handle('tokenSavings:set-settings'"), index.indexOf("ipcMain.handle('tokenSavings:get-receipt'"))
    expect(handler.length).toBeGreaterThan(200)
    expect(handler).not.toContain('setProxyFirstSight')
    expect(handler).toContain('saveSettingsToDisk(hrDir)')
  })
})

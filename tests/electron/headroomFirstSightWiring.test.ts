import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * How the main process hands the first-sight policy to the proxy. The boot block that does it cannot
 * run in the suites that mock the supervisor or the folder (the launch tier log is held the same way,
 * in headroomTierLogWiring.test.ts), so its shape is held here at the source. What it does is pinned
 * where it runs for real: mainAgentIntegrationIpc.test.ts ('the compression proxy at launch') checks the
 * order of the pushes and that the saved policy, not a constant, is handed over; the effect is tested
 * where it lands (headroomFirstSightTransport, headroomFirstSightSettings). The settings-change handler
 * and the status handler ARE run, in cov-main-index.test.ts.
 */

const SRC = join(__dirname, '..', '..', 'src', 'main')
// The needles below run over two lines and end each in LF. A Windows checkout hands the file over with
// CRLF (git's default there is core.autocrlf=true, and the unit job runs on windows-latest), so the
// text is read as LF whatever the checkout gave it.
const sourceOf = (text: string): string => text.replace(/\r\n/g, '\n')
const index = sourceOf(readFileSync(join(SRC, 'index.ts'), 'utf8'))
const count = (needle: string): number => index.split(needle).length - 1

const PUSH = 'setProxyFirstSight(hs.firstSightElision)'
const bootBlockOrder = (source: string): Record<'settings' | 'pushed' | 'resolved' | 'tier' | 'logged' | 'started', number> => ({
  settings: source.indexOf('const hs = getHeadroomSettings()\n        let wireMode = hs.mode'),
  pushed: source.indexOf(PUSH),
  resolved: source.indexOf('wireMode = resolveWireMode(wireMode, cum, getProxyFirstSight())'),
  tier: source.indexOf('setProxyMode(wireMode)'),
  logged: source.indexOf('describeWireTier('),
  started: source.indexOf('if (getHeadroomSettings().wireProxy) ensureHeadroomProxy()'),
})
const expectInOrder = (o: ReturnType<typeof bootBlockOrder>): void => {
  expect(o.settings).toBeGreaterThan(0)
  expect(o.pushed).toBeGreaterThan(o.settings)
  expect(o.resolved).toBeGreaterThan(o.pushed)
  expect(o.tier).toBeGreaterThan(o.resolved)
  expect(o.logged).toBeGreaterThan(o.tier)
  expect(o.started).toBeGreaterThan(o.logged)
}

describe('the first-sight policy in the boot block', () => {
  it('is pushed once, from the settings the block has just read', () => {
    expect(count('setProxyFirstSight(')).toBe(1)
    expect(index).toContain(PUSH)
  })

  it('is pushed before anything is resolved from it and before the proxy can start', () => {
    expectInOrder(bootBlockOrder(index))
  })

  it('is found in the same order in a file a Windows checkout gave CRLF line ends', () => {
    const crlf = index.replace(/\n/g, '\r\n')
    expect(crlf).toContain('\r\n')
    expectInOrder(bootBlockOrder(sourceOf(crlf)))
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

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The resolved wire tier is logged once at launch, from the main process (R1 criterion 7). The
 * boot block that does it cannot run in the suites that mock the supervisor or the folder (cov-main-index
 * gets a string for app.getPath, and the block throws before it), so this holds its shape at the source
 * the way noWholeFileJsonlRead holds its. The block DOES run, for real and on a real folder, in
 * mainAgentIntegrationIpc.test.ts ('the compression proxy at launch'), which pins what it does: the
 * order of the pushes, the saved policy it hands over, and the one line it logs. What the line SAYS is
 * tested in headroomWireTier.test.ts.
 */

const SRC = join(__dirname, '..', '..', 'src', 'main')
const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
const CALL = "logToApp('info', 'main', [describeWireTier(hs.mode, wireMode, hs.floorControl, getProxyFirstSight())])"

describe('the launch tier log', () => {
  it('is one call, and it logs the resolved tier, not the selected one', () => {
    expect(index.split('describeWireTier(').length - 1).toBe(1)
    expect(index).toContain(CALL)
  })

  it('comes after the resolved mode is pushed to the proxy and before the proxy is started', () => {
    const pushed = index.indexOf('setProxyMode(wireMode)')
    const logged = index.indexOf(CALL)
    const started = index.indexOf('if (getHeadroomSettings().wireProxy) ensureHeadroomProxy()')
    expect(pushed).toBeGreaterThan(0)
    expect(logged).toBeGreaterThan(pushed)
    expect(started).toBeGreaterThan(logged)
  })

  it('is the last statement of the block that pushes the config, so a failure there skips nothing', () => {
    const at = index.indexOf(CALL)
    const before = index.slice(index.lastIndexOf('setProxyMode(wireMode)', at), at)
    for (const push of ['setProxyThinkingCap(hs.thinkingCap)', 'setProxyDecay(hs.prefixDecay)', 'setProxyEnabled(hs.wireProxy)']) {
      expect(before).toContain(push)
    }
  })

  it('is not in the transform path: nothing the proxy imports knows the app log', () => {
    for (const rel of ['headroomProxy/proxyMain.ts', 'headroomProxy/wireCompress.ts', 'headroomProxy/usageParse.ts', 'headroomProxy/forwardedKinds.ts', 'headroomProxy/prefixDecay.ts']) {
      expect(readFileSync(join(SRC, rel), 'utf8')).not.toMatch(/logToApp|appLog/)
    }
  })
})

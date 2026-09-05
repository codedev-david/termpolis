/**
 * Termpolis Remote -- the desktop half, driven in the built app.
 *
 * The unit suites cover the bridge, the relay and the phone in isolation. What
 * none of them can show is that the Settings pane, the IPC layer, the settings
 * file and the forked utilityProcess are wired to each other in a real build:
 * every one of those seams is mocked somewhere. This spec clicks through the
 * pane the way a user would and asserts what has to be true of a shipped build.
 *
 * The relay is pointed at a dead local port on purpose. Pairing does not need a
 * live one -- the offer is minted inside the bridge and drawn as a QR before any
 * relay round trip -- so a QR appearing over an unreachable relay is proof the
 * offer came from the forked child over the sealed host channel, and not from a
 * hopeful renderer.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import { e2eLaunchArgs, dismissOnboarding } from './helpers/launch'

/** Discard port on loopback: valid to `new URL()`, refused instantly, never routed. */
const DEAD_RELAY = 'ws://127.0.0.1:9/ws'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  app = await electron.launch({
    args: e2eLaunchArgs('remote-settings'),
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1' },
  })
  page = await app.firstWindow()
  await dismissOnboarding(page)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
})

test.afterAll(async () => {
  if (app) await app.close()
})

test.describe.serial('Remote settings', () => {
  test('1. the Remote tab opens and its status arrives', async () => {
    await page.locator('button[title="Settings"]').click()
    await expect(page.locator('[data-testid="settings-tabs"]')).toBeVisible()
    await page.locator('[data-testid="settings-tab-remote"]').click()

    await expect(page.locator('[data-testid="remote-settings"]')).toBeVisible()
    // Loading is a third render state with no switch in it. Waiting for the
    // switch means the status IPC round trip completed rather than hanging.
    await expect(page.locator('[data-testid="remote-enable"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="remote-unavailable"]')).toHaveCount(0)
  })

  test('2. remote is off, with nothing paired, on a fresh profile', async () => {
    // The default the whole feature rests on. A build that shipped this switch
    // on would put every terminal in the window on a relay unasked.
    await expect(page.locator('[data-testid="remote-enable"]')).not.toBeChecked()
    await expect(page.locator('[data-testid="remote-no-devices"]')).toBeVisible()
  })

  test('3. the relay address round trips through the main process', async () => {
    const field = page.locator('[data-testid="remote-relay-url"]')
    await expect(field).toHaveValue(/^wss:\/\//)

    await field.fill(DEAD_RELAY)
    await page.locator('[data-testid="remote-relay-save"]').click()
    // The field follows the SAVED value once the draft clears, so this reads
    // back what main validated and wrote to disk, not what was typed into it.
    await expect(field).toHaveValue(DEAD_RELAY, { timeout: 10000 })
    await expect(page.locator('[data-testid="remote-error"]')).toHaveCount(0)
  })

  test('4. turning it on forks the bridge without complaint', async () => {
    await page.locator('[data-testid="remote-enable"]').check()
    await expect(page.locator('[data-testid="remote-enable"]')).toBeChecked({ timeout: 15000 })
    // A dead relay is not an error state: the client redials in the background
    // and the pane says so in its status text. A banner here would mean the
    // child died, which is the failure this test exists to catch.
    await expect(page.locator('[data-testid="remote-error"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="remote-disabled-banner"]')).toHaveCount(0)
  })

  test('5. Pair a device shows an offer minted inside the bridge', async () => {
    await page.locator('[data-testid="remote-pair-label"]').fill('E2E phone')
    await page.locator('[data-testid="remote-pair-button"]').click()

    await expect(page.locator('[data-testid="pairing-modal"]')).toBeVisible({ timeout: 20000 })
    // Either shape passes: the QR is an SVG, and the fallback is the same
    // payload as text for a terminal that cannot draw one.
    const qr = page.locator('[data-testid="pairing-qr"], [data-testid="pairing-qr-fallback"]')
    await expect(qr.first()).toBeVisible({ timeout: 20000 })
    await expect(page.locator('[data-testid="pairing-countdown"]')).toBeVisible()
  })

  test('6. closing the modal withdraws the offer without an error', async () => {
    await page.locator('[data-testid="pairing-close"]').click()
    await expect(page.locator('[data-testid="pairing-modal"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="remote-error"]')).toHaveCount(0)
    // Nothing paired, because nothing answered the offer.
    await expect(page.locator('[data-testid="remote-no-devices"]')).toBeVisible()
  })

  test('7. the only key on screen is the public one', async () => {
    // The same invariant the phone screens are held to. The renderer is handed
    // a status object main rebuilds field by field; if a refactor ever widened
    // that to the raw device record, the secret would show up here as a second
    // 64 hex run. The desktop public key is shown on purpose -- it is what the
    // user reads out to compare against the phone -- so the assertion is that
    // it is the ONLY one, not that there is none.
    const pane = page.locator('[data-testid="remote-settings"]')
    const text = (await pane.innerText()).replace(/\s+/g, ' ')
    const keys = text.match(/[0-9a-f]{64}/gi) ?? []
    const shown = (await page.locator('[data-testid="remote-public-key"]').innerText()).trim()

    expect(keys).toHaveLength(1)
    expect(shown).toContain(keys[0])
  })

  test('8. turning it off stops the bridge and leaves nothing behind', async () => {
    // Also the teardown for this file: a live utilityProcess still holding a
    // socket is exactly the kind of thing that turns app.close() into a hang.
    await page.locator('[data-testid="remote-enable"]').uncheck()
    await expect(page.locator('[data-testid="remote-enable"]')).not.toBeChecked({ timeout: 15000 })
    await expect(page.locator('[data-testid="remote-error"]')).toHaveCount(0)
  })
})

/**
 * Linked machines -- Settings ▸ Linked machines, driven in the built app.
 *
 * The unit suites join two bridge cores through an in-memory relay. What none
 * of them can show is that the pane, the preload's `window.linked`, the IPC
 * handlers, linkedHost and the forked bridge child are wired to each other in a
 * real build: every one of those seams is mocked somewhere. This spec clicks
 * through the pane the way a user would, on ONE instance. Linking two machines
 * for real needs the live relay and installed agents, so that proof lives in
 * e2e/manual/linked-machines-real.spec.ts.
 *
 * The relay is a dead loopback port on purpose. A link code, like the phone's
 * QR, is minted inside the bridge before any relay round trip, so a code that
 * appears over an unreachable relay came from the forked child. So does the
 * refusal of a computer's own code: only the child knows its public key.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { e2eLaunchArgs, e2eUserDataDir, dismissOnboarding } from './helpers/launch'

/** Discard port on loopback: refused instantly, never routed. Still a relay a
 *  link code may name -- plain ws:// is accepted on loopback only. */
const DEAD_RELAY = 'ws://127.0.0.1:9/ws'
const LABEL = 'linked-machines'
const LINK_PREFIX = 'termpolis-link:'

let app: ElectronApplication
let page: Page
/** The code the bridge minted in test 4, for the tests after it. */
let code = ''

const byId = (id: string) => page.locator(`[data-testid="${id}"]`)

/** What main persisted for the switch, read off disk. */
function savedLinkedSetting(): unknown {
  return JSON.parse(fs.readFileSync(path.join(e2eUserDataDir(LABEL), 'linked-settings.json'), 'utf8'))
}

test.beforeAll(async () => {
  // The build alone can take most of the default 120 s on a cold machine.
  test.setTimeout(300_000)
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // Linked machines dials Remote's relay, so the address is Remote's setting,
  // seeded before first launch. TERMPOLIS_RELAY_URL is set too, but alone it
  // would not reach the bridge: the supervisor overwrites it from this setting
  // on every fork.
  fs.writeFileSync(
    path.join(e2eUserDataDir(LABEL), 'remote-settings.json'),
    JSON.stringify({ enabled: false, relayUrl: DEAD_RELAY }),
  )

  app = await electron.launch({
    args: e2eLaunchArgs(LABEL),
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_RELAY_URL: DEAD_RELAY },
  })
  page = await app.firstWindow()
  await dismissOnboarding(page)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
})

test.afterAll(async () => {
  // Best effort, for a run that failed before test 9 switched it off: a bridge
  // left dialing is exactly what turns app.close() into a hang.
  await page
    ?.evaluate(() => (window as unknown as { linked?: { setEnabled(on: boolean): Promise<unknown> } }).linked?.setEnabled(false))
    .catch(() => {})
  if (app) await app.close()
})

test.describe.serial('Linked machines settings', () => {
  test('1. the Linked machines tab opens and its status arrives', async () => {
    await page.locator('button[title="Settings"]').click()
    await expect(byId('settings-tabs')).toBeVisible()
    await byId('settings-tab-linked').click()

    await expect(byId('linked-settings')).toBeVisible()
    // Neither the loading state nor the "not running in this session" notice
    // has a switch in it, so the switch means the status round trip completed.
    await expect(byId('linked-enable')).toBeVisible({ timeout: 15000 })
    await expect(byId('linked-unavailable')).toHaveCount(0)
  })

  test('2. it is off on a fresh profile, with nothing linked and nothing to pair with', async () => {
    // The default the feature rests on (spec §3.1): while it is off nothing
    // connects anywhere, so there is nothing to pair with either.
    await expect(byId('linked-enable')).not.toBeChecked()
    await expect(byId('linked-running')).toHaveText('')
    await expect(byId('linked-off-note')).toBeVisible()
    await expect(byId('linked-create-code')).toHaveCount(0)
    await expect(byId('linked-join-input')).toHaveCount(0)
    await expect(byId('linked-no-machines')).toBeVisible()
    await expect(byId('linked-no-activity')).toBeVisible()
    await expect(byId('linked-this-machine')).not.toHaveText('')
  })

  test('3. turning it on starts the bridge without complaint', async () => {
    // click() and then the assertion, not check(): the box follows main's
    // answer, so it flips only once the IPC round trip lands, and check()
    // would race that.
    await byId('linked-enable').click()
    await expect(byId('linked-enable')).toBeChecked({ timeout: 15000 })
    // `running` means the bridge child is up with linked rooms, not that a
    // socket is open: over a dead relay the client redials in the background,
    // as Remote's indicator does. "(not connected)" would mean the child never
    // came up, which is the failure this test exists to catch.
    await expect(byId('linked-running')).toHaveText('(connected to the relay)', { timeout: 15000 })
    await expect(byId('linked-error')).toHaveCount(0)
    // The relay the bridge was started with: Remote's saved setting, read back
    // through main. Checked here rather than on first paint, because a status
    // computed before Remote's host is up names the default relay instead --
    // and a running bridge means the host is up.
    await expect(byId('linked-relay')).toHaveText(DEAD_RELAY, { timeout: 15000 })
    await expect(byId('linked-create-code')).toBeEnabled()
    await expect(byId('linked-join-input')).toBeVisible()
    // Run on, write off: the grant a user gives without thinking is the harmless one.
    await expect(byId('linked-grant-new-run')).toBeChecked()
    await expect(byId('linked-grant-new-write')).not.toBeChecked()
    expect(savedLinkedSetting()).toEqual({ enabled: true })
  })

  test('4. Create code shows a termpolis-link code minted inside the bridge, with a countdown', async () => {
    await byId('linked-create-code').click()
    await expect(byId('linked-code')).toBeVisible({ timeout: 20000 })
    code = (await byId('linked-code').innerText()).trim()
    expect(code.startsWith(LINK_PREFIX)).toBe(true)
    expect(code.slice(LINK_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/)

    // The phone's offer, as text. Main only forwards what the child sends, so
    // a well-formed offer naming the configured relay is the child's work.
    const offer = JSON.parse(Buffer.from(code.slice(LINK_PREFIX.length), 'base64url').toString('utf8'))
    expect(offer).toMatchObject({ v: 1, relayUrl: DEAD_RELAY })
    expect(offer.pairingId).toMatch(/^[0-9a-f]{32}$/)
    expect(offer.desktopPublicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(offer.oneTimeSecret).toMatch(/^[0-9a-f]{64}$/)

    // Five minutes, not the phone's 90 s: the code is carried between computers.
    await expect(byId('linked-countdown')).toHaveText(/^Expires in (5:00|4:[0-5]\d)$/)
    await expect(byId('linked-copy')).toBeVisible()
    await expect(byId('linked-error')).toHaveCount(0)
    // Locked while the code is out: its grants were chosen with it.
    await expect(byId('linked-grant-new-run')).toBeDisabled()
    await expect(byId('linked-grant-new-write')).toBeDisabled()
  })

  test('5. Copy puts exactly the code on the clipboard', async () => {
    await byId('linked-copy').click()
    // Read back in main: what the user pastes on the other computer.
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5000 }).toBe(code)
    await expect(byId('linked-copy-failed')).toHaveCount(0)
  })

  test('6. a computer refuses its own code, and the bridge is what says so', async () => {
    // Main passes a well-formed code on; only the bridge child knows its own
    // public key. So the message below is a full main -> child -> main ->
    // renderer round trip, decided before any relay is dialed.
    await byId('linked-join-input').fill(code)
    await byId('linked-join-button').click()
    await expect(byId('linked-error')).toHaveText('That code was made on this computer. Enter it on the other one.', {
      timeout: 15000,
    })
    // The join is over rather than left spinning, and the code is still on offer.
    await expect(byId('linked-joining')).toHaveCount(0)
    await expect(byId('linked-join-button')).toBeVisible()
    await expect(byId('linked-code')).toHaveText(code)
    await expect(byId('linked-no-machines')).toBeVisible()
  })

  test('7. Cancel withdraws the code', async () => {
    await byId('linked-cancel-code').click()
    await expect(byId('linked-code')).toHaveCount(0, { timeout: 10000 })
    await expect(byId('linked-create-code')).toBeVisible()
    await expect(byId('linked-error')).toHaveCount(0)
    await expect(byId('linked-grant-new-run')).toBeEnabled()
  })

  test('8. a garbage code gets a clear refusal, and nothing starts', async () => {
    await byId('linked-join-input').fill('this is not a link code')
    await byId('linked-join-button').click()
    await expect(byId('linked-error')).toHaveText(
      'That is not a link code. Copy the whole code from Settings ▸ Linked machines on the other computer.',
    )
    await expect(byId('linked-joining')).toHaveCount(0)
    await expect(byId('linked-no-machines')).toBeVisible()
  })

  test('9. turning it off stops the bridge and leaves nothing behind', async () => {
    // Also the teardown for this file: a live utilityProcess still holding a
    // socket is exactly the kind of thing that turns app.close() into a hang.
    await byId('linked-enable').click()
    await expect(byId('linked-enable')).not.toBeChecked({ timeout: 15000 })
    await expect(byId('linked-running')).toHaveText('')
    await expect(byId('linked-off-note')).toBeVisible()
    await expect(byId('linked-error')).toHaveCount(0)
    expect(savedLinkedSetting()).toEqual({ enabled: false })
  })
})

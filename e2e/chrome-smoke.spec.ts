/**
 * Chrome smoke test — click every visible button in the app chrome
 * (sidebar icons, modal open/close, pane header buttons) and assert
 * that no React / window errors fire. This is the net that would have
 * caught the Apr 2026 PaneRenderer Split Right bug (silent breakage
 * from a Rules of Hooks violation).
 *
 * Purposefully shallow: does not assert deep behavior. The contract is
 * "clicking UI chrome does not explode."
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let isolatedUserData: string
const errors: string[] = []

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // Isolate from the developer's real ~/AppData/Roaming/termpolis profile.
  // Without this the test's localStorage writes (e.g. onboarding.seen = 1)
  // persist into the real install and suppress the onboarding modal on the
  // next dev launch.
  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-smoke-'))
  const clean = JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs' })
  fs.writeFileSync(path.join(isolatedUserData, 'session.json'), clean)

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
      TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`)
  })
  page.on('pageerror', err => {
    errors.push(`[pageerror] ${err.message}\n${err.stack || ''}`)
  })

  await page.waitForTimeout(1500)

  // Pre-dismiss the first-run onboarding modal so it doesn't block clicks.
  // We write the "seen" key directly; the modal mounts from that flag.
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch {}
  })
  // If the modal is already mounted, click its primary button to unmount it.
  const onboardingBtn = page.getByRole('button', { name: 'Get started' })
  if (await onboardingBtn.isVisible().catch(() => false)) {
    await onboardingBtn.click()
    await page.waitForTimeout(300)
  }
})

test.afterAll(async () => {
  if (app) await app.close()
  if (isolatedUserData) {
    try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch {}
  }
})

function isFatal(s: string): boolean {
  // Ignore known-noisy errors unrelated to UI correctness.
  const ignorable = [
    /ResizeObserver loop/i,
    /Failed to load resource/i,
    /Not allowed to load local resource/i,
    /Download the React DevTools/i,
    /autofill\.enable/i,
    /autofill\.setAddresses/i,
  ]
  if (ignorable.some(r => r.test(s))) return false
  // These are the canary patterns — any of these = test failure.
  return /Rendered (more|fewer) hooks|order of Hooks|Cannot read (properties|property) of (undefined|null)|Minified React error|Uncaught|unhandledrejection|Invariant failed/i.test(s)
}

async function createTerminalIfNeeded(name: string) {
  const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
  await addBtn.click()
  await page.waitForTimeout(400)
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)
  const createBtn = page.getByRole('button', { name: 'Create', exact: true })
  await createBtn.click()
  await page.waitForTimeout(1500)
}

async function closeAnyOpenModal() {
  // Try Escape several times + a few backdrop clicks to guarantee a clean state.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(120)
  }
  // Known modal backdrop element — click at a point clear of the sidebar
  // (x > 240) and clear of centered modal (x < 500) at mid-height.
  for (const y of [200, 400, 600]) {
    await page.mouse.click(350, y).catch(() => {})
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(300)
}

async function clickAndReturn(selector: string, closeMethod: 'escape' | 'backdrop' | 'toggle' = 'escape') {
  await closeAnyOpenModal()
  const btn = page.locator(selector).first()
  const visible = await btn.isVisible().catch(() => false)
  if (!visible) return false
  await btn.click()
  await page.waitForTimeout(600)
  if (closeMethod === 'escape') {
    await page.keyboard.press('Escape').catch(() => {})
  } else if (closeMethod === 'backdrop') {
    // Click where we're guaranteed to be outside the sidebar (x>240) and
    // outside the centered modal panel.
    await page.mouse.click(350, 400).catch(() => {})
  } else if (closeMethod === 'toggle') {
    const stillThere = await btn.isVisible().catch(() => false)
    if (stillThere) await btn.click().catch(() => {})
  }
  await page.waitForTimeout(400)
  await closeAnyOpenModal()
  return true
}

test.describe.serial('Chrome smoke', () => {
  test('1. Welcome screen renders without errors', async () => {
    const welcome = page.locator('text=Welcome to Termpolis').first()
    const visible = await welcome.isVisible({ timeout: 5000 }).catch(() => false)
    if (!visible) {
      const hasAddBtn = await page.locator('button:has-text("+ Add Terminal")').first().isVisible().catch(() => false)
      expect(hasAddBtn, 'Neither welcome nor add-terminal button visible').toBe(true)
    }
    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('2. Sidebar: Settings toggles open and closed', async () => {
    await clickAndReturn('button[title="Settings"]', 'toggle')
    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('3. Sidebar: Workflows opens and closes via backdrop', async () => {
    await clickAndReturn('button[title="Workflows"]', 'backdrop')
    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('4. Sidebar: Git Panel opens and closes via Escape', async () => {
    await clickAndReturn('button[title="Git Panel"]', 'escape')
    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('5. Sidebar collapse and expand', async () => {
    const collapseBtn = page.locator('button[title="Collapse sidebar"]').first()
    await collapseBtn.click()
    await page.waitForTimeout(400)
    const expandBtn = page.locator('button[title="Expand sidebar"]').first()
    await expandBtn.click()
    await page.waitForTimeout(400)
    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('6. Command palette: Ctrl+K open and Escape close', async () => {
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(400)
    const paletteVisible = await page
      .locator('input[placeholder="Type a command..."]')
      .first()
      .isVisible()
      .catch(() => false)
    if (paletteVisible) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('7. Create terminal, toggle split view, toggle back', async () => {
    await createTerminalIfNeeded('Smoke1')
    await page.locator('button[title="Split View"]').first().click().catch(() => {})
    await page.waitForTimeout(700)
    await page.locator('button[title="Tab View"]').first().click().catch(() => {})
    await page.waitForTimeout(700)
    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('8. Per-pane Split Right + Split Down buttons', async () => {
    // Switch to split view first
    await page.locator('button[title="Split View"]').first().click().catch(() => {})
    await page.waitForTimeout(700)

    const splitRight = page.locator('button[title="Split Right"]').first()
    if (await splitRight.isVisible().catch(() => false)) {
      await splitRight.click()
      await page.waitForTimeout(1500)
    }
    const splitDown = page.locator('button[title="Split Down"]').first()
    if (await splitDown.isVisible().catch(() => false)) {
      await splitDown.click()
      await page.waitForTimeout(1500)
    }
    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('9. Pane close button does not error', async () => {
    // Close any extra panes created by test 8 to get back to a clean state.
    const closeBtns = page.locator('button[aria-label^="Close Smoke1"]')
    const n = await closeBtns.count()
    for (let i = 0; i < n && i < 3; i++) {
      const btn = closeBtns.first()
      const visible = await btn.isVisible().catch(() => false)
      if (visible) {
        await btn.click().catch(() => {})
        await page.waitForTimeout(400)
      }
    }
    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('10. Settings pane tabs all render', async () => {
    await closeAnyOpenModal()
    const gear = page.locator('button[title="Settings"]').first()
    await gear.click()
    await page.waitForTimeout(600)

    // Click each visible sub-tab/section within settings; each click should not error.
    // We don't assume specific labels; we just click every button within the settings pane.
    const settingsPane = page.locator('main')
    const buttonCount = await settingsPane.locator('button').count()
    for (let i = 0; i < Math.min(buttonCount, 20); i++) {
      const btn = settingsPane.locator('button').nth(i)
      const visible = await btn.isVisible().catch(() => false)
      const enabled = await btn.isEnabled().catch(() => false)
      if (visible && enabled) {
        await btn.click({ trial: false, timeout: 500 }).catch(() => {})
        await page.waitForTimeout(100)
      }
    }
    // Close settings
    await gear.click().catch(() => {})
    await page.waitForTimeout(300)

    const fatal = errors.filter(isFatal)
    expect(fatal, fatal.join('\n')).toEqual([])
  })

  test('11. Final assertion: zero fatal errors across entire smoke run', async () => {
    const fatal = errors.filter(isFatal)
    if (fatal.length > 0) {
      console.error('Fatal errors seen during smoke:\n' + fatal.join('\n\n'))
    }
    expect(fatal, `Fatal errors (${fatal.length}):\n${fatal.join('\n\n')}`).toEqual([])
  })
})

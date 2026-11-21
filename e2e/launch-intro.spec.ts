/**
 * The launch intro in the real app, on every platform.
 *
 * Main plays it only on the first start of a process, and not under NODE_ENV=test unless a test
 * sets TERMPOLIS_TEST_LAUNCH_INTRO=1. Every launch here has its own userData folder, so each one
 * is a first start. A relaunch with the SAME folder is the "setting off" case.
 *
 * The two reference frames in launch-intro.spec.ts-snapshots/ are shared by all platforms: the
 * artwork is pre-rendered, so one frame per card is right everywhere.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import os from 'os'
import { dismissOnboarding, e2eLaunchArgs, ensureE2eBuild, quitApp } from './helpers/launch'

const INTRO = '[data-testid="launch-intro"]'
const INTRO_MAX_MS = 2000
const TEST_SLACK_MS = 250
const VIEW_W = 1280
const VIEW_H = 720
const SHELL = process.platform === 'win32' ? 'powershell' : 'bash'

let app: ElectronApplication | null = null

test.beforeAll(() => {
  ensureE2eBuild()
})

test.afterEach(async () => {
  await quitApp(app)
  app = null
})

async function launch(label: string, introSwitch = true): Promise<Page> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1' }
  if (introSwitch) env.TERMPOLIS_TEST_LAUNCH_INTRO = '1'
  else delete env.TERMPOLIS_TEST_LAUNCH_INTRO
  app = await electron.launch({ args: e2eLaunchArgs(label), env })
  const page = await app.firstWindow()
  // A fixed 1280x720 viewport at scale 1, so the overlay and its screenshots are the same everywhere
  // (a real window's content size drifts with the OS's display scaling).
  await page.setViewportSize({ width: VIEW_W, height: VIEW_H })
  await page.waitForLoadState('domcontentloaded')
  return page
}

async function relaunch(label: string): Promise<Page> {
  await quitApp(app)
  app = null
  return launch(label)
}

async function terminalText(page: Page, id: string): Promise<string> {
  return page.evaluate(
    (tid) => (window as unknown as { __termpolis_terminal_text?: (i?: string) => string }).__termpolis_terminal_text?.(tid) ?? '',
    id,
  )
}

test.describe('launch intro', () => {
  test('shows on launch and is gone by 2.0 s after it first paints', async () => {
    const page = await launch('intro-timing')
    const elapsed = await page.evaluate(async (sel) => {
      const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
      const deadline = performance.now() + 10_000
      let el: Element | null = document.querySelector(sel)
      while (!el) {
        if (performance.now() > deadline) throw new Error('the intro never appeared')
        await frame()
        el = document.querySelector(sel)
      }
      // The overlay's own animation clock starts at its first frame; read it once it has begun.
      let start: number | null = null
      while (start === null) {
        start = (el.getAnimations()[0]?.startTime as number | null | undefined) ?? null
        if (start === null) await frame()
      }
      while (document.querySelector(sel)) {
        if (performance.now() > start + 10_000) throw new Error('the intro never left')
        await frame()
      }
      return performance.now() - start
    }, INTRO)
    expect(elapsed).toBeLessThanOrEqual(INTRO_MAX_MS + TEST_SLACK_MS)
    expect(elapsed).toBeGreaterThan(1000)
  })

  test('typing during the intro lands in the terminal once', async () => {
    const page = await launch('intro-typing')
    await expect(page.locator(INTRO)).toBeVisible({ timeout: 15_000 })
    // A terminal has to exist while the intro is up, and clicking the UI would end it. So open the
    // shell the way the app's own remote-open path does: the PTY through the real IPC, then the
    // event that puts it in the sidebar as an ordinary terminal.
    const id = `intro-e2e-${Date.now()}`
    await page.evaluate(async ({ tid, shell, cwd }) => {
      const api = (window as unknown as { termpolis: { createTerminal: (...a: unknown[]) => Promise<{ success: boolean }> } }).termpolis
      const res = await api.createTerminal(tid, shell, cwd)
      if (!res.success) throw new Error('could not create the terminal')
    }, { tid: id, shell: SHELL, cwd: os.homedir() })
    await app!.evaluate(({ BrowserWindow }, data) => {
      BrowserWindow.getAllWindows()[0].webContents.send('mcp:terminal-created', data)
    }, { id, name: 'intro-typing', shell: SHELL, cwd: os.homedir(), remote: true })
    const textarea = page.locator('.xterm-helper-textarea').first()
    await textarea.waitFor({ state: 'attached', timeout: 10_000 })
    // Focus by script: neither a key nor a click, so the intro keeps playing.
    await textarea.focus()
    expect(await page.locator(INTRO).count(), 'the intro must still be up when the typing starts').toBe(1)
    await page.keyboard.type('echo intro-ok')
    await page.keyboard.press('Enter')
    // Focus never moved to the overlay.
    expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true)
    await expect.poll(async () => {
      const lines = (await terminalText(page, id)).split(/\r?\n/).map((l) => l.trim())
      return lines.filter((l) => l === 'intro-ok').length
    }, { timeout: 20_000 }).toBe(1)
    // And it stays one: not doubled by a late repeat.
    await page.waitForTimeout(1000)
    const lines = (await terminalText(page, id)).split(/\r?\n/).map((l) => l.trim())
    expect(lines.filter((l) => l === 'intro-ok')).toHaveLength(1)
    expect(lines.filter((l) => l.endsWith('echo intro-ok'))).toHaveLength(1)
    await expect(page.locator(INTRO)).toHaveCount(0)
  })

  test('a reload does not play it again', async () => {
    const page = await launch('intro-reload')
    await expect(page.locator(INTRO)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(INTRO)).toHaveCount(0, { timeout: INTRO_MAX_MS + 3000 })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1500)
    expect(await page.locator(INTRO).count()).toBe(0)
  })

  test('does not show when the setting is off', async () => {
    const label = 'intro-off'
    const page = await launch(label)
    await expect(page.locator(INTRO)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(INTRO)).toHaveCount(0, { timeout: INTRO_MAX_MS + 3000 })
    await dismissOnboarding(page)
    await page.locator('button[title="Settings"]').click()
    await page.getByRole('button', { name: 'General', exact: true }).click()
    const box = page.getByTestId('settings-launch-intro')
    await expect(box).toBeChecked()
    await box.uncheck()
    await expect(box).not.toBeChecked()
    expect(await page.evaluate(() => localStorage.getItem('termpolis.launchIntro'))).toBe('0')
    // Same userData: the stored setting is what keeps it away.
    const again = await relaunch(label)
    await again.waitForTimeout(3000)
    expect(await again.locator(INTRO).count()).toBe(0)
  })

  test('does not show in e2e without the test switch', async () => {
    const page = await launch('intro-no-switch', false)
    await page.waitForTimeout(3000)
    expect(await page.locator(INTRO).count()).toBe(0)
  })

  for (const [card, t] of [['termpolis', 600], ['lumopolis', 1690]] as const) {
    test(`the ${card} card matches the reference frame`, async () => {
      test.info().snapshotSuffix = ''
      const page = await launch(`intro-shot-${card}`)
      const intro = page.getByTestId('launch-intro')
      await expect(intro).toBeVisible({ timeout: 15_000 })
      // Freeze the film at the card's time. The overlay removes itself 2 s after first paint, so
      // this and the screenshot below have to be quick.
      await page.evaluate((time) => {
        document.getAnimations().forEach((a) => { a.pause(); a.currentTime = time })
      }, t)
      // The overlay is the whole viewport, so a viewport clip is the overlay; a clip rather than the element
      // keeps the frame exactly 1280x720 even if the OS rounds the viewport by a pixel.
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: VIEW_W, height: VIEW_H }, scale: 'css', animations: 'allow' })
      expect(shot).toMatchSnapshot(`launch-intro-${card}.png`, { maxDiffPixelRatio: 0.02 })
    })
  }
})

/**
 * Lumopolis engine e2e: the standalone dist-world/world-viewer.js bundle in a real Electron
 * window with software WebGL. Loads the fixture world, clicks a building, checks the inspector
 * card, closes it with Esc. Task 14 adds more.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { e2eUserDataDir, quitApp } from './helpers/launch'

let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []

test.beforeAll(async () => {
  if (!fs.existsSync(path.resolve('dist-world/world-viewer.js'))) {
    execSync('npm run build:world-viewer', { cwd: path.resolve('.'), stdio: 'pipe', timeout: 180_000 })
  }
  app = await electron.launch({
    args: [
      path.resolve('tests/e2e/fixtures/world-harness-main.cjs'),
      `--user-data-dir=${e2eUserDataDir('world-engine')}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
  })
  page = await app.firstWindow()
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', (err) => { consoleErrors.push(String(err)) })
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30_000 })
})

test.afterAll(async () => {
  await quitApp(app)
})

test('draws the world on a sized canvas', async () => {
  const size = await page.locator('#view canvas').evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }))
  expect(size.w).toBeGreaterThan(0)
  expect(size.h).toBeGreaterThan(0)
})

test('clicking a building opens its card, Esc closes it', async () => {
  const card = page.locator('#card')
  await expect(card).toBeHidden()
  const pt = await page.evaluate(() => (window as unknown as { __worldTest: { project(id: string): Promise<{ x: number; y: number }> } }).__worldTest.project('b1'))
  await page.mouse.click(pt.x, pt.y)
  await expect(card).toBeVisible()
  await expect(card.locator('h3').first()).toHaveText('Desktop app')
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
})

test('logs no console errors', async () => {
  expect(consoleErrors).toEqual([])
})

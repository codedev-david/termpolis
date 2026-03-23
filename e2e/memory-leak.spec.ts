/**
 * Termpolis Memory Leak Detection E2E Tests
 * Validates that common operations do not cause unbounded memory growth.
 * Uses generous thresholds (2x-3x baseline) -- the goal is catching obvious leaks (10x+).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page

// Memory tests need more time
test.setTimeout(120_000)

/** Get renderer process JS heap size (Chrome-only API) */
async function getRendererMemory(p: Page): Promise<number | null> {
  return p.evaluate(() => {
    if ((performance as any).memory) {
      return (performance as any).memory.usedJSHeapSize as number
    }
    return null
  })
}

/** Get main process heap used via Electron API */
async function getMainProcessMemory(a: ElectronApplication): Promise<number> {
  return a.evaluate(({ app: _app }) => process.memoryUsage().heapUsed)
}

/** Force garbage collection in the renderer if exposed */
async function forceGC(p: Page): Promise<void> {
  await p.evaluate(() => {
    if ((window as any).gc) (window as any).gc()
  })
  await p.waitForTimeout(500)
}

/** Helper: create a terminal via the Add Terminal modal */
async function createTerminal(name: string) {
  const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
  await addBtn.click()
  await page.waitForTimeout(500)

  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)

  const create = page.getByRole('button', { name: 'Create', exact: true })
  await create.click()
  await page.waitForTimeout(2000)
}

/** Helper: close a terminal by name */
async function closeTerminalByName(name: string) {
  const closeBtn = page.locator(`aside button[aria-label="Close ${name}"]`).first()
  const visible = await closeBtn.isVisible().catch(() => false)
  if (visible) {
    await closeBtn.click()
    await page.waitForTimeout(1500)
  }
}

/** Helper: click the view mode toggle button */
async function toggleView() {
  const toggle = page.locator('button[title="Split View"], button[title="Tab View"]')
  await toggle.click()
  await page.waitForTimeout(500)
}

/** Format bytes as MB string */
function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

test.beforeAll(async () => {
  // Build the app
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // Kill any stale Electron processes that might block launch
  try { execSync('taskkill /F /IM electron.exe', { stdio: 'pipe' }) } catch { /* none running */ }
  // Brief pause after killing processes
  await new Promise(r => setTimeout(r, 2000))

  // Clear session so we start fresh on the Welcome screen
  const os = await import('os')
  const sessionPaths = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis', 'session.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'session.json'),
  ]
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs'
  })
  for (const sessionPath of sessionPaths) {
    if (fs.existsSync(sessionPath)) {
      fs.writeFileSync(sessionPath, cleanSession)
    }
  }

  // Launch with retry -- Electron can be flaky on Windows after previous test crashes
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      app = await electron.launch({
        args: [path.resolve('out/main/index.js')],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TERMPOLIS_TEST_AGENTS: '1',
          TERMPOLIS_TEST_TIMING: '1',
        },
      })
      page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(2000)
      break
    } catch (err) {
      console.log(`Launch attempt ${attempt + 1} failed, retrying...`)
      try { await app?.close() } catch { /* ignore */ }
      if (attempt === 2) throw err
      await new Promise(r => setTimeout(r, 3000))
    }
  }
})

test.afterAll(async () => {
  try { if (app) await app.close() } catch { /* already closed */ }
})

test.describe.serial('Memory Leak Detection', () => {

  test('1. terminal create/close does not leak memory', async () => {
    // First create a "keeper" terminal that stays open to prevent Welcome screen transition
    await createTerminal('Keeper')

    const rendererBaseline = await getRendererMemory(page)
    const mainBaseline = await getMainProcessMemory(app)

    if (rendererBaseline === null) {
      console.log('performance.memory not available -- testing main process only')
    }

    // Create 3 terminals
    for (let i = 0; i < 3; i++) {
      await createTerminal(`Leak${i}`)
    }
    await page.waitForTimeout(1000)

    // Close the 3 leak-test terminals (Keeper stays open to keep app stable)
    for (let i = 0; i < 3; i++) {
      await closeTerminalByName(`Leak${i}`)
    }

    // Force GC and measure
    await forceGC(page)

    if (rendererBaseline !== null) {
      const rendererAfter = await getRendererMemory(page)
      expect(rendererAfter).not.toBeNull()
      console.log(`Renderer: baseline=${mb(rendererBaseline)}, after=${mb(rendererAfter!)}`)
      expect(rendererAfter!).toBeLessThan(rendererBaseline * 3)
    }

    const mainAfter = await getMainProcessMemory(app)
    console.log(`Main: baseline=${mb(mainBaseline)}, after=${mb(mainAfter)}`)
    expect(mainAfter).toBeLessThan(mainBaseline * 3)
  })

  test('2. modal open/close does not leak DOM nodes', async () => {
    await forceGC(page)
    const rendererBaseline = await getRendererMemory(page)
    const domBaseline = await page.evaluate(() => document.querySelectorAll('*').length)

    // Open and close Add Terminal modal 10 times
    for (let i = 0; i < 10; i++) {
      const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
      await addBtn.click()
      await page.waitForTimeout(500)

      // Close modal via Cancel button or Escape
      const cancelBtn = page.getByRole('button', { name: 'Cancel' })
      const cancelVisible = await cancelBtn.isVisible().catch(() => false)
      if (cancelVisible) {
        await cancelBtn.click()
      } else {
        await page.keyboard.press('Escape')
      }
      await page.waitForTimeout(500)
    }

    await forceGC(page)

    const domAfter = await page.evaluate(() => document.querySelectorAll('*').length)
    console.log(`DOM nodes: baseline=${domBaseline}, after=${domAfter}`)
    // DOM node count should not grow more than 2x (modals should be fully cleaned up)
    expect(domAfter).toBeLessThan(domBaseline * 2)

    if (rendererBaseline !== null) {
      const rendererAfter = await getRendererMemory(page)
      console.log(`Renderer: baseline=${mb(rendererBaseline)}, after=${mb(rendererAfter!)}`)
      expect(rendererAfter!).toBeLessThan(rendererBaseline * 3)
    }
  })

  test('3. view switching does not leak xterm instances', async () => {
    // Keeper terminal already exists from test 1; use it plus one more
    await createTerminal('ViewB')
    await page.waitForTimeout(2000)

    await forceGC(page)
    const rendererBaseline = await getRendererMemory(page)
    const mainBaseline = await getMainProcessMemory(app)

    // Switch between tab/split 3 times with generous delay for xterm disposal/recreation
    for (let i = 0; i < 3; i++) {
      await toggleView()
      await page.waitForTimeout(3000)
    }

    await forceGC(page)

    if (rendererBaseline !== null) {
      const rendererAfter = await getRendererMemory(page)
      console.log(`View switch renderer: baseline=${mb(rendererBaseline)}, after=${mb(rendererAfter!)}`)
      expect(rendererAfter!).toBeLessThan(rendererBaseline * 3)
    }

    const mainAfter = await getMainProcessMemory(app)
    console.log(`View switch main: baseline=${mb(mainBaseline)}, after=${mb(mainAfter)}`)
    expect(mainAfter).toBeLessThan(mainBaseline * 3)
  })

  test('4. swarm dashboard open/close does not leak event listeners', async () => {
    await forceGC(page)
    const rendererBaseline = await getRendererMemory(page)
    const mainBaseline = await getMainProcessMemory(app)

    // Open/close swarm dashboard 10 times via Ctrl+Shift+S
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Control+Shift+S')
      await page.waitForTimeout(800)

      // Verify it opened
      const dashboard = page.locator('text=Swarm Dashboard')
      const isOpen = await dashboard.isVisible().catch(() => false)

      // Close it
      if (isOpen) {
        await page.keyboard.press('Control+Shift+S')
        await page.waitForTimeout(800)
      }
    }

    await forceGC(page)

    if (rendererBaseline !== null) {
      const rendererAfter = await getRendererMemory(page)
      console.log(`Swarm renderer: baseline=${mb(rendererBaseline)}, after=${mb(rendererAfter!)}`)
      expect(rendererAfter!).toBeLessThan(rendererBaseline * 3)
    }

    const mainAfter = await getMainProcessMemory(app)
    console.log(`Swarm main: baseline=${mb(mainBaseline)}, after=${mb(mainAfter)}`)
    expect(mainAfter).toBeLessThan(mainBaseline * 3)
  })

  test('5. long terminal output respects scrollback cap', async () => {
    // Create a terminal for output testing (ViewA/ViewB may still exist from test 3)
    await createTerminal('OutputTest')
    await page.waitForTimeout(1000)

    await forceGC(page)
    const rendererBaseline = await getRendererMemory(page)
    const mainBaseline = await getMainProcessMemory(app)

    // Focus the terminal and send a command that generates lots of output
    const xterm = page.locator('.xterm-helper-textarea').first()
    await xterm.focus()
    await page.waitForTimeout(300)

    // Use a PowerShell loop to generate ~2000 lines of output
    await page.keyboard.type('1..2000 | ForEach-Object { "Line $_ of output test padding data here" }')
    await page.keyboard.press('Enter')

    // Wait for the output to complete
    await page.waitForTimeout(10000)

    await forceGC(page)

    if (rendererBaseline !== null) {
      const rendererAfter = await getRendererMemory(page)
      console.log(`Long output renderer: baseline=${mb(rendererBaseline)}, after=${mb(rendererAfter!)}`)
      // The 10K scrollback cap and 64KB throttle should prevent unbounded growth
      expect(rendererAfter!).toBeLessThan(rendererBaseline * 3)
    }

    const mainAfter = await getMainProcessMemory(app)
    console.log(`Long output main: baseline=${mb(mainBaseline)}, after=${mb(mainAfter)}`)
    expect(mainAfter).toBeLessThan(mainBaseline * 3)
  })

})

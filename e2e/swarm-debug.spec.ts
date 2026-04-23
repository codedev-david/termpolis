/**
 * Swarm Debug Test — launches the app, starts a swarm, and captures
 * exactly what happens in the conductor terminal.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
// Import the renderer-side helper directly in Node test context. The
// alternative (dynamic import from page.evaluate) doesn't work because the
// renderer bundle doesn't ship source files at those paths.
import { buildConductorPrompt } from '../src/renderer/src/lib/conductorPrompt'

let app: ElectronApplication
let page: Page
const SCREENSHOTS = 'e2e/screenshots/swarm-debug'

test.beforeAll(async () => {
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  // Clean session
  const appDataDirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron'),
  ]
  for (const dir of appDataDirs) {
    const lockfile = path.join(dir, 'lockfile')
    try { if (fs.existsSync(lockfile)) fs.unlinkSync(lockfile) } catch {}
    const sessionPath = path.join(dir, 'session.json')
    try {
      if (fs.existsSync(dir)) {
        fs.writeFileSync(sessionPath, JSON.stringify({
          terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs',
        }))
      }
    } catch {}
  }

  // Build
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

const ss = (name: string) => page.screenshot({ path: `${SCREENSHOTS}/${name}.png` })

test('1. App launches and shows welcome screen', async () => {
  await ss('01-launch')
  const title = page.locator('text=Termpolis').first()
  await expect(title).toBeVisible()
})

test('2. Open Swarm Dashboard via Ctrl+Shift+S', async () => {
  await page.keyboard.press('Control+Shift+S')
  await page.waitForTimeout(1000)
  await ss('02-swarm-dashboard')

  // Should show the swarm dashboard
  const dashboard = page.locator('text=Swarm Dashboard').first()
  await expect(dashboard).toBeVisible({ timeout: 5000 })
})

test('3. Dashboard shows Start Swarm button', async () => {
  const startBtn = page.locator('button:has-text("Start Swarm"), a:has-text("Start Swarm")').first()
  await expect(startBtn).toBeVisible({ timeout: 3000 })
  await ss('03-start-swarm-button')
})

test('4. Click Start Swarm — should open directory picker', async () => {
  // We can't interact with native dialogs in Playwright
  // Instead, verify the button exists and is clickable
  const startBtn = page.locator('button:has-text("Start Swarm")').first()
  const isEnabled = await startBtn.isEnabled()
  expect(isEnabled).toBeTruthy()
  await ss('04-start-button-enabled')
})

test('5. Check if MCP server is running', async () => {
  // The status bar should show MCP info
  const mcp = page.locator('text=MCP').first()
  const mcpVisible = await mcp.isVisible().catch(() => false)
  await ss('05-mcp-status')

  // Also check the actual MCP server
  const response = await page.evaluate(async () => {
    try {
      const res = await fetch('http://127.0.0.1:9315/health')
      return { ok: res.ok, status: res.status, body: await res.text() }
    } catch (e: any) {
      return { ok: false, status: 0, body: e.message }
    }
  })
  console.log('[MCP Health]', JSON.stringify(response))
  expect(response.ok).toBeTruthy()
})

test('6. Check conductor prompt file generation', async () => {
  // Build the conductor prompt in Node (no bundling or dynamic import needed).
  const promptContent = buildConductorPrompt({
    taskDescription: 'Test task',
    installedAgents: { claude: true, codex: false, gemini: false, 'aider-qwen': false },
    projectCwd: 'C:\\test',
    shellType: 'powershell',
  })
  console.log('[Conductor Prompt Length]', promptContent.length)
  console.log('[Conductor Prompt Preview]', promptContent.slice(0, 500))
  expect(promptContent).toContain('Swarm Conductor')
  expect(promptContent).toContain('create_terminal')
})

test('7. Check agent detection', async () => {
  const agents = await page.evaluate(async () => {
    try {
      const res = await (window as any).termpolis.detectAgents()
      return res
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
  console.log('[Detected Agents]', JSON.stringify(agents))
  expect(agents.success).toBeTruthy()
})

test('8. Check Claude Code availability', async () => {
  const result = await page.evaluate(async () => {
    try {
      const res = await (window as any).termpolis.detectAgents()
      return {
        success: res.success,
        claude: res.data?.claude,
        codex: res.data?.codex,
        gemini: res.data?.gemini,
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
  console.log('[Agent Availability]', JSON.stringify(result))
  // Claude must be installed for swarm to work
  if (!result.claude) {
    console.warn('[WARNING] Claude Code is NOT installed — swarm will not work')
  }
})

test('9. Test terminal creation', async () => {
  // Generate the terminal id in Node — the renderer bundle doesn't expose
  // `uuid` as a dynamic import target. crypto.randomUUID is in Node 16+.
  const id = (globalThis as any).crypto?.randomUUID?.() ?? `e2e-${Date.now()}`
  const createResult = await page.evaluate(async (terminalId: string) => {
    try {
      const res = await (window as any).termpolis.createTerminal(terminalId, 'powershell', 'C:\\Users')
      return { success: res.success, error: res.error, id: terminalId }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }, id)
  console.log('[Terminal Create]', JSON.stringify(createResult))
  expect(createResult.success).toBeTruthy()
  await page.waitForTimeout(2000)
  await ss('09-terminal-created')
})

test('10. Close swarm dashboard', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await ss('10-dashboard-closed')
})

test('11. Verify conductor temp file path', async () => {
  const homedir = await page.evaluate(async () => {
    const res = await (window as any).termpolis.getHomedir()
    return res.data
  })
  console.log('[Homedir]', homedir)

  const tempFile = homedir.replace(/\\/g, '/') + '/.termpolis-conductor-task.md'
  console.log('[Conductor Temp File Path]', tempFile)

  // Check if we can write to this path
  const writeResult = await page.evaluate(async (filePath: string) => {
    try {
      const res = await (window as any).termpolis.writeConfigFile(filePath, 'test content')
      return res
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }, tempFile)
  console.log('[Write Test]', JSON.stringify(writeResult))
  expect(writeResult.success).toBeTruthy()
})

test('12. Check MCP token and port files exist', async () => {
  const result = await page.evaluate(async () => {
    try {
      const tokenRes = await (window as any).termpolis.readConfigFile(
        process.platform === 'win32'
          ? `${process.env.APPDATA}/termpolis/mcp-token`
          : `${process.env.HOME}/.config/termpolis/mcp-token`
      )
      return { token: tokenRes.success, tokenLength: tokenRes.data?.length }
    } catch (e: any) {
      return { error: e.message }
    }
  })
  console.log('[MCP Token]', JSON.stringify(result))
})

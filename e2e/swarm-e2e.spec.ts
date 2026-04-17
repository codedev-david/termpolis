/**
 * Swarm End-to-End Test
 * Tests the swarm flow through the UI by intercepting the native dialog.
 * Uses electron.dialog mock to bypass the directory picker.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
const SCREENSHOTS = 'e2e/screenshots/swarm-e2e'
const PROJECT_DIR = path.resolve('.')

test.beforeAll(async () => {
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  // Clean
  const appDataDirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron'),
  ]
  for (const dir of appDataDirs) {
    try { if (fs.existsSync(path.join(dir, 'lockfile'))) fs.unlinkSync(path.join(dir, 'lockfile')) } catch {}
    try {
      if (fs.existsSync(dir)) {
        fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
          terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs',
        }))
      }
    } catch {}
  }

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

test('1. App launches with all agents detected', async () => {
  await ss('01-launch')
  // Verify agents are visible
  await expect(page.locator('text=Claude Code').first()).toBeVisible()
  await expect(page.locator('text=Qwen AI').first()).toBeVisible()
})

test('2. Open Swarm Dashboard', async () => {
  await page.keyboard.press('Control+Shift+S')
  await page.waitForTimeout(1000)
  await ss('02-dashboard')
  await expect(page.locator('text=Swarm Dashboard').first()).toBeVisible()
})

test('3. Dashboard has Agents, Tasks, Messages tabs', async () => {
  for (const tab of ['Agents', 'Tasks', 'Messages']) {
    await expect(page.locator(`button:has-text("${tab}")`).first()).toBeVisible()
  }
})

test('4. Messages tab is empty', async () => {
  await page.locator('button:has-text("Messages")').first().click()
  await page.waitForTimeout(300)
  const emptyMsg = page.locator('text=No swarm messages yet')
  await expect(emptyMsg).toBeVisible()
  await ss('04-empty-messages')
})

test('5. Tasks tab shows empty kanban', async () => {
  await page.locator('button:has-text("Tasks")').first().click()
  await page.waitForTimeout(300)
  await ss('05-empty-tasks')
})

test('6. Create a manual task', async () => {
  // Click the "+ Task" button (use icon selector to avoid matching the "Tasks" tab)
  const taskBtn = page.locator('button:has(i.fa-plus):has-text("Task")').first()
  await taskBtn.click()
  await page.waitForTimeout(500)

  // Fill in task form
  const titleInput = page.locator('input[placeholder="Task title"]')
  await titleInput.fill('Test task from E2E')

  const descInput = page.locator('textarea[placeholder="Description"]')
  await descInput.fill('This is a test task created by Playwright')

  // Submit
  const createBtn = page.locator('button:has-text("Create")').last()
  await createBtn.click()
  await page.waitForTimeout(500)
  await ss('06-task-created')
})

test('7. Task appears in Pending column', async () => {
  await page.locator('button:has-text("Tasks")').first().click()
  await page.waitForTimeout(500)
  const task = page.locator('text=Test task from E2E')
  await expect(task).toBeVisible({ timeout: 5000 })
  await ss('07-pending-task')
})

test('8. Broadcast a message to all agents', async () => {
  const broadcastBtn = page.locator('button:has-text("Broadcast")').first()
  await broadcastBtn.click()
  await page.waitForTimeout(500)

  const msgInput = page.locator('textarea[placeholder*="Message content"]')
  await msgInput.fill('Hello from Playwright E2E test!')

  const sendBtn = page.locator('button:has-text("Send")').last()
  await sendBtn.click()
  await page.waitForTimeout(500)
  await ss('08-broadcast-sent')
})

test('9. Message appears in Messages tab', async () => {
  await page.locator('button:has-text("Messages")').first().click()
  await page.waitForTimeout(500)
  const msg = page.locator('text=Hello from Playwright E2E test!')
  await expect(msg).toBeVisible({ timeout: 5000 })
  await ss('09-message-visible')
})

test('10. Agents tab shows empty state', async () => {
  // Ensure dashboard is open
  const dashboardVisible = await page.locator('text=Swarm Dashboard').first().isVisible().catch(() => false)
  if (!dashboardVisible) {
    await page.keyboard.press('Control+Shift+S')
    await page.waitForTimeout(1000)
  }
  await page.locator('button:has-text("Agents")').first().click()
  await page.waitForTimeout(300)
  const emptyAgents = page.locator('text=No swarm agents running')
  await expect(emptyAgents).toBeVisible()
  await ss('10-no-agents')
})

test('11. Start Swarm button visible when not active', async () => {
  const startBtn = page.locator('button:has-text("Start Swarm")').first()
  await expect(startBtn).toBeVisible()
  await ss('11-start-swarm-visible')
})

test('12. Clear swarm - shows confirmation', async () => {
  // Ensure dashboard is open
  const dashboardVisible = await page.locator('text=Swarm Dashboard').first().isVisible().catch(() => false)
  if (!dashboardVisible) {
    await page.keyboard.press('Control+Shift+S')
    await page.waitForTimeout(1000)
  }
  const clearBtn = page.locator('button:has-text("Clear")').first()
  await clearBtn.click()
  await page.waitForTimeout(300)

  const confirmText = page.locator('text=All swarm work will be lost')
  await expect(confirmText).toBeVisible()
  await ss('12-clear-confirm')
})

test('13. Cancel clear', async () => {
  const cancelBtn = page.locator('button:has-text("Cancel")').last()
  await cancelBtn.click()
  await page.waitForTimeout(300)
  // Task should still exist
  await page.locator('button:has-text("Tasks")').first().click()
  await page.waitForTimeout(300)
  await expect(page.locator('text=Test task from E2E')).toBeVisible()
  await ss('13-cancel-clear')
})

test('14. Confirm clear swarm', async () => {
  const clearBtn = page.locator('button:has-text("Clear")').first()
  await clearBtn.click()
  await page.waitForTimeout(300)
  const confirmClear = page.locator('button:has-text("Clear Swarm")').last()
  await confirmClear.click()
  await page.waitForTimeout(500)

  // Tasks and messages should be empty now
  await page.locator('button:has-text("Messages")').first().click()
  await page.waitForTimeout(300)
  await expect(page.locator('text=No swarm messages yet')).toBeVisible()
  await ss('14-cleared')
})

test('15. Close dashboard with Escape', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  // Dashboard should be gone
  const dashboard = page.locator('text=Swarm Dashboard')
  const visible = await dashboard.first().isVisible().catch(() => false)
  expect(visible).toBeFalsy()
  await ss('15-dashboard-closed')
})

test('16. Verify MCP swarm tools work via API', async () => {
  // Test swarm tools through the window.swarmAPI
  const result = await page.evaluate(async () => {
    const api = (window as any).swarmAPI

    // Create a task
    const createRes = await api.createTask('API Test Task', 'Created via MCP API', 'e2e-test')
    const tasks = await api.getTasks()

    // Send a message
    const msgRes = await api.sendMessage('e2e-test', 'all', 'info', 'Testing swarm API')
    const messages = await api.getMessages()

    // Clean up
    await api.clear()

    return {
      taskCreated: createRes.success,
      taskCount: tasks.data?.length,
      msgSent: msgRes.success,
      msgCount: messages.data?.length,
    }
  })

  console.log('[Swarm API Test]', JSON.stringify(result))
  expect(result.taskCreated).toBeTruthy()
  expect(result.taskCount).toBeGreaterThanOrEqual(1)
  expect(result.msgSent).toBeTruthy()
  expect(result.msgCount).toBeGreaterThanOrEqual(1)
})

test('17. Verify MCP server tools via HTTP', async () => {
  // Get the MCP auth token
  const tokenPath = path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis', 'mcp-token')
  if (!fs.existsSync(tokenPath)) {
    test.skip()
    return
  }
  const token = fs.readFileSync(tokenPath, 'utf-8').trim()

  // Call list_terminals via MCP
  const result = await page.evaluate(async (authToken: string) => {
    const res = await fetch('http://127.0.0.1:9315/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_terminals', arguments: {} },
        id: 1,
      }),
    })
    return res.json()
  }, token)

  console.log('[MCP list_terminals]', JSON.stringify(result))
  expect(result.result).toBeDefined()
})

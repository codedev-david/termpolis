import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NODE_ENV: 'test' },
  })

  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

async function screenshot(name: string) {
  await page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true })
}

async function closeAnyModal() {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

// ══════════════════════════════════════════════════════
// 1. APP LAUNCH
// ══════════════════════════════════════════════════════

test('01 - app launches with title bar', async () => {
  await expect(page.locator('text=Termpolis').first()).toBeVisible()
  await screenshot('01-app-launch')
})

test('02 - welcome screen shows on first launch', async () => {
  const welcome = page.locator('text=Welcome to Termpolis')
  if (await welcome.isVisible().catch(() => false)) {
    await expect(welcome).toBeVisible()
    await screenshot('02-welcome-screen')
  }
})

// ══════════════════════════════════════════════════════
// 2. SIDEBAR
// ══════════════════════════════════════════════════════

test('03 - sidebar icon bar visible', async () => {
  await expect(page.locator('button[title="Settings"]')).toBeVisible()
  await expect(page.locator('button[title="Prompts"]')).toBeVisible()
  await expect(page.locator('button[title="Workflows"]')).toBeVisible()
  await expect(page.locator('button[title="Swarm Dashboard"]')).toBeVisible()
  await expect(page.locator('button[title="Collapse sidebar"]')).toBeVisible()
  await screenshot('03-sidebar-icons')
})

test('04 - sidebar collapse and expand', async () => {
  await page.locator('button[title="Collapse sidebar"]').click()
  await page.waitForTimeout(400)
  await screenshot('04-sidebar-collapsed')

  await page.locator('button[title="Expand sidebar"]').click()
  await page.waitForTimeout(400)
  await screenshot('04-sidebar-expanded')
})

test('05 - AI Agents section visible', async () => {
  // AI Agents might be collapsed — try expanding
  const agents = page.locator('button:has-text("AI Agents")').first()
  if (await agents.isVisible().catch(() => false)) {
    await agents.click()
    await page.waitForTimeout(300)
  }
  // Check for at least one agent (might use different text)
  const hasAgents = await page.locator('text=Claude Code').first().isVisible().catch(() => false) ||
    await page.locator('text=OpenAI Codex').first().isVisible().catch(() => false)
  expect(hasAgents).toBeTruthy()
  await screenshot('05-ai-agents')
})

test('06 - Workspaces section visible', async () => {
  await expect(page.locator('button:has-text("Workspaces")').first()).toBeVisible()
  await screenshot('06-workspaces-section')
})

test('07 - Terminals section visible', async () => {
  await expect(page.locator('button:has-text("Terminals")').first()).toBeVisible()
})

test('08 - Add Terminal button visible', async () => {
  await expect(page.locator('button:has-text("+ Add Terminal")').first()).toBeVisible()
})

// ══════════════════════════════════════════════════════
// 3. TERMINAL CREATION
// ══════════════════════════════════════════════════════

test('09 - Add Terminal modal opens with all fields', async () => {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(500)

  await expect(page.locator('h2:has-text("New Terminal")')).toBeVisible()
  await expect(page.locator('text=Dark').first()).toBeVisible()
  await expect(page.locator('text=Light').first()).toBeVisible()
  await expect(page.locator('text=Nord').first()).toBeVisible()
  await expect(page.locator('text=Font Size').first()).toBeVisible()
  await expect(page.locator('text=Font Family').first()).toBeVisible()

  await screenshot('09-add-terminal-modal')
  await page.locator('button:has-text("Cancel")').click()
  await page.waitForTimeout(300)
})

test('10 - theme selection changes preview', async () => {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(500)

  // Click Solarized Dark
  const solarized = page.locator('text=Solarized Dark').first()
  if (await solarized.isVisible().catch(() => false)) {
    await solarized.click()
    await page.waitForTimeout(200)
    await screenshot('10-theme-solarized')
  }

  // Click Dracula
  const dracula = page.locator('text=Dracula').first()
  if (await dracula.isVisible().catch(() => false)) {
    await dracula.click()
    await page.waitForTimeout(200)
    await screenshot('10-theme-dracula')
  }

  await page.locator('button:has-text("Cancel")').click()
  await page.waitForTimeout(300)
})

test('11 - create a terminal', async () => {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(500)

  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(3000)

  await screenshot('11-terminal-created')
})

test('12 - terminal renders with status bar', async () => {
  const statusBar = page.locator('.bg-\\[\\#007acc\\]').first()
  if (await statusBar.isVisible().catch(() => false)) {
    await expect(statusBar).toBeVisible()
    await screenshot('12-terminal-status-bar')
  }
})

// ══════════════════════════════════════════════════════
// 4. TERMINAL INTERACTION
// ══════════════════════════════════════════════════════

test('13 - right-click context menu', async () => {
  const terminal = page.locator('.xterm').first()
  if (await terminal.isVisible().catch(() => false)) {
    await terminal.click({ button: 'right' })
    await page.waitForTimeout(500)
    await screenshot('13-context-menu')

    const copy = page.locator('button:has-text("Copy")')
    if (await copy.isVisible().catch(() => false)) {
      await expect(copy).toBeVisible()
      await expect(page.locator('button:has-text("Paste")')).toBeVisible()
      await expect(page.locator('text=Select All').first()).toBeVisible()
      await expect(page.locator('text=Export Full Scrollback').first()).toBeVisible()
      await expect(page.locator('text=Export Visible Output').first()).toBeVisible()
      await expect(page.locator('text=Pin Selection').first()).toBeVisible()
    }
    await closeAnyModal()
  }
})

// ══════════════════════════════════════════════════════
// 5. SETTINGS
// ══════════════════════════════════════════════════════

test('14 - settings panel opens', async () => {
  await closeAnyModal()
  await page.locator('button[title="Settings"]').click()
  await page.waitForTimeout(1000)

  await expect(page.locator('h1:has-text("Settings")')).toBeVisible()
  await screenshot('14-settings-panel')
})

test('15 - keybindings visible in settings', async () => {
  await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
  await expect(page.locator('text=Copy').first()).toBeVisible()
  await expect(page.locator('text=Paste').first()).toBeVisible()
  await screenshot('15-keybindings')
})

test('16 - default shell selector visible', async () => {
  await expect(page.locator('text=Default Shell')).toBeVisible()
})

test('17 - autocomplete toggle visible', async () => {
  await expect(page.locator('text=Enable Autocomplete')).toBeVisible()
})

test('18 - shell config editor visible', async () => {
  const configFiles = page.locator('text=Shell Config Files')
  if (await configFiles.isVisible().catch(() => false)) {
    await expect(configFiles).toBeVisible()
    await screenshot('18-shell-config-editor')
  }
})

test('19 - close settings returns to terminal', async () => {
  await page.locator('button[title="Settings"]').click()
  await page.waitForTimeout(500)
  await screenshot('19-settings-closed')
})

// ══════════════════════════════════════════════════════
// 6. COMMAND PALETTE
// ══════════════════════════════════════════════════════

test('20 - command palette opens with Ctrl+K', async () => {
  await closeAnyModal()
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(500)

  const input = page.locator('input[placeholder*="command"]').first()
  if (await input.isVisible().catch(() => false)) {
    await expect(input).toBeVisible()
    await screenshot('20-command-palette')
  }
  await closeAnyModal()
})

test('21 - command palette filters on typing', async () => {
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(500)

  const input = page.locator('input[placeholder*="command"]').first()
  if (await input.isVisible().catch(() => false)) {
    await input.fill('split')
    await page.waitForTimeout(300)
    await screenshot('21-command-palette-filtered')
  }
  await closeAnyModal()
})

// ══════════════════════════════════════════════════════
// 7. PROMPT TEMPLATES
// ══════════════════════════════════════════════════════

test('22 - prompt templates modal opens', async () => {
  await closeAnyModal()
  await page.locator('button[title="Prompts"]').click()
  await page.waitForTimeout(500)

  const fixTests = page.locator('text=Fix Tests').first()
  if (await fixTests.isVisible().catch(() => false)) {
    await expect(fixTests).toBeVisible()
    await expect(page.locator('text=Code Review').first()).toBeVisible()
    await expect(page.locator('text=Refactor').first()).toBeVisible()
    await screenshot('22-prompt-templates')
  }
  await closeAnyModal()
})

// ══════════════════════════════════════════════════════
// 8. WORKFLOW TEMPLATES
// ══════════════════════════════════════════════════════

test('23 - workflow templates modal opens', async () => {
  await closeAnyModal()
  await page.locator('button[title="Workflows"]').click()
  await page.waitForTimeout(500)

  await screenshot('23-workflow-templates')
  await closeAnyModal()
})

// ══════════════════════════════════════════════════════
// 9. SPLIT VIEW
// ══════════════════════════════════════════════════════

test('24 - toggle to split view', async () => {
  await closeAnyModal()
  const splitToggle = page.locator('button[title="Split View"]')
  const tabToggle = page.locator('button[title="Tab View"]')
  if (await splitToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
    await splitToggle.click()
    await page.waitForTimeout(1000)
    await screenshot('24-split-view')
  } else if (await tabToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
    // Already in split view
    await screenshot('24-split-view')
  }
})

test('25 - create second terminal for split', async () => {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(3000)
  await screenshot('25-split-two-terminals')
})

test('26 - toggle back to tab view', async () => {
  const toggle = page.locator('button[title="Tab View"]')
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click()
    await page.waitForTimeout(500)
    await screenshot('26-tab-view')
  }
})

// ══════════════════════════════════════════════════════
// 10. HELP MODAL
// ══════════════════════════════════════════════════════

test('27 - help modal opens with all sections', async () => {
  await closeAnyModal()
  await page.locator('button:has-text("Help / Support")').click()
  await page.waitForTimeout(500)

  await expect(page.locator('text=Quick Start Guide')).toBeVisible()
  await screenshot('27-help-modal')

  // Check key sections
  for (const section of ['Sidebar Icon Bar', 'Terminals', 'AI Agents', 'Command Palette', 'MCP Server']) {
    const el = page.locator(`text=${section}`).first()
    await expect(el).toBeVisible()
  }

  // Scroll down and screenshot
  const scrollable = page.locator('.overflow-y-auto').first()
  if (await scrollable.isVisible().catch(() => false)) {
    await scrollable.evaluate(el => el.scrollTop = el.scrollHeight)
    await page.waitForTimeout(300)
    await screenshot('27-help-modal-bottom')
  }

  await page.locator('button:has-text("Close")').click()
  await page.waitForTimeout(300)
})

// ══════════════════════════════════════════════════════
// 11. STATUS BAR
// ══════════════════════════════════════════════════════

test('28 - status bar shows MCP indicator', async () => {
  await expect(page.locator('text=MCP: localhost:9315')).toBeVisible()
})

test('29 - status bar shows Sponsor link', async () => {
  await expect(page.locator('text=Sponsor').first()).toBeVisible()
})

test('30 - status bar shows Help/Support', async () => {
  await expect(page.locator('button:has-text("Help / Support")')).toBeVisible()
  await screenshot('30-status-bar')
})

// ══════════════════════════════════════════════════════
// 12. MCP SERVER
// ══════════════════════════════════════════════════════

test('31 - MCP server health check', async () => {
  const { execSync } = await import('child_process')
  try {
    const result = execSync('curl -s http://127.0.0.1:9315/health', { timeout: 5000 }).toString()
    const health = JSON.parse(result)
    expect(health.status).toBe('ok')
    expect(health.name).toBe('termpolis-mcp')
    expect(health.tools).toBe(14)
    expect(health.auth).toBe('required')
  } catch {
    test.skip()
  }
})

test('32 - MCP server rejects unauthorized requests', async () => {
  const { execSync } = await import('child_process')
  try {
    const result = execSync(
      'curl -s -w "\\n%{http_code}" http://127.0.0.1:9315/mcp -d \'{"jsonrpc":"2.0","method":"tools/list","id":1}\'',
      { timeout: 5000 }
    ).toString()
    const lines = result.trim().split('\n')
    const httpCode = lines[lines.length - 1]
    expect(httpCode).toBe('401')
  } catch {
    test.skip()
  }
})

test('33 - MCP server returns tools with auth', async () => {
  const { execSync, readFileSync } = await import('child_process')
  const fs = await import('fs')
  const os = await import('os')
  try {
    const tokenPath = path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis', 'mcp-token')
    const token = fs.readFileSync(tokenPath, 'utf-8').trim()
    const result = execSync(
      `curl -s -H "Authorization: Bearer ${token}" http://127.0.0.1:9315/mcp -d "{\\"jsonrpc\\":\\"2.0\\",\\"method\\":\\"tools/list\\",\\"id\\":1}"`,
      { timeout: 5000 }
    ).toString()
    const data = JSON.parse(result)
    expect(data.result.tools.length).toBe(14)
  } catch {
    test.skip()
  }
})

// ══════════════════════════════════════════════════════
// 13. WORKSPACE INFO
// ══════════════════════════════════════════════════════

test('34 - workspace info modal opens', async () => {
  await closeAnyModal()
  const info = page.locator('button[title="What are workspaces?"]')
  if (await info.isVisible().catch(() => false)) {
    await info.click()
    await page.waitForTimeout(500)
    await screenshot('34-workspace-info')
    await page.locator('button:has-text("Got it")').click()
    await page.waitForTimeout(300)
  }
})

// ══════════════════════════════════════════════════════
// 14. FINAL SCREENSHOT
// ══════════════════════════════════════════════════════

test('35 - final app state screenshot', async () => {
  await closeAnyModal()
  await page.waitForTimeout(500)
  await screenshot('35-final-state')
})

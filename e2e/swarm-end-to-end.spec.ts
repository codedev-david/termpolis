/**
 * Full Swarm End-to-End Test
 * ---------------------------
 * Exercises the entire swarm pipeline in a single run:
 *
 *   1. User opens Swarm Dashboard and clicks Start Swarm
 *   2. Directory picker resolves via TERMPOLIS_TEST_PROJECT_CWD (mocked at the IPC layer)
 *   3. Wizard's preparing step boots the conductor terminal
 *   4. Conductor spawns `claude --version` — PATH resolves to the test shim which
 *      routes to e2e/mocks/mock-claude.cjs (so we never hit a real agent CLI)
 *   5. User fills Goal and clicks Launch Swarm
 *   6. conductorManager.sendTask writes the prompt file + shell wrapper and runs
 *      `claude -p <prompt>` (again routed to the smart mock conductor)
 *   7. The smart mock conductor drives REAL MCP HTTP calls:
 *        swarm_send_message → swarm_create_task × 2 → create_terminal × 2 →
 *        run_command × 2 → write_to_terminal × 2 → swarm_update_task × 2 →
 *        swarm_send_message('SWARM COMPLETE')
 *   8. The test verifies the renderer's store, the swarm bus, the monitoring
 *      loop, and the MCP HTTP surface all converge on the completed state.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import http from 'http'

let app: ElectronApplication
let page: Page
let mcpToken: string
let mcpPort: number

const PROJECT_ROOT = path.resolve('.')
const SHIM_DIR = path.join(PROJECT_ROOT, 'e2e', 'test-shims')
const SCREENSHOTS = 'e2e/screenshots/swarm-end-to-end'
const TASK_FILE = path.join(os.homedir(), '.termpolis-conductor-task.md')

function userDataDir(): string {
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'termpolis')
  return path.join(os.homedir(), '.config', 'termpolis')
}

async function httpRequest(
  options: http.RequestOptions,
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: d }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function readMcpToken(): string {
  const udir = userDataDir()
  try { return fs.readFileSync(path.join(udir, 'mcp-token'), 'utf-8').trim() }
  catch { return mcpToken }
}

async function mcpCall(toolName: string, args: Record<string, unknown> = {}) {
  // Always re-read the token from disk — the main process rewrites it on every
  // launch, so a cached value from before the app booted will 401.
  const token = readMcpToken()
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })
  const res = await httpRequest(
    {
      hostname: '127.0.0.1',
      port: mcpPort,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        Authorization: `Bearer ${token}`,
      },
    },
    body,
  )
  return JSON.parse(res.body)
}

function parseToolResult(data: any): any {
  const text = data?.result?.content?.[0]?.text
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

test.beforeAll(async () => {
  // Reset screenshots dir
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  // Reset conductor task file from any prior run
  try { if (fs.existsSync(TASK_FILE)) fs.unlinkSync(TASK_FILE) } catch {}

  // Ensure the Unix shim is executable (no-op on Windows, but harmless)
  try { fs.chmodSync(path.join(SHIM_DIR, 'claude'), 0o755) } catch {}

  // Build the app (retry once — electron-vite can flake on Windows)
  const { execSync } = await import('child_process')
  try {
    execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })
  } catch {
    execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })
  }

  // Wipe session.json + any lockfile so we start fresh
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron'),
    path.join(os.homedir(), '.config', 'termpolis'),
    path.join(os.homedir(), 'Library', 'Application Support', 'termpolis'),
  ]
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs',
  })
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue
    const sessionPath = path.join(dir, 'session.json')
    try { fs.writeFileSync(sessionPath, cleanSession) } catch {}
    const lockfile = path.join(dir, 'lockfile')
    try { if (fs.existsSync(lockfile)) fs.unlinkSync(lockfile) } catch {}
  }

  app = await electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
      TERMPOLIS_TEST_PROJECT_CWD: PROJECT_ROOT,
      TERMPOLIS_TEST_SHIM_DIR: SHIM_DIR,
    },
  })

  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Give the MCP server time to bind and write its token/port files
  await page.waitForTimeout(4000)

  const udir = userDataDir()
  mcpToken = fs.readFileSync(path.join(udir, 'mcp-token'), 'utf-8').trim()
  try {
    const raw = fs.readFileSync(path.join(udir, 'mcp-port'), 'utf-8').trim()
    const parsed = parseInt(raw, 10)
    mcpPort = !Number.isNaN(parsed) && parsed > 0 ? parsed : 9315
  } catch {
    mcpPort = 9315
  }

  // Clear any pre-existing swarm state so counts start at 0
  await page.evaluate(async () => {
    await (window as any).swarmAPI.clear()
  })
})

test.afterAll(async () => {
  if (app) await app.close()
  try { if (fs.existsSync(TASK_FILE)) fs.unlinkSync(TASK_FILE) } catch {}
})

const ss = (name: string) => page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true })

// Helper: scoped to the topmost `.fixed` overlay (dashboard or wizard)
const dashboard = () => page.locator('.fixed').filter({ hasText: 'Swarm Dashboard' }).first()
const wizard = () => page.locator('.fixed').filter({ has: page.locator('h2:has-text("Start Swarm")') }).first()

test.describe.serial('Swarm End-to-End', () => {
  test('1. App launches and MCP server is reachable', async () => {
    await expect(page.locator('text=Termpolis').first()).toBeVisible({ timeout: 10000 })

    const health = await httpRequest({
      hostname: '127.0.0.1',
      port: mcpPort,
      path: '/health',
      method: 'GET',
    })
    expect(health.statusCode).toBe(200)
    const body = JSON.parse(health.body)
    expect(body.status).toBe('ok')
    expect(mcpToken.length).toBeGreaterThan(20)
    await ss('01-launched')
  })

  test('2. Open Swarm Dashboard via Ctrl+Shift+S', async () => {
    await page.keyboard.press('Control+Shift+S')
    await expect(page.locator('text=Swarm Dashboard').first()).toBeVisible({ timeout: 5000 })
    await ss('02-dashboard-open')
  })

  test('3. Click Start Swarm → wizard opens (directory picker bypassed by IPC hook)', async () => {
    // Scope to the dashboard overlay — a Welcome-screen card is also titled "Start Swarm"
    const startBtn = dashboard().locator('button:has-text("Start Swarm")').first()
    await expect(startBtn).toBeVisible({ timeout: 3000 })
    await startBtn.click()

    await expect(page.locator('h2:has-text("Start Swarm")')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=Preparing Conductor')).toBeVisible({ timeout: 5000 })
    await ss('03-wizard-preparing')
  })

  test('4. Wizard advances to Describe step (conductor --version handled by shim)', async () => {
    // The conductor runs `claude --version` in its hidden terminal. The test shim
    // routes to mock-claude.cjs which prints a version and exits. No auth prompt
    // is detected, so the wizard advances to the describe step.
    // With TERMPOLIS_TEST_TIMING=1 this happens in ~1s; allow generous slack.
    await expect(wizard().getByText('Describe what you want built', { exact: true })).toBeVisible({ timeout: 60000 })
    await ss('04-wizard-describe')
  })

  test('5. Fill in Goal and click Launch Swarm', async () => {
    const goalText =
      'Build a small contact-form feature — capture name/email/message, validate inputs, and show a confirmation message.'

    const goal = wizard().locator('textarea[placeholder*="contact form"]').first()
    await goal.click()
    await goal.fill(goalText)

    const launch = wizard().locator('button:has-text("Launch Swarm")').first()
    await expect(launch).toBeEnabled()
    await launch.click()

    await expect(page.locator('text=Launching Swarm')).toBeVisible({ timeout: 5000 })
    await ss('05-launching')
  })

  test('6. Conductor terminal is registered in the store (hidden, isConductor=true)', async () => {
    const result: any = await page.waitForFunction(
      () => {
        const getState = (window as any).__termpolis_test_state
        if (typeof getState !== 'function') return null
        const state = getState()
        return (state.terminals || []).find((t: any) => t.isConductor) || null
      },
      null,
      { timeout: 30000 },
    ).then((h) => h.jsonValue())

    expect(result).toBeTruthy()
    expect(result.isConductor).toBe(true)
    expect(result.isSwarm).toBe(true)
    expect(result.hidden).toBe(true)
  })

  test('7. Conductor prompt file was written with the user goal and MCP tool instructions', async () => {
    // The file is written synchronously by sendTask; poll briefly in case of fs timing
    for (let i = 0; i < 20 && !fs.existsSync(TASK_FILE); i++) {
      await page.waitForTimeout(200)
    }
    expect(fs.existsSync(TASK_FILE)).toBeTruthy()

    const content = fs.readFileSync(TASK_FILE, 'utf-8')
    expect(content).toContain('Swarm Conductor')
    expect(content).toContain('swarm_create_task')
    expect(content).toContain('create_terminal')
    expect(content).toContain('contact-form')
  })

  test('8. Smart mock conductor creates 2 tasks via MCP (swarm_create_task)', async () => {
    // Poll the renderer's swarmAPI directly — wait for >=2 tasks or fall back to MCP HTTP
    let tasks: any[] = []
    let lastErr: any = null
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      try {
        const res = await page.evaluate(async () => {
          try {
            const r = await (window as any).swarmAPI.getTasks()
            return { ok: true, r }
          } catch (e: any) {
            return { ok: false, err: String(e?.message || e) }
          }
        })
        if (res.ok && res.r?.success && Array.isArray(res.r.data) && res.r.data.length >= 2) {
          tasks = res.r.data
          break
        }
        lastErr = res.ok ? `data=${JSON.stringify(res.r).slice(0, 300)}` : res.err
      } catch (e: any) {
        lastErr = String(e?.message || e)
      }
      await page.waitForTimeout(1000)
    }

    if (tasks.length < 2) {
      // Diagnostic: query MCP HTTP directly and inspect the conductor terminal buffer
      const mcpList = await mcpCall('swarm_list_tasks', {})
      const mcpTasks = parseToolResult(mcpList)
      const mcpRaw = JSON.stringify(mcpList).slice(0, 400)

      const conductorBuf = await page.evaluate(async () => {
        const s = (window as any).__termpolis_test_state?.()
        const conductor = (s?.terminals || []).find((t: any) => t.isConductor)
        if (!conductor) return { error: 'no-conductor' }
        try {
          const r = await (window as any).termpolis.readTerminalBuffer(conductor.id)
          return { id: conductor.id, output: r?.data?.output?.slice(-3000) || '', success: r?.success }
        } catch (e: any) {
          return { error: String(e?.message || e) }
        }
      })

      // eslint-disable-next-line no-console
      console.log('[Test 8] mcp raw:', mcpRaw)
      // eslint-disable-next-line no-console
      console.log('[Test 8] conductor buffer:', JSON.stringify(conductorBuf, null, 2))

      // Write the buffer to a file so we can read it directly
      fs.writeFileSync(path.join(SCREENSHOTS, 'conductor-buffer.txt'), JSON.stringify(conductorBuf, null, 2))

      throw new Error(`Tasks not created within 90s. lastErr=${lastErr} mcpTasks=${JSON.stringify(mcpTasks).slice(0, 400)}`)
    }

    expect(tasks.length).toBeGreaterThanOrEqual(2)
    const titles = tasks.map((t: any) => t.title)
    expect(titles).toContain('Implement feature')
    expect(titles).toContain('Add tests')
    // NOTE: MCP always sets createdBy='mcp-client' regardless of what the
    // caller passes — this is the server's identity, not the client's claim.
    expect(tasks.every((t: any) => !!t.createdBy)).toBeTruthy()
  })

  test('9. Smart mock conductor spawns 2 agent terminals via MCP (create_terminal)', async () => {
    const agents: any[] = await page.waitForFunction(
      () => {
        const getState = (window as any).__termpolis_test_state
        if (typeof getState !== 'function') return null
        const state = getState()
        const found = (state.terminals || []).filter(
          (t: any) => t.isSwarm && !t.isConductor,
        )
        return found.length >= 2 ? found : null
      },
      null,
      { timeout: 60000 },
    ).then((h) => h.jsonValue())

    expect(agents.length).toBeGreaterThanOrEqual(2)
    const names = agents.map((a: any) => a.name)
    expect(names.some((n: string) => /Implement feature/i.test(n))).toBeTruthy()
    expect(names.some((n: string) => /Add tests/i.test(n))).toBeTruthy()

    // Cross-check via MCP HTTP: list_terminals should include the new agents.
    // (swarm_list_agents reads session.json which only updates after the
    // renderer persists; list_terminals reads live session state.)
    const listed = await mcpCall('list_terminals', {})
    const parsed = parseToolResult(listed)
    expect(Array.isArray(parsed)).toBeTruthy()
    await ss('09-agent-terminals')
  })

  test('10. All tasks reach completed status (conductor → swarm_update_task)', async () => {
    const completed: any[] = await page.waitForFunction(
      async () => {
        const res = await (window as any).swarmAPI.getTasks()
        if (!res.success || !res.data || res.data.length < 2) return null
        const allDone = res.data.every((t: any) => t.status === 'completed' || t.status === 'failed')
        return allDone ? res.data : null
      },
      null,
      { timeout: 60000 },
    ).then((h) => h.jsonValue())

    expect(completed.every((t: any) => t.status === 'completed')).toBeTruthy()
    for (const t of completed) expect(t.result).toBeTruthy()
  })

  test('11. SWARM COMPLETE message is posted to the swarm bus', async () => {
    const msg: any = await page.waitForFunction(
      async () => {
        const res = await (window as any).swarmAPI.getMessages()
        if (!res.success || !res.data) return null
        return res.data.find((m: any) => typeof m.content === 'string' && m.content.includes('SWARM COMPLETE')) || null
      },
      null,
      { timeout: 60000 },
    ).then((h) => h.jsonValue())

    expect(msg).toBeTruthy()
    // MCP server always sets from='mcp-client' regardless of what the caller
    // claims — the identity is the MCP channel, not the client-supplied name.
    expect(['conductor', 'mcp-client']).toContain(msg.from)
    expect(msg.type).toBe('result')
  })

  test('12. Monitoring loop detects completion — swarmCompletionSummary is set', async () => {
    const summary: any = await page.waitForFunction(
      () => {
        const getState = (window as any).__termpolis_test_state
        if (typeof getState !== 'function') return null
        const s = getState()
        return s.swarmCompletionSummary || null
      },
      null,
      { timeout: 120000 },
    ).then((h) => h.jsonValue())

    expect(summary).toBeTruthy()
    expect(summary.message).toBeTruthy()
    expect(Array.isArray(summary.tasks)).toBeTruthy()
    expect(summary.tasks.length).toBeGreaterThanOrEqual(2)
    await ss('12-swarm-complete')
  })

  test('13. MCP HTTP surface reports the same completed state', async () => {
    const listTasks = await mcpCall('swarm_list_tasks', {})
    const tasks = parseToolResult(listTasks)
    expect(Array.isArray(tasks)).toBeTruthy()
    expect(tasks.length).toBeGreaterThanOrEqual(2)
    expect(tasks.every((t: any) => t.status === 'completed')).toBeTruthy()

    const readMsgs = await mcpCall('swarm_read_messages', {})
    const msgs = parseToolResult(readMsgs)
    expect(Array.isArray(msgs)).toBeTruthy()
    expect(msgs.some((m: any) => typeof m.content === 'string' && m.content.includes('SWARM COMPLETE'))).toBeTruthy()
  })

  test('14. App still healthy after the full swarm lifecycle', async () => {
    const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(windowCount).toBeGreaterThan(0)

    const health = await httpRequest({
      hostname: '127.0.0.1',
      port: mcpPort,
      path: '/health',
      method: 'GET',
    })
    expect(health.statusCode).toBe(200)
    await ss('14-final')
  })

  // Regression guard: Claude Code silently fails to register MCP servers when
  // the plugin's .mcp.json lacks the `mcpServers` wrapper. Symptom: conductor
  // posts "analyzing..." then does nothing because it has no tool access.
  // Both the marketplace source AND the cache copy must have the wrapper —
  // Claude reads from cache at startup.
  test('15. Plugin .mcp.json files have the required mcpServers wrapper', async () => {
    const homeDir = os.homedir()
    const pluginPaths = [
      path.join(homeDir, '.claude', 'local-marketplace', 'plugins', 'termpolis', '.mcp.json'),
      path.join(homeDir, '.claude', 'plugins', 'cache', 'local-plugins', 'termpolis', '1.0.0', '.mcp.json'),
    ]

    for (const p of pluginPaths) {
      expect(fs.existsSync(p), `missing: ${p}`).toBeTruthy()
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
      expect(parsed.mcpServers, `no mcpServers wrapper in ${p}`).toBeTruthy()
      expect(parsed.mcpServers.termpolis, `no termpolis entry in ${p}`).toBeTruthy()
      expect(parsed.mcpServers.termpolis.command).toBe('node')
      expect(Array.isArray(parsed.mcpServers.termpolis.args)).toBeTruthy()
      expect(parsed.mcpServers.termpolis.args[0]).toMatch(/stdio-adapter\.cjs$/)
    }
  })
})

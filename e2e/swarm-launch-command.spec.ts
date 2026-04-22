/**
 * Swarm Launch Command — Regression Guards
 * -----------------------------------------
 * Pins the exact shape of the command conductorManager writes to the conductor
 * terminal when the swarm is launched. This protects against three historical
 * regressions that each silently broke the swarm for real users:
 *
 *   v1.11.2 — bare `powershell` failed on pwsh 7 machines (powershell not on PATH)
 *   v1.11.3 — absolute PS 5.1 path worked, but only as a point fix
 *   v1.11.4 — belt-and-suspenders `.cmd` wrapper invoked via `cmd /c` broke when
 *             System32 wasn't on the inherited PATH (cmd.exe unresolvable)
 *   v1.11.5 — pure PowerShell one-liner (current). Runs inline in the already-
 *             running pwsh/PS 5.1 conductor terminal. Zero PATH dependencies.
 *
 * These tests run the renderer inside a real Electron window with the test
 * agent shim wired up, spy on window.termpolis.writeToTerminal, invoke the
 * full sendTask path, and then assert what actually got written.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page

const PROJECT_ROOT = path.resolve('.')
const SHIM_DIR = path.join(PROJECT_ROOT, 'e2e', 'test-shims')
const SCREENSHOTS = 'e2e/screenshots/swarm-launch-command'
const TASK_FILE = path.join(os.homedir(), '.termpolis-conductor-task.md')
const RUN_PS1 = path.join(os.homedir(), '.termpolis-conductor-run.ps1')
const RUN_SH = path.join(os.homedir(), '.termpolis-conductor-run.sh')
const RUN_CMD = path.join(os.homedir(), '.termpolis-conductor-run.cmd')

function userDataDir(): string {
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'termpolis')
  return path.join(os.homedir(), '.config', 'termpolis')
}

test.beforeAll(async () => {
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  // Clear any prior run artifacts so our assertions can't false-pass on stale files
  for (const f of [TASK_FILE, RUN_PS1, RUN_SH, RUN_CMD]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch {}
  }

  try { fs.chmodSync(path.join(SHIM_DIR, 'claude'), 0o755) } catch {}

  const { execSync } = await import('child_process')
  try {
    execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })
  } catch {
    execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })
  }

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
    try { fs.writeFileSync(path.join(dir, 'session.json'), cleanSession) } catch {}
    try {
      const lockfile = path.join(dir, 'lockfile')
      if (fs.existsSync(lockfile)) fs.unlinkSync(lockfile)
    } catch {}
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
  await page.waitForTimeout(3000)

  // Clear any stale launch-cmd hook from a prior app instance
  await page.evaluate(() => {
    try { delete (window as any).__termpolis_last_launch_cmd } catch {}
  })

  // Verify MCP is up before triggering the swarm
  const udir = userDataDir()
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(udir, 'mcp-token'))) break
    await page.waitForTimeout(500)
  }

  await page.evaluate(async () => {
    await (window as any).swarmAPI.clear()
  })
})

test.afterAll(async () => {
  if (app) await app.close()
})

test.describe.serial('Swarm launch command shape', () => {
  test('1. Trigger the full swarm launch flow through the UI', async () => {
    // Open dashboard
    await page.keyboard.press('Control+Shift+S')
    await expect(page.locator('text=Swarm Dashboard').first()).toBeVisible({ timeout: 10000 })

    // Click Start Swarm — the TERMPOLIS_TEST_PROJECT_CWD env bypasses the native picker
    const dashboard = page.locator('.fixed').filter({ hasText: 'Swarm Dashboard' }).first()
    const startBtn = dashboard.locator('button:has-text("Start Swarm")').first()
    await startBtn.click()

    // Wait for the wizard to advance past Preparing Conductor
    await expect(page.locator('h2:has-text("Start Swarm")')).toBeVisible({ timeout: 5000 })

    const wizard = page.locator('.fixed').filter({ has: page.locator('h2:has-text("Start Swarm")') }).first()
    await expect(wizard.getByText('Describe what you want built', { exact: true })).toBeVisible({ timeout: 60000 })

    const goal = wizard.locator('textarea[placeholder*="contact form"]').first()
    await goal.click()
    await goal.fill('Build a tiny feature to validate the launch command.')

    const launch = wizard.locator('button:has-text("Launch Swarm")').first()
    await expect(launch).toBeEnabled()
    await launch.click()

    // Give sendTask a moment to write the script + push the launch command
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${SCREENSHOTS}/01-launched.png` })
  })

  test('2. The .ps1 (Windows) or .sh (Unix) run script was written', async () => {
    if (process.platform === 'win32') {
      // Poll in case of fs-flush delay
      for (let i = 0; i < 40 && !fs.existsSync(RUN_PS1); i++) await page.waitForTimeout(250)
      expect(fs.existsSync(RUN_PS1)).toBe(true)
      const psBody = fs.readFileSync(RUN_PS1, 'utf-8')
      expect(psBody).toContain('claude')
      expect(psBody).toContain('--dangerously-skip-permissions')
    } else {
      for (let i = 0; i < 40 && !fs.existsSync(RUN_SH); i++) await page.waitForTimeout(250)
      expect(fs.existsSync(RUN_SH)).toBe(true)
      const shBody = fs.readFileSync(RUN_SH, 'utf-8')
      expect(shBody).toContain('claude')
      expect(shBody).toContain('--dangerously-skip-permissions')
    }
  })

  test('3. No .cmd wrapper is written (v1.11.4 regression guard)', async () => {
    // Negative-presence check: the v1.11.4 approach wrote this file; v1.11.5+ must not.
    expect(fs.existsSync(RUN_CMD)).toBe(false)
  })

  test('4. Capture the launch command via the diagnostic hook', async () => {
    // Poll for the hook — sendTask sets it right after writing to the terminal
    let cmd: string | null = null
    for (let i = 0; i < 40; i++) {
      cmd = await page.evaluate(() => (window as any).__termpolis_last_launch_cmd ?? null)
      if (cmd) break
      await page.waitForTimeout(250)
    }
    expect(cmd).toBeTruthy()

    // Persist for debugging / post-mortem
    fs.writeFileSync(
      path.join(SCREENSHOTS, 'launch-command.txt'),
      `platform=${process.platform}\n\n${cmd}`,
    )

    const needle = process.platform === 'win32' ? '.termpolis-conductor-run.ps1' : '.termpolis-conductor-run.sh'
    expect(cmd!.includes(needle)).toBe(true)
  })

  test('5. Windows launch uses pure PowerShell (no bare `powershell`, no `cmd`)', async () => {
    test.skip(process.platform !== 'win32', 'Windows-only assertion')

    const cmd: string = await page.evaluate(() => (window as any).__termpolis_last_launch_cmd ?? '')
    expect(cmd).toBeTruthy()

    // Regression guards for the three historical breakage modes:
    //   v1.11.2 — bare `powershell ` (failed on pwsh 7: not on PATH)
    //   v1.11.4 — bare `cmd ` or `cmd /c` (failed when System32 not on PATH)
    expect(cmd.startsWith('powershell '), `v1.11.2 regression: command starts with bare powershell: ${cmd}`).toBe(false)
    expect(cmd.startsWith('cmd '), `v1.11.4 regression: command starts with bare cmd: ${cmd}`).toBe(false)
    expect(cmd.includes('cmd /c'), `v1.11.4 regression: command uses cmd /c: ${cmd}`).toBe(false)
  })

  test('6. Windows launch command has the expected inline-PS shape', async () => {
    test.skip(process.platform !== 'win32', 'Windows-only assertion')

    const cmd: string = await page.evaluate(() => (window as any).__termpolis_last_launch_cmd ?? '')
    expect(cmd).toBeTruthy()

    // Single line — no embedded newlines
    expect(cmd.includes('\n')).toBe(false)

    // Uses absolute PS 5.1 path (primary)
    expect(cmd).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')

    // Uses PS Test-Path fallback + current PID lookup (secondary)
    expect(cmd).toMatch(/if \(-not \(Test-Path \$p\)\)/)
    expect(cmd).toContain('(Get-Process -Id $PID).Path')

    // Invokes the script via the call operator with ExecutionPolicy Bypass
    expect(cmd).toMatch(/& \$p -ExecutionPolicy Bypass -File '[^']+\.ps1'/)
  })

  test('7. Unix launch command invokes bash directly', async () => {
    test.skip(process.platform === 'win32', 'Unix-only assertion')

    const cmd: string = await page.evaluate(() => (window as any).__termpolis_last_launch_cmd ?? '')
    expect(cmd).toBeTruthy()
    expect(cmd.startsWith('bash ')).toBe(true)
  })
})

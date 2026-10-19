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
 *   v1.53.1 — the prompt goes on stdin, not argv (GitHub #36). PS 5.1 ended the
 *             argument at every `"` in it, the rest arrived as options, and
 *             claude exited before it did anything.
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
import { e2eLaunchArgs, dismissOnboarding, e2eUserDataDir, e2eShimEnv, quitApp, ensureE2eBuild } from './helpers/launch'
import { findConductorExit, type ConductorExit } from '../src/renderer/src/lib/conductorLaunch'

let app: ElectronApplication
let page: Page

const PROJECT_ROOT = path.resolve('.')
const SCREENSHOTS = 'e2e/screenshots/swarm-launch-command'
const TASK_FILE = path.join(os.homedir(), '.termpolis-conductor-task.md')
const RUN_PS1 = path.join(os.homedir(), '.termpolis-conductor-run.ps1')
const RUN_SH = path.join(os.homedir(), '.termpolis-conductor-run.sh')
const RUN_CMD = path.join(os.homedir(), '.termpolis-conductor-run.cmd')
// Quotes, option-like words and non-ASCII: each one broke or garbled the argv delivery.
const GOAL = 'Build a tiny feature to validate the launch command: run "npm test --watch" -NoProfile, then reply "all good" — ✓ →'

function userDataDir(): string {
  // `--user-data-dir=X` makes X the app's userData path on win32, darwin AND linux —
  // the old per-platform switch pointed the non-Windows branches at the real profile.
  return e2eUserDataDir('swarm-launch-command')
}
// Where the mock conductor writes the argv and prompt it was handed (MOCK_CLAUDE_RECORD).
const RECEIVED = path.join(userDataDir(), 'mock-claude-received.json')

test.beforeAll(async () => {
  if (fs.existsSync(SCREENSHOTS)) fs.rmSync(SCREENSHOTS, { recursive: true })
  fs.mkdirSync(SCREENSHOTS, { recursive: true })

  // Clear any prior run artifacts so our assertions can't false-pass on stale files
  for (const f of [TASK_FILE, RUN_PS1, RUN_SH, RUN_CMD, RECEIVED]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch {}
  }


  ensureE2eBuild()

  const candidates = [
    e2eUserDataDir('swarm-launch-command'),
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
    args: e2eLaunchArgs('swarm-launch-command'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
      TERMPOLIS_TEST_PROJECT_CWD: PROJECT_ROOT,
      MOCK_CLAUDE_RECORD: RECEIVED,
      ...e2eShimEnv('swarm-launch-command'),
    },
  })

  page = await app.firstWindow()
  await dismissOnboarding(page)
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
  await quitApp(app)
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
    await goal.fill(GOAL)

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
      const written = fs.readFileSync(RUN_PS1, 'utf-8')
      // A BOM first, so Windows PowerShell 5.1 reads the paths in it as UTF-8, not as ANSI.
      expect(written.charCodeAt(0)).toBe(0xfeff)
      const psBody = written.slice(1)
      expect(psBody).toContain('claude')
      expect(psBody).toContain('--dangerously-skip-permissions')
      // The task is piped in, as UTF-8 without a BOM, and never put on the command line.
      // Under a session id of its own, whose transcript Trace follows.
      expect(psBody).toMatch(/^ {2}Get-Content -Raw -Encoding UTF8 -LiteralPath '[^']+\.termpolis-conductor-task\.md' \| \S.* -p (--mcp-config '[^']+' )?--session-id '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}' --dangerously-skip-permissions$/m)
      expect(psBody).toContain('$OutputEncoding = $enc')
      expect(psBody).toContain('[Console]::InputEncoding = $enc')
      expect(psBody).not.toContain('$task')
      // It marks where its output starts, and reports claude's exit on a line of its own: 1 when
      // claude never started, after two blank lines.
      expect(psBody.startsWith("Write-Output '[termpolis-conductor-started]'\n")).toBe(true)
      expect(psBody).toContain("\n$global:LASTEXITCODE = $null\nif ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {\n")
      // In Constrained Language Mode, Start-Process hands claude the task file itself, with no BOM.
      expect(psBody).toContain(' -NoNewWindow -PassThru -RedirectStandardInput ')
      expect(psBody).toMatch(/\n\}\n\$code = \$LASTEXITCODE\n[\s\S]*Write-Output ''\nWrite-Output ''\nWrite-Output "\[termpolis-conductor-exited\] \$code"\nexit \$code\n$/)
    } else {
      for (let i = 0; i < 40 && !fs.existsSync(RUN_SH); i++) await page.waitForTimeout(250)
      expect(fs.existsSync(RUN_SH)).toBe(true)
      const shBody = fs.readFileSync(RUN_SH, 'utf-8')
      expect(shBody).toContain('claude')
      expect(shBody).toContain('--dangerously-skip-permissions')
      expect(shBody).toMatch(/ -p (--mcp-config '[^']+' )?--session-id '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}' --dangerously-skip-permissions < "\$TASK_FILE"$/m)
      expect(shBody).not.toContain('$(cat')
      expect(shBody).toContain("\necho '[termpolis-conductor-started]'\n")
      expect(shBody).toMatch(/< "\$TASK_FILE"\ncode=\$\?\necho\necho "\[termpolis-conductor-exited\] \$code"\nexit \$code\n$/)
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

  test('8. The conductor got the task on stdin, byte for byte, and only flags on its command line', async () => {
    // The mock conductor records what it was handed (MOCK_CLAUDE_RECORD) as soon as it has read
    // its stdin. Before v1.53.1 a Windows run handed it the prompt in pieces, and it exited.
    let received: { argv: string[]; prompt: string } | null = null
    for (let i = 0; i < 80 && !received; i++) {
      try { received = JSON.parse(fs.readFileSync(RECEIVED, 'utf-8')) } catch { await page.waitForTimeout(250) }
    }
    expect(received, `the mock conductor never recorded its input at ${RECEIVED}`).toBeTruthy()

    const task = fs.readFileSync(TASK_FILE, 'utf-8')
    expect(task).toContain(GOAL)
    // PowerShell appends one CRLF to what it pipes; bash's `<` hands the file over as it is.
    expect(received!.prompt).toBe(process.platform === 'win32' ? task + '\r\n' : task)
    expect(received!.argv).toEqual([
      '-p', '--mcp-config', expect.stringMatching(/claude-mcp-config\.json$/),
      '--session-id', expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/), '--dangerously-skip-permissions',
    ])
  })

  test('9. The conductor terminal shows the exit report, and the swarm ends on its tasks', async () => {
    // GitHub #36: when claude exited, the conductor terminal's own shell lived on, so nothing told
    // the monitor. The run script reports the exit on a line of its own. This reads it back out of
    // the REAL terminal (ConPTY on Windows) the way the monitor does. The mock exits 0 once its
    // tasks are done, so the completed tasks, not the exit, must end the swarm.
    let exit: ConductorExit | null = null
    let output = ''
    for (let i = 0; i < 120 && !exit; i++) {
      output = await page.evaluate(async () => {
        const conductor = (window as any).__termpolis_test_state?.().terminals.find((t: any) => t.isConductor)
        if (!conductor) return ''
        const res = await (window as any).termpolis.readTerminalBuffer(conductor.id)
        return res?.success && res.data ? res.data.output : ''
      })
      exit = findConductorExit(output)
      if (!exit) await page.waitForTimeout(500)
    }
    fs.writeFileSync(path.join(SCREENSHOTS, 'conductor-output.txt'), output)
    expect(exit, 'no [termpolis-conductor-exited] line in the conductor terminal (see conductor-output.txt)').toBeTruthy()
    expect(exit!.code).toBe(0)
    expect(exit!.lastLines.join('\n')).not.toContain('-ExecutionPolicy') // the echoed launch line is left out

    let state: any = null
    for (let i = 0; i < 60; i++) {
      state = await page.evaluate(() => (window as any).__termpolis_test_state?.() ?? null)
      if (state && !state.swarmActive && state.swarmCompletionSummary) break
      await page.waitForTimeout(500)
    }
    expect(state?.swarmActive).toBe(false)
    expect(state?.swarmCompletionSummary, 'the swarm should end on its completed tasks').toBeTruthy()
    expect(state.swarmCompletionSummary.tasks.length).toBeGreaterThanOrEqual(2)
    expect(state.swarmNotification?.message ?? '').not.toMatch(/Conductor exited/)
  })
})

/**
 * Compaction re-primer E2E — verifies the FULL flow in the real Electron app:
 *
 *   terminal output "Compacting conversation" -> TerminalPane.onTerminalData
 *   -> useCompactionReprimer.onOutput (arms, debounces) -> injectAutoPrimer
 *   -> memoryBuildPrimer (real seeded memory, relevance gate) -> writeToTerminal
 *   (bracketed paste of the one-line memory_primer POINTER — not the digest)
 *
 * Seeds a real memory, detects an agent via injected output, feeds the compaction
 * marker, then asserts a bracketed-paste re-prime actually reached the terminal — the
 * one bit unit tests couldn't cover (the TerminalPane wiring + the real paste).
 * The launch primer is disabled so the only bracketed paste is the re-prime.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

const MARKER = 'E2E-REPRIME-MARKER'
const BP_START = '\x1b[200~'

test.beforeAll(async () => {
  ensureE2eBuild()

  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-reprime-'))
  fs.writeFileSync(
    path.join(isolatedUserData, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs' }),
  )

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
      // Isolate the re-prime: disable the launch primer so the ONLY bracketed paste
      // is the compaction re-prime; ensure the re-prime is on.
      localStorage.setItem('termpolis.memory.autoPrimerOnLaunch', '0')
      localStorage.setItem('termpolis.memory.autoReprimeOnCompaction', '1')
    } catch {}
  })
  const dlg = page.locator('[aria-labelledby="onboarding-title"]')
  if (await dlg.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  await quitApp(app)
  if (isolatedUserData) {
    try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch {}
  }
})

async function createTerminal(name: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(400)
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

test.describe.serial('Compaction re-primer (real app, full flow)', () => {
  test('seeded memory produces a non-empty primer (precondition)', async () => {
    const primer = await page.evaluate(async (marker) => {
      const api = (window as any).termpolis
      await api.memoryWrite({
        agentId: 'e2e', kind: 'fact',
        content: `${marker} recent work, key decisions, conventions and context for this project auth module`,
      })
      const r = await api.memoryBuildPrimer('recent work, decisions, conventions, and context for proj')
      return (r && r.data) || ''
    }, MARKER)
    expect(primer).toContain(MARKER)
  })

  test('a "Compacting conversation" marker triggers a re-prime paste into the terminal', async () => {
    await createTerminal('Reprime1')
    const termId: string = await page.evaluate(() => {
      const s = (window as any).__termpolis_test_state?.()
      const ts = s?.terminals || []
      return ts.length ? ts[ts.length - 1].id : ''
    })
    expect(termId).toBeTruthy()

    // 1) Detect an agent (the re-primer only fires when an agent is present). The
    //    launch primer is disabled, so this does NOT paste.
    await page.evaluate((id) => (window as any).termpolis.__testTerminalData(id, 'claude code v1.0 starting\r\n'),
      termId)
    await page.waitForTimeout(1200) // let agent detection re-render (updates the re-primer's agent ref)

    // 2) Feed the compaction marker → the re-primer arms and, once output settles
    //    (~3s debounce), fires injectAutoPrimer.
    await page.evaluate((id) => (window as any).termpolis.__testTerminalData(id, '✻ Compacting conversation… (2m 30s)\r\n'),
      termId)

    // 3) Poll the recorded terminal writes for the bracketed-paste re-prime.
    const pasted: string | null = await page.evaluate(async ({ id, bp }) => {
      const api = (window as any).termpolis
      for (let i = 0; i < 40; i++) { // up to ~8s (covers the 3s debounce + processing)
        const r = await api.__testTerminalWrites()
        const writes = (r && r.data) || []
        const hit = writes.find((w: any) => w.id === id && typeof w.data === 'string' && w.data.includes(bp))
        if (hit) return hit.data
        await new Promise((res) => setTimeout(res, 200))
      }
      return null
    }, { id: termId, bp: BP_START })

    expect(pasted, 'expected a bracketed-paste re-prime to reach the terminal').toBeTruthy()
    // The paste is the one-line pointer (content loads behind the scenes via MCP),
    // framed as background only — never the digest itself, never an auto-continue.
    expect(pasted).toContain('memory_primer')
    expect(pasted).toContain('do NOT act on it')
    expect(pasted).not.toContain(MARKER)
  })

  test('no second re-prime fires within the cooldown (one paste per compaction)', async () => {
    const before: number = await page.evaluate(async () => {
      const r = await (window as any).termpolis.__testTerminalWrites()
      return ((r && r.data) || []).filter((w: any) => typeof w.data === 'string' && w.data.includes('\x1b[200~')).length
    })
    // A lingering marker in the same window must not re-fire (cooldown guards it).
    const termId: string = await page.evaluate(() => {
      const ts = (window as any).__termpolis_test_state?.()?.terminals || []
      return ts.length ? ts[ts.length - 1].id : ''
    })
    await page.evaluate((id) => (window as any).termpolis.__testTerminalData(id, 'Compacting conversation again\r\n'), termId)
    await page.waitForTimeout(4500)
    const after: number = await page.evaluate(async () => {
      const r = await (window as any).termpolis.__testTerminalWrites()
      return ((r && r.data) || []).filter((w: any) => typeof w.data === 'string' && w.data.includes('\x1b[200~')).length
    })
    expect(after).toBe(before) // cooldown held — no extra paste
  })
})

/**
 * shellAlone (v1.54.2) is the guard that stops a task being typed at a bare prompt: it asks the OS whether anything but
 * the shell runs in a terminal. On Windows it reads the terminal's console with a small helper script. That helper used
 * to be forked from the main process on every ask (0.1-0.3 s of the thread that echoes keystrokes, on a busy laptop);
 * it now runs through the proc host (utility process). Its failure mode is SILENT: if the helper cannot run, every answer
 * is "cannot tell" (null) and the guard is off. So this drives a REAL cmd.exe: alone at its prompt it answers true, with
 * a program running on its console it answers false, and after that program ends it answers true again.
 * Windows only: the other platforms ask ps and pgrep, which tests/electron/shellAlone.test.ts covers.
 */
test.describe.serial('shellAlone answers for a real shell, through the proc host (Windows)', () => {
  test.skip(process.platform !== 'win32', 'Windows reads the console; Unix asks ps and pgrep (unit-tested)')

  const ID = 'e2e-shell-alone-cmd'

  /** Ask until the answer is `want` (the console takes a moment to show a program starting or ending). */
  async function aloneBecomes(want: boolean): Promise<boolean | null> {
    return page.evaluate(async ({ id, want: w }) => {
      const api = (window as any).termpolis
      let last: boolean | null = null
      for (let i = 0; i < 40; i++) { // up to ~40 s: the helper takes 1-2 s a try
        const r = await api.terminalShellAlone(id)
        last = r && r.success ? r.data : null
        if (last === w) return last
        await new Promise((res) => setTimeout(res, 500))
      }
      return last
    }, { id: ID, want })
  }

  test('opens a real cmd.exe', async () => {
    const res = await page.evaluate(async (id) => (window as any).termpolis.createTerminal(id, 'cmd', 'C:\\Windows'), ID)
    expect(res.success, JSON.stringify(res)).toBe(true)
  })

  test('answers true when nothing but the shell runs (never null: null would switch the guard off)', async () => {
    expect(await aloneBecomes(true)).toBe(true)
  })

  test('answers false while a program runs on the shell\'s console', async () => {
    await page.evaluate((id) => (window as any).termpolis.writeToTerminal(id, 'timeout /t 60 /nobreak >nul\r'), ID)
    expect(await aloneBecomes(false)).toBe(false)
  })

  test('answers true again once that program has ended', async () => {
    await page.evaluate((id) => (window as any).termpolis.writeToTerminal(id, '\x03'), ID)
    expect(await aloneBecomes(true)).toBe(true)
  })

  test('closes the terminal', async () => {
    await page.evaluate((id) => (window as any).termpolis.killTerminal(id), ID)
  })
})

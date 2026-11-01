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
 *
 * The pointer is typed only where something runs in the terminal besides its shell: the app asks
 * the OS (terminalShellAlone, shellAlone.ts) before the paste and before the Enter. The injected
 * output above is no process, so the first terminal gets a real one to stand in for the agent,
 * and a second terminal with none proves that nothing is typed at a bare shell prompt.
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

/** The id of the terminal created last. */
async function lastTerminalId(): Promise<string> {
  return page.evaluate(() => {
    const ts = (window as any).__termpolis_test_state?.()?.terminals || []
    return ts.length ? ts[ts.length - 1].id : ''
  })
}

/**
 * Asks the OS "does nothing run in this terminal but its shell?" until the answer is the one
 * wanted or `ms` is up, and returns the last answer: true, false, null (it cannot tell) or
 * undefined (the call failed). `alone` wants a definite yes. `running` wants anything else: a
 * process seen there, or an OS that cannot tell (the re-primer then types as it always did).
 * On Windows each answer takes a second or two, so this is a deadline, not a count.
 */
async function askShellAlone(termId: string, wanted: 'alone' | 'running', ms: number): Promise<boolean | null | undefined> {
  return page.evaluate(async ({ id, want, budget }) => {
    const api = (window as any).termpolis
    const until = Date.now() + budget
    let last: boolean | null | undefined
    while (Date.now() < until) {
      const r = await api.terminalShellAlone(id)
      last = r && r.success ? r.data : undefined
      if (want === 'alone' ? last === true : last !== true) break
      await new Promise((res) => setTimeout(res, 500))
    }
    return last
  }, { id: termId, want: wanted, budget: ms })
}

/** The bracketed pastes written to one terminal so far (a pointer is one). */
async function pastesTo(termId: string): Promise<number> {
  return page.evaluate(async ({ id, bp }) => {
    const r = await (window as any).termpolis.__testTerminalWrites()
    return ((r && r.data) || []).filter((w: any) => w.id === id && typeof w.data === 'string' && w.data.includes(bp)).length
  }, { id: termId, bp: BP_START })
}

// How long the first test saw the re-prime take, so the last one waits longer than that.
let rePrimeMs = 8000

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
    const termId = await lastTerminalId()
    expect(termId).toBeTruthy()

    // 0) A real process in the terminal, for the OS to find there. The injected output below is
    //    no agent, and the pointer is not typed where nothing runs but the shell. Not mock-claude:
    //    it opens on a trust prompt, which the re-primer waits out.
    await page.evaluate((id) => (window as any).termpolis.writeToTerminal(id, 'node -e "setInterval(Boolean,1e3)"\r'), termId)
    expect(await askShellAlone(termId, 'running', 45_000), 'expected the OS to see node running in the terminal').not.toBe(true)

    // 1) Detect an agent (the re-primer only fires when an agent is present). The
    //    launch primer is disabled, so this does NOT paste.
    await page.evaluate((id) => (window as any).termpolis.__testTerminalData(id, 'claude code v1.0 starting\r\n'),
      termId)
    await page.waitForTimeout(1200) // let agent detection re-render (updates the re-primer's agent ref)

    // 2) Feed the compaction marker → the re-primer arms and, once output settles
    //    (~3s debounce), fires injectAutoPrimer.
    await page.evaluate((id) => (window as any).termpolis.__testTerminalData(id, '✻ Compacting conversation… (2m 30s)\r\n'),
      termId)
    const fedAt = Date.now()

    // 3) Poll the recorded terminal writes for the bracketed-paste re-prime. The deadline covers
    //    the 3s debounce, the screen reads and the OS question before the paste (a second or two on Windows).
    const pasted: string | null = await page.evaluate(async ({ id, bp }) => {
      const api = (window as any).termpolis
      const until = Date.now() + 40_000
      while (Date.now() < until) {
        const r = await api.__testTerminalWrites()
        const writes = (r && r.data) || []
        const hit = writes.find((w: any) => w.id === id && typeof w.data === 'string' && w.data.includes(bp))
        if (hit) return hit.data
        await new Promise((res) => setTimeout(res, 200))
      }
      return null
    }, { id: termId, bp: BP_START })
    rePrimeMs = Date.now() - fedAt

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

  test('nothing is typed at the prompt of a terminal whose agent has exited', async () => {
    // Only the shell runs here: what an agent that died at startup leaves behind. The same
    // signals as above (an agent on screen, a compaction marker) and the same app, so the one
    // difference is what the OS says runs in the terminal.
    await createTerminal('Reprime2')
    const termId = await lastTerminalId()
    expect(termId).toBeTruthy()
    const alone = await askShellAlone(termId, 'alone', 30_000)
    // The OS reads a terminal's processes only for the shells it knows (bash, zsh, fish, sh, ksh,
    // and PowerShell, cmd and Git Bash on Windows). For any other shell it answers null, and the
    // guard has nothing to act on: the pointer is typed, as it always was.
    test.skip(alone === null, "the OS cannot tell what runs in this terminal's shell, so the guard has nothing to act on")
    expect(alone, 'expected the OS to say only the shell runs in the idle terminal').toBe(true)

    await page.evaluate((id) => (window as any).termpolis.__testTerminalData(id, 'claude code v1.0 starting\r\n'),
      termId)
    await page.waitForTimeout(1200)
    await page.evaluate((id) => (window as any).termpolis.__testTerminalData(id, '✻ Compacting conversation… (2m 30s)\r\n'),
      termId)

    // Longer than the first test saw the same flow take, so a pointer that was going to be typed has been.
    await page.waitForTimeout(Math.max(12_000, rePrimeMs * 2 + 3000))
    expect(await pastesTo(termId), 'a pointer was typed at a bare shell prompt').toBe(0)
    // Still only a shell: the silence is the OS's answer, not an agent that came and went.
    expect(await askShellAlone(termId, 'alone', 10_000)).toBe(true)
  })
})

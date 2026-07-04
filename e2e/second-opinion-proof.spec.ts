import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'

// Proves the Second Opinion REVIEW pipeline works end-to-end with REAL agents — Claude,
// Codex, and Gemini — through the real IPC (`agent:second-opinion`) → headless invoke →
// feedback. The UI (dropdown structure, install-gating, AI-terminal gating, capture, and
// bracketed-paste inject) is covered by the TerminalPane component tests; this spec
// exercises the part that can't be unit-tested: the actual CLI reviews and the per-agent
// invocation (Claude `-p`, Codex `exec`, Gemini `-p`). Production Termpolis must be closed.

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({ args: [path.resolve('out/main/index.js')], env: { ...process.env, NODE_ENV: 'test' } })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})
test.afterAll(async () => { await app?.close() })

const CONTENT = 'PROPOSED SOLUTION: sort a 1,000,000-element list with bubble sort because it is simple and easy to read.'

async function review(agent: string, model?: string): Promise<{ success: boolean; data?: { feedback: string }; error?: string }> {
  return page.evaluate(
    async ({ agent, model, content }) => (window as any).termpolis.secondOpinion({ agent, model, content }),
    { agent, model, content: CONTENT },
  )
}

// One test per agent (each gets its own 120s budget; the main-process handler caps the
// review at 90s). Claude + Codex are REQUIRED. Gemini is account-gated (its free-tier
// headless client was deprecated in favour of Antigravity), so if the CLI can't auth we
// skip WITH the reason rather than fail — the invocation is correct and it passes the
// moment the account is eligible.
for (const { agent, model, label, required } of [
  { agent: 'claude', model: 'haiku', label: 'Claude (Haiku)', required: true },
  { agent: 'codex', model: undefined, label: 'Codex (exec)', required: true },
  { agent: 'gemini', model: undefined, label: 'Gemini (agy)', required: true },
]) {
  test(`Second Opinion review runs end-to-end with ${label}`, async () => {
    test.setTimeout(120000)
    const res = await review(agent, model)
    if (!res?.success) {
      if (required) expect(res?.success, `${label} review failed: ${res?.error || 'no response'}`).toBe(true)
      else test.skip(true, `${label} unavailable (account/auth): ${(res?.error || '').slice(0, 180)}`)
      return
    }
    const feedback = res.data?.feedback || ''
    expect(feedback.length, `${label} should return non-empty review feedback`).toBeGreaterThan(10)
    // eslint-disable-next-line no-console
    console.log(`\n===== ${label} second opinion (${feedback.length} chars) =====\n${feedback.slice(0, 600)}\n`)
  })
}

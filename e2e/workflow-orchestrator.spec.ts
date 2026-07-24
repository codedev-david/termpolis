/**
 * Workflow Orchestrator — end-to-end proof.
 *
 * Authors a two-step workflow through the REAL Designer UI in the running
 * Electron app — a headless Command step that runs `exit 0` on a real PTY, then
 * a Control "notify" step — Saves it to disk, opens the Run tab, clicks Run, and
 * asserts BOTH nodes on the live timeline reach `succeeded` and the run bar
 * reports overall completion.
 *
 * This is the whole-pipe proof the unit suites can't give on their own: renderer
 * authoring → workflow:save YAML → workflow:run (trust gate + engine) → real
 * spawnTerminal command substrate → workflow:run-event IPC → store.applyRunEvent
 * → Runner timeline. Command (real bash) + Control (pure) are exercised here;
 * Agent/Skill steps drive external CLIs and stay covered by the unit fakes so CI
 * never shells out to claude/codex/gemini.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

const WF_NAME = 'E2E Orchestrator'

let app: ElectronApplication
let page: Page
let isolatedUserData: string
// The workflow we author lands under <homedir>/.termpolis; remember it so
// afterAll can delete it and not litter the real profile on a dev machine.
let created: { cwd: string; id: string } | null = null

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // Isolate Electron's userData (session.json, trusted-workspaces.json) from the
  // developer's real ~/AppData/Roaming/termpolis profile — see chrome-smoke.
  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-wf-'))
  const clean = JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'bash', viewMode: 'tabs' })
  fs.writeFileSync(path.join(isolatedUserData, 'session.json'), clean)

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
      // Ubuntu GHA runners ship chrome-sandbox without SUID root; pass no-sandbox
      // up-front on Linux (the chromium runtime checks before app JS runs).
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
      TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
    },
  })
  // Surface the Electron main-process stderr in the CI step log. Command steps
  // spawn a real PTY in the main process; when node-pty can't posix_spawn the
  // shell on a CI runner the only evidence is main's stderr, which Playwright
  // does NOT forward on its own. Piping it here makes the exact executable +
  // errno visible when a spawn-dependent step fails on a runner.
  app.process().stderr?.on('data', (d: Buffer) => console.log('[app stderr] ' + d.toString().trimEnd()))
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Dismiss the first-run onboarding modal if it appears.
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  // Clean the workflow we wrote into the real homedir before tearing down IPC.
  try {
    if (created && page) {
      await page.evaluate(c => window.termpolis.deleteWorkflow(c.cwd, c.id), created)
    }
  } catch { /* best effort */ }
  if (app) await app.close()
  if (isolatedUserData) {
    try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('author a Command + Control workflow, run it, and watch both steps go green', async () => {
  // The workflow project dir the sidebar resolves with no terminals open is the
  // homedir. getHomedir() returns the {success,data} IPC envelope (the renderer
  // unwraps it via lib/homedir), so unwrap it to the raw path string here. Trust
  // it through the app's own IPC so both the trust-store write and the
  // workflow:run trust check normalize the same string — no path drift.
  const home = await page.evaluate(() => window.termpolis.getHomedir())
  const cwd = home && home.success && home.data ? home.data : ''
  expect(typeof cwd).toBe('string')
  expect(cwd).toBeTruthy()
  await page.evaluate(c => window.termpolis.workspaceTrust(c), cwd)

  // 1. Open the permanent Workflows sidebar section → New Workflow.
  await page.locator('button[title="New Workflow"]').click()
  // "+" opens a create menu; "Blank workflow" opens the author overlay.
  await page.getByRole('menuitem', { name: 'Blank workflow' }).click()
  const dialog = page.locator('[role="dialog"][aria-label="Workflow"]')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Workflow name').fill(WF_NAME)

  // 2. Add a headless Command step running `exit 0` (visible stays unchecked).
  await dialog.locator('button[title="Insert a step"]').first().click()
  await dialog.getByRole('button', { name: 'Command', exact: true }).click()
  await expect(dialog.locator('[data-testid="step-card"]')).toHaveCount(1)
  await dialog.getByLabel('Inline command').fill('exit 0')

  // 3. Add a Control "notify" step after it (last gap = after the command).
  await dialog.locator('button[title="Insert a step"]').last().click()
  await dialog.getByRole('button', { name: 'Control', exact: true }).click()
  await expect(dialog.locator('[data-testid="step-card"]')).toHaveCount(2)
  await dialog.getByLabel('Control action').selectOption('notify')
  await dialog.getByLabel('Notify message').fill('workflow complete')

  // 4. Save → persists YAML under <cwd>/.termpolis/workflows so Run can load it.
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()

  // 5. Confirm persistence deterministically and capture the id for cleanup.
  await expect
    .poll(async () => {
      const res = await page.evaluate(c => window.termpolis.listWorkflows(c), cwd)
      return (res.data ?? []).some((w: { name: string }) => w.name === WF_NAME)
    }, { timeout: 10_000 })
    .toBe(true)
  const list = await page.evaluate(c => window.termpolis.listWorkflows(c), cwd)
  const saved = (list.data ?? []).find((w: { name: string; id: string }) => w.name === WF_NAME)
  expect(saved).toBeTruthy()
  created = { cwd, id: saved!.id }

  // 6. Switch to the Run tab and start the run.
  await dialog.getByLabel('Run tab').click()
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()

  // 7. Both step nodes must reach `succeeded` on the live timeline. The Runner
  //    renders one <li data-testid="step-node-{id}"> per step with a
  //    step-status-{status} class the store reducer drives from run events.
  await expect(dialog.locator('[data-testid^="step-node-"]')).toHaveCount(2)
  await expect(
    dialog.locator('[data-testid^="step-node-"].step-status-succeeded'),
  ).toHaveCount(2, { timeout: 30_000 })

  // 8. The run bar reflects overall completion. The run-status <span> is the
  //    only node whose text is `succeeded` — step nodes encode status via CSS
  //    class, not text — so this uniquely targets the run bar.
  await expect(dialog.getByText('succeeded')).toBeVisible({ timeout: 10_000 })
})

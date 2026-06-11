/**
 * Voice capture E2E — gates the ONE thing the headless unit suite cannot prove:
 * that the real `getUserMedia` → `AudioContext` capture path works in the packaged
 * Electron runtime. The unit tests stub the mic and the transcriber by design
 * (no audio device in jsdom; the Whisper worker can't load there).
 *
 * How it stays deterministic and cheap:
 *  - Chromium's FAKE audio device (`--use-fake-device-for-media-stream`) feeds
 *    synthetic frames, so getUserMedia resolves headlessly under xvfb.
 *  - The CLOUD STT engine is network-stubbed via page.route, so the transcript
 *    is fixed and NO on-device model is ever loaded.
 *
 * What it proves end-to-end: clicking the on-pane mic button performs REAL mic
 * acquisition (the red "Listening…" badge only renders once getUserMedia
 * resolved AND the capture graph is wired), and clicking the badge actually
 * STOPS capture — the runtime proof of the "never goes away" fix. The
 * transcript→UI decision itself (inject vs confirm-before-run) is exhaustively
 * covered by the unit suite (voicePipeline + useVoiceInput); it needs the
 * on-device Whisper model, which can't load headlessly, so it is intentionally
 * out of scope here. The cloud engine + network stub are used only so a stop
 * resolves instantly without loading that model.
 *
 * Isolated --user-data-dir gives this its own single-instance lock, so it
 * coexists with a developer's running app instead of fighting it for the lock.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

// The fixed transcript the stubbed cloud STT endpoint returns. Distinct enough
// that asserting on it can't be satisfied by stray UI text.
const STT_TEXT = 'voice capture e2e ok'

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // Isolated profile: its own single-instance lock (so it won't collide with a
  // dev app) and a seeded session that turns voice ON with the network-stubbable
  // cloud engine — so the heavy local Whisper model is never loaded in CI.
  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-voice-'))
  const session = JSON.stringify({
    terminals: [],
    workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
    voiceSettings: {
      enabled: true,
      engine: 'cloud',
      model: 'onnx-community/distil-whisper-large-v3.5-ONNX',
      pushToTalkKey: 'Ctrl+Shift+L',
      pushToTalkMode: 'hold',
      autoSubmitInAgent: false,
      correctionEnabled: false,
      confirmBeforeRunInShell: true,
      cloudEndpoint: 'https://stt.e2e.local/transcribe',
    },
  })
  fs.writeFileSync(path.join(isolatedUserData, 'session.json'), session)

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
      // Feed a synthetic mic so getUserMedia resolves with no hardware. Passed
      // as launch args (not app.commandLine) because Chromium's media stack reads
      // them before app JS runs — the same reason --no-sandbox is passed here.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Stub the cloud STT endpoint: deterministic transcript, no model load, and
  // the result never depends on what the fake device actually emits.
  await page.route('**/transcribe', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: STT_TEXT }),
    })
  })

  await page.waitForTimeout(1500)

  // Pre-dismiss first-run onboarding so it doesn't intercept clicks (mirrors
  // chrome-smoke.spec.ts — the modal reads localStorage on mount, so a late
  // write doesn't unmount it; we click "Skip tour" if it's already up).
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch {}
  })
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  if (app) await app.close()
  if (isolatedUserData) {
    try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch {}
  }
})

/** Create a plain (non-agent) terminal so dictation takes the shell → confirm path. */
async function createTerminal(name: string) {
  const addBtn = page.locator('button:has-text("+ Add Terminal")').first()
  await addBtn.click()
  await page.waitForTimeout(400)
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

test.describe.serial('Voice capture (fake audio device)', () => {
  test('1. clicking the mic button acquires the microphone (Listening badge appears)', async () => {
    await createTerminal('Voice1')

    const toggle = page.locator('[data-testid="voice-toggle-btn"]').first()
    await expect(toggle, 'voice mic button should render when voice is enabled').toBeVisible({ timeout: 10000 })
    await toggle.click()

    // The badge only renders after getUserMedia resolved AND the AudioContext
    // capture graph was wired — i.e. real mic acquisition succeeded.
    await expect(
      page.locator('[data-testid="voice-listening-badge"]').first(),
      'Listening badge proves getUserMedia + AudioContext capture succeeded',
    ).toBeVisible({ timeout: 10000 })
  })

  test('2. clicking the Listening badge stops capture (the "never goes away" fix)', async () => {
    // Let the fake device push a few frames into the capture buffer first.
    await page.waitForTimeout(1500)

    const badge = page.locator('[data-testid="voice-listening-badge"]').first()
    await expect(badge).toBeVisible()
    // Click the badge to stop. The bug this guards: the mic got stuck listening
    // forever; the fix must make it actually release (badge leaves the DOM).
    await badge.click()
    await expect(badge, 'clicking the badge must end the listening session').toBeHidden({ timeout: 10000 })
  })
})

/**
 * Voice capture E2E — gates the ONE thing the headless unit suite cannot prove:
 * that the real `getUserMedia` → `AudioContext` capture path works in the packaged
 * Electron runtime. The unit tests stub the mic and the transcriber by design
 * (no audio device in jsdom; the Whisper worker can't load there).
 *
 * How it stays deterministic and cheap:
 *  - Chromium's FAKE audio device (`--use-fake-device-for-media-stream`) feeds a
 *    synthetic tone, so getUserMedia resolves headlessly under xvfb.
 *  - Transcription is NOT exercised here: it runs in the MAIN process (Groq), and
 *    the synthetic tone is gated as non-speech in the renderer before any Groq
 *    call — so stop() resolves instantly with no API key and no network.
 *
 * What it proves end-to-end: clicking the on-pane mic button performs REAL mic
 * acquisition (the red "Listening…" badge only renders once getUserMedia
 * resolved AND the capture graph is wired), and clicking the badge actually
 * STOPS capture — the runtime proof of the "never goes away" fix. The
 * transcript→UI decision itself (inject vs confirm-before-run) is exhaustively
 * covered by the unit suite (voicePipeline + useVoiceInput) and is out of scope here.
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

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // Isolated profile: its own single-instance lock (so it won't collide with a
  // dev app) and a seeded session that turns voice ON. Transcription is never
  // triggered (the fake tone is gated as non-speech), so no Groq key is needed.
  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-voice-'))
  const session = JSON.stringify({
    terminals: [],
    workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
    voiceSettings: {
      enabled: true,
      consentAccepted: true,
      groqModel: 'whisper-large-v3-turbo',
      pushToTalkKey: 'Ctrl+Shift+L',
      pushToTalkMode: 'hold',
      autoSubmitInAgent: false,
      correctionEnabled: false,
      confirmBeforeRunInShell: true,
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
    // The live level meter renders inside the badge while listening — proves the
    // capture instrumentation (AnalyserNode + meter) is wired in the real app.
    await expect(
      page.locator('[data-testid="voice-level-meter"]').first(),
      'live mic-level meter renders during capture',
    ).toBeVisible({ timeout: 5000 })
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

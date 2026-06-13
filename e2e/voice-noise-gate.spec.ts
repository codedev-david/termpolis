/**
 * Voice DEAD-ZONE gate E2E — the in-app proof of the v1.12.9 fix.
 *
 * The bug: steady background hum (a fan, mic-floor, room noise) is ABOVE the raw
 * silence threshold but contains no speech, so Whisper "transcribes" it as canned
 * filler ("the", " you"). For 8 releases the app would INJECT that phantom word.
 *
 * This drives the real capture path in a real Electron runtime with a committed
 * noise fixture as the microphone (tests/fixtures/voice-noise.wav — a flat ~0.006
 * RMS tone, squarely in the dead-zone that produced "the"), and proves the app now
 * GATES it: a notice appears and NOTHING is injected (the shell confirm bar — where
 * a transcript would land — never shows). The speech/noise classifier runs in the
 * renderer BEFORE the model, so this needs no bundled model and never loads one.
 *
 * Companion to voice-transcribe.spec.ts (real speech → correct words): together
 * they prove both halves — real speech gets through, noise/silence never does.
 *
 * Isolated --user-data-dir gives it its own single-instance lock so it coexists
 * with a developer's running app.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

const REPO = path.resolve('.')
const NOISE = path.join(REPO, 'tests', 'fixtures', 'voice-noise.wav')

let app: ElectronApplication
let page: Page
let isolatedUserData: string

test.describe.serial('Voice gates steady noise (no phantom transcript)', () => {
  // The committed fixture must exist; if it somehow doesn't, skip rather than red.
  test.skip(!fs.existsSync(NOISE), 'noise fixture missing — dead-zone e2e skipped')
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    const { execSync } = await import('child_process')
    execSync('npx electron-vite build', { cwd: REPO, stdio: 'pipe' })

    // Voice ON, LOCAL engine (so the real renderer gate runs), plain shell so a
    // transcript — if one were wrongly produced — would surface in the confirm bar
    // we assert NEVER appears.
    isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-vng-'))
    const session = JSON.stringify({
      terminals: [],
      workspaces: [],
      defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
      viewMode: 'tabs',
      voiceSettings: {
        enabled: true,
        engine: 'local',
        model: 'whisper-base.en',
        pushToTalkKey: 'Ctrl+Shift+L',
        pushToTalkMode: 'hold',
        autoSubmitInAgent: false,
        correctionEnabled: false,
        confirmBeforeRunInShell: true,
        cloudEndpoint: '',
      },
    })
    fs.writeFileSync(path.join(isolatedUserData, 'session.json'), session)

    app = await electron.launch({
      args: [
        path.resolve('out/main/index.js'),
        `--user-data-dir=${isolatedUserData}`,
        // Feed the flat-hum WAV as the mic (read by Chromium's media stack before
        // app JS runs). %noloop → plays once, then silence; either reads as no-speech.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${NOISE.replace(/\\/g, '/')}%noloop`,
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ],
      env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_TIMING: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1500)

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
    if (isolatedUserData) { try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch {} }
  })

  test('dictating steady noise shows a notice and injects NOTHING (no "the")', async () => {
    await page.locator('button:has-text("+ Add Terminal")').first().click()
    await page.waitForTimeout(400)
    const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
    await nameInput.fill('VoiceNoise')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForTimeout(1500)

    const toggle = page.locator('[data-testid="voice-toggle-btn"]').first()
    await expect(toggle).toBeVisible({ timeout: 10000 })
    await toggle.click()

    const badge = page.locator('[data-testid="voice-listening-badge"]').first()
    await expect(badge, 'Listening badge = capture started').toBeVisible({ timeout: 10000 })
    // Capture a few seconds of the hum, then stop — which runs the gate.
    await page.waitForTimeout(3000)
    await badge.click()
    await expect(badge).toBeHidden({ timeout: 10000 })

    // The gate must fire: a voice error/notice bar appears...
    const errorBar = page.locator('[data-testid="voice-error-bar"]')
    await expect(errorBar, 'no-speech/noise notice must appear').toBeVisible({ timeout: 30000 })

    // ...and CRUCIALLY no transcript was injected — the shell confirm bar (where a
    // dictated command would land) never shows. This is the "no phantom 'the'" proof.
    await expect(
      page.locator('[data-testid="voice-confirm-bar"]'),
      'a noise clip must NEVER produce an injected transcript',
    ).toBeHidden()

    // The notice names the real cause — background noise or no speech — never a word.
    const msg = ((await errorBar.textContent()) || '').toLowerCase()
    expect(msg, `notice should explain the gate, got: ${msg}`).toMatch(/background noise|no speech/)
  })
})

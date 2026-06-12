/**
 * Voice TRANSCRIPTION E2E — the end-to-end proof the rest of the suite can't give:
 * real speech in → correct text out, through the WHOLE shipped pipeline in a real
 * Electron runtime. Unlike voice-capture.spec.ts (synthetic fake device + stubbed
 * CLOUD transcript, which only proves the mic acquires/stops), this drives:
 *
 *   getUserMedia(fake FILE audio = a real speech clip)
 *     → AudioContext(16k) → ScriptProcessor capture
 *     → resampleTo16k → isNoSpeech gate → normalizeAudioGain
 *     → the LOCAL whisper-base.en worker (real model, no network)
 *     → processVoiceResult → the dictated text in the UI
 *
 * and asserts the KNOWN WORDS of the clip come back. This is the layer that
 * shipped broken five times while every test stayed green — because none ever ran
 * real audio through the real model in the real app. Now one does.
 *
 * Determinism: Chromium plays a WAV as the microphone
 * (`--use-file-for-fake-audio-capture`), so the "spoken" words are fixed. The clip
 * is tests/fixtures/jfk.wav (16k mono) — "...my fellow Americans, ask not what your
 * country can do for you...".
 *
 * SKIP-GUARD: the on-device model + the COMPLETE onnxruntime-web wasm runtime must
 * be bundled (resources/models/whisper-base.en + the asyncify loader). If they're
 * absent — a dev who hasn't run download-voice-model.sh, or a CI HF 429 (the
 * download is best-effort) — the whole group skips instead of failing, exactly
 * like the voice:verify gates. It only runs, and only asserts, when voice is
 * actually shippable.
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
const MODEL_DECODER = path.join(REPO, 'resources', 'models', 'whisper-base.en', 'onnx', 'decoder_model_merged_quantized.onnx')
const ORT_ASYNCIFY = path.join(REPO, 'resources', 'voice-runtime', 'ort', 'ort-wasm-simd-threaded.asyncify.mjs')
const JFK = path.join(REPO, 'tests', 'fixtures', 'jfk.wav')
// Only run when voice is actually bundled+complete (else skip — never red the build).
const VOICE_BUNDLED = fs.existsSync(MODEL_DECODER) && fs.existsSync(ORT_ASYNCIFY) && fs.existsSync(JFK)

let app: ElectronApplication
let page: Page
let isolatedUserData: string

test.describe.serial('Voice transcription (real model, fake file audio)', () => {
  test.skip(!VOICE_BUNDLED, 'on-device voice model / ORT runtime not bundled — real-transcription e2e skipped')
  // Model load + WASM transcription on a CI runner is slow; give it room.
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const { execSync } = await import('child_process')
    execSync('npx electron-vite build', { cwd: REPO, stdio: 'pipe' })

    // Seed a session with voice ON and the LOCAL engine (so the real model runs),
    // in a plain shell so the transcript lands in the confirm bar we can read.
    isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-vtx-'))
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
        confirmBeforeRunInShell: true, // shell → transcript shows in the confirm bar
        cloudEndpoint: '',
      },
    })
    fs.writeFileSync(path.join(isolatedUserData, 'session.json'), session)

    app = await electron.launch({
      args: [
        path.resolve('out/main/index.js'),
        `--user-data-dir=${isolatedUserData}`,
        // Feed a WAV as the microphone so getUserMedia delivers REAL speech frames
        // (read by Chromium's media stack before app JS runs, like --no-sandbox).
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${JFK.replace(/\\/g, '/')}%noloop`,
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

  test('dictating a known clip transcribes the correct words through the real local model', async () => {
    // Plain (non-agent) terminal → dictation takes the shell/confirm path.
    await page.locator('button:has-text("+ Add Terminal")').first().click()
    await page.waitForTimeout(400)
    const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
    await nameInput.fill('VoiceTx')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForTimeout(1500)

    const toggle = page.locator('[data-testid="voice-toggle-btn"]').first()
    await expect(toggle).toBeVisible({ timeout: 10000 })

    // Start capture — the fake file plays the JFK speech into the mic. Starting
    // also pre-warms the model, so it loads while the clip plays.
    await toggle.click()
    const badge = page.locator('[data-testid="voice-listening-badge"]').first()
    await expect(badge, 'Listening badge = capture started').toBeVisible({ timeout: 10000 })

    // Capture ~9s so the buffer holds the load-bearing words ("fellow / country /
    // Americans"), then stop — which kicks off real transcription.
    await page.waitForTimeout(9000)
    await badge.click()
    await expect(badge).toBeHidden({ timeout: 10000 })

    // If the model failed to load, the loud error bar appears — surface it clearly
    // rather than timing out on the confirm bar.
    const errorBar = page.locator('[data-testid="voice-error-bar"]')
    const confirmBar = page.locator('[data-testid="voice-confirm-bar"]')
    await Promise.race([
      confirmBar.waitFor({ state: 'visible', timeout: 150_000 }),
      errorBar.waitFor({ state: 'visible', timeout: 150_000 }),
    ])
    if (await errorBar.isVisible().catch(() => false)) {
      const msg = (await errorBar.textContent().catch(() => '')) || ''
      throw new Error(`voice transcription errored instead of producing text: ${msg.trim()}`)
    }

    const transcript = ((await confirmBar.textContent()) || '').toLowerCase()
    // The clip's load-bearing content words must come back (robust to punctuation,
    // case, and trivial ASR variation). This is the real end-to-end assertion.
    for (const word of ['fellow', 'country', 'american']) {
      expect(transcript, `transcript should contain "${word}" — got: ${transcript}`).toContain(word)
    }
  })
})

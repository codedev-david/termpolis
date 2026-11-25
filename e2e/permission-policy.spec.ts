/**
 * Permission policy E2E: the real Electron session handlers (src/main/permissionPolicy.ts) decide
 * what the Termpolis page may use, in the packaged runtime.
 *
 * The unit suite proves the allow and deny tables against mocks. This proves Chromium routes the
 * page's real requests and checks through them: the microphone is granted (and voice capture
 * works), the camera is refused until hand control turns it on, the clipboard and notifications
 * are granted (and the clipboard really round-trips), location is refused, a frame inside the page
 * is refused what the page itself is granted, the legacy screen capture is refused in the page, and
 * the microphone tester names the microphones.
 *
 * Unlike voice-capture.spec.ts this launches WITHOUT --use-fake-ui-for-media-stream. That switch
 * answers media requests itself and never asks the session's permission handler, so a spec run
 * with it would pass whatever the handler said. --use-fake-device-for-media-stream stays: it only
 * gives Chromium a synthetic microphone and camera to open.
 *
 * Isolated --user-data-dir gives this its own single-instance lock and profile.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import { quitApp, ensureE2eBuild, e2eLaunchArgs, e2eUserDataDir } from './helpers/launch'

let app: ElectronApplication
let page: Page

/** Open the given devices in the page; the stream's track kinds, or the error's name. */
async function openMedia(constraints: { audio?: boolean; video?: boolean }): Promise<string> {
  return page.evaluate(async (c) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(c)
      const kinds = stream.getTracks().map((t) => t.kind).sort().join('+')
      stream.getTracks().forEach((t) => t.stop())
      return `ok:${kinds}`
    } catch (e) {
      return `error:${(e as Error).name}`
    }
  }, constraints)
}

/** navigator.permissions.query for one name: what the session's check handler said. */
async function queryPermission(name: string): Promise<string> {
  return page.evaluate(async (n) => {
    try {
      return (await navigator.permissions.query({ name: n as PermissionName })).state
    } catch (e) {
      return `error:${(e as Error).name}`
    }
  }, name)
}

async function setGestureCamera(on: boolean): Promise<void> {
  await app.evaluate((_electron, value) => {
    const hook = (globalThis as unknown as { __termpolisGestureCamera?: (v: boolean) => void }).__termpolisGestureCamera
    if (!hook) throw new Error('the gesture camera test hook is missing (NODE_ENV must be test)')
    hook(value)
  }, on)
}

test.beforeAll(async () => {
  ensureE2eBuild()
  // Voice on, so the mic button renders (the same seed as voice-capture.spec.ts).
  fs.writeFileSync(path.join(e2eUserDataDir('perm'), 'session.json'), JSON.stringify({
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
  }))
  app = await electron.launch({
    args: [...e2eLaunchArgs('perm'), '--use-fake-device-for-media-stream'],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_TIMING: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch { /* storage off: the dialog check below handles it */ }
  })
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
  // Voice needs a Groq key to start capture; it is never used (the fake tone is not speech).
  await page.evaluate(() =>
    (window as unknown as { termpolis?: { groqSetApiKey?: (key: string) => unknown } }).termpolis?.groqSetApiKey?.('gsk_e2e_dummy_capture_gate_key_not_used_for_network'),
  )
})

test.afterAll(async () => {
  await quitApp(app)
  try { fs.rmSync(e2eUserDataDir('perm'), { recursive: true, force: true }) } catch { /* best effort */ }
})

test.describe.serial('Permission policy (real session handlers)', () => {
  test('1. voice capture works through the handler: the mic button reaches Listening', async () => {
    await page.locator('button:has-text("+ Add Terminal")').first().click()
    await page.waitForTimeout(400)
    await page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first().fill('Perm1')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForTimeout(1500)

    const toggle = page.locator('[data-testid="voice-toggle-btn"]').first()
    await expect(toggle).toBeVisible({ timeout: 10000 })
    await toggle.click()
    const badge = page.locator('[data-testid="voice-listening-badge"]').first()
    await expect(badge, 'the microphone was granted, so capture started').toBeVisible({ timeout: 10000 })
    await badge.click()
    await expect(badge).toBeHidden({ timeout: 10000 })
  })

  test('2. the microphone is granted; the camera is refused while hand control is off', async () => {
    expect(await openMedia({ audio: true })).toBe('ok:audio')
    expect(await openMedia({ video: true })).toBe('error:NotAllowedError')
    expect(await openMedia({ audio: true, video: true })).toBe('error:NotAllowedError')
    expect(await queryPermission('microphone')).toBe('granted')
    expect(await queryPermission('camera')).toBe('denied')
  })

  test('3. the clipboard and notifications are granted; location is refused', async () => {
    expect(await queryPermission('clipboard-read')).toBe('granted')
    expect(await queryPermission('clipboard-write')).toBe('granted')
    expect(await queryPermission('notifications')).toBe('granted')
    expect(await page.evaluate(() => Notification.permission)).toBe('granted')
    expect(await queryPermission('geolocation')).toBe('denied')
    const geo = await page.evaluate(() => new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 15000)
      navigator.geolocation.getCurrentPosition(
        () => { clearTimeout(timer); resolve('position') },
        (err) => { clearTimeout(timer); resolve(`error:${err.code}`) },
        { timeout: 10000 },
      )
    }))
    expect(geo, 'location is refused (PERMISSION_DENIED = 1)').toBe('error:1')
  })

  test('4. hand control turns the camera on, and off again', async () => {
    await setGestureCamera(true)
    try {
      expect(await openMedia({ video: true })).toBe('ok:video')
      expect(await openMedia({ audio: true, video: true })).toBe('ok:audio+video')
    } finally {
      await setGestureCamera(false)
    }
    expect(await openMedia({ video: true })).toBe('error:NotAllowedError')
    expect(await openMedia({ audio: true })).toBe('ok:audio')
  })

  test('5. the clipboard round-trips through navigator.clipboard', async () => {
    // The clipboard API needs a focused document. Focus emulation gives the page that without taking
    // the keyboard from anything else on the machine; main's clipboard is saved and put back.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
    const text = `termpolis-permission-e2e ${Date.now()} é日`
    try {
      const result = await page.evaluate(async (t) => {
        try {
          await navigator.clipboard.writeText(t)
          return `read:${await navigator.clipboard.readText()}`
        } catch (e) {
          return `error:${(e as Error).name}:${(e as Error).message} focus ${document.hasFocus()}`
        }
      }, text)
      expect(result).toBe(`read:${text}`)
      expect(await app.evaluate(({ clipboard }) => clipboard.readText()), 'the system clipboard holds what the page wrote').toBe(text)
    } finally {
      await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), saved)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
      await cdp.detach().catch(() => {})
    }
  })

  // The frame is the app's own page (same file, plus a query), so main sees a request from the
  // Termpolis window at the Termpolis page URL: only the main-frame rule refuses it. Framed, the
  // page starts nothing (main.tsx), and without the preload it has no IPC.
  test('6. a frame of the app page itself is refused the microphone and the clipboard the page is granted', async () => {
    const result = await page.evaluate(async () => {
      const frame = document.createElement('iframe')
      const self = `${location.href.split('#')[0].split('?')[0]}?permission-frame`
      frame.src = self
      frame.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;opacity:0'
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
      document.body.appendChild(frame)
      await loaded
      const win = frame.contentWindow as (Window & typeof globalThis) | null
      const out: Record<string, string> = {}
      try {
        if (!win) throw new Error('no frame window')
        // Same origin as the page, and at the page URL: what makes this the main-frame rule's test.
        out.at = win.location.href === self ? 'app-page' : `elsewhere:${win.location.href}`
        out.started = win.document.getElementById('root')?.childElementCount ? 'yes' : 'no'
        try {
          const stream = await win.navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach((t) => t.stop())
          out.mic = 'ok'
        } catch (e) {
          out.mic = `error:${(e as Error).name}`
        }
        for (const name of ['microphone', 'clipboard-read']) {
          try {
            out[name] = (await win.navigator.permissions.query({ name: name as PermissionName })).state
          } catch (e) {
            out[name] = `error:${(e as Error).name}`
          }
        }
      } catch (e) {
        out.frame = `error:${(e as Error).message}`
      } finally {
        frame.remove()
      }
      return out
    })
    expect(result).toEqual({ at: 'app-page', started: 'no', mic: 'error:NotAllowedError', microphone: 'denied', 'clipboard-read': 'denied' })
    // The page itself still has them.
    expect(await queryPermission('microphone')).toBe('granted')
    expect(await queryPermission('clipboard-read')).toBe('granted')
  })

  test('7. the legacy screen capture is refused in the page, with or without the microphone', async () => {
    const ask = (constraints: unknown): Promise<string> => page.evaluate(async (c) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(c as MediaStreamConstraints)
        stream.getTracks().forEach((t) => t.stop())
        return 'ok'
      } catch (e) {
        return `error:${(e as Error).name}:${(e as Error).message}`
      }
    }, constraints)
    const refused = 'error:NotAllowedError:Screen capture is not allowed in Termpolis'
    expect(await ask({ audio: true, video: { mandatory: { chromeMediaSource: 'desktop' } } })).toBe(refused)
    expect(await ask({ video: { mandatory: { chromeMediaSource: 'screen', chromeMediaSourceId: 'screen:0:0' } } })).toBe(refused)
    expect(await ask({ audio: { mandatory: { chromeMediaSource: 'desktop' } } })).toBe(refused)
    // The guard cannot be taken off.
    expect(await page.evaluate(() => {
      const d = Object.getOwnPropertyDescriptor(MediaDevices.prototype, 'getUserMedia')
      return `${d?.writable} ${d?.configurable}`
    })).toBe('false false')
    expect(await openMedia({ audio: true })).toBe('ok:audio')
  })

  test('8. the microphone tester names the microphones (the media check lets enumerateDevices label them)', async () => {
    await page.locator('button[title="Settings"]').click()
    await page.locator('[data-testid="settings-tab-voice"]').click()
    const select = page.locator('[data-testid="voice-device-select"]')
    await expect(select).toBeVisible({ timeout: 10000 })
    await expect.poll(async () => (await select.locator('option').allTextContents()).length, { timeout: 10000 }).toBeGreaterThan(1)
    const labels = (await select.locator('option').allTextContents()).slice(1)
    // An unnamed device shows as "Microphone N": every one here has its own name.
    expect(labels.length, `labels: ${JSON.stringify(labels)}`).toBeGreaterThan(0)
    for (const label of labels) expect(label, `labels: ${JSON.stringify(labels)}`).not.toMatch(/^(Microphone \d+)?$/)
  })
})

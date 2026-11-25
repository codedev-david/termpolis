/**
 * Lumopolis private repositories in the real app, against a local git server that wants a sign-in
 * (tests/fixtures/gitHttps/server.ts: https on 127.0.0.1, Basic auth checked in Node, then
 * `git http-backend`). The app's git trusts the server's self-signed certificate through
 * GIT_SSL_CAINFO, reads no system git config (GIT_CONFIG_NOSYSTEM=1) and a temporary global one (git's XDG
 * config under a temporary XDG_CONFIG_HOME, since the app's Lumopolis git leaves an inherited
 * GIT_CONFIG_GLOBAL out; on Windows HOME, which there moves only git's home, is an empty folder too), which
 * either names tests/fixtures/gitHttps/fake-helper.sh as the login helper or names nothing. No login helper of the computer the test runs on is ever involved, and nothing
 * talks to any host but 127.0.0.1. The fixture's user and reply are random per run.
 *
 *   1. Sign in opens a private repository: with the fake helper, Open a git repository… meets the
 *      sign-in, offers Sign in (and Use a token), and Sign in opens the world.
 *   2. A remembered repository whose login is gone: relaunched with the helper answering nothing
 *      (FAKE_HELPER_EMPTY=1), opening the remembered entry shows the saved world and the
 *      Sign in needed notice, never a window.
 *   3. The token dialog holds the keyboard: Tab and Shift+Tab go round it alone, never out to the clone
 *      dialog under it, the toolbar or a terminal. Tab from its last control lands on its first, Shift+Tab
 *      from its first on its last, and Esc gives the focus back to Use a token (F-R13).
 *   4. Use a token opens a private repository: with no helper, only Use a token is offered; the pasted
 *      reply opens the world, and the saved sources file does not contain it. Use this token, pressed
 *      with Enter, greys while the token is tried; once the focus leaves the grey button (Chromium moves
 *      it), it is on the token dialog or a control in it, never grey and never outside (F-R13). CI
 *      only: git hands the askpass its prompt on a command line, which this project keeps off developer
 *      machines.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { randomBytes } from 'crypto'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { fakeHelperConfig, fixtureSkipReason, startGitHttps, type GitHttps } from '../tests/fixtures/gitHttps/server'

// Locally a missing git-http-backend or openssl skips this file; on CI (CI=true) it throws and fails it.
const missing = fixtureSkipReason()
const inCi = process.env.CI === 'true'
const user = `u${randomBytes(6).toString('hex')}`
const reply = randomBytes(20).toString('hex')
let server: GitHttps
let work: string
let helperConfig: string
let emptyConfig: string

test.beforeAll(async () => {
  test.skip(missing !== null, `the local https git server cannot run here: ${missing}`)
  ensureE2eBuild()
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-private-repos-'))
  server = await startGitHttps({ user, reply, dir: path.join(work, 'server') })
  helperConfig = path.join(work, 'home-helper', 'xdg', 'git', 'config')
  emptyConfig = path.join(work, 'home-empty', 'xdg', 'git', 'config')
  for (const c of [helperConfig, emptyConfig]) fs.mkdirSync(path.dirname(c), { recursive: true })
  fs.writeFileSync(helperConfig, fakeHelperConfig())
  fs.writeFileSync(emptyConfig, '')
})

test.afterAll(async () => {
  await server?.stop()
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true })
  } catch {
    /* temp dir */
  }
})

/** A fresh userData folder with no terminals and no labelling. */
function newUserData(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-private-${label}-ud-`))
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs' }),
  )
  fs.writeFileSync(path.join(dir, 'world-settings.json'), JSON.stringify({ worldLabelling: false }))
  return dir
}

/** The fake helper's answers, for the launches whose git config names the helper. A token launch goes
 *  without them, so the reply reaches git only as the token. */
const helperEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  FAKE_HELPER_LOG: path.join(work, 'helper.log'),
  FAKE_HELPER_USER: user,
  FAKE_HELPER_REPLY: reply,
  ...extra,
})

/** Launches the app on `userData` with the fixture's git environment and `config` as the global git
 *  config (git finds it as $XDG_CONFIG_HOME/git/config; GIT_CONFIG_GLOBAL names it too);
 *  `extra` adds variables (the fake helper's, for a helper launch). */
async function launch(userData: string, config: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && !/^(GCM_|FAKE_HELPER_)/i.test(k)) env[k] = v
  const app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userData}`,
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...env,
      NODE_ENV: 'test',
      TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
      TERMPOLIS_TEST_WORLD_PROBE: '1',
      GIT_SSL_CAINFO: server.caFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: config,
      XDG_CONFIG_HOME: path.dirname(path.dirname(config)),
      ...(process.platform === 'win32' ? { HOME: path.dirname(path.dirname(path.dirname(config))) } : {}),
      ...extra,
    },
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch {
      /* ignore */
    }
  })
  const onboard = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboard.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboard.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
  return { app, page, errors }
}

const home = (page: Page) => page.locator('[data-testid="world-home"]')

/** Opens the Lumopolis pane on its home. */
async function openHome(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="world-view"]').isVisible().catch(() => false))) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.getByPlaceholder('Type a command...')
    await expect(input).toBeVisible()
    await input.fill('Open Lumopolis')
    await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
  }
  if (!(await home(page).isVisible().catch(() => false))) {
    await page.getByRole('combobox', { name: 'Worlds' }).selectOption('__home')
  }
  await expect(home(page)).toBeVisible()
}

/** Types the fixture's URL into Open a git repository… and clones. */
async function startClone(page: Page): Promise<void> {
  await home(page).getByRole('button', { name: /^Open a git repository/ }).click()
  const dialog = page.locator('[data-testid="world-clone"]')
  await dialog.getByPlaceholder('https://github.com/owner/repo.git').fill(server.url)
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click()
}

/** The world of the fixture repository is open and drawn: the switcher lists it by its title ("private",
 *  from the URL), and the toolbar names it by that title too, never by the hashed folder of its saved
 *  copy. Returns the toolbar's name. */
async function expectWorldOpen(page: Page): Promise<string> {
  await expect(home(page)).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByRole('combobox', { name: 'Worlds' }).locator('option', { hasText: /^private$/ })).toHaveCount(1, { timeout: 60_000 })
  const project = page.locator('[data-testid="world-project"]')
  await expect(project).toHaveText('private', { timeout: 60_000 })
  const canvasHost = page.locator('[data-testid="world-canvas-host"]')
  await expect(canvasHost.locator('canvas')).toBeVisible({ timeout: 120_000 })
  await expect(canvasHost).toHaveCSS('visibility', 'visible', { timeout: 30_000 })
  return (await project.textContent()) ?? ''
}

/**
 * Records every reply main sends for world:update-source, so a test can say why a notice did not come.
 * The map probe (TERMPOLIS_TEST_WORLD_PROBE) lives in the renderer's map and never sees an IPC reply, so
 * this uses the main-process seam the e2e suite already uses (app.evaluate on ipcMain, as
 * swarm-dashboard.spec.ts does): the app's own handler is kept and only wrapped, in this test run only.
 */
async function recordUpdateReplies(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers
    const real = handlers?.get('world:update-source')
    if (!handlers || !real) throw new Error('world:update-source has no handler to record')
    const g = globalThis as unknown as { __worldUpdateReplies?: unknown[] }
    g.__worldUpdateReplies = []
    handlers.set('world:update-source', async (event, ...args) => {
      const res = await real(event, ...args)
      g.__worldUpdateReplies?.push(res)
      return res
    })
  })
}

/** The world:update-source replies recorded so far. */
const updateReplies = (app: ElectronApplication): Promise<unknown[]> =>
  app.evaluate(() => (globalThis as unknown as { __worldUpdateReplies?: unknown[] }).__worldUpdateReplies ?? [])

/** Every file under `dir` whose bytes contain `text`. */
function filesContaining(dir: string, text: string): string[] {
  const needle = Buffer.from(text)
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && fs.readFileSync(p).includes(needle)) out.push(p)
    }
  }
  walk(dir)
  return out
}

test.describe.serial('Lumopolis private repositories with this computer\'s login', () => {
  test.setTimeout(240_000)
  let userData: string
  let app: ElectronApplication | undefined
  let savedCopy = ''

  test.afterAll(async () => {
    await quitApp(app)
    try {
      if (userData) fs.rmSync(userData, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  })

  test('Sign in opens a private repository', async () => {
    userData = newUserData('sign-in')
    const run = await launch(userData, helperConfig, helperEnv())
    app = run.app
    const page = run.page
    await openHome(page)
    await startClone(page)
    const signIn = page.locator('[data-testid="world-clone-sign-in"]')
    await expect(signIn).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('[data-testid="world-clone-use-token"]')).toBeVisible()
    await signIn.click()
    savedCopy = await expectWorldOpen(page)
    expect(run.errors).toEqual([])
  })

  test('a remembered repository whose login is gone shows Sign in needed, not a window', async () => {
    await quitApp(app)
    const run = await launch(userData, helperConfig, helperEnv({ FAKE_HELPER_EMPTY: '1' }))
    app = run.app
    const page = run.page
    await recordUpdateReplies(run.app)
    await openHome(page)
    await home(page).getByRole('list', { name: 'Recent worlds' }).getByRole('button', { name: /^Open private/ }).click()
    // The saved copy renders, and the background update that met no login asks for a sign-in in the notice.
    expect(await expectWorldOpen(page)).toBe(savedCopy)
    // First what main answered the background update, so a missing notice names its cause: an update
    // that failed some other way shows nothing on purpose.
    await expect.poll(async () => (await updateReplies(run.app)).length, { timeout: 60_000 }).toBeGreaterThan(0)
    expect((await updateReplies(run.app))[0]).toEqual({
      success: true,
      data: { needsLogin: { host: expect.any(String), helper: true, message: expect.any(String) } },
    })
    const notice = page.locator('[data-testid="world-sign-in-needed"]')
    await expect(notice).toBeVisible({ timeout: 60_000 })
    await expect(notice.getByRole('button', { name: 'Use a token' })).toBeVisible()
    await expect(page.locator('[data-testid="world-canvas-host"] canvas')).toBeVisible()
    // No login window, dialog or second app window came up: the app still has exactly its one window.
    expect(run.app.windows()).toHaveLength(1)
    expect(run.errors).toEqual([])
  })
})

test.describe.serial('Lumopolis private repositories with a token', () => {
  test.setTimeout(240_000)
  let userData: string
  let app: ElectronApplication | undefined

  test.afterAll(async () => {
    await quitApp(app)
    try {
      if (userData) fs.rmSync(userData, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  })

  test('the token dialog keeps Tab and Shift+Tab in it, and Esc gives the focus back to Use a token', async () => {
    const ud = newUserData('token-keys')
    const run = await launch(ud, emptyConfig)
    app = run.app
    const page = run.page
    await openHome(page)
    await startClone(page)
    const useToken = page.locator('[data-testid="world-clone-use-token"]')
    await expect(useToken).toBeVisible({ timeout: 60_000 })
    await useToken.focus()
    await page.keyboard.press('Enter')
    const dialog = page.locator('[data-testid="world-repo-access"]')
    await expect(dialog.locator('[data-testid="world-repo-access-input"]')).toBeFocused()
    // Where the focus is: inside the token dialog, or else what holds it (the clone dialog's control, the toolbar, a
    // terminal, <body>), so a failure names where it went.
    const where = (): Promise<string> =>
      page.evaluate(() => {
        const a = document.activeElement
        if (a?.closest('[data-testid="world-repo-access"]')) return 'token dialog'
        return a?.getAttribute('data-testid') ?? a?.getAttribute('aria-label') ?? a?.tagName ?? 'nothing'
      })
    // The dialog's Tab order, read from the page: its enabled, shown controls that Tab reaches, in document order.
    const count = await dialog.evaluate((d) => {
      const els = Array.from(d.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')).filter(
        (e) => e.tabIndex >= 0 && !e.matches(':disabled') && e.getClientRects().length > 0
      )
      ;(window as unknown as { __tabOrder?: HTMLElement[] }).__tabOrder = els
      return els.length
    })
    // There is somewhere to go round, and the field the dialog opened on is one of its stops.
    expect(count).toBeGreaterThan(1)
    const at = (): Promise<number> =>
      page.evaluate(() => ((window as unknown as { __tabOrder: HTMLElement[] }).__tabOrder).indexOf(document.activeElement as HTMLElement))
    const start = await at()
    expect(start).toBeGreaterThanOrEqual(0)
    // Tab walks the order once round: on the way it goes from the last control to the first (the wrap).
    for (let i = 1; i <= count; i++) {
      await page.keyboard.press('Tab')
      expect(await where(), `after ${i} x Tab`).toBe('token dialog')
      expect(await at(), `after ${i} x Tab`).toBe((start + i) % count)
    }
    // Shift+Tab walks it back once round: on the way it goes from the first control to the last.
    for (let i = 1; i <= count; i++) {
      await page.keyboard.press('Shift+Tab')
      expect(await where(), `after ${i} x Shift+Tab`).toBe('token dialog')
      expect(await at(), `after ${i} x Shift+Tab`).toBe((((start - i) % count) + count) % count)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(useToken).toBeFocused()
    expect(run.errors).toEqual([])
    await quitApp(app)
    app = undefined
    try {
      fs.rmSync(ud, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  })

  test('Use a token opens a private repository', async () => {
    test.skip(!inCi, 'token runs hand the askpass its prompt on a command line, so they run only in CI')
    userData = newUserData('token')
    const run = await launch(userData, emptyConfig)
    app = run.app
    const page = run.page
    await openHome(page)
    await startClone(page)
    const useToken = page.locator('[data-testid="world-clone-use-token"]')
    await expect(useToken).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('[data-testid="world-clone-sign-in"]')).toHaveCount(0)
    await useToken.click()
    const dialog = page.locator('[data-testid="world-repo-access"]')
    await dialog.locator('[data-testid="world-repo-access-input"]').fill(reply)
    const use = dialog.getByRole('button', { name: 'Use this token' })
    await use.focus()
    // Use this token greys while the token is tried. Chromium moves the focus off a control that greys (to <body>) on
    // its next rendering step, so the check waits, every frame for up to 3 s, until the focus is no longer on the grey
    // button, then says where it went: the token dialog itself or a control in it, never grey and never outside
    // (F-R13). Watched from the page as the button greys, so a fast clone cannot hide it. Without the dialog's
    // holdFocus the focus stays on the grey button until Chromium drops it to <body>: 'BODY', or 'still on the grey
    // button' if it never moves.
    await use.evaluate((b) => {
      const g = window as unknown as { __greyFocus?: string }
      const where = (): string => {
        const a = document.activeElement
        const d = document.querySelector('[data-testid="world-repo-access"]')
        if (a && d && (a === d || d.contains(a))) return a.matches(':disabled') ? 'grey control in the token dialog' : 'token dialog'
        return a?.getAttribute('data-testid') ?? a?.tagName ?? 'nothing'
      }
      new MutationObserver((_, mo) => {
        if (!(b as HTMLButtonElement).disabled) return
        mo.disconnect()
        const until = performance.now() + 3000
        const look = (): void => {
          if (document.activeElement !== b) g.__greyFocus = where()
          else if (performance.now() > until) g.__greyFocus = 'still on the grey button'
          else requestAnimationFrame(look)
        }
        look()
      }).observe(b, { attributes: true, attributeFilter: ['disabled'] })
    })
    await page.keyboard.press('Enter')
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __greyFocus?: string }).__greyFocus ?? null), { timeout: 30_000 })
      .toBe('token dialog')
    await expectWorldOpen(page)
    const sources = path.join(userData, 'world', 'sources.json')
    expect(fs.existsSync(sources)).toBe(true)
    expect(fs.readFileSync(sources, 'utf8').includes(reply)).toBe(false)
    expect(filesContaining(path.join(userData, 'world'), reply)).toEqual([])
    expect(run.errors).toEqual([])
  })
})

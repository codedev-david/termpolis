/**
 * Lumopolis private repositories in the real app, against a local git server that wants a sign-in
 * (tests/fixtures/gitHttps/server.ts: https on 127.0.0.1, Basic auth checked in Node, then
 * `git http-backend`). The app's git trusts the server's self-signed certificate through
 * GIT_SSL_CAINFO, reads no system git config (GIT_CONFIG_NOSYSTEM=1) and a temporary global one
 * (GIT_CONFIG_GLOBAL), which either names tests/fixtures/gitHttps/fake-helper.sh as the login helper
 * or names nothing. No login helper of the computer the test runs on is ever involved, and nothing
 * talks to any host but 127.0.0.1. The fixture's user and reply are random per run.
 *
 *   1. Sign in opens a private repository: with the fake helper, Open a git repository… meets the
 *      sign-in, offers Sign in (and Use a token), and Sign in opens the world.
 *   2. A remembered repository whose login is gone: relaunched with the helper answering nothing
 *      (FAKE_HELPER_EMPTY=1), opening the remembered entry shows the saved world and the
 *      Sign in needed notice, never a window.
 *   3. Use a token opens a private repository: with no helper, only Use a token is offered; the pasted
 *      reply opens the world, and the saved sources file does not contain it. CI only: git hands the
 *      askpass its prompt on a command line, which this project keeps off developer machines.
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
  helperConfig = path.join(work, 'helper.gitconfig')
  emptyConfig = path.join(work, 'empty.gitconfig')
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
 *  config; `extra` adds variables (the fake helper's, for a helper launch). */
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
 *  from the URL), and the toolbar names the folder of its saved copy, which this returns. */
async function expectWorldOpen(page: Page): Promise<string> {
  await expect(home(page)).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByRole('combobox', { name: 'Worlds' }).locator('option', { hasText: /^private$/ })).toHaveCount(1, { timeout: 60_000 })
  const project = page.locator('[data-testid="world-project"]')
  await expect(project).toHaveText(/\S/, { timeout: 60_000 })
  const canvasHost = page.locator('[data-testid="world-canvas-host"]')
  await expect(canvasHost.locator('canvas')).toBeVisible({ timeout: 120_000 })
  await expect(canvasHost).toHaveCSS('visibility', 'visible', { timeout: 30_000 })
  return (await project.textContent()) ?? ''
}

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
    await openHome(page)
    await home(page).getByRole('list', { name: 'Recent worlds' }).getByRole('button', { name: /^Open private/ }).click()
    // The saved copy renders, and the background update that met no login asks for a sign-in in the notice.
    expect(await expectWorldOpen(page)).toBe(savedCopy)
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
    await dialog.getByRole('button', { name: 'Use this token' }).click()
    await expectWorldOpen(page)
    const sources = path.join(userData, 'world', 'sources.json')
    expect(fs.existsSync(sources)).toBe(true)
    expect(fs.readFileSync(sources, 'utf8').includes(reply)).toBe(false)
    expect(filesContaining(path.join(userData, 'world'), reply)).toEqual([])
    expect(run.errors).toEqual([])
  })
})

/**
 * The ways into Lumopolis from where the user already is, in the real app (caveat 3):
 *
 *   1. A fresh profile: the sidebar's labelled Lumopolis entry wears a New badge, and the one-time
 *      hint names every way in.
 *   2. The globe on a terminal's status bar maps THAT terminal's project, while another terminal
 *      is the active one; the active terminal does not change. The first open takes the badge and
 *      the hint away.
 *   3. Typing `lumopolis` in a terminal: a folder that does not exist is refused by the shell itself
 *      (nothing is emitted, nothing opens); plain `lumopolis` opens the pane on the project of the
 *      folder the shell is in. The private sequence that carries it never shows in the terminal.
 *   4. "Opened once" is saved in the Lumopolis settings file; the renderer logged no error.
 *
 * Two temp git projects; terminal B starts in a subfolder of project B, so the pane shows the whole
 * project (the git root), as every folder opener does. The default shell is the platform's own
 * (PowerShell on Windows, bash elsewhere): both carry the `lumopolis` function through Termpolis's
 * shell integration. The view is split, so both terminals' status bars are on screen.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

let app: ElectronApplication
let page: Page
let userDataDir: string
let repoA: string
let repoB: string
const consoleErrors: string[] = []

function makeRepo(label: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-lumo-${label}-`))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return dir
}

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', version: '1.0.0', main: 'src/index.ts' }),
  'src/index.ts': "import { list } from './store'\n\nexport const items = list()\n",
  'src/store.ts': "export function list(): string[] {\n  return ['a', 'b']\n}\n",
  'pkg/util.ts': 'export const twice = (n: number): number => n * 2\n',
}

test.beforeAll(async () => {
  ensureE2eBuild()
  repoA = makeRepo('a', FILES)
  repoB = makeRepo('b', FILES)
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-lumo-openers-ud-'))
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'split' }),
  )
  fs.writeFileSync(path.join(userDataDir, 'world-settings.json'), JSON.stringify({ worldLabelling: false }))

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_SMOKE_SKIP_PICKERS: '1', TERMPOLIS_TEST_WORLD_PROBE: '1' },
  })
  page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch {
      /* ignore */
    }
  })
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  await quitApp(app)
  for (const d of [userDataDir, repoA, repoB]) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  }
})

async function createTerminal(name: string, cwd: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  const dialog = page.locator('h2:has-text("New Terminal")').locator('..')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').first().fill(name)
  await dialog.locator('input[placeholder="Home directory"]').fill(cwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
}

const text = (id?: string): Promise<string> =>
  page.evaluate((t) => (window as unknown as { __termpolis_terminal_text?: (id?: string) => string }).__termpolis_terminal_text?.(t) ?? '', id)
const pane = () => page.locator('[data-testid="world-view"]')
const globeFor = (folder: string) => page.getByRole('button', { name: `Map ${path.basename(folder)} in Lumopolis`, exact: true })
const idOf = async (folder: string): Promise<string> => ((await globeFor(folder).getAttribute('data-testid')) ?? '').replace('terminal-open-world-', '')

/** Types `line` into terminal `id` and presses Enter. */
async function typeIn(id: string, line: string): Promise<void> {
  await page.locator(`[data-terminal-id="${id}"] .xterm`).click()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea')), { message: 'the terminal to have focus' }).toBe(true)
  await page.keyboard.type(line, { delay: 20 })
  await page.keyboard.press('Enter')
}

test.describe.serial('The ways into Lumopolis', () => {
  test.setTimeout(90_000)

  test('1. a fresh profile: the labelled entry wears New, and the hint names every way in', async () => {
    const entry = page.getByTestId('sidebar-lumopolis-entry')
    await expect(entry).toBeVisible()
    await expect(entry).toContainText('Lumopolis')
    await expect(page.getByTestId('sidebar-lumopolis-new')).toHaveText(/new/i)
    await expect(page.getByTestId('sidebar-lumopolis-hint')).toHaveText(
      'Lumopolis: see any project as a 3D city. Open it here, click the globe on a terminal, or type lumopolis.',
    )
    await expect(page.getByTestId('sidebar-open-world')).toHaveAttribute('aria-label', 'Open Lumopolis')
  })

  test('2. a terminal\'s globe maps that terminal\'s project, and the active terminal stays active', async () => {
    await createTerminal('A', repoA)
    await expect(globeFor(repoA)).toBeVisible({ timeout: 30_000 })
    const subB = path.join(repoB, 'pkg')
    await createTerminal('B', subB)
    await expect(globeFor(subB)).toBeVisible({ timeout: 30_000 })
    const a = await idOf(repoA)
    const b = await idOf(subB)
    await expect.poll(async () => (await text(a)).length > 0 && (await text(b)).length > 0, { timeout: 30_000 }).toBe(true)
    // In the split view the active pane wears the ring. Make B the active one, then map A from its globe.
    const ringed = (id: string) => page.locator(`div.ring-1:has([data-terminal-id="${id}"])`)
    await page.locator(`[data-terminal-id="${b}"] .xterm`).click()
    await expect(ringed(b)).toHaveCount(1)
    await expect(ringed(a)).toHaveCount(0)

    await globeFor(repoA).click()
    await expect(pane()).toBeVisible()
    await expect(page.getByTestId('world-project')).toHaveText(path.basename(repoA), { timeout: 30_000 })
    await expect(ringed(b), 'the globe changed the active terminal').toHaveCount(1)
    await expect(ringed(a)).toHaveCount(0)
    // The first open takes the badge and the hint away.
    await expect(page.getByTestId('sidebar-lumopolis-new')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-lumopolis-hint')).toHaveCount(0)
    await page.getByTestId('world-close').click()
    await expect(pane()).toHaveCount(0)
  })

  test('3. typing lumopolis opens the shell\'s project; a missing folder is refused by the shell', async () => {
    const b = await idOf(path.join(repoB, 'pkg'))
    await typeIn(b, 'lumopolis no-such-dir')
    await expect.poll(() => text(b), { timeout: 20_000 }).toContain('lumopolis: no such folder: no-such-dir')
    await page.waitForTimeout(1000)
    await expect(pane()).toHaveCount(0)

    await typeIn(b, 'lumopolis')
    await expect(pane()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('world-project')).toHaveText(path.basename(repoB), { timeout: 30_000 })
    // The sequence was swallowed: none of it reached the screen.
    const shown = await text(b)
    // The sequence's own start (7377 then its separator): a bare 7377 is in a macOS runner's host name, which the
    // prompt prints (iad20-...-aa9f-7377c6121708-...), and failed the check with nothing leaked.
    expect(shown).not.toContain('7377;')
    expect(shown).not.toMatch(/lumopolis;[0-9a-f]{32}/)
  })

  test('4. "opened once" is saved in the Lumopolis settings, and the renderer logged no error', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'world-settings.json'), 'utf8')) as { worldOpened?: boolean }
    expect(saved.worldOpened).toBe(true)
    expect(consoleErrors).toEqual([])
  })
})

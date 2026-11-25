/**
 * Lumopolis sources, design and Build it in the real app (Plan 4, Task 6). The pane opens on its
 * home (no terminal, so no project), and from there:
 *
 *   1. Open a folder… (the folder dialog answers from TERMPOLIS_TEST_WORLD_PICK_FILE) maps a fixture
 *      git project and draws it.
 *   2. Design something new: the description goes to world:design-draft, whose hidden agent run is
 *      e2e/mocks/mock-claude.cjs (MOCK_CLAUDE_WORLD_ANSWER=1 answers the draft prompt with a
 *      design-patch of one district and three buildings). The design world opens with the planned
 *      layer on: three wireframes.
 *   3. "add Payments" in the Ask bar (design mode, world:design-refine) adds a fourth.
 *   4. Build it into an empty temp folder: main links the design to the folder, the agent terminal
 *      opens there with the build prompt (TERMPOLIS_TEST_AGENTS=1, so the typed command is the mock's,
 *      never a real agent), and the pane switches to the folder's world: the plan alone, four
 *      wireframes. The test then writes src/payments/index.ts; the folder watcher re-indexes it, the
 *      world refreshes, the plan's Payments part is matched by the new code (no longer a wireframe)
 *      and the change toast says "+1 part". A second file in that part makes the world draw it with
 *      an outline (changed since the last reconcile). Back in the design, "remove Payments" (the
 *      design's removePart) and the folder's world draws that built part fading.
 *   5. A folder with nothing to map says why in its own words (WP4b F-R9): an empty one, then (Choose another
 *      folder) one of only notes, with no Try again; Back to Home goes home.
 *   6. The renderer logged no console error and threw no page error.
 *
 * Labelling is off: its hidden run is spawned without a shell and cannot launch a Windows shim.
 * The map probe (window.__termpolis_world, TERMPOLIS_TEST_WORLD_PROBE) says which buildings are
 * drawn as wireframes. The launch adds the software GL switches, as world-view.spec.ts does.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild, e2eShimEnv } from './helpers/launch'
import { closeMore, toolbarControl } from './helpers/worldToolbar'

let app: ElectronApplication
let page: Page
let userDataDir: string
let project: string
let buildDir: string
let shimDir: string
let pickFile: string
let emptyDir: string
let notesDir: string
const consoleErrors: string[] = []
const DESCRIPTION = 'A small pet shop'

/** Writes `files` under a new temp folder and makes it a git repository with every file staged. */
function makeRepo(label: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-world-${label}-`))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return dir
}

const PROJECT_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'notes-app', version: '1.0.0', main: 'src/main/index.ts' }),
  'src/main/index.ts': "import { listNotes } from './store'\n\nexport const notes = listNotes()\n",
  'src/main/store.ts': "export function listNotes(): string[] {\n  return ['one', 'two']\n}\n",
  'src/renderer/App.ts': "export const render = (el: HTMLElement): void => { el.textContent = 'notes' }\n",
}

test.beforeAll(async () => {
  ensureE2eBuild()
  project = makeRepo('sources', PROJECT_FILES)
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-build-'))
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-empty-'))
  notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-notes-'))
  fs.writeFileSync(path.join(notesDir, 'notes.txt'), 'shopping list')

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-sources-ud-'))
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs' }),
  )
  fs.writeFileSync(path.join(userDataDir, 'world-settings.json'), JSON.stringify({ worldLabelling: false }))
  pickFile = path.join(userDataDir, 'world-pick.txt')
  fs.writeFileSync(pickFile, '')

  // As in world-ask.spec.ts: on Windows the hidden agent run needs the mock as a PowerShell script
  // first on PATH; elsewhere e2e/test-shims/claude, which e2eShimEnv puts on PATH, is enough.
  const shims = e2eShimEnv('world-sources')
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-sources-shim-'))
  if (process.platform === 'win32') {
    const mock = path.resolve('e2e', 'mocks', 'mock-claude.cjs')
    fs.writeFileSync(path.join(shimDir, 'claude.ps1'), `& node '${mock}' @args
exit $LASTEXITCODE
`)
  }

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      ...shims,
      PATH: `${shimDir}${path.delimiter}${shims.PATH}`,
      PSExecutionPolicyPreference: 'Bypass',
      NODE_ENV: 'test',
      TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
      TERMPOLIS_TEST_WORLD_PROBE: '1',
      TERMPOLIS_TEST_WORLD_PICK_FILE: pickFile,
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_TEST_TIMING: '1',
      MOCK_CLAUDE_WORLD_ANSWER: '1',
    },
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
  for (const d of [userDataDir, project, buildDir, shimDir, emptyDir, notesDir]) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  }
})

const pane = () => page.locator('[data-testid="world-view"]')
const home = () => page.locator('[data-testid="world-home"]')
const projectName = () => page.locator('[data-testid="world-project"]')
const canvasHost = () => page.locator('[data-testid="world-canvas-host"]')

/** The ids drawn as wireframes right now (null while no viewer is up). */
async function wireframes(): Promise<string[] | null> {
  return await page.evaluate(() => {
    const probe = (window as unknown as { __termpolis_world?: { drawn(): { wireframes: string[] } } }).__termpolis_world
    return probe ? [...probe.drawn().wireframes].sort() : null
  })
}

/** The wireframes on screen at the tier drawn (drawn themselves, or under a district slab that stands for them). */
async function shownWireframes(): Promise<string[]> {
  return await page.evaluate(() => {
    const probe = (window as unknown as { __termpolis_world?: { drawn(): { shownWireframes: string[] } } }).__termpolis_world
    return probe ? [...probe.drawn().shownWireframes].sort() : []
  })
}

/** Where the loaded world lays out building `id` (x, y, z), or null. */
async function position(id: string): Promise<number[] | null> {
  return await page.evaluate((want) => {
    const probe = (window as unknown as { __termpolis_world?: { position(id: string): number[] | null } }).__termpolis_world
    return probe ? probe.position(want) : null
  }, id)
}

/** Ground distance between two laid-out spots; Infinity when either is missing. */
const groundGap = (a: number[] | null, b: number[] | null): number => (a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : Infinity)

/** About one building's footprint, in world units: a part built from the design stands within this of its wireframe's spot. */
const FOOTPRINT = 3
/** How far from its district's centre a building of a one-building district may stand: districtRadius(1) + MOVED_TOLERANCE. */
const SLAB_REACH = 5 + 6 + 6

/** The probe's drawn lists: ids outlined (changed parts) and fading (parts the design removes). */
async function drawnLists(): Promise<{ outlined: string[]; fading: string[] }> {
  return await page.evaluate(() => {
    const probe = (window as unknown as { __termpolis_world?: { drawn(): { outlined: string[]; fading: string[] } } }).__termpolis_world
    const d = probe?.drawn()
    return { outlined: d ? [...d.outlined].sort() : [], fading: d ? [...d.fading].sort() : [] }
  })
}

/** The active terminal's text, all whitespace removed (a long typed line wraps across rows). */
async function terminalText(): Promise<string> {
  const text = await page.evaluate(
    () => (window as unknown as { __termpolis_terminal_text?: () => string }).__termpolis_terminal_text?.() ?? '',
  )
  return text.replace(/\s+/g, '')
}

test.describe.serial('Lumopolis sources, design and Build it in the real app', () => {
  test.setTimeout(150_000)

  test('1. the home opens a fixture folder and draws its map', async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.getByPlaceholder('Type a command...')
    await expect(input).toBeVisible()
    await input.fill('Open Lumopolis')
    const result = page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ })
    await expect(result).toBeVisible()
    await result.click()

    await expect(pane()).toBeVisible()
    await expect(home()).toBeVisible()
    await expect(home().getByRole('heading', { name: 'Lumopolis' })).toBeVisible()
    await expect(home()).toContainText('Where AI Worlds Become Human Understanding.')

    fs.writeFileSync(pickFile, project)
    await home().getByRole('button', { name: /^Open a folder/ }).click()
    await expect(home()).toHaveCount(0)
    await expect(projectName()).toHaveText(path.basename(project), { timeout: 30_000 })
    await expect(canvasHost().locator('canvas')).toBeVisible({ timeout: 120_000 })
    await expect(canvasHost()).toHaveCSS('visibility', 'visible', { timeout: 30_000 })
    await expect(page.getByPlaceholder('Ask about this project…')).toBeEnabled({ timeout: 30_000 })
  })

  test('2. Design something new drafts a design of three planned parts', async () => {
    await page.getByRole('combobox', { name: 'Worlds' }).selectOption('__home')
    await expect(home()).toBeVisible()
    // The folder opened in step 1 is a recent world now.
    await expect(home().getByRole('list', { name: 'Recent worlds' })).toContainText(path.basename(project))

    // The viewer pauses while the home covers it, so the click needs no longer than the default.
    await home().getByRole('button', { name: /^Design something new/ }).click()
    const start = page.getByRole('dialog', { name: 'Design something new' })
    await start.getByPlaceholder('Describe the app you want…').fill(DESCRIPTION)
    await start.getByRole('button', { name: 'Design it' }).click()

    await expect(projectName()).toHaveText(DESCRIPTION, { timeout: 60_000 })
    await expect(await toolbarControl(page, 'world-layer-planned')).toHaveAttribute('aria-pressed', 'true')
    await closeMore(page)
    await expect.poll(wireframes, { timeout: 60_000 }).toEqual(['catalog', 'orders', 'storefront'])
  })

  test('3. "add Payments" in the Ask bar adds a fourth planned part', async () => {
    const box = page.getByPlaceholder('Change the design…')
    await expect(box).toBeEnabled({ timeout: 30_000 })
    await box.fill('add Payments')
    await box.press('Enter')
    await expect(page.locator('[data-testid="world-answer"]')).toContainText('Added a Payments part.', { timeout: 60_000 })
    await expect.poll(wireframes, { timeout: 30_000 }).toEqual(['catalog', 'orders', 'payments', 'storefront'])
  })

  test('4. Build it opens the agent in the folder and the folder world matches the plan as code arrives', async () => {
    fs.writeFileSync(pickFile, buildDir)
    await page.locator('[data-testid="world-build-it-open"]').click()
    const dialog = page.getByRole('dialog', { name: 'Build it' })
    await expect(dialog).toContainText(DESCRIPTION)
    await dialog.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(dialog).toContainText(path.basename(buildDir))
    await expect(dialog).not.toContainText("This folder isn't empty")
    await dialog.getByRole('button', { name: 'Build it', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // The pane is on the build folder's world: the linked plan alone, every part still a wireframe.
    await expect(projectName()).toHaveText(path.basename(buildDir), { timeout: 30_000 })
    await expect(await toolbarControl(page, 'world-layer-planned')).toHaveAttribute('aria-pressed', 'true')
    await closeMore(page)
    await expect.poll(wireframes, { timeout: 60_000 }).toEqual(['catalog', 'orders', 'payments', 'storefront'])
    // ...and every one of them is on screen: planned parts stand in no code district, so no slab may hide them.
    await expect.poll(shownWireframes, { timeout: 10_000 }).toEqual(['catalog', 'orders', 'payments', 'storefront'])

    // The agent terminal opened with the build prompt (typed on its launch line).
    // Nothing in it is dropped by the launcher's shell-safety pass: the gateway call arrives whole.
    await expect.poll(terminalText, { timeout: 60_000 }).toContain('ReadtheLumopolisdesignfirst')
    expect(await terminalText()).toMatch(/callgateway_callwithtoollumopolis\/world_readandarguments\{designKey:design:[A-Za-z0-9._-]+\}/)

    const wireAt = await position('payments')
    expect(wireAt).not.toBeNull()

    // The agent's first file: the Payments part now exists in code.
    fs.mkdirSync(path.join(buildDir, 'src', 'payments'), { recursive: true })
    fs.writeFileSync(path.join(buildDir, 'src', 'payments', 'index.ts'), 'export function charge(cents: number): boolean {\n  return cents > 0\n}\n')
    await expect(canvasHost().locator('.lw-toast')).toHaveText(/\+1 part/, { timeout: 60_000 })
    await expect.poll(wireframes, { timeout: 30_000 }).toEqual(['catalog', 'orders', 'storefront'])
    await expect.poll(shownWireframes, { timeout: 10_000 }).toEqual(['catalog', 'orders', 'storefront'])
    // The design asks for Stripe in Payments and the first file does not name it: the part is outlined.
    await expect.poll(async () => (await drawnLists()).outlined.length, { timeout: 30_000 }).toBe(1)
    expect((await drawnLists()).outlined).toHaveLength(1)
    // The built Payments rose where its wireframe stood (spec 5.12), and no wireframe is left for it. The
    // wireframe stood on the ring (the folder had no district yet), so the new Payments district moved under it:
    // the part stands on its own slab (round 6 I1).
    const builtAt = await position((await drawnLists()).outlined[0])
    expect(groundGap(builtAt, wireAt)).toBeLessThan(FOOTPRINT)
    expect(groundGap(builtAt, await position('d-src-payments'))).toBeLessThan(SLAB_REACH)

    // The agent adds a test beside it. The world recompiles, and the outline stays: the build still falls short of the plan.
    fs.writeFileSync(path.join(buildDir, 'src', 'payments', 'index.test.ts'), "import { charge } from './index'\nconsole.assert(charge(5))\n")
    // Give the watcher time to recompile with the new file.
    await page.waitForTimeout(8_000)
    // (The test joins the Payments building, which takes a new id; the one part is still outlined.)
    const outlined = (await drawnLists()).outlined
    expect(outlined).toHaveLength(1)
    const part = outlined[0]
    // ...and the new id keeps the spot: a recompile does not move the part away from where it rose.
    expect(groundGap(await position(part), builtAt)).toBeLessThan(FOOTPRINT)

    // The design takes Payments away: back in the folder's world the built part fades.
    await page.getByRole('combobox', { name: 'Worlds' }).selectOption({ label: DESCRIPTION })
    await expect(projectName()).toHaveText(DESCRIPTION, { timeout: 30_000 })
    const box = page.getByPlaceholder('Change the design…')
    await expect(box).toBeEnabled({ timeout: 30_000 })
    await box.fill('remove Payments')
    await box.press('Enter')
    await expect(page.locator('[data-testid="world-answer"]')).toContainText('Removed the Payments part.', { timeout: 60_000 })
    await page.getByRole('combobox', { name: 'Worlds' }).selectOption({ label: path.basename(buildDir) })
    await expect(projectName()).toHaveText(path.basename(buildDir), { timeout: 30_000 })
    await expect.poll(async () => (await drawnLists()).fading, { timeout: 60_000 }).toEqual([part])
  })

  test('5. a folder with nothing to map says why, and the person goes on from there', async () => {
    await page.getByRole('combobox', { name: 'Worlds' }).selectOption('__home')
    await expect(home()).toBeVisible()
    const error = page.locator('[data-testid="world-error"]')
    fs.writeFileSync(pickFile, emptyDir)
    await home().getByRole('button', { name: /^Open a folder/ }).click()
    await expect(error).toHaveText('This folder has no files Lumopolis can map yet.', { timeout: 60_000 })
    await expect(pane()).not.toContainText('could not map')
    await expect(page.locator('[data-testid="world-retry"]')).toHaveCount(0)

    fs.writeFileSync(pickFile, notesDir)
    await page.getByRole('button', { name: 'Choose another folder' }).click()
    await expect(projectName()).toHaveText(path.basename(notesDir), { timeout: 30_000 })
    await expect(error).toHaveText('Lumopolis found files here, but none in a language it maps yet.', { timeout: 60_000 })
    await expect(page.locator('[data-testid="world-retry"]')).toHaveCount(0)

    await page.getByRole('button', { name: 'Back to Home' }).click()
    await expect(home()).toBeVisible()
    await expect(error).toHaveCount(0)
  })

  test('6. the renderer logged no console errors and threw no page errors', async () => {
    expect(consoleErrors).toEqual([])
  })
})

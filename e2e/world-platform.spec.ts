/**
 * Lumopolis on each platform (caveat 5): the same walk through the pane on Windows, macOS and Linux, with a
 * screenshot at each key moment and a video of the whole run, in test-results/lumopolis-shots/ (CI uploads it
 * per OS), plus the checks that differ by platform:
 *
 *   1. The project sits under a path with spaces ("termpolis platform …/My Project"). The pane opens on it
 *      from the palette, and the spec records which renderer drew it: WebGL (and the GL renderer string, so
 *      SwiftShader shows as such) or the 2D list a machine without WebGL gets. Either way the pane works.
 *   2. Every id, member and line end in the stored world uses forward slashes, never a backslash. On Linux,
 *      two files whose names differ only in case stay two files.
 *   3. to 7. With WebGL: the district zoom, a building card, a line card, a building's floors (the double-
 *      click), a tour, and the 2D map. Without it: the 2D list, whose items open the same cards. No card text
 *      holds a backslash.
 *   8. The `lumopolis` shell command in bash and zsh (macOS and Linux; lumopolis-openers.spec.ts covers
 *      PowerShell on Windows): a quoted folder with spaces, a missing one, and plain `lumopolis` from a
 *      subfolder all do what the command promises.
 *   9. A design world (Home, Design something new, the mock agent's three planned parts).
 *  10. The renderer logged no console error.
 *
 * TERMPOLIS_E2E_WORLD_2D=1 runs the same spec with the GPU and its software fallback off, so the 2D list's branches run where
 * every runner has WebGL on SwiftShader: test 1 then fails unless the list shows, its shots go to
 * test-results/lumopolis-shots-2d/, and the shell command (test 8, which doesn't depend on the renderer) is left
 * to the WebGL run. CI runs it once on Linux.
 *
 * Labelling is off (launchWorldApp), the design draft runs e2e/mocks/mock-claude.cjs (as in
 * lumopolis-sources.spec.ts), and the launch is the shared one: software GL switches, and on Linux the
 * same --no-sandbox the other world specs pass.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild, e2eShimEnv } from './helpers/launch'
import { PROJECT_FILES, launchWorldApp, createTerminal as addTerminal, paletteType, removeDirs } from './helpers/world'

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
/** The 2D run: no WebGL, as on a machine without it. */
const FORCED_2D = process.env.TERMPOLIS_E2E_WORLD_2D === '1'
const SHOTS = path.resolve(FORCED_2D ? 'test-results/lumopolis-shots-2d' : 'test-results/lumopolis-shots')
const VIDEO_DIR = path.join(SHOTS, 'video')
/** The video needs Playwright's ffmpeg. The e2e-windows job installs none (it runs no \`playwright install\`),
 *  and there a recording launch never loaded its window (30 s, twice); the macOS and Linux jobs install it. */
const RECORD = !(process.platform === 'win32' && process.env.CI)
const DESCRIPTION = 'A small pet shop'
const PROJECT_NAME = 'My Project'
/** A second project beside the first, also under the path with spaces, which only the quoted folder in test 8 opens. */
const OTHER_NAME = 'Other Project'
/** Two files whose names differ only in case, written only where the file system keeps them apart (Linux). */
const CASE_PAIR = ['src/lib/Util.ts', 'src/lib/util.ts']
const CASE_SENSITIVE = process.platform === 'linux'

let app: ElectronApplication
let page: Page
let userDataDir: string
let base: string
let project: string
let other: string
let shimDir: string
let pickFile: string
let video: string | undefined
const consoleErrors: string[] = []
/** WebGL ('webgl') or the 2D list ('2d'), set by test 1. */
let mode: 'webgl' | '2d' = 'webgl'

interface Doc {
  districts: { id: string; name: string; members: string[] }[]
  buildings: { id: string; name: string; districtId: string; floors: { name: string }[]; members: string[] }[]
  edges: { id: string; from: string; to: string; label: string }[]
  tours: { id: string }[]
}
interface Probe {
  screenPoint(id: string): { x: number; y: number } | null
  pickAt(x: number, y: number): { kind: string; id: string } | null
  drawn(): { tier: string; wireframes: string[]; visual: { exploded: string | null; explodeGap: number } }
}

test.beforeAll(async () => {
  ensureE2eBuild()
  fs.mkdirSync(SHOTS, { recursive: true })
  // A path with spaces, both in the temp folder's own name and in the project's.
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis platform '))
  project = path.join(base, PROJECT_NAME)
  const files: Record<string, string> = { ...PROJECT_FILES }
  if (CASE_SENSITIVE) {
    files[CASE_PAIR[0]] = 'export const upper = (): string => "Util"\n'
    files[CASE_PAIR[1]] = 'export const lower = (): string => "util"\n'
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true })
    fs.writeFileSync(path.join(project, rel), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: project })
  execFileSync('git', ['add', '-A'], { cwd: project })
  // Its own name, so a `lumopolis` that ignored the folder it was given and reopened the last world would show
  // "My Project" and fail.
  other = path.join(base, OTHER_NAME)
  for (const [rel, text] of Object.entries(PROJECT_FILES)) {
    fs.mkdirSync(path.dirname(path.join(other, rel)), { recursive: true })
    fs.writeFileSync(path.join(other, rel), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: other })
  execFileSync('git', ['add', '-A'], { cwd: other })

  // The design draft's hidden agent run, as in lumopolis-sources.spec.ts: on Windows the mock as a
  // PowerShell script first on PATH; elsewhere e2e/test-shims/claude, which e2eShimEnv puts on PATH.
  const shims = e2eShimEnv('world-platform')
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-platform-shim-'))
  if (process.platform === 'win32') {
    const mock = path.resolve('e2e', 'mocks', 'mock-claude.cjs')
    fs.writeFileSync(path.join(shimDir, 'claude.ps1'), `& node '${mock}' @args\nexit $LASTEXITCODE\n`)
  }
  pickFile = path.join(shimDir, 'world-pick.txt')
  fs.writeFileSync(pickFile, '')

  fs.rmSync(VIDEO_DIR, { recursive: true, force: true })
  const launched = await launchWorldApp({
    ...(RECORD ? { videoDir: VIDEO_DIR } : {}),
    ...(FORCED_2D ? { noWebGL: true } : {}),
    env: {
      ...shims,
      PATH: `${shimDir}${path.delimiter}${shims.PATH}`,
      PSExecutionPolicyPreference: 'Bypass',
      TERMPOLIS_TEST_WORLD_PICK_FILE: pickFile,
      TERMPOLIS_TEST_AGENTS: '1',
      MOCK_CLAUDE_WORLD_ANSWER: '1',
    },
    onPage: (p) => {
      p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
      p.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
    },
  })
  app = launched.app
  page = launched.page
  userDataDir = launched.userDataDir
  await page.setViewportSize({ width: 1280, height: 800 })
  video = await page.video()?.path()
})

test.afterAll(async () => {
  await quitApp(app)
  // The video is written out when its window closes: give it a name that says which OS made it.
  if (video && fs.existsSync(video)) {
    try { fs.renameSync(video, path.join(VIDEO_DIR, `lumopolis-${PLATFORM}.webm`)) } catch { /* left under its own name */ }
  }
  removeDirs([userDataDir, base, shimDir])
})

const pane = () => page.locator('[data-testid="world-view"]')
const canvas = () => page.locator('[data-testid="world-canvas-host"] canvas')
const opening = () => page.locator('[data-testid="world-view-opening"]')
const fallback = () => page.locator('[data-testid="world-fallback"]')
const card = () => page.locator('[data-testid="world-card"]')
const projectName = () => page.getByTestId('world-project')
const shot = (name: string): Promise<Buffer> => page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
const probe = <T,>(fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(({ fn, args }) => {
    const p = (window as unknown as { __termpolis_world: Record<string, (...a: unknown[]) => unknown> }).__termpolis_world
    return p[fn](...args) as T
  }, { fn, args })

/** The world main stored for the project. */
async function worldDoc(): Promise<Doc> {
  const doc = await page.evaluate(async (r) => {
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    return res.success ? res.data ?? null : null
  }, project)
  expect(doc, 'main has no world for the project').not.toBeNull()
  return doc!
}

/** Adds to the run's summary on GitHub (the step summary), and to the log. */
function note(line: string): void {
  console.log(`[world-platform] ${line}`)
  test.info().annotations.push({ type: 'world-platform', description: line })
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    try { fs.appendFileSync(summary, `- Lumopolis (${PLATFORM}): ${line}\n`) } catch { /* no summary file */ }
  }
}

/**
 * A building a person could click: its aim point is on the bare canvas (nothing over it), the renderer picks
 * that building there and a few pixels round it, and it stands as far as can be from the next building's.
 */
async function aim(ids: string[]): Promise<{ id: string; x: number; y: number }> {
  const pt = await page.evaluate((all) => {
    const p = (window as unknown as { __termpolis_world: Probe }).__termpolis_world
    const host = document.querySelector('[data-testid="world-canvas-host"] canvas') as HTMLCanvasElement
    const box = host.getBoundingClientRect()
    const pts = all.map((id) => ({ id, p: p.screenPoint(id) }))
    let best: { id: string; x: number; y: number; gap: number } | null = null
    for (const { id, p: at } of pts) {
      if (!at || at.x < box.left + 8 || at.x > box.right - 8 || at.y < box.top + 8 || at.y > box.bottom - 8) continue
      const round = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]
      if (!round.every(([dx, dy]) => p.pickAt(at.x + dx, at.y + dy)?.id === id && document.elementFromPoint(at.x + dx, at.y + dy) === host)) continue
      const gap = Math.min(Infinity, ...pts.filter((q) => q.id !== id && q.p).map((q) => Math.hypot(q.p!.x - at.x, q.p!.y - at.y)))
      if (!best || gap > best.gap) best = { id, x: at.x, y: at.y, gap }
    }
    return best
  }, ids)
  expect(pt, `no building of ${ids.length} can be clicked on the bare canvas`).not.toBeNull()
  return pt!
}

/** From the overview (the reset button) wheel in until the districts' buildings are drawn, as world-view.spec.ts does. */
async function toBuildings(): Promise<void> {
  if (await card().count()) await page.locator('[data-testid="world-card-close"]').click()
  await expect(card()).toHaveCount(0)
  await page.mouse.move(2, 400)
  await page.locator('[data-testid="world-reset"]').click()
  await page.waitForTimeout(2500)
  const box = (await canvas().boundingBox())!
  // OrbitControls (three r160) divides the wheel delta by `devicePixelRatio | 0` (see world-view.spec.ts).
  await page.evaluate(() => { if ((window.devicePixelRatio | 0) === 0) Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true }) })
  const tier = async (): Promise<string> => (await probe<{ tier: string }>('drawn')).tier
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 40 && (await tier()) === 'districts'; i++) {
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(120)
  }
  expect(await tier(), 'wheeling in never reached the buildings').not.toBe('districts')
  await page.mouse.move(2, 400)
  await page.waitForTimeout(1500)
}

/** Card text a person reads: it names files and folders, and must never show a Windows separator off Windows. */
async function expectNoBackslash(where: string): Promise<void> {
  const text = (await card().innerText()) ?? ''
  if (process.platform !== 'win32') expect(text, `${where} shows a backslash: ${text}`).not.toContain('\\')
}

test.describe.serial('Lumopolis on this platform', () => {
  test.setTimeout(60_000)

  test('1. the palette opens a project under a path with spaces, on WebGL or the 2D list, and the pane works', async () => {
    test.setTimeout(150_000)
    await addTerminal(page, 'Platform', project)
    await paletteType(page, 'Open Lumopolis')
    const result = page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ })
    await expect(result).toBeVisible()
    const clicked = Date.now()
    await result.click()
    // Something shows at once: the pane, or its frame saying "Opening Lumopolis…" while the pane's
    // code (the engine and Three.js) loads on first use. On a cold macOS runner that load took over
    // 5 s, with the frame and its words on screen the whole time and the app answering.
    await expect(pane().or(opening())).toBeVisible()
    const shown = Date.now() - clicked
    await expect(pane()).toBeVisible({ timeout: 60_000 })
    const paneAt = Date.now() - clicked
    await expect(projectName()).toHaveText(PROJECT_NAME, { timeout: 30_000 })
    const namedAt = Date.now() - clicked
    await expect(canvas().or(fallback())).toBeVisible({ timeout: 120_000 })
    const drawnAt = Date.now() - clicked
    mode = (await fallback().count()) > 0 ? '2d' : 'webgl'
    if (FORCED_2D) expect(mode, 'the 2D run drew a WebGL canvas: WebGL was not turned off').toBe('2d')
    note(`first open: something on screen ${shown} ms after the click, the pane ${paneAt} ms, its project named ${namedAt} ms, the map drawn ${drawnAt} ms`)

    // The GL renderer Chromium gives a page here: SwiftShader names itself in its renderer string.
    const gl = await page.evaluate(() => {
      const c = document.createElement('canvas')
      const g = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null
      if (!g) return null
      const ext = g.getExtension('WEBGL_debug_renderer_info')
      const info = {
        version: String(g.getParameter(g.VERSION)),
        vendor: String(ext ? g.getParameter(ext.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR)),
        renderer: String(ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)),
      }
      g.getExtension('WEBGL_lose_context')?.loseContext()
      return info
    })
    const swiftshader = !!gl && /swiftshader/i.test(`${gl.renderer} ${gl.vendor}`)
    const record = { platform: PLATFORM, mode, forced2d: FORCED_2D, swiftshader, gl }
    fs.writeFileSync(path.join(SHOTS, 'renderer.json'), `${JSON.stringify(record, null, 2)}\n`)
    note(mode === '2d' ? `2D list (no WebGL; GL: ${gl ? gl.renderer : 'none'})` : `WebGL${swiftshader ? ' on SwiftShader' : ''}: ${gl ? `${gl.renderer} (${gl.version})` : 'unknown'}`)

    const doc = await worldDoc()
    expect(doc.buildings.length).toBeGreaterThan(1)
    if (mode === 'webgl') {
      await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: 30_000 })
      await page.waitForTimeout(1500) // the camera's first framing
      await shot('01-opened')
    } else {
      // The 2D list: every building drawn once on its flat map and listed once below it, and one opens its card.
      await shot('00-2d-fallback')
      for (const b of doc.buildings) {
        await expect(fallback().locator(`svg rect[data-kind="building"][data-id="${b.id}"]`), `${b.id} on the flat map`).toHaveCount(1)
        await expect(fallback().locator(`li[data-kind="building"][data-id="${b.id}"]`), `${b.id} in the list`).toHaveCount(1)
      }
      await fallback().locator(`li[data-kind="building"][data-id="${doc.buildings[0].id}"]`).click()
      await expect(card()).toBeVisible()
      await expect(card().locator('h3').first()).toHaveText(doc.buildings[0].name)
      await shot('01-opened')
    }
  })

  test('2. ids, members and line ends use forward slashes, and two file names differing only in case stay two files', async () => {
    const doc = await worldDoc()
    const strings = [
      ...doc.districts.flatMap((d) => [d.id, ...d.members]),
      ...doc.buildings.flatMap((b) => [b.id, b.districtId, ...b.members]),
      ...doc.edges.flatMap((e) => [e.id, e.from, e.to]),
    ]
    const members = doc.buildings.flatMap((b) => b.members)
    expect(members.length).toBeGreaterThan(0)
    expect(strings.filter((s) => s.includes('\\')), 'world ids or members with a backslash').toEqual([])
    // The members are project-relative (the spaces in the project's own path never reach them).
    expect(members.filter((m) => m.includes(PROJECT_NAME) || path.isAbsolute(m)), 'members holding the project path').toEqual([])
    note(`ids and members: ${strings.length} checked, no backslash`)
    if (!CASE_SENSITIVE) {
      note('case pair: skipped (this file system ignores case)')
      return
    }
    for (const f of CASE_PAIR) expect(members.filter((m) => m === f), `${f} in the world's members`).toHaveLength(1)
    note(`case pair: ${CASE_PAIR.join(' and ')} are two members`)
  })

  test('3. wheeling in from the overview reaches the districts\' buildings', async () => {
    test.skip(mode === '2d', 'the 2D list has no camera')
    await toBuildings()
    await shot('02-district-zoom')
  })

  test('4. clicking a building opens its card, with its floors, and no backslash in it', async () => {
    test.skip(mode === '2d', 'test 1 opened a card from the 2D list')
    const doc = await worldDoc()
    // A building with lines, so test 5 has a line label to click.
    const connected = doc.buildings.filter((b) => doc.edges.some((e) => e.from === b.id || e.to === b.id))
    const target = await aim((connected.length ? connected : doc.buildings).map((b) => b.id))
    const b = doc.buildings.find((x) => x.id === target.id)!
    await page.mouse.click(target.x, target.y)
    await expect(card()).toBeVisible()
    await expect(card().locator('h3').first()).toHaveText(b.name)
    await expect(card().locator(`h4:text-is("What's inside") + ul > li > b`)).toHaveText(b.floors.map((f) => f.name))
    await page.mouse.move(2, 400)
    await page.waitForTimeout(1500)
    await shot('03-building-card')
    await expectNoBackslash('the building card')
  })

  test('5. a line label of the selected building opens the line\'s card', async () => {
    test.skip(mode === '2d', 'the 2D list has no line labels')
    const label = await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>('.lw-edge')) {
        if (getComputedStyle(el).display === 'none') continue
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        const hit = document.elementFromPoint(x, y)
        if (hit && el.contains(hit)) return { x, y, text: el.textContent ?? '' }
      }
      return null
    })
    expect(label, 'no line label of the selection can be clicked').not.toBeNull()
    await page.mouse.click(label!.x, label!.y)
    await expect(card()).toBeVisible()
    await expect(card().locator('h3').first()).toHaveText(label!.text)
    await expect(card().locator('p.muted').first()).toContainText('→')
    await page.mouse.move(2, 400)
    await page.waitForTimeout(1800)
    await shot('04-line-card')
    await expectNoBackslash('the line card')
  })

  test('6. a double-click on a building shows its floors', async () => {
    test.skip(mode === '2d', 'the 2D list has no floors to open')
    // The line card framed the line close up: back to the overview, then in to the buildings.
    await toBuildings()
    const doc = await worldDoc()
    const target = await aim(doc.buildings.map((b) => b.id))
    await page.mouse.dblclick(target.x, target.y)
    const visual = async (): Promise<{ exploded: string | null; explodeGap: number }> => (await probe<{ visual: { exploded: string | null; explodeGap: number } }>('drawn')).visual
    await expect.poll(async () => (await visual()).exploded, { timeout: 5000 }).toBe(target.id)
    await expect.poll(async () => (await visual()).explodeGap, { timeout: 5000 }).toBeGreaterThan(0)
    await page.mouse.move(2, 400)
    await page.waitForTimeout(1200)
    await shot('05-floors')
  })

  test('7. a tour plays with its caption, and the 2D map draws an svg whose buildings open cards', async () => {
    test.skip(mode === '2d', 'the 2D list is already shown')
    const tours = page.locator('[data-testid="world-tours"]')
    await expect(tours).toBeVisible()
    const values = await tours.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean))
    expect(values.length).toBeGreaterThan(0)
    await tours.selectOption(values[0])
    await expect(card().locator('.tour-caption')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1500)
    await shot('06-tour')
    await page.locator('[data-testid="world-card-close"]').click()
    await expect(card()).toHaveCount(0)

    await page.getByTestId('world-map2d').click()
    const map = page.locator('svg[role=img]')
    await expect(map).toBeVisible()
    const rects = map.locator('rect[data-kind="building"]')
    expect(await rects.count()).toBeGreaterThan(0)
    await rects.first().click()
    await expect(card()).toBeVisible()
    await page.waitForTimeout(500)
    await shot('08-2d-map')
    await expectNoBackslash('the 2D map\'s card')
    await page.locator('[data-testid="world-card-close"]').click()
    await page.getByTestId('world-map2d').click()
    await expect(map).toHaveCount(0)
  })

  test('8. the lumopolis command works in bash and zsh, with spaces in the folder', async () => {
    test.skip(process.platform === 'win32', 'lumopolis-openers.spec.ts covers PowerShell on Windows')
    test.skip(FORCED_2D, 'the WebGL run covers the shell command, which does not depend on the renderer')
    test.setTimeout(150_000)
    if (await pane().count()) {
      await page.locator('[data-testid="world-close"]').click()
      await expect(pane()).toHaveCount(0)
    }
    const text = (id: string): Promise<string> =>
      page.evaluate((t) => (window as unknown as { __termpolis_terminal_text?: (id?: string) => string }).__termpolis_terminal_text?.(t) ?? '', id)
    const typeIn = async (id: string, line: string): Promise<void> => {
      await page.locator(`[data-terminal-id="${id}"] .xterm`).click()
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea')), { message: 'the terminal to have focus' }).toBe(true)
      await page.keyboard.type(line, { delay: 20 })
      await page.keyboard.press('Enter')
    }
    const closePane = async (): Promise<void> => {
      await page.locator('[data-testid="world-close"]').click()
      await expect(pane()).toHaveCount(0)
    }
    // Each shell starts in its own subfolder, so its terminal's globe (named after its folder) finds its id.
    const shells: Array<{ shell: 'bash' | 'zsh'; folder: string }> = [
      { shell: 'bash', folder: path.join(project, 'src', 'renderer') },
      { shell: 'zsh', folder: path.join(project, 'src', 'preload') },
    ]
    for (const { shell, folder } of shells) {
      await page.locator('button:has-text("+ Add Terminal")').first().click()
      const dialog = page.locator('h2:has-text("New Terminal")').locator('..')
      await expect(dialog).toBeVisible()
      const select = dialog.getByRole('combobox', { name: 'Shell' })
      const offered = await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
      if (!offered.includes(shell)) {
        // CI installs both shells: there a missing one is a failure, not a skip.
        expect(process.env.CI, `${shell} is not installed (offered: ${offered.join(', ')})`).toBeFalsy()
        note(`lumopolis in ${shell}: skipped, ${shell} is not installed here`)
        await page.keyboard.press('Escape')
        continue
      }
      await dialog.locator('input').first().fill(`Lumopolis ${shell}`)
      await dialog.locator('input[placeholder="Home directory"]').fill(folder)
      await select.selectOption(shell)
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      const globe = page.getByRole('button', { name: `Map ${path.basename(folder)} in Lumopolis`, exact: true })
      await expect(globe).toBeVisible({ timeout: 30_000 })
      const id = ((await globe.getAttribute('data-testid')) ?? '').replace('terminal-open-world-', '')
      await expect.poll(async () => (await text(id)).trim().length, { timeout: 30_000 }).toBeGreaterThan(0)
      await page.waitForTimeout(1000) // the shell's prompt and its integration are up
      // A start-up question (zsh's compinit asks one about insecure folders) would take the first key typed.
      expect(await text(id), `${shell} asked a question at start-up`).not.toMatch(/insecure directories|\[y\]/)

      // A missing folder with a space in its name: the shell refuses it by name and nothing opens.
      await typeIn(id, "lumopolis 'no such dir'")
      await expect.poll(() => text(id), { timeout: 20_000 }).toContain('lumopolis: no such folder: no such dir')
      await page.waitForTimeout(1000)
      await expect(pane()).toHaveCount(0)

      // Plain lumopolis from a subfolder maps the whole project (its git root, under a path with spaces).
      await typeIn(id, 'lumopolis')
      await expect(pane()).toBeVisible({ timeout: 20_000 })
      await expect(projectName()).toHaveText(PROJECT_NAME, { timeout: 30_000 })
      await closePane()

      // Another project's folder, quoted, from another folder: the spaces reach the pane whole, and the pane
      // maps the folder given, not the project it showed last.
      await typeIn(id, `cd / && lumopolis '${other}'`)
      await expect(pane()).toBeVisible({ timeout: 20_000 })
      await expect(projectName()).toHaveText(OTHER_NAME, { timeout: 30_000 })
      const shown = await text(id)
      expect(shown).not.toContain('7377')
      expect(shown).not.toMatch(/lumopolis;[0-9a-f]{32}/)
      await closePane()
      note(`lumopolis in ${shell}: the missing folder, plain lumopolis and a quoted folder with spaces all worked`)
    }
  })

  test('9. Design something new opens a design world of three planned parts', async () => {
    test.setTimeout(120_000)
    if (!(await pane().count())) {
      await paletteType(page, 'Open Lumopolis')
      await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
      await expect(pane()).toBeVisible()
    }
    const home = page.locator('[data-testid="world-home"]')
    await page.getByRole('combobox', { name: 'Worlds' }).selectOption('__home')
    await expect(home).toBeVisible()
    await home.getByRole('button', { name: /^Design something new/ }).click()
    const start = page.getByRole('dialog', { name: 'Design something new' })
    await start.getByPlaceholder('Describe the app you want…').fill(DESCRIPTION)
    await start.getByRole('button', { name: 'Design it' }).click()
    await expect(projectName()).toHaveText(DESCRIPTION, { timeout: 60_000 })
    await expect(page.locator('[data-testid="world-layer-planned"]')).toHaveAttribute('aria-pressed', 'true')
    if (mode === 'webgl') {
      await expect.poll(async () => [...(await probe<{ wireframes: string[] }>('drawn')).wireframes].sort(), { timeout: 60_000 }).toEqual(['catalog', 'orders', 'storefront'])
    } else {
      await expect(fallback()).toBeVisible()
    }
    await page.waitForTimeout(1500)
    await shot('07-design-world')
  })

  test('10. over the whole run, the renderer logged no console errors and threw no page errors', async () => {
    expect(consoleErrors).toEqual([])
  })
})

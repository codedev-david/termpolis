/**
 * Lumopolis in the real app (Plan 1, Task 14): what only the real Electron app can prove. The unit
 * suites prove the compiler, the engine and the pane against fakes; e2e/world-engine.spec.ts proves the
 * engine bundle in a bare window. This spec drives the whole path on a real project folder:
 *
 *   1. The command palette's "Open Lumopolis" opens the pane on the active terminal's project, which
 *      main compiles (code graph first, then the world in its utility process) and the pane draws on
 *      a WebGL canvas.
 *   2. Clicking a building on the canvas opens that building's card.
 *   3. "What runs where" (the Processes layer) draws the process shells, and takes them away again.
 *   4. A tour plays, and its caption changes from step to step.
 *   5. Typing in a terminal while a bigger project compiles: the p95 keystroke-to-echo time stays
 *      under 50 ms, over at least 60 keys pressed while the compile ran. Measured in the renderer,
 *      from the key's keydown to the moment the echoed character is on xterm's cursor line; the
 *      warm-up keys before the compile starts are not counted.
 *   6. Last, over the whole session (compiles, clicks, tour, typing): the renderer logged no console
 *      error and threw no page error.
 *
 * Steps 2 and 3 read the map through window.__termpolis_world, a read-only probe the pane puts up
 * only under TERMPOLIS_TEST_WORLD_PROBE=1 (a building's place on screen, what is drawn), so the
 * spec clicks a known building instead of scanning the canvas.
 *
 * The fixture projects are temp git repositories (the code graph lists a project's files with
 * `git ls-files`). Labelling is switched off in the temp profile (world-settings.json), so the world
 * is named from the code alone and no model is called. The launch adds Chromium's software GL
 * switches, as the world-engine harness does, so a runner with no GPU still gets WebGL.
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
let project: string
let loadProject: string
const consoleErrors: string[] = []

const P95_BUDGET_MS = 50
/** Keys typed before the compile starts: they warm the shell and the renderer, and are not counted. */
const WARMUP_KEYS = 10
/** The fewest keys pressed during the compile for the p95 to count. */
const MIN_SAMPLES = 60
/** A steady typist: one key every 50 ms. */
const KEY_GAP_MS = 50
/** Keys per shell line before it is cleared, so the line (and its redraw) stays short. */
const LINE_KEYS = 40

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

/** A small Electron-shaped project: main, a forked host, a preload bridge and a renderer that uses it. */
const PROJECT_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'notes-app', version: '1.0.0', main: 'out/main/index.js' }),
  'src/main/index.ts': [
    "import { app, ipcMain, utilityProcess } from 'electron'",
    "import { join } from 'path'",
    "import { listNotes } from './store'",
    '',
    'app.whenReady().then(() => {',
    "  const host = utilityProcess.fork(join(__dirname, 'notesHost.js'))",
    "  ipcMain.handle('notes:list', async () => listNotes())",
    "  ipcMain.handle('notes:index', async () => host.postMessage({ type: 'index' }))",
    '})',
    '',
  ].join('\n'),
  'src/main/store.ts': "export function listNotes(): string[] {\n  return ['one', 'two']\n}\n",
  'src/main/notesHost.ts': [
    "import { buildIndex } from './indexer'",
    '',
    "process.parentPort.on('message', () => buildIndex())",
    '',
  ].join('\n'),
  'src/main/indexer.ts': 'export function buildIndex(): number {\n  return 1\n}\n',
  'src/preload/index.ts': [
    "import { contextBridge, ipcRenderer } from 'electron'",
    '',
    "contextBridge.exposeInMainWorld('notes', {",
    "  list: () => ipcRenderer.invoke('notes:list'),",
    "  index: () => ipcRenderer.invoke('notes:index'),",
    '})',
    '',
  ].join('\n'),
  'src/renderer/main.ts': "import { render } from './App'\n\nrender(document.body)\n",
  'src/renderer/App.ts': [
    "import { row } from './NoteRow'",
    '',
    'export async function render(el: HTMLElement): Promise<void> {',
    '  const notes = await (window as any).notes.list()',
    "  el.innerHTML = notes.map(row).join('')",
    '}',
    '',
  ].join('\n'),
  'src/renderer/NoteRow.ts': 'export const row = (n: string): string => `<li>${n}</li>`\n',
}

/** A bigger project for the typing measurement: enough files that the compile outlasts the typing
 *  of MIN_SAMPLES keys several times over, on a fast machine too. */
const LOAD_AREAS = ['api', 'core', 'jobs', 'ui', 'data', 'auth', 'mail', 'billing', 'search', 'audit', 'files', 'admin']
const LOAD_FILES_PER_AREA = 200
function loadFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const area of LOAD_AREAS) {
    for (let i = 0; i < LOAD_FILES_PER_AREA; i++) {
      const imports = [1, 2, 3].map((k) => (i - k >= 0 ? `import { f${i - k} } from './m${i - k}'\n` : '')).join('')
      const body = Array.from({ length: 12 }, (_, k) => `  const v${k} = f${Math.max(0, i - 1)}(${k}) + ${k}\n  if (v${k} > ${k * 3}) return v${k}\n`).join('')
      files[`src/${area}/m${i}.ts`] = `${imports}export function f${i}(x: number): number {\n${body}  return x\n}\n`
    }
  }
  return files
}

test.beforeAll(async () => {
  ensureE2eBuild()
  project = makeRepo('notes', PROJECT_FILES)
  loadProject = makeRepo('load', loadFiles())

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-ud-'))
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs' }),
  )
  // Names from the code alone: no model is asked to describe the parts.
  fs.writeFileSync(path.join(userDataDir, 'world-settings.json'), JSON.stringify({ worldLabelling: false }))

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      // Software GL (SwiftShader), so a runner with no GPU still gets a WebGL context.
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
  await page.waitForTimeout(1500)
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
  for (const d of [userDataDir, project, loadProject]) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  }
})

/** Adds a terminal whose working folder is `cwd` (the Add Terminal dialog's folder field). */
async function createTerminal(name: string, cwd: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  const dialog = page.locator('h2:has-text("New Terminal")').locator('..')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').first().fill(name)
  await dialog.locator('input[placeholder="Home directory"]').fill(cwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

const pane = () => page.locator('[data-testid="world-view"]')
const canvas = () => page.locator('[data-testid="world-canvas-host"] canvas')
const card = () => page.locator('[data-testid="world-card"]')

/** The world's buildings (id and name), as main stored them for the project. */
async function buildings(root: string): Promise<Array<{ id: string; name: string }>> {
  return page.evaluate(async (r) => {
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: { buildings: { id: string; name: string }[] } | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    return res.success && res.data ? res.data.buildings.map((b) => ({ id: b.id, name: b.name })) : []
  }, root)
}

interface Drawn { layers: { processes: boolean }; processShells: number; conduits: number }
interface Probe { screenPoint(id: string): { x: number; y: number } | null; drawn(): Drawn }
const drawn = (): Promise<Drawn | null> =>
  page.evaluate(() => (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.drawn() ?? null)

test.describe.serial('Lumopolis in the real app', () => {
  test.setTimeout(180_000)

  test('1. the command palette opens Lumopolis and the compiled world is drawn on a canvas', async () => {
    await createTerminal('Notes', project)
    // A focused terminal takes Ctrl+K as a key for the shell: the palette shortcut is the app's
    // only when the focus is outside it, as after clicking away.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Control+k')
    const input = page.getByPlaceholder('Type a command...')
    await expect(input).toBeVisible()
    await input.fill('Open Lumopolis')
    // The palette's result, by its label and description (the sidebar has an 'Open Lumopolis' button too).
    const result = page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ })
    await expect(result).toBeVisible()
    await result.click()

    await expect(pane()).toBeVisible()
    // No WebGL would show the 2D list instead: the launch switches above are meant to rule that out.
    await expect(page.locator('[data-testid="world-fallback"]')).toHaveCount(0)
    await expect(canvas()).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('[data-testid="world-canvas-host"]')).not.toHaveClass(/invisible/, { timeout: 90_000 })
    expect((await buildings(project)).length).toBeGreaterThan(1)
  })

  test('2. clicking a building opens its card', async () => {
    const all = await buildings(project)
    // Let the camera's first framing settle before aiming at it.
    await page.waitForTimeout(1500)
    const box = (await canvas().boundingBox())!
    // The probe says where each building is on screen; the first one clear of the card's strip on
    // the right is clicked as a person would, and its card must open with its name.
    let target: { id: string; name: string; x: number; y: number } | null = null
    for (const b of all) {
      const pt = await page.evaluate((id) => (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.screenPoint(id) ?? null, b.id)
      if (pt && pt.x > box.x + 8 && pt.x < box.x + box.width - 380 && pt.y > box.y + 8 && pt.y < box.y + box.height - 8) {
        target = { ...b, ...pt }
        break
      }
    }
    expect(target, `no building of ${all.length} is on screen clear of the card strip`).not.toBeNull()
    await page.mouse.click(target!.x, target!.y)
    await expect(card()).toBeVisible()
    await expect(card().locator('h3').first()).toHaveText(target!.name)
    await expect(card()).toContainText('What it does')
    await expect(card()).toContainText('Process')
  })

  test('3. "What runs where" draws the process shells, and takes them away again', async () => {
    const toggle = page.locator('[data-testid="world-layer-processes"]')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(await drawn()).toMatchObject({ layers: { processes: false }, processShells: 0 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    // The notes project has a main process, a forked host, a preload and a renderer: shells are drawn.
    await expect.poll(async () => (await drawn())?.processShells ?? 0).toBeGreaterThan(0)
    expect((await drawn())!.layers.processes).toBe(true)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await drawn())?.processShells ?? -1).toBe(0)
    expect((await drawn())!.layers.processes).toBe(false)
  })

  test('4. a tour plays and its caption changes from step to step', async () => {
    const tours = page.locator('[data-testid="world-tours"]')
    await expect(tours).toBeVisible()
    const values = await tours.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean))
    expect(values.length).toBeGreaterThan(0)
    // Every caption the card shows, recorded as it appears (a fast step is not missed between polls).
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { __tourCaptions: string[] }).__tourCaptions = seen
      const note = (): void => {
        const t = document.querySelector('[data-testid="world-card"] .tour-caption')?.textContent?.trim()
        if (t && seen[seen.length - 1] !== t) seen.push(t)
      }
      new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await tours.selectOption(values[0])
    await expect(card().locator('.tour-caption')).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __tourCaptions: string[] }).__tourCaptions.length), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2)
    const captions = await page.evaluate(() => (window as unknown as { __tourCaptions: string[] }).__tourCaptions)
    expect(new Set(captions).size).toBeGreaterThanOrEqual(2)
  })

  test('5. typing stays quick while a project compiles (p95 keystroke echo < 50 ms)', async () => {
    test.setTimeout(300_000)
    // Stop the tour (it may still be running) by closing its card, then close the pane.
    if (await card().isVisible().catch(() => false)) await page.locator('[data-testid="world-card-close"]').click()
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
    await createTerminal('Typing', project)

    // The renderer's side of the measurement. A capture-phase keydown stamps each printable key
    // (the line marker's two capitals excepted), and a 1 ms poll of the terminal's cursor line (a
    // row or two, never the whole buffer) stamps each key once its character is on the line after
    // the marker. Each shell line holds the marker and up to LINE_KEYS keys; the spec clears it and
    // starts a new one (`newLine()`), so the line's redraw stays the same size all the way through.
    const marker = 'ZQ'
    await page.evaluate((marker) => {
      interface Echo {
        down: number[]; echo: number[]; lineBase: number; lineKeys: string; done: boolean
        compiling: boolean; compileStart: number; compileEnd: number; compileError?: string
      }
      const w = window as unknown as { __termpolis_cursor_line?: () => string; __echo: Echo; __echoLine: () => void }
      const s: Echo = { down: [], echo: [], lineBase: 0, lineKeys: '', done: false, compiling: false, compileStart: 0, compileEnd: 0 }
      w.__echo = s
      w.__echoLine = () => { s.lineBase = s.down.length; s.lineKeys = '' }
      window.addEventListener('keydown', (e) => {
        if (e.key.length !== 1 || e.key === marker[0] || e.key === marker[1]) return
        s.down.push(performance.now())
        s.echo.push(0)
        s.lineKeys += e.key
      }, true)
      const poll = (): void => {
        if (s.done) return
        if (s.lineKeys) {
          const line = w.__termpolis_cursor_line?.() ?? ''
          const at = line.lastIndexOf(marker)
          if (at >= 0) {
            let n = 0
            while (n < s.lineKeys.length && line[at + marker.length + n] === s.lineKeys[n]) n++
            const now = performance.now()
            for (let k = 0; k < n; k++) if (!s.echo[s.lineBase + k]) s.echo[s.lineBase + k] = now
          }
        }
        setTimeout(poll, 1)
      }
      poll()
    }, marker)

    const letters = 'abcdefghijklmnoprstuvwxy'
    let typed = 0
    const allEchoed = (): Promise<boolean> =>
      page.evaluate(() => (window as unknown as { __echo: { echo: number[] } }).__echo.echo.every((t) => t > 0))
    const markerShown = (): Promise<boolean> =>
      page.evaluate((m) => ((window as unknown as { __termpolis_cursor_line?: () => string }).__termpolis_cursor_line?.() ?? '').includes(m), marker)
    // Clears the shell's line (nothing typed here is ever run).
    const clearLine = (): Promise<void> => page.keyboard.press(process.platform === 'win32' ? 'Escape' : 'Control+u')
    const newLine = async (): Promise<void> => {
      await expect.poll(allEchoed, { timeout: 20_000 }).toBe(true)
      await clearLine()
      await expect.poll(markerShown, { timeout: 20_000 }).toBe(false)
      await page.evaluate(() => (window as unknown as { __echoLine: () => void }).__echoLine())
      await page.keyboard.type(marker, { delay: KEY_GAP_MS })
      await expect.poll(markerShown, { timeout: 20_000 }).toBe(true)
    }
    const key = async (): Promise<void> => {
      await page.keyboard.press(letters[typed++ % letters.length])
      await page.waitForTimeout(KEY_GAP_MS)
    }

    // Warm-up, before any load: typed and echoed, and not counted.
    await page.keyboard.type(marker, { delay: KEY_GAP_MS })
    await expect.poll(markerShown, { timeout: 20_000 }).toBe(true)
    for (let i = 0; i < WARMUP_KEYS; i++) await key()

    // The load: main builds the bigger project's code graph, then its utility process compiles it.
    // The compile starts first; the typing then runs at a steady pace until it has ended.
    await page.evaluate((root) => {
      const w = window as unknown as { termpolis: { worldCompile: (r: string) => Promise<{ success: boolean; error?: string }> }; __echo: { compiling: boolean; compileStart: number; compileEnd: number; compileError?: string } }
      w.__echo.compiling = true
      w.__echo.compileStart = performance.now()
      void w.termpolis.worldCompile(root).then(
        (r) => { if (!r.success) w.__echo.compileError = r.error },
        (e: unknown) => { w.__echo.compileError = String(e) },
      ).finally(() => { w.__echo.compiling = false; w.__echo.compileEnd = performance.now() })
    }, loadProject)
    await newLine()
    const compiling = (): Promise<boolean> => page.evaluate(() => (window as unknown as { __echo: { compiling: boolean } }).__echo.compiling)
    const deadline = Date.now() + 240_000
    let onLine = 0
    while ((await compiling()) && Date.now() < deadline) {
      if (onLine === LINE_KEYS) { await newLine(); onLine = 0 }
      await key()
      onLine++
    }
    // A few keys after the end, so the last keys pressed during the compile echo under the same
    // pattern; then every echo is awaited and the line cleared.
    for (let i = 0; i < 5; i++) await key()
    await expect.poll(allEchoed, { timeout: 20_000 }).toBe(true)
    await clearLine()

    const r = await page.evaluate(() => {
      const s = (window as unknown as { __echo: { down: number[]; echo: number[]; compiling: boolean; compileStart: number; compileEnd: number; compileError?: string; done: boolean } }).__echo
      s.done = true
      return { down: s.down, echo: s.echo, compiling: s.compiling, compileStart: s.compileStart, compileEnd: s.compileEnd, compileError: s.compileError }
    })
    expect(r.compiling, 'the compile was still running after 240 s of typing').toBe(false)
    expect(r.compileError ?? null).toBeNull()
    // Only keys pressed while the compile ran count: that leaves out the warm-up and the tail.
    const during = r.down.map((d, i) => ({ d, ms: r.echo[i] - d })).filter((x) => x.d >= r.compileStart && x.d < r.compileEnd)
    const lat = during.map((x) => x.ms).sort((a, b) => a - b)
    const n = lat.length
    const p95 = lat[Math.min(n - 1, Math.ceil(n * 0.95) - 1)]
    const p50 = lat[Math.floor(n / 2)]
    const compileMs = r.compileEnd - r.compileStart
    const span = n ? `${(during[0].d - r.compileStart).toFixed(0)}..${(during[n - 1].d - r.compileStart).toFixed(0)} ms` : 'none'
    const summary = `samples=${n} (of ${r.down.length} keys, ${WARMUP_KEYS} warm-up) compile=${compileMs.toFixed(0)} ms, keys at ${span}, p50=${p50?.toFixed(1)} ms p95=${p95?.toFixed(1)} ms max=${lat[n - 1]?.toFixed(1)} ms`
    console.log(`[typing while compiling] ${summary}`)
    expect(n, `too few keys pressed during the compile: ${summary}`).toBeGreaterThanOrEqual(MIN_SAMPLES)
    expect(p95, `p95 keystroke echo over budget: ${summary}`).toBeLessThan(P95_BUDGET_MS)
  })

  test('6. over the whole session, the renderer logged no console errors and threw no page errors', async () => {
    expect(consoleErrors).toEqual([])
  })
})

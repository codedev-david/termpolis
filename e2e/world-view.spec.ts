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
 *      under 50 ms, over at least 60 keys pressed while a compile ran. Measured in the renderer,
 *      from the key's keydown to the moment the echoed character is on xterm's cursor line. A
 *      compile of the load project takes a few seconds on a fast runner, so compiles run back to
 *      back (the first a compile, then forced recompiles, as Re-layout does) until 60 keys fell
 *      inside one, at most MAX_COMPILES of them and within a 60 s typing deadline; only keys whose keydown falls inside a compile
 *      count, so the warm-up keys before the first one never do.
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
/** The fewest keys pressed during a compile for the p95 to count. */
const MIN_SAMPLES = 60
/** The most compiles run back to back to gather MIN_SAMPLES keys. A forced recompile reuses the
 *  code graph and takes about 350 ms on a CI runner (3 to 6 keys), so a fast runner needs many;
 *  the 60 s typing deadline is the hard stop. */
const MAX_COMPILES = 25
/** A steady typist: one key every 50 ms. */
const KEY_GAP_MS = 50
/** The most keys per shell line before it is cleared, so the line (and its redraw) stays short. */
const LINE_KEYS = 20
/** Columns the typed line keeps clear of the terminal's right edge: a line that reaches the margin
 *  is wrapped by the shell or by xterm, and the key at the edge may never show on the cursor line
 *  (a CI prompt is 56 to 58 columns, user@host:/tmp/termpolis-world-notes-XXXXXX$). */
const MARGIN_COLS = 10

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

/** A bigger project for the typing measurement: 2,040 files, about 3 s for the first compile on a
 *  CI runner (2,400 took 3.5 to 4 s there, and 21 to 28 s on a slow laptop). The keys come from
 *  several compiles in a row, so the fixture need not outlast the typing on its own; but a forced
 *  recompile reuses the code graph and takes only about a quarter of the first compile, so the first
 *  one still has to carry most of the MIN_SAMPLES keys. */
const LOAD_AREAS = ['api', 'core', 'jobs', 'ui', 'data', 'auth', 'mail', 'billing', 'search', 'audit', 'files', 'admin']
const LOAD_FILES_PER_AREA = 170
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

/** The world's buildings (id, name and floor names), as main stored them for the project. */
async function buildings(root: string): Promise<Array<{ id: string; name: string; floors: string[] }>> {
  return page.evaluate(async (r) => {
    interface Doc { buildings: { id: string; name: string; floors: { name: string }[] }[] }
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    return res.success && res.data ? res.data.buildings.map((b) => ({ id: b.id, name: b.name, floors: b.floors.map((f) => f.name) })) : []
  }, root)
}

interface Drawn { layers: { processes: boolean }; processShells: number; conduits: number }
interface Probe { screenPoint(id: string): { x: number; y: number } | null; drawn(): Drawn }
const drawn = (): Promise<Drawn | null> =>
  page.evaluate(() => (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.drawn() ?? null)

test.describe.serial('Lumopolis in the real app', () => {
  // About twice the slowest local run of each test (test 1 took 11 s, the others 1 to 2 s; test 5
  // sets its own), so a whole-file retry stays well inside the CI step.
  test.setTimeout(45_000)

  test('1. the command palette opens Lumopolis and the compiled world is drawn on a canvas', async () => {
    // Its own budget: the two 30 s waits below must fail with their own message, not the test's.
    test.setTimeout(75_000)
    await createTerminal('Notes', project)
    // A focused terminal takes Ctrl+K as a key for the shell: the palette shortcut is the app's
    // only when the focus is outside it, as after clicking away.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('ControlOrMeta+k')
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
    await expect(canvas()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: 30_000 })
    expect((await buildings(project)).length).toBeGreaterThan(1)
  })

  test('2. clicking a building opens its card', async () => {
    const all = await buildings(project)
    // Let the camera's first framing settle before aiming at it.
    await page.waitForTimeout(1500)
    const box = (await canvas().boundingBox())!
    // The probe gives a point where the viewer's own pick lands on the building (nothing drawn in
    // front of it); the first such point inside the canvas with the canvas itself under it (no
    // label, legend or other panel on top) is clicked as a person would.
    type Target = { id: string; name: string; floors: string[]; x: number; y: number }
    // Every building's screen point in one pass, so a target can be chosen that no other building
    // stands near: in a narrow pane the buildings are close, and a click between two picks either.
    const pts = await page.evaluate((ids) => {
      const probe = (window as unknown as { __termpolis_world?: Probe }).__termpolis_world
      const host = document.querySelector('[data-testid="world-canvas-host"] canvas')
      return ids.map((id) => {
        const p = probe?.screenPoint(id) ?? null
        return { id, p, free: !!p && document.elementFromPoint(p.x, p.y) === host }
      })
    }, all.map((b) => b.id))
    const NEIGHBOUR_PX = 24
    let target: Target | null = null
    let best = -1
    for (const b of all) {
      const me = pts.find((q) => q.id === b.id)!
      if (!me.p || !me.free) continue
      const pt = me.p
      if (!(pt.x > box.x + 8 && pt.x < box.x + box.width - 8 && pt.y > box.y + 8 && pt.y < box.y + box.height - 8)) continue
      const gap = Math.min(Infinity, ...pts.filter((q) => q.id !== b.id && q.p).map((q) => Math.hypot(q.p!.x - pt.x, q.p!.y - pt.y)))
      if (gap > best) { best = gap; target = { ...b, ...pt } }
    }
    if (best < NEIGHBOUR_PX) target = null
    expect(target, `no building of ${all.length} is on screen with nothing over it and ${NEIGHBOUR_PX} px from the next one`).not.toBeNull()
    await page.mouse.click(target!.x, target!.y)
    await expect(card()).toBeVisible()
    // The card is that building's: its name, and its floors in "What's inside", in order.
    await expect(card().locator('h3').first()).toHaveText(target!.name)
    const inside = card().locator(`h4:text-is("What's inside") + ul > li > b`)
    await expect(inside).toHaveText(target!.floors)
    await expect(card()).toContainText('What it does')
    await expect(card()).toContainText('Runs in:')
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
      .poll(() => page.evaluate(() => (window as unknown as { __tourCaptions: string[] }).__tourCaptions.length), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2)
    const captions = await page.evaluate(() => (window as unknown as { __tourCaptions: string[] }).__tourCaptions)
    expect(new Set(captions).size).toBeGreaterThanOrEqual(2)
  })

  test('5. typing stays quick while a project compiles (p95 keystroke echo < 50 ms)', async () => {
    // Measured at 19 to 31 s on a slow laptop (one long compile covers the keys there). On a fast
    // runner: setup, then at most the 60 s typing deadline (a first compile of 2 to 5 s and up to 24
    // recompiles of about 350 ms fit well inside it), then the tail.
    test.setTimeout(90_000)
    // Stop the tour (it may still be running) by closing its card, then close the pane.
    if (await card().isVisible().catch(() => false)) await page.locator('[data-testid="world-card-close"]').click()
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
    await createTerminal('Typing', project)

    // The renderer's side of the measurement. A capture-phase keydown stamps each typed letter
    // (never the line marker, which has none), and a 1 ms poll of the terminal's cursor line (a row
    // or two, never the whole buffer) stamps each key once its character is on the line after the
    // marker. The marker `~#~` cannot come from the prompt: the temp folder's name is letters and
    // digits. A shell may break a long line with a real newline instead of letting xterm wrap it
    // (bash's readline can), and then the cursor row no longer holds the marker: the poll then reads
    // the terminal's text with its newlines removed, as typing-trace.spec.ts does. Each shell line
    // holds the marker and up to LINE_KEYS keys, fewer when the prompt is long: the line never comes
    // within MARGIN_COLS of the terminal's width, so it never wraps. The spec then clears it and
    // starts a new one (`newLine()`), so the line's redraw stays the same size all the way through.
    const marker = '~#~'
    await page.evaluate((marker) => {
      interface Echo {
        down: number[]; echo: number[]; lineBase: number; lineKeys: string; done: boolean
        compiling: boolean; runs: { start: number; end: number }[]; compileError?: string
      }
      const w = window as unknown as {
        __termpolis_cursor_line?: () => string; __termpolis_terminal_text?: () => string
        __echo: Echo; __echoLine: () => void; __echoText: () => string
      }
      const s: Echo = { down: [], echo: [], lineBase: 0, lineKeys: '', done: false, compiling: false, runs: [] }
      w.__echo = s
      w.__echoLine = () => { s.lineBase = s.down.length; s.lineKeys = '' }
      // The text an echo is looked for in: the cursor line, else the terminal's text with its newlines removed.
      w.__echoText = () => {
        const line = w.__termpolis_cursor_line?.() ?? ''
        return line.includes(marker) ? line : (w.__termpolis_terminal_text?.() ?? '').replace(/\r?\n/g, '')
      }
      window.addEventListener('keydown', (e) => {
        // Only plain letters are samples: Ctrl+U (the Linux/mac line clear) is e.key 'u' too.
        if (!/^[a-z]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return
        s.down.push(performance.now())
        s.echo.push(0)
        s.lineKeys += e.key
      }, true)
      const poll = (): void => {
        if (s.done) return
        if (s.lineKeys) {
          const line = w.__echoText()
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
    type Hooks = { __termpolis_cursor_line?: () => string; __termpolis_terminal_text?: () => string }
    const allEchoed = (): Promise<boolean> =>
      page.evaluate(() => (window as unknown as { __echo: { echo: number[] } }).__echo.echo.every((t) => t > 0))
    const cursorLine = (): Promise<string> => page.evaluate(() => (window as unknown as Hooks).__termpolis_cursor_line?.() ?? '')
    // The marker is looked for where the echoes are (`__echoText`), so a cleared line is cleared there too.
    const markerShown = (): Promise<boolean> =>
      page.evaluate((m) => (window as unknown as { __echoText: () => string }).__echoText().includes(m), marker)
    const markerGone = async (): Promise<boolean> => !(await markerShown())
    // What the terminal shows, for a failure message: the next run says what that platform saw.
    const state = (): Promise<string> =>
      page.evaluate(() => {
        const w = window as unknown as Hooks & { __echo?: { echo: number[]; lineKeys: string } }
        const a = document.activeElement
        return JSON.stringify({
          cursorLine: w.__termpolis_cursor_line?.() ?? null,
          textTail: (w.__termpolis_terminal_text?.() ?? '').slice(-600),
          focused: a ? `${a.tagName.toLowerCase()}.${a.className}` : null,
          unechoed: w.__echo ? w.__echo.echo.filter((t) => !t).length : null,
          lineKeys: w.__echo?.lineKeys ?? null,
        })
      })
    const until = async (what: string, check: () => Promise<boolean>): Promise<void> => {
      try {
        await expect.poll(check, { timeout: 10_000 }).toBe(true)
      } catch {
        throw new Error(`timed out waiting for ${what}: ${await state()}`)
      }
    }
    // Clears the shell's line (nothing typed here is ever run).
    const clearLine = (): Promise<void> => page.keyboard.press(process.platform === 'win32' ? 'Escape' : 'Control+u')
    const newLine = async (): Promise<void> => {
      await until('every key to echo', allEchoed)
      await clearLine()
      await until('the cleared line', markerGone)
      await page.evaluate(() => (window as unknown as { __echoLine: () => void }).__echoLine())
      await page.keyboard.type(marker, { delay: KEY_GAP_MS })
      await until('the marker', markerShown)
    }
    const key = async (): Promise<void> => {
      await page.keyboard.press(letters[typed++ % letters.length])
      await page.waitForTimeout(KEY_GAP_MS)
    }

    // The new terminal has the keyboard (its xterm textarea is focused, as terminal-features.spec.ts
    // does it) and its shell is ready: a prompt is on the cursor line and has stopped changing.
    await page.evaluate(() => {
      const visible = [...document.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea')].filter((t) => t.closest('.xterm')?.getClientRects().length)
      visible[visible.length - 1]?.focus()
    })
    await until('the terminal to have focus', () => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea')))
    let prompt = ''
    await until('a settled prompt', async () => {
      const now = (await cursorLine()).trim()
      const settled = now !== '' && now === prompt
      prompt = now
      if (!settled) await page.waitForTimeout(250)
      return settled
    })

    // How many keys a line takes: up to LINE_KEYS, and never so many that the prompt, the marker and
    // the keys come within MARGIN_COLS of the terminal's width (a long prompt wraps by itself, so
    // only its last row counts).
    const cols = await page.evaluate(
      () => (window as unknown as { __termpolis_terminal_size?: () => { cols: number } | null }).__termpolis_terminal_size?.()?.cols ?? 0,
    )
    const lineKeys = Math.min(LINE_KEYS, cols - ((prompt.length + 1) % cols) - marker.length - MARGIN_COLS)
    expect(lineKeys, `too little room on the shell line: ${JSON.stringify({ cols, prompt })}`).toBeGreaterThanOrEqual(WARMUP_KEYS)

    // Warm-up, before any load: typed and echoed, and not counted.
    await page.keyboard.type(marker, { delay: KEY_GAP_MS })
    await until('the marker', markerShown)
    for (let i = 0; i < WARMUP_KEYS; i++) await key()

    // The load: main builds the bigger project's code graph, then its utility process compiles it.
    // As each compile ends the next starts at once (a forced recompile, world:relayout, the call
    // Re-layout makes), until MIN_SAMPLES keys fell inside a compile or MAX_COMPILES ran. The typing
    // runs at a steady pace until the last one has ended.
    await page.evaluate(({ root, min, max }) => {
      type Res = Promise<{ success: boolean; error?: string }>
      interface Api { worldCompile: (r: string) => Res; worldRelayout: (r: string) => Res }
      const w = window as unknown as { termpolis: Api; __echo: { down: number[]; compiling: boolean; runs: { start: number; end: number }[]; compileError?: string } }
      const s = w.__echo
      const inside = (): number => s.down.filter((d) => s.runs.some((r) => d >= r.start && d < r.end)).length
      const run = (): void => {
        const cur = { start: performance.now(), end: 0 }
        s.runs.push(cur)
        const call = s.runs.length === 1 ? w.termpolis.worldCompile(root) : w.termpolis.worldRelayout(root)
        void call.then(
          (r) => { if (!r.success) s.compileError = r.error },
          (e: unknown) => { s.compileError = String(e) },
        ).finally(() => {
          cur.end = performance.now()
          if (s.compileError === undefined && inside() < min && s.runs.length < max) run()
          else s.compiling = false
        })
      }
      s.compiling = true
      run()
    }, { root: loadProject, min: MIN_SAMPLES, max: MAX_COMPILES })
    await newLine()
    const compiling = (): Promise<boolean> => page.evaluate(() => (window as unknown as { __echo: { compiling: boolean } }).__echo.compiling)
    const deadline = Date.now() + 60_000
    let onLine = 0
    const lineKey = async (): Promise<void> => {
      if (onLine === lineKeys) { await newLine(); onLine = 0 }
      await key()
      onLine++
    }
    while ((await compiling()) && Date.now() < deadline) await lineKey()
    // A few keys after the end, so the last keys pressed during a compile echo under the same
    // pattern; then every echo is awaited and the line cleared.
    for (let i = 0; i < 5; i++) await lineKey()
    await until('every key to echo', allEchoed)
    await clearLine()

    const r = await page.evaluate(() => {
      const s = (window as unknown as { __echo: { down: number[]; echo: number[]; compiling: boolean; runs: { start: number; end: number }[]; compileError?: string; done: boolean } }).__echo
      s.done = true
      return { down: s.down, echo: s.echo, compiling: s.compiling, runs: s.runs, compileError: s.compileError }
    })
    expect(r.compiling, 'the compiles were still running after 60 s of typing').toBe(false)
    expect(r.compileError ?? null).toBeNull()
    // Only keys pressed while a compile ran count: that leaves out the warm-up, the gaps between
    // compiles and the tail.
    const runOf = (d: number): number => r.runs.findIndex((w) => d >= w.start && d < w.end)
    const during = r.down.map((d, i) => ({ d, ms: r.echo[i] - d, run: runOf(d) })).filter((x) => x.run >= 0)
    const lat = during.map((x) => x.ms).sort((a, b) => a - b)
    const n = lat.length
    const p95 = lat[Math.min(n - 1, Math.ceil(n * 0.95) - 1)]
    const p50 = lat[Math.floor(n / 2)]
    const runs = r.runs.map((w, k) => `${(w.end - w.start).toFixed(0)} ms/${during.filter((x) => x.run === k).length} keys`).join(', ')
    const summary = `samples=${n} (of ${r.down.length} keys, ${WARMUP_KEYS} warm-up) over ${r.runs.length} compiles [${runs}], p50=${p50?.toFixed(1)} ms p95=${p95?.toFixed(1)} ms max=${lat[n - 1]?.toFixed(1)} ms`
    console.log(`[typing while compiling] ${summary}`)
    expect(n, `too few keys pressed during the compiles: ${summary}`).toBeGreaterThanOrEqual(MIN_SAMPLES)
    expect(p95, `p95 keystroke echo over budget: ${summary}`).toBeLessThan(P95_BUDGET_MS)
  })

  test('6. the terminal stays visible and takes typing while Lumopolis is open', async () => {
    // Test 5 closed the pane: open it again the way a person does, from the command palette.
    if (await pane().count() === 0) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('ControlOrMeta+k')
      const input = page.getByPlaceholder('Type a command...')
      await expect(input).toBeVisible()
      await input.fill('Open Lumopolis')
      await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
    }
    await expect(pane()).toBeVisible()
    // Click the terminal: the pane is beside it, not over it, so the click lands on the terminal.
    const term = page.locator('.xterm').last()
    await term.click()
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea')), { message: 'the terminal to have focus' }).toBe(true)
    await page.keyboard.type('echo beside')
    await expect.poll(() => page.evaluate(
      () => ((window as unknown as { __termpolis_terminal_text?: () => string }).__termpolis_terminal_text?.() ?? '').includes('echo beside')), { message: 'the typed text on the terminal' }).toBe(true)
    const [a, b] = await Promise.all([pane().boundingBox(), term.boundingBox()])
    expect(a && b).toBeTruthy()
    const overlapX = Math.min(a!.x + a!.width, b!.x + b!.width) - Math.max(a!.x, b!.x)
    expect(overlapX, 'the pane and the terminal overlap').toBeLessThanOrEqual(1)
    await page.keyboard.press('Control+u')
  })

  test('7. over the whole session, the renderer logged no console errors and threw no page errors', async () => {
    expect(consoleErrors).toEqual([])
  })
})

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
 * The fixture projects, the launch (labelling off, software GL) and the Add Terminal dialog come from
 * e2e/helpers/world.ts, which e2e/world-export.spec.ts shares.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { makeRepo, PROJECT_FILES, launchWorldApp, createTerminal as addTerminal, paletteType, removeDirs, expectPaneOpens } from './helpers/world'
import { closeMore, toolbarControl } from './helpers/worldToolbar'

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

  const launched = await launchWorldApp({
    onPage: (p) => {
      p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
      p.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
    },
  })
  app = launched.app
  page = launched.page
  userDataDir = launched.userDataDir
})

test.afterAll(async () => {
  await quitApp(app)
  removeDirs([userDataDir, project, loadProject])
})

/** Adds a terminal whose working folder is `cwd` (the Add Terminal dialog's folder field). */
const createTerminal = (name: string, cwd: string): Promise<void> => addTerminal(page, name, cwd)

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

interface Drawn { layers: { processes: boolean }; processShells: number; conduits: number; highlighted: string[]; tier: string }
interface Cam { pos: number[]; target: number[] }
interface Probe { screenPoint(id: string): { x: number; y: number } | null; drawn(): Drawn; cameraState(): Cam | null }
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
    await paletteType(page, 'Open Lumopolis')
    // The palette's result, by its label and description (the sidebar has an 'Open Lumopolis' button too).
    const result = page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ })
    await expect(result).toBeVisible()
    await result.click()

    await expectPaneOpens(page)
    // No WebGL would show the 2D list instead: the launch switches above are meant to rule that out.
    await expect(page.locator('[data-testid="world-fallback"]')).toHaveCount(0)
    await expect(canvas()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: 30_000 })
    expect((await buildings(project)).length).toBeGreaterThan(1)
  })

  /** Clicks a building a person could click (on screen, nothing over it, clear of its neighbours) and returns it. */
  async function clickABuilding(): Promise<{ id: string; name: string; floors: string[] }> {
    const all = await buildings(project)
    // Let the camera's first framing settle before aiming at it.
    await page.waitForTimeout(1500)
    const box = (await canvas().boundingBox())!
    // From far out (the overview) a district is one slab and its buildings are not drawn: wheel in
    // until they are. This window reports a device pixel ratio a hair under 1 (0.99999998), and
    // OrbitControls (three r160) divides the wheel delta by `devicePixelRatio | 0`: zero, so one notch
    // would fly straight to the nearest distance. Reported as exactly 1, a notch is the intended 5%.
    const tier = (): Promise<string> => page.evaluate(() => (window as unknown as { __termpolis_world: Probe }).__termpolis_world.drawn().tier)
    if ((await tier()) === 'districts') {
      await page.evaluate(() => { if ((window.devicePixelRatio | 0) === 0) Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true }) })
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      for (let i = 0; i < 40 && (await tier()) === 'districts'; i++) {
        await page.mouse.wheel(0, -100)
        await page.waitForTimeout(120)
      }
      expect(await tier(), 'wheeling in from the overview never reached the buildings').not.toBe('districts')
      await page.mouse.move(2, 400)
      await page.waitForTimeout(1500)
    }
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
    return target!
  }

  test('2. clicking a building opens its card', async () => {
    const target = await clickABuilding()
    await expect(card()).toBeVisible()
    // The card is that building's: its name, and its floors in "What's inside", in order.
    await expect(card().locator('h3').first()).toHaveText(target.name)
    const inside = card().locator(`h4:text-is("What's inside") + ul > li > b`)
    await expect(inside).toHaveText(target.floors)
    await expect(card()).toContainText('What it does')
    await expect(card()).toContainText('Runs in:')
  })

  test('3. "What runs where" draws the process shells, and takes them away again', async () => {
    const toggle = await toolbarControl(page, 'world-layer-processes')
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
    await closeMore(page)
  })

  test('4. a tour plays and its caption changes from step to step', async () => {
    const tours = await toolbarControl(page, 'world-tours')
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
    // Stop the tour (it may still be running) by closing its card, then close the pane. The tour may end between
    // the look and the click, taking its card with it.
    if (await card().isVisible().catch(() => false)) await page.locator('[data-testid="world-card-close"]').click({ timeout: 5_000 }).catch(() => undefined)
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
        performance.mark('tf-key')
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
            for (let k = 0; k < n; k++) if (!s.echo[s.lineBase + k]) { s.echo[s.lineBase + k] = now; performance.mark('tf-echo') }
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

    // The window's focus before and after is printed with the result. On CI the app is also brought to the front
    // first, so the runs stay comparable with the ones that tested whether a window behind others had its timers
    // run late: it did not (the app was already frontmost in e6d9c45b and typing was just as slow; the cause was
    // the runner's Spotlight indexing). Never on a developer's machine, where it would take the keyboard from
    // whatever they are typing in, and their keys would land in the measured terminal.
    const focusState = (): Promise<string> => app.evaluate(({ app: eapp, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return `window focused ${w.isFocused()}, visible ${w.isVisible()}, app hidden ${process.platform === 'darwin' ? eapp.isHidden() : false}`
    })
    const focusBefore = `${await focusState()}, page ${await page.evaluate(() => `${document.visibilityState} focus ${document.hasFocus()}`)}`
    if (process.env.CI) {
      await app.evaluate(({ app: eapp, BrowserWindow }) => {
        if (process.platform === 'darwin') eapp.focus({ steal: true })
        const w = BrowserWindow.getAllWindows()[0]
        w.show()
        w.focus()
      })
    }
    await page.evaluate(() => {
      const visible = [...document.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea')].filter((t) => t.closest('.xterm')?.getClientRects().length)
      visible[visible.length - 1]?.focus()
    })
    await until('the terminal to have focus again', () => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea')))
    const focusAfter = `${await focusState()}, page ${await page.evaluate(() => `${document.visibilityState} focus ${document.hasFocus()}`)}`
    console.log(`[typing while compiling, focus] before: ${focusBefore}; after bringing the app to the front: ${focusAfter}`)

    // Warm-up, before any load: typed and echoed, and not counted.
    await page.keyboard.type(marker, { delay: KEY_GAP_MS })
    await until('the marker', markerShown)
    for (let i = 0; i < WARMUP_KEYS; i++) await key()

    // For comparison only (not asserted): main's side while the keys are typed. Keys on macOS and Linux reach
    // the pty through main (Windows types straight to the pty host), so the report shows whether main's event
    // loop stalls during a compile (a 10 ms timer's lateness) or the machine is short of CPU (Electron's own
    // per-process CPU use, sampled every 250 ms). Times are epoch ms, as the renderer's timeOrigin + now().
    // And the page's side: its own 10 ms timer's lateness and its long tasks (50 ms or more of its own script or
    // layout), so a slow last leg shows whether the page's thread was busy with its own work or not run at all.
    await page.evaluate(() => {
      const s = { lag: [] as number[][], long: [] as number[][], frames: [] as { t: number; d: number; render: number; blocking: number; scripts: [string, number][] }[], raf: [] as number[][], recv: [] as number[][], stop: () => {} }
      ;(window as unknown as { __pageDiag: typeof s }).__pageDiag = s
      // DIAG typeflake-trace: each terminal:data chunk with a letter, as the preload hands it to the page.
      const offRecv = (window as unknown as { termpolis: { onTerminalData: (cb: (id: string, d: string) => void) => () => void } }).termpolis.onTerminalData((_id, d) => { if (/[a-z]/.test(d)) { s.recv.push([performance.now(), d.length]); performance.mark('tf-recv') } })
      // The page's frames as requestAnimationFrame runs them: how often the page gets to paint.
      let lastRaf = performance.now()
      let rafId = 0
      const onRaf = (now: number): void => { s.raf.push([now, now - lastRaf]); lastRaf = now; rafId = requestAnimationFrame(onRaf) }
      rafId = requestAnimationFrame(onRaf)
      let last = performance.now()
      const timer = setInterval(() => { const now = performance.now(); s.lag.push([now, now - last - 10]); last = now }, 10)
      let obs: PerformanceObserver | null = null
      try {
        obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) s.long.push([e.startTime, e.duration]) })
        obs.observe({ type: 'longtask', buffered: false })
      } catch { obs = null }
      // Long animation frames (50 ms or more from the frame's first task to its paint) also count the frame's
      // style, layout and paint, which long tasks leave out, and name the scripts that ran in them.
      let frameObs: PerformanceObserver | null = null
      try {
        frameObs = new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as { startTime: number; duration: number; renderStart: number; blockingDuration?: number; scripts?: { invoker?: string; sourceURL?: string; duration: number }[] }[]) {
            s.frames.push({ t: e.startTime, d: e.duration, render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0, blocking: e.blockingDuration ?? -1, scripts: (e.scripts ?? []).map((x) => [`${x.invoker ?? '?'} ${(x.sourceURL ?? '').split('/').pop()}`, x.duration]) })
          }
        })
        frameObs.observe({ type: 'long-animation-frame', buffered: false })
      } catch { frameObs = null }
      s.stop = () => { clearInterval(timer); cancelAnimationFrame(rafId); obs?.disconnect(); frameObs?.disconnect(); offRecv() }
    })
    // It also stamps, in main, each typed letter's arrival (a second terminal:write listener, run after the real
    // one) and each terminal:data message as it leaves for the page, so every key's echo splits into page to main,
    // main to the shell and back (the pty host and the shell), and main to the page's screen.
    await app.evaluate(async ({ app: eapp, ipcMain, BrowserWindow, contentTracing }) => {
      const s = { lag: [] as number[][], cpu: [] as { t: number; p: { k: string; c: number }[] }[], writes: [] as number[], out: [] as [number, string][], sends: [] as [number, string, unknown][], invokes: [] as [number, number, string, unknown][], stop: () => {} }
      ;(globalThis as unknown as { __mainDiag: typeof s }).__mainDiag = s
      // Monotonic epoch ms, as the page's timeOrigin + now(). Date.now() can drift from the page's monotonic clock
      // while the system's time sync adjusts it: on one macOS run it put the page 60 to 80 ms behind main.
      const clock = (): number => performance.timeOrigin + performance.now()
      const onWrite = (_e: unknown, p: { data?: unknown }): void => { if (typeof p?.data === 'string' && /^[a-z]$/.test(p.data)) s.writes.push(clock()) }
      ipcMain.on('terminal:write', onWrite)
      const wc = BrowserWindow.getAllWindows()[0].webContents
      const send = wc.send
      wc.send = function (channel: string, ...args: unknown[]) {
        if (channel === 'terminal:data' && typeof args[1] === 'string') s.out.push([clock(), args[1]])
        else s.sends.push([clock(), channel, channel.startsWith('world:') ? args[0] : null])
        return send.call(this, channel, ...args)
      }
      let last = clock()
      const lagTimer = setInterval(() => { const now = clock(); s.lag.push([now, now - last - 10]); last = now }, 10)
      eapp.getAppMetrics()
      // The whole machine's busy share (all processes, not only Electron's) from the cores' own counters.
      type Cpu = { times: { user: number; nice: number; sys: number; idle: number; irq: number } }
      const os = (process as unknown as { getBuiltinModule?: (m: string) => { cpus: () => Cpu[] } | undefined }).getBuiltinModule?.('os')
      const ticks = (): [number, number] => (os ? os.cpus() : []).reduce<[number, number]>((a, c) => { const t = c.times; return [a[0] + t.idle, a[1] + t.user + t.nice + t.sys + t.idle + t.irq] }, [0, 0])
      let prevTicks = ticks()
      const cpuTimer = setInterval(() => {
        const now = ticks()
        const total = now[1] - prevTicks[1]
        const machine = os && total > 0 ? 100 * (1 - (now[0] - prevTicks[0]) / total) * os.cpus().length : -1
        prevTicks = now
        s.cpu.push({ t: clock(), p: [...eapp.getAppMetrics().map((m) => ({ k: m.name ? `${m.type}:${m.name}` : m.type, c: m.cpu.percentCPUUsage })), { k: 'machine', c: machine }] })
      }, 250)
      // DIAG typeflake-trace: each world:* invoke as main answers it (start, end, and the reply, sized at the end).
      type Handler = (e: unknown, ...a: unknown[]) => unknown
      const ih = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers
      const wrapped: [string, Handler][] = []
      for (const ch of ['world:compile', 'world:relayout', 'world:get']) {
        const h = ih?.get(ch)
        if (!ih || !h) continue
        wrapped.push([ch, h])
        ih.set(ch, async (e: unknown, ...a: unknown[]) => { const t0 = clock(); const res = await h(e, ...a); s.invokes.push([t0, clock(), ch, res]); return res })
      }
      await contentTracing.startRecording({
        recording_mode: 'record-continuously', trace_buffer_size_in_kb: 400_000,
        included_categories: ['toplevel', 'toplevel.flow', 'ipc', 'ipc.flow', 'mojom', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8.execute', 'v8', 'sequence_manager', 'scheduler', 'renderer.scheduler', 'electron', 'cc', 'viz', 'gpu', 'benchmark', 'input', '__metadata'],
      })
      s.stop = () => { clearInterval(lagTimer); clearInterval(cpuTimer); ipcMain.removeListener('terminal:write', onWrite); wc.send = send; for (const [ch, h] of wrapped) ih?.set(ch, h) }
    })

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
    const tracePath = test.info().outputPath('typeflake-trace.json')
    const diag = await app.evaluate(async ({ contentTracing }, tp) => {
      const s = (globalThis as unknown as { __mainDiag: { lag: number[][]; cpu: { t: number; p: { k: string; c: number }[] }[]; writes: number[]; out: [number, string][]; sends: [number, string, unknown][]; invokes: [number, number, string, unknown][]; stop: () => void } }).__mainDiag
      s.stop()
      let traced = ''
      try { traced = await contentTracing.stopRecording(tp) } catch (e) { traced = `failed: ${String(e)}` }
      const size = (x: unknown): number => { try { return x == null ? 0 : JSON.stringify(x).length } catch { return -1 } }
      return { lag: s.lag, cpu: s.cpu, writes: s.writes, out: s.out, traced, sends: s.sends.map(([t, ch, a]) => [t, ch, size(a)] as [number, string, number]), invokes: s.invokes.map(([t0, t1, ch, r]) => [t0, t1, ch, size(r)] as [number, number, string, number]) }
    }, tracePath)
    const pageDiag = await page.evaluate(() => {
      const s = (window as unknown as { __pageDiag: { lag: number[][]; long: number[][]; frames: { t: number; d: number; render: number; blocking: number; scripts: [string, number][] }[]; raf: number[][]; recv: number[][]; stop: () => void } }).__pageDiag
      s.stop()
      return { lag: s.lag, long: s.long, frames: s.frames, raf: s.raf, recv: s.recv }
    })
    const pageIn = (t: number): boolean => r.runs.some((w) => t >= w.start && t < w.end)
    const longOf = (during: boolean): string => {
      const xs = pageDiag.long.filter((x) => pageIn(x[0]) === during)
      return xs.length ? `${xs.length} long tasks, ${xs.reduce((a, x) => a + x[1], 0).toFixed(0)} ms in all, longest ${Math.max(...xs.map((x) => x[1])).toFixed(0)} ms` : 'no long tasks'
    }
    const framesOf = (during: boolean): string => {
      const xs = pageDiag.frames.filter((x) => pageIn(x.t) === during)
      if (!xs.length) return 'no long frames'
      const by: Record<string, number> = {}
      for (const x of xs) for (const [k, d] of x.scripts) by[k] = (by[k] ?? 0) + d
      const top = Object.entries(by).sort((p, q) => q[1] - p[1]).slice(0, 4).map(([k, d]) => `${k} ${d.toFixed(0)} ms`).join(', ')
      return `${xs.length} long frames, ${xs.reduce((a, x) => a + x.d, 0).toFixed(0)} ms in all (rendering ${xs.reduce((a, x) => a + x.render, 0).toFixed(0)} ms, blocking ${xs.reduce((a, x) => a + x.blocking, 0).toFixed(0)} ms), longest ${Math.max(...xs.map((x) => x.d)).toFixed(0)} ms; scripts ${top || 'none'}`
    }
    // The page's clock as epoch ms: its timeOrigin + now(), the same monotonic clock main stamps with.
    const { origin, cores } = await page.evaluate(() => ({ origin: performance.timeOrigin, cores: navigator.hardwareConcurrency }))
    const inRun = (t: number): boolean => r.runs.some((w) => t >= origin + w.start && t < origin + w.end)
    const lagOf = (xs: number[]): string => {
      if (!xs.length) return 'none'
      const v = xs.slice().sort((a, b) => a - b)
      return `p50 ${v[Math.floor(v.length / 2)].toFixed(0)} p95 ${v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)].toFixed(0)} max ${v[v.length - 1].toFixed(0)} ms`
    }
    const cpuOf = (during: boolean): string => {
      const rows = diag.cpu.filter((x) => inRun(x.t - 125) === during)
      const sum: Record<string, number> = {}
      let machine = 0
      for (const x of rows) for (const q of x.p) { if (q.k === 'machine') machine += q.c; else sum[q.k] = (sum[q.k] ?? 0) + q.c }
      const total = Object.values(sum).reduce((a, b) => a + b, 0) / Math.max(1, rows.length)
      const top = Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => `${k} ${(c / Math.max(1, rows.length)).toFixed(0)}%`).join(', ')
      return `${rows.length} samples, total ${total.toFixed(0)}% (${top}); whole machine ${(machine / Math.max(1, rows.length)).toFixed(0)}% of ${cores * 100}%`
    }
    // Each key pressed after the hooks went in, in order, to the next letter main received, then to the first
    // terminal:data after that write that holds a letter, then to the page seeing its echo.
    const stages: { during: boolean; t1: number; t2: number; t3: number; i: number; run: number; S: number; R: number; E: number }[] = []
    {
      let wi = 0
      let oi = 0
      const first = diag.writes.length ? diag.writes[0] - 50 : Infinity
      r.down.forEach((d, i) => {
        const D = origin + d
        if (D < first || !r.echo[i]) return
        while (wi < diag.writes.length && diag.writes[wi] < D - 2) wi++
        if (wi >= diag.writes.length) return
        const W = diag.writes[wi++]
        while (oi < diag.out.length && (diag.out[oi][0] < W || !/[a-z]/.test(diag.out[oi][1]))) oi++
        if (oi >= diag.out.length) return
        const S = diag.out[oi][0]
        const rv = pageDiag.recv.find((x) => origin + x[0] >= S - 1)
        stages.push({ during: r.runs.some((w) => d >= w.start && d < w.end), t1: W - D, t2: S - W, t3: origin + r.echo[i] - S, i, run: r.runs.findIndex((w) => d >= w.start && d < w.end), S, R: rv ? origin + rv[0] : NaN, E: origin + r.echo[i] })
      })
    }
    const stageOf = (during: boolean): string => {
      const xs = stages.filter((x) => x.during === during)
      const q = (k: 't1' | 't2' | 't3'): string => { const v = xs.map((x) => x[k]).sort((a, b) => a - b); return v.length ? `p50 ${v[Math.floor(v.length / 2)].toFixed(0)} p95 ${v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)].toFixed(0)}` : '-' }
      return `${xs.length} keys: page to main ${q('t1')}, main to shell and back ${q('t2')}, main to the page's screen ${q('t3')} ms`
    }
    console.log(`[typing while compiling, stages] during compiles ${stageOf(true)}; with none running ${stageOf(false)}`)
    {
      // DIAG typeflake-trace: the last leg split at the page's terminal:data listener, for every key in a compile,
      // and what else main sent in the window, plus each world:* invoke with its reply's size.
      const rel = (t: number): string => (t - origin - r.runs[0].start).toFixed(0)
      console.log(`[typeflake diag] traced ${diag.traced}; origin ${origin}; runs ${r.runs.map((w) => `${(w.start - r.runs[0].start).toFixed(0)}-${(w.end - r.runs[0].start).toFixed(0)}`).join(' ')}`)
      console.log(`[typeflake diag] invokes ${diag.invokes.map(([t0, t1, ch, n]) => `${ch} ${rel(t0)}-${rel(t1)} ${n}B`).join('; ')}`)
      const chans: Record<string, [number, number]> = {}
      for (const [, ch, n] of diag.sends) { const c = chans[ch] ?? [0, 0]; c[0]++; c[1] += n; chans[ch] = c }
      console.log(`[typeflake diag] other sends ${Object.entries(chans).map(([ch, [k, n]]) => `${ch} x${k} ${n}B`).join('; ')}`)
      for (const x of stages.filter((y) => y.during)) {
        const others = diag.sends.filter(([t]) => t >= x.S - 100 && t <= x.E).map(([t, ch, n]) => `${ch}@${(t - x.S).toFixed(0)}${n ? `/${n}B` : ''}`).join(',')
        console.log(`[typeflake key] i=${x.i} run=${x.run} at=${rel(x.S)} S=${x.S.toFixed(1)} t3=${x.t3.toFixed(1)} send-to-recv=${(x.R - x.S).toFixed(1)} recv-to-seen=${(x.E - x.R).toFixed(1)}${others ? ` others=${others}` : ''}`)
      }
    }
    const compileMs = r.runs.reduce((a, w) => a + (w.end - w.start), 0)
    const rafOf = (during: boolean): string => {
      const xs = pageDiag.raf.filter((x) => pageIn(x[0]) === during).map((x) => x[1])
      if (!xs.length) return 'no frames'
      const span = pageDiag.raf.filter((x) => pageIn(x[0]) === during).reduce((a, x) => a + x[1], 0)
      return `${xs.length} frames (${(1000 * xs.length / Math.max(1, span)).toFixed(0)} a second), gap ${lagOf(xs)}`
    }
    console.log(`[typing while compiling, frames] page frames during compiles ${rafOf(true)}; with none running ${rafOf(false)}`)
    console.log(`[typing while compiling, page] page timer lateness during compiles ${lagOf(pageDiag.lag.filter((x) => pageIn(x[0])).map((x) => x[1]))}, with none running ${lagOf(pageDiag.lag.filter((x) => !pageIn(x[0])).map((x) => x[1]))}; during ${compileMs.toFixed(0)} ms of compiles ${longOf(true)}; with none running ${longOf(false)}; during compiles ${framesOf(true)}; with none running ${framesOf(false)}`)
    console.log(`[typing while compiling, main] ${cores} cores; main timer lateness during compiles ${lagOf(diag.lag.filter((x) => inRun(x[0])).map((x) => x[1]))}, with none running ${lagOf(diag.lag.filter((x) => !inRun(x[0])).map((x) => x[1]))}; Electron CPU during compiles ${cpuOf(true)}; with none running ${cpuOf(false)}`)
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
    // For comparison only (not asserted): the keys pressed with no compile running (the warm-up, the
    // gaps between compiles and the tail), so a slow machine's own echo shows apart from the compiles' cost.
    const idle = r.down.map((d, i) => ({ ms: r.echo[i] - d, run: runOf(d) })).filter((x) => x.run < 0).map((x) => x.ms).sort((a, b) => a - b)
    const idleStats = idle.length ? `n=${idle.length} p50=${idle[Math.floor(idle.length / 2)].toFixed(1)} ms max=${idle[idle.length - 1].toFixed(1)} ms` : 'none'
    // Also for comparison only: the keys' worst echo by the quarter of its compile they were pressed in, so a
    // slow start (main reading the project) shows apart from the compile itself (in its own process) or its end
    // (main saving the world and sending it on).
    const quarters = [0, 1, 2, 3].map((q) => {
      const ms = during.filter((x) => {
        const w = r.runs[x.run]
        return Math.min(3, Math.floor((4 * (x.d - w.start)) / Math.max(1, w.end - w.start))) === q
      }).map((x) => x.ms)
      return ms.length ? `${ms.length} keys max ${Math.max(...ms).toFixed(1)} ms` : '0 keys'
    }).join(' / ')
    // And the first compile (main also builds the project's code graph then) apart from the forced recompiles.
    const worst = (xs: typeof during): string => xs.length ? `${xs.length} keys max ${Math.max(...xs.map((x) => x.ms)).toFixed(1)} ms` : '0 keys'
    const firstVsRest = `first compile ${worst(during.filter((x) => x.run === 0))}, recompiles ${worst(during.filter((x) => x.run > 0))}`
    const summary = `samples=${n} (of ${r.down.length} keys, ${WARMUP_KEYS} warm-up) over ${r.runs.length} compiles [${runs}], p50=${p50?.toFixed(1)} ms p95=${p95?.toFixed(1)} ms max=${lat[n - 1]?.toFixed(1)} ms; by quarter of the compile: ${quarters}; ${firstVsRest}; no compile running: ${idleStats}`
    console.log(`[typing while compiling] ${summary}`)
    expect(n, `too few keys pressed during the compiles: ${summary}`).toBeGreaterThanOrEqual(MIN_SAMPLES)
    expect(p95, `p95 keystroke echo over budget: ${summary}`).toBeLessThan(P95_BUDGET_MS)
  })

  test('6. the terminal stays visible and takes typing while Lumopolis is open', async () => {
    // Test 5 closed the pane: open it again the way a person does, from the command palette.
    if (await pane().count() === 0) {
      await paletteType(page, 'Open Lumopolis')
      await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
    }
    await expect(pane()).toBeVisible()
    // Click the terminal: the pane is beside it, not over it, so the click lands on the terminal.
    const term = page.locator('.xterm').last()
    await term.click()
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea')), { message: 'the terminal to have focus' }).toBe(true)
    await page.keyboard.type('echo beside')
    // Whitespace removed: beside the pane the terminal is narrow, and a long prompt (Linux CI's
    // runner@ip-...:/tmp/...$) soft-wraps the typed line onto the next row, at any column.
    await expect.poll(() => page.evaluate(
      () => ((window as unknown as { __termpolis_terminal_text?: () => string }).__termpolis_terminal_text?.() ?? '').replace(/\s+/g, '').includes('echobeside')), { message: 'the typed text on the terminal' }).toBe(true)
    const [a, b] = await Promise.all([pane().boundingBox(), term.boundingBox()])
    expect(a && b).toBeTruthy()
    const overlapX = Math.min(a!.x + a!.width, b!.x + b!.width) - Math.max(a!.x, b!.x)
    expect(overlapX, 'the pane and the terminal overlap').toBeLessThanOrEqual(1)
    await page.keyboard.press('Control+u')
  })

  test('7. clicking a technology chip opens its glossary card and lights up every use', async () => {
    if (!(await card().isVisible())) await clickABuilding()
    // The e2e project is compiled without a model's labels, so a building has no technology chips;
    // a connection to a spawned agent or a service does (Spawn, HTTP client). Follow the card's own
    // links until a card carries a chip.
    for (let hop = 0; hop < 12 && (await card().locator('[data-tech]').count()) === 0; hop++) {
      const links = card().locator('.lnk')
      const n = await links.count()
      if (n === 0) break
      await links.nth(hop % n).click()
      await page.waitForTimeout(150)
    }
    await expect(card()).toBeVisible()
    const chip = card().locator('[data-tech]').first()
    const term = (await chip.getAttribute('data-tech'))!
    // The chip is a button the keyboard reaches and Enter presses (A11Y Y3); so is every link in the card.
    await expect(card().getByRole('button', { name: term, exact: true }).first()).toBeVisible()
    expect(await card().locator('a:not([href]), span[data-tech]').count()).toBe(0)
    await chip.focus()
    await expect(chip).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => ((await card().locator('h3').first().textContent()) ?? '').toLowerCase()).toContain(term.toLowerCase())
    await expect.poll(async () => (await drawn())?.highlighted.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test('8. a saved view comes back after moving away, and the 2D map switch draws an svg map that a tour steps through', async () => {
    const cam = (): Promise<Cam | null> =>
      page.evaluate(() => (window as unknown as { __termpolis_world?: Probe }).__termpolis_world?.cameraState() ?? null)
    await page.getByTestId('world-bookmarks').click()
    await page.getByTestId('world-bookmark-name').fill('Home view')
    await page.getByTestId('world-bookmark-save').click()
    // The pose the bookmark holds (the camera may drift a little between a read and the click).
    const saved = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) as string
        if (!k.startsWith('termpolis.world.bookmarks.')) continue
        const list = JSON.parse(localStorage.getItem(k) as string) as Array<{ name: string; camera: { pos: number[]; target: number[] } }>
        const mine = list.find((b) => b.name === 'Home view')
        if (mine) return mine.camera
      }
      return null
    })
    expect(saved).not.toBeNull()
    await page.getByTestId('world-bookmarks').click() // close the menu
    // Test 7 leaves its glossary card open; in a narrow pane a card takes most of the height, so it is closed first
    // and the click lands on a building rather than under the card.
    if (await card().isVisible().catch(() => false)) await page.locator('[data-testid="world-card-close"]').click()
    await expect(card()).toHaveCount(0)
    await clickABuilding() // the camera moves to frame it
    await expect.poll(async () => {
      const c = await cam()
      return c ? Math.max(...c.pos.map((v, i) => Math.abs(v - saved!.pos[i]))) : 0
    }, { timeout: 8000 }).toBeGreaterThan(0.5)
    await page.getByTestId('world-bookmarks').click()
    await page.getByTestId('world-bookmark-go').filter({ hasText: 'Home view' }).click()
    await expect.poll(async () => {
      const c = await cam()
      if (!c) return 99
      return Math.max(...c.pos.map((v, i) => Math.abs(v - saved!.pos[i])), ...c.target.map((v, i) => Math.abs(v - saved!.target[i])))
    }, { timeout: 8000 }).toBeLessThan(0.5)
    // The 2D map: an svg with a rect per building, and a click on one opens its card.
    await (await toolbarControl(page, 'world-map2d')).click()
    await closeMore(page)
    const map = page.locator('svg[role=img]')
    await expect(map).toBeVisible()
    const rects = map.locator('rect[data-kind="building"]')
    expect(await rects.count()).toBeGreaterThan(0)
    await rects.first().click()
    await expect(card()).toBeVisible()
    // A tour steps through the 2D map (A11Y Y2): one stop at a time with Back and Next, its parts lit on the map, and
    // each stop said once by the pane's status region (T5).
    const tours = await toolbarControl(page, 'world-tours')
    const tourIds = await tours.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean))
    await tours.selectOption(tourIds[0])
    await closeMore(page)
    const nav = card().getByRole('navigation', { name: 'Tour' })
    await expect(nav).toBeVisible()
    const said = page.getByTestId('world-tour-said')
    await expect(said).toHaveText(/^Stop 1 of \d+: \S/)
    await expect(nav).toContainText(/^Stop 1 of \d+/)
    await expect(card().getByRole('region', { name: 'Details' })).toHaveAttribute('aria-live', 'off')
    await expect(page.locator('[data-testid="world-fallback"] [data-lit]').first()).toBeAttached()
    const stops = Number((/of (\d+)/.exec((await said.textContent()) as string) as RegExpExecArray)[1])
    await expect(nav.getByRole('button', { name: 'Back' })).toHaveAttribute('aria-disabled', 'true')
    if (stops > 1) {
      await nav.getByRole('button', { name: 'Next' }).click()
      await expect(said).toHaveText(new RegExp(`^Stop 2 of ${stops}: \\S`))
      await expect(nav.getByRole('button', { name: 'Next' })).toBeFocused() // the focus stays on the button pressed
    }
    await nav.getByRole('button', { name: 'End tour' }).click()
    await expect(card()).toHaveCount(0)
    await expect(said).toHaveText('')
    await expect(page.locator('[data-testid="world-fallback"] [data-lit]')).toHaveCount(0)
    await (await toolbarControl(page, 'world-map2d')).click() // off again
    await closeMore(page)
    await expect(map).toHaveCount(0)
  })

  test('9. over the whole session, the renderer logged no console errors and threw no page errors', async () => {
    expect(consoleErrors).toEqual([])
  })
})

/**
 * Lumopolis in the real app (Plan 1, Task 14): what only the real Electron app can prove. The unit
 * suites prove the compiler, the engine and the pane against fakes; e2e/world-engine.spec.ts proves the
 * engine bundle in a bare window. This spec drives the whole path on a real project folder:
 *
 *   1. The command palette's "Open Lumopolis" opens the pane on the active terminal's project, which
 *      main compiles (code graph first, then the world in its utility process) and the pane draws on
 *      a WebGL canvas.
 *   2. Clicking a building on the canvas opens that building's card.
 *   3. "What runs where" (the Processes layer) toggles.
 *   4. A tour plays, and its caption changes from step to step.
 *   5. The renderer logged no console error and threw no page error through all of it.
 *   6. Typing in a terminal while a bigger project compiles: the p95 keystroke-to-echo time stays
 *      under 50 ms. Measured in the renderer, from the key's keydown to the moment xterm's buffer
 *      holds the echoed character, with the first keys dropped as warm-up.
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
const WARMUP_KEYS = 8
const MEASURED_KEYS = 60

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

/** A bigger project for the typing measurement: enough files that the compile is still running. */
function loadFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const area of ['api', 'core', 'jobs', 'ui', 'data', 'auth', 'mail', 'billing']) {
    for (let i = 0; i < 80; i++) {
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
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_SMOKE_SKIP_PICKERS: '1' },
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

/** The names of the world's buildings, as main stored them for the project. */
async function buildingNames(root: string): Promise<string[]> {
  return page.evaluate(async (r) => {
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string }>; worldGet: (c: string) => Promise<{ success: boolean; data?: { buildings: { name: string }[] } | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    return res.success && res.data ? res.data.buildings.map((b) => b.name) : []
  }, root)
}

test.describe.serial('Lumopolis in the real app', () => {
  test.setTimeout(180_000)

  test('1. the command palette opens Lumopolis and the compiled world is drawn on a canvas', async () => {
    await createTerminal('Notes', project)
    // A focused terminal takes Ctrl+K as a key for the shell: the palette shortcut is the app's
    // only when the focus is outside it, as after clicking away.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Control+k')
    const input = page.locator('input[placeholder="Type a command..."]')
    await expect(input).toBeVisible()
    await input.fill('Open Lumopolis')
    const result = page.locator('.fixed.z-50 .overflow-y-auto button').filter({ hasText: 'Open Lumopolis' }).first()
    await expect(result).toBeVisible()
    await result.click()

    await expect(pane()).toBeVisible()
    // No WebGL would show the 2D list instead: the launch switches above are meant to rule that out.
    await expect(page.locator('[data-testid="world-fallback"]')).toHaveCount(0)
    await expect(canvas()).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('[data-testid="world-canvas-host"]')).not.toHaveClass(/invisible/, { timeout: 90_000 })
    expect((await buildingNames(project)).length).toBeGreaterThan(1)
  })

  test('2. clicking a building opens its card', async () => {
    const names = await buildingNames(project)
    // Let the camera's first framing settle before aiming at it.
    await page.waitForTimeout(1500)
    const box = (await canvas().boundingBox())!
    // There is no hook into the 3D scene from the app, so the spec looks for a building the way a
    // person would: clicking across the map until a building's card opens. The right-hand strip is
    // left out, because the card sits there.
    let opened = ''
    outer: for (let row = 1; row < 12; row++) {
      for (let col = 1; col < 16; col++) {
        const x = box.x + ((box.width - 360) * col) / 16
        const y = box.y + (box.height * row) / 12
        await page.mouse.click(x, y)
        await page.waitForTimeout(120)
        if (!(await card().isVisible().catch(() => false))) continue
        const title = ((await card().locator('h3').first().textContent().catch(() => '')) ?? '').trim()
        if (names.includes(title)) {
          opened = title
          break outer
        }
      }
    }
    expect(opened, 'no click on the map opened a building card').not.toBe('')
    await expect(card().locator('h3').first()).toHaveText(opened)
    await expect(card()).toContainText('What it does')
    await expect(card()).toContainText('Process')
  })

  test('3. "What runs where" toggles the processes layer', async () => {
    const toggle = page.locator('[data-testid="world-layer-processes"]')
    await expect(toggle).toBeVisible()
    const before = await toggle.getAttribute('aria-pressed')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', before ?? 'false')
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

  test('5. the renderer logged no console errors', async () => {
    expect(consoleErrors).toEqual([])
  })

  test('6. typing stays quick while a project compiles (p95 keystroke echo < 50 ms)', async () => {
    test.setTimeout(240_000)
    // Stop the tour (it may still be running) by closing its card, then close the pane.
    if (await card().isVisible().catch(() => false)) await page.locator('[data-testid="world-card-close"]').click()
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
    await createTerminal('Typing', project)

    // The renderer's side of the measurement: a capture-phase keydown stamp per printable key, and a
    // fast poll of xterm's buffer that stamps each key when its character shows up after the marker.
    const marker = 'ZQ'
    const keys = Array.from({ length: WARMUP_KEYS + MEASURED_KEYS }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[i % 26]).join('')
    await page.evaluate(({ marker, keys }) => {
      const w = window as unknown as {
        __termpolis_terminal_text?: () => string
        __echo: { down: number[]; echo: number[]; done: boolean; compiling: boolean; compileEnd: number }
      }
      const s = { down: [] as number[], echo: [] as number[], done: false, compiling: false, compileEnd: 0 }
      w.__echo = s
      window.addEventListener('keydown', (e) => {
        if (e.key.length === 1 && e.key !== marker[0] && e.key !== marker[1]) s.down.push(performance.now())
      }, true)
      const poll = (): void => {
        if (s.done) return
        const text = (w.__termpolis_terminal_text?.() ?? '').replace(/\r?\n/g, '')
        const at = text.lastIndexOf(marker)
        if (at >= 0) {
          let n = 0
          while (n < keys.length && text[at + marker.length + n] === keys[n]) n++
          const now = performance.now()
          while (s.echo.length < Math.min(n, s.down.length)) s.echo.push(now)
        }
        setTimeout(poll, 1)
      }
      poll()
    }, { marker, keys })
    await page.keyboard.type(marker, { delay: 50 })
    await expect.poll(() => page.evaluate(() => {
      const t = (window as unknown as { __termpolis_terminal_text?: () => string }).__termpolis_terminal_text?.() ?? ''
      return t.includes('ZQ')
    }), { timeout: 20_000 }).toBe(true)

    // The load: main builds the bigger project's code graph, then its utility process compiles it.
    await page.evaluate((root) => {
      const w = window as unknown as { termpolis: { worldCompile: (r: string) => Promise<{ success: boolean; error?: string }> }; __echo: { compiling: boolean; compileEnd: number; compileError?: string } }
      w.__echo.compiling = true
      void w.termpolis.worldCompile(root).then(
        (r) => { if (!r.success) w.__echo.compileError = r.error },
        (e: unknown) => { w.__echo.compileError = String(e) },
      ).finally(() => { w.__echo.compiling = false; w.__echo.compileEnd = performance.now() })
    }, loadProject)

    // A person typing at a steady pace, one key every 60 ms.
    for (const k of keys) await page.keyboard.press(k, { delay: 0 }).then(() => page.waitForTimeout(60))
    await expect.poll(() => page.evaluate(() => (window as unknown as { __echo: { echo: number[] } }).__echo.echo.length), { timeout: 20_000 }).toBe(keys.length)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __echo: { compiling: boolean } }).__echo.compiling), { timeout: 120_000 }).toBe(false)

    const r = await page.evaluate(() => {
      const s = (window as unknown as { __echo: { down: number[]; echo: number[]; compileEnd: number; compileError?: string; done: boolean } }).__echo
      s.done = true
      return { down: s.down, echo: s.echo, compileEnd: s.compileEnd, compileError: s.compileError }
    })
    expect(r.compileError ?? null).toBeNull()
    // Warm-up keys dropped; only keys pressed while the compile was still running count.
    const lat = r.down
      .map((d, i) => ({ d, ms: r.echo[i] - d }))
      .slice(WARMUP_KEYS)
      .filter((x) => x.d < r.compileEnd)
      .map((x) => x.ms)
      .sort((a, b) => a - b)
    const p95 = lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)]
    const p50 = lat[Math.floor(lat.length / 2)]
    console.log(`[typing while compiling] keys=${lat.length} p50=${p50?.toFixed(1)}ms p95=${p95?.toFixed(1)}ms max=${lat[lat.length - 1]?.toFixed(1)}ms`)
    expect(lat.length, 'the compile ended before enough keys were measured').toBeGreaterThanOrEqual(20)
    expect(p95).toBeLessThan(P95_BUDGET_MS)

    // Leave the shell's line empty: nothing typed here is ever run.
    await page.keyboard.press('Escape')
  })
})

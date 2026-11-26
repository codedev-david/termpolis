/**
 * What the Lumopolis specs in the real app share: a temp git repository to map, the small Electron-shaped
 * project they map, the app launched on a fresh profile with labelling off and software GL on, and the Add
 * Terminal dialog. e2e/world-view.spec.ts and e2e/world-export.spec.ts both use them; world-visual and world-perf
 * share the generated big world (bigFiles).
 *
 * The fixture projects are temp git repositories (the code graph lists a project's files with `git ls-files`).
 * Labelling is switched off in the temp profile (world-settings.json), so the world is named from the code alone
 * and no model is called. The launch adds Chromium's software GL switches, as the world-engine harness does, so a
 * runner with no GPU still gets WebGL.
 */
import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

/**
 * Waits for the Lumopolis pane after the click that opens it. Something shows at once: the pane, or its frame
 * saying "Opening Lumopolis…" while the pane's code (the engine and Three.js) loads on its first use. On a cold
 * macOS runner that load took about 7 s, twice, with the frame and its words on screen the whole time and the app
 * answering, so the pane itself gets 60 s.
 */
export async function expectPaneOpens(page: Page): Promise<void> {
  const pane = page.locator('[data-testid="world-view"]')
  await expect(pane.or(page.locator('[data-testid="world-view-opening"]'))).toBeVisible()
  await expect(pane).toBeVisible({ timeout: 60_000 })
}

/** Writes `files` under a new temp folder and makes it a git repository with every file staged. */
export function makeRepo(label: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-world-${label}-`))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return dir
}

/** The generated world of e2e/world-visual.spec.ts and e2e/world-perf.spec.ts: `perArea` files in each of 12 folders (14: 168 files): each file imports two in its folder, the last also the first file of the next folder. */
export const BIG_AREAS = ['api', 'core', 'jobs', 'ui', 'data', 'auth', 'mail', 'billing', 'search', 'audit', 'files', 'admin']
export function bigFiles(perArea: number): Record<string, string> {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'big', version: '1.0.0' }) }
  BIG_AREAS.forEach((area, a) => {
    const next = BIG_AREAS[(a + 1) % BIG_AREAS.length]
    for (let i = 0; i < perArea; i++) {
      const imports = [1, 2].map((k) => (i - k >= 0 ? `import { f${i - k} } from './m${i - k}'\n` : '')).join('')
      const cross = i === perArea - 1 ? `import { f0 as n0 } from '../${next}/m0'\n` : ''
      const call = i === perArea - 1 ? ' + n0(x)' : ''
      files[`src/${area}/m${i}.ts`] = `${imports}${cross}export function f${i}(x: number): number {\n  return x + ${i}${call}\n}\n`
    }
  })
  return files
}

/** A small Electron-shaped project: main, a forked host, a preload bridge and a renderer that uses it. */
export const PROJECT_FILES: Record<string, string> = {
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

export interface WorldAppOptions {
  /** Added to the app's environment (NODE_ENV=test and the world probe are always set). */
  env?: Record<string, string>
  /** Records a video of every window into this folder. */
  videoDir?: string
  /** Called with the first window before it loads, so a spec can listen from the start. */
  onPage?: (page: Page) => void
  /** Launches with the GPU and its software fallback off, so the page has no WebGL and the pane shows its 2D
   *  list, as on a machine without WebGL. */
  noWebGL?: boolean
  /** Added to the profile's world settings (labelling is always off), e.g. a Quality the map is held at. */
  worldSettings?: Record<string, unknown>
}

export interface WorldApp {
  app: ElectronApplication
  page: Page
  /** The temp profile the app runs on; the spec removes it after quitting. */
  userDataDir: string
}

/** Launches the app on a fresh profile (no terminals, labelling off), with the onboarding tour skipped. */
export async function launchWorldApp(opts: WorldAppOptions = {}): Promise<WorldApp> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-ud-'))
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs' }),
  )
  // Names from the code alone: no model is asked to describe the parts.
  fs.writeFileSync(path.join(userDataDir, 'world-settings.json'), JSON.stringify({ worldLabelling: false, ...opts.worldSettings }))

  const app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      // Software GL (SwiftShader), so a runner with no GPU still gets a WebGL context; or, for noWebGL, no GPU
      // and no software fallback, as on a machine without WebGL.
      ...(opts.noWebGL
        ? ['--disable-gpu', '--disable-software-rasterizer']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_SMOKE_SKIP_PICKERS: '1', TERMPOLIS_TEST_WORLD_PROBE: '1', ...opts.env },
    ...(opts.videoDir ? { recordVideo: { dir: opts.videoDir, size: { width: 1280, height: 800 } } } : {}),
  })
  try {
    const page = await app.firstWindow()
    opts.onPage?.(page)
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
    return { app, page, userDataDir }
  } catch (error) {
    await app.close().catch(() => {})
    throw error
  }
}

/** Adds a terminal whose working folder is `cwd` (the Add Terminal dialog's folder field). */
export async function createTerminal(page: Page, name: string, cwd: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  const dialog = page.locator('h2:has-text("New Terminal")').locator('..')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').first().fill(name)
  await dialog.locator('input[placeholder="Home directory"]').fill(cwd)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

/** Opens the command palette (with the focus outside any terminal, which would take Ctrl+K itself) and types `text`. */
export async function paletteType(page: Page, text: string): Promise<void> {
  // A focused terminal takes Ctrl+K as a key for the shell: the palette shortcut is the app's
  // only when the focus is outside it, as after clicking away.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByPlaceholder('Type a command...')
  await expect(input).toBeVisible()
  await input.fill(text)
}

/** Removes temp folders, ignoring any that are already gone or still held. */
export function removeDirs(dirs: Array<string | undefined>): void {
  for (const d of dirs) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  }
}

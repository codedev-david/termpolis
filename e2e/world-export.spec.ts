/**
 * Lumopolis export in the real app (export plan, Task 13): what only the real Electron app can prove. The unit
 * suites prove the builder, the dialog and the IPC against fakes; e2e/export-page proves an exported file in five
 * browsers. This spec drives the whole path on a real project folder:
 *
 *   1. On an unlabelled world, the command palette's "export lumopolis world" opens the export dialog, which shows
 *      the low-coverage note with the smart Ask switch off (the bundled model is there, so the note, not the
 *      "no model" line, is what turns it off).
 *   2. Export ▸ Interactive world ▸ Export… writes the file (the save dialog answered through
 *      TERMPOLIS_TEST_WORLD_SAVE_FILE), and the file opened in a new window of the app, with every request but its
 *      own file refused, gets ready and answers a keyword Ask.
 *   3. Export ▸ Documentation ▸ Save… writes a page titled "How <project> works" with the cards' "What it does"
 *      heading and the sentence a connection's card says from the code.
 *
 * PROOF=1 records a video of every window under test-results/world-export-proof/ (kept local, never committed): the
 * export, the documentation, both files opened offline and three questions asked of the exported world.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { pathToFileURL } from 'url'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { makeRepo, PROJECT_FILES, launchWorldApp, createTerminal, paletteType, removeDirs, expectPaneOpens } from './helpers/world'
import { ask, askReady } from './export-page/helpers'
import { closeMore, toolbarControl } from './helpers/worldToolbar'
import { CARD_HEADINGS } from '../src/shared/world/cardFacts'
import { escapeHtml } from '../src/shared/world/html'
import type { WorldDoc } from '../src/shared/world/types'

const PROOF = process.env.PROOF === '1'

/**
 * The bundled embedding model's files (scripts/download-embedding-model.sh). Without them the export dialog shows
 * the "no model" line in place of the low-coverage note, so test 1 has nothing to prove: it skips locally and fails
 * in CI, where the model job must have restored them.
 */
const MODEL_DIR = path.resolve('resources', 'models', 'bge-small-en-v1.5')
const MODEL_FILES = ['tokenizer.json', path.join('onnx', 'model_quantized.onnx')]
const PROOF_DIR = path.resolve('test-results', 'world-export-proof')

let app: ElectronApplication
let page: Page
let userDataDir: string
let project: string
/** Where the exported files go, and the file whose text answers the app's save dialog. */
let outDir: string
let saveAnswer: string
const consoleErrors: string[] = []

/** In the proof video, a pause long enough to see what just happened; nothing otherwise. */
const beat = (ms = 1500): Promise<void> => (PROOF ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

test.beforeAll(async () => {
  ensureE2eBuild()
  project = makeRepo('notes', PROJECT_FILES)
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-export-'))
  saveAnswer = path.join(outDir, 'save-answer.txt')
  fs.writeFileSync(saveAnswer, '')
  if (PROOF) fs.rmSync(PROOF_DIR, { recursive: true, force: true })
  const launched = await launchWorldApp({
    env: { TERMPOLIS_TEST_WORLD_SAVE_FILE: saveAnswer },
    ...(PROOF ? { videoDir: PROOF_DIR } : {}),
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
  // Closing the app also finishes the proof video files.
  await quitApp(app)
  removeDirs([userDataDir, project, outDir])
})

const exportDialog = () => page.locator('[data-testid="world-export-dialog"]')
const documentDialog = () => page.locator('[data-testid="world-document-dialog"]')
const toast = () => page.locator('[data-testid="world-export-toast"]')

/** The world main stored for the project, read the way the pane reads it. */
async function worldDoc(): Promise<WorldDoc> {
  const doc = await page.evaluate(async (r) => {
    type Res<T> = { success: boolean; data?: T }
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<Res<string>>; worldGet: (c: string) => Promise<Res<unknown>> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    return res.success ? res.data ?? null : null
  }, project)
  expect(doc, 'the world main stored for the project').not.toBeNull()
  return doc as WorldDoc
}

/**
 * Opens `file` in a new window of the app, with every request but the file itself (and data:/blob:) refused.
 * The page's own CSP (default-src/connect-src 'none') refuses a request before the route sees it, so `foreign`
 * stays empty even for a page that tries to reach out: what such an attempt leaves is a CSP violation on the
 * console, and close() fails on any of those (the export-page suite checks the CSP itself, request by request).
 */
async function openOffline(file: string): Promise<{ win: Page; foreign: string[]; close(): Promise<void> }> {
  const own = pathToFileURL(file).href
  const [win, id] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(async ({ BrowserWindow }) => {
      const w = new BrowserWindow({ width: 1280, height: 800, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
      await w.loadURL('about:blank')
      return w.id
    }),
  ])
  const foreign: string[] = []
  await win.route('**/*', (route) => {
    const url = route.request().url()
    if (url === own || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
    foreign.push(url)
    return route.abort()
  })
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  const refused: string[] = []
  win.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) refused.push(m.text()) })
  await win.goto(own, { waitUntil: 'load', timeout: 60_000 })
  return {
    win,
    foreign,
    close: async () => {
      expect(errors, 'errors thrown in the opened file').toEqual([])
      expect(refused, 'requests the CSP refused in the opened file').toEqual([])
      await app.evaluate(({ BrowserWindow }, wid) => { BrowserWindow.fromId(wid)?.close() }, id)
    },
  }
}

test.describe.serial('Lumopolis export in the real app', () => {
  test.setTimeout(PROOF ? 240_000 : 120_000)

  test('0. Lumopolis opens on the project and draws its world', async () => {
    // This test's own waits add up to 150 s (expectPaneOpens' 60 s for the pane, then 30 + 30 + 30) besides the
    // terminal and the palette, so its budget covers them and a slow step fails at that step, with its own message.
    test.setTimeout(PROOF ? 300_000 : 180_000)
    await createTerminal(page, 'Notes', project)
    await paletteType(page, 'Open Lumopolis')
    await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
    await expectPaneOpens(page)
    await expect(page.locator('[data-testid="world-project"]')).toHaveText(path.basename(project), { timeout: 30_000 })
    // A cold first map of this project takes about 4-5 s here (open to canvas, 3 cold launches), its status stage
    // under 1 s; 30 s is world-view.spec.ts's budget for the same wait.
    await expect(page.locator('[data-testid="world-canvas-host"] canvas')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="world-export"]')).toBeEnabled({ timeout: 30_000 })
    expect((await worldDoc()).buildings.length).toBeGreaterThan(1)
    await beat()
  })

  test('1. the palette opens the export dialog, and an unlabelled world shows the note with smart Ask off', async () => {
    const missing = MODEL_FILES.filter((f) => !fs.existsSync(path.join(MODEL_DIR, f)))
    if (missing.length > 0) {
      const why = `the bundled embedding model is missing (${missing.join(', ')} in ${MODEL_DIR}); run bash scripts/download-embedding-model.sh`
      if (process.env.CI) throw new Error(`The smart Ask note can't be tested: ${why}. CI restores it from the model job.`)
      test.skip(true, `Skipped: ${why}.`)
    }
    // The e2e turns Describe parts with AI off (helpers/world.ts), so the note says to turn it on.
    await paletteType(page, 'export lumopolis world')
    await page.getByRole('button', { name: /^Export Lumopolis world\s*Save the world as one page/ }).click()
    await expect(exportDialog()).toBeVisible()
    await expect(page.locator('[data-testid="world-export-size"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="world-export-note"]')).toHaveText(
      "Most parts aren't described yet, so smart Ask would mostly match file names. Turn on Describe parts with AI in Settings, then press Re-layout, or export with keyword Ask.",
    )
    // The model is there: the switch is off because of the note, not for want of a model.
    await expect(page.locator('[data-testid="world-export-keyword"]')).toHaveCount(0)
    const smart = exportDialog().getByRole('checkbox', { name: /Include smart Ask/ })
    await expect(smart).not.toBeChecked()
    await expect(smart).toBeEnabled()
    await beat()
    await exportDialog().getByRole('button', { name: 'Cancel' }).click()
    await expect(exportDialog()).toHaveCount(0)
  })

  test('2. Export ▸ Interactive world writes the file, and it opens offline in a new window and answers Ask', async () => {
    const file = path.join(outDir, 'notes world.html')
    fs.writeFileSync(saveAnswer, file)
    await page.locator('[data-testid="world-export"]').click()
    await expect(page.locator('[data-testid="world-export-menu"]')).toBeVisible()
    await beat(800)
    await page.locator('[data-testid="world-export-world"]').click()
    await expect(exportDialog()).toBeVisible()
    await expect(page.locator('[data-testid="world-export-size"]')).toBeVisible({ timeout: 30_000 })
    await beat()
    await exportDialog().getByRole('button', { name: 'Export…' }).click()
    await expect(toast()).toContainText(`Exported ${path.basename(file)}`, { timeout: 60_000 })
    await expect(exportDialog()).toHaveCount(0)
    expect(fs.statSync(file).size).toBeGreaterThan(100_000)
    await beat()

    const doc = await worldDoc()
    const opened = await openOffline(file)
    try {
      // Unlabelled, so the export was keyword-only: ready settles to keyword search.
      expect((await askReady(opened.win)).state).toBe('keyword')
      const named = doc.buildings.slice(0, PROOF ? 3 : 1)
      for (const b of named) {
        const ids = await ask(opened.win, b.name)
        expect(ids, `Ask "${b.name}" found that part`).toContain(b.id)
        await beat(2500)
      }
      expect(opened.foreign, 'requests the opened file made beyond itself').toEqual([])
    } finally {
      await opened.close()
    }
  })

  test('3. Export ▸ Documentation writes the project\'s documentation page', async () => {
    const file = path.join(outDir, 'notes documentation.html')
    fs.writeFileSync(saveAnswer, file)
    await page.locator('[data-testid="world-export"]').click()
    await page.locator('[data-testid="world-export-document"]').click()
    await expect(documentDialog()).toBeVisible()
    const name = path.basename(project)
    await expect(documentDialog().getByRole('textbox', { name: 'Title' })).toHaveValue(name)
    await beat()
    await documentDialog().getByRole('button', { name: 'Save…' }).click()
    await expect(toast()).toContainText(`Exported ${path.basename(file)}`, { timeout: 60_000 })
    await expect(documentDialog()).toHaveCount(0)

    const html = fs.readFileSync(file, 'utf8')
    expect(html).toContain(`How ${escapeHtml(name)}`)
    expect(html).toContain(`>${escapeHtml(CARD_HEADINGS.whatItDoes)}<`)
    // A line no model described says, under "How it travels", what the code alone shows. One fixed sentence of the
    // fixture's: src/main/index.ts imports ./store (the main and store buildings), written out here rather than
    // worked out with the generator's own function, so a regression there can't carry the test with it.
    expect(html).toContain(escapeHtml('From the code: main imports code from store.'))

    if (PROOF) {
      const opened = await openOffline(file)
      try {
        await opened.win.evaluate(() => window.scrollTo({ top: 0 }))
        for (let y = 0; y < 6; y++) {
          await opened.win.mouse.wheel(0, 600)
          await beat(900)
        }
        expect(opened.foreign).toEqual([])
      } finally {
        await opened.close()
      }
    }
  })

  test('3b. each dialog of the pane keeps Tab inside it, closes alone on Esc and gives the focus back (A11Y Y4)', async () => {
    const pane = page.locator('[data-testid="world-view"]')
    const inside = (testid: string) => page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.contains(document.activeElement) === true, testid)
    /** Tab and Shift+Tab round the dialog, a focus moved to the toolbar behind it, then Esc: the dialog alone closes. */
    async function holds(testid: string): Promise<void> {
      const box = page.locator(`[data-testid="${testid}"]`)
      await expect(box).toBeVisible()
      // A dialog, but no aria-modal one: the pane behind it is inert instead, so the terminals stay in reach (fix round 1).
      expect(['dialog', 'alertdialog']).toContain(await box.getAttribute('role'))
      await expect(box).not.toHaveAttribute('aria-modal', /.*/)
      await expect.poll(() => inside(testid), `the ${testid} took the focus`).toBe(true)
      for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key)
        expect(await inside(testid), `${key} kept the focus in the ${testid}`).toBe(true)
      }
      // A focus moved to the pane behind the dialog (a screen reader's cursor) comes back to it. The pane itself is
      // the one place behind it a focus can still go: what is on it is inert.
      await pane.focus()
      await expect.poll(() => inside(testid), `the ${testid} took the focus back`).toBe(true)
      await page.keyboard.press('Escape')
      await expect(box).toHaveCount(0)
      await expect(pane, 'Esc closed the dialog only, never the pane').toBeVisible()
    }

    await page.locator('[data-testid="world-export"]').click()
    await page.locator('[data-testid="world-export-world"]').click()
    await holds('world-export-dialog')
    // The menu item went with its menu: the focus is back on the Export button, which the dialog greyed.
    await expect(page.locator('[data-testid="world-export"]')).toBeFocused()

    await page.locator('[data-testid="world-export"]').click()
    await page.locator('[data-testid="world-export-document"]').click()
    await holds('world-document-dialog')
    await expect(page.locator('[data-testid="world-export"]')).toBeFocused()

    const relayout = page.locator('[data-testid="world-relayout"]')
    const inMore = !(await relayout.isVisible())
    if (inMore) await page.locator('[data-testid="world-more"]').click()
    await relayout.click()
    await expect(page.locator('[data-testid="world-relayout-cancel"]'), 'Cancel, not Re-layout, takes the focus').toBeFocused()
    await holds('world-relayout-confirm')
    // Back on Re-layout, or on the More button when Re-layout was in its menu: the menu gave its button the focus as it
    // closed, before the question opened.
    await expect(page.locator(`[data-testid="${inMore ? 'world-more' : 'world-relayout'}"]`)).toBeFocused()
  })

  test('3c. with Export up, the pane behind it takes no click and no typing, and the terminal is still in reach (A11Y fix round 1, I1)', async () => {
    const dialog = exportDialog()
    const card = page.locator('[data-testid="world-card"]')
    await expect(card).toHaveCount(0)
    // On the 2D map, whose parts are buttons of the page: a click that reached one would open its card.
    const fallback = page.locator('[data-testid="world-fallback"]')
    const to2d = !(await fallback.isVisible())
    if (to2d) {
      await (await toolbarControl(page, 'world-map2d')).click()
      await closeMore(page)
    }
    const part = fallback.locator('[data-kind="building"]').first()
    await expect(part).toBeVisible()
    const askInput = page.locator('[data-testid="world-ask-row"] input')
    await expect(askInput).toBeVisible()
    const terminalInput = '[data-terminal-id] .xterm-helper-textarea'
    const cdp = await page.context().newCDPSession(page)
    const axOf = async (selector: string): Promise<{ ignored: boolean; reasons: string[] }> => {
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      expect(nodeId, selector).toBeGreaterThan(0)
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })
      const node = nodes[0] as { ignored: boolean; ignoredReasons?: { name: string }[] }
      return { ignored: node.ignored, reasons: (node.ignoredReasons ?? []).map((r) => r.name).sort() }
    }
    const terminalBefore = await axOf(terminalInput)
    expect((await axOf('[data-testid="world-ask-row"] input')).ignored, 'the Ask box is in the tree').toBe(false)
    await page.locator('[data-testid="world-export"]').click()
    await page.locator('[data-testid="world-export-world"]').click()
    await expect(dialog).toBeVisible()
    await expect(page.locator('[data-testid="world-pane-scrim"]')).toBeVisible()
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement)), 'Export took the focus').toBe(true)
    // Real clicks at the spots (force: no wait for the scrim to go), which land on the scrim, not on what is under it.
    await part.click({ force: true })
    await page.waitForTimeout(400)
    await expect(card, 'a click on a part of the 2D map opened no card').toHaveCount(0)
    const relayout = page.locator('[data-testid="world-relayout"]')
    const control = (await relayout.isVisible()) ? relayout : page.locator('[data-testid="world-more"]')
    await control.click({ force: true })
    await page.waitForTimeout(400)
    await expect(page.locator('[data-testid="world-relayout-confirm"]'), 'Re-layout opened no second dialog').toHaveCount(0)
    await expect(page.locator('[data-testid="world-more-menu"]'), 'nor its menu').toHaveCount(0)
    // A click on the Ask box puts no caret there: what is typed next goes to the dialog, as it did before the click.
    await askInput.click({ force: true })
    expect(await askInput.evaluate((el) => el === document.activeElement), 'the Ask box took no focus').toBe(false)
    await page.keyboard.type('xyz')
    await expect(askInput).toHaveValue('')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement)), 'the focus stayed in Export').toBe(true)
    await expect(dialog).toBeVisible()
    // Inert, the pane behind the dialog is out of the accessibility tree; the terminal beside the pane is as it was (an
    // aria-modal dialog would take it out too on macOS, where Chromium prunes the tree to the dialog).
    try {
      expect((await axOf('[data-testid="world-ask-row"] input')).ignored, 'the Ask box is out of the tree').toBe(true)
      expect(await axOf(terminalInput), 'the terminal is in the tree as before').toEqual(terminalBefore)
    } finally {
      await cdp.detach()
    }
    // The terminal can still take the focus: the dialog is modal in the pane only.
    await page.locator(terminalInput).first().focus()
    expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), 'the terminal took the focus').toBe(true)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-testid="world-pane-scrim"]')).toHaveCount(0)
    // Live again: a click on the part opens its card.
    await part.click()
    await expect(card).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
    if (to2d) {
      await (await toolbarControl(page, 'world-map2d')).click()
      await closeMore(page)
    }
  })

  test('4. the renderer logged no error and threw nothing', () => {
    expect(consoleErrors).toEqual([])
  })
})

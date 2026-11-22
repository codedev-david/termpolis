/**
 * Lumopolis's Ask bar in the real app (Plan 2, Task 6): the whole path from the question box to the
 * map. The renderer calls preload worldAsk, main's world:ask hands the question to askRunner, which
 * runs the user's agent hidden and read-only (runHeadless, `claude -p ...`) and parses the reply
 * (answerProtocol). The agent is never real: e2e/test-shims puts e2e/mocks/mock-claude.cjs first on
 * PATH, and MOCK_CLAUDE_WORLD_ANSWER=1 makes its `-p` mode print a canned Lumopolis answer that
 * names its question and focuses and opens the card of
 * the first building the prompt names (a real id: the mock reads it from the prompt's WORLD DATA).
 * MOCK_CLAUDE_SLOW_MATCH/MS hold back the reply to a question with a given word, so a second question can arrive while the first
 * is still running.
 *
 *   1. Lumopolis opens on a temp git project and draws its map.
 *   2. A question typed and sent with Enter shows the answer text and opens the building's card.
 *   3. Two questions in a row: only the second is answered.
 *   5. An unsupported answer says so and leaves its building fogged.
 *   6. The camera moves while the answer is still being revealed: the answer appears one sentence
 *      at a time and the mock's [A1] and [A2] markers play its steps as their sentences appear.
 *   (unnumbered) The evidence chip, below.
 *   7. The renderer logged no console error and threw no page error (last, so it covers every test).
 *
 * Labelling is off for 1 to 6, so the world has no claims (the labelling run is spawned without a
 * shell and cannot launch a Windows shim). The unnumbered evidence-chip test, skipped on Windows,
 * restarts the app with labelling on (the mock answers the labelling prompt with one claim per
 * building citing an excerpt), waits until the labelled world (saved after the code-labelled one)
 * holds a claim, and checks the [E1] chip and its evidence line. It runs before 7.
 * The launch adds the software GL switches, as world-view.spec.ts does.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { expectPaneOpens } from './helpers/world'
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild, e2eShimEnv } from './helpers/launch'

let app: ElectronApplication
let page: Page
let userDataDir: string
let project: string
let shimDir: string
let shims: Record<string, string>
const consoleErrors: string[] = []
const SLOW_MS = 4000

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

test.beforeAll(async () => {
  ensureE2eBuild()
  project = makeRepo('ask', PROJECT_FILES)

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-ask-ud-'))
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({ terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs' }),
  )
  // Labelling off: its hidden `claude -p` run is spawned without a shell (execFile), which cannot
  // launch a Windows shim, so it would reach the machine's real agent. Without labelling the world
  // has no claims, so no evidence and no chip: the chip is covered by the WorldAnswer unit tests.
  fs.writeFileSync(path.join(userDataDir, 'world-settings.json'), JSON.stringify({ worldLabelling: false }))

  // Termpolis refuses a .cmd or .bat agent on Windows (a hidden run never passes a prompt through
  // cmd.exe), so there the mock is a PowerShell script first on PATH: Get-Command takes it as an
  // external script. Elsewhere e2e/test-shims/claude, which e2eShimEnv puts on PATH, is enough.
  shims = e2eShimEnv('world-ask')
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-ask-shim-'))
  if (process.platform === 'win32') {
    const mock = path.resolve('e2e', 'mocks', 'mock-claude.cjs')
    fs.writeFileSync(path.join(shimDir, 'claude.ps1'), `& node '${mock}' @args
exit $LASTEXITCODE
`)
  }

  await launchApp()
})

/** Starts (or restarts) the app on `userDataDir` and gets past onboarding. */
async function launchApp(): Promise<void> {
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
    env: {
      ...process.env,
      ...shims,
      PATH: `${shimDir}${path.delimiter}${shims.PATH}`,
      // A local .ps1 may run whatever the machine's execution policy says.
      PSExecutionPolicyPreference: 'Bypass',
      NODE_ENV: 'test',
      TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
      TERMPOLIS_TEST_WORLD_PROBE: '1',
      MOCK_CLAUDE_WORLD_ANSWER: '1',
      MOCK_CLAUDE_REPLY_DELAY_MS: '300',
      // A question with "first" in it gets its reply 4 s late: far later than the second one's.
      MOCK_CLAUDE_SLOW_MATCH: 'first',
      MOCK_CLAUDE_SLOW_MS: String(SLOW_MS),
    },
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
}

test.afterAll(async () => {
  await quitApp(app)
  for (const d of [userDataDir, project, shimDir]) {
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

const canvas = () => page.locator('[data-testid="world-canvas-host"] canvas')
const card = () => page.locator('[data-testid="world-card"]')
const askBox = () => page.getByPlaceholder('Ask about this project…')
const answer = () => page.locator('[data-testid="world-answer"]')
const chip = () => answer().getByRole('button', { name: 'Evidence E1' })

/** Claims with evidence in the worlds saved under `userDataDir` (0 while only code labels exist). */
function storedClaims(): number {
  const folder = path.join(userDataDir, 'world')
  let n = 0
  for (const name of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
    if (!name.endsWith('.json')) continue
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) as {
        buildings?: { how?: { evidence?: unknown[] }[]; why?: { evidence?: unknown[] }[] }[]
        edges?: { how?: { evidence?: unknown[] }[]; why?: { evidence?: unknown[] }[] }[]
      }
      for (const part of [...(doc.buildings ?? []), ...(doc.edges ?? [])]) {
        for (const c of [...(part.how ?? []), ...(part.why ?? [])]) if ((c.evidence ?? []).length > 0) n++
      }
    } catch {
      // A file mid-write is read again on the next poll.
    }
  }
  return n
}

/** Types `q` in the Ask bar and sends it with Enter. */
async function ask(q: string): Promise<void> {
  await askBox().fill(q)
  await askBox().press('Enter')
}

test.describe.serial('Lumopolis Ask bar in the real app', () => {
  test.setTimeout(60_000)

  test('1. Lumopolis opens and draws the map', async () => {
    test.setTimeout(150_000)
    await createTerminal('Notes', project)
    // A focused terminal takes Ctrl+K as a key for the shell: the palette shortcut is the app's
    // only when the focus is outside it, as after clicking away.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.getByPlaceholder('Type a command...')
    await expect(input).toBeVisible()
    await input.fill('Open Lumopolis')
    const result = page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ })
    await expect(result).toBeVisible()
    await result.click()

    await expectPaneOpens(page)
    await expect(page.locator('[data-testid="world-fallback"]')).toHaveCount(0)
    await expect(canvas()).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('[data-testid="world-canvas-host"]')).toHaveCSS('visibility', 'visible', { timeout: 30_000 })
    // The Ask bar is on once the viewer is up.
    await expect(askBox()).toBeEnabled({ timeout: 30_000 })
  })

  test('2. a question shows the answer, opens the building card and stays free of raw markers', async () => {
    await expect(card()).toHaveCount(0)
    await ask('How does it fit together?')
    await expect(answer()).toBeVisible({ timeout: 30_000 })
    await expect(answer()).toContainText('Answer to: How does it fit together?')
    // The world-actions block opened the card of the building the agent named.
    await expect(card()).toBeVisible({ timeout: 15_000 })
    await expect(card().locator('h3').first()).not.toHaveText('')
    // No world-actions fence is left in the answer, and no evidence chip (the world has no claims).
    await expect(chip()).toHaveCount(0)
    await expect(answer()).not.toContainText('world-actions')
  })

  test("3. asking twice quickly yields one answer, the second's", async () => {
    await ask('What runs first?')
    // The mock holds the first reply back 4 s, so the second question lands while it still runs.
    await expect(page.locator('[role="status"]:has-text("Thinking")')).toBeVisible()
    const asked = Date.now()
    await ask('Where is the data kept?')
    await expect(answer()).toContainText('Answer to: Where is the data kept?', { timeout: 30_000 })
    await expect(answer()).toHaveCount(1)
    // Wait past the moment the first reply would have printed (bounded wait, then a polled check):
    // had that ask not been cancelled, its answer would have replaced the second's by now.
    await page.waitForTimeout(Math.max(0, asked + SLOW_MS + 1500 - Date.now()))
    await expect(answer()).toContainText('Answer to: Where is the data kept?')
    await expect(answer()).not.toContainText('What runs first?')
    await expect(answer()).toHaveCount(1)
  })

  test('5. an unsupported answer says so and leaves its building fogged', async () => {
    const fogged = (): Promise<string[]> => page.evaluate(
      () => (window as unknown as { __termpolis_world?: { drawn(): { fogged: string[] } } }).__termpolis_world?.drawn().fogged ?? []
    )
    await ask('Why was it built this way?')
    await expect(answer()).toContainText('Answer to: Why was it built this way?', { timeout: 30_000 })
    await expect(answer()).toContainText("evidence doesn't say")
    // The fog step named the first building in the prompt: it is the one fogged now.
    await expect.poll(async () => (await fogged()).length, { timeout: 15_000 }).toBe(1)
    expect((await fogged())[0]).not.toBe('')
    // The next answer lifts it.
    await ask('Where is the data kept?')
    await expect(answer()).toContainText('Answer to: Where is the data kept?', { timeout: 30_000 })
    await expect.poll(fogged, { timeout: 15_000 }).toEqual([])
  })

  test('6. the camera moves while the answer is still being revealed', async () => {
    const highlighted = (): Promise<string[]> => page.evaluate(
      () => (window as unknown as { __termpolis_world?: { drawn(): { highlighted: string[] } } }).__termpolis_world?.drawn().highlighted ?? []
    )
    // A machine set to reduce motion reveals the whole answer at once: this test is about the paced reveal.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    // The mock answers in two sentences, [A1] focusing a building and [A2] opening its card. The first
    // one holds the question, so a long question keeps the second sentence back for seconds (70 ms a word).
    await ask(`Please explain ${'alpha beta '.repeat(30)}to me?`)
    await expect(answer()).toContainText('Answer to: Please explain', { timeout: 30_000 })
    await expect(answer()).not.toContainText('The first part')
    // The first sentence's step is already playing: its building is highlighted.
    await expect.poll(async () => (await highlighted()).length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect((await highlighted())[0]).not.toBe('')
    // Still only the first sentence: the second (and its [A2] card) has not appeared yet.
    await expect(answer()).not.toContainText('The first part')
    // Then the rest appears at reading pace.
    await expect(answer()).toContainText('The first part is shown in the map', { timeout: 30_000 })
    await expect(card()).toBeVisible({ timeout: 15_000 })
    await expect(answer()).not.toContainText('[A1]')
    await expect(answer()).not.toContainText('[A2]')
    await page.emulateMedia({ reducedMotion: null })
  })
})

// The [E1] chip needs a labelled world: labelling runs `claude -p` through execFile without a
// shell, which launches the bash shim on Linux and macOS but not a Windows .cmd or .ps1 shim.
test.describe.serial('Lumopolis Ask bar evidence chip (labelling on)', () => {
  test.setTimeout(150_000)
  test.skip(process.platform === 'win32', 'the labelling run uses execFile without a shell, so .cmd/.ps1 shims cannot run')

  test.beforeAll(async () => {
    // Same app again on a fresh user-data folder state, with the default labelling (on).
    const before = consoleErrors.length
    await quitApp(app)
    fs.writeFileSync(
      path.join(userDataDir, 'session.json'),
      JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'bash', viewMode: 'tabs' }),
    )
    fs.rmSync(path.join(userDataDir, 'world'), { recursive: true, force: true })
    fs.writeFileSync(path.join(userDataDir, 'world-settings.json'), JSON.stringify({ worldLabelling: true }))
    await launchApp()
    // Errors logged while the first app quit and this one started are not a test's; the earlier tests' stay.
    consoleErrors.splice(before)
  })

  test('an answer citing [E1] shows a chip, and clicking it shows the evidence', async () => {
    await createTerminal('Notes', project)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.getByPlaceholder('Type a command...')
    await expect(input).toBeVisible()
    await input.fill('Open Lumopolis')
    const result = page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ })
    await expect(result).toBeVisible()
    await result.click()
    // The first world is code-labelled and drawn at once; the labelled one (one hidden agent run
    // per district) is saved behind it and swapped in by an `updated` push.
    await expect(canvas()).toBeVisible({ timeout: 120_000 })
    await expect(askBox()).toBeEnabled({ timeout: 30_000 })
    // Asking before the labelled world is saved would cite no evidence, so wait for a claim in it.
    await expect.poll(storedClaims, { timeout: 120_000, intervals: [500] }).toBeGreaterThan(0)

    await ask('How does it fit together?')
    await expect(answer()).toContainText('Answer to: How does it fit together?', { timeout: 30_000 })
    // The marker became a chip: no raw [E1] text is left in the answer.
    await expect(chip()).toBeVisible()
    await expect(answer().locator('p')).not.toContainText('[E1]')

    // Evidence a model cites is a file, so the chip shows its inline `kind ref` line.
    const evidence = answer().locator('div.font-mono')
    await expect(evidence).toHaveCount(0)
    await chip().click()
    await expect(evidence).toHaveCount(1)
    await expect(evidence).toHaveText(/^file \S+/)
    await chip().click()
    await expect(evidence).toHaveCount(0)
  })
})

// Last, so it covers every test above, including the labelled run.
test.describe.serial('Lumopolis Ask bar console', () => {
  test('7. the renderer logged no console errors and threw no page errors', async () => {
    expect(consoleErrors).toEqual([])
  })
})

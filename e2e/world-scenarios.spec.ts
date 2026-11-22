/**
 * Lumopolis over the edge-case scenario fixtures (tests/e2e/fixtures/worldScenarios.ts), in the real app with one
 * launch for the whole table. Most rows open their scenario the way the app opens a project's world: main is asked to
 * map it (world:map-project), then the pane opens on it (the termpolis:openWorld event). One row, nested-repo, goes
 * through the Lumopolis home's real Open a folder button instead (world:open-folder, its folder dialog answered from
 * TERMPOLIS_TEST_WORLD_PICK_FILE). For each row the world must have the files a person can see as parts (every
 * building's members), none of the vendored ones, and no error in the pane. Last, the renderer must have logged no
 * console error and thrown no page error.
 *
 * With WORLD_SCENARIO_HUGE=1 two more rows run: huge (50,000 files) as a plain folder, where the walk stops at its cap
 * and the pane says so, and as a repository, where git lists every file. Each prints the time to the first map and
 * every process's peak working set (app.getAppMetrics) for the record. CI does not set it: each fixture writes 50,000
 * files.
 *
 * The rows: unicode-names (a git repository, so git's quoting of non-ASCII names is in play), non-git (a plain
 * folder, walked), untracked (a file never added), vendored (dependency, build, minified and bundled files committed),
 * vendored-untracked (dependency, environment, cache and build folders written and never added), submodule (recursed
 * into) and nested-repo (a repository inside the folder, listed by its own git).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { launchWorldApp, removeDirs, expectPaneOpens } from './helpers/world'
import { makeScenario, UNTRACKED_VENDORED, type ScenarioName, type ScenarioOptions } from '../tests/e2e/fixtures/worldScenarios'

let app: ElectronApplication
let page: Page
let userDataDir: string
let base: string
let pickFile: string
const consoleErrors: string[] = []

interface Row {
  name: ScenarioName
  opts?: ScenarioOptions
  /** Files that must be some building's member. */
  parts: string[]
  /** Path prefixes no member may start with. */
  absent?: string[]
  /** Opened through the home's Open a folder button (world:open-folder) rather than world:map-project. */
  openFolder?: boolean
}

const ROWS: Row[] = [
  { name: 'unicode-names', opts: { git: true }, parts: ['src/café.ts', 'src/日本/データ.ts', 'src/😀.ts'] },
  { name: 'non-git', parts: ['src/index.ts', 'src/a.ts', 'src/b.ts', 'src/util.ts', 'lib/format.ts', 'lib/parse.ts'] },
  { name: 'untracked', parts: ['a.ts', 'b.ts'], absent: ['ignored.ts'] },
  {
    name: 'vendored',
    parts: ['src/main.ts', 'src/util.ts'],
    // src/app.bundle.js is a .js file in a folder the world shows: only its name keeps it out, so this can fail.
    absent: ['node_modules/', '.venv/', 'target/', 'dist/', 'src/app.bundle.js']
  },
  { name: 'vendored-untracked', parts: ['src/main.ts', 'src/util.ts'], absent: UNTRACKED_VENDORED },
  { name: 'submodule', parts: ['src/app.ts', 'libs/shared/index.ts', 'libs/shared/helper.ts'] },
  { name: 'nested-repo', parts: ['src/app.ts', 'nested/lib.ts', 'nested/helper.ts'], openFolder: true }
]

test.beforeAll(async () => {
  ensureE2eBuild()
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-scenarios-'))
  pickFile = path.join(base, 'pick.txt')
  const launched = await launchWorldApp({
    env: { TERMPOLIS_TEST_WORLD_PICK_FILE: pickFile },
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
  removeDirs([userDataDir, base])
})

const pane = () => page.locator('[data-testid="world-view"]')
const home = () => page.getByTestId('world-home')

/** The home's Open a folder button, with the folder dialog answered by `dir`: the real world:open-folder handler. */
async function openFromHome(dir: string): Promise<void> {
  fs.writeFileSync(pickFile, dir)
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByPlaceholder('Type a command...')
  await expect(input).toBeVisible()
  await input.fill('Open Lumopolis')
  await page.getByRole('button', { name: /^Open Lumopolis\s*See your project as a 3D world/ }).click()
  await expect(pane()).toBeVisible()
  // The pane opens on the home, or on the last world; the Worlds list goes home from there.
  if (!(await home().isVisible().catch(() => false))) await page.getByRole('combobox', { name: 'Worlds' }).selectOption('__home')
  await expect(home()).toBeVisible()
  await home().getByRole('button', { name: /^Open a folder/ }).click()
  await expect(home()).toHaveCount(0)
}

/** A path as the file system knows it: real (8.3 short names expanded, links followed), slashes, and folded to lower
 *  case where the file system folds case. Two spellings of one folder compare equal. */
function realKey(p: string): string {
  let r = p
  try {
    r = fs.realpathSync.native(p)
  } catch {
    /* gone: compare the spelling as given */
  }
  r = r.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
}

/**
 * The key the app stores `dir`'s world under, and nothing else: a folder opened as a folder under the folder as the
 * dialog gave it, a project under its repository's top as git spells it (which can differ from `dir`: a long name for
 * an 8.3 temp path). A world saved under the other one is not found, so the check fails. The app's own answer is
 * checked against git run here first, so a wrong top from the app cannot agree with itself.
 */
async function worldKey(dir: string, asFolder: boolean): Promise<string> {
  if (asFolder) return dir
  const top = await page.evaluate(
    (r) => (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string | null }> } }).termpolis.gitFindRoot(r),
    dir
  )
  const key = top.success && top.data ? top.data : dir
  expect(realKey(key), `the app finds ${dir}'s repository top as git does`).toBe(realKey(gitTop(dir)))
  return key
}

/** The repository top git itself names for `dir`, run here and not by the app; `dir` when it is in no repository. */
function gitTop(dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || dir
  } catch {
    return dir
  }
}

/** Every building member of the world main stored under `key`; null: no world there yet. */
async function members(key: string): Promise<string[] | null> {
  return page.evaluate(async (k) => {
    interface Doc { buildings: { members: string[] }[] }
    const api = (window as unknown as { termpolis: { worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
    const res = await api.worldGet(k)
    return res.success && res.data ? res.data.buildings.flatMap((b) => b.members) : null
  }, key)
}

/** The kind of every recent world whose folder is `dir` under any spelling (compared as real paths). */
async function listedKinds(dir: string): Promise<string[]> {
  const entries = await page.evaluate(async () => {
    const api = (window as unknown as { termpolis: { worldSourcesList: () => Promise<{ success: boolean; data?: { source: { kind: string; root?: string } }[] }> } }).termpolis
    const res = await api.worldSourcesList()
    return res.success && res.data ? res.data.map((e) => e.source) : []
  })
  const want = realKey(dir)
  return entries.filter((e) => typeof e.root === 'string' && realKey(e.root) === want).map((e) => e.kind)
}

test.describe.serial('Lumopolis over the scenario fixtures', () => {
  for (const row of ROWS) {
    test(`${row.name}: the world has the files a person can see${row.absent ? ', and not the vendored ones' : ''}`, async () => {
      test.setTimeout(90_000)
      const dir = await makeScenario(row.name, base, row.opts)

      if (row.openFolder) {
        await openFromHome(dir)
      } else {
        // The project path, as the home's Map this project takes it: main maps the repository's top (the spelling
        // gitFindRoot gives, not the 8.3 temp path) as a project, then the pane opens on the folder.
        const top = await worldKey(dir, false)
        const mapped = await page.evaluate(
          (r) => (window as unknown as { termpolis: { worldMapProject: (c: string) => Promise<{ success: boolean; error?: string }> } }).termpolis.worldMapProject(r),
          top
        )
        expect(mapped.error ?? '', `world:map-project refused ${row.name}`).toBe('')
        expect(mapped.success).toBe(true)
        await page.evaluate((folder) => window.dispatchEvent(new CustomEvent('termpolis:openWorld', { detail: { folder } })), dir)
      }
      await expectPaneOpens(page)

      const key = await worldKey(dir, row.openFolder === true)
      await expect.poll(() => members(key), { message: `a world for ${row.name} under ${key}`, timeout: 60_000 }).not.toBeNull()
      const got = (await members(key))!
      // The home lists it as what it was opened as: a folder from Open a folder, a project from world:map-project.
      expect(await listedKinds(dir), `${row.name} is in the home once, as a ${row.openFolder ? 'folder' : 'project'}`).toEqual([row.openFolder ? 'folder' : 'project'])
      for (const file of row.parts) expect(got, `${file} is a part of ${row.name}'s world`).toContain(file)
      for (const prefix of row.absent ?? []) {
        expect(got.filter((m) => m.startsWith(prefix)), `nothing under ${prefix} in ${row.name}'s world`).toEqual([])
      }
      await expect(page.locator('[data-testid="world-error"]')).toHaveCount(0)

      await page.locator('[data-testid="world-close"]').click()
      await expect(pane()).toHaveCount(0)
    })
  }

  for (const withGit of [false, true]) {
  test(`huge ${withGit ? 'repository' : 'folder'} (WORLD_SCENARIO_HUGE=1 only): ${withGit ? 'git lists every file' : 'the walk stops at its cap and the pane says so'}; time and memory are printed`, async () => {
    test.skip(process.env.WORLD_SCENARIO_HUGE !== '1', 'huge writes 50,000 files; set WORLD_SCENARIO_HUGE=1 to run it')
    test.setTimeout(900_000)
    const dir = await makeScenario('huge', base, { git: withGit })
    const started = Date.now()
    const mapped = await page.evaluate(
      (r) => (window as unknown as { termpolis: { worldMapProject: (c: string) => Promise<{ success: boolean; error?: string }> } }).termpolis.worldMapProject(r),
      dir
    )
    expect(mapped.error ?? '').toBe('')
    await page.evaluate((folder) => window.dispatchEvent(new CustomEvent('termpolis:openWorld', { detail: { folder } })), dir)
    await expectPaneOpens(page)
    const key = await worldKey(dir, false)
    await expect.poll(() => members(key), { message: 'a world for huge', timeout: 800_000, intervals: [1000] }).not.toBeNull()
    const firstMapMs = Date.now() - started
    const got = (await members(key))!
    expect(got.length).toBeGreaterThan(0)
    if (withGit) {
      expect(got.length).toBe(50_000)
      await expect(page.locator('[data-testid="world-notice"]', { hasText: 'Showing the first ' })).toHaveCount(0)
    } else {
      expect(got.length).toBeLessThanOrEqual(20_000)
      await expect(page.locator('[data-testid="world-notice"]')).toContainText('Showing the first ', { timeout: 60_000 })
    }
    const peaks = await app.evaluate(({ app: eapp }) =>
      eapp.getAppMetrics().map((m) => ({ process: m.name ? `${m.type}:${m.name}` : m.type, peakMB: Math.round(m.memory.peakWorkingSetSize / 1024) }))
    )
    const report = { git: withGit, firstMapMs, mapped: got.length, peaks }
    console.log(`[huge] ${JSON.stringify(report)}`)
    test.info().annotations.push({ type: 'huge', description: JSON.stringify(report) })
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
  })
  }

  test('the renderer logged no console errors and threw no page errors', async () => {
    expect(consoleErrors).toEqual([])
  })
})

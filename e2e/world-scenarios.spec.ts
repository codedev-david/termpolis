/**
 * Lumopolis over the edge-case scenario fixtures (tests/e2e/fixtures/worldScenarios.ts), in the real app with one
 * launch for the whole table. Most rows open their scenario the way the app opens a project's world: main is asked to
 * map it (world:map-project), then the pane opens on it (the termpolis:openWorld event). One row, nested-repo, goes
 * through the Lumopolis home's real Open a folder button instead (world:open-folder, its folder dialog answered from
 * TERMPOLIS_TEST_WORLD_PICK_FILE). For each row the world must have the files a person can see as parts (every
 * building's members), none of the vendored ones, and no error in the pane. Last, the renderer must have logged no
 * console error and thrown no page error.
 *
 * One more row writes a 2,400-file folder (past the host's PROVISIONAL_MIN_FILES) and checks the first map: the pane
 * gets a world drawn from the listing (provisional) before the complete one, and the progress only rises.
 *
 * With WORLD_SCENARIO_HUGE=1 two more rows run: huge (50,000 files) as a plain folder, where the walk stops at its cap
 * and the pane says so, and as a repository, where git lists every file and the pane says only 20,000 were read. Each
 * prints the time to the first map (the first world worldGet returns, provisional or not), the time to the complete
 * world (the first one that is not provisional), the longest wait between two progress reports, and every process's
 * peak working set (app.getAppMetrics) for the record. CI does not set it: each fixture writes 50,000 files.
 *
 * The rows: unicode-names (a git repository, so git's quoting of non-ASCII names is in play), non-git (a plain
 * folder, walked), untracked (a file never added), vendored (dependency, build, minified and bundled files committed),
 * vendored-untracked (dependency, environment, cache and build folders written and never added), submodule (recursed
 * into) and nested-repo (a repository inside the folder, listed by its own git).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { launchWorldApp, removeDirs, expectPaneOpens } from './helpers/world'
import { toolbarControl, closeMore } from './helpers/worldToolbar'
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
  /** Imports that must be lines: the building of the first file joined to the building of the second. */
  lines?: [string, string][]
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
  { name: 'nested-repo', parts: ['src/app.ts', 'nested/lib.ts', 'nested/helper.ts'], openFolder: true },
  // Python's relative imports and Go's module-path imports are lines too, not only JS and TS.
  { name: 'python-only', parts: ['app/main.py', 'app/service.py', 'app/store.py'], lines: [['app/main.py', 'app/service.py'], ['app/service.py', 'app/store.py']] },
  { name: 'go-only', parts: ['main.go', 'server/server.go', 'store/store.go'], lines: [['main.go', 'server/server.go'], ['server/server.go', 'store/store.go']] }
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
  const findRoot = async (): Promise<string | null> => {
    const top = await page.evaluate(
      (r) => (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string | null }> } }).termpolis.gitFindRoot(r),
      dir
    )
    return top.success && top.data ? top.data : null
  }
  // The app's look-up gives up after 3 s and answers null (an uncached git on a busy machine), and null reads as "no
  // repository": the test would then map `dir`'s own spelling while the pane maps the top, two entries for one
  // folder. git run here says whether there is a repository; while there is, the app is asked again until it answers,
  // each ask bounded by the app's own 3 s, for up to two thirds of the test's own time: past that the test fails here,
  // naming the look-up, rather than at its timeout (fix round 4, M2). No fixed clock of its own, so a loaded machine
  // gets the time the test allows, which a fixed 20 s did not (the round 2 flake; minor sweep, R4-3). The last ask can
  // start just before the deadline, so the wait runs at most one ask and one pause (5 s) past it, still inside the test.
  let found = await findRoot()
  if (found === null && gitTopOf(dir) !== null) {
    // A timeout of 0 means the test has none: then neither has this wait, as before round 4.
    const deadline = Date.now() + (test.info().timeout > 0 ? (test.info().timeout * 2) / 3 : Infinity)
    for (let tries = 1; found === null && Date.now() < deadline; tries++) {
      await page.waitForTimeout(Math.min(2000, 250 * tries))
      found = await findRoot()
    }
    if (found === null) throw new Error(`gitFindRoot never answered for ${dir}`)
  }
  const key = found ?? dir
  expect(realKey(key), `the app finds ${dir}'s repository top as git does`).toBe(realKey(gitTop(dir)))
  return key
}

/** The repository top git itself names for `dir`, run here and not by the app; null when it is in no repository. */
function gitTopOf(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/** The repository top git itself names for `dir`; `dir` when it is in no repository. */
function gitTop(dir: string): string {
  return gitTopOf(dir) ?? dir
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

/**
 * The complete world under `key` as its buildings and the lines between them; null: no world yet, or only the first
 * map drawn from the listing, which reads no file and so has no lines.
 */
async function linesOf(key: string): Promise<{ buildings: { id: string; members: string[] }[]; edges: { from: string; to: string }[] } | null> {
  return page.evaluate(async (k) => {
    interface Doc { buildings: { id: string; members: string[] }[]; edges: { from: string; to: string }[]; provisional?: boolean }
    const api = (window as unknown as { termpolis: { worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
    const res = await api.worldGet(k)
    return res.success && res.data && res.data.provisional !== true ? { buildings: res.data.buildings.map((b) => ({ id: b.id, members: b.members })), edges: res.data.edges.map((e) => ({ from: e.from, to: e.to })) } : null
  }, key)
}

/** One look at the world under the key the recorder watches, ms after it started; `error`: the pane showed its error. */
interface Sample { t: number; n: number | null; provisional: boolean; note: string; error: boolean }
interface Recorded { samples: Sample[]; progress: { t: number; root: string; key: string; stage: string; pct: number }[] }

/**
 * Starts watching `key` in the renderer before the world is asked for: worldGet every `everyMs` until a world that is
 * not provisional comes back (the first-map signal is the first world worldGet returns, the complete signal the first
 * one that is not provisional), every progress report, and the pane's note at each look.
 */
async function startRecorder(key: string, everyMs: number): Promise<void> {
  await page.evaluate(
    ({ k, every }) => {
      interface Doc { buildings: { members: string[] }[]; provisional?: boolean }
      interface Look { t: number; n: number | null; provisional: boolean; note: string; error: boolean }
      interface Api {
        worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }>
        onWorldProgress: (cb: (e: { root: string; projectKey: string; stage: string; pct: number }) => void) => () => void
      }
      const w = window as unknown as { termpolis: Api; __wp4a?: unknown }
      const t0 = performance.now()
      const rec = { samples: [] as Look[], progress: [] as { t: number; root: string; key: string; stage: string; pct: number }[] }
      // Every report, with its folder and key: recorded() keeps this world's.
      const off = w.termpolis.onWorldProgress((e) => void rec.progress.push({ t: Math.round(performance.now() - t0), root: e.root, key: e.projectKey, stage: e.stage, pct: e.pct }))
      w.__wp4a = rec
      const look = async (): Promise<void> => {
        const res = await w.termpolis.worldGet(k).catch(() => ({ success: false, data: null }))
        const d = res.success && res.data ? res.data : null
        const note = document.querySelector('[data-testid="world-notice"]')?.textContent ?? ''
        const error = document.querySelector('[data-testid="world-error"]') !== null
        rec.samples.push({ t: Math.round(performance.now() - t0), n: d ? d.buildings.reduce((a, b) => a + b.members.length, 0) : null, provisional: d?.provisional === true, note, error })
        if (d && d.provisional !== true) off()
        else setTimeout(() => void look(), every)
      }
      void look()
    },
    { k: key, every: everyMs }
  )
}

/** What the recorder has seen so far: only `dir`'s progress (compared as real paths), since a world opened earlier in
 *  the table may still be recompiling. */
async function recorded(dir: string): Promise<Recorded> {
  const r = await page.evaluate(() => {
    const w = (window as unknown as { __wp4a: Recorded }).__wp4a
    return { samples: [...w.samples], progress: [...w.progress] }
  })
  const want = realKey(dir)
  // A report names its folder when main knows it, and always its project key (projectKey.ts: sha1 of the folder's
  // spelling, slashes forward and lower case, 16 hex digits), so the key is checked against both spellings.
  const keyOf = (f: string): string => createHash('sha1').update(f.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 16)
  const keys = new Set([keyOf(dir), keyOf(want), keyOf(fs.realpathSync.native(dir))])
  return { samples: r.samples, progress: r.progress.filter((p) => keys.has(p.key) || (p.root !== '' && realKey(p.root) === want)) }
}

/** The first map, the complete world and the longest wait between progress reports (until the compile's 100), in ms. */
function timings(r: Recorded): { firstMapMs: number; completeMs: number; longestQuietMs: number; quietBetween: string; risesOnly: boolean } {
  const first = r.samples.find((s) => s.n !== null) as Sample
  const complete = r.samples.find((s) => s.n !== null && !s.provisional) as Sample
  const end = r.progress.findIndex((p) => p.pct >= 100)
  const run = end < 0 ? r.progress : r.progress.slice(0, end + 1)
  let longestQuietMs = 0
  // The two reports either side of the longest wait (stage pct at t ms), so a quiet bar names its stage.
  let quietBetween = ''
  let risesOnly = true
  for (let i = 1; i < run.length; i++) {
    if (run[i].t - run[i - 1].t > longestQuietMs) {
      longestQuietMs = run[i].t - run[i - 1].t
      quietBetween = [run[i - 1], run[i]].map((p) => `${p.stage} ${p.pct} at ${p.t}`).join(' -> ')
    }
    if (run[i].pct < run[i - 1].pct) risesOnly = false
  }
  return { firstMapMs: first.t, completeMs: complete.t, longestQuietMs, quietBetween, risesOnly }
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
      if (row.lines) {
        await expect.poll(() => linesOf(key), { message: `the complete world for ${row.name}`, timeout: 60_000 }).not.toBeNull()
        const doc = (await linesOf(key))!
        const home = (f: string): string | undefined => doc.buildings.find((b) => b.members.includes(f))?.id
        const drawn = new Set(doc.edges.map((e) => `${e.from} -> ${e.to}`))
        expect(doc.edges.length, `${row.name}'s world has lines`).toBeGreaterThan(0)
        for (const [from, to] of row.lines) {
          expect(home(from), `${from} and ${to} are in different buildings`).not.toBe(home(to))
          expect(drawn.has(`${home(from)} -> ${home(to)}`), `a line from ${from}'s building to ${to}'s`).toBe(true)
        }
      }
      await expect(page.locator('[data-testid="world-error"]')).toHaveCount(0)

      await page.locator('[data-testid="world-close"]').click()
      await expect(pane()).toHaveCount(0)
    })
  }

  test('mid-size folder (2,400 files): a first map from the listing comes before the complete world, and progress only rises', async () => {
    test.setTimeout(180_000)
    const dir = path.join(base, 'mid-size')
    const FOLDERS = 24
    const PER = 100
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mid-size', version: '1.0.0' }))
    for (let d = 0; d < FOLDERS; d++) {
      const folder = path.join(dir, 'src', `d${d}`)
      fs.mkdirSync(folder, { recursive: true })
      for (let i = 0; i < PER; i++) fs.writeFileSync(path.join(folder, `f${i}.ts`), `import { v as w } from '../d${(d + 1) % FOLDERS}/f${i}'\nexport const v = ${i}\nexport const u = w\n`)
    }
    const key = await worldKey(dir, false)
    await startRecorder(key, 25)
    const mapped = await page.evaluate(
      (r) => (window as unknown as { termpolis: { worldMapProject: (c: string) => Promise<{ success: boolean; error?: string }> } }).termpolis.worldMapProject(r),
      key
    )
    expect(mapped.error ?? '').toBe('')
    await page.evaluate((folder) => window.dispatchEvent(new CustomEvent('termpolis:openWorld', { detail: { folder } })), dir)
    await expectPaneOpens(page)
    await expect.poll(async () => (await recorded(dir)).samples.some((s) => s.n !== null && !s.provisional), { timeout: 150_000, intervals: [250] }).toBe(true)
    const r = await recorded(dir)
    const t = timings(r)
    const drawn = r.samples.filter((s) => s.n !== null)
    // The first world the pane could get was drawn from the listing, every file a part, and the complete one came after.
    expect(drawn[0].provisional, 'the first world is the first map from the listing').toBe(true)
    expect(drawn[0].n).toBe(FOLDERS * PER)
    expect(drawn[drawn.length - 1].n).toBe(FOLDERS * PER)
    expect(t.firstMapMs).toBeLessThan(t.completeMs)
    expect(t.risesOnly, `progress only rises: ${JSON.stringify(r.progress)}`).toBe(true)
    const notes = [...new Set(drawn.filter((s) => s.provisional).map((s) => s.note))]
    console.log(`[mid-size] ${JSON.stringify({ ...t, looks: r.samples.length, provisionalNotes: notes })}`)
    test.info().annotations.push({ type: 'mid-size', description: JSON.stringify(t) })
    await expect(page.locator('[data-testid="world-error"]')).toHaveCount(0)
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
  })

  for (const withGit of [false, true]) {
  test(`huge ${withGit ? 'repository' : 'folder'} (WORLD_SCENARIO_HUGE=1 only): ${withGit ? 'git lists every file, 20,000 are read and the pane says so' : 'the walk stops at its cap and the pane says so'}; time and memory are printed`, async () => {
    test.skip(process.env.WORLD_SCENARIO_HUGE !== '1', 'huge writes 50,000 files; set WORLD_SCENARIO_HUGE=1 to run it')
    test.setTimeout(900_000)
    const dir = await makeScenario('huge', base, { git: withGit })
    const key = await worldKey(dir, false)
    // Every look while the first map is up has the world process send that map whole (tens of thousands of parts):
    // a look every 2 s, not every 250 ms, so the looks themselves do not raise the peak being measured (fix round 2,
    // I5/R3). The first map's time is then known to within 2 s.
    await startRecorder(key, 2000)
    const mapped = await page.evaluate(
      (r) => (window as unknown as { termpolis: { worldMapProject: (c: string) => Promise<{ success: boolean; error?: string }> } }).termpolis.worldMapProject(r),
      dir
    )
    expect(mapped.error ?? '').toBe('')
    await page.evaluate((folder) => window.dispatchEvent(new CustomEvent('termpolis:openWorld', { detail: { folder } })), dir)
    await expectPaneOpens(page)
    await expect.poll(async () => (await recorded(dir)).samples.some((s) => s.n !== null && !s.provisional), { message: 'a complete world for huge', timeout: 800_000, intervals: [1000] }).toBe(true)
    const r = await recorded(dir)
    const t = timings(r)
    expect(t.risesOnly, `progress only rises: ${JSON.stringify(r.progress)}`).toBe(true)
    // Once the first map is up it stays up until the complete world replaces it, and the pane never shows its error
    // meanwhile, however long the reads take (fix round 3, N1).
    const shown = r.samples.slice(r.samples.findIndex((s) => s.n !== null))
    expect(shown.filter((s) => s.n === null || s.error), `the first map stays up with no error: ${JSON.stringify(shown.filter((s) => s.n === null || s.error))}`).toEqual([])
    const got = (await members(key))!
    expect(got.length).toBeGreaterThan(0)
    if (withGit) {
      expect(got.length).toBe(50_000)
      await expect(page.locator('[data-testid="world-notice"]', { hasText: 'Showing the first ' })).toHaveCount(0)
      await expect(page.locator('[data-testid="world-notice"]')).toContainText('All 50,000 files are shown, but only 20,000 were read for the lines between them.', { timeout: 60_000 })
    } else {
      expect(got.length).toBeLessThanOrEqual(20_000)
      await expect(page.locator('[data-testid="world-notice"]')).toContainText('Showing the first ', { timeout: 60_000 })
    }
    const peaks = await app.evaluate(({ app: eapp }) =>
      eapp.getAppMetrics().map((m) => ({ process: m.name ? `${m.type}:${m.name}` : m.type, peakMB: Math.round(m.memory.peakWorkingSetSize / 1024) }))
    )
    const firstWasProvisional = r.samples.find((s) => s.n !== null)?.provisional === true
    const report = { git: withGit, firstMapMs: t.firstMapMs, completeMs: t.completeMs, longestQuietMs: t.longestQuietMs, quietBetween: t.quietBetween, firstWasProvisional, mapped: got.length, peaks }
    console.log(`[huge] ${JSON.stringify(report)}`)
    test.info().annotations.push({ type: 'huge', description: JSON.stringify(report) })
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
  })
  }

  /** What the probe counts of the 3D map drawn now; null before a map is drawn. */
  const drawnNow = (): Promise<{ frames: number; buildings: number; changing: number } | null> => page.evaluate(() => {
    const w = window as unknown as { __termpolis_world?: { drawn(): { frames: number; buildings: number; changing: number } } }
    return w.__termpolis_world?.drawn() ?? null
  })

  /** Opens the one-file scenario's world and waits until its 3D map is drawn and its changes have run. */
  async function openOneFile(): Promise<void> {
    const dir = await makeScenario('one-file', base)
    const key = await worldKey(dir, false)
    const mapped = await page.evaluate(
      (r) => (window as unknown as { termpolis: { worldMapProject: (c: string) => Promise<{ success: boolean; error?: string }> } }).termpolis.worldMapProject(r),
      key
    )
    expect(mapped.error ?? '').toBe('')
    await page.evaluate((folder) => window.dispatchEvent(new CustomEvent('termpolis:openWorld', { detail: { folder } })), dir)
    await expectPaneOpens(page)
    await expect(page.locator('[data-testid="world-canvas-host"] canvas')).toBeVisible({ timeout: 120_000 })
    await expect.poll(async () => (await drawnNow())?.buildings ?? 0, { message: 'the one-file world is drawn', timeout: 120_000 }).toBeGreaterThan(0)
    await expect.poll(async () => (await drawnNow())?.changing ?? -1, { message: 'its changes have run', timeout: 60_000 }).toBe(0)
  }

  async function closePane(): Promise<void> {
    await page.locator('[data-testid="world-close"]').click()
    await expect(pane()).toHaveCount(0)
  }

  test('an idle 3D map draws no frames under reduced motion, and starts again live when motion is allowed', async () => {
    test.setTimeout(240_000)
    await openOneFile()
    // Reduced motion, switched on while the map is open (R13): the opening turn and the looping motions stop, and
    // after a few frames to settle the map asks for none. The map before on-demand frames drew every frame.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    try {
      await page.waitForTimeout(1500)
      const f0 = (await drawnNow())!.frames
      await page.waitForTimeout(5000)
      const reducedFrames = (await drawnNow())!.frames - f0
      // Motion allowed again, live: the looping motions draw every frame once more.
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.waitForTimeout(1000)
      const m0 = (await drawnNow())!.frames
      await page.waitForTimeout(5000)
      const movingFrames = (await drawnNow())!.frames - m0
      console.log(`[idle-frames] ${JSON.stringify({ reducedMotion5s: reducedFrames, motion5s: movingFrames })}`)
      test.info().annotations.push({ type: 'idle-frames', description: JSON.stringify({ reducedMotion5s: reducedFrames, motion5s: movingFrames }) })
      expect(reducedFrames, 'frames drawn over 5 s idle under reduced motion').toBeLessThanOrEqual(6)
      expect(movingFrames, 'frames drawn over 5 s with motion allowed').toBeGreaterThan(6)
    } finally {
      await page.emulateMedia({ reducedMotion: null })
    }
    await closePane()
  })

  test('the 2D map is walked by keyboard: Tab reaches a part, Enter opens its card, Esc shuts it', async () => {
    test.setTimeout(240_000)
    await openOneFile()
    await (await toolbarControl(page, 'world-map2d')).click()
    await closeMore(page)
    const fallback = page.locator('[data-testid="world-fallback"]')
    await expect(fallback).toBeVisible()
    try {
      // Tab from the toolbar until the focus is on one of the map's parts (each is a Tab stop), at most 60 presses.
      const onPart = (): Promise<boolean> => page.evaluate(() => document.activeElement?.closest('[data-testid="world-fallback"] [data-kind="building"]') != null)
      let presses = 0
      while (!(await onPart()) && presses < 60) {
        await page.keyboard.press('Tab')
        presses++
      }
      expect(await onPart(), `Tab reaches a part of the 2D map (${presses} presses)`).toBe(true)
      await expect(page.locator('[data-testid="world-card"]')).toHaveCount(0)
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-testid="world-card"]')).toBeVisible()
      await expect(page.locator('[data-testid="world-card-body"]')).toContainText('index')
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-testid="world-card"]')).toHaveCount(0)
      // Esc shut the card and left the pane open on the 2D map.
      await expect(pane()).toBeVisible()
      await expect(fallback).toBeVisible()
    } finally {
      await (await toolbarControl(page, 'world-map2d')).click() // off again: the choice is kept between sessions
      await closeMore(page)
    }
    await expect(fallback).toHaveCount(0)
    await closePane()
  })

  test('the 3D map waits out a lost context and draws again when it comes back; a second loss shows the 2D map', async () => {
    test.setTimeout(240_000)
    await openOneFile()
    const notice = page.locator('[data-testid="world-notice"]')
    const lose = (): Promise<boolean> => page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="world-canvas-host"] canvas') as HTMLCanvasElement | null
      const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl') ?? null
      const ext = gl?.getExtension('WEBGL_lose_context') ?? null
      ;(window as unknown as { __wp2Lose?: WEBGL_lose_context | null }).__wp2Lose = ext
      ext?.loseContext()
      return ext !== null
    })
    expect(await lose(), 'the canvas has WEBGL_lose_context').toBe(true)
    await expect(notice).toHaveText('The 3D map paused: the graphics stopped. It comes back when they do.')
    const before = (await drawnNow())!.frames
    await page.waitForTimeout(1000)
    expect((await drawnNow())!.frames, 'nothing is drawn while the context is lost').toBe(before)
    await page.evaluate(() => (window as unknown as { __wp2Lose: WEBGL_lose_context }).__wp2Lose.restoreContext())
    await expect(notice).toHaveCount(0)
    await expect.poll(async () => (await drawnNow())!.frames, { message: 'the canvas draws again once restored', timeout: 30_000 }).toBeGreaterThan(before)
    await expect.poll(async () => (await drawnNow())!.buildings, { message: 'the world is built again on the restored context', timeout: 30_000 }).toBeGreaterThan(0)
    // The second loss is not waited out: the 2D map shows, and says why.
    expect(await lose()).toBe(true)
    await expect(notice).toHaveText('The graphics stopped again, so the map shows in 2D.')
    await expect(page.locator('[data-testid="world-fallback"]')).toBeVisible()
    await expect(page.locator('[data-testid="world-fallback"] [data-kind="building"]').first()).toBeVisible()
    await closePane()
  })

  test('the renderer logged no console errors and threw no page errors', async () => {
    expect(consoleErrors).toEqual([])
  })
})

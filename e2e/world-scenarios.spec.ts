/**
 * Lumopolis over the edge-case scenario fixtures (tests/e2e/fixtures/worldScenarios.ts), in the real app with one
 * launch for the whole table. Each scenario is opened as the Open folder button opens a folder: main is asked to map
 * it as a project (world:map-project), then the pane opens on it. For each row the world must have the files a
 * person can see as parts (every building's members), none of the vendored ones, and no error in the pane. Last, the
 * renderer must have logged no console error and thrown no page error.
 *
 * The rows: unicode-names (a git repository, so git's quoting of non-ASCII names is in play), non-git (a plain
 * folder, walked), untracked (a file never added), vendored (dependency, build and minified files committed) and
 * submodule (recursed into).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { quitApp, ensureE2eBuild } from './helpers/launch'
import { launchWorldApp, removeDirs, expectPaneOpens } from './helpers/world'
import { makeScenario, type ScenarioName, type ScenarioOptions } from '../tests/e2e/fixtures/worldScenarios'

let app: ElectronApplication
let page: Page
let userDataDir: string
let base: string
const consoleErrors: string[] = []

interface Row {
  name: ScenarioName
  opts?: ScenarioOptions
  /** Files that must be some building's member. */
  parts: string[]
  /** Path prefixes no member may start with. */
  absent?: string[]
}

const ROWS: Row[] = [
  { name: 'unicode-names', opts: { git: true }, parts: ['src/café.ts', 'src/日本/データ.ts', 'src/😀.ts'] },
  { name: 'non-git', parts: ['src/index.ts', 'src/a.ts', 'src/b.ts', 'src/util.ts', 'lib/format.ts', 'lib/parse.ts'] },
  { name: 'untracked', parts: ['a.ts', 'b.ts'], absent: ['ignored.ts'] },
  {
    name: 'vendored',
    parts: ['src/main.ts', 'src/util.ts'],
    absent: ['node_modules/', '.venv/', 'target/', 'dist/', 'site.min.css']
  },
  { name: 'submodule', parts: ['src/app.ts', 'libs/shared/index.ts', 'libs/shared/helper.ts'] }
]

test.beforeAll(async () => {
  ensureE2eBuild()
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-world-scenarios-'))
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
  removeDirs([userDataDir, base])
})

const pane = () => page.locator('[data-testid="world-view"]')

/** Every building member of the world main stored for `root` (its repository's top when it is in one); null: no world yet. */
async function members(root: string): Promise<string[] | null> {
  return page.evaluate(async (r) => {
    interface Doc { buildings: { members: string[] }[] }
    const api = (window as unknown as { termpolis: { gitFindRoot: (c: string) => Promise<{ success: boolean; data?: string | null }>; worldGet: (c: string) => Promise<{ success: boolean; data?: Doc | null }> } }).termpolis
    const top = await api.gitFindRoot(r)
    const res = await api.worldGet(top.success && top.data ? top.data : r)
    return res.success && res.data ? res.data.buildings.flatMap((b) => b.members) : null
  }, root)
}

test.describe.serial('Lumopolis over the scenario fixtures', () => {
  for (const row of ROWS) {
    test(`${row.name}: the world has the files a person can see${row.absent ? ', and not the vendored ones' : ''}`, async () => {
      test.setTimeout(90_000)
      const dir = await makeScenario(row.name, base, row.opts)

      // The Open folder path: main maps the folder as a project, then the pane opens on it.
      const mapped = await page.evaluate(
        (r) => (window as unknown as { termpolis: { worldMapProject: (c: string) => Promise<{ success: boolean; error?: string }> } }).termpolis.worldMapProject(r),
        dir
      )
      expect(mapped.error ?? '', `world:map-project refused ${row.name}`).toBe('')
      expect(mapped.success).toBe(true)
      await page.evaluate((folder) => window.dispatchEvent(new CustomEvent('termpolis:openWorld', { detail: { folder } })), dir)
      await expectPaneOpens(page)

      await expect.poll(() => members(dir), { message: `a world for ${row.name}`, timeout: 60_000 }).not.toBeNull()
      const got = (await members(dir))!
      for (const file of row.parts) expect(got, `${file} is a part of ${row.name}'s world`).toContain(file)
      for (const prefix of row.absent ?? []) {
        expect(got.filter((m) => m.startsWith(prefix)), `nothing under ${prefix} in ${row.name}'s world`).toEqual([])
      }
      await expect(page.locator('[data-testid="world-error"]')).toHaveCount(0)

      await page.locator('[data-testid="world-close"]').click()
      await expect(pane()).toHaveCount(0)
    })
  }

  test('the renderer logged no console errors and threw no page errors', async () => {
    expect(consoleErrors).toEqual([])
  })
})

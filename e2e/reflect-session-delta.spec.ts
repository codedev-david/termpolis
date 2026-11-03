/**
 * Reflect-session pass E2E (v1.54.5 typing hotfix, package P5) — drives the REAL Electron app.
 *
 * WHY. memory:reflect-session fires 60 s after an agent terminal goes quiet and again when one closes. It
 * used to read the transcript (up to five whole files, one of them 77.5 MiB: 229 to 296 ms of synchronous
 * parsing) BEFORE it looked at the cursor, and five terminals on one repo each ran it and reflected the same
 * turns five times. Now the cursor is read first (an unchanged transcript is not opened), only the bytes
 * after it are read, and one pass runs per (cwd, agent). The unit suites prove the modules and the handler
 * with real files and counters; this proves the same story through the real IPC, the real bundle and the
 * real fs, and that the position survives a restart.
 *
 * All it can see is what the IPC tells the renderer: whether a pass fired (an episode was reflected), and,
 * on disk, the cursor file the app writes at quit. That is enough:
 *   - an unchanged transcript does not fire, and an appended one does, exactly once;
 *   - five terminals asking at once reflect the new turns ONCE (fired for exactly one of the five);
 *   - the cursor file carries the byte position the next pass starts from, and a restarted app finds the
 *     transcript unchanged without re-reflecting it;
 *   - CONTROL: with TERMPOLIS_REFLECT_FAST=off the old whole-transcript read runs (it stores no byte
 *     position), and it still works.
 *
 * Windows only. It points os.homedir() at a scratch folder through USERPROFILE, as uninstall-disconnect
 * does; HOME is not overridden on Linux/macOS because Chromium reads it before `ready` for its own folders.
 * The unit suites cover the other platforms. Never touches the real ~/.claude.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

test.skip(
  process.platform !== 'win32',
  'needs os.homedir() pointed at a scratch folder: USERPROFILE on Windows; overriding HOME elsewhere would move Chromium\'s own folders',
)

interface Launched {
  app: ElectronApplication
  page: Page
}

type Reflected = { success: boolean; data?: { fired: boolean; lessons: number }; error?: string }

const STAMP = '2026-11-03T10:00:00.000Z'
const user = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: STAMP, sessionId: 'e2e-session' })
const assistant = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: STAMP, sessionId: 'e2e-session' })
const lines = (...l: string[]): string => l.join('\n') + '\n'

/** One dialogue the reflex will take (an assistant turn and more than 40 characters). */
const dialogue = (n: number): string =>
  lines(
    user(`round ${n}: the build is broken with a module error in the loader`),
    assistant(`round ${n}: fixed the loader import; the tests pass now and the build is green`),
  )

/** Claude Code's name for a working folder: every character but a letter or digit becomes "-". */
const mangled = (cwd: string): string => fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-')

async function launch(userDataDir: string, home: string, extraEnv: Record<string, string> = {}): Promise<Launched> {
  const session = path.join(userDataDir, 'session.json')
  if (!fs.existsSync(session)) {
    fs.writeFileSync(session, JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs' }))
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
    TERMPOLIS_TEST_AGENT_HOME: home,
    USERPROFILE: home,
    ...extraEnv,
  }
  // Electron would start as plain Node, with no `app`, if the runner had this set.
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [path.resolve('out/main/index.js'), `--user-data-dir=${userDataDir}`], env: env as Record<string, string> })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
  // Pre-dismiss the first-run onboarding modal so it doesn't trap the keyboard.
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
  return { app, page }
}

const reflect = (page: Page, terminalId: string, cwd: string): Promise<Reflected> =>
  page.evaluate(
    ([id, dir]) =>
      (window as unknown as { termpolis: { memoryReflectSession: (t: string, c: string, a: string) => Promise<unknown> } }).termpolis.memoryReflectSession(id, dir, 'claude') as Promise<Reflected>,
    [terminalId, cwd] as const,
  )

interface Scratch {
  userDataDir: string
  home: string
  cwd: string
  file: string
  remove: () => void
}

function scratch(label: string): Scratch {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-ud-`))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-home-`))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-repo-`))
  const dir = path.join(home, '.claude', 'projects', mangled(cwd))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, dialogue(1))
  return {
    userDataDir,
    home,
    cwd,
    file,
    remove: () => {
      for (const d of [userDataDir, home, cwd]) {
        try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    },
  }
}

/** What the app wrote at quit: the cursors by transcript. */
function readCursors(userDataDir: string): Array<{ count: number; hash: string; pos?: { file: string; size: number; offset?: number } }> {
  const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, 'session-cursors.json'), 'utf8')) as Record<string, never>
  return Object.values(raw)
}

const sameFile = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

test.beforeAll(() => {
  ensureE2eBuild()
})

test('a pass reads only what was added, five terminals share one pass, and the position survives a restart', async () => {
  test.setTimeout(300_000)
  const s = scratch('reflect-fast')
  let l: Launched | undefined
  try {
    l = await launch(s.userDataDir, s.home)

    // First look: the whole transcript is new.
    const first = await reflect(l.page, 't1', s.cwd)
    expect(first, JSON.stringify(first)).toMatchObject({ success: true, data: { fired: true } })

    // Nothing changed: nothing to reflect (the transcript is not even opened).
    expect(await reflect(l.page, 't1', s.cwd)).toEqual({ success: true, data: { fired: false, lessons: 0 } })

    // One dialogue appended: exactly that is reflected, once.
    fs.appendFileSync(s.file, dialogue(2))
    expect(await reflect(l.page, 't1', s.cwd)).toMatchObject({ success: true, data: { fired: true } })
    expect(await reflect(l.page, 't1', s.cwd)).toEqual({ success: true, data: { fired: false, lessons: 0 } })

    // Five terminals on the one repo ask at once about a new dialogue: it is reflected ONCE.
    fs.appendFileSync(s.file, dialogue(3))
    const five = await Promise.all(Array.from({ length: 5 }, (_, i) => reflect(l!.page, `t${i}`, s.cwd)))
    expect(five.every((r) => r.success), JSON.stringify(five)).toBe(true)
    expect(five.filter((r) => r.data?.fired).length, JSON.stringify(five)).toBe(1)

    await quitApp(l.app)
    l = undefined

    // The cursor the app wrote at quit carries the position the next pass starts from.
    const cursors = readCursors(s.userDataDir)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].pos, JSON.stringify(cursors[0])).toBeDefined()
    expect(sameFile(cursors[0].pos!.file, s.file)).toBe(true)
    expect(cursors[0].pos!.offset).toBe(fs.statSync(s.file).size)

    // A restarted app finds the transcript unchanged (no re-reflection), and carries on from the position.
    l = await launch(s.userDataDir, s.home)
    expect(await reflect(l.page, 'after-restart', s.cwd)).toEqual({ success: true, data: { fired: false, lessons: 0 } })
    fs.appendFileSync(s.file, dialogue(4))
    expect(await reflect(l.page, 'after-restart', s.cwd)).toMatchObject({ success: true, data: { fired: true } })
  } finally {
    if (l) await quitApp(l.app)
    s.remove()
  }
})

test('CONTROL: with TERMPOLIS_REFLECT_FAST=off the old whole-transcript read runs (no byte position is stored) and still works', async () => {
  test.setTimeout(240_000)
  const s = scratch('reflect-off')
  let l: Launched | undefined
  try {
    l = await launch(s.userDataDir, s.home, { TERMPOLIS_REFLECT_FAST: 'off' })
    expect(await reflect(l.page, 't1', s.cwd)).toMatchObject({ success: true, data: { fired: true } })
    expect(await reflect(l.page, 't1', s.cwd)).toEqual({ success: true, data: { fired: false, lessons: 0 } })
    fs.appendFileSync(s.file, dialogue(2))
    expect(await reflect(l.page, 't1', s.cwd)).toMatchObject({ success: true, data: { fired: true } })

    // Recorded, not asserted: how many of five simultaneous terminals reflected the same turns. The old
    // path has no shared pass, so it is up to five (it depends on how the reads interleave).
    fs.appendFileSync(s.file, dialogue(3))
    const five = await Promise.all(Array.from({ length: 5 }, (_, i) => reflect(l!.page, `t${i}`, s.cwd)))
    expect(five.every((r) => r.success), JSON.stringify(five)).toBe(true)
    test.info().annotations.push({ type: 'fired-of-five-with-the-switch-off', description: String(five.filter((r) => r.data?.fired).length) })

    await quitApp(l.app)
    l = undefined
    const cursors = readCursors(s.userDataDir)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].pos, JSON.stringify(cursors[0])).toBeUndefined() // the old path never records one
    expect(cursors[0].count).toBeGreaterThan(0)
  } finally {
    if (l) await quitApp(l.app)
    s.remove()
  }
})

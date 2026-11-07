/**
 * Conversation ingest E2E (v1.54.5 typing hotfix, package P4) — drives the REAL Electron app.
 *
 * WHY. The memory indexer re-read and re-parsed WHOLE transcripts (subagent transcripts included) on the main
 * thread every 90 s and on every drain tick, to find out that nothing was new; with Defender scanning every
 * open, each read stalled the thread that echoes keystrokes. Now an unchanged transcript is skipped from a
 * persisted watermark (size + mtime, written only after a complete ingest), a pass has a byte budget and
 * time slices, and a "Learn from conversations" switch (Settings, on by default) stops it entirely.
 *
 * The unit suites prove the modules and the handler wiring with real files and counters. This proves the same
 * story through the real IPC, the real bundle and the real fs, where only CI can run it:
 *   - the first "index everything" reads the transcripts and the app keeps a watermark file in userData;
 *   - the second one skips every unchanged file (unchanged == files, filesScanned == 0) and, after one
 *     appended line, reads exactly that file;
 *   - with "Learn from conversations" OFF the same call refuses and reads nothing (filesScanned stays 0,
 *     nothing new is stored), the setting survives a restart, and turning it back ON works again;
 *   - CONTROL: with TERMPOLIS_INGEST_FAST=off the old whole-corpus pass runs: every pass re-reads every file
 *     (no `unchanged` counter), and no watermark file is written.
 *
 * Windows only. It points os.homedir() at a scratch folder through USERPROFILE, as uninstall-disconnect and
 * reflect-session-delta do; HOME is not overridden on Linux/macOS because Chromium reads it before `ready`
 * for its own folders. The unit suites cover the other platforms. Never touches the real ~/.claude, and every
 * transcript is synthetic.
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

interface IngestStats {
  filesScanned: number
  chunksWritten: number
  chunksSkipped: number
  truncated: boolean
  unchanged?: number
  bytesRead?: number
  stop?: string
}
type Ingested = { success: boolean; data?: IngestStats; error?: string }

const STAMP = '2026-11-03T10:00:00.000Z'
const user = (text: string, session: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: STAMP, sessionId: session, cwd: '/synthetic/repo' })
const assistant = (text: string, session: string): string =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: STAMP, sessionId: session })
const lines = (...l: string[]): string => l.join('\n') + '\n'

/** A small synthetic session whose text is distinct per (session, round): distinct chunks, distinct hashes. */
const session = (id: number, rounds = 3): string =>
  lines(
    ...Array.from({ length: rounds }, (_, r) => [
      user(`session ${id} round ${r}: the loader import fails with a module error in the build step`, `e2e-${id}`),
      assistant(`session ${id} round ${r}: fixed the import path; the tests pass now and the build is green again`, `e2e-${id}`),
    ]).flat(),
  )

async function launch(userDataDir: string, home: string, extraEnv: Record<string, string> = {}): Promise<Launched> {
  const sessionFile = path.join(userDataDir, 'session.json')
  if (!fs.existsSync(sessionFile)) {
    fs.writeFileSync(sessionFile, JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'powershell', viewMode: 'tabs' }))
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

/** The real "index everything" IPC (the same path the Memory panel uses). */
const ingest = (page: Page): Promise<Ingested> =>
  page.evaluate(() => (window as unknown as { termpolis: { memoryIngestConversations: () => Promise<unknown> } }).termpolis.memoryIngestConversations() as Promise<Ingested>)

const getLearn = (page: Page): Promise<{ success: boolean; data?: boolean }> =>
  page.evaluate(() => (window as unknown as { termpolis: { memoryGetLearnConversations: () => Promise<unknown> } }).termpolis.memoryGetLearnConversations() as Promise<{ success: boolean; data?: boolean }>)

const setLearn = (page: Page, value: boolean): Promise<{ success: boolean }> =>
  page.evaluate((v) => (window as unknown as { termpolis: { memorySetLearnConversations: (b: boolean) => Promise<unknown> } }).termpolis.memorySetLearnConversations(v) as Promise<{ success: boolean }>, value)

interface Scratch {
  userDataDir: string
  home: string
  files: string[]
  /** Write the synthetic transcripts (done at once by default; a test that must not race the app's own first pass does it later). */
  writeSessions: () => void
  remove: () => void
}

const SESSIONS = 6

function scratch(label: string, writeNow = true): Scratch {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-ud-`))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-home-`))
  const dir = path.join(home, '.claude', 'projects', 'C--synthetic-repo')
  fs.mkdirSync(dir, { recursive: true })
  const files: string[] = []
  const writeSessions = (): void => {
    for (let i = 0; i < SESSIONS; i++) {
      const f = path.join(dir, `session-${i}.jsonl`)
      fs.writeFileSync(f, session(i))
      files.push(f)
    }
  }
  if (writeNow) writeSessions()
  return {
    userDataDir,
    home,
    files,
    writeSessions,
    remove: () => {
      for (const d of [userDataDir, home]) {
        try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    },
  }
}

const watermarkFile = (userDataDir: string): string => path.join(userDataDir, 'ingest-watermark.json')

test.beforeAll(() => {
  ensureE2eBuild()
})

test('an unchanged transcript is skipped, an appended one is read alone, and the watermark is kept in userData', async () => {
  test.setTimeout(300_000)
  const s = scratch('ingest-fast', false)
  let l: Launched | undefined
  try {
    l = await launch(s.userDataDir, s.home)
    // The app's own indexer makes a first pass 10 s after launch and the next one 90 s after that. Let the first go by over
    // an EMPTY folder (it finds nothing, so it marks nothing), and only then write the transcripts: every pass counted below
    // is then a manual one, and none of them races with a background pass.
    await l.page.waitForTimeout(13_000)
    s.writeSessions()

    // First pass: everything is new. (An unlocked, empty memory is what a fresh scratch userData has.)
    const first = await ingest(l.page)
    expect(first.success, first.error).toBe(true)
    expect(first.data!.filesScanned).toBe(s.files.length)
    // Every file gave at least one chunk and none was taken for a duplicate. One synthetic session (6 short turns, about
    // 600 characters, one working folder) fits in ONE chunk of 2,000, so 6 files make exactly 6: "more chunks than files"
    // was never what the chunker does, and CI's first run of this spec said so (received 6).
    expect(first.data!.chunksWritten).toBeGreaterThanOrEqual(s.files.length)
    expect(first.data!.chunksSkipped).toBe(0)
    expect(first.data!.unchanged ?? 0).toBe(0)
    await expect.poll(() => fs.existsSync(watermarkFile(s.userDataDir)), { timeout: 15_000 }).toBe(true)

    // Second pass: every file is unchanged, so none is opened.
    const second = await ingest(l.page)
    expect(second.success, second.error).toBe(true)
    expect(second.data).toMatchObject({ filesScanned: 0, chunksWritten: 0, truncated: false, unchanged: s.files.length })

    // One appended line: exactly that file is read again, and what it adds is stored once.
    fs.appendFileSync(s.files[2], lines(user('session 2 extra: one more question about the release notes', 'e2e-2'), assistant('session 2 extra: noted and written up in the changelog', 'e2e-2')))
    const third = await ingest(l.page)
    expect(third.success, third.error).toBe(true)
    expect(third.data!.filesScanned).toBe(1)
    expect(third.data!.unchanged).toBe(s.files.length - 1)
    expect(third.data!.chunksWritten).toBeGreaterThanOrEqual(1)

    // And it is quiet again.
    const fourth = await ingest(l.page)
    expect(fourth.data).toMatchObject({ filesScanned: 0, chunksWritten: 0, unchanged: s.files.length })

    // The marks survive a restart: a new process over the same userData skips everything. (Its own first background pass is
    // 10 s after its launch, and it would skip everything too: nothing here depends on which pass comes first.)
    await quitApp(l.app)
    l = await launch(s.userDataDir, s.home)
    const restarted = await ingest(l.page)
    expect(restarted.success, restarted.error).toBe(true)
    expect(restarted.data).toMatchObject({ filesScanned: 0, unchanged: s.files.length })
  } finally {
    await quitApp(l?.app)
    s.remove()
  }
})

test('"Learn from conversations" off: a pass reads nothing, the setting survives a restart, and on again learns', async () => {
  test.setTimeout(300_000)
  // The transcripts are written only once the switch is off, so the app's own indexer (first pass 10 s after launch)
  // has nothing to learn from before then, however slowly the app starts.
  const s = scratch('ingest-pause', false)
  let l: Launched | undefined
  try {
    l = await launch(s.userDataDir, s.home)
    expect(await getLearn(l.page)).toMatchObject({ success: true, data: true }) // on by default

    expect(await setLearn(l.page, false)).toMatchObject({ success: true })
    s.writeSessions()
    const off = await ingest(l.page)
    expect(off.success).toBe(false) // refused with a plain message, and nothing was read
    expect(off.error).toMatch(/turned off/i)
    expect(fs.existsSync(watermarkFile(s.userDataDir))).toBe(false)

    // The choice is on disk and survives a restart (it is the same store as the other memory settings).
    const saved = JSON.parse(fs.readFileSync(path.join(s.userDataDir, 'memory-settings.json'), 'utf8')) as { learnFromConversations?: boolean }
    expect(saved.learnFromConversations).toBe(false)
    await quitApp(l.app)
    l = await launch(s.userDataDir, s.home)
    expect(await getLearn(l.page)).toMatchObject({ success: true, data: false })
    expect((await ingest(l.page)).success).toBe(false)

    // Back on: it learns again, from where it left off (everything, here).
    expect(await setLearn(l.page, true)).toMatchObject({ success: true })
    const on = await ingest(l.page)
    expect(on.success, on.error).toBe(true)
    expect(on.data!.filesScanned).toBe(s.files.length)
    expect(on.data!.chunksWritten).toBeGreaterThan(0)
  } finally {
    await quitApp(l?.app)
    s.remove()
  }
})

test('CONTROL: with TERMPOLIS_INGEST_FAST=off every pass re-reads every file and no watermark is written (1.54.4 behaviour)', async () => {
  test.setTimeout(300_000)
  const s = scratch('ingest-legacy')
  let l: Launched | undefined
  try {
    l = await launch(s.userDataDir, s.home, { TERMPOLIS_INGEST_FAST: 'off' })
    const first = await ingest(l.page)
    expect(first.success, first.error).toBe(true)
    expect(first.data!.filesScanned).toBe(s.files.length)
    const second = await ingest(l.page)
    expect(second.success, second.error).toBe(true)
    expect(second.data!.filesScanned).toBe(s.files.length) // read again: nothing is skipped
    expect(second.data!.chunksWritten).toBe(0) // the store's own hash dedup is what keeps it idempotent
    expect(second.data!.unchanged).toBeUndefined()
    expect(fs.existsSync(watermarkFile(s.userDataDir))).toBe(false)
    // The pause switch still works under the kill switch.
    expect(await setLearn(l.page, false)).toMatchObject({ success: true })
    expect((await ingest(l.page)).success).toBe(false)
  } finally {
    await quitApp(l?.app)
    s.remove()
  }
})

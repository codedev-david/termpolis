// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import { readFile, stat } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { claudeLaunchEnv, CONTEXT_WINDOW_VAR, type LaunchEnvSources } from '../../src/main/headroom/shapingEnv'
import { readClaudeWindowSettings, claudeWindowSettingsFiles } from '../../src/main/headroom/shapingEnvReader'

/**
 * What the opt-in context window costs a Claude launch (decision D11: performance is a hard gate).
 *
 * The work runs in the main process when a terminal is created, so the question is whether it can hold
 * up a terminal or the UI. The answers, none of which is a stopwatch on its own:
 *
 *  - Off, which is everyone who has not chosen a window: no file is opened and no timer is made
 *    (headroomLaunchEnv.test.ts counts both), and what is left is a few function calls. Measured
 *    here against the launch as it was before this release.
 *  - On: at most three small files, read together through the asynchronous calls, so the main thread
 *    is never held (the reader has no synchronous file call; headroomShapingEnvReader.test.ts scans
 *    for one, and the test below shows it hands control back while a read is pending). What it adds
 *    is the wait for those reads, bounded at 1.5 seconds by a deadline whatever the disk does. Measured
 *    here as a multiple of the same reads with nothing around them.
 *
 * Every timing comparison below is relative: same process, alternating, best of several rounds, against
 * a bound far wider than the measured gap, so load on the machine moves both sides together and cannot
 * make it fail. (Measured when this was written, on a Windows laptop with real-time scanning and other work
 * running: Off 0.5 to 8 microseconds a launch; three 10 KB files read bare in 3.5 to 9.5 ms and through the
 * helper in 5 to 15 ms, the best of each round; the spread is the machine's.)
 */

const VAR = CONTEXT_WINDOW_VAR
const PROXY = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:41999', TERMPOLIS_HEADROOM_PROXY: 'http://127.0.0.1:41999' }

/** The launch as it was before this release: the proxy route, or nothing. */
const before = (proxyEnv: () => Record<string, string> | null): Record<string, string> | undefined => proxyEnv() ?? undefined

/** Mean milliseconds per run of `fn` over `n` runs. */
async function mean(fn: () => Promise<unknown> | unknown, n: number): Promise<number> {
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i++) await fn()
  return Number(process.hrtime.bigint() - t0) / 1e6 / n
}

describe('what the context window costs a launch', () => {
  let root: string
  let userDir: string
  let project: string
  let files: string[]

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-launchcost-'))
    userDir = path.join(root, 'user-claude')
    project = path.join(root, 'project')
    fs.mkdirSync(userDir, { recursive: true })
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
    // Files of a size real ones reach: a long permission list and a hook.
    const big = { env: { API_TIMEOUT_MS: '1200000' }, permissions: { allow: Array.from({ length: 400 }, (_, i) => `Bash(command-${i} *)`) }, hooks: { SessionStart: [{ command: 'x'.repeat(2000) }] } }
    files = claudeWindowSettingsFiles(userDir, project)
    for (const f of files) fs.writeFileSync(f, JSON.stringify(big), 'utf8')
  })
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const sources = (cap: number, over: Partial<LaunchEnvSources> = {}): LaunchEnvSources => ({
    settings: () => ({ contextCap: cap }),
    proxyEnv: () => PROXY,
    env: {},
    readSettings: (dir) => readClaudeWindowSettings(userDir, dir),
    ...over,
  })

  it('reads three files, as the figures below assume', () => {
    expect(files).toHaveLength(3)
    for (const f of files) expect(fs.statSync(f).size).toBeGreaterThan(5_000)
  })

  it('gives the same launch as before to anyone who has not turned it on, with the proxy up or down', async () => {
    for (const proxyEnv of [() => PROXY, () => null] as const) {
      expect(await claudeLaunchEnv(project, sources(0, { proxyEnv }))).toEqual(before(proxyEnv))
    }
  })

  it('adds exactly one variable to a launch when it is on, and changes nothing else in it', async () => {
    const out = await claudeLaunchEnv(project, sources(300_000))
    expect(out).toEqual({ ...PROXY, [VAR]: '300000' })
    expect(Object.keys(out ?? {}).filter((k) => !(k in PROXY))).toEqual([VAR])
  })

  it('does no reading at all while Off, which is what makes it cost a launch nothing', async () => {
    // The mechanism, exactly: with the choice off the settings are not asked for, so there is no I/O to cost anything.
    // This is the assertion that cannot flake; the timing below only guards the same thing from the other side.
    const readSettings = vi.fn(async () => ({ env: null, savedWindow: false }))
    expect(await claudeLaunchEnv(project, sources(0, { readSettings }))).toEqual(before(() => PROXY))
    expect(readSettings).not.toHaveBeenCalled()
  })

  it('costs a launch next to nothing while Off, measured against the launch it replaced in the same process', async () => {
    // Relative, as every committed timing is: the launch as it was before the choice existed against the launch with
    // the choice Off, best of five rounds of 2,000 each, alternating. Off does no I/O, so it is a function call or two
    // more than the old launch (measured 0.3 to 0.7 microseconds against 0.07 to 0.11). The bound allows 50 times the
    // old launch and half a millisecond besides; a read or a parse that found its way onto the Off path costs a
    // hundred times that, and no amount of load on the machine moves a best-of-five that far.
    let old = Infinity
    let off = Infinity
    for (let r = 0; r < 5; r++) {
      old = Math.min(old, await mean(() => before(() => PROXY), 2000))
      off = Math.min(off, await mean(() => claudeLaunchEnv(project, sources(0)), 2000))
    }
    expect(off).toBeLessThanOrEqual(old * 50 + 0.5)
  })

  it('costs a launch a small multiple of the bare reads when On, and never more than its own deadline', async () => {
    const bare = (): Promise<unknown> => Promise.all(files.map(async (f) => {
      const info = await stat(f)
      return info.isFile() ? JSON.parse(await readFile(f, 'utf8')) : null
    }))
    for (let i = 0; i < 5; i++) { await bare(); await claudeLaunchEnv(project, sources(300_000)) } // warm the file cache
    let bareBest = Infinity
    let onBest = Infinity
    for (let r = 0; r < 6; r++) {
      bareBest = Math.min(bareBest, await mean(bare, 10))
      onBest = Math.min(onBest, await mean(() => claudeLaunchEnv(project, sources(300_000)), 10))
    }
    // Measured about 1 to 2 times the bare reads on a quiet machine, and up to 18 times in a full parallel run under
    // coverage, where a mean of ten reads is mostly the other workers. So the bound is wide: 25 times plus 100 ms is
    // past anything load does and still under what a real mistake costs (a parse of something large, or reads made
    // one after another across many files). The structure that makes it cheap is pinned exactly, not timed: the
    // reads are issued together (headroomShapingEnvReaderFs), nothing is called synchronously (this file, below),
    // and the deadline that bounds a read that hangs is tested with fake timers (headroomShapingEnv).
    expect(onBest).toBeLessThan(bareBest * 25 + 100)
  })

  it('hands control back while the files are still being read: it waits on them, it does not do them itself', async () => {
    // The file calls are replaced by promises the test settles by hand. A reader that did its work with synchronous calls could
    // not be caught waiting on them, and would have finished before this line.
    const { vi } = await import('vitest')
    vi.resetModules()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    vi.doMock('fs/promises', () => ({
      stat: async (f: string) => { calls.push(`stat ${path.basename(f)}`); await gate; return { isFile: () => true, size: 2 } },
      readFile: async (f: string) => { calls.push(`read ${path.basename(f)}`); return '{}' },
    }))
    try {
      const { readClaudeWindowSettings: read } = await import('../../src/main/headroom/shapingEnvReader')
      let settled = false
      const pending = read(userDir, project).then((v) => { settled = true; return v })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(settled).toBe(false)
      expect(calls.filter((c) => c.startsWith('stat '))).toHaveLength(3) // all three were asked for before any answer came
      release()
      expect(await pending).toEqual({ env: null, savedWindow: false })
      expect(settled).toBe(true)
    } finally {
      vi.doUnmock('fs/promises')
      vi.resetModules()
    }
  })
})

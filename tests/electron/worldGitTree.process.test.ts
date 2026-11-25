// @vitest-environment node
// WP4b F-R6, the real-process proof: a Cancel (or a timeout) of a git run in the world host ends git's whole process
// tree, not only git. A sign-in runs git, and git runs its login helper (Git Credential Manager can hold a window up);
// killing git alone left that helper running. The stand-in for git is a node script (never git) that starts a child of
// its own and sleeps. Liveness is checked with process.kill(pid, 0) on the pids the stand-in reports about itself, never
// by listing processes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeExecFile } from '../../src/main/world/gitSource'

let dir = ''
let script = ''
let seq = 0
const unverified = new Set<number>()

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-git-tree-'))
  script = join(dir, 'git.cjs')
  writeFileSync(script, [
    "const { spawn } = require('child_process')",
    "const { renameSync, writeFileSync } = require('fs')",
    // The helper keeps git's stderr open, as a login helper that inherits it does. On Windows it is spawned detached, out of
    // this node's own libuv job (which would end it with the stand-in, as real git's job never would); on POSIX it stays in
    // the stand-in's process group, as git's helper does.
    "const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'inherit', windowsHide: true, detached: process.platform === 'win32' })",
    "writeFileSync(process.env.TP_PIDS + '.tmp', JSON.stringify({ git: process.pid, helper: helper.pid }))",
    "renameSync(process.env.TP_PIDS + '.tmp', process.env.TP_PIDS)",
    'setTimeout(() => {}, 120000)',
  ].join('\n'))
})

afterAll(() => {
  // Anything a failed run left behind goes, so a red run does not leave sleepers on the runner.
  for (const pid of unverified) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
})

function isAlive(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false
    } catch { /* gone: kill() says so */ }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitDead(pid: number, withinMs = 10_000): Promise<boolean> {
  const until = Date.now() + withinMs
  while (Date.now() < until) {
    if (!isAlive(pid)) { unverified.delete(pid); return true }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

async function readPids(file: string, run: Promise<unknown>): Promise<{ git: number; helper: number }> {
  let ended = false
  void run.then(() => { ended = true })
  const until = Date.now() + 30_000
  while (Date.now() < until && !ended) {
    try {
      const pids = JSON.parse(readFileSync(file, 'utf8')) as { git: number; helper: number }
      unverified.add(pids.git)
      unverified.add(pids.helper)
      return pids
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(ended ? 'the run ended before the stand-in started' : 'the stand-in never started')
}

const start = (opts: { signal?: AbortSignal; timeout?: number }) => {
  const pidFile = join(dir, `pids-${++seq}.json`)
  const run = nodeExecFile(process.execPath, [script], { env: { ...process.env, TP_PIDS: pidFile }, timeout: opts.timeout ?? 60_000, ...(opts.signal ? { signal: opts.signal } : {}) })
  return { run, pids: readPids(pidFile, run) }
}

describe('a git run in the world host ends its whole process tree', () => {
  it('a Cancel ends git and the helper it started, and answers once both are gone', async () => {
    const ctl = new AbortController()
    const { run, pids } = start({ signal: ctl.signal })
    const { git, helper } = await pids
    const at = Date.now()
    ctl.abort()
    const r = await run
    expect(r.code).not.toBe(0)
    expect(await waitDead(git)).toBe(true)
    expect(await waitDead(helper)).toBe(true)
    // The helper no longer holds git's stderr open until the kill grace (10 s) runs out.
    expect(Date.now() - at).toBeLessThan(8_000)
  }, 60_000)

  it('a timeout ends the helper too', async () => {
    const { run, pids } = start({ timeout: 3_000 })
    const { git, helper } = await pids
    const r = await run
    expect(r).toEqual({ code: 1, stderr: 'it took too long' })
    expect(await waitDead(git)).toBe(true)
    expect(await waitDead(helper)).toBe(true)
  }, 60_000)
})

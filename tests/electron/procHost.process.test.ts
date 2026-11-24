// The real-process proof that cancelling a labelling exec ends the whole tree. The stand-in for
// `claude -p` is a node script, never an agent CLI: it starts a child of its own that inherits its
// stdout and stderr, the way an agent's tool subprocess does, prints half an answer and sleeps. The
// exec goes through execCaptureOffThread with no proc host, so it takes the same runExec the host runs.
//
// The stand-ins sleep longer than any test here may run, so a pid the cleanup kills is always
// still theirs and never a recycled one. Liveness is read from the pids they report themselves:
// nothing here lists processes.
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest'
import { _resetProcClientForTests, execCaptureOffThread } from '../../src/main/procClient'
import { taskkillPath } from '../../src/main/processTree'

let dir = ''
let script = ''
let seq = 0
const unverified = new Set<number>()

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-proc-tree-'))
  script = join(dir, 'labeller.cjs')
  writeFileSync(script, [
    "const { spawn } = require('child_process')",
    "const { renameSync, writeFileSync } = require('fs')",
    // On Windows libuv puts a node process's children in a job that dies with it, so a plain child
    // would die with the stand-in and prove nothing. An agent's deeper descendants are in no such job:
    // detached (Windows only) keeps this one out of it, while it stays the stand-in's child for
    // taskkill /T. On POSIX it must stay in the stand-in's group, which is what gets signalled.
    "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'inherit', windowsHide: true, detached: process.platform === 'win32' })",
    "process.stdout.write('{\"labels\": [\"half an answer\"\\n')",
    // Only a request answered by its pipes closing carries this: the backstop answers with none.
    "process.stderr.write('labeller up\\n')",
    "writeFileSync(process.argv[2] + '.tmp', JSON.stringify({ labeller: process.pid, grandchild: grandchild.pid }))",
    "renameSync(process.argv[2] + '.tmp', process.argv[2])",
    'setTimeout(() => {}, 120000)',
  ].join('\n'))
})

function isAlive(pid: number): boolean {
  if (process.platform === 'linux') {
    // A zombie still answers kill(pid, 0) until it is reaped, but it is already dead.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false
    } catch { /* no such process: kill() below says so */ }
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
    if (!isAlive(pid)) {
      unverified.delete(pid)
      return true
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

async function readPids(file: string, run: Promise<unknown>): Promise<{ labeller: number; grandchild: number }> {
  let ended = false
  void run.then(() => { ended = true })
  const until = Date.now() + 30_000
  while (Date.now() < until && !ended) {
    try {
      const pids = JSON.parse(readFileSync(file, 'utf8')) as { labeller: number; grandchild: number }
      unverified.add(pids.labeller)
      unverified.add(pids.grandchild)
      return pids
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(ended ? 'the exec ended before the stand-in started' : 'the stand-in never started')
}

afterEach(() => {
  // A failed test must not leave its stand-ins behind.
  for (const pid of unverified) {
    if (process.platform === 'win32') {
      spawnSync(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
    } else {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  unverified.clear()
  _resetProcClientForTests()
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('a labelling exec with tree, on real processes', () => {
  it('a cancel ends the stand-in and its grandchild, and the exec settles as cancelled with no output', async () => {
    const pidFile = join(dir, `pids-${++seq}.json`)
    const ac = new AbortController()
    const run = execCaptureOffThread(process.execPath, [script, pidFile], { tree: true, timeout: 60_000 }, ac.signal)
    const { labeller, grandchild } = await readPids(pidFile, run)
    expect(isAlive(labeller)).toBe(true)
    expect(isAlive(grandchild)).toBe(true)
    ac.abort()
    const r = await run
    // Half an answer was printed, and none of it comes back: nothing from a cancelled run is labelled.
    expect(r.stdout).toBe('')
    expect(r.error).toMatchObject({ message: 'cancelled', code: 'ABORT_ERR' })
    // Settled by the tree's pipes closing, which means the whole tree let go of them, not by the
    // backstop (which answers with no stderr) or the 60 s timeout (which reads as a timeout).
    expect(r.stderr).toContain('labeller up')
    expect(await waitDead(labeller)).toBe(true)
    expect(await waitDead(grandchild)).toBe(true)
  }, 60_000)

  it('the timeout ends the whole tree too, not only the direct child', async () => {
    const pidFile = join(dir, `pids-${++seq}.json`)
    // Long enough for a cold node start and the pid file on a slow runner, before the timeout fires.
    const run = execCaptureOffThread(process.execPath, [script, pidFile], { tree: true, timeout: 10_000 })
    const { labeller, grandchild } = await readPids(pidFile, run)
    const r = await run
    expect(r.error).toMatchObject({ message: 'timed out after 10000ms', killed: true, signal: 'SIGTERM' })
    // A timeout keeps what was printed, and the pipes closing (not the backstop) answered it.
    expect(r.stdout).toContain('half an answer')
    expect(r.stderr).toContain('labeller up')
    expect(await waitDead(labeller)).toBe(true)
    expect(await waitDead(grandchild)).toBe(true)
  }, 60_000)
})

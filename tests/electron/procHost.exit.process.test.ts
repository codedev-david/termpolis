// The real-process proof that a labelling run does not outlive the proc host that started it. The host
// here is src/main/procHost.ts itself, bundled and forked as a plain node child (a utilityProcess needs
// Electron), with the same exit handlers the real host installs and the same messages main sends it.
// The run is a node stand-in for `claude -p` that starts a child of its own and sleeps.
//
// What the fork harness shares with a utilityProcess: the host's signal and exit handlers, which are
// Node's own. What it does not: the fork's IPC channel stands in for parentPort, and a utilityProcess has
// no 'disconnect', so nothing here tests the loss of main (procHost.ts says why nothing handles it).
//
//   * macOS and Linux: the run is a detached process group, so nothing ends it with the host unless
//     someone signals it. A host told to go (SIGTERM or SIGINT) signals it itself; a host killed
//     outright cannot, and main signals the group the host reported.
//   * Windows: the run is in the host's kill-on-close job, and ends with the host however it ends.
//
// The stand-ins sleep longer than any test here may run, so a pid the cleanup kills is always still
// theirs and never a recycled one. Liveness is read from the pids they report themselves: nothing here
// lists processes.
import { fork, spawnSync, type ChildProcess } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { build } from 'esbuild'
import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest'
import {
  _resetProcClientForTests,
  _trackedGroupsForTests,
  execCaptureOffThread,
  setProcSpawner,
  type ProcTransport,
} from '../../src/main/procClient'
import type { ProcExecMsg, ProcResult, ProcTreeMsg } from '../../src/main/procHost'
import { taskkillPath } from '../../src/main/processTree'

const isWin = process.platform === 'win32'
let dir = ''
let labeller = ''
let runner = ''
let seq = 0
const unverified = new Set<number>()
const hosts: ChildProcess[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tp-proc-exit-'))
  const bundle = join(dir, 'procHost.cjs')
  await build({
    entryPoints: [join(__dirname, '../../src/main/procHost.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
  })
  runner = join(dir, 'host.cjs')
  writeFileSync(runner, [
    `const host = require(${JSON.stringify(bundle)})`,
    'host.installHostExitHandlers(process)',
    'process.on("message", (m) => {',
    '  const send = (x) => process.send(x)',
    '  void host.handleProcMessage(m, send).then((r) => { if (r) send(r) })',
    '})',
  ].join('\n'))
  labeller = join(dir, 'labeller.cjs')
  writeFileSync(labeller, [
    "const { spawn } = require('child_process')",
    "const { renameSync, writeFileSync } = require('fs')",
    // An ordinary child, the way an agent's tool subprocess is one: in the stand-in's process group on
    // POSIX, and in the stand-in's own kill-on-close job on Windows.
    "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'inherit', windowsHide: true })",
    "writeFileSync(process.argv[2] + '.tmp', JSON.stringify({ labeller: process.pid, grandchild: grandchild.pid }))",
    "renameSync(process.argv[2] + '.tmp', process.argv[2])",
    'setTimeout(() => {}, 120000)',
  ].join('\n'))
}, 60_000)

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

async function readPids(file: string): Promise<{ labeller: number; grandchild: number }> {
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    try {
      const pids = JSON.parse(readFileSync(file, 'utf8')) as { labeller: number; grandchild: number }
      unverified.add(pids.labeller)
      unverified.add(pids.grandchild)
      return pids
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('the stand-in never started')
}

/** Fork a host. Its pid joins the cleanup until it is seen to exit. */
function forkHost(): { host: ChildProcess; exited: Promise<void> } {
  const host = fork(runner, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true })
  hosts.push(host)
  const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()))
  return { host, exited }
}

function labelRequest(id: number, pidFile: string): ProcExecMsg {
  return { kind: 'exec', id, bin: process.execPath, args: [labeller, pidFile], opts: { tree: true, timeout: 60_000 } }
}

afterEach(() => {
  // A failed test must not leave its stand-ins, or a host, behind.
  for (const host of hosts) if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL')
  hosts.length = 0
  for (const pid of unverified) {
    if (isWin) {
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

describe.skipIf(isWin)('a host told to go ends its runs first (macOS and Linux)', () => {
  it.each([
    ['a SIGTERM', (host: ChildProcess) => { host.kill('SIGTERM') }],
    ['a SIGINT', (host: ChildProcess) => { host.kill('SIGINT') }],
  ])('on %s, the run\'s whole group ends with it', async (_how, tell) => {
    const { host, exited } = forkHost()
    const pidFile = join(dir, `pids-${++seq}.json`)
    const reports: Array<ProcTreeMsg | ProcResult> = []
    host.on('message', (m) => { reports.push(m as ProcTreeMsg | ProcResult) })
    host.send(labelRequest(1, pidFile))
    const { labeller: lab, grandchild } = await readPids(pidFile)
    // The host reported the group, which the run leads.
    await vi.waitFor(() => expect(reports).toContainEqual({ kind: 'tree', id: 1, pid: lab }), { timeout: 5_000, interval: 20 })
    tell(host)
    expect(await waitDead(lab)).toBe(true)
    expect(await waitDead(grandchild)).toBe(true)
    await exited
  }, 60_000)
})

describe('a host that is killed outright takes no run with it', () => {
  it(isWin
    ? 'Windows: the run and its child end with the host, through its kill-on-close job'
    : 'macOS and Linux: main ends the group the host reported', async () => {
    const { host, exited } = forkHost()
    const transport: ProcTransport = {
      pid: host.pid,
      postMessage: (m) => { host.send(m) },
      onMessage: (cb) => { host.on('message', (m) => cb(m as ProcResult | ProcTreeMsg)) },
      onExit: (cb) => { host.once('exit', (code) => cb(code ?? -1)) },
      kill: () => { host.kill() },
    }
    setProcSpawner(() => transport)
    const pidFile = join(dir, `pids-${++seq}.json`)
    const run = execCaptureOffThread(process.execPath, [labeller, pidFile], { tree: true, timeout: 60_000 })
    void run.catch(() => undefined)
    const { labeller: lab, grandchild } = await readPids(pidFile)
    if (isWin) {
      // Nothing to report: the job is what ends the run.
      expect(_trackedGroupsForTests()).toEqual([])
    } else {
      await vi.waitFor(() => expect(_trackedGroupsForTests()).toEqual([lab]), { timeout: 5_000, interval: 20 })
    }
    // No handler of the host's runs: this is a crash.
    host.kill('SIGKILL')
    await exited
    await expect(run).rejects.toThrow(/proc host exited/)
    expect(await waitDead(lab)).toBe(true)
    expect(await waitDead(grandchild)).toBe(true)
  }, 60_000)
})

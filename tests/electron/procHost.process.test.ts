// The real-process proof that cancelling a labelling exec ends the whole tree. The stand-in for
// `claude -p` is a node script, never an agent CLI: it starts a child of its own that inherits its
// stdout and stderr, the way an agent's tool subprocess does, prints half an answer and sleeps. The
// exec goes through execCaptureOffThread with no proc host, so it takes the same runExec the host runs.
//
// The stand-ins sleep longer than any test here may run, so a pid the cleanup kills is always
// still theirs and never a recycled one. Liveness is read from the pids they report themselves:
// nothing here lists processes.
import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest'
import { _resetProcClientForTests, execCaptureOffThread } from '../../src/main/procClient'
import { runExec, type ProcOptions, type RunOutcome } from '../../src/main/procHost'
import { endProcessTree, taskkillPath } from '../../src/main/processTree'

let dir = ''
let script = ''
let flooder = ''
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
  // The same tree, but its grandchild shrugs off SIGTERM and the stand-in prints far past maxBuffer once
  // the pid file is written: only the SIGKILL after the grace (on Windows, taskkill /T /F) ends it.
  flooder = join(dir, 'flooder.cjs')
  writeFileSync(flooder, [
    "const { spawn } = require('child_process')",
    "const { renameSync, writeFileSync } = require('fs')",
    "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 120000)\"], { stdio: 'inherit', windowsHide: true, detached: process.platform === 'win32' })",
    "writeFileSync(process.argv[2] + '.tmp', JSON.stringify({ labeller: process.pid, grandchild: grandchild.pid }))",
    "renameSync(process.argv[2] + '.tmp', process.argv[2])",
    // Long enough for the grandchild to have its SIGTERM handler on before the cut can signal it.
    "setTimeout(() => process.stdout.write('x'.repeat(5000)), 1500)",
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

  it('output past maxBuffer ends the whole tree, a grandchild that ignores SIGTERM included', async () => {
    // execFile ends only the direct child here, and the answer drops the group from every list that
    // could still end it, so a grandchild holding the pipes lived on with nothing left to end it.
    const pidFile = join(dir, `pids-${++seq}.json`)
    const r = await execCaptureOffThread(process.execPath, [flooder, pidFile], { tree: true, timeout: 60_000, maxBuffer: 1000 })
    const { labeller, grandchild } = JSON.parse(readFileSync(pidFile, 'utf8')) as { labeller: number; grandchild: number }
    unverified.add(labeller)
    unverified.add(grandchild)
    expect(r.stdout).toBe('x'.repeat(1000))
    expect(r.error).toMatchObject({ message: 'stdout maxBuffer length exceeded', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    expect(await waitDead(labeller)).toBe(true)
    expect(await waitDead(grandchild)).toBe(true)
  }, 60_000)
})

// A tree run spawns its child itself (execFile drops `detached`) and collects its output the way execFile
// does. Each command here runs both ways, through runExec without tree (execFile) and with it (spawnTree),
// on real processes, and must come back the same: output, and every field of the error callers read.
describe('a tree run answers as execFile does, on real processes', () => {
  const node = process.execPath
  function shape(r: RunOutcome): unknown {
    const e = r.error as (NodeJS.ErrnoException & { killed?: boolean; signal?: unknown; cmd?: string; spawnargs?: string[] }) | undefined
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      error: e && {
        ctor: e.constructor.name, name: e.name, message: e.message, code: e.code, killed: e.killed, signal: e.signal,
        cmd: e.cmd, errno: e.errno, syscall: e.syscall, path: e.path, spawnargs: e.spawnargs,
      },
    }
  }
  async function both(bin: string, args: string[], opts: ProcOptions = {}): Promise<unknown> {
    const viaExecFile = shape(await runExec(bin, args, { timeout: 30_000, ...opts }))
    const viaTree = shape(await runExec(bin, args, { timeout: 30_000, ...opts, tree: true }))
    expect(viaTree).toEqual(viaExecFile)
    return viaTree
  }

  it('a clean exit: both pipes, utf8 decoded across a character split between two writes', async () => {
    // 'é' is 0xC3 0xA9: written apart, read as one character only by a decoder that waits for the rest.
    const r = await both(node, ['-e', "process.stdout.write(Buffer.from([0x61, 0xc3])); setTimeout(() => { process.stdout.write(Buffer.from([0xa9, 0x62])); process.stderr.write('note ü') }, 100)"])
    expect(r).toEqual({ stdout: 'aéb', stderr: 'note ü', error: undefined })
  }, 60_000)

  it('a failed exit: Command failed with the command line and stderr, the status, killed and signal', async () => {
    const r = await both(node, ['-e', "process.stderr.write('it broke'); process.exitCode = 3", 'extra arg'])
    expect(r).toMatchObject({ stdout: '', stderr: 'it broke', error: { ctor: 'Error', message: `Command failed: ${node} -e process.stderr.write('it broke'); process.exitCode = 3 extra arg\nit broke`, code: 3, killed: false, signal: null } })
  }, 60_000)

  it('a missing binary: the spawn error, ENOENT and all', async () => {
    const missing = join(dir, 'no-such-binary')
    const r = await both(missing, ['a', 'b'])
    expect(r).toMatchObject({ stdout: '', stderr: '', error: { code: 'ENOENT', syscall: `spawn ${missing}`, path: missing, spawnargs: ['a', 'b'], cmd: `${missing} a b` } })
  }, 60_000)

  it('output past maxBuffer: cut at the limit, the RangeError, the child ended', async () => {
    const r = await both(node, ['-e', "process.stdout.write('0123456789'); setTimeout(() => {}, 20000)"], { maxBuffer: 4 })
    expect(r).toMatchObject({ stdout: '0123', error: { ctor: 'RangeError', message: 'stdout maxBuffer length exceeded', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } })
  }, 60_000)

  it('stdin input, cwd and added variables reach the child', async () => {
    const r = await both(node, ['-e', "let s = ''; process.stdin.on('data', (d) => { s += d }); process.stdin.on('end', () => process.stdout.write([s, require('fs').existsSync('labeller.cjs'), process.env.TP_PARITY].join('|')))"], { input: 'from stdin', cwd: dir, addEnv: { TP_PARITY: 'added' } })
    // The stand-in script sits in `dir`, so a relative path finds it only from there (a macOS tmpdir is a
    // symlink, so the child's own cwd would not read back as `dir`).
    expect(r).toEqual({ stdout: 'from stdin|true|added', stderr: '', error: undefined })
  }, 60_000)
})

// macOS and Linux: a child that is NOT its own group's leader, as every tree run was while execFile
// dropped `detached`. kill(-pid) answers ESRCH for it, which alone reads as "already gone". With the
// caller's own handle (`leader`) that ESRCH is suspect: the signal goes to the child through the handle,
// and a child that ignores SIGTERM still gets SIGKILL after the grace.
describe.skipIf(process.platform === 'win32')('a group that was never made, on real processes (macOS and Linux)', () => {
  async function stubborn(): Promise<ReturnType<typeof spawn>> {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('up'); setTimeout(() => {}, 120000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
    unverified.add(child.pid!)
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()))
    return child
  }

  it('without the handle, ESRCH reads as gone and the child is left running (the batch 2 failure)', async () => {
    const child = await stubborn()
    expect(await endProcessTree(child.pid, { graceMs: 200 })).toBe(true)
    await new Promise((r) => setTimeout(r, 1_000))
    expect(isAlive(child.pid!)).toBe(true)
  }, 30_000)

  it('with the handle, the child gets SIGTERM, then SIGKILL after the grace since it ignores SIGTERM', async () => {
    const child = await stubborn()
    const signals: string[] = []
    const exit = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_c, sig) => resolve(sig)))
    const lines: string[] = []
    expect(await endProcessTree(child.pid, { graceMs: 200, leader: (sig) => { signals.push(sig); return child.kill(sig) } }, { log: (l) => lines.push(l) })).toBe(true)
    expect(await exit).toBe('SIGKILL')
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(lines).toEqual([`[processTree] process group ${child.pid} not found while its leader runs (ESRCH); signalling the leader`])
    expect(await waitDead(child.pid!)).toBe(true)
  }, 30_000)
})

// @vitest-environment node
import { spawn, spawnSync, type SpawnOptions } from 'child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest'
import { createSecondOpinionDeliver, type AgentChild, type SecondOpinionDeliver } from '../../src/main/secondOpinionDeliver'
import { taskkillPath } from '../../src/main/processTree'
import { PROMPT_TOKEN } from '../../src/main/secondOpinion'

// The real-process proof that a stop ends the whole tree. The stand-in "agent" is a node script,
// never an agent CLI. It starts a child of its own that inherits its stdout and stderr, the way an
// agent's tool subprocess does, and then sleeps. On Windows the tree is
//   powershell.exe (the wrapper deliver spawns) -> node agent.cjs -> node (grandchild),
// which is the shape where ending only the wrapper used to leave the other two running and
// holding the output pipes. On macOS and Linux the agent is spawned directly and leads its group.
//
// The stand-ins sleep longer than any test here may run, so a pid the cleanup kills is always
// still theirs and never a recycled one.

// Made in beforeAll, not at load, so a run that only collects this file (a -t filter that
// skips it, `vitest list`) leaves nothing behind in the temp dir.
let dir = ''
let agentScript = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-so-tree-'))
  agentScript = join(dir, 'agent.cjs')
  writeFileSync(agentScript, [
    "const { spawn } = require('child_process')",
    "const { renameSync, writeFileSync } = require('fs')",
    "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'inherit', windowsHide: true })",
    // The prompt arrives as the last argument, the same way it reaches a real agent.
    "process.stdout.write('partial review of ' + JSON.stringify(process.argv[2]) + '\\n')",
    "writeFileSync(process.env.TP_PIDS + '.tmp', JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }))",
    "renameSync(process.env.TP_PIDS + '.tmp', process.env.TP_PIDS)",
    'setTimeout(() => {}, 120000)',
  ].join('\n'))
})

let live: SecondOpinionDeliver | undefined
const unverified = new Set<number>()
let seq = 0

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

/** The stand-in writes its pids once its own child is running. Fails fast if the run ends first. */
async function readPids(file: string, run: Promise<unknown>): Promise<{ agent: number; grandchild: number }> {
  let ended = false
  void run.then(() => { ended = true })
  const until = Date.now() + 30_000
  while (Date.now() < until && !ended) {
    try {
      const pids = JSON.parse(readFileSync(file, 'utf8')) as { agent: number; grandchild: number }
      unverified.add(pids.agent)
      unverified.add(pids.grandchild)
      return pids
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(ended ? 'the run ended before the stand-in agent started' : 'the stand-in agent never started')
}

function setup(over: { spawn?: (cmd: string, args: string[], opts: SpawnOptions) => AgentChild; settleMs?: number } = {}) {
  const pidFile = join(dir, `pids-${++seq}.json`)
  live = createSecondOpinionDeliver({ tempDir: () => dir, env: () => ({ ...process.env, TP_PIDS: pidFile }), ...over })
  return { runs: live, pidFile }
}

afterEach(() => {
  // A failed test must not leave its stand-ins behind.
  try { live?.stopAll() } catch { /* cleanup only */ }
  live = undefined
  for (const pid of unverified) {
    if (process.platform === 'win32') {
      spawnSync(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
    } else {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  unverified.clear()
})

afterAll(() => {
  // Retries, because on Windows a stand-in that was just killed can hold agent.cjs for a moment.
  try { if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a temp dir */ }
})

describe('secondOpinionDeliver with real processes', () => {
  it('stopAll (app quit) ends the agent and the process it started, not just the one Termpolis spawned', async () => {
    const { runs, pidFile } = setup()
    const run = runs.deliver(process.execPath, [agentScript, PROMPT_TOKEN], 'review this', PROMPT_TOKEN, { timeoutMs: 0 })
    const pids = await readPids(pidFile, run)
    expect(isAlive(pids.agent)).toBe(true)
    expect(isAlive(pids.grandchild)).toBe(true)

    runs.stopAll()
    const r = await run
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('was stopped because Termpolis is quitting')
    expect(await waitDead(pids.agent)).toBe(true)
    expect(await waitDead(pids.grandchild)).toBe(true)
    // The Windows prompt file goes with the run.
    expect(readdirSync(dir).filter((f) => f.startsWith('termpolis-so-'))).toEqual([])
  }, 60_000)

  it('the deadline ends the whole tree, so the output pipes close and the partial output is kept', async () => {
    let closed = false
    const recordingSpawn = (cmd: string, args: string[], opts: SpawnOptions): AgentChild => {
      const child = spawn(cmd, args, opts)
      child.on('close', () => { closed = true })
      return child
    }
    // A long settle time: if anything in the tree survived holding a pipe, `close` would never
    // come and the run would only settle 20 s after the deadline.
    const { runs, pidFile } = setup({ spawn: recordingSpawn, settleMs: 20_000 })
    const started = Date.now()
    const run = runs.deliver(process.execPath, [agentScript, PROMPT_TOKEN], 'review this', PROMPT_TOKEN, { timeoutMs: 10_000 })
    const pids = await readPids(pidFile, run)

    const r = await run
    expect(closed).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000 + 20_000)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('did not finish within 10s and was stopped')
    // Capture still works, and the prompt reached the agent as its own argument.
    expect(r.stdout).toContain('partial review of "review this"')
    expect(await waitDead(pids.agent)).toBe(true)
    expect(await waitDead(pids.grandchild)).toBe(true)
  }, 60_000)
})

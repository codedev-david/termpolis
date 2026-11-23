// @vitest-environment node
// WPA item 2, the real-process proof: cancelling a Lumopolis ask ends the agent's whole process tree, not just the process
// Termpolis spawned. The ask runs through the real askRunner, the real runHeadless and the real secondOpinionDeliver; only the
// agent is a stand-in, a node script (never an agent CLI) that starts a child of its own and sleeps, the way an agent's tool
// subprocess does. Liveness is checked with process.kill(pid, 0) on the pids the stand-ins report about themselves, never by
// listing processes.
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createSecondOpinionDeliver, type SecondOpinionDeliver } from '../../src/main/secondOpinionDeliver'
import { taskkillPath } from '../../src/main/processTree'
import { PROMPT_TOKEN } from '../../src/main/secondOpinion'
import { runHeadless, type ExecDeps } from '../../src/main/headlessExec'
import { createAskRunner } from '../../src/main/world/askRunner'
import type { AskRequest, AskResult, WorldDoc } from '../../src/shared/world/types'

const DOC = {
  version: 1, projectKey: 'k', generatedAt: 1, sourceRevision: { head: 'h', dirty: false },
  districts: [], buildings: [], edges: [], externals: [], glossary: {}, cargo: {}, processes: {}, tours: [],
  layout: { seed: 1, positions: {} }, runtimeNames: {}, layers: { plan: [] }
} as unknown as WorldDoc

let dir = ''
let agentScript = ''
let live: SecondOpinionDeliver | undefined
const unverified = new Set<number>()
let seq = 0

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-ask-tree-'))
  agentScript = join(dir, 'agent.cjs')
  writeFileSync(agentScript, [
    "const { spawn } = require('child_process')",
    "const { renameSync, writeFileSync } = require('fs')",
    "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'inherit', windowsHide: true })",
    "writeFileSync(process.env.TP_PIDS + '.tmp', JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }))",
    "renameSync(process.env.TP_PIDS + '.tmp', process.env.TP_PIDS)",
    'setTimeout(() => {}, 120000)',
  ].join('\n'))
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
  throw new Error(ended ? 'the ask ended before the stand-in agent started' : 'the stand-in agent never started')
}

/** The real runner over the real runHeadless and deliver; the agent command is swapped for the stand-in. */
function setup(primer: (cwd: string, signal?: AbortSignal) => Promise<string | null>) {
  const pidFile = join(dir, `pids-${++seq}.json`)
  live = createSecondOpinionDeliver({ tempDir: () => dir, env: () => ({ ...process.env, TP_PIDS: pidFile }) })
  const real = live
  const execDeps: ExecDeps = {
    deliver: (_bin, _args, prompt, _token, opts) => real.deliver(process.execPath, [agentScript, PROMPT_TOKEN], prompt, PROMPT_TOKEN, opts),
  }
  const runner = createAskRunner({
    exec: runHeadless,
    execDeps,
    client: { get: async () => DOC, read: async () => ({ items: [], evidence: [] }) },
    agent: () => 'claude',
    runEnv: async () => ({ env: {} }),
    primer,
    log: () => undefined,
  })
  const req: AskRequest = { askId: `ask-${seq}`, root: dir, question: 'What is this?', selection: [], cameraRegion: [], summary: '' }
  return { runner, req, pidFile }
}

afterEach(() => {
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
  try { if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* a temp dir */ }
})

describe('cancelling a Lumopolis ask with real processes', () => {
  it('ends the agent and the process it started, and the ask says cancelled', async () => {
    const { runner, req, pidFile } = setup(async () => 'notes')
    const run: Promise<AskResult> = runner.ask(req)
    const pids = await readPids(pidFile, run)
    expect(isAlive(pids.agent)).toBe(true)
    expect(isAlive(pids.grandchild)).toBe(true)

    runner.cancel(req.askId)
    expect(await run).toMatchObject({ ok: false, cancelled: true })
    expect(await waitDead(pids.agent)).toBe(true)
    expect(await waitDead(pids.grandchild)).toBe(true)
  }, 60_000)

  it('a cancel while the memory primer is reading stops the primer, and no agent is ever started', async () => {
    let primerSignal: AbortSignal | undefined
    let primerStarted!: () => void
    const started = new Promise<void>((r) => { primerStarted = r })
    const { runner, req, pidFile } = setup((_cwd, signal) => {
      primerSignal = signal
      primerStarted()
      return new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(new Error('memory call cancelled'))))
    })
    const run = runner.ask(req)
    await started
    runner.cancel(req.askId)
    expect(await run).toMatchObject({ ok: false, cancelled: true })
    expect(primerSignal?.aborted).toBe(true)
    // Give a wrongly started agent time to write its pids.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(existsSync(pidFile)).toBe(false)
  }, 60_000)
})

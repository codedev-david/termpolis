// secondOpinionDeliver.ts
//
// The process half of a one-shot agent run, shared by Second Opinion and `termpolis exec`.
// It does four things:
//   - writes the untrusted prompt out of band;
//   - spawns the plan secondOpinionSpawnPlan resolved;
//   - captures stdout and stderr;
//   - STOPS the run when its time is up or Termpolis quits.
//
// Stopping ends the whole process tree (see processTree.ts). On Windows every agent runs under a
// PowerShell wrapper, so ending only the process we spawned used to leave the agent itself running,
// still holding the output pipes, until it finished on its own.
//
// It lives outside index.ts so every path can be tested with an injected spawn and kill. index.ts
// supplies only the temp dir and the environment.

import { spawn, type SpawnOptions } from 'child_process'
import { unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { killProcessTree, type KillTreeOptions } from './processTree'
// Import ONLY secondOpinionSpawnPlan (and types) from here. The index.ts test harness mocks
// ./secondOpinion with just runSecondOpinion and secondOpinionSpawnPlan.
import { secondOpinionSpawnPlan, type DeliverFn } from './secondOpinion'

/** How long a stopped run waits for its output pipes to close before it settles anyway. Longer
 *  than processTree's SIGTERM grace, so SIGKILL gets its turn first. Shorter than
 *  DELIVER_GRACE_MS, so the caller gets this result instead of deliverWithDeadline's bare timeout.
 *  What can still hold a pipe by then is a process that left the tree: on Windows, one whose
 *  wrapper had already exited. */
export const STOP_SETTLE_MS = 3_000

// setTimeout fires at once for a delay past 2^31-1 ms (the same bound deliverWithDeadline uses).
const MAX_TIMER_MS = 2_147_483_647

type DataListener = (chunk: Buffer | string) => void

/** The part of a ChildProcess used here. Listeners are added one call at a time, never chained. */
export interface AgentChild {
  pid?: number
  stdout?: { on(event: 'data', listener: DataListener): unknown } | null
  stderr?: { on(event: 'data', listener: DataListener): unknown } | null
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: () => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
}

export interface SecondOpinionDeliverDeps {
  /** Where the Windows prompt file goes. The app passes app.getPath('temp'). */
  tempDir: () => string
  /** The agent's environment. It is read for each run and never mutated. */
  env: () => NodeJS.ProcessEnv
  /** Test seams. Production uses the real platform, child_process, fs and killProcessTree. */
  platform?: NodeJS.Platform
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => AgentChild
  killTree?: (pid: number | undefined, opts: KillTreeOptions) => unknown
  writeFile?: (file: string, data: string) => void
  unlink?: (file: string) => void
  settleMs?: number
}

export interface SecondOpinionDeliver {
  deliver: DeliverFn
  /** Stop every run still going, and finish before returning. This is for app quit, where the
   *  app exits right after its quit handlers return and work left to a timer can't be counted on. */
  stopAll(): void
}

interface Run {
  bin: string
  stop(reason: string, sync: boolean): void
}

export function createSecondOpinionDeliver(deps: SecondOpinionDeliverDeps): SecondOpinionDeliver {
  // Each default is a wrapper, so a module import is only touched when a run needs it. A test that
  // mocks child_process or fs without these names still loads this file.
  const spawnAgent = deps.spawn ?? ((cmd: string, args: string[], opts: SpawnOptions): AgentChild => spawn(cmd, args, opts))
  const killTree = deps.killTree ?? killProcessTree
  const writeFile = deps.writeFile ?? ((file: string, data: string): void => writeFileSync(file, data, 'utf8'))
  const unlink = deps.unlink ?? ((file: string): void => unlinkSync(file))
  const settleMs = deps.settleMs ?? STOP_SETTLE_MS
  const running = new Set<Run>()

  const deliver: DeliverFn = (bin, args, prompt, promptToken, opts) => new Promise((resolve) => {
    const platform = deps.platform ?? process.platform
    const isWin = platform === 'win32'
    const env: NodeJS.ProcessEnv = { ...deps.env() }
    let tmp: string | null = null
    if (isWin) {
      // PowerShell reads the prompt from this file into $p, so it never touches a command line (see
      // secondOpinionSpawnPlan). If the file can't be written, the run is refused. It is not sent
      // some other way.
      tmp = join(deps.tempDir(), `termpolis-so-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`)
      try { writeFile(tmp, prompt) } catch { resolve({ stdout: '', code: 1 }); return }
      env.TP_SO_FILE = tmp
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let exited = false
    let child: AgentChild | undefined
    let stopReason: string | null = null
    let deadline: ReturnType<typeof setTimeout> | undefined
    let giveUp: ReturnType<typeof setTimeout> | undefined
    const finish = (r: { stdout: string; stderr?: string; code: number }): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(giveUp)
      running.delete(run)
      if (tmp) { try { unlink(tmp) } catch { /* best effort */ } }
      resolve(r)
    }
    // A stopped run fails whatever its exit code. It keeps the output it produced, and the reason
    // comes before any stderr.
    const stopped = (note: string): { stdout: string; stderr: string; code: number } =>
      ({ stdout, stderr: stderr ? `${note}\n${stderr}` : note, code: 1 })
    const run: Run = {
      bin,
      stop(reason, sync) {
        if (settled) return
        const note = (stopReason ??= reason)
        clearTimeout(deadline)
        clearTimeout(giveUp)
        // Windows: after the wrapper exits its pid can be reused, and `taskkill /T` can no longer
        // find the tree under it anyway, so nothing is left that is safe to kill.
        if (!(isWin && exited)) {
          try { killTree(child?.pid, { platform, sync }) } catch { /* the run still settles below */ }
        }
        if (sync) finish(stopped(note))
        else giveUp = setTimeout(() => finish(stopped(note)), settleMs)
      },
    }
    running.add(run)
    try {
      const { cmd, cmdArgs } = secondOpinionSpawnPlan(isWin, bin, args, promptToken, prompt)
      // Spawn options:
      //  - stdin 'ignore': an agent that reads stdin (`codex exec`) gets EOF instead of blocking.
      //  - `detached`, POSIX only: the agent leads its own process group, so a stop reaches
      //    everything it started. On Windows it would give the agent its own console instead.
      //  - No spawn `timeout`: that ends only the direct child. The deadline below stops the tree.
      child = spawnAgent(cmd, cmdArgs, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin })
      child.stdout?.on('data', (d) => { stdout += d.toString() })
      child.stderr?.on('data', (d) => { stderr += d.toString() })
      child.on('error', (e) => finish({ stdout: '', stderr: e.message, code: 1 }))
      child.on('exit', () => { exited = true })
      child.on('close', (code) => finish(stopReason === null ? { stdout, stderr, code: code ?? 1 } : stopped(stopReason)))
    } catch (e) {
      finish({ stdout: '', stderr: (e as Error)?.message, code: 1 })
      return
    }
    const { timeoutMs } = opts
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      deadline = setTimeout(
        () => run.stop(`${bin} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`, false),
        Math.min(timeoutMs, MAX_TIMER_MS),
      )
    }
  })

  return {
    deliver,
    stopAll(): void {
      // A copy, because each stop removes its run from the set.
      for (const run of [...running]) run.stop(`${run.bin} was stopped because Termpolis is quitting`, true)
    },
  }
}

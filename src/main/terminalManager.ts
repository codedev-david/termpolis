import * as pty from 'node-pty'
import { homedir } from 'os'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { execSync } from 'child_process'
import { app } from 'electron'
import { execShellCaptureOffThread } from './procClient'
import type { ShellType } from './types'
import { createOutputCoalescer, type OutputCoalescer } from './ptyCoalescer'
import { flushBeforeResize } from './ptyResizeFlush'
import { sudoAskpassEnv } from './sudoAskpass'
import { integrationScriptState, INTEGRATION_SCRIPT_NAME, type SpawnPrep } from './terminalSpawnPrep'
import { shellAlone, readConsoleProcessList } from './shellAlone'
import { consoleListInProc } from './consoleListInProc'
import {
  detectShellKind,
  integrationArgs,
  integrationEnv,
  integrationDisabled,
  needsScriptFile,
  POWERSHELL_INTEGRATION_SCRIPT,
} from './shellIntegration'

interface PtyProcess {
  pty: pty.IPty
  /** Batches this terminal's output before it crosses to the renderer. Disposed on
   *  exit and on kill so trailing output is delivered, never dropped. */
  coalescer: OutputCoalescer
  /** The geometry the child believes it is drawing for.
   *
   *  node-pty exposes `cols`/`rows` on the process, but only as the values it was
   *  constructed with -- a later `resize` does not update them. Anything that has
   *  to reproduce this terminal's grid elsewhere (the phone bridge does) needs the
   *  CURRENT size, so it is recorded on the way through instead. */
  cols: number
  rows: number
  /** What was started in the PTY: the shell, or the agent itself for a workflow's agent step. */
  executable: string
}

/** A terminal's current geometry, or null when there is no such terminal.
 *
 *  Exists for the remote bridge: it replays these bytes into its own emulator,
 *  and a TUI addresses cells by number. Replaying a 150-column redraw into a
 *  120-column grid puts the cursor on the wrong cell, which is not a cosmetic
 *  difference -- it drops characters out of the middle of words and leaves
 *  frames behind that the real terminal has already painted over. */
export function getTerminalSize(id: string): { cols: number; rows: number } | null {
  const proc = processes.get(id)
  return proc === undefined ? null : { cols: proc.cols, rows: proc.rows }
}

const processes = new Map<string, PtyProcess>()

/** Geometry a terminal is born with, before the renderer's fit reports the real
 *  one. Only ever visible for the first instant of a terminal's life. */
const SPAWN_COLS = 80
const SPAWN_ROWS = 24

// Trust prompt detection is handled by timed Enter sends in the renderer
// (AIProfiles.tsx, App.tsx, StartSwarmModal.tsx) since Claude Code's TUI
// doesn't reliably respond to output-based detection.

// Cache tool availability check — run once, reuse for all terminal spawns
let bundledToolsNeeded: boolean | null = null

/** `where`/`which` for one tool. Shared so the sync and primed paths can never ask different
 *  questions and cache different answers. */
function toolProbe(cmd: string): string {
  return process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`
}

/**
 * Fill the bundled-tools cache without spawning on the main thread.
 *
 * The sync version below runs up to three `where`/`which` probes, and it runs them from inside
 * spawnTerminal — so they land on the main thread at the exact moment the user is waiting for a
 * terminal to appear, and on Windows each one costs tens of milliseconds of CreateProcess on the
 * thread that pumps every PTY (see procHost.ts). Priming at startup makes the cache warm before the
 * first terminal is ever opened, and the sync function then returns it without spawning anything.
 *
 * The three probes run in parallel here, in the host, rather than short-circuiting: off the main
 * thread the cost of asking all three is wall-clock free, and the answer is identical.
 */
export function primeBundledToolsCheck(): Promise<boolean> {
  if (bundledToolsNeeded !== null) return Promise.resolve(bundledToolsNeeded)
  // Single-flight (HP2-02): the start-up prime and every terminal created while it runs (a session restore, a
  // swarm opening N terminals) share ONE set of three probes instead of launching three each.
  if (bundledToolsPrime) return bundledToolsPrime
  const has = async (cmd: string): Promise<boolean> => {
    try {
      const r = await execShellCaptureOffThread(toolProbe(cmd), { timeout: 2000 })
      return !r.error
    } catch {
      // No host and no in-process fallback either — treat as "missing", exactly as the sync
      // version's catch does.
      return false
    }
  }
  bundledCounters.primes++
  bundledToolsPrime = Promise.all([has('jq'), has('yq'), has('nano')]).then((found) => {
    bundledToolsNeeded = found.some((ok) => !ok)
    bundledToolsPrime = null
    return bundledToolsNeeded
  })
  return bundledToolsPrime
}

/** The prime in flight, so concurrent callers share it (singleFlight.ts pattern, one key). */
let bundledToolsPrime: Promise<boolean> | null = null
const bundledCounters = { primes: 0, unprimedPreparedSpawns: 0 }

/** Counters for the bundled-tools probe: `primes` = probe sets started on the proc host (3 probes each);
 *  `unprimedPreparedSpawns` = prepared spawns that came before any answer and took the bundled tools. */
export function bundledToolsCounters(): { primes: number; unprimedPreparedSpawns: number } {
  return { ...bundledCounters }
}

/**
 * The answer for a PREPARED spawn (HP2-01). Every app path prepares (a click, create_terminal, a workflow command
 * or agent step, the trigger supervisor, run_and_wait), and the click and create_terminal paths also await the
 * prime; the workflow paths do not. Before the prime has answered, the sync probe would run `where` three times on
 * the main thread, up to 2 s each. Instead: take the bundled tools (the answer that can only add tools, never take
 * one away; the bundled dir goes first on PATH for this terminal) and let the shared prime finish for the next one.
 * TERMPOLIS_BUNDLED_TOOLS_SYNC_PROBE=1 puts back the 1.54.4 sync probe.
 */
function bundledToolsForPreparedSpawn(env: NodeJS.ProcessEnv = process.env): boolean {
  if (bundledToolsNeeded !== null) return bundledToolsNeeded
  if (env.TERMPOLIS_BUNDLED_TOOLS_SYNC_PROBE === '1') return checkBundledToolsNeeded()
  bundledCounters.unprimedPreparedSpawns++
  void primeBundledToolsCheck()
  return true
}

function checkBundledToolsNeeded(): boolean {
  if (bundledToolsNeeded !== null) return bundledToolsNeeded
  const check = (cmd: string) => {
    try {
      execSync(toolProbe(cmd), { stdio: 'ignore', timeout: 2000, windowsHide: true })
      return true
    } catch { return false }
  }
  bundledToolsNeeded = !check('jq') || !check('yq') || !check('nano')
  return bundledToolsNeeded
}

export function spawnTerminal(
  id: string,
  executable: string,
  cwd: string,
  onData: (data: string) => void,
  extraPaths?: string[],
  extraEnv?: Record<string, string>,
  onExit?: (exitCode: number) => void,
  /** What a caller on a hot path looked up on the thread pool (terminalSpawnPrep.ts); without it, the lookups are synchronous. */
  prep?: SpawnPrep,
): void {
  const resolvedCwd = prep ? prep.cwd : (() => {
    try { return existsSync(cwd) ? cwd : homedir() }
    catch { return homedir() }
  })()

  const toolsDir = join(
    app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'),
    'tools',
    process.platform
  )
  const sep = process.platform === 'win32' ? ';' : ':'
  const existingPath = process.env.PATH || process.env.Path || ''
  const needsBundled = prep ? bundledToolsForPreparedSpawn() : checkBundledToolsNeeded()
  const extraPathStr = extraPaths?.length ? extraPaths.join(sep) + sep : ''
  // On Windows, ensure System32 + PowerShell 1.0 are on PATH so nested
  // `powershell` / `cmd` invocations resolve even when the parent Electron
  // process was launched with a stripped-down PATH (e.g., from Git Bash /
  // CI shells that don't include the Windows system directories).
  // Use exact-entry comparison, not substring-includes — otherwise
  // `C:\Windows\System32` is falsely considered present when the PATH
  // only contains the longer `C:\Windows\System32\WindowsPowerShell\v1.0`,
  // which leaves `cmd.exe` and `powershell.exe` unresolvable.
  const winSystemPath = process.platform === 'win32'
    ? (() => {
        const existingEntries = new Set(
          existingPath
            .split(sep)
            .map((e) => e.replace(/[\\/]+$/, '').trim().toLowerCase())
            .filter(Boolean)
        )
        return [
          'C:\\Windows\\System32',
          'C:\\Windows',
          'C:\\Windows\\System32\\Wbem',
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
        ]
          .filter((p) => !existingEntries.has(p.toLowerCase()))
          .join(sep)
      })()
    : ''
  const winSystemPrefix = winSystemPath ? winSystemPath + sep : ''
  // Git Bash hardening: if the user is launching `C:\Program Files\Git\bin\bash.exe`,
  // make sure Git's sibling `/usr/bin` is on PATH so POSIX helpers (sed, dirname,
  // uname) are always resolvable. Default Git Bash pulls these in via /etc/profile,
  // but users whose ~/.bash_profile doesn't chain to ~/.bashrc (or whose .bashrc
  // does `PATH=...` without `:$PATH`) can end up in a login shell where /usr/bin
  // is missing — which silently breaks every shell-wrapped CLI (Claude Code's
  // `claude`, gh's completion, node's npm-exec wrappers, etc.).
  const gitBashUsrBin: string = (() => {
    if (process.platform !== 'win32') return ''
    if (!/[\\/]git[\\/]+bin[\\/]+bash\.exe$/i.test(executable)) return ''
    // Derive the sibling usr\bin from the executable. Git for Windows always
    // ships <install>\bin\bash.exe alongside <install>\usr\bin, so if we got
    // here the derived path is guaranteed to exist.
    const derived = executable.replace(/[\\/]+bin[\\/]+bash\.exe$/i, '\\usr\\bin')
    const existingEntries = new Set(
      existingPath.split(sep).map((e) => e.replace(/[\\/]+$/, '').trim().toLowerCase()).filter(Boolean),
    )
    return existingEntries.has(derived.toLowerCase()) ? '' : derived
  })()
  const gitBashPrefix = gitBashUsrBin ? gitBashUsrBin + sep : ''
  const basePath = needsBundled
    ? `${toolsDir}${sep}${winSystemPrefix}${gitBashPrefix}${existingPath}`
    : `${winSystemPrefix}${gitBashPrefix}${existingPath}`
  // Test hook: e2e tests can prepend a shim directory that intercepts agent
  // binaries (claude, codex, gemini) and routes them to mocks. Keeps
  // tests from accidentally invoking real agents on developer machines.
  const testShimPath = process.env.TERMPOLIS_TEST_SHIM_DIR
    ? `${process.env.TERMPOLIS_TEST_SHIM_DIR}${sep}`
    : ''
  const baseEnv = {
    ...process.env,
    PATH: `${testShimPath}${extraPathStr}${basePath}`,
    OLLAMA_API_BASE: process.env.OLLAMA_API_BASE || 'http://localhost:11434',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    // Where `sudo -A` finds Termpolis's password dialog (sudoAskpass.ts), on Linux and macOS.
    ...sudoAskpassEnv(),
    ...(extraEnv || {}),
  } as Record<string, string>

  // Shell integration: teach the shell to announce its working directory every time it
  // draws a prompt, so the git mark follows `cd` instead of freezing at the directory
  // the terminal was launched in.
  //
  // Computed against baseEnv rather than process.env so a caller-supplied
  // PROMPT_COMMAND/PROMPT is chained onto rather than clobbered, and applied last so
  // the chained value wins (nothing is lost — the prior value is inside it).
  //
  // Every failure path here degrades to the pre-integration spawn: a git mark that
  // does not update is a small loss, a terminal that does not open is a broken app.
  const shellKind = detectShellKind(executable)
  const integrate = !integrationDisabled()
  const scriptPath = integrate && needsScriptFile(shellKind) ? (prep ? prep.integrationScript : ensureIntegrationScript()) : null
  const env = {
    ...baseEnv,
    ...(integrate ? integrationEnv(shellKind, baseEnv) : {}),
  } as Record<string, string>
  const args = [
    ...getShellArgs(executable),
    ...(integrate ? integrationArgs(shellKind, scriptPath) : []),
  ]

  let proc: pty.IPty
  try {
    proc = pty.spawn(executable, args, {
      name: 'xterm-256color',
      cols: SPAWN_COLS,
      rows: SPAWN_ROWS,
      cwd: resolvedCwd,
      env,
    })
  } catch (e: any) {
    const msg = e?.message || String(e)
    console.error(`[node-pty] Failed to spawn "${executable}" in "${resolvedCwd}": ${msg}`)
    throw new Error(`Failed to open terminal: ${msg}`)
  }

  // TERMPOLIS_CONSOLE_LIST_INPROC=1 leaves node-pty's own console listing in place (the 1.54.4 close).
  if (process.platform === 'win32' && !consoleListInProc()) endConsoleOffThread(proc)
  const coalescer = createOutputCoalescer(onData)
  proc.onData((chunk) => coalescer.push(chunk))
  const pid = proc.pid
  if (pid) running.add(pid)
  proc.onExit((e: { exitCode: number }) => {
    if (pid) running.delete(pid)
    if (running.size === 0) for (const done of exitWaiters.splice(0)) done()
    // Flush BEFORE the exit callback: a shell's last line (a prompt, an error, an exit
    // banner) is usually still inside the window when the process ends, and delivering
    // it after the terminal is torn down is the same as losing it.
    try { coalescer.dispose() } catch {}
    try { onExit?.(e.exitCode) } finally { processes.delete(id) }
  })
  processes.set(id, { pty: proc, coalescer, cols: SPAWN_COLS, rows: SPAWN_ROWS, executable })
}

/**
 * Closing a terminal on Windows, without a process created on this thread.
 *
 * node-pty's kill() lists the programs on the shell's console, to end them with it, by FORKING its helper script
 * (WindowsPtyAgent._getConsoleProcessList) from the process it runs in: this one. That is a process creation on the
 * thread that echoes every keystroke, on every close (0.1-0.3 s on a busy laptop with Defender; a swarm closes many
 * terminals). This answers the same question, for this terminal's agent only, through the proc host: the same list, the
 * same ending of every program in it, and the shell alone when the host cannot say (node-pty does the same when its
 * helper times out). Nothing happens for a pty that is not node-pty's Windows terminal.
 */
function endConsoleOffThread(proc: pty.IPty): void {
  const agent = (proc as unknown as { _agent?: { innerPid?: number; _getConsoleProcessList?: () => Promise<number[]> } })._agent
  if (!agent || typeof agent._getConsoleProcessList !== 'function') return
  agent._getConsoleProcessList = async () => {
    const pid = agent.innerPid ?? proc.pid
    return (await readConsoleProcessList(pid)) ?? [pid]
  }
}

export function killTerminal(id: string): void {
  const proc = processes.get(id)
  if (proc) {
    try { proc.coalescer.dispose() } catch {}
    try { proc.pty.kill() } catch {}
    try { proc.pty.pid && process.kill(proc.pty.pid) } catch {}
    processes.delete(id)
  }
}

export function writeToTerminal(id: string, data: string): void {
  try { processes.get(id)?.pty.write(data) } catch {}
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const proc = processes.get(id)
  if (proc === undefined) return
  // Bytes already read from the pty were drawn for the size it still has, and everything that reads them
  // later asks for the size then (the phone pump does, as it sends). So they leave first: the coalescer's
  // held bytes, then the remote pump's, both at the old size (ptyResizeFlush.ts). A resize to the size
  // the terminal already has changes nothing for any reader and flushes nothing; the pty still gets it.
  if (proc.cols !== cols || proc.rows !== rows) flushBeforeResize(id, () => proc.coalescer.flush())
  // Recorded even if the resize throws. A failed resize leaves the child drawing
  // for whatever size it last accepted, and that is still `cols`/`rows` as far as
  // every reader is concerned -- node-pty throws here for a closed pty, not for a
  // rejected geometry.
  proc.cols = cols
  proc.rows = rows
  try { proc.pty.resize(cols, rows) } catch {}
}

export function killAll(): void {
  for (const [id] of processes) killTerminal(id)
}

/** Shells started and not yet reported exited, by pid. Unlike `processes`, a kill leaves an
 *  entry here until node-pty sees the exit: that is what the app's own exit is waiting on. */
const running = new Set<number>()
const exitWaiters: Array<() => void> = []

/**
 * Resolves once every shell has exited, or after `timeoutMs` whatever is left.
 *
 * At exit, node-pty joins a thread per terminal that waits for its shell, so a shell that
 * survives killAll's SIGHUP/SIGTERM holds the whole app open after its last line of JS, and
 * holds open the output pipes it inherited from main too. Half way through the wait anything
 * still running gets SIGKILL, so the wait ends one way or the other.
 */
export function whenTerminalsExit(timeoutMs = 2000): Promise<void> {
  if (running.size === 0) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(force)
      clearTimeout(giveUp)
      resolve()
    }
    exitWaiters.push(finish)
    const force = setTimeout(() => {
      for (const pid of running) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
    }, timeoutMs / 2)
    const giveUp = setTimeout(finish, timeoutMs)
  })
}

/** How many shells have started and not yet been seen to exit. */
export function runningShellCount(): number {
  return running.size
}

/** @internal test-only */
export function _resetTerminalExitsForTests(): void {
  running.clear()
  exitWaiters.splice(0)
}

export function getTerminalPid(id: string): number | null {
  const proc = processes.get(id)
  return proc?.pty.pid ?? null
}

/** Whether nothing runs in terminal `id` but its shell (shellAlone.ts); null for no such terminal,
 *  or where that can't be told. */
export function terminalShellAlone(id: string): Promise<boolean | null> {
  const proc = processes.get(id)
  return proc?.pty.pid ? shellAlone(proc.pty.pid, proc.executable) : Promise.resolve(null)
}

/** The shell pipeline that reads a pid's cwd: fast /proc on Linux, lsof on macOS. */
function cwdProbeCommand(pid: number): string {
  return `readlink /proc/${pid}/cwd 2>/dev/null || lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1 | cut -c2-`
}

/**
 * The working directory of a terminal's shell, asked of the proc host so that neither the spawn nor the wait costs the
 * main thread anything. (There was a synchronous twin once; nothing called it after v1.47.1 and it is gone: `lsof`
 * takes 50-500 ms on macOS, which is where there is no /proc, and the `terminal:status` handler asks every 5 s per
 * open terminal.)
 */
export async function getTerminalCwdAsync(id: string): Promise<string | null> {
  if (process.platform === 'win32') return null
  const pid = getTerminalPid(id)
  if (!pid) return null
  // Via the proc host, so even the CreateProcess/fork half of the spawn happens off the main
  // thread. `exec` here would still have blocked the PTY pump for the duration of uv_spawn.
  const r = await execShellCaptureOffThread(cwdProbeCommand(pid), { timeout: 2000 })
  if (r.error) return null
  return r.stdout.trim() || null
}

/**
 * Put the PowerShell integration script on disk, once per app run.
 *
 * PowerShell is the only shell whose integration cannot travel in the environment — it
 * has no PROMPT_COMMAND equivalent — so the wrapper needs a real file to dot-source.
 * It goes in Termpolis's own data folder, never anywhere the user owns, and is rewritten
 * if something cleaned it up mid-session. Not the temp dir: PowerShell running a script
 * from %TEMP% is a pattern endpoint security flags (malware stages scripts there).
 *
 * Returns null on any failure, which the caller reads as "spawn exactly as before".
 */
function ensureIntegrationScript(): string | null {
  try {
    const p = integrationScriptState.path ?? join(app.getPath('userData'), INTEGRATION_SCRIPT_NAME)
    if (integrationScriptState.path === null || !existsSync(p)) {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, POWERSHELL_INTEGRATION_SCRIPT, 'utf8')
    }
    integrationScriptState.path = p
    return p
  } catch {
    return null
  }
}

function getShellArgs(executable: string): string[] {
  const lower = executable.toLowerCase()
  if (lower.endsWith('bash') || lower.endsWith('zsh')) return ['--login']
  return []
}

/**
 * xterm.js `windowsPty` option for a renderer Terminal: tells the emulator the
 * Windows PTY backend + OS build so its line-reflow and scrollback heuristics
 * match ConPTY (which hard-wraps lines and repaints differently than a Unix
 * pty). Without this hint a heavy-redraw TUI — e.g. Claude Code's Ink UI —
 * progressively desyncs and its output overlaps the prompt box ("text gets
 * jumbled with the prompt area"). Returns null off Windows, where xterm's
 * native reflow is already correct.
 *
 * Mirrors node-pty's OWN backend decision — ConPTY when the OS build >= 18309,
 * else winpty (see node-pty windowsPtyAgent._getWindowsBuildNumber) — so the
 * hint we hand xterm matches the pty we actually spawned. Pure + injectable
 * (platform/release passed in) for unit testing.
 */
export function computeWindowsPty(
  platform: NodeJS.Platform,
  release: string,
): { backend: 'conpty' | 'winpty'; buildNumber: number } | null {
  if (platform !== 'win32') return null
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(release)
  const buildNumber = match ? parseInt(match[3], 10) : 0
  return { backend: buildNumber >= 18309 ? 'conpty' : 'winpty', buildNumber }
}

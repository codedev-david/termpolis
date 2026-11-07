import { createRequire } from 'module'
import { basename, dirname } from 'path'
import { execCaptureOffThread } from './procClient'
import { ensureConsoleListHelper } from './consoleListHelper'
import { createSingleFlight } from './singleFlight'
import { consoleListInProc, forkConsoleList } from './consoleListInProc'

/**
 * Whether nothing runs in a terminal but its shell: whatever was typed at its prompt, an agent
 * among them, has exited. write_to_terminal's submit asks it before typing into an agent
 * (mcpServer.ts), since the screen can't always tell an agent that exited from one at its input:
 *
 * - zsh and fish report no prompts (shellIntegration.ts), nor does a bash whose own PROMPT_COMMAND
 *   replaced Termpolis's;
 * - an agent a person started leaves no run_command mark;
 * - Claude Code and Antigravity leave their last frame, input box and all, on the screen when they
 *   exit, with the shell's prompt under it.
 *
 * Read as the agent at its input, that frame got the task typed at the prompt. bash and zsh ran
 * each line of it as soon as its line feed came; PowerShell held the lines and ran all of them at
 * the next Enter, which the run_command that starts the agent again presses.
 *
 * Answers true only where the OS says so, from the terminal's own processes: no process listing,
 * no names or command lines of other programs. It answers null where it can't tell: a shell not
 * known here, WSL, or a query that failed. The screen's answer then stands.
 *
 * Never on the main thread: every question here is a process creation (Windows: Termpolis run as Node, to read the
 * console; Unix: ps and pgrep), and a process creation on the thread that echoes keystrokes has been measured at
 * 0.1-0.3 s on a busy Windows laptop. They go to the proc host (procClient.ts), and the caller waits for the answer.
 */
export async function shellAlone(pid: number, executable: string, platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  return platform === 'win32' ? aloneOnConsole(pid, executable) : aloneInForeground(pid, executable)
}

/** How long the console helper gets to list a console: it is Termpolis started again as Node, which
 *  took 0.7 to 1.1 s on a live run. */
export const CONSOLE_LIST_TIMEOUT_MS = 5000

/** Two asks for the same terminal this close together (a submit and an auto-primer, say) share one run of the helper.
 *  Shorter than the 2 s between the auto-primer's own asks, so each of those is a fresh look. */
export const CONSOLE_LIST_SHARE_MS = 1500

/** How many processes a Windows shell keeps on its console at its prompt: one, or two for Git for
 *  Windows' bin\bash.exe, which starts usr\bin\bash.exe and waits for it. A program run from an
 *  MSYS bash adds two (the bash it forks waits for it). null for a shell whose programs the console
 *  doesn't show (WSL's, in System32: they are Linux processes) and for any shell not known here. */
export function ownConsoleProcesses(executable: string): number | null {
  const exe = executable.replace(/\//g, '\\').toLowerCase()
  const name = exe.slice(exe.lastIndexOf('\\') + 1).replace(/\.exe$/, '')
  if (name === 'powershell' || name === 'pwsh' || name === 'cmd') return 1
  if (!['bash', 'sh', 'zsh', 'fish'].includes(name) || !exe.includes('\\') || exe.includes('\\system32\\')) return null
  return exe.endsWith('\\git\\bin\\bash.exe') ? 2 : 1
}

/** Windows has no foreground process. What runs in a terminal is on its console: the shell, and
 *  every console program started in it. Read with node-pty's own call for it, the one it makes to close
 *  a terminal, through a helper script that ships with the app (resources/mcp-adapter/termpolis-console-list.cjs,
 *  see consoleListHelper.ts; never written at run time) and that the proc host runs. It attaches to the
 *  console to read it, so it is in the list itself. */
async function aloneOnConsole(pid: number, executable: string): Promise<boolean | null> {
  const own = ownConsoleProcesses(executable)
  if (own === null) return null
  // TERMPOLIS_CONSOLE_LIST_INPROC=1 (consoleListInProc.ts): the 1.54.4 read, node-pty's helper forked from main.
  const attached = consoleListInProc() ? await forkConsoleList(pid, CONSOLE_LIST_TIMEOUT_MS) : await consoleProcesses(pid, own)
  return attached === null || !attached.includes(pid) ? null : attached.length <= own
}

/** node-pty's lib folder, from where the package keeps it on disk (package.json asarUnpack): a script outside
 *  app.asar loads node-pty's native module the same way in or out of a packaged build. Found ONCE: resolving a module
 *  walks the file system with synchronous calls (realpathSync, stat), and this is asked on every submit to an agent. */
let libDir: string | null = null
function nodePtyLibDir(): string {
  libDir ??= dirname(createRequire(import.meta.url).resolve('node-pty')).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  return libDir
}

/**
 * Start-up, Windows: find node-pty's folder and write the helper script now, so the first submit to an agent (and the
 * first close of a terminal) makes no file call on the main thread: finding a module's folder walks the file system with
 * synchronous calls, and writing the script is a file write.
 */
export async function primeShellAlone(): Promise<void> {
  if (process.platform !== 'win32') return
  try { nodePtyLibDir() } catch { /* the first ask finds out */ }
  await ensureConsoleListHelper()
}

/** What the helper prints: {"self": its own pid, "list": [pid, ...]}; null for anything else. */
export function parseConsoleList(stdout: string): number[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { return null }
  const { self, list } = (parsed ?? {}) as { self?: unknown; list?: unknown }
  if (!Array.isArray(list) || !list.every((p) => Number.isInteger(p))) return null
  return (list as number[]).filter((p) => p !== self)
}

const consoleLists = createSingleFlight()

/** What the console helper did since start-up (EDR-2): the runs, the runs that came back "cannot tell", and those of them
 *  that ran out of time (the helper killed at CONSOLE_LIST_TIMEOUT_MS, or the proc host never answering). The helper is run
 *  by the below-normal proc host; these say whether that ever costs a submit its answer. missingHelper (EDR2-2): asks that
 *  ran nothing because the helper script could not be found or written, each one "cannot tell" too. In diagnostics:collect
 *  as typing.extra.consoleList (index.ts). */
export interface ConsoleListCounters { runs: number; failures: number; timeouts: number; missingHelper: number }
const counters: ConsoleListCounters = { runs: 0, failures: 0, timeouts: 0, missingHelper: 0 }

export function consoleListCounters(): ConsoleListCounters {
  return { ...counters }
}

/** The programs on the console of the shell `pid`, read now (never shared with another ask); null where the helper
 *  failed. For closing a terminal, which must see what runs in it at that moment. */
export function readConsoleProcessList(pid: number): Promise<number[] | null> {
  return readConsole(pid)
}

/** @internal test-only */
export function _resetShellAloneForTests(): void {
  consoleLists.clear()
  counters.runs = counters.failures = counters.timeouts = counters.missingHelper = 0
}

/** The processes on the console of the shell `pid`, the helper left out; null where the helper
 *  failed. node-pty's own use of it (WindowsPtyAgent._getConsoleProcessList) answers the shell
 *  alone when it fails, which would read here as the shell being alone.
 *
 *  Asks made while one run is going share it. After it settles only a "not alone" list is kept for
 *  CONSOLE_LIST_SHARE_MS (HP-6): a kept "alone" would outlive an agent started again inside the window
 *  (the model switcher's relaunch), and a submit would be refused as "agent exited". A kept "not alone"
 *  only delays seeing an exit, which the quit loop asks again for. */
function consoleProcesses(pid: number, own: number): Promise<number[] | null> {
  const busy = (list: number[] | null): boolean => list !== null && list.includes(pid) && list.length > own
  return consoleLists.run(`shellAlone:${pid}`, CONSOLE_LIST_SHARE_MS, () => readConsole(pid), busy)
}

async function readConsole(pid: number): Promise<number[] | null> {
  // A helper that cannot be found or written runs nothing: "cannot tell", counted (EDR2-2).
  const helper = await ensureConsoleListHelper().catch(() => null)
  if (!helper) {
    counters.missingHelper++
    return null
  }
  // Termpolis run as Node (ELECTRON_RUN_AS_NODE) on the shipped script, by the proc host. A failure of any kind (the host is down, the
  // helper could not load node-pty, the time ran out and it was killed) is "cannot tell", never "alone".
  counters.runs++
  let r: Awaited<ReturnType<typeof execCaptureOffThread>>
  try {
    r = await execCaptureOffThread(process.execPath, [helper, String(pid), nodePtyLibDir()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: CONSOLE_LIST_TIMEOUT_MS,
    })
  } catch (err) {
    counters.failures++
    if (/timed out/.test(String(err))) counters.timeouts++
    return null
  }
  if (r.error) {
    counters.failures++
    if (r.error.killed || r.error.signal) counters.timeouts++
    return null
  }
  return parseConsoleList(r.stdout)
}

/** The shells that give each program they run the terminal, in a process group of its own (job
 *  control), so that at the prompt the terminal's foreground group is the shell's. Not PowerShell
 *  or Nushell on Unix, which keep what they run in their own group. */
const JOB_CONTROL_SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'fish', 'ksh'])

/** Unix: the shell is alone when its terminal's foreground process group is its own, and nothing
 *  else is in that group (a program a shell with job control turned off runs is). Not while the
 *  terminal's process is no longer its shell: `exec claude` made the agent the terminal's process,
 *  its group's leader. */
async function aloneInForeground(pid: number, executable: string): Promise<boolean | null> {
  const name = basename(executable)
  if (!JOB_CONTROL_SHELLS.has(name)) return null
  try {
    // Two -o: macOS's ps reads the header text after "=" up to the end of the argument, commas too.
    const ps = await execCaptureOffThread('ps', ['-o', 'tpgid=', '-o', 'comm=', '-p', String(pid)], { timeout: 3000 })
    const m = /^\s*(-?\d+)\s+(.+?)\s*$/m.exec(ps.stdout)
    // macOS shows the path the shell was started by, "-zsh" for a login shell's.
    if (!m || basename(m[2]).replace(/^-/, '') !== name) return null
    const foreground = Number(m[1])
    if (foreground <= 0) return null
    if (foreground !== pid) return false
    const group = await execCaptureOffThread('pgrep', ['-g', String(pid)], { timeout: 3000 })
    const pids = group.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '').map(Number)
    return pids.includes(pid) ? pids.length === 1 : null
  } catch {
    return null
  }
}

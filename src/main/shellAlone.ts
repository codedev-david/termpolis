import { fork as forkProcess } from 'child_process'
import { createRequire } from 'module'
import { basename, dirname, join } from 'path'
import { execCaptureOffThread } from './procClient'

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
 */
export async function shellAlone(pid: number, executable: string, platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  return platform === 'win32' ? aloneOnConsole(pid, executable) : aloneInForeground(pid, executable)
}

/** How long node-pty's helper gets to list a console: it is Termpolis started again as Node, which
 *  took 0.7 to 1.1 s on a live run. */
export const CONSOLE_LIST_TIMEOUT_MS = 5000

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
 *  every console program started in it. Read by node-pty's own helper, the one it starts to close
 *  a terminal, with the console's process list (GetConsoleProcessList). It attaches to the console
 *  to read it, so it is in the list itself. */
async function aloneOnConsole(pid: number, executable: string): Promise<boolean | null> {
  const own = ownConsoleProcesses(executable)
  if (own === null) return null
  const attached = await consoleProcesses(pid)
  return attached === null || !attached.includes(pid) ? null : attached.length <= own
}

/** node-pty's conpty_console_list_agent, next to its own lib, from where the package keeps it on
 *  disk (package.json asarUnpack): a forked script outside app.asar loads its native module the
 *  same way in or out of a packaged build. */
function consoleListAgent(): string {
  const lib = dirname(createRequire(import.meta.url).resolve('node-pty'))
  return join(lib, 'conpty_console_list_agent').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/** The processes on the console of the shell `pid`, the helper left out; null where the helper
 *  failed. node-pty's own use of it (WindowsPtyAgent._getConsoleProcessList) answers the shell
 *  alone when it fails, which would read here as the shell being alone. */
function consoleProcesses(pid: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    let helper: ReturnType<typeof forkProcess>
    try {
      // silent: what the helper prints when the shell exits as it attaches isn't Termpolis's to show.
      helper = forkProcess(consoleListAgent(), [String(pid)], { silent: true })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      try { helper.kill() } catch { /* already gone */ }
      resolve(null)
    }, CONSOLE_LIST_TIMEOUT_MS)
    const done = (list: number[] | null): void => {
      clearTimeout(timer)
      resolve(list)
    }
    helper.on('message', (m: unknown) => {
      const list = (m as { consoleProcessList?: unknown } | null)?.consoleProcessList
      done(Array.isArray(list) && list.every((p) => Number.isInteger(p)) ? (list as number[]).filter((p) => p !== helper.pid) : null)
    })
    helper.on('error', () => done(null))
    // Its list can come after it has exited: it sends it, then exits at once.
    helper.on('exit', () => { setTimeout(() => done(null), 100) })
  })
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

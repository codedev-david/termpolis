import { fork as forkProcess } from 'child_process'
import { createRequire } from 'module'
import { dirname, join } from 'path'

/**
 * Kill switch (1.54.5, EDR2-3): TERMPOLIS_CONSOLE_LIST_INPROC=1 puts back the 1.54.4 way of reading a Windows
 * terminal's console. shellAlone forks node-pty's own conpty_console_list_agent from the main process again, and
 * closing a terminal leaves node-pty's kill() to fork it the same way. Unset (the default), both go through the
 * shipped helper script on the proc host (shellAlone.ts, consoleListHelper.ts). For a machine where the proc-host
 * helper fails and the old path worked: it costs a process creation on the main thread per ask and per close.
 */
export const CONSOLE_LIST_INPROC_ENV = 'TERMPOLIS_CONSOLE_LIST_INPROC'

export function consoleListInProc(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[CONSOLE_LIST_INPROC_ENV] ?? '').trim() === '1'
}

/** node-pty's conpty_console_list_agent, next to its own lib, from where the package keeps it on disk
 *  (package.json asarUnpack): a forked script outside app.asar loads its native module the same way in or out of a
 *  packaged build. */
function consoleListAgent(): string {
  const lib = dirname(createRequire(import.meta.url).resolve('node-pty'))
  return join(lib, 'conpty_console_list_agent').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/** The 1.54.4 read, unchanged: the processes on the console of the shell `pid`, the helper left out; null where the
 *  helper failed or took longer than `timeoutMs`. */
export function forkConsoleList(pid: number, timeoutMs: number): Promise<number[] | null> {
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
    }, timeoutMs)
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

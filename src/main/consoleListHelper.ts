// The small script that reads one terminal's console, for shellAlone.ts (Windows).
//
// node-pty's own helper for this (lib/conpty_console_list_agent.js) hands its answer back over process.send, which
// only a child started with child_process.fork has. Termpolis used to fork it from the main process, once per ask,
// and a fork on the main thread costs 0.1-0.3 s of that thread (the endpoint scanner inspects every process creation
// and its queue grows with the load): every submit to an agent, every re-prime, every model switch. The proc host
// (procHost.ts) runs commands off the main thread but only through execFile, which has no IPC channel. So this
// script makes the same native call and answers on stdout, and the proc host runs it.
//
// The script SHIPS with the app (src/mcp-adapter/termpolis-console-list.cjs, copied to resources/mcp-adapter by the
// existing extraResources entry, like the other .cjs files there). It is never written at run time: a script that
// Termpolis.exe writes into its data folder and then runs as Node is exactly what endpoint security flags as a
// dropped-and-executed payload. When the file is missing, the answer is null, which shellAlone reads as "cannot
// tell" (the screen's answer stands) - today's behaviour before 1.54.5.

import { promises as fsp } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export const CONSOLE_LIST_HELPER_NAME = 'termpolis-console-list.cjs'

/** Where the shipped script lives: resources/mcp-adapter in a packaged app, src/mcp-adapter in development. */
export function consoleListHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'mcp-adapter', CONSOLE_LIST_HELPER_NAME)
    : join(__dirname, '../../src/mcp-adapter', CONSOLE_LIST_HELPER_NAME)
}

/** The path once this run has seen the file (null: not yet). */
let helperPath: string | null = null

/**
 * The shipped helper's path, or null when it is not there (shellAlone then cannot tell). Read-only: it checks the
 * file once per run on the thread pool and never writes anything.
 */
export async function ensureConsoleListHelper(): Promise<string | null> {
  if (helperPath !== null) return helperPath
  try {
    const p = consoleListHelperPath()
    await fsp.access(p)
    helperPath = p
    return p
  } catch {
    return null
  }
}

/** @internal test-only */
export function _resetConsoleListHelperForTests(): void {
  helperPath = null
}

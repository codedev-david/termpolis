// The small script that reads one terminal's console, for shellAlone.ts (Windows).
//
// node-pty's own helper for this (lib/conpty_console_list_agent.js) hands its answer back over process.send, which
// only a child started with child_process.fork has. Termpolis used to fork it from the main process, once per ask,
// and a fork on the main thread costs 0.1-0.3 s of that thread (the endpoint scanner inspects every process creation
// and its queue grows with the load): every submit to an agent, every re-prime, every model switch. The proc host
// (procHost.ts) runs commands off the main thread but only through execFile, which has no IPC channel. So this
// script makes the same native call and answers on stdout, and the proc host runs it.
//
// It is written once per app run into Termpolis's own data folder (the way terminalSpawnPrep.ts puts the PowerShell
// integration script there), so the packaged app needs no new file: it only needs node-pty's lib folder, which
// asarUnpack already keeps on disk.

import { promises as fsp } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'

export const CONSOLE_LIST_HELPER_NAME = 'termpolis-console-list.cjs'

/** argv: <the shell's pid> <node-pty's lib folder>. stdout: {"self": <its own pid>, "list": [<pid>, ...]}. */
export const CONSOLE_LIST_HELPER_SOURCE = `'use strict'
// Lists the programs on the console of one terminal's shell and prints them as JSON. Started by Termpolis (it runs
// itself as Node for this): see src/main/consoleListHelper.ts. It attaches to the console to read it, so it is in
// the list itself, which is why it prints its own pid.
const path = require('path')
const done = (code) => { process.exitCode = code; process.exit(code) }
try {
  const pid = parseInt(process.argv[2], 10)
  const utils = require(path.join(process.argv[3], 'utils'))
  const list = utils.loadNativeModule('conpty_console_list').module.getConsoleProcessList(pid)
  process.stdout.write(JSON.stringify({ self: process.pid, list: list }), () => done(0))
} catch (e) {
  done(1)
}
`

/** Where the helper was last put on disk this run (null: not yet). */
let helperPath: string | null = null

/**
 * The helper's path, written if this run has not written it yet or if something removed it. The first call of a
 * run always writes it, so a newer Termpolis replaces an older one's copy. Null when it cannot be written, which
 * shellAlone reads as "cannot tell" (the screen's answer stands).
 */
export async function ensureConsoleListHelper(): Promise<string | null> {
  try {
    const p = helperPath ?? join(app.getPath('userData'), CONSOLE_LIST_HELPER_NAME)
    let present = false
    if (helperPath !== null) {
      try { await fsp.access(p); present = true } catch { /* removed mid-session: written again below */ }
    }
    if (!present) {
      await fsp.mkdir(dirname(p), { recursive: true })
      await fsp.writeFile(p, CONSOLE_LIST_HELPER_SOURCE, 'utf8')
    }
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

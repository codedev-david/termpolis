'use strict'
// Lists the programs on the console of one terminal's shell and prints them as JSON, for shellAlone.ts (Windows).
// Termpolis runs it as Node (ELECTRON_RUN_AS_NODE) from its own install folder (resources/mcp-adapter), through the
// proc host: see src/main/consoleListHelper.ts. It is shipped, never written at run time.
// argv: <the shell's pid> <node-pty's lib folder>. stdout: {"self": <its own pid>, "list": [<pid>, ...]}.
// It attaches to the console to read it, so it is in the list itself, which is why it prints its own pid.
const path = require('path')
const done = (code) => { process.exitCode = code; process.exit(code) }
// The proc host runs below normal priority (src/main/hostPriority.ts) and a Windows child inherits its class, but a
// submit to an agent waits on this answer. So it puts ITSELF (pid 0, never another process) back to normal first.
// Best effort: where that is not allowed it lists the console anyway. Kill switch: TERMPOLIS_CONSOLE_LIST_NORMAL=0.
if (process.env.TERMPOLIS_CONSOLE_LIST_NORMAL !== '0') {
  try {
    const os = require('os')
    os.setPriority(0, os.constants.priority.PRIORITY_NORMAL)
  } catch (e) {
    // stays at the priority it started with
  }
}
try {
  const pid = parseInt(process.argv[2], 10)
  const utils = require(path.join(process.argv[3], 'utils'))
  const list = utils.loadNativeModule('conpty_console_list').module.getConsoleProcessList(pid)
  process.stdout.write(JSON.stringify({ self: process.pid, list: list }), () => done(0))
} catch (e) {
  done(1)
}

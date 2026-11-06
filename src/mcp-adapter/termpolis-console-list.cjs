'use strict'
// Lists the programs on the console of one terminal's shell and prints them as JSON, for shellAlone.ts (Windows).
// Termpolis runs it as Node (ELECTRON_RUN_AS_NODE) from its own install folder (resources/mcp-adapter), through the
// proc host: see src/main/consoleListHelper.ts. It is shipped, never written at run time.
// argv: <the shell's pid> <node-pty's lib folder>. stdout: {"self": <its own pid>, "list": [<pid>, ...]}.
// It attaches to the console to read it, so it is in the list itself, which is why it prints its own pid.
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

// Global setup for Playwright E2E tests
// Cleans up Electron lockfiles and stale session data before test runs

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { makeScratchAgentHome } from '../tests/agentHomeScratch'

export default function globalSetup(): () => void {
  // Agent configs the app writes (MCP registration, folder trust, one-time migrations) land
  // in a scratch home. Workers inherit this, and every Electron launch inherits its worker's
  // env, so no spec can rewrite the developer's real ~/.claude*, ~/.codex or ~/.gemini.
  // resolveAgentIntegrationPaths() honors it over homedir(), CLAUDE_CONFIG_DIR and CODEX_HOME.
  const agentHome = makeScratchAgentHome()
  process.env.TERMPOLIS_TEST_AGENT_HOME = agentHome.dir

  // An app an earlier run of THIS checkout left behind (its runner was killed before quitApp ran) is stopped. Only
  // that one: every e2e launch starts the app as `<checkout>/out/main/index.js`, so the pattern is that full path.
  // This was `pkill -f electron` (and `taskkill /im electron.exe` on Windows), which also killed the app of a
  // run going on at the same time in another checkout or worktree on the machine: that run's test died at
  // whatever step it had reached with "Target page, context or browser has been closed" (world-responsive's
  // long test 2 on the shared Linux box, at 1.6 and 5.0 minutes). A leftover is harmless to this run, since
  // every spec has its own --user-data-dir (so its own single-instance lock) and the app's ports fall back to
  // free ones. Windows has no way to match a process by its arguments short of listing every process's
  // command line, which this suite does not do, so there nothing is stopped.
  if (process.platform !== 'win32') {
    const main = path.resolve('out', 'main', 'index.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // No shell: `sh -c "pkill -f …"` would carry the pattern in its own command line and be killed too.
    try { execFileSync('pkill', ['-f', main], { stdio: 'ignore' }) } catch { /* exit 1: none left over */ }
  }

  // Clean lockfiles
  const appDataDirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'termpolis'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron'),
    path.join(os.homedir(), 'Library', 'Application Support', 'termpolis'),
    path.join(os.homedir(), '.config', 'termpolis'),
  ]

  for (const dir of appDataDirs) {
    const lockfile = path.join(dir, 'lockfile')
    try { if (fs.existsSync(lockfile)) fs.unlinkSync(lockfile) } catch {}
  }

  // Write clean session so tests start fresh
  const cleanSession = JSON.stringify({
    terminals: [], workspaces: [], defaultShell: process.platform === 'win32' ? 'powershell' : 'bash', viewMode: 'tabs',
  })
  for (const dir of appDataDirs) {
    const sessionPath = path.join(dir, 'session.json')
    try {
      if (fs.existsSync(dir)) {
        fs.writeFileSync(sessionPath, cleanSession)
      }
    } catch {}
  }

  // Playwright runs a function returned from globalSetup as the global teardown, after every worker has exited:
  // the scratch agent home goes with the run instead of piling up in the temp folder.
  return () => { agentHome.remove() }
}

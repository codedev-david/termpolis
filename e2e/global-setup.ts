// Global setup for Playwright E2E tests
// Cleans up Electron lockfiles and stale session data before test runs

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { makeScratchAgentHome } from '../tests/agentHomeScratch'

export default function globalSetup(): () => void {
  // Agent configs the app writes (MCP registration, folder trust, one-time migrations) land
  // in a scratch home. Workers inherit this, and every Electron launch inherits its worker's
  // env, so no spec can rewrite the developer's real ~/.claude*, ~/.codex or ~/.gemini.
  // resolveAgentIntegrationPaths() honors it over homedir(), CLAUDE_CONFIG_DIR and CODEX_HOME.
  const agentHome = makeScratchAgentHome()
  process.env.TERMPOLIS_TEST_AGENT_HOME = agentHome.dir

  // Kill any lingering Electron processes
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /f /im electron.exe 2>nul', { stdio: 'ignore' })
    } else {
      execSync('pkill -f electron 2>/dev/null || true', { stdio: 'ignore' })
    }
  } catch {}

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

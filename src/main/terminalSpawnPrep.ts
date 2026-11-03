// What opening a terminal needs from the file system, looked up on the thread pool instead of on the main thread.
//
// spawnTerminal (terminalManager.ts) used to ask for it synchronously: existsSync on the working folder, and
// existsSync (+ mkdirSync + writeFileSync the first time) on the PowerShell integration script. It runs from a
// person's click and from an agent's create_terminal call, on the thread that echoes every keystroke, where
// one such call has been measured at up to 1.5 s on a busy Windows laptop. A caller asks prepareSpawn() first and
// hands the answer to spawnTerminal, which then makes no file call at all. A caller that does not (a workflow
// step; a test) gets the synchronous lookups, as before.

import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { app } from 'electron'
import { detectShellKind, integrationDisabled, needsScriptFile, POWERSHELL_INTEGRATION_SCRIPT } from './shellIntegration'

export interface SpawnPrep {
  /** The folder the shell starts in: the one asked for when it exists, else the home folder. */
  cwd: string
  /** The PowerShell integration script, or null for a shell that has none or where it could not be written. */
  integrationScript: string | null
}

/** Where the integration script was last put on disk this run (null: not yet). Shared with terminalManager's
 *  synchronous fallback, so the two never write it twice. */
export const integrationScriptState: { path: string | null } = { path: null }

export const INTEGRATION_SCRIPT_NAME = 'termpolis-shell-integration.ps1'

/**
 * Put the PowerShell integration script on disk, once per app run, and again if something cleaned it up
 * mid-session. It goes in Termpolis's own data folder, never anywhere the user owns, and not the temp dir
 * (PowerShell running a script from %TEMP% is a pattern endpoint security flags). Null on any failure, which
 * the caller reads as "spawn exactly as before".
 */
export async function ensureIntegrationScriptAsync(): Promise<string | null> {
  try {
    const p = integrationScriptState.path ?? join(app.getPath('userData'), INTEGRATION_SCRIPT_NAME)
    let present = false
    if (integrationScriptState.path !== null) {
      try { await fsp.access(p); present = true } catch { /* cleaned up mid-session: written again below */ }
    }
    if (!present) {
      await fsp.mkdir(dirname(p), { recursive: true })
      await fsp.writeFile(p, POWERSHELL_INTEGRATION_SCRIPT, 'utf8')
    }
    integrationScriptState.path = p
    return p
  } catch {
    return null
  }
}

export async function prepareSpawn(cwd: string, executable: string): Promise<SpawnPrep> {
  let resolvedCwd: string
  try {
    await fsp.stat(cwd)
    resolvedCwd = cwd
  } catch {
    resolvedCwd = homedir()
  }
  const script = !integrationDisabled() && needsScriptFile(detectShellKind(executable)) ? await ensureIntegrationScriptAsync() : null
  return { cwd: resolvedCwd, integrationScript: script }
}

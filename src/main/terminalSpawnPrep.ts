// What opening a terminal needs from the file system, looked up on the thread pool instead of on the main thread.
//
// spawnTerminal (terminalManager.ts) used to ask for it synchronously: existsSync on the working folder, and
// existsSync (+ mkdirSync + writeFileSync the first time) on the shell's integration file. It runs from a
// person's click and from an agent's create_terminal call, on the thread that echoes every keystroke, where
// one such call has been measured at up to 1.5 s on a busy Windows laptop. A caller asks prepareSpawn() first and
// hands the answer to spawnTerminal, which then makes no file call at all. A caller that does not (a workflow
// step; a test) gets the synchronous lookups, as before.

import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { app } from 'electron'
import { detectShellKind, integrationDisabled, integrationFile, integrationFileSet, INTEGRATION_FILES, type IntegrationFile } from './shellIntegration'

export interface SpawnPrep {
  /** The folder the shell starts in: the one asked for when it exists, else the home folder. */
  cwd: string
  /** The shell's integration file (PowerShell's script, cmd's doskey macros, zsh's .zshenv, fish's file), or null for a shell that has none
   *  or where it could not be written. */
  integrationScript: string | null
}

/** Where each integration file was last put on disk this run, by file name (absent: not yet). Shared with
 *  terminalManager's synchronous fallback, so the two never write one twice. */
export const integrationScriptState: Record<string, string> = {}

export const INTEGRATION_SCRIPT_NAME = INTEGRATION_FILES.powershell.name

let tempCount = 0
/** A temp name beside `path`, its own for every write: concurrent writers (two terminals opening at once) never share one. */
export const wholeFileTempName = (path: string): string =>
  `${path}.${process.pid}.${++tempCount}.${Math.random().toString(36).slice(2, 8)}.tmp`

/**
 * Windows refuses a rename over a file another process has open (a shell reading it as it starts, a scanner) with
 * one of these. The file there is whole, so it stays: an older copy beats no integration and an error in spawn.
 */
export const RENAME_REFUSED = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Write `content` to `path` whole: to a temp file in the same folder, then renamed over it, so a shell starting while
 * another terminal rewrites the file reads the old one or the new one, never half of one. A refused rename over a file
 * that is there keeps that file and resolves; any other failure (or nothing there to keep) rejects. No temp file stays.
 */
export async function writeWholeFile(
  path: string,
  content: string,
  rename: (from: string, to: string) => unknown = fsp.rename,
): Promise<void> {
  const tmp = wholeFileTempName(path)
  await fsp.writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, path)
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    if (RENAME_REFUSED.has(String((e as NodeJS.ErrnoException).code))) {
      try { await fsp.access(path); return } catch { /* nothing there to keep: the failure stands */ }
    }
    throw e
  }
}

/**
 * Put a shell's integration file on disk, once per app run, and again if something cleaned it up mid-session.
 * It goes in Termpolis's own data folder, never anywhere the user owns, and not the temp dir (PowerShell running
 * a script from %TEMP% is a pattern endpoint security flags). Null on any failure, which the caller reads as
 * "spawn exactly as before".
 */
export async function ensureIntegrationScriptAsync(file: IntegrationFile = INTEGRATION_FILES.powershell): Promise<string | null> {
  try {
    const known = integrationScriptState[file.name]
    const p = known ?? join(app.getPath('userData'), file.name)
    const set = integrationFileSet(file, p) // zsh's .zshenv brings three siblings; every other shell one file
    let present = false
    if (known !== undefined) {
      try { await Promise.all(set.map((f) => fsp.access(f.path))); present = true } catch { /* cleaned up mid-session: written again below */ }
    }
    if (!present) {
      await fsp.mkdir(dirname(p), { recursive: true })
      for (const f of set) await writeWholeFile(f.path, f.content)
    }
    integrationScriptState[file.name] = p
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
  const file = integrationDisabled() ? null : integrationFile(detectShellKind(executable))
  const script = file ? await ensureIntegrationScriptAsync(file) : null
  return { cwd: resolvedCwd, integrationScript: script }
}

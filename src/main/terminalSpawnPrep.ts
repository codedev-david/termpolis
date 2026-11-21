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
import { logToApp } from './appLog'
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
 * Windows refuses a rename with one of these while another process has either file open: a shell reading the old file
 * as it starts, or a scanner reading the temp file just written (the classic case, on a fresh .ps1). It usually lets
 * go within milliseconds, so the rename is tried again (RENAME_RETRIES times, RENAME_RETRY_MS apart, as graceful-fs
 * does). Still refused: the old file is whole, so it stays (an older copy beats no integration and an error in spawn),
 * and with no old file the content is written straight to the file.
 */
export const RENAME_REFUSED = new Set(['EPERM', 'EBUSY', 'EACCES'])
export const RENAME_RETRIES = 4
export const RENAME_RETRY_MS = 50

export const isRenameRefused = (e: unknown): boolean => RENAME_REFUSED.has(String((e as NodeJS.ErrnoException)?.code))

/** 'written': the file now holds the content. 'kept': every rename was refused and the old file stayed, so the
 *  content is not on disk yet and a later spawn should try again. */
export type WholeFileResult = 'written' | 'kept'

export interface WholeFileIo {
  writeFile: (path: string, content: string) => unknown
  rename: (from: string, to: string) => unknown
  rm: (path: string) => unknown
  exists: (path: string) => boolean | Promise<boolean>
  sleep: (ms: number) => unknown
}

const realIo: WholeFileIo = {
  writeFile: (p, c) => fsp.writeFile(p, c, 'utf8'),
  rename: (from, to) => fsp.rename(from, to),
  rm: (p) => fsp.rm(p, { force: true }),
  exists: (p) => fsp.access(p).then(() => true, () => false),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Write `content` to `path` whole: to a temp file in the same folder, then renamed over it, so a shell starting while
 * another terminal rewrites the file reads the old one or the new one, never half of one. A refused rename is tried
 * again; still refused, it keeps a file that is there ('kept') or writes straight to the file when none is ('written').
 * Any other failure rejects with that failure. The temp file is removed whatever happened; when even that is refused
 * (the scanner still holds it) it is left behind, and the failure that matters is the one reported.
 */
export async function writeWholeFile(path: string, content: string, io: Partial<WholeFileIo> = {}): Promise<WholeFileResult> {
  const { writeFile, rename, rm, exists, sleep } = { ...realIo, ...io }
  const tmp = wholeFileTempName(path)
  try {
    await writeFile(tmp, content) // inside the try: a temp file cut short (a full disk) is removed below too
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, path)
        return 'written'
      } catch (e) {
        if (!isRenameRefused(e) || attempt >= RENAME_RETRIES) throw e
        await sleep(RENAME_RETRY_MS)
      }
    }
  } catch (e) {
    try { await rm(tmp) } catch { /* the temp file is still held: it is left, and `e` is what went wrong */ }
    if (!isRenameRefused(e)) throw e
    if (await exists(path)) return 'kept'
    await writeFile(path, content) // first run, nothing to keep: a direct write beats a terminal with no integration
    return 'written'
  }
}

const refusalsLogged = new Set<string>()
/** Tell the app log, once per file per run, that a refused rename kept an old integration file. */
export function logRenameRefusal(path: string, log: (line: string) => void = (line) => logToApp('warn', 'main', [line])): void {
  if (refusalsLogged.has(path)) return
  refusalsLogged.add(path)
  log(`[shell integration] ${path} could not be replaced (the rename was refused ${RENAME_RETRIES + 1} times; another program has it open). The old copy stays, and the next terminal tries again.`)
}

/**
 * Put a shell's integration file on disk, once per app run, and again if something cleaned it up mid-session.
 * It goes in Termpolis's own data folder, never anywhere the user owns, and not the temp dir (PowerShell running
 * a script from %TEMP% is a pattern endpoint security flags). Null on any failure, which the caller reads as
 * "spawn exactly as before".
 */
export async function ensureIntegrationScriptAsync(
  file: IntegrationFile = INTEGRATION_FILES.powershell,
  io: Partial<WholeFileIo> = {},
): Promise<string | null> {
  try {
    const known = integrationScriptState[file.name]
    const p = known ?? join(app.getPath('userData'), file.name)
    const set = integrationFileSet(file, p) // zsh's .zshenv brings three siblings; every other shell one file
    let present = false
    if (known !== undefined) {
      try { await Promise.all(set.map((f) => fsp.access(f.path))); present = true } catch { /* cleaned up mid-session: written again below */ }
    }
    let kept = false
    if (!present) {
      await fsp.mkdir(dirname(p), { recursive: true })
      for (const f of set) {
        if ((await writeWholeFile(f.path, f.content, io)) === 'kept') { kept = true; logRenameRefusal(f.path) }
      }
    }
    // An old copy kept by a refused rename is used, but not recorded as written: the next spawn tries again, so a
    // scanner that refuses once cannot freeze an old script (or zsh's four files half old, half new) for the run.
    if (kept) delete integrationScriptState[file.name]
    else integrationScriptState[file.name] = p
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

// The main side of the `lumopolis` shell command (the wire format is src/shared/world/lumopolisCommand.ts).
//
// The renderer's terminal parser catches the command's OSC 7377 sequence in a terminal's own output and asks
//   world:terminal-open { terminalId, payload, cwd? } → ok(folder)
// The answer is a folder that exists, or an error; the renderer then opens the Lumopolis pane on it. Nothing here
// runs anything: the payload is only ever read as a path, checked, and stat'ed. It is accepted only when:
//   - it names a terminal Termpolis started (an output stream from anywhere else has no terminal id),
//   - it carries this run's nonce (a file printed to the screen cannot know it),
//   - its folder is absolute, or relative with the terminal's own folder to resolve it against,
//   - and that folder exists and is a directory.
// A refusal the person should read (a folder that is not there, a folder of the shell's own) carries `show: true`,
// and the renderer shows it as a notice; one that only a forged request gets (no terminal, no nonce) stays silent.
// Any program running in the terminal can read the nonce from its environment, so a limiter per terminal allows at
// most one open of a folder every 3 seconds (REPEAT_MS) and 5 opens a minute (OPEN_LIMIT). Only an answer that
// opened something is counted, so a loop asking every second still opens the pane again every 3 seconds, up to 5
// times a minute, and no more: it cannot keep Lumopolis mapping and labelling folders on the person's tokens. A
// repeat inside the 3 seconds is still said, with the folder, so the notice can offer an Open button: the person who
// closed the pane and typed the command again at once gets it back with one click.
// `ipc` and the checks are parameters, so this module never imports Electron and tests pass fakes.
import { randomBytes } from 'crypto'
import { posix, win32 } from 'path'
import { normalizeShellPath } from '../../shared/cwdPath'
import { parseLumopolisPayload } from '../../shared/world/lumopolisCommand'
import { err, ok } from '../ipcResult'

export const TERMINAL_OPEN_CHANNEL = 'world:terminal-open'

export const NOT_A_TERMINAL = 'That is not a Termpolis terminal.'
export const NOT_A_REQUEST = 'That was not a lumopolis request from this Termpolis.'
export const NEEDS_FULL_PATH = 'lumopolis needs a full path here.'
export const TOO_MANY = 'lumopolis: too many requests from this terminal. Try again in a minute.'
export const noSuchFolder = (p: string): string => `lumopolis: no such folder: ${p}`
/** The shell's own folders on Windows (/tmp, /usr of Git Bash, MSYS2 zsh or fish) have no Windows path to open. */
export const shellOnly = (p: string): string =>
  `lumopolis: ${p} exists only inside this shell and has no Windows path, so it cannot be mapped. Use a folder on a drive, such as /c/Users.`
/** The same folder asked again at once: opened nothing, said with the folder for the notice's Open button. */
export const askedAgain = (folder: string): string => `lumopolis: ${folder} was asked for a moment ago. Open shows it again.`

/** The same folder again from the same terminal within this long opens nothing (a repeat). */
export const REPEAT_MS = 3000
/** At most this many opens a minute from one terminal. */
export const OPEN_LIMIT = 5
const LIMIT_WINDOW_MS = 60_000

export type OpenVerdict = 'ok' | 'repeat' | 'busy'
export type OpenLimiter = (terminalId: string, folder: string) => OpenVerdict

/** Counts the opens each terminal was answered; only an `ok` is counted. */
export function createOpenLimiter(now: () => number = Date.now): OpenLimiter {
  const seen = new Map<string, { folder: string; times: number[] }>()
  return (terminalId, folder) => {
    const t = now()
    const s = seen.get(terminalId) ?? { folder: '', times: [] }
    s.times = s.times.filter((at) => t - at < LIMIT_WINDOW_MS)
    const last = s.times[s.times.length - 1]
    if (s.folder === folder && last !== undefined && t - last < REPEAT_MS) return 'repeat'
    if (s.times.length >= OPEN_LIMIT) return 'busy'
    s.folder = folder
    s.times.push(t)
    seen.set(terminalId, s)
    return 'ok'
  }
}

/** A refusal the renderer shows to the person. */
const shown = (message: string) => ({ ...err(message), show: true as const })

export interface LumopolisOpenDeps {
  /** This run's nonce (lumopolisNonce()). */
  nonce: string
  /** Whether Termpolis started a terminal with this id (and it is still open). */
  hasTerminal(id: string): boolean
  /** True only for an existing directory. Never rejects. */
  isDirectory(p: string): Promise<boolean>
  platform: NodeJS.Platform
  homedir: string
  /** The limiter's clock; Date.now by default. */
  now?(): number
}

export interface LumopolisOpenIpc {
  handle(channel: string, listener: (event: unknown, args?: unknown) => unknown): void
}

/** 16 random bytes as 32 hex characters. */
export const createLumopolisNonce = (): string => randomBytes(16).toString('hex')

let runNonce: string | null = null
/** The nonce for this app run: made once, then the same for every shell. */
export function lumopolisNonce(): string {
  runNonce ??= createLumopolisNonce()
  return runNonce
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** An absolute path with a drive or a share (Windows), or a leading slash (everywhere else). */
const isFull = (p: string, isWin: boolean): boolean => (isWin ? /^([A-Za-z]:\\|\\\\[^\\])/.test(p) : p.startsWith('/'))

/**
 * The folder a lumopolis request names, made absolute and canonical (no `..`), or null when it cannot be: a
 * relative folder with no usable terminal folder to resolve it against, or a rooted path the platform cannot open.
 */
export function folderOf(raw: string, cwd: string | null, platform: NodeJS.Platform, homedir: string): string | null {
  const isWin = platform === 'win32'
  const mod = isWin ? win32 : posix
  const opts = { platform, homedir }
  const n = normalizeShellPath(raw, opts)
  if (n !== null && isFull(n, isWin)) return mod.resolve(n)
  // Rooted but not openable (an MSYS-only path like /usr/bin on Windows): not a relative path either.
  if (/^[\\/]/.test(raw.trim())) return null
  const base = cwd === null ? null : normalizeShellPath(cwd, opts)
  if (base === null || !isFull(base, isWin)) return null
  return mod.resolve(base, raw.trim())
}

/** Checks one request (see the header); answers the folder to open or the reason it is refused. */
export async function resolveLumopolisOpen(args: unknown, deps: LumopolisOpenDeps, limit?: OpenLimiter) {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const terminalId = str(a.terminalId)
  if (terminalId === null || !deps.hasTerminal(terminalId)) return err(NOT_A_TERMINAL)
  const req = parseLumopolisPayload(a.payload)
  if (req === null || req.nonce !== deps.nonce) return err(NOT_A_REQUEST)
  const folder = folderOf(req.path, str(a.cwd), deps.platform, deps.homedir)
  if (folder === null) return shown(/^[\\/]/.test(req.path.trim()) ? shellOnly(req.path) : NEEDS_FULL_PATH)
  if (!(await deps.isDirectory(folder))) return shown(noSuchFolder(req.path))
  const verdict = limit ? limit(terminalId, folder) : 'ok'
  if (verdict === 'repeat') return { ...shown(askedAgain(folder)), folder }
  if (verdict === 'busy') return shown(TOO_MANY)
  return ok(folder)
}

export function registerLumopolisIpc(ipc: LumopolisOpenIpc, deps: LumopolisOpenDeps): void {
  const limit = createOpenLimiter(deps.now)
  ipc.handle(TERMINAL_OPEN_CHANNEL, (_event: unknown, args?: unknown) => resolveLumopolisOpen(args, deps, limit))
}

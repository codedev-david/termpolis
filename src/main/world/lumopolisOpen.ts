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
export const noSuchFolder = (p: string): string => `lumopolis: no such folder: ${p}`

export interface LumopolisOpenDeps {
  /** This run's nonce (lumopolisNonce()). */
  nonce: string
  /** Whether Termpolis started a terminal with this id (and it is still open). */
  hasTerminal(id: string): boolean
  /** True only for an existing directory. Never rejects. */
  isDirectory(p: string): Promise<boolean>
  platform: NodeJS.Platform
  homedir: string
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
export async function resolveLumopolisOpen(args: unknown, deps: LumopolisOpenDeps) {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const terminalId = str(a.terminalId)
  if (terminalId === null || !deps.hasTerminal(terminalId)) return err(NOT_A_TERMINAL)
  const req = parseLumopolisPayload(a.payload)
  if (req === null || req.nonce !== deps.nonce) return err(NOT_A_REQUEST)
  const folder = folderOf(req.path, str(a.cwd), deps.platform, deps.homedir)
  if (folder === null) return err(NEEDS_FULL_PATH)
  if (!(await deps.isDirectory(folder))) return err(noSuchFolder(req.path))
  return ok(folder)
}

export function registerLumopolisIpc(ipc: LumopolisOpenIpc, deps: LumopolisOpenDeps): void {
  ipc.handle(TERMINAL_OPEN_CHANNEL, (_event: unknown, args?: unknown) => resolveLumopolisOpen(args, deps))
}

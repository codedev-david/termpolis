// Where a paired phone may open a terminal or browse.
//
// A phone with "Start terminals" picks the folder an agent starts in, and an agent
// works on whatever folder it starts in. Before 1.60 any folder was accepted, so a
// crafted request could start one in C:\Windows or /etc. The fence is:
//
//   - the desktop user's home folder and everything under it, and
//   - on Windows, any OTHER local drive (D:\, E:\, ...) -- projects live there,
//     and the folder picker has offered them since issue #35 --
//   - but never the system drive outside home, never `/` outside home, and never
//     a network or device path.
//
// Checked on the REAL path: `..` is resolved and every link followed before the
// comparison, so neither a `home/../..` nor a link under home that leads to
// C:\Windows gets out. Windows paths compare case-insensitively.
import { realpath as realpathCallback } from 'fs'
import { homedir } from 'os'
import { posix, win32 } from 'path'
import { promisify } from 'util'

/** The JS realpath, as the folder picker uses: the native one turns a mapped
 *  drive into its UNC path, which would then read as a network path. */
const realpathJs = promisify(realpathCallback)

export interface FenceDeps {
  realpath?: (path: string) => Promise<string>
  home?: string
  platform?: NodeJS.Platform
  /** `C:` unless Windows says otherwise. */
  systemDrive?: string
}

/** A network or device path: `\\host\share`, `//host/share`, `\\?\`, `\\.\`.
 *
 *  Refused before any filesystem call. On Windows, so much as checking that
 *  `\\host\share` exists connects to that host and offers it the user's NTLM
 *  hash, so a phone that could name one could make the desktop authenticate to a
 *  server of its choosing. */
export function isNetworkOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

const DRIVE_RE = /^([a-z]):(?:[\\/]|$)/i

function keyOf(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.toLowerCase().replace(/\//g, '\\') : path
}

/** `child` is `parent` or inside it. Both are real, absolute paths. */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const c = keyOf(child, platform)
  const p = keyOf(parent, platform)
  if (c === p) return true
  const sep = platform === 'win32' ? '\\' : '/'
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

function systemDriveOf(deps: FenceDeps): string {
  const raw = deps.systemDrive ?? process.env.SystemDrive ?? 'C:'
  const m = /^([a-z]):?$/i.exec(raw.trim())
  return (m ? m[1] : 'c').toLowerCase()
}

/** On a drive a phone may use: on Windows any drive but the system one.
 *  Elsewhere none -- `/` is the system. */
export function isOnAllowedDrive(root: string, deps: FenceDeps = {}): boolean {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return false
  const m = DRIVE_RE.exec(root)
  return m !== null && m[1].toLowerCase() !== systemDriveOf(deps)
}

/** Whether a REAL path is inside the fence, given the real home. */
export function isInsideFence(real: string, home: string, deps: FenceDeps = {}): boolean {
  const platform = deps.platform ?? process.platform
  if (isNetworkOrDevicePath(real)) return false
  if (isWithin(real, home, platform)) return true
  return isOnAllowedDrive(real, deps)
}

/** The real home folder; the plain one when it cannot be resolved. */
export async function realHome(deps: FenceDeps = {}): Promise<string> {
  const home = deps.home ?? homedir()
  try {
    return await (deps.realpath ?? realpathJs)(home)
  } catch {
    return home
  }
}

/** Why a phone's folder was refused. One sentence, shown on the phone. */
export const FOLDER_OUTSIDE_FENCE =
  'That folder is outside what a phone may open: your home folder, or on Windows another drive than the system one.'
export const FOLDER_NOT_FOUND = 'That folder does not exist on the desktop.'
export const FOLDER_NETWORK = 'A phone cannot open a terminal on a network or device path.'

/**
 * The real folder a phone's request names, or why it may not be used.
 *
 * A relative path is taken from home, the folder the picker opens at. The
 * answer is the REAL path, and it is what the terminal is started in: checking
 * one path and starting in another would let a link swapped in between the two
 * move the terminal out of the fence.
 */
export async function fenceFolder(
  raw: string,
  deps: FenceDeps = {},
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (isNetworkOrDevicePath(raw)) return { ok: false, reason: FOLDER_NETWORK }
  const home = await realHome(deps)
  // The desktop's own path rules, so `..` and drive letters read as it reads them.
  const { resolve } = (deps.platform ?? process.platform) === 'win32' ? win32 : posix
  let real: string
  try {
    real = await (deps.realpath ?? realpathJs)(resolve(home, raw))
  } catch {
    return { ok: false, reason: FOLDER_NOT_FOUND }
  }
  if (isNetworkOrDevicePath(real)) return { ok: false, reason: FOLDER_NETWORK }
  if (!isInsideFence(real, home, deps)) return { ok: false, reason: FOLDER_OUTSIDE_FENCE }
  return { ok: true, path: real }
}

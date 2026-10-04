/**
 * Self-heal for the recurring "Termpolis shows a GENERIC icon in the Windows
 * taskbar" bug.
 *
 * ROOT CAUSE: electron-builder hands package.json `description` to NSIS as the
 * shortcut description, and it is stored in the .lnk StringData block. Every
 * StringData field is bounded at MAX_PATH (260 chars). An over-long description
 * overruns that bound and corrupts the fields serialized right after it —
 * WORKING_DIR and, fatally, ICON_LOCATION. Measured with the 288-char description
 * Termpolis shipped: IconLocation read back as "xe?,0", an unresolvable path, so
 * Windows fell back to a generic icon. At 40 chars it round-tripped intact.
 *
 * Why the window icon didn't save us: the app declares an AppUserModelID that
 * MATCHES the installed shortcut, so Windows resolves the taskbar button's icon
 * from the SHORTCUT, not from the BrowserWindow icon. A corrupt ICON_LOCATION
 * therefore beats anything main sets on the window — which is why the earlier
 * fixes (v1.15.10 AUMID + window icon, v1.16.2 icon-cache refresh) never held.
 *
 * Shortening the description fixes shortcuts the installer writes from now on, but
 * the PINNED TASKBAR shortcut lives in the user's profile and is never rewritten by
 * the installer — so existing users would stay broken forever. This module repairs
 * the shortcuts in place at startup.
 *
 * The same blank pin has a second cause: the pinned shortcut DELETED while the pin
 * stays. Defender's quarantine of the unsigned v1.49.1 took Termpolis.exe and every
 * shortcut to it; reinstalling writes the Start-menu and desktop shortcuts again, but
 * never the pinned one. restoreVanishedTaskbarPin writes it back.
 *
 * Everything is injected so the logic is testable without touching a real registry,
 * filesystem, or Electron shell.
 */

import path from 'path'

/** Max characters in a Shell Link StringData field (MAX_PATH). */
export const MAX_LNK_STRING = 260

/** Keep repaired descriptions far below the limit — room to grow without corrupting. */
export const SAFE_DESCRIPTION_LIMIT = 200

export interface ShortcutLinkDetails {
  target?: string
  cwd?: string
  args?: string
  description?: string
  icon?: string
  iconIndex?: number
  appUserModelId?: string
}

/**
 * What we hand to `writeShortcutLink`. Electron's own ShortcutDetails requires `target`,
 * so the write side narrows it — a repair that omitted the target would produce a .lnk
 * pointing nowhere, which is worse than the broken icon we came to fix.
 */
export type ShortcutWriteDetails = ShortcutLinkDetails & { target: string }

export interface ShortcutRepairDeps {
  platform: string
  /** Absolute path to the running Termpolis.exe. */
  exePath: string
  /** The AppUserModelID the app declares — must match what the shortcut carries. */
  appUserModelId: string
  /** Description to write; clamped to SAFE_DESCRIPTION_LIMIT before use. */
  description: string
  /** Shortcut paths to inspect (Start menu, pinned taskbar, desktop). */
  candidatePaths: string[]
  fileExists: (path: string) => boolean
  readShortcutLink: (path: string) => ShortcutLinkDetails
  writeShortcutLink: (path: string, operation: 'update', details: ShortcutWriteDetails) => boolean
  /** Directory of the exe, used as the shortcut's working directory. */
  exeDir: string
  log?: (message: string) => void
}

export interface ShortcutRepairResult {
  /** Shortcuts that were rewritten. */
  repaired: string[]
  /** Shortcuts inspected and found healthy. */
  healthy: string[]
  /** Shortcuts that could not be read or written. */
  failed: string[]
}

/**
 * Decide whether a shortcut's stored details are damaged (or would become damaged
 * the next time something rewrites them).
 */
export function isShortcutDamaged(
  details: ShortcutLinkDetails,
  expected: { exePath: string; appUserModelId: string },
  fileExists: (path: string) => boolean,
): boolean {
  // The corruption signature: ICON_LOCATION lost or pointing at a path that is not
  // on disk (e.g. the truncated "olis.exe" left behind by the overflow).
  if (!details.icon) return true
  if (!fileExists(details.icon)) return true

  // A description at/over the limit will overrun the StringData bound and corrupt
  // the following fields on the next write — repair it before that happens.
  if ((details.description?.length ?? 0) >= MAX_LNK_STRING) return true

  // Target drift (app moved/reinstalled elsewhere) also yields a dead icon source.
  if (details.target && details.target.toLowerCase() !== expected.exePath.toLowerCase()) return true

  // Without a matching AUMID the taskbar button won't merge with the pinned entry.
  if (details.appUserModelId !== expected.appUserModelId) return true

  return false
}

/**
 * Inspect the known Termpolis shortcuts and rewrite any whose icon/target/AUMID are
 * damaged. No-op off Windows. Never throws — a shortcut we cannot fix is recorded
 * and skipped, because failing to repair an icon must never block app startup.
 */
export function repairWindowsShortcuts(deps: ShortcutRepairDeps): ShortcutRepairResult {
  const result: ShortcutRepairResult = { repaired: [], healthy: [], failed: [] }
  if (deps.platform !== 'win32') return result

  const description = deps.description.slice(0, SAFE_DESCRIPTION_LIMIT)
  const expected = { exePath: deps.exePath, appUserModelId: deps.appUserModelId }

  for (const path of deps.candidatePaths) {
    if (!deps.fileExists(path)) continue

    let details: ShortcutLinkDetails
    try {
      details = deps.readShortcutLink(path)
    } catch {
      result.failed.push(path)
      continue
    }

    if (!isShortcutDamaged(details, expected, deps.fileExists)) {
      result.healthy.push(path)
      continue
    }

    try {
      // Write every string field explicitly. An 'update' that left the old
      // over-long description in place would re-corrupt the very fields we are
      // repairing, so the short description is part of the fix, not a nicety.
      const ok = deps.writeShortcutLink(path, 'update', {
        target: deps.exePath,
        cwd: deps.exeDir,
        icon: deps.exePath,
        iconIndex: 0,
        appUserModelId: deps.appUserModelId,
        description,
      })
      if (ok) {
        result.repaired.push(path)
        deps.log?.(`Repaired damaged Windows shortcut icon: ${path}`)
      } else {
        result.failed.push(path)
      }
    } catch {
      result.failed.push(path)
    }
  }

  return result
}

/**
 * The three places Windows keeps a Termpolis shortcut for the current user. The
 * pinned-taskbar entry is the one that matters most: the installer never touches it,
 * so it keeps a corrupt icon across every reinstall and update.
 */
export function defaultShortcutPaths(
  env: Record<string, string | undefined>,
  joinPath: (...parts: string[]) => string,
  shortcutName = 'Termpolis',
): string[] {
  const paths: string[] = []
  const appData = env['APPDATA']
  const userProfile = env['USERPROFILE']
  const file = `${shortcutName}.lnk`

  if (appData) paths.push(joinPath(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', file))
  const pin = taskbarPinPath(env, joinPath, shortcutName)
  if (pin) paths.push(pin)
  if (userProfile) paths.push(joinPath(userProfile, 'Desktop', file))

  return paths
}

/** The pinned-taskbar shortcut, or null without APPDATA. */
export function taskbarPinPath(
  env: Record<string, string | undefined>,
  joinPath: (...parts: string[]) => string,
  shortcutName = 'Termpolis',
): string | null {
  const appData = env['APPDATA']
  if (!appData) return null
  return joinPath(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', `${shortcutName}.lnk`)
}

/** Where Explorer records the taskbar pins. Its `Favorites` value names each pinned shortcut. */
export const TASKBAND_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband'

/**
 * The bytes of `valueName` in `reg query <key> /v <valueName>` output, or null when the output
 * holds no such REG_BINARY value. reg.exe prints the value as one line of hex, and an empty value
 * as nothing after the type.
 */
export function parseRegBinary(stdout: string, valueName: string): Buffer | null {
  const want = valueName.toLowerCase()
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s+REG_BINARY(?:\s+([0-9A-Fa-f]*))?\s*$/.exec(line)
    if (!m || m[1].toLowerCase() !== want) continue
    const hex = m[2] ?? ''
    return hex.length % 2 === 0 ? Buffer.from(hex, 'hex') : null
  }
  return null
}

/**
 * Whether Explorer's pin record names `fileName`. Each pin is stored as a shell item ID list whose
 * long file name is UTF-16LE at whatever offset the structure before it leaves, odd as often as
 * even, so the record is read at both byte alignments. Case-insensitive, as NTFS names are.
 */
export function pinRecordNames(record: Buffer, fileName: string): boolean {
  const want = fileName.toLowerCase()
  return [record, record.subarray(1)].some((bytes) => bytes.toString('utf16le').toLowerCase().includes(want))
}

/** Runs a binary without a shell; production passes procClient's execCaptureOffThread. */
export type CaptureRunner = (bin: string, args: string[]) => Promise<{ stdout: string; error?: unknown }>

/**
 * Explorer's record of the taskbar pins (the Taskband `Favorites` value), or null when it cannot be
 * read; reg.exe fails when nothing has ever been pinned. reg.exe by absolute path, so a reg.exe
 * planted on PATH or in the cwd can't stand in. Never rejects.
 */
export async function readTaskbarPinRecord(
  run: CaptureRunner,
  env: Record<string, string | undefined> = process.env,
): Promise<Buffer | null> {
  const reg = path.win32.join(env['SystemRoot'] || env['windir'] || 'C:\\Windows', 'System32', 'reg.exe')
  try {
    const r = await run(reg, ['query', TASKBAND_KEY, '/v', 'Favorites'])
    return r.error ? null : parseRegBinary(r.stdout, 'Favorites')
  } catch {
    return null
  }
}

export interface PinRestoreDeps {
  platform: string
  /** Absolute path to the running Termpolis.exe. */
  exePath: string
  /** Directory of the exe, used as the shortcut's working directory. */
  exeDir: string
  /** The AppUserModelID the app declares; the pin must carry it for the window to merge into it. */
  appUserModelId: string
  /** Description to write; clamped to SAFE_DESCRIPTION_LIMIT before use. */
  description: string
  /** The pinned-taskbar shortcut (taskbarPinPath), or null when it cannot be located. */
  pinPath: string | null
  fileExists: (path: string) => boolean
  /** Explorer's record of the taskbar pins (readTaskbarPinRecord), or null when unreadable. */
  readPinRecord: () => Promise<Buffer | null>
  writeShortcutLink: (path: string, operation: 'create', details: ShortcutWriteDetails) => boolean
  log?: (message: string) => void
}

export type PinRestoreOutcome = 'skipped' | 'present' | 'not-pinned' | 'restored' | 'failed'

/**
 * Write the pinned-taskbar shortcut back when Explorer still lists the pin but the file is gone.
 *
 * repairWindowsShortcuts mends only shortcuts that exist. A pinned shortcut deleted out from under
 * Explorer leaves the pin on the taskbar with nothing to draw its icon from, and the running window
 * merges into that blank pin because they share the AppUserModelID. No reinstall fixes it: the
 * installer writes the Start-menu and desktop shortcuts, never the pinned one.
 *
 * Explorer's own pin record is the guard. Unpinning removes the shortcut AND its entry in the
 * record, so a shortcut that is missing while the record still names it was removed by something
 * else (Defender, a cleanup tool), and writing it back cannot undo a choice the user made.
 * writeShortcutLink announces the new file to the shell (SHCNE_CREATE), and the taskbar redraws
 * the pin from it without an Explorer restart.
 *
 * Never rejects: an icon must never be able to break startup.
 */
export async function restoreVanishedTaskbarPin(deps: PinRestoreDeps): Promise<PinRestoreOutcome> {
  const pinPath = deps.pinPath
  if (deps.platform !== 'win32' || !pinPath) return 'skipped'
  try {
    if (deps.fileExists(pinPath)) return 'present'
    const record = await deps.readPinRecord()
    if (!record || !pinRecordNames(record, path.win32.basename(pinPath))) return 'not-pinned'
    const ok = deps.writeShortcutLink(pinPath, 'create', {
      target: deps.exePath,
      cwd: deps.exeDir,
      icon: deps.exePath,
      iconIndex: 0,
      appUserModelId: deps.appUserModelId,
      description: deps.description.slice(0, SAFE_DESCRIPTION_LIMIT),
    })
    if (!ok) return 'failed'
    deps.log?.(`Restored the vanished Windows taskbar pin: ${pinPath}`)
    return 'restored'
  } catch {
    return 'failed'
  }
}

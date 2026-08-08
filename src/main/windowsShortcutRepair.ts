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
 * Everything is injected so the logic is testable without touching a real registry,
 * filesystem, or Electron shell.
 */

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

  if (appData) {
    paths.push(joinPath(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', file))
    paths.push(
      joinPath(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', file),
    )
  }
  if (userProfile) paths.push(joinPath(userProfile, 'Desktop', file))

  return paths
}

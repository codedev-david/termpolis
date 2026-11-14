// Runs second in src/main/index.ts (right after threadpoolEnv), before anything can spawn a child.
//
// WHY: a snap starts Termpolis through electron-builder's launcher scripts (desktop-init.sh,
// desktop-common.sh, desktop-gnome-specific.sh in app-builder-lib/templates/snap). They are written for
// a confined GUI app and export a pile of variables pointing into the snap: XDG_CONFIG_HOME,
// XDG_DATA_HOME and XDG_CACHE_HOME move to ~/snap/termpolis/..., GTK/GDK/GIO/GStreamer get their own
// module paths, Wayland gets forced, LD_LIBRARY_PATH and XDG_DATA_DIRS grow snap entries. Termpolis is a
// terminal: everything in process.env is inherited by every shell and agent CLI it starts, so a user's
// `nvim`, `git` or Claude Code would read and write its config under ~/snap/termpolis instead of ~/.config,
// and a GUI program started from a Termpolis shell would load the launcher's GTK caches. The Snap Store
// build is CLASSIC (it runs on the host's own libraries, exactly like the .deb), so none of this is needed
// by Termpolis itself either: undoing it here makes the snap run as the .deb does.
//
// Only what the launcher put there is removed. Variables the launcher always sets are dropped; path lists
// lose only the entries that point into the snap (or at snapd's GL folders); the XDG homes go only when
// they point into the snap's user folders; the Wayland backends go only when the launcher's own flag says
// it set them and they still hold its values. snapd's own SNAP_* variables stay (the updater and
// runsFromSnap read SNAP).

import { runsFromSnap } from './noNewPrivs'

/** Set unconditionally by the launcher scripts, read by nothing a user starts. */
export const SNAP_LAUNCHER_VARS: readonly string[] = [
  'REALHOME', 'SNAP_DESKTOP_COMPONENTS_NEED_UPDATE', 'SNAP_DESKTOP_ARCH_TRIPLET', 'SNAP_DESKTOP_WAYLAND_AVAILABLE',
  'XKB_CONFIG_ROOT', 'XLOCALEDIR', 'XCURSOR_PATH', 'LIBGL_DRIVERS_PATH', 'LIBVA_DRIVERS_PATH',
  'GST_PLUGIN_PATH', 'GST_PLUGIN_SYSTEM_PATH', 'GST_PLUGIN_SCANNER', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
  'GIO_MODULE_DIR', 'GDK_PIXBUF_MODULE_FILE', 'GDK_PIXBUF_MODULEDIR', 'GTK_PATH', 'GTK_IM_MODULE_FILE',
]

/** Colon-separated lists the launcher prepends or appends to. */
export const SNAP_PATH_LISTS: readonly string[] = [
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'GI_TYPELIB_PATH', '__EGL_VENDOR_LIBRARY_DIRS', 'LOCPATH', 'PATH',
]

/** The XDG homes the launcher moves into the snap's user folders. */
export const SNAP_XDG_HOMES: readonly string[] = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']

/** What the launcher forces when SNAP_DESKTOP_WAYLAND_AVAILABLE is "true". */
export const SNAP_WAYLAND_VARS: Readonly<Record<string, string>> = {
  GDK_BACKEND: 'wayland', CLUTTER_BACKEND: 'wayland', QT_QPA_PLATFORM: 'wayland-egl',
}

/** Entries the launcher adds outside the snap when the desktop runtime is empty (the classic build). */
const HOST_ENTRIES_ADDED = /^\/var\/lib\/snapd\/lib\/(gl|glvnd)(\/|$)|^\/usr\/lib\/[^/]+-linux-gnu[^/]*\/(mesa|mesa-egl|dri|libunity|pulseaudio)$|^\/usr\/lib\/locale$/

function trimSlash(p: string | undefined): string {
  return (p ?? '').replace(/\/+$/, '')
}

function inside(path: string, roots: readonly string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(`${r}/`))
}

/** What cleanSnapLauncherEnv changed, for the log line and the tests. */
export interface SnapEnvCleanup {
  removed: string[]
  trimmed: string[]
  /** The launcher had moved XDG_CONFIG_HOME into the snap: Electron may already have taken it for userData. */
  configHomeMoved: boolean
}

/**
 * Undo electron-builder's snap launcher in `env` (mutated in place). Pure apart from that: no fs, no process.
 * Does nothing without SNAP.
 */
export function cleanSnapLauncherEnv(env: NodeJS.ProcessEnv): SnapEnvCleanup {
  const out: SnapEnvCleanup = { removed: [], trimmed: [], configHomeMoved: false }
  const snap = trimSlash(env.SNAP)
  if (!snap) return out
  const userRoots = [trimSlash(env.SNAP_USER_DATA), trimSlash(env.SNAP_USER_COMMON)].filter(Boolean)
  const snapRoots = [snap, ...userRoots]
  const drop = (name: string): void => {
    if (env[name] === undefined) return
    delete env[name]
    out.removed.push(name)
  }

  if (env.SNAP_DESKTOP_WAYLAND_AVAILABLE === 'true') {
    for (const [name, value] of Object.entries(SNAP_WAYLAND_VARS)) if (env[name] === value) drop(name)
  }
  for (const name of SNAP_XDG_HOMES) {
    const value = env[name]
    if (value && inside(trimSlash(value), userRoots)) {
      if (name === 'XDG_CONFIG_HOME') out.configHomeMoved = true
      drop(name)
    }
  }
  for (const name of SNAP_LAUNCHER_VARS) drop(name)
  for (const name of SNAP_PATH_LISTS) {
    const value = env[name]
    if (value === undefined) continue
    const parts = value.split(':')
    // An empty entry is left alone: the launcher never adds one (it uses ${VAR:+...}), and on PATH it means
    // "the current folder" to whoever put it there.
    const kept = parts.filter((p) => p === '' || (!inside(trimSlash(p), snapRoots) && !HOST_ENTRIES_ADDED.test(trimSlash(p))))
    if (kept.length === parts.length) continue
    if (kept.length) {
      env[name] = kept.join(':')
      out.trimmed.push(name)
    } else {
      drop(name)
    }
  }
  return out
}

/** Set when this process runs from a snap and the cleanup ran; null otherwise. */
export const snapEnvCleanup: SnapEnvCleanup | null = runsFromSnap(process.env, process.execPath)
  ? cleanSnapLauncherEnv(process.env)
  : null

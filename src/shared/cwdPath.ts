/**
 * Turning what a shell SAYS its directory is into a path the filesystem agrees with.
 *
 * Every shell reports its location in its own dialect, and most of them are not
 * openable paths on Windows:
 *
 *   PowerShell   C:\Users\dev\repo
 *   cmd.exe      C:\Users\dev\repo
 *   Git Bash     /c/Users/dev/repo          (MSYS)
 *   Cygwin       /cygdrive/c/Users/dev/repo
 *   WSL          /mnt/c/Users/dev/repo
 *   any of them  file:///C:/Users/dev/my%20repo   (OSC 7 wraps it in a URI)
 *   all of them  ~/repo                     (when the prompt abbreviates home)
 *
 * Handing any of the last five straight to `git -C` fails, and the failure is
 * invisible: git:change-counts catches it and answers null, which the dot reads as
 * "not a repo" and renders nothing. That is precisely the reported symptom — the mark
 * appears, the shell reports a path in its own dialect, and the mark vanishes. So this
 * module is not tidying: it is the difference between the feature working and the
 * feature silently disappearing.
 *
 * Pure and platform-injectable so the Windows dialects are testable off Windows.
 * Shared by main (spawn-time resolution) and the renderer (live OSC reports), which is
 * why it lives in src/shared rather than either tree.
 */

export interface PathOptions {
  /** Defaults to the host platform. Injected so win32 dialects are testable anywhere. */
  platform?: NodeJS.Platform
  /** Expansion target for a leading `~`. Omitted means "leave ~ alone" (we cannot guess). */
  homedir?: string
}

/**
 * The host platform, asked for in a way that cannot throw.
 *
 * This module is imported by the RENDERER as well as main, and under context isolation
 * a renderer has no `process` at all — a bare `process.platform` there is a
 * ReferenceError, not a wrong answer, and it would take out the whole data handler it
 * was called from. Callers in the renderer pass `platform` explicitly; this is the
 * backstop for the ones that forget.
 */
function hostPlatform(): NodeJS.Platform {
  try {
    if (typeof process !== 'undefined' && process?.platform) return process.platform
  } catch {
    /* no process here */
  }
  // Best available guess in a browser-like host. Wrong only for the separator and
  // case rules, never for whether a path is returned at all.
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows/i.test(ua)) return 'win32'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'darwin'
  return 'linux'
}

/** A single drive letter followed by a separator or the end of the string. */
const MSYS_DRIVE = /^\/([A-Za-z])(\/.*)?$/
const CYGDRIVE = /^\/cygdrive\/([A-Za-z])(\/.*)?$/
const WSL_MNT = /^\/mnt\/([A-Za-z])(\/.*)?$/

/**
 * Decode an OSC 7 payload — `file://<host>/<path>` — into a filesystem path.
 *
 * The host is deliberately ignored rather than matched against the local hostname.
 * Shells disagree about what belongs there (bash sends $HOSTNAME, some send nothing,
 * containers send an id nobody can resolve), and rejecting on a mismatch would turn a
 * cosmetic disagreement into a silently dead git mark. A genuinely remote path fails
 * the existence check later, which is the right place to lose it.
 */
export function decodeOsc7(payload: string, opts: PathOptions = {}): string | null {
  const pathPart = osc7PathPart(payload)
  if (pathPart === null) return null
  return normalizeShellPath(pathPart, opts)
}

/**
 * The path component of an OSC 7 payload, percent-decoded but NOT normalized.
 *
 * Exists because a null from decodeOsc7 means two different things to a caller, and
 * only one of them should be ignored:
 *
 *   - the payload was never a file:// URI — garbage, drop it;
 *   - it was a valid URI naming a directory THIS platform cannot open. WSL running
 *     inside a Windows build reports `file://host/home/dev` exactly like this.
 *
 * The second is a real relocation, and a caller that ignores it leaves the terminal
 * pointing at the directory the shell has just left — so the git mark reports the old
 * directory's changes as if they were the new one's. Falling back to the undecoded
 * path instead lets git fail cleanly on it, which blanks the mark honestly. Only this
 * function can hand the caller that path, hence the split.
 */
export function osc7PathPart(payload: string): string | null {
  const raw = payload.trim()
  if (!raw.toLowerCase().startsWith('file://')) return null

  const afterScheme = raw.slice('file://'.length)
  // The first '/' ends the host. `file:///c:/x` gives an empty host; `file://box/c:/x`
  // gives "box". Anything with no '/' at all carries no path and is unusable.
  const slash = afterScheme.indexOf('/')
  if (slash === -1) return null
  const pathPart = afterScheme.slice(slash)

  // Percent-decoding is what makes `my%20repo` openable. A malformed escape throws
  // rather than returning a wrong answer, and a wrong answer here is a path that
  // points somewhere real but different — so take the undecoded form instead.
  try {
    return decodeURIComponent(pathPart)
  } catch {
    return pathPart
  }
}

/**
 * Normalize any shell-reported path into a real filesystem path, or null if the input
 * cannot be one.
 *
 * Returns null rather than a best guess for empty/garbage input: a wrong path and a
 * missing path both blank the mark, but a wrong one also points git at someone else's
 * repository, and reporting another directory's changes as yours is worse than
 * reporting none.
 */
export function normalizeShellPath(raw: string, opts: PathOptions = {}): string | null {
  const platform = opts.platform ?? hostPlatform()
  const isWin = platform === 'win32'

  if (typeof raw !== 'string') return null
  let p = raw.trim()
  if (!p) return null

  // Shells quote paths containing spaces; the quotes are never part of the path.
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim()
    if (!p) return null
  }

  // A URI can arrive here directly (a prompt that prints one, a nested OSC payload).
  if (p.toLowerCase().startsWith('file://')) return decodeOsc7(p, opts)

  // NUL or control characters mean we are looking at mis-framed terminal bytes, not a
  // path. Accepting them would write junk into the store and poll git with it forever.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) return null

  // `~` and `~/x` — but NOT `~user/x`, whose home we cannot resolve without a lookup
  // we have no business doing. Left verbatim, it fails the existence check cleanly.
  if (opts.homedir && (p === '~' || p.startsWith('~/') || (isWin && p.startsWith('~\\')))) {
    const rest = p.slice(1).replace(/^[/\\]/, '')
    p = rest ? joinNative(opts.homedir, rest, isWin) : opts.homedir
    return trimTrailingSep(p, isWin)
  }

  if (isWin) {
    // A URI-shaped drive path. `file:///C:/repo` has an empty authority, so its path
    // component decodes to "/C:/repo" — the leading slash belongs to the URI, not to
    // the filesystem. Stripped first so the plain-drive rules below see "C:/repo".
    // Unambiguous: a colon cannot appear in a Windows path segment, so no real
    // Unix-shaped path can take this form.
    if (/^\/[A-Za-z]:([/\\]|$)/.test(p)) p = p.slice(1)

    // The Unix-shaped dialects, most specific first: /cygdrive/c/x and /mnt/c/x both
    // start with a single letter segment too, so MSYS must be tried last or it would
    // read "/mnt/c/x" as drive M.
    const cyg = CYGDRIVE.exec(p)
    if (cyg) return driveToWindows(cyg[1], cyg[2])
    const wsl = WSL_MNT.exec(p)
    if (wsl) return driveToWindows(wsl[1], wsl[2])
    const msys = MSYS_DRIVE.exec(p)
    if (msys) return driveToWindows(msys[1], msys[2])

    // UNC: //server/share (posix-style) → \\server\share
    if (/^\/\/[^/]/.test(p)) return trimTrailingSep('\\\\' + p.slice(2).replace(/\//g, '\\'), true)

    // A plain drive path, possibly with forward slashes: C:/Users/dev → C:\Users\dev
    if (/^[A-Za-z]:[/\\]/.test(p)) {
      return trimTrailingSep(p.charAt(0).toUpperCase() + p.slice(1).replace(/\//g, '\\'), true)
    }
    // Bare drive with no separator: "C:" means "current dir on C", not the root — but a
    // shell reporting it means the root, and that is the only reading we can act on.
    if (/^[A-Za-z]:$/.test(p)) return p.charAt(0).toUpperCase() + ':\\'

    // A rooted POSIX path on Windows that matched none of the dialects above (e.g.
    // "/usr/bin" inside an MSYS install) has no Windows equivalent we can derive.
    if (p.startsWith('/')) return null

    return trimTrailingSep(p.replace(/\//g, '\\'), true)
  }

  // POSIX: only absolute paths are meaningful. A relative fragment means we parsed
  // something that was not a path.
  if (!p.startsWith('/')) return null
  return trimTrailingSep(p, false)
}

function driveToWindows(letter: string, rest: string | undefined): string {
  const tail = (rest ?? '').replace(/\//g, '\\')
  return trimTrailingSep(`${letter.toUpperCase()}:${tail || '\\'}`, true)
}

function joinNative(base: string, rest: string, isWin: boolean): string {
  const sep = isWin ? '\\' : '/'
  const left = base.replace(/[/\\]+$/, '')
  const right = isWin ? rest.replace(/\//g, '\\') : rest
  return `${left}${sep}${right}`
}

/**
 * Drop a trailing separator, except on a root. `C:\repo\` and `C:\repo` are the same
 * directory, but they are different Map keys and different store values — and an
 * unstable cwd string restarts the poll and re-renders the sidebar on every prompt.
 */
function trimTrailingSep(p: string, isWin: boolean): string {
  if (isWin) {
    if (/^[A-Za-z]:\\?$/.test(p)) return p.charAt(0).toUpperCase() + ':\\'
    return p.replace(/[\\/]+$/, '') || p
  }
  if (p === '/') return '/'
  return p.replace(/\/+$/, '') || '/'
}

/**
 * Do two reported paths mean the same directory?
 *
 * Case-insensitive on Windows, and separator-insensitive everywhere, because the same
 * shell can report `C:\Repo` and `C:/repo` across two prompts. Without this the store
 * write-guard in TerminalPane sees a change that isn't one and re-renders every
 * sidebar subscriber twice a second.
 */
export function samePath(a: string | null | undefined, b: string | null | undefined, platform?: NodeJS.Platform): boolean {
  if (!a || !b) return a === b || (!a && !b)
  const isWin = (platform ?? hostPlatform()) === 'win32'
  const canon = (s: string): string => {
    const t = s.replace(/[/\\]+/g, isWin ? '\\' : '/').replace(/[\\/]+$/, '')
    return isWin ? t.toLowerCase() : t
  }
  return canon(a) === canon(b)
}

// Lumopolis export: the privacy boundary. Every exported page and every generated document is built from the
// WorldDoc this module returns, so nothing here may let through an absolute path, the home or userData folder,
// a memory note, a transcript step, an evidence excerpt or a secret. The doc is rebuilt field by field from the
// WorldDoc contract (types.ts): a field this file does not name is dropped, never copied.
//
// What counts as a revealing path in free text (REVEALING_PATH, isRevealingPath): one that names a place on the
// machine, so it is always rewritten. It is a route-safe heuristic, deliberately so: a claim saying a service
// "serves /api/users" must keep its words.
//   - Windows drive paths: standalone with either slash (`C:\x`, `C:/x`; `C://` is a URL), glued after a digit or
//     `_` with either slash (`x_C:/x`), glued after a letter only with a backslash (`xC:\x`), so prose such as
//     `route:/users` keeps its words. The project, home and userData folders are caught glued in any form anyway.
//   - UNC paths (`\\server\share`), with the long forms `\\?\` and `\\.\`.
//   - `file://` URLs, whatever the host.
//   - `~/` and `~user/`.
//   - POSIX paths whose first folder is home, Users, root, mnt, media, Volumes, tmp, private, var, opt, srv,
//     workspace or workspaces, in any letter case, starting the text or after a space, quote, bracket, `=`, `,`
//     or `;`. After a `:` (PATH lists, `file:line:` prefixes, `cwd:/x`) the folder must be followed by a real
//     second name, one not starting with `:` or `{`: `PATH=/a:/home/ann` and `cwd:/Users/ann` count, while route
//     prose such as `route:/users`, `route:/users/:id`, `route:/users/{id}` and `at:/home` keeps its words.
//     (`api:/users/123` is rewritten too: it cannot be told apart from `api:/users/ann`.)
// Other absolute POSIX text (`/api/users`, `/etc/hosts`) is left alone. Beyond that definition, the project root,
// the home folder and the userData folder are found wherever they appear (any case, either slash, doubled
// backslashes, the long and admin-share forms, and a drive written the Git Bash or Cygwin way, `/c/...` or
// `/cygdrive/c/...`), so a folder name holding a space never splits.
//
// Known limits (ruled acceptable): a percent-encoded path outside a file URL; a path split by a line break; a
// path right after `<`, `|`, `+`, `@`, `&` or `*`; a forward-slash UNC path (`//host/share`); another scheme's
// URL holding a path (`vscode://file/home/<other>`); and a space in another account's folder name (only this
// machine's own folders are matched whole, so `/home/Ann Lee/x` ends at the space).

import { redactSecrets } from '../appLog'
import type { Building, BuildingGrowth, Claim, District, Evidence, EvidenceKind, External, Floor, PlanReconcile, Proposal, Tour, WorldDoc, WorldEdge } from './types'

/** Where the export is made from. `root` is the project folder, null for a design world (it has no folder). */
export interface SanitizeContext { root: string | null; home: string; userData: string }

/** What a path outside the project becomes (followed by `/<basename>` when it has one). */
export const OUTSIDE = '<outside the project>'

/** A design world's key (main/world/designer.ts DESIGN_KEY_RE): it holds no path, so it is kept as it is. */
const DESIGN_KEY = /^design:[A-Za-z0-9][A-Za-z0-9._-]*$/
/** Evidence kinds whose ref is a project path; the other kept kinds' refs are free text. */
const PATH_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['file', 'symbol', 'test'])
/** The only evidence an export carries. Memory notes, transcript steps and the live layer's kinds never leave. */
const EXPORTED_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['file', 'symbol', 'test', 'commit', 'person'])

/** The characters a path in free text runs on with: up to a space, a quote, an angle bracket or a pipe. */
const REST = `[^\\s"'<>|]*`
/** A POSIX first folder that names a place on the machine, as a whole name. */
const MACHINE_FOLDER = '/(?:home|users|root|mnt|media|volumes|tmp|private|var|opt|srv|workspaces?)(?![\\w.-])'
/** The source of the revealing-path pattern described at the top of this file (use it with the `i` flag). */
export const REVEALING_PATH = [
  `(?<![a-z0-9])[a-z]:(?:\\\\|/(?!/))${REST}`,
  `(?<=[0-9_])[a-z]:[\\\\/]${REST}`,
  `(?<=[a-z])[a-z]:\\\\${REST}`,
  `\\\\\\\\[^\\s\\\\/"'<>|]+[\\\\/]${REST}`,
  `file://${REST}`,
  `(?<![\\w~])~[\\w.-]*[\\\\/]${REST}`,
  `(?<=^|[\\s"'\`(\\[{=,;])${MACHINE_FOLDER}${REST}`,
  `(?<=:)${MACHINE_FOLDER}/[^\\s"'<>|:{/]${REST}`,
].join('|')

/** Every revealing path in `text`, as written (trailing punctuation included). */
export function revealingPaths(text: string): string[] {
  return text.match(new RegExp(REVEALING_PATH, 'gi')) ?? []
}

/** Whether `text` holds a revealing path. */
export function isRevealingPath(text: string): boolean {
  return new RegExp(REVEALING_PATH, 'i').test(text)
}

/** Forward slashes, no trailing slash. */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
/** A drive path or a UNC path: compared without regard to case. */
const windowsLike = (p: string): boolean => /^[A-Za-z]:(\/|$)/.test(p) || p.startsWith('//')
const isAbsolute = (p: string): boolean => /^[A-Za-z]:(\/|$)/.test(p) || p.startsWith('/')

/**
 * A path in the plain form the comparisons expect: a file URL becomes its (decoded) path, every slash a single
 * forward slash (a UNC path keeps its leading two), the long forms `//?/` and `//./` lose their prefix and an admin
 * share (`//host/C$/x`) becomes its drive (`C:/x`). A backslash is a slash too, unless `keepBackslash` says it is a
 * name character (backslashKept).
 */
function plainPath(p: string, keepBackslash: boolean): string {
  let n = p
  const url = /^file:(?:\/\/([^/\\]*))?(.*)$/i.exec(n)
  if (url) {
    n = (url[1] ? `//${url[1]}` : '') + url[2]
    try { n = decodeURIComponent(n) } catch { /* a stray % : keep the path as written */ }
    if (/^\/[A-Za-z]:/.test(n)) n = n.slice(1)
  }
  if (!keepBackslash) n = n.replace(/\\/g, '/')
  n = (n.startsWith('//') ? '/' : '') + n.replace(/\/{2,}/g, '/')
  const long = /^\/\/[?.]\/(unc\/)?/i.exec(n)
  if (long) {
    // `\\?\C:\x` is the drive path; with no drive after the prefix (`\\.\home\x`) the path is still rooted.
    const rest = n.slice(long[0].length)
    n = (long[1] ? '//' : /^[A-Za-z]:/.test(rest) ? '' : '/') + rest
  }
  const share = /^\/\/[^/]+\/([A-Za-z])\$(?=\/|$)/.exec(n)
  if (share) n = `${share[1]}:${n.slice(share[0].length)}`
  return n
}

/**
 * Whether the world was mapped on Windows. An export runs on the computer that mapped its world, so the context's
 * own folders tell: a drive or a backslash in any of them means Windows, and a leading `/` with neither means Linux or
 * macOS. With no folder to go by it counts as Windows, where a backslash is a separator: reading one that way can
 * only expose a `..` to resolveRelative, never hide one.
 */
function mappedOnWindows(ctx: SanitizeContext): boolean {
  const folders = [ctx.root ?? '', ctx.home, ctx.userData]
  return folders.some((f) => /^[A-Za-z]:|\\/.test(f)) || !folders.some((f) => f.startsWith('/'))
}

/**
 * Whether a backslash in `p` is a name character rather than a separator: on Linux and macOS `a\b.ts` is one file.
 * A path that starts with a backslash (`\home\dev\x`, `\\host\x`) is rooted the Windows way instead, so it is found
 * inside the project or outside it like any absolute path, never shown as one long name.
 * A drive, UNC, long-form, `~` or file-URL path is written the Windows way (or a shell's), so its backslashes stay
 * separators on any platform and such a path is still found to leave the project.
 */
function backslashKept(p: string, ctx: SanitizeContext): boolean {
  return !/^(?:[A-Za-z]:|\\|~|file:)/i.test(p) && !mappedOnWindows(ctx)
}

/** Whether `p` (normalised) lies in or is `base` (normalised), by whole folder names; gives the segments past it. */
function under(p: string, base: string): string[] | null {
  if (!base) return null
  const fold = windowsLike(base) ? (s: string): string => s.toLowerCase() : (s: string): string => s
  const ps = p.split('/')
  const bs = base.split('/')
  if (ps.length < bs.length || bs.some((s, i) => fold(s) !== fold(ps[i]))) return null
  return ps.slice(bs.length)
}

/** The last real name in a path: no empty, dot or drive part. */
function baseName(segments: string[]): string {
  const names = segments.filter((s) => s !== '' && s !== '.' && s !== '..')
  const last = names.length ? names[names.length - 1] : ''
  // Only what follows a name's last backslash: a POSIX name such as `a\..\home\ann\x` that climbed out of the
  // project (backslashKept) shows `x`, never the folders it spells.
  const name = last.slice(last.lastIndexOf('\\') + 1)
  return /^[A-Za-z]:$/.test(name) ? '' : name
}

const outside = (segments: string[]): string => {
  const name = baseName(segments)
  return name ? `${OUTSIDE}/${name}` : OUTSIDE
}

/** Folds `.` and `..` out of a relative path; one that climbs above its start is outside the project. */
function resolveRelative(segments: string[]): string {
  const kept: string[] = []
  for (const s of segments) {
    if (s === '' || s === '.') continue
    if (s !== '..') kept.push(s)
    else if (!kept.pop()) return outside(segments)
  }
  return kept.join('/') || '.'
}

/**
 * A path as the export may show it: relative to the project root with forward slashes, or `<outside the project>/`
 * and its basename. The home and userData folders themselves become `<outside the project>` alone, so the account
 * name never shows. `~` stands for the home folder; `~user` is another account's, so it is outside. Nor is a
 * basename that is the home folder's own name shown, in any case and whatever follows it that is not a name
 * character (`:12`): a folder of that name elsewhere (on another host, or a path read some other way) is
 * `<outside the project>` alone too.
 */
export function relativePath(p: string, ctx: SanitizeContext): string {
  // A path holding a known folder percent-encoded (decodeUrls) is one path: every escape in it is decoded.
  const read = placedPath(decodeUrls(p, ctx) === p ? p : unescapeUrl(p), ctx)
  const named = `${OUTSIDE}/${baseName(norm(ctx.home).split('/'))}`
  const after = read.slice(named.length)
  return named !== `${OUTSIDE}/` && read.toLowerCase().startsWith(named.toLowerCase()) && !/^[\w.-]/.test(after) ? OUTSIDE + after : read
}

/** relativePath before the home folder's name is taken out. */
function placedPath(p: string, ctx: SanitizeContext): string {
  // Every path is first read as Windows would write it, a backslash being a separator. If that reading roots it
  // (`\home\dev\x`) or climbs out (`..\x`, `a\..\..\x`), it is outside on any platform. Only a path that stays
  // in the project that way keeps its backslashes as name characters, on Linux and macOS.
  const read = separatorReading(p, ctx)
  if (!p.includes('\\') || read.startsWith(OUTSIDE) || !backslashKept(p, ctx)) return read
  const kept = plainPath(p, true)
  if (!kept.startsWith('/')) return resolveRelative(kept.split('/'))
  // An absolute path read as inside the project has a project folder to be inside of.
  const inRoot = under(kept.replace(/\/+$/, ''), norm(ctx.root as string))
  return inRoot ? resolveRelative(inRoot) : read
}

/** relativePath with every backslash read as a separator. */
function separatorReading(p: string, ctx: SanitizeContext): string {
  let n = plainPath(p, false)
  if (n === '~' || n.startsWith('~/')) n = norm(ctx.home) + n.slice(1)
  else if (n.startsWith('~')) return outside(n.split('/').slice(1))
  // On Windows (a drive home folder) `/c/x` and `/cygdrive/c/x` are Git Bash and Cygwin for `C:/x`.
  const bash = /^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)/i.exec(n)
  if (bash && /^[A-Za-z]:/.test(ctx.home)) n = `${bash[1]}:${n.slice(bash[0].length)}`
  // On Windows `\x` is rooted on the current drive: read on the drive of the project, userData or home folder it is
  // in, or else on home's drive.
  else if (/^\/(?!\/)/.test(n) && /^[A-Za-z]:/.test(ctx.home)) n = onDrive(n, ctx) + n
  if (/^[A-Za-z]:/.test(n)) n = driveRead(n, ctx)
  if (!isAbsolute(n)) return n ? resolveRelative(n.split('/')) : ''
  const n2 = norm(n)
  const inRoot = ctx.root === null ? null : under(n2, norm(ctx.root))
  if (inRoot) return resolveRelative(inRoot)
  if ([ctx.home, ctx.userData].some((b) => under(n2, norm(b))?.length === 0)) return OUTSIDE
  return outside(n2.split('/'))
}

/**
 * Each known drive folder (normalised, `C:/Users/ann`), longest first, with a RegExp source matching it with any of
 * its separators left out, every gap a group (`C:([\\/]*)Users([\\/]*)ann`). Node's `path.join('C:', 'Users')` leaves
 * the drive relative (`C:Users\ann`), Git Bash strips an unquoted path's backslashes (`C:Usersannrepo`), and a dropped
 * separator glues two names (`C:\Users\annrepo`). Only this machine's own folder names are read across a missing
 * separator.
 */
function gluedFolders(ctx: SanitizeContext): Array<[string, string]> {
  return [ctx.root ?? '', ctx.userData, ctx.home].map((b) => norm(b).split('/'))
    .filter((p) => /^[A-Za-z]:$/.test(p[0]) && p.length > 1).sort((a, b) => b.join('/').length - a.join('/').length)
    .map((p) => [p.join('/'), escapeRe(p[0]) + p.slice(1).map((s) => `([\\\\/]*)${escapeRe(s)}`).join('')])
}

/**
 * The folder `base` stands for when written with the separators `gaps` (some left out) and followed by `after`, or
 * null to leave it: written whole (gluedFolders' pattern matched every separator), it is the plain form's, and a name
 * running on is another folder, except with every separator left out, when the rest is glued on too (`C:Usersannx`).
 */
function gluedBase(base: string, gaps: string[], after: string): string | null {
  if (gaps.every(Boolean)) return null
  if (/^(?:[\\/]|(?![\w-]|\.[\w.-]))/.test(after)) return base
  return gaps.some(Boolean) ? null : `${base}/`
}

/** Per context: gluedFolders, each matched at the start of a plain path. */
const gluedStarts = new WeakMap<SanitizeContext, Array<[string, RegExp]>>()

/**
 * A plain path `n` on a drive as the drive path it stands for: a known drive folder written with separators left out
 * is that folder (gluedBase), and any other drive followed by a name is rooted on it (`C:x` reads `C:/x`).
 */
function driveRead(n: string, ctx: SanitizeContext): string {
  let starts = gluedStarts.get(ctx)
  if (!starts) {
    starts = gluedFolders(ctx).map(([base, src]): [string, RegExp] => [base, new RegExp(`^${src}`, 'i')])
    gluedStarts.set(ctx, starts)
  }
  for (const [base, re] of starts) {
    const m = re.exec(n)
    const read = m ? gluedBase(base, m.slice(1), n.slice(m[0].length)) : null
    if (m && read !== null) return read + n.slice(m[0].length)
  }
  return n.replace(/^([A-Za-z]:)(?=[^/])/, '$1/')
}

/** The drive (`C:`) a drive-less rooted path `n` is read on, for a context whose home folder has one. */
function onDrive(n: string, ctx: SanitizeContext): string {
  const base = [ctx.root ?? '', ctx.userData, ctx.home].find((b) => /^[A-Za-z]:/.test(b) && under(b.slice(0, 2) + n, norm(b)) !== null)
  return (base ?? ctx.home).slice(0, 2)
}

const SEP = '[\\\\/]+'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * Somewhere inside a UNC path (`\\host\share\...`, `\\?\UNC\host\...`, either JSON-escaped): its double backslash
 * starts the token, after the text's start or a character no path runs on with. A known folder found there is a
 * folder on that host, left whole to the revealing pass, so neither the host nor the share name shows.
 */
const IN_UNC = `(?:^|[^\\w.:\\\\/$~%-])\\\\{2,}[^\\s\\\\/"'<>|][^\\s"'<>|]*`

/**
 * A RegExp source (for the `i` flag) matching folder `base` however a text writes it: either slash, doubled
 * backslashes (JSON), the long forms `\\?\` and `\\.\`, and a drive as an admin share (`\\host\C$`).
 */
function baseSource(base: string): string {
  const n = norm(base)
  const parts = n.split('/')
  const drive = /^([A-Za-z]):$/.exec(parts[0])
  if (drive) {
    const rest = parts.slice(1).map((s) => SEP + escapeRe(s)).join('')
    // Git Bash and Cygwin write the drive as a folder (`/c/...`, `/cygdrive/c/...`). Only below the drive itself:
    // a drive-root project would otherwise claim any `/c/` in the text.
    const bash = rest ? `|[\\\\/]+(?:cygdrive${SEP})?${drive[1]}` : ''
    // Rooted on the current drive, the drive left out (`\Users\ann`): not right after a drive letter, a share's `$`, a
    // name character or another slash, so `D:\Users\ann`, `\\host\D$\Users\ann` and `x\Users\ann` are not taken for
    // it, while `..\Users\ann`, `a.ts:12:\Users\ann`, `cwd:\Users\ann`, `-\Users\ann` and `$\Users\ann` are. Nor
    // anywhere inside a UNC path (`\\host\share$\Users\ann`). Only below the drive itself too.
    const bare = rest ? `|[\\\\/]{2}[?.](?=[\\\\/])|(?<![\\w\\\\/]|(?<!\\w)[a-z]:|[\\\\/]{2}[^\\s\\\\/"'<>|]+[\\\\/][a-z]\\$|${IN_UNC})` : ''
    return `(?:(?:[\\\\/]{2}[?.]${SEP})?(?:${drive[1]}:|[\\\\/]{2}[^\\s\\\\/"'<>|]+${SEP}${drive[1]}\\$)${bash}${bare})${rest}`
  }
  if (n.startsWith('//')) return `(?:[\\\\/]{2}[?.]${SEP}unc${SEP}|[\\\\/]{2})` + parts.slice(2).map(escapeRe).join(SEP)
  // A POSIX folder, also in the long form with no drive after the prefix (`\\?\home\ann`), and written with a
  // backslash after anything (`..\home\ann`, `cwd:\home\ann`) but a host's name: in `\\host\home\ann`, and anywhere
  // else inside a UNC path (`\\host\share\home\ann`), it is a folder on that host.
  return `(?:[\\\\/]{2}[?.]|(?<!${IN_UNC})(?=/)|(?<![\\\\/]{2}[^\\s\\\\/"'<>|]+|${IN_UNC}))` + parts.map(escapeRe).join(SEP)
}

/** A separator as a URL may write it: a slash, a backslash, or either percent-encoded. */
const URL_SEP = '(?:[\\\\/]|%2F|%5C)+'
/** A folder name as a URL may write it: as it is or percent-encoded. */
const urlName = (s: string): string => (encodeURIComponent(s) === s ? escapeRe(s) : `(?:${escapeRe(s)}|${escapeRe(encodeURIComponent(s))})`)

/**
 * A RegExp source (for the `i` flag) matching folder `base` as a URL may write it, its colon and separators
 * percent-encoded or not (`C%3A%5CUsers%5Cann`, `%2Fhome%2Fann`), the drive left out as baseSource's `bare` form
 * does; null for a UNC folder.
 */
function urlSource(base: string): string | null {
  const parts = norm(base).split('/')
  const names = parts.slice(1).map(urlName).join(URL_SEP)
  const drive = /^([A-Za-z]):$/.exec(parts[0])
  if (drive) return `(?:${drive[1]}(?::|%3A)|(?<!\\w|(?<!\\w)[a-z](?::|%3A)))${URL_SEP}${names}`
  return parts[0] === '' && parts[1] !== '' ? URL_SEP + names : null
}

/** Each percent escape (a run as one character where it decodes as one) as the character it stands for. */
const unescapeUrl = (s: string): string => s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
  try {
    return decodeURIComponent(run)
  } catch {
    return run.replace(/%[0-9a-f]{2}/gi, (e) => { try { return decodeURIComponent(e) } catch { return e } })
  }
})

/** Per context: the project root, userData and home folders, longest first, as urlSource writes them. */
const urlForms = new WeakMap<SanitizeContext, RegExp>()

/**
 * Text `s` with every path of the project root, userData and home folders that a URL percent-encodes
 * (`?path=%2Fhome%2Fann%2Fx`, `file:///c%3A/Users/ann`) decoded, its secrets redacted again, up to a character no URL
 * path holds (whitespace, a quote, `<>|&#?`), so the known pass takes it. Only a folder written with an encoded colon
 * or separator in it or right after it is decoded, and only at a whole name or a name running on as knownPattern's
 * `beside` does: a folder written plainly keeps its escapes (`a%20b.ts`).
 */
function decodeUrls(s: string, ctx: SanitizeContext): string {
  let re = urlForms.get(ctx)
  if (!re) {
    const bases = [ctx.root ?? '', ctx.userData, ctx.home].filter((b) => norm(b) !== '')
      .sort((a, b) => norm(b).length - norm(a).length).map(urlSource).filter((b): b is string => b !== null)
    re = new RegExp(`((?:file:/*)?(?:${[...bases, '(?!)'].join('|')}))(?=[\\\\/~+%]|(?![\\w-]|\\.[\\w.-]))([^\\s"'<>|&#?]*)`, 'gi')
    urlForms.set(ctx, re)
  }
  return s.replace(re, (m: string, base: string, rest: string) => (base.includes('%') || /^%(?:2F|5C)/i.test(rest) ? redact(unescapeUrl(m)) : m))
}

/** Whatever the app's log scanner (appLog.ts) takes for a secret, as `[redacted]`. */
const redact = (text: string): string => redactSecrets(text).replace(/<redacted(?:-[a-z]+)?>/g, '[redacted]')

/** Where a known folder's last name ends (knownPattern). */
const FOLDER_END = `(?=$|[\\s\\\\/"'\`,;:!?)\\]}<>|]|\\.(?![\\w.-]))`

/** Punctuation that ends a sentence, not a path. */
const TRAILING = /[.,;:!?)\]}]+$/

/** The project root, home and userData folders, longest first, each ending at a whole name, then the rest of the path. */
function knownPattern(ctx: SanitizeContext): RegExp {
  const bases = [ctx.root ?? '', ctx.userData, ctx.home].filter((b) => norm(b) !== '')
    .sort((a, b) => norm(b).length - norm(a).length).map(baseSource)
  // A `file:` URL of a known folder is taken whole. `(?!)` never matches, so with no folder known the pass changes
  // nothing. A name running on with `~`, `+` or a letter outside ASCII (an 8.3 short name `ANN~1`, `ann+x`, `anné`)
  // is a folder beside it, taken whole as group 2 up to a whole name's end: a separator, whitespace, a quote, the end
  // of the text, or punctuation that ends a sentence or a list (a dot only when no name follows it). Otherwise the
  // folder ends wherever no letter, digit, `_`, `-` or dot-and-name follows, so a sign after it (`&&`, `**`, `’s`,
  // `(main)`, `#x`, `=1`, `@{u}`) keeps its words, and a name running on with a name character is another folder,
  // left to the revealing pass.
  const beside = `(?=[~+]|(?![\\x00-\\x7f])[\\p{L}\\p{M}])([^\\s\\\\/"'<>|]+?)${FOLDER_END}`
  return new RegExp(`((?:file:/*)?(?:${[...bases, '(?!)'].join('|')}))(?:${beside}|(?![\\w-]|\\.[\\w.-]))((?:[\\\\/]${REST})?)`, 'giu')
}

/** sanitizeText for one context, its patterns built once (a world holds thousands of strings). */
function textCleaner(ctx: SanitizeContext): (text: string) => string {
  const known = knownPattern(ctx)
  const revealing = new RegExp(REVEALING_PATH, 'gi')
  const rewrite = (path: string, tail: string): string => relativePath(path.slice(0, path.length - tail.length), ctx) + tail
  // A known folder named alone keeps its last character; a path running on drops the punctuation ending a sentence.
  // A folder beside a known one is outside the project, and its name is never shown, not even as the basename.
  const knownHit = (_m: string, base: string, beside: string | undefined, rest: string): string => {
    const tail = rest ? (TRAILING.exec(rest) ?? [''])[0] : ''
    if (!beside) return rewrite(base + rest, tail)
    const out = rewrite(base + beside + rest, tail)
    return out.toLowerCase().includes(beside.toLowerCase()) ? OUTSIDE + tail : out
  }
  const revealingHit = (m: string): string => rewrite(m, (TRAILING.exec(m) ?? [''])[0])
  // A known drive folder written with separators left out is first written out whole (gluedBase), after no name
  // character, so the known pass takes it.
  const glued = gluedFolders(ctx).map(([base, src]): [string, RegExp] => [base, new RegExp(`(?<!\\w)${src}`, 'gi')])
  const unglue = (text: string): string => glued.reduce((t, [base, re]) => t.replace(re, (...a: Array<string | number>) => {
    const m = a[0] as string
    const end = (a[a.length - 2] as number) + m.length
    return gluedBase(base, a.slice(1, -2) as string[], t.slice(end)) ?? m
  }), text)
  // The known folders go first, in a pass of their own: a generic pattern would stop at a space in the user name.
  return (text) => unglue(decodeUrls(redact(text), ctx)).replace(known, knownHit).replace(revealing, revealingHit)
}

/**
 * Free text as the export may show it: a secret the app's log scanner recognises becomes `[redacted]`, then the
 * project root, home and userData folders and every revealing path (top of this file) are rewritten with relativePath.
 */
export function sanitizeText(text: string, ctx: SanitizeContext): string {
  return textCleaner(ctx)(text)
}

/** The characters an exported external id may hold (compile builds them as `x-<slug of the name>`). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
/** compile's slug (main/world/group.ts): lower case, every run of other characters one dash. */
const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * The exported id of each external whose own id could carry something out, by its old id. Ids are not free text and
 * are kept as they are, except an external's: compile slugs it from the external's name, so a name that held a path
 * would carry the path in the id. An external id is replaced when it holds a character outside SAFE_ID (markup, a
 * slash), holds the slug of the project, home or userData folder as whole words, or is the slug of a name the
 * sanitiser rewrites. The new id is `x-<slug of the sanitised name>`, numbered when another part already has it.
 */
function externalIds(doc: WorldDoc, ctx: SanitizeContext, text: (s: string) => string): Map<string, string> {
  const folders = [ctx.root ?? '', ctx.home, ctx.userData].map((f) => slugOf(norm(f))).filter((f) => f !== '')
  const unsafe = (x: External): boolean => {
    if (!SAFE_ID.test(x.id)) return true
    const words = `-${x.id.toLowerCase()}-`
    if (folders.some((f) => words.includes(`-${f}-`))) return true
    return text(x.name) !== x.name && x.id.toLowerCase() === `x-${slugOf(x.name)}`
  }
  const taken = new Set([...doc.districts, ...doc.buildings, ...doc.externals].map((p) => p.id))
  const out = new Map<string, string>()
  for (const x of doc.externals) {
    if (!unsafe(x)) continue
    const base = `x-${slugOf(text(x.name)) || 'external'}`
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    out.set(x.id, id)
  }
  return out
}

/** Rebuilds a WorldDoc from its known fields only, with every path relative and no private evidence. */
export function sanitizeWorld(doc: WorldDoc, ctx: SanitizeContext): WorldDoc {
  const text = textCleaner(ctx)
  // An external given a new id (externalIds) is renamed wherever an id names it: a line's ends and its id, a tour
  // step, a map position and a proposal's removals.
  const renamed = externalIds(doc, ctx, text)
  // In any other id holding an old id, the longest old id is replaced first, so one old id inside another can't
  // break it.
  const longestFirst = [...renamed].sort((a, b) => b[0].length - a[0].length)
  const swap = (id: string): string => longestFirst.reduce((out, [from, to]) => out.split(from).join(to), id)
  // A line's new id, which every step naming it uses too: one built from its ends ('e-<from>--<to>', group.ts and
  // designPatch.ts) is built again from the new ends.
  const lineIds = new Map<string, string>()
  if (renamed.size > 0) {
    const end = (id: string): string => renamed.get(id) ?? id
    for (const e of [...doc.edges, ...doc.layers.plan.flatMap((p) => p.edges)]) {
      lineIds.set(e.id, e.id === `e-${e.from}--${e.to}` ? `e-${end(e.from)}--${end(e.to)}` : swap(e.id))
    }
  }
  const ref = (id: string): string => {
    if (renamed.size === 0) return id
    const exact = renamed.get(id) ?? lineIds.get(id)
    if (exact !== undefined) return exact
    return id.startsWith('e-') ? swap(id) : id
  }
  // A path field is relativised, then scanned as text: a URL, a quoted or padded path, or a note after it.
  const path = (s: string): string => text(relativePath(s, ctx))
  const evidence = (e: Evidence): Evidence => ({ kind: e.kind, ref: PATH_KINDS.has(e.kind) ? path(e.ref) : text(e.ref) })
  const claims = (list: Claim[]): Claim[] => list.map((c) =>
    ({ text: text(c.text), state: c.state, evidence: c.evidence.filter((e) => EXPORTED_KINDS.has(e.kind)).map(evidence) }))
  const floor = (f: Floor): Floor => ({ name: text(f.name), tech: f.tech.map(text), members: f.members.map(path) })
  const growth = (g: BuildingGrowth): BuildingGrowth => ({
    start: g.start, seed: path(g.seed), ...(g.folder !== undefined ? { folder: path(g.folder) } : {}),
    merged: g.merged, mergedFiles: g.mergedFiles, ...(g.reached !== undefined ? { reached: g.reached } : {}),
    ...(g.inFolder !== undefined ? { inFolder: g.inFolder } : {}), folded: g.folded, cap: g.cap,
  })
  const building = (b: Building): Building => ({
    id: b.id, districtId: b.districtId, name: text(b.name), techLabel: text(b.techLabel), process: b.process,
    floors: b.floors.map(floor), stack: b.stack.map(text), how: claims(b.how), why: claims(b.why), status: b.status,
    members: b.members.map(path), claims: claims(b.claims), nameState: b.nameState,
    ...(b.growth ? { growth: growth(b.growth) } : {}),
  })
  const edge = (e: WorldEdge): WorldEdge => ({
    id: ref(e.id), from: ref(e.from), to: ref(e.to), cargo: e.cargo, label: text(e.label), how: claims(e.how), tech: e.tech.map(text),
    why: claims(e.why), rate: text(e.rate), twoWay: e.twoWay, ...(e.twoWayStated ? { twoWayStated: true as const } : {}),
    claims: claims(e.claims),
  })
  const district = (d: District): District =>
    ({ id: d.id, name: text(d.name), subtitle: text(d.subtitle), hue: d.hue, members: d.members.map(path), nameState: d.nameState })
  const external = (x: External): External => ({ id: ref(x.id), name: text(x.name), kind: x.kind, fog: x.fog })
  const tour = (t: Tour): Tour =>
    ({ id: t.id, title: text(t.title), steps: t.steps.map((s) => ({ ids: s.ids.map(ref), caption: text(s.caption) })) })
  const reconcile = (r: PlanReconcile & { planAt: number }): PlanReconcile & { planAt: number } =>
    ({ matched: { ...r.matched }, missing: [...r.missing], extra: [...r.extra], changed: [...r.changed], planAt: r.planAt })
  const proposal = (p: Proposal): Proposal => ({
    id: p.id, title: text(p.title), summary: claims(p.summary), buildings: p.buildings.map(building), edges: p.edges.map(edge),
    ...(p.reconcile ? { reconcile: reconcile(p.reconcile) } : {}), ...(p.removes ? { removes: p.removes.map(ref) } : {}),
  })
  const record = <T, U>(r: Record<string, T>, value: (v: T) => U): Record<string, U> =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, value(v)]))
  // Two terms can sanitise to the same text: the first keeps its place and the second's definition joins it.
  const glossary = new Map<string, string>()
  for (const [term, def] of Object.entries(doc.glossary)) {
    const key = text(term)
    const prev = glossary.get(key)
    glossary.set(key, prev === undefined ? text(def) : `${prev}; ${text(def)}`)
  }
  const projectKey = DESIGN_KEY.test(doc.projectKey) ? doc.projectKey
    : ctx.root !== null ? baseName(norm(ctx.root).split('/')) || 'project' : text(doc.projectKey)
  return {
    version: doc.version, projectKey, generatedAt: doc.generatedAt,
    sourceRevision: { head: doc.sourceRevision.head, dirty: doc.sourceRevision.dirty },
    districts: doc.districts.map(district), buildings: doc.buildings.map(building), edges: doc.edges.map(edge),
    externals: doc.externals.map(external),
    glossary: Object.fromEntries(glossary),
    cargo: record(doc.cargo, (c) => ({ shape: c.shape, color: c.color, label: text(c.label) })),
    processes: record(doc.processes, (p) => ({ label: text(p.label), color: p.color })),
    tours: doc.tours.map(tour),
    layout: {
      seed: doc.layout.seed,
      positions: Object.fromEntries(Object.entries(doc.layout.positions).map(([id, v]) => [ref(id), [v[0], v[1], v[2]] as [number, number, number]])),
      ...(doc.layout.round !== undefined ? { round: doc.layout.round } : {}),
    },
    runtimeNames: record(doc.runtimeNames, (names) => names.map(text)),
    ...(doc.runtimeHandSet ? { runtimeHandSet: [...doc.runtimeHandSet] } : {}),
    layers: { plan: doc.layers.plan.map(proposal) },
    ...(doc.labelTokens !== undefined ? { labelTokens: doc.labelTokens } : {}),
    ...(doc.filesCapped !== undefined ? { filesCapped: doc.filesCapped } : {}),
    ...(doc.nestedCapped !== undefined ? { nestedCapped: doc.nestedCapped } : {}),
    ...(doc.filesUnreadable !== undefined ? { filesUnreadable: doc.filesUnreadable } : {}),
    ...(doc.filesRead !== undefined ? { filesRead: doc.filesRead } : {}),
    ...(doc.filesListed !== undefined ? { filesListed: doc.filesListed } : {}),
  }
}

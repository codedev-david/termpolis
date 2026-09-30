/**
 * Scrubbing for every Sentry event and breadcrumb, main and renderer alike.
 *
 * A report is not private once it leaves the machine: the Sentry → GitHub pipeline files it as a
 * public issue, and #29–#31 carried a user's home directory — their account name — straight into
 * one. So this does not check a list of fields someone remembered. It rewrites every string an
 * event carries: any user path becomes `<home>`, the OS user name standing as a path segment
 * becomes `<user>`, a stack frame's file becomes its path inside the app
 * (`app:///out/main/index.js`), and the fields that name a machine or a person (server_name, user,
 * cookies, query strings) are dropped outright.
 *
 * Pure, with no Node or DOM dependency: the renderer has no `process` and no `os`. Main passes its
 * real home directory and user name in (ScrubOptions); the renderer relies on the path shapes.
 */

export const HOME_TOKEN = '<home>'
export const USER_TOKEN = '<user>'

export interface ScrubOptions {
  /** os.homedir(): replaced wherever it appears, in either separator and any case. */
  homeDir?: string
  /** os.userInfo().username: replaced where it stands as a path segment. */
  userName?: string
}

export type Scrub = (text: string) => string

// A Windows profile folder in every spelling an event carries one: C:\Users\x, C:\\Users\\x
// (JSON-escaped), C:/Users/x, /C:/Users/x and file:///C:/Users/x, any case. The name may hold
// spaces ("Jane Doe") only when a separator follows it, so "C:\Users\jane is read-only" keeps its
// prose.
const WIN_HOME_RE =
  /(?:file:\/\/\/?)?\/?(?<![a-z0-9])[a-z]:(?:\\+|\/+)(?:users|documents and settings)(?:\\+|\/+)(?:[^\\/\r\n\t"`<>|:;,=*?()[\]{} ]+(?: [^\\/\r\n\t"`<>|:;,=*?()[\]{} ]+)*(?=[\\/])|[^\\/\r\n\t"`<>|:;,=*?()[\]{} ]+)/gi

// The POSIX homes: /Users/x (macOS), /home/x (Linux), file:///Users/x, and the /c/Users/x and
// /mnt/c/Users/x a Windows path takes in Git Bash and WSL. Never mid-path or mid-URL
// (https://host/home/page is a page, not a home).
const POSIX_HOME_RE = /(?<![\w.])(?:file:\/\/)?(?:\/mnt)?(?:\/[a-z])?\/(?:users|home)\/[^/\\\s"'`<>|:;,()[\]{}*?=+]+/gi

const SEP = '[\\\\/]+'

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The literal home directory, so a home the shapes above miss (D:\Profiles\x, /var/home/x) is still
// caught. Never the prefix of a longer name: home /Users/x leaves /Users/xavier alone.
function literalHomeRe(homeDir: string | undefined): RegExp | null {
  const root = (homeDir ?? '').replace(/[\\/]+$/, '')
  // Too short to be a real home ("/", "C:"): it would match all over the text.
  if (root.length < 3) return null
  const parts = root.split(/[\\/]+/)
  // A POSIX home opens with its separator: match exactly one there, so file:///Users/x keeps its
  // scheme's slashes and reads file://<home>.
  const body = parts[0] === ''
    ? `[\\\\/]${parts.slice(1).map(escapeRe).join(SEP)}`
    : parts.map(escapeRe).join(SEP)
  return new RegExp(`(?<![\\w.-])${body}(?![\\w.-])`, 'gi')
}

function userSegmentRe(userName: string | undefined): RegExp | null {
  // One letter would hit every single-letter directory.
  if (!userName || userName.length < 2) return null
  return new RegExp(`(?<=[\\\\/])${escapeRe(userName)}(?![\\w.-])`, 'gi')
}

/** A scrubber with the home and user patterns compiled once, for walking a whole event. */
export function makeScrubber(opts: ScrubOptions = {}): Scrub {
  const home = literalHomeRe(opts.homeDir)
  const user = userSegmentRe(opts.userName)
  return (text: string): string => {
    // Every pattern needs a path separator; most strings in an event have none.
    if (typeof text !== 'string' || !/[\\/]/.test(text)) return text
    let out = home ? text.replace(home, HOME_TOKEN) : text
    out = out.replace(WIN_HOME_RE, HOME_TOKEN).replace(POSIX_HOME_RE, HOME_TOKEN)
    return user ? out.replace(user, USER_TOKEN) : out
  }
}

export function scrubText(text: string, opts?: ScrubOptions): string {
  return makeScrubber(opts)(text)
}

/** A URL without its query string or fragment: tokens and search terms live there. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

// Frame paths that already name nothing on the user's disk.
const KEEP_FRAME_PATH = /^(?:app:\/\/\/|node:|internal[/:]|native\b|<anonymous>)/

/**
 * A stack frame's file as its path inside the app, so a frame reads the same on every machine:
 * `…\resources\app.asar\out\main\index.js` and a dev build's `…/termpolis/out/main/index.js` both
 * become `app:///out/main/index.js`. Anything else outside the app is scrubbed like any text.
 */
export function toAppPath(path: string, scrub: Scrub): string {
  if (KEEP_FRAME_PATH.test(path)) return path
  const unified = path.replace(/\\+/g, '/')
  const inApp = /\/app\.asar(?:\.unpacked)?\/(.*)$/i.exec(unified) ?? /\/(out\/(?:main|preload|renderer)\/.*)$/i.exec(unified)
  return inApp ? `app:///${inApp[1]}` : scrub(path)
}

type Frame = Record<string, unknown>

function framesOf(event: Record<string, any>): Frame[] {
  const frames: Frame[] = []
  const collect = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const entry of list) {
      const own = entry?.stacktrace?.frames
      if (Array.isArray(own)) frames.push(...own)
    }
  }
  collect(event.exception?.values)
  collect(event.threads?.values)
  if (Array.isArray(event.stacktrace?.frames)) frames.push(...event.stacktrace.frames)
  return frames
}

// Local variables and source lines: none of it is ours to send.
const FRAME_SOURCE_FIELDS = ['vars', 'pre_context', 'context_line', 'post_context']

const MAX_DEPTH = 40

// Every string, and every key, at any depth. Mutates in place: Sentry hands beforeSend an event
// that is ours to change, and a copy of a large event would cost more than the walk.
function scrubDeep(value: unknown, scrub: Scrub, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return scrub(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_DEPTH) return '[Truncated]'
  // Already scrubbed in place (a shared reference or a cycle).
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubDeep(value[i], scrub, seen, depth + 1)
    return value
  }
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const next = scrubDeep(obj[key], scrub, seen, depth + 1)
    const safeKey = scrub(key)
    if (safeKey !== key) delete obj[key]
    obj[safeKey] = next
  }
  return value
}

// Breadcrumbs whose data names a URL (a request, a navigation).
const URL_CRUMB_CATEGORIES = new Set(['http', 'fetch', 'xhr', 'navigation', 'electron.net'])
const URL_CRUMB_FIELDS = ['url', 'to', 'from']

function scrubCrumbWith<T>(crumb: T, scrub: Scrub): T | null {
  if (!crumb || typeof crumb !== 'object') return crumb
  const c = crumb as unknown as { category?: unknown; data?: unknown }
  // Console lines are whatever the app logged: terminal text, prompts, paths. Never sent.
  if (c.category === 'console') return null
  if (typeof c.category === 'string' && URL_CRUMB_CATEGORIES.has(c.category) && c.data && typeof c.data === 'object') {
    const data = c.data as Record<string, unknown>
    for (const field of URL_CRUMB_FIELDS) {
      const v = data[field]
      if (typeof v === 'string') data[field] = toAppPath(stripQuery(v), scrub)
    }
  }
  scrubDeep(crumb, scrub, new WeakSet(), 0)
  return crumb
}

/** A breadcrumb fit to send, or null when it must not be kept at all (console output). */
export function scrubBreadcrumb<T>(crumb: T, opts: ScrubOptions = {}): T | null {
  return scrubCrumbWith(crumb, makeScrubber(opts))
}

/**
 * A Sentry event fit to send: frames rewritten to app paths with their locals and source lines
 * removed, the request reduced to a query-less URL, the machine name and user dropped, console
 * breadcrumbs dropped, and every remaining string and key scrubbed. Mutates and returns `event`.
 */
export function scrubEvent<T>(event: T, opts: ScrubOptions = {}): T {
  if (!event || typeof event !== 'object') return event
  const scrub = makeScrubber(opts)
  const e = event as unknown as Record<string, any>
  for (const frame of framesOf(e)) {
    if (!frame || typeof frame !== 'object') continue
    if (typeof frame.filename === 'string') frame.filename = toAppPath(frame.filename, scrub)
    if (typeof frame.abs_path === 'string') frame.abs_path = toAppPath(frame.abs_path, scrub)
    for (const field of FRAME_SOURCE_FIELDS) delete frame[field]
  }
  const request = e.request
  if (request && typeof request === 'object') {
    if (typeof request.url === 'string') request.url = toAppPath(stripQuery(request.url), scrub)
    delete request.cookies
    delete request.query_string
    delete request.data
  }
  delete e.server_name
  delete e.user
  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = e.breadcrumbs.map((crumb: unknown) => scrubCrumbWith(crumb, scrub)).filter((crumb: unknown) => crumb !== null)
  }
  const seen = new WeakSet<object>()
  for (const key of Object.keys(e)) {
    // SDK-internal (scopes, the raw request): never serialised into the envelope, and not ours to touch.
    if (key === 'sdkProcessingMetadata') continue
    e[key] = scrubDeep(e[key], scrub, seen, 0)
  }
  return event
}

/**
 * The stable part of an updater error, for grouping and de-duplication: its first line, with
 * every URL, path, hash, hex id and number replaced by a placeholder. Two machines failing the
 * same way produce the same signature; a new failure mode produces a new one.
 */
export function normalizeUpdaterSignature(text: string): string {
  const firstLine = String(text ?? '').split(/\r?\n/, 1)[0]
  const signature = scrubText(firstLine)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/<home>[^\s"'<>]*/g, '<path>')
    // updaterErrors.scrubUpdaterText has already written the home as `~`.
    .replace(/(?<![\w~])~[\\/][^\s"'<>]*/g, '<path>')
    .replace(/(?<!\w)[a-z]:[\\/][^\s"'<>]*/gi, '<path>')
    .replace(/\\\\[^\s"'<>\\]+\\[^\s"'<>]*/g, '<path>')
    .replace(/(?<![\w.:/])\/[^\s"'<>:]+/g, '<path>')
    .replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? '<hash>' : run))
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi, '<hex>')
    .replace(/\d+(?:[.,:]\d+)*/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return signature || 'unknown'
}

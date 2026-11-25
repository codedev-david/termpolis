// What the window's page may use: the permission request and check handlers on every session.
//
// Electron's default with no handler, and what Termpolis did until 2.0, is to grant every request
// and every check: the camera, location, MIDI, HID and the rest, for whatever page asked. Only the
// navigation lock (createWindow in index.ts) kept other pages out of the window. This is the
// allowlist instead, granted only to the Termpolis page in the Termpolis window.
//
// Granted, and why (each one is something the renderer really calls):
//   media, audio   voice input (hooks/useVoiceInput.ts) and the microphone tester (MicTester.tsx).
//                  Its check also lets enumerateDevices name the microphones.
//   media, video   only while hand control is on (setGestureCamera, which WP-GESTURE sets).
//                  Off by default, so the camera is refused.
//   clipboard-sanitized-write   navigator.clipboard.writeText / write: Copy for Teams and the
//                  export copy (lib/exportTerminal.ts), the app log, a diff, a pairing code.
//   clipboard-read the Shell Config editor's Paste (Monaco reads navigator.clipboard).
//   notifications  the usage-limit notice while the window is in the background (lib/limitWatch.ts).
//   Most copy and paste goes through main's clipboard module over IPC and needs no permission.
//
// Everything else is refused, with one log line that names the permission and the reason, never a
// URL (a requesting URL can carry a path or a query with the user's data in it).

/** Why a permission was refused. null (from the decide functions) means it was granted. */
export type PermissionDenial = 'foreign' | 'not-allowed' | 'camera-off' | 'media-unknown'

export interface PermissionPolicyDeps {
  /** The page main loads into the window: the dev server URL, or the file URL of index.html. */
  appPageUrl: () => string
  /** True when `wc` is the webContents of the Termpolis window. */
  isAppContents: (wc: unknown) => boolean
  /** Where a denial is logged. Default console.warn, which main captures into the app log. */
  log?: (line: string) => void
}

/** The details Electron passes a request handler (PermissionRequest and MediaAccessPermissionRequest). */
export interface RequestDetails {
  isMainFrame?: boolean
  requestingUrl?: string
  securityOrigin?: string
  mediaTypes?: readonly string[]
}

/** The details Electron passes a check handler (PermissionCheckHandlerHandlerDetails). */
export interface CheckDetails {
  isMainFrame?: boolean
  requestingUrl?: string
  securityOrigin?: string
  embeddingOrigin?: string
  mediaType?: string
}

/** The two methods of an Electron Session this sets. Optional so a minimal test mock passes. */
export interface PermissionSession {
  setPermissionRequestHandler?(handler: (wc: unknown, permission: string, callback: (granted: boolean) => void, details: RequestDetails) => void): void
  setPermissionCheckHandler?(handler: (wc: unknown, permission: string, requestingOrigin: string, details: CheckDetails) => boolean): void
}

/** Granted from the app's page whatever the details. `media` is decided by its device kinds. */
const GRANTED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications'])

let cameraForGestures = false

/** Hand control (WP-GESTURE) turns the camera on while it runs, and off again. Off by default. */
export function setGestureCamera(on: boolean): void {
  cameraForGestures = on
}

export function gestureCamera(): boolean {
  return cameraForGestures
}

function parse(url: string | undefined): URL | null {
  if (typeof url !== 'string' || url === '') return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

const isWeb = (u: URL): boolean => u.protocol === 'http:' || u.protocol === 'https:'

/** A file URL as one comparable string: host and decoded path, case-folded on Windows. */
function fileKey(u: URL, platform: NodeJS.Platform): string | null {
  try {
    const key = `${u.host}${decodeURIComponent(u.pathname)}`
    return platform === 'win32' ? key.toLowerCase() : key
  } catch {
    return null
  }
}

/**
 * Whether `url` is the page main loaded. The dev server: the same origin. A file page: the same
 * file (any hash or query), because every local file shares the opaque file: origin.
 */
export function isAppPage(url: string | undefined, appPageUrl: string, platform: NodeJS.Platform = process.platform): boolean {
  const got = parse(url)
  const want = parse(appPageUrl)
  if (!got || !want || got.protocol !== want.protocol) return false
  if (isWeb(want)) return got.origin === want.origin
  if (want.protocol !== 'file:') return false
  const a = fileKey(got, platform)
  return a !== null && a === fileKey(want, platform)
}

/** Whether an origin is the app page's. A file page's origin is opaque, so it is any file: origin. */
export function isAppOrigin(origin: string | undefined, appPageUrl: string): boolean {
  const got = parse(origin)
  const want = parse(appPageUrl)
  if (!got || !want || got.protocol !== want.protocol) return false
  if (isWeb(want)) return got.origin === want.origin
  return want.protocol === 'file:'
}

/** The verdict on a permission from the app's own page. */
function verdict(permission: string, mediaTypes: readonly string[] | undefined): PermissionDenial | null {
  if (permission !== 'media') return GRANTED.has(permission) ? null : 'not-allowed'
  // Device capture names its kinds; screen and tab capture name none, so they are refused here.
  if (!mediaTypes || mediaTypes.length === 0) return 'media-unknown'
  for (const kind of mediaTypes) {
    if (kind === 'audio') continue
    if (kind !== 'video') return 'media-unknown'
    if (!cameraForGestures) return 'camera-off'
  }
  return null
}

/** The request handler's decision: null grants it. */
export function decideRequest(wc: unknown, permission: string, details: RequestDetails | undefined, deps: PermissionPolicyDeps): PermissionDenial | null {
  const page = deps.appPageUrl()
  const fromApp = deps.isAppContents(wc)
    && details?.isMainFrame !== false
    && isAppPage(details?.requestingUrl, page)
    && (details?.securityOrigin === undefined || isAppOrigin(details.securityOrigin, page))
  return fromApp ? verdict(permission, details?.mediaTypes) : 'foreign'
}

/** The check handler's decision: null grants it. A check with no webContents (a worker) is refused. */
export function decideCheck(wc: unknown, permission: string, requestingOrigin: string, details: CheckDetails | undefined, deps: PermissionPolicyDeps): PermissionDenial | null {
  const page = deps.appPageUrl()
  const fromApp = deps.isAppContents(wc)
    && details?.isMainFrame !== false
    && isAppOrigin(requestingOrigin, page)
    && (details?.requestingUrl === undefined || isAppPage(details.requestingUrl, page))
    && (details?.securityOrigin === undefined || isAppOrigin(details.securityOrigin, page))
    && (details?.embeddingOrigin === undefined || isAppOrigin(details.embeddingOrigin, page))
  return fromApp ? verdict(permission, details?.mediaType === undefined ? undefined : [details.mediaType]) : 'foreign'
}

const REASON: Record<PermissionDenial, string> = {
  foreign: 'not from the Termpolis window',
  'not-allowed': 'not on the allowlist',
  'camera-off': 'the camera is only for hand control, which is off',
  'media-unknown': 'not a microphone or camera',
}

/** Each permission, kind and reason is logged once; past this many the log stays quiet. */
const MAX_LOGGED = 64
const logged = new Set<string>()

/** Tests: forget what has been logged. */
export function resetPermissionLog(): void {
  logged.clear()
}

function logDenial(kind: 'request' | 'check', permission: string, denial: PermissionDenial, log: (line: string) => void): void {
  const name = permission.replace(/[^A-Za-z0-9-]/g, '').slice(0, 48)
  const key = `${kind}:${name}:${denial}`
  if (logged.has(key) || logged.size >= MAX_LOGGED) return
  logged.add(key)
  log(`[permissions] denied ${name} ${kind}: ${REASON[denial]}`)
}

/** Put the policy on a session, as both its request and its check handler. */
export function installPermissionPolicy(ses: PermissionSession | null | undefined, deps: PermissionPolicyDeps): void {
  const log = deps.log ?? ((line: string) => console.warn(line))
  ses?.setPermissionRequestHandler?.((wc, permission, callback, details) => {
    let denial: PermissionDenial | null
    try {
      denial = decideRequest(wc, permission, details, deps)
    } catch {
      denial = 'foreign'
    }
    if (denial) logDenial('request', permission, denial, log)
    callback(denial === null)
  })
  ses?.setPermissionCheckHandler?.((wc, permission, requestingOrigin, details) => {
    let denial: PermissionDenial | null
    try {
      denial = decideCheck(wc, permission, requestingOrigin, details, deps)
    } catch {
      denial = 'foreign'
    }
    if (denial) logDenial('check', permission, denial, log)
    return denial === null
  })
}

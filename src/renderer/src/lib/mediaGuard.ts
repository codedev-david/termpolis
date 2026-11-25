// The page's half of the media permission (main/permissionPolicy.ts has the other half).
//
// Main grants `media` when the request names only the microphone (and the camera while hand control
// is on). Nothing Electron gives main identifies the legacy screen capture,
// getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop' } } }): its mediaTypes name only
// microphone and camera kinds, so desktop video asked for with the microphone reads as ['audio'], and
// Electron then hands over the whole screen. Nothing in Termpolis asks for chromeMediaSource, so this
// refuses any constraint that names it when the page asks for it the ordinary way,
// navigator.mediaDevices.getUserMedia (or the old navigator.webkitGetUserMedia).
//
// What it does not do: stop a script already running in the page. Such a script can reach the
// original getUserMedia another way (through another frame's, or by changing the built-ins this
// calls), but it also has the preload API, so the guard gives it no power it did not have. It is
// installed first in the renderer (installMediaGuard.ts, imported first by main.tsx), and its
// wrapper cannot be replaced or removed.

/** The constraint names Chromium reads a legacy screen, window or tab source from. */
const SCREEN_KEYS = new Set(['chromeMediaSource', 'chromeMediaSourceId'])

/** Deeper than any real constraints go (video.optional[i].chromeMediaSource is 3 levels). */
const MAX_DEPTH = 8

export const SCREEN_REFUSED = 'Screen capture is not allowed in Termpolis'

/**
 * Whether constraints name a legacy screen source anywhere: in audio or video, their mandatory,
 * optional or advanced sets, or deeper. Anything nested deeper than real constraints is refused too.
 */
export function asksForScreen(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object') return false
  if (depth > MAX_DEPTH) return true
  if (Array.isArray(value)) return value.some((v) => asksForScreen(v, depth + 1))
  for (const [key, v] of Object.entries(value)) {
    if (SCREEN_KEYS.has(key) || asksForScreen(v, depth + 1)) return true
  }
  return false
}

type GetUserMedia = (this: unknown, constraints?: MediaStreamConstraints) => Promise<MediaStream>

/** The parts of a window the guard changes. A test passes a fake. */
export interface GuardWindow {
  MediaDevices?: { prototype: object }
  Navigator?: { prototype: object }
  DOMException?: typeof DOMException
  console?: { warn(line: string): void }
}

/**
 * Put the guard on MediaDevices.prototype.getUserMedia, and refuse the prefixed callback-style
 * navigator.webkitGetUserMedia outright (nothing in Termpolis uses it). False when there is no
 * getUserMedia to guard. A second call is a no-op.
 */
export function installMediaGuard(win: GuardWindow): boolean {
  const proto = win.MediaDevices?.prototype as { getUserMedia?: GetUserMedia } | undefined
  const original = proto?.getUserMedia
  if (!proto || typeof original !== 'function') return false
  // Already guarded (the module evaluated again): Chromium's own getUserMedia can be replaced, and
  // the guard's cannot, so the second call has nothing to do.
  const current = Object.getOwnPropertyDescriptor(proto, 'getUserMedia')
  if (current && !current.writable && !current.configurable) return true
  const Refusal = win.DOMException ?? DOMException
  const refuse = (): Error => {
    win.console?.warn('[permissions] refused a screen capture asked for through getUserMedia')
    return new Refusal(SCREEN_REFUSED, 'NotAllowedError')
  }

  const getUserMedia: GetUserMedia = function (this: unknown, constraints) {
    let copy: MediaStreamConstraints | undefined
    try {
      // Check a copy and pass that copy on, so a getter or a proxy cannot show one thing here and
      // another to Chromium.
      copy = constraints === undefined ? undefined : structuredClone(constraints)
    } catch {
      return Promise.reject(new TypeError('getUserMedia constraints must be plain data'))
    }
    if (asksForScreen(copy)) return Promise.reject(refuse())
    return original.call(this, copy)
  }
  Object.defineProperty(proto, 'getUserMedia', { value: getUserMedia, writable: false, configurable: false, enumerable: true })

  const nav = win.Navigator?.prototype
  for (const name of ['webkitGetUserMedia', 'getUserMedia']) {
    if (!nav || !(name in nav)) continue
    try {
      Object.defineProperty(nav, name, {
        value: (_constraints: unknown, _onStream: unknown, onError: unknown) => {
          if (typeof onError === 'function') onError(refuse())
        },
        writable: false,
        configurable: false,
        enumerable: true,
      })
    } catch {
      /* already fixed in place by the browser: leave it */
    }
  }
  return true
}

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pathToFileURL } from 'url'
import {
  decideCheck,
  decideRequest,
  gestureCamera,
  installPermissionPolicy,
  isAppOrigin,
  isAppPage,
  resetPermissionLog,
  setGestureCamera,
  type PermissionPolicyDeps,
} from '../../src/main/permissionPolicy'

// The page the window really loads in a packaged build: a file URL of out/renderer/index.html.
const PAGE_FILE = process.platform === 'win32'
  ? 'C:\\Users\\Some One\\AppData\\Local\\Programs\\termpolis\\resources\\app.asar\\out\\renderer\\index.html'
  : '/Applications/Termpolis.app/Contents/Resources/app.asar/out/renderer/index.html'
const PAGE = pathToFileURL(PAGE_FILE).href
const DEV = 'http://localhost:5173'

const appWc = { id: 1 }
const otherWc = { id: 2 }

function deps(over: Partial<PermissionPolicyDeps> = {}): PermissionPolicyDeps & { log: ReturnType<typeof vi.fn> } {
  const log = vi.fn()
  return { appPageUrl: () => PAGE, isAppContents: (wc) => wc === appWc, log, ...over } as PermissionPolicyDeps & { log: ReturnType<typeof vi.fn> }
}

/** What Electron hands the request handler for the app's own main frame. */
const fromPage = (extra: Record<string, unknown> = {}) => ({ isMainFrame: true, requestingUrl: `${PAGE}#/world`, ...extra })

beforeEach(() => {
  setGestureCamera(false)
  resetPermissionLog()
})

describe('isAppPage: the requesting URL is the page main loaded', () => {
  it('matches the packaged file page, ignoring the hash and query', () => {
    expect(isAppPage(PAGE, PAGE)).toBe(true)
    expect(isAppPage(`${PAGE}?x=1#/a`, PAGE)).toBe(true)
  })

  it('matches the same file however Chromium spelled it (case of a Windows path, escapes)', () => {
    const win = 'file:///C:/Users/Some%20One/out/renderer/index.html'
    expect(isAppPage('file:///c:/users/some one/out/renderer/index.html', win, 'win32')).toBe(true)
    // Case matters off Windows.
    expect(isAppPage('file:///Users/Some%20One/x/INDEX.html', 'file:///Users/Some%20One/x/index.html', 'darwin')).toBe(false)
    expect(isAppPage('file:///Users/Some One/x/index.html', 'file:///Users/Some%20One/x/index.html', 'linux')).toBe(true)
  })

  it('refuses any other local file, another host, or another scheme', () => {
    expect(isAppPage(pathToFileURL(PAGE_FILE.replace('index.html', 'other.html')).href, PAGE)).toBe(false)
    expect(isAppPage('file://server/share/out/renderer/index.html', 'file:///share/out/renderer/index.html', 'win32')).toBe(false)
    expect(isAppPage('https://evil.example/index.html', PAGE)).toBe(false)
    expect(isAppPage('data:text/html,hi', PAGE)).toBe(false)
  })

  it('matches the dev server by origin only', () => {
    expect(isAppPage('http://localhost:5173/index.html#/x', DEV)).toBe(true)
    expect(isAppPage('http://localhost:5174/', DEV)).toBe(false)
    expect(isAppPage('https://localhost:5173/', DEV)).toBe(false)
  })

  it('refuses a missing, empty or unparsable URL, and an app page of an unknown scheme', () => {
    expect(isAppPage(undefined, PAGE)).toBe(false)
    expect(isAppPage('', PAGE)).toBe(false)
    expect(isAppPage('not a url', PAGE)).toBe(false)
    expect(isAppPage(PAGE, 'not a url')).toBe(false)
    expect(isAppPage('data:text/html,hi', 'data:text/html,hi')).toBe(false)
  })

  it('refuses a file URL whose escapes cannot be decoded (never treats two bad paths as equal)', () => {
    expect(isAppPage('file:///a/%E0%A4%A', 'file:///a/%E0%A4%A')).toBe(false)
    expect(isAppPage(PAGE, 'file:///a/%E0%A4%A')).toBe(false)
  })
})

describe('isAppOrigin: the requesting origin is the page main loaded', () => {
  it('a file page has an opaque origin: any file: origin, nothing else', () => {
    expect(isAppOrigin('file:///', PAGE)).toBe(true)
    expect(isAppOrigin('file://', PAGE)).toBe(true)
    expect(isAppOrigin('https://evil.example', PAGE)).toBe(false)
  })

  it('the dev server: the same origin only', () => {
    expect(isAppOrigin('http://localhost:5173', DEV)).toBe(true)
    expect(isAppOrigin('http://localhost:5173/', DEV)).toBe(true)
    expect(isAppOrigin('http://localhost:9999', DEV)).toBe(false)
    expect(isAppOrigin('file:///', DEV)).toBe(false)
  })

  it('refuses an empty, null or unparsable origin, and an app page of an unknown scheme', () => {
    expect(isAppOrigin(undefined, PAGE)).toBe(false)
    expect(isAppOrigin('', PAGE)).toBe(false)
    expect(isAppOrigin('null', PAGE)).toBe(false)
    expect(isAppOrigin('file:///', 'not a url')).toBe(false)
    expect(isAppOrigin('data:text/html,hi', 'data:text/html,hi')).toBe(false)
  })
})

describe('decideRequest: the allow and deny table', () => {
  const allowed: Array<[string, Record<string, unknown>]> = [
    ['media', { mediaTypes: ['audio'] }], // voice input, the mic tester
    ['clipboard-read', {}], // the Shell Config editor's Paste
    ['clipboard-sanitized-write', {}], // navigator.clipboard.writeText / write
    ['notifications', {}], // the usage-limit notice while the window is in the background
  ]
  for (const [permission, extra] of allowed) {
    it(`allows ${permission}${extra.mediaTypes ? ` ${String(extra.mediaTypes)}` : ''} from the app's page`, () => {
      expect(decideRequest(appWc, permission, fromPage(extra), deps())).toBeNull()
    })
  }

  const denied = [
    'geolocation', 'fullscreen', 'pointerLock', 'keyboardLock', 'openExternal', 'display-capture',
    'midi', 'midiSysex', 'mediaKeySystem', 'idle-detection', 'speaker-selection', 'storage-access',
    'top-level-storage-access', 'window-management', 'fileSystem', 'unknown', 'hid', 'usb', 'serial',
    'some-permission-a-later-electron-adds',
  ]
  for (const permission of denied) {
    it(`denies ${permission}, even from the app's page`, () => {
      expect(decideRequest(appWc, permission, fromPage(), deps())).toBe('not-allowed')
    })
  }

  it('denies the camera while hand control is off, and allows it once it is on', () => {
    expect(decideRequest(appWc, 'media', fromPage({ mediaTypes: ['video'] }), deps())).toBe('camera-off')
    expect(decideRequest(appWc, 'media', fromPage({ mediaTypes: ['audio', 'video'] }), deps())).toBe('camera-off')
    setGestureCamera(true)
    expect(gestureCamera()).toBe(true)
    expect(decideRequest(appWc, 'media', fromPage({ mediaTypes: ['video'] }), deps())).toBeNull()
    expect(decideRequest(appWc, 'media', fromPage({ mediaTypes: ['audio', 'video'] }), deps())).toBeNull()
    setGestureCamera(false)
    expect(decideRequest(appWc, 'media', fromPage({ mediaTypes: ['video'] }), deps())).toBe('camera-off')
  })

  it('denies media that names no device, or a kind it does not know (screen and tab capture send none)', () => {
    expect(decideRequest(appWc, 'media', fromPage(), deps())).toBe('media-unknown')
    expect(decideRequest(appWc, 'media', fromPage({ mediaTypes: [] }), deps())).toBe('media-unknown')
    expect(decideRequest(appWc, 'media', fromPage({ mediaTypes: ['audio', 'screen'] }), deps())).toBe('media-unknown')
  })

  it('denies everything from a webContents that is not the app window', () => {
    for (const permission of ['media', 'clipboard-read', 'notifications']) {
      expect(decideRequest(otherWc, permission, fromPage({ mediaTypes: ['audio'] }), deps())).toBe('foreign')
      expect(decideRequest(null, permission, fromPage({ mediaTypes: ['audio'] }), deps())).toBe('foreign')
    }
  })

  it('denies a foreign origin inside the app window: another page, a subframe, a media origin that is not the app', () => {
    const d = deps()
    expect(decideRequest(appWc, 'media', { isMainFrame: true, requestingUrl: 'https://evil.example/', mediaTypes: ['audio'] }, d)).toBe('foreign')
    expect(decideRequest(appWc, 'media', fromPage({ isMainFrame: false, mediaTypes: ['audio'] }), d)).toBe('foreign')
    expect(decideRequest(appWc, 'media', fromPage({ securityOrigin: 'https://evil.example', mediaTypes: ['audio'] }), d)).toBe('foreign')
    expect(decideRequest(appWc, 'media', fromPage({ securityOrigin: 'file:///', mediaTypes: ['audio'] }), d)).toBeNull()
    expect(decideRequest(appWc, 'notifications', { isMainFrame: true }, d)).toBe('foreign')
    expect(decideRequest(appWc, 'notifications', undefined, d)).toBe('foreign')
  })

  it('follows the dev server page when that is what main loaded', () => {
    const d = deps({ appPageUrl: () => DEV })
    expect(decideRequest(appWc, 'media', { isMainFrame: true, requestingUrl: `${DEV}/`, mediaTypes: ['audio'] }, d)).toBeNull()
    expect(decideRequest(appWc, 'media', fromPage({ mediaTypes: ['audio'] }), d)).toBe('foreign')
  })
})

describe('decideCheck: the check handler', () => {
  const fromPageCheck = (extra: Record<string, unknown> = {}) => ({ isMainFrame: true, requestingUrl: PAGE, ...extra })

  it('allows the same permissions as a request, from the app page', () => {
    for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'notifications']) {
      expect(decideCheck(appWc, permission, 'file:///', fromPageCheck(), deps())).toBeNull()
    }
    expect(decideCheck(appWc, 'media', 'file:///', fromPageCheck({ mediaType: 'audio', securityOrigin: 'file:///' }), deps())).toBeNull()
  })

  it('a media check carries one mediaType: the camera follows hand control, unknown is denied', () => {
    expect(decideCheck(appWc, 'media', 'file:///', fromPageCheck({ mediaType: 'video' }), deps())).toBe('camera-off')
    setGestureCamera(true)
    expect(decideCheck(appWc, 'media', 'file:///', fromPageCheck({ mediaType: 'video' }), deps())).toBeNull()
    expect(decideCheck(appWc, 'media', 'file:///', fromPageCheck({ mediaType: 'unknown' }), deps())).toBe('media-unknown')
    expect(decideCheck(appWc, 'media', 'file:///', fromPageCheck(), deps())).toBe('media-unknown')
  })

  it('denies what is not on the list', () => {
    for (const permission of ['geolocation', 'fullscreen', 'pointerLock', 'hid', 'serial', 'usb', 'midi', 'openExternal', 'storage-access']) {
      expect(decideCheck(appWc, permission, 'file:///', fromPageCheck(), deps())).toBe('not-allowed')
    }
  })

  it('denies a check with no webContents (a worker or a service worker) or another webContents', () => {
    expect(decideCheck(null, 'notifications', 'file:///', fromPageCheck(), deps())).toBe('foreign')
    expect(decideCheck(otherWc, 'notifications', 'file:///', fromPageCheck(), deps())).toBe('foreign')
  })

  it('denies a foreign origin: requesting origin, URL, media origin, subframe or embedder', () => {
    const d = deps()
    expect(decideCheck(appWc, 'notifications', 'https://evil.example', fromPageCheck(), d)).toBe('foreign')
    expect(decideCheck(appWc, 'notifications', '', fromPageCheck(), d)).toBe('foreign')
    expect(decideCheck(appWc, 'notifications', 'file:///', fromPageCheck({ requestingUrl: 'file:///tmp/other.html' }), d)).toBe('foreign')
    expect(decideCheck(appWc, 'media', 'file:///', fromPageCheck({ mediaType: 'audio', securityOrigin: 'https://evil.example' }), d)).toBe('foreign')
    expect(decideCheck(appWc, 'notifications', 'file:///', fromPageCheck({ isMainFrame: false }), d)).toBe('foreign')
    expect(decideCheck(appWc, 'notifications', 'file:///', fromPageCheck({ embeddingOrigin: 'https://evil.example' }), d)).toBe('foreign')
    // An embedder that IS the app is no reason to refuse.
    expect(decideCheck(appWc, 'notifications', 'file:///', fromPageCheck({ embeddingOrigin: 'file:///' }), d)).toBeNull()
  })

  it('without a requesting URL, the origin alone decides', () => {
    expect(decideCheck(appWc, 'notifications', 'file:///', { isMainFrame: true }, deps())).toBeNull()
    expect(decideCheck(appWc, 'notifications', 'file:///', undefined, deps())).toBeNull()
    expect(decideCheck(appWc, 'notifications', 'https://evil.example', { isMainFrame: true }, deps())).toBe('foreign')
  })
})

describe('installPermissionPolicy: the handlers it puts on a session', () => {
  function session() {
    return { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
  }
  function handlers(d = deps()) {
    const ses = session()
    installPermissionPolicy(ses, d)
    return {
      request: ses.setPermissionRequestHandler.mock.calls[0][0] as (...a: unknown[]) => void,
      check: ses.setPermissionCheckHandler.mock.calls[0][0] as (...a: unknown[]) => boolean,
      d,
    }
  }

  it('grants the microphone request through the callback, and logs nothing', () => {
    const { request, d } = handlers()
    const cb = vi.fn()
    request(appWc, 'media', cb, fromPage({ mediaTypes: ['audio'] }))
    expect(cb).toHaveBeenCalledWith(true)
    expect(d.log).not.toHaveBeenCalled()
  })

  it('refuses a denied request and logs one line naming the permission and why, never a URL', () => {
    const { request, d } = handlers()
    const cb = vi.fn()
    request(appWc, 'geolocation', cb, fromPage())
    expect(cb).toHaveBeenCalledWith(false)
    expect(d.log).toHaveBeenCalledTimes(1)
    const line = String(d.log.mock.calls[0][0])
    expect(line).toBe('[permissions] denied geolocation request: not on the allowlist')
    expect(line).not.toMatch(/file:|http|index\.html|Users/)
  })

  it('logs each permission, kind and reason once, not on every check', () => {
    const { request, check, d } = handlers()
    for (let i = 0; i < 5; i++) {
      check(appWc, 'geolocation', 'file:///', { isMainFrame: true, requestingUrl: PAGE })
      request(appWc, 'geolocation', vi.fn(), fromPage())
    }
    request(appWc, 'media', vi.fn(), fromPage({ mediaTypes: ['video'] }))
    request(otherWc, 'media', vi.fn(), { isMainFrame: true, requestingUrl: 'https://evil.example/?q=private' })
    request(appWc, 'media', vi.fn(), fromPage())
    expect(d.log.mock.calls.map((c) => c[0])).toEqual([
      '[permissions] denied geolocation check: not on the allowlist',
      '[permissions] denied geolocation request: not on the allowlist',
      '[permissions] denied media request: the camera is only for hand control, which is off',
      '[permissions] denied media request: not from the Termpolis window',
      '[permissions] denied media request: not a microphone or camera',
    ])
  })

  it('stops logging once it has logged 64 distinct denials (a hostile page cannot flood the log)', () => {
    const { check, d } = handlers()
    for (let i = 0; i < 100; i++) check(appWc, `made-up-${i}`, 'file:///', { isMainFrame: true, requestingUrl: PAGE })
    expect(d.log).toHaveBeenCalledTimes(64)
  })

  it('names the permission with safe characters only, and briefly', () => {
    const { check, d } = handlers()
    check(appWc, 'odd\nname/with:stuff' + 'x'.repeat(80), 'file:///', { isMainFrame: true, requestingUrl: PAGE })
    const line = String(d.log.mock.calls[0][0])
    expect(line).toMatch(/^\[permissions\] denied oddnamewithstuffx+ check: not on the allowlist$/)
    expect(line.length).toBeLessThan(120)
  })

  it('the check handler returns true only for what is allowed', () => {
    const { check } = handlers()
    expect(check(appWc, 'clipboard-sanitized-write', 'file:///', { isMainFrame: true, requestingUrl: PAGE })).toBe(true)
    expect(check(appWc, 'geolocation', 'file:///', { isMainFrame: true, requestingUrl: PAGE })).toBe(false)
    expect(check(null, 'notifications', 'file:///', { isMainFrame: true })).toBe(false)
  })

  it('denies, and still answers, if deciding throws (a destroyed window)', () => {
    const { request, check, d } = handlers(deps({ isAppContents: () => { throw new Error('Object has been destroyed') } }))
    const cb = vi.fn()
    request(appWc, 'media', cb, fromPage({ mediaTypes: ['audio'] }))
    expect(cb).toHaveBeenCalledWith(false)
    expect(check(appWc, 'notifications', 'file:///', { isMainFrame: true, requestingUrl: PAGE })).toBe(false)
    expect(d.log.mock.calls.map((c) => c[0])).toEqual([
      '[permissions] denied media request: not from the Termpolis window',
      '[permissions] denied notifications check: not from the Termpolis window',
    ])
  })

  it('logs to console.warn when no log is given (main captures it into the app log)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const ses = session()
      installPermissionPolicy(ses, { appPageUrl: () => PAGE, isAppContents: (wc) => wc === appWc })
      const check = ses.setPermissionCheckHandler.mock.calls[0][0] as (...a: unknown[]) => boolean
      expect(check(appWc, 'geolocation', 'file:///', { isMainFrame: true, requestingUrl: PAGE })).toBe(false)
      expect(warn).toHaveBeenCalledWith('[permissions] denied geolocation check: not on the allowlist')
    } finally {
      warn.mockRestore()
    }
  })

  it('tolerates a missing session or a session without the handler methods', () => {
    expect(() => installPermissionPolicy(null, deps())).not.toThrow()
    expect(() => installPermissionPolicy(undefined, deps())).not.toThrow()
    expect(() => installPermissionPolicy({}, deps())).not.toThrow()
  })
})

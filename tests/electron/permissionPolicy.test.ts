import { describe, it, expect, vi, beforeEach } from 'vitest'
import { win32 } from 'path'
import { format as formatUrl, pathToFileURL } from 'url'
import {
  createAppPage,
  decideCheck,
  decideRequest,
  fileUrlOf,
  gestureCamera,
  installDeviceRefusals,
  installPermissionPolicy,
  isAppOrigin,
  refuseBluetooth,
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

  it('compares a file URL whose escapes cannot be decoded as it is, without throwing', () => {
    expect(isAppPage('file:///a/%E0%A4%A', 'file:///a/%E0%A4%A')).toBe(true)
    expect(isAppPage('file:///a/%E0%A4%A#/x', 'file:///a/%E0%A4%A')).toBe(true)
    expect(isAppPage('file:///b/%E0%A4%A', 'file:///a/%E0%A4%A')).toBe(false)
    expect(isAppPage(PAGE, 'file:///a/%E0%A4%A')).toBe(false)
    // A lone % is not an escape: it stands for itself, so %25 matches it.
    expect(isAppPage('file:///a%/index.html', 'file:///a%25/index.html')).toBe(true)
    expect(isAppPage('file:///a%zz/index.html', 'file:///a%25zz/index.html')).toBe(true)
    expect(isAppPage('file:///a%/index.html', 'file:///b%25/index.html')).toBe(false)
  })
})

// What the window's address bar really holds after loadFile(path): Electron formats the path the way
// url.format does (escaping only ? and #) and Chromium parses it (encoding spaces and non-ASCII, keeping
// a % that starts no escape, turning a backslash into /).
const loaded = (path: string): string => new URL(formatUrl({ protocol: 'file', slashes: true, pathname: path })).href

describe('fileUrlOf: the page URL of the file main loads, as the window holds it', () => {
  // Windows paths are written with / here and given their backslashes below, as path.resolve gives them.
  const dirs = process.platform === 'win32'
    ? ['C:/Program Files/Termpolis', 'C:/Users/Dav%id/100%', 'C:/Users/a #b/c?d', 'C:/Users/Jos\u00e9 M\u00fcller/\u65e5\u672c', 'C:/Users/x/%41%2', 'D:/%E0%A4%A']
    : ['/opt/Termpolis App', '/home/dav%id/100%', '/home/a #b/c?d', '/home/jos\u00e9 m\u00fcller/\u65e5\u672c', '/home/x/%41%2', '/srv/%E0%A4%A']
  const files = dirs.map((d) => process.platform === 'win32' ? win32.normalize(`${d}/index.html`) : `${d}/index.html`)

  it.each(files)('matches the loaded page for %s', (file) => {
    expect(fileUrlOf(file)).toBe(loaded(file))
    expect(isAppPage(`${loaded(file)}#/world`, fileUrlOf(file))).toBe(true)
    expect(isAppPage(`${loaded(file)}?q=1`, fileUrlOf(file))).toBe(true)
  })

  it.each(files)('never throws, and tells another file from %s', (file) => {
    expect(() => isAppPage(loaded(file), pathToFileURL(file).href)).not.toThrow()
    expect(isAppPage(loaded(`${file}.bak`), fileUrlOf(file))).toBe(false)
    expect(isAppPage(loaded(file.replace('index.html', 'other.html')), fileUrlOf(file))).toBe(false)
  })

  it('agrees with pathToFileURL wherever the path holds no % (spaces, #, ? and non-ASCII)', () => {
    for (const file of files.filter((f) => !f.includes('%'))) {
      expect(isAppPage(`${loaded(file)}#/world`, pathToFileURL(file).href)).toBe(true)
    }
  })

  it('takes a relative or slash-led path the same way', () => {
    expect(fileUrlOf('/a b/index.html')).toBe('file:///a%20b/index.html')
    expect(fileUrlOf('a b/index.html')).toBe('file:///a%20b/index.html')
  })
})

describe('createAppPage: grant against the page URL Chromium committed', () => {
  /** A webContents whose first navigation commits `url`: did-navigate fires once, as Electron's once does. */
  function navigating(url: string | undefined) {
    let listener: (() => void) | undefined
    return {
      once: vi.fn((event: string, l: () => void) => { if (event === 'did-navigate') listener = l }),
      getURL: vi.fn(() => url),
      navigate() { const l = listener; listener = undefined; l?.() },
    }
  }
  const UNC = String.raw`\\server\share\Termpolis\resources\app.asar\out\renderer\index.html`
  // What Chromium commits on Windows for loadFile(UNC): the server is the URL's host.
  const UNC_COMMITTED = 'file://server/share/Termpolis/resources/app.asar/out/renderer/index.html'

  it('a UNC install: the computed URL misses Chromium\'s spelling, the committed one matches', () => {
    // new URL gives a UNC path an empty host, so the computed page alone refuses every grant.
    expect(isAppPage(`${UNC_COMMITTED}#/world`, fileUrlOf(UNC), 'win32')).toBe(false)
    const page = createAppPage(() => fileUrlOf(UNC))
    const wc = navigating(UNC_COMMITTED)
    page.track(wc)
    expect(page.url()).toBe(fileUrlOf(UNC))
    wc.navigate()
    expect(page.url()).toBe(UNC_COMMITTED)
    expect(isAppPage(`${UNC_COMMITTED}#/world`, page.url(), 'win32')).toBe(true)
    const d = deps({ appPageUrl: () => page.url() })
    expect(decideRequest(appWc, 'media', { isMainFrame: true, requestingUrl: `${UNC_COMMITTED}#/world`, mediaTypes: ['audio'] }, d)).toBeNull()
    expect(decideCheck(appWc, 'clipboard-read', 'file:///', { isMainFrame: true, requestingUrl: UNC_COMMITTED }, d)).toBeNull()
    // Another file on the share is still another page.
    expect(decideRequest(appWc, 'media', { isMainFrame: true, requestingUrl: 'file://server/share/other.html', mediaTypes: ['audio'] }, d)).toBe('foreign')
  })

  it('records only the first navigation of a window, and a new window\'s first one', () => {
    const page = createAppPage(() => PAGE)
    const first = navigating(`${PAGE}#/`)
    page.track(first)
    expect(first.once).toHaveBeenCalledWith('did-navigate', expect.any(Function))
    first.navigate()
    expect(page.url()).toBe(`${PAGE}#/`)
    first.getURL.mockReturnValue('file:///elsewhere.html')
    first.navigate() // once: the listener is gone
    expect(page.url()).toBe(`${PAGE}#/`)
    const second = navigating(PAGE)
    page.track(second)
    second.navigate()
    expect(page.url()).toBe(PAGE)
  })

  it('keeps the computed page when the window commits a page of another kind, or nothing', () => {
    const dev = createAppPage(() => DEV)
    for (const url of ['file:///x/index.html', 'http://localhost:9999/', 'https://evil.example/', 'not a url', '', undefined]) {
      const wc = navigating(url)
      dev.track(wc)
      wc.navigate()
      expect(dev.url()).toBe(DEV)
    }
    const devWc = navigating(`${DEV}/#/`)
    dev.track(devWc)
    devWc.navigate()
    expect(dev.url()).toBe(`${DEV}/#/`)

    const file = createAppPage(() => PAGE)
    const web = navigating('https://evil.example/')
    file.track(web)
    web.navigate()
    expect(file.url()).toBe(PAGE)
    const noUrl = { once: (_e: string, l: () => void) => l() }
    file.track(noUrl)
    expect(file.url()).toBe(PAGE)
  })

  it('takes a committed file page even when the computed one cannot be built', () => {
    let fail = true
    const page = createAppPage(() => { if (fail) throw new Error('no path'); return PAGE })
    const web = navigating('https://evil.example/')
    page.track(web)
    web.navigate()
    expect(() => page.url()).toThrow('no path')
    const wc = navigating(UNC_COMMITTED)
    page.track(wc)
    wc.navigate()
    expect(page.url()).toBe(UNC_COMMITTED)
    fail = false
  })

  it('tolerates a missing webContents or one without events', () => {
    const page = createAppPage(() => PAGE)
    expect(() => page.track(null)).not.toThrow()
    expect(() => page.track(undefined)).not.toThrow()
    expect(() => page.track({})).not.toThrow()
    expect(page.url()).toBe(PAGE)
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
    'top-level-storage-access', 'window-management', 'fileSystem', 'unknown',
    'some-permission-a-later-electron-adds',
  ]
  for (const permission of denied) {
    it(`denies ${permission}, even from the app's page`, () => {
      expect(decideRequest(appWc, permission, fromPage(), deps())).toBe('not-allowed')
    })
  }

  it('denies Bluetooth, HID, serial and USB devices by name, even from the app page', () => {
    for (const permission of ['bluetooth', 'hid', 'serial', 'usb']) {
      expect(decideRequest(appWc, permission, fromPage(), deps())).toBe('device')
    }
  })

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

  it('denies a request that does not say it comes from the main frame', () => {
    const d = deps()
    expect(decideRequest(appWc, 'media', { requestingUrl: PAGE, mediaTypes: ['audio'] }, d)).toBe('foreign')
    expect(decideRequest(appWc, 'notifications', { isMainFrame: undefined, requestingUrl: PAGE }, d)).toBe('foreign')
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
    for (const permission of ['geolocation', 'fullscreen', 'pointerLock', 'midi', 'openExternal', 'storage-access']) {
      expect(decideCheck(appWc, permission, 'file:///', fromPageCheck(), deps())).toBe('not-allowed')
    }
    for (const permission of ['bluetooth', 'hid', 'serial', 'usb']) {
      expect(decideCheck(appWc, permission, 'file:///', fromPageCheck(), deps())).toBe('device')
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

  it('is as strict as a request: no requesting URL or no main-frame flag is refused', () => {
    // Electron 43 passes both for every check from a frame (the soak's notifications, clipboard and
    // microphone checks all carry them), and only a cross-origin subframe goes without the URL.
    expect(decideCheck(appWc, 'notifications', 'file:///', { isMainFrame: true }, deps())).toBe('foreign')
    expect(decideCheck(appWc, 'notifications', 'file:///', undefined, deps())).toBe('foreign')
    expect(decideCheck(appWc, 'notifications', 'file:///', { requestingUrl: PAGE }, deps())).toBe('foreign')
    expect(decideCheck(appWc, 'notifications', 'https://evil.example', { isMainFrame: true }, deps())).toBe('foreign')
    expect(decideCheck(appWc, 'notifications', 'file:///', { isMainFrame: true, requestingUrl: '' }, deps())).toBe('foreign')
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

  it('a subframe at the app page itself is refused by the main-frame rule alone, with one exact line each', () => {
    // What e2e test 6 makes Chromium send: a frame whose committed URL is the app page plus a query,
    // so isAppPage passes it and only `isMainFrame === true` can refuse it.
    const framed = { isMainFrame: false, requestingUrl: `${PAGE}?permission-frame` }
    expect(isAppPage(framed.requestingUrl, PAGE)).toBe(true)
    expect(decideRequest(appWc, 'media', { ...framed, isMainFrame: true, mediaTypes: ['audio'] }, deps())).toBeNull()
    expect(decideCheck(appWc, 'clipboard-read', 'file:///', { ...framed, isMainFrame: true }, deps())).toBeNull()
    const { request, check, d } = handlers()
    const cb = vi.fn()
    request(appWc, 'media', cb, { ...framed, mediaTypes: ['audio'], securityOrigin: 'file:///' })
    expect(cb).toHaveBeenCalledWith(false)
    expect(check(appWc, 'clipboard-read', 'file:///', framed)).toBe(false)
    const lines = d.log.mock.calls.map((c) => String(c[0]))
    expect(lines).toEqual([
      '[permissions] denied media request: not from the Termpolis window',
      '[permissions] denied clipboard-read check: not from the Termpolis window',
    ])
    for (const line of lines) expect(line).not.toMatch(/file:|permission-frame|index\.html|Users|Applications/)
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

  it('stops logging once it has logged 64 distinct denials, and says so once (a hostile page cannot flood the log)', () => {
    const { check, d } = handlers()
    for (let i = 0; i < 100; i++) check(appWc, `made-up-${i}`, 'file:///', { isMainFrame: true, requestingUrl: PAGE })
    expect(d.log).toHaveBeenCalledTimes(65)
    expect(d.log.mock.calls[63][0]).toBe('[permissions] denied made-up-63 check: not on the allowlist')
    expect(d.log.mock.calls[64][0]).toBe('[permissions] 64 denials logged; further denials are not logged')
    // Still answering, still quiet.
    expect(check(appWc, 'geolocation', 'file:///', { isMainFrame: true, requestingUrl: PAGE })).toBe(false)
    expect(d.log).toHaveBeenCalledTimes(65)
    // A reset (a test) starts the count again.
    resetPermissionLog()
    check(appWc, 'geolocation', 'file:///', { isMainFrame: true, requestingUrl: PAGE })
    expect(d.log).toHaveBeenCalledTimes(66)
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

describe('installDeviceRefusals and refuseBluetooth: no device is ever handed to the page', () => {
  function fakeSession() {
    const listeners = new Map<string, (...a: unknown[]) => void>()
    return {
      listeners,
      setDevicePermissionHandler: vi.fn(),
      setBluetoothPairingHandler: vi.fn(),
      on: vi.fn((event: string, listener: (...a: unknown[]) => void) => { listeners.set(event, listener) }),
    }
  }

  it('refuses every device permission, and logs the kind once', () => {
    const ses = fakeSession()
    const log = vi.fn()
    installDeviceRefusals(ses, log)
    const handler = ses.setDevicePermissionHandler.mock.calls[0][0] as (d: unknown) => boolean
    for (const deviceType of ['hid', 'serial', 'usb', 'hid']) expect(handler({ deviceType, origin: 'file:///' })).toBe(false)
    expect(handler(undefined)).toBe(false)
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '[permissions] denied hid device: a Bluetooth, HID, serial or USB device is never shared',
      '[permissions] denied serial device: a Bluetooth, HID, serial or USB device is never shared',
      '[permissions] denied usb device: a Bluetooth, HID, serial or USB device is never shared',
      '[permissions] denied unknown device: a Bluetooth, HID, serial or USB device is never shared',
    ])
  })

  it('refuses Bluetooth pairing', () => {
    const ses = fakeSession()
    installDeviceRefusals(ses, vi.fn())
    const pair = ses.setBluetoothPairingHandler.mock.calls[0][0] as (d: unknown, cb: (r: unknown) => void) => void
    const cb = vi.fn()
    pair({ deviceId: 'x', pairingKind: 'confirm' }, cb)
    expect(cb).toHaveBeenCalledWith({ confirmed: false })
  })

  it('adds no HID, serial or USB chooser listener: with none, Electron cancels the request itself', () => {
    const ses = fakeSession()
    installDeviceRefusals(ses, vi.fn())
    expect(ses.on).not.toHaveBeenCalled()
    expect(ses.listeners.size).toBe(0)
  })

  it('installs once per session, however often a window is created on it', () => {
    const ses = fakeSession()
    installDeviceRefusals(ses, vi.fn())
    installDeviceRefusals(ses, vi.fn())
    installDeviceRefusals(ses)
    expect(ses.setDevicePermissionHandler).toHaveBeenCalledTimes(1)
    expect(ses.setBluetoothPairingHandler).toHaveBeenCalledTimes(1)
    const other = fakeSession()
    installDeviceRefusals(other, vi.fn())
    expect(other.setDevicePermissionHandler).toHaveBeenCalledTimes(1)
  })

  it('cancels the Bluetooth chooser once per webContents, however often it is handed over', () => {
    const wc = { on: vi.fn() }
    refuseBluetooth(wc, vi.fn())
    refuseBluetooth(wc, vi.fn())
    refuseBluetooth(wc)
    expect(wc.on).toHaveBeenCalledTimes(1)
    expect(wc.on.mock.calls[0][0]).toBe('select-bluetooth-device')
  })

  it('cancels the Bluetooth chooser with an empty id (Electron would otherwise pick the first device)', () => {
    const listeners = new Map<string, (...a: unknown[]) => void>()
    const wc = { on: vi.fn((event: string, listener: (...a: unknown[]) => void) => { listeners.set(event, listener) }) }
    const log = vi.fn()
    refuseBluetooth(wc, log)
    const ev = { preventDefault: vi.fn() }
    const cb = vi.fn()
    listeners.get('select-bluetooth-device')!(ev, [{ deviceId: 'b1', deviceName: 'Headset' }], cb)
    expect(ev.preventDefault).toHaveBeenCalled()
    expect(cb).toHaveBeenCalledWith('')
    expect(log).toHaveBeenCalledWith('[permissions] denied bluetooth chooser: a Bluetooth, HID, serial or USB device is never shared')
  })

  it('logs to console.warn by default, and copes with a session or webContents that has none of it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const ses = fakeSession()
      installDeviceRefusals(ses)
      ;(ses.setDevicePermissionHandler.mock.calls[0][0] as (d: unknown) => boolean)({ deviceType: 'usb' })
      expect(warn).toHaveBeenCalledWith('[permissions] denied usb device: a Bluetooth, HID, serial or USB device is never shared')
      const listeners = new Map<string, (...a: unknown[]) => void>()
      refuseBluetooth({ on: (event: string, l: (...a: unknown[]) => void) => { listeners.set(event, l) } })
      listeners.get('select-bluetooth-device')!({ preventDefault: () => undefined }, [], () => undefined)
      expect(warn).toHaveBeenCalledWith('[permissions] denied bluetooth chooser: a Bluetooth, HID, serial or USB device is never shared')
    } finally {
      warn.mockRestore()
    }
    expect(() => installDeviceRefusals(null)).not.toThrow()
    expect(() => installDeviceRefusals({})).not.toThrow()
    expect(() => refuseBluetooth(null)).not.toThrow()
    expect(() => refuseBluetooth({})).not.toThrow()
  })
})

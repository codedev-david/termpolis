import { describe, it, expect } from 'vitest'
import { decodeOsc7, normalizeShellPath, osc7PathPart, samePath } from '../../src/shared/cwdPath'

const WIN = { platform: 'win32' as NodeJS.Platform }
const POSIX = { platform: 'linux' as NodeJS.Platform }

describe('normalizeShellPath — Windows dialects', () => {
  it('passes a native path through, uppercasing the drive', () => {
    expect(normalizeShellPath('c:\\Users\\dev\\repo', WIN)).toBe('C:\\Users\\dev\\repo')
  })

  it('converts forward slashes a shell may emit', () => {
    expect(normalizeShellPath('C:/Users/dev/repo', WIN)).toBe('C:\\Users\\dev\\repo')
  })

  it('converts an MSYS path from Git Bash', () => {
    expect(normalizeShellPath('/c/Users/dev/repo', WIN)).toBe('C:\\Users\\dev\\repo')
  })

  it('converts a Cygwin path', () => {
    expect(normalizeShellPath('/cygdrive/c/Users/dev/repo', WIN)).toBe('C:\\Users\\dev\\repo')
  })

  it('converts a WSL mount path', () => {
    expect(normalizeShellPath('/mnt/c/Users/dev/repo', WIN)).toBe('C:\\Users\\dev\\repo')
  })

  it('reads /mnt/c as drive C, not as a drive named M', () => {
    // The MSYS pattern also matches a single leading letter, so ordering decides this.
    expect(normalizeShellPath('/mnt/c/x', WIN)).toBe('C:\\x')
    expect(normalizeShellPath('/cygdrive/c/x', WIN)).toBe('C:\\x')
  })

  it('maps a bare drive in each dialect to that drive root', () => {
    expect(normalizeShellPath('/c', WIN)).toBe('C:\\')
    expect(normalizeShellPath('/mnt/d', WIN)).toBe('D:\\')
    expect(normalizeShellPath('/cygdrive/e', WIN)).toBe('E:\\')
    expect(normalizeShellPath('C:', WIN)).toBe('C:\\')
    expect(normalizeShellPath('C:\\', WIN)).toBe('C:\\')
  })

  it('strips the URI leading slash from a drive path', () => {
    // What file:///C:/repo decodes to. The slash is the URI's empty authority.
    expect(normalizeShellPath('/C:/Users/dev', WIN)).toBe('C:\\Users\\dev')
    expect(normalizeShellPath('/c:', WIN)).toBe('C:\\')
  })

  it('converts a posix-style UNC path', () => {
    expect(normalizeShellPath('//server/share/dir', WIN)).toBe('\\\\server\\share\\dir')
  })

  it('drops a trailing separator so the same directory is always the same string', () => {
    expect(normalizeShellPath('C:\\Users\\dev\\repo\\', WIN)).toBe('C:\\Users\\dev\\repo')
    expect(normalizeShellPath('C:/Users/dev/repo/', WIN)).toBe('C:\\Users\\dev\\repo')
  })

  it('returns null for a rooted posix path with no Windows equivalent', () => {
    // "/usr/bin" inside an MSYS install is not reachable as a Windows path.
    expect(normalizeShellPath('/usr/bin', WIN)).toBeNull()
  })

  it('normalizes separators in a relative fragment on Windows', () => {
    expect(normalizeShellPath('foo/bar', WIN)).toBe('foo\\bar')
  })

  it('survives a lone separator without emptying the path', () => {
    expect(normalizeShellPath('\\', WIN)).toBe('\\')
  })
})

describe('normalizeShellPath — POSIX', () => {
  it('passes an absolute path through', () => {
    expect(normalizeShellPath('/home/dev/repo', POSIX)).toBe('/home/dev/repo')
  })

  it('drops a trailing slash but keeps the root', () => {
    expect(normalizeShellPath('/home/dev/repo/', POSIX)).toBe('/home/dev/repo')
    expect(normalizeShellPath('/', POSIX)).toBe('/')
    expect(normalizeShellPath('//', POSIX)).toBe('/')
  })

  it('does NOT read /c/... or /mnt/c/... as drives off Windows', () => {
    // These are ordinary directories on Linux and rewriting them would point git
    // at a path that does not exist.
    expect(normalizeShellPath('/c/Users/dev', POSIX)).toBe('/c/Users/dev')
    expect(normalizeShellPath('/mnt/c/data', POSIX)).toBe('/mnt/c/data')
  })

  it('rejects a relative fragment', () => {
    expect(normalizeShellPath('repo/src', POSIX)).toBeNull()
  })
})

describe('normalizeShellPath — shared handling', () => {
  it('rejects empty, blank and non-string input', () => {
    expect(normalizeShellPath('', WIN)).toBeNull()
    expect(normalizeShellPath('   ', WIN)).toBeNull()
    expect(normalizeShellPath(undefined as unknown as string, WIN)).toBeNull()
    expect(normalizeShellPath(123 as unknown as string, WIN)).toBeNull()
  })

  it('strips surrounding quotes a shell adds for spaces', () => {
    expect(normalizeShellPath('"C:\\my repo"', WIN)).toBe('C:\\my repo')
    expect(normalizeShellPath("'/home/my repo'", POSIX)).toBe('/home/my repo')
  })

  it('rejects a quoted empty string', () => {
    expect(normalizeShellPath('""', WIN)).toBeNull()
  })

  it('rejects input carrying control characters', () => {
    // Mis-framed terminal bytes, not a path — accepting them would poll git forever
    // with junk.
    expect(normalizeShellPath('C:\\repo\u0007', WIN)).toBeNull()
    expect(normalizeShellPath('/home\u0000/x', POSIX)).toBeNull()
  })

  it('expands a leading ~ when a homedir is supplied', () => {
    expect(normalizeShellPath('~', { ...WIN, homedir: 'C:\\Users\\dev' })).toBe('C:\\Users\\dev')
    expect(normalizeShellPath('~/repo', { ...WIN, homedir: 'C:\\Users\\dev' })).toBe('C:\\Users\\dev\\repo')
    expect(normalizeShellPath('~\\repo', { ...WIN, homedir: 'C:\\Users\\dev' })).toBe('C:\\Users\\dev\\repo')
    expect(normalizeShellPath('~/repo', { ...POSIX, homedir: '/home/dev' })).toBe('/home/dev/repo')
  })

  it('trims a trailing separator off the supplied homedir', () => {
    expect(normalizeShellPath('~/repo', { ...POSIX, homedir: '/home/dev/' })).toBe('/home/dev/repo')
  })

  it('leaves ~ alone when no homedir is known', () => {
    // Guessing another user's home would point git at someone else's repository.
    expect(normalizeShellPath('~/repo', POSIX)).toBeNull()
  })

  it('does not expand ~user, whose home it cannot resolve', () => {
    expect(normalizeShellPath('~otheruser/repo', { ...POSIX, homedir: '/home/dev' })).toBeNull()
  })

  it('delegates a file:// URI handed to it directly', () => {
    expect(normalizeShellPath('file:///C:/Users/dev', WIN)).toBe('C:\\Users\\dev')
  })

  it('defaults to the host platform when none is injected', () => {
    const expected = process.platform === 'win32' ? 'C:\\tmp' : null
    expect(normalizeShellPath('C:/tmp')).toBe(expected)
  })
})

describe('decodeOsc7', () => {
  it('decodes an empty-host URI', () => {
    expect(decodeOsc7('file:///C:/Users/dev/repo', WIN)).toBe('C:\\Users\\dev\\repo')
  })

  it('decodes a URI carrying a hostname', () => {
    // The host is ignored on purpose: shells disagree about what belongs there, and
    // rejecting on a mismatch would kill the mark over a cosmetic difference.
    expect(decodeOsc7('file://DESKTOP-ABC/C:/Users/dev', WIN)).toBe('C:\\Users\\dev')
    expect(decodeOsc7('file://localhost/home/dev', POSIX)).toBe('/home/dev')
  })

  it('percent-decodes a path containing spaces', () => {
    expect(decodeOsc7('file:///C:/my%20repo', WIN)).toBe('C:\\my repo')
    expect(decodeOsc7('file:///home/dev/my%20repo', POSIX)).toBe('/home/dev/my repo')
  })

  it('decodes an MSYS path reported over OSC 7 by Git Bash', () => {
    expect(decodeOsc7('file://HOST/c/Users/dev/repo', WIN)).toBe('C:\\Users\\dev\\repo')
  })

  it('falls back to the undecoded form on a malformed escape', () => {
    // A wrong decode points somewhere real but different; the raw form fails cleanly.
    expect(decodeOsc7('file:///home/dev/100%done', POSIX)).toBe('/home/dev/100%done')
  })

  it('accepts an uppercase scheme and surrounding whitespace', () => {
    expect(decodeOsc7('  FILE:///home/dev  ', POSIX)).toBe('/home/dev')
  })

  it('rejects a payload that is not a file URI', () => {
    expect(decodeOsc7('https://example.com/x', POSIX)).toBeNull()
    expect(decodeOsc7('/home/dev', POSIX)).toBeNull()
    expect(decodeOsc7('', POSIX)).toBeNull()
  })

  it('rejects a URI carrying no path at all', () => {
    expect(decodeOsc7('file://hostname', POSIX)).toBeNull()
  })
})

describe('osc7PathPart', () => {
  it('supplies the raw path for a URI this platform cannot open', () => {
    // WSL running inside a Windows build reports its own root. There is no Windows
    // path for it, so decodeOsc7 answers null — but the shell really IS there, and a
    // caller that ignores the report strands the git mark on the directory just left.
    expect(decodeOsc7('file://wsl/home/dev/repo', WIN)).toBeNull()
    expect(osc7PathPart('file://wsl/home/dev/repo')).toBe('/home/dev/repo')
  })

  it('percent-decodes but does not normalize', () => {
    expect(osc7PathPart('file:///C:/my%20repo')).toBe('/C:/my repo')
    expect(osc7PathPart('  FILE:///home/dev  ')).toBe('/home/dev')
  })

  it('keeps the undecoded form on a malformed escape', () => {
    expect(osc7PathPart('file:///home/dev/100%done')).toBe('/home/dev/100%done')
  })

  it('rejects exactly what decodeOsc7 rejects', () => {
    expect(osc7PathPart('https://example.com/x')).toBeNull()
    expect(osc7PathPart('/home/dev')).toBeNull()
    expect(osc7PathPart('')).toBeNull()
    expect(osc7PathPart('file://hostname')).toBeNull()
  })
})

describe('samePath', () => {
  it('treats separator and case differences as the same directory on Windows', () => {
    expect(samePath('C:\\Repo', 'c:/repo', 'win32')).toBe(true)
    expect(samePath('C:\\Repo\\', 'C:\\Repo', 'win32')).toBe(true)
  })

  it('is case-sensitive off Windows', () => {
    expect(samePath('/home/Repo', '/home/repo', 'linux')).toBe(false)
    expect(samePath('/home/repo/', '/home/repo', 'linux')).toBe(true)
  })

  it('handles null and undefined without claiming a false match', () => {
    expect(samePath(null, null)).toBe(true)
    expect(samePath(undefined, undefined)).toBe(true)
    expect(samePath(null, '/home/dev')).toBe(false)
    expect(samePath('/home/dev', undefined)).toBe(false)
    expect(samePath('', null)).toBe(true)
  })

  it('defaults to the host platform', () => {
    expect(samePath('/home/dev', '/home/dev')).toBe(true)
  })

  it('reports genuinely different directories as different', () => {
    expect(samePath('C:\\a', 'C:\\b', 'win32')).toBe(false)
  })
})

describe('the host-platform backstop when there is no process', () => {
  /**
   * Under context isolation the renderer has no `process` AT ALL — a bare
   * `process.platform` there is a ReferenceError that takes out the whole data handler it
   * was called from, not merely a wrong answer. Renderer callers pass `platform`
   * explicitly, so this fallback only runs for the ones that forget; that is precisely
   * when it must not throw.
   *
   * vitest always supplies a real `process`, so the branch is unreachable without taking
   * it away. The call runs with process removed but the ASSERTION runs after it is back:
   * a failing expect() builds its diff using process, and asserting inside would turn a
   * simple mismatch into an unreadable crash.
   */
  const withoutProcess = <T>(ua: string, run: () => T): T => {
    const realProcess = globalThis.process
    const realUa = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent')
    ;(globalThis as unknown as { process?: unknown }).process = undefined
    Object.defineProperty(globalThis.navigator, 'userAgent', { value: ua, configurable: true })
    try {
      return run()
    } finally {
      ;(globalThis as unknown as { process?: unknown }).process = realProcess
      // jsdom keeps userAgent on Navigator.PROTOTYPE, so there is normally no own property
      // to put back: defineProperty above added one that shadows the getter, and only a
      // delete removes it. Without this the last stub leaks into every later test here.
      if (realUa) Object.defineProperty(globalThis.navigator, 'userAgent', realUa)
      else delete (globalThis.navigator as { userAgent?: string }).userAgent
    }
  }

  /**
   * The bottom rung: a host with neither `process` NOR `navigator` — a sandboxed worker,
   * a bare V8 context, any embedder that is not a browser. Nothing is left to read, so
   * the guess has to resolve to a value rather than throw; `navigator.userAgent` written
   * as a bare identifier would be the same ReferenceError this whole ladder exists to
   * avoid, just one rung further down.
   */
  const withoutProcessOrNavigator = <T>(run: () => T): T => {
    const realProcess = globalThis.process
    const realNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    ;(globalThis as unknown as { process?: unknown }).process = undefined
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true })
    try {
      return run()
    } finally {
      ;(globalThis as unknown as { process?: unknown }).process = realProcess
      if (realNav) Object.defineProperty(globalThis, 'navigator', realNav)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  }

  it('answers instead of throwing when there is no navigator either', () => {
    const got = withoutProcessOrNavigator(() => normalizeShellPath('/home/dev/repo'))
    expect(got).toBe('/home/dev/repo')
  })

  it('reads Windows out of the user agent and applies the Windows dialects', () => {
    const got = withoutProcess('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/32', () =>
      normalizeShellPath('/c/Users/dev/repo'),
    )
    expect(got).toBe('C:\\Users\\dev\\repo')
  })

  it('reads macOS out of the user agent, where /c/... is just a directory', () => {
    const got = withoutProcess('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/32', () => ({
      home: normalizeShellPath('/Users/dev/repo'),
      notADrive: normalizeShellPath('/c/Users/dev'),
    }))
    expect(got.home).toBe('/Users/dev/repo')
    expect(got.notADrive).toBe('/c/Users/dev')
  })

  it('falls through to linux for anything it does not recognise', () => {
    const got = withoutProcess('Mozilla/5.0 (X11; Linux x86_64) Electron/32', () => ({
      path: normalizeShellPath('/home/dev/repo'),
      caseSensitive: samePath('/home/Repo', '/home/repo'),
    }))
    expect(got.path).toBe('/home/dev/repo')
    // Case-sensitive, which is the whole reason the platform guess matters here.
    expect(got.caseSensitive).toBe(false)
  })
})

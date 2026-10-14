// Tests for writeSecureFile — the cross-platform helper that writes token
// files with POSIX 0o600 mode AND an NTFS ACL via icacls on Windows.
//
// Key invariants we verify:
//   1. writeFileSync is always called with mode: 0o600
//   2. On Windows, ONE icacls call (inheritance:r + grant:r DOMAIN\user:F)
//      with shell:false so the file path can't be shell-escaped — the two
//      switches every boot has always run, and nothing that removes,
//      denies, re-owns or resets
//   3. icacls failure doesn't break the caller — file is already on disk
//   4. USERNAME is validated, never edited: a name carrying icacls syntax
//      (an injected "/grant everyone:F") is refused before any spawn
//   5. A file the old two-call sequence locked out is reopened, not fatal
//
// USERDOMAIN is set or deleted in EVERY win32 case: the Windows CI runner has
// one and Linux/macOS don't, so a case that inherits it passes on one OS and
// fails on the other.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockWriteFileSync, mockReadFileSync, mockExistsSync, mockUnlinkSync, mockExecFileSync } = vi.hoisted(() => ({
  mockWriteFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockExecFileSync: vi.fn(),
}))

vi.mock('fs', () => {
  const fs = {
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    unlinkSync: mockUnlinkSync,
  }
  return { ...fs, default: fs }
})

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  default: { execFileSync: mockExecFileSync },
}))

/** What execFileSync throws when icacls exits non-zero: the exit status, and stderr in the message. */
function icaclsFailure(status: number, said: string): Error {
  return Object.assign(new Error(`Command failed: icacls\n${said}`), { status })
}

function errno(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

describe('writeSecureFile', () => {
  const saved: Record<string, string | undefined> = {}
  const ENV_KEYS = ['USERNAME', 'USER', 'USERDOMAIN', 'TERMPOLIS_SKIP_ACL'] as const
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    mockWriteFileSync.mockReset()
    mockReadFileSync.mockReset()
    mockExistsSync.mockReset()
    mockUnlinkSync.mockReset()
    mockExecFileSync.mockReset()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    delete process.env.TERMPOLIS_SKIP_ACL
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }

  /** Windows, as USERNAME on USERDOMAIN; `undefined` deletes the variable rather than inheriting it. */
  function onWindows(username: string | undefined, domain: string | undefined) {
    setPlatform('win32')
    if (username === undefined) delete process.env.USERNAME
    else process.env.USERNAME = username
    if (domain === undefined) delete process.env.USERDOMAIN
    else process.env.USERDOMAIN = domain
  }

  /** The principal argument of the n-th icacls call ("PC\\david:F"). */
  const granted = (n = 0): string => mockExecFileSync.mock.calls[n][1][3]

  it('writes file with mode 0o600', async () => {
    setPlatform('linux')
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('/tmp/token', 'secret')
    expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/token', 'secret', {
      encoding: 'utf-8',
      mode: 0o600,
    })
    expect(r.aclApplied).toBe(true)
  })

  it('on POSIX, does not invoke icacls', async () => {
    setPlatform('darwin')
    const { writeSecureFile } = await import('../../src/main/secureFile')
    writeSecureFile('/tmp/token', 'secret')
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('on win32, ONE icacls call strips inheritance and grants DOMAIN\\user full control', async () => {
    onWindows('david', 'PC')
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\Users\\david\\mcp-token', 'secret')
    expect(r.aclApplied).toBe(true)
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
    const [cmd, argv, opts] = mockExecFileSync.mock.calls[0]
    expect(cmd).toBe('icacls')
    // The whole argv, pinned: these two switches are what every boot has always run. Nothing
    // that removes SYSTEM/Administrators, denies, takes ownership or resets — a Termpolis child
    // doing that on every boot is what an endpoint monitor raises an incident over.
    expect(argv).toEqual(['C:\\Users\\david\\mcp-token', '/inheritance:r', '/grant:r', 'PC\\david:F'])
    expect(opts).toMatchObject({ shell: false, windowsHide: true, timeout: 5000, stdio: 'pipe' })
  })

  it('on win32 without USERDOMAIN, grants the bare name', async () => {
    onWindows('david', undefined)
    const { writeSecureFile } = await import('../../src/main/secureFile')
    writeSecureFile('C:\\f', 'x')
    expect(granted()).toBe('david:F')
  })

  it('ignores a USERDOMAIN that is not a domain name, rather than editing it', async () => {
    onWindows('david', 'CORP:evil')
    const { writeSecureFile } = await import('../../src/main/secureFile')
    writeSecureFile('C:\\f', 'x')
    expect(granted()).toBe('david:F')
  })

  it('a DOMAIN\\user USERNAME keeps its own domain over USERDOMAIN', async () => {
    onWindows('CORP\\jane', 'OTHER')
    const { writeSecureFile } = await import('../../src/main/secureFile')
    writeSecureFile('C:\\f', 'x')
    expect(granted()).toBe('CORP\\jane:F')
  })

  it('on win32, refuses a USERNAME carrying icacls syntax — no icacls call at all', async () => {
    // Attacker-controlled env: "david /grant everyone:F" would become extra icacls syntax if
    // passed through. Stripping it used to leave "davidgranteveryoneF" — a name that is not
    // the user and could be someone else's — so it is refused outright now.
    onWindows('david /grant everyone:F', 'PC')
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\Users\\david\\mcp-token', 'secret')
    expect(r.aclApplied).toBe(false)
    expect(r.aclError).toContain('USERNAME')
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockWriteFileSync).toHaveBeenCalled()
  })

  it.each([
    ['CORP\\a\\b', 'two backslashes'],
    ['CORP\\', 'no account'],
    ['\\jane', 'an empty domain'],
    ['CO:RP\\jane', 'a domain carrying icacls syntax'],
  ])('refuses %s (%s) without calling icacls', async (username) => {
    onWindows(username, 'PC')
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    expect(r.aclApplied).toBe(false)
    expect(r.aclError).toContain('USERNAME')
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('refuses a machine account: LocalSystem runs as COMPUTER$, which a domain resolves to someone else', async () => {
    onWindows('PC1$', 'CORP')
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    expect(r.aclApplied).toBe(false)
    expect(r.aclError).toMatch(/USERNAME.*machine account/)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('on win32 without USERNAME, returns aclApplied:false without throwing', async () => {
    onWindows(undefined, 'PC')
    delete process.env.USER
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    expect(r.aclApplied).toBe(false)
    expect(r.aclError).toContain('USERNAME')
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('on win32 with TERMPOLIS_SKIP_ACL, skips icacls and says so', async () => {
    onWindows('david', 'PC')
    process.env.TERMPOLIS_SKIP_ACL = '1'
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    expect(r).toMatchObject({ aclApplied: false, aclError: 'skipped (TERMPOLIS_SKIP_ACL)' })
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('a qualified name that maps to no account is retried ONCE with the bare name', async () => {
    // USERDOMAIN can name a domain this machine cannot resolve (offline, or a stale logon value).
    onWindows('david', 'CORP')
    mockExecFileSync.mockImplementationOnce(() => {
      throw icaclsFailure(1332, 'CORP\\david: No mapping between account names and security IDs was done.')
    })
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    expect(r.aclApplied).toBe(true)
    expect(mockExecFileSync).toHaveBeenCalledTimes(2)
    expect(granted(0)).toBe('CORP\\david:F')
    expect(granted(1)).toBe('david:F')
  })

  it("when neither name maps, reports icacls's own reason", async () => {
    onWindows('david', 'CORP')
    mockExecFileSync.mockImplementation(() => {
      throw icaclsFailure(1332, 'david: No mapping between account names and security IDs was done.')
    })
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    expect(r.aclApplied).toBe(false)
    expect(r.aclError).toContain('No mapping')
    expect(mockExecFileSync).toHaveBeenCalledTimes(2)
  })

  it('a failure other than "no mapping" is not retried with the bare name', async () => {
    onWindows('david', 'CORP')
    mockExecFileSync.mockImplementation(() => {
      throw icaclsFailure(5, 'C:\\f: Access is denied.')
    })
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    expect(r.aclApplied).toBe(false)
    expect(r.aclError).toContain('Access is denied')
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
  })

  it('with no domain to drop, an unmapped name is not retried', async () => {
    onWindows('david', undefined)
    mockExecFileSync.mockImplementation(() => {
      throw icaclsFailure(1332, 'david: No mapping between account names and security IDs was done.')
    })
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    expect(r.aclApplied).toBe(false)
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
  })

  it('on win32, icacls failure is swallowed (file still written)', async () => {
    onWindows('david', 'PC')
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('icacls not found')
    })
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    // writeFileSync still happened
    expect(mockWriteFileSync).toHaveBeenCalled()
    // aclApplied false + error captured
    expect(r.aclApplied).toBe(false)
    expect(r.aclError).toContain('icacls not found')
  })

  it('a non-Error throw from the spawn still yields a reason', async () => {
    onWindows('david', 'PC')
    mockExecFileSync.mockImplementationOnce(() => {
      throw 'spawn icacls ENOENT'
    })
    const { writeSecureFile } = await import('../../src/main/secureFile')
    expect(writeSecureFile('C:\\f', 'x').aclError).toBe('spawn icacls ENOENT')
  })

  it('every icacls call has shell:false', async () => {
    onWindows('david', 'CORP')
    mockExecFileSync.mockImplementationOnce(() => {
      throw icaclsFailure(1332, 'No mapping')
    })
    const { writeSecureFile } = await import('../../src/main/secureFile')
    writeSecureFile('C:\\f', 'x')
    expect(mockExecFileSync).toHaveBeenCalledTimes(2)
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[2].shell).toBe(false)
      expect(call[2].windowsHide).toBe(true)
    }
  })

  // OneDrive sync, AV scanners, backup agents briefly lock files on Windows.
  // writeSecureFile must retry transient EBUSY/EPERM/EACCES instead of
  // crashing the main process during MCP token write on boot.
  describe('write retry on transient Windows locks', () => {
    it('retries EBUSY and succeeds within MAX_WRITE_ATTEMPTS', async () => {
      setPlatform('linux')
      let calls = 0
      mockWriteFileSync.mockImplementation(() => {
        calls++
        if (calls < 3) {
          const e: any = new Error('resource busy')
          e.code = 'EBUSY'
          throw e
        }
      })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      const r = writeSecureFile('/tmp/t', 'x')
      expect(calls).toBe(3)
      expect(r.writeRetries).toBe(2)
    })

    it('retries EPERM (OneDrive) and succeeds', async () => {
      setPlatform('linux')
      let calls = 0
      mockWriteFileSync.mockImplementation(() => {
        calls++
        if (calls === 1) {
          const e: any = new Error('EPERM: operation not permitted')
          e.code = 'EPERM'
          throw e
        }
      })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      const r = writeSecureFile('/tmp/t', 'x')
      expect(r.writeRetries).toBe(1)
    })

    it('gives up after MAX_WRITE_ATTEMPTS and rethrows', async () => {
      setPlatform('linux')
      mockWriteFileSync.mockImplementation(() => {
        const e: any = new Error('still locked')
        e.code = 'EBUSY'
        throw e
      })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      expect(() => writeSecureFile('/tmp/t', 'x')).toThrowError(/still locked/)
      // Hard-coded to the retry budget in secureFile.ts (4 attempts)
      expect(mockWriteFileSync).toHaveBeenCalledTimes(4)
    }, 10000)

    it('non-retryable errors bubble immediately (no retry)', async () => {
      setPlatform('linux')
      mockWriteFileSync.mockImplementation(() => {
        const e: any = new Error('ENOSPC: no space left')
        e.code = 'ENOSPC'
        throw e
      })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      expect(() => writeSecureFile('/tmp/t', 'x')).toThrowError(/ENOSPC/)
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
    })

    it('writeRetries is 0 on first-try success', async () => {
      setPlatform('linux')
      const { writeSecureFile } = await import('../../src/main/secureFile')
      const r = writeSecureFile('/tmp/t', 'x')
      expect(r.writeRetries).toBe(0)
    })
  })

  // Before the single call, icacls ran twice: /inheritance:r, then /grant:r. When the grant named
  // no account (the old sanitizer made "David Engelhart" into "DavidEngelhart") the first call had
  // already emptied the DACL, and every later write of that file failed with EPERM — on the boot
  // path, before Remote, linked machines and agent integration start.
  describe('a file the old two-call ACL locked out', () => {
    it('is reopened by the grant, then written', async () => {
      onWindows('David Engelhart', 'PC')
      mockExistsSync.mockReturnValue(true)
      let writes = 0
      mockWriteFileSync.mockImplementation(() => {
        if (++writes <= 4) throw errno('EPERM', 'EPERM: operation not permitted')
      })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      const r = writeSecureFile('C:\\ud\\mcp-token', 'tok')
      // Four failed attempts, the grant, the write that now succeeds — then the usual lockdown.
      expect(writes).toBe(5)
      expect(mockExecFileSync).toHaveBeenCalledTimes(2)
      expect(granted(0)).toBe('PC\\David Engelhart:F')
      expect(mockUnlinkSync).not.toHaveBeenCalled()
      expect(r).toMatchObject({ aclApplied: true, writeRetries: 4 })
    }, 10000)

    it('is replaced when the grant cannot reopen it', async () => {
      onWindows('david', 'PC')
      mockExistsSync.mockReturnValue(true)
      let writes = 0
      mockWriteFileSync.mockImplementation(() => {
        if (++writes <= 5) throw errno('EACCES', 'EACCES: permission denied')
      })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      const r = writeSecureFile('C:\\ud\\mcp-token', 'tok')
      expect(mockUnlinkSync).toHaveBeenCalledWith('C:\\ud\\mcp-token')
      expect(writes).toBe(6)
      expect(r).toMatchObject({ aclApplied: true, writeRetries: 5 })
    }, 10000)

    it('rethrows the original error when it cannot be replaced either', async () => {
      onWindows('david', 'PC')
      mockExistsSync.mockReturnValue(true)
      let writes = 0
      mockWriteFileSync.mockImplementation(() => {
        throw errno('EPERM', ++writes === 4 ? 'the fourth attempt' : 'a later attempt')
      })
      mockUnlinkSync.mockImplementation(() => { throw errno('EPERM', 'unlink refused') })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      expect(() => writeSecureFile('C:\\ud\\mcp-token', 'tok')).toThrowError('the fourth attempt')
    }, 10000)

    it('an access-denied on a file that is not there is not a lockout', async () => {
      // The folder itself refusing the create: no file to reopen, so nothing to grant or replace.
      onWindows('david', 'PC')
      mockExistsSync.mockReturnValue(false)
      mockWriteFileSync.mockImplementation(() => { throw errno('EPERM') })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      expect(() => writeSecureFile('C:\\ud\\mcp-token', 'tok')).toThrowError('EPERM')
      expect(mockExecFileSync).not.toHaveBeenCalled()
      expect(mockUnlinkSync).not.toHaveBeenCalled()
    }, 10000)

    it('a file still busy after every retry is rethrown, not repaired', async () => {
      onWindows('david', 'PC')
      mockExistsSync.mockReturnValue(true)
      mockWriteFileSync.mockImplementation(() => { throw errno('EBUSY') })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      expect(() => writeSecureFile('C:\\ud\\mcp-token', 'tok')).toThrowError('EBUSY')
      expect(mockExecFileSync).not.toHaveBeenCalled()
    }, 10000)

    it('off Windows, an EPERM is just a failed write', async () => {
      setPlatform('linux')
      mockExistsSync.mockReturnValue(true)
      mockWriteFileSync.mockImplementation(() => { throw errno('EPERM') })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      expect(() => writeSecureFile('/tmp/t', 'x')).toThrowError('EPERM')
      expect(mockExecFileSync).not.toHaveBeenCalled()
      expect(mockUnlinkSync).not.toHaveBeenCalled()
    }, 10000)
  })

  describe('readSecureFile', () => {
    it('reads the file as UTF-8, with no icacls when nothing is wrong', async () => {
      onWindows('david', 'PC')
      mockReadFileSync.mockReturnValue('{"paths":[]}')
      const { readSecureFile } = await import('../../src/main/secureFile')
      expect(readSecureFile('C:\\ud\\trusted-workspaces.json')).toBe('{"paths":[]}')
      expect(mockReadFileSync).toHaveBeenCalledWith('C:\\ud\\trusted-workspaces.json', 'utf-8')
      expect(mockExecFileSync).not.toHaveBeenCalled()
    })

    it('reopens a locked-out file with the grant, then reads it', async () => {
      // Without this a trust store the old ACL locked reads as empty on every boot, and the next
      // save overwrites the user's real list with that empty one.
      onWindows('david', 'PC')
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync
        .mockImplementationOnce(() => { throw errno('EPERM') })
        .mockReturnValueOnce('{"paths":["C:\\\\repo"]}')
      const { readSecureFile } = await import('../../src/main/secureFile')
      expect(readSecureFile('C:\\ud\\trusted-workspaces.json')).toBe('{"paths":["C:\\\\repo"]}')
      expect(mockExecFileSync).toHaveBeenCalledTimes(1)
      expect(granted()).toBe('PC\\david:F')
    })

    it('throws when the file is still unreadable after the grant', async () => {
      onWindows('david', 'PC')
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockImplementation(() => { throw errno('EACCES') })
      const { readSecureFile } = await import('../../src/main/secureFile')
      expect(() => readSecureFile('C:\\ud\\x.json')).toThrowError('EACCES')
      expect(mockExecFileSync).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['win32', 'ENOENT'],
      ['linux', 'EACCES'],
    ] as const)('on %s, %s is rethrown without touching the ACL', async (platform, code) => {
      onWindows('david', 'PC')
      setPlatform(platform)
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockImplementation(() => { throw errno(code) })
      const { readSecureFile } = await import('../../src/main/secureFile')
      expect(() => readSecureFile('/ud/x.json')).toThrowError(code)
      expect(mockExecFileSync).not.toHaveBeenCalled()
    })
  })

  // Real Windows usernames can contain unicode, spaces, or shell-meta-like
  // characters. None of them is icacls syntax, and with shell:false there is
  // no shell to interpret them, so they reach icacls exactly as Windows has
  // them — where the old strip-to-ASCII produced a different, wrong name.
  describe('USERNAME edge cases', () => {
    it('a name with a space is ONE argv element, space and all', async () => {
      onWindows('David Engelhart', 'PC')
      const { writeSecureFile } = await import('../../src/main/secureFile')
      writeSecureFile('C:\\f', 'x')
      expect(mockExecFileSync.mock.calls[0][1]).toHaveLength(4)
      expect(granted()).toBe('PC\\David Engelhart:F')
    })

    it.each(['José', 'やまだ'])('a non-ASCII name (%s) reaches icacls verbatim', async (name) => {
      onWindows(name, 'PC')
      const { writeSecureFile } = await import('../../src/main/secureFile')
      const r = writeSecureFile('C:\\f', 'x')
      expect(r.aclApplied).toBe(true)
      expect(granted()).toBe(`PC\\${name}:F`)
    })

    it('shell metacharacters ($me%admin`) reach icacls verbatim — there is no shell', async () => {
      onWindows('$me%admin`', 'PC')
      const { writeSecureFile } = await import('../../src/main/secureFile')
      writeSecureFile('C:\\f', 'x')
      expect(granted()).toBe('PC\\$me%admin`:F')
    })

    it('falls back to USER if USERNAME absent (MSYS/Git Bash on Windows)', async () => {
      onWindows(undefined, undefined)
      process.env.USER = 'david'
      const { writeSecureFile } = await import('../../src/main/secureFile')
      writeSecureFile('C:\\f', 'x')
      expect(granted()).toBe('david:F')
    })
  })
})

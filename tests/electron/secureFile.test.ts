// Tests for writeSecureFile — the cross-platform helper that writes token
// files with POSIX 0o600 mode AND an NTFS ACL via icacls on Windows.
//
// Key invariants we verify:
//   1. writeFileSync is always called with mode: 0o600
//   2. On Windows, icacls is invoked twice (inheritance:r, grant:r <user>:F)
//      with shell:false so the file path can't be shell-escaped
//   3. icacls failure doesn't break the caller — file is already on disk
//   4. USERNAME is sanitized so an attacker-controlled env var can't inject
//      an icacls flag like "/grant administrators:F"

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockWriteFileSync, mockExecFileSync } = vi.hoisted(() => ({
  mockWriteFileSync: vi.fn(),
  mockExecFileSync: vi.fn(),
}))

vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  default: { writeFileSync: mockWriteFileSync },
}))

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  default: { execFileSync: mockExecFileSync },
}))

describe('writeSecureFile', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let originalUsername: string | undefined
  let originalUser: string | undefined

  beforeEach(() => {
    mockWriteFileSync.mockReset()
    mockExecFileSync.mockReset()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    originalUsername = process.env.USERNAME
    originalUser = process.env.USER
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    if (originalUsername === undefined) delete process.env.USERNAME
    else process.env.USERNAME = originalUsername
    if (originalUser === undefined) delete process.env.USER
    else process.env.USER = originalUser
  })

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }

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

  it('on win32, invokes icacls with /inheritance:r and /grant:r', async () => {
    setPlatform('win32')
    process.env.USERNAME = 'david'
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\Users\\david\\mcp-token', 'secret')
    expect(r.aclApplied).toBe(true)
    expect(mockExecFileSync).toHaveBeenCalledTimes(2)
    const call1 = mockExecFileSync.mock.calls[0]
    const call2 = mockExecFileSync.mock.calls[1]
    expect(call1[0]).toBe('icacls')
    expect(call1[1]).toEqual(['C:\\Users\\david\\mcp-token', '/inheritance:r'])
    expect(call1[2].shell).toBe(false)
    expect(call2[0]).toBe('icacls')
    expect(call2[1]).toEqual(['C:\\Users\\david\\mcp-token', '/grant:r', 'david:F'])
    expect(call2[2].shell).toBe(false)
  })

  it('on win32, sanitizes USERNAME — rejects injected flags', async () => {
    setPlatform('win32')
    // Attacker-controlled env: "david /grant everyone:F" would become an
    // extra icacls flag if we passed it raw. We strip non-alphanumeric-ish.
    process.env.USERNAME = 'david /grant everyone:F'
    const { writeSecureFile } = await import('../../src/main/secureFile')
    writeSecureFile('C:\\Users\\david\\mcp-token', 'secret')
    const grantCall = mockExecFileSync.mock.calls[1]
    // Space, colon, slash are stripped — the resulting user token is safe
    // even though it won't match a real account; icacls will fail harmlessly.
    // The trailing ":F" is the permission suffix appended by the helper.
    expect(grantCall[1][2]).toBe('davidgranteveryoneF:F')
    // Critically, argv stays at length 3 — no injected extra flag reached icacls
    expect(grantCall[1]).toHaveLength(3)
  })

  it('on win32 without USERNAME, returns aclApplied:false without throwing', async () => {
    setPlatform('win32')
    delete process.env.USERNAME
    delete process.env.USER
    const { writeSecureFile } = await import('../../src/main/secureFile')
    const r = writeSecureFile('C:\\f', 'x')
    expect(r.aclApplied).toBe(false)
    expect(r.aclError).toContain('USERNAME')
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('on win32, icacls failure is swallowed (file still written)', async () => {
    setPlatform('win32')
    process.env.USERNAME = 'david'
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

  it('every icacls call has shell:false', async () => {
    setPlatform('win32')
    process.env.USERNAME = 'david'
    const { writeSecureFile } = await import('../../src/main/secureFile')
    writeSecureFile('C:\\f', 'x')
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

  // Real Windows usernames can contain unicode, spaces, backslashes (DOMAIN\user),
  // or be shell-meta-like. We strip to [A-Za-z0-9._\\-]: safe for icacls argv,
  // degrades gracefully (aclApplied:false) for non-ASCII accounts.
  describe('USERNAME edge cases', () => {
    it('preserves DOMAIN\\user', async () => {
      setPlatform('win32')
      process.env.USERNAME = 'CORP\\jane'
      const { writeSecureFile } = await import('../../src/main/secureFile')
      writeSecureFile('C:\\f', 'x')
      expect(mockExecFileSync.mock.calls[1][1][2]).toBe('CORP\\jane:F')
    })

    it('strips spaces (real account "David Engelhart" → "DavidEngelhart")', async () => {
      setPlatform('win32')
      process.env.USERNAME = 'David Engelhart'
      const { writeSecureFile } = await import('../../src/main/secureFile')
      writeSecureFile('C:\\f', 'x')
      expect(mockExecFileSync.mock.calls[1][1][2]).toBe('DavidEngelhart:F')
    })

    it('strips unicode (José → Jos); icacls will fail, aclApplied:false', async () => {
      setPlatform('win32')
      process.env.USERNAME = 'José'
      mockExecFileSync.mockImplementation(() => {
        throw new Error('icacls: No mapping between account names')
      })
      const { writeSecureFile } = await import('../../src/main/secureFile')
      const r = writeSecureFile('C:\\f', 'x')
      expect(r.aclApplied).toBe(false)
      expect(r.aclError).toContain('No mapping')
      expect(mockWriteFileSync).toHaveBeenCalled()
    })

    it('strips shell metacharacters ($me%admin`)', async () => {
      setPlatform('win32')
      process.env.USERNAME = '$me%admin`'
      const { writeSecureFile } = await import('../../src/main/secureFile')
      writeSecureFile('C:\\f', 'x')
      expect(mockExecFileSync.mock.calls[1][1][2]).toBe('meadmin:F')
    })

    it('all-unicode USERNAME becomes empty → no icacls call, not thrown', async () => {
      setPlatform('win32')
      process.env.USERNAME = 'やまだ'
      const { writeSecureFile } = await import('../../src/main/secureFile')
      const r = writeSecureFile('C:\\f', 'x')
      expect(r.aclApplied).toBe(false)
      expect(r.aclError).toContain('USERNAME')
      expect(mockExecFileSync).not.toHaveBeenCalled()
    })

    it('falls back to USER if USERNAME absent (MSYS/Git Bash on Windows)', async () => {
      setPlatform('win32')
      delete process.env.USERNAME
      process.env.USER = 'david'
      const { writeSecureFile } = await import('../../src/main/secureFile')
      writeSecureFile('C:\\f', 'x')
      expect(mockExecFileSync.mock.calls[1][1][2]).toBe('david:F')
    })
  })
})

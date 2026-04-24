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
    mockWriteFileSync.mockClear()
    mockExecFileSync.mockClear()
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
})

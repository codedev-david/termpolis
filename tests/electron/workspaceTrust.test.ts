// Unit tests for workspaceTrust.
//
// Covers the store (trust/revoke/list/isTrusted), persistence, parent-path
// matching, prompt behavior under test env flags, and the malformed-store
// fallback. Dialog interactions are exercised in the IPC integration suite.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'

const { mockShowMessageBox } = vi.hoisted(() => ({
  mockShowMessageBox: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) },
  BrowserWindow: class {},
  dialog: { showMessageBox: mockShowMessageBox },
}))

async function freshModule() {
  vi.resetModules()
  return await import('../../src/main/workspaceTrust')
}

describe('workspaceTrust store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-trust-'))
    mockShowMessageBox.mockReset()
    delete process.env.TERMPOLIS_TEST_TRUST
    // Skip the icacls spawn in writeSecureFile — otherwise tests that write
    // the store multiple times blow past the 5s vitest timeout on Windows.
    process.env.TERMPOLIS_SKIP_ACL = '1'
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    delete process.env.TERMPOLIS_SKIP_ACL
  })

  it('isWorkspaceTrusted returns false for unknown paths', async () => {
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    expect(m.isWorkspaceTrusted(join(dir, 'project-a'))).toBe(false)
  })

  it('trustWorkspace + isWorkspaceTrusted round-trip', async () => {
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    const p = join(dir, 'project-a')
    m.trustWorkspace(p)
    expect(m.isWorkspaceTrusted(p)).toBe(true)
  })

  it('child paths inherit trust from trusted parent', async () => {
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    m.trustWorkspace(dir)
    expect(m.isWorkspaceTrusted(join(dir, 'nested', 'deep'))).toBe(true)
  })

  it('sibling paths do not inherit trust', async () => {
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    m.trustWorkspace(join(dir, 'alpha'))
    expect(m.isWorkspaceTrusted(join(dir, 'alpha-evil'))).toBe(false)
  })

  it('revokeWorkspaceTrust removes trust', async () => {
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    const p = join(dir, 'project-a')
    m.trustWorkspace(p)
    m.revokeWorkspaceTrust(p)
    expect(m.isWorkspaceTrusted(p)).toBe(false)
  })

  it('listTrustedWorkspaces returns all trusted paths', async () => {
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    m.trustWorkspace(join(dir, 'a'))
    m.trustWorkspace(join(dir, 'b'))
    const list = m.listTrustedWorkspaces()
    expect(list).toHaveLength(2)
  })

  it('persists trusted paths to disk', async () => {
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    m.trustWorkspace(join(dir, 'persist-me'))
    const store = readFileSync(join(dir, 'trusted-workspaces.json'), 'utf-8')
    expect(JSON.parse(store).paths).toContain(join(dir, 'persist-me'))
  })

  it('reloads trusted paths from disk on re-init', async () => {
    const p = join(dir, 'persist-me')
    writeFileSync(
      join(dir, 'trusted-workspaces.json'),
      JSON.stringify({ paths: [p] }),
    )
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    expect(m.isWorkspaceTrusted(p)).toBe(true)
  })

  it('treats a corrupt store as empty (does not throw)', async () => {
    writeFileSync(join(dir, 'trusted-workspaces.json'), 'not json{{{')
    const m = await freshModule()
    expect(() => m.initWorkspaceTrust(dir)).not.toThrow()
    expect(m.listTrustedWorkspaces()).toEqual([])
  })

  it('ignores non-string entries in paths array', async () => {
    writeFileSync(
      join(dir, 'trusted-workspaces.json'),
      JSON.stringify({ paths: [null, 42, '', join(dir, 'ok')] }),
    )
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    const list = m.listTrustedWorkspaces()
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('ok')
  })

  it('rejects non-string cwd gracefully', async () => {
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    expect(m.isWorkspaceTrusted('' as any)).toBe(false)
    expect(m.isWorkspaceTrusted(null as any)).toBe(false)
    expect(m.isWorkspaceTrusted(undefined as any)).toBe(false)
    expect(m.isWorkspaceTrusted({} as any)).toBe(false)
  })
})

describe('ensureWorkspaceTrust', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-trust-'))
    mockShowMessageBox.mockReset()
    delete process.env.TERMPOLIS_TEST_TRUST
    process.env.TERMPOLIS_SKIP_ACL = '1'
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    delete process.env.TERMPOLIS_TEST_TRUST
    delete process.env.TERMPOLIS_SKIP_ACL
  })

  it('returns true without prompting if already trusted', async () => {
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    m.trustWorkspace(dir)
    const ok = await m.ensureWorkspaceTrust({ cwd: dir, reason: 'test' })
    expect(ok).toBe(true)
    expect(mockShowMessageBox).not.toHaveBeenCalled()
  })

  it('TERMPOLIS_TEST_TRUST=deny returns false without prompting', async () => {
    process.env.TERMPOLIS_TEST_TRUST = 'deny'
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    const ok = await m.ensureWorkspaceTrust({ cwd: dir, reason: 'test' })
    expect(ok).toBe(false)
    expect(mockShowMessageBox).not.toHaveBeenCalled()
    expect(m.isWorkspaceTrusted(dir)).toBe(false)
  })

  it('TERMPOLIS_TEST_TRUST=allow trusts and returns true without prompting', async () => {
    process.env.TERMPOLIS_TEST_TRUST = 'allow'
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    const ok = await m.ensureWorkspaceTrust({ cwd: dir, reason: 'test' })
    expect(ok).toBe(true)
    expect(mockShowMessageBox).not.toHaveBeenCalled()
    expect(m.isWorkspaceTrusted(dir)).toBe(true)
  })

  it('prompts dialog when untrusted and no test env flag', async () => {
    mockShowMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    const ok = await m.ensureWorkspaceTrust({ cwd: dir, reason: 'run tests' })
    expect(ok).toBe(false)
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1)
  })

  it('dialog response=1 grants trust and persists it', async () => {
    mockShowMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    const ok = await m.ensureWorkspaceTrust({ cwd: dir, reason: 'run tests' })
    expect(ok).toBe(true)
    expect(m.isWorkspaceTrusted(dir)).toBe(true)
  })

  it('dialog cancel (response=0) does NOT grant trust', async () => {
    mockShowMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    await m.ensureWorkspaceTrust({ cwd: dir, reason: 'run tests' })
    expect(m.isWorkspaceTrusted(dir)).toBe(false)
  })

  it('prompt detail includes cwd and reason', async () => {
    mockShowMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const m = await freshModule()
    m.initWorkspaceTrust(dir)
    await m.ensureWorkspaceTrust({ cwd: dir, reason: 'UNIQUE_REASON_xyz' })
    const opts = mockShowMessageBox.mock.calls[0][0]
    expect(opts.detail).toContain(dir)
    expect(opts.detail).toContain('UNIQUE_REASON_xyz')
    expect(opts.buttons).toEqual(['Cancel', 'Trust and continue'])
    expect(opts.defaultId).toBe(0)
    expect(opts.cancelId).toBe(0)
  })
})

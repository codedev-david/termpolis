// Smoke test for scripts/notarize.cjs — proves the CI rethrow path we
// just added actually fails the build when @electron/notarize rejects
// and CI=true. Without this test, a regression could silently re-open
// the old "ship an un-notarized DMG" behavior.
//
// @electron/notarize isn't installed locally (only on release CI), so we
// intercept require() via Module._resolveFilename to return a stub. This
// is the standard CJS trick for mocking an uninstalled peer module.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import Module from 'module'

const mockNotarize = vi.fn()

const STUB_ID = path.resolve('tests/scripts/.notarize-stub.cjs')
const originalResolve = (Module as any)._resolveFilename
;(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === '@electron/notarize') return STUB_ID
  return originalResolve.call(this, request, ...rest)
}
require.cache[STUB_ID] = {
  id: STUB_ID,
  filename: STUB_ID,
  loaded: true,
  exports: { notarize: (...args: any[]) => mockNotarize(...args) },
  children: [],
  paths: [],
} as any

// Minimal electron-builder afterSign context shape
function ctx() {
  return {
    electronPlatformName: 'darwin',
    appOutDir: '/tmp/out',
    packager: { appInfo: { productFilename: 'Termpolis' } },
  }
}

describe('scripts/notarize.cjs', () => {
  let originalCi: string | undefined
  let originalAppleId: string | undefined
  let originalPwd: string | undefined
  let originalTeam: string | undefined
  let notarizing: (context: any) => Promise<void>

  beforeEach(async () => {
    originalCi = process.env.CI
    originalAppleId = process.env.APPLE_ID
    originalPwd = process.env.APPLE_APP_SPECIFIC_PASSWORD
    originalTeam = process.env.APPLE_TEAM_ID
    process.env.APPLE_ID = 'fake@example.com'
    process.env.APPLE_APP_SPECIFIC_PASSWORD = 'fake-app-pw'
    process.env.APPLE_TEAM_ID = 'FAKE123TEAM'
    mockNotarize.mockReset()
    // Force a fresh require each time so the mocked @electron/notarize
    // is wired up from the top of the file.
    delete require.cache[require.resolve(path.resolve('scripts/notarize.cjs'))]
    notarizing = require(path.resolve('scripts/notarize.cjs')).default
  })

  afterEach(() => {
    if (originalCi === undefined) delete process.env.CI
    else process.env.CI = originalCi
    if (originalAppleId === undefined) delete process.env.APPLE_ID
    else process.env.APPLE_ID = originalAppleId
    if (originalPwd === undefined) delete process.env.APPLE_APP_SPECIFIC_PASSWORD
    else process.env.APPLE_APP_SPECIFIC_PASSWORD = originalPwd
    if (originalTeam === undefined) delete process.env.APPLE_TEAM_ID
    else process.env.APPLE_TEAM_ID = originalTeam
  })

  it('skips notarization on non-darwin', async () => {
    await notarizing({ ...ctx(), electronPlatformName: 'win32' })
    expect(mockNotarize).not.toHaveBeenCalled()
  })

  it('skips notarization when env vars are missing', async () => {
    delete process.env.APPLE_ID
    await notarizing(ctx())
    expect(mockNotarize).not.toHaveBeenCalled()
  })

  it('succeeds when @electron/notarize resolves', async () => {
    mockNotarize.mockResolvedValue(undefined)
    process.env.CI = 'true'
    await expect(notarizing(ctx())).resolves.toBeUndefined()
    expect(mockNotarize).toHaveBeenCalledOnce()
    const args = mockNotarize.mock.calls[0][0]
    expect(args.tool).toBe('notarytool')
    expect(args.teamId).toBe('FAKE123TEAM')
  })

  it('soft-fails on dev build (CI unset) when notarize rejects', async () => {
    delete process.env.CI
    mockNotarize.mockRejectedValue(new Error('Apple said no'))
    // Should NOT throw — build continues
    await expect(notarizing(ctx())).resolves.toBeUndefined()
  })

  it('rethrows in CI (CI=true) when notarize rejects', async () => {
    process.env.CI = 'true'
    mockNotarize.mockRejectedValue(new Error('Apple said no'))
    await expect(notarizing(ctx())).rejects.toThrow(/Notarization failed in CI.*Apple said no/)
  })

  it('rethrows in CI (CI=1) when notarize rejects', async () => {
    process.env.CI = '1'
    mockNotarize.mockRejectedValue(new Error('team-id mismatch'))
    await expect(notarizing(ctx())).rejects.toThrow(/Notarization failed in CI/)
  })

  it('CI=false does NOT rethrow', async () => {
    process.env.CI = 'false'
    mockNotarize.mockRejectedValue(new Error('boom'))
    await expect(notarizing(ctx())).resolves.toBeUndefined()
  })
})

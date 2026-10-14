// End-to-end verification for the workspace trust + mcp-token ACL work.
// Launches the real built Electron app and exercises:
//   - workspace:is-trusted / workspace:trust / workspace:list-trusted /
//     workspace:revoke-trust through the preload contextBridge
//   - swarm:run-command trust gate (denied w/o trust, allowed w/ trust)
//   - mcp-token file is written under userData with restricted ACL on win32
//
// Unlike the mocked IPC tests, this one hits the real main process through
// real IPC and verifies observable side effects (file on disk, icacls output).

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { e2eLaunchArgs, dismissOnboarding, quitApp, ensureE2eBuild } from './helpers/launch'
import { lockdownProblems } from '../tests/windowsAcl'

let app: ElectronApplication
let page: Page
let tempRepo: string

test.beforeAll(async () => {
  ensureE2eBuild()
  // TERMPOLIS_TEST_TRUST='deny' makes the dialog auto-deny so we can test
  // the gate without a visible modal. Individual tests override via
  // workspace:trust IPC calls.
  app = await electron.launch({
    args: e2eLaunchArgs('workspace-trust'),
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_TRUST: 'deny' },
  })
  page = await app.firstWindow()
  await dismissOnboarding(page)
  await page.waitForLoadState('domcontentloaded')
  // Main process needs a beat to finish initWorkspaceTrust + MCP server bind
  await page.waitForTimeout(2500)
  tempRepo = mkdtempSync(path.join(tmpdir(), 'tp-e2e-trust-'))
})

test.afterAll(async () => {
  try { rmSync(tempRepo, { recursive: true, force: true }) } catch {}
  await quitApp(app)
})

// Helper to invoke IPC through the preload bridge the renderer actually uses.
async function invoke(method: string, ...args: any[]) {
  return await page.evaluate(
    ([m, a]) => (window as any).termpolis[m as string](...(a as any[])),
    [method, args] as [string, any[]],
  )
}

test('workspace:is-trusted returns false for a fresh folder', async () => {
  const r = await invoke('workspaceIsTrusted', tempRepo)
  expect(r.success).toBe(true)
  expect(r.data).toBe(false)
})

test('workspace:trust + workspace:is-trusted round-trip', async () => {
  const trustResp = await invoke('workspaceTrust', tempRepo)
  expect(trustResp.success).toBe(true)
  const isTrusted = await invoke('workspaceIsTrusted', tempRepo)
  expect(isTrusted.data).toBe(true)
})

test('workspace:list-trusted includes the trusted folder', async () => {
  const list = await invoke('workspaceListTrusted')
  expect(list.success).toBe(true)
  expect(list.data.some((p: string) => p.toLowerCase().includes(path.basename(tempRepo).toLowerCase()))).toBe(true)
})

test('swarm:run-command is blocked for an untrusted folder', async () => {
  const untrusted = mkdtempSync(path.join(tmpdir(), 'tp-e2e-untrusted-'))
  try {
    const r = await invoke('swarmRunCommand', untrusted, 'npm test')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not trusted/i)
  } finally {
    try { rmSync(untrusted, { recursive: true, force: true }) } catch {}
  }
})

test('workspace:revoke-trust removes a trusted folder', async () => {
  await invoke('workspaceTrust', tempRepo)
  const before = await invoke('workspaceIsTrusted', tempRepo)
  expect(before.data).toBe(true)
  await invoke('workspaceRevokeTrust', tempRepo)
  const after = await invoke('workspaceIsTrusted', tempRepo)
  expect(after.data).toBe(false)
})

test('mcp-token file is written under userData with restricted ACL (win32)', async () => {
  // app.getPath('userData') in main — grab it through IPC? It's not exposed,
  // so we read it from a known main-side handler. Instead we rely on the
  // token file being written to the standard Electron userData location:
  //   Windows: %APPDATA%\<productName>\mcp-token
  //   macOS:   ~/Library/Application Support/<productName>/mcp-token
  //   Linux:   ~/.config/<productName>/mcp-token
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  const tokenPath = path.join(userData, 'mcp-token')
  expect(existsSync(tokenPath), `mcp-token should exist at ${tokenPath}`).toBe(true)

  if (process.platform === 'win32') {
    // The lockdown ran (the DACL is protected), nothing is inherited, no broad audience, and the
    // user holds full control — matched against the raw USERNAME, which the app grants exactly as
    // Windows has it (spaces, accents and all).
    //
    // The protected flag is the check with teeth on a CI runner: its userData (a mkdtemp folder)
    // passes nothing inheritable, so mcp-token is BORN with explicit ACEs only, and would pass all
    // the others with no lockdown at all. NT AUTHORITY\SYSTEM and BUILTIN\Administrators MAY appear,
    // as explicit ACEs from the creating token's default DACL: the app's one icacls call leaves
    // them alone by design. lockdownProblems (tests/windowsAcl.ts) says why;
    // tests/electron/secureFile.integration.test.ts holds the same line and reproduces that
    // folder on any machine.
    expect(lockdownProblems(tokenPath, process.env.USERNAME || '')).toEqual([])
  }
})

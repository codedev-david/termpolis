// @vitest-environment node
//
// Where Check, Sign in and the agy sign-in look for the agent CLIs: the PATH a terminal would give them
// (agentPaths.ts getExtendedPath), not the minimal one a GUI launch hands Electron's main (macOS Finder or
// Dock, Linux under nvm, volta or ~/.local/bin). Without it the CLI "isn't installed where Termpolis can
// find it", a dead end. A test that injects an environment is given exactly that one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../src/main/agentPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agentPaths')>()),
  getExtendedPath: () => '/ext/bin:/usr/bin:/bin',
}))

import { _resetTerminalAccountsForTest, registerAccountsIpc } from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { AccountIdentity, AddAccountResult } from '../../src/shared/agentAccounts'
import { createSandbox, writeJson } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'
import { mkdirSync } from 'fs'
import { join } from 'path'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let seenEnv: Array<Readonly<Record<string, string | undefined>> | undefined>
let signInEnvs: Array<Record<string, string>>

const IDENTITY: AccountIdentity = { email: 'b@example.test', signedIn: true, checkedAt: 1, source: 'auth-status', plan: 'max' }

function register(over: Partial<AccountsIpcDeps> = {}): void {
  handlers = new Map()
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, {
    paths: () => sb.paths,
    runtime: () => ({ ...sb.rt, hookShell: 'sh' }),
    integrationConnected: () => false,
    pickFolder: async () => null,
    send: () => undefined,
    checkCwd: () => sb.root,
    now: () => 1_000_000,
    signedInNow: async (_agent, _profile, d) => { seenEnv.push(d.env); return { identity: IDENTITY } },
    signInCli: (_agent, _args, env) => { signInEnvs.push(env); throw new Error('stop here: the environment is all this test reads') },
    setInterval: () => 1,
    clearInterval: () => undefined,
    ...over,
  } as AccountsIpcDeps)
}

async function ok<T = any>(channel: string, input?: unknown): Promise<T> {
  const r = (await handlers.get(channel)!(null, input)) as { success: boolean; data?: T; error?: string }
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`)
  return r.data as T
}

async function aSecondAccount(): Promise<string> {
  mkdirSync(join(sb.paths.claudeDir, 'projects'), { recursive: true })
  writeJson(sb.paths.claudeJson, { oauthAccount: { emailAddress: 'a@example.test' } })
  return (await ok<AddAccountResult>(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false })).account.id
}

beforeEach(() => {
  sb = createSandbox()
  seenEnv = []
  signInEnvs = []
  _resetTerminalAccountsForTest()
})

afterEach(() => {
  _resetTerminalAccountsForTest()
  sb.dispose()
})

describe('the PATH the agent CLIs are looked for on', () => {
  it('is the extended one when main is given no environment of its own (a GUI launch)', async () => {
    register()
    const id = await aSecondAccount()
    await ok(ACCOUNTS_IPC.check, { id })
    expect(seenEnv.length).toBeGreaterThan(0)
    expect(seenEnv[seenEnv.length - 1]?.PATH).toBe('/ext/bin:/usr/bin:/bin')
  })

  it('is the very one it was given when a test injects an environment', async () => {
    register({ env: { PATH: '/only/this' } })
    const id = await aSecondAccount()
    await ok(ACCOUNTS_IPC.check, { id })
    expect(seenEnv[seenEnv.length - 1]?.PATH).toBe('/only/this')
  })

  it('keeps the rest of main\'s environment beside it', async () => {
    register()
    const id = await aSecondAccount()
    await ok(ACCOUNTS_IPC.check, { id })
    const env = seenEnv[seenEnv.length - 1] as Record<string, string | undefined>
    // Whatever main was started with is still there; only the PATH is replaced.
    const own = Object.keys(process.env).find((k) => k.toLowerCase() !== 'path' && process.env[k] !== undefined)
    if (own) expect(env[own]).toBe(process.env[own])
  })

  it('reaches the hidden sign-in session\'s environment too, which is what node shims such as Codex need to find node', async () => {
    register()
    const id = await aSecondAccount()
    await handlers.get(ACCOUNTS_IPC.signInStart)!(null, { accountId: id, method: 'claudeai' })
    expect(signInEnvs.length).toBe(1)
    expect(signInEnvs[0].PATH).toBe('/ext/bin:/usr/bin:/bin')
  })
})

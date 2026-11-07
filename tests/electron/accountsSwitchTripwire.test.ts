// @vitest-environment node
//
// The live tripwire (D11) over the flows accountsCredentialTripwire.test.ts does not run: accounts:switch with a
// transcript carried into an unshared profile, accounts:limit-look and accounts:launch-line. They run over profiles
// that hold sign-in decoys (at the profile roots, and INSIDE the carried conversation's subagent folder); no fs call
// may name a sign-in path, and every decoy must be as it was, byte for byte and in its mtime.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createRequire, syncBuiltinESMExports } from 'module'
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { _resetTerminalAccountsForTest, noteAgentStart, noteTerminalAccount, noteTerminalSession, registerAccountsIpc } from '../../src/main/accountsIpc'
import type { AccountsIpcDeps } from '../../src/main/accountsIpc'
import { _resetSwitchLocksForTest } from '../../src/main/accountSwitch'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import type { AddAccountResult } from '../../src/shared/agentAccounts'
import { loadAccounts } from '../../src/main/agentAccounts'
import { createSandbox, writeJson } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'
import { FakeTerminal, ID } from './_switchTerminal'

const nodeRequire = createRequire(import.meta.url)
const realFs = nodeRequire('fs') as Record<string, unknown> & typeof import('fs')
const SIGN_IN = ['.credentials.json', 'auth.json', 'oauth_creds.json', 'mcp-oauth-tokens.json', '.git-credentials']
const isSignIn = (p: string): boolean => {
  const parts = resolve(p).split(/[\\/]+/).map((s) => s.toLowerCase())
  return SIGN_IN.includes(parts[parts.length - 1]) || parts.includes('.ssh') || parts.includes('.aws')
}

let recording = false
const touched: Array<{ fn: string; path: string }> = []
const saved = new Map<object, Map<string, unknown>>()
const TWO = new Set(['renameSync', 'rename', 'copyFileSync', 'copyFile', 'symlinkSync', 'symlink'])
function wrap(target: Record<string, unknown>, prefix: string): void {
  const keep = new Map<string, unknown>()
  for (const [name, fn] of Object.entries(target)) {
    if (typeof fn !== 'function' || !/^[a-z]/.test(name)) continue
    keep.set(name, fn)
    const orig = fn as (...a: unknown[]) => unknown
    const w = function (this: unknown, ...args: unknown[]): unknown {
      if (recording) for (const a of args.slice(0, TWO.has(name) ? 2 : 1)) if (typeof a === 'string') touched.push({ fn: prefix + name, path: a })
      return orig.apply(this, args)
    }
    for (const [k, v] of Object.entries(orig as unknown as Record<string, unknown>)) {
      ;(w as unknown as Record<string, unknown>)[k] = typeof v === 'function'
        ? function (this: unknown, ...a: unknown[]) {
          if (recording && typeof a[0] === 'string') touched.push({ fn: `${prefix}${name}.${k}`, path: a[0] as string })
          return (v as (...x: unknown[]) => unknown).apply(this, a)
        }
        : v
    }
    target[name] = w
  }
  saved.set(target, keep)
}
let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>
let term: FakeTerminal
beforeAll(() => { wrap(realFs, 'fs.'); wrap(realFs.promises as unknown as Record<string, unknown>, 'fs.promises.'); syncBuiltinESMExports() })
afterAll(() => { for (const [t, m] of saved) for (const [n, f] of m) (t as Record<string, unknown>)[n] = f; saved.clear(); syncBuiltinESMExports() })
beforeEach(() => { sb = createSandbox(); _resetTerminalAccountsForTest(); _resetSwitchLocksForTest(); touched.length = 0 })
afterEach(() => { recording = false; _resetTerminalAccountsForTest(); sb.dispose() })

function register(): void {
  handlers = new Map()
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, {
    paths: () => sb.paths, runtime: () => ({ ...sb.rt, hookShell: 'sh' }), integrationConnected: () => true, pickFolder: async () => null,
    send: () => undefined, checkCwd: () => sb.root, env: {}, now: () => 42,
    switchIO: {
      output: (id) => term.io().output(id), outputFrom: (id, from) => term.io().outputFrom(id, from), end: (id) => term.io().end(id),
      size: () => ({ cols: 80, rows: 24 }), write: (id, data) => term.io().write(id, data), sleep: (ms) => term.io().sleep(ms), now: () => term.clock,
    },
  } as AccountsIpcDeps)
}
async function call(channel: string, input?: unknown): Promise<{ success: boolean; data?: any; error?: string }> {
  return (await handlers.get(channel)!(null, input)) as never
}

describe('the live tripwire (D11) over a switch with a carry, the limit look and the launch line', () => {
  it('sees a sign-in file opened while it records, so a quiet run means something', () => {
    const decoy = join(sb.paths.claudeDir, '.credentials.json')
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeFileSync(decoy, '{}')
    touched.length = 0
    recording = true
    try { readFileSync(decoy) } finally { recording = false }
    expect(touched.filter((t) => isSignIn(t.path)).map((t) => t.fn)).toContain('fs.readFileSync')
  })

  it('touches no sign-in path, leaves every decoy as it was', async () => {
    term = new FakeTerminal({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint' })
    register()
    mkdirSync(join(sb.paths.claudeDir, 'projects', 'C--repo', ID), { recursive: true })
    writeJson(sb.paths.claudeJson, { oauthAccount: { emailAddress: 'a@example.test' }, primaryApiKey: 'sk-ant-' + 'a'.repeat(40) })
    writeFileSync(join(sb.paths.claudeDir, 'projects', 'C--repo', `${ID}.jsonl`), '{}\n')
    const decoys = [
      join(sb.paths.claudeDir, '.credentials.json'),
      join(sb.paths.claudeDir, 'projects', 'C--repo', ID, '.credentials.json'),
      join(sb.paths.claudeDir, 'projects', 'C--repo', ID, 'auth.json'),
      join(sb.paths.claudeDir, 'projects', 'C--repo', ID, 'sub.jsonl'),
    ]
    for (const d of decoys) writeFileSync(d, 'a'.repeat(64))
    const before = new Map(decoys.map((d) => [d, { text: readFileSync(d, 'utf-8'), m: statSync(d).mtimeMs }]))
    const r = await call(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false, share: [] })
    expect(r.success).toBe(true)
    const bDir = (r.data as AddAccountResult).account.profile as string
    writeFileSync(join(bDir, '.credentials.json'), 'a'.repeat(64))
    const doc = loadAccounts(sb.paths.userData)
    if (!doc.ok) throw new Error(doc.error)
    const main = doc.doc.file.accounts.find((a) => a.agent === 'claude' && a.profile === null)!.id
    noteTerminalAccount('t1', main)
    noteTerminalSession('t1', ID)
    noteAgentStart('t1', { at: term.launchedAt, commands: [term.launchLine()] })
    recording = true
    await call(ACCOUNTS_IPC.list)
    const sw = await call(ACCOUNTS_IPC.switchAccount, { terminalId: 't1', targetId: (r.data as AddAccountResult).account.id, shellType: 'gitbash' })
    await call(ACCOUNTS_IPC.limitLook, { terminalId: 't1' })
    await call(ACCOUNTS_IPC.launchLine, { terminalId: 't2', agent: 'claude', shellType: 'gitbash', command: 'claude', accountId: main })
    recording = false
    const hits = touched.filter((t) => isSignIn(t.path)).map((t) => `${t.fn} ${t.path}`)
    expect(touched.length).toBeGreaterThan(30)
    expect(hits).toEqual([])
    for (const [d, was] of before) {
      expect(readFileSync(d, 'utf-8')).toBe(was.text)
      expect(statSync(d).mtimeMs).toBe(was.m)
    }
    // the carried conversation reached the unshared profile
    expect(realFs.existsSync(join(bDir, 'projects', 'C--repo', `${ID}.jsonl`))).toBe(true)
    // ...and no sign-in decoy was copied beside it
    expect(realFs.existsSync(join(bDir, 'projects', 'C--repo', ID, '.credentials.json'))).toBe(false)
    expect(realFs.existsSync(join(bDir, 'projects', 'C--repo', ID, 'auth.json'))).toBe(false)
  })
})

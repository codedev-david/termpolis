// @vitest-environment node
//
// Learning reads every registered profile's conversations (§10, item 10): the default folder and
// each account's own projects/ (Claude Code) or sessions/ (Codex), linked into the default or not,
// each read once. src/main/conversationIngest.ts (the roots, the walk), src/main/aiSessions.ts (Past
// AI Sessions) and src/main/accountsIpc.ts (the registry's profiles). All in a scratch home under
// TERMPOLIS_TEST_AGENT_HOME; the links are junctions on Windows, removed as links.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, promises as fsPromises, utimesSync, writeFileSync } from 'fs'
import { join, parse } from 'path'
import {
  discoverTranscriptFiles, isInTranscriptRoot, newestTranscriptFiles, setExtraTranscriptRoots, transcriptRoots, walkRoots,
} from '../../src/main/conversationIngest'
import { listAISessions } from '../../src/main/aiSessions'
import { _resetTerminalAccountsForTest, profileTranscriptRoots, registerAccountsIpc } from '../../src/main/accountsIpc'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'
import { createSandbox } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

let sb: Sandbox
let handlers: Map<string, (e: unknown, input?: unknown) => unknown>

const line = (o: unknown): string => JSON.stringify(o) + '\n'
/** A Claude Code transcript with a cwd and a first prompt, as listAISessions reads one. */
function transcript(dir: string, id: string, ask: string, mtime?: Date): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, line({ type: 'user', message: { role: 'user', content: ask }, cwd: '/repo', sessionId: id }))
  if (mtime) utimesSync(file, mtime, mtime)
  return file
}

function register(): void {
  handlers = new Map()
  registerAccountsIpc({ handle: (ch, fn) => { handlers.set(ch, fn) } }, {
    paths: () => sb.paths, runtime: () => ({ ...sb.rt, hookShell: 'sh' }), integrationConnected: () => true,
    pickFolder: async () => null, send: () => {}, checkCwd: () => sb.root, env: {}, now: () => 1,
  })
}
async function ok<T = any>(channel: string, input?: unknown): Promise<T> {
  const r = (await handlers.get(channel)!(null, input)) as { success: boolean; data?: T; error?: string }
  if (!r.success) throw new Error(`${channel} failed: ${r.error}`)
  return r.data as T
}

beforeEach(() => {
  sb = createSandbox()
  _resetTerminalAccountsForTest()
  setExtraTranscriptRoots(null)
})
afterEach(() => {
  setExtraTranscriptRoots(null)
  _resetTerminalAccountsForTest()
  sb.dispose()
})

const home = () => process.env.TERMPOLIS_TEST_AGENT_HOME as string

describe('transcriptRoots and isInTranscriptRoot', () => {
  it("reads the default folders under the test run's agent home, never the developer's own", () => {
    expect(transcriptRoots('claude')).toEqual([join(home(), '.claude', 'projects')])
    expect(transcriptRoots('codex')).toEqual([join(home(), '.codex', 'sessions')])
    expect(transcriptRoots('gemini')).toEqual([join(home(), '.gemini', 'tmp')])
    expect(transcriptRoots('other' as never)).toEqual([])
  })

  it('adds every profile folder the provider names, and keeps the default when the provider fails', () => {
    setExtraTranscriptRoots((s) => (s === 'claude' ? ['/p/b/projects', ''] : []))
    expect(transcriptRoots('claude')).toEqual([join(home(), '.claude', 'projects'), '/p/b/projects'])
    expect(transcriptRoots('codex')).toEqual([join(home(), '.codex', 'sessions')])
    setExtraTranscriptRoots(() => { throw new Error('registry gone') })
    expect(transcriptRoots('claude')).toEqual([join(home(), '.claude', 'projects')])
  })

  it('takes a file inside any of the folders, and nothing outside, a sibling only named like one, or a folder itself', () => {
    const projects = join(home(), '.claude', 'projects')
    const other = join(sb.root, 'b', 'projects')
    setExtraTranscriptRoots((src) => (src === 'claude' ? [other] : []))
    expect(isInTranscriptRoot(join(projects, 'p', 's.jsonl'), 'claude')).toBe(true)
    expect(isInTranscriptRoot(join(other, 'p', 's.jsonl'), 'claude')).toBe(true)
    expect(isInTranscriptRoot(join(projects, '..', 'settings.json'), 'claude')).toBe(false)
    expect(isInTranscriptRoot(join(home(), '.claude', 'projects-evil', 'x.jsonl'), 'claude')).toBe(false)
    expect(isInTranscriptRoot(projects, 'claude')).toBe(false)
    expect(isInTranscriptRoot(join(sb.root, 'elsewhere', 'x.jsonl'), 'claude')).toBe(false)
    expect(isInTranscriptRoot(join(other, 'p', 's.jsonl'), 'codex')).toBe(false)
  })
})

describe('walkRoots: each folder read once', () => {
  it('reads a profile folder linked to the default one through the default only', async () => {
    const def = join(home(), '.claude', 'projects')
    mkdirSync(def, { recursive: true })
    const linked = join(sb.root, 'b', 'projects')
    sb.link(def, linked)
    const own = join(sb.root, 'c', 'projects')
    mkdirSync(own, { recursive: true })
    expect(await walkRoots([def, linked, own])).toEqual([def, own])
    // The link first: still one, the link's spelling.
    expect(await walkRoots([linked, def])).toEqual([linked])
  })

  it('walks a folder inside another as part of it, and leaves out one that is not there', async () => {
    const outer = join(sb.root, 'outer')
    const inner = join(outer, 'proj')
    mkdirSync(inner, { recursive: true })
    expect(await walkRoots([inner, outer, join(sb.root, 'missing')])).toEqual([outer])
    // A sibling whose name only starts the same is its own folder.
    const sibling = join(sb.root, 'outer-2')
    mkdirSync(sibling)
    expect(await walkRoots([outer, sibling])).toEqual([outer, sibling])
  })

  it('walks the whole drive (a root ending in its separator) as the one folder it is', async () => {
    const drive = parse(sb.root).root
    expect(await walkRoots([drive, sb.root])).toEqual([drive])
  })

  it('takes a folder spelled in another case on Windows as the same one, by the case the disk has', async () => {
    const dir = join(sb.root, 'CaseDir')
    mkdirSync(dir)
    const other = join(sb.root, 'casedir')
    const walked = await walkRoots([dir, other])
    expect(walked[0]).toBe(dir)
    // Windows' realpath answers in the disk's case; elsewhere a folder of another case is another
    // folder (Linux), or may keep the case it was given (macOS).
    if (process.platform === 'win32') expect(walked).toEqual([dir])
  })
})

describe('discoverTranscriptFiles with no root given', () => {
  it("reads the default folder and each profile's own, a linked one once", async () => {
    const def = join(home(), '.claude', 'projects')
    const a = transcript(join(def, 'C--repo'), 'a1', 'on the default')
    const ownRoot = join(sb.root, 'c', 'projects')
    const c = transcript(join(ownRoot, 'C--repo'), 'c1', 'on c')
    const linked = join(sb.root, 'b', 'projects')
    sb.link(def, linked)
    setExtraTranscriptRoots((s) => (s === 'claude' ? [linked, ownRoot] : []))
    expect((await discoverTranscriptFiles('claude')).sort()).toEqual([a, c].sort())
    // An explicit root is that root alone, as before; an empty one is none.
    expect(await discoverTranscriptFiles('claude', ownRoot)).toEqual([c])
    expect(await discoverTranscriptFiles('claude', '')).toEqual([])
    // The newest files, across them.
    expect(await newestTranscriptFiles('claude', 5)).toHaveLength(2)
  })

  it("reads each Codex home's sessions/ too", async () => {
    const def = join(home(), '.codex', 'sessions', '2026', '10', '23')
    mkdirSync(def, { recursive: true })
    writeFileSync(join(def, 'rollout-a.jsonl'), '{}\n')
    const other = join(sb.root, 'cx', 'sessions', '2026', '10', '23')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'rollout-b.jsonl'), '{}\n')
    setExtraTranscriptRoots((s) => (s === 'codex' ? [join(sb.root, 'cx', 'sessions')] : []))
    expect((await discoverTranscriptFiles('codex')).map((f) => f.split(/[\\/]/).pop()).sort()).toEqual(['rollout-a.jsonl', 'rollout-b.jsonl'])
  })
})

describe('listAISessions with no root given (Past AI Sessions)', () => {
  it("lists every account's sessions, a linked folder once, and a carried conversation once, its newest copy", async () => {
    const def = join(home(), '.claude', 'projects')
    transcript(join(def, 'C--repo'), 'a1', 'on the default', new Date(2026, 9, 20))
    transcript(join(def, 'C--repo'), 'shared', 'the older copy', new Date(2026, 9, 21))
    const own = join(sb.root, 'c', 'projects')
    transcript(join(own, 'C--repo'), 'c1', 'on c', new Date(2026, 9, 19))
    transcript(join(own, 'C--repo'), 'shared', 'the newer copy', new Date(2026, 9, 22))
    const linked = join(sb.root, 'b', 'projects')
    sb.link(def, linked)
    setExtraTranscriptRoots(() => [linked, own])
    const sessions = await listAISessions()
    expect(sessions.map((s) => [s.id, s.firstUserMessage])).toEqual([['shared', 'the newer copy'], ['a1', 'on the default'], ['c1', 'on c']])
  })

  it('never lists the folder a link to the default one points at twice', async () => {
    const def = join(home(), '.claude', 'projects')
    transcript(join(def, 'C--repo'), 'a1', 'on the default')
    const linked = join(sb.root, 'b', 'projects')
    sb.link(def, linked)
    setExtraTranscriptRoots(() => [linked])
    const readdir = vi.spyOn(fsPromises, 'readdir')
    try {
      expect((await listAISessions()).map((s) => s.id)).toEqual(['a1'])
      expect(readdir.mock.calls.map((c) => String(c[0]))).not.toContain(linked)
    } finally {
      readdir.mockRestore()
    }
  })

  it('lists nothing from folders that are not there', async () => {
    setExtraTranscriptRoots(() => [join(sb.root, 'missing')])
    expect(await listAISessions()).toEqual([])
  })
})

describe("profileTranscriptRoots: the registry's profiles (accountsIpc.ts)", () => {
  it('names nothing before the registry is wired', async () => {
    vi.resetModules()
    const fresh = await import('../../src/main/accountsIpc')
    expect(fresh.profileTranscriptRoots('claude')).toEqual([])
  })

  it("names each Claude Code and Codex account's own folder, never the default profile's, and wires itself in", async () => {
    register()
    mkdirSync(join(sb.paths.claudeDir, 'projects'), { recursive: true })
    mkdirSync(sb.paths.codexHome, { recursive: true })
    const b = await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false, share: [] })
    const cx = await ok(ACCOUNTS_IPC.add, { agent: 'codex', label: 'cx', folder: 'new', copy: false, share: [] })
    await ok(ACCOUNTS_IPC.add, { agent: 'agy', label: 'g', email: 'g@example.test' })
    expect(profileTranscriptRoots('claude')).toEqual([join(b.account.profile, 'projects')])
    expect(profileTranscriptRoots('codex')).toEqual([join(cx.account.profile, 'sessions')])
    expect(profileTranscriptRoots('gemini')).toEqual([])
    expect(transcriptRoots('claude')).toContain(join(b.account.profile, 'projects'))
  })

  it('names none for a profile whose folder is gone, or while the registry is unreadable', async () => {
    register()
    mkdirSync(join(sb.paths.claudeDir, 'projects'), { recursive: true })
    const b = await ok(ACCOUNTS_IPC.add, { agent: 'claude', label: 'b', folder: 'new', copy: false, share: [] })
    const { rmSync } = await import('fs')
    rmSync(b.account.profile, { recursive: true, force: true })
    expect(profileTranscriptRoots('claude')).toEqual([])
    writeFileSync(join(sb.paths.userData, 'agent-accounts.json'), '{ not json')
    expect(profileTranscriptRoots('claude')).toEqual([])
  })
})

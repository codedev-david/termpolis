// Error-path hardening for the three main-process modules that turn agent transcripts into
// memory and expose that memory over MCP:
//
//   • src/main/conversationIngest.ts — the claude/codex/gemini transcript parsers + disk discovery
//   • src/main/mcpServer.ts          — JSON-RPC tool dispatch, the audit log, port binding
//   • src/main/agentMcpRegistry.ts   — per-agent config-file registration
//
// The happy paths are already covered elsewhere. Everything here drives the arms those suites
// never reach — malformed JSONL, a transcript with no dialogue, a stat that fails mid-scan, a
// config file that cannot be written, a tool that throws, an over-sized audit log, a
// non-EADDRINUSE bind failure. Those arms exist because the MAIN PROCESS must survive them: a
// throw in any of them takes the whole app down, and a silently-swallowed one corrupts memory.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { join } from 'path'
import * as http from 'http'
import * as net from 'net'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

// --- fs: real behaviour by default, with narrowly-scoped injectable failures --------------
// A rule only fires for a path containing `match`, so nothing else in the process (vitest's
// own source-map reads, the temp-dir scaffolding) is affected. This is how we reach the
// `catch` arms that a real disk would only produce on a full/locked/vanishing file.
const fsCtl = vi.hoisted(() => ({
  rules: [] as Array<{ op: 'write' | 'append' | 'read' | 'stat' | 'stream'; match: string; err: unknown }>,
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const hit = (op: string, p: unknown): { err: unknown } | undefined =>
    fsCtl.rules.find((r) => r.op === op && String(p).includes(r.match))

  const writeFileSync = (p: any, ...rest: any[]): void => {
    const r = hit('write', p)
    if (r) throw r.err
    return (actual.writeFileSync as any)(p, ...rest)
  }
  const appendFileSync = (p: any, ...rest: any[]): void => {
    const r = hit('append', p)
    if (r) throw r.err
    return (actual.appendFileSync as any)(p, ...rest)
  }
  const readFileSync = (p: any, ...rest: any[]): any => {
    const r = hit('read', p)
    if (r) throw r.err
    return (actual.readFileSync as any)(p, ...rest)
  }
  const createWriteStream = (p: any, ...rest: any[]): any => {
    const r = hit('stream', p)
    if (r) throw r.err
    return (actual.createWriteStream as any)(p, ...rest)
  }
  const promises = {
    ...actual.promises,
    stat: (p: any, ...rest: any[]): any => {
      const r = hit('stat', p)
      if (r) return Promise.reject(r.err)
      return (actual.promises.stat as any)(p, ...rest)
    },
  }
  const patched = { ...actual, writeFileSync, appendFileSync, readFileSync, createWriteStream, promises }
  return { ...patched, default: patched }
})

// --- memoryAudit: mcpServer's audit calls are ASSERTED, not persisted --------------------
// redactPreview is stubbed to a visible marker so we can prove exactly which string mcpServer
// fed it (that string is produced by the `args.query ?? args.id ?? ''` coalescing chains).
const audit = vi.hoisted(() => ({
  auditMemory: vi.fn(),
  redactPreview: vi.fn((s: string) => `RP:${s}`),
  readMemoryAudit: vi.fn((limit: number) => [{ event: 'recall', limit }]),
  memoryAuditSummary: vi.fn(() => ({ recall: 2, write: 1 })),
}))
vi.mock('../../src/main/memoryAudit', () => audit)

import {
  parseClaudeTranscript,
  parseCodexRollout,
  parseGeminiSession,
  chunkTurns,
  ingestConversations,
  discoverTranscriptFiles,
  findLatestTranscriptFile,
  type IngestTurn,
  type IngestDeps,
} from '../../src/main/conversationIngest'
import {
  registerInClaudeSettings,
  registerInGlobalMcp,
  registerInCodex,
  registerInGemini,
  resolveNodeCommand,
} from '../../src/main/agentMcpRegistry'
import {
  executeTool,
  initAuditLog,
  startMcpServer,
  awaitMcpPortBound,
  getMcpAuthToken,
  resetRateLimits,
  _resetPortStateForTest,
} from '../../src/main/mcpServer'

// The un-mocked fs — every temp file/dir in this suite is built with it, so an injected
// failure rule can never sabotage the scaffolding that sets a test up.
const realFs = await vi.importActual<typeof import('fs')>('fs')

afterEach(() => {
  fsCtl.rules.length = 0
})

// =========================================================================================
// conversationIngest — parsers
// =========================================================================================

describe('parseClaudeTranscript — malformed lines and non-dialogue turns', () => {
  it('drops JSONL lines that parse to a non-object (null / number / string / bool)', () => {
    const turns = parseClaudeTranscript(
      ['null', '42', '"just a string"', 'true', '  ', '{oops', '{"type":"user","message":{"role":"user","content":"real turn"}}'].join('\n'),
    )
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('real turn')
  })

  it('leaves ts undefined for an unparseable or non-string timestamp, but KEEPS the turn', () => {
    const turns = parseClaudeTranscript(
      '{"type":"user","timestamp":"not-a-real-date","message":{"role":"user","content":"bad ts"}}\n' +
        '{"type":"user","timestamp":1712345678,"message":{"role":"user","content":"numeric ts"}}',
    )
    expect(turns.map((t) => t.text)).toEqual(['bad ts', 'numeric ts'])
    expect(turns[0].ts).toBeUndefined() // Date.parse -> NaN
    expect(turns[1].ts).toBeUndefined() // not a string at all
  })

  it('accepts an assistant turn whose content is a plain string (not a block array)', () => {
    const turns = parseClaudeTranscript('{"type":"assistant","message":{"role":"assistant","content":"  plain string answer  "}}')
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ role: 'assistant', text: 'plain string answer', source: 'claude' })
  })

  it('drops an assistant turn whose content is neither string nor array', () => {
    expect(parseClaudeTranscript('{"type":"assistant","message":{"role":"assistant","content":42}}')).toEqual([])
    expect(parseClaudeTranscript('{"type":"assistant","message":{"role":"assistant","content":{"type":"text"}}}')).toEqual([])
    expect(parseClaudeTranscript('{"type":"assistant","message":{"role":"assistant","content":null}}')).toEqual([])
  })

  it('ignores text blocks whose .text is not a string, keeping the rest of the turn', () => {
    const turns = parseClaudeTranscript(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":123},null,"raw",{"type":"text","text":"kept"}]}}',
    )
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('kept')
  })

  it('drops an assistant turn that carries ONLY tool_use / thinking blocks (no dialogue to embed)', () => {
    expect(
      parseClaudeTranscript(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Read","input":{}},{"type":"thinking","thinking":"x"}]}}',
      ),
    ).toEqual([])
  })

  it('drops a type:user entry whose message.role is NOT user, but keeps one with role omitted', () => {
    const turns = parseClaudeTranscript(
      '{"type":"user","message":{"role":"system","content":"injected system prompt"}}\n' +
        '{"type":"user","message":{"content":"role omitted - still a user turn"}}',
    )
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('role omitted - still a user turn')
  })

  it('ignores an entry whose type is neither user nor assistant even when it carries a message', () => {
    expect(parseClaudeTranscript('{"type":"summary","message":{"role":"user","content":"summary text"}}')).toEqual([])
  })

  it('drops an entry with no message object at all', () => {
    expect(parseClaudeTranscript('{"type":"user","message":"a string, not an object"}\n{"type":"assistant"}')).toEqual([])
  })

  it('F32: re-tags cwd per turn as the session moves between repos; a blank cwd keeps the previous one', () => {
    const turns = parseClaudeTranscript(
      '{"type":"user","cwd":"/repo/a","message":{"role":"user","content":"in A"}}\n' +
        '{"type":"user","cwd":"","message":{"role":"user","content":"blank cwd keeps A"}}\n' +
        '{"type":"user","cwd":"/repo/b","message":{"role":"user","content":"in B"}}',
    )
    expect(turns.map((t) => t.cwd)).toEqual(['/repo/a', '/repo/a', '/repo/b'])
  })
})

describe('parseCodexRollout — malformed session_meta and empty messages', () => {
  it('tolerates session_meta with no payload, and with a non-string id/cwd', () => {
    const turns = parseCodexRollout(
      [
        '{"type":"session_meta"}',
        '{"type":"session_meta","payload":{"id":42,"cwd":null}}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":"plain string content"}}',
      ].join('\n'),
    )
    expect(turns).toHaveLength(1)
    expect(turns[0].sessionId).toBeUndefined()
    expect(turns[0].cwd).toBeUndefined()
    expect(turns[0].text).toBe('plain string content')
  })

  it('drops a message whose content yields no text (empty array / imagey blocks / non-array)', () => {
    const turns = parseCodexRollout(
      [
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[]}}',
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_image"},null,7]}}',
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":99}}',
        '{"type":"response_item"}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":"kept"}}',
      ].join('\n'),
    )
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('kept')
  })

  it('keeps a first user turn that is NOT an <environment_context> preamble', () => {
    const turns = parseCodexRollout(
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"first real ask"}]}}',
    )
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ role: 'user', text: 'first real ask', source: 'codex' })
  })

  it('strips the synthetic preamble ONCE — a later <environment_context> turn is real content and survives', () => {
    const turns = parseCodexRollout(
      [
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"<environment_context>cwd=/a</environment_context>"}]}}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"<environment_context> pasted later, kept</environment_context>"}]}}',
      ].join('\n'),
    )
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toContain('pasted later, kept')
  })
})

describe('parseGeminiSession — content shapes and cwd recovery (F20)', () => {
  const wrap = (messages: unknown[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ sessionId: 'g1', messages, ...extra })

  it('joins an array of plain strings and ignores blocks with no string .text', () => {
    const turns = parseGeminiSession(
      wrap([
        { type: 'user', content: ['line one', 'line two'] },
        { type: 'gemini', content: [null, 7, { notText: 1 }, { text: 'answer' }] },
      ]),
    )
    expect(turns.map((t) => t.text)).toEqual(['line one\nline two', 'answer'])
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
  })

  it('skips null/primitive messages, unknown types, and messages with no text', () => {
    const turns = parseGeminiSession(
      wrap([
        null,
        42,
        'a bare string',
        { type: 'tool', content: 'tool noise' }, // neither user nor gemini -> no role -> dropped
        { type: 'user', content: [] }, // no text -> dropped
        { type: 'gemini', content: 99 }, // neither string nor array -> '' -> dropped
        { type: 'user', content: 'kept' },
      ]),
    )
    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('kept')
  })

  it('scopes turns to an explicit cwd when the transcript carries one', () => {
    expect(parseGeminiSession(wrap([{ type: 'user', content: 'x' }], { cwd: '/repos/app' }))[0].cwd).toBe('/repos/app')
  })

  it('falls back to projectPath when cwd is missing or blank', () => {
    expect(parseGeminiSession(wrap([{ type: 'user', content: 'x' }], { cwd: '', projectPath: '/repos/other' }))[0].cwd).toBe('/repos/other')
  })

  it('derives cwd from the on-disk .gemini/tmp/<proj>/chats layout, normalising Windows separators', () => {
    const turns = parseGeminiSession(
      wrap([{ type: 'user', content: 'x' }]),
      'C:\\Users\\me\\.gemini\\tmp\\myproj\\chats\\session-1.json',
    )
    expect(turns[0].cwd).toBe('C:/Users/me/.gemini/tmp/myproj')
  })

  it('leaves cwd undefined when there is no path, no chats/ segment, or chats/ is the first segment', () => {
    const msgs = [{ type: 'user', content: 'x' }]
    expect(parseGeminiSession(wrap(msgs))[0].cwd).toBeUndefined()
    expect(parseGeminiSession(wrap(msgs), '/tmp/proj/session-1.json')[0].cwd).toBeUndefined()
    expect(parseGeminiSession(wrap(msgs), 'chats/session-1.json')[0].cwd).toBeUndefined() // lastIndexOf === 0, not > 0
    expect(parseGeminiSession(wrap(msgs, { cwd: '', projectPath: '' }))[0].cwd).toBeUndefined()
  })

  it('returns [] when messages is present but not an array', () => {
    expect(parseGeminiSession(JSON.stringify({ sessionId: 'g', messages: { not: 'an array' } }))).toEqual([])
  })
})

describe('chunkTurns — a chunk carries exactly one cwd (F32)', () => {
  it('splits on a cwd change so a repo-hopping session never mis-tags the second repo', () => {
    const turns: IngestTurn[] = [
      { role: 'user', text: 'work in A', source: 'claude', sessionId: 's', cwd: '/repo/a', ts: 1 },
      { role: 'assistant', text: 'done in A', source: 'claude', sessionId: 's', cwd: '/repo/a', ts: 2 },
      { role: 'user', text: 'work in B', source: 'claude', sessionId: 's', cwd: '/repo/b', ts: 3 },
    ]
    const chunks = chunkTurns(turns, { maxChars: 10_000 }) // budget is huge — only cwd can split these
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ cwd: '/repo/a', turnCount: 2 })
    expect(chunks[0].text).not.toContain('work in B')
    expect(chunks[1]).toMatchObject({ cwd: '/repo/b', turnCount: 1 })
    expect(chunks[1].text).toBe('user: work in B')
  })

  it('an oversized turn is windowed, and the window boundary also respects the cwd split', () => {
    const turns: IngestTurn[] = [
      { role: 'user', text: 'x'.repeat(60), source: 'claude', cwd: '/a', ts: 1 },
      { role: 'user', text: 'y'.repeat(60), source: 'claude', cwd: '/b', ts: 2 },
    ]
    const chunks = chunkTurns(turns, { maxChars: 25 })
    expect(chunks.every((c) => c.text.length <= 25)).toBe(true)
    expect(new Set(chunks.map((c) => c.cwd))).toEqual(new Set(['/a', '/b']))
  })
})

describe('ingestConversations — a readable file with no dialogue in it', () => {
  it('counts the file as scanned but writes nothing when it parses to zero turns', async () => {
    const write = vi.fn(async () => {})
    const deps: IngestDeps = {
      sources: ['claude'],
      listFiles: async () => ['empty.jsonl', 'junk.jsonl'],
      readFile: async (fp) => (fp === 'empty.jsonl' ? '' : 'not json at all\n{"type":"summary","summary":"x"}'),
      hasHash: () => false,
      write,
    }
    const stats = await ingestConversations(deps)
    expect(stats.filesScanned).toBe(2)
    expect(stats.chunksWritten).toBe(0)
    expect(stats.chunksSkipped).toBe(0)
    expect(stats.truncated).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})

// =========================================================================================
// conversationIngest — on-disk discovery
// =========================================================================================

describe('discoverTranscriptFiles / findLatestTranscriptFile — default roots, depth cap, bad entries', () => {
  let home: string
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE

  beforeEach(() => {
    // os.homedir() reads $HOME (POSIX) / %USERPROFILE% (Windows) on every call, so pointing
    // both at a temp dir lets us exercise the REAL default-root logic without ever touching
    // the developer's actual ~/.claude, ~/.codex or ~/.gemini transcripts.
    home = realFs.mkdtempSync(join(os.tmpdir(), 'tp-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
    try {
      realFs.rmSync(home, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('falls back to ~/.claude/projects when no root is passed', async () => {
    const proj = join(home, '.claude', 'projects', 'repo-x')
    realFs.mkdirSync(proj, { recursive: true })
    realFs.writeFileSync(join(proj, 'a.jsonl'), 'x')
    realFs.writeFileSync(join(proj, 'notes.md'), 'x')
    expect(await discoverTranscriptFiles('claude')).toEqual([join(proj, 'a.jsonl')])
  })

  it('falls back to ~/.codex/sessions and ~/.gemini/tmp for the other disk sources', async () => {
    const cx = join(home, '.codex', 'sessions', '2026', '07')
    realFs.mkdirSync(cx, { recursive: true })
    realFs.writeFileSync(join(cx, 'rollout-1.jsonl'), 'x')
    realFs.writeFileSync(join(cx, 'history.jsonl'), 'x') // wrong prefix — must be ignored

    const gm = join(home, '.gemini', 'tmp', 'proj', 'chats')
    realFs.mkdirSync(gm, { recursive: true })
    realFs.writeFileSync(join(gm, 'session-1.json'), 'x')
    realFs.writeFileSync(join(gm, 'logs.json'), 'x') // wrong prefix — must be ignored

    expect(await discoverTranscriptFiles('codex')).toEqual([join(cx, 'rollout-1.jsonl')])
    expect(await discoverTranscriptFiles('gemini')).toEqual([join(gm, 'session-1.json')])
  })

  it('stops recursing past depth 6 — a pathologically deep tree cannot trap the walk', async () => {
    const root = join(home, 'deep')
    const d6 = join(root, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6')
    const d7 = join(d6, 'd7')
    realFs.mkdirSync(d7, { recursive: true })
    realFs.writeFileSync(join(d6, 'at-depth-6.jsonl'), 'x')
    realFs.writeFileSync(join(d7, 'at-depth-7.jsonl'), 'x')
    const files = await discoverTranscriptFiles('claude', root)
    expect(files.map((f) => path.basename(f))).toEqual(['at-depth-6.jsonl'])
  })

  it('skips a file whose stat fails mid-scan instead of aborting the whole freshness pass', async () => {
    const root = join(home, 'fresh')
    realFs.mkdirSync(root, { recursive: true })
    const good = join(root, 'good.jsonl')
    const vanished = join(root, 'vanished.jsonl')
    realFs.writeFileSync(good, 'x')
    realFs.writeFileSync(vanished, 'x')
    realFs.utimesSync(good, new Date(9_000_000), new Date(9_000_000))
    realFs.utimesSync(vanished, new Date(9_000_000), new Date(9_000_000))

    // The file is gone (or locked) by the time the scan stats it — a real race on an
    // active session directory. It must be skipped, not thrown.
    fsCtl.rules.push({ op: 'stat', match: 'vanished', err: new Error('ENOENT: file vanished') })

    const files = await discoverTranscriptFiles('claude', root, 1_000_000)
    expect(files.map((f) => path.basename(f))).toEqual(['good.jsonl'])
  })

  it('findLatestTranscriptFile picks by mtime, not by directory order', async () => {
    const root = join(home, 'latest')
    realFs.mkdirSync(root, { recursive: true })
    const newest = join(root, 'a-newest.jsonl') // read FIRST (alphabetical)
    const older = join(root, 'b-older.jsonl') // read SECOND — must not win
    realFs.writeFileSync(newest, 'x')
    realFs.writeFileSync(older, 'x')
    realFs.utimesSync(newest, new Date(9_000_000), new Date(9_000_000))
    realFs.utimesSync(older, new Date(1_000_000), new Date(1_000_000))
    expect(await findLatestTranscriptFile('claude', root)).toBe(newest)
  })

  it('findLatestTranscriptFile skips an unstattable file and still returns the best of the rest', async () => {
    const root = join(home, 'latest2')
    realFs.mkdirSync(root, { recursive: true })
    const broken = join(root, 'a-broken.jsonl')
    const ok = join(root, 'b-ok.jsonl')
    realFs.writeFileSync(broken, 'x')
    realFs.writeFileSync(ok, 'x')
    fsCtl.rules.push({ op: 'stat', match: 'a-broken', err: new Error('EPERM') })
    expect(await findLatestTranscriptFile('claude', root)).toBe(ok)
  })
})

// =========================================================================================
// agentMcpRegistry
// =========================================================================================

const ADAPTER = '/path/to/stdio-adapter.cjs'
const HOOK = '/path/to/mcp-adapter/memory-primer-hook.cjs'

describe('agentMcpRegistry — a config we cannot write must be REPORTED, never thrown', () => {
  let dir: string

  beforeEach(() => {
    dir = realFs.mkdtempSync(join(os.tmpdir(), 'tp-reg-fail-'))
  })
  afterEach(() => {
    try {
      realFs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  // atomicWriteJson writes `<path>.tmp` and then renames it. Making that temp path a DIRECTORY
  // makes the write fail for real — a faithful stand-in for a full disk or a locked file, with
  // no mocking at all. The errno wording differs slightly per OS, so we assert on the CONTRACT
  // (write-failed + a genuine errno was captured + the user's file survived), not the spelling.
  const blockTmp = (p: string): void => realFs.mkdirSync(p + '.tmp')
  const OS_ERRNO = /EISDIR|EPERM|EACCES/

  it('claude settings.json: reports write-failed and leaves the original file untouched', () => {
    const p = join(dir, 'settings.json')
    realFs.writeFileSync(p, '{}')
    blockTmp(p)
    const r = registerInClaudeSettings(p, ADAPTER)
    expect(r).toMatchObject({ changed: false, skipped: 'write-failed' })
    expect(r.error).toMatch(OS_ERRNO) // the real OS error is surfaced, not swallowed into undefined
    expect(realFs.readFileSync(p, 'utf-8')).toBe('{}') // user's config not corrupted by the failure
  })

  it('~/.mcp.json: reports write-failed instead of crashing main-process boot', () => {
    const p = join(dir, '.mcp.json')
    blockTmp(p) // the manifest does not even exist yet — it is created, so only the write can fail
    const r = registerInGlobalMcp(p, ADAPTER)
    expect(r).toMatchObject({ changed: false, skipped: 'write-failed' })
    expect(r.error).toMatch(OS_ERRNO)
    expect(realFs.existsSync(p)).toBe(false)
  })

  it('gemini settings.json: report write-failed', () => {
    const g = join(dir, 'gemini.json')
    realFs.writeFileSync(g, '{}')
    blockTmp(g)
    expect(registerInGemini(g, ADAPTER)).toMatchObject({ changed: false, skipped: 'write-failed' })
    expect(realFs.readFileSync(g, 'utf-8')).toBe('{}')
  })

  it('codex config.toml: an unreadable path (a directory) is reported as corrupt', () => {
    const p = join(dir, 'config.toml')
    realFs.mkdirSync(p) // exists, but reading it is an OS error
    const r = registerInCodex(p, ADAPTER)
    expect(r).toMatchObject({ changed: false, skipped: 'corrupt' })
    expect(r.error).toMatch(OS_ERRNO)
  })

  it('codex config.toml: a failing append is reported as write-failed and the file is left intact', () => {
    const p = join(dir, 'config.toml')
    const before = 'model = "gpt-5"\n'
    realFs.writeFileSync(p, before)
    fsCtl.rules.push({ op: 'append', match: 'config.toml', err: new Error('EACCES: permission denied') })
    const r = registerInCodex(p, ADAPTER)
    expect(r).toMatchObject({ changed: false, skipped: 'write-failed' })
    expect(r.error).toContain('EACCES')
    expect(realFs.readFileSync(p, 'utf-8')).toBe(before)
  })

  it('a thrown NON-Error (no .message) is still surfaced as a string, never as "undefined"', () => {
    const settings = join(dir, 'settings.json')
    const gem = join(dir, 'gemini.json')
    const toml = join(dir, 'config.toml')
    for (const p of [settings, gem]) realFs.writeFileSync(p, '{}')
    realFs.writeFileSync(toml, '')

    fsCtl.rules.push({ op: 'write', match: dir, err: 'raw string blew up' })
    fsCtl.rules.push({ op: 'append', match: dir, err: 'raw append blew up' })

    expect(registerInClaudeSettings(settings, ADAPTER)).toMatchObject({ skipped: 'write-failed', error: 'raw string blew up' })
    expect(registerInGemini(gem, ADAPTER)).toMatchObject({ skipped: 'write-failed', error: 'raw string blew up' })
    expect(registerInGlobalMcp(join(dir, '.mcp.json'), ADAPTER)).toMatchObject({ skipped: 'write-failed', error: 'raw string blew up' })
    expect(registerInCodex(toml, ADAPTER)).toMatchObject({ skipped: 'write-failed', error: 'raw append blew up' })
  })

  it('a NON-Error read failure is reported as corrupt with the raw value as the message', () => {
    const p = join(dir, 'settings.json')
    const toml = join(dir, 'config.toml')
    realFs.writeFileSync(p, '{}')
    realFs.writeFileSync(toml, 'model = "gpt-5"\n')
    fsCtl.rules.push({ op: 'read', match: dir, err: 'read blew up' })
    expect(registerInClaudeSettings(p, ADAPTER)).toMatchObject({ changed: false, skipped: 'corrupt', error: 'read blew up' })
    expect(registerInGemini(p, ADAPTER)).toMatchObject({ changed: false, skipped: 'corrupt', error: 'read blew up' })
    // registerInCodex reads the TOML as a raw blob (no JSON parse) — it has its own catch.
    expect(registerInCodex(toml, ADAPTER)).toMatchObject({ changed: false, skipped: 'corrupt', error: 'read blew up' })
  })
})

describe('agentMcpRegistry — hook + manifest shapes the happy path never produces', () => {
  let dir: string
  beforeEach(() => {
    dir = realFs.mkdtempSync(join(os.tmpdir(), 'tp-reg-shape-'))
  })
  afterEach(() => {
    try {
      realFs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('detects an existing memory-primer hook registered as a FLAT SessionStart entry (no nested hooks[])', () => {
    const p = join(dir, 'settings.json')
    realFs.writeFileSync(
      p,
      JSON.stringify({
        mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
        permissions: { allow: ['mcp__termpolis__*'] },
        // A hand-written / older-schema group that puts `command` at the TOP level.
        hooks: { SessionStart: [{ type: 'command', command: `node "${HOOK}"` }] },
      }),
    )
    const r = registerInClaudeSettings(p, ADAPTER, HOOK)
    expect(r).toMatchObject({ changed: false, skipped: 'already-registered' })
    const v = JSON.parse(realFs.readFileSync(p, 'utf-8'))
    expect(v.hooks.SessionStart).toHaveLength(1) // NOT duplicated
  })

  it('~/.mcp.json: strips the legacy ROOT-level termpolis key even when mcpServers already matches', () => {
    const p = join(dir, '.mcp.json')
    realFs.writeFileSync(
      p,
      JSON.stringify({
        termpolis: { command: 'node', args: ['/legacy/adapter.cjs'] }, // pre-1.11 shape
        mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } }, // already correct
      }),
    )
    const r = registerInGlobalMcp(p, ADAPTER)
    expect(r.changed).toBe(true) // the legacy key alone is enough to warrant a rewrite
    const v = JSON.parse(realFs.readFileSync(p, 'utf-8'))
    expect(v).not.toHaveProperty('termpolis')
    expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
    // Now that the legacy key is gone, a second pass is a clean no-op.
    expect(registerInGlobalMcp(p, ADAPTER)).toMatchObject({ changed: false, skipped: 'already-registered' })
  })
})

describe('resolveNodeCommand — platform-specific PATH resolution (#4 node-not-on-PATH)', () => {
  const realPlatform = process.platform
  const setPlatform = (p: string): void => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }
  afterEach(() => setPlatform(realPlatform))

  it('win32: probes %ProgramFiles%\\nodejs as a backstop when PATH carries no node', () => {
    setPlatform('win32')
    const target = join('D:\\Apps', 'nodejs', 'node.exe')
    const probed: string[] = []
    const got = resolveNodeCommand({ PATH: '', ProgramFiles: 'D:\\Apps' } as NodeJS.ProcessEnv, (p) => {
      probed.push(p)
      return p === target
    })
    expect(got).toBe(target)
    expect(probed).toContain(target)
  })

  it('win32: honours the legacy `Path` env spelling and splits on ";"', () => {
    setPlatform('win32')
    const target = join('C:\\tools\\node', 'node.exe')
    expect(resolveNodeCommand({ Path: 'C:\\nope; C:\\tools\\node ' } as NodeJS.ProcessEnv, (p) => p === target)).toBe(target)
  })

  it('posix: splits PATH on ":" and backstops on /usr/local/bin, /usr/bin, /opt/homebrew/bin', () => {
    setPlatform('linux')
    // If PATH were split on ';' (the win separator) the single dir would be "/a:/b" and this
    // candidate would never be probed — so the assertion really does pin the ':' split.
    const onPath = join('/b', 'node')
    expect(resolveNodeCommand({ PATH: '/a:/b' } as NodeJS.ProcessEnv, (p) => p === onPath)).toBe(onPath)

    const brew = join('/opt/homebrew/bin', 'node')
    expect(resolveNodeCommand({ PATH: '' } as NodeJS.ProcessEnv, (p) => p === brew)).toBe(brew)

    expect(resolveNodeCommand({ PATH: '/nothing/here' } as NodeJS.ProcessEnv, () => false)).toBe('node')
  })
})

// =========================================================================================
// mcpServer — executeTool dispatch
// =========================================================================================

function makeHandlers(): any {
  return {
    listTerminals: vi.fn().mockReturnValue([]),
    createTerminal: vi.fn().mockResolvedValue('t1'),
    runCommand: vi.fn(),
    readOutput: vi.fn().mockReturnValue(''),
    closeTerminal: vi.fn(),
    writeToTerminal: vi.fn(),
    getFileTree: vi.fn().mockReturnValue([]),
    getGitStatus: vi.fn().mockReturnValue({ status: '', recentCommits: '', branch: 'main' }),
    swarmSendMessage: vi.fn().mockReturnValue({}),
    swarmReadMessages: vi.fn().mockReturnValue([]),
    swarmCreateTask: vi.fn().mockReturnValue({}),
    swarmListTasks: vi.fn().mockReturnValue([]),
    swarmUpdateTask: vi.fn().mockReturnValue({}),
    swarmListAgents: vi.fn().mockReturnValue([]),
    memoryWrite: vi.fn().mockResolvedValue({ id: 'm1' }),
    memorySearch: vi.fn().mockResolvedValue([]),
    memoryList: vi.fn().mockReturnValue([]),
    memoryPrimer: vi.fn().mockResolvedValue({ project: null, primer: null }),
    memoryRelated: vi.fn().mockResolvedValue([]),
    memoryLink: vi.fn().mockReturnValue({}),
    memoryGraph: vi.fn().mockResolvedValue([]),
    memoryFeedback: vi.fn().mockReturnValue({}),
    memorySelfcheck: vi.fn().mockReturnValue({}),
    memoryPool: vi.fn().mockReturnValue([]),
    memoryAnticipate: vi.fn().mockResolvedValue([]),
    memoryConflicts: vi.fn().mockReturnValue([]),
    codeExplore: vi.fn().mockReturnValue({}),
    codeCallers: vi.fn().mockReturnValue([]),
    codeCallees: vi.fn().mockReturnValue([]),
    codeImpact: vi.fn().mockReturnValue([]),
    codeSearch: vi.fn().mockReturnValue([]),
    codeLocate: vi.fn().mockReturnValue([]),
  }
}

describe('executeTool — memory tool dispatch and the audit trail it emits', () => {
  beforeEach(() => {
    audit.auditMemory.mockClear()
    audit.redactPreview.mockClear()
    audit.readMemoryAudit.mockClear()
  })

  it('memory_list forwards every filter verbatim and returns the handler result', async () => {
    const h = makeHandlers()
    h.memoryList.mockReturnValue([{ id: 'm1' }])
    const out = await executeTool('memory_list', { limit: 5, agentId: 'a', kind: 'note', since: 123 }, h)
    expect(h.memoryList).toHaveBeenCalledWith({ limit: 5, agentId: 'a', kind: 'note', since: 123 })
    expect(out).toEqual([{ id: 'm1' }])
  })

  it('memory_search: diversify defaults ON, fuseGraph defaults OFF, and only the TOP-5 ids are audited', async () => {
    const h = makeHandlers()
    h.memorySearch.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ id: `s${i}` })))
    await executeTool('memory_search', { query: 'auth middleware', agentId: 'claude' }, h)
    expect(h.memorySearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'auth middleware', agentId: 'claude', diversify: true, fuseGraph: false }),
    )
    expect(audit.auditMemory).toHaveBeenCalledWith({
      event: 'recall',
      agentId: 'claude',
      query: 'RP:auth middleware', // the raw query is redacted before it is ever recorded
      results: 6,
      topIds: ['s0', 's1', 's2', 's3', 's4'],
    })
  })

  it('memory_search: a missing query audits an empty string, and a non-array result audits 0 hits', async () => {
    const h = makeHandlers()
    h.memorySearch.mockResolvedValue({ hits: 'not an array' })
    const out = await executeTool('memory_search', {}, h)
    expect(out).toEqual({ hits: 'not an array' }) // handed back untouched
    expect(audit.redactPreview).toHaveBeenCalledWith('')
    expect(audit.auditMemory).toHaveBeenCalledWith(expect.objectContaining({ results: 0, topIds: [] }))
  })

  it('memory_related: audits the recall keyed on the seed id when no query is given', async () => {
    const h = makeHandlers()
    const res = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}` }))
    h.memoryRelated.mockResolvedValue(res)
    const out = await executeTool('memory_related', { id: 'seed-1', limit: 7 }, h)
    expect(h.memoryRelated).toHaveBeenCalledWith({ id: 'seed-1', query: undefined, limit: 7 })
    expect(out).toBe(res)
    expect(audit.redactPreview).toHaveBeenCalledWith('seed-1')
    expect(audit.auditMemory).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'recall', agentId: undefined, results: 7, topIds: ['r0', 'r1', 'r2', 'r3', 'r4'] }),
    )
  })

  it('memory_related: a query wins over the id, and a non-array result audits 0 hits', async () => {
    const h = makeHandlers()
    h.memoryRelated.mockResolvedValue({ nope: true })
    await executeTool('memory_related', { id: 'seed-1', query: 'why did it break' }, h)
    expect(audit.redactPreview).toHaveBeenCalledWith('why did it break')
    expect(audit.auditMemory).toHaveBeenCalledWith(expect.objectContaining({ results: 0, topIds: [] }))
  })

  it('memory_related: with neither id nor query the audited query is an empty string (never "undefined")', async () => {
    const h = makeHandlers()
    await executeTool('memory_related', {}, h)
    expect(audit.redactPreview).toHaveBeenCalledWith('')
  })

  it('memory_primer: a null digest is audited as 0 tokens rather than crashing on .length', async () => {
    const h = makeHandlers()
    const out = await executeTool('memory_primer', {}, h)
    expect(out).toEqual({ project: null, primer: null })
    expect(audit.auditMemory).toHaveBeenCalledWith({ event: 'inject', target: 'primer', memoryIds: [], approxTokens: 0 })
  })

  it('memory_primer: the injected-context size is recorded as ceil(chars / 4) — size only, never content', async () => {
    const h = makeHandlers()
    h.memoryPrimer.mockResolvedValue({ project: 'termpolis', primer: 'x'.repeat(10) })
    await executeTool('memory_primer', { cwd: '/repo', query: 'q', limit: 3 }, h)
    expect(h.memoryPrimer).toHaveBeenCalledWith({ cwd: '/repo', query: 'q', limit: 3 })
    const call = audit.auditMemory.mock.calls.at(-1)![0] as any
    expect(call).toMatchObject({ event: 'inject', target: 'primer', approxTokens: 3 })
    expect(JSON.stringify(call)).not.toContain('xxx') // the digest text itself is never audited
  })

  it('memory_audit clamps the limit into [1, 1000] and treats 0 / NaN / missing as the default 50', async () => {
    const h = makeHandlers()
    await executeTool('memory_audit', {}, h)
    expect(audit.readMemoryAudit).toHaveBeenLastCalledWith(50) // missing -> ?? 50
    await executeTool('memory_audit', { limit: 'abc' }, h)
    expect(audit.readMemoryAudit).toHaveBeenLastCalledWith(50) // Number('abc') -> NaN -> || 50
    await executeTool('memory_audit', { limit: 0 }, h)
    expect(audit.readMemoryAudit).toHaveBeenLastCalledWith(50) // 0 is falsy -> || 50
    await executeTool('memory_audit', { limit: 9999 }, h)
    expect(audit.readMemoryAudit).toHaveBeenLastCalledWith(1000) // capped
    await executeTool('memory_audit', { limit: -5 }, h)
    expect(audit.readMemoryAudit).toHaveBeenLastCalledWith(1) // floored

    const out = await executeTool('memory_audit', { limit: 3 }, h)
    expect(out).toEqual({ events: [{ event: 'recall', limit: 3 }], summary: { recall: 2, write: 1 } })
  })

  it('memory_link passes the relation through (undefined lets the store apply its own default)', async () => {
    const h = makeHandlers()
    h.memoryLink.mockReturnValue({ ok: true })
    expect(await executeTool('memory_link', { from: 'a', to: 'b' }, h)).toEqual({ ok: true })
    expect(h.memoryLink).toHaveBeenCalledWith({ from: 'a', to: 'b', relation: undefined })
    await executeTool('memory_link', { from: 'a', to: 'b', relation: 'solved-by' }, h)
    expect(h.memoryLink).toHaveBeenLastCalledWith({ from: 'a', to: 'b', relation: 'solved-by' })
  })

  it('memory_graph forwards the full traversal spec', async () => {
    const h = makeHandlers()
    h.memoryGraph.mockResolvedValue([{ id: 'x', hops: 2 }])
    const out = await executeTool('memory_graph', { id: 'seed', query: 'q', relation: 'causes', depth: 3, limit: 9 }, h)
    expect(h.memoryGraph).toHaveBeenCalledWith({ id: 'seed', query: 'q', relation: 'causes', depth: 3, limit: 9 })
    expect(out).toEqual([{ id: 'x', hops: 2 }])
  })

  it('memory_selfcheck / memory_pool / memory_anticipate / memory_conflicts forward args and return results', async () => {
    const h = makeHandlers()
    h.memorySelfcheck.mockReturnValue({ confidence: 0.7, attempts: 9, verdict: 'confident' })
    h.memoryPool.mockReturnValue([{ lesson: 'always copy grammars', corroboration: 2 }])
    h.memoryAnticipate.mockResolvedValue([{ id: 'a1' }])
    h.memoryConflicts.mockReturnValue([{ a: '1', b: '2' }])

    expect(await executeTool('memory_selfcheck', { domain: 'termpolis' }, h)).toMatchObject({ verdict: 'confident' })
    expect(h.memorySelfcheck).toHaveBeenCalledWith({ domain: 'termpolis' })

    expect(await executeTool('memory_pool', { limit: 20 }, h)).toEqual([{ lesson: 'always copy grammars', corroboration: 2 }])
    expect(h.memoryPool).toHaveBeenCalledWith({ limit: 20 })

    expect(await executeTool('memory_anticipate', { task: 'fix the flaky test', limit: 2 }, h)).toEqual([{ id: 'a1' }])
    expect(h.memoryAnticipate).toHaveBeenCalledWith({ task: 'fix the flaky test', limit: 2 })

    expect(await executeTool('memory_conflicts', {}, h)).toEqual([{ a: '1', b: '2' }])
    expect(h.memoryConflicts).toHaveBeenCalledWith({ limit: undefined })
  })

  it('an unknown tool rejects, naming the tool so the agent can correct itself', async () => {
    await expect(executeTool('definitely_not_a_tool', {}, makeHandlers())).rejects.toThrow('Unknown tool: definitely_not_a_tool')
  })
})

// =========================================================================================
// mcpServer — HTTP surface: audit-log rotation, sanitized errors, malformed JSON-RPC
// =========================================================================================

const MAX_LOG_SIZE = 1024 * 1024

// `agent: false` on every request: the 413 case makes the server DESTROY the socket, and a
// pooled keep-alive agent will happily hand that poisoned socket to the next test, which then
// hangs. One fresh socket per request keeps the cases independent.
function request(options: http.RequestOptions, body?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: false, ...options }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ statusCode: res.statusCode!, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

// Find a contiguous run of `count` free ports. Started from a randomised high base so this
// suite cannot collide with a running dev Termpolis (9315) or another test file's window.
async function findFreeBasePort(count: number): Promise<number> {
  const start = 27000 + Math.floor(Math.random() * 3000)
  for (let base = start; base < start + 2000; base += count) {
    const ok = await Promise.all(Array.from({ length: count }, (_, i) => isFree(base + i)))
    if (ok.every(Boolean)) return base
  }
  throw new Error('no free port window found for test')
}

function occupy(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const s = http.createServer(() => {})
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

const closeAll = (servers: http.Server[]): Promise<void> =>
  Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined)

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(predicate()).toBe(true) // fail with the real assertion, not a silent timeout
}

describe('MCP HTTP server — audit log rotation, sanitized tool errors, malformed JSON-RPC', () => {
  let server: http.Server
  let port: number
  let logDir: string
  let logPath: string
  let backupPath: string
  const handlers = makeHandlers()
  const token = getMcpAuthToken()
  const savedBasePort = process.env.TERMPOLIS_MCP_BASE_PORT

  const rpc = (payload: object): Promise<{ statusCode: number; body: string }> =>
    request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      },
      JSON.stringify(payload),
    )

  beforeAll(async () => {
    logDir = realFs.mkdtempSync(join(os.tmpdir(), 'tp-mcp-audit-'))
    logPath = join(logDir, 'mcp-audit.log')
    backupPath = logPath + '.old'
    // Seed an OVER-SIZED audit log so the very first logged request has to rotate it.
    realFs.writeFileSync(logPath, 'A'.repeat(MAX_LOG_SIZE + 64))
    initAuditLog(logDir)

    const base = await findFreeBasePort(1)
    process.env.TERMPOLIS_MCP_BASE_PORT = String(base)
    _resetPortStateForTest()
    server = startMcpServer(handlers)
    port = await awaitMcpPortBound()
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    _resetPortStateForTest()
    resetRateLimits()
    if (savedBasePort === undefined) delete process.env.TERMPOLIS_MCP_BASE_PORT
    else process.env.TERMPOLIS_MCP_BASE_PORT = savedBasePort
    try {
      realFs.rmSync(logDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  beforeEach(() => resetRateLimits())

  // --- audit log rotation (a 1MB cap is the only thing stopping this file eating the disk) ---

  it('rotates the audit log once it passes 1MB, keeping the overflow as a single .old backup', async () => {
    expect(realFs.existsSync(backupPath)).toBe(false)
    await rpc({ jsonrpc: '2.0', method: 'ping', id: 1 }) // any request writes an audit line
    await waitFor(() => realFs.existsSync(backupPath) && realFs.existsSync(logPath))

    expect(realFs.statSync(backupPath).size).toBeGreaterThan(MAX_LOG_SIZE) // the overflow was preserved
    expect(realFs.statSync(logPath).size).toBeLessThan(MAX_LOG_SIZE) // and the live log started over
  })

  it('keeps writing into the FRESH log after a rotation (the stream really was reopened)', async () => {
    await rpc({ jsonrpc: '2.0', method: 'tools/list', id: 2 })
    await waitFor(() => realFs.readFileSync(logPath, 'utf-8').includes('tools/list'))
    expect(realFs.readFileSync(logPath, 'utf-8')).toContain('"status":"ok"')
  })

  it('replaces the previous backup on the next rotation — there is only ever ONE .old', async () => {
    realFs.appendFileSync(logPath, 'B'.repeat(MAX_LOG_SIZE)) // push the live log back over the cap
    await rpc({ jsonrpc: '2.0', method: 'ping', id: 3 })
    await waitFor(() => realFs.readFileSync(backupPath, 'utf-8').includes('BBBB'))
    expect(realFs.existsSync(backupPath + '.old')).toBe(false) // no chain of backups accumulates
  })

  // --- tool errors are sanitized on the way out ---

  it('a throwing tool is reported as a generic failure — internals never leak to the agent', async () => {
    handlers.listTerminals.mockImplementationOnce(() => {
      throw new Error('connect failed: postgres://user:hunter2@db.internal/prod')
    })
    const res = await rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_terminals', arguments: {} }, id: 10 })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe('Error: Tool execution failed')
    expect(res.body).not.toContain('postgres')
    expect(res.body).not.toContain('hunter2')
  })

  it('an "Invalid ..." tool error IS passed through — it is actionable, not an internal leak', async () => {
    handlers.readOutput.mockImplementationOnce(() => {
      throw new Error('Invalid terminal id t-999')
    })
    const res = await rpc({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'read_output', arguments: { terminalId: 't-999' } },
      id: 11,
    })
    const body = JSON.parse(res.body)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe('Error: Invalid terminal id t-999')
  })

  it('an unknown tool name is echoed back so the agent can correct itself', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'no_such_tool', arguments: {} }, id: 12 })
    const body = JSON.parse(res.body)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe('Error: Unknown tool: no_such_tool')
  })

  it('a rejected async tool is sanitized too (not just a synchronous throw)', async () => {
    handlers.memorySearch.mockRejectedValueOnce(new Error('vector index corrupt at /home/dave/.termpolis/hnsw.bin'))
    const res = await rpc({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'x' } },
      id: 13,
    })
    const body = JSON.parse(res.body)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe('Error: Tool execution failed')
    expect(res.body).not.toContain('hnsw.bin')
  })

  // --- malformed JSON-RPC ---

  it('a JSON-RPC request with NO method is answered with -32601 rather than crashing the handler', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 77 })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe(-32601)
    expect(body.error.message).toContain('undefined')
    expect(body.id).toBe(77)
  })

  it('rejects a >1MB body with 413 and never parses it', async () => {
    try {
      const res = await request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        },
        JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'run_command', arguments: { command: 'x'.repeat(MAX_LOG_SIZE + 512) } }, id: 14 }),
      )
      expect(res.statusCode).toBe(413)
      expect(JSON.parse(res.body).error.message).toBe('Payload too large')
    } catch (e: any) {
      expect(e.code).toBe('ECONNRESET') // server destroyed the socket — also acceptable
    }
    expect(handlers.runCommand).not.toHaveBeenCalled() // the oversized body never reached a tool
  })

  // --- SSE ---

  it('the SSE stream schedules a keepalive tick, and tears it down when the client disconnects', async () => {
    // Faking the global clock here would stall the very socket we need to read, so instead we
    // intercept ONLY the 30s interval the SSE handler registers: capture its callback, hand back
    // a sentinel handle, and fire it by hand. Firing it must put a real `:keepalive` on the wire
    // (which is what proves we captured the right callback), and disconnecting must clear it.
    const realSetInterval = globalThis.setInterval
    const realClearInterval = globalThis.clearInterval
    const handle = { sentinel: 'sse-keepalive' }
    let capturing = true
    let keepalive: (() => void) | undefined
    let cleared: unknown

    globalThis.setInterval = ((fn: any, ms?: number, ...rest: any[]) => {
      if (capturing && ms === 30000) {
        keepalive = fn
        return handle
      }
      return (realSetInterval as any)(fn, ms, ...rest)
    }) as any
    globalThis.clearInterval = ((h: any) => {
      if (h === handle) {
        cleared = h
        return
      }
      return (realClearInterval as any)(h)
    }) as any

    const seen: string[] = []
    let sseReq: http.ClientRequest | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        sseReq = http.request(
          { agent: false, hostname: '127.0.0.1', port, path: '/mcp/sse', method: 'GET', headers: { Authorization: `Bearer ${token}` } },
          (res) => {
            expect(res.statusCode).toBe(200)
            expect(res.headers['content-type']).toBe('text/event-stream')
            res.on('data', (c) => {
              seen.push(String(c))
              resolve()
            })
          },
        )
        sseReq.on('error', (e: any) => {
          if (e.code !== 'ECONNRESET') reject(e)
        })
        sseReq.end()
      })
      capturing = false

      expect(seen.join('')).toContain('"method":"ready"')
      expect(seen.join('')).not.toContain(':keepalive') // not until the interval actually ticks
      expect(typeof keepalive).toBe('function') // a keepalive really was scheduled

      keepalive!() // fire the tick the 30s interval would have fired
      await waitFor(() => seen.join('').includes(':keepalive'))

      sseReq!.destroy()
      await waitFor(() => cleared === handle) // disconnecting stops the timer — no leak per dropped client
    } finally {
      capturing = false
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
      sseReq?.destroy()
    }
  })

  // --- the audit stream itself failing must not take the app down (keep LAST: these null the stream) ---

  it('survives an audit log it cannot even open — the stream error is handled and requests keep working', async () => {
    // A userDataPath whose directory does not exist: createWriteStream emits ENOENT asynchronously.
    // Without the 'error' handler on the stream this is an UNHANDLED error event, i.e. a main-process crash.
    const badDir = join(logDir, 'not-a-real-dir')
    initAuditLog(badDir)
    await new Promise((r) => setTimeout(r, 100)) // let the async ENOENT land

    const res = await rpc({ jsonrpc: '2.0', method: 'ping', id: 20 })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).result).toEqual({})
    expect(realFs.existsSync(join(badDir, 'mcp-audit.log'))).toBe(false)
  })

  it('survives a SYNCHRONOUS failure to open the audit stream (EMFILE) — auditing degrades, serving does not', async () => {
    const emfileDir = realFs.mkdtempSync(join(os.tmpdir(), 'tp-mcp-emfile-'))
    fsCtl.rules.push({
      op: 'stream',
      match: 'mcp-audit.log',
      err: Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }),
    })
    try {
      expect(() => initAuditLog(emfileDir)).not.toThrow()
      const res = await rpc({ jsonrpc: '2.0', method: 'ping', id: 21 })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).result).toEqual({})
      expect(realFs.existsSync(join(emfileDir, 'mcp-audit.log'))).toBe(false) // no stream was ever opened
    } finally {
      realFs.rmSync(emfileDir, { recursive: true, force: true })
    }
  })
})

// =========================================================================================
// mcpServer — bind failures must SURFACE, never hang
// =========================================================================================

describe('startMcpServer — a port it cannot bind is reported, not silently swallowed', () => {
  const savedBasePort = process.env.TERMPOLIS_MCP_BASE_PORT

  afterEach(() => {
    _resetPortStateForTest()
    if (savedBasePort === undefined) delete process.env.TERMPOLIS_MCP_BASE_PORT
    else process.env.TERMPOLIS_MCP_BASE_PORT = savedBasePort
  })

  it('a NON-EADDRINUSE listen error rejects awaitMcpPortBound (callers see a real failure, not a hang)', async () => {
    const base = await findFreeBasePort(1)
    process.env.TERMPOLIS_MCP_BASE_PORT = String(base)
    _resetPortStateForTest()

    const server = startMcpServer(makeHandlers())
    const bound = awaitMcpPortBound() // registered BEFORE the error — this is the caller we must not strand
    server.emit('error', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))

    await expect(bound).rejects.toThrow('EACCES: permission denied')
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('exhausting every fallback port rejects — and a LATE duplicate EADDRINUSE afterwards is a no-op, not a crash', async () => {
    const base = await findFreeBasePort(5)
    const blockers = await Promise.all([0, 1, 2, 3, 4].map((i) => occupy(base + i)))
    try {
      process.env.TERMPOLIS_MCP_BASE_PORT = String(base)
      _resetPortStateForTest()

      const server = startMcpServer(makeHandlers())
      await expect(awaitMcpPortBound()).rejects.toThrow(
        new RegExp(`could not bind any port in range ${base}\\.\\.${base + 4}`),
      )

      // The retry budget is spent and the pending 'listening' handler has been detached. A
      // straggler EADDRINUSE from the last failed attempt must not re-enter the retry loop.
      expect(() => server.emit('error', Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }))).not.toThrow()
      await new Promise<void>((r) => server.close(() => r()))
    } finally {
      await closeAll(blockers)
    }
  })
})

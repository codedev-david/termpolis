import { describe, it, expect, vi, beforeEach } from 'vitest'

// The DEFAULT deps (defaultDeps / defaultSessionDeps) are the production wiring: which
// discovery function each agent is routed to, and that the file is read as utf8. The
// suites below that inject deps can never exercise that wiring, so mock the three modules
// liveTranscript imports and drive it with no deps argument at all.
const {
  mockFsReadFile,
  mockFindLatestSessionFile,
  mockFindLatestTranscriptFile,
  mockParseClaudeTranscript,
  mockParseBySource,
} = vi.hoisted(() => ({
  mockFsReadFile: vi.fn(),
  mockFindLatestSessionFile: vi.fn(),
  mockFindLatestTranscriptFile: vi.fn(),
  mockParseClaudeTranscript: vi.fn(),
  mockParseBySource: vi.fn(),
}))

vi.mock('fs', () => ({
  promises: { readFile: mockFsReadFile },
  default: { promises: { readFile: mockFsReadFile } },
}))
vi.mock('../../src/main/transcriptWatchers/claudeCodeWatcher', () => ({
  findLatestSessionFile: mockFindLatestSessionFile,
}))
vi.mock('../../src/main/conversationIngest', () => ({
  parseClaudeTranscript: mockParseClaudeTranscript,
  parseBySource: mockParseBySource,
  findLatestTranscriptFile: mockFindLatestTranscriptFile,
}))

import {
  readActiveTranscript,
  readSessionTranscript,
  type TranscriptDeps,
  type SessionTranscriptDeps,
} from '../../src/main/liveTranscript'

function deps(over: Partial<TranscriptDeps> = {}): TranscriptDeps {
  return {
    findFile: () => '/fake/session.jsonl',
    readFile: async () => 'JSONL',
    parse: () => [
      { role: 'user', text: 'hello world', ts: 1 },
      { role: 'assistant', text: 'hi there', ts: 2 },
    ],
    ...over,
  }
}

describe('readActiveTranscript', () => {
  it('returns clean dialogue turns for an active Claude session', async () => {
    const turns = await readActiveTranscript('C:/repo', 'claude', deps())
    expect(turns).toEqual([
      { role: 'user', text: 'hello world', ts: 1 },
      { role: 'assistant', text: 'hi there', ts: 2 },
    ])
  })

  it('reads the file findFile resolves for the cwd and parses its content', async () => {
    const findFile = vi.fn(() => '/x/session.jsonl')
    const readFile = vi.fn(async () => 'CONTENT')
    const parse = vi.fn(() => [{ role: 'user' as const, text: 'q', ts: 5 }])
    const turns = await readActiveTranscript('C:/repo', 'claude', deps({ findFile, readFile, parse }))
    expect(findFile).toHaveBeenCalledWith('C:/repo')
    expect(readFile).toHaveBeenCalledWith('/x/session.jsonl')
    expect(parse).toHaveBeenCalledWith('CONTENT')
    expect(turns).toEqual([{ role: 'user', text: 'q', ts: 5 }])
  })

  it('returns [] for a non-Claude agent without touching the filesystem', async () => {
    const findFile = vi.fn(() => '/x.jsonl')
    expect(await readActiveTranscript('C:/repo', 'codex', deps({ findFile }))).toEqual([])
    expect(findFile).not.toHaveBeenCalled()
  })

  it('returns [] when cwd is empty', async () => {
    expect(await readActiveTranscript('', 'claude', deps())).toEqual([])
  })

  it('returns [] when no session file is found', async () => {
    expect(await readActiveTranscript('C:/repo', 'claude', deps({ findFile: () => null }))).toEqual([])
  })

  it('returns [] (never throws) when the session file is unreadable', async () => {
    const readFile = async () => {
      throw new Error('ENOENT')
    }
    expect(await readActiveTranscript('C:/repo', 'claude', deps({ readFile }))).toEqual([])
  })

  it('returns [] (never throws) when the transcript fails to parse', async () => {
    const parse = () => {
      throw new Error('bad jsonl')
    }
    expect(await readActiveTranscript('C:/repo', 'claude', deps({ parse }))).toEqual([])
  })

  it('keeps only role/text/ts, dropping extra parser fields', async () => {
    const parse = () => [
      { role: 'user' as const, text: 'q', ts: 5, source: 'claude', sessionId: 'abc', cwd: 'C:/repo' },
    ]
    const turns = await readActiveTranscript('C:/repo', 'claude', deps({ parse }))
    expect(turns).toEqual([{ role: 'user', text: 'q', ts: 5 }])
  })
})

function sessionDeps(over: Partial<SessionTranscriptDeps> = {}): SessionTranscriptDeps {
  return {
    findFile: () => '/fake/rollout.jsonl',
    readFile: async () => 'CONTENT',
    parse: () => [
      { role: 'user', text: 'fix the bug' },
      { role: 'assistant', text: 'fixed, tests pass now' },
    ],
    ...over,
  }
}

describe('readSessionTranscript — cross-agent active-session reader', () => {
  it('resolves + parses a Codex session into role/text turns', async () => {
    const turns = await readSessionTranscript('C:/repo', 'codex', sessionDeps())
    expect(turns).toEqual([
      { role: 'user', text: 'fix the bug' },
      { role: 'assistant', text: 'fixed, tests pass now' },
    ])
  })

  it('threads the agent through to both findFile and parse', async () => {
    const findFile = vi.fn(() => '/x/session.json')
    const parse = vi.fn(() => [{ role: 'assistant' as const, text: 'ok' }])
    await readSessionTranscript('C:/repo', 'gemini', sessionDeps({ findFile, parse }))
    expect(findFile).toHaveBeenCalledWith('C:/repo', 'gemini')
    expect(parse).toHaveBeenCalledWith('gemini', 'CONTENT')
  })

  it('drops extra parser fields, keeping only role/text', async () => {
    const parse = () => [{ role: 'user' as const, text: 'q', ts: 9, source: 'codex', cwd: 'C:/repo' }]
    expect(await readSessionTranscript('C:/repo', 'codex', sessionDeps({ parse }))).toEqual([
      { role: 'user', text: 'q' },
    ])
  })

  it('returns [] when cwd or agent is missing', async () => {
    expect(await readSessionTranscript('', 'codex', sessionDeps())).toEqual([])
    expect(await readSessionTranscript('C:/repo', '', sessionDeps())).toEqual([])
  })

  it('returns [] when no session file resolves', async () => {
    expect(await readSessionTranscript('C:/repo', 'codex', sessionDeps({ findFile: () => null }))).toEqual([])
  })

  it('returns [] (never throws) when the file is unreadable', async () => {
    const readFile = async () => {
      throw new Error('ENOENT')
    }
    expect(await readSessionTranscript('C:/repo', 'codex', sessionDeps({ readFile }))).toEqual([])
  })

  it('returns [] (never throws) when parsing fails', async () => {
    const parse = () => {
      throw new Error('bad')
    }
    expect(await readSessionTranscript('C:/repo', 'codex', sessionDeps({ parse }))).toEqual([])
  })

  it('with default deps, an unsupported agent resolves no file → []', async () => {
    expect(await readSessionTranscript('C:/repo', 'unknown-agent')).toEqual([])
  })

  it('awaits an ASYNC findFile (codex/gemini resolve their newest session asynchronously)', async () => {
    const findFile = vi.fn(async () => '/deep/2026/02/05/rollout-x.jsonl')
    const turns = await readSessionTranscript('C:/repo', 'codex', sessionDeps({ findFile }))
    expect(findFile).toHaveBeenCalledWith('C:/repo', 'codex')
    expect(turns).toEqual([
      { role: 'user', text: 'fix the bug' },
      { role: 'assistant', text: 'fixed, tests pass now' },
    ])
  })
})

describe('default deps (production wiring, no deps argument)', () => {
  beforeEach(() => {
    mockFsReadFile.mockReset()
    mockFindLatestSessionFile.mockReset()
    mockFindLatestTranscriptFile.mockReset()
    mockParseClaudeTranscript.mockReset()
    mockParseBySource.mockReset()
  })

  describe('readActiveTranscript / defaultDeps', () => {
    it('resolves the cwd session with findLatestSessionFile, reads it as UTF-8, parses with parseClaudeTranscript', async () => {
      mockFindLatestSessionFile.mockReturnValue('C:/projects/-c--repo/abc.jsonl')
      mockFsReadFile.mockResolvedValue('{"type":"user"}\n')
      mockParseClaudeTranscript.mockReturnValue([
        { role: 'user', text: 'where did I set the port?', ts: 11 },
        { role: 'assistant', text: 'in config.ts', ts: 12 },
      ])

      const turns = await readActiveTranscript('C:/repo', 'claude')

      expect(mockFindLatestSessionFile).toHaveBeenCalledWith('C:/repo')
      // utf8 is load-bearing: without it fsp.readFile hands back a Buffer and the parser
      // would receive "[object Object]" instead of JSONL.
      expect(mockFsReadFile).toHaveBeenCalledWith('C:/projects/-c--repo/abc.jsonl', 'utf8')
      expect(mockParseClaudeTranscript).toHaveBeenCalledWith('{"type":"user"}\n')
      expect(turns).toEqual([
        { role: 'user', text: 'where did I set the port?', ts: 11 },
        { role: 'assistant', text: 'in config.ts', ts: 12 },
      ])
    })

    it('swallows a session file that vanished mid-read: fs rejection → [], parser never runs', async () => {
      mockFindLatestSessionFile.mockReturnValue('C:/gone.jsonl')
      mockFsReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      await expect(readActiveTranscript('C:/repo', 'claude')).resolves.toEqual([])
      expect(mockParseClaudeTranscript).not.toHaveBeenCalled()
    })

    it('never touches the filesystem when the cwd has no Claude session directory', async () => {
      mockFindLatestSessionFile.mockReturnValue(null)

      await expect(readActiveTranscript('C:/repo', 'claude')).resolves.toEqual([])
      expect(mockFsReadFile).not.toHaveBeenCalled()
    })

    it('substitutes ts 0 for legacy rows the parser emits without a timestamp, per turn', async () => {
      mockFindLatestSessionFile.mockReturnValue('C:/s.jsonl')
      mockFsReadFile.mockResolvedValue('RAW')
      mockParseClaudeTranscript.mockReturnValue([
        { role: 'user', text: 'legacy row' }, // pre-timestamp transcript line: ts is absent
        { role: 'assistant', text: 'timestamped row', ts: 42 },
      ])

      expect(await readActiveTranscript('C:/repo', 'claude')).toEqual([
        { role: 'user', text: 'legacy row', ts: 0 },
        { role: 'assistant', text: 'timestamped row', ts: 42 },
      ])
    })

    it('short-circuits a non-Claude agent before consulting the real finder', async () => {
      await expect(readActiveTranscript('C:/repo', 'codex')).resolves.toEqual([])
      expect(mockFindLatestSessionFile).not.toHaveBeenCalled()
      expect(mockFsReadFile).not.toHaveBeenCalled()
    })
  })

  describe('readSessionTranscript / defaultSessionDeps', () => {
    it("routes 'claude' to the per-cwd finder and parses via parseBySource, dropping ts", async () => {
      mockFindLatestSessionFile.mockReturnValue('C:/claude/sess.jsonl')
      mockFsReadFile.mockResolvedValue('CLAUDE-JSONL')
      mockParseBySource.mockReturnValue([{ role: 'user', text: 'ship it', ts: 3 }])

      const turns = await readSessionTranscript('C:/repo', 'claude')

      expect(mockFindLatestSessionFile).toHaveBeenCalledWith('C:/repo')
      expect(mockFindLatestTranscriptFile).not.toHaveBeenCalled()
      expect(mockFsReadFile).toHaveBeenCalledWith('C:/claude/sess.jsonl', 'utf8')
      expect(mockParseBySource).toHaveBeenCalledWith('claude', 'CLAUDE-JSONL')
      expect(turns).toEqual([{ role: 'user', text: 'ship it' }])
    })

    it("routes 'codex' to the indexer's newest-transcript discovery, ignoring cwd", async () => {
      mockFindLatestTranscriptFile.mockResolvedValue('C:/codex/sessions/2026/02/05/rollout-x.jsonl')
      mockFsReadFile.mockResolvedValue('CODEX-JSONL')
      mockParseBySource.mockReturnValue([{ role: 'assistant', text: 'done' }])

      const turns = await readSessionTranscript('C:/repo', 'codex')

      // one argument only — the default root is what knows the nested rollout layout
      expect(mockFindLatestTranscriptFile).toHaveBeenCalledWith('codex')
      expect(mockFindLatestSessionFile).not.toHaveBeenCalled()
      expect(mockFsReadFile).toHaveBeenCalledWith('C:/codex/sessions/2026/02/05/rollout-x.jsonl', 'utf8')
      expect(mockParseBySource).toHaveBeenCalledWith('codex', 'CODEX-JSONL')
      expect(turns).toEqual([{ role: 'assistant', text: 'done' }])
    })

    it("routes 'gemini' to the indexer's newest-transcript discovery, ignoring cwd", async () => {
      mockFindLatestTranscriptFile.mockResolvedValue('C:/gemini/tmp/proj/chats/session-1.json')
      mockFsReadFile.mockResolvedValue('GEMINI-JSON')
      mockParseBySource.mockReturnValue([{ role: 'user', text: 'hi' }])

      const turns = await readSessionTranscript('C:/repo', 'gemini')

      expect(mockFindLatestTranscriptFile).toHaveBeenCalledWith('gemini')
      expect(mockFindLatestSessionFile).not.toHaveBeenCalled()
      expect(mockParseBySource).toHaveBeenCalledWith('gemini', 'GEMINI-JSON')
      expect(turns).toEqual([{ role: 'user', text: 'hi' }])
    })

    it('returns [] without reading when the async finder has no codex session yet', async () => {
      mockFindLatestTranscriptFile.mockResolvedValue(null)

      await expect(readSessionTranscript('C:/repo', 'codex')).resolves.toEqual([])
      expect(mockFsReadFile).not.toHaveBeenCalled()
      expect(mockParseBySource).not.toHaveBeenCalled()
    })

    it('swallows a locked/unreadable session file under default deps', async () => {
      mockFindLatestTranscriptFile.mockResolvedValue('C:/codex/rollout.jsonl')
      mockFsReadFile.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))

      await expect(readSessionTranscript('C:/repo', 'codex')).resolves.toEqual([])
      expect(mockParseBySource).not.toHaveBeenCalled()
    })

    it('swallows a parseBySource throw on a half-written transcript under default deps', async () => {
      mockFindLatestSessionFile.mockReturnValue('C:/claude/sess.jsonl')
      mockFsReadFile.mockResolvedValue('{{{ not json')
      mockParseBySource.mockImplementation(() => {
        throw new Error('bad jsonl')
      })

      await expect(readSessionTranscript('C:/repo', 'claude')).resolves.toEqual([])
      expect(mockParseBySource).toHaveBeenCalledWith('claude', '{{{ not json')
    })

    it('consults no finder at all for an agent with no known session layout', async () => {
      await expect(readSessionTranscript('C:/repo', 'aider')).resolves.toEqual([])
      expect(mockFindLatestSessionFile).not.toHaveBeenCalled()
      expect(mockFindLatestTranscriptFile).not.toHaveBeenCalled()
      expect(mockFsReadFile).not.toHaveBeenCalled()
    })
  })
})

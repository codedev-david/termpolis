import { describe, it, expect, vi, beforeEach } from 'vitest'

// The DEFAULT deps (defaultDeps / defaultSessionDeps) are the production wiring: which
// discovery function each agent is routed to, and that the file is read as utf8. The
// suites below that inject deps can never exercise that wiring, so mock the three modules
// liveTranscript imports and drive it with no deps argument at all.
const {
  mockFsReadFile,
  mockListSessionFiles,
  mockNewestTranscriptFiles,
  mockParseClaudeTranscript,
  mockParseBySource,
} = vi.hoisted(() => ({
  mockFsReadFile: vi.fn(),
  mockListSessionFiles: vi.fn(),
  mockNewestTranscriptFiles: vi.fn(),
  mockParseClaudeTranscript: vi.fn(),
  mockParseBySource: vi.fn(),
}))

vi.mock('fs', () => ({
  promises: { readFile: mockFsReadFile },
  default: { promises: { readFile: mockFsReadFile } },
}))
vi.mock('../../src/main/transcriptWatchers/claudeCodeWatcher', () => ({
  listSessionFiles: mockListSessionFiles,
}))
vi.mock('../../src/main/conversationIngest', () => ({
  parseClaudeTranscript: mockParseClaudeTranscript,
  parseBySource: mockParseBySource,
  newestTranscriptFiles: mockNewestTranscriptFiles,
}))

import {
  MAX_SESSION_CANDIDATES,
  readActiveTranscript,
  readSessionTranscript,
  type TranscriptDeps,
  type SessionTranscriptDeps,
} from '../../src/main/liveTranscript'
import { PRIMER_CLOSE, PRIMER_OPEN, PRIMER_PREFACE, delegationHeader } from '../../src/shared/headlessPrompt'

/** The opening prompt of a job another computer ran here, as its CLI saved it. */
const DELEGATED = `${delegationHeader('laptop', '/home/me/repo')}\n\nReview the parser.`
/** The opening prompt of a local `termpolis exec` run, primer and all (headlessExec's shape; this
 *  file mocks fs, so headlessExec itself is not loaded here). */
const PRIMED = [PRIMER_OPEN, ...PRIMER_PREFACE, '', '- [claude · 2d ago] the parser lives in src/parse.ts', PRIMER_CLOSE, '', 'List the open TODOs.'].join('\n')

function deps(over: Partial<TranscriptDeps> = {}): TranscriptDeps {
  return {
    findFiles: () => ['/fake/session.jsonl'],
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

  it('reads the newest file findFiles lists for the cwd and parses its content', async () => {
    const findFiles = vi.fn(() => ['/x/session.jsonl', '/x/older.jsonl'])
    const readFile = vi.fn(async () => 'CONTENT')
    const parse = vi.fn(() => [{ role: 'user' as const, text: 'q', ts: 5 }])
    const turns = await readActiveTranscript('C:/repo', 'claude', deps({ findFiles, readFile, parse }))
    expect(findFiles).toHaveBeenCalledWith('C:/repo')
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith('/x/session.jsonl')
    expect(parse).toHaveBeenCalledWith('CONTENT')
    expect(turns).toEqual([{ role: 'user', text: 'q', ts: 5 }])
  })

  it('passes over a newer session another computer started here and shows the own one under it', async () => {
    const files: Record<string, string> = { '/x/job.jsonl': 'JOB', '/x/mine.jsonl': 'MINE' }
    const readFile = vi.fn(async (f: string) => files[f])
    const parse = (content: string) =>
      content === 'JOB'
        ? [{ role: 'user' as const, text: DELEGATED, ts: 9 }, { role: 'assistant' as const, text: 'reviewed', ts: 10 }]
        : [{ role: 'user' as const, text: 'where did I set the port?', ts: 3 }]
    const turns = await readActiveTranscript('C:/repo', 'claude', deps({ findFiles: () => ['/x/job.jsonl', '/x/mine.jsonl'], readFile, parse }))
    expect(readFile.mock.calls.map(([f]) => f)).toEqual(['/x/job.jsonl', '/x/mine.jsonl'])
    expect(turns).toEqual([{ role: 'user', text: 'where did I set the port?', ts: 3 }])
  })

  it(`reads at most ${MAX_SESSION_CANDIDATES} sessions, and returns [] when all of them are delegated`, async () => {
    const all = Array.from({ length: MAX_SESSION_CANDIDATES + 2 }, (_, i) => `/x/job-${i}.jsonl`)
    const readFile = vi.fn(async () => 'JOB')
    const parse = () => [{ role: 'user' as const, text: DELEGATED, ts: 1 }]
    expect(await readActiveTranscript('C:/repo', 'claude', deps({ findFiles: () => all, readFile, parse }))).toEqual([])
    expect(readFile).toHaveBeenCalledTimes(MAX_SESSION_CANDIDATES)
  })

  it("leaves a headless run's memory primer out of its opening turn", async () => {
    const parse = () => [
      { role: 'user' as const, text: PRIMED, ts: 1 },
      { role: 'assistant' as const, text: 'Two TODOs.', ts: 2 },
    ]
    expect(await readActiveTranscript('C:/repo', 'claude', deps({ parse }))).toEqual([
      { role: 'user', text: 'List the open TODOs.', ts: 1 },
      { role: 'assistant', text: 'Two TODOs.', ts: 2 },
    ])
  })

  it('returns [] for a non-Claude agent without touching the filesystem', async () => {
    const findFiles = vi.fn(() => ['/x.jsonl'])
    expect(await readActiveTranscript('C:/repo', 'codex', deps({ findFiles }))).toEqual([])
    expect(findFiles).not.toHaveBeenCalled()
  })

  it('returns [] when cwd is empty', async () => {
    expect(await readActiveTranscript('', 'claude', deps())).toEqual([])
  })

  it('returns [] when no session file is found', async () => {
    expect(await readActiveTranscript('C:/repo', 'claude', deps({ findFiles: () => [] }))).toEqual([])
  })

  it('returns [] (never throws) when the newest session file is unreadable, rather than reading an older one', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const findFiles = () => ['/x/new.jsonl', '/x/old.jsonl']
    expect(await readActiveTranscript('C:/repo', 'claude', deps({ findFiles, readFile }))).toEqual([])
    expect(readFile).toHaveBeenCalledTimes(1)
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
    findFiles: () => ['/fake/rollout.jsonl'],
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

  it('threads the agent through to both findFiles and parse', async () => {
    const findFiles = vi.fn(() => ['/x/session.json'])
    const parse = vi.fn(() => [{ role: 'assistant' as const, text: 'ok' }])
    await readSessionTranscript('C:/repo', 'gemini', sessionDeps({ findFiles, parse }))
    expect(findFiles).toHaveBeenCalledWith('C:/repo', 'gemini')
    expect(parse).toHaveBeenCalledWith('gemini', 'CONTENT')
  })

  it('learns from the newest session that is not a job another computer ran here', async () => {
    const files: Record<string, string> = { '/r/job.jsonl': 'JOB', '/r/mine.jsonl': 'MINE' }
    const parse = (_agent: string, content: string) =>
      content === 'JOB'
        ? [{ role: 'user' as const, text: '<environment_context>cwd=/r</environment_context>' }, { role: 'user' as const, text: DELEGATED }]
        : [{ role: 'user' as const, text: 'fix the flaky test' }, { role: 'assistant' as const, text: 'fixed' }]
    const turns = await readSessionTranscript('C:/repo', 'codex', sessionDeps({
      findFiles: async () => ['/r/job.jsonl', '/r/mine.jsonl'],
      readFile: async (f) => files[f],
      parse,
    }))
    expect(turns).toEqual([{ role: 'user', text: 'fix the flaky test' }, { role: 'assistant', text: 'fixed' }])
  })

  it('does not learn the memory primer a headless run opened with', async () => {
    const parse = () => [{ role: 'user' as const, text: PRIMED }, { role: 'assistant' as const, text: 'Two TODOs.' }]
    expect(await readSessionTranscript('C:/repo', 'claude', sessionDeps({ parse }))).toEqual([
      { role: 'user', text: 'List the open TODOs.' },
      { role: 'assistant', text: 'Two TODOs.' },
    ])
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
    expect(await readSessionTranscript('C:/repo', 'codex', sessionDeps({ findFiles: () => [] }))).toEqual([])
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

  it('awaits an ASYNC findFiles (codex/gemini resolve their newest sessions asynchronously)', async () => {
    const findFiles = vi.fn(async () => ['/deep/2026/02/05/rollout-x.jsonl'])
    const turns = await readSessionTranscript('C:/repo', 'codex', sessionDeps({ findFiles }))
    expect(findFiles).toHaveBeenCalledWith('C:/repo', 'codex')
    expect(turns).toEqual([
      { role: 'user', text: 'fix the bug' },
      { role: 'assistant', text: 'fixed, tests pass now' },
    ])
  })
})

describe('default deps (production wiring, no deps argument)', () => {
  beforeEach(() => {
    mockFsReadFile.mockReset()
    mockListSessionFiles.mockReset()
    mockNewestTranscriptFiles.mockReset()
    mockParseClaudeTranscript.mockReset()
    mockParseBySource.mockReset()
  })

  describe('readActiveTranscript / defaultDeps', () => {
    it('resolves the cwd sessions with listSessionFiles, reads the newest as UTF-8, parses with parseClaudeTranscript', async () => {
      mockListSessionFiles.mockReturnValue(['C:/projects/-c--repo/abc.jsonl', 'C:/projects/-c--repo/older.jsonl'])
      mockFsReadFile.mockResolvedValue('{"type":"user"}\n')
      mockParseClaudeTranscript.mockReturnValue([
        { role: 'user', text: 'where did I set the port?', ts: 11 },
        { role: 'assistant', text: 'in config.ts', ts: 12 },
      ])

      const turns = await readActiveTranscript('C:/repo', 'claude')

      expect(mockListSessionFiles).toHaveBeenCalledWith('C:/repo')
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
      mockListSessionFiles.mockReturnValue(['C:/gone.jsonl'])
      mockFsReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      await expect(readActiveTranscript('C:/repo', 'claude')).resolves.toEqual([])
      expect(mockParseClaudeTranscript).not.toHaveBeenCalled()
    })

    it('never touches the filesystem when the cwd has no Claude session directory', async () => {
      mockListSessionFiles.mockReturnValue([])

      await expect(readActiveTranscript('C:/repo', 'claude')).resolves.toEqual([])
      expect(mockFsReadFile).not.toHaveBeenCalled()
    })

    it('substitutes ts 0 for legacy rows the parser emits without a timestamp, per turn', async () => {
      mockListSessionFiles.mockReturnValue(['C:/s.jsonl'])
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
      expect(mockListSessionFiles).not.toHaveBeenCalled()
      expect(mockFsReadFile).not.toHaveBeenCalled()
    })
  })

  describe('readSessionTranscript / defaultSessionDeps', () => {
    it("routes 'claude' to the per-cwd finder and parses via parseBySource, dropping ts", async () => {
      mockListSessionFiles.mockReturnValue(['C:/claude/sess.jsonl'])
      mockFsReadFile.mockResolvedValue('CLAUDE-JSONL')
      mockParseBySource.mockReturnValue([{ role: 'user', text: 'ship it', ts: 3 }])

      const turns = await readSessionTranscript('C:/repo', 'claude')

      expect(mockListSessionFiles).toHaveBeenCalledWith('C:/repo')
      expect(mockNewestTranscriptFiles).not.toHaveBeenCalled()
      expect(mockFsReadFile).toHaveBeenCalledWith('C:/claude/sess.jsonl', 'utf8')
      expect(mockParseBySource).toHaveBeenCalledWith('claude', 'CLAUDE-JSONL')
      expect(turns).toEqual([{ role: 'user', text: 'ship it' }])
    })

    it("routes 'codex' to the indexer's newest-transcript discovery, ignoring cwd", async () => {
      mockNewestTranscriptFiles.mockResolvedValue(['C:/codex/sessions/2026/02/05/rollout-x.jsonl'])
      mockFsReadFile.mockResolvedValue('CODEX-JSONL')
      mockParseBySource.mockReturnValue([{ role: 'assistant', text: 'done' }])

      const turns = await readSessionTranscript('C:/repo', 'codex')

      // no root — the default root is what knows the nested rollout layout
      expect(mockNewestTranscriptFiles).toHaveBeenCalledWith('codex', MAX_SESSION_CANDIDATES)
      expect(mockListSessionFiles).not.toHaveBeenCalled()
      expect(mockFsReadFile).toHaveBeenCalledWith('C:/codex/sessions/2026/02/05/rollout-x.jsonl', 'utf8')
      expect(mockParseBySource).toHaveBeenCalledWith('codex', 'CODEX-JSONL')
      expect(turns).toEqual([{ role: 'assistant', text: 'done' }])
    })

    it("routes 'gemini' to the indexer's newest-transcript discovery, ignoring cwd", async () => {
      mockNewestTranscriptFiles.mockResolvedValue(['C:/gemini/tmp/proj/chats/session-1.json'])
      mockFsReadFile.mockResolvedValue('GEMINI-JSON')
      mockParseBySource.mockReturnValue([{ role: 'user', text: 'hi' }])

      const turns = await readSessionTranscript('C:/repo', 'gemini')

      expect(mockNewestTranscriptFiles).toHaveBeenCalledWith('gemini', MAX_SESSION_CANDIDATES)
      expect(mockListSessionFiles).not.toHaveBeenCalled()
      expect(mockParseBySource).toHaveBeenCalledWith('gemini', 'GEMINI-JSON')
      expect(turns).toEqual([{ role: 'user', text: 'hi' }])
    })

    it('returns [] without reading when the async finder has no codex session yet', async () => {
      mockNewestTranscriptFiles.mockResolvedValue([])

      await expect(readSessionTranscript('C:/repo', 'codex')).resolves.toEqual([])
      expect(mockFsReadFile).not.toHaveBeenCalled()
      expect(mockParseBySource).not.toHaveBeenCalled()
    })

    it('swallows a locked/unreadable session file under default deps', async () => {
      mockNewestTranscriptFiles.mockResolvedValue(['C:/codex/rollout.jsonl'])
      mockFsReadFile.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))

      await expect(readSessionTranscript('C:/repo', 'codex')).resolves.toEqual([])
      expect(mockParseBySource).not.toHaveBeenCalled()
    })

    it('swallows a parseBySource throw on a half-written transcript under default deps', async () => {
      mockListSessionFiles.mockReturnValue(['C:/claude/sess.jsonl'])
      mockFsReadFile.mockResolvedValue('{{{ not json')
      mockParseBySource.mockImplementation(() => {
        throw new Error('bad jsonl')
      })

      await expect(readSessionTranscript('C:/repo', 'claude')).resolves.toEqual([])
      expect(mockParseBySource).toHaveBeenCalledWith('claude', '{{{ not json')
    })

    it('consults no finder at all for an agent with no known session layout', async () => {
      await expect(readSessionTranscript('C:/repo', 'aider')).resolves.toEqual([])
      expect(mockListSessionFiles).not.toHaveBeenCalled()
      expect(mockNewestTranscriptFiles).not.toHaveBeenCalled()
      expect(mockFsReadFile).not.toHaveBeenCalled()
    })
  })
})

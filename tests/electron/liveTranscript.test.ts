import { describe, it, expect, vi } from 'vitest'
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

  it('with default deps, an unsupported agent (qwen) resolves no file → []', async () => {
    expect(await readSessionTranscript('C:/repo', 'qwen')).toEqual([])
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

import { describe, it, expect, vi } from 'vitest'
import { readActiveTranscript, type TranscriptDeps } from '../../src/main/liveTranscript'

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

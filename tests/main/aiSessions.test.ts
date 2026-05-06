import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listAISessions, digestAISession, renderDigestAsPrompt } from '../../src/main/aiSessions'

let projectsRoot: string
const list = () => listAISessions({ projectsRoot })

function makeSession(folder: string, id: string, lines: object[]) {
  const dir = join(projectsRoot, folder)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, id + '.jsonl')
  writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return filePath
}

describe('listAISessions', () => {
  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'aisessions-'))
  })
  afterEach(() => {
    try { rmSync(projectsRoot, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('returns empty array when ~/.claude/projects/ does not exist', () => {
    expect(list()).toEqual([])
  })

  it('summarizes a basic session with cwd, branch, version, first user message', () => {
    makeSession('C--Users-foo-bar-myrepo', 'sess-1', [
      { type: 'permission-mode', sessionId: 'sess-1' },
      {
        type: 'user',
        message: { role: 'user', content: 'fix the bug in auth.ts' },
        cwd: 'C:\\Users\\foo\\bar\\myrepo',
        gitBranch: 'main',
        version: '1.0.99',
        timestamp: '2026-05-06T10:00:00Z',
      },
    ])
    const sessions = list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'sess-1',
      cwd: 'C:\\Users\\foo\\bar\\myrepo',
      gitBranch: 'main',
      version: '1.0.99',
      firstUserMessage: 'fix the bug in auth.ts',
      startTime: '2026-05-06T10:00:00Z',
    })
    expect(sessions[0].sizeBytes).toBeGreaterThan(0)
  })

  it('skips sessions without a cwd (cannot resume confidently)', () => {
    makeSession('orphan', 'sess-2', [
      { type: 'permission-mode', sessionId: 'sess-2' },
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ])
    expect(list()).toHaveLength(0)
  })

  it('extracts text from array-shape content blocks', () => {
    makeSession('C--repos-x', 'sess-3', [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'array-shape message' }] },
        cwd: '/repos/x',
      },
    ])
    const [s] = list()
    expect(s.firstUserMessage).toBe('array-shape message')
  })

  it('truncates long first messages to 240 chars', () => {
    const long = 'a'.repeat(500)
    makeSession('C--repos-y', 'sess-4', [
      { type: 'user', message: { role: 'user', content: long }, cwd: '/repos/y' },
    ])
    const [s] = list()
    expect(s.firstUserMessage!.length).toBeLessThanOrEqual(240)
    expect(s.firstUserMessage!.endsWith('...')).toBe(true)
  })

  it('ignores synthetic <command-name> entries when picking first user message', () => {
    makeSession('C--repos-z', 'sess-5', [
      { type: 'user', message: { role: 'user', content: '<command-name>/exit</command-name>' }, cwd: '/repos/z' },
      { type: 'user', message: { role: 'user', content: 'real prompt' }, cwd: '/repos/z' },
    ])
    const [s] = list()
    expect(s.firstUserMessage).toBe('real prompt')
  })

  it('returns sessions sorted by lastModified descending', () => {
    makeSession('A', 'older', [{ type: 'user', message: { role: 'user', content: 'old' }, cwd: '/A' }])
    // Spread mtime — write file with backdated time.
    makeSession('B', 'newer', [{ type: 'user', message: { role: 'user', content: 'new' }, cwd: '/B' }])
    const sessions = list()
    expect(sessions.length).toBe(2)
    expect(sessions[0].lastModified).toBeGreaterThanOrEqual(sessions[1].lastModified)
  })

  it('skips non-jsonl files in project folders', () => {
    const dir = join(projectsRoot, 'C--repos-mixed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.txt'), 'not a session', 'utf8')
    writeFileSync(join(dir, 'real.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' }, cwd: '/repos/mixed' }) + '\n', 'utf8')
    const sessions = list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe('real')
  })
})

describe('digestAISession', () => {
  let tempRoot: string
  beforeEach(() => { tempRoot = mkdtempSync(join(tmpdir(), 'digest-')) })
  afterEach(() => { try { rmSync(tempRoot, { recursive: true, force: true }) } catch {} })

  function writeSession(filename: string, lines: object[]): string {
    const filePath = join(tempRoot, filename)
    writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8')
    return filePath
  }

  it('returns null when filePath does not exist', () => {
    expect(digestAISession(join(tempRoot, 'nope.jsonl'))).toBeNull()
  })

  it('returns null when no cwd is recoverable from the session', () => {
    const fp = writeSession('orphan.jsonl', [
      { type: 'user', message: { role: 'user', content: 'no cwd here' } },
    ])
    expect(digestAISession(fp)).toBeNull()
  })

  it('captures cwd, branch, version, first message, recent user msgs, last assistant text', () => {
    const fp = writeSession('rich.jsonl', [
      { type: 'permission-mode', sessionId: 'rich' },
      { type: 'user', message: { role: 'user', content: 'first goal' }, cwd: '/repos/proj', gitBranch: 'main', version: '1.2.3' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
      { type: 'user', message: { role: 'user', content: 'second nudge' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second reply (current)' }] } },
      { type: 'user', message: { role: 'user', content: 'third nudge' } },
    ])
    const d = digestAISession(fp)!
    expect(d).toBeTruthy()
    expect(d.cwd).toBe('/repos/proj')
    expect(d.gitBranch).toBe('main')
    expect(d.version).toBe('1.2.3')
    expect(d.firstUserMessage).toBe('first goal')
    expect(d.recentUserMessages.slice(-3)).toEqual(['first goal', 'second nudge', 'third nudge'])
    expect(d.lastAssistantText).toBe('second reply (current)')
    expect(d.totalUserTurns).toBe(3)
    expect(d.totalAssistantTurns).toBe(2)
  })

  it('ignores synthetic <command-name> entries when picking first user message', () => {
    const fp = writeSession('syn.jsonl', [
      { type: 'user', message: { role: 'user', content: '<command-name>/exit</command-name>' }, cwd: '/x' },
      { type: 'user', message: { role: 'user', content: 'real prompt' }, cwd: '/x' },
    ])
    const d = digestAISession(fp)!
    expect(d.firstUserMessage).toBe('real prompt')
  })

  it('truncates very long user messages to MAX_PREVIEW_CHARS', () => {
    const long = 'x'.repeat(5000)
    const fp = writeSession('long.jsonl', [
      { type: 'user', message: { role: 'user', content: long }, cwd: '/x' },
    ])
    const d = digestAISession(fp)!
    expect(d.firstUserMessage!.length).toBeLessThan(5000)
    expect(d.firstUserMessage!.endsWith('...')).toBe(true)
  })

  it('skips malformed JSON lines without aborting', () => {
    const filePath = join(tempRoot, 'mixed.jsonl')
    const goodLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'good' }, cwd: '/x' })
    writeFileSync(filePath, '{not json\n' + goodLine + '\n', 'utf8')
    const d = digestAISession(filePath)!
    expect(d.firstUserMessage).toBe('good')
  })
})

describe('renderDigestAsPrompt', () => {
  it('produces a plain-text handoff prompt with goal, recent direction, and last reply', () => {
    const out = renderDigestAsPrompt({
      id: 'sess-x',
      filePath: '/p/sess-x.jsonl',
      cwd: '/repos/proj',
      gitBranch: 'feat/rewrite',
      version: '1.0.0',
      firstUserMessage: 'rewrite the auth module',
      recentUserMessages: ['rewrite the auth module', 'use httpOnly cookies', 'add CSRF tests'],
      lastAssistantText: 'I added CSRF middleware in src/auth/csrf.ts; remaining: write integration tests.',
      totalUserTurns: 3,
      totalAssistantTurns: 2,
    })
    expect(out).toContain('Context handoff')
    expect(out).toContain('/repos/proj')
    expect(out).toContain('feat/rewrite')
    expect(out).toContain('rewrite the auth module')
    expect(out).toContain('CSRF middleware')
    // No backticks (would be parsed as command substitution if pasted into bash)
    expect(out).not.toContain('`')
  })

  it('omits sections when their data is missing', () => {
    const out = renderDigestAsPrompt({
      id: 'minimal',
      filePath: '/p/minimal.jsonl',
      cwd: '/x',
      recentUserMessages: [],
      totalUserTurns: 0,
      totalAssistantTurns: 0,
    })
    expect(out).toContain('Context handoff')
    expect(out).toContain('/x')
    expect(out).not.toContain('Original goal')
    expect(out).not.toContain('Last assistant turn')
  })
})

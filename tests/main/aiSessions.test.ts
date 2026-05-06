import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listAISessions } from '../../src/main/aiSessions'

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

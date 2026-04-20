import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Additional attach-path tests for transcript watchers.
 * Uses HOME/USERPROFILE env vars + module resets to make the watchers read
 * a temp directory instead of the real user home.
 */

let tmpHome: string
let origHome: string | undefined
let origUserProfile: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-watchers-attach-'))
  origHome = process.env.HOME
  origUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  vi.resetModules()
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = origUserProfile
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  vi.resetModules()
})

describe('claudeCodeWatcher attach (success path)', () => {
  it('findLatestSessionFile returns newest jsonl when dir has files', async () => {
    const { mangleCwd, findLatestSessionFile } = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
    const cwd = '/test-project'
    const mangled = mangleCwd(cwd)
    const dir = path.join(tmpHome, '.claude', 'projects', mangled)
    fs.mkdirSync(dir, { recursive: true })
    const a = path.join(dir, 'old.jsonl')
    const b = path.join(dir, 'new.jsonl')
    fs.writeFileSync(a, '{}\n')
    // Wait a hair, then write b so mtime differs
    const pastMs = Date.now() - 10000
    fs.utimesSync(a, pastMs / 1000, pastMs / 1000)
    fs.writeFileSync(b, '{}\n')
    const result = findLatestSessionFile(cwd)
    expect(result).toBe(b)
  })

  it('findLatestSessionFile filters non-jsonl entries', async () => {
    const { mangleCwd, findLatestSessionFile } = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
    const cwd = '/test-project-2'
    const mangled = mangleCwd(cwd)
    const dir = path.join(tmpHome, '.claude', 'projects', mangled)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.txt'), 'nope')
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '{}\n')
    const result = findLatestSessionFile(cwd)
    expect(result).toMatch(/a\.jsonl$/)
  })

  it('findLatestSessionFile returns null if dir is not a directory', async () => {
    const { mangleCwd, findLatestSessionFile } = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
    const cwd = '/test-not-a-dir'
    const mangled = mangleCwd(cwd)
    const fileInsteadOfDir = path.join(tmpHome, '.claude', 'projects', mangled)
    fs.mkdirSync(path.dirname(fileInsteadOfDir), { recursive: true })
    fs.writeFileSync(fileInsteadOfDir, 'file not dir')
    expect(findLatestSessionFile(cwd)).toBeNull()
  })

  it('findLatestSessionFile returns null when dir exists but is empty', async () => {
    const { mangleCwd, findLatestSessionFile } = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
    const cwd = '/test-empty'
    const mangled = mangleCwd(cwd)
    const dir = path.join(tmpHome, '.claude', 'projects', mangled)
    fs.mkdirSync(dir, { recursive: true })
    expect(findLatestSessionFile(cwd)).toBeNull()
  })

  it('attachClaudeCodeWatcher returns handle when session file exists', async () => {
    const { mangleCwd, attachClaudeCodeWatcher } = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
    const cwd = '/test-attach'
    const mangled = mangleCwd(cwd)
    const dir = path.join(tmpHome, '.claude', 'projects', mangled)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.jsonl'), '')
    const handle = attachClaudeCodeWatcher('t1', cwd)
    expect(handle).not.toBeNull()
    handle?.stop()
  })

  it('mangleCwd returns empty string for empty input', async () => {
    const { mangleCwd } = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
    expect(mangleCwd('')).toBe('')
  })

  it('mangleCwd converts backslashes and slashes to dashes', async () => {
    const { mangleCwd } = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
    expect(mangleCwd('C:\\foo\\bar')).toBe('C--foo-bar')
    expect(mangleCwd('/home/u/r')).toBe('-home-u-r')
  })
})

describe('codexWatcher attach (success path)', () => {
  it('findLatestCodexSessionFile returns newest when files present', async () => {
    const { findLatestCodexSessionFile, CODEX_SESSIONS_DIR } = await import('../../src/main/transcriptWatchers/codexWatcher')
    fs.mkdirSync(CODEX_SESSIONS_DIR, { recursive: true })
    const a = path.join(CODEX_SESSIONS_DIR, 'a.jsonl')
    const b = path.join(CODEX_SESSIONS_DIR, 'b.jsonl')
    fs.writeFileSync(a, '')
    const past = Date.now() - 20000
    fs.utimesSync(a, past / 1000, past / 1000)
    fs.writeFileSync(b, '')
    const result = findLatestCodexSessionFile()
    expect(result).toBe(b)
  })

  it('findLatestCodexSessionFile walks one level into subdirectories', async () => {
    const { findLatestCodexSessionFile, CODEX_SESSIONS_DIR } = await import('../../src/main/transcriptWatchers/codexWatcher')
    const sub = path.join(CODEX_SESSIONS_DIR, '2026-04-19')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'session.jsonl'), '')
    const result = findLatestCodexSessionFile()
    expect(result).toMatch(/session\.jsonl$/)
  })

  it('findLatestCodexSessionFile returns null when sessions dir missing', async () => {
    const { findLatestCodexSessionFile } = await import('../../src/main/transcriptWatchers/codexWatcher')
    expect(findLatestCodexSessionFile()).toBeNull()
  })

  it('findLatestCodexSessionFile filters non-jsonl files', async () => {
    const { findLatestCodexSessionFile, CODEX_SESSIONS_DIR } = await import('../../src/main/transcriptWatchers/codexWatcher')
    fs.mkdirSync(CODEX_SESSIONS_DIR, { recursive: true })
    fs.writeFileSync(path.join(CODEX_SESSIONS_DIR, 'ignore.txt'), 'nope')
    fs.writeFileSync(path.join(CODEX_SESSIONS_DIR, 'a.jsonl'), '')
    const result = findLatestCodexSessionFile()
    expect(result).toMatch(/a\.jsonl$/)
  })

  it('attachCodexWatcher returns handle when session file exists', async () => {
    const { attachCodexWatcher, CODEX_SESSIONS_DIR } = await import('../../src/main/transcriptWatchers/codexWatcher')
    fs.mkdirSync(CODEX_SESSIONS_DIR, { recursive: true })
    fs.writeFileSync(path.join(CODEX_SESSIONS_DIR, 'session.jsonl'), '')
    const handle = attachCodexWatcher('t1')
    expect(handle).not.toBeNull()
    handle?.stop()
  })
})

describe('geminiWatcher attach (success path)', () => {
  it('findLatestGeminiSessionFile returns file at top level', async () => {
    const { findLatestGeminiSessionFile, GEMINI_DIR } = await import('../../src/main/transcriptWatchers/geminiWatcher')
    fs.mkdirSync(GEMINI_DIR, { recursive: true })
    fs.writeFileSync(path.join(GEMINI_DIR, 'session.jsonl'), '')
    const result = findLatestGeminiSessionFile()
    expect(result).toMatch(/session\.jsonl$/)
  })

  it('findLatestGeminiSessionFile walks into subdirectories up to depth 2', async () => {
    const { findLatestGeminiSessionFile, GEMINI_DIR } = await import('../../src/main/transcriptWatchers/geminiWatcher')
    const sub = path.join(GEMINI_DIR, 'tmp', 'sessions')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'chat.jsonl'), '')
    const result = findLatestGeminiSessionFile()
    expect(result).toMatch(/chat\.jsonl$/)
  })

  it('findLatestGeminiSessionFile returns newest among multiple', async () => {
    const { findLatestGeminiSessionFile, GEMINI_DIR } = await import('../../src/main/transcriptWatchers/geminiWatcher')
    fs.mkdirSync(GEMINI_DIR, { recursive: true })
    const a = path.join(GEMINI_DIR, 'old.jsonl')
    const b = path.join(GEMINI_DIR, 'new.jsonl')
    fs.writeFileSync(a, '')
    const past = Date.now() - 20000
    fs.utimesSync(a, past / 1000, past / 1000)
    fs.writeFileSync(b, '')
    const result = findLatestGeminiSessionFile()
    expect(result).toBe(b)
  })

  it('findLatestGeminiSessionFile returns null when dir missing', async () => {
    const { findLatestGeminiSessionFile } = await import('../../src/main/transcriptWatchers/geminiWatcher')
    expect(findLatestGeminiSessionFile()).toBeNull()
  })

  it('attachGeminiWatcher returns handle when session file exists', async () => {
    const { attachGeminiWatcher, GEMINI_DIR } = await import('../../src/main/transcriptWatchers/geminiWatcher')
    fs.mkdirSync(GEMINI_DIR, { recursive: true })
    fs.writeFileSync(path.join(GEMINI_DIR, 'session.jsonl'), '')
    const handle = attachGeminiWatcher('t1')
    expect(handle).not.toBeNull()
    handle?.stop()
  })
})

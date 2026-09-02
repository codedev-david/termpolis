import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  trustClaudeWorkspace, claudeProjectKey, claudeConfigPath, __resetTrustCache,
} from '../../src/main/claudeTrust'

// Termpolis used to "auto-trust" Claude Code by typing a bare Enter at its
// workspace-trust dialog. Claude Code 2.1.x builds that dialog with
// `cancelFirst: true, focus: "cancel"`, so the Enter answered "No, exit" and
// quit the session — the launch looked cut off. Trust is a config value, so
// these tests pin down writing the config value instead of guessing a keystroke.

let dir: string
let configPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-trust-'))
  configPath = join(dir, '.claude.json')
  __resetTrustCache()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = (): any => JSON.parse(readFileSync(configPath, 'utf-8'))

describe('claudeProjectKey', () => {
  it('normalizes to an absolute forward-slash path with no trailing separator', () => {
    const key = claudeProjectKey(dir)
    expect(key).not.toContain('\\')
    expect(key.endsWith('/')).toBe(false)
  })

  it('keeps the slash on a bare drive root so "C:/" never collapses to "C:"', () => {
    if (process.platform !== 'win32') return
    expect(claudeProjectKey('C:\\')).toBe('C:/')
  })

  it('is stable across separator styles and trailing slashes', () => {
    const a = claudeProjectKey(dir)
    expect(claudeProjectKey(dir + (process.platform === 'win32' ? '\\' : '/'))).toBe(a)
    expect(claudeProjectKey(dir.replace(/\\/g, '/'))).toBe(a)
  })

  it('resolves a path that does not exist on disk rather than throwing', () => {
    const missing = join(dir, 'not-created-yet')
    expect(claudeProjectKey(missing)).toBe(missing.replace(/\\/g, '/'))
  })
})

describe('claudeConfigPath', () => {
  it('defaults to ~/.claude.json', () => {
    expect(claudeConfigPath({}, '/home/me')).toBe(join('/home/me', '.claude.json'))
  })

  it('honors CLAUDE_CONFIG_DIR so a second profile is seeded in its own file', () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/alt/profile' }, '/home/me'))
      .toBe(join('/alt/profile', '.claude.json'))
  })

  it('ignores a blank CLAUDE_CONFIG_DIR', () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: '   ' }, '/home/me')).toBe(join('/home/me', '.claude.json'))
  })
})

describe('trustClaudeWorkspace', () => {
  it('creates the config when Claude has never run, so the FIRST launch is covered too', () => {
    const res = trustClaudeWorkspace(dir, { configPath })
    expect(res.changed).toBe(true)
    expect(read().projects[claudeProjectKey(dir)].hasTrustDialogAccepted).toBe(true)
  })

  it('adds the flag to an existing config without disturbing anything else', () => {
    writeFileSync(configPath, JSON.stringify({
      numStartups: 42,
      projects: { '/other/repo': { hasTrustDialogAccepted: true, history: ['a'] } },
    }), 'utf-8')

    expect(trustClaudeWorkspace(dir, { configPath }).changed).toBe(true)
    const cfg = read()
    expect(cfg.numStartups).toBe(42)
    expect(cfg.projects['/other/repo']).toEqual({ hasTrustDialogAccepted: true, history: ['a'] })
    expect(cfg.projects[claudeProjectKey(dir)].hasTrustDialogAccepted).toBe(true)
  })

  it('preserves the rest of an existing project entry', () => {
    writeFileSync(configPath, JSON.stringify({
      projects: { [claudeProjectKey(dir)]: { history: ['prompt one'], mcpServers: { x: 1 } } },
    }), 'utf-8')

    expect(trustClaudeWorkspace(dir, { configPath }).changed).toBe(true)
    const entry = read().projects[claudeProjectKey(dir)]
    expect(entry.history).toEqual(['prompt one'])
    expect(entry.mcpServers).toEqual({ x: 1 })
    expect(entry.hasTrustDialogAccepted).toBe(true)
  })

  it('is idempotent — a second call writes nothing', () => {
    trustClaudeWorkspace(dir, { configPath })
    const second = trustClaudeWorkspace(dir, { configPath })
    expect(second.changed).toBe(false)
    expect(second.skipped).toBe('already-trusted')
  })

  it('does not write when the flag is already true (no read-modify-write race)', () => {
    writeFileSync(configPath, JSON.stringify({
      projects: { [claudeProjectKey(dir)]: { hasTrustDialogAccepted: true } },
    }), 'utf-8')
    const before = readFileSync(configPath, 'utf-8')

    expect(trustClaudeWorkspace(dir, { configPath }).changed).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })

  it('seeds the git root alongside the cwd', () => {
    const sub = join(dir, 'packages', 'app')
    mkdirSync(sub, { recursive: true })

    const res = trustClaudeWorkspace(sub, { alsoTrust: [dir], configPath })
    expect(res.changed).toBe(true)
    const projects = read().projects
    expect(projects[claudeProjectKey(sub)].hasTrustDialogAccepted).toBe(true)
    expect(projects[claudeProjectKey(dir)].hasTrustDialogAccepted).toBe(true)
  })

  it('dedupes when the cwd IS the git root', () => {
    const res = trustClaudeWorkspace(dir, { alsoTrust: [dir], configPath })
    expect(res.keys).toHaveLength(1)
  })

  it('ignores blank alsoTrust entries', () => {
    const res = trustClaudeWorkspace(dir, { alsoTrust: ['', '   '], configPath })
    expect(res.keys).toEqual([claudeProjectKey(dir)])
  })

  it('refuses an empty cwd instead of writing a garbage key', () => {
    const res = trustClaudeWorkspace('  ', { configPath })
    expect(res).toEqual({ changed: false, keys: [], skipped: 'no-cwd' })
  })

  it('never overwrites a config it could not parse', () => {
    writeFileSync(configPath, '{ this is not json', 'utf-8')

    const res = trustClaudeWorkspace(dir, { configPath })
    expect(res.changed).toBe(false)
    expect(res.skipped).toBe('corrupt')
    expect(readFileSync(configPath, 'utf-8')).toBe('{ this is not json')
  })

  it('treats a non-object config root as corrupt', () => {
    writeFileSync(configPath, '[1,2,3]', 'utf-8')
    expect(trustClaudeWorkspace(dir, { configPath }).skipped).toBe('corrupt')
  })

  it('treats an empty file as a fresh config rather than corruption', () => {
    writeFileSync(configPath, '   \n', 'utf-8')
    expect(trustClaudeWorkspace(dir, { configPath }).changed).toBe(true)
    expect(read().projects[claudeProjectKey(dir)].hasTrustDialogAccepted).toBe(true)
  })

  it('replaces a non-object projects map instead of crashing on it', () => {
    writeFileSync(configPath, JSON.stringify({ projects: 'nope' }), 'utf-8')
    expect(trustClaudeWorkspace(dir, { configPath }).changed).toBe(true)
    expect(read().projects[claudeProjectKey(dir)].hasTrustDialogAccepted).toBe(true)
  })

  it('replaces a non-object project entry', () => {
    writeFileSync(configPath, JSON.stringify({ projects: { [claudeProjectKey(dir)]: 'nope' } }), 'utf-8')
    expect(trustClaudeWorkspace(dir, { configPath }).changed).toBe(true)
    expect(read().projects[claudeProjectKey(dir)].hasTrustDialogAccepted).toBe(true)
  })

  it('reports a failed write rather than throwing into the terminal-create path', () => {
    // A directory where the config file should be: the write cannot succeed.
    mkdirSync(join(dir, 'blocked'), { recursive: true })
    mkdirSync(join(dir, 'blocked', '.claude.json.tmp'), { recursive: true })

    const res = trustClaudeWorkspace(dir, { configPath: join(dir, 'blocked', '.claude.json') })
    expect(res.changed).toBe(false)
    expect(res.skipped).toBe('write-failed')
    expect(res.error).toBeTruthy()
  })

  it('skips a pathologically large config rather than blocking the main process', () => {
    // The main process seeds trust synchronously on every terminal creation, so an
    // unbounded parse here would freeze the whole app.
    writeFileSync(configPath, JSON.stringify({ projects: {} }), 'utf-8')
    const huge = join(dir, 'huge.json')
    writeFileSync(huge, '{"projects":{}}', 'utf-8')
    // 32 MB ceiling — build a file just past it without holding it all in memory twice.
    const chunk = ' '.repeat(1024 * 1024)
    let padded = '{"projects":{},"pad":"'
    for (let i = 0; i < 33; i++) padded += chunk
    padded += '"}'
    writeFileSync(huge, padded, 'utf-8')

    const res = trustClaudeWorkspace(dir, { configPath: huge })
    expect(res.changed).toBe(false)
    expect(res.skipped).toBe('too-large')
  })
})

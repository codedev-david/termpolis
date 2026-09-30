import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync, realpathSync,
} from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import {
  trustClaudeWorkspace, claudeProjectKey, claudeConfigPath, __resetTrustCache,
  revertClaudeTrust, untrustUnsafeClaudeRoots,
} from '../../src/main/claudeTrust'

// Termpolis used to "auto-trust" Claude Code by typing a bare Enter at its
// workspace-trust dialog. Claude Code 2.1.x builds that dialog with
// `cancelFirst: true, focus: "cancel"`, so the Enter answered "No, exit" and
// quit the session — the launch looked cut off. Trust is a config value, so
// these tests pin down writing the config value instead of guessing a keystroke.
//
// It also used to seed EVERY folder a terminal opened in, home included. Claude
// checks trust by walking up from the working folder, so a trusted home (or drive
// root, or share root) trusted every project beneath it. Those folders are now
// refused, and whatever a trust call set can be withdrawn again on disconnect.

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

const read = (): any => JSON.parse(readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, ''))

/** Swap `realpathSync.native` for the length of `fn` (the resolver claudeProjectKey prefers). */
function withNativeRealpath(replacement: unknown, fn: () => void): void {
  const target = realpathSync as unknown as { native?: unknown }
  const original = target.native
  target.native = replacement
  try { fn() } finally { target.native = original }
}

/**
 * Run `fn` with CLAUDE_CONFIG_DIR pointed at the temp dir, so the no-options code paths
 * resolve to `configPath` and never to the real ~/.claude.json.
 */
function withClaudeConfigDir(fn: () => void): void {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR')
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    // Guard: if the override did not take, stop before touching any real config.
    if (claudeConfigPath() !== configPath) throw new Error('CLAUDE_CONFIG_DIR override did not apply')
    fn()
  } finally {
    if (had) process.env.CLAUDE_CONFIG_DIR = prev
    else delete process.env.CLAUDE_CONFIG_DIR
  }
}

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

  it('keeps a bare POSIX root as "/" instead of collapsing it to an empty key', () => {
    // Windows resolves "/" to the current drive, so hand the resolver a POSIX root directly.
    withNativeRealpath(() => '/', () => {
      expect(claudeProjectKey('/anything')).toBe('/')
    })
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

  it('resolves a symlinked or junctioned folder to its target, the key Claude itself writes', () => {
    const real = join(dir, 'real')
    mkdirSync(real)
    const link = join(dir, 'link')
    symlinkSync(real, link, 'junction')
    expect(claudeProjectKey(link)).toBe(claudeProjectKey(real))
  })

  it('still resolves links when realpathSync.native is unavailable', () => {
    const real = join(dir, 'real')
    mkdirSync(real)
    const link = join(dir, 'link')
    symlinkSync(real, link, 'junction')
    withNativeRealpath(undefined, () => {
      expect(claudeProjectKey(link)).toBe(claudeProjectKey(real))
      expect(claudeProjectKey(link)).not.toBe(link.replace(/\\/g, '/'))
    })
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
    expect(res.newlySet).toEqual([claudeProjectKey(dir)])
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

  it('reads a config saved with a byte-order mark and keeps the mark', () => {
    writeFileSync(configPath, '\uFEFF' + JSON.stringify({ numStartups: 3 }), 'utf-8')

    const res = trustClaudeWorkspace(dir, { configPath })
    expect(res.changed).toBe(true)
    expect(readFileSync(configPath, 'utf-8').startsWith('\uFEFF')).toBe(true)
    expect(read().numStartups).toBe(3)
    expect(read().projects[claudeProjectKey(dir)].hasTrustDialogAccepted).toBe(true)
  })

  it('is idempotent — a second call writes nothing', () => {
    trustClaudeWorkspace(dir, { configPath })
    const second = trustClaudeWorkspace(dir, { configPath })
    expect(second.changed).toBe(false)
    expect(second.skipped).toBe('already-trusted')
    expect(second.newlySet).toEqual([])
  })

  it('does not write when the flag is already true (no read-modify-write race)', () => {
    writeFileSync(configPath, JSON.stringify({
      projects: { [claudeProjectKey(dir)]: { hasTrustDialogAccepted: true } },
    }), 'utf-8')
    const before = readFileSync(configPath, 'utf-8')

    const res = trustClaudeWorkspace(dir, { configPath })
    expect(res.changed).toBe(false)
    expect(res.skipped).toBe('already-trusted')
    // Trust the user gave is not ours to take back on disconnect.
    expect(res.newlySet).toEqual([])
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })

  it('keeps its "already done" memory per config file, so a second Claude profile is still seeded', () => {
    const otherConfig = join(dir, 'profile-2', '.claude.json')
    mkdirSync(join(dir, 'profile-2'))
    expect(trustClaudeWorkspace(dir, { configPath }).changed).toBe(true)

    expect(trustClaudeWorkspace(dir, { configPath: otherConfig }).changed).toBe(true)
    expect(JSON.parse(readFileSync(otherConfig, 'utf-8')).projects[claudeProjectKey(dir)].hasTrustDialogAccepted).toBe(true)
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

  it('reports only the keys it switched in newlySet, not ones that were already trusted', () => {
    const sub = join(dir, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      projects: { [claudeProjectKey(dir)]: { hasTrustDialogAccepted: true } },
    }), 'utf-8')

    const res = trustClaudeWorkspace(sub, { alsoTrust: [dir], configPath })
    expect(res.keys).toEqual([claudeProjectKey(sub), claudeProjectKey(dir)])
    expect(res.newlySet).toEqual([claudeProjectKey(sub)])
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
    expect(trustClaudeWorkspace('  ', { configPath })).toEqual({ changed: false, keys: [], newlySet: [], skipped: 'no-cwd' })
    expect(trustClaudeWorkspace('', { configPath })).toEqual({ changed: false, keys: [], newlySet: [], skipped: 'no-cwd' })
    expect(existsSync(configPath)).toBe(false)
  })

  it('never overwrites a config it could not parse', () => {
    writeFileSync(configPath, '{ this is not json', 'utf-8')

    const res = trustClaudeWorkspace(dir, { configPath })
    expect(res.changed).toBe(false)
    expect(res.skipped).toBe('corrupt')
    expect(res.newlySet).toEqual([])
    expect(readFileSync(configPath, 'utf-8')).toBe('{ this is not json')
  })

  it('treats a non-object config root as corrupt', () => {
    writeFileSync(configPath, '[1,2,3]', 'utf-8')
    const res = trustClaudeWorkspace(dir, { configPath })
    expect(res.skipped).toBe('corrupt')
    expect(res.error).toBe('root is not an object')
    expect(readFileSync(configPath, 'utf-8')).toBe('[1,2,3]')
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

  it('reports a failed write rather than throwing into the terminal-create path, and retries next time', () => {
    // The config's folder does not exist, so the write cannot succeed.
    const blocked = join(dir, 'no-such-profile', '.claude.json')

    const res = trustClaudeWorkspace(dir, { configPath: blocked })
    expect(res.changed).toBe(false)
    expect(res.skipped).toBe('write-failed')
    expect(res.newlySet).toEqual([])
    expect(res.error).toBeTruthy()

    // A failed write is not remembered as done: once the folder exists, the next call writes.
    mkdirSync(join(dir, 'no-such-profile'))
    expect(trustClaudeWorkspace(dir, { configPath: blocked }).changed).toBe(true)
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

describe('trustClaudeWorkspace — folders it never trusts', () => {
  let home: string

  beforeEach(() => {
    home = join(dir, 'home', 'me')
    mkdirSync(home, { recursive: true })
  })

  it('refuses the home folder itself and writes nothing', () => {
    // Claude keeps home trust session-only on purpose; a terminal in ~ keeps its dialog.
    expect(trustClaudeWorkspace(home, { configPath, home }))
      .toEqual({ changed: false, keys: [], newlySet: [], skipped: 'unsafe-root' })
    expect(existsSync(configPath)).toBe(false)
  })

  it('refuses any folder above home', () => {
    expect(trustClaudeWorkspace(join(dir, 'home'), { configPath, home }).skipped).toBe('unsafe-root')
    expect(trustClaudeWorkspace(dir, { configPath, home }).skipped).toBe('unsafe-root')
    expect(existsSync(configPath)).toBe(false)
  })

  it('refuses a filesystem root', () => {
    const roots = process.platform === 'win32' ? ['/', 'C:\\', 'c:/'] : ['/']
    for (const root of roots) {
      expect(trustClaudeWorkspace(root, { configPath, home }).skipped, root).toBe('unsafe-root')
    }
    expect(existsSync(configPath)).toBe(false)
  })

  it('recognises home through a symlink or junction, not only as spelled', () => {
    const linkedHome = join(dir, 'linked-home')
    symlinkSync(home, linkedHome, 'junction')

    expect(trustClaudeWorkspace(home, { configPath, home: linkedHome }).skipped).toBe('unsafe-root')
    expect(existsSync(configPath)).toBe(false)
  })

  it('still trusts a project inside home', () => {
    const repo = join(home, 'repo')
    mkdirSync(repo)

    const res = trustClaudeWorkspace(repo, { configPath, home })
    expect(res.changed).toBe(true)
    expect(Object.keys(read().projects)).toEqual([claudeProjectKey(repo)])
  })

  it('drops an unsafe alsoTrust path but still seeds the rest', () => {
    const repo = join(home, 'repo')
    const pkg = join(repo, 'pkg')
    mkdirSync(pkg, { recursive: true })

    const res = trustClaudeWorkspace(pkg, { alsoTrust: [home, '/', repo], configPath, home })
    expect(res.changed).toBe(true)
    expect(res.keys).toEqual([claudeProjectKey(pkg), claudeProjectKey(repo)])
    expect(Object.keys(read().projects).sort()).toEqual([claudeProjectKey(pkg), claudeProjectKey(repo)].sort())
  })

  it('with no home folder to compare against, still refuses roots but trusts other folders', () => {
    expect(trustClaudeWorkspace('/', { configPath, home: '   ' }).skipped).toBe('unsafe-root')
    expect(existsSync(configPath)).toBe(false)

    const res = trustClaudeWorkspace(home, { configPath, home: '' })
    expect(res.changed).toBe(true)
    expect(res.newlySet).toEqual([claudeProjectKey(home)])
  })
})

describe('revertClaudeTrust', () => {
  it('withdraws exactly what a trust call newly set and leaves trust the user gave alone', () => {
    const sub = join(dir, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      numStartups: 7,
      projects: { [claudeProjectKey(dir)]: { hasTrustDialogAccepted: true } },
    }), 'utf-8')
    const res = trustClaudeWorkspace(sub, { alsoTrust: [dir], configPath })

    expect(revertClaudeTrust(res.newlySet, { configPath }))
      .toEqual({ changed: true, reverted: [claudeProjectKey(sub)] })
    const cfg = read()
    // An entry holding nothing but the flag was Termpolis's own, so it goes entirely.
    expect(cfg.projects[claudeProjectKey(sub)]).toBeUndefined()
    expect(cfg.projects[claudeProjectKey(dir)]).toEqual({ hasTrustDialogAccepted: true })
    expect(cfg.numStartups).toBe(7)
  })

  it('sets the flag back to false on an entry that holds more than the flag', () => {
    const key = claudeProjectKey(dir)
    writeFileSync(configPath, JSON.stringify({ projects: { [key]: { history: ['x'] } } }), 'utf-8')
    const res = trustClaudeWorkspace(dir, { configPath })
    expect(res.newlySet).toEqual([key])

    expect(revertClaudeTrust(res.newlySet, { configPath })).toEqual({ changed: true, reverted: [key] })
    expect(read().projects[key]).toEqual({ history: ['x'], hasTrustDialogAccepted: false })
  })

  it('skips entries that are untrusted, malformed or not asked for, and then writes nothing', () => {
    writeFileSync(configPath, JSON.stringify({
      projects: {
        '/a': { hasTrustDialogAccepted: false },
        '/b': 'nope',
        '/c': { hasTrustDialogAccepted: true },
      },
    }), 'utf-8')
    const before = readFileSync(configPath, 'utf-8')

    expect(revertClaudeTrust(['/a', '/b', '/missing'], { configPath })).toEqual({ changed: false, reverted: [] })
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })

  it('returns at once for an empty key list, without even reading the config', () => {
    writeFileSync(configPath, '{ not json', 'utf-8')
    // A read would have reported the corrupt file as an error.
    expect(revertClaudeTrust([], { configPath })).toEqual({ changed: false, reverted: [] })
  })

  it('treats a missing config or projects map as nothing to withdraw', () => {
    expect(revertClaudeTrust(['/a'], { configPath })).toEqual({ changed: false, reverted: [] })
    expect(existsSync(configPath)).toBe(false)

    writeFileSync(configPath, JSON.stringify({ projects: ['/a'] }), 'utf-8')
    expect(revertClaudeTrust(['/a'], { configPath })).toEqual({ changed: false, reverted: [] })
  })

  it('reports a config it cannot parse and leaves it untouched', () => {
    writeFileSync(configPath, '{ this is not json', 'utf-8')
    const res = revertClaudeTrust(['/a'], { configPath })
    expect(res.changed).toBe(false)
    expect(res.reverted).toEqual([])
    expect(res.error).toBeTruthy()
    expect(readFileSync(configPath, 'utf-8')).toBe('{ this is not json')
  })

  it('reports a failed write and leaves the config as it was', () => {
    writeFileSync(configPath, JSON.stringify({ projects: { '/a': { hasTrustDialogAccepted: true } } }), 'utf-8')
    const before = readFileSync(configPath, 'utf-8')
    // A directory squatting on the temp file the atomic write goes through.
    mkdirSync(`${realpathSync.native(configPath)}.termpolis-${process.pid}.tmp`)

    const res = revertClaudeTrust(['/a'], { configPath })
    expect(res.changed).toBe(false)
    expect(res.reverted).toEqual([])
    expect(res.error).toBeTruthy()
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })

  it('forgets what it cached, so the next terminal in that folder seeds trust again', () => {
    const first = trustClaudeWorkspace(dir, { configPath })
    expect(revertClaudeTrust(first.newlySet, { configPath }).changed).toBe(true)

    const again = trustClaudeWorkspace(dir, { configPath })
    expect(again.changed).toBe(true)
    expect(read().projects[claudeProjectKey(dir)].hasTrustDialogAccepted).toBe(true)
  })
})

describe('untrustUnsafeClaudeRoots', () => {
  it('withdraws trust an earlier version wrote for home, its parents and the roots, and keeps real projects', () => {
    const home = join(dir, 'home', 'me')
    mkdirSync(home, { recursive: true })
    const homeKey = claudeProjectKey(home)
    const parentKey = claudeProjectKey(join(dir, 'home'))
    const repoKey = claudeProjectKey(join(home, 'repo'))
    writeFileSync(configPath, JSON.stringify({
      numStartups: 3,
      projects: {
        [homeKey]: { hasTrustDialogAccepted: true },
        [parentKey]: { hasTrustDialogAccepted: true },
        '/': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
        'C:/': { hasTrustDialogAccepted: true },
        '//fileserver/share': { hasTrustDialogAccepted: true },
        [repoKey]: { hasTrustDialogAccepted: true },
      },
    }), 'utf-8')

    const res = untrustUnsafeClaudeRoots({ configPath, home })
    expect(res.changed).toBe(true)
    expect([...res.reverted].sort()).toEqual([homeKey, parentKey, '/', 'C:/', '//fileserver/share'].sort())
    const cfg = read()
    expect(cfg.projects).toEqual({
      '/': { hasTrustDialogAccepted: false, allowedTools: ['Bash'] },
      [repoKey]: { hasTrustDialogAccepted: true },
    })
    expect(cfg.numStartups).toBe(3)
  })

  it('writes nothing when no unsafe folder is trusted', () => {
    const home = join(dir, 'home', 'me')
    mkdirSync(home, { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      projects: {
        [claudeProjectKey(home)]: { hasTrustDialogAccepted: false },
        [claudeProjectKey(join(home, 'repo'))]: { hasTrustDialogAccepted: true },
      },
    }), 'utf-8')
    const before = readFileSync(configPath, 'utf-8')

    expect(untrustUnsafeClaudeRoots({ configPath, home })).toEqual({ changed: false, reverted: [] })
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })
})

describe('no options: the default config location and home folder', () => {
  // Every other test passes configPath. These pin the no-options path, with
  // CLAUDE_CONFIG_DIR pointed at the temp dir so the real ~/.claude.json is never used.
  it('trustClaudeWorkspace writes to the file claudeConfigPath() names', () => {
    withClaudeConfigDir(() => {
      const proj = join(dir, 'proj')
      mkdirSync(proj)
      expect(trustClaudeWorkspace(proj).changed).toBe(true)
      expect(read().projects[claudeProjectKey(proj)]).toEqual({ hasTrustDialogAccepted: true })
    })
  })

  it('revertClaudeTrust withdraws from that same file', () => {
    const key = claudeProjectKey(join(dir, 'proj'))
    writeFileSync(configPath, JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }), 'utf-8')
    withClaudeConfigDir(() => {
      expect(revertClaudeTrust([key])).toEqual({ changed: true, reverted: [key] })
      expect(read().projects).toEqual({})
    })
  })

  it('untrustUnsafeClaudeRoots checks against the real home folder by default', () => {
    const homeKey = claudeProjectKey(homedir())
    const projKey = claudeProjectKey(join(dir, 'proj'))
    writeFileSync(configPath, JSON.stringify({
      projects: {
        [homeKey]: { hasTrustDialogAccepted: true },
        [projKey]: { hasTrustDialogAccepted: true },
      },
    }), 'utf-8')
    withClaudeConfigDir(() => {
      expect(untrustUnsafeClaudeRoots()).toEqual({ changed: true, reverted: [homeKey] })
      expect(Object.keys(read().projects)).toEqual([projKey])
    })
  })
})

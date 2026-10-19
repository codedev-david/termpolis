// @vitest-environment node
// Agent integration with more than one account: every connected account's profile gets
// Termpolis's entries, the ledger records each profile before the first write, folder trust is
// recorded per `.claude.json`, and Disconnect (Settings, --disconnect-agents, the uninstallers)
// takes everything out of every profile, registry or no registry.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import {
  bootAgentIntegration, connectAccountProfile, disconnectAccountProfile, disconnectAgentIntegration,
  isAgentIntegrationConnected, isFolderTrustAllowed, prepareCodexLaunch, profileConnection, removeCodexHomeTrust, setAgentIntegration,
  stripCopiedEntries, trustFolderForAgents,
} from '../../src/main/agentIntegrationManager'
import type { ProfileTarget } from '../../src/main/agentIntegrationManager'
import { CLAUDE_ALLOW_RULES } from '../../src/main/agentMcpRegistry'
import { claudeProjectKey } from '../../src/main/claudeTrust'
import { codexServerState } from '../../src/main/codexConfigEdit'
import { AGENTS_BEGIN, AGENTS_END } from '../../src/main/codexParity'
import { runDisconnectAgentsCli } from '../../src/main/disconnectAgentsCli'
import { CODEX_AUTO_APPROVED_TOOLS } from '../../src/shared/agentIntegration'
import {
  blockWrites, codexServerToml, codexTrustToml, createSandbox, readJson, readText, unblockWrites, writeJson, writeLedger,
  writeText,
} from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

let sb: Sandbox

beforeEach(() => {
  sb = createSandbox()
  sb.rt.hookShell = 'sh'
})

afterEach(() => {
  vi.restoreAllMocks()
  sb.dispose()
})

const ID = (n: number): string => `acc_${String(n).padStart(12, '0')}`

function claudeTarget(name: string, id = 1): ProfileTarget {
  const dir = join(sb.home, name)
  return { agent: 'claude', dir, claudeJson: join(dir, '.claude.json'), accountId: ID(id) }
}

function codexTarget(name: string, id = 2): ProfileTarget {
  return { agent: 'codex', dir: join(sb.home, name), accountId: ID(id) }
}

function makeProfile(t: ProfileTarget): void {
  mkdirSync(t.dir, { recursive: true })
}

/** A registry in userData naming these accounts (connect as given). */
function writeRegistry(accounts: Array<{ id: string; agent: 'claude' | 'codex'; label: string; profile: string | null; connect: boolean }>): void {
  writeJson(join(sb.paths.userData, 'agent-accounts.json'), {
    version: 1,
    accounts: accounts.map((a, i) => ({ ...a, autoOffer: true, order: i, origin: 'adopted', links: [] })),
  })
}

function granted(fields: Record<string, unknown> = {}): void {
  writeLedger(sb, { consent: 'granted', ...fields })
}

function ledger(): any {
  return readJson(sb.ledgerFile)
}

function hasOurServer(claudeJson: string): boolean {
  return !!readJson(claudeJson).mcpServers?.termpolis
}

describe('applyAll covers every connected account profile', () => {
  it('writes the MCP server, the allow list and the memory hook into each Claude profile, and the server into each Codex home', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    const c = claudeTarget('.claude-codedev')
    const x = codexTarget('.codex-work')
    makeProfile(c)
    makeProfile(x)
    granted()
    sb.rt.profiles = [c, x]
    const r = setAgentIntegration(sb.rt, { connect: true })
    expect(r.saveError).toBeUndefined()
    expect(hasOurServer(c.claudeJson!)).toBe(true)
    const settings = readJson(join(c.dir, 'settings.json'))
    expect(settings.permissions.allow).toEqual([...CLAUDE_ALLOW_RULES])
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain('memory-primer-hook.cjs')
    const toml = readText(join(x.dir, 'config.toml'))
    expect(codexServerState(toml)).toMatchObject({ state: 'present', args: [sb.adapter] })
    for (const tool of CODEX_AUTO_APPROVED_TOOLS) expect(toml).toContain(`[mcp_servers.termpolis.tools.${tool}]`)
    // Each profile is in the ledger, recorded before anything was written there.
    expect(ledger().profiles).toEqual([
      { agent: 'claude', dir: c.dir, claudeJson: c.claudeJson, migrated: true },
      { agent: 'codex', dir: x.dir },
    ])
    // The rows name the profile files, so Settings lists them like the default ones.
    const files = r.changes.map((ch) => ch.file)
    expect(files).toContain(c.claudeJson)
    expect(files).toContain(join(x.dir, 'config.toml'))
  })

  it('writes nothing new on a second run', () => {
    const c = claudeTarget('.claude-codedev')
    makeProfile(c)
    granted()
    sb.rt.profiles = [c]
    setAgentIntegration(sb.rt, { connect: true })
    const again = bootAgentIntegration(sb.rt)
    expect(again.changes).toEqual([])
  })

  it('skips a target that is the default profile, by path or through a link, a duplicate, and one with no .claude.json path', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    granted()
    const linkToDefault = join(sb.home, '.claude-alias')
    sb.link(sb.paths.claudeDir, linkToDefault)
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    sb.rt.profiles = [
      { agent: 'claude', dir: sb.paths.claudeDir, claudeJson: sb.paths.claudeJson },
      { agent: 'claude', dir: linkToDefault, claudeJson: join(linkToDefault, '.claude.json') },
      c, { ...c },
      { agent: 'claude', dir: join(sb.home, '.claude-nojson') },
      { agent: 'claude', dir: 'relative', claudeJson: 'relative/.claude.json' },
      { agent: 'codex', dir: sb.paths.codexHome },
    ]
    setAgentIntegration(sb.rt, { connect: true })
    expect(ledger().profiles).toEqual([{ agent: 'claude', dir: c.dir, claudeJson: c.claudeJson, migrated: true }])
    expect(existsSync(join(linkToDefault, '.claude.json'))).toBe(false)
  })

  it('writes nothing into a profile whose record could not be saved first (R9 write-ahead)', () => {
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    granted()
    sb.rt.profiles = [c]
    const boot = (): ReturnType<typeof bootAgentIntegration> => {
      blockWrites(sb.ledgerFile)
      try {
        return bootAgentIntegration(sb.rt)
      } finally {
        unblockWrites(sb.ledgerFile)
      }
    }
    const r = boot()
    expect(r.changes).toContainEqual({
      agent: 'claude', file: c.dir, action: 'skipped', what: 'Account profile',
      error: 'Termpolis could not record this profile in its ledger first, so it wrote nothing there',
    })
    expect(readdirSync(c.dir)).toEqual([])
    expect(ledger().profiles).toBeUndefined()
  })

  it('keeps the profiles already recorded when a later one can\'t be', () => {
    const a = claudeTarget('.claude-a', 1)
    const b = claudeTarget('.claude-b', 3)
    makeProfile(a)
    makeProfile(b)
    granted({ profiles: [{ agent: 'claude', dir: a.dir, claudeJson: a.claudeJson, migrated: true }] })
    sb.rt.profiles = [a, b]
    blockWrites(sb.ledgerFile)
    try {
      bootAgentIntegration(sb.rt)
    } finally {
      unblockWrites(sb.ledgerFile)
    }
    expect(hasOurServer(a.claudeJson!)).toBe(true)
    expect(readdirSync(b.dir)).toEqual([])
  })

  it('runs the old-version cleanups once in a profile it first connects', () => {
    const c = claudeTarget('.claude-old')
    makeProfile(c)
    // An older Termpolis, run under CLAUDE_CONFIG_DIR, left its blanket rule and trusted home there.
    writeJson(join(c.dir, 'settings.json'), { permissions: { allow: ['mcp__termpolis__*', 'Bash(ls)'] } })
    writeJson(c.claudeJson!, { projects: { [claudeProjectKey(sb.home)]: { hasTrustDialogAccepted: true } } })
    granted()
    sb.rt.profiles = [c]
    setAgentIntegration(sb.rt, { connect: true })
    const settings = readJson(join(c.dir, 'settings.json'))
    expect(settings.permissions.allow).not.toContain('mcp__termpolis__*')
    expect(settings.permissions.allow).toContain('Bash(ls)')
    expect(readJson(c.claudeJson!).projects[claudeProjectKey(sb.home)]).toBeUndefined()
    expect(ledger().profiles[0].migrated).toBe(true)
    // Not again: a wildcard the user adds back later is theirs.
    writeJson(join(c.dir, 'settings.json'), { permissions: { allow: ['mcp__termpolis__*'] } })
    bootAgentIntegration(sb.rt)
    expect(readJson(join(c.dir, 'settings.json')).permissions.allow).toContain('mcp__termpolis__*')
  })

  it('retries those cleanups next time when one could not run', () => {
    const c = claudeTarget('.claude-bad')
    makeProfile(c)
    writeText(join(c.dir, 'settings.json'), '{ not json')
    granted()
    sb.rt.profiles = [c]
    bootAgentIntegration(sb.rt)
    expect(ledger().profiles[0].migrated).toBeUndefined()
  })

  it('is today\'s behaviour exactly when no account was added (D13)', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    granted()
    const without = setAgentIntegration(sb.rt, { connect: true })
    sb.rt.profiles = []
    const withEmpty = setAgentIntegration(sb.rt, { connect: true })
    expect(withEmpty.changes).toEqual([])
    expect(without.changes.every((ch) => !ch.file.includes('.claude-'))).toBe(true)
    expect(ledger().profiles).toBeUndefined()
    expect(ledger().trustedByFile).toBeUndefined()
  })
})

describe('connectAccountProfile', () => {
  it('connects one profile now, given Agent Integration\'s consent', () => {
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    granted()
    const rows = connectAccountProfile(sb.rt, c)
    expect(rows.map((r) => r.what)).toEqual(['MCP server', 'Tool permissions', 'SessionStart memory hook'])
    expect(hasOurServer(c.claudeJson!)).toBe(true)
    expect(connectAccountProfile(sb.rt, c)).toEqual([])
  })

  it('refuses without consent, and without a profile folder', () => {
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    expect(connectAccountProfile(sb.rt, c)).toEqual([{ agent: 'claude', file: c.dir, action: 'skipped', what: 'Account profile', error: 'Agent Integration is off: turn it on first' }])
    expect(existsSync(c.claudeJson!)).toBe(false)
    granted()
    const missing = claudeTarget('.claude-missing')
    expect(connectAccountProfile(sb.rt, missing)).toEqual([{ agent: 'claude', file: missing.dir, action: 'skipped', what: 'Account profile', error: 'the profile folder doesn\'t exist' }])
    const outside: ProfileTarget = { agent: 'claude', dir: join(sb.root, 'outside'), claudeJson: join(sb.root, 'outside', '.claude.json') }
    mkdirSync(outside.dir)
    expect(connectAccountProfile(sb.rt, outside)[0].error).toBe('the profile folder doesn\'t exist')
    expect(existsSync(outside.claudeJson!)).toBe(false)
  })

  it('leaves the default profile to Agent Integration, and a Claude target with no .claude.json path alone', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    granted()
    expect(connectAccountProfile(sb.rt, { agent: 'claude', dir: sb.paths.claudeDir, claudeJson: sb.paths.claudeJson })).toEqual([])
    const nojson: ProfileTarget = { agent: 'claude', dir: join(sb.home, '.claude-n') }
    mkdirSync(nojson.dir)
    expect(connectAccountProfile(sb.rt, nojson)).toEqual([])
  })

  it('says why, when there is no home folder or the ledger can\'t be read', () => {
    granted()
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    expect(connectAccountProfile({ ...sb.rt, paths: { ...sb.paths, claudeDir: '' } }, c)[0].what).toBe('Agent configs')
    const broken = { ...sb.rt, get paths(): never { throw new Error('paths gone') } }
    expect(connectAccountProfile(broken as never, c)).toEqual([{ agent: 'claude', file: c.dir, action: 'skipped', what: 'Account profile', error: 'paths gone' }])
  })
})

describe('folder trust per account (R9)', () => {
  it('pre-trusts in the account\'s own .claude.json, and records it by file', () => {
    granted()
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    const cwd = join(sb.root, 'repo')
    mkdirSync(cwd)
    const r = trustFolderForAgents(sb.paths, cwd, null, c)
    expect(r).toEqual({ changed: true, keys: [claudeProjectKey(cwd)] })
    expect(readJson(c.claudeJson!).projects[claudeProjectKey(cwd)].hasTrustDialogAccepted).toBe(true)
    expect(existsSync(sb.paths.claudeJson)).toBe(false)
    expect(ledger().trustedByFile).toEqual({ [c.claudeJson!]: [claudeProjectKey(cwd)] })
    expect(ledger().trustedByTermpolis).toEqual([])
    expect(ledger().profiles).toEqual([{ agent: 'claude', dir: c.dir, claudeJson: c.claudeJson }])
  })

  it('trusts in the default .claude.json for the default profile, or no target', () => {
    granted()
    const cwd = join(sb.root, 'repo')
    mkdirSync(cwd)
    trustFolderForAgents(sb.paths, cwd, null, { agent: 'claude', dir: sb.paths.claudeDir, claudeJson: sb.paths.claudeJson })
    expect(ledger().trustedByTermpolis).toEqual([claudeProjectKey(cwd)])
    expect(ledger().trustedByFile).toBeUndefined()
  })

  it('writes nothing for a profile it can\'t record first, or one outside the test home', () => {
    granted()
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    const cwd = join(sb.root, 'repo')
    mkdirSync(cwd)
    blockWrites(sb.ledgerFile)
    try {
      expect(trustFolderForAgents(sb.paths, cwd, null, c)).toEqual({ changed: false, keys: [], skipped: 'not-recorded' })
    } finally {
      unblockWrites(sb.ledgerFile)
    }
    expect(existsSync(c.claudeJson!)).toBe(false)
    const outside: ProfileTarget = { agent: 'claude', dir: join(sb.root, 'out'), claudeJson: join(sb.root, 'out', '.claude.json') }
    mkdirSync(outside.dir)
    expect(trustFolderForAgents(sb.paths, cwd, null, outside)).toEqual({ changed: false, keys: [], skipped: 'not-recorded' })
    expect(existsSync(outside.claudeJson!)).toBe(false)
  })

  it('keeps consent the gate: no consent, no trust anywhere', () => {
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    const cwd = join(sb.root, 'repo')
    mkdirSync(cwd)
    expect(trustFolderForAgents(sb.paths, cwd, null, c)).toEqual({ changed: false, keys: [], skipped: 'no-consent' })
    expect(isFolderTrustAllowed(sb.paths, cwd)).toBe(false)
  })
})

describe('disconnect covers every profile', () => {
  function connectTwo(): { c: ProfileTarget; x: ProfileTarget; cwd: string } {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    const c = claudeTarget('.claude-codedev', 1)
    const x = codexTarget('.codex-work', 2)
    makeProfile(c)
    makeProfile(x)
    granted()
    sb.rt.profiles = [c, x]
    setAgentIntegration(sb.rt, { connect: true })
    const cwd = join(sb.root, 'repo')
    mkdirSync(cwd)
    trustFolderForAgents(sb.paths, cwd, null, c)
    return { c, x, cwd }
  }

  it('takes Termpolis\'s entries and trust out of every account profile, and keeps the profiles on record', () => {
    const { c, x, cwd } = connectTwo()
    const r = setAgentIntegration(sb.rt, { connect: false })
    expect(r.saveError).toBeUndefined()
    expect(hasOurServer(c.claudeJson!)).toBe(false)
    expect(readJson(join(c.dir, 'settings.json')).permissions?.allow ?? []).toEqual([])
    expect(readJson(c.claudeJson!).projects?.[claudeProjectKey(cwd)]).toBeUndefined()
    expect(codexServerState(readText(join(x.dir, 'config.toml')))).toEqual({ state: 'absent' })
    expect(ledger().consent).toBe('declined')
    expect(ledger().profiles).toHaveLength(2)
    expect(ledger().trustedByFile).toBeUndefined()
  })

  it('finds them from the ledger alone when the registry file is gone, and from the registry alone too', () => {
    const { c } = connectTwo()
    rmSync(join(sb.paths.userData, 'agent-accounts.json'), { force: true })
    disconnectAgentIntegration(sb.paths)
    expect(hasOurServer(c.claudeJson!)).toBe(false)
    // An account the registry names, written into by hand (or an old run), with no ledger record.
    const d = claudeTarget('.claude-handmade', 4)
    makeProfile(d)
    writeJson(d.claudeJson!, { mcpServers: { termpolis: { type: 'stdio', command: 'node', args: [sb.adapter] } } })
    writeRegistry([{ id: ID(4), agent: 'claude', label: 'handmade', profile: d.dir, connect: false }])
    disconnectAgentIntegration(sb.paths)
    expect(hasOurServer(d.claudeJson!)).toBe(false)
  })

  it('reverts only the trust each file got from Termpolis, never a key the user accepted in another profile', () => {
    granted()
    const a = claudeTarget('.claude-a', 1)
    const b = claudeTarget('.claude-b', 3)
    makeProfile(a)
    makeProfile(b)
    const cwd = join(sb.root, 'repo')
    mkdirSync(cwd)
    const key = claudeProjectKey(cwd)
    // The user accepted the folder themselves in B, with Claude's own fields beside the flag.
    writeJson(b.claudeJson!, { projects: { [key]: { hasTrustDialogAccepted: true, allowedTools: [] } } })
    trustFolderForAgents(sb.paths, cwd, null, a)
    trustFolderForAgents(sb.paths, cwd, null, b)
    expect(ledger().trustedByFile).toEqual({ [a.claudeJson!]: [key] })
    // B first, so a revert that took the wrong file's keys would reach B before A's record goes.
    writeRegistry([
      { id: ID(3), agent: 'claude', label: 'b', profile: b.dir, connect: true },
      { id: ID(1), agent: 'claude', label: 'a', profile: a.dir, connect: true },
    ])
    disconnectAgentIntegration(sb.paths)
    expect(readJson(a.claudeJson!).projects?.[key]).toBeUndefined()
    expect(readJson(b.claudeJson!).projects[key].hasTrustDialogAccepted).toBe(true)
  })

  it('keeps a file\'s trust on record when its revert fails, so the next disconnect tries again', () => {
    const { c, cwd } = connectTwo()
    writeText(c.claudeJson!, '{ broken')
    disconnectAgentIntegration(sb.paths)
    expect(ledger().trustedByFile).toEqual({ [c.claudeJson!]: [claudeProjectKey(cwd)] })
  })

  it('runs from --disconnect-agents (the Windows uninstaller and the .deb prerm), with no change of their own', () => {
    const { c, x } = connectTwo()
    const lines: string[] = []
    const code = runDisconnectAgentsCli([sb.paths.userData], { ...process.env, HOME: sb.home }, { log: (l) => lines.push(l), error: (l) => lines.push(l), homedir: () => sb.home })
    expect(code).toBe(0)
    expect(hasOurServer(c.claudeJson!)).toBe(false)
    expect(codexServerState(readText(join(x.dir, 'config.toml')))).toEqual({ state: 'absent' })
    expect(lines.some((l) => l.includes(c.claudeJson!))).toBe(true)
  })

  it('reports a profile list it couldn\'t work out as a skipped row, and disconnects the rest', () => {
    connectTwo()
    writeText(sb.ledgerFile, '{ broken ledger')
    // An unreadable ledger lists no profiles; the registry's still are.
    writeRegistry([])
    const rows = disconnectAgentIntegration(sb.paths)
    expect(rows.some((r) => r.what === 'MCP server')).toBe(true)
  })
})

describe('disconnectAccountProfile and stripCopiedEntries', () => {
  it('takes one profile\'s entries and its recorded trust out, and leaves the ledger\'s other files alone', () => {
    granted()
    const a = claudeTarget('.claude-a', 1)
    const b = claudeTarget('.claude-b', 3)
    makeProfile(a)
    makeProfile(b)
    connectAccountProfile(sb.rt, a)
    connectAccountProfile(sb.rt, b)
    const cwd = join(sb.root, 'repo')
    mkdirSync(cwd)
    trustFolderForAgents(sb.paths, cwd, null, a)
    trustFolderForAgents(sb.paths, cwd, null, b)
    const rows = disconnectAccountProfile(sb.paths, a)
    expect(rows.map((r) => r.what).sort()).toEqual(['Folder trust Termpolis added', 'MCP server', 'SessionStart memory hook', 'Tool permissions'])
    expect(hasOurServer(a.claudeJson!)).toBe(false)
    expect(hasOurServer(b.claudeJson!)).toBe(true)
    expect(ledger().trustedByFile).toEqual({ [b.claudeJson!]: [claudeProjectKey(cwd)] })
    disconnectAccountProfile(sb.paths, b)
    expect(ledger().trustedByFile).toBeUndefined()
  })

  it('takes a Codex home\'s server out', () => {
    granted()
    const x = codexTarget('.codex-w')
    makeProfile(x)
    connectAccountProfile(sb.rt, x)
    expect(disconnectAccountProfile(sb.paths, x)).toEqual([{ agent: 'codex', file: join(x.dir, 'config.toml'), action: 'remove', what: 'MCP server' }])
  })

  it('never touches the default profile, a folder outside the test home, or a profile with no home folder known', () => {
    granted()
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    setAgentIntegration(sb.rt, { connect: true })
    expect(disconnectAccountProfile(sb.paths, { agent: 'claude', dir: sb.paths.claudeDir, claudeJson: sb.paths.claudeJson })).toEqual([])
    expect(hasOurServer(sb.paths.claudeJson)).toBe(true)
    expect(disconnectAccountProfile(sb.paths, { agent: 'claude', dir: join(sb.root, 'x'), claudeJson: join(sb.root, 'x', '.claude.json') })).toEqual([])
    expect(disconnectAccountProfile({ ...sb.paths, home: '' }, claudeTarget('.claude-q'))[0].what).toBe('Agent configs')
  })

  it('untrusts the home folder only in a profile Termpolis itself wrote into', () => {
    granted()
    const c = claudeTarget('.claude-mine')
    makeProfile(c)
    writeJson(c.claudeJson!, { projects: { [claudeProjectKey(sb.home)]: { hasTrustDialogAccepted: true } } })
    disconnectAccountProfile(sb.paths, c)
    expect(readJson(c.claudeJson!).projects[claudeProjectKey(sb.home)]).toBeDefined()
  })

  it('reports a fault as a skipped row, never a throw', () => {
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    const broken = { ...sb.paths, get userData(): never { throw new Error('userData gone') } }
    expect(disconnectAccountProfile(broken as never, c)).toEqual([{ agent: 'claude', file: c.dir, action: 'skipped', what: 'Account profile', error: 'userData gone' }])
    // With no home folder at all, it says that instead.
    const noHome = { ...sb.paths, get home(): never { throw new Error('home gone') } }
    expect(disconnectAccountProfile(noHome as never, c)[0].what).toBe('Agent configs')
  })

  it('strips a copied settings.json of Termpolis\'s entries, touching nothing else', () => {
    const c = claudeTarget('.claude-copied')
    makeProfile(c)
    writeJson(join(c.dir, 'settings.json'), {
      permissions: { allow: [...CLAUDE_ALLOW_RULES, 'Bash(ls)'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${sb.hookScript}"` }] }] },
    })
    writeJson(c.claudeJson!, { mcpServers: { termpolis: { type: 'stdio', command: 'node', args: [sb.adapter] } } })
    const rows = stripCopiedEntries(c)
    expect(rows.map((r) => r.what)).toEqual(['Tool permissions', 'SessionStart memory hook'])
    expect(readJson(join(c.dir, 'settings.json')).permissions.allow).toEqual(['Bash(ls)'])
    // The .claude.json is not a copy: left alone.
    expect(hasOurServer(c.claudeJson!)).toBe(true)
    expect(stripCopiedEntries({ agent: 'codex', dir: c.dir })).toEqual([])
    expect(stripCopiedEntries({ agent: 'claude', dir: join(sb.root, 'outside') })).toEqual([])
    expect(stripCopiedEntries({ agent: 'claude', dir: 'relative' })).toEqual([])
  })
})

describe('the Codex launch and home trust, per account', () => {
  it('prepares the launch from the account\'s own CODEX_HOME', () => {
    granted()
    const x = codexTarget('.codex-w')
    makeProfile(x)
    writeText(join(x.dir, 'config.toml'), codexServerToml('node', [sb.adapter]))
    const r = prepareCodexLaunch(sb.paths, '', {}, x.dir)
    expect(r.approvals).toBe(CODEX_AUTO_APPROVED_TOOLS.length)
    expect(r.developerInstructions).toBeTruthy()
    // The default home has no server: launched there, it isn't connected.
    expect(prepareCodexLaunch(sb.paths, '', {}).skipped).toBe('disabled')
    // A home outside the test home falls back to the default one, never read.
    expect(prepareCodexLaunch(sb.paths, '', {}, join(sb.root, 'out')).skipped).toBe('disabled')
  })

  it('adds nothing for an account the user didn\'t connect, and still cleans the old AGENTS.md note (R9)', () => {
    granted()
    const x = codexTarget('.codex-u')
    makeProfile(x)
    writeText(join(x.dir, 'config.toml'), codexServerToml('node', [sb.adapter]))
    const cwd = join(sb.root, 'proj')
    mkdirSync(cwd)
    writeText(join(cwd, 'AGENTS.md'), `${AGENTS_BEGIN}\nold note\n${AGENTS_END}\n`)
    const r = prepareCodexLaunch(sb.paths, cwd, { accountConnected: false }, x.dir)
    expect(r).toEqual({ developerInstructions: null, skipped: 'account-not-connected', approvals: 0, agentsMdCleaned: 'file-deleted' })
    expect(readText(join(x.dir, 'config.toml'))).toBe(codexServerToml('node', [sb.adapter]))
  })

  it('removes home-folder trust from the account\'s CODEX_HOME', () => {
    const x = codexTarget('.codex-w')
    makeProfile(x)
    writeText(join(x.dir, 'config.toml'), codexTrustToml(sb.home))
    expect(removeCodexHomeTrust(sb.paths, x.dir)).toEqual({ changed: true })
    expect(readText(join(x.dir, 'config.toml'))).not.toContain('trusted')
    expect(removeCodexHomeTrust(sb.paths, 'relative')).toEqual({ changed: false })
  })
})

describe('profileConnection', () => {
  it('says which of Termpolis\'s entries a profile holds', () => {
    granted()
    const c = claudeTarget('.claude-c')
    const x = codexTarget('.codex-w')
    makeProfile(c)
    makeProfile(x)
    expect(profileConnection(c)).toEqual({ server: false, hook: false, allow: false })
    expect(profileConnection(x)).toEqual({ server: false, hook: false, allow: false })
    connectAccountProfile(sb.rt, c)
    connectAccountProfile(sb.rt, x)
    expect(profileConnection(c)).toEqual({ server: true, hook: true, allow: true })
    expect(profileConnection(x)).toEqual({ server: true, hook: false, allow: false })
    expect(profileConnection({ agent: 'claude', dir: c.dir })).toEqual({ server: false, hook: true, allow: true })
    writeText(join(x.dir, 'config.toml'), '[broken')
    expect(profileConnection(x).server).toBe(false)
  })
})

describe('the ledger\'s profile fields', () => {
  it('reads only well-formed profiles and trust records, and drops the rest at the next save', () => {
    const outside = join(sb.root, 'outside-profile')
    mkdirSync(outside)
    const good = claudeTarget('.claude-good')
    makeProfile(good)
    writeJson(good.claudeJson!, { mcpServers: { termpolis: { type: 'stdio', command: 'node', args: [sb.adapter] } } })
    granted({
      profiles: [
        null, 'x', { agent: 'gemini', dir: good.dir }, { agent: 'claude', dir: 'relative' },
        { agent: 'claude', dir: good.dir, claudeJson: 'relative.json' }, { agent: 'claude', dir: outside },
        { agent: 'claude', dir: good.dir, claudeJson: good.claudeJson, migrated: 'yes' },
      ],
      trustedByFile: { relative: ['k'], [good.claudeJson!]: [], [join(sb.home, 'x.json')]: ['k', 3] },
    })
    disconnectAgentIntegration(sb.paths)
    expect(hasOurServer(good.claudeJson!)).toBe(false)
    const saved = ledger()
    expect(saved.profiles).toEqual([
      { agent: 'claude', dir: outside },
      { agent: 'claude', dir: good.dir, claudeJson: good.claudeJson },
    ])
    expect(saved.trustedByFile).toEqual({ [join(sb.home, 'x.json')]: ['k'] })
    granted({ trustedByFile: ['not', 'a', 'map'] })
    disconnectAgentIntegration(sb.paths)
    expect(ledger().trustedByFile).toBeUndefined()
  })
})

describe('more edges', () => {
  it('recognises the default profile through its realpath on a case-sensitive platform too', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    granted()
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...original, value: 'linux' })
    try {
      expect(connectAccountProfile(sb.rt, { agent: 'claude', dir: sb.paths.claudeDir, claudeJson: sb.paths.claudeJson })).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })

  it('disconnects a Claude profile named without its .claude.json: only its settings.json', () => {
    granted()
    const c = claudeTarget('.claude-c')
    makeProfile(c)
    connectAccountProfile(sb.rt, c)
    const rows = disconnectAccountProfile(sb.paths, { agent: 'claude', dir: c.dir })
    expect(rows.map((r) => r.file)).toEqual([join(c.dir, 'settings.json'), join(c.dir, 'settings.json')])
    expect(hasOurServer(c.claudeJson!)).toBe(true)
  })

  it('says a Codex home whose config.toml can\'t be read holds no server', () => {
    const x = codexTarget('.codex-dir')
    mkdirSync(join(x.dir, 'config.toml'), { recursive: true })
    expect(profileConnection(x)).toEqual({ server: false, hook: false, allow: false })
  })
})

describe('isAgentIntegrationConnected', () => {
  it('reads the consent every per-account write rests on, from the ledger alone', () => {
    expect(isAgentIntegrationConnected(sb.paths)).toBe(false)
    granted()
    expect(isAgentIntegrationConnected(sb.paths)).toBe(true)
    writeLedger(sb, { consent: 'declined' })
    expect(isAgentIntegrationConnected(sb.paths)).toBe(false)
    // A legacy install that hasn't answered the review stays connected, as at launch.
    writeLedger(sb, { consent: null, legacy: true })
    expect(isAgentIntegrationConnected(sb.paths)).toBe(true)
  })

  it('answers false, never throws, when the ledger can\'t be read', () => {
    expect(isAgentIntegrationConnected({ ...sb.paths, userData: 'relative/ud' })).toBe(false)
    // A userData that isn't a string throws inside the ledger read, as getAgentIntegrationStatus sees.
    expect(isAgentIntegrationConnected({ ...sb.paths, userData: undefined as unknown as string })).toBe(false)
  })
})

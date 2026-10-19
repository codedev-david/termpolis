// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SETTINGS_COPY_KEYS, createProfile, recopyProfile, strippedClaudeSettings, strippedCodexConfig } from '../../src/main/accountProfiles'
import type { CreateProfileOptions } from '../../src/main/accountProfiles'
import { accountFs } from '../../src/main/accountFs'
import type { AccountFs } from '../../src/main/accountFs'
import { CLAUDE_ALLOW_RULES, stripTermpolisEntries } from '../../src/main/agentMcpRegistry'
import { stripCodexSecrets } from '../../src/main/codexConfigEdit'

let root: string
let home: string
let savedTestHome: string | undefined

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tp-acctprof-')))
  home = join(root, 'home')
  mkdirSync(home)
  savedTestHome = process.env.TERMPOLIS_TEST_AGENT_HOME
  process.env.TERMPOLIS_TEST_AGENT_HOME = home
})

afterEach(() => {
  // Take every link out first, as links: the tree is then removed with nothing to walk through.
  const unlinkAll = (dir: string): void => {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const p = join(dir, e)
      const s = lstatSync(p)
      if (s.isSymbolicLink()) {
        try { rmdirSync(p) } catch { unlinkSync(p) }
      } else if (s.isDirectory()) {
        unlinkAll(p)
      }
    }
  }
  unlinkAll(root)
  if (savedTestHome === undefined) delete process.env.TERMPOLIS_TEST_AGENT_HOME
  else process.env.TERMPOLIS_TEST_AGENT_HOME = savedTestHome
  rmSync(root, { recursive: true, force: true })
})

const SECRET = 'sk-' + 'a'.repeat(40)
const HOOK = 'if [ -f "/x/hooks/memory-primer-hook.cjs" ]; then node "/x/hooks/memory-primer-hook.cjs"; fi'
const ADAPTER = '/x/mcp-adapter/stdio-adapter.cjs'

function mainSettings(): Record<string, unknown> {
  return {
    model: 'opus',
    env: { ANTHROPIC_API_KEY: SECRET, OTHER: 'x' },
    apiKeyHelper: '/bin/print-key',
    awsAuthRefresh: 'aws sso login',
    awsCredentialExport: '/bin/export',
    otelHeadersHelper: '/bin/h',
    permissions: { allow: ['Bash(ls)', ...CLAUDE_ALLOW_RULES.slice(0, 3)] },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: HOOK }] }],
      StopFailure: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/auth-failover.sh' }] }],
    },
    statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh' },
    skipDangerousModePermissionPrompt: true,
    mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
  }
}

describe('strippedClaudeSettings (R11)', () => {
  it('keeps only the keys that can hold no secret, and names what it left out, never its value', () => {
    const r = strippedClaudeSettings(JSON.stringify(mainSettings(), null, 2) + '\n')
    if ('error' in r) throw new Error(r.error)
    const kept = JSON.parse(r.text)
    expect(Object.keys(kept).sort()).toEqual(['hooks', 'model', 'permissions', 'skipDangerousModePermissionPrompt', 'statusLine'])
    expect(r.leftOut).toEqual(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'env', 'mcpServers', 'otelHeadersHelper'])
    expect(r.text).not.toContain(SECRET)
    expect(JSON.stringify(r.leftOut)).not.toContain(SECRET)
    expect(r.text.endsWith('\n')).toBe(true)
  })

  it('takes Termpolis\'s own entries out, so an unconnected copy carries none of them', () => {
    const r = strippedClaudeSettings(JSON.stringify(mainSettings()))
    if ('error' in r) throw new Error(r.error)
    const kept = JSON.parse(r.text)
    expect(kept.permissions.allow).toEqual(['Bash(ls)'])
    expect(kept.hooks.SessionStart).toBeUndefined()
    expect(kept.hooks.StopFailure).toHaveLength(1)
  })

  it('copies an empty file as an empty object, and refuses what isn\'t a JSON object', () => {
    expect(strippedClaudeSettings('\uFEFF  ')).toEqual({ text: '\uFEFF{}\n', leftOut: [] })
    expect(strippedClaudeSettings('{ nope')).toEqual({ error: 'the main profile\'s settings.json is not valid JSON' })
    expect(strippedClaudeSettings('[1]')).toEqual({ error: 'the main profile\'s settings.json is not a JSON object' })
    expect(strippedClaudeSettings('null')).toEqual({ error: 'the main profile\'s settings.json is not a JSON object' })
  })

  it('refuses a settings.json whose Termpolis entries can\'t be taken out safely', () => {
    expect(strippedClaudeSettings(JSON.stringify({ permissions: { allow: 'everything' } }))).toEqual({
      error: 'the main profile\'s settings.json can\'t be copied: `permissions.allow` is not an array',
    })
  })

  it('lists exactly the documented keys', () => {
    expect(SETTINGS_COPY_KEYS).toEqual([
      'model', 'effortLevel', 'alwaysThinkingEnabled', 'permissions', 'hooks', 'statusLine', 'outputStyle', 'theme',
      'enabledPlugins', 'includeCoAuthoredBy', 'cleanupPeriodDays', 'spinnerTipsEnabled',
      'skipDangerousModePermissionPrompt', 'autoUpdates',
    ])
  })
})

describe('stripTermpolisEntries', () => {
  it('removes the allow rules, the memory hook and the old server entry, and says so', () => {
    const root0 = mainSettings()
    expect(stripTermpolisEntries(root0)).toBe('remove')
    expect(stripTermpolisEntries(root0)).toBe('unchanged')
    expect(stripTermpolisEntries({})).toBe('unchanged')
    expect(stripTermpolisEntries({ hooks: [] })).toEqual({ skipped: '`hooks` is not an object' })
  })
})

describe('stripCodexSecrets / strippedCodexConfig (R11)', () => {
  const toml = [
    'model = "gpt-6"',
    'model_provider = "corp"',
    '',
    '[model_providers.corp]',
    'name = "Corp"',
    'base_url = "https://corp.example/v1"',
    `experimental_bearer_token = "${SECRET}"`,
    `http_headers = { "X-Key" = "${SECRET}" }`,
    'env_http_headers = { "X-Env" = "CORP_KEY" }',
    '',
    '[model_providers.other.http_headers]',
    `Authorization = "Bearer ${SECRET}"`,
    '',
    '[mcp_servers.termpolis]',
    'command = "node"',
    `args = ["${ADAPTER}"]`,
    '',
    '[mcp_servers.termpolis.tools.memory_search]',
    'approval_mode = "auto"',
    '',
    '[mcp_servers.github]',
    'command = "gh-mcp"',
    `env = { GITHUB_TOKEN = "${SECRET}" }`,
    '',
    '[shell_environment_policy]',
    'inherit = "all"',
    `set = { NPM_TOKEN = "${SECRET}" }`,
    '',
    '[projects.\'C:\\\\work\']',
    'trust_level = "trusted"',
    '',
  ].join('\n')

  it('drops every MCP server, a provider\'s headers and bearer token, and the shell env it sets', () => {
    const r = strippedCodexConfig(toml)
    if ('error' in r) throw new Error(r.error)
    expect(r.text).not.toContain(SECRET)
    expect(r.text).not.toContain('mcp_servers')
    expect(r.text).toContain('model = "gpt-6"')
    expect(r.text).toContain('[model_providers.corp]')
    expect(r.text).toContain('base_url = "https://corp.example/v1"')
    expect(r.text).toContain('inherit = "all"')
    expect(r.text).toContain('trust_level = "trusted"')
    expect(r.leftOut).toEqual([
      'mcp_servers',
      'model_providers.corp.env_http_headers',
      'model_providers.corp.experimental_bearer_token',
      'model_providers.corp.http_headers',
      'model_providers.other.http_headers',
      'shell_environment_policy.set',
    ])
  })

  it('drops a provider written inline when it holds one of those keys, and keeps one that doesn\'t', () => {
    const r = stripCodexSecrets([
      `model_providers.a = { name = "A", experimental_bearer_token = "${SECRET}" }`,
      'model_providers.b = { name = "B" }',
      `mcp_servers = { x = { command = "y", env = { T = "${SECRET}" } } }`,
      `shell_environment_policy = { set = { T = "${SECRET}" } }`,
      '[shell_environment_policy.set]',
      `A = "${SECRET}"`,
      '[model_providers]',
      `c = { name = "C", http_headers = { K = "${SECRET}" } }`,
      'd = { name = "D" }',
      '',
    ].join('\n'))
    if ('error' in r) throw new Error(r.error)
    expect(r.text).not.toContain(SECRET)
    expect(r.text).toContain('model_providers.b = { name = "B" }')
    expect(r.text).toContain('d = { name = "D" }')
    expect(r.leftOut).toEqual(['mcp_servers', 'model_providers.a', 'model_providers.c', 'shell_environment_policy', 'shell_environment_policy.set'])
    const all = stripCodexSecrets(`model_providers = { z = { http_headers = { K = "${SECRET}" } } }\nshell_environment_policy = { inherit = "all" }\n`)
    expect(all).toEqual({ text: 'shell_environment_policy = { inherit = "all" }\n', leftOut: ['model_providers'] })
  })

  it('leaves a config with nothing to drop exactly as it was, and refuses one it can\'t read', () => {
    const plain = 'model = "x"\r\n[projects."/a"]\r\ntrust_level = "trusted"\r\n'
    expect(stripCodexSecrets(plain)).toEqual({ text: plain, leftOut: [] })
    expect(stripCodexSecrets('[unterminated')).toEqual({ error: 'line 1: unreadable table header' })
    expect(strippedCodexConfig('[unterminated')).toEqual({ error: 'the main profile\'s config.toml can\'t be copied: line 1: unreadable table header' })
  })
})

function options(over: Partial<CreateProfileOptions> = {}): CreateProfileOptions {
  return { agent: 'claude', home, slug: 'codedev', share: ['projects', 'commands', 'skills', 'agents'], copy: true, commit: () => null, ...over }
}

function setupMainClaude(): string {
  const main = join(home, '.claude')
  for (const d of ['projects', 'commands', 'skills']) mkdirSync(join(main, d), { recursive: true })
  writeFileSync(join(main, 'projects', 'conversation.jsonl'), '{"keep":true}\n')
  writeFileSync(join(main, 'settings.json'), JSON.stringify(mainSettings(), null, 2))
  writeFileSync(join(main, 'CLAUDE.md'), '# my rules\n')
  // A sign-in file in the main profile: it must never be read, copied or linked.
  writeFileSync(join(main, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: SECRET } }))
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'p@example.test' }, primaryApiKey: SECRET }))
  return main
}

describe('createProfile', () => {
  it('makes ~/.claude-<slug> with links into the main profile and stripped copies, never a sign-in', () => {
    const main = setupMainClaude()
    const committed: Array<{ dir: string; links: unknown }> = []
    const r = createProfile(options({ commit: (dir, links) => { committed.push({ dir, links }); return null } }))
    const dir = join(home, '.claude-codedev')
    expect(r).toEqual({
      ok: true,
      dir,
      links: [
        { name: 'projects', target: join(main, 'projects') },
        { name: 'commands', target: join(main, 'commands') },
        { name: 'skills', target: join(main, 'skills') },
      ],
      copied: ['settings.json', 'CLAUDE.md'],
      leftOut: ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'env', 'mcpServers', 'otelHeadersHelper'],
      notes: ['agents isn\'t shared: the main profile has no agents folder'],
    })
    expect(committed).toEqual([{ dir, links: r.ok ? r.links : [] }])
    // A link really is a link (a junction on Windows), into the main profile's own folder.
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dir, 'projects', 'conversation.jsonl'), 'utf8')).toBe('{"keep":true}\n')
    expect(readdirSync(dir).sort()).toEqual(['CLAUDE.md', 'commands', 'projects', 'settings.json', 'skills'])
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain(SECRET)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# my rules\n')
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, 'settings.json')).mode & 0o777).toBe(0o600)
    }
    // No staging folder is left beside it.
    expect(readdirSync(home).filter((n) => n.includes('.partial-'))).toEqual([])
  })

  it('makes the conversations folder a link needs when the main profile has none yet', () => {
    mkdirSync(join(home, '.claude'))
    const r = createProfile(options({ share: ['projects', 'plugins'], copy: false }))
    expect(r.ok && r.links.map((l) => l.name)).toEqual(['projects'])
    expect(r.ok && r.notes).toEqual(['plugins isn\'t shared: the main profile has no plugins folder'])
    expect(existsSync(join(home, '.claude', 'projects'))).toBe(true)
  })

  it('shares nothing, and says why, when the main profile itself doesn\'t exist', () => {
    const r = createProfile(options({ copy: false, share: ['projects'] }))
    expect(r.ok && r.links).toEqual([])
    expect(r.ok && r.notes).toEqual(['projects isn\'t shared: Claude Code\'s main profile doesn\'t exist yet'])
    // And it never makes the main profile, which would make Claude Code look installed.
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })

  it('ignores a share name that isn\'t one of the agent\'s, and copies nothing the main profile lacks', () => {
    mkdirSync(join(home, '.claude'))
    const r = createProfile(options({ share: ['sessions', '../../etc'], copy: true }))
    expect(r.ok && r.links).toEqual([])
    expect(r.ok && r.copied).toEqual([])
  })

  it('makes a Codex home with its sessions linked and a stripped config.toml', () => {
    const main = join(home, '.codex')
    mkdirSync(main)
    writeFileSync(join(main, 'config.toml'), `model = "x"\n[mcp_servers.gh]\ncommand = "g"\nenv = { T = "${SECRET}" }\n`)
    writeFileSync(join(main, 'auth.json'), JSON.stringify({ tokens: SECRET }))
    const r = createProfile(options({ agent: 'codex', slug: 'work', share: ['sessions'] }))
    const dir = join(home, '.codex-work')
    expect(r).toEqual({ ok: true, dir, links: [{ name: 'sessions', target: join(main, 'sessions') }], copied: ['config.toml'], leftOut: ['mcp_servers'], notes: [] })
    expect(readdirSync(dir).sort()).toEqual(['config.toml', 'sessions'])
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe('model = "x"\n')
  })

  it('refuses a slug that isn\'t a plain folder name, a folder outside the test home, and one that exists', () => {
    expect(createProfile(options({ slug: 'Bad Slug' }))).toEqual({ ok: false, error: 'the name gives no folder name: use letters or digits' })
    expect(createProfile(options({ slug: '' }))).toEqual({ ok: false, error: 'the name gives no folder name: use letters or digits' })
    expect(createProfile(options({ home: join(root, 'elsewhere') }))).toEqual({ ok: false, error: 'the folder would be outside the test home' })
    mkdirSync(join(home, '.claude-codedev'))
    writeFileSync(join(home, '.claude-codedev', 'mine.txt'), 'x')
    const r = createProfile(options())
    expect(r).toEqual({ ok: false, error: `${join(home, '.claude-codedev')} already exists: choose it as an existing folder instead` })
    expect(readFileSync(join(home, '.claude-codedev', 'mine.txt'), 'utf8')).toBe('x')
  })

  it('reports a staging folder it couldn\'t make, with nothing to undo', () => {
    const fsx: AccountFs = { ...accountFs, mkdir: () => { throw new Error('EACCES: no') } }
    expect(createProfile(options(), fsx)).toEqual({ ok: false, error: 'EACCES: no' })
  })
})

/** The real fs, with one operation made to fail on its `nth` call. */
function failing(op: keyof AccountFs, nth = 1): AccountFs {
  let calls = 0
  const real = accountFs[op] as (...args: unknown[]) => unknown
  return {
    ...accountFs,
    [op]: (...args: unknown[]) => {
      if (++calls === nth) throw new Error(`${op} failed`)
      return real(...args)
    },
  } as AccountFs
}

describe('createProfile rolls back, removing only what it made (R19)', () => {
  function assertUndone(): void {
    expect(readdirSync(home).sort()).toEqual(['.claude', '.claude.json'])
    // The main profile and everything a link pointed at is untouched.
    expect(readFileSync(join(home, '.claude', 'projects', 'conversation.jsonl'), 'utf8')).toBe('{"keep":true}\n')
    expect(readdirSync(join(home, '.claude')).sort()).toEqual(['.credentials.json', 'CLAUDE.md', 'commands', 'projects', 'settings.json', 'skills'])
  }

  it('after a link fails part-way', () => {
    setupMainClaude()
    expect(createProfile(options(), failing('link', 2))).toEqual({ ok: false, error: 'link failed' })
    assertUndone()
  })

  it('after a copy fails, links already made', () => {
    setupMainClaude()
    expect(createProfile(options(), failing('writePrivate', 2))).toEqual({ ok: false, error: 'writePrivate failed' })
    assertUndone()
  })

  it('after the main settings.json turns out unreadable', () => {
    setupMainClaude()
    writeFileSync(join(home, '.claude', 'settings.json'), '{ broken')
    expect(createProfile(options())).toEqual({ ok: false, error: 'the main profile\'s settings.json is not valid JSON' })
    expect(readdirSync(home).sort()).toEqual(['.claude', '.claude.json'])
  })

  it('after the rename fails', () => {
    setupMainClaude()
    expect(createProfile(options(), failing('rename'))).toEqual({ ok: false, error: 'rename failed' })
    assertUndone()
  })

  it('after the registry entry can\'t be written, once the folder is in place', () => {
    setupMainClaude()
    expect(createProfile(options({ commit: () => 'agent-accounts.json could not be saved (EPERM)' }))).toEqual({
      ok: false, error: 'agent-accounts.json could not be saved (EPERM)',
    })
    assertUndone()
  })

  it('leaves the folder, and says where, when something it didn\'t make is in it', () => {
    setupMainClaude()
    const r = createProfile(options({
      commit: (dir) => {
        writeFileSync(join(dir, 'someone-elses.txt'), 'x')
        return 'commit failed'
      },
    }))
    expect(r).toEqual({ ok: false, error: 'commit failed', leftAt: join(home, '.claude-codedev') })
    // Only what it made is gone.
    expect(readdirSync(join(home, '.claude-codedev'))).toEqual(['someone-elses.txt'])
  })

  it('never removes a link or file it can\'t identify as its own, and keeps the folder', () => {
    setupMainClaude()
    const fsx: AccountFs = {
      ...accountFs,
      unlinkLink: () => { throw new Error('not a link') },
      removeFile: () => { throw new Error('busy') },
    }
    const r = createProfile(options({ commit: () => 'x' }), fsx)
    expect(r).toEqual({ ok: false, error: 'x', leftAt: join(home, '.claude-codedev') })
    // The links are still there, and still links: the main profile's files are intact.
    expect(lstatSync(join(home, '.claude-codedev', 'projects')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(home, '.claude', 'projects', 'conversation.jsonl'), 'utf8')).toBe('{"keep":true}\n')
  })

  it('reports a non-Error failure as text', () => {
    setupMainClaude()
    const fsx: AccountFs = { ...accountFs, rename: () => { throw 'plain string' } }
    expect(createProfile(options(), fsx)).toEqual({ ok: false, error: 'plain string' })
  })
})

describe('recopyProfile: "Re-copy from main profile"', () => {
  it('writes fresh stripped copies over the profile\'s own, and says what it left out', () => {
    setupMainClaude()
    const r = createProfile(options({ share: [] }))
    if (!r.ok) throw new Error(r.error)
    writeFileSync(join(r.dir, 'settings.json'), '{"model":"haiku"}\n')
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# my new rules\n')
    const again = recopyProfile('claude', home, r.dir)
    expect(again).toEqual({ ok: true, copied: ['settings.json', 'CLAUDE.md'], leftOut: ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'env', 'mcpServers', 'otelHeadersHelper'] })
    expect(JSON.parse(readFileSync(join(r.dir, 'settings.json'), 'utf8')).model).toBe('opus')
    expect(readFileSync(join(r.dir, 'settings.json'), 'utf8')).not.toContain(SECRET)
    expect(readFileSync(join(r.dir, 'CLAUDE.md'), 'utf8')).toBe('# my new rules\n')
    expect(existsSync(join(r.dir, '.credentials.json'))).toBe(false)
  })

  it('writes nothing when a main file can\'t be copied, and skips one the main profile lacks', () => {
    setupMainClaude()
    const r = createProfile(options({ share: [] }))
    if (!r.ok) throw new Error(r.error)
    writeFileSync(join(home, '.claude', 'settings.json'), '{ broken')
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# changed\n')
    expect(recopyProfile('claude', home, r.dir)).toEqual({ ok: false, error: 'the main profile\'s settings.json is not valid JSON' })
    expect(readFileSync(join(r.dir, 'CLAUDE.md'), 'utf8')).toBe('# my rules\n')
    rmSync(join(home, '.claude', 'settings.json'))
    expect(recopyProfile('claude', home, r.dir)).toEqual({ ok: true, copied: ['CLAUDE.md'], leftOut: [] })
  })

  it('re-copies a Codex home\'s config.toml, stripped', () => {
    mkdirSync(join(home, '.codex', 'sessions'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), `model = "gpt-5"\n[mcp_servers.x]\ncommand = "y"\nenv = { T = "${SECRET}" }\n`)
    const r = createProfile(options({ agent: 'codex', slug: 'cx', share: [] }))
    if (!r.ok) throw new Error(r.error)
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n')
    expect(recopyProfile('codex', home, r.dir)).toMatchObject({ ok: true, copied: ['config.toml'] })
    expect(readFileSync(join(r.dir, 'config.toml'), 'utf8')).toContain('o3')
  })

  it('refuses a folder that is missing, outside the test home, or the main profile itself', () => {
    setupMainClaude()
    expect(recopyProfile('claude', home, join(home, '.claude-none'))).toEqual({ ok: false, error: 'the profile folder doesn\'t exist' })
    expect(recopyProfile('claude', home, join(root, 'elsewhere'))).toEqual({ ok: false, error: 'the profile folder doesn\'t exist' })
    expect(recopyProfile('claude', home, join(home, '.claude'))).toEqual({ ok: false, error: 'that is the main profile' })
  })

  it('reports a write it couldn\'t make', () => {
    setupMainClaude()
    const r = createProfile(options({ share: [] }))
    if (!r.ok) throw new Error(r.error)
    const fsx: AccountFs = { ...accountFs, writePrivate: () => { throw new Error('EACCES') } }
    expect(recopyProfile('claude', home, r.dir, fsx)).toEqual({ ok: false, error: 'EACCES' })
  })
})

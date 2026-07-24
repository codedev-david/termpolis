// Unit tests for artifactInstaller — the INSTALL stage of Safe Import.
//
// Everything here runs against an INJECTED in-memory fs (no real disk, no
// electron), which is the whole point of the DI'd InstallerDeps: the risky
// part of Safe Import is that we write into the user's REAL agent configs
// (~/.claude, ~/.codex, ~/.gemini), so the merge/idempotency/
// never-clobber rules have to be provable without touching them.
//
// The one exception is defaultInstallerDeps(), which is exercised against a
// real temp dir — an fs adapter that is never run against a real fs is an
// fs adapter that doesn't work.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  classifyArtifact,
  supportedTargets,
  installArtifact,
  uninstallArtifact,
  defaultInstallerDeps,
  type Artifact,
  type ArtifactFile,
  type InstallerDeps,
} from '../../src/main/artifactInstaller'

const HOME = '/home/dev'

// In-memory fs. `dirs` is tracked separately so we can assert we mkdirp'd the
// nested skill dirs before writing into them.
function fakeFs(home = HOME) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const deps: InstallerDeps = {
    home: () => home,
    readFile: (p) => (files.has(p) ? (files.get(p) as string) : null),
    writeFile: (p, data) => { files.set(p, data) },
    mkdirp: (p) => { dirs.add(p) },
    exists: (p) => files.has(p) || dirs.has(p),
    rm: (p) => { files.delete(p) },
  }
  return { deps, files, dirs }
}

// Paths under test, built with the same join() the module uses so these
// assertions hold on win32 (backslashes) and posix alike.
const claudeSettings = join(HOME, '.claude', 'settings.json')
const geminiSettings = join(HOME, '.gemini', 'settings.json')
const codexToml = join(HOME, '.codex', 'config.toml')

const SKILL_MD = '---\nname: pdf-filler\ndescription: Fill in PDF forms\n---\n\n# PDF Filler\nDo the thing.\n'
const COMMAND_MD = '---\ndescription: Ship the current branch\n---\n\nDeploy $ARGUMENTS to prod.\n'
const SUBAGENT_MD = '---\nname: code-reviewer\ndescription: Reviews code\ntools: Read, Grep, Glob\n---\n\nYou are a reviewer.\n'
const MCP_JSON = JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', 'context7-mcp'] } } })

const skillArtifact = (): Artifact => ({
  name: 'pdf-filler',
  kind: 'skill',
  files: [
    { path: 'pdf-filler/SKILL.md', content: SKILL_MD },
    { path: 'pdf-filler/scripts/fill.py', content: 'print("fill")\n' },
  ],
})
const commandArtifact = (): Artifact => ({
  name: 'deploy',
  kind: 'command',
  files: [{ path: 'commands/deploy.md', content: COMMAND_MD }],
})
const subagentArtifact = (): Artifact => ({
  name: 'code-reviewer',
  kind: 'subagent',
  files: [{ path: 'agents/code-reviewer.md', content: SUBAGENT_MD }],
})
const mcpArtifact = (): Artifact => ({
  name: 'context7',
  kind: 'mcp',
  files: [{ path: '.mcp.json', content: MCP_JSON }],
  mcp: { command: 'npx', args: ['-y', 'context7-mcp'] },
})

describe('artifactInstaller', () => {
  describe('classifyArtifact', () => {
    it('classifies a SKILL.md bundle as a skill named after its parent dir', () => {
      const r = classifyArtifact(skillArtifact().files)
      expect(r).toEqual({ kind: 'skill', name: 'pdf-filler' })
    })

    it('finds SKILL.md at any depth (github zips nest under <repo>-main/)', () => {
      const files: ArtifactFile[] = [
        { path: 'awesome-skills-main/skills/brand-voice/SKILL.md', content: SKILL_MD },
        { path: 'awesome-skills-main/README.md', content: '# readme' },
      ]
      expect(classifyArtifact(files)).toEqual({ kind: 'skill', name: 'brand-voice' })
    })

    it('falls back to the frontmatter name when SKILL.md has no parent dir', () => {
      const files: ArtifactFile[] = [{ path: 'SKILL.md', content: SKILL_MD }]
      expect(classifyArtifact(files)).toEqual({ kind: 'skill', name: 'pdf-filler' })
    })

    it('classifies .claude-plugin/plugin.json as a plugin, named from the manifest', () => {
      const files: ArtifactFile[] = [
        { path: 'acme-pack/.claude-plugin/plugin.json', content: '{"name":"acme-pack","description":"x"}' },
        { path: 'acme-pack/commands/hi.md', content: COMMAND_MD },
      ]
      expect(classifyArtifact(files)).toEqual({ kind: 'plugin', name: 'acme-pack' })
    })

    it('plugin beats the .mcp.json it bundles (the plugin is the container)', () => {
      const files: ArtifactFile[] = [
        { path: '.claude-plugin/plugin.json', content: '{"name":"acme-pack"}' },
        { path: '.mcp.json', content: MCP_JSON },
      ]
      expect(classifyArtifact(files)?.kind).toBe('plugin')
    })

    it('plugin beats a bundled SKILL.md', () => {
      const files: ArtifactFile[] = [
        { path: 'p/.claude-plugin/plugin.json', content: '{"name":"acme-pack"}' },
        { path: 'p/skills/pdf-filler/SKILL.md', content: SKILL_MD },
      ]
      expect(classifyArtifact(files)?.kind).toBe('plugin')
    })

    it('classifies a .mcp.json as mcp, named from the first server key', () => {
      expect(classifyArtifact([{ path: '.mcp.json', content: MCP_JSON }])).toEqual({ kind: 'mcp', name: 'context7' })
    })

    it('classifies ANY json containing an mcpServers key as mcp', () => {
      const files: ArtifactFile[] = [{ path: 'servers.json', content: '{"mcpServers":{"linear":{"command":"npx"}}}' }]
      expect(classifyArtifact(files)).toEqual({ kind: 'mcp', name: 'linear' })
    })

    it('classifies name+tools frontmatter as a subagent (NOT a command)', () => {
      // A subagent md also has `description:` — `tools:` is the discriminator,
      // so subagent must be tested before command or every agent misfiles.
      const r = classifyArtifact(subagentArtifact().files)
      expect(r).toEqual({ kind: 'subagent', name: 'code-reviewer' })
    })

    it('names a subagent from its frontmatter (Claude keys the agent off `name:`)', () => {
      const files: ArtifactFile[] = [{ path: 'agents/whatever-file.md', content: SUBAGENT_MD }]
      expect(classifyArtifact(files)).toEqual({ kind: 'subagent', name: 'code-reviewer' })
    })

    it('classifies a lone description-only md as a command named after the FILE', () => {
      // The slash-command name is the filename, so the basename wins.
      expect(classifyArtifact(commandArtifact().files)).toEqual({ kind: 'command', name: 'deploy' })
    })

    it('returns null for a plain md with no frontmatter', () => {
      expect(classifyArtifact([{ path: 'README.md', content: '# hello' }])).toBeNull()
    })

    it('returns null for frontmatter with neither description nor tools', () => {
      expect(classifyArtifact([{ path: 'x.md', content: '---\ntitle: nope\n---\nbody' }])).toBeNull()
    })

    it('returns null for junk (a shell script, a stray json)', () => {
      expect(classifyArtifact([{ path: 'evil.sh', content: 'rm -rf /' }])).toBeNull()
      expect(classifyArtifact([{ path: 'package.json', content: '{"name":"x"}' }])).toBeNull()
    })

    it('returns null for an empty file list', () => {
      expect(classifyArtifact([])).toBeNull()
    })

    it('returns null when several markdown files are ambiguous (no SKILL.md, no manifest)', () => {
      const files: ArtifactFile[] = [
        { path: 'a.md', content: COMMAND_MD },
        { path: 'b.md', content: COMMAND_MD },
      ]
      expect(classifyArtifact(files)).toBeNull()
    })

    it('survives a .mcp.json / plugin.json that is corrupt JSON', () => {
      expect(() => classifyArtifact([{ path: '.mcp.json', content: '{{{ not json' }])).not.toThrow()
      expect(classifyArtifact([{ path: '.mcp.json', content: '{{{ not json' }])?.kind).toBe('mcp')
      expect(classifyArtifact([{ path: '.claude-plugin/plugin.json', content: 'nope' }])?.kind).toBe('plugin')
    })
  })

  describe('supportedTargets', () => {
    it('mcp is the only artifact every agent can take', () => {
      expect(supportedTargets('mcp')).toEqual(['claude', 'codex', 'gemini'])
    })
    it('skills and plugins are Claude-only', () => {
      expect(supportedTargets('skill')).toEqual(['claude'])
      expect(supportedTargets('plugin')).toEqual(['claude'])
    })
    it('commands go everywhere except codex (which uses prompts, not commands)', () => {
      expect(supportedTargets('command')).toEqual(['claude', 'gemini'])
    })
    it('subagents are Claude-only', () => {
      expect(supportedTargets('subagent')).toEqual(['claude'])
    })
    it('returns nothing (rather than throwing) for a kind it does not know', () => {
      // The kind can arrive over IPC from the renderer — junk must not crash it.
      expect(supportedTargets('nonsense' as never)).toEqual([])
    })
    it('hands back a fresh array each call (callers must not corrupt the table)', () => {
      const a = supportedTargets('mcp')
      a.push('claude')
      expect(supportedTargets('mcp')).toHaveLength(3)
    })
  })

  describe('installArtifact — skill', () => {
    it('writes every file under ~/.claude/skills/<name>/ preserving relative paths', () => {
      const { deps, files, dirs } = fakeFs()
      const written = installArtifact(skillArtifact(), ['claude'], deps)

      const skillMd = join(HOME, '.claude', 'skills', 'pdf-filler', 'SKILL.md')
      const script = join(HOME, '.claude', 'skills', 'pdf-filler', 'scripts', 'fill.py')
      expect(written).toEqual([
        { target: 'claude', path: skillMd },
        { target: 'claude', path: script },
      ])
      expect(files.get(skillMd)).toBe(SKILL_MD)
      expect(files.get(script)).toBe('print("fill")\n')
      // Nested dir must be mkdirp'd or the real writeFile would ENOENT.
      expect(dirs.has(join(HOME, '.claude', 'skills', 'pdf-filler', 'scripts'))).toBe(true)
    })

    it('installs under the APPROVED name, not the zip dir name', () => {
      const { deps, files } = fakeFs()
      const a = { ...skillArtifact(), name: 'renamed' }
      installArtifact(a, ['claude'], deps)
      expect(files.has(join(HOME, '.claude', 'skills', 'renamed', 'SKILL.md'))).toBe(true)
    })

    it('ignores archive junk that lives outside the SKILL.md dir', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = {
        name: 'brand-voice',
        kind: 'skill',
        files: [
          { path: 'repo-main/README.md', content: '# repo' },
          { path: 'repo-main/LICENSE', content: 'MIT' },
          // Nested DEEPER than the skill root but on a sibling branch — without a
          // real prefix check this lands inside the skill as `notes.md`.
          { path: 'repo-main/docs/guide/notes.md', content: 'junk' },
          { path: 'repo-main/skills/other-skill/SKILL.md', content: '---\nname: other\n---\n' },
          { path: 'repo-main/skills/brand-voice/SKILL.md', content: SKILL_MD },
        ],
      }
      const written = installArtifact(a, ['claude'], deps)
      const root = join(HOME, '.claude', 'skills', 'brand-voice')
      expect(written).toEqual([{ target: 'claude', path: join(root, 'SKILL.md') }])
      expect(files.get(join(root, 'SKILL.md'))).toBe(SKILL_MD)
      expect([...files.keys()]).toHaveLength(1)
      // Specifically: no junk smuggled in under a rewritten relative path.
      expect(files.has(join(root, 'notes.md'))).toBe(false)
      expect([...files.keys()].some((p) => /LICENSE|README|notes|other/.test(p))).toBe(false)
    })

    it('refuses zip-slip paths and skips bare directory entries', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = {
        name: 'pdf-filler',
        kind: 'skill',
        files: [
          { path: 'pdf-filler', content: '' },                        // zip dir entry
          { path: 'pdf-filler/SKILL.md', content: SKILL_MD },
          { path: 'pdf-filler/../../../.bashrc', content: 'evil' },   // zip-slip
        ],
      }
      const written = installArtifact(a, ['claude'], deps)
      expect(written).toHaveLength(1)
      expect([...files.keys()]).toEqual([join(HOME, '.claude', 'skills', 'pdf-filler', 'SKILL.md')])
    })

    it('falls back to the archive root when a skill has no SKILL.md anchor', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = { name: 'odd', kind: 'skill', files: [{ path: 'notes.txt', content: 'x' }] }
      installArtifact(a, ['claude'], deps)
      expect(files.has(join(HOME, '.claude', 'skills', 'odd', 'notes.txt'))).toBe(true)
    })

    it('is a no-op for unsupported targets (codex/gemini cannot take skills)', () => {
      const { deps, files } = fakeFs()
      const written = installArtifact(skillArtifact(), ['codex', 'gemini'], deps)
      expect(written).toEqual([])
      expect(files.size).toBe(0)
    })

    it('omits the unsupported target but still installs the supported one', () => {
      const { deps } = fakeFs()
      const written = installArtifact(skillArtifact(), ['codex', 'claude'], deps)
      expect(written.every((w) => w.target === 'claude')).toBe(true)
      expect(written).toHaveLength(2)
    })
  })

  describe('installArtifact — plugin', () => {
    it('writes the plugin tree into the local marketplace Claude already reads', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = {
        name: 'acme-pack',
        kind: 'plugin',
        files: [
          { path: 'src/.claude-plugin/plugin.json', content: '{"name":"acme-pack"}' },
          { path: 'src/commands/hi.md', content: COMMAND_MD },
        ],
      }
      const written = installArtifact(a, ['claude'], deps)
      const root = join(HOME, '.claude', 'local-marketplace', 'plugins', 'acme-pack')
      expect(written.map((w) => w.path)).toEqual([
        join(root, '.claude-plugin', 'plugin.json'),
        join(root, 'commands', 'hi.md'),
      ])
      expect(files.get(join(root, '.claude-plugin', 'plugin.json'))).toBe('{"name":"acme-pack"}')
    })
  })

  describe('installArtifact — command', () => {
    it('writes ~/.claude/commands/<name>.md verbatim', () => {
      const { deps, files } = fakeFs()
      const written = installArtifact(commandArtifact(), ['claude'], deps)
      const p = join(HOME, '.claude', 'commands', 'deploy.md')
      expect(written).toEqual([{ target: 'claude', path: p }])
      expect(files.get(p)).toBe(COMMAND_MD)
    })

    it('transpiles to Gemini TOML commands (they are not markdown)', () => {
      const { deps, files } = fakeFs()
      const written = installArtifact(commandArtifact(), ['gemini'], deps)
      const gp = join(HOME, '.gemini', 'commands', 'deploy.toml')
      expect(written).toEqual([
        { target: 'gemini', path: gp },
      ])
      const toml = files.get(gp) as string
      expect(toml).toContain('description = "Ship the current branch"')
      expect(toml).toContain('prompt = """')
      expect(toml).toContain('Deploy {{args}} to prod.') // $ARGUMENTS → {{args}}
      expect(toml).not.toContain('$ARGUMENTS')
      expect(toml).not.toContain('---') // frontmatter stripped, not shipped as prompt text
    })

    it('escapes TOML metacharacters in the prompt body', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = {
        name: 'evil',
        kind: 'command',
        files: [{ path: 'evil.md', content: '---\ndescription: has "quotes" and \\ slash\n---\nbody """ end\n' }],
      }
      installArtifact(a, ['gemini'], deps)
      const toml = files.get(join(HOME, '.gemini', 'commands', 'evil.toml')) as string
      expect(toml).toContain('description = "has \\"quotes\\" and \\\\ slash"')
      // A raw """ inside a multi-line basic string would terminate it early.
      expect(toml).toContain('body \\"\\"\\" end')
      // Exactly two delimiters: the opener and the closer.
      expect(toml.match(/"""/g)).toHaveLength(2)
    })

    it('emits a prompt-only TOML when the markdown has no frontmatter', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = { name: 'bare', kind: 'command', files: [{ path: 'bare.md', content: 'just a prompt' }] }
      installArtifact(a, ['gemini'], deps)
      const toml = files.get(join(HOME, '.gemini', 'commands', 'bare.toml')) as string
      expect(toml).not.toContain('description =')
      expect(toml).toContain('prompt = """\njust a prompt\n"""')
    })

    it('is a no-op for codex (prompts, not commands)', () => {
      const { deps, files } = fakeFs()
      expect(installArtifact(commandArtifact(), ['codex'], deps)).toEqual([])
      expect(files.size).toBe(0)
    })

    it('writes nothing when the artifact carries no markdown at all', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = { name: 'x', kind: 'command', files: [{ path: 'x.txt', content: 'not markdown' }] }
      expect(installArtifact(a, ['claude'], deps)).toEqual([])
      expect(files.size).toBe(0)
    })
  })

  describe('installArtifact — subagent', () => {
    it('writes ~/.claude/agents/<name>.md', () => {
      const { deps, files } = fakeFs()
      const written = installArtifact(subagentArtifact(), ['claude'], deps)
      const p = join(HOME, '.claude', 'agents', 'code-reviewer.md')
      expect(written).toEqual([{ target: 'claude', path: p }])
      expect(files.get(p)).toBe(SUBAGENT_MD)
    })
  })

  describe('installArtifact — mcp', () => {
    it('MERGES into existing settings without clobbering another server or other keys', () => {
      const { deps, files } = fakeFs()
      files.set(claudeSettings, JSON.stringify({
        mcpServers: { termpolis: { command: 'node', args: ['/adapter.cjs'] } },
        permissions: { allow: ['mcp__termpolis__*'] },
      }))
      const written = installArtifact(mcpArtifact(), ['claude'], deps)
      expect(written).toEqual([{ target: 'claude', path: claudeSettings }])

      const v = JSON.parse(files.get(claudeSettings) as string)
      expect(v.mcpServers.termpolis.args[0]).toBe('/adapter.cjs') // untouched
      expect(v.mcpServers.context7).toEqual({ command: 'npx', args: ['-y', 'context7-mcp'] })
      expect(v.permissions.allow).toEqual(['mcp__termpolis__*']) // unrelated keys survive
    })

    it('creates the settings file (and its dir) when the agent has none yet', () => {
      const { deps, files, dirs } = fakeFs()
      installArtifact(mcpArtifact(), ['gemini'], deps)
      expect(dirs.has(join(HOME, '.gemini'))).toBe(true)
      expect(JSON.parse(files.get(geminiSettings) as string).mcpServers.context7.command).toBe('npx')
    })

    it('writes env when the server declares it', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = { ...mcpArtifact(), mcp: { command: 'npx', env: { API_KEY: 'xyz' } } }
      installArtifact(a, ['gemini'], deps)
      const entry = JSON.parse(files.get(geminiSettings) as string).mcpServers.context7
      expect(entry).toEqual({ command: 'npx', env: { API_KEY: 'xyz' } })
      expect('args' in entry).toBe(false) // no empty args noise
    })

    it('falls back to the server def inside the artifact files when a.mcp is absent', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = { name: 'context7', kind: 'mcp', files: [{ path: '.mcp.json', content: MCP_JSON }] }
      installArtifact(a, ['claude'], deps)
      expect(JSON.parse(files.get(claudeSettings) as string).mcpServers.context7.args).toEqual(['-y', 'context7-mcp'])
    })

    it('keys the entry off the APPROVED name even when the json calls it something else', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = {
        name: 'my-c7',
        kind: 'mcp',
        files: [{ path: '.mcp.json', content: '{"mcpServers":{"context7":{"command":"npx","env":{"K":"v"}}}}' }],
      }
      installArtifact(a, ['claude'], deps)
      const servers = JSON.parse(files.get(claudeSettings) as string).mcpServers
      expect(servers['my-c7']).toEqual({ command: 'npx', env: { K: 'v' } })
      expect(servers.context7).toBeUndefined()
    })

    it('creates the settings file when the existing one is empty', () => {
      const { deps, files } = fakeFs()
      files.set(claudeSettings, '')
      installArtifact(mcpArtifact(), ['claude'], deps)
      expect(JSON.parse(files.get(claudeSettings) as string).mcpServers.context7.command).toBe('npx')
    })

    it('omits args from the Codex block when the server has none', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = { ...mcpArtifact(), mcp: { command: 'my-server' } }
      installArtifact(a, ['codex'], deps)
      const toml = files.get(codexToml) as string
      expect(toml).toContain('command = "my-server"')
      expect(toml).not.toContain('args =')
      expect(toml).not.toContain('.env]')
    })

    it('refuses to touch a CORRUPT settings file (never nuke a hand-edited config)', () => {
      const { deps, files } = fakeFs()
      files.set(claudeSettings, '{"mcpServers": {broken')
      const written = installArtifact(mcpArtifact(), ['claude'], deps)
      expect(written).toEqual([]) // omitted — the caller can surface the failure
      expect(files.get(claudeSettings)).toBe('{"mcpServers": {broken') // byte-identical
    })

    it('recovers when the settings root is the wrong shape (array / primitive)', () => {
      const { deps, files } = fakeFs()
      files.set(geminiSettings, '[1,2,3]')
      installArtifact(mcpArtifact(), ['gemini'], deps)
      expect(JSON.parse(files.get(geminiSettings) as string).mcpServers.context7.command).toBe('npx')
    })

    it('appends a [mcp_servers.<name>] block to the Codex TOML, preserving user content', () => {
      const { deps, files } = fakeFs()
      const before = '# MY CONFIG\nmodel = "gpt-5"\n'
      files.set(codexToml, before)
      const written = installArtifact(mcpArtifact(), ['codex'], deps)
      expect(written).toEqual([{ target: 'codex', path: codexToml }])
      const after = files.get(codexToml) as string
      expect(after.startsWith(before)).toBe(true) // append-only
      expect(after).toContain('[mcp_servers.context7]')
      expect(after).toContain('command = "npx"')
      expect(after).toContain('args = ["-y", "context7-mcp"]')
    })

    it('escapes Windows backslashes and writes an env sub-table in the Codex TOML', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = {
        ...mcpArtifact(),
        mcp: { command: 'C:\\tools\\mcp.exe', args: ['C:\\a b\\x.js'], env: { TOKEN: 'sh"h' } },
      }
      installArtifact(a, ['codex'], deps)
      const toml = files.get(codexToml) as string
      expect(toml).toContain('command = "C:\\\\tools\\\\mcp.exe"')
      expect(toml).toContain('args = ["C:\\\\a b\\\\x.js"]')
      expect(toml).toContain('[mcp_servers.context7.env]')
      expect(toml).toContain('TOKEN = "sh\\"h"')
    })

    it('creates the Codex TOML when missing', () => {
      const { deps, files, dirs } = fakeFs()
      installArtifact(mcpArtifact(), ['codex'], deps)
      expect(dirs.has(join(HOME, '.codex'))).toBe(true)
      expect(files.get(codexToml)).toContain('[mcp_servers.context7]')
    })

    it('installs to all three agents at once', () => {
      const { deps } = fakeFs()
      const written = installArtifact(mcpArtifact(), ['claude', 'codex', 'gemini'], deps)
      expect(written.map((w) => w.target)).toEqual(['claude', 'codex', 'gemini'])
    })

    it('omits the target when the server def cannot be resolved at all', () => {
      const { deps, files } = fakeFs()
      const a: Artifact = { name: 'ghost', kind: 'mcp', files: [{ path: '.mcp.json', content: '{}' }] }
      expect(installArtifact(a, ['claude', 'codex'], deps)).toEqual([])
      expect(files.size).toBe(0)
    })
  })

  describe('idempotency', () => {
    it('installing an MCP server twice does not duplicate the Codex TOML block', () => {
      const { deps, files } = fakeFs()
      files.set(codexToml, 'model = "gpt-5"\n')
      const first = installArtifact(mcpArtifact(), ['codex'], deps)
      const afterFirst = files.get(codexToml) as string
      const second = installArtifact(mcpArtifact(), ['codex'], deps)

      expect(second).toEqual(first) // same result — install is safe to repeat
      expect(files.get(codexToml)).toBe(afterFirst) // byte-identical: no second append
      expect((files.get(codexToml) as string).match(/\[mcp_servers\.context7\]/g)).toHaveLength(1)
    })

    it('installing anything twice leaves the same files and returns the same paths', () => {
      const cases: Artifact[] = [skillArtifact(), commandArtifact(), subagentArtifact(), mcpArtifact()]
      for (const a of cases) {
        const { deps, files } = fakeFs()
        const targets = supportedTargets(a.kind)
        const first = installArtifact(a, targets, deps)
        const snap = JSON.stringify([...files.entries()].sort())
        const second = installArtifact(a, targets, deps)
        expect(second).toEqual(first)
        expect(JSON.stringify([...files.entries()].sort())).toBe(snap)
      }
    })
  })

  describe('uninstallArtifact', () => {
    it('removes exactly the files the skill install wrote', () => {
      const { deps, files } = fakeFs()
      const a = skillArtifact()
      const written = installArtifact(a, ['claude'], deps)
      expect(files.size).toBe(2)

      const removed = uninstallArtifact(a, ['claude'], deps)
      expect(removed).toEqual(written.map((w) => w.path))
      expect(files.size).toBe(0)
    })

    it('only reports what actually existed (second uninstall removes nothing)', () => {
      const { deps } = fakeFs()
      const a = commandArtifact()
      installArtifact(a, ['claude', 'gemini'], deps)
      expect(uninstallArtifact(a, ['claude', 'gemini'], deps)).toHaveLength(2)
      expect(uninstallArtifact(a, ['claude', 'gemini'], deps)).toEqual([])
    })

    it('deletes ONLY our mcpServers key — other servers and keys survive', () => {
      const { deps, files } = fakeFs()
      files.set(claudeSettings, JSON.stringify({
        mcpServers: { termpolis: { command: 'node' } },
        permissions: { allow: ['mcp__termpolis__*'] },
      }))
      const a = mcpArtifact()
      installArtifact(a, ['claude'], deps)
      const removed = uninstallArtifact(a, ['claude'], deps)

      expect(removed).toEqual([claudeSettings])
      const v = JSON.parse(files.get(claudeSettings) as string)
      expect(v.mcpServers.context7).toBeUndefined()
      expect(v.mcpServers.termpolis).toEqual({ command: 'node' })
      expect(v.permissions.allow).toEqual(['mcp__termpolis__*'])
    })

    it('strips only our block from the Codex TOML, leaving user content intact', () => {
      const { deps, files } = fakeFs()
      const before = '# MY CONFIG\nmodel = "gpt-5"\n\n[mcp_servers.termpolis]\ncommand = "node"\nargs = ["/a.cjs"]\n'
      files.set(codexToml, before)
      const a = mcpArtifact()
      installArtifact(a, ['codex'], deps)
      const removed = uninstallArtifact(a, ['codex'], deps)

      expect(removed).toEqual([codexToml])
      const after = files.get(codexToml) as string
      expect(after).not.toContain('[mcp_servers.context7]')
      expect(after).not.toContain('context7-mcp')
      expect(after).toContain('[mcp_servers.termpolis]') // neighbour block survives
      expect(after).toContain('model = "gpt-5"')
    })

    it('returns nothing when the mcp entry was never installed', () => {
      const { deps, files } = fakeFs()
      files.set(claudeSettings, JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
      files.set(codexToml, 'model = "gpt-5"\n')
      expect(uninstallArtifact(mcpArtifact(), ['claude', 'codex'], deps)).toEqual([])
      expect(JSON.parse(files.get(claudeSettings) as string).mcpServers.other).toBeDefined()
    })

    it('leaves a corrupt settings file alone', () => {
      const { deps, files } = fakeFs()
      files.set(claudeSettings, 'garbage{{{')
      expect(uninstallArtifact(mcpArtifact(), ['claude'], deps)).toEqual([])
      expect(files.get(claudeSettings)).toBe('garbage{{{')
    })

    it('does not CREATE a config for an agent that has none (uninstall never writes)', () => {
      const { deps, files } = fakeFs()
      expect(uninstallArtifact(mcpArtifact(), ['claude', 'codex', 'gemini'], deps)).toEqual([])
      expect(files.size).toBe(0)
    })

    it('is a no-op for unsupported targets', () => {
      const { deps } = fakeFs()
      installArtifact(skillArtifact(), ['claude'], deps)
      expect(uninstallArtifact(skillArtifact(), ['codex', 'gemini'], deps)).toEqual([])
    })

    it('reports nothing for file artifacts when deps.rm is absent (never lie about deleting)', () => {
      const { deps, files } = fakeFs()
      const noRm: InstallerDeps = { ...deps, rm: undefined }
      const a = skillArtifact()
      installArtifact(a, ['claude'], noRm)
      // No delete primitive → we cannot remove files, so we must not claim we did.
      expect(uninstallArtifact(a, ['claude'], noRm)).toEqual([])
      expect(files.size).toBe(2)
      // MCP entries are a rewrite, not a delete — those still work without rm.
      const m = mcpArtifact()
      installArtifact(m, ['claude'], noRm)
      expect(uninstallArtifact(m, ['claude'], noRm)).toEqual([claudeSettings])
    })
  })

  // The DI'd deps are only worth anything if the REAL adapter behind them works.
  describe('defaultInstallerDeps (real fs)', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tp-artifact-')) })
    afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

    it('round-trips a skill install/uninstall on a real filesystem', () => {
      const deps = defaultInstallerDeps(dir)
      expect(deps.home()).toBe(dir)

      const written = installArtifact(skillArtifact(), ['claude'], deps)
      expect(written).toHaveLength(2)
      for (const w of written) expect(existsSync(w.path)).toBe(true)
      expect(readFileSync(join(dir, '.claude', 'skills', 'pdf-filler', 'SKILL.md'), 'utf-8')).toBe(SKILL_MD)

      const removed = uninstallArtifact(skillArtifact(), ['claude'], deps)
      expect(removed).toHaveLength(2)
      for (const p of removed) expect(existsSync(p)).toBe(false)
    })

    it('merges an MCP server into a real settings.json without clobbering it', () => {
      const deps = defaultInstallerDeps(dir)
      const settings = join(dir, '.claude', 'settings.json')
      deps.mkdirp(join(dir, '.claude'))
      deps.writeFile(settings, JSON.stringify({ mcpServers: { termpolis: { command: 'node' } } }))

      installArtifact(mcpArtifact(), ['claude'], deps)
      const v = JSON.parse(readFileSync(settings, 'utf-8'))
      expect(v.mcpServers.termpolis).toEqual({ command: 'node' })
      expect(v.mcpServers.context7.command).toBe('npx')
      // Atomic write must not leave its temp file behind.
      expect(existsSync(settings + '.tmp')).toBe(false)
    })

    it('readFile returns null for a missing file and exists() is honest', () => {
      const deps = defaultInstallerDeps(dir)
      expect(deps.readFile(join(dir, 'nope.json'))).toBeNull()
      expect(deps.exists(join(dir, 'nope.json'))).toBe(false)
    })

    it('defaults home() to the real home dir when no override is given', () => {
      // Never write with these — just prove the default wiring is the user's home.
      const { homedir } = require('os')
      expect(defaultInstallerDeps().home()).toBe(homedir())
    })
  })
})

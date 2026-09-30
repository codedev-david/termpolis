/**
 * Sandbox shared by the agentIntegrationManager tests. Every test gets a throwaway home under the
 * OS temp folder and the module is pointed at it, so no test can reach the real ~/.claude,
 * ~/.claude.json, ~/.codex, ~/.gemini, ~/.mcp.json or Termpolis's userData folder.
 */
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, relative, sep } from 'path'
import { resolveAgentIntegrationPaths } from '../../src/main/agentIntegrationManager'
import type { AgentIntegrationPaths, AgentIntegrationRuntime } from '../../src/main/agentIntegrationManager'
import { __resetTrustCache } from '../../src/main/claudeTrust'
import { tomlString } from '../../src/main/codexConfigEdit'

/** Every one-time migration, in the order the module runs them. */
export const ALL_MIGRATIONS: readonly string[] = [
  'claude-allow-safe-list-v1',
  'drop-global-mcp-json-v1',
  'remove-local-plugin-v1',
  'untrust-home-v1',
]

/** Every migration but `id`: a ledger where only `id` is still to run. */
export function allMigrationsBut(id: string): string[] {
  return ALL_MIGRATIONS.filter((m) => m !== id)
}

/** The plugin manifest the old local-plugin installer wrote. */
export const PLUGIN_MANIFEST = { name: 'termpolis', version: '1.0.0', author: { name: 'Termpolis' } }

const ENV_KEYS = ['TERMPOLIS_TEST_AGENT_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const

export interface SandboxFiles {
  claudeJson: string
  /** Claude Code's settings.json */
  settings: string
  /** Codex's config.toml */
  codex: string
  /** Gemini CLI's settings.json */
  gemini: string
  /** ~/.mcp.json */
  mcpJson: string
}

export interface Sandbox {
  /** The temp folder everything lives in, resolved (no 8.3 short names). */
  root: string
  /** The fake home folder the module is pointed at. */
  home: string
  paths: AgentIntegrationPaths
  rt: AgentIntegrationRuntime
  /** A path shaped like Termpolis's stdio adapter. */
  adapter: string
  /** A path shaped like the memory-primer hook script, with forward slashes. */
  hookScript: string
  ledgerFile: string
  files: SandboxFiles
  /** A directory junction (a symlink on POSIX) at `at` pointing at `target`; both must be in the sandbox. */
  link(target: string, at: string): void
  dispose(): void
}

/** `child` is strictly inside `parent` (case-insensitive on Windows, like `path.relative`). */
export function isUnder(parent: string, child: string): boolean {
  const r = relative(parent, child)
  return r !== '' && r.split(sep)[0] !== '..' && !isAbsolute(r)
}

export function samePath(a: string, b: string): boolean {
  return relative(a, b) === ''
}

export function createSandbox(): Sandbox {
  const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]))
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tp-aim-')))
  const home = join(root, 'home')
  mkdirSync(home)
  process.env.TERMPOLIS_TEST_AGENT_HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(root, 'env-claude-config')
  process.env.CODEX_HOME = join(root, 'env-codex-home')
  __resetTrustCache()
  // The OS home handed in is a decoy: the test home above must win over it.
  const paths = resolveAgentIntegrationPaths(join(root, 'decoy-os-home'), join(root, 'userData'), process.env)
  const adapter = join(root, 'app', 'mcp-adapter', 'stdio-adapter.cjs')
  const hookScript = join(root, 'app', 'hooks', 'memory-primer-hook.cjs').replace(/\\/g, '/')
  const links: string[] = []
  return {
    root,
    home,
    paths,
    adapter,
    hookScript,
    rt: { paths, adapterPath: adapter, hookScriptPath: hookScript, node: 'node' },
    ledgerFile: join(paths.userData, 'agent-integration.json'),
    files: {
      claudeJson: paths.claudeJson,
      settings: join(paths.claudeDir, 'settings.json'),
      codex: join(paths.codexHome, 'config.toml'),
      gemini: join(paths.geminiDir, 'settings.json'),
      mcpJson: join(paths.home, '.mcp.json'),
    },
    link(target: string, at: string): void {
      if (!isUnder(root, target) || !isUnder(root, at)) throw new Error(`link outside the sandbox: ${at} -> ${target}`)
      mkdirSync(dirname(at), { recursive: true })
      symlinkSync(target, at, 'junction')
      links.push(at)
    },
    dispose(): void {
      // Links go first, so removing the tree can never walk through one.
      for (const at of links.reverse()) {
        try {
          unlinkSync(at)
        } catch {
          try { rmdirSync(at) } catch { /* already gone */ }
        }
      }
      for (const [k, v] of savedEnv) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      __resetTrustCache()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf-8')
}

export function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + '\n')
}

export function readText(file: string): string {
  return readFileSync(file, 'utf-8')
}

/** Parse a JSON file, skipping a UTF-8 byte order mark (code point 0xFEFF) if it has one. */
export function readJson(file: string): any {
  const text = readText(file)
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

/** Make every atomic write of `file` fail: its temp file's name is taken by a folder. */
export function blockWrites(file: string): void {
  mkdirSync(`${file}.termpolis-${process.pid}.tmp`, { recursive: true })
}

export function unblockWrites(file: string): void {
  rmSync(`${file}.termpolis-${process.pid}.tmp`, { recursive: true, force: true })
}

/** A saved ledger. By default: no answer yet, not legacy, every migration done. */
export function writeLedger(sb: Sandbox, fields: Record<string, unknown> = {}): void {
  writeJson(sb.ledgerFile, {
    version: 1,
    consent: null,
    primerHook: true,
    legacy: false,
    migrations: [...ALL_MIGRATIONS],
    trustedByTermpolis: [],
    ...fields,
  })
}

/** The server entry Termpolis writes with `node: 'node'`. */
export function ourEntry(sb: Sandbox): { command: string; args: string[] } {
  return { command: 'node', args: [sb.adapter] }
}

/** A `[mcp_servers.termpolis]` table; `args` omitted when not given. */
export function codexServerToml(command: string, args?: string[]): string {
  const argsLine = args ? `args = [${args.map(tomlString).join(', ')}]\n` : ''
  return `[mcp_servers.termpolis]\ncommand = ${tomlString(command)}\n${argsLine}`
}

/** `[projects.<folder>]` marked trusted, as Codex writes it. */
export function codexTrustToml(folder: string): string {
  return `[projects.${tomlString(folder)}]\ntrust_level = "trusted"\n`
}

/**
 * A copy of `paths` whose `home` throws when read from inside the function named `fnName`, and
 * reads normally everywhere else: a fault inside one step, with every other step left working.
 */
export function throwingHomeIn(fnName: string, paths: AgentIntegrationPaths): AgentIntegrationPaths {
  const copy = { ...paths }
  Object.defineProperty(copy, 'home', {
    enumerable: true,
    get(): string {
      if (new Error().stack?.includes(fnName)) throw new Error(`boom: home unavailable in ${fnName}`)
      return paths.home
    },
  })
  return copy
}

/** Run `fn` with `process.platform` reporting `platform`. */
export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!original) throw new Error('process.platform has no own descriptor')
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

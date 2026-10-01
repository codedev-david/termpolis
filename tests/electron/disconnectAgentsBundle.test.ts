// @vitest-environment node
// resources/disconnect-agents.cjs, the file the Linux .deb's prerm runs as each user. On the user's
// machine it has nothing around it: it sits next to the binary, outside app.asar, with no
// node_modules and no out/main to load chunks from. So this builds it the way `electron-vite build`
// does, through the plugin in electron.vite.config.ts, into a temp folder, and then runs it in a
// separate Node process, as the app's Electron runs it under ELECTRON_RUN_AS_NODE=1.
// The run is pointed at the fixture's throwaway home through TERMPOLIS_TEST_AGENT_HOME, and its
// HOME is an empty decoy folder in the sandbox, so it cannot reach a real config.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'fs'
import { isBuiltin } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Plugin, UserConfig } from 'vite'
import { setAgentIntegration } from '../../src/main/agentIntegrationManager'
import { createSandbox, readJson, readText, writeLedger } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

const NAME = 'termpolis:disconnect-agents-bundle'

interface BundleHooks {
  configResolved: (config: { root: string; build: { outDir: string; watch: object | null } }) => void
  closeBundle: () => Promise<void>
}

function isBundlePlugin(p: unknown): p is Plugin {
  return typeof p === 'object' && p !== null && (p as Plugin).name === NAME
}

/** The plugin, as electron-vite gets it from the main build's config. */
async function bundlePlugin(): Promise<BundleHooks> {
  // The config sets VITE_APP_VERSION when it loads. Put it back, so nothing else sees it.
  const saved = process.env.VITE_APP_VERSION
  try {
    const { default: config } = await import('../../electron.vite.config')
    const plugin = (config.main as UserConfig).plugins?.find(isBundlePlugin)
    if (!plugin) throw new Error(`${NAME} is not among the main build's plugins`)
    expect(plugin.apply).toBe('build')
    return plugin as unknown as BundleHooks
  } finally {
    if (saved === undefined) delete process.env.VITE_APP_VERSION
    else process.env.VITE_APP_VERSION = saved
  }
}

/** Build it as `electron-vite build` would with its output in `root`/out, and return out/linux. */
async function build(root: string, watch: object | null): Promise<string> {
  const plugin = await bundlePlugin()
  plugin.configResolved({ root, build: { outDir: 'out/main', watch } })
  await plugin.closeBundle()
  return join(root, 'out', 'linux')
}

describe('resources/disconnect-agents.cjs, as `electron-vite build` makes it', () => {
  let out: string
  let bundle: string

  beforeAll(async () => {
    out = realpathSync.native(mkdtempSync(join(tmpdir(), 'termpolis-bundle-')))
    bundle = join(await build(out, null), 'disconnect-agents.cjs')
  }, 120_000)

  afterAll(() => {
    rmSync(out, { recursive: true, force: true })
  })

  it('is written to out/linux, next to out/main, and alone there', () => {
    expect(readdirSync(join(out, 'out', 'linux'))).toEqual(['disconnect-agents.cjs'])
  })

  it("is one CommonJS file that needs nothing but Node's builtins", () => {
    const code = readFileSync(bundle, 'utf8')
    const required = [...code.matchAll(/\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1])
    // fs, path and os at least. Anything else would have to come from a node_modules that is not there.
    expect(required).toEqual(expect.arrayContaining(['fs', 'path', 'os']))
    expect(required.filter((id) => !isBuiltin(id))).toEqual([])
    // No chunk to load at run time, and no ESM syntax for Node to trip over in a .cjs file.
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/^\s*(import|export)\s/m)
    expect(code).toContain('"use strict"')
  })

  describe('run by a separate Node', () => {
    let sb: Sandbox
    let decoy: string

    beforeEach(() => {
      sb = createSandbox()
      decoy = join(sb.root, 'decoy-home')
      mkdirSync(decoy)
    })

    afterEach(() => {
      sb.dispose()
    })

    function runBundle(args: string[]): { status: number | null; stdout: string; stderr: string } {
      // createSandbox() put TERMPOLIS_TEST_AGENT_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME in this
      // process's environment; the child inherits them. NODE_OPTIONS stays behind, so nothing the
      // test runner may have put there loads into the child.
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: decoy, USERPROFILE: decoy, ELECTRON_RUN_AS_NODE: '1' }
      delete env.NODE_OPTIONS
      const r = spawnSync(process.execPath, [bundle, ...args], { env, encoding: 'utf8', timeout: 60_000 })
      return { status: r.status, stdout: r.stdout, stderr: r.stderr }
    }

    it('takes Termpolis back out of every agent, and says what it did', () => {
      for (const d of [sb.paths.claudeDir, sb.paths.codexHome, sb.paths.geminiDir]) mkdirSync(d, { recursive: true })
      writeLedger(sb)
      setAgentIntegration(sb.rt, { connect: true })
      expect(readJson(sb.files.claudeJson).mcpServers.termpolis).toBeDefined()

      const r = runBundle([sb.paths.userData])

      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
      const lines = r.stdout.split(/\r?\n/).filter(Boolean)
      expect(lines).toContain(`claude: remove MCP server (${sb.files.claudeJson})`)
      expect(lines).toContain(`codex: remove MCP server (${sb.files.codex})`)
      expect(lines).toContain(`gemini: remove MCP server (${sb.files.gemini})`)
      expect(readJson(sb.files.claudeJson).mcpServers?.termpolis).toBeUndefined()
      expect(readJson(sb.files.gemini).mcpServers?.termpolis).toBeUndefined()
      expect(readText(sb.files.codex)).not.toContain('[mcp_servers.termpolis]')
      expect(readJson(sb.ledgerFile).consent).toBeNull()
      // The HOME it was given was never used: the test home won, as it does in the app.
      expect(readdirSync(decoy)).toEqual([])
    })

    it('succeeds quietly when nothing was connected', () => {
      expect(runBundle([sb.paths.userData])).toEqual({ status: 0, stdout: '', stderr: '' })
      expect(readdirSync(decoy)).toEqual([])
    })
  })
})

describe('`electron-vite dev`', () => {
  it('does not build it: main is rebuilt on every save there, and only a real build ships it', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'termpolis-bundle-watch-')))
    try {
      expect(existsSync(await build(root, {}))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

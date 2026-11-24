import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runHeadless, PROMPT_TOKEN, type ExecAgent, type ExecDeps } from '../../src/main/headlessExec'
import { clearIsolationChecks, defaultIsolationIO, prepareIsolatedLaunch, type IsolationIO } from '../../src/main/readOnlyIsolation'
import { LUMOPOLIS_RUN, lumopolisClaudeExec } from '../../src/main/world/agentProfile'
import { agentMissingMessage, createAskRunner } from '../../src/main/world/askRunner'
import { createDesigner } from '../../src/main/world/designer'
import { makeWorldLlm } from '../../src/main/world/label'
import { createSourceRegistry } from '../../src/main/world/sources'
import { createWorldStore } from '../../src/main/world/worldStore'
import type { WorldDoc } from '../../src/shared/world/types'

// Ask, the Designer and labelling launch each agent the same way, through the one Lumopolis profile:
// these tests run the real runHeadless and the real isolation (against a fake home and temp folder)
// and check the exact argv and environment each agent is started with, its MCP list check included.

const DOC = {
  version: 1, projectKey: 'k', generatedAt: 1, sourceRevision: { head: 'h', dirty: false },
  districts: [], buildings: [], edges: [], externals: [], glossary: {}, cargo: {}, processes: {}, tours: [],
  layout: { seed: 1, positions: {} }, runtimeNames: {}, layers: { plan: [] }
} as unknown as WorldDoc

const PROXY = 'http://127.0.0.1:9/lumopolis'
/** The run environment index.ts's worldRunEnv gives each agent (Claude's proxy env, Codex's proxy URL). */
const runEnv = async (agent: ExecAgent): Promise<{ env: Record<string, string>; baseUrl?: string }> =>
  agent === 'claude' ? { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } } : agent === 'codex' ? { env: {}, baseUrl: PROXY } : { env: {} }

let base: string
let home: string
let tmp: string
let root: string
beforeEach(async () => {
  clearIsolationChecks()
  base = await mkdtemp(join(tmpdir(), 'world-agent-profile-'))
  home = join(base, 'home')
  tmp = join(base, 'tmp')
  root = join(base, 'repo')
  await Promise.all([mkdir(join(home, '.codex'), { recursive: true }), mkdir(tmp), mkdir(root)])
  // The person's own Codex config: two servers of theirs plus Termpolis's.
  await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "d"\n[mcp_servers.termpolis]\ncommand = "t"\n[mcp_servers.github]\ncommand = "g"\n')
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const io = (): IsolationIO => ({ ...defaultIsolationIO, homedir: () => home, tmpdir: () => tmp, env: {} })

type DeliverOpts = { env?: Record<string, string>; signal?: AbortSignal }

/** Real runHeadless deps with a recording deliver that answers the MCP list check as an isolated CLI
 *  does; the agy home is checked while the run is live. `run` stands in for the agent's own run. */
type Delivered = { stdout: string; stderr: string; code: number }
const listedOff = (bin: string): Delivered => ({ stdout: bin === 'agy' ? 'No MCP servers configured.\n' : '[{"name":"docs","enabled":false}]', stderr: '', code: 0 })

function liveDeps(
  run: (opts: DeliverOpts) => Promise<Delivered> = async () => ({ stdout: 'answer', stderr: '', code: 0 }),
  mcp: (bin: string) => Delivered = listedOff,
): {
  deps: ExecDeps; deliver: ReturnType<typeof vi.fn>; homesSeen: string[][]
} {
  const homesSeen: string[][] = []
  const deliver = vi.fn(async (bin: string, args: string[], _prompt: string, _token: string, opts: DeliverOpts) => {
    if (args[0] === 'mcp') return mcp(bin)
    if (opts.env?.HOME) homesSeen.push(await readdir(join(opts.env.HOME, '.gemini', 'antigravity-cli')))
    return run(opts)
  })
  const deps: ExecDeps = { deliver: deliver as never, isolation: (agent, cwd, env, check) => prepareIsolatedLaunch(agent, cwd, env, check, io()) }
  return { deps, deliver, homesSeen }
}

const CODEX_OFF = [
  '-c', 'mcp_servers.docs.enabled=false',
  '-c', 'mcp_servers.docs.command=termpolis-mcp-disabled',
  '-c', 'mcp_servers.github.enabled=false',
  '-c', 'mcp_servers.github.command=termpolis-mcp-disabled',
  '-c', 'mcp_servers.termpolis.enabled=false',
  '-c', 'mcp_servers.termpolis.command=termpolis-mcp-disabled',
  '-c', 'features.apps=false',
]

/** The exact argv and environment each agent gets for a Lumopolis run in `cwd`. */
function expected(agent: ExecAgent, cwd: string, timeoutSecs: number): { bin: string; args: unknown[]; env: unknown } {
  if (agent === 'claude') {
    return {
      bin: 'claude',
      args: [
        '--permission-mode', 'plan', '--tools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,PowerShell,Edit,Write,NotebookEdit', '--strict-mcp-config',
        '--setting-sources', 'user', '-p', PROMPT_TOKEN,
      ],
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', TERMPOLIS_READ_ONLY_RUN: '1' },
    }
  }
  if (agent === 'codex') {
    return {
      bin: 'codex',
      args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', ...CODEX_OFF, '-C', cwd, '-c', `openai_base_url="${PROXY}"`, PROMPT_TOKEN],
      env: { TERMPOLIS_READ_ONLY_RUN: '1' },
    }
  }
  return {
    bin: 'agy',
    args: ['--mode', 'plan', '--print-timeout', `${timeoutSecs}s`, '-p', PROMPT_TOKEN],
    env: { TERMPOLIS_READ_ONLY_RUN: '1', HOME: expect.stringMatching(/termpolis-agy-/), USERPROFILE: expect.stringMatching(/termpolis-agy-/) },
  }
}

/** Checks one recorded launch and the MCP list check before it (same CLI, folder and environment),
 *  and that the agy home existed during the run and is gone after it. */
async function checkLaunch(agent: ExecAgent, cwd: string, timeoutSecs: number, deliver: ReturnType<typeof vi.fn>, homesSeen: string[][]): Promise<void> {
  const want = expected(agent, cwd, timeoutSecs)
  expect(deliver).toHaveBeenCalledTimes(agent === 'claude' ? 1 : 2)
  const [bin, args, , , opts] = deliver.mock.calls[deliver.mock.calls.length - 1]
  expect(bin).toBe(want.bin)
  expect(args).toEqual(want.args)
  expect(opts.env).toEqual(want.env)
  if (agent !== 'claude') {
    const [checkBin, checkArgs, , , checkOpts] = deliver.mock.calls[0]
    expect(checkBin).toBe(want.bin)
    expect(checkArgs).toEqual(agent === 'codex' ? ['mcp', 'list', '--json', ...CODEX_OFF] : ['mcp', 'list'])
    expect(checkOpts).toMatchObject({ cwd, timeoutMs: 10_000 })
    expect(checkOpts.env).toEqual(agent === 'codex' ? want.env : { ...want.env, HOME: opts.env.HOME, USERPROFILE: opts.env.HOME })
  }
  if (agent === 'gemini') {
    expect(opts.env.HOME).toBe(opts.env.USERPROFILE)
    expect(homesSeen).toEqual([['settings.json']])
  } else {
    expect(homesSeen).toEqual([])
  }
  // Nothing is left in the temp folder, and the person's config is as it was.
  expect(await readdir(tmp)).toEqual([])
  expect(await readdir(join(home, '.codex'))).toEqual(['config.toml'])
}

describe('the Lumopolis launch profile', () => {
  it('is read-only, isolated and never remembered', () => {
    expect(LUMOPOLIS_RUN).toEqual({ write: false, isolated: true, noRemember: true })
  })

  for (const agent of ['claude', 'codex', 'gemini'] as const) {
    it(`Ask launches ${agent} read-only and isolated`, async () => {
      const { deps, deliver, homesSeen } = liveDeps()
      const runner = createAskRunner({
        exec: runHeadless, execDeps: deps,
        client: { get: async () => DOC, read: async () => ({ items: [], evidence: [] }) } as never,
        agent: () => agent, runEnv, primer: async () => null, log: () => undefined,
      })
      const res = await runner.ask({ askId: 'a1', root, question: 'What is this?', selection: [], cameraRegion: [], summary: '' })
      expect(res.ok).toBe(true)
      await checkLaunch(agent, root, 90, deliver, homesSeen)
    })

    it(`the Designer launches ${agent} read-only and isolated`, async () => {
      const { deps, deliver, homesSeen } = liveDeps()
      const store = createWorldStore(base)
      const designer = createDesigner({
        exec: runHeadless, execDeps: deps, store, registry: createSourceRegistry(base, { exists: async () => true, now: () => 7 }),
        agent: () => agent, runEnv: (a) => runEnv(a), designsDir: join(base, 'designs'), newId: () => 'id1',
      })
      // The reply is not a design; the launch is what is checked here.
      await designer.draft('A shop that takes orders').catch(() => undefined)
      await checkLaunch(agent, join(base, 'designs', 'id1'), 90, deliver, homesSeen)
    })
  }

  for (const agent of ['codex', 'gemini'] as const) {
    it(`an Ask on ${agent} when its CLI isn't installed says so, starts nothing more and leaves no home behind`, async () => {
      const { deps, deliver } = liveDeps(undefined, (bin) => ({ stdout: '', stderr: `spawn ${bin} ENOENT`, code: 1 }))
      const runner = createAskRunner({
        exec: runHeadless, execDeps: deps,
        client: { get: async () => DOC, read: async () => ({ items: [], evidence: [] }) } as never,
        agent: () => agent, runEnv, primer: async () => null, log: () => undefined,
      })
      expect(await runner.ask({ askId: 'a1', root, question: 'What is this?', selection: [], cameraRegion: [], summary: '' }))
        .toEqual({ askId: 'a1', ok: false, error: agentMissingMessage(agent) })
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(deliver.mock.calls[0][1].slice(0, 2)).toEqual(['mcp', 'list'])
      expect(await readdir(tmp)).toEqual([])
    })
  }

  it('an Ask cancelled while agy runs leaves no home behind', async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    const { deps, homesSeen } = liveDeps((opts) => new Promise((resolve) => {
      started()
      opts.signal?.addEventListener('abort', () => resolve({ stdout: '', stderr: '', code: 1 }), { once: true })
    }))
    const runner = createAskRunner({
      exec: runHeadless, execDeps: deps,
      client: { get: async () => DOC, read: async () => ({ items: [], evidence: [] }) } as never,
      agent: () => 'gemini', runEnv, primer: async () => null, log: () => undefined,
    })
    const asked = runner.ask({ askId: 'a1', root, question: 'What is this?', selection: [], cameraRegion: [], summary: '' })
    await running
    expect(homesSeen).toEqual([['settings.json']])
    expect(await readdir(tmp)).toHaveLength(1)
    runner.cancel('a1')
    expect(await asked).toMatchObject({ ok: false, cancelled: true })
    await vi.waitFor(async () => expect(await readdir(tmp)).toEqual([]))
  })

  it('labelling launches claude with no tools, no MCP server and the person\'s own settings only, prompt on stdin', async () => {
    const exec = vi.fn(async () => ({ stdout: 'answer', code: 0 }))
    const llm = makeWorldLlm('claude', undefined, { claudeExec: exec })
    expect(await llm('label these')).toBe('answer')
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]).toEqual(['claude', ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--setting-sources', 'user'], expect.objectContaining({ input: expect.stringContaining('label these') })])
  })

  it('lumopolisClaudeExec wraps the real exec when given none', () => {
    expect(typeof lumopolisClaudeExec()).toBe('function')
  })

  for (const agent of ['codex', 'gemini'] as const) {
    it(`labelling launches ${agent} read-only and isolated, as index.ts routes it`, async () => {
      const { deps, deliver, homesSeen } = liveDeps()
      const llm = makeWorldLlm(agent, undefined, {
        run: async (req) => {
          const route = await runEnv(agent)
          return runHeadless({ ...req, cwd: root, env: route.env, ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}) }, deps)
        },
      })
      expect(await llm('label these')).toBe('answer')
      await checkLaunch(agent, root, 120, deliver, homesSeen)
    })
  }
})

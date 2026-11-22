import { describe, expect, it, vi } from 'vitest'
import { agentMissingMessage, createAskRunner, DEFAULT_PREP_TIMEOUT_MS } from '../../src/main/world/askRunner'
import type { AskRequest, WorldDoc } from '../../src/shared/world/types'
import type { ExecRequest, ExecResult } from '../../src/main/headlessExec'

const DOC = {
  version: 1, projectKey: 'k', generatedAt: 1, sourceRevision: { head: 'h', dirty: false },
  districts: [], buildings: [], edges: [], externals: [], glossary: {}, cargo: {}, processes: {}, tours: [],
  layout: { seed: 1, positions: {} }, runtimeNames: {}, layers: { plan: [] }
} as unknown as WorldDoc

const REQ: AskRequest = { askId: 'a1', root: 'C:/repo', question: 'What is this?', selection: [], cameraRegion: [], summary: '' }
const okRes = (output: string): ExecResult => ({ ok: true, output, primerChars: 0 }) as ExecResult

function setup(
  exec: (req: ExecRequest) => Promise<ExecResult>, doc: WorldDoc | null = DOC, timeoutMs?: number, getTimeoutMs?: number,
  over: Partial<Pick<Parameters<typeof createAskRunner>[0], 'agent' | 'runEnv' | 'primer' | 'prepTimeoutMs' | 'log'>> = {}
) {
  const execFn = vi.fn(exec)
  const client = {
    get: vi.fn((_root: string, _opts?: { refresh?: boolean }): Promise<WorldDoc | null> => Promise.resolve(doc)),
    read: vi.fn(async () => ({ items: [], evidence: [] }))
  }
  const execDeps = { deliver: vi.fn() }
  const runEnv = vi.fn(async () => ({ env: {} as Record<string, string> }))
  const primer = vi.fn(async () => null as string | null)
  const log = vi.fn()
  const runner = createAskRunner({
    exec: execFn as never, execDeps: execDeps as never, client: client as never, timeoutMs, getTimeoutMs,
    agent: () => 'claude', runEnv, primer, log, ...over
  })
  return { runner, execFn, client, execDeps, runEnv, primer, log }
}

/** An exec that never answers by itself and rejects when its signal aborts. */
const hanging = (req: ExecRequest) =>
  new Promise<ExecResult>((_res, rej) => req.signal?.addEventListener('abort', () => rej(new Error('aborted'))))

describe('createAskRunner', () => {
  it('looks up request.proposalId in the doc; an unknown id or none sends no proposal', async () => {
    const plan = { id: 'p1', title: 'Add a cache', summary: [], buildings: [], edges: [] }
    const withPlan = { ...DOC, layers: { plan: [plan] } } as unknown as WorldDoc
    const task = (m: { mock: { calls: unknown[][] } }): string => (m.mock.calls[m.mock.calls.length - 1][0] as ExecRequest).task
    const { runner, execFn } = setup(async () => okRes('hi'), withPlan)
    await runner.ask({ ...REQ, proposalId: 'p1' })
    expect(task(execFn)).toContain('proposal p1: Add a cache')
    await runner.ask({ ...REQ, proposalId: 'nope' })
    expect(task(execFn)).not.toContain('PROPOSAL')
    await runner.ask(REQ)
    expect(task(execFn)).not.toContain('PROPOSAL')
  })

  it('passes write:false, noRemember:true, cwd=root', async () => {
    const { runner, execFn, execDeps, client } = setup(async () => okRes('hi'))
    await runner.ask(REQ)
    expect(client.read).toHaveBeenCalledWith('C:/repo', { text: 'What is this?', limit: 20 })
    const [req, deps] = execFn.mock.calls[0] as [ExecRequest, unknown]
    expect(req).toMatchObject({ cwd: 'C:/repo', write: false, noRemember: true, timeoutMs: 90_000 })
    expect(req.agent).toBe('claude')
    expect(req.model).toBeUndefined()
    expect(req.baseUrl).toBeUndefined()
    expect(req.signal).toBeInstanceOf(AbortSignal)
    expect(deps).toMatchObject({ deliver: execDeps.deliver, primer: expect.any(Function) })
  })

  it('runs the settings agent with the request model, the runEnv env and baseUrl, the primer dep, write:false, noRemember:true', async () => {
    const runEnv = vi.fn(async () => ({ env: { A: '1' }, baseUrl: 'u' }))
    const primer = vi.fn(async () => 'PRIMER')
    const { runner, execFn } = setup(async () => okRes('hi'), DOC, undefined, undefined, { agent: () => 'codex', runEnv, primer })
    await runner.ask({ ...REQ, model: 'gpt-5.5-mini' })
    expect(execFn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', model: 'gpt-5.5-mini', env: { A: '1' }, baseUrl: 'u', write: false, noRemember: true }),
      expect.objectContaining({ primer: expect.any(Function) })
    )
    expect(runEnv).toHaveBeenCalledWith('codex', 'C:/repo')
    const deps = execFn.mock.calls[0][1] as { primer: (cwd: string) => Promise<string | null> }
    expect(await deps.primer('C:/repo')).toBe('PRIMER')
    expect(primer).toHaveBeenCalledWith('C:/repo')
  })

  it('an unsafe model id in the request is dropped, not passed', async () => {
    const { runner, execFn } = setup(async () => okRes('hi'))
    await runner.ask({ ...REQ, model: 'x; rm' })
    expect('model' in (execFn.mock.calls[0][0] as ExecRequest)).toBe(false)
  })

  it('a runEnv or primer that throws is absorbed: the run goes on with no env and no primer', async () => {
    const runEnv = vi.fn(async () => { throw new Error('proxy down') })
    const primer = vi.fn(async () => { throw new Error('memory down') })
    const { runner, execFn } = setup(async () => okRes('hi'), DOC, undefined, undefined, { runEnv, primer })
    const res = await runner.ask(REQ)
    expect(res).toMatchObject({ ok: true })
    expect((execFn.mock.calls[0][0] as ExecRequest).env).toEqual({})
    const deps = execFn.mock.calls[0][1] as { primer: (cwd: string) => Promise<string | null> }
    expect(await deps.primer('C:/repo')).toBeNull()
  })

  it('a cancel while runEnv is working answers cancelled and never starts the agent', async () => {
    let release!: () => void
    const runEnv = vi.fn(() => new Promise<{ env: Record<string, string> }>((r) => { release = () => r({ env: {} }) }))
    const { runner, execFn } = setup(async () => okRes('hi'), DOC, undefined, undefined, { runEnv })
    const p = runner.ask(REQ)
    await vi.waitFor(() => expect(runEnv).toHaveBeenCalled())
    runner.cancel('a1')
    release()
    expect(await p).toMatchObject({ ok: false, cancelled: true })
    expect(execFn).not.toHaveBeenCalled()
  })

  it('a missing agent CLI (ENOENT) answers agentMissingMessage at once', async () => {
    const { runner } = setup(async () => ({ ok: false, error: 'spawn codex ENOENT' }) as ExecResult, DOC, undefined, undefined, { agent: () => 'codex' })
    expect(await runner.ask(REQ)).toEqual({ askId: 'a1', ok: false, error: "Codex isn't installed. Choose another agent in Settings › Lumopolis." })
  })

  it('names each agent the way Settings does, and PowerShell "not recognized" counts as missing', async () => {
    expect(agentMissingMessage('claude')).toBe("Claude Code isn't installed. Choose another agent in Settings › Lumopolis.")
    expect(agentMissingMessage('gemini')).toBe("Gemini CLI isn't installed. Choose another agent in Settings › Lumopolis.")
    const { runner } = setup(async () => ({ ok: false, error: "The term 'agy' is not recognized as the name of a cmdlet" }) as ExecResult, DOC, undefined, undefined, { agent: () => 'gemini' })
    expect(await runner.ask(REQ)).toMatchObject({ ok: false, error: agentMissingMessage('gemini') })
  })

  it('adds the primer the run carried (chars / 4) to the token estimate', async () => {
    const { runner, execFn } = setup(async () => ({ ok: true, output: 'x'.repeat(400), primerChars: 800 }) as ExecResult)
    const res = await runner.ask(REQ)
    const prompt = (execFn.mock.calls[0][0] as ExecRequest).task
    expect(res).toMatchObject({ ok: true, tokens: Math.ceil(prompt.length / 4) + 100 + 200 })
  })

  it('an answer that cites a label nobody sent cites nothing', async () => {
    const { runner } = setup(async () => okRes('It is a tool [E9].'))
    const r = await runner.ask(REQ)
    expect(r.ok && r.cited).toEqual({})
  })

  it('honours a custom timeout', async () => {
    const { runner, execFn } = setup(async () => okRes('hi'), DOC, 5000)
    await runner.ask(REQ)
    expect((execFn.mock.calls[0][0] as ExecRequest).timeoutMs).toBe(5000)
  })

  it('parses output into answer and returns new summary', async () => {
    const { runner } = setup(async () => okRes('It is a tool.'))
    const res = await runner.ask(REQ)
    expect(res).toMatchObject({ askId: 'a1', ok: true, answer: { text: 'It is a tool.' } })
    expect((res as { summary: string }).summary).toContain('What is this?')
  })

  it('reports tokens = estimate(prompt) + estimate(output), and nothing for a failed ask', async () => {
    const { runner, execFn } = setup(async () => okRes('x'.repeat(400)))
    const res = await runner.ask(REQ)
    const prompt = (execFn.mock.calls[0][0] as ExecRequest).task
    expect(res).toMatchObject({ ok: true, tokens: Math.ceil(prompt.length / 4) + 100 })
    expect((res as { tokens: number }).tokens).toBeGreaterThanOrEqual(100)
    const failed = await setup(async () => ({ ok: false, error: 'boom' }) as ExecResult).runner.ask(REQ)
    expect(failed).not.toHaveProperty('tokens')
  })

  it('answers an ok exec with empty output as an empty answer', async () => {
    const { runner } = setup(async () => okRes(''))
    expect(await runner.ask(REQ)).toMatchObject({ ok: true, answer: { text: '' } })
  })

  it('still answers when the read of matches fails', async () => {
    const { runner, client } = setup(async () => okRes('fine'))
    client.read.mockRejectedValueOnce(new Error('host down'))
    expect(await runner.ask(REQ)).toMatchObject({ ok: true, answer: { text: 'fine' } })
  })

  it('exec ok:false → {ok:false, error}', async () => {
    const { runner } = setup(async () => ({ ok: false, output: '', error: 'timed out' }) as ExecResult)
    expect(await runner.ask(REQ)).toEqual({ askId: 'a1', ok: false, error: "Lumopolis couldn't reach your agent: timed out" })
  })

  it('exec ok:false without an error says no answer', async () => {
    const { runner } = setup(async () => ({ ok: false, output: '' }) as ExecResult)
    expect(await runner.ask(REQ)).toMatchObject({ error: "Lumopolis couldn't reach your agent: no answer" })
  })

  it('a thrown exec error is handled like a failed exec', async () => {
    const { runner } = setup(async () => { throw new Error('spawn failed') })
    expect(await runner.ask(REQ)).toMatchObject({ ok: false, error: "Lumopolis couldn't reach your agent: spawn failed" })
    const { runner: r2 } = setup(async () => { throw 'odd' })
    expect(await r2.ask(REQ)).toMatchObject({ ok: false, error: "Lumopolis couldn't reach your agent: odd" })
  })

  it('cancel aborts the signal and resolves {ok:false, cancelled:true}', async () => {
    const { runner, execFn } = setup(hanging)
    const p = runner.ask(REQ)
    await vi.waitFor(() => expect(execFn).toHaveBeenCalled())
    runner.cancel('a1')
    expect(await p).toMatchObject({ askId: 'a1', ok: false, cancelled: true })
    expect((execFn.mock.calls[0][0] as ExecRequest).signal?.aborted).toBe(true)
  })

  it('cancel of an exec that still resolves is reported as cancelled', async () => {
    let release!: () => void
    const { runner, execFn } = setup(() => new Promise<ExecResult>((r) => { release = () => r(okRes('late')) }))
    const p = runner.ask(REQ)
    await vi.waitFor(() => expect(execFn).toHaveBeenCalled())
    runner.cancel('a1')
    release()
    expect(await p).toMatchObject({ ok: false, cancelled: true })
  })

  it('cancel during the context reads stops before the agent runs', async () => {
    const { runner, execFn, client } = setup(async () => okRes('x'))
    let release!: () => void
    client.read.mockImplementationOnce(() => new Promise((r) => { release = () => r({ items: [], evidence: [] }) }))
    const p = runner.ask(REQ)
    await vi.waitFor(() => expect(client.read).toHaveBeenCalled())
    runner.cancel('a1')
    release()
    expect(await p).toMatchObject({ ok: false, cancelled: true })
    expect(execFn).not.toHaveBeenCalled()
  })

  it('cancel of an unknown id does nothing', async () => {
    const { runner } = setup(async () => okRes('x'))
    runner.cancel('nope')
    expect(await runner.ask(REQ)).toMatchObject({ ok: true })
  })

  it('a second ask for the same root cancels the first', async () => {
    let n = 0
    const { runner, execFn } = setup((req) => (n++ === 0 ? hanging(req) : Promise.resolve(okRes('second'))))
    const first = runner.ask(REQ)
    await vi.waitFor(() => expect(execFn).toHaveBeenCalledTimes(1))
    const second = await runner.ask({ ...REQ, askId: 'a2' })
    expect(await first).toMatchObject({ askId: 'a1', ok: false, cancelled: true })
    expect(second).toMatchObject({ askId: 'a2', ok: true, answer: { text: 'second' } })
  })

  it('asks for different roots run side by side', async () => {
    const { runner, execFn } = setup(async () => okRes('x'))
    const both = await Promise.all([runner.ask(REQ), runner.ask({ ...REQ, askId: 'a2', root: 'C:/other' })])
    expect(both.every((r) => r.ok)).toBe(true)
    expect(execFn).toHaveBeenCalledTimes(2)
  })

  it('loads the world without starting a background refresh', async () => {
    const { runner, client } = setup(async () => okRes('hi'))
    await runner.ask(REQ)
    expect(client.get).toHaveBeenCalledWith('C:/repo', { refresh: false })
  })

  describe('nothing before the agent holds a question (round 3: a memory primer took 99 s and 108 s on a busy machine)', () => {
    const never = <T>(): Promise<T> => new Promise<T>(() => undefined)
    /** An exec that asks for its primer, as runHeadless does, and answers with what it got. */
    const primed = async (_req: ExecRequest, deps?: unknown): Promise<ExecResult> => {
      const primer = await (deps as { primer: (cwd: string) => Promise<string | null> }).primer('C:/repo')
      return okRes(`primer:${String(primer)}`)
    }

    it('waits 10 s by default for each step before the agent', () => {
      expect(DEFAULT_PREP_TIMEOUT_MS).toBe(10_000)
    })

    it('a primer that does not come in time is left out: the run starts cold after 10 s', async () => {
      vi.useFakeTimers()
      try {
        const { runner, execFn } = setup(primed, DOC, undefined, undefined, { primer: vi.fn(() => never<string | null>()) })
        const p = runner.ask(REQ)
        let settled = false
        void p.then(() => { settled = true })
        await vi.advanceTimersByTimeAsync(9_999)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(await p).toMatchObject({ ok: true, answer: { text: 'primer:null' } })
        expect(execFn).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a primer that comes in time is used', async () => {
      const { runner } = setup(primed, DOC, undefined, undefined, { primer: vi.fn(async () => 'recalled') })
      expect(await runner.ask(REQ)).toMatchObject({ ok: true, answer: { text: 'primer:recalled' } })
    })

    it('a read of matches that does not come in time is left out: the ask goes on with no matches after 10 s', async () => {
      vi.useFakeTimers()
      try {
        const { runner, client, execFn } = setup(async () => okRes('hi'))
        client.read.mockImplementationOnce(() => never())
        const p = runner.ask(REQ)
        await vi.advanceTimersByTimeAsync(9_999)
        expect(execFn).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await p).toMatchObject({ ok: true })
        expect(execFn).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a run environment that does not come in time is left out: the run goes direct after 10 s', async () => {
      vi.useFakeTimers()
      try {
        const runEnv = vi.fn(() => never<{ env: Record<string, string> }>())
        const { runner, execFn } = setup(async () => okRes('hi'), DOC, undefined, undefined, { runEnv })
        const p = runner.ask(REQ)
        await vi.advanceTimersByTimeAsync(9_999)
        expect(execFn).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await p).toMatchObject({ ok: true })
        expect((execFn.mock.calls[0][0] as ExecRequest).env).toEqual({})
      } finally {
        vi.useRealTimers()
      }
    })

    it('honours a custom limit for the steps before the agent', async () => {
      const { runner, client } = setup(primed, DOC, undefined, undefined, { primer: vi.fn(() => never<string | null>()), prepTimeoutMs: 5 })
      client.read.mockImplementationOnce(() => never())
      expect(await runner.ask(REQ)).toMatchObject({ ok: true, answer: { text: 'primer:null' } })
    })

    it('a cancel while the primer is working answers cancelled at once', async () => {
      let execSignal: AbortSignal | undefined
      const exec = async (req: ExecRequest, deps?: unknown): Promise<ExecResult> => {
        execSignal = req.signal
        await (deps as { primer: (cwd: string) => Promise<string | null> }).primer('C:/repo')
        return okRes('late')
      }
      const primer = vi.fn(() => never<string | null>())
      const { runner } = setup(exec, DOC, undefined, undefined, { primer })
      const p = runner.ask(REQ)
      await vi.waitFor(() => expect(primer).toHaveBeenCalled())
      runner.cancel('a1')
      expect(await p).toMatchObject({ ok: false, cancelled: true })
      expect(execSignal?.aborted).toBe(true)
    })
  })

  describe('a cancel before a step, and a step that runs out (round 4: m2, m3)', () => {
    const never = <T>(): Promise<T> => new Promise<T>(() => undefined)
    const primed = async (_req: ExecRequest, deps?: unknown): Promise<ExecResult> =>
      okRes(`primer:${String(await (deps as { primer: (cwd: string) => Promise<string | null> }).primer('C:/repo'))}`)

    it('a cancel that lands before priming begins answers cancelled at once, and the primer search is never started', async () => {
      vi.useFakeTimers()
      try {
        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        let got: string | null | undefined
        // runHeadless awaits its own checks (cwdProblem) before it asks for the primer: the cancel lands there.
        const exec = async (_req: ExecRequest, deps?: unknown): Promise<ExecResult> => {
          await gate
          got = await (deps as { primer: (cwd: string) => Promise<string | null> }).primer('C:/repo')
          return okRes('late')
        }
        const primer = vi.fn(() => never<string | null>())
        const { runner, execFn } = setup(exec, DOC, undefined, undefined, { primer })
        const p = runner.ask(REQ)
        await vi.waitFor(() => expect(execFn).toHaveBeenCalled())
        runner.cancel('a1')
        release()
        await vi.advanceTimersByTimeAsync(0)
        expect(got).toBeNull() // not after the 10 s limit: at once
        expect(primer).not.toHaveBeenCalled()
        expect(await p).toMatchObject({ ok: false, cancelled: true })
      } finally {
        vi.useRealTimers()
      }
    })

    it('each step that runs out writes which step, its limit and its time to the app log; nothing else is logged', async () => {
      vi.useFakeTimers()
      try {
        const { runner, client, log } = setup(primed, DOC, undefined, undefined, {
          primer: vi.fn(() => never<string | null>()), runEnv: vi.fn(() => never<{ env: Record<string, string> }>())
        })
        client.read.mockImplementationOnce(() => never())
        const p = runner.ask(REQ)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await p).toMatchObject({ ok: true, answer: { text: 'primer:null' } })
        expect(log.mock.calls.map((c) => c[0])).toEqual([
          '[world] ask: reading matches ran out after 10000 ms (limit 10000 ms)',
          '[world] ask: the run environment ran out after 10000 ms (limit 10000 ms)',
          '[world] ask: the memory primer ran out after 10000 ms (limit 10000 ms)'
        ])
        // The map's own limit logs too; a step in time, or one that fails fast, logs nothing.
        log.mockClear()
        client.get.mockImplementationOnce(() => never())
        const q = runner.ask({ ...REQ, askId: 'a2' })
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await q).toMatchObject({ ok: false })
        expect(log.mock.calls.map((c) => c[0])).toEqual(['[world] ask: loading the map ran out after 15000 ms (limit 15000 ms)'])
        const fast = setup(async () => okRes('hi'))
        fast.client.read.mockRejectedValueOnce(new Error('host gone'))
        expect(await fast.runner.ask(REQ)).toMatchObject({ ok: true })
        expect(fast.log).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('a cancel logs no step as run out', async () => {
      const primer = vi.fn(() => never<string | null>())
      const { runner, log } = setup(primed, DOC, undefined, undefined, { primer })
      const p = runner.ask(REQ)
      await vi.waitFor(() => expect(primer).toHaveBeenCalled())
      runner.cancel('a1')
      expect(await p).toMatchObject({ cancelled: true })
      expect(log).not.toHaveBeenCalled()
    })

    it('a primer that answers, or fails, after its limit changes nothing: the run already started cold', async () => {
      vi.useFakeTimers()
      try {
        for (const fail of [false, true]) {
          let settle!: () => void
          const primer = vi.fn(() => new Promise<string | null>((res, rej) => { settle = () => (fail ? rej(new Error('search failed')) : res('too late')) }))
          const { runner } = setup(primed, DOC, undefined, undefined, { primer })
          const p = runner.ask(REQ)
          await vi.advanceTimersByTimeAsync(10_000)
          expect(await p).toMatchObject({ ok: true, answer: { text: 'primer:null' } })
          settle()
          await vi.advanceTimersByTimeAsync(0)
        }
      } finally {
        vi.useRealTimers()
      }
    })

    it('without a log of its own, a step that runs out goes to console.warn (the app log)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const runner = createAskRunner({
          exec: (async () => okRes('hi')) as never, execDeps: {} as never, client: { get: async () => DOC, read: () => never() } as never,
          agent: () => 'claude', runEnv: async () => ({ env: {} }), primer: async () => null, prepTimeoutMs: 5
        })
        expect(await runner.ask(REQ)).toMatchObject({ ok: true })
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[world\] ask: reading matches ran out after \d+ ms \(limit 5 ms\)/))
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('loading the world fails', () => {
    const MAP_FAILED = "Lumopolis couldn't load this project's map. Try again."

    it('a host failure shows plain copy, never the raw error', async () => {
      const { runner, client, execFn, log } = setup(async () => okRes('x'))
      client.get.mockRejectedValueOnce(new Error('Lumopolis host exited (code 3)'))
      expect(await runner.ask(REQ)).toEqual({ askId: 'a1', ok: false, error: MAP_FAILED })
      expect(execFn).not.toHaveBeenCalled()
      // The raw reason goes to the app log only (round 4: m5).
      expect(log.mock.calls.map((c) => c[0])).toEqual(['[world] ask: loading the map failed: Lumopolis host exited (code 3)'])
      client.get.mockRejectedValueOnce('gone')
      expect(await runner.ask({ ...REQ, askId: 'a2' })).toEqual({ askId: 'a2', ok: false, error: MAP_FAILED })
      expect(log).toHaveBeenLastCalledWith('[world] ask: loading the map failed: gone')
    })

    it('a host that does not answer in time shows plain copy (15 s by default)', async () => {
      vi.useFakeTimers()
      try {
        const { runner, client } = setup(async () => okRes('x'))
        client.get.mockImplementationOnce(() => new Promise(() => undefined))
        const p = runner.ask(REQ)
        await vi.advanceTimersByTimeAsync(14_999)
        let settled = false
        void p.then(() => { settled = true })
        await vi.advanceTimersByTimeAsync(0)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(await p).toEqual({ askId: 'a1', ok: false, error: MAP_FAILED })
      } finally {
        vi.useRealTimers()
      }
    })

    it('honours a custom load timeout', async () => {
      const { runner, client } = setup(async () => okRes('x'), DOC, undefined, 5)
      client.get.mockImplementationOnce(() => new Promise(() => undefined))
      expect(await runner.ask(REQ)).toEqual({ askId: 'a1', ok: false, error: MAP_FAILED })
    })

    it('a cancel while the world loads reports cancelled at once, not "not mapped"', async () => {
      const { runner, client, execFn } = setup(async () => okRes('x'), null)
      let release!: (d: WorldDoc | null) => void
      client.get.mockImplementationOnce(() => new Promise((r) => { release = r }))
      const p = runner.ask(REQ)
      runner.cancel('a1')
      expect(await p).toEqual({ askId: 'a1', ok: false, error: 'cancelled', cancelled: true })
      release(null) // the late answer changes nothing
      expect(execFn).not.toHaveBeenCalled()
    })

    it('a cancel that lands just after the load is still reported as cancelled', async () => {
      const { runner, client, execFn } = setup(async () => okRes('x'), null)
      client.get.mockImplementationOnce(() => {
        const p = Promise.resolve(null)
        // Runs after the runner's own then on p: the load has finished, its result is not yet read.
        queueMicrotask(() => { void p.then(() => runner.cancel('a1')) })
        return p
      })
      expect(await runner.ask(REQ)).toMatchObject({ ok: false, cancelled: true })
      expect(execFn).not.toHaveBeenCalled()
    })
  })

  it('no world doc for root → {ok:false, error:"This project has not been mapped yet."}', async () => {
    const { runner, execFn } = setup(async () => okRes('x'), null)
    expect(await runner.ask(REQ)).toEqual({ askId: 'a1', ok: false, error: 'This project has not been mapped yet.' })
    expect(execFn).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { agentMissingMessage, createAskRunner } from '../../src/main/world/askRunner'
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
  over: Partial<Pick<Parameters<typeof createAskRunner>[0], 'agent' | 'runEnv' | 'primer'>> = {}
) {
  const execFn = vi.fn(exec)
  const client = {
    get: vi.fn((_root: string, _opts?: { refresh?: boolean }): Promise<WorldDoc | null> => Promise.resolve(doc)),
    read: vi.fn(async () => ({ items: [], evidence: [] }))
  }
  const execDeps = { deliver: vi.fn() }
  const runEnv = vi.fn(async () => ({ env: {} as Record<string, string> }))
  const primer = vi.fn(async () => null as string | null)
  const runner = createAskRunner({
    exec: execFn as never, execDeps: execDeps as never, client: client as never, timeoutMs, getTimeoutMs,
    agent: () => 'claude', runEnv, primer, ...over
  })
  return { runner, execFn, client, execDeps, runEnv, primer }
}

/** An exec that never answers by itself and rejects when its signal aborts. */
const hanging = (req: ExecRequest) =>
  new Promise<ExecResult>((_res, rej) => req.signal?.addEventListener('abort', () => rej(new Error('aborted'))))

describe('createAskRunner', () => {
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

  describe('loading the world fails', () => {
    const MAP_FAILED = "Lumopolis couldn't load this project's map. Try again."

    it('a host failure shows plain copy, never the raw error', async () => {
      const { runner, client, execFn } = setup(async () => okRes('x'))
      client.get.mockRejectedValueOnce(new Error('Lumopolis host exited (code 3)'))
      expect(await runner.ask(REQ)).toEqual({ askId: 'a1', ok: false, error: MAP_FAILED })
      expect(execFn).not.toHaveBeenCalled()
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

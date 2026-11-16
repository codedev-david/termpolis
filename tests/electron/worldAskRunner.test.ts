import { describe, expect, it, vi } from 'vitest'
import { createAskRunner } from '../../src/main/world/askRunner'
import type { AskRequest, WorldDoc } from '../../src/shared/world/types'
import type { ExecRequest, ExecResult } from '../../src/main/headlessExec'

const DOC = {
  version: 1, projectKey: 'k', generatedAt: 1, sourceRevision: { head: 'h', dirty: false },
  districts: [], buildings: [], edges: [], externals: [], glossary: {}, cargo: {}, processes: {}, tours: [],
  layout: { seed: 1, positions: {} }, runtimeNames: {}, layers: { plan: [] }
} as unknown as WorldDoc

const REQ: AskRequest = { askId: 'a1', root: 'C:/repo', question: 'What is this?', selection: [], cameraRegion: [], summary: '' }
const okRes = (output: string): ExecResult => ({ ok: true, output }) as ExecResult

function setup(exec: (req: ExecRequest) => Promise<ExecResult>, doc: WorldDoc | null = DOC, timeoutMs?: number) {
  const execFn = vi.fn(exec)
  const client = { get: vi.fn(async () => doc), read: vi.fn(async () => ({ items: [], evidence: [] })) }
  const execDeps = { deliver: vi.fn() }
  const runner = createAskRunner({ exec: execFn as never, execDeps: execDeps as never, client: client as never, timeoutMs })
  return { runner, execFn, client, execDeps }
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
    expect(req.agent).toBeUndefined()
    expect(req.model).toBeUndefined()
    expect(req.signal).toBeInstanceOf(AbortSignal)
    expect(deps).toBe(execDeps)
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

  it('no world doc for root → {ok:false, error:"This project has not been mapped yet."}', async () => {
    const { runner, execFn } = setup(async () => okRes('x'), null)
    expect(await runner.ask(REQ)).toEqual({ askId: 'a1', ok: false, error: 'This project has not been mapped yet.' })
    expect(execFn).not.toHaveBeenCalled()
  })
})

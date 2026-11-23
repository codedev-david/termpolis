// WPA item 2 and 3 in the ask runner: a step the 10 s cap gave up on, or a cancelled ask, is stopped (its own signal fires),
// not just left behind; and an answer made without the project memory says why.
import { describe, expect, it, vi } from 'vitest'
import { createAskRunner, memoryUnavailable, DEFAULT_PREP_TIMEOUT_MS } from '../../src/main/world/askRunner'
import type { AskRequest, WorldDoc } from '../../src/shared/world/types'
import type { ExecRequest, ExecResult } from '../../src/main/headlessExec'

const DOC = {
  version: 1, projectKey: 'k', generatedAt: 1, sourceRevision: { head: 'h', dirty: false },
  districts: [], buildings: [], edges: [], externals: [], glossary: {}, cargo: {}, processes: {}, tours: [],
  layout: { seed: 1, positions: {} }, runtimeNames: {}, layers: { plan: [] }
} as unknown as WorldDoc
const REQ: AskRequest = { askId: 'a1', root: 'C:/repo', question: 'What is this?', selection: [], cameraRegion: [], summary: '' }
const okRes = (output: string): ExecResult => ({ ok: true, output, primerChars: 0 }) as ExecResult

/** An exec that asks for its primer, as runHeadless does, and answers with what it got. */
const primed = async (_req: ExecRequest, deps?: unknown): Promise<ExecResult> => {
  const p = await (deps as { primer: (cwd: string) => Promise<string | null> }).primer('C:/repo')
  return okRes(`primer:${String(p)}`)
}
/** Never settles by itself; records the signal it was given and settles (rejecting) only when that signal fires. */
function stoppable<T>(): { fn: (...a: unknown[]) => Promise<T>; signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  const fn = (...a: unknown[]): Promise<T> => {
    const last = a[a.length - 1]
    const signal = (last instanceof AbortSignal ? last : (last as { signal?: AbortSignal })?.signal) as AbortSignal
    signals.push(signal)
    return new Promise<T>((_res, rej) => signal.addEventListener('abort', () => rej(new Error('memory call cancelled'))))
  }
  return { fn, signals }
}

function setup(over: Record<string, unknown> = {}, exec: (req: ExecRequest, deps?: unknown) => Promise<ExecResult> = primed) {
  const client = {
    get: vi.fn(async (): Promise<WorldDoc | null> => DOC),
    read: vi.fn(async () => ({ items: [], evidence: [] }))
  }
  const runner = createAskRunner({
    exec: vi.fn(exec) as never, execDeps: { deliver: vi.fn() } as never, client: client as never,
    agent: () => 'claude', runEnv: vi.fn(async () => ({ env: {} })), primer: vi.fn(async () => null), log: vi.fn(),
    ...over
  } as never)
  return { runner, client }
}

describe('askRunner: the cap and a cancel stop the step they gave up on', () => {
  it('the memory primer the cap gave up on is cancelled, and the answer says it ran without memory (timeout)', async () => {
    vi.useFakeTimers()
    try {
      const primer = stoppable<string | null>()
      const { runner } = setup({ primer: primer.fn })
      const p = runner.ask(REQ)
      await vi.advanceTimersByTimeAsync(DEFAULT_PREP_TIMEOUT_MS - 1)
      expect(primer.signals[0].aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(primer.signals[0].aborted).toBe(true)
      expect(await p).toMatchObject({ ok: true, answer: { text: 'primer:null' }, noMemory: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelling the ask cancels the memory primer it is waiting on; a cancelled ask carries no note', async () => {
    const primer = stoppable<string | null>()
    const hangingExec = async (req: ExecRequest, deps?: unknown): Promise<ExecResult> => {
      const got = (deps as { primer: (cwd: string) => Promise<string | null> }).primer('C:/repo')
      await new Promise<void>((_r, rej) => req.signal?.addEventListener('abort', () => rej(new Error('stopped'))))
      return okRes(String(await got))
    }
    const { runner } = setup({ primer: primer.fn }, hangingExec)
    const p = runner.ask(REQ)
    await vi.waitFor(() => expect(primer.signals).toHaveLength(1))
    runner.cancel('a1')
    expect(primer.signals[0].aborted).toBe(true)
    const r = await p
    expect(r).toEqual({ askId: 'a1', ok: false, error: 'cancelled', cancelled: true })
  })

  it('cancelling while the map loads cancels the map step; while the matches are read, that step', async () => {
    const get = stoppable<WorldDoc | null>()
    const a = setup()
    a.client.get.mockImplementation(get.fn as never)
    const p = a.runner.ask(REQ)
    await vi.waitFor(() => expect(get.signals).toHaveLength(1))
    a.runner.cancel('a1')
    expect(get.signals[0].aborted).toBe(true)
    expect(await p).toMatchObject({ cancelled: true })

    const read = stoppable<unknown>()
    const b = setup()
    b.client.read.mockImplementation(read.fn as never)
    const q = b.runner.ask(REQ)
    await vi.waitFor(() => expect(read.signals).toHaveLength(1))
    b.runner.cancel('a1')
    expect(read.signals[0].aborted).toBe(true)
    expect(await q).toMatchObject({ cancelled: true })
  })

  it('the matches the cap gave up on are cancelled too, and the ask goes on', async () => {
    vi.useFakeTimers()
    try {
      const read = stoppable<unknown>()
      const { runner, client } = setup({ primer: vi.fn(async () => 'recalled') })
      client.read.mockImplementation(read.fn as never)
      const p = runner.ask(REQ)
      await vi.advanceTimersByTimeAsync(DEFAULT_PREP_TIMEOUT_MS)
      expect(read.signals[0].aborted).toBe(true)
      const r = await p
      expect(r).toMatchObject({ ok: true, answer: { text: 'primer:recalled' } })
      expect(r).not.toHaveProperty('noMemory')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a step that finished leaves its signal alone', async () => {
    let seen: AbortSignal | undefined
    const { runner } = setup({ primer: vi.fn(async (_cwd: string, signal: AbortSignal) => { seen = signal; return 'recalled' }) })
    expect(await runner.ask(REQ)).toMatchObject({ ok: true })
    expect(seen?.aborted).toBe(false)
  })
})

describe('askRunner: an answer made without the project memory says why', () => {
  it('memory locked', async () => {
    const { runner } = setup({ primer: vi.fn(async () => { throw memoryUnavailable('locked') }) })
    expect(await runner.ask(REQ)).toMatchObject({ ok: true, answer: { text: 'primer:null' }, noMemory: 'locked' })
  })

  it('one memory call that ran out of time inside the primer says timeout (WPA fix I2)', async () => {
    const { runner } = setup({ primer: vi.fn(async () => { throw memoryUnavailable('timeout') }) })
    expect(await runner.ask(REQ)).toMatchObject({ ok: true, noMemory: 'timeout' })
  })

  it('the memory process down, or any other failure to read it', async () => {
    const down = setup({ primer: vi.fn(async () => { throw memoryUnavailable('down') }) })
    expect(await down.runner.ask(REQ)).toMatchObject({ ok: true, noMemory: 'down' })
    const other = setup({ primer: vi.fn(async () => { throw new Error('host exited') }) })
    expect(await other.runner.ask(REQ)).toMatchObject({ ok: true, noMemory: 'down' })
    const odd = setup({ primer: vi.fn(async () => { throw 'a string' }) })
    expect(await odd.runner.ask(REQ)).toMatchObject({ ok: true, noMemory: 'down' })
  })

  it('a memory that answered, with notes or with none, is no note; nor is a run that never asked for it', async () => {
    const some = setup({ primer: vi.fn(async () => 'recalled') })
    expect(await some.runner.ask(REQ)).not.toHaveProperty('noMemory')
    const none = setup({ primer: vi.fn(async () => null) })
    expect(await none.runner.ask(REQ)).not.toHaveProperty('noMemory')
    const cold = setup({ primer: vi.fn(async () => { throw memoryUnavailable('down') }) }, async () => okRes('no primer asked'))
    expect(await cold.runner.ask(REQ)).not.toHaveProperty('noMemory')
  })

  it('a failed run carries no note (there is no answer to annotate)', async () => {
    const { runner } = setup({ primer: vi.fn(async () => { throw memoryUnavailable('locked') }) }, async (_r, deps) => {
      await (deps as { primer: (cwd: string) => Promise<string | null> }).primer('C:/repo')
      return { ok: false, error: 'exit 1' } as ExecResult
    })
    expect(await runner.ask(REQ)).toEqual(expect.objectContaining({ ok: false }))
    expect(await runner.ask(REQ)).not.toHaveProperty('noMemory')
  })

  it('an answer that cites a label it was sent carries that label, with the note left off as usual', async () => {
    const plan = { id: 'p1', title: 'Add a cache', summary: [{ text: 'reads once', state: 'observed', evidence: [{ kind: 'file', ref: 'src/a.ts' }] }], buildings: [], edges: [] }
    const { runner, client } = setup({ primer: vi.fn(async () => 'recalled') }, async () => okRes('It reads files [E1].'))
    client.get.mockResolvedValue({ ...DOC, layers: { plan: [plan] } } as never)
    const r = await runner.ask({ ...REQ, proposalId: 'p1' })
    expect(r).toMatchObject({ ok: true, cited: { E1: { kind: 'file', ref: 'src/a.ts' } } })
    expect(r).not.toHaveProperty('noMemory')
  })

  it('memoryUnavailable makes an error that names its reason and nothing else', () => {
    const e = memoryUnavailable('locked')
    expect(e).toBeInstanceOf(Error)
    expect(e.noMemory).toBe('locked')
    expect(e.message).toBe('memory unavailable: locked')
  })
})

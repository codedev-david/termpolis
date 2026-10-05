import { describe, it, expect, afterEach, vi } from 'vitest'
import * as path from 'path'
import type { ExecRequest, ExecResult } from '../../src/main/headlessExec'
import type { LinkTarget, PeerJobView } from '../../src/main/remoteBridge/protocol'
import type { LinkMeta } from '../../src/main/linkedStore'
import {
  JOB_RETENTION_MS,
  MAX_FINISHED_JOBS,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_JSON_BYTES,
  MAX_PROMPT_CHARS,
  activitySummary,
  createLinkedJobs,
  type LinkedActivity,
  type LinkedJobsDeps,
} from '../../src/main/linkedJobs'

const HOME = path.resolve('/home/tester')
const REPO = path.join(HOME, 'repos', 'app')

const FROM: LinkTarget = { via: 'device', id: 'a1b2c3d4e5f60718' }
const OTHER: LinkTarget = { via: 'link', id: '0011223344556677' }
const THIRD: LinkTarget = { via: 'link', id: '8899aabbccddeeff' }

const META: LinkMeta = {
  ref: 'device:a1b2c3d4e5f60718',
  name: 'laptop',
  grants: { run: true, write: false },
  confirmed: true,
  linkedAt: 1,
}
const WRITER: LinkMeta = { ...META, grants: { run: true, write: true } }

const NOT_CONFIRMED = 'Not confirmed yet on linux \u2014 confirm the link under Settings \u25b8 Linked machines there.'

interface PendingRun {
  req: ExecRequest
  resolve: (r: ExecResult) => void
  reject: (e: unknown) => void
}

function setup(over: Partial<LinkedJobsDeps> = {}) {
  const clock = { t: 1_000_000 }
  let seq = 0
  const runs: PendingRun[] = []
  const activity: LinkedActivity[] = []
  const deps: LinkedJobsDeps = {
    runHeadless: (req) => new Promise<ExecResult>((resolve, reject) => runs.push({ req, resolve, reject })),
    agentsInstalled: async () => ({ claude: true, codex: true, gemini: false }),
    localName: () => 'linux',
    version: '1.50.0',
    homedir: () => HOME,
    isDirectory: (p) => p === HOME || p === REPO,
    isSafeModel: (m) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m),
    now: () => clock.t,
    randomId: () => (++seq).toString(16).padStart(12, '0'),
    onActivity: (a) => activity.push(a),
    ...over,
  }
  return { jobs: createLinkedJobs(deps), deps, runs, activity, clock }
}

const result = (over: Partial<ExecResult> = {}): ExecResult => ({
  ok: true,
  agent: 'codex',
  output: 'the answer',
  code: 0,
  durationMs: 1,
  primerChars: 0,
  ...over,
})

const runReq = (over: Record<string, unknown> = {}) => ({ kind: 'peerRun', agent: 'codex', prompt: 'Review the parser', ...over })

/** Let the job's runner settle: the result crosses a few awaits before it lands. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Whether a promise has settled, without awaiting it. */
function track<T>(p: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false }
  p.then(
    (value) => Object.assign(state, { done: true, value }),
    (error) => Object.assign(state, { done: true, error }),
  )
  return state
}

async function start(h: ReturnType<typeof setup>, from: LinkTarget = FROM, meta: LinkMeta = META, over = {}) {
  return (await h.jobs.handle(from, meta, runReq(over) as never)) as PeerJobView
}

const poll = async (h: ReturnType<typeof setup>, jobId: string, waitMs?: number, from: LinkTarget = FROM) =>
  (await h.jobs.handle(from, META, { kind: 'peerResult', jobId, ...(waitMs === undefined ? {} : { waitMs }) })) as PeerJobView

afterEach(() => {
  vi.useRealTimers()
})

describe('peerHello', () => {
  it('answers an unconfirmed link with nothing it may do', async () => {
    const agentsInstalled = vi.fn(async () => ({ claude: true, codex: true, gemini: true }))
    const h = setup({ agentsInstalled })
    expect(await h.jobs.handle(FROM, { ...META, confirmed: false }, { kind: 'peerHello' })).toEqual({
      name: 'linux',
      agents: { claude: false, codex: false, gemini: false },
      grants: { run: false, write: false },
      confirmed: false,
      version: '1.50.0',
    })
    // Which agents are installed here is not told to a machine nobody confirmed.
    expect(agentsInstalled).not.toHaveBeenCalled()
  })

  it('treats a machine with no meta yet as unconfirmed rather than failing', async () => {
    // A pairing that finished a moment ago has no meta until main writes it.
    const h = setup()
    expect(await h.jobs.handle(FROM, undefined as unknown as LinkMeta, { kind: 'peerHello' })).toMatchObject({
      confirmed: false,
      grants: { run: false, write: false },
    })
    await expect(h.jobs.handle(FROM, null as unknown as LinkMeta, runReq() as never)).rejects.toThrow(NOT_CONFIRMED)
  })

  it('tells a confirmed link its grants and the agents installed here', async () => {
    const h = setup()
    expect(await h.jobs.handle(FROM, META, { kind: 'peerHello' })).toEqual({
      name: 'linux',
      agents: { claude: true, codex: true, gemini: false },
      grants: { run: true, write: false },
      confirmed: true,
      version: '1.50.0',
    })
  })

  it('applies write-implies-run, and grants nothing for malformed grants', async () => {
    const h = setup()
    const hello = (grants: unknown) =>
      h.jobs.handle(FROM, { ...META, grants: grants as LinkMeta['grants'] }, { kind: 'peerHello' }) as Promise<{
        grants: unknown
      }>
    expect((await hello({ run: false, write: true })).grants).toEqual({ run: true, write: true })
    expect((await hello({ run: 'yes' })).grants).toEqual({ run: false, write: false })
  })

  it('reports no agents when the probe fails, and only explicit trues', async () => {
    const failing = setup({ agentsInstalled: async () => Promise.reject(new Error('where.exe missing')) })
    expect(await failing.jobs.handle(FROM, META, { kind: 'peerHello' })).toMatchObject({
      agents: { claude: false, codex: false, gemini: false },
    })
    const odd = setup({ agentsInstalled: async () => ({ claude: 'yes', codex: 1, gemini: true }) as never })
    expect(await odd.jobs.handle(FROM, META, { kind: 'peerHello' })).toMatchObject({
      agents: { claude: false, codex: false, gemini: true },
    })
  })
})

describe('peerRun gating', () => {
  it('refuses everything but hello until the link is confirmed here', async () => {
    const h = setup()
    const unconfirmed = { ...META, confirmed: false }
    for (const req of [runReq(), { kind: 'peerResult', jobId: '000000000001' }, { kind: 'peerCancel', jobId: '000000000001' }]) {
      await expect(h.jobs.handle(FROM, unconfirmed, req as never)).rejects.toThrow(NOT_CONFIRMED)
    }
    expect(h.runs).toHaveLength(0)
  })

  it('refuses a machine that may not run agents here', async () => {
    const h = setup()
    await expect(start(h, FROM, { ...META, grants: { run: false, write: false } })).rejects.toThrow(
      'linux does not let this computer run agents there. Turn on "Run agents here" for it under Settings \u25b8 Linked machines on linux.',
    )
    await expect(start(h, FROM, { ...META, grants: null as never })).rejects.toThrow(/does not let this computer run agents/)
    expect(h.runs).toHaveLength(0)
  })

  it('refuses write without the write grant, and runs it with one', async () => {
    const h = setup()
    await expect(start(h, FROM, META, { write: true })).rejects.toThrow(
      'linux does not let this computer\'s agents edit files or run commands there. Run read-only, or turn on "Let agents edit files and run commands here" for it under Settings \u25b8 Linked machines on linux.',
    )
    expect(h.runs).toHaveLength(0)
    await start(h, FROM, WRITER, { write: true })
    expect(h.runs[0].req.write).toBe(true)
  })

  it('refuses requests that are not a linked-machine request', async () => {
    const h = setup()
    for (const req of [null, 'peerRun', 42, { kind: 7 }, {}]) {
      await expect(h.jobs.handle(FROM, META, req as never)).rejects.toThrow('Malformed linked-machine request.')
    }
    // peerBye is the bridge's to handle; it never reaches main.
    for (const kind of ['peerBye', 'listTerminals']) {
      await expect(h.jobs.handle(FROM, META, { kind } as never)).rejects.toThrow('Unsupported linked-machine request.')
    }
  })
})

describe('peerRun validation', () => {
  it('runs only claude, codex or gemini', async () => {
    const h = setup()
    for (const agent of [undefined, 'gpt', 'Codex', 5]) {
      await expect(start(h, FROM, META, { agent })).rejects.toThrow('Invalid agent: expected claude, codex or gemini.')
    }
  })

  it('refuses an agent that is not installed here', async () => {
    const h = setup()
    await expect(start(h, FROM, META, { agent: 'gemini' })).rejects.toThrow('gemini is not installed on linux.')
    const broken = setup({ agentsInstalled: () => Promise.reject(new Error('probe failed')) })
    await expect(start(broken, FROM, META, { agent: 'claude' })).rejects.toThrow('claude is not installed on linux.')
  })

  it('takes a prompt of 1 to 20000 characters', async () => {
    const h = setup()
    for (const prompt of [undefined, '', '  \n\t', 5, 'x'.repeat(MAX_PROMPT_CHARS + 1)]) {
      await expect(start(h, FROM, META, { prompt })).rejects.toThrow('Invalid prompt: expected 1 to 20000 characters.')
    }
    expect(MAX_PROMPT_CHARS).toBe(20_000)
    expect((await start(h, FROM, META, { prompt: 'x'.repeat(MAX_PROMPT_CHARS) })).status).toBe('running')
  })

  it('takes write as a boolean, absent meaning read-only', async () => {
    const h = setup()
    for (const write of ['true', 1, {}]) {
      await expect(start(h, FROM, WRITER, { write })).rejects.toThrow('Invalid write: expected true or false.')
    }
    await start(h, FROM, META, { write: null })
    await start(h, FROM, META, { write: false })
    expect(h.runs.map((r) => r.req.write)).toEqual([false, false])
  })

  it('takes only a safe model id', async () => {
    const h = setup()
    for (const model of ['../evil', '', '-rf', 5, {}]) {
      await expect(start(h, FROM, META, { model })).rejects.toThrow('Invalid model: expected a model id such as "sonnet" or "gpt-5-codex".')
    }
    await start(h, FROM, META, { model: null })
    await start(h, FROM, META, { model: 'gpt-5-codex' })
    expect(h.runs[0].req).not.toHaveProperty('model')
    expect(h.runs[1].req.model).toBe('gpt-5-codex')
  })

  it('clamps the timeout to 10 s .. 60 min, defaulting to 15 min', async () => {
    const timeoutFor = async (timeoutMs: unknown) => {
      const h = setup()
      await start(h, FROM, META, { timeoutMs })
      return h.runs[0].req.timeoutMs
    }
    expect(await timeoutFor(undefined)).toBe(900_000)
    expect(await timeoutFor(null)).toBe(900_000)
    expect(await timeoutFor(1)).toBe(10_000)
    expect(await timeoutFor(120_000)).toBe(120_000)
    expect(await timeoutFor(9e9)).toBe(3_600_000)
    expect(await timeoutFor(Infinity)).toBe(3_600_000)
    for (const timeoutMs of ['60s', NaN, {}]) {
      await expect(start(setup(), FROM, META, { timeoutMs })).rejects.toThrow('Invalid timeoutMs: expected a number of milliseconds.')
    }
  })
})

describe('peerRun working folder', () => {
  const cwdFor = async (cwd: unknown, over: Partial<LinkedJobsDeps> = {}) => {
    const h = setup(over)
    await start(h, FROM, META, cwd === undefined ? {} : { cwd })
    return h.runs[0].req.cwd
  }

  it('defaults to home, and expands ~', async () => {
    expect(await cwdFor(undefined)).toBe(HOME)
    expect(await cwdFor(null)).toBe(HOME)
    expect(await cwdFor('')).toBe(HOME)
    expect(await cwdFor('   ')).toBe(HOME)
    expect(await cwdFor('~')).toBe(HOME)
    expect(await cwdFor('~/repos/app')).toBe(REPO)
    expect(await cwdFor(REPO)).toBe(REPO)
    if (process.platform === 'win32') expect(await cwdFor('~\\repos\\app')).toBe(REPO)
  })

  it('accepts a folder the isDirectory check answers asynchronously', async () => {
    expect(await cwdFor('~/repos/app', { isDirectory: async (p) => p === REPO })).toBe(REPO)
  })

  it('refuses a folder that is not an absolute path', async () => {
    const h = setup()
    await expect(start(h, FROM, META, { cwd: 'repos/app' })).rejects.toThrow(
      'cwd must be an absolute folder path on linux, or start with ~: repos/app',
    )
    // Control characters are never a path, and are not echoed back either.
    await expect(start(h, FROM, META, { cwd: `${REPO}\u0000\u001b[2J` })).rejects.toThrow(
      `cwd must be an absolute folder path on linux, or start with ~: ${REPO}[2J`,
    )
  })

  it('refuses a network path before touching it', async () => {
    // Opening \\host\share from here hands that host this user's NTLM hash on
    // Windows, and an unreachable one can hold the main thread for seconds.
    const isDirectory = vi.fn(() => true)
    const h = setup({ isDirectory })
    await expect(start(h, FROM, META, { cwd: '//fileserver/share/repo' })).rejects.toThrow(
      /^cwd must be a folder on linux itself, not a network path: /,
    )
    expect(isDirectory).not.toHaveBeenCalled()
  })

  it('refuses a folder that does not exist', async () => {
    const missing = path.join(HOME, 'nope')
    await expect(start(setup(), FROM, META, { cwd: missing })).rejects.toThrow(`Folder not found on linux: ${missing}`)
    const throwing = setup({
      isDirectory: () => {
        throw new Error('EACCES')
      },
    })
    await expect(start(throwing, FROM, META, { cwd: REPO })).rejects.toThrow(`Folder not found on linux: ${REPO}`)
    const rejecting = setup({ isDirectory: () => Promise.reject(new Error('EIO')) })
    await expect(start(rejecting, FROM, META)).rejects.toThrow(`Folder not found on linux: ${HOME}`)
  })

  it('refuses a cwd that is not a string or is absurdly long', async () => {
    const h = setup()
    await expect(start(h, FROM, META, { cwd: 5 })).rejects.toThrow('Invalid cwd: expected a folder path.')
    await expect(start(h, FROM, META, { cwd: `/${'a'.repeat(4096)}` })).rejects.toThrow('Invalid cwd: longer than 4096 characters.')
  })

  it('cuts a long folder short when echoing it back', async () => {
    const deep = path.join(HOME, 'x'.repeat(300))
    const err = await start(setup(), FROM, META, { cwd: deep }).catch((e: Error) => e)
    expect((err as Error).message).toBe(`Folder not found on linux: ${deep.slice(0, 199)}\u2026`)
  })
})

describe('running a job', () => {
  it('starts the agent confined: framed prompt, no Termpolis MCP, nothing remembered, marked as a linked job', async () => {
    const h = setup()
    const view = await start(h, FROM, WRITER, { cwd: '~/repos/app', write: true, model: 'gpt-5-codex', timeoutMs: 60_000, prompt: 'Implement the parser.\nThen commit.' })
    expect(view).toEqual({ jobId: '000000000001', agent: 'codex', status: 'running', startedAt: 1_000_000 })
    expect(h.runs[0].req).toEqual({
      task:
        `[Delegated by "laptop" over Termpolis Linked machines. Working folder: ${REPO}. ` +
        'Your final message is returned to the agent that asked.]\n\nImplement the parser.\nThen commit.',
      agent: 'codex',
      model: 'gpt-5-codex',
      cwd: REPO,
      write: true,
      timeoutMs: 60_000,
      isolateMcp: true,
      noRemember: true,
      env: { TERMPOLIS_LINKED_JOB: '000000000001' },
      signal: expect.any(AbortSignal),
    })
    // The memory primer is kept: delegated work should start as warm as local work.
    expect(h.runs[0].req).not.toHaveProperty('noPrimer')
  })

  it('answers at once with a running job, then reports what the agent said', async () => {
    const h = setup()
    const { jobId } = await start(h)
    expect((await poll(h, jobId)).status).toBe('running')
    h.clock.t += 5_000
    h.runs[0].resolve(result({ output: 'the answer' }))
    await flush()
    expect(await poll(h, jobId)).toEqual({
      jobId,
      agent: 'codex',
      status: 'done',
      output: 'the answer',
      startedAt: 1_000_000,
      durationMs: 5_000,
    })
  })

  it('records activity on start and on every status change, under one id', async () => {
    const h = setup()
    const { jobId } = await start(h, FROM, META, { prompt: '\n  Review the parser in src/  \nand more' })
    h.clock.t += 2_500
    h.runs[0].resolve(result())
    await flush()
    const base = {
      id: jobId,
      direction: 'in',
      ref: 'device:a1b2c3d4e5f60718',
      machine: 'laptop',
      agent: 'codex',
      summary: 'Review the parser in src/',
      startedAt: 1_000_000,
    }
    expect(h.activity).toEqual([
      { ...base, status: 'running' },
      { ...base, status: 'done', durationMs: 2_500 },
    ])
  })

  it('keeps the tail of an answer longer than 200000 characters', async () => {
    const h = setup()
    const { jobId } = await start(h)
    const output = `${'h'.repeat(10)}${'t'.repeat(MAX_OUTPUT_CHARS)}`
    h.runs[0].resolve(result({ output }))
    await flush()
    const view = await poll(h, jobId)
    expect(view.output).toBe('t'.repeat(MAX_OUTPUT_CHARS))
    expect(view.truncated).toBe(true)
  })

  it('keeps the tail of an answer that would not fit in one relay frame once encoded', async () => {
    // A control character is six bytes in JSON, so 200000 of them make a 1.2 MB
    // reply -- over the relay's 1 MiB frame, and an answer the bridge would
    // refuse to send on every poll.
    const h = setup()
    const { jobId } = await start(h)
    h.runs[0].resolve(result({ output: `head${'\u0001'.repeat(MAX_OUTPUT_CHARS - 8)}tail` }))
    await flush()
    const view = await poll(h, jobId)
    expect(view.truncated).toBe(true)
    expect(view.output!.endsWith(`${'\u0001'.repeat(1_000)}tail`)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(view.output))).toBeLessThanOrEqual(MAX_OUTPUT_JSON_BYTES)
    // Not cut to nothing: as much of the tail as fits.
    expect(view.output!.length).toBeGreaterThan(MAX_OUTPUT_JSON_BYTES / 6 / 2)
  })

  it('cuts nothing more from an answer free of control characters, however wide its characters', async () => {
    // Three bytes a character is the most such text takes: 200000 of them fit.
    const h = setup()
    const { jobId } = await start(h)
    const output = '中'.repeat(MAX_OUTPUT_CHARS)
    h.runs[0].resolve(result({ output }))
    await flush()
    const view = await poll(h, jobId)
    expect(view.output).toBe(output)
    expect(view.truncated).toBeUndefined()
  })

  it('reports an empty or missing answer as done with empty output', async () => {
    const h = setup()
    const a = await start(h)
    const b = await start(h)
    h.runs[0].resolve(result({ output: '' }))
    h.runs[1].resolve(result({ output: undefined as never }))
    await flush()
    expect(await poll(h, a.jobId)).toMatchObject({ status: 'done', output: '' })
    expect(await poll(h, b.jobId)).toMatchObject({ status: 'done', output: '' })
  })

  it('reports a failed run with its error, and any output it left', async () => {
    const h = setup()
    const a = await start(h)
    const b = await start(h)
    h.runs[0].resolve(result({ ok: false, output: '', error: 'auth expired', code: 1 }))
    h.runs[1].resolve(result({ ok: false, output: 'partial work', error: undefined, code: 3 }))
    await flush()
    const failedA = await poll(h, a.jobId)
    expect(failedA).toMatchObject({ status: 'failed', error: 'auth expired' })
    expect(failedA).not.toHaveProperty('output')
    expect(await poll(h, b.jobId)).toMatchObject({ status: 'failed', error: 'exit 3', output: 'partial work' })
  })

  it('keeps the end of a very long error', async () => {
    const h = setup()
    const { jobId } = await start(h)
    h.runs[0].resolve(result({ ok: false, output: '', error: `${'x'.repeat(5_000)}the real error` }))
    await flush()
    const { error } = await poll(h, jobId)
    expect(error).toHaveLength(4_000)
    expect(error?.startsWith('\u2026x')).toBe(true)
    expect(error?.endsWith('the real error')).toBe(true)
  })

  it('fails a job whose runner throws or rejects', async () => {
    const thrown = setup({
      runHeadless: () => {
        throw new Error('spawn EPERM')
      },
    })
    const a = await start(thrown)
    await flush()
    expect(await poll(thrown, a.jobId)).toMatchObject({ status: 'failed', error: 'spawn EPERM' })

    const h = setup()
    const b = await start(h)
    const c = await start(h)
    h.runs[0].reject(new Error('deliver crashed'))
    h.runs[1].reject('plain string')
    await flush()
    expect(await poll(h, b.jobId)).toMatchObject({ status: 'failed', error: 'deliver crashed' })
    expect(await poll(h, c.jobId)).toMatchObject({ status: 'failed', error: 'plain string' })
  })

  it('fails a job whose runner answers with nothing usable', async () => {
    const h = setup({ runHeadless: async () => null as never })
    const { jobId } = await start(h)
    await flush()
    expect(await poll(h, jobId)).toMatchObject({ status: 'failed' })
  })

  it('keeps a job going when the activity listener throws', async () => {
    const h = setup({
      onActivity: () => {
        throw new Error('renderer gone')
      },
    })
    const { jobId } = await start(h)
    h.runs[0].resolve(result())
    await flush()
    expect((await poll(h, jobId)).status).toBe('done')
  })
})

describe('peerResult long-poll', () => {
  it('holds the poll until the job finishes, and no longer', async () => {
    vi.useFakeTimers()
    const h = setup()
    const { jobId } = await start(h)
    const pending = track(poll(h, jobId, 50_000))
    await flush()
    expect(pending.done).toBe(false)
    h.runs[0].resolve(result())
    await flush()
    // Woken by the job itself, not by a timer: no time has passed.
    expect(pending.done).toBe(true)
    expect(pending.value?.status).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up at waitMs with the job still running', async () => {
    vi.useFakeTimers()
    const h = setup()
    const { jobId } = await start(h)
    const pending = track(poll(h, jobId, 20_000))
    await vi.advanceTimersByTimeAsync(19_999)
    expect(pending.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(pending.done).toBe(true)
    expect(pending.value?.status).toBe('running')
  })

  it('holds a poll for 50 seconds at most', async () => {
    vi.useFakeTimers()
    const h = setup()
    const { jobId } = await start(h)
    const pending = track(poll(h, jobId, 600_000))
    await vi.advanceTimersByTimeAsync(49_999)
    expect(pending.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(pending.done).toBe(true)
  })

  it('answers at once for a wait of zero, a negative one, or one that is not a number', async () => {
    vi.useFakeTimers()
    const h = setup()
    const { jobId } = await start(h)
    for (const waitMs of [undefined, 0, -5, 'soon', NaN, Infinity]) {
      const pending = track(h.jobs.handle(FROM, META, { kind: 'peerResult', jobId, waitMs } as never))
      await flush()
      expect(pending.done).toBe(true)
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers a finished job at once', async () => {
    vi.useFakeTimers()
    const h = setup()
    const { jobId } = await start(h)
    h.runs[0].resolve(result())
    await flush()
    const pending = track(poll(h, jobId, 50_000))
    await flush()
    expect(pending.value?.status).toBe('done')
  })

  it('shows a job only to the machine that started it', async () => {
    const h = setup()
    const { jobId } = await start(h)
    await expect(poll(h, jobId, 0, OTHER)).rejects.toThrow('unknown job')
    await expect(poll(h, 'ffffffffffff')).rejects.toThrow('unknown job')
    await expect(h.jobs.handle(FROM, META, { kind: 'peerResult', jobId: 7 } as never)).rejects.toThrow('unknown job')
    await expect(h.jobs.handle(OTHER, META, { kind: 'peerCancel', jobId })).rejects.toThrow('unknown job')
    expect(h.runs[0].req.signal?.aborted).toBe(false)
  })
})

describe('peerCancel', () => {
  it('stops a running job, and the job reads cancelled from then on', async () => {
    const h = setup()
    const { jobId } = await start(h)
    h.clock.t += 700
    const view = (await h.jobs.handle(FROM, META, { kind: 'peerCancel', jobId })) as PeerJobView
    expect(view).toEqual({
      jobId,
      agent: 'codex',
      status: 'cancelled',
      error: 'Cancelled by the computer that asked for it.',
      startedAt: 1_000_000,
      durationMs: 700,
    })
    expect(h.runs[0].req.signal?.aborted).toBe(true)
    expect(h.activity.map((a) => a.status)).toEqual(['running', 'cancelled'])
    // The run winding down afterwards changes nothing.
    h.runs[0].resolve(result({ ok: false, error: 'cancelled', code: 1 }))
    await flush()
    expect((await poll(h, jobId)).status).toBe('cancelled')
    expect(h.activity).toHaveLength(2)
  })

  it('leaves a finished job as it was', async () => {
    const h = setup()
    const { jobId } = await start(h)
    h.runs[0].resolve(result())
    await flush()
    expect(((await h.jobs.handle(FROM, META, { kind: 'peerCancel', jobId })) as PeerJobView).status).toBe('done')
    expect(h.runs[0].req.signal?.aborted).toBe(false)
  })

  it('wakes a poll that is waiting on the job', async () => {
    vi.useFakeTimers()
    const h = setup()
    const { jobId } = await start(h)
    const pending = track(poll(h, jobId, 50_000))
    await flush()
    await h.jobs.handle(FROM, META, { kind: 'peerCancel', jobId })
    await flush()
    expect(pending.value?.status).toBe('cancelled')
  })
})

describe('concurrency caps', () => {
  it('runs at most 2 jobs for one machine', async () => {
    const h = setup()
    await start(h)
    await start(h)
    await expect(start(h)).rejects.toThrow(
      'busy: linux is already running 2 jobs for this computer. Wait for one to finish, or cancel one.',
    )
  })

  it('runs at most 4 jobs in all', async () => {
    const h = setup()
    await start(h, FROM)
    await start(h, FROM)
    await start(h, OTHER)
    await start(h, OTHER)
    await expect(start(h, THIRD)).rejects.toThrow('busy: linux is already running 4 linked jobs. Try again when one finishes.')
    expect(h.runs).toHaveLength(4)
  })

  it('frees the slot when a job finishes', async () => {
    const h = setup()
    await start(h)
    await start(h)
    h.runs[0].resolve(result())
    await flush()
    expect((await start(h)).status).toBe('running')
  })

  it('counts jobs only once every check has passed, so a burst cannot slip past', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = setup({
      agentsInstalled: async () => {
        await gate
        return { claude: true, codex: true, gemini: false }
      },
    })
    const burst = Promise.allSettled([start(h), start(h), start(h)])
    release()
    const outcomes = await burst
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2)
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1)
    expect(h.runs).toHaveLength(2)
  })
})

describe('job ids', () => {
  it('refuses to start a job under an id that is malformed or already used', async () => {
    const bad = setup({ randomId: () => 'not-hex' })
    await expect(start(bad)).rejects.toThrow('Could not start the job on linux. Try again.')
    expect(bad.runs).toHaveLength(0)

    const stuck = setup({ randomId: () => 'abcdefabcdef' })
    await start(stuck)
    await expect(start(stuck)).rejects.toThrow('Could not start the job on linux. Try again.')
    expect(stuck.runs).toHaveLength(1)
  })
})

describe('retention', () => {
  it('forgets a finished job two hours after it finished', async () => {
    const h = setup()
    const { jobId } = await start(h)
    h.runs[0].resolve(result())
    await flush()
    h.clock.t += JOB_RETENTION_MS
    expect((await poll(h, jobId)).status).toBe('done')
    h.clock.t += 1
    await expect(poll(h, jobId)).rejects.toThrow('unknown job')
  })

  it('keeps at most 100 finished jobs, forgetting the oldest first', async () => {
    const h = setup()
    const ids: string[] = []
    for (let i = 0; i <= MAX_FINISHED_JOBS; i++) {
      ids.push((await start(h)).jobId)
      h.clock.t += 1
      h.runs[i].resolve(result())
      await flush()
    }
    await expect(poll(h, ids[0])).rejects.toThrow('unknown job')
    expect((await poll(h, ids[1])).status).toBe('done')
    expect((await poll(h, ids[MAX_FINISHED_JOBS])).status).toBe('done')
  })

  it('never forgets a job that is still running', async () => {
    const h = setup()
    const { jobId } = await start(h)
    h.clock.t += 3 * JOB_RETENTION_MS
    expect((await poll(h, jobId)).status).toBe('running')
  })
})

describe('cancelAll', () => {
  it('stops every running job and leaves finished ones alone', async () => {
    const h = setup()
    const a = await start(h, FROM)
    const b = await start(h, OTHER)
    const c = await start(h, OTHER)
    h.runs[2].resolve(result())
    await flush()
    h.jobs.cancelAll()
    expect(h.runs.map((r) => r.req.signal?.aborted)).toEqual([true, true, false])
    expect(await poll(h, a.jobId)).toMatchObject({ status: 'cancelled', error: 'Cancelled on linux.' })
    expect(await poll(h, b.jobId, 0, OTHER)).toMatchObject({ status: 'cancelled' })
    expect((await poll(h, c.jobId, 0, OTHER)).status).toBe('done')
  })
})

describe('revoke', () => {
  it("stops every job an unlinked machine has running here -- and only that machine's", async () => {
    const h = setup()
    const mine = await start(h, FROM)
    const finished = await start(h, FROM)
    const theirs = await start(h, OTHER)
    h.runs[1].resolve(result())
    await flush()

    h.jobs.revoke(FROM, null)

    expect(h.runs.map((r) => r.req.signal?.aborted)).toEqual([true, false, false])
    expect(await poll(h, mine.jobId)).toMatchObject({ status: 'cancelled', error: 'Cancelled on linux: the link was removed.' })
    expect((await poll(h, finished.jobId)).status).toBe('done')
    expect((await poll(h, theirs.jobId, 0, OTHER)).status).toBe('running')
    expect(h.activity.filter((a) => a.id === mine.jobId).map((a) => a.status)).toEqual(['running', 'cancelled'])
  })

  it('stops the jobs a withdrawn grant no longer allows, and leaves the rest running', async () => {
    const h = setup()
    const read = await start(h, FROM, WRITER)
    const write = await start(h, FROM, WRITER, { write: true })

    // Nothing withdrawn: nothing stops.
    h.jobs.revoke(FROM, { run: true, write: true })
    expect(h.runs.map((r) => r.req.signal?.aborted)).toEqual([false, false])

    h.jobs.revoke(FROM, { run: true, write: false })
    expect(h.runs.map((r) => r.req.signal?.aborted)).toEqual([false, true])
    expect(await poll(h, write.jobId)).toMatchObject({
      status: 'cancelled',
      error: "Cancelled: linux no longer lets this computer's agents edit files or run commands there.",
    })
    expect((await poll(h, read.jobId)).status).toBe('running')

    h.jobs.revoke(FROM, { run: false, write: false })
    expect(h.runs.map((r) => r.req.signal?.aborted)).toEqual([true, true])
    expect(await poll(h, read.jobId)).toMatchObject({
      status: 'cancelled',
      error: 'Cancelled: linux no longer lets this computer run agents there.',
    })
  })
})

describe('names in messages', () => {
  it('says "the other computer" when this machine has no name', async () => {
    const h = setup({ localName: () => '  ' })
    await expect(h.jobs.handle(FROM, { ...META, confirmed: false }, runReq() as never)).rejects.toThrow(
      'Not confirmed yet on the other computer \u2014',
    )
    expect(await h.jobs.handle(FROM, META, { kind: 'peerHello' })).toMatchObject({ name: '  ' })
  })
})

describe('activitySummary', () => {
  it('is the first line with text in it', () => {
    expect(activitySummary('Review the parser')).toBe('Review the parser')
    expect(activitySummary('\n \r\n  Fix the build  \nthen test')).toBe('Fix the build')
    expect(activitySummary('first\rsecond')).toBe('first')
  })

  it('flattens control characters and runs of whitespace', () => {
    expect(activitySummary('a\tb\u001b[31m  c\u0000d\u0085e')).toBe('a b [31m c d e')
  })

  it('is at most 80 characters, with an ellipsis when cut', () => {
    expect(activitySummary('x'.repeat(80))).toBe('x'.repeat(80))
    const cut = activitySummary('y'.repeat(100))
    expect(cut).toBe(`${'y'.repeat(79)}\u2026`)
    expect(cut).toHaveLength(80)
    expect(activitySummary(`${'z'.repeat(78)} word`)).toBe(`${'z'.repeat(78)}\u2026`)
  })

  it('is empty when the prompt has no text', () => {
    expect(activitySummary('')).toBe('')
    expect(activitySummary(' \n\t\n ')).toBe('')
  })
})

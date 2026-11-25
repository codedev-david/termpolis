// WP4b #26: a slow `gh` never holds the map. The host gives main's CI answer a short budget (ciAskMs); past it the
// compile goes on without CI and the map is drawn. The ask keeps going: when main answers, the answer is kept (per
// project and commit) and the world is compiled again from the stored one, so the CI results land on the map drawn.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import type { CompileDeps, CompileInput } from '../../src/main/world/compile'
import type { TestRun } from '../../src/main/world/testStatus'
import { CI_ASK_MS, CI_MEMO_MS, ciOf, createWorldHost, RUNS_WAIT_MS, type WorldHead, type WorldHostDeps, type WorldHostResponse } from '../../src/main/world/worldHost'
import { createWorldRuns } from '../../src/main/world/worldRuns'
import type { WorldStore } from '../../src/main/world/worldStore'
import type { WorldDoc } from '../../src/shared/world/types'

const snap = (root = '/repo'): GraphSnapshot => ({ root, files: ['src/a.ts'], symbols: [], callEdges: [], fileImports: {} })
const HEAD: WorldHead = { head: 'h1', dirty: false }
let seq = 0
const doc = (projectKey: string): WorldDoc => ({ projectKey, generatedAt: ++seq }) as unknown as WorldDoc

function memStore(): WorldStore & { docs: Map<string, WorldDoc>; saves: WorldDoc[] } {
  const docs = new Map<string, WorldDoc>()
  const saves: WorldDoc[] = []
  return {
    docs,
    saves,
    load: async (k) => docs.get(k) ?? null,
    save: async (d) => {
      saves.push(d)
      docs.set(d.projectKey, d)
    },
    labelCache: { get: async () => null, set: async () => undefined }
  }
}

type Ask = Extract<WorldHostResponse, { kind: 'runs' }>

/** A host whose compile records what CI gave it; main's transcript asks are answered at once with nothing. */
function harness(deps: WorldHostDeps = {}) {
  const out: WorldHostResponse[] = []
  const store = memStore()
  const ci: Array<TestRun[] | null | undefined> = []
  const inputs: CompileInput[] = []
  const compile = vi.fn(async (input: CompileInput, d: CompileDeps) => {
    inputs.push(input)
    const [, got] = await Promise.all([d.transcriptRuns?.(), d.ciRuns?.()])
    ci.push(got)
    return doc(input.projectKey)
  })
  const ref: { host?: ReturnType<typeof createWorldHost> } = {}
  const post = (m: WorldHostResponse): void => {
    out.push(m)
    if (m.kind === 'runs' && m.source === 'transcript') queueMicrotask(() => void ref.host?.handle({ kind: 'runs-result', id: m.id, runs: [], files: [] }))
  }
  const host = (ref.host = createWorldHost(post, { createStore: () => store, compile, runsTimeoutMs: 60_000, ...deps }))
  const send = (m: Parameters<typeof host.handle>[0]) => host.handle(m)
  const ciAsks = (): Ask[] => out.filter((m): m is Ask => m.kind === 'runs' && m.source === 'ci')
  /** main's answer to a CI ask, naming the commit it judged (by default the one the tests compile). */
  const answer = (a: Ask, runs: unknown[] | null, head: string | null = HEAD.head, age?: number) =>
    send({ kind: 'runs-result', id: a.id, runs: runs as TestRun[] | null, head, ...(age === undefined ? {} : { age }) })
  const updated = () => out.filter((m) => m.kind === 'updated')
  const init = (labelling = false) => send({ kind: 'init', userDataPath: '/ud', labelling })
  return { out, store, ci, inputs, compile, send, ciAsks, answer, updated, init }
}

const RUN = { file: 'src/a.test.ts', passed: true, at: 3 }
const CLEAN = { ...RUN, source: 'ci' }

afterEach(() => {
  vi.useRealTimers()
})

describe('main\'s CI answer has a short budget, and lands when it comes (WP4b #26)', () => {
  it('the budget is short beside the other runs\' wait', () => {
    expect(CI_ASK_MS).toBeLessThanOrEqual(2000)
    expect(CI_ASK_MS).toBeLessThan(RUNS_WAIT_MS)
  })

  it('a CI answer later than the budget: the map is drawn without it, then compiled again with it, once', async () => {
    const h = harness({ ciAskMs: 20 })
    await h.init()
    const first = await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    void first
    // Drawn and saved without CI: the call answered while main's CI ask is still open.
    expect(h.out.some((m) => m.kind === 'result' && m.id === 1 && m.ok)).toBe(true)
    expect(h.ci).toEqual([null])
    expect(h.store.saves).toHaveLength(1)
    expect(h.ciAsks()).toHaveLength(1)
    // main answers: the world is compiled again from the stored one, with the CI runs, saved and pushed.
    await h.answer(h.ciAsks()[0], [RUN])
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
    expect(h.ci).toEqual([null, [CLEAN]])
    expect(h.ciAsks()).toHaveLength(1)
    const again = h.inputs[1]
    expect(again.previous).toBe(h.store.saves[0])
    expect(again.changed).toEqual([])
    expect(again.snap).toEqual(snap())
    expect(again.head).toEqual(HEAD)
    expect(h.updated().length).toBe(2)
    // The compile's own push is a world like any other; the late CI one changes test status only, and says so, so the
    // pane restyles the parts in place and a tour or flight under way goes on (WP4b fix round 1, M6).
    expect(h.updated()).toEqual([{ kind: 'updated', projectKey: 'k1' }, { kind: 'updated', projectKey: 'k1', statusOnly: true }])
  })

  it('a CI answer within the budget is used at once and compiles nothing more', async () => {
    const h = harness({ ciAskMs: 5_000 })
    await h.init()
    const call = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(1))
    await h.answer(h.ciAsks()[0], [RUN])
    await call
    expect(h.ci).toEqual([[CLEAN]])
    await new Promise((r) => setTimeout(r, 20))
    expect(h.compile).toHaveBeenCalledTimes(1)
  })

  it('the answer is kept for the project and its commit: the next compile asks main nothing, a new commit asks again', async () => {
    const h = harness({ ciAskMs: 5_000 })
    await h.init()
    const call = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(1))
    await h.answer(h.ciAsks()[0], [RUN])
    await call
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.ciAsks()).toHaveLength(1)
    expect(h.ci).toEqual([[CLEAN], [CLEAN]])
    // Another project, or another commit of this one, is not this answer's.
    const other = h.send({ kind: 'call', id: 3, fn: 'compile', args: ['k2', snap('/other'), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(2))
    await h.answer(h.ciAsks()[1], [])
    await other
    const moved = h.send({ kind: 'call', id: 4, fn: 'compile', args: ['k1', snap(), { head: 'h2', dirty: false }] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(3))
    await h.answer(h.ciAsks()[2], [], 'h2')
    await moved
    expect(h.ci.slice(2)).toEqual([[], []])
  })

  it('an answer is kept only so long: past CI_MEMO_MS the next compile asks main again', async () => {
    let t = 1_000
    const h = harness({ ciAskMs: 5_000, now: () => t })
    await h.init()
    const call = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(1))
    await h.answer(h.ciAsks()[0], [RUN])
    await call
    t += 10 * 60_000 + 1
    const next = h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(2))
    await h.answer(h.ciAsks()[1], [])
    await next
    expect(h.ci).toEqual([[CLEAN], []])
  })

  it('compiles that run while one ask is open share it, and its late answer compiles again once', async () => {
    const h = harness({ ciAskMs: 20 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.ciAsks()).toHaveLength(1)
    expect(h.ci).toEqual([null, null])
    await h.answer(h.ciAsks()[0], [RUN])
    await vi.waitFor(() => expect(h.compile).toHaveBeenCalledTimes(3))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.compile).toHaveBeenCalledTimes(3)
    expect(h.ci[2]).toEqual([CLEAN])
  })

  it('main never answering compiles nothing more, and the next compile asks again', async () => {
    const h = harness({ ciAskMs: 10, runsTimeoutMs: 30 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await new Promise((r) => setTimeout(r, 60))
    expect(h.compile).toHaveBeenCalledTimes(1)
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.ciAsks()).toHaveLength(2)
  })

  it('a late answer for a world that was never saved, or no longer is, compiles nothing', async () => {
    const h = harness({ ciAskMs: 10 })
    h.compile.mockImplementationOnce(async (_input: CompileInput, d: CompileDeps) => {
      await d.ciRuns?.()
      throw new Error('boom')
    })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.store.saves).toHaveLength(0)
    await h.answer(h.ciAsks()[0], [RUN])
    await new Promise((r) => setTimeout(r, 20))
    expect(h.compile).toHaveBeenCalledTimes(1)
    // Saved, then gone (removed) before the answer came.
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), { head: 'h2', dirty: false }] })
    expect(h.store.saves).toHaveLength(1)
    h.store.docs.clear()
    await h.answer(h.ciAsks()[1], [RUN], 'h2')
    await new Promise((r) => setTimeout(r, 20))
    expect(h.compile).toHaveBeenCalledTimes(2)
  })

  it('a world compiled again for a newer commit meanwhile takes no late answer for the old one', async () => {
    const h = harness({ ciAskMs: 10 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    const newer = h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), { head: 'h2', dirty: false }] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(2))
    await newer
    await h.answer(h.ciAsks()[0], [RUN])
    await new Promise((r) => setTimeout(r, 20))
    expect(h.compile).toHaveBeenCalledTimes(2)
  })

  it('with labelling on, the compile the late answer makes asks no model: labels come from the label cache only', async () => {
    const h = harness({ ciAskMs: 10 })
    const asked: Array<string | null> = []
    h.compile.mockImplementation(async (input: CompileInput, d: CompileDeps) => {
      h.inputs.push(input)
      const [, got] = await Promise.all([d.transcriptRuns?.(), d.ciRuns?.()])
      h.ci.push(got)
      if (h.ci.length === 2) asked.push(await (d.label?.llm as (p: string) => Promise<string | null>)('name this'))
      return doc(input.projectKey)
    })
    await h.init(true)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await h.answer(h.ciAsks()[0], [RUN])
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
    expect(asked).toEqual([null])
    expect(h.out.some((m) => m.kind === 'llm')).toBe(false)
  })

  it('a late answer that fails to compile again is logged, and the stored world stands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = harness({ ciAskMs: 10 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    h.compile.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    await h.answer(h.ciAsks()[0], [RUN])
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(h.store.saves).toHaveLength(1)
    warn.mockRestore()
  })
  it('each guard on a late answer holds on its own (fix round 1, M3): an old ask that lands leaves the newer ask open', async () => {
    const h = harness({ ciAskMs: 10 })
    await h.init()
    // h1 asks and goes late; h2 asks and replaces it, and goes late too.
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), { head: 'h2', dirty: false }] })
    expect(h.ciAsks()).toHaveLength(2)
    // h1's answer lands: it is not this project's any more, so h2's open ask stands and the next h2 compile shares it.
    await h.answer(h.ciAsks()[0], [RUN], 'h1')
    await h.send({ kind: 'call', id: 3, fn: 'compile', args: ['k1', snap(), { head: 'h2', dirty: false }] })
    expect(h.ciAsks()).toHaveLength(2)
    // h2's answer lands, once, and is kept: the next h2 compile asks nothing.
    await h.answer(h.ciAsks()[1], [RUN], 'h2')
    await vi.waitFor(() => expect(h.compile).toHaveBeenCalledTimes(4))
    await h.send({ kind: 'call', id: 4, fn: 'compile', args: ['k1', snap(), { head: 'h2', dirty: false }] })
    expect(h.ciAsks()).toHaveLength(2)
    expect(h.ci[4]).toEqual([CLEAN])
  })

  it('each guard on a late answer holds on its own (fix round 1, M3): a late answer for a commit the world has left compiles nothing', async () => {
    const h = harness({ ciAskMs: 10 })
    await h.init()
    // h2's answer comes late and lands: kept, and the world compiled again with it.
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), { head: 'h2', dirty: false }] })
    await h.answer(h.ciAsks()[0], [RUN], 'h2')
    await vi.waitFor(() => expect(h.compile).toHaveBeenCalledTimes(2))
    // h1 asks and goes late.
    const a = h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(2))
    // back on h2 before h1's answer comes: kept, so no ask, and the world is now h2's.
    await h.send({ kind: 'call', id: 3, fn: 'compile', args: ['k1', snap(), { head: 'h2', dirty: false }] })
    expect(h.ciAsks()).toHaveLength(2)
    const updates = h.updated().length
    // h1's answer: the ask is still the open one, but the world is h2's now, so nothing is compiled for it.
    await h.answer(h.ciAsks()[1], [RUN], 'h1')
    await a
    await new Promise((r) => setTimeout(r, 20))
    expect(h.compile).toHaveBeenCalledTimes(4)
    expect(h.updated().length).toBe(updates)
  })
})

describe('CI answers are kept by the commit main judged (WP4b fix round 1, I2)', () => {
  it('an answer that judged another commit (HEAD moved while main looked) is not used, kept or compiled in', async () => {
    const h = harness({ ciAskMs: 5_000 })
    await h.init()
    const call = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(1))
    await h.answer(h.ciAsks()[0], [RUN], 'h2')
    await call
    expect(h.ci).toEqual([null])
    // Not kept for h1: the next h1 compile asks again and takes its own answer, whatever case main spells it in.
    const again = h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(2))
    await h.answer(h.ciAsks()[1], [], 'H1')
    await again
    expect(h.ci).toEqual([null, []])
  })

  it('a late answer for another commit compiles nothing and is not kept', async () => {
    const h = harness({ ciAskMs: 10 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await h.answer(h.ciAsks()[0], [RUN], 'h2')
    await new Promise((r) => setTimeout(r, 20))
    expect(h.compile).toHaveBeenCalledTimes(1)
    expect(h.updated()).toHaveLength(1)
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.ciAsks()).toHaveLength(2)
  })

  it('no answer (runs null, or no commit named) is not known and not kept; CI not read (head null) is no runs, not kept', async () => {
    const h = harness({ ciAskMs: 5_000 })
    await h.init()
    const answers: Array<[unknown[] | null, string | null | undefined]> = [
      [null, HEAD.head],
      [[RUN], undefined],
      [[RUN], null]
    ]
    for (const [i, [runs, head]] of answers.entries()) {
      const call = h.send({ kind: 'call', id: i + 1, fn: 'compile', args: ['k1', snap(), HEAD] })
      await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(i + 1))
      const ask = h.ciAsks()[i]
      await h.send({ kind: 'runs-result', id: ask.id, runs: runs as TestRun[] | null, ...(head === undefined ? {} : { head }) })
      await call
    }
    expect(h.ci).toEqual([null, null, []])
    // None was kept: a fourth compile asks again.
    const last = h.send({ kind: 'call', id: 9, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(4))
    await h.answer(h.ciAsks()[3], [])
    await last
  })

  it('a world with no commit takes no CI runs: there is no commit to judge them by', async () => {
    const h = harness({ ciAskMs: 5_000 })
    await h.init()
    const call = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), { head: '', dirty: false }] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(1))
    await h.answer(h.ciAsks()[0], [RUN], '')
    await call
    expect(h.ci).toEqual([null])
  })

  it("the host keeps an answer only for what is left of main's 10 minutes", async () => {
    let t = 1_000
    const h = harness({ ciAskMs: 5_000, now: () => t })
    await h.init()
    const call = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(1))
    // main found this 9 minutes ago: one minute is left.
    await h.answer(h.ciAsks()[0], [RUN], HEAD.head, 9 * 60_000)
    await call
    t += 59_000
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.ciAsks()).toHaveLength(1)
    t += 2_000
    const late = h.send({ kind: 'call', id: 3, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(2))
    // An age past main's own keep, or none that is a number, is clamped: kept for nothing more, or from now.
    await h.answer(h.ciAsks()[1], [RUN], HEAD.head, CI_MEMO_MS * 5)
    await late
    const next = h.send({ kind: 'call', id: 4, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(3))
    await h.answer(h.ciAsks()[2], [RUN], HEAD.head, -5)
    await next
    t += CI_MEMO_MS - 1
    await h.send({ kind: 'call', id: 5, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.ciAsks()).toHaveLength(3)
    expect(ciOf({ runs: [], head: 'h1', age: 'x' }, 'h1')).toEqual({ runs: [], keep: true, age: 0 })
  })

  it("HEAD switched while the map was built, then back within 10 minutes: the map never shows the other commit's status", async () => {
    const A = 'a'.repeat(40)
    const B = 'b'.repeat(40)
    const repo = { head: A, t: Date.parse('2026-11-03T00:00:00Z') }
    const gh = '/usr/bin/gh'
    // main's real CI lookup: A's test run failed, B's passed; each changed src/a.ts.
    const main = createWorldRuns({
      listTranscripts: async () => [],
      transcriptsAllowed: () => true,
      ciAllowed: async () => true,
      ghOnPath: async () => gh,
      gitBin: async () => '/usr/bin/git',
      realpath: async (p) => p,
      now: () => repo.t,
      exec: async (bin, args) => {
        if (bin === gh) {
          return { stdout: JSON.stringify([A, B].map((headSha, i) => ({ headSha, conclusion: headSha === A ? 'failure' : 'success', workflowName: 'Tests', createdAt: '2026-11-02T10:00:00Z', databaseId: i }))) }
        }
        if (args.includes('remote')) return { stdout: 'origin\tgit@github.com:o/r.git (fetch)\n' }
        if (args.includes('--abbrev-ref')) return { stdout: 'main' }
        if (args.includes('diff-tree')) return { stdout: 'src/a.ts' }
        return { stdout: repo.head }
      }
    })
    const h = harness({ ciAskMs: 5_000, now: () => repo.t })
    // main answers as worldClient does: the answer, spread.
    const answerFromMain = async (a: Ask) => h.send({ kind: 'runs-result', id: a.id, ...((await main.ciRuns('/repo')) ?? { runs: null }) })
    await h.init()
    // The map of A is building; HEAD moves to B before main looks.
    const first = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), { head: A, dirty: false }] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(1))
    repo.head = B
    await answerFromMain(h.ciAsks()[0])
    await first
    expect(h.ci).toEqual([null])
    // Five minutes later, back on A: main's kept answer is B's, so it looks A up; the host kept nothing for A.
    repo.t += 5 * 60_000
    repo.head = A
    const back = h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), { head: A, dirty: false }] })
    await vi.waitFor(() => expect(h.ciAsks()).toHaveLength(2))
    await answerFromMain(h.ciAsks()[1])
    await back
    expect(h.ci[1]).toEqual([{ file: 'src/a.ts', passed: false, at: Date.parse('2026-11-02T10:00:00Z'), source: 'ci' }])
  })
})

describe('with the real compiler, the late CI answer lands on the map (WP4b #26)', () => {
  let dir = ''
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('drawn first as not yet checked, then verified when the passing CI run comes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'world-ci-late-'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1' + String.fromCharCode(10))
    await writeFile(join(dir, 'src', 'a.test.ts'), "import { a } from './a'" + String.fromCharCode(10))
    const out: WorldHostResponse[] = []
    const store = memStore()
    const ref: { host?: ReturnType<typeof createWorldHost> } = {}
    const post = (m: WorldHostResponse): void => {
      out.push(m)
      if (m.kind === 'runs' && m.source === 'transcript') queueMicrotask(() => void ref.host?.handle({ kind: 'runs-result', id: m.id, runs: [], files: [] }))
    }
    const host = (ref.host = createWorldHost(post, { createStore: () => store, runsTimeoutMs: 60_000, ciAskMs: 20 }))
    await host.handle({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
    const s: GraphSnapshot = { root: dir, files: ['src/a.test.ts', 'src/a.ts'], symbols: [], callEdges: [], fileImports: { 'src/a.test.ts': ['./a'] } }
    await host.handle({ kind: 'call', id: 1, fn: 'compile', args: ['k1', s, HEAD] })
    const of = (d: WorldDoc | undefined) => d?.buildings.find((b) => b.members.includes('src/a.ts'))
    expect(of(store.saves[0])?.status).toBe('built')
    const ask = out.find((m): m is Ask => m.kind === 'runs' && m.source === 'ci') as Ask
    await host.handle({ kind: 'runs-result', id: ask.id, runs: [{ file: 'src/a.test.ts', passed: true, at: 5, source: 'ci' }], head: HEAD.head })
    await vi.waitFor(() => expect(store.saves).toHaveLength(2))
    expect(of(store.saves[1])?.status).toBe('verified')
    expect(of(store.saves[1])?.claims.some((c) => c.evidence.some((e) => JSON.stringify(e).includes('src/a.test.ts')))).toBe(true)
    // The same parts, where they were: only the status changed.
    expect(store.saves[1].buildings.map((b) => b.id)).toEqual(store.saves[0].buildings.map((b) => b.id))
    expect(store.saves[1].layout.positions).toEqual(store.saves[0].layout.positions)
  })
})

// The one limit on labelling calls for the whole computer (caveat 4): at most WORLD_LLM_HOST_LIMIT model calls
// across every world, the rest waiting in order, each still able to leave, and timed only once it runs.
import { describe, expect, it } from 'vitest'
import { createLlmGate, GATE_SETTLE_GRACE_MS, WORLD_LLM_HOST_LIMIT, type GateTimers } from '../../src/main/world/llmGate'

/** Timers on a hand-driven clock: `advance(ms)` fires every timer due by then, in order. */
function fakeTime(): GateTimers & { advance(ms: number): void; now(): number; pending(): number } {
  let t = 0
  let seq = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      due.set(id, { at: t + ms, fn })
      return id
    },
    clearTimeout(h) {
      due.delete(h as number)
    },
    advance(ms) {
      const end = t + ms
      for (;;) {
        const first = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!first) break
        due.delete(first[0])
        t = first[1].at
        first[1].fn()
      }
      t = end
    },
    now: () => t,
    pending: () => due.size,
  }
}

/** A call the test settles by hand; `started` says whether the gate ever ran it (its CLI started). */
function deferred() {
  let resolve!: (v: string | null) => void
  let reject!: (e: unknown) => void
  const d = {
    started: false,
    signal: null as AbortSignal | null,
    resolve: (v: string | null) => resolve(v),
    reject: (e: unknown) => reject(e),
    call: (signal: AbortSignal): Promise<string | null> => {
      d.started = true
      d.signal = signal
      return new Promise<string | null>((res, rej) => {
        resolve = res
        reject = rej
      })
    },
  }
  return d
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('llmGate', () => {
  it('holds four calls for the whole computer', () => {
    expect(WORLD_LLM_HOST_LIMIT).toBe(4)
  })

  it('two projects asking 4 calls each never have more than 4 in flight, and every call is answered', async () => {
    const time = fakeTime()
    const gate = createLlmGate({ timers: time })
    let inFlight = 0
    let most = 0
    const answers: Array<Promise<string | null>> = []
    for (const project of ['a', 'b']) {
      for (let i = 0; i < 4; i++) {
        answers.push(
          gate.run(async () => {
            inFlight++
            most = Math.max(most, inFlight)
            expect(gate.inFlight()).toBeLessThanOrEqual(4)
            await new Promise<void>((r) => time.setTimeout(r, 1000 + i * 10))
            inFlight--
            return `${project}${i}`
          }, { timeoutMs: 120_000 })
        )
      }
    }
    expect(gate.inFlight()).toBe(4)
    expect(gate.queued()).toBe(4)
    for (let i = 0; i < 10; i++) {
      time.advance(500)
      await flush()
    }
    expect(await Promise.all(answers)).toEqual(['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3'])
    expect(most).toBe(4)
    expect(gate.inFlight()).toBe(0)
    expect(gate.queued()).toBe(0)
  })

  it('starts waiting calls in the order they asked', async () => {
    const gate = createLlmGate({ limit: 1, timers: fakeTime() })
    const order: string[] = []
    const first = deferred()
    const done = [gate.run(first.call, { timeoutMs: 1000 })]
    for (const name of ['b', 'c', 'd']) done.push(gate.run(async () => { order.push(name); return name }, { timeoutMs: 1000, onStart: () => order.push(`start ${name}`) }))
    expect(gate.queued()).toBe(3)
    first.resolve('a')
    expect(await Promise.all(done)).toEqual(['a', 'b', 'c', 'd'])
    expect(order).toEqual(['start b', 'b', 'start c', 'c', 'start d', 'd'])
  })

  it('a call cancelled while it waits leaves the line answered null, and its CLI never starts', async () => {
    const time = fakeTime()
    const gate = createLlmGate({ limit: 1, timers: time })
    const busy = deferred()
    const p1 = gate.run(busy.call, { timeoutMs: 1000 })
    const queued = deferred()
    const behind = deferred()
    const ctl = new AbortController()
    let started = false
    const p2 = gate.run(queued.call, { timeoutMs: 1000, signal: ctl.signal, onStart: () => { started = true } })
    const p3 = gate.run(behind.call, { timeoutMs: 1000 })
    expect(gate.queued()).toBe(2)
    ctl.abort()
    expect(await p2).toBeNull()
    expect(gate.queued()).toBe(1)
    busy.resolve('one')
    expect(await p1).toBe('one')
    await flush()
    // The cancelled call was skipped: the one behind it took the slot.
    expect(queued.started).toBe(false)
    expect(started).toBe(false)
    expect(behind.started).toBe(true)
    behind.resolve('three')
    expect(await p3).toBe('three')
    await flush()
    expect(gate.inFlight()).toBe(0)
  })

  it('a call whose signal is already aborted is answered null and never starts', async () => {
    const gate = createLlmGate({ timers: fakeTime() })
    const d = deferred()
    const ctl = new AbortController()
    ctl.abort()
    expect(await gate.run(d.call, { timeoutMs: 1000, signal: ctl.signal })).toBeNull()
    expect(d.started).toBe(false)
    expect(gate.inFlight()).toBe(0)
  })

  it('times only the call: one that waited longer than its limit still gets its whole limit once it runs', async () => {
    const time = fakeTime()
    const gate = createLlmGate({ limit: 1, timers: time })
    const busy = deferred()
    void gate.run(busy.call, { timeoutMs: 1_000_000 })
    const slow = deferred()
    let startedAt = -1
    const p = gate.run(slow.call, { timeoutMs: 120_000, onStart: () => { startedAt = time.now() } })
    let answered = false
    void p.then(() => { answered = true })
    // It waits 200 s, past its 120 s limit, and nothing times it out while it waits.
    time.advance(200_000)
    await flush()
    expect(answered).toBe(false)
    expect(slow.started).toBe(false)
    busy.resolve('done')
    await flush()
    expect(slow.started).toBe(true)
    expect(startedAt).toBe(200_000)
    // 119.999 s into the call: still running.
    time.advance(119_999)
    await flush()
    expect(answered).toBe(false)
    expect(slow.signal?.aborted).toBe(false)
    // At 120 s of call time it is answered null and its CLI is told to stop.
    time.advance(1)
    expect(await p).toBeNull()
    expect(time.now() - startedAt).toBe(120_000)
    expect(slow.signal?.aborted).toBe(true)
  })

  it('a timed-out call keeps its slot until its CLI settles, never more than the grace after', async () => {
    const time = fakeTime()
    const gate = createLlmGate({ limit: 1, timers: time })
    const stuck = deferred()
    const p1 = gate.run(stuck.call, { timeoutMs: 100 })
    const next = deferred()
    const p2 = gate.run(next.call, { timeoutMs: 100 })
    time.advance(100)
    expect(await p1).toBeNull()
    // The timed-out CLI is still being stopped: its slot is held.
    expect(gate.inFlight()).toBe(1)
    expect(next.started).toBe(false)
    time.advance(GATE_SETTLE_GRACE_MS - 1)
    await flush()
    expect(next.started).toBe(false)
    time.advance(1)
    await flush()
    expect(next.started).toBe(true)
    // The stuck call settling late frees nothing twice.
    stuck.resolve('late')
    await flush()
    expect(gate.inFlight()).toBe(1)
    next.resolve('two')
    expect(await p2).toBe('two')
    await flush()
    expect(gate.inFlight()).toBe(0)
    expect(time.pending()).toBe(0)
  })

  it('a timed-out call that settles inside the grace frees its slot then', async () => {
    const time = fakeTime()
    const gate = createLlmGate({ limit: 1, timers: time, graceMs: 5000 })
    const d = deferred()
    const ctl = new AbortController()
    const p = gate.run(d.call, { timeoutMs: 100, signal: ctl.signal })
    time.advance(100)
    expect(await p).toBeNull()
    expect(gate.inFlight()).toBe(1)
    // Cancelled after it timed out: no second grace starts.
    ctl.abort()
    expect(time.pending()).toBe(1)
    d.resolve('too late')
    await flush()
    expect(gate.inFlight()).toBe(0)
    expect(time.pending()).toBe(0)
  })

  it('a call cancelled while it runs is answered null at once and its CLI is told to stop', async () => {
    const time = fakeTime()
    const gate = createLlmGate({ timers: time })
    const d = deferred()
    const ctl = new AbortController()
    const p = gate.run(d.call, { timeoutMs: 120_000, signal: ctl.signal })
    ctl.abort()
    expect(await p).toBeNull()
    expect(d.signal?.aborted).toBe(true)
    d.reject(new Error('killed'))
    await flush()
    expect(gate.inFlight()).toBe(0)
    expect(time.pending()).toBe(0)
  })

  it('a rejected call frees its slot for the next', async () => {
    const gate = createLlmGate({ limit: 1, timers: fakeTime() })
    const bad = deferred()
    const p1 = gate.run(bad.call, { timeoutMs: 1000 })
    const p2 = gate.run(async () => 'next', { timeoutMs: 1000 })
    bad.reject(new Error('the CLI failed'))
    expect(await p1).toBeNull()
    expect(await p2).toBe('next')
    await flush()
    expect(gate.inFlight()).toBe(0)
  })

  it('a call that throws frees its slot for the next', async () => {
    const gate = createLlmGate({ limit: 1, timers: fakeTime() })
    const p1 = gate.run(() => { throw new Error('no CLI') }, { timeoutMs: 1000 })
    const p2 = gate.run(async () => 'next', { timeoutMs: 1000 })
    expect(await p1).toBeNull()
    expect(await p2).toBe('next')
    await flush()
    expect(gate.inFlight()).toBe(0)
  })

  it('a reply that is not text is null, and an onStart that throws does not stop the call', async () => {
    const gate = createLlmGate({ timers: fakeTime() })
    expect(await gate.run(async () => 42 as unknown as string, { timeoutMs: 1000 })).toBeNull()
    expect(await gate.run(async () => 'ok', { timeoutMs: 1000, onStart: () => { throw new Error('gone') } })).toBe('ok')
  })

  it('runs on real timers by default, and a limit below one is one', async () => {
    const gate = createLlmGate({ limit: 0 })
    const d = deferred()
    const p1 = gate.run(d.call, { timeoutMs: 60_000 })
    const p2 = gate.run(async () => 'b', { timeoutMs: 60_000 })
    expect(gate.inFlight()).toBe(1)
    expect(gate.queued()).toBe(1)
    d.resolve('a')
    expect(await Promise.all([p1, p2])).toEqual(['a', 'b'])
    expect(await gate.run(() => new Promise(() => undefined), { timeoutMs: 5, signal: AbortSignal.timeout(1) })).toBeNull()
  })
})

// src/shared/agentExit.ts: the one place that waits for an agent to be gone, shared by the model
// switch (renderer, lib/modelRelaunch.ts) and the account switch (main, accountSwitch.ts). The OS's
// word on whether only the shell is left in the terminal (shellAlone.ts) has the last say: Claude
// Code took 4 to 11 s to hand the terminal back on a machine with SessionEnd hooks, and anything
// typed into it meanwhile was lost without a sound.
import { describe, it, expect } from 'vitest'
import {
  BLIND_EXIT_WAIT_MS, EXIT_CEILING_MS, EXIT_POLL_MS, PROMPT_SETTLE_MS, aloneNow, waitForExit,
} from '../../src/shared/agentExit'
import type { ExitWatch } from '../../src/shared/agentExit'

type Answer = boolean | null | 'throw'

/** A scripted clock and OS: every sleep and question lands in one ordered log. */
function watch(answers: Answer[], over: Partial<ExitWatch> = {}) {
  const log: string[] = []
  let clock = 0
  let asked = 0
  const io: ExitWatch = {
    sleep: async (ms) => { clock += ms; log.push(`sleep:${ms}`) },
    now: () => clock,
    shellAlone: async () => {
      log.push('alone?')
      const a = answers[Math.min(asked++, answers.length - 1)]
      if (a === 'throw') throw new Error('the query blew up')
      return a
    },
    ...over,
  }
  return { io, log, clock: () => clock, asked: () => asked }
}

describe('the constants both switches wait with', () => {
  it('are the ones the model switch was proven live with', () => {
    expect(EXIT_POLL_MS).toBe(500)
    expect(EXIT_CEILING_MS).toBe(30_000)
    expect(BLIND_EXIT_WAIT_MS).toBe(12_000)
    expect(PROMPT_SETTLE_MS).toBe(600)
  })
})

describe('aloneNow', () => {
  it('is what the OS says: true once only the shell is left, false while the agent runs, null when it cannot tell', async () => {
    for (const a of [true, false, null] as const) expect(await aloneNow(watch([a]).io)).toBe(a)
  })

  it('reads a question that cannot be asked, or fails, as "cannot tell"', async () => {
    expect(await aloneNow({})).toBeNull()
    expect(await aloneNow(watch(['throw']).io)).toBeNull()
  })
})

describe('waitForExit', () => {
  it('asks only after each poll gap, and is done at the first "only the shell is left"', async () => {
    const w = watch([false, false, true])
    expect(await waitForExit(w.io, false)).toBe(true)
    expect(w.log).toEqual([`sleep:${EXIT_POLL_MS}`, 'alone?', `sleep:${EXIT_POLL_MS}`, 'alone?', `sleep:${EXIT_POLL_MS}`, 'alone?'])
  })

  it('gives up at the ceiling when the agent never goes: false, so nothing is typed', async () => {
    const w = watch([false])
    expect(await waitForExit(w.io, false)).toBe(false)
    expect(w.clock()).toBeGreaterThanOrEqual(EXIT_CEILING_MS)
    expect(w.clock()).toBeLessThan(EXIT_CEILING_MS + 2 * EXIT_POLL_MS)
  })

  it('waits blind, once, when the OS cannot tell from the first question: too long only delays', async () => {
    const w = watch([null])
    expect(await waitForExit(w.io, false)).toBe(true)
    expect(w.log).toEqual([`sleep:${EXIT_POLL_MS}`, 'alone?', `sleep:${BLIND_EXIT_WAIT_MS}`])
  })

  it('does not go blind after the OS has said "still running": a later null is a hiccup to ask again about', async () => {
    const w = watch([false, null, null, true])
    expect(await waitForExit(w.io, false)).toBe(true)
    expect(w.asked()).toBe(4)
    expect(w.log).not.toContain(`sleep:${BLIND_EXIT_WAIT_MS}`)
    // ...and the same for a caller that already knew the OS can tell.
    const known = watch([null, true])
    expect(await waitForExit(known.io, true)).toBe(true)
    expect(known.log).not.toContain(`sleep:${BLIND_EXIT_WAIT_MS}`)
  })

  it('keeps asking through a hiccup until the ceiling, then reports the agent still running', async () => {
    const w = watch([false, null])
    expect(await waitForExit(w.io, false)).toBe(false)
  })

  it('takes a failing question as a hiccup too', async () => {
    const w = watch([false, 'throw', true])
    expect(await waitForExit(w.io, false)).toBe(true)
  })

  it('lets the caller choose the blind wait: none at all where the screen already showed the exit', async () => {
    const w = watch([null])
    expect(await waitForExit(w.io, false, 0)).toBe(true)
    expect(w.log).toEqual([`sleep:${EXIT_POLL_MS}`, 'alone?'])
  })

  it('uses Date.now when no clock is given', async () => {
    const asked: string[] = []
    const io: ExitWatch = { sleep: async () => undefined, shellAlone: async () => { asked.push('q'); return true } }
    expect(await waitForExit(io, false)).toBe(true)
    expect(asked).toEqual(['q'])
  })
})

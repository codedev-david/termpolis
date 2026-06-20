import { describe, it, expect } from 'vitest'
import { createInputLatencyProbe, type InputLatencySample } from '../../src/renderer/src/lib/inputLatencyProbe'

// Built from char codes so the source stays plain ASCII (no raw control bytes).
const ENTER = String.fromCharCode(13) // '\r'
const CTRL_C = String.fromCharCode(3)
const ARROW_UP = String.fromCharCode(27) + '[A' // ESC [ A

// Deterministic harness: a manual clock + a frame queue we drain on demand, so we
// can assert both legs (echoMs from the shell round trip, paintMs to the frame).
function harness() {
  let clock = 0
  const frameCbs: (() => void)[] = []
  const samples: InputLatencySample[] = []
  const probe = createInputLatencyProbe({
    now: () => clock,
    scheduleFrame: (cb) => frameCbs.push(cb),
    report: (s) => samples.push(s),
  })
  return {
    probe,
    samples,
    setClock: (t: number) => { clock = t },
    runFrame: () => { const cbs = [...frameCbs]; frameCbs.length = 0; cbs.forEach((c) => c()) },
  }
}

describe('createInputLatencyProbe', () => {
  it('measures echoMs (keystroke→echo) and paintMs (echo→frame)', () => {
    const h = harness()
    h.probe.markOpen()
    h.setClock(5)
    h.probe.onKeystroke('a')
    h.setClock(35)
    h.probe.onOutput(12) // echo arrives 30ms after the keystroke
    h.setClock(50)
    h.runFrame() // frame paints 15ms after the echo arrived
    expect(h.samples).toHaveLength(1)
    expect(h.samples[0]).toMatchObject({ echoMs: 30, paintMs: 15, echoBytes: 12, firstEcho: true, sinceOpenMs: 35 })
  })

  it('only times single echoable characters, not Enter / control / escape sequences', () => {
    const h = harness()
    h.probe.markOpen()
    for (const k of [ENTER, CTRL_C, ARROW_UP, 'ab']) {
      // Enter, Ctrl+C, an arrow escape sequence, and a 2-char chunk: none arm the timer.
      h.probe.onKeystroke(k)
      h.probe.onOutput(4)
      h.runFrame()
    }
    expect(h.samples).toHaveLength(0)
    // A real character still works afterwards.
    h.probe.onKeystroke('x')
    h.probe.onOutput(2)
    h.runFrame()
    expect(h.samples).toHaveLength(1)
  })

  it('marks only the first echo as firstEcho', () => {
    const h = harness()
    h.probe.markOpen()
    h.setClock(5); h.probe.onKeystroke('a'); h.setClock(10); h.probe.onOutput(1); h.runFrame()
    h.setClock(20); h.probe.onKeystroke('b'); h.setClock(25); h.probe.onOutput(1); h.runFrame()
    expect(h.samples.map((s) => s.firstEcho)).toEqual([true, false])
  })

  it('does not restart the clock for a second keystroke before the echo lands', () => {
    const h = harness()
    h.probe.markOpen()
    h.setClock(5); h.probe.onKeystroke('a') // armed at 5
    h.setClock(8); h.probe.onKeystroke('b') // ignored — still pending
    h.setClock(20); h.probe.onOutput(3); h.runFrame()
    expect(h.samples[0].echoMs).toBe(15) // measured from 5, not 8
  })

  it('ignores output when no keystroke is pending', () => {
    const h = harness()
    h.probe.markOpen()
    h.setClock(10); h.probe.onOutput(5); h.runFrame()
    expect(h.samples).toHaveLength(0)
  })

  it('markOpen resets the first-echo flag for a reused probe', () => {
    const h = harness()
    h.probe.markOpen()
    h.probe.onKeystroke('a'); h.probe.onOutput(1); h.runFrame()
    h.probe.markOpen() // terminal reopened
    h.probe.onKeystroke('b'); h.probe.onOutput(1); h.runFrame()
    expect(h.samples.map((s) => s.firstEcho)).toEqual([true, true])
  })

  it('runs with all default deps (performance.now + rAF/fallback + no-op report) without throwing', () => {
    const probe = createInputLatencyProbe() // every dependency defaulted
    probe.markOpen()
    probe.onKeystroke('a')
    expect(() => probe.onOutput(2)).not.toThrow()
  })
})

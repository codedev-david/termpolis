import { describe, it, expect, vi } from 'vitest'
import { mapOutsideReminders, eachOutsideReminder } from '../../src/main/headroomProxy/reminders'
const { rewriteMessagesBody } = await import('../../src/main/headroomProxy/wireCompress')

const upper = (s: string) => ({ text: s.toUpperCase(), changed: s.toUpperCase() !== s })

describe('mapOutsideReminders', () => {
  it('hands text with no reminder to the transform whole', () => {
    const seen: string[] = []
    const r = mapOutsideReminders('plain output', (s) => { seen.push(s); return upper(s) })
    expect(seen).toEqual(['plain output'])
    expect(r).toEqual({ text: 'PLAIN OUTPUT', changed: true })
  })

  it('transforms only the text between reminders and keeps each reminder in place', () => {
    const t = 'head <system-reminder>keep me</system-reminder> mid <system-reminder>and me</system-reminder> tail'
    expect(mapOutsideReminders(t, upper).text)
      .toBe('HEAD <system-reminder>keep me</system-reminder> MID <system-reminder>and me</system-reminder> TAIL')
  })

  it('reports unchanged when no segment changed', () => {
    const t = 'A<system-reminder>x</system-reminder>B'
    expect(mapOutsideReminders(t, upper)).toEqual({ text: t, changed: false })
  })

  it('handles a reminder at the very start or end with no empty-segment calls', () => {
    const seen: string[] = []
    const t = '<system-reminder>a</system-reminder>mid<system-reminder>b</system-reminder>'
    mapOutsideReminders(t, (s) => { seen.push(s); return { text: s, changed: false } })
    expect(seen).toEqual(['mid'])
  })

  it('protects everything after an opening tag that never closes', () => {
    const t = 'out <system-reminder>never closed, still an instruction'
    expect(mapOutsideReminders(t, upper).text).toBe('OUT <system-reminder>never closed, still an instruction')
  })
})

describe('live compressor keeps harness reminders out of the window', () => {
  const REMINDER = '<system-reminder>\nWhen you commit, end the message with the attribution line.\nNever skip hooks.\n</system-reminder>'
  const big = Array.from({ length: 200 }, (_, i) => `line ${i}: ${'detail '.repeat(8)}`).join('\n')

  it('compacts the output and leaves the reminder byte-identical', () => {
    const body = JSON.stringify({
      model: 'claude-x',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'build' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `${big}\n${REMINDER}` }] },
      ],
    })
    const r = rewriteMessagesBody(body)
    const tr = JSON.parse(r.body).messages[1].content[0].content as string
    expect(r.changed).toBe(true)
    expect(tr.length).toBeLessThan(big.length)
    expect(tr).toContain(REMINDER)
  })

  it('leaves a short result with a long reminder completely untouched', () => {
    const long = `<system-reminder>\n${'Follow this instruction exactly. '.repeat(60)}\n</system-reminder>`
    const content = `exit 0\n${long}`
    const body = JSON.stringify({
      model: 'claude-x',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
      ],
    })
    const tr = JSON.parse(rewriteMessagesBody(body).body).messages[1].content[0].content
    expect(tr).toBe(content)
  })
})

/**
 * The stub-kind tally only reads. Giving it the splitter that rebuilds every string it is handed cost
 * a body of reminder-dense results about a tenth more than v1.54.4 took to rewrite, for text the tally
 * threw away. eachOutsideReminder visits the same stretches without building anything, and has to agree
 * with mapOutsideReminders about which they are: a disagreement would count text the compressor never saw.
 */
describe('eachOutsideReminder', () => {
  const seen = (text: string): string[] => { const out: string[] = []; eachOutsideReminder(text, (g) => { out.push(g) }); return out }
  const mapped = (text: string): string[] => { const out: string[] = []; mapOutsideReminders(text, (g) => { out.push(g); return { text: g, changed: false } }); return out }

  it('hands text with no reminder to the visitor whole, and nothing for an empty text', () => {
    expect(seen('plain output')).toEqual(['plain output'])
    expect(seen('')).toEqual([''])
    expect(mapped('')).toEqual([''])
  })

  it('visits only the stretches between reminders, none for a reminder at either end or two side by side', () => {
    expect(seen('head <system-reminder>a</system-reminder> mid <system-reminder>b</system-reminder> tail')).toEqual(['head ', ' mid ', ' tail'])
    expect(seen('<system-reminder>a</system-reminder>mid<system-reminder>b</system-reminder>')).toEqual(['mid'])
    expect(seen('x<system-reminder>a</system-reminder><system-reminder>b</system-reminder>y')).toEqual(['x', 'y'])
  })

  it('treats an opening tag with no closing tag as protecting everything after it', () => {
    expect(seen('keep <system-reminder>never closed, and more text')).toEqual(['keep '])
    expect(seen('<system-reminder>never closed')).toEqual([])
  })

  it('agrees with mapOutsideReminders, stretch for stretch, on 2,000 random texts', () => {
    let a = 0x5eed
    const next = (): number => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
    const pieces = ['<system-reminder>', '</system-reminder>', 'text ', '\n', '<system-', 'reminder>', ' ', 'x'.repeat(30), '<system-reminder>a</system-reminder>', '</system-reminder></system-reminder>', '<system-reminder><system-reminder>']
    for (let n = 0; n < 2000; n++) {
      let t = ''
      const k = Math.floor(next() * 14)
      for (let i = 0; i < k; i++) t += pieces[Math.floor(next() * pieces.length)]
      expect(seen(t), JSON.stringify(t)).toEqual(mapped(t))
    }
  })

  // The visitor exists so that a caller that only READS pays nothing for rebuilding. The rebuilding splitter finds the
  // reminders with a regular expression (matchAll: a match object, holding the whole reminder, for each) and builds the
  // output by concatenation; the visitor uses indexOf and slices only the stretches it hands over. That difference is held
  // here as a COUNT, which cannot flake: no regular expression is run by the visitor and one is by the rebuilder. A visitor
  // that delegated to the rebuilder (as one the reviewers planted did, and which a timing bound could not tell apart from
  // the real one without failing the real one now and then: the visitor ran at 0.46 to 0.69 of the rebuilder, the planted
  // one at 0.74 to 1.07, on a busy machine) is found by this at once.
  it('does not build the text back: it matches no pattern (no regular expression, split or replace) and makes no match object, which is what the rebuilding splitter does', () => {
    const text = Array.from({ length: 300 }, (_, i) => `result line ${i} <system-reminder>keep this block of instructions ${i}</system-reminder>`).join('\n')
    const regexpMethods = ['matchAll', 'match', 'replace', 'replaceAll', 'split', 'search'] as const
    /** The calls to the regular-expression methods while `fn` runs. The window is only the call: nothing of the test's own runs inside it. */
    const counted = (fn: () => void): { string: number; exec: number; test: number } => {
      const spies = regexpMethods.map((name) => vi.spyOn(String.prototype, name))
      const exec = vi.spyOn(RegExp.prototype, 'exec')
      const test = vi.spyOn(RegExp.prototype, 'test')
      try {
        fn()
        return { string: spies.reduce((n, s) => n + s.mock.calls.length, 0), exec: exec.mock.calls.length, test: test.mock.calls.length }
      } finally {
        for (const s of spies) s.mockRestore()
        exec.mockRestore(); test.mockRestore()
      }
    }
    const visited: string[] = []
    const visitor = counted(() => { eachOutsideReminder(text, (segment) => { visited.push(segment) }) })
    expect(visitor).toEqual({ string: 0, exec: 0, test: 0 })
    expect(visited).toHaveLength(300) // it did its work: a count of zero is not a count of nothing done
    // The rebuilder is the counterpart: the same counter sees it, so a zero above is a zero and not a blind spy.
    const rebuilt = counted(() => { mapOutsideReminders(text, (g) => ({ text: g, changed: false })) })
    expect(rebuilt.string).toBeGreaterThan(0)
    // And a visitor that delegates to it is not a visitor: this is what it would count.
    const delegating = counted(() => { mapOutsideReminders(text, (g) => { visited.push(g); return { text: g, changed: false } }) })
    expect(delegating.string).toBeGreaterThan(0)
  })

  // The other half of "builds nothing": the only copy it makes is of the stretches it hands over. One slice for each stretch it
  // visits, and what is sliced is exactly what is handed over, so nothing of a reminder (and nothing extra) is ever copied. The
  // counter is a wrapper of our own on String.prototype.slice, put back at once: a spy library has its own use of strings, and
  // this is a count that has to be exact. A visitor that cut an extra piece to build an output from (as a planted one did,
  // a timing bound could not see) is found by it.
  it('copies only what it hands over: one slice for each stretch it visits, of exactly that stretch', () => {
    const text = 'head <system-reminder>keep</system-reminder> middle ' + Array.from({ length: 49 }, (_, i) => `piece ${i} <system-reminder>instructions ${i}</system-reminder> and text ${i}`).join(' ') + ' tail'
    const real = String.prototype.slice
    let calls = 0
    let chars = 0
    const handed: string[] = []
    String.prototype.slice = function (this: string, ...args: [number?, number?]): string {
      const out = real.apply(this, args)
      calls++
      chars += out.length
      return out
    }
    try {
      eachOutsideReminder(text, (segment) => { handed.push(segment) })
    } finally {
      String.prototype.slice = real
    }
    expect(handed.length).toBe(51) // head, the 49 between, and the tail: it did its work
    expect(calls).toBe(handed.length)
    expect(chars).toBe(handed.reduce((n, h) => n + h.length, 0))
    // The counter counts: the rebuilding splitter copies the same stretches and the reminders too.
    String.prototype.slice = function (this: string, ...args: [number?, number?]): string { calls++; return real.apply(this, args) }
    const before = calls
    try { mapOutsideReminders(text, (g) => ({ text: g, changed: false })) } finally { String.prototype.slice = real }
    expect(calls - before).toBeGreaterThanOrEqual(handed.length)
  })

  // The time it takes is held coarsely: no slower than the rebuilder it replaces. Relative, in one process, best of several
  // alternating rounds, met by any of three measurements (a slow moment of the machine is not a failure). It cannot tell a
  // visitor that rebuilds from one that does not (the count above does that); it holds a visitor that has become slower
  // than the thing it was written to be cheaper than.
  it('is no slower than the rebuilding splitter it replaces, on a text dense in reminders', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `result line ${i} <system-reminder>keep this block of instructions ${i}</system-reminder>`).join('\n')
    const visitor = (): void => { eachOutsideReminder(text, () => undefined) }
    const rebuild = (): void => { mapOutsideReminders(text, (g) => ({ text: g, changed: false })) }
    const time = (fn: () => void): number => { const t0 = process.hrtime.bigint(); for (let i = 0; i < 20; i++) fn(); return Number(process.hrtime.bigint() - t0) }
    visitor(); rebuild()
    let ratio = Infinity
    let seen = ''
    for (let attempt = 0; attempt < 3 && ratio > 1; attempt++) {
      let v = Infinity, r = Infinity
      for (let round = 0; round < 9; round++) { v = Math.min(v, time(visitor)); r = Math.min(r, time(rebuild)) }
      ratio = Math.min(ratio, v / r)
      seen += ` ${(v / r).toFixed(2)}`
    }
    // Measured 0.46 to 0.69 here on a busy machine (about 0.5 on a quiet one).
    expect(ratio, `visitor over rebuild, by attempt:${seen}`).toBeLessThanOrEqual(1)
  })
})

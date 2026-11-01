import { describe, it, expect } from 'vitest'
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

  it('does not build the text back: its work is the visits and nothing else', () => {
    // Relative, in one process, best of several alternating rounds, with a bound a factor away from the
    // measured ratio: a reminder-dense text costs the rebuilding splitter about twice what the visitor does.
    const text = Array.from({ length: 3000 }, (_, i) => `result line ${i} <system-reminder>keep this block of instructions ${i}</system-reminder>`).join('\n')
    const visitor = (): void => { eachOutsideReminder(text, () => undefined) }
    const rebuild = (): void => { mapOutsideReminders(text, (g) => ({ text: g, changed: false })) }
    const time = (fn: () => void): number => { const t0 = process.hrtime.bigint(); for (let i = 0; i < 20; i++) fn(); return Number(process.hrtime.bigint() - t0) }
    visitor(); rebuild()
    let v = Infinity, r = Infinity
    for (let round = 0; round < 9; round++) { v = Math.min(v, time(visitor)); r = Math.min(r, time(rebuild)) }
    expect(v).toBeLessThanOrEqual(r * 1.25)
  })
})

import { describe, it, expect } from 'vitest'
import { mapOutsideReminders } from '../../src/main/headroomProxy/reminders'
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

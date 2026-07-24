import { describe, it, expect } from 'vitest'
import { parseCron, cronMatches, dueSince, MAX_CATCHUP_MS } from '../../src/main/workflow/cron'

// All dates are constructed with the local-time Date constructor, and the cron
// matcher reads local-time getters, so these assertions hold in any timezone.
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0)
const ms = (y: number, mo: number, d: number, h: number, mi: number) => at(y, mo, d, h, mi).getTime()
const parse = (e: string) => {
  const f = parseCron(e)
  if (!f) throw new Error(`expected ${e} to parse`)
  return f
}

describe('parseCron', () => {
  it('accepts all-wildcards and matches every minute', () => {
    const f = parse('* * * * *')
    expect(cronMatches(f, at(2026, 7, 24, 0, 0))).toBe(true)
    expect(cronMatches(f, at(2026, 12, 31, 23, 59))).toBe(true)
  })

  it('matches an exact minute and hour only', () => {
    const f = parse('30 2 * * *')
    expect(cronMatches(f, at(2026, 7, 24, 2, 30))).toBe(true)
    expect(cronMatches(f, at(2026, 7, 24, 2, 31))).toBe(false)
    expect(cronMatches(f, at(2026, 7, 24, 3, 30))).toBe(false)
  })

  it('ignores seconds and milliseconds (cron granularity is a minute)', () => {
    const f = parse('30 2 * * *')
    expect(cronMatches(f, new Date(2026, 6, 24, 2, 30, 59, 999))).toBe(true)
  })

  it('expands */n steps', () => {
    const f = parse('*/15 * * * *')
    for (const m of [0, 15, 30, 45]) expect(cronMatches(f, at(2026, 7, 24, 1, m))).toBe(true)
    for (const m of [1, 14, 16, 59]) expect(cronMatches(f, at(2026, 7, 24, 1, m))).toBe(false)
  })

  it('expands ranges and comma lists', () => {
    const f = parse('0 9-11 * * *')
    expect(cronMatches(f, at(2026, 7, 24, 9, 0))).toBe(true)
    expect(cronMatches(f, at(2026, 7, 24, 11, 0))).toBe(true)
    expect(cronMatches(f, at(2026, 7, 24, 12, 0))).toBe(false)

    const g = parse('0,30 * * * *')
    expect(cronMatches(g, at(2026, 7, 24, 5, 0))).toBe(true)
    expect(cronMatches(g, at(2026, 7, 24, 5, 30))).toBe(true)
    expect(cronMatches(g, at(2026, 7, 24, 5, 15))).toBe(false)
  })

  it('supports a stepped range (a-b/n)', () => {
    const f = parse('0-30/10 * * * *')
    for (const m of [0, 10, 20, 30]) expect(cronMatches(f, at(2026, 7, 24, 1, m))).toBe(true)
    for (const m of [5, 40, 50]) expect(cronMatches(f, at(2026, 7, 24, 1, m))).toBe(false)
  })

  it('treats a bare number with a step as "from n to end of range"', () => {
    const f = parse('5/15 * * * *')
    for (const m of [5, 20, 35, 50]) expect(cronMatches(f, at(2026, 7, 24, 1, m))).toBe(true)
    expect(cronMatches(f, at(2026, 7, 24, 1, 0))).toBe(false)
  })

  it('accepts 7 as a second spelling of Sunday', () => {
    const f = parse('0 0 * * 7')
    // 2026-07-26 is a Sunday.
    expect(cronMatches(f, at(2026, 7, 26, 0, 0))).toBe(true)
    expect(cronMatches(f, at(2026, 7, 27, 0, 0))).toBe(false)
  })

  it('matches weekday ranges', () => {
    const f = parse('0 9 * * 1-5')
    expect(cronMatches(f, at(2026, 7, 24, 9, 0))).toBe(true) // Friday
    expect(cronMatches(f, at(2026, 7, 25, 9, 0))).toBe(false) // Saturday
    expect(cronMatches(f, at(2026, 7, 26, 9, 0))).toBe(false) // Sunday
  })

  it('restricts by month', () => {
    const f = parse('0 0 1 1 *')
    expect(cronMatches(f, at(2026, 1, 1, 0, 0))).toBe(true)
    expect(cronMatches(f, at(2026, 2, 1, 0, 0))).toBe(false)
  })

  it('ORs day-of-month against day-of-week when BOTH are restricted (Vixie rule)', () => {
    // "1st of the month, or any Monday."
    const f = parse('0 0 1 * 1')
    expect(cronMatches(f, at(2026, 7, 1, 0, 0))).toBe(true) // the 1st (a Wednesday)
    expect(cronMatches(f, at(2026, 7, 27, 0, 0))).toBe(true) // a Monday, not the 1st
    expect(cronMatches(f, at(2026, 7, 28, 0, 0))).toBe(false) // neither
  })

  it('ANDs normally when only one day field is restricted', () => {
    const dom = parse('0 0 15 * *')
    expect(cronMatches(dom, at(2026, 7, 15, 0, 0))).toBe(true)
    expect(cronMatches(dom, at(2026, 7, 16, 0, 0))).toBe(false)
    const dow = parse('0 0 * * 1')
    expect(cronMatches(dow, at(2026, 7, 27, 0, 0))).toBe(true)
    expect(cronMatches(dow, at(2026, 7, 28, 0, 0))).toBe(false)
  })

  it.each([
    ['@hourly', at(2026, 7, 24, 13, 0), at(2026, 7, 24, 13, 1)],
    ['@daily', at(2026, 7, 24, 0, 0), at(2026, 7, 24, 1, 0)],
    ['@midnight', at(2026, 7, 24, 0, 0), at(2026, 7, 24, 0, 1)],
    ['@weekly', at(2026, 7, 26, 0, 0), at(2026, 7, 27, 0, 0)],
    ['@monthly', at(2026, 7, 1, 0, 0), at(2026, 7, 2, 0, 0)],
    ['@yearly', at(2026, 1, 1, 0, 0), at(2026, 2, 1, 0, 0)],
    ['@annually', at(2026, 1, 1, 0, 0), at(2026, 2, 1, 0, 0)],
  ])('supports the %s alias', (expr, hit, miss) => {
    const f = parse(expr)
    expect(cronMatches(f, hit)).toBe(true)
    expect(cronMatches(f, miss)).toBe(false)
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseCron('  @DAILY  ')).not.toBeNull()
    expect(parseCron('  0   9  *  *  *  ')).not.toBeNull()
  })

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['* * * *', 'four fields'],
    ['* * * * * *', 'six fields'],
    ['@nope', 'unknown alias'],
    ['60 * * * *', 'minute out of range'],
    ['* 24 * * *', 'hour out of range'],
    ['* * 0 * *', 'day-of-month below range'],
    ['* * 32 * *', 'day-of-month above range'],
    ['* * * 0 *', 'month below range'],
    ['* * * 13 *', 'month above range'],
    ['* * * * 8', 'weekday above range'],
    ['5-1 * * * *', 'reversed range'],
    ['abc * * * *', 'non-numeric'],
    ['*/0 * * * *', 'zero step'],
    ['*/x * * * *', 'non-numeric step'],
    ['1/2/3 * * * *', 'double step'],
    ['1,,2 * * * *', 'empty list element'],
    ['1- * * * *', 'dangling range'],
  ])('rejects %s (%s)', (expr) => {
    expect(parseCron(expr)).toBeNull()
  })

  it('rejects non-string input without throwing', () => {
    expect(parseCron(undefined as unknown as string)).toBeNull()
    expect(parseCron(null as unknown as string)).toBeNull()
    expect(parseCron(42 as unknown as string)).toBeNull()
  })
})

describe('dueSince', () => {
  const daily2am = parse('0 2 * * *')

  it('is true when an occurrence falls inside the window', () => {
    expect(dueSince(daily2am, ms(2026, 7, 24, 1, 59), ms(2026, 7, 24, 2, 1))).toBe(true)
  })

  it('is false when no occurrence falls inside the window', () => {
    expect(dueSince(daily2am, ms(2026, 7, 24, 3, 0), ms(2026, 7, 24, 4, 0))).toBe(false)
  })

  it('does not re-fire an occurrence exactly at lastMs', () => {
    // Last fired precisely at 02:00; at 02:00:30 that same slot must not count.
    expect(dueSince(daily2am, ms(2026, 7, 24, 2, 0), ms(2026, 7, 24, 2, 0) + 30_000)).toBe(false)
  })

  it('catches up across an app-closed gap of days', () => {
    expect(dueSince(daily2am, ms(2026, 7, 20, 12, 0), ms(2026, 7, 24, 12, 0))).toBe(true)
  })

  it('respects a short lookback: a slot older than the window is not caught up', () => {
    // 2am was 10 hours ago, but we only look back 3 minutes.
    expect(dueSince(daily2am, ms(2026, 7, 24, 1, 0), ms(2026, 7, 24, 12, 0), 3 * 60_000)).toBe(false)
  })

  it('still fires inside a short lookback when the slot is recent', () => {
    expect(dueSince(daily2am, ms(2026, 7, 24, 1, 58), ms(2026, 7, 24, 2, 0), 3 * 60_000)).toBe(true)
  })

  it('is false when now is at or before last', () => {
    expect(dueSince(daily2am, ms(2026, 7, 24, 5, 0), ms(2026, 7, 24, 5, 0))).toBe(false)
    expect(dueSince(daily2am, ms(2026, 7, 24, 5, 0), ms(2026, 7, 24, 4, 0))).toBe(false)
  })

  it('is false (never throws) for non-finite inputs', () => {
    expect(dueSince(daily2am, NaN, ms(2026, 7, 24, 5, 0))).toBe(false)
    expect(dueSince(daily2am, 0, NaN)).toBe(false)
    expect(dueSince(daily2am, 0, Infinity)).toBe(false)
  })

  it('bounds the walk for an ancient lastFiredAt instead of hanging', () => {
    // Ten years of minutes would be ~5.2M iterations; MAX_CATCHUP_MS clamps it.
    const started = Date.now()
    expect(dueSince(daily2am, ms(2016, 1, 1, 0, 0), ms(2026, 7, 24, 12, 0))).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('every-minute cron is due after a single minute', () => {
    const every = parse('* * * * *')
    expect(dueSince(every, ms(2026, 7, 24, 5, 0), ms(2026, 7, 24, 5, 1))).toBe(true)
    expect(dueSince(every, ms(2026, 7, 24, 5, 0), ms(2026, 7, 24, 5, 0) + 30_000)).toBe(false)
  })

  it('MAX_CATCHUP_MS is two weeks', () => {
    expect(MAX_CATCHUP_MS).toBe(14 * 24 * 60 * 60 * 1000)
  })
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  limitKindOf, limitTargets, parseResetsAt, resetTextOf, stopKey, suggestedModel, untilText,
} from '../../src/shared/accountLimits'
import type { AccountRowView } from '../../src/shared/agentAccounts'

// The usage-limit chooser's pure half (§8.2, §8.3): when a limit lifts, what kind it is, and which
// accounts it offers. Reset times are in each CLI's own forms, read from their program files:
// Claude Code 2.1.309's formatter (sR: "3pm", "3:30pm", "Aug 1, 4pm", "Jan 3, 2027, 4pm", each with
// its zone in brackets in a limit message) and Codex 0.153.4's chrono formats ("3:04 PM",
// "Oct 24th, 2026 4:15 PM", local time).

const at = (iso: string): number => Date.parse(iso)

describe('stopKey', () => {
  it('drops when the limit lifts, so a countdown the CLI redraws is the same stop', () => {
    expect(stopKey('usage limit reached (resets 3pm (America/New_York))')).toBe('usage limit reached')
    expect(stopKey('usage limit reached (resets 2:59pm (America/New_York))')).toBe('usage limit reached')
    expect(stopKey('waiting on a menu: Codex offers to update itself')).toBe('waiting on a menu: Codex offers to update itself')
  })
})

describe('resetTextOf', () => {
  it('reads the reset the detector put in its summary', () => {
    expect(resetTextOf('usage limit reached (resets 3pm (America/New_York))')).toBe('3pm (America/New_York)')
    expect(resetTextOf('usage limit reached (resets Oct 24th, 2026 4:15 PM)')).toBe('Oct 24th, 2026 4:15 PM')
    expect(resetTextOf('usage limit reached')).toBeNull()
    expect(resetTextOf('waiting on a menu: Codex offers to update itself')).toBeNull()
  })
})

describe('parseResetsAt', () => {
  it("reads Claude Code's time of day in its zone, the next such time after it was seen", () => {
    // 2pm in New York (EDT, UTC-4) on Oct 23: 3pm is an hour on.
    expect(parseResetsAt('3pm (America/New_York)', at('2026-10-23T18:00:00Z'))).toBe(at('2026-10-23T19:00:00Z'))
    expect(parseResetsAt('3:30pm (America/New_York)', at('2026-10-23T18:00:00Z'))).toBe(at('2026-10-23T19:30:00Z'))
    expect(parseResetsAt('12am (UTC)', at('2026-10-23T18:00:00Z'))).toBe(at('2026-10-24T00:00:00Z'))
    expect(parseResetsAt('12pm (UTC)', at('2026-10-23T08:00:00Z'))).toBe(at('2026-10-23T12:00:00Z'))
  })

  it('rolls a time already past over to the next day', () => {
    // 11pm in New York; "resets 3am" is tomorrow's.
    expect(parseResetsAt('3am (America/New_York)', at('2026-10-24T03:00:00Z'))).toBe(at('2026-10-24T07:00:00Z'))
    // The very minute it was seen is past too.
    expect(parseResetsAt('7pm (UTC)', at('2026-10-23T19:00:00Z'))).toBe(at('2026-10-24T19:00:00Z'))
  })

  it('counts the day in the named zone, not in UTC', () => {
    // 9pm Oct 23 in New York is already Oct 24 in UTC: 10pm New York is the same evening.
    expect(parseResetsAt('10pm (America/New_York)', at('2026-10-24T01:00:00Z'))).toBe(at('2026-10-24T02:00:00Z'))
  })

  it('keeps the wall-clock time across a change of clocks', () => {
    // New York leaves daylight time at 2am on Nov 1 2026: 3pm that day is UTC-5.
    expect(parseResetsAt('3pm (America/New_York)', at('2026-10-31T23:00:00Z'))).toBe(at('2026-11-01T20:00:00Z'))
    // And enters it on Mar 8 2026: 3pm that day is UTC-4.
    expect(parseResetsAt('3pm (America/New_York)', at('2026-03-08T05:00:00Z'))).toBe(at('2026-03-08T19:00:00Z'))
    // A time right after the clocks go back: read at the UTC guess, the offset is still daylight
    // time's; only read again at the answer is it standard time's (3am EST is 08:00 UTC, not 07:00).
    expect(parseResetsAt('3am (America/New_York)', at('2026-11-01T01:00:00Z'))).toBe(at('2026-11-01T08:00:00Z'))
  })

  it("reads the weekly form: a date and a time, as David's transcripts show it (R15)", () => {
    expect(parseResetsAt('Aug 1, 4pm (America/New_York)', at('2026-07-28T12:00:00Z'))).toBe(at('2026-08-01T20:00:00Z'))
    expect(parseResetsAt('Oct 24, 4pm (America/New_York)', at('2026-10-19T12:00:00Z'))).toBe(at('2026-10-24T20:00:00Z'))
    expect(parseResetsAt('Oct 24, 4:30pm (UTC)', at('2026-10-19T12:00:00Z'))).toBe(at('2026-10-24T16:30:00Z'))
  })

  it('reads a year where Claude Code names one, and rolls a date just past the new year over', () => {
    expect(parseResetsAt('Jan 3, 2027, 4pm (UTC)', at('2026-12-30T12:00:00Z'))).toBe(at('2027-01-03T16:00:00Z'))
    // A version that names no year: Jan 2 seen on Dec 30 is next year's.
    expect(parseResetsAt('Jan 2, 4pm (UTC)', at('2026-12-30T12:00:00Z'))).toBe(at('2027-01-02T16:00:00Z'))
  })

  it('leaves a date long past as it is: the limit lifted then', () => {
    // A screen read the day after, never a year away.
    expect(parseResetsAt('Oct 24, 4pm (UTC)', at('2026-10-25T12:00:00Z'))).toBe(at('2026-10-24T16:00:00Z'))
  })

  it("reads Codex's forms, in local time", () => {
    const seen = new Date(2026, 9, 23, 14, 0).getTime()
    expect(parseResetsAt('3:04 PM', seen)).toBe(new Date(2026, 9, 23, 15, 4).getTime())
    expect(parseResetsAt('1:00 PM', seen)).toBe(new Date(2026, 9, 24, 13, 0).getTime())
    expect(parseResetsAt('Oct 24th, 2026 4:15 PM', seen)).toBe(new Date(2026, 9, 24, 16, 15).getTime())
    expect(parseResetsAt('Nov 1st, 2026 9:00 AM', seen)).toBe(new Date(2026, 10, 1, 9, 0).getTime())
    expect(parseResetsAt('Nov 2nd, 2026 9:00 AM', seen)).toBe(new Date(2026, 10, 2, 9, 0).getTime())
    expect(parseResetsAt('Nov 3rd, 2026 9:00 AM', seen)).toBe(new Date(2026, 10, 3, 9, 0).getTime())
    // A date with no year, in local time.
    expect(parseResetsAt('Oct 30, 9am', seen)).toBe(new Date(2026, 9, 30, 9, 0).getTime())
  })

  it('gives null for anything it cannot read', () => {
    const seen = at('2026-10-23T18:00:00Z')
    for (const text of ['', 'in 4h 59m', 'soon', '13pm', '3:75pm', 'Foo 3, 4pm', 'Oct 40, 4pm', 'Oct 0, 4pm', '3pm (Not/AZone)', '0am']) {
      expect(parseResetsAt(text, seen), text).toBeNull()
    }
  })
})

describe('limitKindOf (R15)', () => {
  it("classifies Claude Code's messages as Claude Code itself does (RP: session, weekly, model)", () => {
    expect(limitKindOf("You've hit your session limit · resets 3pm (America/New_York)")).toEqual({ scope: 'account', window: 'session' })
    expect(limitKindOf("You've hit your weekly limit · resets Aug 1, 4pm (America/New_York)")).toEqual({ scope: 'account', window: 'weekly' })
    expect(limitKindOf('You’ve hit your weekly limit')).toEqual({ scope: 'account', window: 'weekly' })
    expect(limitKindOf("You've hit your Opus limit · resets Oct 24, 4pm (UTC)")).toEqual({ scope: 'model', window: 'weekly', model: 'Opus' })
    expect(limitKindOf("You've hit your Sonnet limit")).toEqual({ scope: 'model', window: 'weekly', model: 'Sonnet' })
    expect(limitKindOf("You've hit your Fable limit")).toEqual({ scope: 'model', window: 'weekly', model: 'Fable' })
    expect(limitKindOf("You've reached your Fable limit.")).toEqual({ scope: 'model', window: 'other', model: 'Fable' })
    expect(limitKindOf('Opus requires usage credits. /model to switch models.')).toEqual({ scope: 'model', window: 'other', model: 'Opus' })
    expect(limitKindOf("You've hit your org's monthly spend limit")).toEqual({ scope: 'account', window: 'monthly' })
    expect(limitKindOf("You've hit your org's monthly usage limit")).toEqual({ scope: 'account', window: 'monthly' })
    expect(limitKindOf("You're out of usage credits · resets 3pm (UTC)")).toEqual({ scope: 'account', window: 'other' })
  })

  it("classifies Codex's and agy's", () => {
    expect(limitKindOf("■ You've hit your usage limit. Upgrade to Plus to continue, or try again at 3:04 PM.")).toEqual({ scope: 'account', window: 'other' })
    expect(limitKindOf("■ You've hit your usage limit for gpt-5.6-sol. Switch to another model now, or try again at 4:15 PM.")).toEqual({ scope: 'model', window: 'other', model: 'gpt-5.6-sol' })
    expect(limitKindOf('✕ You have exhausted your quota on this model.')).toEqual({ scope: 'model', window: 'other' })
    expect(limitKindOf('Your AI credits balance is too low to continue.')).toEqual({ scope: 'account', window: 'other' })
    expect(limitKindOf('')).toEqual({ scope: 'account', window: 'other' })
  })
})

describe('suggestedModel', () => {
  it("offers Claude Code's own advice for a model it ran out of", () => {
    expect(suggestedModel('claude', { scope: 'model', model: 'Opus' })).toBe('sonnet')
    expect(suggestedModel('claude', { scope: 'model', model: 'Fable' })).toBe('opus')
    expect(suggestedModel('claude', { scope: 'model', model: 'Sonnet' })).toBe('opus')
    expect(suggestedModel('claude', { scope: 'model', model: 'Haiku' })).toBeNull()
    expect(suggestedModel('claude', { scope: 'model' })).toBeNull()
    expect(suggestedModel('claude', { scope: 'account', window: 'session' })).toBeNull()
    expect(suggestedModel('codex', { scope: 'model', model: 'gpt-5.6-sol' })).toBeNull()
  })
})

describe('untilText', () => {
  it('says when the limit lifts, in words', () => {
    const now = new Date(2026, 9, 23, 14, 0).getTime()
    // ICU puts a narrow no-break space before PM in some versions.
    expect(untilText(new Date(2026, 9, 23, 15, 0).getTime(), now, 'en-US')).toMatch(/^until 3:00\sPM$/)
    expect(untilText(new Date(2026, 9, 25, 16, 30).getTime(), now, 'en-US')).toMatch(/^until Sun 4:30\sPM$/)
    // Tomorrow, though within 24 hours, names its day.
    expect(untilText(new Date(2026, 9, 24, 9, 0).getTime(), now, 'en-US')).toMatch(/^until Sat 9:00\sAM$/)
    expect(untilText(new Date(2026, 9, 23, 15, 0).getTime(), now)).toMatch(/^until /)
    expect(untilText(null, now)).toBe('')
    expect(untilText(now - 1000, now)).toBe('')
  })
})

// ── Which accounts the chooser offers (§8.3) ─────────────────────────────────────────────

function row(id: string, over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id, agent: 'claude', label: id, profile: `/home/u/.claude-${id}`, folder: `/home/u/.claude-${id}`, isDefault: false,
    autoOffer: true, order: 0, connect: true, origin: 'created', folderExists: true, shares: ['projects'],
    lastEmail: `${id}@example.test`, connection: null, bypassReady: true, terminals: 0, recopyAvailable: false,
    ...over,
  }
}

describe('limitTargets', () => {
  const now = at('2026-10-23T18:00:00Z')
  const personal = row('personal', { order: 0, isDefault: true, profile: null })
  const codedev = row('codedev', { order: 1 })
  const work = row('work', { order: 2, autoOffer: false })
  const spare = row('spare', { order: 3 })

  it('offers the other accounts of the agent in failover order, from the one after the limited account round', () => {
    const t = limitTargets([personal, codedev, work, spare], 'claude', { accountId: 'codedev', email: 'codedev@example.test' }, now)
    expect(t.map((x) => [x.row.id, x.state])).toEqual([['spare', 'available'], ['personal', 'available'], ['codedev', 'this']])
  })

  it('never offers an account not offered automatically, and lists none of another agent (D14)', () => {
    const codex = row('cx', { agent: 'codex' })
    const t = limitTargets([personal, codedev, work, codex], 'claude', { accountId: 'personal', email: 'personal@example.test' }, now)
    expect(t.map((x) => x.row.id)).toEqual(['codedev', 'personal'])
  })

  it('says why an account is no way out: limited, its folder gone, the same sign-in (R23)', () => {
    const limited = row('a', { order: 1, limit: { seenAt: now, resetsAt: now + 3600_000, text: 'x', scope: 'account' } })
    const outside = row('b', { order: 2, limitedOutside: now - 60_000 })
    const gone = row('c', { order: 3, folderExists: false })
    // The default profile is signed in to codedev's address: "personal ran out" means codedev did.
    const same = row('d', { order: 4, lastEmail: 'codedev@example.test' })
    const t = limitTargets([personal, limited, outside, gone, same], 'claude', { accountId: 'personal', email: 'codedev@example.test' }, now)
    expect(t.map((x) => [x.row.id, x.state])).toEqual([
      ['a', 'limited'], ['b', 'limited'], ['c', 'folder-missing'], ['d', 'same-sign-in'], ['personal', 'this'],
    ])
    expect(t[0].text).toMatch(/^out of usage until /)
    expect(t[1].text).toBe('out of usage (seen by your failover hook)')
    // A weekly limit whose reset didn't read: out, with no time to name.
    const weekly = row('w', { order: 1, limit: { seenAt: now, resetsAt: null, text: 'x', scope: 'account', window: 'weekly' } })
    expect(limitTargets([personal, weekly], 'claude', { accountId: 'personal', email: null }, now)[0]).toMatchObject({ state: 'limited', text: 'out of usage' })
    expect(t[3].text).toBe('signed in to codedev@example.test, the same account')
  })

  it('reads a limit recorded under the same sign-in as that account being out too (R23)', () => {
    const elsewhere = row('x', { order: 1, lastEmail: 'shared@example.test' })
    const recorded = row('y', { order: 2, limit: { seenAt: now, resetsAt: now + 3600_000, text: 'x', scope: 'account', email: 'shared@example.test' } })
    const t = limitTargets([personal, elsewhere, recorded], 'claude', { accountId: 'personal', email: 'personal@example.test' }, now)
    expect(t.map((x) => [x.row.id, x.state])).toEqual([['x', 'limited'], ['y', 'limited'], ['personal', 'this']])
  })

  it('keeps an account whose limit is for one model only on offer (R15)', () => {
    const modelOnly = row('m', { order: 1, limit: { seenAt: now, resetsAt: now + 3600_000, text: "You've hit your Opus limit", scope: 'model' } })
    const t = limitTargets([personal, modelOnly], 'claude', { accountId: 'personal', email: 'personal@example.test' }, now)
    expect(t[0]).toMatchObject({ state: 'available', text: "available · You've hit your Opus limit" })
  })

  it('applies what a sign-in check said: signed out, signed in elsewhere, or as the limited account', () => {
    const a = row('a', { order: 1 })
    const b = row('b', { order: 2 })
    const c = row('c', { order: 3 })
    const d = row('d', { order: 4 })
    const t = limitTargets([personal, a, b, c, d], 'claude', { accountId: 'personal', email: 'personal@example.test' }, now, {
      a: { kind: 'signed-out' },
      b: { kind: 'signed-in', email: 'PERSONAL@example.test' },
      c: { kind: 'signed-in', email: 'c@example.test' },
      d: { kind: 'unknown', why: 'no answer' },
    })
    expect(t.map((x) => [x.row.id, x.state])).toEqual([['a', 'signed-out'], ['b', 'same-sign-in'], ['c', 'available'], ['d', 'unknown'], ['personal', 'this']])
    expect(t[2].text).toBe('signed in as c@example.test')
    expect(t[3].text).toBe("couldn't tell whether it is signed in: no answer")
  })

  it('treats a terminal on an account Termpolis does not know as limited on its sign-in only', () => {
    const t = limitTargets([personal, codedev], 'claude', { accountId: null, email: 'codedev@example.test' }, now)
    expect(t.map((x) => [x.row.id, x.state])).toEqual([['personal', 'available'], ['codedev', 'same-sign-in']])
  })

  it('lists agy accounts by label: nothing to sign in to or compare but the email given', () => {
    const g1 = row('g1', { agent: 'agy', profile: null, folder: null, folderExists: false, lastEmail: null, email: 'g1@example.test', order: 0 })
    const g2 = row('g2', { agent: 'agy', profile: null, folder: null, folderExists: false, lastEmail: null, email: 'g2@example.test', order: 1 })
    const g3 = row('g3', { agent: 'agy', profile: null, folder: null, folderExists: false, lastEmail: null, email: 'g1@example.test', order: 2 })
    const t = limitTargets([g1, g2, g3], 'agy', { accountId: 'g1', email: 'g1@example.test' }, now)
    expect(t.map((x) => [x.row.id, x.state])).toEqual([['g2', 'available'], ['g3', 'same-sign-in'], ['g1', 'this']])
    expect(t[0].text).toBe('g2@example.test')
    // One registered with no email: nothing to compare, and the row says so.
    const bare = row('g4', { agent: 'agy', profile: null, folder: null, folderExists: false, lastEmail: null, order: 3 })
    expect(limitTargets([g1, bare], 'agy', { accountId: 'g1', email: 'g1@example.test' }, now)[0]).toMatchObject({ state: 'available', text: 'no email given' })
  })

  it('reads a check that says signed in with no email by what the profile last named', () => {
    const a = row('a', { order: 1, lastEmail: 'personal@example.test' })
    const b = row('b', { order: 2, lastEmail: null })
    const t = limitTargets([personal, a, b], 'claude', { accountId: 'personal', email: 'personal@example.test' }, now, {
      a: { kind: 'signed-in', email: null },
      b: { kind: 'signed-in', email: null },
    })
    expect(t.map((x) => [x.row.id, x.state, x.text])).toEqual([
      ['a', 'same-sign-in', 'signed in to personal@example.test, the same account'],
      ['b', 'available', 'signed in'],
      ['personal', 'this', "this terminal's account"],
    ])
  })
})

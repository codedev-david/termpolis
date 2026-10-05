import { describe, it, expect } from 'vitest'
import {
  ACTIVITY_ROWS,
  LINKED_MACHINE_LIMIT,
  formatCountdown,
  formatDuration,
  latestActivity,
  pendingConfirmations,
  reconcileAnnouncements,
  relativeTime,
  secondsLeft,
  toggleGrant,
  withoutAnnouncement,
  type Announcements,
} from '../../src/renderer/src/lib/linkedMachines'
import { MAX_LINKED_MACHINES } from '../../src/main/remoteBridge/protocol'
import type { LinkedActivityView, LinkedMachineView } from '../../src/renderer/src/types'

const machine = (over: Partial<LinkedMachineView> = {}): LinkedMachineView => ({
  ref: 'link:aaaa',
  name: 'linux',
  online: true,
  confirmed: true,
  grants: { run: true, write: false },
  linkedAt: 1,
  ...over,
})

const row = (id: string, startedAt: number): LinkedActivityView => ({
  id,
  direction: 'out',
  machine: 'linux',
  agent: 'codex',
  summary: 'do the thing',
  status: 'done',
  startedAt,
})

describe('linked machines limits', () => {
  it('explains the same cap the bridge enforces', () => {
    // The pane only describes the limit; the bridge refuses the 17th pairing.
    // If these ever disagree the pane would warn about the wrong number.
    expect(LINKED_MACHINE_LIMIT).toBe(MAX_LINKED_MACHINES)
  })

  it('shows twenty activity rows, as the spec says', () => {
    expect(ACTIVITY_ROWS).toBe(20)
  })
})

describe('toggleGrant', () => {
  it('turns run on with write left off', () => {
    expect(toggleGrant({ run: false, write: false }, 'run')).toEqual({ run: true, write: false })
  })

  it('turns write on next to an existing run', () => {
    expect(toggleGrant({ run: true, write: false }, 'write')).toEqual({ run: true, write: true })
  })

  it('turns run on with write, because write implies run', () => {
    expect(toggleGrant({ run: false, write: false }, 'write')).toEqual({ run: true, write: true })
  })

  it('takes write away with run, so the pair never says write without run', () => {
    expect(toggleGrant({ run: true, write: true }, 'run')).toEqual({ run: false, write: false })
  })

  it('leaves run alone when only write is switched off', () => {
    expect(toggleGrant({ run: true, write: true }, 'write')).toEqual({ run: true, write: false })
  })
})

describe('countdown', () => {
  it('rounds a part second up, so the last second still reads 0:01', () => {
    expect(secondsLeft(10_500, 10_000)).toBe(1)
    expect(secondsLeft(70_000, 10_000)).toBe(60)
  })

  it('never counts below zero', () => {
    expect(secondsLeft(1_000, 5_000)).toBe(0)
  })

  it('formats minutes and padded seconds', () => {
    expect(formatCountdown(300)).toBe('5:00')
    expect(formatCountdown(65)).toBe('1:05')
    expect(formatCountdown(9)).toBe('0:09')
    expect(formatCountdown(0)).toBe('0:00')
  })
})

describe('relativeTime', () => {
  const now = 10_000_000_000

  it('words recent, minute, hour and day distances', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now')
    expect(relativeTime(now - 300_000, now)).toBe('5m ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4d ago')
  })

  it('treats a timestamp from the future as just now', () => {
    expect(relativeTime(now + 60_000, now)).toBe('just now')
  })
})

describe('formatDuration', () => {
  it('says under a second rather than 0s', () => {
    expect(formatDuration(400)).toBe('<1s')
  })

  it('counts seconds, then minutes, then hours', () => {
    expect(formatDuration(1_400)).toBe('1s')
    expect(formatDuration(59_400)).toBe('59s')
    expect(formatDuration(61_000)).toBe('1m 1s')
    expect(formatDuration(3_600_000)).toBe('1h 0m')
    expect(formatDuration(3_725_000)).toBe('1h 2m')
  })
})

describe('latestActivity', () => {
  it('keeps the newest twenty, newest first, whatever order main sent', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`j${i}`, i))
    const shuffled = [...rows.slice(10), ...rows.slice(0, 10)]
    const out = latestActivity(shuffled)
    expect(out).toHaveLength(20)
    expect(out[0].id).toBe('j24')
    expect(out[19].id).toBe('j5')
  })

  it('does not reorder the array it was given', () => {
    const rows = [row('old', 1), row('new', 2)]
    latestActivity(rows)
    expect(rows.map((r) => r.id)).toEqual(['old', 'new'])
  })
})

describe('reconcileAnnouncements', () => {
  const unseen = { phrase: 'p', suggestedName: 'linux', seen: false }
  const seen = { ...unseen, seen: true }

  it('hands back the same object when nothing changed', () => {
    const prev: Announcements = { 'link:aaaa': unseen }
    // Not listed yet: the status may simply be older than the event.
    expect(reconcileAnnouncements(prev, [])).toBe(prev)
    const listed: Announcements = { 'link:aaaa': seen }
    expect(reconcileAnnouncements(listed, [machine({ confirmed: false })])).toBe(listed)
  })

  it('marks an announcement seen once a status lists it unconfirmed', () => {
    const next = reconcileAnnouncements({ 'link:aaaa': unseen }, [machine({ confirmed: false })])
    expect(next['link:aaaa']).toEqual(seen)
  })

  it('drops an announcement once that link is confirmed', () => {
    expect(reconcileAnnouncements({ 'link:aaaa': unseen }, [machine({ confirmed: true })])).toEqual({})
  })

  it('drops an announcement that was listed and is now gone', () => {
    // The other computer cancelled: its record went away without a "linked" event.
    expect(reconcileAnnouncements({ 'link:aaaa': seen }, [])).toEqual({})
  })

  it('keeps the other announcements while dropping one', () => {
    const next = reconcileAnnouncements(
      { 'link:aaaa': seen, 'device:bbbb': unseen },
      [],
    )
    expect(next).toEqual({ 'device:bbbb': unseen })
  })
})

describe('withoutAnnouncement', () => {
  it('drops one ref and leaves the original untouched', () => {
    const a = { phrase: 'p', suggestedName: 'x', seen: false }
    const prev: Announcements = { 'link:aaaa': a, 'device:bbbb': a }
    expect(withoutAnnouncement(prev, 'link:aaaa')).toEqual({ 'device:bbbb': a })
    expect(Object.keys(prev)).toHaveLength(2)
  })
})

describe('pendingConfirmations', () => {
  it('asks to confirm every unconfirmed machine, using its own name and words', () => {
    const out = pendingConfirmations([machine({ confirmed: false, phrase: 'w1 w2', name: 'box' })], {})
    expect(out).toEqual([{ ref: 'link:aaaa', phrase: 'w1 w2', suggestedName: 'box' }])
  })

  it('prefers the suggested name an event carried', () => {
    const out = pendingConfirmations([machine({ confirmed: false, phrase: 'w1', name: 'box (2)' })], {
      'link:aaaa': { phrase: 'old', suggestedName: 'box', seen: true },
    })
    expect(out).toEqual([{ ref: 'link:aaaa', phrase: 'w1', suggestedName: 'box' }])
  })

  it('falls back to the event words when the machine carries none', () => {
    const out = pendingConfirmations([machine({ confirmed: false })], {
      'link:aaaa': { phrase: 'from event', suggestedName: 'box', seen: true },
    })
    expect(out[0].phrase).toBe('from event')
  })

  it('reports missing words as null rather than inventing any', () => {
    expect(pendingConfirmations([machine({ confirmed: false })], {})[0].phrase).toBeNull()
  })

  it('shows an announced link before any status lists it', () => {
    const out = pendingConfirmations([], {
      'device:bbbb': { phrase: 'w', suggestedName: 'laptop', seen: false },
    })
    expect(out).toEqual([{ ref: 'device:bbbb', phrase: 'w', suggestedName: 'laptop' }])
  })

  it('leaves confirmed machines alone even if an announcement lingers', () => {
    expect(
      pendingConfirmations([machine({ confirmed: true })], {
        'link:aaaa': { phrase: 'w', suggestedName: 'linux', seen: true },
      }),
    ).toEqual([])
  })
})

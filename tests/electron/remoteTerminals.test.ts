import { describe, it, expect } from 'vitest'

import { createRemoteTerminals, type ListedTerminal } from '../../src/main/remoteTerminals'

const phone = (id: string, name = `T ${id}`): ListedTerminal => ({ id, name, shellType: 'bash', cwd: '/repo' })

describe('createRemoteTerminals', () => {
  it('lists a terminal a phone opened before the session records it', () => {
    const held = createRemoteTerminals()
    held.add(phone('p1'))
    expect(held.merge([])).toEqual([phone('p1')])
  })

  it('puts the recorded terminals first, in their order, then the held ones', () => {
    const held = createRemoteTerminals()
    held.add(phone('p1'))
    held.add(phone('p2'))
    expect(held.merge([phone('a'), phone('b')]).map((t) => t.id)).toEqual(['a', 'b', 'p1', 'p2'])
  })

  it('answers with the recorded entry while the session has it', () => {
    const held = createRemoteTerminals()
    held.add(phone('p1', 'Claude · repo'))
    // Renamed on the desktop before the phone asked again: the session's name wins.
    expect(held.merge([phone('p1', 'Renamed')])).toEqual([phone('p1', 'Renamed')])
  })

  it('lets go of a terminal once a saved session records it', () => {
    const held = createRemoteTerminals()
    held.add(phone('p1'))
    held.add(phone('p2'))
    held.recorded(['p1', 'other'])
    // Closed on the desktop afterwards: gone from the session, and so from the list.
    expect(held.merge([])).toEqual([phone('p2')])
  })

  it('forgets a terminal that closed before the session recorded it', () => {
    const held = createRemoteTerminals()
    held.add(phone('p1'))
    held.add(phone('p2'))
    held.remove('p1')
    expect(held.merge([])).toEqual([phone('p2')])
  })

  it('ignores removing a terminal it never held', () => {
    const held = createRemoteTerminals()
    held.remove('nope')
    expect(held.merge([phone('a')])).toEqual([phone('a')])
  })

  it('keeps one entry per terminal when the same one is added twice', () => {
    const held = createRemoteTerminals()
    held.add(phone('p1', 'first'))
    held.add(phone('p1', 'second'))
    expect(held.merge([])).toEqual([phone('p1', 'second')])
  })

  it('does not change the list it was handed', () => {
    const held = createRemoteTerminals()
    held.add(phone('p1'))
    const recorded = [phone('a')]
    held.merge(recorded)
    expect(recorded).toEqual([phone('a')])
  })
})

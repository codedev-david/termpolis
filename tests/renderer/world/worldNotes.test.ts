import { describe, expect, it } from 'vitest'
import { cappedNotice, nextCappedNotice } from '../../../src/renderer/src/components/World/worldNotes'

describe('worldNotes: the capped-walk notice', () => {
  it('says how many files the world shows, with a thousands separator', () => {
    expect(cappedNotice(20000)).toBe('Showing the first 20,000 files in this folder.')
    expect(cappedNotice(7)).toBe('Showing the first 7 files in this folder.')
  })

  it('shows for a capped world, replaces only its own text when the world is not capped, and leaves other notices', () => {
    expect(nextCappedNotice(20000, null)).toBe('Showing the first 20,000 files in this folder.')
    expect(nextCappedNotice(20000, 'Re-layout failed: x')).toBe('Showing the first 20,000 files in this folder.')
    expect(nextCappedNotice(undefined, 'Showing the first 20,000 files in this folder.')).toBeNull()
    expect(nextCappedNotice(0, 'Showing the first 3 files in this folder.')).toBeNull()
    expect(nextCappedNotice(undefined, 'Re-layout failed: x')).toBe('Re-layout failed: x')
    expect(nextCappedNotice(undefined, null)).toBeNull()
  })
})

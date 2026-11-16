import { describe, expect, it } from 'vitest'
import { createKeyedLock } from '../../src/main/world/keyedLock'

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('createKeyedLock', () => {
  it('runs jobs on one key one at a time, in order; other keys run alongside', async () => {
    const lock = createKeyedLock()
    const log: string[] = []
    const job = (name: string, ms: number) => async (): Promise<string> => {
      log.push(`${name}+`)
      await tick(ms)
      log.push(`${name}-`)
      return name
    }
    const all = Promise.all([lock('k', job('a', 15)), lock('k', job('b', 1)), lock('other', job('c', 1))])
    expect(await all).toEqual(['a', 'b', 'c'])
    expect(log.indexOf('a-')).toBeLessThan(log.indexOf('b+'))
    expect(log.indexOf('c-')).toBeLessThan(log.indexOf('a-'))
  })

  it('a rejected job reaches only its caller and releases the lock', async () => {
    const lock = createKeyedLock()
    const failed = lock('k', async () => {
      await tick()
      throw new Error('boom')
    })
    const next = lock('k', async () => 'ran')
    await expect(failed).rejects.toThrow('boom')
    expect(await next).toBe('ran')
    // Idle again: a later job starts at once.
    expect(await lock('k', async () => 'again')).toBe('again')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import {
  DISABLE_FLAG,
  flushBeforeResize,
  onBeforeResize,
  resizeFlushDisabled,
} from '../../src/main/ptyResizeFlush'

// What a terminal does with the output it is holding when its pty changes size (plan P11). The ORDER is
// the whole point -- the terminal's own coalescer first, then every reader of the buffer it fills -- and
// so is the promise that nothing in here can stop the resize it runs ahead of. Every test that proves a
// step happens sits next to the one that proves it does not when it should not.

const disposers: Array<() => void> = []
const register = (hook: (id: string) => void): (() => void) => {
  const off = onBeforeResize(hook)
  disposers.push(off)
  return off
}

afterEach(() => {
  for (const off of disposers.splice(0)) off()
  delete process.env[DISABLE_FLAG]
})

describe('flushBeforeResize', () => {
  it("runs the terminal's own flush first, then every reader in the order they registered, each told which terminal", () => {
    const log: string[] = []
    register((id) => log.push(`first reader ${id}`))
    register((id) => log.push(`second reader ${id}`))
    flushBeforeResize('t1', () => log.push('own flush'))
    expect(log).toEqual(['own flush', 'first reader t1', 'second reader t1'])
  })

  it('lets a reader see what the own flush produced (the reverse order would read an empty buffer)', () => {
    const buffer: string[] = []
    const read: string[][] = []
    register(() => read.push([...buffer]))
    flushBeforeResize('t1', () => buffer.push('held bytes'))
    expect(read).toEqual([['held bytes']])
  })

  it('runs every time the terminal is about to change size, not once', () => {
    let readers = 0
    register(() => {
      readers += 1
    })
    flushBeforeResize('t1', () => undefined)
    flushBeforeResize('t1', () => undefined)
    flushBeforeResize('t2', () => undefined)
    expect(readers).toBe(3)
  })

  it('with no readers registered it still flushes the terminal itself', () => {
    let flushed = 0
    flushBeforeResize('t1', () => {
      flushed += 1
    })
    expect(flushed).toBe(1)
  })

  describe('fails open', () => {
    it('an own flush that throws does not stop the readers, and nothing throws out', () => {
      const log: string[] = []
      register((id) => log.push(`reader ${id}`))
      expect(() =>
        flushBeforeResize('t1', () => {
          throw new Error('the window is gone')
        }),
      ).not.toThrow()
      expect(log).toEqual(['reader t1'])
    })

    it('a reader that throws does not stop the next reader, and nothing throws out', () => {
      const log: string[] = []
      register(() => {
        throw new Error('the bridge is down')
      })
      register((id) => log.push(`second reader ${id}`))
      expect(() => flushBeforeResize('t1', () => log.push('own flush'))).not.toThrow()
      expect(log).toEqual(['own flush', 'second reader t1'])
    })

    it('a reader that removes itself during the pass does not make the next one skip its turn', () => {
      const log: string[] = []
      const off = register(() => {
        log.push('removes itself')
        off()
      })
      register(() => log.push('next reader'))
      flushBeforeResize('t1', () => undefined)
      flushBeforeResize('t1', () => undefined)
      expect(log).toEqual(['removes itself', 'next reader', 'next reader'])
    })

    it('a reader added during the pass waits for the next one', () => {
      const log: string[] = []
      let added = false
      register(() => {
        log.push('adds one')
        if (added) return
        added = true
        register(() => log.push('added'))
      })
      flushBeforeResize('t1', () => undefined)
      expect(log).toEqual(['adds one'])
      flushBeforeResize('t1', () => undefined)
      expect(log).toEqual(['adds one', 'adds one', 'added'])
    })
  })

  describe('onBeforeResize', () => {
    it('hands back the function that removes the reader, and removing twice is harmless', () => {
      const log: string[] = []
      const off = register((id) => log.push(id))
      flushBeforeResize('t1', () => undefined)
      off()
      off()
      flushBeforeResize('t2', () => undefined)
      expect(log).toEqual(['t1'])
    })

    it('counts the same function registered twice as one reader', () => {
      const log: string[] = []
      const reader = (id: string): void => {
        log.push(id)
      }
      register(reader)
      register(reader)
      flushBeforeResize('t1', () => undefined)
      expect(log).toEqual(['t1'])
    })
  })

  describe('the kill switch', () => {
    it('skips the own flush AND every reader, which is the order from before this module existed', () => {
      const log: string[] = []
      register((id) => log.push(`reader ${id}`))
      process.env[DISABLE_FLAG] = '1'
      flushBeforeResize('t1', () => log.push('own flush'))
      expect(log).toEqual([])
      // Negative control: the same call, switch off again, does both.
      delete process.env[DISABLE_FLAG]
      flushBeforeResize('t1', () => log.push('own flush'))
      expect(log).toEqual(['own flush', 'reader t1'])
    })

    it('is read on every call, so it can be flipped without a restart', () => {
      let flushed = 0
      const flush = (): void => {
        flushed += 1
      }
      process.env[DISABLE_FLAG] = 'true'
      flushBeforeResize('t1', flush)
      delete process.env[DISABLE_FLAG]
      flushBeforeResize('t1', flush)
      process.env[DISABLE_FLAG] = '1'
      flushBeforeResize('t1', flush)
      expect(flushed).toBe(1)
    })
  })
})

describe('resizeFlushDisabled', () => {
  it('is on for 1, true and any other value that is not an explicit no', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(resizeFlushDisabled({ [DISABLE_FLAG]: v })).toBe(true)
    }
  })

  it('is off when unset, empty, 0 or false, in any case', () => {
    for (const v of [undefined, '', '0', 'false', 'FALSE', 'False']) {
      expect(resizeFlushDisabled({ [DISABLE_FLAG]: v })).toBe(false)
    }
    expect(resizeFlushDisabled({})).toBe(false)
  })

  it('reads the process environment when no environment is given', () => {
    expect(resizeFlushDisabled()).toBe(false)
    process.env[DISABLE_FLAG] = '1'
    expect(resizeFlushDisabled()).toBe(true)
  })
})

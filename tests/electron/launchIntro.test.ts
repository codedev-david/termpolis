import { describe, it, expect, vi } from 'vitest'
import { createIntroGate, LAST_RUN_FILE, type IntroGateDeps } from '../../src/main/launchIntro'

function make(over: Partial<IntroGateDeps> & { stored?: string | Error } = {}) {
  const { stored, ...rest } = over
  const writes: Array<[string, string]> = []
  const deps: IntroGateDeps = {
    userData: '/ud',
    version: '1.64.0',
    env: {},
    readFile: vi.fn((): string => {
      if (stored instanceof Error) throw stored
      if (stored === undefined) throw new Error('ENOENT')
      return stored
    }),
    writeFile: vi.fn((p: string, t: string) => { writes.push([p, t]) }),
    ...rest,
  }
  return { deps, writes, gate: createIntroGate(deps) }
}

describe('createIntroGate', () => {
  it('plays on the first claim of a normal start and never again in the same process', () => {
    const { gate } = make()
    expect([gate.claim(), gate.claim(), gate.claim()]).toEqual([true, false, false])
  })

  it('skips the start after an update, and rewrites the file with the new version', () => {
    const { gate, writes, deps } = make({ stored: '1.63.0' })
    expect(gate.claim()).toBe(false)
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toBe('1.64.0')
    expect(writes[0][0]).toMatch(/last-run-version$/)
    expect(writes[0][0]).toContain('ud')
    expect(LAST_RUN_FILE).toBe('last-run-version')
    expect(deps.readFile).toHaveBeenCalledTimes(1)
  })

  it('plays when the file is missing, and when it holds the same version', () => {
    expect(make().gate.claim()).toBe(true)
    expect(make({ stored: '1.64.0\n' }).gate.claim()).toBe(true)
  })

  it('writes the current version once, on the first call, whatever the answer', () => {
    const a = make()
    a.gate.claim(); a.gate.claim()
    expect(a.writes).toEqual([[expect.stringContaining('last-run-version'), '1.64.0']])
  })

  it('treats an unreadable or garbage file as missing', () => {
    expect(make({ stored: new Error('EACCES') }).gate.claim()).toBe(true)
    expect(make({ stored: '\u0000garbage' }).gate.claim()).toBe(true)
    expect(make({ stored: '' }).gate.claim()).toBe(true)
    expect(make({ stored: '1.63.0-beta.1' }).gate.claim()).toBe(false)
  })

  it('still answers when the write throws', () => {
    const { gate } = make({ writeFile: () => { throw new Error('EROFS') } })
    expect(() => gate.claim()).not.toThrow()
    expect(gate.claim()).toBe(false)
    expect(make({ writeFile: () => { throw new Error('EROFS') } }).gate.claim()).toBe(true)
  })

  it('stays off in e2e unless the test asks', () => {
    expect(make({ env: { NODE_ENV: 'test' } }).gate.claim()).toBe(false)
    expect(make({ env: { NODE_ENV: 'test', TERMPOLIS_TEST_LAUNCH_INTRO: '1' } }).gate.claim()).toBe(true)
    expect(make({ env: { TERMPOLIS_TEST_LAUNCH_INTRO: '1' } }).gate.claim()).toBe(true)
  })
})

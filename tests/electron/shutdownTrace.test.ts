// The e2e quit tracer: what it remembers about in-flight requests, and when it lets go of them.
// Real fs calls drive it, because the async_hooks types it filters on are Node's own.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startShutdownTrace, describeInflight, _stopShutdownTraceForTests } from '../../src/main/shutdownTrace'

afterEach(() => _stopShutdownTraceForTests())

describe('shutdownTrace', () => {
  it('names an fs request still in flight, with the stack of the line that made it', async () => {
    startShutdownTrace()
    const reading = fsp.readFile(join(tmpdir(), 'shutdown-trace-missing-file'))
    const lines = describeInflight()
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some(l => l.startsWith('FSREQ') && l.includes('shutdownTrace.test.ts'))).toBe(true)
    await reading.catch(() => {})
  })

  it('forgets a request once it has finished', async () => {
    startShutdownTrace()
    await fsp.readFile(join(tmpdir(), 'shutdown-trace-missing-file')).catch(() => {})
    // destroy() runs from a later turn of the loop than the promise's settling.
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(describeInflight().filter(l => l.includes('shutdownTrace.test.ts'))).toEqual([])
  })

  it('lists the oldest request first and says how old each is', () => {
    startShutdownTrace()
    const a = fsp.stat(tmpdir())
    const b = fsp.stat(tmpdir())
    const lines = describeInflight(Date.now() + 1000)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) expect(line).toMatch(/^[A-Z]+, \d+ms old, made at:\n/)
    const ages = lines.map(l => Number(/, (\d+)ms old/.exec(l)![1]))
    expect([...ages].sort((x, y) => y - x)).toEqual(ages)
    return Promise.all([a, b])
  })

  it('ignores handles and timers, which say nothing about a stuck exit', () => {
    startShutdownTrace()
    const t = setTimeout(() => {}, 1000)
    expect(describeInflight().some(l => l.startsWith('Timeout'))).toBe(false)
    clearTimeout(t)
  })

  it('records nothing until started, and starting twice is harmless', async () => {
    const before = fsp.stat(tmpdir())
    expect(describeInflight()).toEqual([])
    await before
    startShutdownTrace()
    startShutdownTrace()
    const after = fsp.stat(tmpdir())
    expect(describeInflight().filter(l => l.includes('shutdownTrace.test.ts'))).toHaveLength(1)
    await after
  })
})

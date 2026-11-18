import * as fsp from 'fs/promises'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  CI_CACHE_MS,
  GH_TIMEOUT_MS,
  MAX_TRANSCRIPTS,
  TRANSCRIPT_CACHE_MS,
  createWorldRuns,
  tailOfFile,
  type RunsDeps
} from '../../src/main/world/worldRuns'

vi.mock('fs/promises', async (orig) => {
  const actual = await orig<typeof import('fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const ROOT = '/repo'
const GH_ARGS = ['run', 'list', '--limit', '1', '--json', 'conclusion,headSha,createdAt,databaseId']
const SHA = 'abc1234def'

function make(over: Partial<RunsDeps> = {}): { d: RunsDeps; exec: ReturnType<typeof vi.fn>; clock: { t: number } } {
  const clock = { t: 1000 }
  const exec = vi.fn(async (bin: string) =>
    bin === 'gh'
      ? { stdout: JSON.stringify([{ conclusion: 'success', headSha: SHA, createdAt: '2026-11-02T10:00:00Z', databaseId: 1 }]) }
      : { stdout: 'src/a.ts\n\n src/b.ts \n' }
  )
  const d: RunsDeps = {
    listTranscripts: async () => [],
    readTail: async () => null,
    transcriptsAllowed: () => true,
    ciAllowed: async () => true,
    exec,
    now: () => clock.t,
    ...over
  }
  return { d, exec, clock }
}

describe('ciRuns', () => {
  it('success marks the commit files passed, with the 5 s gh timeout', async () => {
    const { d, exec } = make()
    const runs = await createWorldRuns(d).ciRuns(ROOT)
    const at = Date.parse('2026-11-02T10:00:00Z')
    expect(runs).toEqual([
      { file: 'src/a.ts', passed: true, at, source: 'ci' },
      { file: 'src/b.ts', passed: true, at, source: 'ci' }
    ])
    expect(exec).toHaveBeenNthCalledWith(1, 'gh', GH_ARGS, { cwd: ROOT, timeout: GH_TIMEOUT_MS })
    expect(GH_TIMEOUT_MS).toBe(5000)
    expect(exec.mock.calls[1][1]).toEqual(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', SHA])
  })

  it('failure marks them failed, and a bad createdAt uses now', async () => {
    const { d } = make({
      exec: async (bin) =>
        bin === 'gh' ? { stdout: JSON.stringify([{ conclusion: 'failure', headSha: SHA, createdAt: 'nope' }]) } : { stdout: 'x.ts' }
    })
    expect(await createWorldRuns(d).ciRuns(ROOT)).toEqual([{ file: 'x.ts', passed: false, at: 1000, source: 'ci' }])
  })

  it('a CI answer with no createdAt uses now', async () => {
    const { d } = make({
      exec: async (bin) => (bin === 'gh' ? { stdout: JSON.stringify([{ conclusion: 'success', headSha: SHA }]) } : { stdout: 'x.ts' })
    })
    expect(await createWorldRuns(d).ciRuns(ROOT)).toEqual([{ file: 'x.ts', passed: true, at: 1000, source: 'ci' }])
  })

  it('never starts gh unless the setting is on', async () => {
    const { d, exec } = make({ ciAllowed: async () => false })
    expect(await createWorldRuns(d).ciRuns(ROOT)).toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })

  it('gh missing, failing, unparsable or not finished gives []', async () => {
    const cases: RunsDeps['exec'][] = [
      async () => ({ stdout: '', error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }),
      async () => ({ stdout: 'not json' }),
      async () => ({ stdout: '[]' }),
      async () => ({ stdout: JSON.stringify([{ conclusion: 'cancelled', headSha: SHA }]) }),
      async () => ({ stdout: JSON.stringify([{ conclusion: 'success', headSha: 'not a sha!' }]) }),
      async () => ({ stdout: JSON.stringify([{ conclusion: 'success' }]) }),
      async (bin) => (bin === 'gh' ? { stdout: JSON.stringify([{ conclusion: 'success', headSha: SHA }]) } : { stdout: '', error: new Error('git') })
    ]
    for (const exec of cases) expect(await createWorldRuns(make({ exec }).d).ciRuns(ROOT)).toEqual([])
  })

  it('keeps the answer 10 minutes per root, even an empty one', async () => {
    const { d, exec, clock } = make()
    const w = createWorldRuns(d)
    await w.ciRuns(ROOT)
    await w.ciRuns(ROOT)
    expect(exec).toHaveBeenCalledTimes(2)
    await w.ciRuns('/other')
    expect(exec).toHaveBeenCalledTimes(4)
    clock.t += CI_CACHE_MS
    await w.ciRuns(ROOT)
    expect(exec).toHaveBeenCalledTimes(6)
  })
})

describe('transcriptRuns', () => {
  const line = (cmd: string): string => JSON.stringify({ cmd })

  it('reads nothing when conversations may not be read', async () => {
    const listTranscripts = vi.fn(async () => ['a'])
    const { d } = make({ transcriptsAllowed: () => false, listTranscripts })
    expect(await createWorldRuns(d).transcriptRuns(ROOT)).toEqual([])
    expect(listTranscripts).not.toHaveBeenCalled()
  })

  it('reads only the 20 newest, skips unreadable ones and caches 20 s', async () => {
    const files = Array.from({ length: 30 }, (_, i) => `f${i}`)
    const readTail = vi.fn(async (f: string) => (f === 'f1' ? null : line(f)))
    const { d, clock } = make({ listTranscripts: async () => files, readTail })
    const w = createWorldRuns(d)
    expect(await w.transcriptRuns(ROOT)).toEqual([])
    expect(readTail).toHaveBeenCalledTimes(MAX_TRANSCRIPTS)
    await w.transcriptRuns(ROOT)
    expect(readTail).toHaveBeenCalledTimes(MAX_TRANSCRIPTS)
    clock.t += TRANSCRIPT_CACHE_MS
    await w.transcriptRuns(ROOT)
    expect(readTail).toHaveBeenCalledTimes(MAX_TRANSCRIPTS * 2)
  })

  it('returns the runs a transcript holds, and a listing failure gives []', async () => {
    const text = JSON.stringify({
      timestamp: '2026-11-02T10:00:00.000Z',
      type: 'user',
      message: { content: [{ type: 'tool_result', content: ' FAIL  src/main/a.test.ts > x\nTest Files  1 failed (1)' }] }
    })
    const a = make({ listTranscripts: async () => ['a'], readTail: async () => text })
    const runs = await createWorldRuns(a.d).transcriptRuns(ROOT)
    expect(runs.every((r) => r.source === 'transcript')).toBe(true)
    const b = make({
      listTranscripts: async () => {
        throw new Error('gone')
      }
    })
    expect(await createWorldRuns(b.d).transcriptRuns(ROOT)).toEqual([])
  })
})

describe('tailOfFile', () => {
  it('reads the last bytes of a file, whole when it is small, null when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wruns-'))
    try {
      const f = join(dir, 't.jsonl')
      await writeFile(f, 'abcdef')
      expect(await tailOfFile(f, 3)).toBe('def')
      expect(await tailOfFile(f, 100)).toBe('abcdef')
      expect(await tailOfFile(join(dir, 'none'), 10)).toBeNull()
      // a handle that will not close still gives the text
      const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
      vi.mocked(fsp.open).mockImplementationOnce((async (...args: Parameters<typeof real.open>) => {
        const h = await real.open(...args)
        const close = h.close.bind(h)
        h.close = async () => {
          await close()
          throw new Error('close failed')
        }
        return h
      }) as never)
      expect(await tailOfFile(f, 3)).toBe('def')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

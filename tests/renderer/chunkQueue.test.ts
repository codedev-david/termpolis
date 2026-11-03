import { describe, it, expect } from 'vitest'
import { createChunkQueue, createStringQueue } from '../../src/renderer/src/lib/chunkQueue'

// The queue behind the output throttle and the selection hold (1.54.5, plan package P2).
//
// WHY: the throttle held its backlog in ONE string (`buffer += data`, then `buffer.slice(0, 65536)`).
// Slicing a string built by `+=` flattens all of it, so every 64 KB flush copied the whole backlog
// (2.0x the backlog in heap, per flush, at 1 M / 4 M / 16 M / 50 M chars in the lens harness), and each
// queued 64 KB slice pinned that flat copy. The chunk list keeps the chunks main sent, joins at most
// 64 KB from the head and splits only the chunk on the boundary.
//
// The proof is counters, not clocks: `reads` (chunk objects a take touched) and `work` (chars a take
// had to read or copy). Each test that bounds them carries a NEGATIVE CONTROL in this file: the same
// loop on the old representation (createStringQueue) breaks the same bound.

const FLUSH = 65_536

/** mulberry32: a seeded PRNG, so a failure names a seed that reproduces it. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('createChunkQueue: contents and order', () => {
  it('starts empty and reports length, chunk count and counters', () => {
    const q = createChunkQueue()
    expect(q.length).toBe(0)
    expect(q.chunks).toBe(0)
    expect(q.reads).toBe(0)
    expect(q.work).toBe(0)
    expect(q.take(100)).toBe('')
    expect(q.takeAll()).toBe('')
  })

  it('returns exactly what was pushed, in order, and tracks length', () => {
    const q = createChunkQueue()
    q.push('abc')
    q.push('def')
    q.push('g')
    expect(q.length).toBe(7)
    expect(q.chunks).toBe(3)
    expect(q.take(100)).toBe('abcdefg')
    expect(q.length).toBe(0)
    expect(q.chunks).toBe(0)
  })

  it('ignores empty pushes', () => {
    const q = createChunkQueue()
    q.push('')
    expect(q.chunks).toBe(0)
    expect(q.length).toBe(0)
    q.push('a')
    q.push('')
    expect(q.chunks).toBe(1)
  })

  it('splits ONLY the chunk on the boundary: whole head chunks are returned untouched', () => {
    const q = createChunkQueue()
    q.push('aaaa')
    q.push('bbbb')
    q.push('cccc')
    expect(q.take(6)).toBe('aaaabb') // 'aaaa' whole, 'bbbb' split
    expect(q.length).toBe(6)
    expect(q.chunks).toBe(2) // the remainder 'bb' and 'cccc'
    expect(q.take(3)).toBe('bbc')
    expect(q.take(100)).toBe('ccc')
  })

  it('hands back a single head chunk as the very same string (no join, no copy)', () => {
    const q = createChunkQueue()
    const big = 'x'.repeat(5000)
    q.push(big)
    q.push('tail')
    const out = q.take(5000)
    expect(out).toBe(big)
    expect(q.take(10)).toBe('tail')
  })

  it('takes nothing for a zero or negative size, and clamps to what is there', () => {
    const q = createChunkQueue()
    q.push('hello')
    expect(q.take(0)).toBe('')
    expect(q.take(-5)).toBe('')
    expect(q.length).toBe(5)
    expect(q.take(1000)).toBe('hello')
  })

  it('takeAll drains everything in order and resets the queue', () => {
    const q = createChunkQueue()
    for (const s of ['one ', 'two ', 'three']) q.push(s)
    expect(q.takeAll()).toBe('one two three')
    expect(q.length).toBe(0)
    expect(q.chunks).toBe(0)
    q.push('again')
    expect(q.takeAll()).toBe('again')
  })

  it('clear drops everything', () => {
    const q = createChunkQueue()
    q.push('abc')
    q.push('def')
    q.clear()
    expect(q.length).toBe(0)
    expect(q.chunks).toBe(0)
    expect(q.take(10)).toBe('')
    q.push('x')
    expect(q.take(10)).toBe('x')
  })

  it('restore puts a failed hand-off back at the head, ahead of everything still queued', () => {
    const q = createChunkQueue()
    q.push('aaaa')
    q.push('bbbb')
    q.push('cccc')
    const out = q.take(6) // 'aaaabb', leaves 'bb' + 'cccc'
    q.restore(out)
    expect(q.length).toBe(12)
    expect(q.take(100)).toBe('aaaabbbbcccc')
  })

  it('restore works when the take only split the first chunk (no consumed slot in front of it)', () => {
    const q = createChunkQueue()
    q.push('0123456789')
    const out = q.take(4) // splits the only chunk: '0123', leaves '456789'
    q.restore(out)
    expect(q.take(100)).toBe('0123456789')
  })

  it('restore of an empty string is a no-op', () => {
    const q = createChunkQueue()
    q.push('a')
    q.restore('')
    expect(q.chunks).toBe(1)
    expect(q.take(10)).toBe('a')
  })

  it('stays correct across many takes (the consumed prefix is compacted, not kept forever)', () => {
    const q = createChunkQueue()
    let model = ''
    for (let i = 0; i < 6000; i++) {
      const s = `<${i}>`
      q.push(s)
      model += s
    }
    let out = ''
    while (q.length > 0) out += q.take(1000)
    expect(out).toBe(model)
    expect(q.chunks).toBe(0)
  })
})

describe('createChunkQueue: byte-identical to a plain string over random splits', () => {
  // The oracle is the representation the queue replaces: one string, `+=` to add, slice to take.
  for (const seed of [1, 2, 3, 7, 42, 99, 1234, 5150]) {
    it(`seed ${seed}: pushes, takes of random size, restores and takeAll never reorder, lose or repeat a char`, () => {
      const rand = prng(seed)
      const q = createChunkQueue()
      let model = ''
      const taken: string[] = []
      const modelTaken: string[] = []
      for (let step = 0; step < 400; step++) {
        const r = rand()
        if (r < 0.5) {
          const len = Math.floor(rand() * rand() * 20_000) // many small, a few big
          const s = String.fromCharCode(97 + (step % 26)).repeat(len) + `|${step}|`
          q.push(s)
          model += s
        } else if (r < 0.9) {
          const max = 1 + Math.floor(rand() * 70_000)
          const got = q.take(max)
          const want = model.slice(0, max)
          model = model.slice(max)
          taken.push(got)
          modelTaken.push(want)
          expect(got).toBe(want)
        } else if (r < 0.95 && taken.length > 0) {
          // a failed hand-off: give the last take back
          const last = taken.pop()!
          modelTaken.pop()
          q.restore(last)
          model = last + model
        } else {
          const got = q.takeAll()
          expect(got).toBe(model)
          model = ''
          taken.push(got)
          modelTaken.push(got)
        }
        expect(q.length).toBe(model.length)
      }
      expect(q.takeAll()).toBe(model)
      expect(q.length).toBe(0)
    })
  }
})

describe('createChunkQueue: the work of one take does not depend on the backlog', () => {
  /** A backlog of `total` chars made of shared chunk strings of 1 KB to 9 KB (shared, so 50 M chars cost pointers). */
  function backlog(q: ReturnType<typeof createChunkQueue>, total: number, seed: number): { smallest: number; largest: number } {
    const rand = prng(seed)
    const pool: string[] = []
    for (const n of [1024, 2048, 4096, 7000, 9000]) pool.push('x'.repeat(n))
    let pushed = 0
    let smallest = Infinity
    let largest = 0
    while (pushed < total) {
      const s = pool[Math.floor(rand() * pool.length)]
      q.push(s)
      pushed += s.length
      smallest = Math.min(smallest, s.length)
      largest = Math.max(largest, s.length)
    }
    return { smallest, largest }
  }

  for (const total of [1_000_000, 4_000_000, 16_000_000, 50_000_000]) {
    it(`a take of 64 KB reads at most ceil(64 KB / smallest chunk) + 2 chunks at a ${total.toLocaleString('en-US')} char backlog`, () => {
      const q = createChunkQueue()
      const { smallest, largest } = backlog(q, total, 11)
      const readsBound = Math.ceil(FLUSH / smallest) + 2
      const workBound = FLUSH + largest // whole head chunks + the one chunk that is split
      const takes = Math.min(40, Math.floor(total / FLUSH) - 1)
      let worstReads = 0
      let worstWork = 0
      let delivered = 0
      for (let i = 0; i < takes; i++) {
        const r0 = q.reads
        const w0 = q.work
        const out = q.take(FLUSH)
        delivered += out.length
        expect(out.length).toBe(FLUSH)
        worstReads = Math.max(worstReads, q.reads - r0)
        worstWork = Math.max(worstWork, q.work - w0)
      }
      expect(takes).toBeGreaterThanOrEqual(14)
      expect(worstReads).toBeGreaterThan(0) // the counter really counts
      expect(worstReads).toBeLessThanOrEqual(readsBound)
      expect(worstWork).toBeLessThanOrEqual(workBound)
      expect(delivered).toBe(takes * FLUSH)
      expect(q.length).toBeGreaterThan(total - (takes + 1) * FLUSH - largest) // only what was taken is gone
    })
  }

  it('the cost is the same at every backlog size: the worst take at 50 M is no worse than the worst at 1 M plus one chunk', () => {
    const worst = (total: number): number => {
      const q = createChunkQueue()
      backlog(q, total, 5)
      let w = 0
      for (let i = 0; i < 20; i++) {
        const w0 = q.work
        q.take(FLUSH)
        w = Math.max(w, q.work - w0)
      }
      return w
    }
    expect(worst(50_000_000)).toBeLessThanOrEqual(worst(1_000_000) + 9_000)
  })

  it('NEGATIVE CONTROL: the 1.54.4 string representation breaks the same bound, in proportion to the backlog', () => {
    // Same backlog, same takes, same counters: the old representation has to read all of it on the first
    // take (the `+=` rope is flattened), so a bound written for the chunk list does not hold for it.
    const total = 4_000_000
    const q = createStringQueue()
    const { largest } = (() => {
      const pool = ['x'.repeat(1024), 'y'.repeat(7000), 'z'.repeat(9000)]
      let pushed = 0
      let big = 0
      for (let i = 0; pushed < total; i++) {
        const s = pool[i % pool.length]
        q.push(s)
        pushed += s.length
        big = Math.max(big, s.length)
      }
      return { largest: big }
    })()
    const w0 = q.work
    const out = q.take(FLUSH)
    expect(out.length).toBe(FLUSH)
    expect(q.work - w0).toBeGreaterThan(FLUSH + largest) // the bound the chunk list meets
    expect(q.work - w0).toBeGreaterThanOrEqual(total - 20_000) // and in fact it read the backlog
  })
})

describe('createStringQueue (the 1.54.4 representation, kept behind the kill switch)', () => {
  it('has the same contents and order contract as the chunk list', () => {
    const rand = prng(77)
    const a = createChunkQueue()
    const b = createStringQueue()
    for (let step = 0; step < 300; step++) {
      if (rand() < 0.55) {
        const s = String.fromCharCode(65 + (step % 26)).repeat(Math.floor(rand() * 5000)) + step
        a.push(s)
        b.push(s)
      } else {
        const max = 1 + Math.floor(rand() * 9000)
        const x = a.take(max)
        const y = b.take(max)
        expect(y).toBe(x)
        if (x && rand() < 0.2) {
          a.restore(x)
          b.restore(y)
        }
      }
      expect(b.length).toBe(a.length)
    }
    expect(b.takeAll()).toBe(a.takeAll())
  })

  it('reports its chunk count as 0 or 1 and can be cleared', () => {
    const q = createStringQueue()
    expect(q.chunks).toBe(0)
    q.push('abc')
    q.push('def')
    expect(q.chunks).toBe(1)
    q.clear()
    expect(q.length).toBe(0)
    expect(q.chunks).toBe(0)
    expect(q.take(5)).toBe('')
    expect(q.takeAll()).toBe('')
  })

  it('restore of an empty string is a no-op', () => {
    const q = createStringQueue()
    q.push('a')
    q.restore('')
    expect(q.take(9)).toBe('a')
  })
})

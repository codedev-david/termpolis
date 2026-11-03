/**
 * A FIFO of text, kept as the chunks it arrived in (1.54.5, the output throttle and the selection hold).
 *
 * The throttle used to hold its backlog in ONE string: `buffer += data`, then `buffer.slice(0, 65536)`
 * on every flush. V8 builds a `+=` string as a rope, and slicing a rope flattens ALL of it first, so each
 * 64 KB flush copied the whole backlog (2.0x the backlog in heap, per flush, at a 1 M to 50 M char
 * backlog), and every 64 KB slice that stayed queued pinned that flat copy. While the renderer was
 * behind, every flush made it further behind.
 *
 * Here a flush joins at most `max` chars from the head and splits ONLY the chunk on the boundary, so the
 * work of one take depends on the size of the take and of one chunk, never on the backlog.
 *
 * `reads` and `work` are the counters the tests bound (chunk objects touched, chars read or copied).
 * They are plain numbers on the queue: counting costs two additions per chunk.
 */
export interface ChunkQueue {
  /** Chars queued. */
  readonly length: number
  /** Chunks queued right now. */
  readonly chunks: number
  /** Chunk objects every take has touched so far. */
  readonly reads: number
  /** Chars every take has had to read or copy so far (a split chunk counts in full). */
  readonly work: number
  push(data: string): void
  /** Remove and return up to `max` chars from the head, in order. */
  take(max: number): string
  /** Put text a take returned back at the head, ahead of everything queued (a hand-off that failed). */
  restore(text: string): void
  /** Remove and return everything, in order. */
  takeAll(): string
  clear(): void
}

/** The consumed prefix of the array is dropped once it is both long and at least half of it. */
const COMPACT_MIN_HEAD = 1024

class ChunkList implements ChunkQueue {
  private items: string[] = []
  private head = 0
  private chars = 0
  reads = 0
  work = 0

  get length(): number {
    return this.chars
  }

  get chunks(): number {
    return this.items.length - this.head
  }

  push(data: string): void {
    if (data.length === 0) return
    this.items.push(data)
    this.chars += data.length
  }

  take(max: number): string {
    if (!(max > 0) || this.chars === 0) return ''
    const want = Math.min(max, this.chars)
    let got = 0
    const pieces: string[] = []
    while (got < want) {
      const chunk = this.items[this.head]
      const room = want - got
      this.reads++
      this.work += chunk.length
      if (chunk.length <= room) {
        pieces.push(chunk)
        got += chunk.length
        this.items[this.head] = '' // let the chunk go; the slot is reused or compacted away
        this.head++
      } else {
        pieces.push(chunk.slice(0, room)) // the boundary: the only chunk ever split
        got += room
        this.items[this.head] = chunk.slice(room)
      }
    }
    this.chars -= got
    this.compact()
    return pieces.length === 1 ? pieces[0] : pieces.join('')
  }

  restore(text: string): void {
    if (text.length === 0) return
    // The slot in front of the head is a consumed one: reuse it. At the very start there is none.
    if (this.head > 0) this.items[--this.head] = text
    else this.items.unshift(text)
    this.chars += text.length
  }

  takeAll(): string {
    if (this.chars === 0) return ''
    const live = this.head === 0 ? this.items : this.items.slice(this.head)
    this.reads += live.length
    this.work += this.chars
    const out = live.length === 1 ? live[0] : live.join('')
    this.clear()
    return out
  }

  clear(): void {
    this.items = []
    this.head = 0
    this.chars = 0
  }

  private compact(): void {
    if (this.head >= this.items.length) {
      this.items.length = 0
      this.head = 0
    } else if (this.head >= COMPACT_MIN_HEAD && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
  }
}

export function createChunkQueue(): ChunkQueue {
  return new ChunkList()
}

/**
 * The 1.54.4 representation: one string, `+=` to add, `slice` to take. Kept behind the kill switch
 * (localStorage 'termpolis.outputChunks' = '0'), and as the negative control of the work-bound tests:
 * a take has to read all of the backlog, which is exactly what the chunk list stops doing.
 */
class StringQueue implements ChunkQueue {
  private buffer = ''
  reads = 0
  work = 0

  get length(): number {
    return this.buffer.length
  }

  get chunks(): number {
    return this.buffer.length > 0 ? 1 : 0
  }

  push(data: string): void {
    this.buffer += data
  }

  take(max: number): string {
    if (!(max > 0) || this.buffer.length === 0) return ''
    this.reads++
    this.work += this.buffer.length
    if (this.buffer.length <= max) {
      const out = this.buffer
      this.buffer = ''
      return out
    }
    const out = this.buffer.slice(0, max)
    this.buffer = this.buffer.slice(max)
    return out
  }

  restore(text: string): void {
    if (text.length > 0) this.buffer = text + this.buffer
  }

  takeAll(): string {
    if (this.buffer.length === 0) return ''
    this.reads++
    this.work += this.buffer.length
    const out = this.buffer
    this.buffer = ''
    return out
  }

  clear(): void {
    this.buffer = ''
  }
}

export function createStringQueue(): ChunkQueue {
  return new StringQueue()
}

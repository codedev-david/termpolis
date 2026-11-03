// The real-file side of a pass: stat a file, read its text in pieces (1 MiB in the app), read the head of a
// parent session. The decode is the delicate part: a multi-byte character may straddle two reads.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, promises as fsPromises } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileHead, filePieces, fileStamp, READ_PIECE_BYTES } from '../../src/main/ingestFiles'
import { mulberry32 } from './_transcriptFixture'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tmpFile(content: string | Buffer, name = 'a.jsonl'): string {
  const d = mkdtempSync(join(tmpdir(), 'ingest-files-'))
  dirs.push(d)
  const p = join(d, name)
  writeFileSync(p, content)
  return p
}
async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const piece of it) out.push(piece)
  return out
}

describe('fileStamp', () => {
  it('is the size and mtime of the file, or null when it cannot be statted (a missing file, a folder)', async () => {
    const p = tmpFile('hello')
    const s = await fileStamp(p)
    expect(s).toMatchObject({ size: 5 })
    expect(s!.mtimeMs).toBeGreaterThan(1_500_000_000_000)
    expect(await fileStamp(p + '.nope')).toBeNull()
    expect(await fileStamp(join(p, '..'))).toBeNull() // a folder is not a transcript
  })
})

describe('filePieces', () => {
  it('reads the whole file as text, in pieces of at most the piece size, and an empty file as nothing', async () => {
    const text = 'abc\n'.repeat(1_000)
    const p = tmpFile(text)
    const pieces = await collect(filePieces(p, 256))
    expect(pieces.join('')).toBe(text)
    expect(pieces.length).toBe(Math.ceil(text.length / 256))
    expect(pieces.every((x) => x.length <= 256)).toBe(true)
    expect(await collect(filePieces(tmpFile(''), 256))).toEqual([])
  })

  it('the piece size in the app is 1 MiB', () => {
    expect(READ_PIECE_BYTES).toBe(1024 * 1024)
  })

  it('a multi-byte character cut by the piece boundary comes out whole, at every possible boundary', async () => {
    const text = 'a日本語b🎉c€é\n'.repeat(3)
    const buf = Buffer.from(text, 'utf8')
    const p = tmpFile(buf)
    for (let n = 1; n <= 40; n++) {
      const pieces = await collect(filePieces(p, n))
      expect(pieces.join(''), `piece size ${n}`).toBe(text)
      expect(pieces.join('').includes('�'), `piece size ${n}`).toBe(false)
    }
  })

  it('random text and random piece sizes decode exactly as reading the whole file does', async () => {
    const rnd = mulberry32(3)
    const alphabet = ['a', 'z', ' ', '\n', 'é', '日', '🎉', '€', '"', '\\', '\t']
    for (let round = 0; round < 25; round++) {
      let text = ''
      const n = 1 + Math.floor(rnd() * 400)
      for (let i = 0; i < n; i++) text += alphabet[Math.floor(rnd() * alphabet.length)]
      const p = tmpFile(text)
      const piece = 1 + Math.floor(rnd() * 64)
      expect((await collect(filePieces(p, piece))).join('')).toBe(Buffer.from(text, 'utf8').toString('utf8'))
    }
  })

  it('a UTF-8 BOM and invalid bytes come out as readFile would give them', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok\n'), Buffer.from([0xff, 0xfe]), Buffer.from('end\n')])
    const p = tmpFile(bytes)
    const whole = bytes.toString('utf8')
    expect((await collect(filePieces(p, 4))).join('')).toBe(whole)
    expect((await collect(filePieces(p, 1_000))).join('')).toBe(whole)
  })

  it('a file that does not exist fails the iteration (the pass then counts it unreadable)', async () => {
    await expect(collect(filePieces(join(tmpdir(), 'ingest-files-missing', 'x.jsonl'), 64))).rejects.toThrow()
  })

  it('the handle is closed whether the reader reads on, stops early, or fails', async () => {
    const p = tmpFile('x'.repeat(5_000))
    const it = filePieces(p, 100)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.(undefined) // the consumer walked away
    // on Windows an open handle would block deleting the file
    rmSync(p, { force: true })
    expect(await fileStamp(p)).toBeNull()
  })
})

describe('a handle that will not close', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const fakeHandle = (text: string) => {
    let served = false
    return {
      read: vi.fn(async (buf: Buffer, offset: number) => {
        if (served) return { bytesRead: 0 }
        served = true
        return { bytesRead: buf.write(text, offset) }
      }),
      close: vi.fn(async () => { throw new Error('EIO') }),
    }
  }

  it('does not turn a good read of the pieces into a failure', async () => {
    const h = fakeHandle('hi')
    vi.spyOn(fsPromises, 'open').mockResolvedValue(h as never)
    expect(await collect(filePieces('whatever.jsonl', 64))).toEqual(['hi'])
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('does not turn a good read of the head into a failure', async () => {
    const h = fakeHandle('hi')
    vi.spyOn(fsPromises, 'open').mockResolvedValue(h as never)
    expect(await fileHead('whatever.jsonl', 64)).toEqual({ text: 'hi', eof: true })
    expect(h.close).toHaveBeenCalledTimes(1)
  })
})

describe('a file that ends in the middle of a character', () => {
  it('comes out as readFile gives it: the cut character is the replacement character, at every piece size', async () => {
    const bytes = Buffer.from([0x61, 0x62, 0xe6]) // "ab" and the first byte of a three-byte character that never finishes
    const p = tmpFile(bytes)
    for (const n of [1, 2, 3, 8]) expect((await collect(filePieces(p, n))).join(''), `piece size ${n}`).toBe(bytes.toString('utf8'))
  })
})

describe('fileHead', () => {
  it('reads at most maxBytes from the start, and says whether that was the whole file', async () => {
    const p = tmpFile('0123456789')
    expect(await fileHead(p, 4)).toEqual({ text: '0123', eof: false })
    expect(await fileHead(p, 10)).toEqual({ text: '0123456789', eof: true })
    expect(await fileHead(p, 100)).toEqual({ text: '0123456789', eof: true })
    expect(await fileHead(tmpFile(''), 10)).toEqual({ text: '', eof: true })
  })

  it('a character cut by the end of the head is dropped rather than shown broken', async () => {
    const p = tmpFile('ab日本')
    const h = await fileHead(p, 4) // "ab" + 2 of the 3 bytes of 日
    expect(h.text).toBe('ab')
    expect(h.eof).toBe(false)
  })

  it('a missing file rejects (the caller treats the parent as not delegated)', async () => {
    await expect(fileHead(join(tmpdir(), 'ingest-files-missing', 'x.jsonl'), 10)).rejects.toThrow()
  })
})

// ingestFiles.ts
//
// The three file operations a conversation-ingest pass needs, each one a small async step so the main
// thread (which also echoes every keystroke) is never held for longer than one of them:
//   - fileStamp:  size and mtime, to decide whether a file changed without opening it
//   - filePieces: the file as decoded text in pieces of at most READ_PIECE_BYTES, so a 77 MB transcript is
//                 never one 77 MB read, one 77 MB string and one block of parsing
//   - fileHead:   the first bytes of a file, to judge a subagent's parent session without reading it whole
//
// Decoding goes through a StringDecoder, so a multi-byte character cut by a piece boundary comes out whole,
// and the text is exactly what readFile(path, 'utf8') gives (invalid bytes become U+FFFD alike).

import { promises as fsp } from 'fs'
import { StringDecoder } from 'string_decoder'
import type { FileStamp } from './ingestWatermark'

/** Bytes per read. Measured on the target box: a 1 MiB piece parses in about 2 ms (14 ms worst), so a piece never needs splitting. */
export const READ_PIECE_BYTES = 1024 * 1024

/** The size and mtime of a regular file; null for anything else or on any error (the caller then does not skip it). */
export async function fileStamp(path: string): Promise<FileStamp | null> {
  try {
    const st = await fsp.stat(path)
    if (!st.isFile()) return null
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/** The whole file as text, in pieces. The handle is closed whether the reader finishes, stops early or fails. */
export async function* filePieces(path: string, pieceBytes: number = READ_PIECE_BYTES): AsyncGenerator<string> {
  const fh = await fsp.open(path, 'r')
  try {
    const decoder = new StringDecoder('utf8')
    const buf = Buffer.allocUnsafe(Math.max(1, Math.floor(pieceBytes)))
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      const text = decoder.write(buf.subarray(0, bytesRead))
      if (text) yield text
    }
    const rest = decoder.end()
    if (rest) yield rest
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * The start of a file: at most `maxBytes` bytes decoded, and whether that was all of it. A character cut by
 * the end of the head is dropped, not shown broken (unless the file ends there, as readFile would show it).
 */
export async function fileHead(path: string, maxBytes: number): Promise<{ text: string; eof: boolean }> {
  const fh = await fsp.open(path, 'r')
  try {
    // One byte more than asked, to tell "exactly maxBytes long" from "longer".
    const buf = Buffer.allocUnsafe(maxBytes + 1)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    const eof = got <= maxBytes
    const decoder = new StringDecoder('utf8')
    const text = decoder.write(buf.subarray(0, Math.min(got, maxBytes)))
    return { text: eof ? text + decoder.end() : text, eof }
  } finally {
    await fh.close().catch(() => undefined)
  }
}

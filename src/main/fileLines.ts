// fileLines.ts — the byte-safe way to read a (possibly very large) newline-delimited file.
//
// A leaf module (imports only Node builtins) so every JSONL loader in the app can share it without
// creating an import cycle. It exists because of the v1.27.4 field crash: a shard/log file grew past
// V8's max string length (~512 MiB / 0x1FFFFFE8 bytes), and the loader read the whole file with
// `fs.readFileSync(path, 'utf8')`. On Node 20 (Electron 30's runtime) that fast path decodes straight
// into `String::NewFromUtf8`, which returns an empty MaybeLocal and then FATALS — uncatchably —
// "v8::ToLocalChecked Empty MaybeLocal", aborting the ENTIRE process (no try/catch can stop it). A
// Buffer is backed by an ArrayBuffer (~2 GB ceiling, NOT a V8 string), so we read the bytes once and
// decode ONE LINE AT A TIME; every decoded string stays small, so the fatal can never fire no matter
// how large the file grows.

import * as fs from 'fs'
import * as nodeBuffer from 'node:buffer'

/** The largest byte length V8 will materialise as one string. A file no larger than this is safe to
 *  decode whole (UTF-8 byte length ≥ decoded length); anything larger risks the uncatchable fatal
 *  above. Resolved defensively (`?.`/`??`) so a module-interop quirk can never leave it undefined. */
export const MAX_SINGLE_STRING_BYTES = nodeBuffer.constants?.MAX_STRING_LENGTH ?? 0x1fffffe8

/**
 * Iterate the lines of a Buffer WITHOUT ever holding it as one JS string. Byte-faithful to
 * `raw.split('\n')`: we split on the 0x0A byte only — UTF-8-safe, since a newline byte never occurs
 * inside a multi-byte sequence — and decode each inter-newline slice verbatim, so a trailing '\r'
 * survives exactly as split() leaves it (callers trim). The one divergence — we do not emit the empty
 * final element after a trailing '\n' — is immaterial: every caller skips blank lines. `onLine` may
 * return `false` to stop early (used by first-match lookups).
 */
export function forEachBufferLine(buf: Buffer, onLine: (line: string) => void | boolean): void {
  const len = buf.length
  let start = 0
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0x0a) {
      if (onLine(buf.toString('utf8', start, i)) === false) return
      start = i + 1
    }
  }
  if (start < len) onLine(buf.toString('utf8', start, len))
}

/** Bytes pulled per `readSync`. Large enough that a multi-GB shard costs a few hundred syscalls,
 *  small enough that peak RSS is a rounding error — the old whole-file read allocated a Buffer the
 *  size of the entire store (2.27 GB on the field machine that motivated this) just to walk it. */
const READ_CHUNK_BYTES = 8 * 1024 * 1024

/** Decode one line's bytes and hand it to the caller. A single line past V8's string cliff cannot be
 *  decoded at all without the uncatchable fatal described at the top of this file, so it is skipped
 *  rather than aborting the process — one absurd line lost beats every line lost. */
function emitLine(buf: Buffer, onLine: (line: string) => void | boolean): void | boolean {
  if (buf.length > MAX_SINGLE_STRING_BYTES) return
  return onLine(buf.toString('utf8'))
}

/**
 * Read a file and iterate its lines without ever materialising it as a single string — and without
 * ever materialising it as a single Buffer either.
 *
 * v1.27.4 fixed the V8 *string* cliff (~512 MiB) by reading the whole file as a Buffer and decoding
 * line by line. That left a second, lower ceiling in place: `fs.readFileSync` refuses ANY file larger
 * than `kIoMaxLength` (2**31-1 = 2 GiB) with `ERR_FS_FILE_TOO_LARGE`, Buffer or not. A real store
 * crossed it — a 2.27 GB `swarm-memory.jsonl` — and because reloadFrom's per-shard `catch` treats an
 * unreadable shard as an empty one, 311,680 memories silently failed to load and the brain came up
 * looking brand new.
 *
 * So: stream fixed-size chunks and carry the partial line across chunk boundaries as BYTES (never as
 * a decoded string, or a multi-byte character straddling the seam would be corrupted). No file-size
 * ceiling is left on this path. Output is identical to `forEachBufferLine` over the same content,
 * including the trailing-'' and no-empty-final-element behaviour callers rely on.
 *
 * Throws only if the file itself can't be opened — callers decide skip vs. return.
 */
export function forEachShardLine(file: string, onLine: (line: string) => void | boolean): void {
  const fd = fs.openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let carry: Buffer | null = null // bytes of a line still in flight across the chunk boundary
    let stopped = false
    for (;;) {
      const got = fs.readSync(fd, chunk, 0, READ_CHUNK_BYTES, null)
      if (got === 0) break
      let start = 0
      for (let i = 0; i < got; i++) {
        if (chunk[i] !== 0x0a) continue
        // `subarray` is a VIEW into `chunk`, which the next readSync overwrites — safe only because
        // it is decoded (or copied into `carry`) before we read again.
        const slice = chunk.subarray(start, i)
        const line = carry ? Buffer.concat([carry, slice]) : slice
        carry = null
        start = i + 1
        if (emitLine(line, onLine) === false) { stopped = true; break }
      }
      if (stopped) break
      if (start < got) {
        const tail = chunk.subarray(start, got)
        carry = carry ? Buffer.concat([carry, tail]) : Buffer.from(tail) // COPY — `chunk` is reused
      }
    }
    if (!stopped && carry && carry.length > 0) emitLine(carry, onLine)
  } finally {
    fs.closeSync(fd)
  }
}

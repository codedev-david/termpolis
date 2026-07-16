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

/** Read a file and iterate its lines without ever materialising it as a single string (see
 *  forEachBufferLine). Throws only if the file itself can't be read — callers decide skip vs. return. */
export function forEachShardLine(file: string, onLine: (line: string) => void | boolean): void {
  forEachBufferLine(fs.readFileSync(file), onLine)
}

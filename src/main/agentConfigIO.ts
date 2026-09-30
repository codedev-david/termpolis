// Reading and writing the agent CLIs' own JSON configs (Claude Code's settings.json and
// .claude.json, Gemini CLI's settings.json) without ever leaving one worse than it was:
//
//  - A file that doesn't parse is reported and left alone, never "repaired" by overwriting.
//  - A write lands in a temp file beside the real target and is renamed over it, so a crash
//    or a full disk mid-write leaves the old file whole. A symlinked config (dotfiles repos
//    do this) is written through the link, not replaced by a regular file.
//  - The file keeps its indent, line endings, BOM, final newline and permissions, so changing
//    one key shows up as a small diff in the user's dotfiles repo.
//  - Nothing is written unless the parsed content actually changed.
import { chmodSync, existsSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

/** Far larger than any real agent config. A bigger file is not one Termpolis should rewrite. */
export const MAX_CONFIG_BYTES = 32 * 1024 * 1024

export type JsonObjectRead =
  | { kind: 'missing' }
  | { kind: 'ok'; value: Record<string, any>; text: string }
  | { kind: 'error'; error: string }

export type JsonEditResult =
  | { status: 'written' }
  | { status: 'unchanged' }
  | { status: 'missing' }
  | { status: 'error'; error: string }

export function errorText(e: unknown): string {
  return (e as Error)?.message || String(e)
}

/** Read a JSON file whose top level must be an object. An empty file reads as `{}`. */
export function readJsonObject(path: string, cap = MAX_CONFIG_BYTES): JsonObjectRead {
  let text: string
  try {
    if (!existsSync(path)) return { kind: 'missing' }
    if (statSync(path).size > cap) return { kind: 'error', error: `larger than ${cap} bytes` }
    text = readFileSync(path, 'utf-8')
  } catch (e) {
    return { kind: 'error', error: errorText(e) }
  }
  const body = text.replace(/^\uFEFF/, '')
  if (!body.trim()) return { kind: 'ok', value: {}, text }
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (e) {
    return { kind: 'error', error: `not valid JSON (${errorText(e)})` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'error', error: 'top level is not a JSON object' }
  }
  return { kind: 'ok', value: value as Record<string, any>, text }
}

/** Serialize `value` in the style of `original`; null means a new file (2 spaces, LF, final newline). */
export function formatJsonLike(value: unknown, original: string | null): string {
  const src = original ?? ''
  const bom = src.startsWith('\uFEFF')
  const indentMatch = /\n([ \t]+)\S/.exec(src)
  const indent = !indentMatch ? 2 : indentMatch[1].startsWith('\t') ? '\t' : indentMatch[1].length
  const finalNewline = !src.trim() || /\n$/.test(src)
  let out = JSON.stringify(value, null, indent)
  if (finalNewline) out += '\n'
  // JSON.stringify escapes newlines inside strings, so every raw \n here is structural.
  if (src.includes('\r\n')) out = out.replace(/\n/g, '\r\n')
  return (bom ? '\uFEFF' : '') + out
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * rename(), retried briefly on Windows' transient sharing violations: an agent reading its
 * config, or a scanner holding the file, makes the rename fail for a few milliseconds.
 */
export function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  sleep: (ms: number) => void = sleepSync,
  attempts = 5,
): void {
  for (let i = 1; ; i++) {
    try {
      rename(from, to)
      return
    } catch (e) {
      if (i >= attempts || !RENAME_RETRY_CODES.has((e as NodeJS.ErrnoException)?.code ?? '')) throw e
      sleep(15 * i)
    }
  }
}

/**
 * The file a write to `path` must replace. A symlink is followed even when what it points
 * at does not exist yet (a dotfiles link made before the file was): renaming onto the link
 * itself would turn it into a plain file and cut it off from the dotfiles.
 */
function writeTarget(path: string): string {
  let target = path
  for (let hops = 0; hops < 32; hops++) {
    try { return realpathSync.native(target) } catch { /* missing, or a link to something missing */ }
    let link: string
    try { link = readlinkSync(target) } catch { return target } // not a link: a new file
    target = resolve(dirname(target), link)
  }
  throw new Error(`${path}: too many levels of symbolic links`)
}

/** Replace `path` with `text` atomically. Throws on failure, leaving the old file as it was. */
export function atomicWriteText(path: string, text: string): void {
  const target = writeTarget(path)
  let mode: number | undefined
  try { mode = statSync(target).mode & 0o777 } catch { /* a new file */ }
  const tmp = `${target}.termpolis-${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf-8', mode: mode ?? 0o666 })
    // writeFileSync's mode is filtered through the umask; the copy must match the original.
    if (mode !== undefined) chmodSync(tmp, mode)
    renameWithRetry(tmp, target)
  } catch (e) {
    // A read-only temp file can't be unlinked on Windows, so make it writable first.
    try { chmodSync(tmp, 0o600) } catch { /* never created */ }
    try { unlinkSync(tmp) } catch { /* never created */ }
    throw e
  }
}

/**
 * Read-modify-write one JSON config. `mutate` edits the parsed object in place, and the file
 * is written only when the result differs from what was read. A missing file is created only
 * with `create`, and only when `mutate` actually put something in it.
 */
export function editJsonObject(
  path: string,
  mutate: (obj: Record<string, any>) => void,
  opts: { create?: boolean } = {},
): JsonEditResult {
  const read = readJsonObject(path)
  if (read.kind === 'error') return { status: 'error', error: read.error }
  if (read.kind === 'missing' && !opts.create) return { status: 'missing' }
  const obj = read.kind === 'ok' ? read.value : {}
  const before = JSON.stringify(obj)
  try {
    mutate(obj)
  } catch (e) {
    return { status: 'error', error: errorText(e) }
  }
  if (JSON.stringify(obj) === before) return { status: 'unchanged' }
  try {
    atomicWriteText(path, formatJsonLike(obj, read.kind === 'ok' ? read.text : null))
  } catch (e) {
    return { status: 'error', error: errorText(e) }
  }
  return { status: 'written' }
}

/** Read a text file up to `cap` bytes: null when it doesn't exist. Throws on a read failure. */
export function readTextFile(path: string, cap = MAX_CONFIG_BYTES): string | null {
  if (!existsSync(path)) return null
  if (statSync(path).size > cap) throw new Error(`larger than ${cap} bytes`)
  return readFileSync(path, 'utf-8')
}

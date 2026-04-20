import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

/**
 * Context Pin Store — durable per-project list of "pinned" snippets
 * users want available to any agent in that project.
 *
 * Storage layout:
 *   <userData>/context-pins/<sha256(cwd).slice(0,16)>.json
 *
 * Each pin is a small JSON record; the file is an array of records.
 * We keep files per-project to avoid a single unbounded file and to
 * make cleanup/export simple.
 *
 * Security / safety:
 * - Writes constrained to the configured storage root
 * - Pin body capped (MAX_BODY_BYTES)
 * - Per-project pin count capped (MAX_PINS_PER_PROJECT)
 * - Atomic writes via tmp+rename
 * - IDs are generated internally — callers cannot supply arbitrary paths
 */

export interface ContextPin {
  id: string
  createdAt: number
  label: string
  body: string
  /** Optional source (agent name, tool, file) for display */
  source?: string
  /** Optional tags for grouping */
  tags?: string[]
}

export const MAX_BODY_BYTES = 16 * 1024
export const MAX_LABEL_BYTES = 200
export const MAX_PINS_PER_PROJECT = 100
const STORE_SUBDIR = 'context-pins'

let rootDir: string | null = null

export function initContextPinStore(userDataPath: string): void {
  if (!userDataPath || typeof userDataPath !== 'string') {
    throw new Error('initContextPinStore: userDataPath required')
  }
  if (!path.isAbsolute(userDataPath)) {
    throw new Error('initContextPinStore: userDataPath must be absolute')
  }
  rootDir = path.join(path.resolve(userDataPath), STORE_SUBDIR)
  try { fs.mkdirSync(rootDir, { recursive: true }) } catch { /* best-effort */ }
}

/** Hash a cwd path to a safe filename (never reveal absolute paths on disk) */
export function cwdKey(cwd: string): string {
  const normalized = (cwd || '').trim()
  if (!normalized) throw new Error('cwdKey: cwd required')
  const h = crypto.createHash('sha256').update(normalized).digest('hex')
  return h.slice(0, 16)
}

function fileFor(cwd: string): string {
  if (!rootDir) throw new Error('context pin store not initialized')
  const file = path.join(rootDir, `${cwdKey(cwd)}.json`)
  // Defensive: file must sit directly under rootDir
  const resolved = path.resolve(file)
  const rootResolved = path.resolve(rootDir) + path.sep
  if (!resolved.startsWith(rootResolved)) {
    throw new Error('context pin path escapes store')
  }
  return resolved
}

function readAll(cwd: string): ContextPin[] {
  let f: string
  try { f = fileFor(cwd) } catch { return [] }
  try {
    const raw = fs.readFileSync(f, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidPin)
  } catch {
    return []
  }
}

function writeAll(cwd: string, pins: ContextPin[]): void {
  const f = fileFor(cwd)
  const tmp = f + '.tmp'
  const payload = JSON.stringify(pins.slice(0, MAX_PINS_PER_PROJECT))
  fs.writeFileSync(tmp, payload, { encoding: 'utf-8' })
  try {
    fs.renameSync(tmp, f)
  } catch {
    // Windows: rename can race with antivirus / briefly held handles.
    // Fall back to overwrite in place, then clean up tmp.
    try { fs.writeFileSync(f, payload, { encoding: 'utf-8' }) } catch {}
    try { fs.unlinkSync(tmp) } catch {}
  }
}

function isValidPin(p: unknown): p is ContextPin {
  if (!p || typeof p !== 'object') return false
  const r = p as Record<string, unknown>
  return typeof r.id === 'string' && typeof r.label === 'string' && typeof r.body === 'string'
}

export function listPins(cwd: string): ContextPin[] {
  return readAll(cwd)
}

export function addPin(
  cwd: string,
  input: { label: string; body: string; source?: string; tags?: string[] },
): ContextPin {
  if (!cwd || typeof cwd !== 'string') throw new Error('cwd required')
  if (!input || typeof input !== 'object') throw new Error('pin input required')
  const label = String(input.label || '').slice(0, MAX_LABEL_BYTES).trim()
  if (!label) throw new Error('pin label required')
  const body = String(input.body || '').slice(0, MAX_BODY_BYTES)
  if (!body) throw new Error('pin body required')
  const source = input.source ? String(input.source).slice(0, 200) : undefined
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).slice(0, 60)).slice(0, 20)
    : undefined

  const pins = readAll(cwd)
  if (pins.length >= MAX_PINS_PER_PROJECT) {
    throw new Error(`pin limit reached (${MAX_PINS_PER_PROJECT})`)
  }
  const pin: ContextPin = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    label,
    body,
    source,
    tags,
  }
  pins.push(pin)
  writeAll(cwd, pins)
  return pin
}

export function removePin(cwd: string, id: string): boolean {
  if (!cwd || !id) return false
  const pins = readAll(cwd)
  const next = pins.filter((p) => p.id !== id)
  if (next.length === pins.length) return false
  writeAll(cwd, next)
  return true
}

export function updatePin(
  cwd: string,
  id: string,
  patch: Partial<Pick<ContextPin, 'label' | 'body' | 'source' | 'tags'>>,
): ContextPin | null {
  if (!cwd || !id) return null
  const pins = readAll(cwd)
  const idx = pins.findIndex((p) => p.id === id)
  if (idx === -1) return null
  const current = pins[idx]
  const next: ContextPin = {
    ...current,
    ...(patch.label != null
      ? { label: String(patch.label).slice(0, MAX_LABEL_BYTES) }
      : {}),
    ...(patch.body != null
      ? { body: String(patch.body).slice(0, MAX_BODY_BYTES) }
      : {}),
    ...(patch.source != null ? { source: String(patch.source).slice(0, 200) } : {}),
    ...(patch.tags != null
      ? {
          tags: Array.isArray(patch.tags)
            ? patch.tags.map((t) => String(t).slice(0, 60)).slice(0, 20)
            : undefined,
        }
      : {}),
  }
  pins[idx] = next
  writeAll(cwd, pins)
  return next
}

export function clearPins(cwd: string): void {
  if (!cwd) return
  writeAll(cwd, [])
}

/** Test-only: reset root pointer */
export function _resetForTests(): void {
  rootDir = null
}

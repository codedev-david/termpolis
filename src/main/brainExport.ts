// brainExport.ts — export/import the FULL brain (memories + knowledge graph + learning stores +
// code graph) to/from a portable .zip, so you can move it between machines via any cloud yourself.
//
// Integrity is the whole point: the archive is a real .zip (each entry CRC-checked by zipArchive),
// AND the manifest carries a SHA-256 of every file. On import we verify EVERY hash BEFORE applying
// anything — so a file corrupted while zipping or uploading is rejected outright, never half-merged.
//
// Import is a grow-only CRDT MERGE (additive): memories and edges union into the target, and the
// device-local learning files are restored only when absent (a fresh machine), never clobbering an
// existing brain. The per-machine identity (deviceId), sync config, and salt are deliberately NOT
// exported — copying the deviceId would recreate the double-writer corruption v1.19.4 fixed.

import * as crypto from 'crypto'
import { createZip, readZip, type ZipEntry } from './zipArchive'

export const BRAIN_EXPORT_VERSION = 1
export const MEMORY_ENTRY = 'memory.jsonl'
export const GRAPH_ENTRY = 'memory-graph.jsonl'
export const MANIFEST_ENTRY = 'manifest.json'

// Device-local brain files (by name under userData) carried in the archive. memory-graph.jsonl is
// exported from the LIVE graph instead; the rest are restored-if-absent on import.
export const RESTORE_FILES = ['memory-deletes.json', 'memory-forgot.json', 'mneme-competence.jsonl', 'mneme-identity.jsonl', 'memory-metrics.jsonl', 'code-graph.json'] as const

export interface BrainManifest {
  version: number
  app: string
  exportedAt: number
  files: Record<string, string> // entry name -> sha256(content) hex
  memories: number
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export interface ExportDeps {
  memorySnapshot: () => string
  graphSnapshot: () => string
  readFile: (name: string) => Buffer | null // read a userData file by name; null if absent
  appVersion: string
  now: number
}

/** Assemble the brain .zip. Every content entry is hashed into the manifest. */
export function buildBrainZip(deps: ExportDeps): Buffer {
  const entries: ZipEntry[] = []
  const files: Record<string, string> = {}
  const add = (name: string, data: Buffer): void => {
    entries.push({ name, data })
    files[name] = sha256(data)
  }

  const memStr = deps.memorySnapshot()
  add(MEMORY_ENTRY, Buffer.from(memStr, 'utf8'))
  const graph = deps.graphSnapshot()
  if (graph) add(GRAPH_ENTRY, Buffer.from(graph, 'utf8'))
  for (const name of RESTORE_FILES) {
    const data = deps.readFile(name)
    if (data && data.length > 0) add(name, data)
  }

  const manifest: BrainManifest = {
    version: BRAIN_EXPORT_VERSION,
    app: deps.appVersion,
    exportedAt: deps.now,
    files,
    memories: memStr ? memStr.split('\n').filter((l) => l.trim() && !l.includes('"reinforce"')).length : 0,
  }
  // manifest.json is not self-referential (it holds the OTHER files' hashes) and rides on the zip's
  // own CRC; a malformed manifest is caught on import (JSON.parse) and refuses the whole archive.
  entries.unshift({ name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
  return createZip(entries)
}

export interface ImportDeps {
  importMemory: (jsonl: string) => { imported: number }
  importGraph: (jsonl: string) => number
  restoreFile: (name: string, data: Buffer) => void // restore a userData file (impl decides absent-only)
}

export interface ImportResult {
  ok: boolean
  error?: string
  memoriesImported: number
  edgesImported: number
  restored: string[]
}

const fail = (error: string): ImportResult => ({ ok: false, error, memoriesImported: 0, edgesImported: 0, restored: [] })

/** Verify + merge a brain .zip. Verifies the zip CRCs (readZip) AND every manifest SHA-256 BEFORE
 *  applying anything — so corruption from zipping or uploading is rejected, not partially imported. */
export function importBrainZip(zipBuf: Buffer, deps: ImportDeps): ImportResult {
  let entries: ZipEntry[]
  try {
    entries = readZip(zipBuf)
  } catch (e) {
    return fail(`Corrupt archive: ${(e as Error).message}`)
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]))

  const manRaw = byName.get(MANIFEST_ENTRY)
  if (!manRaw) return fail('This is not a Termpolis brain export (no manifest).')
  let manifest: BrainManifest
  try {
    manifest = JSON.parse(manRaw.toString('utf8'))
  } catch {
    return fail('The archive manifest is malformed — refusing to import.')
  }
  if (!manifest || typeof manifest.version !== 'number' || typeof manifest.files !== 'object' || !manifest.files) {
    return fail('The archive manifest is invalid — refusing to import.')
  }
  if (manifest.version > BRAIN_EXPORT_VERSION) {
    return fail(`This archive was made by a newer Termpolis (format v${manifest.version}); please update to import it.`)
  }

  // Integrity gate: EVERY file the manifest claims must be present and hash-match, checked in full
  // before a single byte is merged.
  for (const [name, expected] of Object.entries(manifest.files)) {
    const data = byName.get(name)
    if (!data) return fail(`Archive is missing ${name} — refusing to import a partial brain.`)
    if (sha256(data) !== expected) return fail(`Integrity check failed for ${name} — the archive is corrupt or was modified.`)
  }

  // All verified → apply the merge.
  const mem = byName.get(MEMORY_ENTRY)
  const memoriesImported = mem ? deps.importMemory(mem.toString('utf8')).imported : 0
  const graph = byName.get(GRAPH_ENTRY)
  const edgesImported = graph ? deps.importGraph(graph.toString('utf8')) : 0
  const restored: string[] = []
  for (const name of RESTORE_FILES) {
    const data = byName.get(name)
    if (data) {
      deps.restoreFile(name, data)
      restored.push(name)
    }
  }
  return { ok: true, memoriesImported, edgesImported, restored }
}

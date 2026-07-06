import { describe, it, expect, vi } from 'vitest'
import { buildBrainZip, importBrainZip, MEMORY_ENTRY, MANIFEST_ENTRY, BRAIN_EXPORT_VERSION, type ExportDeps } from '../../src/main/brainExport'
import { createZip, readZip } from '../../src/main/zipArchive'

function exportDeps(over: Partial<ExportDeps> = {}): ExportDeps {
  return {
    memorySnapshot: () => '{"id":"m1","content":"alpha"}\n{"id":"m2","content":"bravo"}\n{"reinforce":[{"id":"m1","used":2,"ts":1}]}\n',
    graphSnapshot: () => '{"from":"m1","to":"m2","relation":"follows"}',
    readFile: (name) => (name === 'mneme-competence.jsonl' ? Buffer.from('{"domain":"x","attempts":3}') : null),
    appVersion: '1.21.0',
    now: 1700000000000,
    ...over,
  }
}
const noopImport = () => ({ importMemory: vi.fn().mockReturnValue({ imported: 0 }), importGraph: vi.fn().mockReturnValue(0), restoreFile: vi.fn() })

describe('brainExport', () => {
  it('builds a zip with manifest + memory + live graph + present files (absent files skipped)', () => {
    const names = readZip(buildBrainZip(exportDeps())).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining([MANIFEST_ENTRY, MEMORY_ENTRY, 'memory-graph.jsonl', 'mneme-competence.jsonl']))
    expect(names).not.toContain('mneme-identity.jsonl') // readFile returned null → not bundled
    const manifest = JSON.parse(readZip(buildBrainZip(exportDeps())).find((e) => e.name === MANIFEST_ENTRY)!.data.toString())
    expect(manifest.version).toBe(BRAIN_EXPORT_VERSION)
    expect(manifest.memories).toBe(2) // 2 add lines, reinforce not counted
    expect(Object.keys(manifest.files)).toContain(MEMORY_ENTRY)
  })

  it('round-trips: the exported zip imports and MERGES (additive)', () => {
    const zip = buildBrainZip(exportDeps())
    const d = { importMemory: vi.fn().mockReturnValue({ imported: 2 }), importGraph: vi.fn().mockReturnValue(1), restoreFile: vi.fn() }
    const res = importBrainZip(zip, d)
    expect(res.ok).toBe(true)
    expect(res.memoriesImported).toBe(2)
    expect(res.edgesImported).toBe(1)
    expect(d.importMemory).toHaveBeenCalledWith(expect.stringContaining('"id":"m1"'))
    expect(d.importGraph).toHaveBeenCalledWith(expect.stringContaining('"from":"m1"'))
    expect(res.restored).toContain('mneme-competence.jsonl')
  })

  it('REJECTS content tampering via the manifest SHA-256 gate (CRC alone would pass)', () => {
    const zip = buildBrainZip(exportDeps())
    // Re-zip with memory.jsonl content changed but the ORIGINAL manifest (stale hash) kept — a valid
    // zip with a correct CRC for the new bytes, so only the SHA-256 gate can catch it.
    const tampered = readZip(zip).map((e) => (e.name === MEMORY_ENTRY ? { name: e.name, data: Buffer.from('{"id":"EVIL","content":"pwned"}\n') } : e))
    const d = noopImport()
    const res = importBrainZip(createZip(tampered), d)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/integrity check failed/i)
    expect(d.importMemory).not.toHaveBeenCalled() // nothing applied
  })

  it('REJECTS a structurally-corrupt (truncated) archive before applying anything', () => {
    const zip = buildBrainZip(exportDeps())
    const d = noopImport()
    const res = importBrainZip(zip.subarray(0, Math.floor(zip.length / 2)), d)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/corrupt|missing/i) // truncation → intact prefix read, then a manifest-listed file is absent
    expect(d.importMemory).not.toHaveBeenCalled()
  })

  it('REJECTS a zip that is not a brain export (no manifest)', () => {
    const res = importBrainZip(createZip([{ name: 'random.txt', data: Buffer.from('hi') }]), noopImport())
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not a termpolis brain export/i)
  })

  it('REJECTS an archive from a newer format version', () => {
    const zip = createZip([{ name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify({ version: 99, app: 'x', exportedAt: 0, files: {}, memories: 0 })) }])
    const res = importBrainZip(zip, noopImport())
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/newer termpolis/i)
  })
})

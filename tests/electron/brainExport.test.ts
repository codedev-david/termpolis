import { describe, it, expect, vi } from 'vitest'
import { buildBrainZip, importBrainZip, MEMORY_ENTRY, MANIFEST_ENTRY, BRAIN_EXPORT_VERSION, type ExportDeps } from '../../src/main/brainExport'
import { createZip, readZip } from '../../src/main/zipArchive'
import { MAX_SINGLE_STRING_BYTES } from '../../src/main/fileLines'

const RUN_HUGE_STORE_TEST = process.env.RUN_HUGE_STORE_TEST === '1'

function exportDeps(over: Partial<ExportDeps> = {}): ExportDeps {
  return {
    memorySnapshot: () => ['{"id":"m1","content":"alpha"}', '{"id":"m2","content":"bravo"}', '{"reinforce":[{"id":"m1","used":2,"ts":1}]}'],
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

  // v1.26: importBrainZip is async — importMemory crosses to the memory process. Everything it
  // rejects below is still rejected BEFORE any dep is called, so verify-before-apply is unchanged.
  it('round-trips: the exported zip imports and MERGES (additive)', async () => {
    const zip = buildBrainZip(exportDeps())
    const d = { importMemory: vi.fn().mockResolvedValue({ imported: 2 }), importGraph: vi.fn().mockReturnValue(1), restoreFile: vi.fn() }
    const res = await importBrainZip(zip, d)
    expect(res.ok).toBe(true)
    expect(res.memoriesImported).toBe(2)
    expect(res.edgesImported).toBe(1)
    expect(d.importMemory).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('"id":"m1"')]))
    expect(d.importGraph).toHaveBeenCalledWith(expect.stringContaining('"from":"m1"'))
    expect(res.restored).toContain('mneme-competence.jsonl')
  })

  it('REJECTS content tampering via the manifest SHA-256 gate (CRC alone would pass)', async () => {
    const zip = buildBrainZip(exportDeps())
    // Re-zip with memory.jsonl content changed but the ORIGINAL manifest (stale hash) kept — a valid
    // zip with a correct CRC for the new bytes, so only the SHA-256 gate can catch it.
    const tampered = readZip(zip).map((e) => (e.name === MEMORY_ENTRY ? { name: e.name, data: Buffer.from('{"id":"EVIL","content":"pwned"}\n') } : e))
    const d = noopImport()
    const res = await importBrainZip(createZip(tampered), d)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/integrity check failed/i)
    expect(d.importMemory).not.toHaveBeenCalled() // nothing applied
  })

  it('REJECTS a structurally-corrupt (truncated) archive before applying anything', async () => {
    const zip = buildBrainZip(exportDeps())
    const d = noopImport()
    const res = await importBrainZip(zip.subarray(0, Math.floor(zip.length / 2)), d)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/corrupt|missing/i) // truncation → intact prefix read, then a manifest-listed file is absent
    expect(d.importMemory).not.toHaveBeenCalled()
  })

  it('REJECTS a zip that is not a brain export (no manifest)', async () => {
    const res = await importBrainZip(createZip([{ name: 'random.txt', data: Buffer.from('hi') }]), noopImport())
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not a termpolis brain export/i)
  })

  it('REJECTS an archive from a newer format version', async () => {
    const zip = createZip([{ name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify({ version: 99, app: 'x', exportedAt: 0, files: {}, memories: 0 })) }])
    const res = await importBrainZip(zip, noopImport())
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/newer termpolis/i)
  })

  it('REJECTS a manifest missing required fields', async () => {
    const zip = createZip([{ name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify({ app: 'x' })) }])
    expect((await importBrainZip(zip, noopImport())).error).toMatch(/invalid/i)
  })

  it('skips an empty graph + empty files, and counts zero memories cleanly', () => {
    const zip = buildBrainZip(exportDeps({ graphSnapshot: () => '', readFile: () => Buffer.from(''), memorySnapshot: () => [] }))
    const entries = readZip(zip)
    const names = entries.map((e) => e.name)
    expect(names).toContain(MEMORY_ENTRY)
    expect(names).not.toContain('memory-graph.jsonl') // empty graph → not bundled
    expect(names).not.toContain('mneme-competence.jsonl') // empty file → not bundled
    expect(JSON.parse(entries.find((e) => e.name === MANIFEST_ENTRY)!.data.toString()).memories).toBe(0)
  })

  it('export→import round-trips the memory lines faithfully (string[] in, string[] out — no join)', async () => {
    const lines = ['{"id":"a","content":"one"}', '{"id":"b","content":"two"}', '{"reinforce":[{"id":"a","used":1,"ts":1}]}']
    const zip = buildBrainZip(exportDeps({ memorySnapshot: () => lines }))
    let received: string[] | null = null
    const res = await importBrainZip(zip, {
      importMemory: (l) => { received = l; return { imported: l.length } },
      importGraph: () => 0,
      restoreFile: () => {},
    })
    expect(res.ok).toBe(true)
    expect(received).toEqual(lines) // exactly the exported lines come back — byte-faithful, no giant string built
  })

  // The whole point of the string[] change: a brain past V8's ~512 MiB max string length used to throw
  // RangeError on export (lines.join) AND again on import (buffer.toString). Gated — it allocates
  // >512 MiB; run on demand: RUN_HUGE_STORE_TEST=1 npx vitest run tests/electron/brainExport.test.ts
  ;(RUN_HUGE_STORE_TEST ? it : it.skip)('exports + imports a brain LARGER than V8 max string length without RangeError', async () => {
    const chunk = 'y'.repeat(10_000)
    const n = Math.ceil((MAX_SINGLE_STRING_BYTES + 8 * 1024 * 1024) / (chunk.length + 40))
    const lines = Array.from({ length: n }, (_, i) => `{"id":"big-${i}","content":"${chunk}"}`)
    // The joined size would exceed the cliff — exactly what the old lines.join('\n') tried to build.
    expect(n * (chunk.length + 20)).toBeGreaterThan(MAX_SINGLE_STRING_BYTES)
    const zip = buildBrainZip(exportDeps({ memorySnapshot: () => lines, graphSnapshot: () => '', readFile: () => null }))
    let count = 0
    const res = await importBrainZip(zip, {
      importMemory: (l) => { count = l.length; return { imported: l.length } },
      importGraph: () => 0,
      restoreFile: () => {},
    })
    expect(res.ok).toBe(true)
    expect(count).toBe(n) // every line survived export→zip→import; no >512 MiB string ever built
  }, 300_000)
})

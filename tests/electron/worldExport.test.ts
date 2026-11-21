// The export assembler in main (src/main/world/export.ts): the offline page an exported world becomes (spec 5.3),
// written through a .part name and a rename, the Ask index embedded in chunks, the documentation file, the size
// estimate and where the export finds its runtime, wasm and model. File operations are injected; the page itself is
// decoded back (gunzip of every block) and checked as the runtime would read it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { askEntries, packInt8 } from '../../src/shared/world/askIndex'
import { isMeta, pageMeta, type PageMeta } from '../../src/shared/world/exportMeta'
import { applyDesignPatch, REMOVALS_ID } from '../../src/shared/world/designPatch'
import { OUTSIDE, sanitizeText, sanitizeWorld, type SanitizeContext } from '../../src/shared/world/exportSanitize'
import type { WorldDoc } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import {
  CANCELLED, DEFAULT_EXPORT_SIZES, describedShare, EMBED_CHUNK, estimateExportBytes, EXPORT_CSP, exportPageHtml, exportWorld,
  FILE_IN_USE, NO_ACCESS, NO_MODEL, NO_PROPOSAL, NO_RUNTIME, NO_SPACE, resolveExportAssets, SMART_DEFAULT_SHARE, writeDocument,
  type ExportAssets, type ExportDeps, type ExportFs, type ExportProgress, type ExportRequest, type ExportSizes,
} from '../../src/main/world/export'
import { embedBatch } from '../../src/main/localEmbedder'
import { describedWorld, designWorld, labelledWorld, linkedDesignWorld } from '../fixtures/world/docWorlds'

const SPEC_CSP = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; worker-src blob:; connect-src 'none'"
const HOME = 'C:/Users/someone'
const CTX: SanitizeContext = { root: `${HOME}/repos/shop`, home: HOME, userData: `${HOME}/AppData/Roaming/Termpolis` }
const TARGET = 'D:/out/Shop - Lumopolis.html'

const fixture = (): WorldDoc => JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'world', 'termpolis.world.json'), 'utf8')) as WorldDoc

// The export's own files, in memory: a small runtime, a wasm and a model of random bytes, and a tokenizer.
const RUNTIME = '(function(){window.__exported=1})()\n'
const MODEL_DIR = join('M:', 'models', 'bge')
const ASSETS: ExportAssets = { runtimeJs: join('R:', 'world-export.js'), ortWasm: join('R:', 'ort.wasm'), modelDir: MODEL_DIR, modelFile: join(MODEL_DIR, 'onnx', 'model.onnx') }
const noise = (n: number, seed: number): Uint8Array => {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24 }
  return out
}
const WASM = noise(20_000, 1)
const MODEL = noise(50_000, 2)
const TOKENIZER = { model: { vocab: { '[PAD]': 0, '[UNK]': 1, hello: 2 } }, note: '</script><!--' }
const TOKENIZER_CONFIG = { do_lower_case: true }

/** A file system in memory: what the export reads, every call it makes, and failures to inject. */
function memFs(over: { write?: (path: string) => Error | undefined; rename?: Error; onWrite?: () => void; missing?: string[]; stat?: Error } = {}) {
  const files = new Map<string, Uint8Array>([
    [ASSETS.runtimeJs, Buffer.from(RUNTIME)], [ASSETS.ortWasm, WASM], [ASSETS.modelFile, MODEL],
    [join(MODEL_DIR, 'tokenizer.json'), Buffer.from(JSON.stringify(TOKENIZER))],
    [join(MODEL_DIR, 'tokenizer_config.json'), Buffer.from(JSON.stringify(TOKENIZER_CONFIG))],
  ])
  for (const m of over.missing ?? []) files.delete(m)
  const calls: string[] = []
  const written = new Map<string, string>()
  const fs: ExportFs = {
    readFile: vi.fn(async (p: string) => {
      const f = files.get(p)
      if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return f
    }),
    writeFile: vi.fn(async (p: string, data: string | Uint8Array) => {
      calls.push(`write ${p}`)
      over.onWrite?.()
      const err = over.write?.(p)
      if (err) throw err
      written.set(p, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    }),
    rename: vi.fn(async (from: string, to: string) => {
      calls.push(`rename ${from} -> ${to}`)
      if (over.rename) throw over.rename
      written.set(to, written.get(from) as string)
      written.delete(from)
    }),
    rm: vi.fn(async (p: string) => {
      calls.push(`rm ${p}`)
      written.delete(p)
    }),
    stat: vi.fn(async (p: string) => {
      if (over.stat) throw over.stat
      return { size: Buffer.byteLength(written.get(p) as string, 'utf8') }
    }),
  }
  return { fs, calls, written }
}

const coded = (code: string): Error => Object.assign(new Error(code), { code })

/** A deterministic unit vector per text, like the embedder's (384 wide, spread values). */
const vectorFor = (text: string): number[] => {
  const bytes = noise(384, [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7))
  const v = Array.from(bytes, (b) => (b - 127.5) / 127.5)
  const n = Math.hypot(...v)
  return v.map((x) => x / n)
}
const embedAll = vi.fn(async (texts: string[]) => texts.map(vectorFor))

function deps(over: Partial<ExportDeps> & { mem?: ReturnType<typeof memFs> } = {}) {
  const mem = over.mem ?? memFs()
  const progress: ExportProgress[] = []
  const d: ExportDeps = {
    assets: ASSETS, embed: embedAll, fs: mem.fs, signal: new AbortController().signal, progress: (p) => progress.push(p), ...over,
  }
  return { d, mem, progress }
}

const request = (over: Partial<ExportRequest> = {}): ExportRequest =>
  ({ doc: labelledWorld(), ctx: CTX, title: 'Shop', smart: true, target: TARGET, exportedOn: '2026-11-21', ...over })

/** A design world has no folder. */
const DESIGN_CTX: SanitizeContext = { root: null, home: HOME, userData: CTX.userData }
/** The design world with a part taken away (removePart stores it in layers.plan) and a later proposal naming a home path. */
function designWithRemovals(): WorldDoc {
  const doc = applyDesignPatch(designWorld(), [{ op: 'removePart', id: 'b2' }]).doc
  doc.layers.plan.unshift({
    id: 'later', title: 'Later', summary: [{ text: `Keeps notes in ${HOME}/notes/plan.md.`, state: 'proposed', evidence: [{ kind: 'person', ref: 'David' }] }], buildings: [], edges: [],
  })
  return doc
}

/** Every data block of a page, in order: its id and decoded bytes. */
function blocksOf(html: string): { id: string; bytes: Buffer; raw: string }[] {
  const re = /<script type="application\/octet-stream" id="([a-z0-9]+)" data-enc="gz64">([^<]*)<\/script>/g
  return [...html.matchAll(re)].map((m) => ({ id: m[1], raw: m[2], bytes: gunzipSync(Buffer.from(m[2], 'base64')) }))
}
const jsonBlock = <T>(html: string, id: string): T => JSON.parse(blocksOf(html).find((b) => b.id === id)!.bytes.toString('utf8')) as T
const pageAt = (mem: ReturnType<typeof memFs>): string => mem.written.get(TARGET) as string
const scriptTags = (html: string): number => html.split('<script').length - 1

afterEach(() => {
  vi.clearAllMocks()
})

describe('exportPageHtml', () => {
  const parts = { title: 'Shop', blocks: [{ id: 'world', gz64: 'AAAA' }, { id: 'meta', gz64: 'QUJD' }], runtimeJs: RUNTIME }

  it('writes meta charset, viewport, title, the CSP, inline CSS, the blocks, then one classic script', () => {
    const html = exportPageHtml(parts)
    const at = (s: string): number => html.indexOf(s)
    const order = ['<meta charset="utf-8">', '<meta name="viewport"', '<title>Shop · Lumopolis</title>', '<meta http-equiv="Content-Security-Policy"', '<style>', 'id="world"', 'id="meta"', `<script>${RUNTIME}</script>`]
    order.forEach((s) => expect(at(s), s).toBeGreaterThan(-1))
    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b))
    expect(html.startsWith('<!doctype html>')).toBe(true)
    const runtimeAt = at(`<script>${RUNTIME}`)
    for (const m of html.matchAll(/data-enc="gz64"/g)) expect(m.index).toBeLessThan(runtimeAt)
    expect(scriptTags(html)).toBe(3)
  })

  it('carries the spec CSP exactly, wasm-unsafe-eval included', () => {
    expect(EXPORT_CSP).toBe(SPEC_CSP)
    expect(exportPageHtml(parts)).toContain(`<meta http-equiv="Content-Security-Policy" content="${SPEC_CSP}">`)
  })

  it('escapes a hostile title: no markup gets out of <title>, quotes and ampersands included', () => {
    const title = `</title><script>alert("x")</script>&'${'long '.repeat(200)}\u05e9\u05dc\u05d5\u05dd`
    const html = exportPageHtml({ ...parts, title })
    expect(scriptTags(html)).toBe(3)
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;long ')
    expect(html).toContain('\u05e9\u05dc\u05d5\u05dd · Lumopolis</title>')
    expect(html.match(/<\/title>/g)).toHaveLength(1)
  })

  it('refuses a runtime that holds "</script" or "<!--", in any case', () => {
    expect(() => exportPageHtml({ ...parts, runtimeJs: 'var a="</SCRIPT>"' })).toThrow(/runtime/)
    expect(() => exportPageHtml({ ...parts, runtimeJs: 'var a="<!--"' })).toThrow(/runtime/)
  })

  it('refuses a block that is not base64 or whose id is not plain letters and digits', () => {
    expect(() => exportPageHtml({ ...parts, blocks: [{ id: 'world', gz64: 'AA</script>' }] })).toThrow(/not base64/)
    expect(() => exportPageHtml({ ...parts, blocks: [{ id: 'a" onload="x', gz64: 'AAAA' }] })).toThrow(/block id/)
    expect(() => exportPageHtml({ ...parts, blocks: [{ id: '', gz64: 'AAAA' }] })).toThrow(/block id/)
  })
})

describe('exportWorld: the page', () => {
  it('a smart page carries world, meta, ask, askvec, vocab, ortwasm and model, each as the runtime reads it', async () => {
    const { d, mem } = deps()
    const req = request()
    const r = await exportWorld(req, d)
    const html = pageAt(mem)
    expect(r).toEqual({ ok: true, path: TARGET, bytes: Buffer.byteLength(html, 'utf8') })
    const blocks = blocksOf(html)
    expect(blocks.map((b) => b.id)).toEqual(['world', 'meta', 'ask', 'askvec', 'vocab', 'ortwasm', 'model'])
    const world = jsonBlock<WorldDoc>(html, 'world')
    expect(validateWorld(world).ok).toBe(true)
    const ask = jsonBlock<{ version: number; entries: { id: string; text: string }[]; dim: number; scales: number[] }>(html, 'ask')
    expect(ask.entries).toEqual(askEntries(world))
    expect(ask.dim).toBe(384)
    expect(ask.scales).toHaveLength(ask.entries.length)
    expect(blocks[3].bytes.length).toBe(ask.entries.length * 384)
    expect(jsonBlock(html, 'vocab')).toEqual({ tokenizer: TOKENIZER, tokenizerConfig: TOKENIZER_CONFIG })
    expect(Buffer.compare(blocks[5].bytes, Buffer.from(WASM))).toBe(0)
    expect(Buffer.compare(blocks[6].bytes, Buffer.from(MODEL))).toBe(0)
    expect(html.endsWith(`<script>${RUNTIME}</script>\n</body>\n</html>\n`)).toBe(true)
    // Passages are embedded as they are (no query prefix), every entry once, in chunks.
    expect(embedAll.mock.calls.flatMap((c) => c[0])).toEqual(ask.entries.map((e) => e.text))
  })

  it('a keyword page carries only world, meta and ask, embeds nothing and reads no model file', async () => {
    const { d, mem } = deps()
    const r = await exportWorld(request({ smart: false }), d)
    expect(r.ok).toBe(true)
    const html = pageAt(mem)
    expect(blocksOf(html).map((b) => b.id)).toEqual(['world', 'meta', 'ask'])
    for (const id of ['askvec', 'vocab', 'ortwasm', 'model']) expect(html).not.toContain(`id="${id}"`)
    expect(jsonBlock<{ scales: number[] }>(html, 'ask').scales).toEqual([])
    expect(embedAll).not.toHaveBeenCalled()
    expect(vi.mocked(mem.fs.readFile).mock.calls.map((c) => c[0])).toEqual([ASSETS.runtimeJs])
  })

  it('a hostile building name stays inside its block: the page has exactly one <script per block, plus the runtime', async () => {
    const doc = labelledWorld()
    doc.buildings[0].name = '</script><script>alert(1)</script><!--'
    for (const smart of [true, false]) {
      const { d, mem } = deps()
      await exportWorld(request({ doc, smart }), d)
      const html = pageAt(mem)
      expect(scriptTags(html)).toBe(blocksOf(html).length + 1)
      expect(html).not.toContain('alert(1)')
      expect(jsonBlock<WorldDoc>(html, 'world').buildings[0].name).toBe('</script><script>alert(1)</script><!--')
      // safeJson: no "<" is left in any JSON block, even before it is encoded.
      for (const id of ['world', 'meta', 'ask']) expect(blocksOf(html).find((b) => b.id === id)!.bytes.toString('utf8')).not.toContain('<')
    }
  })

  it('runs the sanitiser: the page never holds the home folder, and a path outside the project is renamed', async () => {
    const doc = labelledWorld()
    doc.buildings[0].members = [`${HOME}/repos/shop/src/a.ts`, `${HOME}/notes/plan.md`]
    doc.buildings[0].how[0].text = `Reads ${HOME}/.config/shop.json at start.`
    doc.edges[0].label = `writes ${CTX.userData}/cache`
    for (const smart of [true, false]) {
      const { d, mem } = deps()
      await exportWorld(request({ doc, smart }), d)
      const html = pageAt(mem)
      const text = [html, ...blocksOf(html).filter((b) => ['world', 'meta', 'ask', 'vocab'].includes(b.id)).map((b) => b.bytes.toString('utf8'))].join('\n')
      expect(text).not.toContain(HOME)
      expect(text).not.toContain('someone')
      expect(jsonBlock<WorldDoc>(html, 'world').buildings[0].members).toEqual(['src/a.ts', `${OUTSIDE}/plan.md`])
    }
  })

  it('names the project from the request title and the commit from sourceRevision, never from the project key', async () => {
    const { d, mem } = deps()
    const doc = labelledWorld()
    doc.projectKey = 'a3f9c2e1d0b4'
    doc.sourceRevision = { head: '0123456789abcdef0123456789abcdef01234567', dirty: true }
    await exportWorld(request({ doc, title: 'Shop & Co <beta>', smart: false }), d)
    const html = pageAt(mem)
    expect(html).toContain('<title>Shop &amp; Co &lt;beta&gt; · Lumopolis</title>')
    const meta = jsonBlock<PageMeta>(html, 'meta')
    expect(meta).toEqual({ project: 'Shop & Co <beta>', exportedOn: '2026-11-21', head7: '0123456', dirty: true })
    expect(html).not.toContain('a3f9c2e1d0b4')
  })

  it('a whole-world export draws no proposal; a proposal export keeps only that one, selected on open', async () => {
    const whole = deps()
    await exportWorld(request({ doc: linkedDesignWorld(), smart: false }), whole.d)
    const wholeHtml = pageAt(whole.mem)
    expect(jsonBlock<WorldDoc>(wholeHtml, 'world').layers.plan).toEqual([])
    const wholeMeta = jsonBlock<PageMeta>(wholeHtml, 'meta')
    expect('proposalId' in wholeMeta).toBe(false)
    expect(isMeta(wholeMeta)).toBe(true)

    const one = deps()
    const all = linkedDesignWorld().layers.plan
    expect(all.length).toBeGreaterThan(1)
    await exportWorld(request({ doc: linkedDesignWorld(), smart: false, proposalId: all[1].id }), one.d)
    const oneHtml = pageAt(one.mem)
    expect(jsonBlock<WorldDoc>(oneHtml, 'world').layers.plan.map((p) => p.id)).toEqual([all[1].id])
    const meta = jsonBlock<PageMeta>(oneHtml, 'meta')
    expect(meta.proposalId).toBe(all[1].id)
    expect(isMeta(meta)).toBe(true)
  })

  it('a design world, with no commit, writes an empty head7 that still passes the page check', async () => {
    const { d, mem } = deps()
    await exportWorld(request({ doc: designWorld(), smart: false }), d)
    const meta = jsonBlock<PageMeta>(pageAt(mem), 'meta')
    expect(meta.head7).toBe('')
    expect(isMeta(meta)).toBe(true)
    expect(jsonBlock<WorldDoc>(pageAt(mem), 'world').projectKey).toBe('design:7f3a')
  })

  it('a design world exports its whole plan, sanitised: the removals it stores there and its other proposals', async () => {
    const doc = designWithRemovals()
    expect(doc.layers.plan.map((p) => p.id)).toEqual(['later', REMOVALS_ID])
    for (const smart of [true, false]) {
      const { d, mem } = deps()
      const r = await exportWorld(request({ doc, ctx: DESIGN_CTX, smart, title: 'Shop design' }), d)
      expect(r.ok, JSON.stringify(r)).toBe(true)
      const html = pageAt(mem)
      const world = jsonBlock<WorldDoc>(html, 'world')
      expect(world.layers.plan).toEqual(sanitizeWorld(doc, DESIGN_CTX).layers.plan)
      expect(world.layers.plan.find((p) => p.id === REMOVALS_ID)?.removes).toEqual(['b2'])
      expect(world.layers.plan[0].summary[0].text).toBe(`Keeps notes in ${OUTSIDE}/plan.md.`)
      expect(blocksOf(html).find((b) => b.id === 'world')!.bytes.toString('utf8')).not.toContain(HOME)
      // A design export is the design, not a proposal export: the page shows the plan on its own (controls.ts).
      expect('proposalId' in jsonBlock<PageMeta>(html, 'meta')).toBe(false)
      expect(jsonBlock<{ entries: { id: string }[] }>(html, 'ask').entries).toEqual(askEntries(world))
    }
  })

  it('a proposal export of a design world still keeps only that proposal', async () => {
    const { d, mem } = deps()
    await exportWorld(request({ doc: designWithRemovals(), ctx: DESIGN_CTX, smart: false, proposalId: REMOVALS_ID }), d)
    expect(jsonBlock<WorldDoc>(pageAt(mem), 'world').layers.plan.map((p) => p.id)).toEqual([REMOVALS_ID])
    expect(jsonBlock<PageMeta>(pageAt(mem), 'meta').proposalId).toBe(REMOVALS_ID)
  })

  it('sanitises the title too: a path in it never reaches <title> or meta.project', async () => {
    const title = `${HOME}/repos/shop`
    const { d, mem } = deps()
    await exportWorld(request({ title, smart: false }), d)
    const html = pageAt(mem)
    const meta = jsonBlock<PageMeta>(html, 'meta')
    expect(meta.project).toBe(sanitizeText(title, CTX))
    expect(meta.project).not.toContain(HOME)
    expect(html).not.toContain(HOME)
    expect(html).toContain(`<title>${meta.project.replace(/</g, '&lt;').replace(/>/g, '&gt;')} · Lumopolis</title>`)
  })

  it('checks the world before the sanitiser reads it: a malformed doc is refused, never thrown, and nothing is written', async () => {
    for (const doc of [{ ...labelledWorld(), buildings: 'none' }, { ...labelledWorld(), layers: null }, null]) {
      const { d, mem } = deps()
      const r = await exportWorld(request({ doc: doc as unknown as WorldDoc }), d)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toMatch(/^This world didn't pass its checks, so it can't be exported \(.+\)\.$/)
      expect(mem.fs.writeFile).not.toHaveBeenCalled()
    }
  })

  it('refuses a proposal the world no longer has, and a world that fails its checks, writing nothing', async () => {
    const a = deps()
    expect(await exportWorld(request({ proposalId: 'gone' }), a.d)).toEqual({ ok: false, error: NO_PROPOSAL })
    const doc = labelledWorld()
    doc.edges[0].from = 'nowhere'
    const b = deps()
    const r = await exportWorld(request({ doc }), b.d)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/^This world didn't pass its checks, so it can't be exported \(.+\)\.$/)
    expect(a.mem.fs.writeFile).not.toHaveBeenCalled()
    expect(b.mem.fs.writeFile).not.toHaveBeenCalled()
  })

  it('checks the world again after sanitising: a claim whose only evidence is private is left with none, and refused', async () => {
    const doc = labelledWorld()
    doc.buildings[0].how = [{ text: 'Remembers the user.', state: 'observed', evidence: [{ kind: 'memory', ref: 'm-1' }] }]
    expect(validateWorld(doc).ok).toBe(true)
    const { d, mem } = deps()
    const r = await exportWorld(request({ doc }), d)
    expect(!r.ok && r.error).toMatch(/^This world didn't pass its checks, so it can't be exported \(.*claim without evidence\)\.$/)
    expect(mem.fs.writeFile).not.toHaveBeenCalled()
  })
})

describe('exportWorld: the Ask index', () => {
  it('reports prepare, then index climbing by 16 to the entry count, then write', async () => {
    const doc = describedWorld(30, 20, 30, 20)
    const n = askEntries(sanitizeWorld(doc, CTX)).length
    expect(n).toBeGreaterThan(2 * EMBED_CHUNK)
    const { d, progress } = deps()
    await exportWorld(request({ doc }), d)
    const steps = progress.map((p) => p.step)
    expect(steps.indexOf('index')).toBeGreaterThan(steps.lastIndexOf('prepare'))
    expect(steps.indexOf('write')).toBeGreaterThan(steps.lastIndexOf('index'))
    const index = progress.filter((p) => p.step === 'index')
    expect(index.every((p) => p.total === n)).toBe(true)
    const expected = [0]
    for (let k = EMBED_CHUNK; k < n; k += EMBED_CHUNK) expected.push(k)
    expected.push(n)
    expect(index.map((p) => p.done)).toEqual(expected)
    expect(embedAll.mock.calls.map((c) => c[0].length)).toEqual(expected.slice(1).map((v, i) => v - expected[i]))
    expect(progress[progress.length - 1]).toEqual({ step: 'write', done: 1, total: 1 })
  })

  it('a keyword export has no index step', async () => {
    const { d, progress } = deps()
    await exportWorld(request({ smart: false }), d)
    expect(progress.map((p) => p.step)).toEqual(['prepare', 'prepare', 'write', 'write'])
  })

  it('a row the embedder could not give, or gave at the wrong width, is a zero row', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map((t, i) => (i === 0 ? null : i === 1 ? [1, 2, 3] : vectorFor(t))))
    const { d, mem } = deps({ embed })
    expect((await exportWorld(request(), d)).ok).toBe(true)
    const html = pageAt(mem)
    const ask = jsonBlock<{ scales: number[] }>(html, 'ask')
    expect(ask.scales[0]).toBe(0)
    expect(ask.scales[1]).toBe(0)
    expect(ask.scales[2]).toBeGreaterThan(0)
    const vec = blocksOf(html).find((b) => b.id === 'askvec')!.bytes
    expect(vec.subarray(0, 768).every((x) => x === 0)).toBe(true)
  })

  it('an embedder that returns fewer rows than texts leaves the rest zero', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.slice(1).map(vectorFor))
    const { d, mem } = deps({ embed })
    expect((await exportWorld(request(), d)).ok).toBe(true)
    const ask = jsonBlock<{ scales: number[] }>(pageAt(mem), 'ask')
    expect(ask.scales.some((s) => s === 0)).toBe(true)
  })

  it('an empty world exports a smart page with no rows', async () => {
    const { d, mem } = deps()
    const doc = describedWorld(0, 0, 0, 0)
    doc.districts = []
    doc.glossary = {}
    expect(askEntries(doc)).toEqual([])
    expect((await exportWorld(request({ doc }), d)).ok).toBe(true)
    expect(blocksOf(pageAt(mem)).find((b) => b.id === 'askvec')!.bytes.length).toBe(0)
    expect(embedAll).not.toHaveBeenCalled()
  })
})

describe('exportWorld: a missing model', () => {
  const expectKeywordOnly = (r: unknown): void => expect(r).toEqual({ ok: false, error: NO_MODEL, keywordOnly: true })

  it('no model folder (resolveExportAssets found none): keyword only, nothing written', async () => {
    const { d, mem } = deps({ assets: { ...ASSETS, modelDir: '', modelFile: '' } })
    expectKeywordOnly(await exportWorld(request(), d))
    expect(mem.fs.writeFile).not.toHaveBeenCalled()
    expect(embedAll).not.toHaveBeenCalled()
  })

  it('a model, tokenizer or wasm file that cannot be read: keyword only', async () => {
    for (const missing of [ASSETS.modelFile, ASSETS.ortWasm, join(MODEL_DIR, 'tokenizer.json')]) {
      const { d, mem } = deps({ mem: memFs({ missing: [missing] }) })
      expectKeywordOnly(await exportWorld(request(), d))
      expect(mem.fs.writeFile).not.toHaveBeenCalled()
    }
    const { d } = deps({ assets: { ...ASSETS, ortWasm: '' } })
    expectKeywordOnly(await exportWorld(request(), d))
  })

  it('a tokenizer that is not JSON: keyword only', async () => {
    const mem = memFs()
    vi.mocked(mem.fs.readFile).mockImplementation(async (p: string) => (p === join(MODEL_DIR, 'tokenizer.json') ? Buffer.from('{not json') : p === ASSETS.runtimeJs ? Buffer.from(RUNTIME) : new Uint8Array(4)))
    expectKeywordOnly(await exportWorld(request(), deps({ mem }).d))
  })

  it('an embedder that embeds nothing (its model would not load), or throws: keyword only', async () => {
    expectKeywordOnly(await exportWorld(request(), deps({ embed: async (t) => t.map(() => null) }).d))
    expectKeywordOnly(await exportWorld(request(), deps({ embed: async () => { throw new Error('ort') } }).d))
  })

  it('the same world exports as keyword with the model missing', async () => {
    const { d } = deps({ assets: { ...ASSETS, modelDir: '', modelFile: '' } })
    expect((await exportWorld(request({ smart: false }), d)).ok).toBe(true)
  })

  it('a missing or damaged runtime is its own sentence', async () => {
    expect(await exportWorld(request({ smart: false }), deps({ mem: memFs({ missing: [ASSETS.runtimeJs] }) }).d)).toEqual({ ok: false, error: NO_RUNTIME })
    expect(await exportWorld(request({ smart: false }), deps({ assets: { ...ASSETS, runtimeJs: '' } }).d)).toEqual({ ok: false, error: NO_RUNTIME })
    const mem = memFs()
    vi.mocked(mem.fs.readFile).mockResolvedValueOnce(Buffer.from('x="</script>"'))
    expect(await exportWorld(request({ smart: false }), deps({ mem }).d)).toEqual({ ok: false, error: NO_RUNTIME })
    expect(mem.fs.writeFile).not.toHaveBeenCalled()
  })
})

describe('exportWorld: writing the file', () => {
  const PART = /^D:\/out\/Shop - Lumopolis\.html\.part-[0-9a-f]{12}$/

  it('writes to <target>.part-<random>, then renames it to the target; nothing is ever written to the target itself', async () => {
    const { d, mem } = deps()
    await exportWorld(request({ smart: false }), d)
    expect(mem.calls).toHaveLength(2)
    const part = mem.calls[0].replace(/^write /, '')
    expect(part).toMatch(PART)
    expect(mem.calls[1]).toBe(`rename ${part} -> ${TARGET}`)
    expect(vi.mocked(mem.fs.writeFile).mock.calls.every((c) => c[0] !== TARGET)).toBe(true)
  })

  it('two exports to one target use different .part names', async () => {
    const a = deps()
    const b = deps()
    await exportWorld(request({ smart: false }), a.d)
    await exportWorld(request({ smart: false }), b.d)
    expect(a.mem.calls[0]).not.toBe(b.mem.calls[0])
  })

  it('reports the size of the written file, or of the page when it cannot be read back', async () => {
    const mem = memFs({ stat: new Error('gone') })
    const r = await exportWorld(request({ smart: false }), deps({ mem }).d)
    expect(r).toEqual({ ok: true, path: TARGET, bytes: Buffer.byteLength(pageAt(mem), 'utf8') })
  })

  it('a cancel during index removes the .part and returns cancelled, with nothing written', async () => {
    const ac = new AbortController()
    const embed = vi.fn(async (texts: string[]) => { ac.abort(); return texts.map(vectorFor) })
    const { d, mem } = deps({ embed, signal: ac.signal })
    const r = await exportWorld(request({ doc: describedWorld(30, 20, 30, 20) }), d)
    expect(r).toEqual({ ok: false, error: CANCELLED, cancelled: true })
    expect(embed).toHaveBeenCalledTimes(1)
    expect(mem.fs.writeFile).not.toHaveBeenCalled()
    expect(mem.calls).toHaveLength(1)
    expect(mem.calls[0]).toMatch(/^rm D:\/out\/Shop - Lumopolis\.html\.part-[0-9a-f]{12}$/)
  })

  it('a cancel during the last chunk, before the run, or while the file is written also leaves no file', async () => {
    const last = new AbortController()
    const one = deps({ embed: async (t) => { last.abort(); return t.map(vectorFor) }, signal: last.signal })
    expect((await exportWorld(request(), one.d)).cancelled).toBe(true)
    expect(one.mem.fs.writeFile).not.toHaveBeenCalled()

    const before = new AbortController()
    before.abort()
    const two = deps({ signal: before.signal })
    expect((await exportWorld(request({ smart: false }), two.d)).cancelled).toBe(true)
    expect(two.mem.fs.writeFile).not.toHaveBeenCalled()

    const during = new AbortController()
    const three = deps({ mem: memFs({ onWrite: () => during.abort() }), signal: during.signal })
    expect(await exportWorld(request({ smart: false }), three.d)).toEqual({ ok: false, error: CANCELLED, cancelled: true })
    expect(three.mem.fs.rename).not.toHaveBeenCalled()
    expect(three.mem.calls[1]).toBe(`rm ${three.mem.calls[0].replace(/^write /, '')}`)
    expect(three.mem.written.size).toBe(0)
  })

  it.each([['ENOSPC', NO_SPACE], ['EACCES', NO_ACCESS], ['EPERM', NO_ACCESS], ['EROFS', NO_ACCESS]])('a write failing with %s says so and removes the .part', async (code, sentence) => {
    const mem = memFs({ write: () => coded(code) })
    expect(await exportWorld(request({ smart: false }), deps({ mem }).d)).toEqual({ ok: false, error: sentence })
    const part = mem.calls[0].replace(/^write /, '')
    expect(mem.calls).toEqual([`write ${part}`, `rm ${part}`])
  })

  it.each(['EPERM', 'EBUSY'])('a rename failing with %s means another program holds the target: the .part goes, the target is untouched', async (code) => {
    const mem = memFs({ rename: coded(code) })
    expect(await exportWorld(request({ smart: false }), deps({ mem }).d)).toEqual({ ok: false, error: FILE_IN_USE })
    const part = mem.calls[0].replace(/^write /, '')
    expect(mem.calls).toEqual([`write ${part}`, `rename ${part} -> ${TARGET}`, `rm ${part}`])
    expect(mem.written.size).toBe(0)
    expect(vi.mocked(mem.fs.writeFile).mock.calls.every((c) => c[0] !== TARGET)).toBe(true)
  })

  it('a rename failing for lack of space or access says so too; anything else is named honestly', async () => {
    expect(await exportWorld(request({ smart: false }), deps({ mem: memFs({ rename: coded('ENOSPC') }) }).d)).toEqual({ ok: false, error: NO_SPACE })
    expect(await exportWorld(request({ smart: false }), deps({ mem: memFs({ rename: coded('EACCES') }) }).d)).toEqual({ ok: false, error: NO_ACCESS })
    expect(await exportWorld(request({ smart: false }), deps({ mem: memFs({ write: () => coded('EIO') }) }).d))
      .toEqual({ ok: false, error: "Termpolis couldn't save the file (EIO)." })
    expect(await exportWorld(request({ smart: false }), deps({ mem: memFs({ write: () => new Error('disk went away') }) }).d))
      .toEqual({ ok: false, error: "Termpolis couldn't save the file (disk went away)." })
    const odd = memFs()
    vi.mocked(odd.fs.writeFile).mockRejectedValueOnce('plain')
    expect(await exportWorld(request({ smart: false }), deps({ mem: odd }).d)).toEqual({ ok: false, error: "Termpolis couldn't save the file (plain)." })
  })

  it('a .part that cannot be removed does not hide the write error', async () => {
    const mem = memFs({ write: () => coded('ENOSPC') })
    vi.mocked(mem.fs.rm).mockRejectedValue(new Error('locked'))
    expect(await exportWorld(request({ smart: false }), deps({ mem }).d)).toEqual({ ok: false, error: NO_SPACE })
  })
})

describe('writeDocument', () => {
  it('writes the sanitised documentation through a .part and a rename, card sentences included', async () => {
    const mem = memFs()
    const doc = labelledWorld()
    doc.buildings[0].members = [`${HOME}/notes/plan.md`]
    const target = 'D:/out/Shop - Documentation.html'
    const r = await writeDocument({ doc, ctx: CTX, title: 'Shop', target, generatedOn: '2026-11-21' }, mem.fs)
    const html = mem.written.get(target) as string
    expect(r).toEqual({ ok: true, path: target, bytes: Buffer.byteLength(html, 'utf8') })
    expect(html).toContain('The main process opens the window and hosts terminals.')
    expect(html).toContain('How Shop works')
    expect(html).not.toContain(HOME)
    expect(mem.calls[0]).toMatch(/^write D:\/out\/Shop - Documentation\.html\.part-[0-9a-f]{12}$/)
    expect(mem.calls[1]).toBe(`rename ${mem.calls[0].replace(/^write /, '')} -> ${target}`)
  })

  it('places the city picture when one is given, and reports a failed write with its sentence', async () => {
    const png = `data:image/png;base64,${Buffer.from('png').toString('base64')}`
    const mem = memFs()
    await writeDocument({ doc: labelledWorld(), ctx: CTX, title: 'Shop', picturePng: png, target: 'D:/d.html', generatedOn: '2026-11-21' }, mem.fs)
    expect(mem.written.get('D:/d.html')).toContain(png)
    const full = memFs({ write: () => coded('ENOSPC') })
    expect(await writeDocument({ doc: labelledWorld(), ctx: CTX, title: 'Shop', target: 'D:/d.html', generatedOn: '2026-11-21' }, full.fs)).toEqual({ ok: false, error: NO_SPACE })
    expect(full.calls[1]).toMatch(/^rm /)
  })
})

describe('writeDocument: a malformed world', () => {
  it('is refused with a sentence, never thrown, and nothing is written', async () => {
    const mem = memFs()
    const r = await writeDocument({ doc: { ...labelledWorld(), edges: 7 } as unknown as WorldDoc, ctx: CTX, title: 'Shop', target: 'D:/d.html', generatedOn: '2026-11-21' }, mem.fs)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/^This world didn't pass its checks, so its documentation can't be written \(.+\)\.$/)
    expect(mem.fs.writeFile).not.toHaveBeenCalled()
  })

  it('sanitises the title of the document too', async () => {
    const mem = memFs()
    await writeDocument({ doc: labelledWorld(), ctx: CTX, title: `${HOME}/repos/shop`, target: 'D:/d.html', generatedOn: '2026-11-21' }, mem.fs)
    expect(mem.written.get('D:/d.html')).not.toContain(HOME)
  })
})

describe('describedShare', () => {
  it('starts smart Ask on from 80% of buildings and 80% of lines described', () => {
    expect(SMART_DEFAULT_SHARE).toBe(0.8)
    expect(describedShare(describedWorld(100, 20, 79, 20))).toEqual({ buildings: 0.79, lines: 1, smartDefault: false })
    expect(describedShare(describedWorld(100, 20, 80, 20))).toEqual({ buildings: 0.8, lines: 1, smartDefault: true })
    expect(describedShare(describedWorld(10, 100, 10, 79)).smartDefault).toBe(false)
    expect(describedShare(describedWorld(10, 100, 10, 80)).smartDefault).toBe(true)
  })

  it('counts a world with no buildings or no lines as described there (nothing is left to describe)', () => {
    expect(describedShare(describedWorld(0, 0, 0, 0))).toEqual({ buildings: 1, lines: 1, smartDefault: true })
    expect(describedShare(describedWorld(5, 0, 4, 0))).toEqual({ buildings: 0.8, lines: 1, smartDefault: true })
  })

  it('the Termpolis fixture is described enough for smart Ask', () => {
    expect(describedShare(fixture()).smartDefault).toBe(true)
  })
})

describe('estimateExportBytes', () => {
  /** base64(gzip) of `data`, as the page stores a block. */
  const encoded = (data: string | Uint8Array): number => Math.ceil(gzipSync(data).length / 3) * 4
  const TAG = '<script type="application/octet-stream" id="vocab" data-enc="gz64"></script>\n'.length
  // As the export writes it: every "<" escaped (safeJson).
  const vocabJson = JSON.stringify({ tokenizer: TOKENIZER, tokenizerConfig: TOKENIZER_CONFIG }).replace(/</g, '\\u003c')
  /** The world the page shows: sanitised, with the plan the export keeps (all of a design's, none of a code world's). */
  const shown = (doc: WorldDoc, ctx = CTX): WorldDoc => {
    const clean = sanitizeWorld(doc, ctx)
    return doc.projectKey.startsWith('design:') ? clean : { ...clean, layers: { ...clean.layers, plan: [] } }
  }
  /** The test's own files and vectors, measured here, independently of the export. */
  const sizesFor = (doc: WorldDoc, ctx = CTX) => {
    const rows = askEntries(shown(doc, ctx)).map((e) => vectorFor(e.text))
    const { data } = packInt8(rows)
    return {
      runtime: Buffer.byteLength(RUNTIME),
      smartAssets: encoded(vocabJson) + encoded(WASM) + encoded(MODEL) + 3 * TAG,
      vectorShare: data.length === 0 ? 1 : gzipSync(data).length / data.length,
    }
  }
  const est = (doc: WorldDoc, smart: boolean, sizes?: ExportSizes, over: Partial<ExportRequest> = {}): Promise<number | null> =>
    estimateExportBytes({ doc, ctx: CTX, title: 'Termpolis', smart, ...over }, sizes)
  const pageBytes = async (doc: WorldDoc, smart: boolean, over: Partial<ExportRequest> = {}): Promise<number> => {
    const r = await exportWorld(request({ doc, smart, title: 'Termpolis', ...over }), deps().d)
    return r.ok ? r.bytes : -1
  }
  const off = (estimate: number | null, real: number): number => Math.abs((estimate as number) - real) / real

  it("measures the export's own vocab block: escaped exactly as safeJson escapes it", () => {
    expect(vocabJson).toContain('\\u003c/script>')
    expect(vocabJson).not.toContain('<')
  })

  // Tolerance, stated: within 1% of the whole page, and within 2% of what smart Ask adds. What the estimate cannot
  // know is the head7 and how the scales print; on the fixture those are a few hundred bytes.
  it('is within 1% of the real keyword page and of the real smart page, for the fixture and a described world', async () => {
    for (const doc of [fixture(), describedWorld(40, 60, 40, 60), labelledWorld()]) {
      for (const smart of [false, true]) {
        expect(off(await est(doc, smart, sizesFor(doc)), await pageBytes(doc, smart)), `smart ${smart}`).toBeLessThan(0.01)
      }
    }
  })

  it('smart minus keyword is the encoded smart files plus the vectors, within 2%', async () => {
    const doc = fixture()
    const realDiff = (await pageBytes(doc, true)) - (await pageBytes(doc, false))
    const estDiff = (await est(doc, true, sizesFor(doc)) as number) - (await est(doc, false, sizesFor(doc)) as number)
    expect(Math.abs(estDiff - realDiff) / realDiff).toBeLessThan(0.02)
  })

  it('grows with the world; a whole code-world export leaves proposals out, a proposal export counts its one', async () => {
    expect(await est(describedWorld(60, 80, 60, 80), false)).toBeGreaterThan(await est(describedWorld(6, 8, 6, 8), false) as number)
    const linked = linkedDesignWorld()
    expect(await est(linked, false)).toBe(await est({ ...linked, layers: { ...linked.layers, plan: [] } }, false))
    const p2 = { proposalId: 'p2' }
    expect(await est(linked, false, undefined, p2)).toBeGreaterThan(await est(linked, false) as number)
    // The vectors are measured on the world the proposal page shows: the built world plus p2.
    const onlyP2 = sanitizeWorld({ ...linked, layers: { plan: linked.layers.plan.filter((p) => p.id === 'p2') } }, CTX)
    const rows = packInt8(askEntries(onlyP2).map((e) => vectorFor(e.text))).data
    const sizes = { ...sizesFor(linked), vectorShare: gzipSync(rows).length / rows.length }
    for (const smart of [false, true]) {
      expect(off(await est(linked, smart, sizes, p2), await pageBytes(linked, smart, p2)), `proposal, smart ${smart}`).toBeLessThan(0.01)
    }
  })

  it("counts a design world's plan, removals included, as the export keeps it", async () => {
    const doc = designWithRemovals()
    const bare = { ...doc, layers: { plan: [] } }
    const design = { ctx: DESIGN_CTX }
    expect(await est(doc, false, undefined, design)).toBeGreaterThan(await est(bare, false, undefined, design) as number)
    for (const smart of [false, true]) {
      expect(off(await est(doc, smart, sizesFor(doc, DESIGN_CTX), design), await pageBytes(doc, smart, design)), `smart ${smart}`).toBeLessThan(0.01)
    }
  })

  it('measures the sanitised world: evidence excerpts the export strips are not counted', async () => {
    const doc = labelledWorld()
    const long = labelledWorld()
    for (const b of long.buildings) for (const c of b.how) c.evidence = c.evidence.map((e) => ({ ...e, excerpt: 'x'.repeat(1200) }))
    expect(JSON.stringify(long).length).toBeGreaterThan(JSON.stringify(doc).length + 1200)
    expect(await est(long, false)).toBe(await est(doc, false))
  })

  it('is null for a world the export would refuse: a malformed doc, one failing its checks, a proposal it lacks', async () => {
    const broken = labelledWorld()
    broken.edges[0].from = 'nowhere'
    expect(await est({ ...labelledWorld(), buildings: 'none' } as unknown as WorldDoc, true)).toBeNull()
    expect(await est(broken, false)).toBeNull()
    expect(await est(labelledWorld(), false, undefined, { proposalId: 'gone' })).toBeNull()
  })

  it('defaults to the measured runtime and smart files: about 37.3 MB smart and 0.75 MB keyword for the Termpolis fixture', async () => {
    expect((await est(fixture(), true) as number) / 1e6).toBeCloseTo(37.3, 1)
    expect((await est(fixture(), false) as number) / 1e6).toBeCloseTo(0.75, 1)
  })

  // Where this checkout has the real files (a dev machine after model prep and npm run build:world-viewer, or CI's
  // package-verify job), the defaults must hold for a real page: the fixture exported through the real embedder,
  // runtime, wasm and model, to a real file, is within 2% of the default estimate.
  const real = resolveExportAssets({ appPath: join(__dirname, '..', '..') })
  const realAssets = 'missing' in real ? undefined : real.assets
  it.skipIf(realAssets === undefined)('the defaults match a real smart page built from the real files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'world-export-real-'))
    try {
      const target = join(dir, 'Termpolis - Lumopolis.html')
      const r = await exportWorld(
        { doc: fixture(), ctx: CTX, title: 'Termpolis', smart: true, target, exportedOn: '2026-11-21' },
        { assets: realAssets as ExportAssets, embed: (t) => embedBatch(t), fs: fsp, signal: new AbortController().signal, progress: () => undefined },
      )
      expect(r.ok).toBe(true)
      const bytes = statSync(target).size
      const smart = await est(fixture(), true) as number
      expect(Math.abs(smart - bytes) / bytes).toBeLessThan(0.02)
      expect(Math.abs((await est(fixture(), false) as number) + DEFAULT_EXPORT_SIZES.smartAssets - smart) / bytes).toBeLessThan(0.01)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('resolveExportAssets', () => {
  const dirs: string[] = []
  const temp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'world-export-'))
    dirs.push(d)
    return d
  }
  const touch = (file: string): string => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'x')
    return file
  }
  const model = { dir: 'M:/models/bge', model: 'M:/models/bge/onnx/model_quantized.onnx' }
  const wasmRel = ['node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm']
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('packaged: the runtime in <resources>/world-export, the asar-unpacked wasm, the embedder model', () => {
    const res = temp()
    const runtimeJs = touch(join(res, 'world-export', 'world-export.js'))
    const ortWasm = touch(join(res, 'app.asar.unpacked', ...wasmRel))
    const app = temp()
    touch(join(app, 'dist-world', 'world-export.js'))
    expect(resolveExportAssets({ resourcesPath: res, appPath: app, resolveModel: () => model }))
      .toEqual({ assets: { runtimeJs, ortWasm, modelDir: model.dir, modelFile: model.model } })
  })

  it('dev: the runtime in <app>/dist-world and the wasm in <app>/node_modules', () => {
    const app = temp()
    const runtimeJs = touch(join(app, 'dist-world', 'world-export.js'))
    const ortWasm = touch(join(app, ...wasmRel))
    expect(resolveExportAssets({ resourcesPath: temp(), appPath: app, resolveModel: () => model }))
      .toEqual({ assets: { runtimeJs, ortWasm, modelDir: model.dir, modelFile: model.model } })
    expect(resolveExportAssets({ appPath: app, resolveModel: () => model }))
      .toEqual({ assets: { runtimeJs, ortWasm, modelDir: model.dir, modelFile: model.model } })
  })

  it('a missing runtime: nothing can be exported', () => {
    const app = temp()
    touch(join(app, ...wasmRel))
    expect(resolveExportAssets({ appPath: app, resolveModel: () => model })).toEqual({ missing: 'runtime' })
  })

  it('a missing model (the resolver finds none) or wasm: keyword only, with the runtime still found', () => {
    const app = temp()
    const runtimeJs = touch(join(app, 'dist-world', 'world-export.js'))
    const noModel = resolveExportAssets({ appPath: app, resolveModel: () => undefined })
    expect(noModel).toEqual({ missing: 'model', assets: { runtimeJs, ortWasm: '', modelDir: '', modelFile: '' } })
    const ortWasm = touch(join(app, ...wasmRel))
    expect(resolveExportAssets({ appPath: app, resolveModel: () => undefined }))
      .toEqual({ missing: 'model', assets: { runtimeJs, ortWasm, modelDir: '', modelFile: '' } })
    rmSync(ortWasm)
    expect(resolveExportAssets({ appPath: app, resolveModel: () => model })).toEqual({ missing: 'model', assets: { runtimeJs, ortWasm: '', modelDir: '', modelFile: '' } })
  })

  it('a keyword export from a missing-model result writes a page', async () => {
    const app = temp()
    touch(join(app, 'dist-world', 'world-export.js'))
    const found = resolveExportAssets({ appPath: app, resolveModel: () => undefined })
    const assets = (found as { assets: ExportAssets }).assets
    const mem = memFs()
    vi.mocked(mem.fs.readFile).mockResolvedValue(Buffer.from(RUNTIME))
    expect(await exportWorld(request({ smart: true }), deps({ mem, assets }).d)).toEqual({ ok: false, error: NO_MODEL, keywordOnly: true })
    expect((await exportWorld(request({ smart: false }), deps({ mem, assets }).d)).ok).toBe(true)
  })

  it('uses the embedder resolver when none is given', () => {
    const app = temp()
    touch(join(app, 'dist-world', 'world-export.js'))
    const r = resolveExportAssets({ appPath: app })
    expect('assets' in r).toBe(true)
    expect(existsSync((r as { assets: ExportAssets }).assets.runtimeJs)).toBe(true)
  })
})

describe('pageMeta from the writer passes the page check', () => {
  it('code world, design world without git, a proposal, and git missing', () => {
    const code = pageMeta(labelledWorld(), { title: 'Shop', exportedOn: '2026-11-21' })
    expect(code).toEqual({ project: 'Shop', exportedOn: '2026-11-21', head7: 'a1b2c3d', dirty: true })
    const design = pageMeta(designWorld(), { title: 'Shop design', exportedOn: '2026-11-21' })
    expect(design).toEqual({ project: 'Shop design', exportedOn: '2026-11-21', head7: '', dirty: false })
    const proposal = pageMeta(linkedDesignWorld(), { title: 'Shop', exportedOn: '2026-11-21', proposalId: 'p1' })
    expect(proposal.proposalId).toBe('p1')
    const noGit = labelledWorld()
    noGit.sourceRevision = { head: '', dirty: false }
    const missing = pageMeta(noGit, { title: 'Shop', exportedOn: '2026-11-21' })
    for (const m of [code, design, proposal, missing]) expect(isMeta(m)).toBe(true)
    for (const m of [code, design, missing]) expect('proposalId' in m).toBe(false)
    expect(JSON.stringify([code, design, proposal, missing])).not.toContain('null')
  })
})

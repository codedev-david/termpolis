// Writes the files a Lumopolis world leaves the app as (spec 5.2 and 5.3): one offline .html page, the world
// exported, and a documentation file. Main process only, and no process is started here: the commit shown on the
// page comes from the world's own sourceRevision, and the Ask index is embedded through the app's embedder.
//
// The page: the data blocks first (<script type="application/octet-stream" data-enc="gz64">, gzip then base64), then
// ONE classic <script> holding the runtime (dist-world/world-export.js), under a CSP that forbids every request.
// A keyword page carries the world, its meta and the Ask entries; a smart Ask page adds the int8 vectors, the
// tokenizer, the ORT wasm and the model. Nothing reaches the target name until the whole file is written: it is
// written beside it under a .part name, then renamed, and a cancel or a failure removes the .part.
//
// Index reuse: the export embeds the Ask entries afresh every time. There is no cache in userData in 2.0: about
// 30 s on a 600-line world is acceptable, and a cache adds a failure mode (a stale index that no longer matches).
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { askEntries, ASK_INDEX_VERSION, packInt8, type AskEntry } from '../../shared/world/askIndex'
import { buildDocumentation } from '../../shared/world/documentation'
import { renderDocumentation } from '../../shared/world/documentationHtml'
import { pageMeta } from '../../shared/world/exportMeta'
import { sanitizeWorld, type SanitizeContext } from '../../shared/world/exportSanitize'
import { escapeHtml } from '../../shared/world/html'
import type { WorldDoc } from '../../shared/world/types'
import { validateWorld } from '../../shared/world/validate'
import { EMBED_DIM, resolveEmbedderAssets } from '../localEmbedder'

/** The files an export reads: the page runtime, the ORT wasm, and the embedding model's folder and file. */
export interface ExportAssets { runtimeJs: string; ortWasm: string; modelDir: string; modelFile: string }

/** The runtime's file name, in dist-world (dev) and in <resources>/world-export (packaged). */
const RUNTIME_FILE = 'world-export.js'
/** The ORT wasm a smart Ask page carries: the asar-unpacked copy the embedder itself loads. */
const ORT_WASM_REL = ['node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm']

/**
 * Where the export's files are: packaged first (<resourcesPath>/world-export, the asar-unpacked ORT wasm), then
 * dev (<appPath>/dist-world, <appPath>/node_modules). Without the runtime nothing can be exported. Without the
 * model or the wasm only keyword Ask can be: `missing: 'model'` then still carries the assets, with an empty
 * modelDir and modelFile, so the caller can offer a keyword export.
 */
export function resolveExportAssets(env: { resourcesPath?: string; appPath: string; resolveModel?: () => { dir: string; model: string } | undefined }):
  { assets: ExportAssets } | { missing: 'runtime' } | { missing: 'model'; assets: ExportAssets } {
  const { resourcesPath, appPath, resolveModel = resolveEmbedderAssets } = env
  const first = (candidates: string[]): string => candidates.find((c) => existsSync(c)) ?? ''
  const packaged = (...rel: string[]): string[] => (resourcesPath ? [join(resourcesPath, ...rel)] : [])
  const runtimeJs = first([...packaged('world-export', RUNTIME_FILE), join(appPath, 'dist-world', RUNTIME_FILE)])
  if (runtimeJs === '') return { missing: 'runtime' }
  const ortWasm = first([...packaged('app.asar.unpacked', ...ORT_WASM_REL), join(appPath, ...ORT_WASM_REL)])
  const model = resolveModel()
  if (!model || ortWasm === '') return { missing: 'model', assets: { runtimeJs, ortWasm, modelDir: '', modelFile: '' } }
  return { assets: { runtimeJs, ortWasm, modelDir: model.dir, modelFile: model.model } }
}

/** The share of described buildings and of described lines from which the smart Ask switch starts on (spec 5.2). */
export const SMART_DEFAULT_SHARE = 0.8

/**
 * How much of the world a model has described: the share of buildings and of lines with at least one `how` claim
 * (the labelling's description, not the fallback). A world with no buildings or no lines counts that share as whole.
 */
export function describedShare(doc: WorldDoc): { buildings: number; lines: number; smartDefault: boolean } {
  const share = (parts: Array<{ how: unknown[] }>): number => (parts.length === 0 ? 1 : parts.filter((p) => p.how.length > 0).length / parts.length)
  const buildings = share(doc.buildings)
  const lines = share(doc.edges)
  return { buildings, lines, smartDefault: buildings >= SMART_DEFAULT_SHARE && lines >= SMART_DEFAULT_SHARE }
}

export type ExportStep = 'prepare' | 'index' | 'write'
export interface ExportProgress { step: ExportStep; done: number; total: number }

/** What to export. `title` is the project's name as the person sees it: the page title and header use it. */
export interface ExportRequest { doc: WorldDoc; ctx: SanitizeContext; title: string; smart: boolean; proposalId?: string; target: string; exportedOn: string }

/** The file operations the export uses: node:fs/promises fits. */
export interface ExportFs {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, opts: { force: boolean }): Promise<void>
  stat(path: string): Promise<{ size: number }>
}

export interface ExportDeps {
  assets: ExportAssets
  /** The embedder (localEmbedder's embedBatch): one vector per text, null where it could not embed. */
  embed(texts: string[]): Promise<(number[] | null)[]>
  fs: ExportFs
  signal: AbortSignal
  progress(p: ExportProgress): void
}

export type ExportResult = { ok: true; path: string; bytes: number } | { ok: false; error: string; cancelled?: boolean; keywordOnly?: boolean }

export const NO_SPACE = "There isn't enough space on that drive to save the file."
export const NO_ACCESS = "Termpolis can't write to that folder. Choose another one."
export const FILE_IN_USE = 'That file is open in another program. Close it and try again.'
export const NO_MODEL = "The smart Ask model isn't installed with this copy of Termpolis, so this export can use keyword Ask only."
export const NO_RUNTIME = "This copy of Termpolis is missing the page runtime, so it can't export a world."
export const NO_PROPOSAL = "That proposal isn't in this world any more."
export const CANCELLED = 'The export was cancelled.'

/** How many Ask entries are embedded at a time: the cancel is checked, and progress told, between chunks. */
export const EMBED_CHUNK = 16

/** The page's CSP (spec 5.3): no request of any kind; the wasm may compile, workers come from blobs. */
export const EXPORT_CSP = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; worker-src blob:; connect-src 'none'"

/** The page's own CSS: only what holds until the runtime adds its stylesheet. */
const PAGE_CSS = 'html,body{margin:0;height:100%;background:#03050a;color:#e2e8f0}'

const SAFE_ID = /^[a-z][a-z0-9]*$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
/** A sequence that would end an inline script early, or with a later "<script" stop "</script>" from ending it. */
const SCRIPT_BREAK = /<\/script|<!--/i

const blockTag = (id: string, gz: string): string => `<script type="application/octet-stream" id="${id}" data-enc="gz64">${gz}</script>`
/** One block's markup around its base64 (the id is at most a few letters), and a newline. */
const BLOCK_TAG_BYTES = blockTag('vocab', '').length + 1

/**
 * The page, in the order spec 5.3 makes load-bearing: meta charset, viewport, title, CSP, inline CSS, the data
 * blocks, then one classic script holding the runtime. Throws when a block or the runtime could break out of its
 * script element: a block id that is not plain letters and digits, a block that is not base64, or a runtime holding
 * "</script" or "<!--".
 */
export function exportPageHtml(parts: { title: string; blocks: { id: string; gz64: string }[]; runtimeJs: string }): string {
  for (const b of parts.blocks) {
    if (!SAFE_ID.test(b.id)) throw new Error(`exportPageHtml: block id ${JSON.stringify(b.id)} is not plain letters and digits`)
    if (!BASE64.test(b.gz64)) throw new Error(`exportPageHtml: block ${b.id} is not base64`)
  }
  if (SCRIPT_BREAK.test(parts.runtimeJs)) throw new Error('exportPageHtml: the runtime holds "</script" or "<!--"')
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(parts.title)} · Lumopolis</title>`,
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    `<style>${PAGE_CSS}</style>`,
    '</head>',
    '<body>',
    ...parts.blocks.map((b) => blockTag(b.id, b.gz64)),
    `<script>${parts.runtimeJs}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/**
 * What the estimate cannot read from the world: the bytes the page spends on the runtime and on the smart Ask files
 * (tokenizer, ORT wasm, model) as written, and the share gzip leaves of the int8 vectors (it depends on the model).
 */
export interface ExportSizes { runtime: number; smartAssets: number; vectorShare: number }

/**
 * The sizes measured on 2026-11-21: the runtime is 724,881 bytes; the vocab, wasm and model blocks are 254,548,
 * 4,439,172 and 31,808,792 bytes of base64 (bge-small-en-v1.5 quantised, onnxruntime-web's simd-threaded wasm);
 * gzip left 0.854 of the Termpolis fixture's 110 int8 vectors.
 */
export const DEFAULT_EXPORT_SIZES: ExportSizes = { runtime: 725_000, smartAssets: 36_502_700, vectorShare: 0.86 }
/** What one entry's scale costs in the `ask` block, gzip then base64 (a float printed in full). */
const SCALE_BYTES = 12

/** gzip then base64: how the page stores every block. */
const gz64 = (data: string | Uint8Array): string => gzipSync(data).toString('base64')
/** JSON with every `<` escaped, so no block's text could ever hold markup, even before it is encoded. */
const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')
/** The base64 length of `n` bytes. */
const b64Length = (n: number): number => Math.ceil(n / 3) * 4

/** The world as the page shows it: one proposal when the export is of a proposal, none otherwise. */
const withPlan = (doc: WorldDoc, plan: WorldDoc['layers']['plan']): WorldDoc => ({ ...doc, layers: { ...doc.layers, plan } })

/** The `ask` block: the entries the page searches and, on a smart page, how the `askvec` rows are packed. */
const askBlock = (entries: AskEntry[], dim: number, scales: number[]): string => safeJson({ version: ASK_INDEX_VERSION, entries, dim, scales })

/**
 * The size of the exported page, for the dialog's live estimate: the world, its meta and Ask entries as the export
 * encodes them, the runtime, and on a smart page the fixed smart cost plus the vectors (spec 5.2, "A live
 * estimate from the world JSON size plus the fixed smart cost"). Checked against real pages in the tests.
 */
export function estimateExportBytes(doc: WorldDoc, smart: boolean, sizes: ExportSizes = DEFAULT_EXPORT_SIZES): number {
  const world = withPlan(doc, [])
  const entries = askEntries(world)
  const meta = pageMeta(world, { title: 'Project', exportedOn: '2026-01-01' })
  const blocks = [safeJson(world), safeJson(meta), askBlock(entries, 0, [])]
  const frame = Buffer.byteLength(exportPageHtml({ title: meta.project, blocks: [], runtimeJs: '' }), 'utf8')
  const keyword = frame + sizes.runtime + blocks.reduce((sum, b) => sum + BLOCK_TAG_BYTES + gz64(b).length, 0)
  if (!smart) return keyword
  const vectors = b64Length(Math.ceil(entries.length * EMBED_DIM * sizes.vectorShare)) + entries.length * SCALE_BYTES
  return keyword + sizes.smartAssets + BLOCK_TAG_BYTES + vectors
}

const errCode = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** The sentence for a failed write: the rename fails on a target another program holds open. */
function writeError(e: unknown, phase: 'write' | 'rename'): string {
  const code = errCode(e)
  if (code === 'ENOSPC') return NO_SPACE
  if (phase === 'rename' && (code === 'EPERM' || code === 'EBUSY')) return FILE_IN_USE
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return NO_ACCESS
  return `Termpolis couldn't save the file (${code ?? (e instanceof Error ? e.message : String(e))}).`
}

/** A name beside the target that nothing else would use: the file is written there, then renamed. */
const partName = (target: string): string => `${target}.part-${randomBytes(6).toString('hex')}`

const removeQuietly = (fs: ExportFs, path: string): Promise<void> => fs.rm(path, { force: true }).catch(() => undefined)

/**
 * Writes `data` to `part`, then renames it to `target`. On a failure, or a cancel before the rename, the .part is
 * removed and `target` is left as it was. The size is the written file's, or the data's when it cannot be read.
 */
async function writeAtomically(fs: ExportFs, part: string, target: string, data: string, signal?: AbortSignal): Promise<ExportResult> {
  let phase: 'write' | 'rename' = 'write'
  try {
    await fs.writeFile(part, data)
    if (signal?.aborted) {
      await removeQuietly(fs, part)
      return { ok: false, error: CANCELLED, cancelled: true }
    }
    phase = 'rename'
    await fs.rename(part, target)
  } catch (e) {
    await removeQuietly(fs, part)
    return { ok: false, error: writeError(e, phase) }
  }
  const bytes = await fs.stat(target).then((s) => s.size, () => Buffer.byteLength(data, 'utf8'))
  return { ok: true, path: target, bytes }
}

/** A failure reading one of the export's own files. */
class AssetError extends Error {
  constructor(readonly result: ExportResult) { super('export asset') }
}

const readOr = (fs: ExportFs, path: string, onFail: ExportResult): Promise<Uint8Array> =>
  path === '' ? Promise.reject(new AssetError(onFail)) : fs.readFile(path).catch(() => { throw new AssetError(onFail) })

const keywordOnly: ExportResult = { ok: false, error: NO_MODEL, keywordOnly: true }

/** The smart Ask blocks besides the index: the tokenizer (both files, as JSON), the ORT wasm and the model. */
async function smartFiles(fs: ExportFs, assets: ExportAssets): Promise<{ id: string; gz64: string }[]> {
  const dir = assets.modelDir
  const [tokenizer, tokenizerConfig, wasm, model] = await Promise.all([
    readOr(fs, dir === '' ? '' : join(dir, 'tokenizer.json'), keywordOnly),
    readOr(fs, dir === '' ? '' : join(dir, 'tokenizer_config.json'), keywordOnly),
    readOr(fs, assets.ortWasm, keywordOnly),
    readOr(fs, assets.modelFile, keywordOnly),
  ])
  const text = (b: Uint8Array): unknown => JSON.parse(Buffer.from(b).toString('utf8'))
  let vocab: string
  try {
    vocab = safeJson({ tokenizer: text(tokenizer), tokenizerConfig: text(tokenizerConfig) })
  } catch {
    throw new AssetError(keywordOnly)
  }
  return [{ id: 'vocab', gz64: gz64(vocab) }, { id: 'ortwasm', gz64: gz64(wasm) }, { id: 'model', gz64: gz64(model) }]
}

/**
 * Exports the world as one offline page at `req.target` (spec 5.2 and 5.3). The world is sanitised (no path
 * outside the project, no private evidence), keeps only the proposal asked for, and is checked as the page will
 * check it. A smart export embeds the Ask entries in chunks of EMBED_CHUNK, checking the cancel between chunks.
 * A missing model returns `keywordOnly` and writes nothing; a cancel or a failed write leaves no partial file.
 */
export async function exportWorld(req: ExportRequest, deps: ExportDeps): Promise<ExportResult> {
  const { fs, signal, progress } = deps
  const part = partName(req.target)
  const cancelled = async (): Promise<ExportResult> => {
    await removeQuietly(fs, part)
    return { ok: false, error: CANCELLED, cancelled: true }
  }
  progress({ step: 'prepare', done: 0, total: 1 })
  const clean = sanitizeWorld(req.doc, req.ctx)
  const proposal = req.proposalId === undefined ? undefined : clean.layers.plan.find((p) => p.id === req.proposalId)
  if (req.proposalId !== undefined && !proposal) return { ok: false, error: NO_PROPOSAL }
  const checked = validateWorld(withPlan(clean, proposal ? [proposal] : []))
  if (!checked.ok) return { ok: false, error: `This world didn't pass its checks, so it can't be exported (${checked.errors[0]}).` }
  const doc = checked.doc
  const meta = pageMeta(doc, { title: req.title, exportedOn: req.exportedOn, ...(proposal ? { proposalId: proposal.id } : {}) })
  const entries = askEntries(doc)
  let runtimeJs: string
  let extra: { id: string; gz64: string }[] = []
  try {
    runtimeJs = Buffer.from(await readOr(fs, deps.assets.runtimeJs, { ok: false, error: NO_RUNTIME })).toString('utf8')
    if (req.smart) extra = await smartFiles(fs, deps.assets)
  } catch (e) {
    return (e as AssetError).result
  }
  progress({ step: 'prepare', done: 1, total: 1 })
  if (signal.aborted) return cancelled()

  let ask = askBlock(entries, 0, [])
  if (req.smart) {
    const total = entries.length
    const rows: (number[] | null)[] = []
    progress({ step: 'index', done: 0, total })
    for (let i = 0; i < total; i += EMBED_CHUNK) {
      if (signal.aborted) return cancelled()
      const texts = entries.slice(i, i + EMBED_CHUNK).map((e) => e.text)
      const got = await deps.embed(texts).catch((): null[] => texts.map(() => null))
      texts.forEach((_, j) => rows.push(got[j] ?? null))
      progress({ step: 'index', done: Math.min(i + EMBED_CHUNK, total), total })
    }
    if (signal.aborted) return cancelled()
    if (total > 0 && rows.every((r) => r === null)) return keywordOnly
    // A row the embedder could not give at the right width is a zero row: that entry is found by keyword only.
    const packed = packInt8(rows.map((r) => (r !== null && r.length === EMBED_DIM ? r : new Array<number>(EMBED_DIM).fill(0))))
    ask = askBlock(entries, EMBED_DIM, packed.scales)
    extra = [{ id: 'askvec', gz64: gz64(new Uint8Array(packed.data.buffer, packed.data.byteOffset, packed.data.byteLength)) }, ...extra]
  }

  progress({ step: 'write', done: 0, total: 1 })
  let html: string
  try {
    html = exportPageHtml({
      title: req.title,
      blocks: [{ id: 'world', gz64: gz64(safeJson(doc)) }, { id: 'meta', gz64: gz64(safeJson(meta)) }, { id: 'ask', gz64: gz64(ask) }, ...extra],
      runtimeJs,
    })
  } catch {
    return { ok: false, error: NO_RUNTIME }
  }
  const result = await writeAtomically(fs, part, req.target, html, signal)
  if (result.ok) progress({ step: 'write', done: 1, total: 1 })
  return result
}

/**
 * Writes the world's documentation (spec 5.4) to `req.target` as one HTML file, through the same .part-then-rename
 * as the page. The world is sanitised first; `picturePng` (a PNG data URL of the city) is optional.
 */
export async function writeDocument(
  req: { doc: WorldDoc; ctx: SanitizeContext; title: string; picturePng?: string; target: string; generatedOn: string },
  fs: ExportFs,
): Promise<ExportResult> {
  const doc = sanitizeWorld(req.doc, req.ctx)
  const model = buildDocumentation(doc, { title: req.title, picture: req.picturePng !== undefined, generatedOn: req.generatedOn })
  return writeAtomically(fs, partName(req.target), req.target, renderDocumentation(model, doc, req.picturePng))
}

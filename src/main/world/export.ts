// Writes the files a Lumopolis world leaves the app as (spec 5.2 and 5.3): one offline .html page, the world
// exported, and a documentation file. Main process only, and no process is started here: the commit shown on the
// page comes from the world's own sourceRevision, and the Ask index is embedded through the app's embedder.
//
// The page: the data blocks first (<script type="application/octet-stream" data-enc="gz64">, gzip then base64), then
// ONE classic <script> holding the runtime (dist-world/world-export.js), under a CSP that forbids every request.
// A keyword page carries the world, its meta and the Ask entries; a smart Ask page adds the int8 vectors, the
// tokenizer, the ORT wasm and the model. Nothing reaches the target name until the whole file is written: it is
// written beside it under a .part name, then renamed (or, for a name Termpolis picked, hard-linked), and a cancel
// or a failure removes the .part.
//
// Index reuse: the export embeds the Ask entries afresh every time. There is no cache in userData in 2.0: about
// 30 s on a 600-line world is acceptable, and a cache adds a failure mode (a stale index that no longer matches).
//
// Main is never blocked: every block is compressed with zlib's async gzip, on the libuv threadpool (a smart page
// gzips about 47 MB; gzipSync took about a second of main's time). The smart files are not cached between exports
// either: holding their 36 MB of base64 in main for an export a person makes now and then costs more than it saves.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { askEntries, ASK_INDEX_VERSION, packInt8, type AskEntry } from '../../shared/world/askIndex'
import { buildDocumentation } from '../../shared/world/documentation'
import { renderDocumentation } from '../../shared/world/documentationHtml'
import { NO_MODEL, pageMeta } from '../../shared/world/exportMeta'
import { sanitizeText, sanitizeWorld, type SanitizeContext } from '../../shared/world/exportSanitize'
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
/** How far above appPath dev looks for the project folder: `electron out/main/index.js` gives appPath out/main. */
const DEV_LEVELS = 3

/**
 * The folders dev looks in, nearest first: appPath, then each folder above it up to the first one that holds a
 * package.json (the project), at most DEV_LEVELS above. `electron .` gives the project itself; `electron
 * out/main/index.js`, as the e2e specs launch, gives out/main, two levels under it.
 */
export function devRoots(appPath: string): string[] {
  const roots = [appPath]
  let dir = appPath
  for (let i = 0; i < DEV_LEVELS && !existsSync(join(dir, 'package.json')); i++) {
    const up = dirname(dir)
    if (up === dir) break
    roots.push(up)
    dir = up
  }
  return roots
}

/**
 * Where the export's files are: packaged first (<resourcesPath>/world-export, the asar-unpacked ORT wasm), then
 * dev (dist-world and node_modules in appPath or the project folder above it, devRoots). Without the runtime nothing can be exported. Without the
 * model or the wasm only keyword Ask can be: `missing: 'model'` then still carries the assets, with an empty
 * modelDir and modelFile, so the caller can offer a keyword export.
 */
export function resolveExportAssets(env: { resourcesPath?: string; appPath: string; resolveModel?: () => { dir: string; model: string } | undefined }):
  { assets: ExportAssets } | { missing: 'runtime' } | { missing: 'model'; assets: ExportAssets } {
  const { resourcesPath, appPath, resolveModel = resolveEmbedderAssets } = env
  const first = (candidates: string[]): string => candidates.find((c) => existsSync(c)) ?? ''
  const packaged = (...rel: string[]): string[] => (resourcesPath ? [join(resourcesPath, ...rel)] : [])
  const dev = (...rel: string[]): string[] => devRoots(appPath).map((root) => join(root, ...rel))
  const runtimeJs = first([...packaged('world-export', RUNTIME_FILE), ...dev('dist-world', RUNTIME_FILE)])
  if (runtimeJs === '') return { missing: 'runtime' }
  const ortWasm = first([...packaged('app.asar.unpacked', ...ORT_WASM_REL), ...dev(...ORT_WASM_REL)])
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

/**
 * What to export. `title` is the project's name as the person sees it: the page title and header use it. `newName`
 * marks a `target` whose `.html` Termpolis added after the dialog (writeAtomically never replaces a file there).
 */
export interface ExportRequest { doc: WorldDoc; ctx: SanitizeContext; title: string; smart: boolean; proposalId?: string; target: string; newName?: boolean; exportedOn: string }

/** The file operations the export uses: node:fs/promises fits. */
export interface ExportFs {
  readFile(path: string): Promise<Uint8Array>
  /** `flag: 'wx'` creates the file only when no file has the name (EEXIST otherwise). */
  writeFile(path: string, data: string | Uint8Array, opts?: { flag: 'wx' }): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** A hard link: `newPath` names the file `existing` names, EEXIST when a file has that name. Optional: without it a new name is claimed empty. */
  link?(existing: string, newPath: string): Promise<void>
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

/** A failure's `error` is the sentence the person reads; `detail`, when there is one, is the validator's text, for
 *  the app log only (exportIpc logs it), never shown. */
export type ExportResult = { ok: true; path: string; bytes: number } | { ok: false; error: string; detail?: string; cancelled?: boolean; keywordOnly?: boolean }

/** A world that fails its checks: the sentence the person reads (the validator's text goes to the app log). */
export const NOT_EXPORTABLE = "This world didn't pass its checks, so it can't be exported."
export const NOT_DOCUMENTABLE = "This world didn't pass its checks, so its documentation can't be written."

export const NO_SPACE = "There isn't enough space on that drive to save the file."
export const NO_ACCESS = "Termpolis can't write to that folder. Choose another one."
export const FILE_IN_USE = 'That file is open in another program. Close it and try again.'
export { NO_MODEL }
export const NO_RUNTIME = "This copy of Termpolis is missing the page runtime, so it can't export a world."
export const NO_PROPOSAL = "That proposal isn't in this world anymore."
export const CANCELLED = 'The export was cancelled.'

/** How many Ask entries are embedded at a time: the cancel is checked, and progress told, between chunks. */
export const EMBED_CHUNK = 16

/**
 * The page's CSP (spec 5.3): no request of any kind, and the wasm may compile. Nothing else: smart Ask runs ORT on
 * one thread with no proxy worker and loads no image. Unset, img-src falls back to default-src 'none', and
 * worker-src to child-src, then script-src, which names no source a worker could load from, so neither an image
 * nor a worker can load (e2e/export-page/smart.page.ts proved smart Ask still starts without them, and fails
 * without 'wasm-unsafe-eval').
 */
export const EXPORT_CSP = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'"

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

const gzipAsync = promisify(gzip)
/** gzip then base64: how the page stores every block. Async: compressing never runs on main's thread. */
const gz64 = async (data: string | Uint8Array): Promise<string> => (await gzipAsync(data)).toString('base64')
/** JSON with every `<` escaped, so no block's text could ever hold markup, even before it is encoded. */
const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')
/** The base64 length of `n` bytes. */
const b64Length = (n: number): number => Math.ceil(n / 3) * 4

const withPlan = (doc: WorldDoc, plan: WorldDoc['layers']['plan']): WorldDoc => ({ ...doc, layers: { ...doc.layers, plan } })

/** What a request exports: the world as the page shows it, its sanitised title, or why it can't be exported. */
type Prepared = { ok: true; doc: WorldDoc; title: string; proposalId?: string } | { ok: false; error: string; detail?: string }

/** A failed check: the plain sentence, with the validator's first error as the detail for the app log. */
const failedChecks = (error: string, detail: string): { ok: false; error: string; detail: string } => ({ ok: false, error, detail })

/**
 * The world as the page shows it (spec 5.2). It is checked before the sanitiser reads it (a malformed world is
 * refused, never thrown on), sanitised, given its plan, and checked again as the page will check it. The plan: a
 * proposal export keeps the one proposal asked for; a whole design world keeps its whole plan, the removals the
 * design chat stores there included (the design is what it exports); a whole code world keeps none. The title is
 * sanitised as the world is.
 */
function prepareWorld(req: Pick<ExportRequest, 'doc' | 'ctx' | 'title' | 'proposalId'>): Prepared {
  const first = validateWorld(req.doc)
  if (!first.ok) return failedChecks(NOT_EXPORTABLE, first.errors[0])
  const clean = sanitizeWorld(first.doc, req.ctx)
  let plan: WorldDoc['layers']['plan'] = []
  if (req.proposalId !== undefined) {
    const proposal = clean.layers.plan.find((p) => p.id === req.proposalId)
    if (!proposal) return { ok: false, error: NO_PROPOSAL }
    plan = [proposal]
  } else if (first.doc.projectKey.startsWith('design:')) {
    plan = clean.layers.plan
  }
  const checked = validateWorld(withPlan(clean, plan))
  if (!checked.ok) return failedChecks(NOT_EXPORTABLE, checked.errors[0])
  return { ok: true, doc: checked.doc, title: sanitizeText(req.title, req.ctx), ...(req.proposalId !== undefined ? { proposalId: req.proposalId } : {}) }
}

/** The `ask` block: the entries the page searches and, on a smart page, how the `askvec` rows are packed. */
const askBlock = (entries: AskEntry[], dim: number, scales: number[]): string => safeJson({ version: ASK_INDEX_VERSION, entries, dim, scales })

/**
 * The size of the exported page, for the dialog's live estimate: the world the request exports (sanitised, with
 * its plan), its meta and Ask entries as the export encodes them, the runtime, and on a smart page the fixed smart
 * cost plus the vectors (spec 5.2, "A live estimate from the world JSON size plus the fixed smart cost"). Null when
 * the export would refuse the world. Checked against real pages in the tests.
 */
export async function estimateExportBytes(
  req: Pick<ExportRequest, 'doc' | 'ctx' | 'title' | 'smart' | 'proposalId'>,
  sizes: ExportSizes = DEFAULT_EXPORT_SIZES,
): Promise<number | null> {
  const prepared = prepareWorld(req)
  if (!prepared.ok) return null
  const world = prepared.doc
  const entries = askEntries(world)
  const meta = pageMeta(world, { title: prepared.title, exportedOn: '2026-01-01', ...(prepared.proposalId !== undefined ? { proposalId: prepared.proposalId } : {}) })
  const blocks = await Promise.all([safeJson(world), safeJson(meta), askBlock(entries, 0, [])].map(gz64))
  const frame = Buffer.byteLength(exportPageHtml({ title: meta.project, blocks: [], runtimeJs: '' }), 'utf8')
  const keyword = frame + sizes.runtime + blocks.reduce((sum, b) => sum + BLOCK_TAG_BYTES + b.length, 0)
  if (!req.smart) return keyword
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

/** How many numbered names (`x.html`, `x (2).html`, …) a new name tries before a random one. */
export const MAX_NUMBERED = 100

/**
 * Places the written `part` at a name for a `target` whose `.html` Termpolis added (`<stem>.html`): the first of
 * `<stem>.html`, `<stem> (2).html` … `(MAX_NUMBERED).html`, then `<stem> (<random>).html`, that no file has. A hard
 * link puts the whole file at that name in one step, so the name never holds an empty or half-written file, not even
 * when Termpolis is killed. On a volume with no hard links (FAT, some shares), or an ExportFs without `link`, the name
 * is created empty with `wx` and the caller renames the .part onto it. Only EEXIST moves on to the next name; any
 * other error, or a random name taken too, is thrown (writeError words it). `linked` says the file is already there.
 */
async function placeNew(fs: ExportFs, part: string, target: string): Promise<{ name: string; linked: boolean }> {
  const stem = target.slice(0, -'.html'.length)
  let link = fs.link
  for (let n = 1; ; n++) {
    const name = n === 1 ? target : n <= MAX_NUMBERED ? `${stem} (${n}).html` : `${stem} (${randomBytes(6).toString('hex')}).html`
    try {
      if (link) {
        await link(part, name)
        return { name, linked: true }
      }
      await fs.writeFile(name, '', { flag: 'wx' })
      return { name, linked: false }
    } catch (e) {
      if (errCode(e) === 'EEXIST') {
        if (n > MAX_NUMBERED) throw e
      } else if (link) {
        // No hard link here: the same name again, claimed empty, and every name after it.
        link = undefined
        n--
      } else throw e
    }
  }
}

/**
 * Writes `data` to `part`, then renames it to `target`. On a failure, or a cancel before the rename, the .part is
 * removed and `target` is left as it was. The size is the written file's, or the data's when it cannot be read.
 * With `newName` the target is a name the dialog never saw, so no file there is replaced: placeNew picks the name
 * when the file is written, not when the dialog closed, and two saves of one name (or a file another program made
 * meanwhile) each keep their own file. A name placeNew hard-linked already holds the file, and only the .part goes.
 */
async function writeAtomically(fs: ExportFs, part: string, target: string, data: string, signal?: AbortSignal, newName = false): Promise<ExportResult> {
  if (signal?.aborted) return { ok: false, error: CANCELLED, cancelled: true }
  let phase: 'write' | 'rename' = 'write'
  let path = target
  let claimed: string | null = null
  let linked = false
  try {
    await fs.writeFile(part, data)
    if (newName && !signal?.aborted) {
      const placed = await placeNew(fs, part, target)
      path = claimed = placed.name
      linked = placed.linked
    }
    if (signal?.aborted) {
      await removeQuietly(fs, part)
      if (claimed !== null) await removeQuietly(fs, claimed)
      return { ok: false, error: CANCELLED, cancelled: true }
    }
    phase = 'rename'
    if (linked) await removeQuietly(fs, part)
    else await fs.rename(part, path)
  } catch (e) {
    await removeQuietly(fs, part)
    if (claimed !== null) await removeQuietly(fs, claimed)
    return { ok: false, error: writeError(e, phase) }
  }
  const bytes = await fs.stat(path).then((s) => s.size, () => Buffer.byteLength(data, 'utf8'))
  return { ok: true, path, bytes }
}

/** A failure reading one of the export's own files. */
class AssetError extends Error {
  constructor(readonly result: ExportResult) { super('export asset') }
}

const readOr = (fs: ExportFs, path: string, onFail: ExportResult): Promise<Uint8Array> =>
  path === '' ? Promise.reject(new AssetError(onFail)) : fs.readFile(path).catch(() => { throw new AssetError(onFail) })

const keywordOnly: ExportResult = { ok: false, error: NO_MODEL, keywordOnly: true }

/** The smart Ask blocks besides the index: the tokenizer (both files, as JSON), the ORT wasm and the model. Null
 *  when a cancel came while they were read: the 37 MB are then never parsed or compressed. */
async function smartFiles(fs: ExportFs, assets: ExportAssets, signal: AbortSignal): Promise<{ id: string; gz64: string }[] | null> {
  const dir = assets.modelDir
  const [tokenizer, tokenizerConfig, wasm, model] = await Promise.all([
    readOr(fs, dir === '' ? '' : join(dir, 'tokenizer.json'), keywordOnly),
    readOr(fs, dir === '' ? '' : join(dir, 'tokenizer_config.json'), keywordOnly),
    readOr(fs, assets.ortWasm, keywordOnly),
    readOr(fs, assets.modelFile, keywordOnly),
  ])
  if (signal.aborted) return null
  const text = (b: Uint8Array): unknown => JSON.parse(Buffer.from(b).toString('utf8'))
  let vocab: string
  try {
    vocab = safeJson({ tokenizer: text(tokenizer), tokenizerConfig: text(tokenizerConfig) })
  } catch {
    throw new AssetError(keywordOnly)
  }
  const [v, w, m] = await Promise.all([gz64(vocab), gz64(wasm), gz64(model)])
  return [{ id: 'vocab', gz64: v }, { id: 'ortwasm', gz64: w }, { id: 'model', gz64: m }]
}

/**
 * Exports the world as one offline page at `req.target` (spec 5.2 and 5.3). The world is checked, sanitised (no
 * path outside the project, no private evidence), given its plan (prepareWorld) and checked as the page will check
 * it. A smart export embeds the Ask entries in chunks of EMBED_CHUNK, checking the cancel between chunks.
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
  const prepared = prepareWorld(req)
  if (!prepared.ok) return prepared
  const doc = prepared.doc
  const meta = pageMeta(doc, { title: prepared.title, exportedOn: req.exportedOn, ...(prepared.proposalId !== undefined ? { proposalId: prepared.proposalId } : {}) })
  const entries = askEntries(doc)
  let runtimeJs: string
  let extra: { id: string; gz64: string }[] = []
  // The cancel is checked after each read and after the compression (the model alone is 37 MB).
  try {
    runtimeJs = Buffer.from(await readOr(fs, deps.assets.runtimeJs, { ok: false, error: NO_RUNTIME })).toString('utf8')
    if (signal.aborted) return cancelled()
    if (req.smart) {
      const files = await smartFiles(fs, deps.assets, signal)
      if (files === null) return cancelled()
      extra = files
    }
  } catch (e) {
    return (e as AssetError).result
  }
  if (signal.aborted) return cancelled()
  progress({ step: 'prepare', done: 1, total: 1 })

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
    extra = [{ id: 'askvec', gz64: await gz64(new Uint8Array(packed.data.buffer, packed.data.byteOffset, packed.data.byteLength)) }, ...extra]
  }

  progress({ step: 'write', done: 0, total: 1 })
  const [world, metaGz, askGz] = await Promise.all([gz64(safeJson(doc)), gz64(safeJson(meta)), gz64(ask)])
  if (signal.aborted) return cancelled()
  let html: string
  try {
    html = exportPageHtml({
      title: prepared.title,
      blocks: [{ id: 'world', gz64: world }, { id: 'meta', gz64: metaGz }, { id: 'ask', gz64: askGz }, ...extra],
      runtimeJs,
    })
  } catch {
    return { ok: false, error: NO_RUNTIME }
  }
  const result = await writeAtomically(fs, part, req.target, html, signal, req.newName)
  if (result.ok) progress({ step: 'write', done: 1, total: 1 })
  return result
}

/**
 * Writes the world's documentation (spec 5.4) to `req.target` as one HTML file, through the same .part-then-rename
 * as the page. The world is checked before the sanitiser reads it (a malformed one is refused, never thrown on),
 * then sanitised, title included; `picturePng` (a PNG data URL of the city) is optional. A cancel (`signal`) before
 * the rename leaves no file.
 */
export async function writeDocument(
  req: { doc: WorldDoc; ctx: SanitizeContext; title: string; picturePng?: string; target: string; newName?: boolean; generatedOn: string },
  fs: ExportFs,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const checked = validateWorld(req.doc)
  if (!checked.ok) return failedChecks(NOT_DOCUMENTABLE, checked.errors[0])
  const doc = sanitizeWorld(checked.doc, req.ctx)
  const title = sanitizeText(req.title, req.ctx)
  const model = buildDocumentation(doc, { title, picture: req.picturePng !== undefined, generatedOn: req.generatedOn })
  return writeAtomically(fs, partName(req.target), req.target, renderDocumentation(model, doc, req.picturePng), signal, req.newName)
}

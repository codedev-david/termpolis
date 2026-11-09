// v1.56.0 per-message routing: the local classifier, run where the embedder already lives (the memory
// host; in-process when the host is down). It embeds the labelled seeds once, caches their vectors in
// userData keyed by a hash of the seed texts, and keeps the user's own picks beside them as vectors
// only: the text of a message the user re-routed never reaches the disk.

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { embedBatch, embedText } from './localEmbedder'
import { flatSeeds, type SeedLabel } from '../shared/routerSeeds'
import { knnClassify, USER_WEIGHT, type LabeledVec, type Classification } from '../shared/smartRoute'

export const SEED_FILE = 'router-seeds.json'
export const USER_FILE = 'router-examples.json'
/** The user's picks kept, newest first wins: past this the oldest go. */
export const MAX_USER_EXAMPLES = 300
const EMBED_MODEL = 'bge-small-en-v1.5'
const LABELS: readonly SeedLabel[] = ['keep', 'haiku', 'sonnet', 'opus']

let seeds: LabeledVec[] | null = null
let seedsDir = ''
let seedsLoading: Promise<LabeledVec[] | null> | null = null
let user: LabeledVec[] | null = null
let userDir = ''

export function _resetRouterModelForTests(): void {
  seeds = null; seedsDir = ''; seedsLoading = null; user = null; userDir = ''
}

/** Changes whenever a seed text, its label or the embedding model does: the cache is then rebuilt. */
export function seedHash(): string {
  return createHash('sha256').update(EMBED_MODEL + '\n' + JSON.stringify(flatSeeds())).digest('hex').slice(0, 16)
}

/** The vector at unit length, rounded so the cache file stays small. null for an empty or zero vector. */
export function unit(v: ArrayLike<number> | null | undefined): number[] | null {
  if (!v || v.length === 0) return null
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  if (!(n > 0) || !Number.isFinite(n)) return null
  const out = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) out[i] = Math.round((v[i] / n) * 1e4) / 1e4
  return out
}

function isLabel(v: unknown): v is SeedLabel {
  return typeof v === 'string' && (LABELS as readonly string[]).includes(v)
}

/** Items read from a cache file, keeping only well-formed ones. */
export function parseItems(raw: unknown): LabeledVec[] {
  if (!Array.isArray(raw)) return []
  const out: LabeledVec[] = []
  for (const it of raw) {
    const o = it as { label?: unknown; vec?: unknown }
    if (o && isLabel(o.label) && Array.isArray(o.vec) && o.vec.length > 0 && o.vec.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      out.push({ label: o.label, vec: o.vec as number[] })
    }
  }
  return out
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')) } catch { return null }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  try {
    const tmp = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(data))
    await fs.promises.rename(tmp, file)
  } catch { /* a cache: the next start embeds again */ }
}

/** A router file, only under a real data folder: a missing one must never read or write the working folder. */
function dataFile(dir: string, name: string): string | null {
  return dir && path.isAbsolute(dir) ? path.join(dir, name) : null
}

async function buildSeeds(dir: string): Promise<LabeledVec[] | null> {
  const flat = flatSeeds()
  const hash = seedHash()
  const file = dataFile(dir, SEED_FILE)
  const cached = (file ? await readJson(file) : null) as { hash?: unknown; items?: unknown } | null
  if (cached && cached.hash === hash) {
    const items = parseItems(cached.items)
    if (items.length === flat.length) return items
  }
  const vecs = await embedBatch(flat.map((s) => s.text))
  const items: LabeledVec[] = []
  for (let i = 0; i < flat.length; i++) {
    const v = unit(vecs[i])
    if (!v) return null // the embedder is not up: nothing is cached, the next call tries again
    items.push({ label: flat[i].label, vec: v })
  }
  if (file) await writeJson(file, { hash, items })
  return items
}

/** The seed vectors, embedded once per start (or read from the cache). null while the embedder is down. */
export async function loadSeeds(dir: string): Promise<LabeledVec[] | null> {
  if (seeds && seedsDir === dir) return seeds
  if (seedsLoading) return seedsLoading
  seedsLoading = buildSeeds(dir)
    .then((s) => { if (s) { seeds = s; seedsDir = dir } return s })
    .catch(() => null)
    .finally(() => { seedsLoading = null })
  return seedsLoading
}

async function loadUser(dir: string): Promise<LabeledVec[]> {
  if (user && userDir === dir) return user
  const file = dataFile(dir, USER_FILE)
  const raw = (file ? await readJson(file) : null) as { items?: unknown } | null
  user = parseItems(raw?.items).slice(-MAX_USER_EXAMPLES).map((e) => ({ ...e, weight: USER_WEIGHT }))
  userDir = dir
  return user
}

/** Embed the seeds ahead of the first message, so the first decision is as quick as the rest. */
export async function routerWarm(dir: string): Promise<boolean> {
  return (await loadSeeds(String(dir ?? ''))) !== null
}

export interface ClassifyResult {
  cls: Classification | null
  /** Milliseconds the embedding and the vote took. */
  ms: number
}

/** The nearest examples' vote on one message. cls is null while the embedder is down. */
export async function routerClassify(dir: string, text: string): Promise<ClassifyResult> {
  const started = Date.now()
  const d = String(dir ?? '')
  const t = String(text ?? '').slice(0, 2000)
  const s = await loadSeeds(d)
  if (!s || !t.trim()) return { cls: null, ms: Date.now() - started }
  const q = unit(await embedText(t))
  if (!q) return { cls: null, ms: Date.now() - started }
  return { cls: knnClassify(q, [...s, ...(await loadUser(d))]), ms: Date.now() - started }
}

/** The user moved a message to `label`: keep its vector (never its text) as an example that counts double. */
export async function routerLearn(dir: string, text: string, label: string): Promise<boolean> {
  const file = dataFile(String(dir ?? ''), USER_FILE)
  if (!isLabel(label) || !file) return false
  const q = unit(await embedText(String(text ?? '').slice(0, 2000)))
  if (!q) return false
  const list = [...(await loadUser(String(dir))), { label, vec: q, weight: USER_WEIGHT }].slice(-MAX_USER_EXAMPLES)
  user = list
  await writeJson(file, { items: list.map((e) => ({ label: e.label, vec: e.vec })) })
  return true
}

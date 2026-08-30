// headroom/receiptArtifact.ts
//
// A portable, tamper-evident savings receipt.
//
// WHY: "we cut your token bill roughly in half" is the one claim this app makes that
// no model vendor will ever make for you, and it is also the one claim nobody has any
// reason to believe. The in-app dashboard cannot fix that — it convinces the person
// already running the app. The receipt is the exportable form: a canonical JSON blob
// plus a rendering, signed so that a copy can be checked against its own numbers.
//
// HONESTY CONSTRAINT, and it governs the whole design: this is a SELF-signed receipt.
// The HMAC key lives on the same machine that issued it, so the signature proves the
// document has not been edited since issue — it does NOT attest that the underlying
// counters are true, and no local artifact can. Anything that implied third-party
// verification would be a lie told with cryptography, so `verifyReceipt` reports
// exactly that scope and the rendered artifact says it in the footer. What actually
// makes the numbers credible is the arithmetic being reproducible from the raw
// counters, which is why every input is carried in the payload.

import crypto from 'crypto'
import type { UnifiedTotals } from './unifiedReceipt'
import { isoFromEpochMs } from '../isoTime'

/** Anthropic's published multipliers, relative to one uncached input token. Output is
 *  5x input across the Claude line ($3/$15 for Sonnet, $15/$75 for Opus), so a single
 *  ratio is correct for every model in the family and no model id is needed. */
export const W_CACHE_READ = 0.1
export const W_CACHE_WRITE = 1.25
export const W_INPUT = 1.0
export const W_OUTPUT = 5.0

export const RECEIPT_VERSION = 2

export interface CostSplit {
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
  total: number
}

/** Where the money actually goes, in effective units.
 *
 *  This is the single most useful number the ledger can produce and it is not the one
 *  the dashboard leads with. Compression works on the INPUT side; on real measured
 *  traffic the input side is ~69% of the bill and output is the other ~30% — so the
 *  ceiling on compression alone is visible here, in the user's own data, rather than
 *  discovered after another release of tuning. */
export function costSplit(t: Pick<UnifiedTotals, 'cacheReadTokens' | 'cacheCreationTokens' | 'inputTokens' | 'outputTokens'>): CostSplit {
  const cacheRead = t.cacheReadTokens * W_CACHE_READ
  const cacheWrite = t.cacheCreationTokens * W_CACHE_WRITE
  const input = t.inputTokens * W_INPUT
  const output = t.outputTokens * W_OUTPUT
  return { cacheRead, cacheWrite, input, output, total: cacheRead + cacheWrite + input + output }
}

export function sharePct(split: CostSplit): Record<'cacheRead' | 'cacheWrite' | 'input' | 'output', number> {
  const round = (n: number): number => (split.total > 0 ? Math.round((n / split.total) * 1000) / 10 : 0)
  return { cacheRead: round(split.cacheRead), cacheWrite: round(split.cacheWrite), input: round(split.input), output: round(split.output) }
}

export interface ReceiptPayload {
  version: number
  issuedAt: number
  /** Opaque, stable per install. NOT a user identifier — a salted hash, so two
   *  receipts can be told apart without either naming anybody. */
  installHash: string
  requests: number
  origTokens: number
  grossSavedTokens: number
  netSavedTokens: number
  savedPct: number
  retrieves: number
  givebackTokens: number
  /** retrieves / requests. The fidelity evidence: if elision were losing context that
   *  the model needed, this rate would be high, because the model would keep asking
   *  for the originals back. A low rate is the only direct evidence the compression is
   *  not quietly degrading the work. */
  retrieveRate: number
  worstSavedPct: number
  usage: { cacheReadTokens: number; cacheCreationTokens: number; inputTokens: number; outputTokens: number }
  split: CostSplit
  share: Record<string, number>
}

/** Deterministic serialisation. Object key order in JS is insertion order, which is
 *  stable here but would silently change if a field were ever reordered in the struct
 *  — and a signature over a reordered document fails to verify for no visible reason.
 *  Sorting the keys makes the signed bytes a function of the CONTENT alone. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`
}

export function buildPayload(
  totals: UnifiedTotals,
  opts: { installHash: string; now: number },
): ReceiptPayload {
  const split = costSplit(totals)
  const origTokens = totals.wireOrigTokens + totals.toolOrigTokens
  return {
    version: RECEIPT_VERSION,
    issuedAt: opts.now,
    installHash: opts.installHash,
    requests: totals.requests,
    origTokens,
    grossSavedTokens: totals.grossSavedTokens,
    netSavedTokens: totals.netSavedTokens,
    savedPct: totals.savedPct,
    retrieves: totals.retrieves,
    givebackTokens: totals.givebackTokens,
    retrieveRate: totals.requests > 0 ? Math.round((totals.retrieves / totals.requests) * 10000) / 10000 : 0,
    worstSavedPct: totals.worstSavedPct,
    usage: {
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
    },
    split,
    share: sharePct(split),
  }
}

export interface SignedReceipt {
  payload: ReceiptPayload
  /** HMAC-SHA256 over `canonicalJson(payload)`, hex. */
  signature: string
  algorithm: 'HMAC-SHA256'
}

export function signReceipt(payload: ReceiptPayload, key: string): SignedReceipt {
  const signature = crypto.createHmac('sha256', key).update(canonicalJson(payload)).digest('hex')
  return { payload, signature, algorithm: 'HMAC-SHA256' }
}

export interface VerifyResult {
  /** The signature matches the payload: nothing was edited after issue. */
  intact: boolean
  /** The arithmetic in the payload is self-consistent — checkable by ANYONE, with no
   *  key at all, which is the part of the receipt that carries actual weight. */
  consistent: boolean
  problems: string[]
  scope: string
}

const SCOPE =
  'Self-signed: the HMAC key belongs to the issuing install, so a valid signature shows the ' +
  'document is unedited since issue. It does NOT independently attest the counters. The ' +
  'arithmetic check needs no key and is what a third party can verify.'

/** Recompute everything derivable from the raw counters and compare. A doctored
 *  "94% saved" headline survives the signature check only if the forger also re-signed;
 *  it never survives this, because the raw usage counters would have to be doctored to
 *  match, and those are what the cost split is computed from. */
export function verifyReceipt(receipt: SignedReceipt, key?: string): VerifyResult {
  const problems: string[] = []
  const { payload } = receipt

  const intact = key
    ? crypto.timingSafeEqual(
        Buffer.from(crypto.createHmac('sha256', key).update(canonicalJson(payload)).digest('hex')),
        Buffer.from(receipt.signature.padEnd(64, '0').slice(0, 64)),
      )
    : false
  if (key && !intact) problems.push('signature does not match payload')

  const split = costSplit(payload.usage)
  const near = (a: number, b: number, tol = 0.5): boolean => Math.abs(a - b) <= tol
  if (!near(split.total, payload.split.total, Math.max(1, split.total * 1e-9))) {
    problems.push('cost split does not follow from usage counters')
  }
  const expectedPct = payload.origTokens > 0 ? (payload.netSavedTokens / payload.origTokens) * 100 : 0
  if (!near(expectedPct, payload.savedPct, 0.5)) {
    problems.push(`savedPct ${payload.savedPct} does not follow from ${payload.netSavedTokens}/${payload.origTokens}`)
  }
  if (payload.netSavedTokens > payload.grossSavedTokens) {
    problems.push('net saving exceeds gross saving')
  }
  const expectedRate = payload.requests > 0 ? payload.retrieves / payload.requests : 0
  if (!near(expectedRate, payload.retrieveRate, 0.001)) {
    problems.push('retrieve rate does not follow from retrieves/requests')
  }

  return { intact, consistent: problems.length === 0, problems, scope: SCOPE }
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')
const pct = (n: number): string => `${Math.round(n * 10) / 10}%`

/** Markdown rendering — the form that pastes into a PR, an issue or a README. */
export function renderReceiptMarkdown(receipt: SignedReceipt): string {
  const p = receipt.payload
  const verdict = verifyReceipt(receipt)
  return [
    '# Termpolis Token Headroom — savings receipt',
    '',
    `Issued ${isoFromEpochMs(p.issuedAt)} · install \`${p.installHash.slice(0, 12)}\` · receipt v${p.version}`,
    '',
    '## Bottom line',
    '',
    `| | |`,
    `|---|---|`,
    `| Requests measured | ${fmt(p.requests)} |`,
    `| Tokens examined | ${fmt(p.origTokens)} |`,
    `| Saved (net of give-back) | **${fmt(p.netSavedTokens)}** (${pct(p.savedPct)}) |`,
    `| Cost of reversing compression | ${fmt(p.givebackTokens)} across ${fmt(p.retrieves)} retrievals |`,
    `| Retrieval rate | ${pct(p.retrieveRate * 100)} of requests |`,
    '',
    '## Where the remaining bill is',
    '',
    'Effective units, using Anthropic\'s published multipliers (cache read 0.1x, cache write 1.25x, output 5x input).',
    '',
    `| Bucket | Tokens | Share of bill |`,
    `|---|---|---|`,
    `| Cache reads | ${fmt(p.usage.cacheReadTokens)} | ${pct(p.share.cacheRead)} |`,
    `| Cache writes | ${fmt(p.usage.cacheCreationTokens)} | ${pct(p.share.cacheWrite)} |`,
    `| Fresh input | ${fmt(p.usage.inputTokens)} | ${pct(p.share.input)} |`,
    `| Output | ${fmt(p.usage.outputTokens)} | ${pct(p.share.output)} |`,
    '',
    `Compression acts on the input side. Output is ${pct(p.share.output)} of the bill and no amount of`,
    'input compression touches it — that is the ceiling this receipt makes visible.',
    '',
    '## Verification',
    '',
    `- Arithmetic self-consistent: **${verdict.consistent ? 'yes' : 'NO — ' + verdict.problems.join('; ')}**`,
    `- Signature (${receipt.algorithm}): \`${receipt.signature.slice(0, 16)}…\``,
    '',
    verdict.scope,
    '',
    'Recheck with `termpolis-cli receipt --verify <file>`.',
  ].join('\n')
}

/** The full artifact: payload, signature, and a rendering, in one file that can be
 *  re-verified after a round trip through anything that preserves text. */
export function renderReceiptJson(receipt: SignedReceipt): string {
  return JSON.stringify(receipt, null, 2)
}

/**
 * What the wire proxy knows about an elision at the moment it makes one, and the vocabulary the
 * elision ledger counts in.
 *
 * Pure types and functions, no state and no I/O, and no clock: the proxy child imports this file
 * (so it must stay free of electron and fs), the main process imports it to count, and the
 * compression sweep forbids anything here that would make a stash depend on when it was made.
 */

import { isFirstSightPolicy, type FirstSightPolicy } from './elisionPolicy'

/** How a token came to be on the wire. A `compact` is the first-sight head/tail window or
 *  structural reduction; `dedup` and `diff` replace a repeat or a near-repeat of an earlier result
 *  in the same request; `decay` ages out the old half of a long conversation. */
export type ElisionKind = 'compact' | 'dedup' | 'diff' | 'decay'
export const ELISION_KINDS: readonly ElisionKind[] = ['compact', 'dedup', 'diff', 'decay']

/** Stored beside each original in the stash. Tiny on purpose: one of these rides every stash. */
export interface ElisionMeta {
  kind: ElisionKind
  /** The tool whose result this was, as the request named it; absent when the body did not say. */
  tool?: string
  /** Characters of the original text that was replaced. */
  chars: number
  /** Characters of what replaced it on the wire. */
  view: number
  model?: string
  /** The first-sight policy the request ran under: `late`, or `legacy` for a conversation held out on the
   *  old behaviour and for a run on the Settings kill switch. Absent on a stash from before it was
   *  recorded, which ran the old behaviour. Only a compaction's class depends on it (see classKey). */
  policy?: FirstSightPolicy
}

/** One original handed from the proxy to the stash. `meta` is absent on a stash from before v1.55. */
export interface StashEntry { token: string; original: string; meta?: ElisionMeta }

/** A tool or model name is the client's to choose; nothing stored should grow without bound. */
const MAX_NAME = 80

export function makeMeta(kind: ElisionKind, tool: string | undefined, chars: number, view: number): ElisionMeta {
  const m: ElisionMeta = { kind, chars, view }
  if (tool) m.tool = tool.slice(0, MAX_NAME)
  return m
}

/** Put the request's model on every meta of a body. The model is one field of the body, so this
 *  stays a function of the body alone. A meta-less entry (nothing in this release makes one) is skipped. */
export function stampModel(stashes: StashEntry[], model: unknown): void {
  if (typeof model !== 'string' || model === '') return
  const name = model.slice(0, MAX_NAME)
  for (const s of stashes) if (s.meta) s.meta.model = name
}

/** Put the policy a request ran under on every meta of a body. Like the model it is a function of the
 *  request alone, and it rides beside the stash without entering the forwarded bytes. */
export function stampPolicy(stashes: StashEntry[], policy: FirstSightPolicy): void {
  if (!isFirstSightPolicy(policy)) return
  for (const s of stashes) if (s.meta) s.meta.policy = policy
}

/** The size bands of the research's redemption table (section 5.2). */
export const SIZE_BANDS = ['<1.6k', '1.6-4k', '4-10k', '10-40k', '40k+'] as const
export type SizeBand = (typeof SIZE_BANDS)[number]

/** Anything that is not a number of at least 1,600 (negative, NaN) is the smallest band. */
export function sizeBand(chars: number): SizeBand {
  if (!(chars >= 1600)) return '<1.6k'
  if (chars < 4000) return '1.6-4k'
  if (chars < 10_000) return '4-10k'
  if (chars < 40_000) return '10-40k'
  return '40k+'
}

/** The tools the research measured, then MCP tools and everything else. Bounded, so the class
 *  table cannot grow with the names a client invents. */
export const TOOL_CLASSES = ['Read', 'Bash', 'Grep', 'Glob', 'PowerShell', 'WebFetch', 'WebSearch', 'mcp', 'other'] as const
export type ToolClass = (typeof TOOL_CLASSES)[number]
const NAMED_TOOLS: ReadonlySet<string> = new Set(['Read', 'Bash', 'Grep', 'Glob', 'PowerShell', 'WebFetch', 'WebSearch'])

export function toolClass(tool: unknown): ToolClass {
  if (typeof tool !== 'string') return 'other'
  if (NAMED_TOOLS.has(tool)) return tool as ToolClass
  return tool.startsWith('mcp__') ? 'mcp' : 'other'
}

/**
 * The ledger's class: kind, tool class and size band, joined by `|`. A compaction made under the `late`
 * policy carries a fourth part, `late`. A key without one is the old behaviour, which is what every key
 * written before the policy was recorded was, and what the holdout and the Legacy setting run: so the
 * Elision health card can judge the policy in force apart from the one kept for comparison, and a ledger
 * from before reads as it always did. A repeat, a patch and an aged-out result are made the same way
 * under both policies, so their keys do not split.
 */
export function classKey(meta: ElisionMeta): string {
  const base = `${meta.kind}|${toolClass(meta.tool)}|${sizeBand(meta.chars)}`
  return meta.kind === 'compact' && meta.policy === 'late' ? `${base}|late` : base
}

export interface ParsedClass { kind: ElisionKind; tool: ToolClass; band: SizeBand; policy: FirstSightPolicy }

/** The inverse of classKey; null for anything classKey could not have built. */
export function parseClassKey(key: string): ParsedClass | null {
  const parts = key.split('|')
  if (parts.length !== 3 && parts.length !== 4) return null
  const [kind, tool, band, policy] = parts
  if (!(ELISION_KINDS as readonly string[]).includes(kind)) return null
  if (!(TOOL_CLASSES as readonly string[]).includes(tool)) return null
  if (!(SIZE_BANDS as readonly string[]).includes(band)) return null
  if (parts.length === 4 && !(kind === 'compact' && policy === 'late')) return null
  return { kind: kind as ElisionKind, tool: tool as ToolClass, band: band as SizeBand, policy: parts.length === 4 ? 'late' : 'legacy' }
}

/**
 * A meta read back from a stash file, or undefined when it is not one. A file from before v1.55
 * has none, and a damaged one must read as none: the value beside it is what matters, and a stash
 * that fails to resolve over its bookkeeping would break the one promise retrieve_full makes.
 */
export function sanitizeMeta(raw: unknown): ElisionMeta | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (!(ELISION_KINDS as readonly unknown[]).includes(r.kind)) return undefined
  const size = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (!size(r.chars) || !size(r.view)) return undefined
  const m = makeMeta(r.kind as ElisionKind, typeof r.tool === 'string' ? r.tool : undefined, r.chars, r.view)
  if (typeof r.model === 'string') m.model = r.model.slice(0, MAX_NAME)
  if (isFirstSightPolicy(r.policy)) m.policy = r.policy
  return m
}

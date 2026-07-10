// codeLocate.ts
//
// The Weave (v1.23 C5) — the issue -> LOCATION predictor. Given a problem description (or an
// error that just scrolled by), it answers "where is this found / where do I fix it" with a
// ranked list of {file, symbol, why:[past lessons]}. This is what turns recall into prediction:
// it crosses the memory<->code bridge — issue text -> tokens -> code symbols/files -> the memories
// anchored there (symbolHistory) + code-graph centrality (codeImpact) — and ranks the sites.
//
// PURE / injectable (no electron, no store, no clock): every dep is passed in and `now` is the
// injected clock, so every branch is deterministic and unit-testable. index.ts wires the real
// code-graph + memory deps and exposes it as the code_locate MCP tool + the proactive hook.

import { learnedUtility } from './mnemeRetrieval'

/** A past memory that explains WHY a site is a candidate (a fix/decision anchored to it). */
export interface LocatorMemory {
  id: string
  content?: string
  importance?: number
  useCount?: number
  ts?: number
  memoryType?: string
}
export interface LocatorSymbol {
  id: string
  name: string
  file: string
}
export interface LocateDeps {
  /** Extract the salient tokens (files / identifiers / error codes) from the issue text. */
  signals: (text: string) => string[]
  /** Resolve a token to code locations (code graph). */
  resolve: (token: string) => { symbols: LocatorSymbol[]; files: string[] }
  /** The memories anchored to a symbol name / file (the memory<->code bridge, symbolHistory). */
  history: (query: string) => LocatorMemory[]
  /** Blast-radius size of a symbol (codeImpact length) — a centrality proxy. */
  impact: (name: string) => number
  /** Injected clock (ms). */
  now: number
}
export interface LocateOptions {
  limit?: number
}
export interface LocatedSite {
  file: string
  symbol?: string
  symbolId?: string
  score: number
  why: LocatorMemory[]
}

const MAX_WHY = 5

/**
 * Rank the code sites an issue most likely lives in. A site is kept only if it has a supporting
 * lesson OR is an exact-symbol hit (the "needs ≥1 lesson or a strong token" gate that keeps this
 * from guessing). Score = (symbolBonus + Σ lesson utility) × (1 + ln(1 + blast radius)); ties
 * break toward the most recently-learned site. Deterministic; empty issue → [].
 */
export function codeLocate(issueText: string, deps: LocateDeps, opts: LocateOptions = {}): LocatedSite[] {
  const limit = Math.max(1, opts.limit ?? 8)
  let tokens: string[] = []
  try {
    tokens = deps.signals(issueText) || []
  } catch {
    tokens = []
  }
  if (tokens.length === 0) return []

  interface Acc { file: string; symbol?: string; symbolId?: string; impact: number; why: Map<string, LocatorMemory> }
  const sites = new Map<string, Acc>()
  const ensure = (key: string, base: { file: string; symbol?: string; symbolId?: string }): Acc => {
    let s = sites.get(key)
    if (!s) {
      s = { ...base, impact: 0, why: new Map() }
      sites.set(key, s)
    }
    return s
  }
  const addWhy = (acc: Acc, mems: LocatorMemory[] | undefined): void => {
    for (const m of mems || []) if (m && m.id) acc.why.set(m.id, m)
  }

  for (const token of tokens) {
    let resolved: { symbols: LocatorSymbol[]; files: string[] }
    try {
      resolved = deps.resolve(token) || { symbols: [], files: [] }
    } catch {
      continue
    }
    for (const sym of resolved.symbols || []) {
      const acc = ensure(`s:${sym.id}`, { file: sym.file, symbol: sym.name, symbolId: sym.id })
      try { acc.impact = Math.max(acc.impact, deps.impact(sym.name)) } catch { /* keep prior */ }
      try { addWhy(acc, deps.history(sym.name)) } catch { /* best effort */ }
    }
    for (const f of resolved.files || []) {
      const acc = ensure(`f:${f}`, { file: f })
      try { addWhy(acc, deps.history(token)) } catch { /* best effort */ }
    }
  }

  const scored: Array<{ site: LocatedSite; newest: number }> = []
  for (const acc of sites.values()) {
    const why = [...acc.why.values()].sort(
      (a, b) => (b.ts ?? 0) - (a.ts ?? 0) || (b.importance ?? 0) - (a.importance ?? 0),
    )
    if (why.length === 0 && !acc.symbol) continue // gate: no lesson AND not a strong symbol hit
    const whyScore = why.reduce(
      (sum, m) => sum + learnedUtility({ id: m.id, relevance: 1, importance: m.importance, useCount: m.useCount, ts: m.ts }, deps.now),
      0,
    )
    const symbolBonus = acc.symbol ? 0.5 : 0
    const score = (symbolBonus + whyScore) * (1 + Math.log1p(Math.max(0, acc.impact)))
    const newest = why.reduce((mx, m) => Math.max(mx, m.ts ?? 0), 0)
    scored.push({
      site: { file: acc.file, symbol: acc.symbol, symbolId: acc.symbolId, score, why: why.slice(0, MAX_WHY) },
      newest,
    })
  }
  scored.sort((a, b) => b.site.score - a.site.score || b.newest - a.newest)
  return scored.slice(0, limit).map((s) => s.site)
}

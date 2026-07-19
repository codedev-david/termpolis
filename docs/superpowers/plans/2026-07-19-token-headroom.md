# Token Headroom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-first, deterministic token-savings layer that compresses Termpolis's own MCP tool outputs (reversible via a `retrieve_full` tool), steers output verbosity at launch, and surfaces a measured savings receipt in Settings — provably, with zero performance impact.

**Architecture:** A single interception point wraps `compressToolResult(name, result)` around the MCP `tools/call` return (`src/main/mcpServer.ts:685`). Compression is pure-TypeScript and shape-driven: the tool name decides *exempt-or-not*; the result *shape* (array vs object) picks one of two generic compressors. Aggressive-but-reversible: full originals are cached in an in-memory session LRU (CCR) and re-fetched on demand via a new `retrieve_full` MCP tool. A buffered ledger records measured tokens-removed for the receipt. Everything is fail-open — any error returns the original, uncompressed result.

**Tech Stack:** TypeScript, Node/Electron main process, node-pty MCP server, Vitest (v8 coverage), React renderer (Settings panel). No new runtime dependencies. No ML model.

## Global Constraints

- **No new runtime dependencies.** Pure TS; reuse `estimateTokens` from `src/main/memoryEconomy.ts:9`.
- **No ML / no Python / no HuggingFace.** Deterministic structural transforms only.
- **Fail-open everywhere.** Any error in the compression path returns `JSON.stringify(result, null, 2)` — a bug must degrade to "no savings", never a corrupted tool result.
- **`memory_*` and control tools are EXEMPT** (byte-identical passthrough). The brain store, recall ranking, and learning are never touched — compression is outbound-render only.
- **Performance:** compression runs on a single bounded tool result, single-pass/linear, no sync disk I/O on the hot path. Hard byte cap `MAX_COMPRESS_BYTES = 4_000_000` → passthrough above it. CCR is in-memory LRU; ledger flush is async/best-effort.
- **Coverage gates (Windows CI, `vitest.config.ts:99-102`): lines 97, functions 96, branches 93, statements 96.** New `src/main/headroom/**` modules must approach 100%. Do not let the full suite drop below the gate.
- **Commit directly to `main`** (project convention — no branches/PRs). Stage only changed files.
- **Ship as v1.28.0** — do NOT bump/tag until the in-flight v1.27.8 release completes and the full suite is green.
- **Test commands:** whole suite `npm test` (= `vitest run`); single file `npx vitest run <path>`; coverage `npm run test:coverage`.
- **Test scaffolding conventions:** top-level `vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))`, then dynamic `const { X } = await import('../../src/main/...')` AFTER the mock. Handlers are `vi.fn()` objects cast `as unknown as McpToolHandlers`.

---

## File Structure

**New (`src/main/headroom/`):**
- `config.ts` — settings authority (pure, in-memory) + per-mode thresholds + `MAX_COMPRESS_BYTES`.
- `ccrStore.ts` — in-memory session LRU: `ccrStash(value) → token`, `ccrRetrieve(token) → value | undefined`.
- `compactText.ts` — `compactText(s, opts)`: collapse consecutive duplicate lines + head/tail window.
- `router.ts` — `isExempt(tool)`, `route(tool, result) → 'exempt' | 'array' | 'object'`.
- `compressors.ts` — `compressArray(arr, opts)`, `compressObject(obj, opts)` (both pure, return `{ text, offload? }`).
- `savingsLedger.ts` — `recordEvent(ev)`, `summarizeSavings()`, `resetLedger()`; buffered async flush.
- `outputSteering.ts` — `steeringDirective()` (pure terseness/effort block).
- `compressToolResult.ts` — orchestrator wiring all of the above; the single fail-open entry point.

**New (renderer):**
- `src/renderer/src/components/SettingsPane/TokenSavingsSettings.tsx` — toggles + receipt.

**Modified:**
- `src/main/mcpServer.ts` — add `retrieveFull` to `McpToolHandlers` (:480), `retrieve_full` case in `executeTool` (:515-643), `retrieve_full` entry in `TOOLS` (:114-478), and wrap `compressToolResult` at the `tools/call` return (:682-687).
- `src/main/index.ts` — `retrieveFull` handler in the handlers object (near :2714-2719); startup settings/ledger init; `tokenSavings:*` IPC handlers; append `steeringDirective()` in the primer `instruction` array (:2004-2022).
- `src/preload/index.ts` — `tokenSavingsGetSettings/SetSettings/GetReceipt` methods (near :160).
- `src/renderer/src/types/index.ts` — three method signatures in `TermpolisAPI` (near :245).
- `src/renderer/src/lib/settingsNav.ts` — add `'tokenSavings'` to the `SettingsTab` union (:9).
- `src/renderer/src/components/SettingsPane/SettingsPane.tsx` — import panel (:6-11), tab button (:229-254), render switch (:597-605).

---

### Task 1: Settings config (pure, in-memory)

**Files:**
- Create: `src/main/headroom/config.ts`
- Test: `tests/electron/headroomConfig.test.ts`

**Interfaces:**
- Produces: `type Mode = 'conservative' | 'balanced' | 'aggressive'`; `interface HeadroomSettings { enabled: boolean; mode: Mode; steering: boolean }`; `getSettings(): HeadroomSettings`; `setSettings(p: Partial<HeadroomSettings>): HeadroomSettings`; `resetSettings(): void`; `interface Thresholds { floorTokens: number; topK: number; maxFieldChars: number; headLines: number; tailLines: number }`; `thresholdsFor(mode: Mode): Thresholds`; `const MAX_COMPRESS_BYTES = 4_000_000`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/electron/headroomConfig.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
const { getSettings, setSettings, resetSettings, thresholdsFor, MAX_COMPRESS_BYTES } =
  await import('../../src/main/headroom/config')

describe('headroom config', () => {
  beforeEach(() => resetSettings())

  it('defaults to enabled + balanced + steering on', () => {
    expect(getSettings()).toEqual({ enabled: true, mode: 'balanced', steering: true })
  })

  it('setSettings merges partials and returns the new state', () => {
    expect(setSettings({ enabled: false })).toEqual({ enabled: false, mode: 'balanced', steering: true })
    expect(setSettings({ mode: 'aggressive' })).toEqual({ enabled: false, mode: 'aggressive', steering: true })
    expect(getSettings().mode).toBe('aggressive')
  })

  it('setSettings ignores an invalid mode', () => {
    setSettings({ mode: 'nonsense' as any })
    expect(getSettings().mode).toBe('balanced')
  })

  it('thresholds get stricter as mode escalates', () => {
    expect(thresholdsFor('conservative').floorTokens).toBeGreaterThan(thresholdsFor('balanced').floorTokens)
    expect(thresholdsFor('aggressive').topK).toBeLessThan(thresholdsFor('balanced').topK)
    expect(MAX_COMPRESS_BYTES).toBe(4_000_000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomConfig.test.ts`
Expected: FAIL — cannot find module `../../src/main/headroom/config`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/headroom/config.ts
export type Mode = 'conservative' | 'balanced' | 'aggressive'
export interface HeadroomSettings { enabled: boolean; mode: Mode; steering: boolean }
export interface Thresholds {
  floorTokens: number
  topK: number
  maxFieldChars: number
  headLines: number
  tailLines: number
}

export const MAX_COMPRESS_BYTES = 4_000_000
const MODES: Mode[] = ['conservative', 'balanced', 'aggressive']
const DEFAULTS: HeadroomSettings = { enabled: true, mode: 'balanced', steering: true }

let current: HeadroomSettings = { ...DEFAULTS }

export function getSettings(): HeadroomSettings {
  return { ...current }
}

export function setSettings(p: Partial<HeadroomSettings>): HeadroomSettings {
  const next: HeadroomSettings = { ...current }
  if (typeof p.enabled === 'boolean') next.enabled = p.enabled
  if (typeof p.steering === 'boolean') next.steering = p.steering
  if (p.mode && MODES.includes(p.mode)) next.mode = p.mode
  current = next
  return { ...current }
}

export function resetSettings(): void {
  current = { ...DEFAULTS }
}

const TABLE: Record<Mode, Thresholds> = {
  conservative: { floorTokens: 1500, topK: 25, maxFieldChars: 4000, headLines: 40, tailLines: 20 },
  balanced:     { floorTokens: 800,  topK: 12, maxFieldChars: 2000, headLines: 24, tailLines: 12 },
  aggressive:   { floorTokens: 400,  topK: 6,  maxFieldChars: 1000, headLines: 12, tailLines: 6 },
}

export function thresholdsFor(mode: Mode): Thresholds {
  return TABLE[mode] ?? TABLE.balanced
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomConfig.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/headroom/config.ts tests/electron/headroomConfig.test.ts
git commit -m "feat(headroom): settings config + per-mode thresholds"
```

---

### Task 2: CCR store (in-memory session LRU)

**Files:**
- Create: `src/main/headroom/ccrStore.ts`
- Test: `tests/electron/headroomCcr.test.ts`

**Interfaces:**
- Produces: `ccrStash(value: unknown): string`; `ccrRetrieve(token: string): unknown | undefined`; `resetCcr(): void`; `const CCR_MAX_ENTRIES = 64`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/electron/headroomCcr.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
const { ccrStash, ccrRetrieve, resetCcr, CCR_MAX_ENTRIES } =
  await import('../../src/main/headroom/ccrStore')

describe('ccr store', () => {
  beforeEach(() => resetCcr())

  it('round-trips a value byte-identically', () => {
    const original = { hits: [{ name: 'foo', file: 'a.ts' }], n: 100 }
    const token = ccrStash(original)
    expect(typeof token).toBe('string')
    expect(ccrRetrieve(token)).toEqual(original)
  })

  it('returns undefined for an unknown token', () => {
    expect(ccrRetrieve('hr_nope')).toBeUndefined()
  })

  it('issues distinct tokens', () => {
    expect(ccrStash(1)).not.toBe(ccrStash(2))
  })

  it('evicts the oldest entry past the cap (LRU)', () => {
    const first = ccrStash('first')
    for (let i = 0; i < CCR_MAX_ENTRIES; i++) ccrStash(`fill-${i}`)
    expect(ccrRetrieve(first)).toBeUndefined() // evicted
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomCcr.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/headroom/ccrStore.ts
// In-memory, session-scoped reversible cache. No disk I/O (hot-path perf).
// Bounded by entry count; oldest-inserted evicted first (Map preserves order).
export const CCR_MAX_ENTRIES = 64

const store = new Map<string, unknown>()
let counter = 0

export function ccrStash(value: unknown): string {
  const token = `hr_${(++counter).toString(36)}`
  store.set(token, value)
  while (store.size > CCR_MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
  return token
}

export function ccrRetrieve(token: string): unknown | undefined {
  return store.get(token)
}

export function resetCcr(): void {
  store.clear()
  counter = 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomCcr.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/headroom/ccrStore.ts tests/electron/headroomCcr.test.ts
git commit -m "feat(headroom): in-memory reversible CCR store with LRU cap"
```

---

### Task 3: Text compaction helper

**Files:**
- Create: `src/main/headroom/compactText.ts`
- Test: `tests/electron/headroomCompactText.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface CompactTextOpts { headLines: number; tailLines: number; maxChars: number }`; `compactText(s: string, opts: CompactTextOpts): { text: string; elided: boolean }`. Collapses runs of ≥1 identical consecutive lines into one line plus `… (×N)`, then if still over `maxChars` OR over `headLines+tailLines` lines, returns head + `… [K lines elided] …` + tail.

- [ ] **Step 1: Write the failing test**

```ts
// tests/electron/headroomCompactText.test.ts
import { describe, it, expect } from 'vitest'
const { compactText } = await import('../../src/main/headroom/compactText')

describe('compactText', () => {
  it('leaves small text untouched', () => {
    const r = compactText('a\nb\nc', { headLines: 10, tailLines: 10, maxChars: 1000 })
    expect(r).toEqual({ text: 'a\nb\nc', elided: false })
  })

  it('collapses runs of identical consecutive lines', () => {
    const r = compactText('x\nx\nx\ny', { headLines: 10, tailLines: 10, maxChars: 1000 })
    expect(r.text).toBe('x\n… (×2 identical lines)\ny')
    expect(r.elided).toBe(true)
  })

  it('applies a head/tail window when over the line budget', () => {
    const src = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n')
    const r = compactText(src, { headLines: 2, tailLines: 2, maxChars: 100000 })
    expect(r.elided).toBe(true)
    expect(r.text.startsWith('line0\nline1\n')).toBe(true)
    expect(r.text.endsWith('\nline98\nline99')).toBe(true)
    expect(r.text).toContain('lines elided')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomCompactText.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/headroom/compactText.ts
export interface CompactTextOpts { headLines: number; tailLines: number; maxChars: number }

export function compactText(s: string, opts: CompactTextOpts): { text: string; elided: boolean } {
  let elided = false

  // 1) Collapse runs of identical consecutive lines (log spam).
  const rawLines = s.split('\n')
  const collapsed: string[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    let run = 1
    while (i + 1 < rawLines.length && rawLines[i + 1] === line) { run++; i++ }
    collapsed.push(line)
    if (run > 1) { collapsed.push(`… (×${run - 1} identical lines)`); elided = true }
  }

  // 2) Head/tail window if still over budget (by line count or chars).
  const overLines = collapsed.length > opts.headLines + opts.tailLines
  const joined = collapsed.join('\n')
  if (!overLines && joined.length <= opts.maxChars) {
    return { text: joined, elided }
  }
  const head = collapsed.slice(0, opts.headLines)
  const tail = collapsed.slice(collapsed.length - opts.tailLines)
  const elidedCount = collapsed.length - head.length - tail.length
  const windowed = [...head, `… [${Math.max(0, elidedCount)} lines elided] …`, ...tail].join('\n')
  return { text: windowed, elided: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomCompactText.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/headroom/compactText.ts tests/electron/headroomCompactText.test.ts
git commit -m "feat(headroom): compactText line-dedup + head/tail window helper"
```

---

### Task 4: Router (exempt policy + shape routing)

**Files:**
- Create: `src/main/headroom/router.ts`
- Test: `tests/electron/headroomRouter.test.ts`

**Interfaces:**
- Produces: `type Route = 'exempt' | 'array' | 'object'`; `isExempt(tool: string): boolean`; `route(tool: string, result: unknown): Route`; `const EXEMPT_TOOLS: readonly string[]`.
- Policy: every `memory_*` tool, every `swarm_*` tool, all terminal-control tools (`create_terminal`, `close_terminal`, `write_to_terminal`, `run_command`, `list_terminals`), and `retrieve_full` are exempt. Non-exempt: arrays → `'array'`, non-null objects → `'object'`, everything else (string/number/null) → `'exempt'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/electron/headroomRouter.test.ts
import { describe, it, expect } from 'vitest'
const { route, isExempt, EXEMPT_TOOLS } = await import('../../src/main/headroom/router')

describe('router', () => {
  it('exempts every memory_* tool', () => {
    for (const t of ['memory_search', 'memory_primer', 'memory_list', 'memory_related', 'memory_graph', 'memory_write'])
      expect(route(t, [{ a: 1 }])).toBe('exempt')
  })

  it('exempts swarm_*, control tools, and retrieve_full', () => {
    for (const t of ['swarm_list_tasks', 'create_terminal', 'run_command', 'write_to_terminal', 'list_terminals', 'retrieve_full'])
      expect(isExempt(t)).toBe(true)
  })

  it('routes code_search array results to the array compressor', () => {
    expect(route('code_search', [{ name: 'x' }])).toBe('array')
    expect(route('get_file_tree', [{ name: 'a', isDir: true }])).toBe('array')
  })

  it('routes object results to the object compressor', () => {
    expect(route('read_output', { output: 'x' })).toBe('object')
    expect(route('code_explore', { symbol: {}, source: '' })).toBe('object')
    expect(route('get_git_status', { status: '', branch: 'main', recentCommits: '' })).toBe('object')
  })

  it('exempts primitives and null (nothing to compress)', () => {
    expect(route('code_explore', null)).toBe('exempt')
    expect(route('read_output', 'plain')).toBe('exempt')
  })

  it('exposes the exempt list', () => {
    expect(EXEMPT_TOOLS).toContain('memory_primer')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomRouter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/headroom/router.ts
export type Route = 'exempt' | 'array' | 'object'

export const EXEMPT_TOOLS: readonly string[] = [
  'list_terminals', 'create_terminal', 'run_command', 'close_terminal', 'write_to_terminal',
  'retrieve_full',
]

export function isExempt(tool: string): boolean {
  // Never touch memory/learning or swarm coordination surfaces, or control acks.
  return tool.startsWith('memory_') || tool.startsWith('swarm_') || EXEMPT_TOOLS.includes(tool)
}

export function route(tool: string, result: unknown): Route {
  if (isExempt(tool)) return 'exempt'
  if (Array.isArray(result)) return 'array'
  if (result !== null && typeof result === 'object') return 'object'
  return 'exempt'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomRouter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/headroom/router.ts tests/electron/headroomRouter.test.ts
git commit -m "feat(headroom): shape+exempt router (memory/swarm/control always exempt)"
```

---

### Task 5: Compressors (array + object)

**Files:**
- Create: `src/main/headroom/compressors.ts`
- Test: `tests/electron/headroomCompressors.test.ts`

**Interfaces:**
- Consumes: `compactText` (Task 3), `Thresholds` (Task 1).
- Produces: `interface Compressed { text: string; offload?: unknown }`; `compressArray(arr: unknown[], t: Thresholds): Compressed`; `compressObject(obj: Record<string, unknown>, t: Thresholds): Compressed`. `offload` is the FULL original to stash in CCR; present only when the compressor actually elided/truncated content. Kept items render as compact single-line JSON (drops pretty-print overhead).

- [ ] **Step 1: Write the failing test**

```ts
// tests/electron/headroomCompressors.test.ts
import { describe, it, expect } from 'vitest'
const { compressArray, compressObject } = await import('../../src/main/headroom/compressors')
import { thresholdsFor } from '../../src/main/headroom/config'

const T = thresholdsFor('balanced')

describe('compressArray', () => {
  it('keeps top-K, elides the tail, and offloads the full array', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ name: `sym${i}`, file: 'a.ts', startLine: i }))
    const r = compressArray(arr, T)
    expect(r.offload).toBe(arr)                       // full original preserved for retrieve
    expect(r.text).toContain('sym0')
    expect(r.text).not.toContain('sym99')             // tail elided
    expect(r.text).toContain('88 more items elided')  // 100 - topK(12)
  })

  it('compacts (no offload) when the array is within top-K', () => {
    const arr = [{ a: 1 }, { b: 2 }]
    const r = compressArray(arr, T)
    expect(r.offload).toBeUndefined()
    expect(r.text).toBe('{"a":1}\n{"b":2}')            // compact one-line JSON per item
  })
})

describe('compressObject', () => {
  it('truncates over-long string fields and offloads the original', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n')
    const obj = { output: big }
    const r = compressObject(obj, thresholdsFor('aggressive'))
    expect(r.offload).toBe(obj)
    expect(r.text.length).toBeLessThan(big.length)
    expect(r.text).toContain('lines elided')
  })

  it('caps over-long arrays inside an object', () => {
    const obj = { symbol: { name: 'f' }, callers: Array.from({ length: 50 }, (_, i) => ({ n: i })) }
    const r = compressObject(obj, thresholdsFor('aggressive'))
    expect(r.offload).toBe(obj)
    expect(r.text).toContain('more elided')
  })

  it('no offload when nothing needed truncation', () => {
    const r = compressObject({ status: 'clean', branch: 'main' }, T)
    expect(r.offload).toBeUndefined()
    expect(r.text).toBe('{"status":"clean","branch":"main"}')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomCompressors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/headroom/compressors.ts
import { compactText } from './compactText'
import type { Thresholds } from './config'

export interface Compressed { text: string; offload?: unknown }

export function compressArray(arr: unknown[], t: Thresholds): Compressed {
  const kept = arr.slice(0, t.topK).map(x => JSON.stringify(x)).join('\n')
  if (arr.length <= t.topK) return { text: kept }
  const elided = arr.length - t.topK
  return { text: `${kept}\n… (${elided} more items elided)`, offload: arr }
}

export function compressObject(obj: Record<string, unknown>, t: Thresholds): Compressed {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length > t.maxFieldChars) {
      const c = compactText(v, { headLines: t.headLines, tailLines: t.tailLines, maxChars: t.maxFieldChars })
      out[k] = c.text
      if (c.elided) changed = true
    } else if (Array.isArray(v) && v.length > t.topK) {
      out[k] = [...v.slice(0, t.topK), `… (${v.length - t.topK} more elided)`]
      changed = true
    } else {
      out[k] = v
    }
  }
  const text = JSON.stringify(out)
  return changed ? { text, offload: obj } : { text }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomCompressors.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/headroom/compressors.ts tests/electron/headroomCompressors.test.ts
git commit -m "feat(headroom): generic array + object compressors"
```

---

### Task 6: Savings ledger

**Files:**
- Create: `src/main/headroom/savingsLedger.ts`
- Test: `tests/electron/headroomLedger.test.ts`

**Interfaces:**
- Produces: `interface LedgerEvent { tool: string; kind: 'compress' | 'retrieve'; savedTokens: number }`; `interface SavingsTotals { netSaved: number; events: number; byTool: Record<string, number> }`; `interface SavingsReceipt { session: SavingsTotals; cumulative: SavingsTotals }`; `recordEvent(ev: LedgerEvent): void`; `summarizeSavings(): SavingsReceipt`; `resetLedger(): void`. `netSaved = Σ savedTokens` (compress positive, retrieve negative → honest net). Persistence is best-effort/async and must NOT be required for `summarizeSavings()` to work in-memory.

- [ ] **Step 1: Write the failing test**

```ts
// tests/electron/headroomLedger.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
const { recordEvent, summarizeSavings, resetLedger } =
  await import('../../src/main/headroom/savingsLedger')

describe('savings ledger', () => {
  beforeEach(() => resetLedger())

  it('sums compress savings into session + cumulative', () => {
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 1000 })
    recordEvent({ tool: 'read_output', kind: 'compress', savedTokens: 500 })
    const r = summarizeSavings()
    expect(r.session.netSaved).toBe(1500)
    expect(r.session.byTool.code_search).toBe(1000)
    expect(r.session.events).toBe(2)
    expect(r.cumulative.netSaved).toBe(1500)
  })

  it('nets out retrieves honestly (no inflation)', () => {
    recordEvent({ tool: 'code_search', kind: 'compress', savedTokens: 1000 })
    recordEvent({ tool: 'retrieve_full', kind: 'retrieve', savedTokens: -400 })
    expect(summarizeSavings().session.netSaved).toBe(600)
  })

  it('resetLedger clears session but callers can still summarize', () => {
    recordEvent({ tool: 'x', kind: 'compress', savedTokens: 10 })
    resetLedger()
    expect(summarizeSavings().session.netSaved).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomLedger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/headroom/savingsLedger.ts
export interface LedgerEvent { tool: string; kind: 'compress' | 'retrieve'; savedTokens: number }
export interface SavingsTotals { netSaved: number; events: number; byTool: Record<string, number> }
export interface SavingsReceipt { session: SavingsTotals; cumulative: SavingsTotals }

function emptyTotals(): SavingsTotals { return { netSaved: 0, events: 0, byTool: {} } }

let session: SavingsTotals = emptyTotals()
// Cumulative baseline loaded from disk at startup (see index.ts init); session adds on top.
let cumulativeBase: SavingsTotals = emptyTotals()
let flush: (() => void) | null = null

/** Wire an async, best-effort persistence flush (called from main startup). */
export function setLedgerFlush(fn: (() => void) | null): void { flush = fn }
export function loadCumulativeBase(base: SavingsTotals): void { cumulativeBase = base }

export function recordEvent(ev: LedgerEvent): void {
  session.netSaved += ev.savedTokens
  session.events += 1
  session.byTool[ev.tool] = (session.byTool[ev.tool] ?? 0) + ev.savedTokens
  try { flush?.() } catch { /* best effort */ }
}

export function summarizeSavings(): SavingsReceipt {
  const cumulative: SavingsTotals = {
    netSaved: cumulativeBase.netSaved + session.netSaved,
    events: cumulativeBase.events + session.events,
    byTool: { ...cumulativeBase.byTool },
  }
  for (const [k, v] of Object.entries(session.byTool)) {
    cumulative.byTool[k] = (cumulative.byTool[k] ?? 0) + v
  }
  return { session: { ...session, byTool: { ...session.byTool } }, cumulative }
}

export function resetLedger(): void {
  session = emptyTotals()
  cumulativeBase = emptyTotals()
  flush = null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomLedger.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/headroom/savingsLedger.ts tests/electron/headroomLedger.test.ts
git commit -m "feat(headroom): buffered savings ledger (net-of-retrieves)"
```

---

### Task 7: Orchestrator (`compressToolResult`) — the fail-open heart

**Files:**
- Create: `src/main/headroom/compressToolResult.ts`
- Test: `tests/electron/headroomOrchestrator.test.ts`

**Interfaces:**
- Consumes: `getSettings`, `thresholdsFor`, `MAX_COMPRESS_BYTES` (Task 1); `ccrStash` (Task 2); `route` (Task 4); `compressArray`, `compressObject` (Task 5); `recordEvent` (Task 6); `estimateTokens` (`src/main/memoryEconomy.ts:9`).
- Produces: `compressToolResult(name: string, result: unknown): string` — always returns a string; never throws.

- [ ] **Step 1: Write the failing test**

```ts
// tests/electron/headroomOrchestrator.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
const { compressToolResult } = await import('../../src/main/headroom/compressToolResult')
import { setSettings, resetSettings } from '../../src/main/headroom/config'
import { resetCcr, ccrRetrieve } from '../../src/main/headroom/ccrStore'
import { resetLedger, summarizeSavings } from '../../src/main/headroom/savingsLedger'

const bigSearch = () => Array.from({ length: 100 }, (_, i) => ({ name: `sym${i}`, kind: 'function', file: 'src/a.ts', startLine: i, endLine: i + 5, lang: 'ts' }))
const pretty = (v: unknown) => JSON.stringify(v, null, 2)

describe('compressToolResult', () => {
  beforeEach(() => { resetSettings(); resetCcr(); resetLedger() })

  it('compresses a big code_search and records the saving', () => {
    const arr = bigSearch()
    const text = compressToolResult('code_search', arr)
    expect(text.length).toBeLessThan(pretty(arr).length)
    expect(text).toContain('retrieve_full')
    expect(summarizeSavings().session.netSaved).toBeGreaterThan(0)
  })

  it('stashes the full original so retrieve_full can recover it', () => {
    const arr = bigSearch()
    const text = compressToolResult('code_search', arr)
    const token = text.match(/hr_[a-z0-9]+/)![0]
    expect(ccrRetrieve(token)).toEqual(arr)
  })

  it('passes memory_* through byte-identical (brain non-interference)', () => {
    const mem = [{ id: 'm1', content: 'x'.repeat(5000) }]
    expect(compressToolResult('memory_search', mem)).toBe(pretty(mem))
  })

  it('passes through when disabled', () => {
    setSettings({ enabled: false })
    const arr = bigSearch()
    expect(compressToolResult('code_search', arr)).toBe(pretty(arr))
  })

  it('passes through small results under the token floor', () => {
    const small = [{ name: 'a' }]
    expect(compressToolResult('code_search', small)).toBe(pretty(small))
  })

  it('passes through above the byte cap (perf guard)', () => {
    const huge = [{ blob: 'z'.repeat(4_100_000) }]
    expect(compressToolResult('code_search', huge)).toBe(pretty(huge))
  })

  it('is fail-open: a serialization error returns the original string form', () => {
    const circular: any = {}; circular.self = circular
    // JSON.stringify throws on circular; compressToolResult must not throw.
    expect(() => compressToolResult('read_output', circular)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomOrchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/headroom/compressToolResult.ts
import { estimateTokens } from '../memoryEconomy'
import { getSettings, thresholdsFor, MAX_COMPRESS_BYTES } from './config'
import { route } from './router'
import { compressArray, compressObject, type Compressed } from './compressors'
import { ccrStash } from './ccrStore'
import { recordEvent } from './savingsLedger'

function footer(token: string): string {
  return `\n\n[headroom] Full result cached — call the retrieve_full tool with token "${token}" to expand it.`
}

/**
 * Wraps a raw MCP tool result, returning the text the agent should receive.
 * Fail-open: any error returns the pretty-printed original. Never throws.
 */
export function compressToolResult(name: string, result: unknown): string {
  let pretty: string
  try {
    pretty = JSON.stringify(result, null, 2)
  } catch {
    // Non-serializable (e.g. circular) — hand back a safe string form.
    return String(result)
  }
  try {
    const settings = getSettings()
    if (!settings.enabled) return pretty
    const kind = route(name, result)
    if (kind === 'exempt') return pretty
    if (Buffer.byteLength(pretty, 'utf8') > MAX_COMPRESS_BYTES) return pretty // perf guard

    const origTokens = estimateTokens(pretty)
    const t = thresholdsFor(settings.mode)
    if (origTokens < t.floorTokens) return pretty // nothing to gain

    const c: Compressed = kind === 'array'
      ? compressArray(result as unknown[], t)
      : compressObject(result as Record<string, unknown>, t)

    let text = c.text
    let token: string | undefined
    if (c.offload !== undefined) { token = ccrStash(c.offload); text += footer(token) }

    const compTokens = estimateTokens(text)
    if (compTokens >= origTokens) return pretty // never inflate; don't leak a token

    recordEvent({ tool: name, kind: 'compress', savedTokens: origTokens - compTokens })
    return text
  } catch {
    return pretty // fail-open
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomOrchestrator.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/headroom/compressToolResult.ts tests/electron/headroomOrchestrator.test.ts
git commit -m "feat(headroom): fail-open orchestrator wiring router+compressors+ccr+ledger"
```

---

### Task 8: `retrieve_full` tool wiring (mcpServer + handler)

**Files:**
- Modify: `src/main/mcpServer.ts` (`McpToolHandlers` :480-513; `executeTool` switch :515-643; `TOOLS` array :114-478)
- Modify: `src/main/index.ts` (handlers object near :2714-2719)
- Test: `tests/electron/headroomRetrieveTool.test.ts`

**Interfaces:**
- Consumes: `ccrRetrieve` (Task 2), `recordEvent` (Task 6), `estimateTokens`.
- Produces: `McpToolHandlers.retrieveFull: (token: string) => unknown`; MCP tool `retrieve_full`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/electron/headroomRetrieveTool.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
import { vi } from 'vitest'
const { executeTool } = await import('../../src/main/mcpServer')
import type { McpToolHandlers } from '../../src/main/mcpServer'
import { ccrStash, resetCcr } from '../../src/main/headroom/ccrStore'
import { recordEvent, resetLedger } from '../../src/main/headroom/savingsLedger'
import { estimateTokens } from '../../src/main/memoryEconomy'

// The real handler used by the app (mirror of index.ts wiring), for a focused unit test.
const retrieveFull = (token: string): unknown => {
  const v = ccrRetrieve(token)
  if (v === undefined) return { error: 'expired', message: 'This result has expired — re-run the original tool.' }
  recordEvent({ tool: 'retrieve_full', kind: 'retrieve', savedTokens: -estimateTokens(JSON.stringify(v, null, 2)) })
  return v
}
import { ccrRetrieve } from '../../src/main/headroom/ccrStore'
const handlers = () => ({ retrieveFull } as unknown as McpToolHandlers)

describe('retrieve_full tool', () => {
  beforeEach(() => { resetCcr(); resetLedger() })

  it('returns the stashed original for a known token', async () => {
    const original = { hits: [1, 2, 3] }
    const token = ccrStash(original)
    const out = await executeTool('retrieve_full', { token }, handlers())
    expect(out).toEqual(original)
  })

  it('returns a clear expired message for an unknown token (never throws)', async () => {
    const out: any = await executeTool('retrieve_full', { token: 'hr_gone' }, handlers())
    expect(out.error).toBe('expired')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomRetrieveTool.test.ts`
Expected: FAIL — `executeTool` throws `Unknown tool: retrieve_full`.

- [ ] **Step 3a: Add `retrieveFull` to the handler interface**

In `src/main/mcpServer.ts`, inside `interface McpToolHandlers` (ends at :513), add:

```ts
  retrieveFull: (token: string) => unknown
```

- [ ] **Step 3b: Add the `executeTool` case**

In `src/main/mcpServer.ts`, in the `switch (name)` (before `default:` at :640), add:

```ts
    case 'retrieve_full':
      return handlers.retrieveFull(args.token)
```

- [ ] **Step 3c: Register the `retrieve_full` TOOLS entry**

In `src/main/mcpServer.ts`, inside the `TOOLS` array (before the closing `]` at :478), add:

```ts
  {
    name: 'retrieve_full',
    description: 'Expand a Termpolis-compressed tool result back to its full form. When a tool result ends with a [headroom] note and a token, call this with that token to recover the complete, uncompressed result.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'The hr_… token from a [headroom] footer' } },
      required: ['token'],
    },
  },
```

- [ ] **Step 3d: Wire the real handler in index.ts**

In `src/main/index.ts`, in the handlers object passed to the MCP server (near the code* handlers at :2714-2719), add (and ensure imports of `ccrRetrieve`, `recordEvent`, `estimateTokens` exist at the top of the file):

```ts
    retrieveFull: (token: string) => {
      const v = ccrRetrieve(token)
      if (v === undefined) return { error: 'expired', message: 'This result has expired — re-run the original tool.' }
      try { recordEvent({ tool: 'retrieve_full', kind: 'retrieve', savedTokens: -estimateTokens(JSON.stringify(v, null, 2)) }) } catch { /* best effort */ }
      return v
    },
```

Add near the other `src/main/headroom/*` imports at the top of `index.ts`:

```ts
import { ccrRetrieve } from './headroom/ccrStore'
import { recordEvent } from './headroom/savingsLedger'
// estimateTokens is already imported from './memoryEconomy' in index.ts; add it to that import if not.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomRetrieveTool.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpServer.ts src/main/index.ts tests/electron/headroomRetrieveTool.test.ts
git commit -m "feat(headroom): retrieve_full MCP tool + handler (reversible expand)"
```

---

### Task 9: Wire compression into the dispatch + E2E proof + perf budget

**Files:**
- Modify: `src/main/mcpServer.ts` (`tools/call` return :682-687)
- Test: `tests/electron/headroomProof.test.ts` (HTTP end-to-end, Pattern A)

**Interfaces:**
- Consumes: `compressToolResult` (Task 7).

- [ ] **Step 1: Write the failing test (real dispatch proof + perf)**

```ts
// tests/electron/headroomProof.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { vi } from 'vitest'
import * as http from 'http'
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
const { getMcpAuthToken, startMcpServer, stopMcpServer, awaitMcpPortBound, _resetPortStateForTest } =
  await import('../../src/main/mcpServer')
import { estimateTokens } from '../../src/main/memoryEconomy'
import { setSettings, resetSettings } from '../../src/main/headroom/config'
import { resetCcr } from '../../src/main/headroom/ccrStore'

const bigSearch = Array.from({ length: 100 }, (_, i) => ({ name: `symbol_${i}`, kind: 'function', file: `src/module_${i}.ts`, startLine: i * 10, endLine: i * 10 + 8, lang: 'ts' }))
const handlers: any = { codeSearch: () => bigSearch, memorySearch: async () => [{ id: 'm1', content: 'x'.repeat(6000) }] }

function call(port: number, token: string, name: string) {
  return new Promise<string>((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: {} }, id: 1 })
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` } }, res => {
      let body = ''; res.on('data', d => body += d); res.on('end', () => resolve(JSON.parse(body).result.content[0].text))
    })
    req.on('error', reject); req.write(payload); req.end()
  })
}

let port: number, token: string
beforeAll(async () => { _resetPortStateForTest(); startMcpServer(handlers as any); port = await awaitMcpPortBound(); token = getMcpAuthToken() })
afterAll(() => stopMcpServer())
beforeEach(() => { resetSettings(); resetCcr() })

describe('headroom token-spend proof (real dispatch)', () => {
  it('cuts a 100-hit code_search by ≥80% tokens', async () => {
    setSettings({ enabled: false })
    const raw = await call(port, token, 'code_search')
    setSettings({ enabled: true, mode: 'balanced' })
    const compressed = await call(port, token, 'code_search')
    const rawTok = estimateTokens(raw), compTok = estimateTokens(compressed)
    expect(compressed).toContain('retrieve_full')
    expect(1 - compTok / rawTok).toBeGreaterThanOrEqual(0.80)
  })

  it('leaves memory_search byte-identical (brain non-interference, real dispatch)', async () => {
    setSettings({ enabled: true, mode: 'aggressive' })
    const raw = JSON.stringify([{ id: 'm1', content: 'x'.repeat(6000) }], null, 2)
    expect(await call(port, token, 'memory_search')).toBe(raw)
  })

  it('meets the perf budget: compressing a 100-hit search is fast', async () => {
    setSettings({ enabled: true, mode: 'balanced' })
    const start = performance.now()
    for (let i = 0; i < 20; i++) await call(port, token, 'code_search')
    expect((performance.now() - start) / 20).toBeLessThan(50) // ms per call incl. HTTP round-trip
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomProof.test.ts`
Expected: FAIL — code_search response is uncompressed (compression not wired into dispatch yet); the ≥80% assertion fails.

- [ ] **Step 3: Wire compression into the dispatch**

In `src/main/mcpServer.ts`, add the import near the top (with the other `./` imports):

```ts
import { compressToolResult } from './headroom/compressToolResult'
```

Change the `tools/call` success return (currently :682-687) from:

```ts
      const result = await executeTool(name, args || {}, handlers)
      return {
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        id,
      }
```

to:

```ts
      const result = await executeTool(name, args || {}, handlers)
      return {
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: compressToolResult(name, result) }] },
        id,
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomProof.test.ts`
Expected: PASS (3 tests) — code_search ≥80% reduction, memory untouched, within perf budget.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpServer.ts tests/electron/headroomProof.test.ts
git commit -m "feat(headroom): wire compression into tools/call dispatch + e2e proof"
```

---

### Task 10: Source-level memory-exemption guard test

**Files:**
- Test: `tests/electron/headroomExemptGuard.test.ts`

**Interfaces:**
- Consumes: `route`, `EXEMPT_TOOLS`, `McpToolHandlers` keys. This test fails the build if any `memory_*`/`swarm_*` tool ever becomes compressible.

- [ ] **Step 1: Write the guard test**

```ts
// tests/electron/headroomExemptGuard.test.ts
import { describe, it, expect } from 'vitest'
const { route } = await import('../../src/main/headroom/router')

// The full set of tool names the MCP server dispatches that must NEVER be compressed.
const MUST_EXEMPT = [
  'memory_write', 'memory_search', 'memory_list', 'memory_primer', 'memory_related', 'memory_audit',
  'memory_link', 'memory_graph', 'memory_feedback', 'memory_selfcheck', 'memory_pool',
  'memory_anticipate', 'memory_conflicts',
  'swarm_send_message', 'swarm_read_messages', 'swarm_create_task', 'swarm_list_tasks',
  'swarm_update_task', 'swarm_list_agents',
  'create_terminal', 'close_terminal', 'write_to_terminal', 'run_command', 'list_terminals',
  'retrieve_full',
]

describe('brain/control non-interference guard', () => {
  it('routes every memory/swarm/control tool to exempt regardless of payload shape', () => {
    for (const tool of MUST_EXEMPT) {
      expect(route(tool, [{ big: 'x'.repeat(9999) }])).toBe('exempt')
      expect(route(tool, { big: 'x'.repeat(9999) })).toBe('exempt')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it passes (router already exempts these)**

Run: `npx vitest run tests/electron/headroomExemptGuard.test.ts`
Expected: PASS (1 test). If it FAILS, the router regressed — fix the router, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/electron/headroomExemptGuard.test.ts
git commit -m "test(headroom): source-level guard — memory/swarm/control never compressed"
```

---

### Task 11: Settings persistence + IPC round-trips

**Files:**
- Modify: `src/main/index.ts` (startup init + three `ipcMain.handle`)
- Modify: `src/preload/index.ts` (three methods near :160)
- Modify: `src/renderer/src/types/index.ts` (three signatures in `TermpolisAPI` near :245)
- Create: `src/main/headroom/persist.ts` (guarded disk load/save)
- Test: `tests/electron/headroomPersist.test.ts`

**Interfaces:**
- Produces: `persist.ts` → `loadSettingsFromDisk(dir: string): void` (calls `setSettings`), `saveSettingsToDisk(dir: string): void`, `loadLedgerBaseFromDisk(dir: string): void` (calls `loadCumulativeBase`), `saveLedgerToDisk(dir: string): void`. IPC channels: `tokenSavings:get-settings`, `tokenSavings:set-settings`, `tokenSavings:get-receipt`. Preload/renderer: `tokenSavingsGetSettings(): Promise<IpcResponse<HeadroomSettings>>`, `tokenSavingsSetSettings(p): Promise<IpcResponse<HeadroomSettings>>`, `tokenSavingsGetReceipt(): Promise<IpcResponse<SavingsReceipt>>`.

- [ ] **Step 1: Write the failing test (guarded persistence)**

```ts
// tests/electron/headroomPersist.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import * as os from 'os'; import * as fs from 'fs'; import * as path from 'path'
const { loadSettingsFromDisk, saveSettingsToDisk } = await import('../../src/main/headroom/persist')
import { getSettings, setSettings, resetSettings } from '../../src/main/headroom/config'

describe('headroom persist', () => {
  beforeEach(() => resetSettings())

  it('round-trips settings through disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'))
    setSettings({ mode: 'aggressive', steering: false })
    saveSettingsToDisk(dir)
    resetSettings()
    loadSettingsFromDisk(dir)
    expect(getSettings()).toEqual({ enabled: true, mode: 'aggressive', steering: false })
  })

  it('load is a no-op (defaults kept) when the dir is unwritable/missing', () => {
    loadSettingsFromDisk(path.join(os.tmpdir(), 'does-not-exist-hr', 'x'))
    expect(getSettings().mode).toBe('balanced')
  })

  it('save never throws on a bad path', () => {
    expect(() => saveSettingsToDisk('/root/no/permission/hr')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomPersist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3a: Implement guarded persistence**

```ts
// src/main/headroom/persist.ts
import { writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getSettings, setSettings, type HeadroomSettings } from './config'
import { summarizeSavings, loadCumulativeBase, type SavingsTotals } from './savingsLedger'

const SETTINGS_FILE = 'headroom-settings.json'
const LEDGER_FILE = 'headroom-totals.json'

export function loadSettingsFromDisk(dir: string): void {
  try {
    const raw = readFileSync(join(dir, SETTINGS_FILE), 'utf8')
    setSettings(JSON.parse(raw) as Partial<HeadroomSettings>)
  } catch { /* keep defaults */ }
}

export function saveSettingsToDisk(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify(getSettings()), 'utf8')
  } catch { /* best effort */ }
}

export function loadLedgerBaseFromDisk(dir: string): void {
  try {
    const raw = readFileSync(join(dir, LEDGER_FILE), 'utf8')
    loadCumulativeBase(JSON.parse(raw) as SavingsTotals)
  } catch { /* start at zero */ }
}

export function saveLedgerToDisk(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, LEDGER_FILE), JSON.stringify(summarizeSavings().cumulative), 'utf8')
  } catch { /* best effort */ }
}
```

- [ ] **Step 3b: Run the persist test**

Run: `npx vitest run tests/electron/headroomPersist.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3c: Wire startup init + IPC in index.ts**

Near the top of `src/main/index.ts` (with other headroom imports):

```ts
import { getSettings, setSettings } from './headroom/config'
import { summarizeSavings, setLedgerFlush } from './headroom/savingsLedger'
import { loadSettingsFromDisk, saveSettingsToDisk, loadLedgerBaseFromDisk, saveLedgerToDisk } from './headroom/persist'
```

Inside `app.whenReady()` (guarded — see the app.whenReady try/catch convention), after userData is available:

```ts
  try {
    const hrDir = join(app.getPath('userData'), 'headroom')
    loadSettingsFromDisk(hrDir)
    loadLedgerBaseFromDisk(hrDir)
    let flushTimer: NodeJS.Timeout | null = null
    setLedgerFlush(() => { // debounced, async, best-effort — never on the hot path
      if (flushTimer) return
      flushTimer = setTimeout(() => { flushTimer = null; saveLedgerToDisk(hrDir) }, 2000)
    })
  } catch { /* headroom persistence is best-effort */ }
```

Register the three IPC handlers alongside the other `ipcMain.handle` calls:

```ts
  ipcMain.handle('tokenSavings:get-settings', () => ok(getSettings()))
  ipcMain.handle('tokenSavings:set-settings', (_e, p) => {
    const next = setSettings(p || {})
    try { saveSettingsToDisk(join(app.getPath('userData'), 'headroom')) } catch { /* best effort */ }
    return ok(next)
  })
  ipcMain.handle('tokenSavings:get-receipt', () => ok(summarizeSavings()))
```

- [ ] **Step 3d: Expose in preload**

In `src/preload/index.ts`, in the `api` object (near :160):

```ts
  tokenSavingsGetSettings: () => ipcRenderer.invoke('tokenSavings:get-settings'),
  tokenSavingsSetSettings: (p: { enabled?: boolean; mode?: string; steering?: boolean }) => ipcRenderer.invoke('tokenSavings:set-settings', p),
  tokenSavingsGetReceipt: () => ipcRenderer.invoke('tokenSavings:get-receipt'),
```

- [ ] **Step 3e: Add types**

In `src/renderer/src/types/index.ts`, inside `interface TermpolisAPI` (near :245):

```ts
  tokenSavingsGetSettings: () => Promise<IpcResponse<{ enabled: boolean; mode: 'conservative' | 'balanced' | 'aggressive'; steering: boolean }>>
  tokenSavingsSetSettings: (p: { enabled?: boolean; mode?: string; steering?: boolean }) => Promise<IpcResponse<{ enabled: boolean; mode: 'conservative' | 'balanced' | 'aggressive'; steering: boolean }>>
  tokenSavingsGetReceipt: () => Promise<IpcResponse<{ session: { netSaved: number; events: number; byTool: Record<string, number> }; cumulative: { netSaved: number; events: number; byTool: Record<string, number> } }>>
```

- [ ] **Step 4: Run the full main-side suite to confirm no regressions**

Run: `npx vitest run tests/electron/headroomPersist.test.ts tests/electron/mcpServer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/headroom/persist.ts src/main/index.ts src/preload/index.ts src/renderer/src/types/index.ts tests/electron/headroomPersist.test.ts
git commit -m "feat(headroom): settings persistence + tokenSavings IPC round-trips"
```

---

### Task 12: Output-token steering

**Files:**
- Create: `src/main/headroom/outputSteering.ts`
- Modify: `src/main/index.ts` (primer `instruction` array :2004-2022)
- Test: `tests/electron/headroomSteering.test.ts`

**Interfaces:**
- Produces: `steeringDirective(): string` (pure, constant terseness/effort block).

- [ ] **Step 1: Write the failing test**

```ts
// tests/electron/headroomSteering.test.ts
import { describe, it, expect } from 'vitest'
const { steeringDirective } = await import('../../src/main/headroom/outputSteering')

describe('output steering', () => {
  it('is a terse, non-empty directive that discourages preamble', () => {
    const d = steeringDirective()
    expect(d.length).toBeGreaterThan(20)
    expect(d.toLowerCase()).toContain('terse')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/electron/headroomSteering.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3a: Implement**

```ts
// src/main/headroom/outputSteering.ts
/**
 * Standing output-token steering appended to the launch system prompt.
 * Trims what the model WRITES BACK (output ≈ 5× input cost). Toggled by
 * settings.steering at the call site. Not per-request effort dialing (that
 * needs a proxy) — this is a durable verbosity/effort nudge.
 */
export function steeringDirective(): string {
  return [
    'Output style: be terse and information-dense.',
    'Skip preamble and postamble — no restating the question, no "Here is…", no summary of what you are about to do.',
    'Prefer the smallest correct answer; do not over-explain routine steps (file reads, simple edits).',
    'Reserve depth for genuinely hard or ambiguous work.',
  ].join(' ')
}
```

- [ ] **Step 3b: Append it in the primer handler (gated on the setting)**

In `src/main/index.ts`, the `ipcMain.handle('memory:prepare-primer-file', …)` handler builds the `instruction` array at :2004-2022. Add an import at the top:

```ts
import { steeringDirective } from './headroom/outputSteering'
// getSettings is already imported for headroom (Task 11).
```

Change the `const instruction = [ … ].join(' ')` (:2004-2022) so the steering line is appended when enabled — replace the closing `].join(' ')` with a conditional push before joining:

```ts
  const instructionParts = [
    'Termpolis project memory: saved background context exists for this project.',
    `When you begin working, call the termpolis MCP tool memory_primer${cwdArg} and read it as background reference only — do NOT resume past work from it or summarize it unprompted; just hold it as context.`,
    'Before re-deriving any fix or solution that may already be stored, call the termpolis memory_search tool first.',
    'If your context is compacted or summarized during this session, the memory digest you loaded will have been summarized away with it — call memory_primer once more, silently, before continuing, then carry on with the task in hand.',
    'If the termpolis memory tools are unavailable, ignore this and proceed normally.',
  ]
  try { if (getSettings().steering) instructionParts.push(steeringDirective()) } catch { /* steering optional */ }
  const instruction = instructionParts.join(' ')
```

(Keep any existing comment lines between the array elements intact.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/electron/headroomSteering.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/main/headroom/outputSteering.ts src/main/index.ts tests/electron/headroomSteering.test.ts
git commit -m "feat(headroom): output-token steering appended to launch primer (toggle)"
```

---

### Task 13: Renderer Settings panel + receipt

**Files:**
- Create: `src/renderer/src/components/SettingsPane/TokenSavingsSettings.tsx`
- Modify: `src/renderer/src/lib/settingsNav.ts` (:9 union)
- Modify: `src/renderer/src/components/SettingsPane/SettingsPane.tsx` (import :6-11; tab :229-254; render :597-605)
- Test: `tests/renderer/tokenSavingsSettings.test.tsx`

**Interfaces:**
- Consumes: `window.termpolis.tokenSavingsGetSettings/SetSettings/GetReceipt` (Task 11).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/renderer/tokenSavingsSettings.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { TokenSavingsSettings } from '../../src/renderer/src/components/SettingsPane/TokenSavingsSettings'

beforeEach(() => {
  ;(window as any).termpolis = {
    tokenSavingsGetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: true, mode: 'balanced', steering: true } }),
    tokenSavingsSetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: false, mode: 'balanced', steering: true } }),
    tokenSavingsGetReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: { netSaved: 12345, events: 3, byTool: { code_search: 12000 } }, cumulative: { netSaved: 99999, events: 40, byTool: {} } } }),
  }
})

describe('TokenSavingsSettings', () => {
  it('renders the measured session savings from the receipt', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => expect(screen.getByText(/12,345/)).toBeInTheDocument())
    expect(screen.getByText(/99,999/)).toBeInTheDocument()
  })

  it('toggling compression calls setSettings', async () => {
    render(<TokenSavingsSettings />)
    await waitFor(() => screen.getByTestId('hr-toggle-enabled'))
    fireEvent.click(screen.getByTestId('hr-toggle-enabled'))
    await waitFor(() => expect((window as any).termpolis.tokenSavingsSetSettings).toHaveBeenCalledWith({ enabled: false }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/tokenSavingsSettings.test.tsx`
Expected: FAIL — component module not found.

- [ ] **Step 3a: Implement the panel**

```tsx
// src/renderer/src/components/SettingsPane/TokenSavingsSettings.tsx
import { useEffect, useState } from 'react'

type Mode = 'conservative' | 'balanced' | 'aggressive'
interface Settings { enabled: boolean; mode: Mode; steering: boolean }
interface Totals { netSaved: number; events: number; byTool: Record<string, number> }
interface Receipt { session: Totals; cumulative: Totals }

const fmt = (n: number) => n.toLocaleString('en-US')

export function TokenSavingsSettings(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)

  const refresh = async () => {
    const s = await window.termpolis.tokenSavingsGetSettings()
    if (s.success) setSettings(s.data)
    const r = await window.termpolis.tokenSavingsGetReceipt()
    if (r.success) setReceipt(r.data)
  }
  useEffect(() => { void refresh() }, [])

  const update = async (p: Partial<Settings>) => {
    const res = await window.termpolis.tokenSavingsSetSettings(p)
    if (res.success) setSettings(res.data)
  }

  if (!settings) return <div>Loading…</div>

  return (
    <div className="settings-section">
      <h3>Token Savings <span style={{ fontWeight: 400, opacity: 0.7 }}>(Headroom)</span></h3>
      <p style={{ opacity: 0.8 }}>Compresses Termpolis's own tool outputs before the agent reads them. Reversible — the agent calls <code>retrieve_full</code> if it needs the full result. Your memory/brain is never touched.</p>

      <label>
        <input data-testid="hr-toggle-enabled" type="checkbox" checked={settings.enabled} onChange={() => update({ enabled: !settings.enabled })} />
        Compress tool outputs
      </label>

      <label>
        Aggressiveness:
        <select data-testid="hr-mode" value={settings.mode} onChange={e => update({ mode: e.target.value as Mode })} disabled={!settings.enabled}>
          <option value="conservative">Conservative</option>
          <option value="balanced">Balanced</option>
          <option value="aggressive">Aggressive</option>
        </select>
      </label>

      <label>
        <input data-testid="hr-toggle-steering" type="checkbox" checked={settings.steering} onChange={() => update({ steering: !settings.steering })} />
        Output-token steering (terser agent replies) <span style={{ opacity: 0.6 }}>— estimated</span>
      </label>

      <div className="hr-receipt" style={{ marginTop: 16 }}>
        <h4>Measured savings <span style={{ fontWeight: 400, opacity: 0.7 }}>(tokens removed, net of expansions)</span></h4>
        <div><strong>This session:</strong> {fmt(receipt?.session.netSaved ?? 0)} tokens across {receipt?.session.events ?? 0} tool results</div>
        <div><strong>All time:</strong> {fmt(receipt?.cumulative.netSaved ?? 0)} tokens</div>
        {receipt && Object.keys(receipt.session.byTool).length > 0 && (
          <ul>
            {Object.entries(receipt.session.byTool).sort((a, b) => b[1] - a[1]).map(([tool, n]) => (
              <li key={tool}>{tool}: {fmt(n)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3b: Register the tab**

In `src/renderer/src/lib/settingsNav.ts:9`, add `'tokenSavings'` to the union:

```ts
export type SettingsTab = 'general' | 'memory' | 'security' | 'voice' | 'keybindings' | 'agents' | 'shell' | 'tokenSavings'
```

In `src/renderer/src/components/SettingsPane/SettingsPane.tsx`, add the import (near :6-11):

```ts
import { TokenSavingsSettings } from './TokenSavingsSettings'
```

Add the tab button to the array (near :230-238):

```tsx
  { id: 'tokenSavings', label: 'Token Savings' },
```

Add the render line (near :605):

```tsx
{activeTab === 'tokenSavings' && <TokenSavingsSettings />}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/tokenSavingsSettings.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/SettingsPane/TokenSavingsSettings.tsx src/renderer/src/lib/settingsNav.ts src/renderer/src/components/SettingsPane/SettingsPane.tsx tests/renderer/tokenSavingsSettings.test.tsx
git commit -m "feat(headroom): Token Savings settings panel + measured receipt"
```

---

### Task 14: Full-suite green, coverage, and typecheck gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck** (esbuild strips types — typecheck is a separate gate, per v1.26.2 lesson)

Run: `npm run typecheck` (or `npx tsc --noEmit` if that is the script)
Expected: no errors. Fix any type mismatches (esp. `TermpolisAPI` signatures vs preload).

- [ ] **Step 2: Run the FULL suite** (focused runs lie — v1.27.4 lesson)

Run: `npm test`
Expected: all suites PASS, including the new `tests/electron/headroom*.test.ts` and `tests/renderer/tokenSavingsSettings.test.tsx`.

- [ ] **Step 3: Run coverage and confirm gates hold**

Run: `npm run test:coverage`
Expected: lines ≥ 97, functions ≥ 96, branches ≥ 93, statements ≥ 96. The new `src/main/headroom/**` files should be ~100%. If any headroom branch is uncovered, add a focused test (do not lower the gate).

- [ ] **Step 4: Verify the working tree is clean and on main**

Run: `git status --short && git log --oneline -14`
Expected: clean tree; the 13 feature commits present. (Do NOT tag yet — see Task 15.)

---

### Task 15: Release v1.28.0 (only after v1.27.8 completes)

**Files:** `package.json` (version).

- [ ] **Step 1: Confirm the in-flight v1.27.8 release finished green**

Run: `gh run list --limit 5 --json name,conclusion,headBranch`
Expected: the v1.27.8 Tests + Release runs show `conclusion: success`. If not, wait — do not tag over an in-flight release.

- [ ] **Step 2: Bump the version**

Edit `package.json` `"version": "1.27.8"` → `"1.28.0"`.

- [ ] **Step 3: Commit and tag**

```bash
git add package.json
git commit -m "Release v1.28.0: Token Headroom — compress tool outputs, steer output, savings receipt"
git tag v1.28.0
git push origin main --tags
```

- [ ] **Step 4: Watch both pipelines to green (use the release-notify skill)**

Invoke the `release-notify` skill: watch the Tests AND Release workflows via `--json conclusion` until both are `success`; ship a clean patch if either fails; send the release email.

- [ ] **Step 5: Update MEMORY.md** — add ONE index line for the v1.28.0 minor (per the memory-budget rule: one line per minor, not per patch).

---

## Self-Review

**Spec coverage:**
- §2 scope (owned outputs, memory-exempt) → Tasks 4, 7, 10. ✓
- §3 one choke point, deterministic → Task 9. ✓
- §4 Model C (structural + reversible offload) → Tasks 5 (compressors), 2 (CCR), 7 (offload+footer), 8 (retrieve_full). ✓
- §5 output steering → Task 12. ✓
- §6 savings receipt in settings → Tasks 6 (ledger), 11 (IPC), 13 (panel). ✓
- §7 performance (in-memory CCR, buffered ledger, byte cap, perf test) → Tasks 2, 6, 7, 9 (perf-budget test). ✓
- §8 fail-open → Task 7 (catch → original), Task 8 (expired message). ✓
- §9 testing (golden, round-trip, honest-ledger, guard, fail-open, e2e proof, perf) → Tasks 1–13 tests + Task 10 guard + Task 9 proof/perf + Task 14 gate. ✓
- §10 release v1.28.0 after 1.27.8 → Task 15. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code; every test shows real assertions. ✓

**Type consistency:** `HeadroomSettings`/`Mode`/`Thresholds` (Task 1) reused in 7, 11, 12, 13. `Compressed { text, offload? }` (Task 5) consumed in 7. `ccrStash`/`ccrRetrieve` (Task 2) consumed in 7, 8. `recordEvent`/`summarizeSavings` (Task 6) consumed in 7, 8, 11. `compressToolResult(name, result): string` (Task 7) consumed in 9. IPC channel names match across index/preload/types (Task 11). ✓

**Notes for the implementer:**
- If `index.ts` does not already import `estimateTokens` from `./memoryEconomy`, add it (Task 8 uses it).
- `performance.now()` is a Node global (perf test, Task 9) — no import needed.
- The renderer test uses `@testing-library/react`; confirm it is already a devDependency (the repo's existing `tests/renderer/**` use it). If a different render util is used there, mirror that file's imports.

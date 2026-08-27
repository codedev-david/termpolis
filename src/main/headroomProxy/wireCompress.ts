import * as crypto from 'crypto'
import { compactText } from '../headroom/compactText'
import { compactWeb, looksLikeHtml } from '../headroom/compactWeb'
import { thresholdsFor, type Mode } from '../headroom/config'
import { applyPrefixDecay } from './prefixDecay'
import { bestDiff, makeCandidate, type DiffCandidate } from '../headroom/diffEncode'
import { compactJson } from './jsonCompact'
import { familyForPath, looksLikeCode, outlineCode } from './codeOutline'
import { isExempt } from '../headroom/router'
import { STEERING_MARK } from '../headroom/outputSteering'

export interface WireStats {
  trBlocks: number
  trOrigChars: number
  trCompChars: number
  /** tool_use input (the agent's own output, re-read from the prefix every turn) — counted
   *  separately from tool_result so the dashboard can report what each surface actually earns
   *  rather than quoting one blended number that hides which half is working. */
  tuBlocks: number
  tuOrigChars: number
  tuCompChars: number
  images: number
  imgOrigBytes: number
  imgCompBytes: number
  /** The PREFIX HEAD — `system` and `tools` — measured, never rewritten.
   *
   *  Every compression this file performs happens inside `messages`. The system prompt and the
   *  tool schemas sit in front of it, are re-sent on every single request, and are what a cache
   *  WRITE actually pays for at 1.25x. On this install that bucket was 258M tokens, ~27% of
   *  effective input spend, and no layer could see it at all. Measuring is the whole point:
   *  `tpToolsChars` isolates the slice Termpolis itself emits, which is the only slice we are
   *  entitled to shrink. */
  sysChars: number
  toolsChars: number
  toolCount: number
  tpToolsChars: number
  /** How many messages this request carried. The prefix head is what a conversation costs to
   *  START; this is what it costs to have KEPT GOING, and it is the only field here the
   *  compressor cannot act on — see headroom/sessionDepth.ts. */
  msgCount: number
  /** Whether this request carried the output-steering directive. Output is 5x input and the
   *  largest single bucket on the bill; steering is the only lever aimed at it, and until now
   *  nothing recorded whether it was even present, let alone what it earned. */
  steered: boolean
}
/** Which counter pair a compacted block is billed to. */
export type StatBucket = 'tr' | 'tu'
export interface WireResult {
  body: string
  changed: boolean
  stats: WireStats
  stashes: Array<{ token: string; original: string }>
}
export type ImageCompressor = (dataB64: string, mediaType: string) => { data: string; mediaType: string; changed: boolean }

function emptyStats(): WireStats {
  return {
    trBlocks: 0, trOrigChars: 0, trCompChars: 0, tuBlocks: 0, tuOrigChars: 0, tuCompChars: 0,
    images: 0, imgOrigBytes: 0, imgCompBytes: 0,
    sysChars: 0, toolsChars: 0, toolCount: 0, tpToolsChars: 0, msgCount: 0, steered: false,
  }
}
function detToken(s: string): string { return 'hr_' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 16) }

export interface WireWindow { headLines: number; tailLines: number; maxChars: number; floorChars: number }

/**
 * `Thresholds.floorTokens` counts tokens; every gate on the wire counts chars. Four chars per
 * token is the ratio config.ts's own comments already use to gloss that column ("150 (~600
 * chars)"), so converting here beats adding a second table that could drift away from the first.
 */
export const FLOOR_CHARS_PER_TOKEN = 4

/**
 * Mode → wire window, mirroring the config profiles (maxChars ← maxFieldChars, floorChars ←
 * floorTokens). Exposed so the proxy child can translate a mode message without importing
 * config's mutable settings state.
 * Unknown mode → null, so a garbled message can never silently DOWNGRADE the active window.
 */
export function windowForMode(mode: string): WireWindow | null {
  if (mode !== 'conservative' && mode !== 'balanced' && mode !== 'aggressive' && mode !== 'max') return null
  const t = thresholdsFor(mode as Mode)
  return { headLines: t.headLines, tailLines: t.tailLines, maxChars: t.maxFieldChars, floorChars: t.floorTokens * FLOOR_CHARS_PER_TOKEN }
}

/**
 * The active tool-output window for the LIVE proxy wire — the SOLE driver of the reported
 * savedPct. Defaults to the 'aggressive' profile (12/6/1000, floor 1600): keep the head (command
 * + first output) and tail (result/errors) an agent needs inline; the full original is always
 * stashed, so retrieve_full recovers the middle on demand (empirically rare). setWireWindow() lets
 * the proxy child honor the user's mode live (proxySupervisor pushes it on init + on change); the
 * aggressive default is the fail-safe, so a missing/garbled mode keeps savings high, never drops
 * them. The validated setter also guarantees a bad payload can neither break nor downgrade it.
 */
let wireWindow: WireWindow = { headLines: 12, tailLines: 6, maxChars: 1000, floorChars: 1600 }

/**
 * The floor is the one part of the window that moves ONCE per launch and then never again.
 *
 * headLines/tailLines/maxChars only change how a block that is already being compacted gets cut;
 * the floor changes WHICH blocks are compacted at all. Lower it mid-session and every short block
 * already sitting in the cached prefix comes back compacted on the next turn — the prefix is
 * rewritten, the Anthropic prompt cache is lost, and one bust costs far more than any floor change
 * earns. Same arithmetic, same answer as savingsFloor.ts: resolve before the first request, then
 * freeze. A push carrying no usable floor (an old-shaped window, a garbled zero) leaves the one
 * resolution unspent for a later push rather than locking in the fail-safe default.
 */
let floorResolved = false

export function setWireWindow(w: WireWindow | null | undefined): void {
  if (w && Number.isFinite(w.headLines) && Number.isFinite(w.tailLines) && Number.isFinite(w.maxChars)
      && w.headLines >= 0 && w.tailLines >= 0 && w.maxChars > 0) {
    const takesFloor = !floorResolved && Number.isFinite(w.floorChars) && w.floorChars > 0
    if (takesFloor) floorResolved = true
    wireWindow = {
      headLines: Math.floor(w.headLines), tailLines: Math.floor(w.tailLines), maxChars: Math.floor(w.maxChars),
      floorChars: takesFloor ? Math.floor(w.floorChars) : wireWindow.floorChars,
    }
  }
}

/**
 * Extended-thinking budget ceiling, in tokens. 0 = off (the default, and deliberately so — a
 * silent cut to reasoning depth is not something to opt a user into).
 *
 * Everything else Token Headroom does compresses what goes IN. Output is the one slice it never
 * touched, and on a measured 62,716-request lifetime it was 38% of effective spend — thinking
 * tokens are billed as output, and extended thinking is where they come from. Clamping the
 * client's declared budget is the only lever that reaches them.
 *
 * CACHE SAFETY: the Anthropic prompt cache keys on the thinking parameters, so a budget that
 * varied per request would invalidate the cached prefix on every turn and cost far more than it
 * saved. The clamp is therefore a pure function of (declared budget, this constant) — the same
 * session always emits the same value. Changing the cap in Settings costs exactly one cache miss,
 * the same as changing the compression mode already does.
 */
export const THINKING_MIN_BUDGET = 1024 // Anthropic's floor; clamping below it is an invalid request
let thinkingCap = 0
export function setThinkingCap(n: unknown): void {
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) thinkingCap = Math.floor(n)
}
export function getThinkingCap(): number { return thinkingCap }

/** Lower a declared thinking budget to the cap. Returns whether the body was modified. */
export function clampThinkingBudget(obj: { thinking?: unknown }): boolean {
  if (thinkingCap <= 0) return false
  const t = obj.thinking as { budget_tokens?: unknown } | null | undefined
  if (!t || typeof t !== 'object' || typeof t.budget_tokens !== 'number') return false
  const target = Math.max(THINKING_MIN_BUDGET, thinkingCap)
  if (t.budget_tokens <= target) return false // only ever lowers; never raises a user's budget
  t.budget_tokens = target
  return true
}

/**
 * What the wire already told us about a block's content. Derived only from the request body — the
 * enclosing tool_use's name and the path it names — so it stays a pure function of the input and
 * cannot make compression vary between turns.
 */
export interface ContentHint { path?: string; toolName?: string }

/** Input keys that name the file a tool acted on. First match wins; all are in TOOL_USE_SKIP. */
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'filePath', 'file']

/** Pull the content hint out of a tool_use input object. */
export function hintFromInput(input: unknown, name?: unknown): ContentHint {
  const hint: ContentHint = {}
  if (typeof name === 'string') hint.toolName = name
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>
    for (const k of PATH_KEYS) {
      const v = rec[k]
      if (typeof v === 'string' && v.length > 0) { hint.path = v; break }
    }
  }
  return hint
}

/**
 * Index tool_use blocks by id so a tool_result can be told which file it came from. Built in one
 * pass over the whole body before any rewriting, so it is complete regardless of block order and
 * unaffected by anything the rewrite later does to those inputs.
 */
export function collectToolUseHints(messages: Array<{ content?: unknown }>): Map<string, ContentHint> {
  const map = new Map<string, ContentHint>()
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object' || b.type !== 'tool_use' || typeof b.id !== 'string') continue
      map.set(b.id, hintFromInput(b.input, b.name))
    }
  }
  return map
}

/**
 * A structural pass has already thrown away the bodies, so what remains is nearly all signal —
 * spending the raw window on it would undo the fidelity the pass just bought. This multiplies the
 * budget instead. It stays a MULTIPLE of the user's mode, so 'max' is still tighter than
 * 'aggressive', and the block is still hard-bounded: an outline that overruns is windowed like
 * anything else, and the full original remains one retrieve_full away.
 */
export const STRUCT_WINDOW_SCALE = 3

function scaleWindow(w: WireWindow, k: number): WireWindow {
  // floorChars is deliberately NOT scaled: the block is already past the floor by the time this
  // runs, and a scaled copy would be a second, contradictory answer to "is this worth compacting".
  return { ...w, headLines: w.headLines * k, tailLines: w.tailLines * k, maxChars: w.maxChars * k }
}

/**
 * Bound an already-structured block by lines and then by chars. The char clamp is what compactText
 * cannot do: minified JSON is a single line, so a line window either never fires or (with head and
 * tail both covering that one line) emits it TWICE.
 */
export function windowStructured(s: string, win: WireWindow): { text: string; elided: boolean } {
  let out = s
  let elided = false
  const lines = s.split('\n')
  if (lines.length > win.headLines + win.tailLines) {
    const head = lines.slice(0, win.headLines)
    const tail = lines.slice(lines.length - win.tailLines)
    out = [...head, `… [${lines.length - head.length - tail.length} lines elided] …`, ...tail].join('\n')
    elided = true
  }
  if (out.length > win.maxChars) {
    out = `${out.slice(0, win.maxChars)}\n… [${out.length - win.maxChars} chars elided] …`
    elided = true
  }
  return { text: out, elided }
}

/**
 * Deterministically compact one tool_result text: content router (HTML / JSON / code) then a
 * head/tail window (wireWindow). When it elides content it appends a footer with a CONTENT-HASH
 * token (so re-compression is byte-identical → cache-safe) and returns the original to stash.
 */
export function compactToolText(text: string, hint?: ContentHint): { text: string; stash?: { token: string; original: string } } {
  if (text.length < wireWindow.floorChars) return { text }
  // Content-aware pre-pass, one branch per shape. Each reduces the block to its meaningful
  // structure BEFORE the window, so the surviving bytes are chosen rather than sliced:
  //   HTML  → readable text          (a line window barely helps markup-dense, few-newline HTML)
  //   JSON  → sampled + minified     (a minified payload is ONE line, so the window never fires)
  //   code  → signatures, no bodies  (a head/tail window keeps imports and throws away the API)
  // The branches are exclusive — the three shapes don't overlap — and every one is shrink-only
  // and deterministic, with the original still stashed for retrieve_full.
  let body = text
  let hidden = false      // content was removed, so the block needs a retrieve token
  let structured = false  // the branch already chose what matters; see STRUCT_WINDOW_SCALE
  if (looksLikeHtml(text)) {
    const w = compactWeb(text)
    /* v8 ignore next -- the false arm is unreachable: compactWeb only ever deletes markup, expands
       entities to something shorter and collapses whitespace, so it cannot grow the input, and
       looksLikeHtml only fires when there are tags to delete. Kept as a shrink-only assertion. */
    if (w.length < text.length) {
      body = w
      hidden = true
    }
  } else {
    const j = compactJson(text)
    if (j && j.text.length < text.length) {
      body = j.text
      hidden = j.elided // a whitespace-only win hides nothing, so it needs no token
      structured = true
    } else {
      const fam = familyForPath(hint?.path)
      if (fam !== null || looksLikeCode(text)) {
        const o = outlineCode(text, fam)
        if (o.length < text.length) {
          body = o
          hidden = true
          structured = true
        }
      }
    }
  }
  const r = structured
    ? windowStructured(body, scaleWindow(wireWindow, STRUCT_WINDOW_SCALE))
    : compactText(body, wireWindow)
  if (r.text.length >= text.length) return { text } // net no shrink → forward original
  // No retrieve token needed only when nothing was hidden: pure consecutive-line
  // dedup is self-describing, whereas an elision or a structural reduction hides content.
  if (!r.elided && !hidden) return { text: r.text }
  const token = detToken(text) // key on the ORIGINAL so retrieve_full returns the true original
  const withNotice = `${r.text}\n\n[headroom] Full result cached — call the retrieve_full tool with token "${token}" to expand it.`
  // Never hand back more than we were given. The retrieval notice is ~110 chars, and on a
  // markup-light block the pre-pass can save less than that — leaving a "compressed" block
  // LARGER than the original, which then rides the cached prefix and is re-read at that inflated
  // size on every later turn. Shrink-only is the invariant the cache math depends on, and it has
  // to hold after the notice is added, not before.
  if (withNotice.length >= text.length) return { text }
  return { text: withNotice, stash: { token, original: text } }
}

/** Blocks already met in THIS body: hashes for exact-duplicate collapse, texts as diff bases. */
export interface SeenIndex { keys: Set<string>; blocks: DiffCandidate[] }
export function emptySeen(): SeenIndex { return { keys: new Set<string>(), blocks: [] } }

/**
 * Compact one tool_result text string, OR replace it with a reference to an earlier block in
 * THIS SAME REQUEST BODY: a one-line stub when the two are byte-identical, a patch (v1.34.0)
 * when they merely share a head and tail — the read-edit-reread shape that exact-duplicate
 * matching always missed.
 *
 * `seen` is scoped to a single rewriteMessagesBody call and filled left-to-right, so the output
 * stays a PURE function of the body (determinism guard holds) and remains byte-stable across
 * turns (cache-safe): a repeat only collapses when its earlier twin is also present, which it is
 * on every turn that re-sends the conversation. Reversible either way — the original is stashed
 * under its content-hash token for retrieve_full.
 */
function compactOrDedup(
  text: string,
  seen: SeenIndex,
  stats: WireStats,
  stashes: Array<{ token: string; original: string }>,
  bucket: StatBucket = 'tr',
  hint?: ContentHint,
): { text: string; changed: boolean } {
  const origKey = bucket === 'tu' ? 'tuOrigChars' : 'trOrigChars'
  const compKey = bucket === 'tu' ? 'tuCompChars' : 'trCompChars'
  const blockKey = bucket === 'tu' ? 'tuBlocks' : 'trBlocks'
  stats[origKey] += text.length
  let out = text
  let changed = false
  const key = detToken(text)
  if (text.length >= wireWindow.floorChars && seen.keys.has(key)) {
    // A block at or above the floor already seen earlier in THIS body → collapse to a one-line
    // reference stub (always far shorter than the original, since the floor is well past the
    // stub's own length). Reversible: the original is stashed under its content-hash token.
    out = `[headroom] Identical to an earlier tool result in this conversation — call the retrieve_full tool with token "${key}" to expand it.`
    changed = true
    stats[blockKey]++
    stashes.push({ token: key, original: text })
  } else {
    const c = compactToolText(text, hint)
    let best = c.text
    let stash = c.stash
    if (text.length >= wireWindow.floorChars) {
      const cand = makeCandidate(text)
      // Diff BEFORE recording this block, so it can never be its own base.
      const p = bestDiff(seen.blocks, cand.lines, text.length, key)
      if (p && p.text.length < best.length) { best = p.text; stash = { token: key, original: text } }
      seen.keys.add(key)
      seen.blocks.push(cand)
    }
    if (best.length < text.length) {
      out = best
      changed = true
      stats[blockKey]++
      if (stash) stashes.push(stash)
    }
  }
  stats[compKey] += out.length
  return { text: out, changed }
}

/**
 * Record a block in `seen` WITHOUT rewriting it — the index half of compactOrDedup, split out for
 * the fields that must ride the wire verbatim (TOOL_USE_VERBATIM).
 *
 * A file body the agent wrote has to arrive byte-for-byte, but it is still the best possible dedup
 * key and diff base for the tool_result that re-reads that same file a few turns later — and a
 * tool_result IS safe to compress. Indexing it here keeps the "wrote it, then read it — paid for
 * once, not twice" collapse working, which simply skipping the field would have silently lost.
 *
 * The key and candidate are derived from the ORIGINAL text at the same point in the left-to-right
 * walk where compactOrDedup would have added them, so the index state — and therefore every later
 * block's output — is byte-identical to before. Determinism and cache-stability are unaffected.
 */
function noteSeen(text: string, seen: SeenIndex): void {
  if (text.length < wireWindow.floorChars) return
  const key = detToken(text)
  if (seen.keys.has(key)) return // already indexed by an earlier identical block
  seen.keys.add(key)
  seen.blocks.push(makeCandidate(text))
}

function compressImageBlock(block: { source?: { type?: string; media_type?: string; data?: string } }, compressImage: ImageCompressor, stats: WireStats): boolean {
  const src = block.source
  if (!src || src.type !== 'base64' || typeof src.data !== 'string') return false
  let res
  try { res = compressImage(src.data, src.media_type || 'image/png') } catch { return false }
  if (!res || !res.changed || typeof res.data !== 'string' || res.data.length >= src.data.length) return false
  stats.images++; stats.imgOrigBytes += src.data.length; stats.imgCompBytes += res.data.length
  src.data = res.data; src.media_type = res.mediaType
  return true
}

/**
 * Keys in a tool_use input that name a thing rather than carry content. All are short enough that
 * the compaction floor already excludes them; the explicit skip is defense-in-depth, because a
 * truncated path or glob would be actively misleading rather than merely elided.
 */
const TOOL_USE_SKIP = new Set(['file_path', 'path', 'notebook_path', 'url', 'pattern', 'glob'])

/**
 * Fields whose bytes the agent COPIES FORWARD into the real world, and which therefore must survive
 * byte-for-byte no matter how large they get.
 *
 * The distinction that makes tool_result compression safe does not hold here. A tool_result is
 * OBSERVED DATA: the model knows it did not author it, and calls retrieve_full when it needs the
 * exact bytes back. A tool_use input is AUTHORED INTENT: the model treats its own prior Write/Edit/
 * Bash input as the record of what it meant, reproduces it verbatim on a later turn, and has no
 * reason to suspect the bytes were rewritten underneath it.
 *
 * So eliding these does not shrink history — it REWRITES it, and the elision marker becomes a real
 * artifact. Both of these are from one live session (2026-08-25):
 *
 *     /usr/bin/bash: line 37: [headroom]: command not found
 *     File "apex3.py", line 8: SyntaxError: invalid character '…' (U+2026)
 *
 * The model had re-emitted "… [20 lines elided] …" and the "[headroom] Full result cached" footer
 * into a real Python file and a real shell command. Each such turn is a red tool error, a retry off
 * the same poisoned history, and a retrieve_full round-trip — which is why the give-back ledger ran
 * NET NEGATIVE (-7,970,560 tokens) instead of paying for itself.
 *
 * Keeping them whole costs ~1.7% of measured savings (tool_use was 22.5M of 1.34B saved tokens) and
 * removes the entire failure class. The remaining tool_use fields — descriptions, prompts, MCP tool
 * bodies — are still compressed, and identifiers are still skipped above.
 */
const TOOL_USE_VERBATIM = new Set([
  'content',      // Write — the file body, replayed onto disk
  'command',      // Bash — replayed into a shell, heredocs and all
  'old_string',   // Edit — must match the file EXACTLY or the edit fails
  'new_string',   // Edit — replayed into the file
  'new_source',   // NotebookEdit — replayed into the cell
  'old_source',
  'replace_all',
  'edits',        // MultiEdit — an array today, a string if ever serialized
  // Anthropic's built-in text_editor tool and Codex's apply_patch reach the same files through
  // different field names. Same replay, same consequence — the set is keyed on behaviour, not on
  // which client happens to be in front of the proxy.
  'file_text',    // text_editor create — the whole file body
  'old_str',      // text_editor str_replace — must match the file EXACTLY
  'new_str',      // text_editor str_replace — replayed into the file
  'patch',        // apply_patch — a unified diff applied verbatim
])

/**
 * Compress the bulk string fields of a historical `tool_use` block — the agent's OWN output —
 * EXCEPT the artifact-bearing fields listed in TOOL_USE_VERBATIM, which are copied forward into
 * real files and real shell commands and must therefore arrive byte-for-byte.
 *
 * Output tokens are billed once at generation (5x, and nothing here can change that), but they then
 * live in the prefix and are re-read as cache-read tokens on EVERY later turn. Those re-reads were
 * paying full freight.
 *
 * Cache-safe: deterministic, shrink-only, and byte-stable across turns, so the re-sent prefix keeps
 * hashing the same. Reversible via retrieve_full. Every tool_use in a request body is by definition
 * a PRIOR action (the current turn's has not been generated yet), so this never touches an in-flight
 * call — but "prior" is NOT the same as "finished with", which is what TOOL_USE_VERBATIM exists to
 * say: the agent re-reads and replays its own prior inputs.
 */
function compressToolUseInput(
  block: { input?: unknown },
  seen: SeenIndex,
  stats: WireStats,
  stashes: Array<{ token: string; original: string }>,
): boolean {
  const input = block.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const rec = input as Record<string, unknown>
  let changed = false
  // The block names its own file (Write's file_path sits beside its content), so the router can
  // outline what the agent wrote just as it outlines what the agent read.
  const hint = hintFromInput(rec, (block as { name?: unknown }).name)
  // The memory/swarm exemption is a product invariant, not an MCP-layer detail: what the model
  // SEES when it recalls has to be what the brain stored. The MCP layer already refuses these
  // tools; the wire used to compress them anyway, because the wire's name is namespaced
  // (`mcp__termpolis__memory_write`) and the exemption list holds bare names. isExempt strips
  // the namespace now, so one list governs both layers.
  if (hint.toolName && isExempt(hint.toolName)) return false
  // Object.keys order is insertion order, and the body is re-parsed from identical JSON each
  // turn, so the traversal — and therefore the output — is deterministic.
  for (const k of Object.keys(rec)) {
    if (TOOL_USE_SKIP.has(k)) continue
    const v = rec[k]
    // Artifact-bearing field: index it as a dedup key / diff base for the tool_results that follow,
    // but hand the bytes on untouched. Never counted as compressible material — it isn't.
    if (TOOL_USE_VERBATIM.has(k)) {
      if (typeof v === 'string') noteSeen(v, seen)
      continue
    }
    // Only fields at/above the compaction floor are candidates — below it compactOrDedup is a
    // provable no-op, so counting them would just dilute the ratio with incompressible tare.
    if (typeof v !== 'string' || v.length < wireWindow.floorChars) continue
    const r = compactOrDedup(v, seen, stats, stashes, 'tu', hint)
    if (r.changed) { rec[k] = r.text; changed = true }
  }
  return changed
}

/**
 * Rewrite an Anthropic /v1/messages request body: compress tool_result text, tool_use input and
 * image blocks, and (only when a cap is configured — off by default) lower `thinking.budget_tokens`.
 * Everything else (system, tools, thinking blocks, cache_control, all headers/fields) is left
 * byte-identical. `thinking` blocks are a HARD exclusion: they carry a cryptographic signature that
 * Anthropic validates, so any edit would be rejected outright.
 * Deterministic and FAIL-OPEN: any parse error / unknown shape / anomaly returns the original body.
 */
/** Tool names Termpolis itself registers, as Claude Code presents them over MCP. */
const TP_TOOL_PREFIX = 'mcp__termpolis__'
/* STEERING_MARK is imported, not restated — see its definition for why. */

/**
 * Measure the prefix head. Read-only by construction: it takes the parsed body and writes only
 * into `stats`, so no future edit here can change a byte on the wire. `system` may be a string or
 * an array of blocks; both shapes are summed rather than one being silently scored as zero.
 */
function measurePrefixHead(obj: Record<string, unknown>, stats: WireStats): void {
  const sys = obj.system
  let sysText = ''
  if (typeof sys === 'string') sysText = sys
  else if (Array.isArray(sys)) {
    for (const b of sys) {
      const t = (b as { text?: unknown })?.text
      if (typeof t === 'string') sysText += t
    }
  }
  stats.sysChars = sysText.length
  stats.steered = sysText.includes(STEERING_MARK)
  // Before the `tools` early return on purpose: a request without a tools array still has a
  // depth, and dropping it would bias the curve toward tool-using turns only.
  stats.msgCount = Array.isArray(obj.messages) ? obj.messages.length : 0
  const tools = obj.tools
  if (!Array.isArray(tools)) return
  stats.toolCount = tools.length
  for (const t of tools) {
    let size: number
    try { size = JSON.stringify(t)?.length ?? 0 } catch { continue } // a cyclic tool is not ours to count
    stats.toolsChars += size
    const name = (t as { name?: unknown })?.name
    if (typeof name === 'string' && name.startsWith(TP_TOOL_PREFIX)) stats.tpToolsChars += size
  }
}

export function rewriteMessagesBody(raw: string, opts: { compressImage?: ImageCompressor; maxBodyChars?: number; decay?: boolean } = {}): WireResult {
  const stats = emptyStats()
  const stashes: Array<{ token: string; original: string }> = []
  const seen = emptySeen() // per-body dedup/diff index over earlier tool_result text, filled left-to-right
  const maxChars = opts.maxBodyChars ?? 10_000_000
  if (raw.length > maxChars) return { body: raw, changed: false, stats, stashes }
  let obj: { messages?: unknown[]; thinking?: unknown }
  try { obj = JSON.parse(raw) } catch { return { body: raw, changed: false, stats, stashes } }
  if (!obj || !Array.isArray(obj.messages)) return { body: raw, changed: false, stats, stashes }
  // Measured here, BEFORE the round-trip guard below can fail us open: the prefix head is an
  // observation of what the client sent, not a claim about what we compressed, so it stays true
  // on requests we decline to touch. Those are exactly the requests whose cost was invisible.
  measurePrefixHead(obj as Record<string, unknown>, stats)
  // Corruption + cache safety: only proceed when the body round-trips LOSSLESSLY (the Anthropic
  // V8 SDK emits canonical JSON). Otherwise a whole-object reserialize could silently alter an
  // UNTOUCHED field — an integer > 2^53, unusual escaping, etc. — so fail open. This makes every
  // non-tool_result byte identical to the client's original, and keeps the prompt cache intact.
  let reserialized: string
  /* v8 ignore next -- the catch is unreachable here: `obj` is the untouched JSON.parse result and
     nothing has mutated it yet, so stringify cannot throw. Kept as a fail-open guard. */
  try { reserialized = JSON.stringify(obj) } catch { return { body: raw, changed: false, stats, stashes } }
  if (reserialized !== raw) return { body: raw, changed: false, stats, stashes }
  let changed = clampThinkingBudget(obj)
  // Built once, up front: a tool_result's file hint lives in the tool_use it answers, which sits
  // in an EARLIER message, and the lookup must not depend on how far the walk has got.
  const hints = collectToolUseHints(obj.messages as Array<{ content?: unknown }>)
  try {
    // Decay runs BEFORE the main walk so aged-out blocks never enter the dedup/diff index — a
    // later block must not be encoded as a patch against something no longer on the wire.
    if (opts.decay) {
      const d = applyPrefixDecay(obj.messages as Array<{ content?: unknown }>, stashes)
      if (d.blocks > 0) {
        changed = true
        stats.trBlocks += d.blocks
        stats.trOrigChars += d.origChars
        stats.trCompChars += d.compChars
      }
    }
    for (const m of obj.messages as Array<{ content?: unknown }>) {
      if (!m || !Array.isArray(m.content)) continue
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'tool_result') {
          // The result carries no file name of its own — it is the tool_use it answers, in an
          // earlier message, that knows which file this is. hints was built before the walk.
          const hint = typeof b.tool_use_id === 'string' ? hints.get(b.tool_use_id) : undefined
          // Same exemption as the tool_use path: a recalled memory reaches the model whole or the
          // brain may as well not have stored it. The tool_use this result answers is what knows
          // the name, which is exactly what `hints` was built to carry.
          if (hint?.toolName && isExempt(hint.toolName)) continue
          if (typeof b.content === 'string') {
            const r = compactOrDedup(b.content, seen, stats, stashes, 'tr', hint)
            if (r.changed) { b.content = r.text; changed = true }
          } else if (Array.isArray(b.content)) {
            for (const item of b.content as Array<Record<string, unknown>>) {
              if (item && item.type === 'text' && typeof item.text === 'string') {
                const r = compactOrDedup(item.text, seen, stats, stashes, 'tr', hint)
                if (r.changed) { item.text = r.text; changed = true }
              } else if (item && item.type === 'image' && opts.compressImage) {
                changed = compressImageBlock(item as { source?: { type?: string; media_type?: string; data?: string } }, opts.compressImage, stats) || changed
              }
            }
          }
        } else if (b.type === 'image' && opts.compressImage) {
          changed = compressImageBlock(b as { source?: { type?: string; media_type?: string; data?: string } }, opts.compressImage, stats) || changed
        } else if (b.type === 'tool_use') {
          // Shares `seen` with tool_result on purpose: a file the agent WROTE and later READ
          // collapses on the second occurrence instead of being paid for twice.
          if (compressToolUseInput(b, seen, stats, stashes)) changed = true
        }
      }
    }
  } catch {
    return { body: raw, changed: false, stats: emptyStats(), stashes: [] } // fail-open
  }
  if (!changed) return { body: raw, changed: false, stats, stashes }
  let out: string
  try { out = JSON.stringify(obj) } catch { return { body: raw, changed: false, stats: emptyStats(), stashes: [] } }
  return { body: out, changed: true, stats, stashes }
}

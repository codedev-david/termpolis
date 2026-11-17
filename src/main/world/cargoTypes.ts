// What travels on a line the code alone describes: a few cargo types a person reads at a glance
// (spec line 88: keystrokes, requests, tool calls, memories, code changes, logs, jobs), never the
// raw identifier. An environment-variable read is "settings", whatever the variable is called; the
// variable's name stays in the line's own label, which the connection card shows.
import type { BoundaryKind } from './detectors/common'

/** The cargo key of a line by the kind of boundary it crosses. A plain import carries 'code'. */
export const CARGO_OF_KIND: Record<BoundaryKind, string> = {
  ipc: 'messages',
  port: 'network',
  fork: 'jobs',
  worker: 'jobs',
  spawn: 'jobs',
  'http-out': 'requests',
  'http-listen': 'requests',
  env: 'settings',
  mcp: 'tool calls',
  watch: 'file changes',
}

/** The legend's words for each code-derived cargo key. */
export const CARGO_LABELS: Record<string, string> = {
  code: 'Code',
  messages: 'Messages inside the app',
  network: 'Network traffic',
  jobs: 'Jobs for other programs',
  requests: 'Web requests',
  settings: 'Settings from the environment',
  'tool calls': 'Tool calls',
  'file changes': 'File changes',
}

/** The cargo of a line that crosses these boundaries (the first one decides), or 'code' for an import. */
export function cargoOf(kinds: BoundaryKind[]): string {
  return kinds.length === 0 ? 'code' : CARGO_OF_KIND[kinds[0]]
}

/** The words for a cargo key: the legend's for a code-derived one, else the key itself (a model's own word). */
export function cargoLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(CARGO_LABELS, key) ? CARGO_LABELS[key] : key
}

/**
 * A colour of its own for each code-derived cargo key, told apart at a glance: every pair is far
 * apart (CIE76 colour difference of 40 or more) and each reads at 4.5:1 or better on the Neon,
 * Blueprint and Glass backgrounds (tests/electron/worldCargoTypes.test.ts checks both).
 */
export const CARGO_COLORS: Record<string, string> = {
  code: '#38bdf8',
  messages: '#a78bfa',
  network: '#34d399',
  jobs: '#fb923c',
  requests: '#facc15',
  settings: '#f472b6',
  'tool calls': '#e2e8f0',
  'file changes': '#a3e635',
}
/** After those, for a model's own cargo words. */
const EXTRA_COLORS = ['#f87171', '#2dd4bf', '#e879f9', '#818cf8']
const ALL_COLORS = [...Object.values(CARGO_COLORS), ...EXTRA_COLORS]

/**
 * The colour of each cargo key of one world. A code-derived key has its own; any other key takes, in
 * the order given, the colours this world leaves unused, so the keys of one world stay apart; past
 * those the colours go round again.
 */
export function cargoColors(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(CARGO_COLORS, k)) out[k] = CARGO_COLORS[k]
  const taken = new Set(Object.values(out))
  const free = ALL_COLORS.filter((c) => !taken.has(c))
  let i = 0
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(out, k)) continue
    out[k] = i < free.length ? free[i] : ALL_COLORS[(i - free.length) % ALL_COLORS.length]
    i++
  }
  return out
}

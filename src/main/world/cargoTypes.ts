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

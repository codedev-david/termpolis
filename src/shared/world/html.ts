// Shared HTML escaping for every Lumopolis output that builds markup (cards, 2D fallback, export, documentation).

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escapes `& < > " '`. Every interpolated value, attributes included, must go through this. A runtime non-string is coerced; null and undefined become ''. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])
}

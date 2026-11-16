// Shared HTML escaping for every engine module that builds markup (cards, 2D fallback).

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escapes `& < > " '`. Every interpolated value, attributes included, must go through this. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c])
}

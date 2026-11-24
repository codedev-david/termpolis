// A colour from a world doc ends up inside style attributes (a card's cargo swatch), so only a plain hex colour is
// kept, the same allowlist as the exported page's legend (src/world-export/controls.ts safeColor).

/** The grey a colour outside the allowlist becomes, the legend's and the scene's fallback. */
export const FALLBACK_COLOR = '#94a3b8'

/** Whether `c` is a plain hex colour: '#' and 3 to 8 hex digits, nothing else. */
export const isSafeColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c)

/** `c` when it is a plain hex colour, else FALLBACK_COLOR. */
export const safeColor = (c: unknown): string => (isSafeColor(c) ? c : FALLBACK_COLOR)

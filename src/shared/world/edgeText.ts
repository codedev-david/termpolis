// Lumopolis line words: what a connection says on screen and as its card's title. A label the code
// alone wrote lists every identifier the line crosses ("env A, env B, ipc c"); shown as it is, a
// busy building's lines pile into an unreadable band. On screen it is a short summary from the kind
// and a count instead ("reads 2 settings +1 more"), and the card body lists the identifiers in full.
// A model's own label is kept, cut to the same length.

/** The longest line label or card title, in characters; a longer one ends in an ellipsis. */
export const MAX_EDGE_TEXT = 32

/** What one kind of crossing does: the verb, and the noun for one and for more. */
type Phrase = readonly [verb: string, one: string, many: string]
const PROGRAMS: Phrase = ['starts', 'program', 'programs']
const PHRASES: Record<string, Phrase> = {
  env: ['reads', 'setting', 'settings'],
  ipc: ['uses', 'message channel', 'message channels'],
  port: ['connects on', 'port', 'ports'],
  fork: PROGRAMS,
  spawn: PROGRAMS,
  worker: ['starts', 'worker', 'workers'],
  'http-out': ['calls', 'web address', 'web addresses'],
  'http-listen': ['serves', 'web route', 'web routes'],
  mcp: ['uses', 'tool', 'tools'],
  watch: ['watches', 'path', 'paths'],
}
const phraseOf = (item: string): Phrase | undefined => {
  const kind = item.slice(0, item.indexOf(' '))
  return Object.prototype.hasOwnProperty.call(PHRASES, kind) ? PHRASES[kind] : undefined
}

/**
 * The identifiers a code-written label lists ("env A", "ipc b", ...), or null when the label is
 * anything else (a model's own words, or "imports").
 */
export function edgeItems(label: string): string[] | null {
  const items = label.split(', ')
  return items.every((i) => i.indexOf(' ') > 0 && phraseOf(i) !== undefined) ? items : null
}

/** `text` on one line, at most `max` characters: a longer one is cut at a word where it can be and ends in an ellipsis. */
export function capText(text: string, max = MAX_EDGE_TEXT): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…'
}

/**
 * The words a line shows: for a code-written label, what the busiest kind of crossing does and how
 * many ("reads 6 settings"), with the count of the rest ("+2 more"); any other label as it is. Never
 * longer than MAX_EDGE_TEXT.
 */
export function edgeSummary(label: string): string {
  const items = edgeItems(label)
  if (!items) return capText(label)
  const [[p, n], ...rest] = countKinds(items)
  const others = rest.reduce((s, [, k]) => s + k, 0)
  const head = phrase(p, n)
  return capText(others > 0 ? `${head} +${others} more` : head)
}

/** How many of a code-written label's identifiers each kind of crossing has, busiest first; a tie keeps the order the
 *  label lists them in (the sort is stable). */
function countKinds(items: string[]): [Phrase, number][] {
  const count = new Map<Phrase, number>()
  for (const i of items) {
    const p = phraseOf(i) as Phrase
    count.set(p, (count.get(p) ?? 0) + 1)
  }
  return [...count].sort((a, b) => b[1] - a[1])
}

const phrase = (p: Phrase, n: number): string => `${p[0]} ${n} ${n === 1 ? p[1] : p[2]}`

/** What every kind of crossing among `items` (from edgeItems) does, busiest first and uncut: ["uses 3 message
 *  channels", "reads 2 settings"]. */
export const edgeActions = (items: string[]): string[] => countKinds(items).map(([p, n]) => phrase(p, n))

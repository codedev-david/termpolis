/**
 * The ANSI subset the agent CLIs actually emit, turned into styled runs.
 *
 * Deliberately not an emulator. A phone view is a scrollback, not a grid: there
 * is no cursor to move and no cell to erase, so every sequence that addresses
 * one is DROPPED rather than approximated. A half-implemented cursor move
 * corrupts text in a way that dropping never does.
 */

export interface Segment {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

/** The xterm palette, in the shades Termpolis already renders on the desktop, so
 *  the same output does not read as two different colours on two screens. */
const PALETTE = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]

const CUBE_STEPS = [0, 95, 135, 175, 215, 255]

function hex(n: number): string {
  return n.toString(16).padStart(2, '0')
}

function rgb(r: number, g: number, b: number): string {
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** One of the 256 indexed colours, or null if the index is not one. */
function indexedColor(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null
  if (n < 16) return PALETTE[n] ?? null
  if (n < 232) {
    const c = n - 16
    const r = CUBE_STEPS[Math.floor(c / 36) % 6] as number
    const g = CUBE_STEPS[Math.floor(c / 6) % 6] as number
    const b = CUBE_STEPS[c % 6] as number
    return rgb(r, g, b)
  }
  const level = 8 + (n - 232) * 10
  return rgb(level, level, level)
}

interface Style {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

function styleKey(s: Style): string {
  return `${s.fg ?? ''}|${s.bg ?? ''}|${s.bold ? 1 : 0}${s.dim ? 1 : 0}${s.italic ? 1 : 0}${s.underline ? 1 : 0}`
}

function segmentOf(text: string, s: Style): Segment {
  const seg: Segment = { text }
  if (s.fg !== undefined) seg.fg = s.fg
  if (s.bg !== undefined) seg.bg = s.bg
  if (s.bold === true) seg.bold = true
  if (s.dim === true) seg.dim = true
  if (s.italic === true) seg.italic = true
  if (s.underline === true) seg.underline = true
  return seg
}

/** Apply one `ESC[…m`. Unknown parameters run off rather than aborting the
 *  sequence -- an agent that emits 53 (overline) must not lose the 31 after it. */
function applySgr(style: Style, params: number[]): void {
  if (params.length === 0) params = [0]
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i] as number
    if (p === 0) {
      delete style.fg
      delete style.bg
      delete style.bold
      delete style.dim
      delete style.italic
      delete style.underline
    } else if (p === 1) style.bold = true
    else if (p === 2) style.dim = true
    else if (p === 3) style.italic = true
    else if (p === 4) style.underline = true
    // 22 clears bold AND dim: they are one intensity attribute, and clearing
    // only bold leaves dim text nothing will ever turn off.
    else if (p === 22) {
      delete style.bold
      delete style.dim
    } else if (p === 23) delete style.italic
    else if (p === 24) delete style.underline
    else if (p >= 30 && p <= 37) style.fg = PALETTE[p - 30] as string
    else if (p === 39) delete style.fg
    else if (p >= 40 && p <= 47) style.bg = PALETTE[p - 40] as string
    else if (p === 49) delete style.bg
    else if (p >= 90 && p <= 97) style.fg = PALETTE[p - 90 + 8] as string
    else if (p >= 100 && p <= 107) style.bg = PALETTE[p - 100 + 8] as string
    else if (p === 38 || p === 48) {
      const mode = params[i + 1]
      let color: string | null = null
      if (mode === 5 && i + 2 < params.length) {
        color = indexedColor(params[i + 2] as number)
        i += 2
      } else if (mode === 2 && i + 4 < params.length) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]] as number[]
        const inRange = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= 255
        if (inRange(r as number) && inRange(g as number) && inRange(b as number)) {
          color = rgb(r as number, g as number, b as number)
        }
        i += 4
      } else {
        // A truncated 38/48 has eaten the rest of the sequence either way.
        i = params.length
      }
      if (color === null) {
        if (p === 38) delete style.fg
        else delete style.bg
      } else if (p === 38) style.fg = color
      else style.bg = color
    }
  }
}

const ESC = '\u001b'

export function renderAnsi(input: string): Segment[] {
  const segments: Segment[] = []
  const style: Style = {}
  // Pushed as pieces and joined once. Appending to a string per character is
  // what makes a naive renderer quadratic on a megabyte of scrollback.
  let pending: string[] = []
  // The style the pending pieces were written under, which is not necessarily
  // the current one by the time they are flushed.
  let pendingKey = styleKey(style)
  let lastKey: string | null = null

  function flush(): void {
    if (pending.length === 0) return
    const text = pending.join('')
    pending = []
    const last = segments[segments.length - 1]
    // A run whose style never actually changed extends the one before it rather
    // than becoming a second Text node the view lays out separately.
    if (last !== undefined && lastKey === pendingKey) {
      last.text += text
      return
    }
    segments.push(segmentOf(text, style))
    lastKey = pendingKey
  }

  let i = 0
  while (i < input.length) {
    const ch = input[i] as string

    if (ch !== ESC) {
      i += 1
      if (ch === '\r') {
        // CRLF and a bare CR both become one newline: a PTY writes the first and
        // an agent rewriting its status line writes the second, and either left
        // alone renders as a stray glyph.
        if (input[i] === '\n') i += 1
        pending.push('\n')
      } else if (ch === '\b' || ch === '\u0007') {
        // Nothing to back over in a scrollback, and a bell is not text.
      } else {
        pending.push(ch)
      }
      continue
    }

    const next = input[i + 1]
    // A lone ESC at the very end is a sequence split across two relay frames.
    // Its tail arrives next; emitting anything now would leave it in the
    // scrollback forever.
    if (next === undefined) break

    if (next === '[') {
      const seq = readCsi(input, i)
      if (seq === null) break
      if (seq.final === 'm') {
        flush()
        applySgr(style, parseParams(seq.params))
        pendingKey = styleKey(style)
      }
      // Every other CSI -- cursor, erase, scroll region, private modes -- is
      // dropped. See the note at the top of this file.
      i = seq.next
      continue
    }

    if (next === ']') {
      const end = readOsc(input, i)
      // Unterminated: dropped rather than dumping its payload as text. An OSC 8
      // hyperlink cut mid-frame would otherwise paint a URL into the scrollback.
      if (end === null) break
      i = end
      continue
    }

    // ESC ( B and friends select a charset; ESC M, ESC =, ESC 7 and the rest are
    // single-character controls. Both take their argument with them.
    if (next === '(' || next === ')' || next === '*' || next === '+') {
      i += input[i + 2] === undefined ? 2 : 3
      continue
    }
    i += 2
  }

  flush()
  return segments
}

interface Csi {
  params: string
  final: string
  next: number
}

/** Read `ESC [ params final`, or null if the sequence is cut short. */
function readCsi(input: string, start: number): Csi | null {
  let i = start + 2
  while (i < input.length) {
    const code = input.charCodeAt(i)
    // Parameter and intermediate bytes: 0x30-0x3f then 0x20-0x2f.
    if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
      i += 1
      continue
    }
    return { params: input.slice(start + 2, i), final: input[i] as string, next: i + 1 }
  }
  return null
}

/** Index just past an OSC's terminator (BEL or ESC \), or null if unterminated. */
function readOsc(input: string, start: number): number | null {
  for (let i = start + 2; i < input.length; i += 1) {
    if (input[i] === '\u0007') return i + 1
    if (input[i] === ESC && input[i + 1] === '\\') return i + 2
  }
  return null
}

function parseParams(raw: string): number[] {
  // Private-mode CSIs (`?25h`) never reach here -- only `m` does -- so a leading
  // '?' would be a malformed SGR, and NaN drops through applySgr untouched.
  if (raw.length === 0) return []
  return raw.split(';').map((p) => (p.length === 0 ? 0 : Number.parseInt(p, 10)))
}

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// A11Y Y9: every text colour the Lumopolis pane writes in meets WCAG AA on the pane's darkest surfaces (the pane
// #1e1e1e, a dialog or card #252526): 4.5:1 for text. A colour used only for an icon (the mic while it listens, the
// export step's spinner) is a part of the interface, and needs 3:1.

const DIR = path.resolve(__dirname, '../../../src/renderer/src/components/World')
const SURFACES = ['#1e1e1e', '#252526']

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Every `text-[#rrggbb]` in the pane's components, with the line it is on. */
function uses(): { file: string; line: string; colour: string }[] {
  const out: { file: string; line: string; colour: string }[] = []
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.tsx'))) {
    for (const line of fs.readFileSync(path.join(DIR, file), 'utf8').split('\n')) {
      for (const m of line.matchAll(/(?<![\w:-])text-\[(#[0-9a-fA-F]{6})\]/g)) out.push({ file, line: line.trim(), colour: m[1].toLowerCase() })
    }
  }
  return out
}
/** An icon's colour: on a Font Awesome glyph, or the mic's while it listens. */
const icon = (line: string): boolean => /\bfa-(?!spin\b)[a-z-]+/.test(line) || /voice\.listening|mic\.status === 'listening'/.test(line)

describe('Lumopolis text contrast (A11Y Y9)', () => {
  it('measures as WCAG does', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#6b7280', '#252526')).toBeLessThan(4.5)
  })

  it('every text colour in the pane reads at 4.5:1, an icon at 3:1, on its darkest surfaces', () => {
    const found = uses()
    expect(found.length).toBeGreaterThan(50)
    const short = found.filter(({ line, colour }) => SURFACES.some((bg) => contrast(colour, bg) < (icon(line) ? 3 : 4.5)))
    expect(short.map(({ file, colour }) => `${file} ${colour}`)).toEqual([])
  })

  it('an error the pane reads out is in the lighter red', () => {
    const errors = uses().filter(({ line }) => line.includes('role="alert"'))
    expect(errors.length).toBeGreaterThan(10)
    expect(errors.filter(({ colour }) => colour === '#f14c4c')).toEqual([])
  })
})

describe('Lumopolis icons (A11Y Y10)', () => {
  it('every Font Awesome glyph in the pane is hidden from a screen reader: the control around it carries the name', () => {
    const icons: string[] = []
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.tsx'))) {
      for (const m of fs.readFileSync(path.join(DIR, file), 'utf8').matchAll(/<i\b[^>]*>/g)) icons.push(`${file}: ${m[0]}`)
    }
    expect(icons.length).toBeGreaterThan(10)
    expect(icons.filter((i) => !i.includes('aria-hidden="true"'))).toEqual([])
  })
})

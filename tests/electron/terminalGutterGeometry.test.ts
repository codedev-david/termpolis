import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// GUARD (v1.32.4 "the terminal paints over the scrollbar"). Two independent facts about xterm.js
// make the right-hand gutter fragile, and BOTH have to hold or the last text column lands on top
// of the scrollbar and the bar looks clipped:
//
//   1. FitAddon reserves only `options.overviewRuler?.width || 14`px on the right for the bar, so
//      the CSS scrollbar width must not exceed 14 + the terminal element's own padding-right.
//   2. FitAddon derives the grid from `getComputedStyle(element.parentElement).width`. With
//      `box-sizing: border-box` (set globally in index.css) that resolves to the parent's BORDER
//      box, so padding on the CONTAINER is silently counted as usable grid space. The inset must
//      therefore live on `.xterm` itself — the one element FitAddon subtracts padding from.
//
// `.xterm-screen` is a later sibling than `.xterm-viewport`, so it wins the paint order and any
// overflow is drawn straight over the native scrollbar. Nothing in jsdom can catch that (there is
// no layout), and the e2e specs only click inside the screen box — hence this source-level guard.
describe('terminal right-hand gutter geometry', () => {
  const root = path.resolve(__dirname, '..', '..')
  const css = fs.readFileSync(path.join(root, 'src/renderer/src/index.css'), 'utf8')
  const pane = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/TerminalPane/TerminalPane.tsx'),
    'utf8'
  )

  /** FitAddon's hard-coded right-hand reserve when `overviewRuler` is unset. */
  const FIT_ADDON_RESERVE = 14

  function ruleBody(selector: string): string {
    const at = css.indexOf(selector + ' {')
    expect(at, `index.css must style ${selector}`).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }

  it('reserves at least the scrollbar width via .xterm padding-right', () => {
    const shorthand = /padding:\s*([^;]+);/.exec(ruleBody('.xterm'))
    expect(shorthand, '.xterm must declare padding').toBeTruthy()
    const parts = shorthand![1].trim().split(/\s+/).map(v => parseFloat(v))
    // CSS shorthand: 1 value = all sides, 2 = block/inline, 3+ = top right bottom left.
    const paddingRight = parts.length === 1 ? parts[0] : parts[1]
    expect(Number.isFinite(paddingRight)).toBe(true)

    const width = /width:\s*(\d+(?:\.\d+)?)px/.exec(
      ruleBody('.xterm .xterm-viewport::-webkit-scrollbar')
    )
    expect(width, 'the terminal scrollbar must declare an explicit width').toBeTruthy()
    const scrollbarWidth = parseFloat(width![1])

    // The rows stop at padding-right + 14 from the viewport's right edge; the bar starts at
    // scrollbarWidth. Anything less and they overlap.
    expect(paddingRight + FIT_ADDON_RESERVE).toBeGreaterThanOrEqual(scrollbarWidth)
  })

  it('keeps the TerminalPane container padding-free', () => {
    const at = pane.indexOf('ref={containerRef}')
    expect(at, 'TerminalPane must still mount xterm into containerRef').toBeGreaterThan(0)
    const tagStart = pane.lastIndexOf('<div', at)
    const tagEnd = pane.indexOf('\n      >', at)
    expect(tagStart).toBeGreaterThan(0)
    expect(tagEnd).toBeGreaterThan(at)
    // Padding here would be double-counted as grid space (see the note above) — put it on `.xterm`.
    expect(pane.slice(tagStart, tagEnd)).not.toMatch(/padding/)
  })
})

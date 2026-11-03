import { describe, it, expect } from 'vitest'
import { paneRootStyle } from '../../src/renderer/src/lib/paneHiding'

// The style an inactive pane gets (1.54.5, plan package P9). The effect on rendering is proven in real Chromium by
// e2e/terminal-hidden-render.spec.ts and by the harness numbers in paneHiding.ts; here: what the style IS, and that the
// kill switch gives back exactly the 1.54.4 one.

describe('paneRootStyle', () => {
  it('a pane on screen is visible, with nothing that could skip its rendering', () => {
    expect(paneRootStyle(true, true)).toEqual({ visibility: 'visible' })
    expect(paneRootStyle(true, false)).toEqual({ visibility: 'visible' })
  })

  it('an inactive pane is hidden AND has its rendering skipped (its box is kept: nothing but contentVisibility is added)', () => {
    expect(paneRootStyle(false, true)).toEqual({ visibility: 'hidden', contentVisibility: 'hidden' })
  })

  it('NEGATIVE CONTROL: with the kill switch an inactive pane has only visibility: hidden, the 1.54.4 style', () => {
    const style = paneRootStyle(false, false)
    expect(style).toEqual({ visibility: 'hidden' })
    expect('contentVisibility' in style).toBe(false)
  })

  it('never takes the pane out of layout: no display, position, size or transform property is ever set', () => {
    for (const visible of [true, false]) {
      for (const skip of [true, false]) {
        const keys = Object.keys(paneRootStyle(visible, skip))
        for (const forbidden of ['display', 'position', 'width', 'height', 'transform', 'top', 'left', 'opacity']) {
          expect(keys).not.toContain(forbidden)
        }
      }
    }
  })
})

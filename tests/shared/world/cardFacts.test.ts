import { describe, expect, it } from 'vitest'
import { CARD_HEADINGS, serviceNames, serviceNamesLine } from '../../../src/shared/world/cardFacts'
import { escapeHtml } from '../../../src/shared/world/html'
import { escapeHtml as engineEscape } from '../../../src/renderer/src/world/engine/html'
import { minimal } from '../../renderer/world/helpers'

describe('serviceNames', () => {
  it('gives the raw names and whether a person set them', () => {
    const doc = minimal()
    expect(serviceNames(doc, 'b1')).toEqual({ names: [], handSet: false })
    doc.runtimeNames.b1 = ['a', 'b']
    doc.runtimeHandSet = ['b1']
    expect(serviceNames(doc, 'b1')).toEqual({ names: ['a', 'b'], handSet: true })
    delete doc.runtimeHandSet
    expect(serviceNames(doc, 'b1').handSet).toBe(false)
  })
})

describe('serviceNamesLine', () => {
  it('is null with no names, the names when there are some, and says when a person edited them', () => {
    const doc = minimal()
    expect(serviceNamesLine(doc, 'b1')).toBeNull()
    doc.runtimeNames.b1 = ['a', 'b']
    expect(serviceNamesLine(doc, 'b1')).toBe('a, b')
    doc.runtimeHandSet = ['b1']
    expect(serviceNamesLine(doc, 'b1')).toBe('a, b (edited by you)')
    delete doc.runtimeHandSet
    expect(serviceNamesLine(doc, 'b1')).toBe('a, b')
  })
})

describe('CARD_HEADINGS and escapeHtml', () => {
  it('keeps the agreed wording', () => {
    expect(CARD_HEADINGS.whyDone).toBe("Why it's done this way")
    expect(Object.keys(CARD_HEADINGS)).toHaveLength(18)
  })
  it('escapes in one place, re-exported by the engine', () => {
    expect(engineEscape).toBe(escapeHtml)
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(escapeHtml(null)).toBe('')
  })
})

// The exported page's meta block (src/shared/world/exportMeta.ts): written by the export in main, checked by the
// page's runtime. Whatever the writer builds must pass the reader's check, for every kind of world.
import { describe, expect, it } from 'vitest'
import { isMeta, pageMeta } from '../../../src/shared/world/exportMeta'
import { designWorld, labelledWorld, linkedDesignWorld } from '../../fixtures/world/docWorlds'

const ON = '2026-11-21'

describe('pageMeta', () => {
  it('a code world: the title as the project, seven characters of the commit, the dirty flag', () => {
    const doc = labelledWorld()
    doc.sourceRevision = { head: '0123456789abcdef', dirty: true }
    doc.projectKey = 'a3f9c2e1'
    const m = pageMeta(doc, { title: 'Shop', exportedOn: ON })
    expect(m).toEqual({ project: 'Shop', exportedOn: ON, head7: '0123456', dirty: true })
    expect(isMeta(m)).toBe(true)
  })

  it('a design world without git: an empty head7, still a string, and not dirty', () => {
    const m = pageMeta(designWorld(), { title: 'Shop design', exportedOn: ON })
    expect(m).toEqual({ project: 'Shop design', exportedOn: ON, head7: '', dirty: false })
    expect(isMeta(m)).toBe(true)
  })

  it('a single proposal: proposalId is set; without one it is left out, never null', () => {
    const one = pageMeta(linkedDesignWorld(), { title: 'Shop', exportedOn: ON, proposalId: 'p1' })
    expect(one.proposalId).toBe('p1')
    expect(isMeta(one)).toBe(true)
    const whole = pageMeta(linkedDesignWorld(), { title: 'Shop', exportedOn: ON })
    expect('proposalId' in whole).toBe(false)
    expect(JSON.parse(JSON.stringify(whole))).toEqual(whole)
  })

  it('git missing on a code folder: head7 is empty and a dirty flag that is not true is false', () => {
    const doc = labelledWorld()
    doc.sourceRevision = { head: '', dirty: false }
    const m = pageMeta(doc, { title: 'Shop', exportedOn: ON })
    expect(m.head7).toBe('')
    expect(m.dirty).toBe(false)
    expect(isMeta(m)).toBe(true)
  })
})

describe('isMeta', () => {
  const good = { project: 'Shop', exportedOn: ON, head7: 'abc1234', dirty: false }

  it('accepts the meta the export writes, with or without a proposal', () => {
    expect(isMeta(good)).toBe(true)
    expect(isMeta({ ...good, proposalId: 'p1' })).toBe(true)
  })

  it('refuses anything else: not an object, a missing or mistyped field, a null proposal', () => {
    for (const bad of [null, 'meta', 3, { ...good, dirty: 'yes' }, { ...good, head7: null }, { ...good, proposalId: null }, { project: 'Shop' }]) {
      expect(isMeta(bad)).toBe(false)
    }
  })
})

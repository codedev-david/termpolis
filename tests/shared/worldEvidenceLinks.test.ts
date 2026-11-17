import { describe, it, expect } from 'vitest'
import { itemsForEvidence } from '../../src/shared/world/evidenceLinks'
import type { Claim, WorldDoc } from '../../src/shared/world/types'
import minDoc from './fixtures/world.min.json'

const base = minDoc as unknown as WorldDoc
const claim = (ref: string): Claim => ({ text: 't', state: 'observed', evidence: [{ kind: 'file', ref }] })

describe('itemsForEvidence', () => {
  it('a file ref maps to the building holding that file, and a line or symbol suffix is ignored', () => {
    expect(itemsForEvidence(base, { kind: 'file', ref: 'src/main/index.ts' })).toEqual(['b1'])
    expect(itemsForEvidence(base, { kind: 'file', ref: 'src/main/index.ts:12' })).toEqual(['b1'])
    expect(itemsForEvidence(base, { kind: 'symbol', ref: 'src/main/memory/store.ts#open' })).toEqual(['b2'])
  })

  it('a claim ref maps to the buildings whose claims cite it and to its edge', () => {
    // client.ts is no building's member: b1 cites it in a claim, and e1 cites it in its how.
    const doc: WorldDoc = {
      ...base,
      buildings: base.buildings.map((b) => (b.id === 'b1' ? { ...b, claims: [claim('src/main/memory/client.ts')] } : b)),
    }
    expect(itemsForEvidence(doc, { kind: 'file', ref: 'src/main/memory/client.ts' })).toEqual(['b1', 'e1'])
  })

  it('an edge claim and a building why also cite a ref; an unknown ref maps to nothing', () => {
    const doc: WorldDoc = {
      ...base,
      buildings: base.buildings.map((b) => (b.id === 'b2' ? { ...b, why: [claim('docs/why.md')] } : b)),
      edges: base.edges.map((e) => ({ ...e, claims: [claim('docs/edge.md')] })),
    }
    expect(itemsForEvidence(doc, { kind: 'file', ref: 'docs/why.md' })).toEqual(['b2'])
    expect(itemsForEvidence(doc, { kind: 'file', ref: 'docs/edge.md' })).toEqual(['e1'])
    expect(itemsForEvidence(doc, { kind: 'commit', ref: 'abc123' })).toEqual([])
  })
})

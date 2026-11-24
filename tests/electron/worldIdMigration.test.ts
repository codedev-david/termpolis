import { describe, expect, it } from 'vitest'
import type { Building, Claim, District, External, Proposal, WorldDoc, WorldEdge } from '../../src/shared/world/types'
import { edgeId, type Grouping } from '../../src/main/world/group'
import { idRenames, renameClaims, renameDoc } from '../../src/main/world/idMigration'

const orbKey = (x: Pick<External, 'kind' | 'name'>): string => `${x.kind}\0${x.name}`
const B = (id: string, districtId: string, members: string[]): Building => ({ id, districtId, members }) as unknown as Building
const D = (id: string, members: string[]): District => ({ id, members }) as unknown as District
const X = (id: string, name: string, kind: External['kind'] = 'service'): External => ({ id, name, kind, fog: false })
const E = (from: string, to: string, label = ''): WorldEdge => ({ id: edgeId({ from, to }), from, to, label }) as unknown as WorldEdge

function doc(parts: { buildings?: Building[]; districts?: District[]; edges?: WorldEdge[]; externals?: External[] } = {}): WorldDoc {
  return {
    version: 1,
    projectKey: 'k',
    generatedAt: 1,
    sourceRevision: { head: '', dirty: false },
    districts: parts.districts ?? [],
    buildings: parts.buildings ?? [],
    edges: parts.edges ?? [],
    externals: parts.externals ?? [],
    glossary: {},
    cargo: {},
    processes: {},
    tours: [],
    layout: { seed: 1, positions: {} },
    runtimeNames: {},
    layers: { plan: [] }
  } as WorldDoc
}

function grouping(buildings: { id: string; districtId: string; members: string[] }[], edges: { from: string; to: string }[] = []): Grouping {
  const ds = [...new Set(buildings.map((b) => b.districtId))]
  return {
    districts: ds.map((id) => ({ id, name: id, members: buildings.filter((b) => b.districtId === id).map((b) => b.id) })),
    buildings: buildings.map((b) => ({ ...b, name: b.id, process: '', boundaries: [] })) as unknown as Grouping['buildings'],
    edges: edges.map((e) => ({ ...e, via: [] })) as unknown as Grouping['edges']
  }
}
const noExt = { externals: [], edges: [] }

describe('idRenames', () => {
  it('moves a building and a district with the same files from an old-rule id to the new one', () => {
    const prev = doc({
      districts: [D('d-root', ['b-root']), D('d-src-a-b', ['b-src-a-b'])],
      buildings: [B('b-root', 'd-root', ['🚀.ts']), B('b-src-a-b', 'd-src-a-b', ['src/a-b/y.ts'])]
    })
    const g = grouping([
      { id: 'b-u123abc', districtId: 'd-root', members: ['🚀.ts'] },
      { id: 'b-src-a-b', districtId: 'd-src-a-b--afd7a8', members: ['src/a-b/y.ts'] }
    ])
    expect(Object.fromEntries(idRenames(prev, g, noExt, orbKey))).toEqual({ 'b-root': 'b-u123abc', 'd-src-a-b': 'd-src-a-b--afd7a8' })
  })

  it('moves an id between collision forms both ways, and leaves a part whose plain name changed with the same files', () => {
    const prev = doc({
      buildings: [B('b-src-q--x-2', 'd', ['q/b/x.ts']), B('b-src-main--a', 'd', ['m/a.ts']), B('b-old-name', 'd', ['n.ts'])]
    })
    const g = grouping([
      { id: 'b-src-q--x--0a1b2c', districtId: 'd', members: ['q/b/x.ts'] },
      { id: 'b-src-main', districtId: 'd', members: ['m/a.ts'] },
      { id: 'b-new-name', districtId: 'd', members: ['n.ts'] }
    ])
    expect(Object.fromEntries(idRenames(prev, g, noExt, orbKey))).toEqual({ 'b-src-q--x-2': 'b-src-q--x--0a1b2c', 'b-src-main--a': 'b-src-main' })
  })

  it('pairs nothing when two vanished or two new parts share a key, or a vanished part has no match', () => {
    const prev = doc({ buildings: [B('b-root', 'd', ['a.ts']), B('b-root-2', 'd', ['a.ts']), B('b-gone-2', 'd', ['gone.ts']), B('b-x-2', 'd', ['x.ts'])] })
    const g = grouping([
      { id: 'b-u111111', districtId: 'd', members: ['a.ts'] },
      { id: 'b-x--aaaaaa', districtId: 'd', members: ['x.ts'] },
      { id: 'b-x--bbbbbb', districtId: 'd', members: ['x.ts'] }
    ])
    expect(idRenames(prev, g, noExt, orbKey).size).toBe(0)
  })

  it('moves an orb by kind and host, its lines by their ends, and a line to a split orb by its label', () => {
    const prev = doc({
      buildings: [B('b-a', 'd', ['a.ts']), B('b-z', 'd', ['z.ts']), B('b-k', 'd', ['k.ts'])],
      externals: [X('x-api-foo-com', 'api.foo.com'), X('x-claude', 'claude', 'agent'), X('x-', 'xn--wgv71a.jp')],
      edges: [
        E('b-a', 'x-api-foo-com', 'http-out api.foo.com'),
        E('b-z', 'x-api-foo-com', 'http-out api-foo.com'),
        E('b-z', 'x-claude', 'spawn claude'),
        E('b-k', 'x-', 'http-out xn--wgv71a.jp'),
        E('b-a', 'b-z'),
        E('b-k', 'x-api-foo-com', 'http-out nowhere.com')
      ]
    })
    const g = grouping(
      [
        { id: 'b-a', districtId: 'd', members: ['a.ts'] },
        { id: 'b-z', districtId: 'd', members: ['z.ts'] },
        { id: 'b-k', districtId: 'd', members: ['k.ts'] }
      ],
      [{ from: 'b-a', to: 'b-z' }]
    )
    const ext = {
      externals: [X('x-api-foo-com--aaaaaa', 'api.foo.com'), X('x-api-foo-com--bbbbbb', 'api-foo.com'), X('x-claude', 'claude', 'agent'), X('x-xn-wgv71a-jp', 'xn--wgv71a.jp')],
      edges: [
        E('b-a', 'x-api-foo-com--aaaaaa', 'http-out api.foo.com'),
        E('b-z', 'x-api-foo-com--bbbbbb', 'http-out api-foo.com'),
        E('b-z', 'x-claude', 'spawn claude'),
        E('b-k', 'x-xn-wgv71a-jp', 'http-out xn--wgv71a.jp')
      ]
    }
    expect(Object.fromEntries(idRenames(prev, g, ext, orbKey))).toEqual({
      'x-api-foo-com': 'x-api-foo-com--aaaaaa',
      'x-': 'x-xn-wgv71a-jp',
      [edgeId({ from: 'b-a', to: 'x-api-foo-com' })]: edgeId({ from: 'b-a', to: 'x-api-foo-com--aaaaaa' }),
      [edgeId({ from: 'b-z', to: 'x-api-foo-com' })]: edgeId({ from: 'b-z', to: 'x-api-foo-com--bbbbbb' }),
      [edgeId({ from: 'b-k', to: 'x-' })]: edgeId({ from: 'b-k', to: 'x-xn-wgv71a-jp' })
    })
  })

  it('does not move a line onto one the old doc already had', () => {
    const prev = doc({
      buildings: [B('b-root', 'd', ['a.ts']), B('b-q', 'd', ['q.ts'])],
      edges: [E('b-root', 'b-q'), E('b-u222222', 'b-q')]
    })
    const g = grouping(
      [
        { id: 'b-u222222', districtId: 'd', members: ['a.ts'] },
        { id: 'b-q', districtId: 'd', members: ['q.ts'] }
      ],
      [{ from: 'b-u222222', to: 'b-q' }]
    )
    expect(Object.fromEntries(idRenames(prev, g, noExt, orbKey))).toEqual({ 'b-root': 'b-u222222' })
  })
})

describe('renameDoc', () => {
  const map = new Map([
    ['b-root', 'b-u1'],
    ['d-root', 'd-u1'],
    ['x-', 'x-n'],
    ['e-b-root--x-', 'e-b-u1--x-n']
  ])

  it('returns the doc itself for an empty map', () => {
    const d = doc()
    expect(renameDoc(d, new Map())).toBe(d)
  })

  it('renames parts, ends, positions, service names, hand-set ids and a design reconcile and removes', () => {
    const linked: Proposal = {
      id: 'design:1',
      title: '',
      summary: [],
      buildings: [],
      edges: [],
      reconcile: { matched: { 'p-a': 'b-root', 'p-b': 'b-other' }, missing: ['p-c'], extra: ['b-root'], changed: ['b-root'], planAt: 1 },
      removes: ['b-root']
    }
    const plain: Proposal = { id: 'p2', title: '', summary: [], buildings: [], edges: [] }
    const d = {
      ...doc({
        districts: [D('d-root', ['b-root', 'b-other'])],
        buildings: [B('b-root', 'd-root', ['a.ts']), B('b-other', 'd-root', ['o.ts'])],
        externals: [X('x-', 'h')],
        edges: [E('b-root', 'x-')]
      }),
      layout: { seed: 1, positions: { 'b-root': [1, 0, 1], 'x-': [2, 12, 2], 'b-other': [3, 0, 3] } },
      runtimeNames: { 'b-root': ['svc'] },
      runtimeHandSet: ['b-root'],
      layers: { plan: [linked, plain] }
    } as WorldDoc
    const out = renameDoc(d, map)
    expect(out.districts).toEqual([{ id: 'd-u1', members: ['b-u1', 'b-other'] }])
    expect(out.buildings.map((b) => [b.id, b.districtId])).toEqual([['b-u1', 'd-u1'], ['b-other', 'd-u1']])
    expect(out.externals).toEqual([X('x-n', 'h')])
    expect(out.edges.map((e) => [e.id, e.from, e.to])).toEqual([['e-b-u1--x-n', 'b-u1', 'x-n']])
    expect(out.layout.positions).toEqual({ 'b-u1': [1, 0, 1], 'x-n': [2, 12, 2], 'b-other': [3, 0, 3] })
    expect(out.runtimeNames).toEqual({ 'b-u1': ['svc'] })
    expect(out.runtimeHandSet).toEqual(['b-u1'])
    expect(out.layers.plan[0]).toMatchObject({
      reconcile: { matched: { 'p-a': 'b-u1', 'p-b': 'b-other' }, missing: ['p-c'], extra: ['b-u1'], changed: ['b-u1'], planAt: 1 },
      removes: ['b-u1']
    })
    expect(out.layers.plan[1]).toEqual(plain)
    // The input is left as it was.
    expect(d.buildings[0].id).toBe('b-root')
  })

  it('leaves a doc with no hand-set ids without them', () => {
    const out = renameDoc(doc({ buildings: [B('b-root', 'd', ['a.ts'])] }), map)
    expect(out).not.toHaveProperty('runtimeHandSet')
    expect(out.buildings[0].id).toBe('b-u1')
  })
})

describe('renameClaims', () => {
  const c = (text: string): Claim => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'me' }] })

  it('returns the annotations themselves when the map names none of their ids', () => {
    const byItem = { 'b-a': [c('one')] }
    expect(renameClaims(byItem, new Map([['b-z', 'b-y']]))).toBe(byItem)
  })

  it('moves a renamed item after what its new id has, keeping a claim held under both once', () => {
    const out = renameClaims(
      { 'b-root': [c('old'), c('both')], 'b-u1': [c('both')], 'b-k': [c('kept')], 'b-x-2': [c('alone')] },
      new Map([['b-root', 'b-u1'], ['b-x-2', 'b-x--abcdef']])
    )
    expect({ ...out }).toEqual({ 'b-u1': [c('both'), c('old')], 'b-k': [c('kept')], 'b-x--abcdef': [c('alone')] })
  })
})

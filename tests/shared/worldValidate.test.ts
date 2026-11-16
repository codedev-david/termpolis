import { describe, it, expect } from 'vitest'
import { validateWorld } from '../../src/shared/world/validate'
import minDoc from './fixtures/world.min.json'

type Any = any
const fresh = (): Any => JSON.parse(JSON.stringify(minDoc))
const errorsOf = (doc: unknown): string[] => {
  const r = validateWorld(doc)
  if (r.ok) throw new Error('expected failure')
  return r.errors
}
const claim = (): Any => ({ text: 't', state: 'observed', evidence: [{ kind: 'file', ref: 'a/b.ts' }] })

describe('validateWorld', () => {
  it('accepts the minimal fixture', () => {
    const r = validateWorld(fresh())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.buildings).toHaveLength(2)
  })

  it('rejects non-objects', () => {
    for (const v of [null, undefined, 5, 'x', [], true]) expect(validateWorld(v).ok).toBe(false)
    expect(errorsOf(null)[0]).toMatch(/object/)
  })

  it('rejects wrong version and malformed top-level fields', () => {
    const d = fresh()
    d.version = 2
    d.projectKey = 3
    d.generatedAt = 'x'
    d.sourceRevision = { head: 1, dirty: 'no' }
    d.districts = {}
    d.buildings = 'x'
    d.edges = null
    d.externals = 1
    d.glossary = []
    d.cargo = null
    d.processes = []
    d.tours = {}
    d.layout = { seed: 'a', positions: [] }
    d.runtimeNames = 5
    d.layers = 5
    const e = errorsOf(d)
    for (const k of ['version must be 1', 'projectKey must be a string', 'generatedAt must be a number',
      'sourceRevision must be { head: string, dirty: boolean }', 'districts must be an array', 'buildings must be an array',
      'edges must be an array', 'externals must be an array', 'glossary must be an object', 'cargo must be an object',
      'processes must be an object', 'tours must be an array', 'layout.seed must be a number',
      'layout.positions must be an object', 'runtimeNames must be an object', 'layers must be an object']) {
      expect(e).toContain(k)
    }
  })

  it('rejects a missing sourceRevision, layout and layers', () => {
    const d = fresh()
    delete d.sourceRevision
    delete d.layout
    delete d.layers
    const e = errorsOf(d)
    expect(e).toContain('sourceRevision must be { head: string, dirty: boolean }')
    expect(e).toContain('layout must be an object')
    expect(e).toContain('layers must be an object')
  })

  it('flags dangling edge endpoints', () => {
    const d = fresh()
    d.edges[0].to = 'nope'
    d.edges[0].from = 'gone'
    const e = errorsOf(d)
    expect(e).toContain('edge e1: unknown to "nope"')
    expect(e).toContain('edge e1: unknown from "gone"')
  })

  it('accepts edges that point at externals', () => {
    const d = fresh()
    d.edges[0].to = 'x1'
    expect(validateWorld(d).ok).toBe(true)
  })

  it('flags tech ids missing from glossary', () => {
    const d = fresh()
    d.edges[0].tech = ['ghost1']
    d.buildings[0].stack = ['ghost2']
    d.buildings[0].floors[0].tech = ['ghost3']
    const e = errorsOf(d)
    expect(e).toContain('edge e1: tech "ghost1" not in glossary')
    expect(e).toContain('building b1: stack "ghost2" not in glossary')
    expect(e).toContain('building b1: floor "Window shell": tech "ghost3" not in glossary')
  })

  it('does not mistake inherited object keys for glossary entries', () => {
    const d = fresh()
    d.edges[0].tech = ['constructor']
    expect(errorsOf(d)).toContain('edge e1: tech "constructor" not in glossary')
  })

  it('flags unknown districts', () => {
    const d = fresh()
    d.buildings[0].districtId = 'zz'
    expect(errorsOf(d)).toContain('building b1: unknown districtId "zz"')
  })

  it('flags duplicate ids', () => {
    const d = fresh()
    d.buildings[1].id = 'b1'
    d.districts.push({ ...d.districts[0] })
    d.edges.push({ ...d.edges[0] })
    d.externals.push({ ...d.externals[0] })
    const e = errorsOf(d)
    expect(e).toContain('building b1: duplicate id')
    expect(e).toContain('district d1: duplicate id')
    expect(e).toContain('edge e1: duplicate id')
    expect(e).toContain('external x1: duplicate id')
  })

  it('flags buildings without a layout position', () => {
    const d = fresh()
    delete d.layout.positions.b2
    d.layout.positions.b1 = [1, 2]
    const e = errorsOf(d)
    expect(e).toContain('building b2: no layout position')
    expect(e).toContain('building b1: layout position must be [x, y, z]')
  })

  it('flags claims without evidence', () => {
    const d = fresh()
    d.buildings[0].how[0].evidence = []
    d.edges[0].why[0].evidence = []
    const e = errorsOf(d)
    expect(e).toContain('building b1: claim without evidence')
    expect(e).toContain('edge e1: claim without evidence')
  })

  it('flags malformed claims and evidence', () => {
    const d = fresh()
    d.buildings[0].how = [null, { text: 1, state: 'maybe', evidence: 'x' }]
    d.buildings[0].why = 'x'
    d.edges[0].how = [{ text: 't', state: 'observed', evidence: [null, { kind: 'bogus', ref: 3, excerpt: 4 }] }]
    const e = errorsOf(d)
    expect(e).toContain('building b1: claim is not an object')
    expect(e).toContain('building b1: claim text must be a string')
    expect(e).toContain('building b1: claim state "maybe" is invalid')
    expect(e).toContain('building b1: claim evidence must be an array')
    expect(e).toContain('building b1: why must be an array')
    expect(e).toContain('edge e1: evidence is not an object')
    expect(e).toContain('edge e1: evidence kind "bogus" is invalid')
    expect(e).toContain('edge e1: evidence ref must be a string')
    expect(e).toContain('edge e1: evidence excerpt must be a string')
  })

  it('rejects evidence refs that are absolute paths', () => {
    for (const ref of ['C:\\x', '/home/x', 'c:/x/y', '\\\\server\\share']) {
      const d = fresh()
      d.buildings[0].how[0].evidence[0].ref = ref
      expect(errorsOf(d).join('\n')).toContain('building b1: evidence ref "' + ref + '" must be repository-relative')
    }
  })

  it('rejects empty file refs but leaves other evidence kinds alone', () => {
    const d = fresh()
    d.buildings[0].how[0].evidence = [{ kind: 'file', ref: '' }]
    expect(errorsOf(d).join('\n')).toContain('must be repository-relative')
    const ok = fresh()
    ok.buildings[0].how[0].evidence = [{ kind: 'commit', ref: '/abc' }]
    expect(validateWorld(ok).ok).toBe(true)
  })

  it('flags non-object items in every list', () => {
    const d = fresh()
    d.districts = [5]
    d.buildings = [7]
    d.edges = [null]
    d.externals = [[]]
    d.tours = [1]
    d.layers = { plan: [3] }
    const e = errorsOf(d)
    for (const k of ['district', 'building', 'edge', 'external', 'tour', 'proposal']) expect(e).toContain(`${k} #0 is not an object`)
  })

  it('flags bad field types on districts, buildings, edges, externals and floors', () => {
    const d = fresh()
    d.districts[0].hue = 'red'
    d.districts[0].name = 1
    d.districts[0].subtitle = 1
    d.districts[0].members = 'x'
    d.buildings[0].name = 1
    d.buildings[0].techLabel = 1
    d.buildings[0].process = 1
    d.buildings[0].status = 'done'
    d.buildings[0].members = 1
    d.buildings[0].stack = 1
    d.buildings[0].floors = 1
    d.buildings[1].floors = [5, { name: 1, tech: 1, members: 1 }]
    d.edges[0].cargo = 1
    d.edges[0].label = 1
    d.edges[0].rate = 1
    d.edges[0].twoWay = 1
    d.edges[0].tech = 1
    d.externals[0].name = 1
    d.externals[0].kind = 'alien'
    d.externals[0].fog = 1
    const e = errorsOf(d)
    for (const k of ['district d1: hue must be a number', 'district d1: name must be a string',
      'district d1: subtitle must be a string', 'district d1: members must be an array of strings',
      'building b1: name must be a string', 'building b1: techLabel must be a string',
      'building b1: process must be a string', 'building b1: status "done" is invalid',
      'building b1: members must be an array of strings', 'building b1: stack must be an array of strings',
      'building b1: floors must be an array', 'building b2: floor #0 is not an object',
      'building b2: floor #1: name must be a string', 'building b2: floor #1: tech must be an array of strings',
      'building b2: floor #1: members must be an array of strings',
      'edge e1: cargo must be a string', 'edge e1: label must be a string', 'edge e1: rate must be a string',
      'edge e1: twoWay must be a boolean', 'edge e1: tech must be an array of strings',
      'external x1: name must be a string', 'external x1: kind "alien" is invalid', 'external x1: fog must be a boolean']) {
      expect(e).toContain(k)
    }
  })

  it('flags bad tours and steps', () => {
    const d = fresh()
    d.tours = [{ id: 1, title: 1, steps: 1 }, { id: 't2', title: 't', steps: [3, { ids: 'x', caption: 4 }] }]
    const e = errorsOf(d).join('\n')
    expect(e).toContain('tour #0: id must be a non-empty string')
    expect(e).toContain('tour #0: title must be a string')
    expect(e).toContain('tour #0: steps must be an array')
    expect(e).toContain('tour t2: step #0 is not an object')
    expect(e).toContain('tour t2: step #1: ids must be an array of strings')
    expect(e).toContain('tour t2: step #1: caption must be a string')
  })

  it('flags string-array fields with non-string entries', () => {
    const d = fresh()
    d.districts[0].members = [1]
    expect(errorsOf(d)).toContain('district d1: members must be an array of strings')
  })

  it('flags id fields that are not strings', () => {
    const d = fresh()
    d.districts[0].id = 3
    d.buildings[0].id = ''
    d.edges[0].id = 4
    d.externals[0].id = 5
    const e = errorsOf(d).join('\n')
    expect(e).toContain('district #0: id must be a non-empty string')
    expect(e).toContain('building #0: id must be a non-empty string')
    expect(e).toContain('edge #0: id must be a non-empty string')
    expect(e).toContain('external #0: id must be a non-empty string')
  })

  it('validates glossary, cargo, processes and runtimeNames shapes', () => {
    const d = fresh()
    d.glossary = { a: 1 }
    d.cargo = { c: { shape: 'cone', color: 1, label: 2 }, n: 5 }
    d.processes = { p: { label: 1, color: 2 }, q: 5 }
    d.runtimeNames = { r: 'x', s: [1] }
    const e = errorsOf(d).join('\n')
    expect(e).toContain('glossary "a" must be a string')
    expect(e).toContain('cargo "c": shape "cone" is invalid')
    expect(e).toContain('cargo "c": color must be a string')
    expect(e).toContain('cargo "c": label must be a string')
    expect(e).toContain('cargo "n" must be an object')
    expect(e).toContain('process "p": label must be a string')
    expect(e).toContain('process "p": color must be a string')
    expect(e).toContain('process "q" must be an object')
    expect(e).toContain('runtimeNames "r": value must be an array of strings')
    expect(e).toContain('runtimeNames "s": value must be an array of strings')
  })

  it('treats buildings, externals, districts and edges as one id namespace', () => {
    const d = fresh()
    d.externals[0].id = 'b1'
    d.districts[0].id = 'e1'
    d.buildings[0].districtId = 'e1'
    d.buildings[1].districtId = 'e1'
    const e = errorsOf(d)
    expect(e).toContain('external b1: duplicate id')
    expect(e).toContain('edge e1: duplicate id')
  })

  it('requires non-empty cargo and process to exist in their maps', () => {
    const d = fresh()
    d.edges[0].cargo = 'nope'
    d.buildings[0].process = 'ghost'
    const e = errorsOf(d)
    expect(e).toContain('edge e1: unknown cargo "nope"')
    expect(e).toContain('building b1: unknown process "ghost"')
    const ok = fresh()
    ok.edges[0].cargo = ''
    ok.buildings[0].process = ''
    expect(validateWorld(ok).ok).toBe(true)
  })

  it('rejects evidence refs with a parent-directory segment but not look-alikes', () => {
    for (const ref of ['../x.ts', 'a/../b.ts', 'a\\..\\b.ts', 'a/..']) {
      const d = fresh()
      d.buildings[0].how[0].evidence[0].ref = ref
      expect(errorsOf(d)).toContain('building b1: evidence ref "' + ref + '" must be repository-relative')
    }
    const ok = fresh()
    ok.buildings[0].how[0].evidence = [{ kind: 'file', ref: 'a/..b/c..d.ts' }, { kind: 'symbol', ref: 'x:foo' }]
    expect(validateWorld(ok).ok).toBe(true)
  })

  it('checks layout positions even when the seed is bad', () => {
    const d = fresh()
    d.layout.seed = 'x'
    delete d.layout.positions.b2
    const e = errorsOf(d)
    expect(e).toContain('layout.seed must be a number')
    expect(e).toContain('building b2: no layout position')
  })

  it('flags tour steps that point at unknown ids', () => {
    const d = fresh()
    d.tours = [{ id: 't1', title: 't', steps: [{ ids: ['b1', 'x1', 'd1', 'e1', 'zz'], caption: 'c' }] }]
    expect(errorsOf(d)).toEqual(['tour t1: step #0: unknown id "zz"'])
  })

  describe('plan proposals', () => {
    const proposal = (): Any => {
      const d = fresh()
      const b = JSON.parse(JSON.stringify(d.buildings[0]))
      b.id = 'p1b'
      b.status = 'proposed'
      d.layout.positions.p1b = [3, 0, 3]
      d.layers.plan = [{
        id: 'p1', title: 'Add cache', summary: [claim()],
        buildings: [b],
        edges: [{ ...d.edges[0], id: 'pe1', from: 'b1', to: 'p1b' }]
      }]
      return d
    }

    it('accepts a well-formed proposal', () => {
      expect(validateWorld(proposal()).ok).toBe(true)
    })

    it('needs layout positions and status proposed', () => {
      const d = proposal()
      delete d.layout.positions.p1b
      d.layers.plan[0].buildings[0].status = 'built'
      const e = errorsOf(d)
      expect(e).toContain('proposal p1: building p1b: no layout position')
      expect(e).toContain('proposal p1: building p1b: status must be "proposed"')
    })

    it('flags unknown edge targets and duplicate proposal ids', () => {
      const d = proposal()
      d.layers.plan[0].edges[0].to = 'nope'
      d.layers.plan.push(JSON.parse(JSON.stringify(d.layers.plan[0])))
      const e = errorsOf(d)
      expect(e).toContain('proposal p1: edge pe1: unknown to "nope"')
      expect(e).toContain('proposal p1: duplicate id')
    })

    it('flags bad proposal fields and a non-array plan', () => {
      const d = proposal()
      d.layers.plan[0].title = 1
      d.layers.plan[0].summary = 'x'
      d.layers.plan[0].buildings = 'x'
      d.layers.plan[0].edges = 'x'
      d.layers.plan[0].id = ''
      const e = errorsOf(d)
      expect(e).toContain('proposal #0: id must be a non-empty string')
      expect(e).toContain('proposal #0: title must be a string')
      expect(e).toContain('proposal #0: summary must be an array')
      expect(e).toContain('proposal #0: buildings must be an array')
      expect(e).toContain('proposal #0: edges must be an array')
      const d2 = fresh()
      d2.layers.plan = 'x'
      expect(errorsOf(d2)).toContain('layers.plan must be an array')
    })
  })
})

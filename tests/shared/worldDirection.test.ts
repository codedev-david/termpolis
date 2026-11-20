// Which way a Lumopolis line runs, worked out once for both cards (shared/world/cardFacts.ts), and the
// twoWay flag set on a line whose reverse is in the same list.
import { describe, expect, it } from 'vitest'
import { direction, markTwoWay, reverseOf } from '../../src/shared/world/cardFacts'
import type { WorldDoc } from '../../src/shared/world/types'
import { building, edge, minimal } from '../renderer/world/helpers'

/** Renderer and Main, with a line from Renderer to Main and an outside web service. */
function world(): WorldDoc {
  const doc = minimal()
  doc.buildings = [building('r', { name: 'Renderer' }), building('m', { name: 'Main' })]
  doc.edges = [edge('rm', 'r', 'm', { label: 'ipc <pty:data>' })]
  doc.externals = [{ id: 'x-api', name: 'api.example.com', kind: 'service', fog: false }]
  doc.layers.plan = []
  return doc
}

describe('markTwoWay', () => {
  it('sets twoWay on both lines of a reverse pair, keeps a lone line as it was, and keeps every id', () => {
    const lines = markTwoWay([edge('a', 'r', 'm'), edge('b', 'm', 'r'), edge('c', 'r', 'x'), edge('d', 'm', 'x', { twoWay: true })])
    expect(lines.map((e) => [e.id, e.twoWay])).toEqual([['a', true], ['b', true], ['c', false], ['d', true]])
  })

  it('returns new lines and leaves the given ones alone', () => {
    const given = [edge('a', 'r', 'm'), edge('b', 'm', 'r')]
    markTwoWay(given)
    expect(given.map((e) => e.twoWay)).toEqual([false, false])
  })
})

describe('reverseOf', () => {
  it('finds the line back in the list holding the line, built or planned', () => {
    const doc = world()
    doc.edges.push(edge('mr', 'm', 'r'))
    expect(reverseOf(doc, doc.edges[0])?.id).toBe('mr')
    doc.layers.plan.push({ id: 'p', title: 'P', summary: [], buildings: [], edges: [edge('p1', 'r', 'x-api'), edge('p2', 'x-api', 'r')] })
    expect(reverseOf(doc, doc.layers.plan[0].edges[0])?.id).toBe('p2')
    // A planned line's reverse among the built lines is not its pair: the two lists are separate worlds.
    doc.layers.plan.push({ id: 'q', title: 'Q', summary: [], buildings: [], edges: [edge('q1', 'm', 'r')] })
    expect(reverseOf(doc, doc.layers.plan[1].edges[0])).toBeUndefined()
    expect(reverseOf(doc, edge('loose', 'm', 'r'))).toBeUndefined()
  })
})

describe('direction', () => {
  it('both ways: the reverse line exists, and its half of the sentence links to it', () => {
    const doc = world()
    doc.edges.push(edge('mr', 'm', 'r'))
    const d = direction(doc, doc.edges[0])
    expect(d.text).toBe('Both ways: Renderer reaches Main, and Main reaches Renderer.')
    expect(d).toMatchObject({ before: 'Both ways: Renderer reaches Main, and ', link: 'Main reaches Renderer', after: '.', reverseId: 'mr' })
    expect(direction(doc, doc.edges[1]).text).toBe('Both ways: Main reaches Renderer, and Renderer reaches Main.')
  })

  it('both ways with no reverse line: a line marked twoWay says so, with nothing to link to', () => {
    const doc = world()
    doc.edges[0].twoWay = true
    const d = direction(doc, doc.edges[0])
    expect(d.text).toBe('Both ways: Renderer reaches Main, and Main reaches Renderer.')
    expect(d.reverseId).toBeUndefined()
  })

  it('one way, with replies: a call to an outside web address answers it', () => {
    const doc = world()
    doc.edges.push(edge('rx', 'r', 'x-api', { label: 'http-out api.example.com' }))
    expect(direction(doc, doc.edges[1]).text).toBe('One way, with replies: Renderer asks and api.example.com answers.')
  })

  it('one way: no line back and no recorded reply; channels, programs and model words do not count as replies', () => {
    const doc = world()
    expect(direction(doc, doc.edges[0]).text).toBe('One way: Renderer reaches Main; the code shows no line from Main back to Renderer.')
    // A line between two parts of the project whose words a model wrote is not the code's http call.
    doc.edges.push(edge('rm2', 'r', 'm', { label: 'http-out api.example.com' }))
    expect(direction(doc, doc.edges[1]).text).toBe('One way: Renderer reaches Main; the code shows no line from Main back to Renderer.')
    for (const label of ['spawn claude', 'mcp termpolis', 'Calls the API']) {
      doc.edges.push(edge(`x-${label}`, 'r', 'x-api', { label }))
      expect(direction(doc, doc.edges[doc.edges.length - 1]).text).toBe('One way: Renderer reaches api.example.com; the code shows no line from api.example.com back to Renderer.')
    }
    expect(direction(doc, doc.edges[0])).toMatchObject({ before: 'One way: Renderer reaches Main; the code shows no line from Main back to Renderer.', link: '', after: '' })
  })

  it('a planned line says only what the plan says, a proposal\'s or a design world\'s', () => {
    const doc = world()
    doc.layers.plan.push({ id: 'p', title: 'P', summary: [], buildings: [], edges: [edge('p1', 'r', 'm'), edge('p2', 'm', 'r'), edge('p3', 'r', 'x-api', { label: 'http-out api.example.com' })] })
    const [p1, , p3] = doc.layers.plan[0].edges
    expect(direction(doc, p1)).toMatchObject({ text: 'Both ways (planned): Renderer reaches Main, and Main reaches Renderer.', reverseId: 'p2' })
    expect(direction(doc, p3).text).toBe('One way (planned): Renderer reaches api.example.com.')
    const design = world()
    design.projectKey = 'design:abc'
    expect(direction(design, design.edges[0]).text).toBe('One way (planned): Renderer reaches Main.')
    design.edges[0].twoWay = true
    expect(direction(design, design.edges[0]).text).toBe('Both ways (planned): Renderer reaches Main, and Main reaches Renderer.')
  })
})

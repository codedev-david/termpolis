import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { askEntries, bm25Scores, buildBm25, rankAsk } from '../../src/shared/world/askIndex'
import { validateWorld } from '../../src/shared/world/validate'

const dir = join(__dirname, '..', 'fixtures', 'world')
const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'))

describe('Ask quality on the fixture world', () => {
  it('keyword Ask finds the right part in the top 3 for at least 10 of 15 questions', () => {
    const checked = validateWorld(read('termpolis.world.json'))
    if (!checked.ok) throw new Error(checked.errors.join('; '))
    const doc = checked.doc
    const questions = read('askQuestions.json') as { q: string; labelled: string[] }[]
    expect(questions).toHaveLength(15)
    const entries = askEntries(doc)
    const ix = buildBm25(entries.map((e) => e.text))
    const edges = new Map(doc.edges.map((e) => [e.id, e]))
    let found = 0
    for (const { q, labelled } of questions) {
      const hits = rankAsk(entries, { keyword: bm25Scores(ix, q) }).slice(0, 3)
      const ok = hits.some((h) => {
        const e = edges.get(h.id)
        return labelled.includes(h.id) || (e !== undefined && labelled.includes(e.from) && labelled.includes(e.to))
      })
      if (ok) found++
    }
    expect(found).toBeGreaterThanOrEqual(10)
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { askEntries, bm25Scores, buildBm25, cosineScores, nameFit, packInt8, rankAsk, type AskHit } from '../../src/shared/world/askIndex'
import { validateWorld } from '../../src/shared/world/validate'
import { embedBatch } from '../../src/main/localEmbedder'

const dir = join(__dirname, '..', 'fixtures', 'world')
const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'))

interface Question { q: string; labelled: string[] }
/**
 * One-word and area-name questions, each with the rank a newcomer accepts. A name of a part (or one word of it) is
 * `top: 1`: the newcomer clicks the first row and expects the part they named. An area is `top: 3`: areas are not
 * Ask entries (spec "The Ask index"), so any building of the area answers, and three rows is the spec's own bar.
 */
interface NameQuestion extends Question { top: 1 | 3 }

function fixture() {
  const checked = validateWorld(read('termpolis.world.json'))
  if (!checked.ok) throw new Error(checked.errors.join('; '))
  const doc = checked.doc
  const entries = askEntries(doc)
  const ix = buildBm25(entries.map((e) => e.text))
  const edges = new Map(doc.edges.map((e) => [e.id, e]))
  /** A hit is an accepted id, or a line whose two ends are both accepted. */
  const accepted = (labelled: string[], hits: AskHit[]): boolean => hits.some((h) => {
    const e = edges.get(h.id)
    return labelled.includes(h.id) || (e !== undefined && labelled.includes(e.from) && labelled.includes(e.to))
  })
  return { entries, ix, accepted }
}

const questions = read('askQuestions.json') as Question[]
const nameQuestions = read('askNameQuestions.json') as NameQuestion[]

describe('Ask quality on the fixture world', () => {
  it('keyword Ask finds the right part in the top 3 for at least 10 of 15 questions', () => {
    const { entries, ix, accepted } = fixture()
    expect(questions).toHaveLength(15)
    let found = 0
    for (const { q, labelled } of questions) {
      if (accepted(labelled, rankAsk(entries, { keyword: bm25Scores(ix, q), named: nameFit(entries, q) }).slice(0, 3))) found++
    }
    expect(found).toBeGreaterThanOrEqual(10)
  })

  it('keyword Ask puts the part a one-word question names first, and a building of a named area in the top 3', () => {
    const { entries, ix, accepted } = fixture()
    const missed = nameQuestions
      .filter(({ q, labelled, top }) => !accepted(labelled, rankAsk(entries, { keyword: bm25Scores(ix, q), named: nameFit(entries, q) }).slice(0, top)))
      .map(({ q }) => q)
    expect(missed).toEqual([])
  })

  it('smart and fused Ask find the right part in the top 3 for at least 12 of 15 questions, and fused Ask passes the name and area questions', async (ctx) => {
    // The bge model is not in git; CI's package-verify job downloads it and sets TERMPOLIS_REQUIRE_MODEL=1.
    const [probe] = await embedBatch(['model check'])
    if (probe === null) {
      if (process.env.TERMPOLIS_REQUIRE_MODEL === '1') throw new Error('The bge-small model is missing from resources/models')
      ctx.skip('the bge-small model is not on this machine')
    }
    const { entries, ix, accepted } = fixture()
    const packed = packInt8((await embedBatch(entries.map((e) => e.text))).map((v) => v as number[]))
    const all = [...questions, ...nameQuestions]
    const vectors = await embedBatch(all.map((x) => x.q), { isQuery: true })
    const ranked = all.map(({ q }, i) => {
      const smart = cosineScores(packed, Float32Array.from(vectors[i] as number[]))
      // The page never ranks by meaning alone (it fuses, or with FUSE off ranks by keyword); this measures the meaning
      // ranking the spec bars. rankAsk ranks one list of scores as `keyword`, which differs from the meaning half of the
      // fusion only by dropping the entries scored 0 or below; with 3 or more above 0 the top 3 are the same.
      expect(smart.filter((x) => x > 0).length).toBeGreaterThanOrEqual(3)
      return {
        smart: rankAsk(entries, { keyword: smart }),
        fused: rankAsk(entries, { smart, keyword: bm25Scores(ix, q), named: nameFit(entries, q) })
      }
    })
    const top3 = (pick: 'smart' | 'fused'): number => questions.filter(({ labelled }, i) => accepted(labelled, ranked[i][pick].slice(0, 3))).length
    expect(top3('smart')).toBeGreaterThanOrEqual(12)
    expect(top3('fused')).toBeGreaterThanOrEqual(12)
    const missed = nameQuestions
      .filter(({ labelled, top }, i) => !accepted(labelled, ranked[questions.length + i].fused.slice(0, top)))
      .map(({ q }) => q)
    expect(missed).toEqual([])
  }, 120_000)
})

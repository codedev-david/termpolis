// @vitest-environment node
// The regression pin for the primer: in these scenarios (no saved note past the first three, no lesson the substance
// gate vouches for, and none of the cases below) 1.55.0 builds exactly the text 1.54 built. The expected text in
// fixtures/primerBaseline.json was captured from the 1.54 builder, before the primer was reordered, and is
// compared byte for byte. If this fails, a change meant for notes, lessons, the lane or duplicates has leaked
// into a digest that has none of them. (One scenario holds saved notes, so it pins the new order, not 1.54's:
// the notes lead there. The rest are 1.54's text.) The text is NOT 1.54's in every digest without notes: a chunk
// and the fuller chunk that begins with it become one line, the lane leaves out what a search leaves out, and a
// correction applies; none of those is in these scenarios. contextPrimer.test.ts pins each of them.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { scenarios } from './_primerScenarios'

const baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'primerBaseline.json'), 'utf8')) as Record<string, string | null>

describe('the primer without notes or gated lessons is the 1.54 primer, byte for byte, in the pinned scenarios', () => {
  it('has an expected digest for every scenario and no stray ones', () => {
    expect(Object.keys(baseline).sort()).toEqual(scenarios.map((s) => s.name).sort())
  })

  for (const s of scenarios) {
    it(s.name, async () => {
      expect(await s.build()).toBe(baseline[s.name])
    })
  }
})

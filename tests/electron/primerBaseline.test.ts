// @vitest-environment node
// The regression pin for the primer: when a digest holds no saved note past the first three and no lesson the
// substance gate vouches for, 1.55.0 builds exactly the text 1.54 built. The expected text in
// fixtures/primerBaseline.json was captured from the 1.54 builder, before the primer was reordered, and is
// compared byte for byte. If this fails, a change meant for notes, lessons, the lane or duplicates has leaked
// into a digest that has none of them.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { scenarios } from './_primerScenarios'

const baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'primerBaseline.json'), 'utf8')) as Record<string, string | null>

describe('the primer without notes or gated lessons is the 1.54 primer, byte for byte', () => {
  it('has an expected digest for every scenario and no stray ones', () => {
    expect(Object.keys(baseline).sort()).toEqual(scenarios.map((s) => s.name).sort())
  })

  for (const s of scenarios) {
    it(s.name, async () => {
      expect(await s.build()).toBe(baseline[s.name])
    })
  }
})

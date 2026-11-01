import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * What the README says about Token Headroom's savings, held to what the app does.
 *
 * Until v1.55 the product promised that at least half of the tool text on the wire goes away, and
 * the README quoted the measurement ("61.0% removed", "93.8% of requests clear 50%"). The default
 * policy since v1.55 (Late) removes less tool text on purpose, because the model asks for most of
 * what is shortened early and each ask is a whole extra turn. Those figures are true of the Legacy
 * policy and are not true of the default, so every place that states one has to say which it means,
 * and the figure the release stands on (the modelled 11.7%) has to say it is modelled. This keeps a
 * later edit from quietly putting the old promise back.
 */

const ROOT = join(__dirname, '..', '..')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

/** The bullets of the Token Headroom section, one entry per list item. */
function headroomBullets(): string[] {
  const start = readme.indexOf('## ⚡ Token Headroom')
  const end = readme.indexOf('\n---', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return readme.slice(start, end).split('\n').filter((l) => l.startsWith('- '))
}

describe('the README on Token Headroom', () => {
  it('has the section, at the version it describes', () => {
    expect(readme).toContain('## ⚡ Token Headroom — compress what Claude Code sends, cut your burn rate (v1.55)')
  })

  it('says every old savings figure belongs to the Legacy policy', () => {
    const stale = ['93.8%', '61.0%', '72.3%', '99.9%', 'clears 50%', 'clear 50%']
    let found = 0
    for (const bullet of headroomBullets()) {
      if (!stale.some((s) => bullet.includes(s))) continue
      found++
      expect(bullet, bullet.slice(0, 80)).toMatch(/Legacy/)
    }
    expect(found).toBeGreaterThan(0)
  })

  it('does not present the savings floor as a promise of the default policy', () => {
    const floor = headroomBullets().find((b) => b.includes('A savings floor that enforces itself'))
    expect(floor).toBeDefined()
    expect(floor).toContain('Legacy policy only since v1.55')
    expect(floor).toContain('Late policy removes less tool text on purpose')
  })

  it('introduces Late with the reason, the number as a modelled one, the holdout and the way back', () => {
    const late = headroomBullets().find((b) => b.startsWith('- **Late, not early (v1.55).**'))
    expect(late).toBeDefined()
    expect(late).toContain('40,000 characters')
    expect(late).toContain('two thirds')
    expect(late).toMatch(/11\.7%.{0,160}\*\*modelled\*\* figure, not a promise/)
    expect(late).toContain('one conversation in ten')
    expect(late).toContain('holdout')
    expect(late).toContain('Elision health')
    expect(late).toContain('500 requests')
    expect(late).toContain('cannot see the quality of an answer')
    expect(late).toContain('never less')
    expect(late).toContain('Legacy')
    expect(late).toContain('next time Termpolis starts')
  })

  it('says the size from which each kind of compression applies, so no bullet implies it starts at the tier', () => {
    const text = headroomBullets().join('\n')
    expect(text).toContain('from **40,000 characters** under the default Late policy')
    expect(text).toContain('files of 40,000 characters and up')
    expect(text).toContain('payloads of 40,000 characters and up')
  })

  it('describes the headline as the bill, net of the turns that fetched elided text', () => {
    const meter = headroomBullets().find((b) => b.includes('The meter reports all three denominators'))
    expect(meter).toBeDefined()
    expect(meter).toContain('billed units avoided, net of the turns that only fetched elided text')
    expect(meter).toContain('allowed to read negative')
  })

  it('names the regression test for the Legacy half and for the Late half', () => {
    const measured = headroomBullets().find((b) => b.startsWith('- **Measured, not asserted'))
    expect(measured).toBeDefined()
    expect(measured).toContain('tests/electron/headroomFloorRealistic.test.ts')
    expect(measured).toContain('Legacy policy ever stops clearing 50%')
    expect(measured).toContain('for Late it asserts the opposite on purpose')
  })
})

describe('the Settings copy on the savings floor', () => {
  const settings = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'components', 'SettingsPane', 'TokenSavingsSettings.tsx'), 'utf8')

  it('no longer offers an unconditional 50% floor', () => {
    expect(settings).not.toMatch(/\{' '\}Hold a 50% savings floor/)
    expect(settings).toContain('Under Legacy, hold a 50% savings floor')
    expect(settings).toContain('Late is not held to a floor')
  })
})

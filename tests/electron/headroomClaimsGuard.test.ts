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
 * and the figure the release stands on (the modeled 10%) has to say it is modeled and whose it is.
 * This keeps a later edit from quietly putting the old promise back.
 *
 * It is not enough for a bullet to MENTION Legacy somewhere: the sentence that carries the old figure
 * has to say whose figure it is, so each lead-in below is pinned in full.
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

  it('says every old savings figure belongs to the v1.34 measurement or the Legacy policy', () => {
    // The v1.34 figures: the text removed, the three denominators, the body share.
    const stale = ['93.8%', '61.0%', '72.3%', '99.9%', 'clears 50%', 'clear 50%', '(**61%**)', '(~9%)', '(~6%)', '**42.3%**', '**25.8%']
    let found = 0
    for (const bullet of headroomBullets()) {
      if (!stale.some((s) => bullet.includes(s))) continue
      found++
      expect(bullet, bullet.slice(0, 80)).toMatch(/v1\.34|Legacy/)
    }
    expect(found).toBeGreaterThanOrEqual(2)
  })

  it('pins the sentences that say whose the old figures are, in full, so they cannot be reworded into the default\'s', () => {
    const measured = headroomBullets().find((b) => b.startsWith('- **Measured, not asserted'))
    expect(measured).toBeDefined()
    expect(measured).toContain('- **Measured, not asserted (the v1.34 numbers, which now describe the Legacy policy).**')
    const meter = headroomBullets().find((b) => b.includes('The meter reports all three denominators'))
    expect(meter).toBeDefined()
    expect(meter).toContain('(Those three figures are the v1.34 measurement.)')
  })

  it('does not present the savings floor as a promise of the default policy', () => {
    const floor = headroomBullets().find((b) => b.includes('A savings floor that enforces itself'))
    expect(floor).toBeDefined()
    expect(floor).toContain('Legacy policy only since v1.55')
    expect(floor).toContain('Late policy removes less tool text on purpose')
  })

  it('introduces Late with the reason, the number as a modeled one that is one person\'s, the holdout and the way back', () => {
    const late = headroomBullets().find((b) => b.startsWith('- **Late, not early (v1.55).**'))
    expect(late).toBeDefined()
    expect(late).toContain('40,000 characters')
    expect(late).toContain('two thirds')
    // Whose: the author's machine, with the two models it differs by.
    expect(late).toContain("on the author's own machine (about 69% on Opus 5.5 and 44% on Sonnet 5.5)")
    // What it is worth: about 10% (not the 11.7% that included a band Late does not touch), where, and what less looks like.
    expect(late).toMatch(/about \*\*10%\*\* of the bill saved where the model asks for results back that often, from one person's history/)
    expect(late).not.toContain('11.7%')
    expect(late).toContain('varies only the cost of one retrieval turn, not how often the model asks')
    expect(late).toContain('below roughly a third to a half of the time it costs a little')
    expect(late).toMatch(/\*\*modeled\*\* figure, not a promise/)
    expect(late).toContain('one distinct opening message in ten')
    expect(late).toContain('holdout')
    expect(late).toContain('Elision health')
    expect(late).toContain('500 requests')
    expect(late).toContain('cannot see the quality of an answer')
    expect(late).toContain('shown at least as much as before, never less')
    expect(late).toContain('Legacy')
    expect(late).toContain('next time Termpolis starts')
  })

  it('says the first start after the upgrade rebuilds the prompt cache once for a conversation that is resumed', () => {
    const late = headroomBullets().find((b) => b.startsWith('- **Late, not early (v1.55).**')) as string
    expect(late).toContain('The first start after upgrading to v1.55 rebuilds the prompt cache once for a conversation you resume')
    expect(late).toContain('because Late leaves whole the results v1.54 had shortened')
  })

  it('does not say the proxy does less work by construction: speed is measured, with the numbers that were', () => {
    const late = headroomBullets().find((b) => b.startsWith('- **Late, not early (v1.55).**')) as string
    expect(late).not.toContain('does less work per request, not more')
    expect(late).toContain('Speed is measured, not promised')
    expect(late).toContain('about eight times less')
    expect(late).toContain('at most about 0.05 ms more on a request made only of small results')
  })

  it('says Legacy is v1.54 byte for byte only in its compression, since retrieve_full hands back the text itself under both', () => {
    const late = headroomBullets().find((b) => b.startsWith('- **Late, not early (v1.55).**')) as string
    expect(late).toContain("restores v1.54's compression byte for byte (`retrieve_full` hands back the text itself under both settings)")
    expect(late).not.toMatch(/restores v1\.54's behaviour byte for byte/)
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

  it('does not quote the 11.7% that included a band Late does not touch, or say which machine it is not from', () => {
    expect(settings).not.toContain('11.7%')
    expect(settings).toContain('On the author’s machine')
    expect(settings).not.toMatch(/never less\./)
  })

  it('no longer describes the compressor\'s reach as the 86% of message bytes it reached before v1.49 stopped touching tool inputs', () => {
    expect(settings).not.toContain('about 86% of message bytes')
    expect(settings).toContain('the input of any tool call')
  })
})

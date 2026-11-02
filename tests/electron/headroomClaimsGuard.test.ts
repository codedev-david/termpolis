import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
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

/** The words the old promise came in, and the names of the policy it is true of. */
const PROMISE_WORDS = ['51%', 'at least half', 'half of your', '50% minimum', 'at least 50%', '51 percent', '50 percent', 'fifty percent', 'half the tool', 'half of the tool']
const QUALIFIER = /v1\.34|Legacy|holdout/

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

  // The check above only looks at a bullet that already carries one of the exact figures it lists, so a new
  // bullet that promises the old thing in other words would pass it. These are the words the promise came in.
  /** A bullet that uses a word of the old promise and does not say it is about v1.34, Legacy or the holdout. */
  const promisesTheOldFigure = (bullet: string): boolean => PROMISE_WORDS.some((w) => bullet.includes(w)) && !QUALIFIER.test(bullet)

  it('has no bullet that promises the old half-of-your-tool-text figure without saying which policy it is about', () => {
    for (const bullet of headroomBullets()) expect(promisesTheOldFigure(bullet), bullet.slice(0, 90)).toBe(false)
  })

  it('and that rule is not vacuous: it fails a new unqualified bullet and passes the same words when they name Legacy', () => {
    expect(promisesTheOldFigure('- **Saves you money.** Termpolis removes about 51% fewer tokens, at least half of your tool text, every time.')).toBe(true)
    expect(promisesTheOldFigure('- **Half.** Saves at least half of your tool text.')).toBe(true)
    expect(promisesTheOldFigure('- **A 50% minimum.** Always.')).toBe(true)
    // The same promise spelled out, which a list of the digit forms alone would let through.
    expect(promisesTheOldFigure('- **Half.** Termpolis removes 50 percent of your tool text, every time.')).toBe(true)
    expect(promisesTheOldFigure('- **Half.** It takes out fifty percent of what a tool prints.')).toBe(true)
    expect(promisesTheOldFigure('- **Half.** About 51 percent fewer tokens.')).toBe(true)
    expect(promisesTheOldFigure('- **Half.** It cuts half the tool output on every request.')).toBe(true)
    expect(promisesTheOldFigure('- **Legacy only.** Under the Legacy policy it removed at least half of your tool text.')).toBe(false)
    expect(promisesTheOldFigure('- **Measured (v1.34).** About 51% fewer tokens.')).toBe(false)
    expect(promisesTheOldFigure('- **Nothing of the sort.** It shortens large results.')).toBe(false)
  })

  it('pins the sentences that say whose the old figures are, in full, so they cannot be reworded into the default\'s', () => {
    const measured = headroomBullets().find((b) => b.startsWith('- **Measured, not asserted'))
    expect(measured).toBeDefined()
    expect(measured).toContain('- **Measured, not asserted (the v1.34 numbers, which now describe the Legacy policy).**')
    const meter = headroomBullets().find((b) => b.includes('The meter reports all three denominators'))
    expect(meter).toBeDefined()
    expect(meter).toContain('(Those three figures are the v1.34 measurement.)')
  })

  // The bullet's title says "the v1.34 numbers", but the SENTENCE that carries the percentages used to open
  // "At the shipped default:", which on its own is the stale at-least-half claim for a default that is now Late
  // (which removes less on purpose). The qualifier has to be in the sentence that holds the numbers.
  it('puts the qualifier in the very sentence that carries the v1.34 percentages, never "the shipped default"', () => {
    const measured = headroomBullets().find((b) => b.startsWith('- **Measured, not asserted')) as string
    expect(measured).toContain("At v1.34's default tier (Aggressive, Legacy policy): **61.0% of compressible tool text removed**")
    expect(measured).not.toContain('shipped default')
    // Every sentence of this bullet that holds one of the percentages names its source or follows one that does.
    // The bold title is cut off first: it names v1.34 and Legacy, and would excuse the sentence after it.
    const sentences = measured.replace(/^- \*\*[^*]+\*\*/, '').trim().split(/(?<=[.)])\s+(?=[A-Z])/)
    const holders = sentences.map((s, i) => ({ s, i })).filter(({ s }) => /61\.0%|93\.8%|72\.3%|99\.9%/.test(s))
    expect(holders.length).toBeGreaterThanOrEqual(2)
    for (const { s, i } of holders) {
      const named = QUALIFIER.test(s) || (i > 0 && QUALIFIER.test(sentences[i - 1]))
      expect(named, s.slice(0, 80)).toBe(true)
    }
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
    // Per result and not per request: the added work grows with the number of results, so a fixed bound on a
    // request is only true of a short one. About a microsecond each; 400 results of 300 characters measured
    // 0.39 ms (legacy) and 0.50 ms (late) more, about 15% of a 2.5 ms rewrite.
    expect(late).toContain('about one microsecond more for each tool result in a request made only of small ones (under half a millisecond for a request of 400 results)')
    expect(late).not.toContain('0.05 ms')
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

/**
 * The README is not the only place the old promise could come back: the guide, the privacy policy and every string of
 * the app's own UI are read as claims too. The README rule works on a bullet; these texts are not bullets (JSX is
 * not even lines of prose), so the unit is the sentence, and a sentence that uses a word of the old promise has to
 * name the policy it is true of itself or follow a sentence that does.
 */
describe('the old promise, anywhere else a person could read it', () => {
  /** The sentences of a text that use a word of the old promise without naming v1.34, Legacy or the holdout. */
  const unqualifiedSentences = (text: string): string[] => {
    const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z*`(<{'"])/)
    return sentences.filter((s, i) => PROMISE_WORDS.some((w) => s.includes(w)) && !QUALIFIER.test(s) && !(i > 0 && QUALIFIER.test(sentences[i - 1])))
  }

  /** Every .ts and .tsx file under a folder, with its text. */
  const sourceFiles = (dir: string): Array<{ name: string; text: string }> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return sourceFiles(p)
      return /\.tsx?$/.test(e.name) ? [{ name: p.slice(ROOT.length + 1), text: readFileSync(p, 'utf8') }] : []
    })

  it('is not made in the guide, the privacy policy or any file of the renderer (the pane, the card, the what\'s-new text)', () => {
    const files = [
      { name: 'docs/DOCUMENTATION.md', text: readFileSync(join(ROOT, 'docs', 'DOCUMENTATION.md'), 'utf8') },
      { name: 'PRIVACY.md', text: readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8') },
      ...sourceFiles(join(ROOT, 'src', 'renderer', 'src')),
    ]
    // The two files that are the point of the sweep are in it: a path typo must not make it vacuous.
    const names = files.map((f) => f.name.split('\\').join('/'))
    expect(names).toContain('src/renderer/src/components/SettingsPane/TokenSavingsSettings.tsx')
    expect(names).toContain('src/renderer/src/components/SettingsPane/ElisionHealthCard.tsx')
    expect(files.length).toBeGreaterThan(50)
    for (const f of files) expect(unqualifiedSentences(f.text), f.name).toEqual([])
  })

  it('and that rule is not vacuous: it fails the old promise in the words a pane or a guide would use and passes it when it names its policy', () => {
    expect(unqualifiedSentences('Claude Code compression proxy: saves 51% fewer tokens, always.')).toHaveLength(1)
    expect(unqualifiedSentences('It removes at least half of your tool text, every time.')).toHaveLength(1)
    expect(unqualifiedSentences("<p>Termpolis removes 50% minimum of tool text.</p>")).toHaveLength(1)
    expect(unqualifiedSentences('Nothing to see. It removes at least 50% of every result.')).toHaveLength(1)
    expect(unqualifiedSentences('Termpolis removes 50 percent of your tool text, every time.')).toHaveLength(1)
    // Across the line breaks JSX and Markdown put inside a sentence.
    expect(unqualifiedSentences('It removes\n   at least half\n   of your tool text.')).toHaveLength(1)
    // Named in the same sentence or the one before it.
    expect(unqualifiedSentences('Under Legacy it removes at least half of your tool text.')).toEqual([])
    expect(unqualifiedSentences('That was the v1.34 measurement. It removed 51% fewer tokens.')).toEqual([])
    expect(unqualifiedSentences('The holdout keeps the old behavior. It removes at least half of your tool text.')).toEqual([])
    // Two sentences away is too far: the qualifier has to be where the figure is.
    expect(unqualifiedSentences('That was Legacy. Nothing else here. It removes at least half of your tool text.')).toHaveLength(1)
    expect(unqualifiedSentences('Late shortens a result from 40,000 characters.')).toEqual([])
  })

  // The sentences the round-2 verifier found nothing pinned, each held to the words it is true in. They are the
  // ones a later edit could flip without any test going red: a restart that is not needed, a headline that stops
  // saying it is overstated, a summary that stops saying what the default is.
  it('keeps the sentences a person relies on to read the savings and the restart', () => {
    const flat = (s: string): string => s.replace(/\s+/g, ' ')
    const privacy = flat(readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8'))
    const docs = flat(readFileSync(join(ROOT, 'docs', 'DOCUMENTATION.md'), 'utf8'))
    const pane = flat(readFileSync(join(ROOT, 'src', 'renderer', 'src', 'components', 'SettingsPane', 'TokenSavingsSettings.tsx'), 'utf8'))
    expect(pane).toContain('A change takes effect the next time Termpolis starts, because one proxy serves every Claude session of a run and a change in the middle would rewrite each session’s prompt cache.')
    expect(docs).toContain('the all-time figure is higher than your bill supports, and stays higher: it carries the older history as it was, never netted, and only what is added from v1.55 on is.')
    expect(privacy).toContain('Since v1.55 it shortens a tool result only from 40,000 characters by default, and keeps a comparison on your machine of that against the old behavior (Late or Legacy, your choice).')
  })
})

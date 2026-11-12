import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

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
const PROMISE_WORDS = ['51%', 'at least half', 'half of your', '50% minimum', 'at least 50%', '51 percent', '50 percent', 'fifty percent', 'half the tool', 'half of the tool', 'half your', 'halves your', 'halve your', 'in half,', 'in half.']
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
    // What it is worth: about 10% (the 11.7% included a band Late does not touch, so it is never the headline: it is named
    // once, as the research's figure for every size, and the range of 5.6 to 17.9% is attributed to it and not to the 10%),
    // where it holds, and what less looks like.
    expect(late).toMatch(/about \*\*10%\*\* of the bill saved where the model asks for results back that often, from one person's history/)
    expect(late!.split('11.7%')).toHaveLength(2)
    expect(late).not.toContain('**11.7%**')
    expect(late).toContain("the research's 11.7% counts every size")
    expect(late).toContain('belongs to that figure and varies only the cost of one retrieval turn, not how often the model asks')
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
 * The README bullets are held by the rule above, which works on a bullet: a bullet that names Legacy somewhere
 * excuses every sentence in it. That is too coarse to catch a sentence planted in a bullet that is otherwise
 * about Legacy, and it does not reach the other places a person reads the claim at all: the guide, the privacy
 * policy and the words of the app's own UI. So the rule here is about the SENTENCE: one that uses a word of the old
 * promise has to say, itself, that it is about v1.34, Legacy or the holdout. A neighbouring sentence or a bold
 * label that names Legacy does not excuse it ("Shorten tool results: Late or Legacy." is a label, not a
 * qualifier of what follows).
 *
 * Markdown is read as prose, sentence by sentence. A renderer file is code, so it is parsed and only what a person
 * can read in it is taken: each piece of JSX text and each string or template literal, on its own, so that a
 * heading in one element cannot borrow the Legacy of the element beside it.
 */
describe('the old promise, anywhere a person could read it', () => {
  /**
   * The sentences of a prose text that use a word of the old promise and do not name v1.34, Legacy or the holdout themselves.
   * A list item, a heading, a table row and a blank line each begin something new whatever the line before ended with, so the
   * text is cut there on its lines, before the wrap of a long line is flattened: a promise that ends one bullet would otherwise
   * join the first sentence of the next and be excused by the Legacy in its label. Within one such piece a sentence ends at
   * . ! or ? and whatever closes it (a bold label's ** or a bracket or a quote), and the next begins at a capital or an opener.
   */
  const unqualifiedSentences = (text: string): string[] =>
    text
      .split(/\n\s*\n|\n(?=[ \t]*(?:[-*+]|\d+[.)])[ \t]|#{1,6}[ \t]|\|)/)
      .flatMap((piece) => piece.replace(/\s+/g, ' ').split(/(?<=[.!?][*)"'’”`]*)\s+(?=[A-Z*`(<{'"])/))
      .filter((s) => PROMISE_WORDS.some((w) => s.includes(w)) && !QUALIFIER.test(s))

  /** Everything a person can read in a .ts or .tsx source: JSX text, string and template literals, each on its own. */
  const readableText = (source: string, file: string): string[] => {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const out: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isJsxText(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text)
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out.filter((t) => t.trim().length > 0)
  }

  /** Every .ts and .tsx file under a folder, by path from the repo root. */
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return sourceFiles(p)
      return /\.tsx?$/.test(e.name) ? [p.slice(ROOT.length + 1).split('\\').join('/')] : []
    })

  it('is not made in any sentence of the README bullets, the guide or the privacy policy', () => {
    for (const bullet of headroomBullets()) expect(unqualifiedSentences(bullet), bullet.slice(0, 80)).toEqual([])
    for (const file of ['docs/DOCUMENTATION.md', 'PRIVACY.md']) expect(unqualifiedSentences(readFileSync(join(ROOT, file), 'utf8')), file).toEqual([])
  })

  it('is not made in any readable text of any file of the renderer (the pane, the card, the what\'s-new text)', () => {
    const files = sourceFiles(join(ROOT, 'src', 'renderer', 'src'))
    // The two files that are the point of the sweep are in it: a path typo must not make it vacuous.
    expect(files).toContain('src/renderer/src/components/SettingsPane/TokenSavingsSettings.tsx')
    expect(files).toContain('src/renderer/src/components/SettingsPane/ElisionHealthCard.tsx')
    expect(files.length).toBeGreaterThan(50)
    let pieces = 0
    for (const f of files) {
      for (const piece of readableText(readFileSync(join(ROOT, f), 'utf8'), f)) {
        pieces++
        expect(unqualifiedSentences(piece), f).toEqual([])
      }
    }
    expect(pieces).toBeGreaterThan(1000)
  })

  it('and that rule is not vacuous: it fails the old promise in the words a pane or a guide would use, and passes it when the sentence names its policy', () => {
    expect(unqualifiedSentences('Claude Code compression proxy: saves 51% fewer tokens, always.')).toHaveLength(1)
    expect(unqualifiedSentences('It removes at least half of your tool text, every time.')).toHaveLength(1)
    expect(unqualifiedSentences('<p>Termpolis removes 50% minimum of tool text.</p>')).toHaveLength(1)
    expect(unqualifiedSentences('Nothing to see. It removes at least 50% of every result.')).toHaveLength(1)
    expect(unqualifiedSentences('Termpolis removes 50 percent of your tool text, every time.')).toHaveLength(1)
    // Across the line breaks JSX and Markdown put inside a sentence.
    expect(unqualifiedSentences('It removes\n   at least half\n   of your tool text.')).toHaveLength(1)
    // Named in the same sentence.
    expect(unqualifiedSentences('Under Legacy it removes at least half of your tool text.')).toEqual([])
    expect(unqualifiedSentences('That was the v1.34 measurement, which removed 51% fewer tokens.')).toEqual([])
    expect(unqualifiedSentences('The holdout keeps the old behavior and removes at least half of your tool text.')).toEqual([])
    // A neighbouring sentence, or a label that names Legacy, does not excuse the one after it.
    expect(unqualifiedSentences('That was the v1.34 measurement. It removed 51% fewer tokens.')).toHaveLength(1)
    expect(unqualifiedSentences('- **Shorten tool results: Late or Legacy.** It removes at least half of your tool text, every time.')).toHaveLength(1)
    expect(unqualifiedSentences('That was Legacy. Nothing else here. It removes at least half of your tool text.')).toHaveLength(1)
    expect(unqualifiedSentences('Late shortens a result from 40,000 characters.')).toEqual([])
  })

  // The guide and the privacy policy are lists of bullets. A bullet starts with "- ", which is not a capital or an opener, so a
  // promise that ended one bullet used to join the first sentence of the next, and the Legacy or holdout named in that next
  // bullet's label excused it. These are the three the round-3 verifier planted, and the lines around them.
  it('and a bullet, a heading or a paragraph that follows does not excuse the promise that ends the one before it', () => {
    const promise = 'Termpolis removes at least half of your tool text every time.'
    // Before a bullet labelled with the holdout, before one labelled with Legacy, and as the last sentence of a bullet.
    expect(unqualifiedSentences(`- **Savings.** ${promise}\n- **A holdout on your own work.** About one distinct opening message in ten always runs Legacy.`)).toHaveLength(1)
    expect(unqualifiedSentences(`- **Savings.** ${promise}\n- **Shorten tool results: Late or Legacy.** Since v1.55 the default is Late.`)).toHaveLength(1)
    expect(unqualifiedSentences(`- **Savings.** Nothing else here. ${promise}\n- **Shorten tool results: Late or Legacy.** Since v1.55 the default is Late.`)).toHaveLength(1)
    // A numbered list, a heading and a paragraph after a blank line are the same.
    expect(unqualifiedSentences(`1. ${promise}\n2. Under Legacy a tier sets the size.`)).toHaveLength(1)
    expect(unqualifiedSentences(`${promise}\n\n## Legacy\n\nUnder Legacy a tier sets the size.`)).toHaveLength(1)
    expect(unqualifiedSentences(`${promise}\n\nthe holdout keeps the old behavior.`)).toHaveLength(1)
    // The same bullets pass when the promise names its policy itself, and a sentence wrapped over lines is still one sentence.
    expect(unqualifiedSentences(`- **Savings.** Under Legacy ${promise.toLowerCase()}\n- **A holdout on your own work.** About one in ten runs Legacy.`)).toEqual([])
    expect(unqualifiedSentences('- **Savings.** It removes\n  at least half\n  of your tool text, under Legacy.\n- **Other.** Something else.')).toEqual([])
    expect(unqualifiedSentences('- **Savings.** It removes\n  at least half\n  of your tool text.\n- **Other.** Under Legacy, something else.')).toHaveLength(1)
  })

  // The words the promise came in other than the ones above: "half your", "halves", "in half" read the same to a person.
  it('and it holds the paraphrases of the old promise too: half your, halves, in half', () => {
    expect(unqualifiedSentences('Termpolis removes half your tool text, every time.')).toHaveLength(1)
    expect(unqualifiedSentences('Termpolis halves your tool text on every request.')).toHaveLength(1)
    expect(unqualifiedSentences('It cuts what tools print in half, on every request.')).toHaveLength(1)
    expect(unqualifiedSentences('Under Legacy it halves your tool text on every request.')).toEqual([])
    // A bare "half" is not a promise ("the oldest half" of a conversation ages out), so it is not one of the words.
    expect(unqualifiedSentences('Age the oldest half of a long conversation down to stubs.')).toEqual([])
  })

  it('and the renderer reading is not vacuous: a heading in one element is not excused by the Legacy of the next', () => {
    const jsx = "export const A = () => (<div><h4>Claude Code compression proxy: saves 51% fewer tokens, always</h4><p>Under Legacy a tier sets the size.</p></div>)"
    const pieces = readableText(jsx, 'a.tsx')
    expect(pieces).toEqual(['Claude Code compression proxy: saves 51% fewer tokens, always', 'Under Legacy a tier sets the size.'])
    expect(pieces.flatMap(unqualifiedSentences)).toEqual(['Claude Code compression proxy: saves 51% fewer tokens, always'])
    // A string, a template and a template with a hole are all read.
    const code = "const a = 'It removes at least half of your tool text.'; const b = `Saves 51% fewer tokens`; const c = `Saves ${n} and removes 50 percent of your tool text`"
    expect(readableText(code, 'b.ts').flatMap(unqualifiedSentences)).toHaveLength(3)
    // Code that is not text is not read: an identifier or a comment that spells a word of the promise is not a claim.
    expect(readableText('// removes at least half of your tool text\nconst atLeastHalf = 1', 'c.ts')).toEqual([])
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

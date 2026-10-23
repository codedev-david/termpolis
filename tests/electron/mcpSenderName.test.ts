import { describe, it, expect } from 'vitest'
import { senderKey } from '../../src/main/mcpServer'
import lookalikes from '../fixtures/senderLookalikes.json'

// BEH-4: a swarm message's sender is told from Termpolis's own system and from the conductor by how
// its name reads, a character Unicode's confusables list as drawn like one of their letters read as
// that letter, whatever its script. Lookalikes in other scripts than Cyrillic, Greek and Armenian
// (Lisu's ꓢꓬꓢꓔꓰꓟ, Cherokee's ꮪꮍꮪꭲꭼꮇ) were filed as themselves, and read like Termpolis's own
// sender in the Messages tab, and so were the symbols it lists (⊤ like T, ∪ like U: M-1). Every code
// point is read here, against the list in the fixture.

const drawnAs = new Map<string, string>()
for (const [letter, rows] of Object.entries(lookalikes.lookalikes)) {
  for (const [cp] of rows) drawnAs.set(String.fromCodePoint(parseInt(cp, 16)), letter)
}

describe('senderKey', () => {
  it("reads as its letter every character Unicode's confusables 18.0.0 list as drawn like a letter of system or conductor, symbols among them", () => {
    expect(lookalikes.version).toBe('18.0.0')
    expect(drawnAs.size).toBe(267)
    expect([...drawnAs].filter(([c, letter]) => senderKey(c) !== letter)).toEqual([])
  })

  it('reads every other character as itself, lowercased', () => {
    const wrong: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const c = String.fromCodePoint(cp)
      if (!drawnAs.has(c) && senderKey(c) !== c.toLowerCase()) wrong.push(cp.toString(16))
    }
    expect(wrong).toEqual([])
  })

  it('reads rn as m, which the list gives as drawn like it, in any case', () => {
    expect(senderKey('rn')).toBe('m')
    expect(senderKey('RN')).toBe('m')
    expect(senderKey('Systern')).toBe('system')
    expect(senderKey('sysrntern')).toBe('sysmtem')
    expect(senderKey('r n')).toBe('r n')
    expect(senderKey('nr')).toBe('nr')
  })

  it('reads a name once, before lowercasing it', () => {
    // Greek Μ is drawn like M, and lowercased into μ, drawn like none of these.
    expect(senderKey('SYSTE\u039c')).toBe('system')
    // Σ is drawn like none of these, and lowercased into σ, drawn like o.
    expect(senderKey('C\u03a3NDUCT\u03a3R')).toBe('c\u03c3nduct\u03c3r')
  })
})

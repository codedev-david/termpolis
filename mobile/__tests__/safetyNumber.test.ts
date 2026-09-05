import { deriveVerificationPhrase, PHRASE_WORDS } from '../src/wire/safetyNumber'
import { SAFETY_WORDS } from '../src/wire/wordlist'

const DESKTOP_ID_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const DEVICE_ID_PK = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
const GOLDEN = 'hurdle desert ember kelp velvet tundra thicket pebble'

describe('SAFETY_WORDS', () => {
  it('has exactly 256 entries so every digest byte maps without a modulo', () => {
    expect(SAFETY_WORDS).toHaveLength(256)
  })

  it('has no duplicates, so two digests cannot render the same phrase', () => {
    expect(new Set(SAFETY_WORDS).size).toBe(256)
  })

  it('holds only lowercase ASCII letters, so the words survive being read aloud', () => {
    for (const w of SAFETY_WORDS) expect(w).toMatch(/^[a-z]+$/)
  })
})

describe('deriveVerificationPhrase', () => {
  it('matches the golden vector', () => {
    expect(deriveVerificationPhrase(DESKTOP_ID_PK, DEVICE_ID_PK)).toBe(GOLDEN)
  })

  it('is identical in either order', () => {
    // The sort is what lets both ends render the same words without agreeing on
    // who is "first" -- neither end can know that.
    expect(deriveVerificationPhrase(DEVICE_ID_PK, DESKTOP_ID_PK)).toBe(GOLDEN)
  })

  it('is eight words', () => {
    expect(GOLDEN.split(' ')).toHaveLength(8)
    expect(PHRASE_WORDS).toBe(8)
    expect(deriveVerificationPhrase(DESKTOP_ID_PK, DEVICE_ID_PK).split(' ')).toHaveLength(8)
  })

  it('changes completely when one key changes by one bit', () => {
    const flipped = DEVICE_ID_PK.slice(0, 63) + '1'
    expect(deriveVerificationPhrase(DESKTOP_ID_PK, flipped)).not.toBe(GOLDEN)
  })

  it('draws every word from the wordlist', () => {
    for (const w of deriveVerificationPhrase(DESKTOP_ID_PK, DEVICE_ID_PK).split(' ')) {
      expect(SAFETY_WORDS).toContain(w)
    }
  })
})

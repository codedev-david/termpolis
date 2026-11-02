// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { LATE_FLOOR_CHARS } from '../../src/main/headroom/elisionPolicy'
import { MIN_SAMPLES, UNITS_PER_KEPT_TOKEN, ASSUMED_TURN_UNITS, MIN_TURNS_MEASURED, CHARS_PER_TOKEN } from '../../src/main/headroom/elisionHealth'
import { MIN_ARM_GROUPS } from '../../src/main/headroom/armCompare'
import { DECAY_FIRST_THRESHOLD } from '../../src/main/headroomProxy/prefixDecay'
import { CCR_MAX_BYTES } from '../../src/main/headroom/ccrStore'

/**
 * The renderer cannot import the main process, so the Elision health card and the Token Savings pane keep
 * their own copies of the few numbers they quote: the size from which Late shortens a result, the samples a
 * class needs before it is judged, the price of a kept token, the groups a comparison needs, the message the
 * ageing-out pass waits for, the cap on the stash. A copy that is not held to its original goes on quoting
 * the old number after the original moves. This reads each copy out of the renderer's source and compares it
 * with the constant it mirrors.
 */

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'SettingsPane')
const card = readFileSync(join(RENDERER, 'ElisionHealthCard.tsx'), 'utf8')
const pane = readFileSync(join(RENDERER, 'TokenSavingsSettings.tsx'), 'utf8')

/** The literal a renderer file gives a top-level `const NAME = <literal>`. */
function literal(src: string, name: string): string {
  const m = new RegExp(`^const ${name} = (.+?)\\s*(?://.*)?$`, 'm').exec(src)
  expect(m, `${name} is not declared in the file`).not.toBeNull()
  return (m as RegExpExecArray)[1]
}
const text = (src: string, name: string): string => literal(src, name).replace(/^'|'$/g, '')
const num = (src: string, name: string): number => Number(literal(src, name))

describe('the renderer quotes the numbers the main process uses', () => {
  const thousands = LATE_FLOOR_CHARS.toLocaleString('en-US')

  it('the size from which Late shortens a result, in the card and in the pane', () => {
    expect(thousands).toBe('40,000')
    expect(text(card, 'LATE_FLOOR')).toBe(thousands)
    expect(text(pane, 'LATE_FLOOR')).toBe(thousands)
  })

  it('the samples a class needs, the price of a kept token and the groups a comparison needs', () => {
    expect(num(card, 'MIN_SAMPLES')).toBe(MIN_SAMPLES)
    expect(num(card, 'UNITS_PER_KEPT_TOKEN')).toBe(UNITS_PER_KEPT_TOKEN)
    expect(num(card, 'MIN_ARM_GROUPS')).toBe(MIN_ARM_GROUPS)
  })

  it('what a retrieval turn is charged until some have been measured, how many that takes, and characters to a token', () => {
    // These three are quoted in the card as plain text in the estimate note and beside the turns, so a change
    // to the model has to reach the words.
    expect(num(card, 'ASSUMED_TURN_UNITS')).toBe(ASSUMED_TURN_UNITS)
    expect(num(card, 'MIN_TURNS_MEASURED')).toBe(MIN_TURNS_MEASURED)
    expect(num(card, 'CHARS_PER_TOKEN')).toBe(CHARS_PER_TOKEN)
  })

  it('the card uses them where it states them, and does not write the numbers a second time', () => {
    expect(card).toContain('{fmt(ASSUMED_TURN_UNITS)}')
    expect(card).toContain('{MIN_TURNS_MEASURED}')
    expect(card).toContain('{CHARS_PER_TOKEN} characters to a token')
    for (const stale of ['16,800', 'seen 20', 'four characters', '1,600 characters']) expect(card, stale).not.toContain(stale)
  })

  it('the message the ageing-out pass waits for', () => {
    expect(num(card, 'DECAY_FIRST')).toBe(DECAY_FIRST_THRESHOLD)
  })

  it('the cap on the stash, in megabytes', () => {
    expect(num(pane, 'CCR_CAP_MB')).toBe(CCR_MAX_BYTES / 1024 / 1024)
  })

  it('and the reader that finds them finds them: a name that is not there fails loudly rather than reading nothing', () => {
    expect(() => literal(card, 'NOT_A_CONSTANT_ANYWHERE')).toThrow()
  })
})

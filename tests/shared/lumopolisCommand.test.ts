import { describe, expect, it } from 'vitest'
import {
  LUMOPOLIS_MAX_PAYLOAD,
  LUMOPOLIS_NONCE_ENV,
  LUMOPOLIS_OSC,
  lumopolisNoSuchFolder,
  lumopolisSequence,
  parseLumopolisPayload,
} from '../../src/shared/world/lumopolisCommand'

const N = '0123456789abcdef0123456789abcdef'

describe('the lumopolis wire format', () => {
  it('builds the exact sequence a shell prints', () => {
    expect(LUMOPOLIS_OSC).toBe(7377)
    expect(LUMOPOLIS_NONCE_ENV).toBe('TERMPOLIS_LUMOPOLIS_NONCE')
    expect(lumopolisSequence(N, '/home/me/repo')).toBe(`\x1b]7377;lumopolis;${N};/home/me/repo\x07`)
    expect(lumopolisNoSuchFolder('nope')).toBe('lumopolis: no such folder: nope')
  })

  it('reads a valid payload, keeping a folder that contains semicolons', () => {
    expect(parseLumopolisPayload(`lumopolis;${N};C:\\Users\\me\\repo`)).toEqual({ nonce: N, path: 'C:\\Users\\me\\repo' })
    expect(parseLumopolisPayload(`lumopolis;${N};/a;b/c`)).toEqual({ nonce: N, path: '/a;b/c' })
  })

  it('ignores a malformed payload', () => {
    for (const bad of [
      undefined,
      42,
      '',
      'lumopolis',
      `other;${N};/x`,
      'lumopolis;/x',
      `lumopolis;${N}`,
      'lumopolis;NOTHEX0123456789abcdef0123456789;/x',
      `lumopolis;${N.toUpperCase()};/x`,
      `lumopolis;${N};`,
      `lumopolis;${N};   `,
      `lumopolis;${N};/x\x1b]0;evil`,
      `lumopolis;${N};/x\x7f`,
    ]) expect(parseLumopolisPayload(bad)).toBeNull()
  })

  it('refuses an over-long payload unread', () => {
    const head = `lumopolis;${N};/`
    expect(parseLumopolisPayload(head + 'a'.repeat(LUMOPOLIS_MAX_PAYLOAD - head.length))).not.toBeNull()
    expect(parseLumopolisPayload(head + 'a'.repeat(LUMOPOLIS_MAX_PAYLOAD - head.length + 1))).toBeNull()
  })
})

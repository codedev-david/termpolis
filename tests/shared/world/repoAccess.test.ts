import { describe, expect, it } from 'vitest'
import {
  TOKEN_EMPTY_MESSAGE,
  TOKEN_FORMAT_MESSAGE,
  TOKEN_MAX_LENGTH,
  TOKEN_REJECTED_MESSAGE,
  TOKEN_TOO_LONG_MESSAGE,
  hideValue,
  normalizeToken,
  type RepoAccess,
  type RepoLogin
} from '../../../src/shared/world/repoAccess'

describe('normalizeToken', () => {
  it('trims a leading or trailing space or line break', () => {
    expect(normalizeToken('  ghp_abc\n')).toEqual({ ok: true, value: 'ghp_abc' })
    expect(normalizeToken('\tghp_abc\r\n')).toEqual({ ok: true, value: 'ghp_abc' })
    expect(normalizeToken('ghp_abc')).toEqual({ ok: true, value: 'ghp_abc' })
  })

  it('refuses a space, tab, line break or control character inside it', () => {
    for (const raw of ['ghp_a bc', 'ghp_a\nbc', 'ghp_a\tbc', 'ghp_a\rbc', 'ghp_a\x00bc', 'ghp_a\x1fbc', 'ghp_a\x7fbc', 'ghp_a bc', ' ghp_a b\n']) {
      expect(normalizeToken(raw)).toEqual({ ok: false, error: TOKEN_FORMAT_MESSAGE })
    }
  })

  it('refuses nothing at all, only spaces, and anything that is not text', () => {
    for (const raw of ['', '   ', '\n\t\r', 42, null, undefined, {}, ['ghp_abc']]) {
      expect(normalizeToken(raw)).toEqual({ ok: false, error: TOKEN_EMPTY_MESSAGE })
    }
  })

  it('takes up to 4096 characters after trimming, and refuses more', () => {
    expect(TOKEN_MAX_LENGTH).toBe(4096)
    const max = 'a'.repeat(4096)
    expect(normalizeToken(max)).toEqual({ ok: true, value: max })
    expect(normalizeToken(`  ${max}\n`)).toEqual({ ok: true, value: max })
    expect(normalizeToken('a'.repeat(4097))).toEqual({ ok: false, error: TOKEN_TOO_LONG_MESSAGE })
  })

  it('says what went wrong in plain words', () => {
    expect(TOKEN_FORMAT_MESSAGE).toBe('That token has a space or line break inside it. Copy it again and paste only the token.')
    expect(TOKEN_EMPTY_MESSAGE).toBe('Paste a token first.')
    expect(TOKEN_REJECTED_MESSAGE).toBe("That token didn't open the repository. Check that it hasn't expired and can read this repository, then try again.")
    expect(TOKEN_TOO_LONG_MESSAGE).toBe('That is longer than any token. Copy it again and paste only the token.')
  })

  it('the request and registry shapes', () => {
    const asks: RepoAccess[] = [{ mode: 'machine' }, { mode: 'token', value: 'v' }]
    const kept: RepoLogin[] = ['machine', 'token']
    expect(asks.map((a) => a.mode)).toEqual(kept)
  })
})

describe('hideValue', () => {
  const v = 'tv-' + 'Q7'.repeat(20)

  it('replaces every copy of the value', () => {
    const out = hideValue('x ' + v + ' y ' + v, v)
    expect(out).toBe('x [hidden] y [hidden]')
    expect(out).not.toContain(v)
  })

  it('takes the value literally, never as a pattern', () => {
    expect(hideValue('a.b*c and axbbc', 'a.b*c')).toBe('[hidden] and axbbc')
  })

  it('also redacts anything shaped like a key, as the app log does', () => {
    const shaped = 'ghp_' + 'A1'.repeat(15)
    const out = hideValue(`fatal: ${shaped} and ${v}`, v)
    expect(out).not.toContain(shaped)
    expect(out).toContain('<redacted-token>')
    expect(out).toContain('[hidden]')
  })

  it('an empty value hides nothing and leaves the text whole', () => {
    expect(hideValue('plain text', '')).toBe('plain text')
  })
})

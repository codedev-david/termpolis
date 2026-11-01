// The key detectors (src/main/keyMaterial.ts) on their own, before screenText uses them: a private
// key in every format is removed whole however an answer writes its lines (T1), everything that
// only looks like a key is left byte for byte (T2), and the recall bugs the prototype's probes found
// stay fixed (T5). Every key is made fresh in memory (fixtures/freshKeys.ts) and never printed; a
// synthetic body ('Ab'.repeat, 'Q'.repeat) only ever shows what is NOT removed.
import { describe, it, expect, beforeAll } from 'vitest'
import * as crypto from 'crypto'
import { createHash, generateKeyPairSync, randomBytes } from 'crypto'
import {
  decodeHead,
  detectorStart,
  encodedKeys,
  headless,
  jwkKeys,
  keyBlocks,
  keySpans,
  LINE_END_RUN,
  looksRandom,
  opensshHeader,
  partialLine,
  percentEncoded,
  pgpPacket,
  placeholderWhy,
  proseEnds,
  puttyKeys,
  rsaKeyValues,
  shortAbove,
  structureOf,
  type KeySpan,
} from '../../src/main/keyMaterial'
import { COST_SHAPES } from './fixtures/costShapes'
import { JOIN, T1_JOININGS, der, leakedWindows, makeKeys, pgpPhotoExport, pgpRsaBody, secretLinesOf, shownWhole, ssh2Key, wrap, type Format, type KeySet } from './fixtures/freshKeys'

/** What a screen makes of `text` with the detectors alone (screenText adds the token rules): the
 *  removed spans merged and replaced by their markers, a JWK's or an RSAKeyValue's members counted
 *  once, and the flags no removal covers. `keep`: only the end is kept, as linkedJobs keeps an
 *  answer's; `cutStart`: the text is an end an older doing computer cut. */
function screenKeys(text: string, opts: { keep?: number; cutStart?: boolean } = {}): { text: string; removed: Record<string, number>; flagged: Record<string, number>; spans: KeySpan[] } {
  const from = opts.keep !== undefined && text.length > opts.keep ? text.length - opts.keep : 0
  const start = detectorStart(text, from, 4096)
  const { blocks, spans } = keySpans(text, start, opts.cutStart === true)
  const straddled = spans.some((c) => c.cls === 'remove' && c.from < from && c.to > from)
  const cutAt = opts.cutStart ? 0 : from > 0 && !straddled ? from : undefined
  for (const s of headless(text, blocks, { start, ...(cutAt === undefined ? {} : { cutAt }) })) spans.push(s)
  const cuts = spans.filter((s) => s.cls === 'remove').sort((a, b) => a.from - b.from)
  const merged: KeySpan[] = []
  for (const c of cuts) {
    const last = merged[merged.length - 1]
    if (last && c.from < last.to) last.to = Math.max(last.to, c.to)
    else merged.push({ ...c })
  }
  let out = ''
  let at = from
  const removed: Record<string, number> = {}
  const groups = new Set<string>()
  for (const c of merged) {
    if (c.to <= from) continue
    out += text.slice(at, Math.max(at, c.from)) + `[REDACTED:${c.rule}]`
    at = Math.max(at, c.to)
    const key = c.group !== undefined ? `${c.rule}@${c.group}` : null
    if (!key || !groups.has(key)) removed[c.rule] = (removed[c.rule] ?? 0) + 1
    if (key) groups.add(key)
  }
  out += text.slice(at)
  const flagged: Record<string, number> = {}
  for (const f of spans) {
    if (f.cls === 'flag' && f.to > from && !merged.some((c) => c.from < f.to && c.to > f.from)) flagged[f.rule] = (flagged[f.rule] ?? 0) + 1
  }
  return { text: out, removed, flagged, spans }
}

/** The rule each format's BEGIN line names in a marker, and what decided it. */
const EXPECT: Record<Format, [string, string]> = {
  pkcs8_rsa: ['private_key', 'pkcs8-complete'],
  pkcs8_ec: ['private_key', 'pkcs8-complete'],
  pkcs8_ed25519: ['private_key', 'pkcs8-complete'],
  enc_pkcs8: ['private_key', 'encrypted-pkcs8-complete'],
  pkcs1_rsa: ['private_key', 'pkcs1-or-dsa-complete'],
  rsa_legacy_enc: ['private_key', 'pem-encrypted-headers'],
  sec1_ec: ['private_key', 'sec1-complete'],
  openssh: ['private_key', 'openssh'],
  dsa: ['ssh_dsa_pubkey', 'pkcs1-or-dsa-complete'],
  pgp_rsa_hdr: ['gpg_block', 'pgp'],
  pgp_rsa_nohdr: ['gpg_block', 'pgp'],
  pgp_ed_hdr: ['gpg_block', 'pgp'],
  pgp_ed_nohdr: ['gpg_block', 'pgp'],
  ssh2: ['ssh2_private_key', 'ssh2'],
  ssh2_real: ['ssh2_private_key', 'ssh2'],
  openvpn: ['openvpn_static_key', 'openvpn-hex'],
}
const FORMATS = Object.keys(EXPECT) as Format[]
/** A key file's last base64 line (the checksum excluded). */
const lastLine = (ls: string[]): string => ls.filter((l) => /^[A-Za-z0-9+/]+=*$/.test(l) && !l.startsWith('=')).pop() as string
/** The base64 lines of a PEM file between its BEGIN and END lines, joined. */
const bodyOf = (ls: string[]): string => ls.slice(1, -1).join('')

let K: KeySet
beforeAll(() => {
  K = makeKeys()
})

describe('T1 K1-K3: a key block, recognised by what its bytes decode to', () => {
  for (const format of FORMATS) {
    it(`${format}: removed whole in the 20 joinings, with its END line and without`, () => {
      const [rule, why] = EXPECT[format]
      const lines = K.F[format]
      // what decided, on the file as it is
      expect(keyBlocks(lines.join('\n')).map((b) => [b.rule, b.cls, b.why])).toEqual([[rule, 'remove', why]])
      for (const jn of T1_JOININGS) {
        for (const withEnd of [true, false]) {
          const label = `${format}/${jn}/${withEnd ? 'END' : 'no END'}`
          const ls = withEnd ? lines : lines.slice(0, -1)
          const input = 'Answer follows.\n' + JOIN[jn](ls) + '\nThat was the file.'
          const r = screenKeys(input)
          expect(leakedWindows(r.text, secretLinesOf(ls)), label).toBe(0)
          expect(r.removed, label).toEqual({ [rule]: 1 })
          expect(r.text.startsWith('Answer follows.') && r.text.endsWith('That was the file.'), label).toBe(true)
          // the short last line, under the 12 characters the windows measure
          const tail = lastLine(ls)
          if (tail.length < 12) expect(shownWhole(r.text, tail), label).toBe(false)
          // the asking computer screens what arrives again: nothing more is taken
          expect(screenKeys(r.text).removed, label).toEqual({})
        }
      }
    })
  }

  it('takes a DER key cut short before its END line, and an excerpt of a real key, and flags a one-line example', () => {
    const p8 = K.F.pkcs8_rsa
    // cut short: no END line, half the key
    const half = [p8[0], ...p8.slice(1, 14)]
    expect(keyBlocks(half.join('\n')).map((b) => [b.cls, b.why])).toEqual([['remove', 'pkcs8-prefix']])
    // an excerpt: the head, five lines, an elision, the END line
    const frag = [p8[0], ...p8.slice(1, 6), '...', p8[p8.length - 1]]
    const r = screenKeys(frag.join('\n'))
    expect(r.spans.filter((s) => s.cls === 'remove').map((s) => s.why)).toEqual(['pkcs8-incomplete'])
    expect(leakedWindows(r.text, p8.slice(1, 6))).toBe(0)
    // one line of a real key, with its END line: a documentation example, not a key
    const one = [p8[0], p8[1], '...', p8[p8.length - 1]].join('\n')
    expect(keyBlocks(one).map((b) => [b.cls, b.why])).toEqual([['flag', 'pkcs8-example']])
    // an OpenSSH key's first two lines, with its END line: too short for its own structure (128)
    const os = K.F.openssh
    expect(keyBlocks([os[0], os[1], '...', os[os.length - 1]].join('\n')).map((b) => [b.cls, b.why])).toEqual([['flag', 'openssh-example']])
  })

  it('takes a key written on one line after its headers, its last short line too', () => {
    const pgp = K.F.pgp_rsa_hdr
    const text = `KEY="${pgp.join(' ')}"`
    const r = screenKeys(text)
    expect(r.removed).toEqual({ gpg_block: 1 })
    expect(leakedWindows(r.text, secretLinesOf(pgp))).toBe(0)
  })

  it('takes a key in an ED25519 kind, a kind of up to three words', () => {
    const ed = K.F.pkcs8_ed25519.map((l) => l.replace(' PRIVATE KEY-----', ' ED25519 PRIVATE KEY-----'))
    expect(screenKeys(ed.join('\n')).removed).toEqual({ private_key: 1 })
    const three = K.F.pkcs8_rsa.map((l) => l.replace(' PRIVATE KEY-----', ' A B C PRIVATE KEY-----'))
    expect(screenKeys(three.join('\n')).removed).toEqual({ private_key: 1 })
  })

  it('takes two keys one after the other, the first cut short, each whole', () => {
    const a = K.F.pkcs1_rsa
    const b = K.F.sec1_ec
    const text = [a[0], ...a.slice(1, 10), b[0], ...b.slice(1)].join('\n')
    const r = screenKeys(text)
    expect(r.removed).toEqual({ private_key: 2 })
    expect(leakedWindows(r.text, [...a.slice(1, 10), ...secretLinesOf(b)])).toBe(0)
  })
})

describe('T1 K4: a key tail with its END line, its BEGIN line out of view', () => {
  it('at the top of what is screened: the text starts inside the key', () => {
    const p8 = K.F.pkcs8_rsa
    for (const jn of ['lf', 'java_concat', 'cat_n', 'docker_t', 'rg_win']) {
      const body = JOIN[jn](p8)
      const at = body.indexOf('\n', Math.floor(body.length / 2)) + 1
      const text = body.slice(at) + '\nThe deploy finished.'
      const tail = secretLinesOf(p8).filter((l) => text.includes(l.slice(-12)))
      const r = screenKeys(text)
      expect(r.removed, jn).toEqual({ private_key: 1 })
      expect(r.spans.filter((s) => s.cls === 'remove').map((s) => s.why), jn).toEqual(['tail-with-end'])
      expect(leakedWindows(r.text, tail), jn).toBe(0)
      expect(r.text.endsWith('The deploy finished.'), jn).toBe(true)
    }
  })

  it('right under a key block taken: the frame changed halfway down the key', () => {
    const p8 = K.F.pkcs8_rsa
    // a reply that quotes the BEGIN line and the first ten lines, and not the rest
    const text = ['Key:', `> ${p8[0]}`, ...p8.slice(1, 11).map((l) => `> ${l}`), ...p8.slice(11), 'Done.'].join('\n')
    const r = screenKeys(text)
    expect(r.spans.filter((s) => s.cls === 'remove').map((s) => s.why)).toEqual(['pkcs8-prefix', 'tail-with-end'])
    expect(leakedWindows(r.text, secretLinesOf(p8))).toBe(0)
    expect(r.text.startsWith('Key:') && r.text.endsWith('Done.')).toBe(true)
  })

  it('at the start of a text another computer cut: a few characters of key above the END line are enough', () => {
    const last = lastLine(K.F.pkcs8_rsa)
    const kept = last.slice(-20)
    const text = `…${kept}\n-----END PRIVATE KEY-----\nThe deploy finished.`
    // with cutStart: the 20 characters go with the END line, the ellipsis stays
    const cut = screenKeys(text, { cutStart: true })
    expect(cut.text).toBe('…[REDACTED:private_key]\nThe deploy finished.')
    expect(cut.spans.filter((s) => s.cls === 'remove').map((s) => s.why)).toEqual(['cut-tail-with-end'])
    // not cut by anyone: one line of 20 characters above an END line is not a key's tail
    expect(screenKeys(text).removed).toEqual({})
    // 16 characters are enough, and fewer are not, even then
    expect(screenKeys(`…${last.slice(-16)}\n-----END PRIVATE KEY-----\n`, { cutStart: true }).text).toBe('…[REDACTED:private_key]\n')
    for (const n of [15, 12]) expect(screenKeys(`…${last.slice(-n)}\n-----END PRIVATE KEY-----\n`, { cutStart: true }).removed, String(n)).toEqual({})
  })

  it("at the start of a text another computer cut, a report's last words above an END line named in prose are no key's tail", () => {
    // lnk3's F2: each line of a report ends in the same 8-character word, one width and one frame
    // from the top of the text down to the END line its summary names. Taken for a key's tail,
    // the whole report went. A key's full lines are a payload run wide at least.
    const report = Array.from({ length: 40 }, (_, i) => `test ${String(i).padStart(4, '0')} passed: parsePem accepts header ${i % 7} and rejects malformed input as expected`).join('\n')
    const text = `${report.slice(25)}\nSummary: nothing ends with \`-----END RSA PRIVATE KEY-----\`. All checks passed.`
    expect(headless(text, [], { cutAt: 0 })).toEqual([])
    expect(screenKeys(text, { cutStart: true })).toMatchObject({ text, removed: {}, flagged: {} })
    // Random lines 16 characters wide, a payload run, are a key's lines there; 15 wide, they are not.
    const lines = (w: number): string => wrap(randomBytes(150).toString('base64').replace(/=+$/, ''), w).slice(0, 9).join('\n')
    expect(screenKeys(`${lines(16)}\n-----END PRIVATE KEY-----\nok`, { cutStart: true }).text).toBe('[REDACTED:private_key]\nok')
    const narrow = `${lines(15)}\n-----END PRIVATE KEY-----\nok`
    expect(screenKeys(narrow, { cutStart: true }).text).toBe(narrow)
  })

  it('at the start of a text another computer cut, a run of key lines with no END line below is flagged, not removed', () => {
    const p8 = K.F.pkcs8_rsa
    const text = p8.slice(5, 15).join('\n') + '\nThe deploy finished.'
    const r = screenKeys(text, { cutStart: true })
    expect(r.text).toBe(text)
    expect(r.flagged).toEqual({ private_key: 1 })
    expect(r.spans.map((s) => s.why)).toEqual(['cut-start-run'])
  })

  it('an older doing computer cut inside a docker -t timestamp: still taken from its END line', () => {
    const p8 = K.F.pkcs8_rsa
    const text = 'Key:\n' + JOIN.docker_t(p8) + '\nDone.\n'
    let at = -1
    for (let i = 0, p = 0; i < 6; i++) p = at = text.indexOf('2026-10-18T', p + 1)
    at += 6
    const tail = secretLinesOf(p8).filter((l) => text.slice(at).includes(l.slice(-12)))
    const r = screenKeys('…' + text.slice(at), { cutStart: true })
    expect(leakedWindows(r.text, tail)).toBe(0)
    expect(r.removed).toEqual({ private_key: 1 })
  })

  it('an older doing computer cut at half, 93% and 97% of a key: the end that arrived is removed from its END line', () => {
    const p8 = K.F.pkcs8_rsa
    for (const jn of ['lf', 'java_concat', 'cat_n', 'docker_t']) {
      const body = JOIN[jn](p8)
      for (const frac of [0.5, 0.93, 0.97]) {
        const at = Math.floor(body.length * frac)
        const arrived = '…' + body.slice(at) + '\nThe deploy finished.\n'
        const tail = secretLinesOf(p8).filter((l) => body.slice(at).includes(l.slice(-12)))
        const r = screenKeys(arrived, { cutStart: true })
        expect(leakedWindows(r.text, tail), `${jn} ${frac}`).toBe(0)
        expect(r.removed, `${jn} ${frac}`).toEqual({ private_key: 1 })
      }
    }
  })

  it('names the tail by its END line: PGP and SSH2 tails keep their own ids', () => {
    const pgp = K.F.pgp_rsa_nohdr
    const fromMiddle = pgp.slice(Math.floor(pgp.length / 2)).join('\n')
    expect(screenKeys(fromMiddle).removed).toEqual({ gpg_block: 1 })
    const ssh2 = K.F.ssh2
    expect(screenKeys(ssh2.slice(4).join('\n')).removed).toEqual({ ssh2_private_key: 1 })
  })
})

describe('T1 K5: a key file stored base64 encoded', () => {
  it('removes the 9 forms: a Kubernetes tls.key in YAML and JSON, wrapped, listed, escaped, and SSH2 and PuTTY files', () => {
    const forms: Array<[string, string, string[]]> = [
      ['k8s tls.key, -o yaml', `apiVersion: v1\nkind: Secret\ndata:\n  tls.key: ${K.k8s.plain}\n`, [K.k8s.plain]],
      ['EC PARAMETERS first (openssl ecparam)', `data:\n  tls.key: ${K.k8s.ecParamsFirst}\n`, [K.k8s.ecParamsFirst]],
      ['-o json', `{"data":{"tls.key":"${K.k8s.ecParamsFirst}"}}`, [K.k8s.ecParamsFirst]],
      ['Bag Attributes first (pkcs12 -nodes)', `data:\n  tls.key: ${K.k8s.bagAttributes}\n`, [K.k8s.bagAttributes]],
      ['Helm values, GNU base64 at 76, indented 4', `tls:\n  key: |\n${wrap(K.k8s.plain, 76).map((l) => `    ${l}`).join('\n')}\n`, wrap(K.k8s.plain, 76)],
      ['GNU base64 at 76 behind cat -n', wrap(K.k8s.plain, 76).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'), wrap(K.k8s.plain, 76)],
      ['base64 at 64 in \\n escapes', `{"key":"${wrap(K.k8s.plain, 64).join('\\n')}"}`, wrap(K.k8s.plain, 64)],
      ['an SSH2 file', `blob: ${Buffer.from(K.F.ssh2.join('\n')).toString('base64')}\n`, [Buffer.from(K.F.ssh2.join('\n')).toString('base64')]],
      ['a PuTTY file', `blob: ${Buffer.from(K.ppk.join('\n')).toString('base64')}\n`, [Buffer.from(K.ppk.join('\n')).toString('base64')]],
    ]
    for (const [name, text, secret] of forms) {
      const r = screenKeys(text)
      expect(r.removed, name).toEqual({ private_key_b64: 1 })
      expect(leakedWindows(r.text, secret.filter((l) => l.length >= 8)), name).toBe(0)
    }
  })

  it('leaves a base64 certificate, a base64 template with a made-up body, and a header constant', () => {
    const cert = Buffer.from(['-----BEGIN CERTIFICATE-----', ...wrap(randomBytes(600).toString('base64')), '-----END CERTIFICATE-----', ''].join('\n')).toString('base64')
    const template = Buffer.from(['-----BEGIN PRIVATE KEY-----', ...Array.from({ length: 6 }, (_, i) => ('AbCdEfGhIjKlMnOpQrStUvWxYz' + String(i).padStart(4, '0')).repeat(3).slice(0, 64)), '-----END PRIVATE KEY-----', ''].join('\n')).toString('base64')
    for (const text of [`tls.crt: ${cert}\n`, `fixture: ${template}\n`, "const ONE = 'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCg=='\n"]) {
      const r = screenKeys(text)
      expect(r.text).toBe(text)
      expect(r.removed).toEqual({})
    }
    expect(encodedKeys(`fixture: ${template}\n`).map((s) => [s.cls, s.why])).toEqual([['flag', 'decoded:not-key-material']])
  })
})

describe('T1 K6: a PuTTY key file', () => {
  it('removes the private lines in the 7 forms: YAML, JSON, CR, trailing spaces, from Private-Lines on, cat -n, a diff', () => {
    const ppk = K.ppk
    const secret = secretLinesOf(ppk, true)
    const at = ppk.findIndex((l) => l.startsWith('Private-Lines'))
    const forms: Record<string, string> = {
      'indented in YAML': `deploy_ppk: |\n${ppk.map((l) => `  ${l}`).join('\n')}\n`,
      'a JSON string': `{"ppk":"${ppk.join('\\n')}"}`,
      'CR-joined': ppk.join('\r'),
      'trailing spaces': ppk.map((l) => l + '  ').join('\n'),
      'from Private-Lines on (sed -n)': ppk.slice(at).join('\n'),
      'behind cat -n': ppk.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'),
      'as a diff': ppk.map((l) => `+${l}`).join('\n'),
    }
    for (const [name, text] of Object.entries(forms)) {
      const r = screenKeys(text)
      expect(r.removed, name).toEqual({ putty_private_key: 1 })
      expect(leakedWindows(r.text, secret), name).toBe(0)
    }
    // the whole file from its first line to its MAC, in its own lines
    const whole = screenKeys(`Here:\n${ppk.join('\n')}\nDone.`)
    expect(whole.text).toBe('Here:\n[REDACTED:putty_private_key]\nDone.')
  })

  it('takes private lines written with no break, cut short, or behind a log prefix with words', () => {
    const ppk = K.ppk
    const at = ppk.findIndex((l) => l.startsWith('Private-Lines'))
    const priv = ppk.slice(at + 1, -1)
    // glued: the private lines run together on one line
    const glued = `${ppk[at]}\n${priv.join('')}\n${ppk[ppk.length - 1]}`
    expect(screenKeys(glued).removed).toEqual({ putty_private_key: 1 })
    // cut short: only three of the private lines arrived
    const short = [ppk[at], ...priv.slice(0, 3)].join('\n')
    expect(screenKeys(short).removed).toEqual({ putty_private_key: 1 })
    // a journal prefix on every line: words in the frame, not between the anchor and the lines
    const logged = ppk.map((l) => `Oct 18 12:00:01 build-box deploy[4242]: ${l}`).join('\n')
    const r = screenKeys(logged)
    expect(r.removed).toEqual({ putty_private_key: 1 })
    expect(leakedWindows(r.text, priv)).toBe(0)
  })

  it('leaves an excerpt, prose and a parser alone', () => {
    const h = (n: number): string => randomBytes(n).toString('base64')
    for (const text of [`Private-Lines: 14\n${h(36)}\n(the rest is elided)\n`, `The file says Private-Lines: 14 but I only see:\n${h(36)}\n${h(36)}\n`, 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\nPrivate-Lines: 1\n...']) {
      const r = screenKeys(text)
      expect(r.text).toBe(text)
      expect(r.removed).toEqual({})
    }
    expect(puttyKeys('Private-Lines: 0\n').map((s) => [s.cls, s.why])).toEqual([['flag', 'ppk 0/0']])
  })
})

describe('T1 K7: a JWK private member', () => {
  it('removes the values in the 8 forms, and leaves the object parseable', () => {
    const ec = K.J.ec
    const rsa = K.J.rsa
    const forms: Array<[string, string, string[]]> = [
      ['YAML', `jwk:\n  kty: EC\n  crv: P-256\n  x: ${ec.x}\n  y: ${ec.y}\n  d: ${ec.d}\n`, [ec.d as string]],
      ['YAML, quoted', `jwk:\n  kty: "EC"\n  crv: "P-256"\n  x: "${ec.x}"\n  y: "${ec.y}"\n  d: "${ec.d}"\n`, [ec.d as string]],
      ['TOML', `[jwk]\nkty = "EC"\ncrv = "P-256"\nx = "${ec.x}"\ny = "${ec.y}"\nd = "${ec.d}"\n`, [ec.d as string]],
      ['an RSA key with a nested oth member', JSON.stringify({ ...rsa, oth: [{ r: rsa.p, d: rsa.dp, t: rsa.qi }] }), [rsa.d, rsa.p, rsa.q, rsa.dp, rsa.dq, rsa.qi] as string[]],
      ['a JWK carrying a 20 KB x5c chain', JSON.stringify({ kty: 'EC', crv: 'P-256', x5c: Array.from({ length: 8 }, () => randomBytes(1900).toString('base64')), x: ec.x, y: ec.y, d: ec.d }), [ec.d as string]],
      ['escaped twice in JSON', JSON.stringify(JSON.stringify(JSON.stringify(ec))), [ec.d as string]],
      ['quotes as the JSON escape of a double quote', JSON.stringify(ec).replace(/"/g, '\\' + 'u0022'), [ec.d as string]],
      ['an oct key (an HS256 secret)', JSON.stringify(K.J.oct), [K.J.oct.k]],
    ]
    for (const [name, text, secret] of forms) {
      const r = screenKeys(text)
      expect(r.removed, name).toEqual({ jwk_private_key: 1 })
      expect(leakedWindows(r.text, secret), name).toBe(0)
    }
    // the values only: JSON stays JSON
    const okp = screenKeys(JSON.stringify(K.J.okp))
    expect(JSON.parse(okp.text)).toEqual({ ...K.J.okp, d: '[REDACTED:jwk_private_key]' })
  })

  it('judges a curve by its own size, and leaves a placeholder, a wrong size and a public key', () => {
    const ec = K.J.ec
    // an Ed448 d is 57 bytes; a P-256 one 32
    expect(jwkKeys(JSON.stringify({ kty: 'OKP', crv: 'Ed448', x: 'x', d: randomBytes(57).toString('base64url') })).map((s) => s.cls)).toEqual(['remove'])
    expect(jwkKeys(JSON.stringify({ kty: 'OKP', crv: 'Ed448', x: 'x', d: randomBytes(32).toString('base64url') })).map((s) => s.cls)).toEqual(['flag'])
    expect(jwkKeys(JSON.stringify({ kty: 'EC', crv: 'P-384', d: ec.d })).map((s) => s.cls)).toEqual(['flag'])
    expect(jwkKeys(JSON.stringify({ kty: 'EC', d: ec.d })).map((s) => s.cls)).toEqual(['remove'])
    for (const text of [
      JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'A'.repeat(43) }),
      JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'placeholder' }),
      JSON.stringify({ kty: 'oct', alg: 'HS256', k: 'your-256-bit-secret-goes-here' }),
      JSON.stringify({ kty: 'RSA', n: randomBytes(256).toString('base64url'), e: 'AQAB' }),
      JSON.stringify({ d: randomBytes(32).toString('base64url'), name: 'no kty' }),
      '{ kty: "EC", crv: "P-256", d: "REPLACE_WITH_PRIVATE_SCALAR" }',
    ]) {
      const r = screenKeys(text)
      expect(r.text).toBe(text)
      expect(r.removed).toEqual({})
    }
  })

  it('reads a curve name as data: `toString` or `constructor` is no curve and throws nothing', () => {
    for (const crv of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const text = JSON.stringify({ kty: 'EC', crv, d: randomBytes(32).toString('base64url') })
      expect(() => jwkKeys(text), crv).not.toThrow()
      expect(jwkKeys(text).map((s) => s.cls), crv).toEqual(['remove'])
      expect(() => jwkKeys(JSON.stringify({ kty: 'OKP', crv, d: randomBytes(32).toString('base64url') })), crv).not.toThrow()
    }
  })
})

describe('T1 K8: an RSAKeyValue private member', () => {
  it('removes the values in the 5 forms', () => {
    const xml = K.xml
    // every private member's value, in the base64 the XML writes
    const secret = (['d', 'p', 'q', 'dp', 'dq', 'qi'] as const).map((m) => Buffer.from(K.J.rsa[m] as string, 'base64url').toString('base64'))
    const forms: Record<string, string> = {
      'XML-escaped in appSettings': `<add key="SigningKey" value="${xml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}" />`,
      'the JSON escape of < (System.Text.Json)': JSON.stringify({ key: xml }).replace(/</g, '\\' + 'u003c').replace(/>/g, '\\' + 'u003e'),
      'a namespace and an attribute': xml.replace('<RSAKeyValue>', '<RSAKeyValue xmlns="http://www.w3.org/2000/09/xmldsig#" Version="2">'),
      'ds: prefixes': xml.replace(/<(\/?)(\w+)>/g, '<$1ds:$2>'),
      'no closing tag': xml.replace('</RSAKeyValue>', ''),
    }
    for (const [name, text] of Object.entries(forms)) {
      const r = screenKeys(text)
      expect(r.removed, name).toEqual({ xml_private_key: 1 })
      expect(leakedWindows(r.text, secret), name).toBe(0)
      // the public members stay
      expect(r.text.includes(Buffer.from(K.J.rsa.n as string, 'base64url').toString('base64')), name).toBe(true)
    }
  })

  it('takes P and Q with no D, and leaves a public key, a short D and a placeholder', () => {
    const b64 = (s: string | undefined): string => Buffer.from(s as string, 'base64url').toString('base64')
    const pq = `<RSAKeyValue><Modulus>${b64(K.J.rsa.n)}</Modulus><P>${b64(K.J.rsa.p)}</P><Q>${b64(K.J.rsa.q)}</Q></RSAKeyValue>`
    expect(screenKeys(pq).removed).toEqual({ xml_private_key: 1 })
    for (const text of [
      `<RSAKeyValue><Modulus>${b64(K.J.rsa.n)}</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>`,
      `<RSAKeyValue><D>${randomBytes(32).toString('base64')}</D></RSAKeyValue>`,
      `<RSAKeyValue><P>${b64(K.J.rsa.p)}</P></RSAKeyValue>`,
      '<RSAKeyValue><Modulus>ModulusInBase64Here</Modulus><Exponent>AQAB</Exponent><D>PrivateExponentInBase64Here</D></RSAKeyValue>\n',
    ]) {
      const r = screenKeys(text)
      expect(r.text).toBe(text)
      expect(r.removed).toEqual({})
    }
  })
})

describe('T1 K9: a key file URL-encoded whole', () => {
  it('removes it, %20 and form-post encoded', () => {
    for (const f of ['pkcs8_rsa', 'pgp_rsa_hdr', 'sec1_ec'] as Format[]) {
      const lines = K.F[f]
      const enc = encodeURIComponent(lines.join('\n'))
      for (const text of [`key=${enc}&next=1`, `key=${enc.replace(/%20/g, '+')}`]) {
        const r = screenKeys(text)
        expect(r.removed, f).toEqual({ [EXPECT[f][0]]: 1 })
        // none of any key line (the measure reads %2B, %2F and %3D as the characters they encode)
        expect(leakedWindows(r.text, secretLinesOf(lines)), f).toBe(0)
      }
    }
    expect(percentEncoded('no encoded block here')).toEqual([])
    expect(percentEncoded(`key=-----BEGIN%20PRIVATE%20KEY-----%0AMIIE%0A`).map((s) => s.cls)).toEqual(['flag'])
  })
})

describe('T2: what only looks like a key is left byte for byte', () => {
  const pub = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const pub2 = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  // certificate pins: SHA-256 digests in base64
  const pins = ['a', 'b', 'c'].map((x) => createHash('sha256').update(x).digest('base64'))
  const sri = Array.from({ length: 12 }, () => randomBytes(32).toString('base64'))
  // The judge's truncated example quotes the first line of a published sample key. Its first 50
  // characters are the header every 2048-bit RSA PKCS#8 key starts with; the 14 after them, the
  // start of that key's modulus, are made fresh here, so no key's own bytes are committed.
  const modulusStart = randomBytes(12).toString('base64').slice(0, 14)

  // lnk3's false removals (F1-F5, DOCS-R0-1, DOCS-R0-4) rebuilt from their evidence, and the
  // judge's near-misses (judge/rerun2/p3-adversarial.cjs, verbatim but for modulusStart)
  const CASES: Record<string, string> = {
    'F1a prose, two macOS folders between BEGIN and END mentions':
      "I searched every file for a `-----BEGIN RSA PRIVATE KEY-----` line. The two folders that hold PEM files:\n/Users/alice/Projects/PaymentService/src/main/resources\n/Users/alice/Projects/PaymentService/src/test/resources\nBoth only hold certificates (`server.crt`, `ca.crt`), no keys. Nothing ends with `-----END RSA PRIVATE KEY-----`,\nso there is no private key in the repository. The audit is complete.",
    'F1b code review, cert pins between KEY_BEGIN and KEY_END':
      `export const KEY_BEGIN = '-----BEGIN PRIVATE KEY-----'\nexport const PINS = [\n  'sha256/${pins[0]}',\n  'sha256/${pins[2]}',\n]\nexport const KEY_END = '-----END PRIVATE KEY-----'\n`,
    'F1c prose, Java source roots':
      'Searched for -----BEGIN PRIVATE KEY----- under these source roots:\n  src/main/java/com/acme/PaymentGateway/SecurityConfig\n  src/test/java/com/acme/PaymentGateway/SecurityConfigTest\nand for -----END PRIVATE KEY----- in the same places: no matches. Nothing to rotate.',
    'F1d prompt naming the header, pins and footer':
      `In pem.ts, KEY_BEGIN is '-----BEGIN PRIVATE KEY-----' and the pins are 'sha256/${pins[0]}', 'sha256/${pins[2]}'. Add a check that a key ends with '-----END PRIVATE KEY-----', and add a test for a key with no footer.`,
    'F1e public SPKI DER literal between PRIVATE_HEADER and PRIVATE_FOOTER':
      `const PRIVATE_HEADER = '-----BEGIN PRIVATE KEY-----'\nconst SPKI =\n${wrap(pub).map((l) => `  '${l}' +`).join('\n')}\n  ''\nconst PRIVATE_FOOTER = '-----END PRIVATE KEY-----'\n`,
    'F1f long identifiers between BEGIN and END constants':
      "const BEGIN = '-----BEGIN PRIVATE KEY-----'\nimport { validatePrivateKeyInfoStructureForPkcs8Encoding, normalizePrivateKeyInfoStructureForPkcs8Output } from './pkcs8'\nconst END = '-----END PRIVATE KEY-----'\n",
    'DOCS-R0-1a base64 alphabets between PEM_BEGIN and PEM_END':
      "export const PEM_BEGIN = '-----BEGIN PRIVATE KEY-----'\nexport const ALPHABETS = [\n  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',\n  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',\n]\nexport function decodeBody(body: string): Uint8Array {\n  const clean = body.replace(/\\s+/g, '')\n  return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0))\n}\nexport const PEM_END = '-----END PRIVATE KEY-----'\n",
    'DOCS-R0-1b YAML comment with pins':
      `# client_key: from -----BEGIN PRIVATE KEY----- on\npins:\n  - ${pins[0]}\n  - ${pins[1]}\n# ending with -----END PRIVATE KEY-----\n`,
    'DOCS-R0-1c JWKS with public x5c between KEY_HEADER and KEY_FOOTER':
      `const KEY_HEADER = '-----BEGIN PRIVATE KEY-----'\nconst JWKS = { keys: [{ kty: 'RSA', kid: 'a', n: '${crypto.randomBytes(256).toString('base64url')}', e: 'AQAB', x5c: ['${pub}', '${pub2}'] }] }\n` +
      Array.from({ length: 40 }, (_, i) => `it('verifies token ${i}', () => expect(verify(tokens[${i}], JWKS)).toBe(true))`).join('\n') +
      "\nconst KEY_FOOTER = '-----END PRIVATE KEY-----'\n",
    'DOCS-R0-4 empty block (Go pem.EncodeToMemory)': '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n',
    'DOCS-R0-4 empty block in a literal': 'const EMPTY_PEM = "-----BEGIN PRIVATE KEY-----\\n-----END PRIVATE KEY-----\\n"\n',
    'DOCS-R0-4 empty EC block in a test': "expect(() => parsePem('-----BEGIN EC PRIVATE KEY-----\\n-----END EC PRIVATE KEY-----')).toThrow('empty')\n",
    'F5 empty template behind #': '# -----BEGIN PRIVATE KEY-----\n#\n# -----END PRIVATE KEY-----\n',
    'F5 empty template behind >': '> -----BEGIN PRIVATE KEY-----\n>\n> -----END PRIVATE KEY-----\n',
    'F4 ENCRYPTED header constant in a diff': "+export const ENCRYPTED_PKCS8_BEGIN = '-----BEGIN ENCRYPTED PRIVATE KEY-----'\n",
    'F4 SSH2 header in docs': '+A key exported by PuTTYgen as "ssh.com format" starts with `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----`.\n',
    'F4 JWK placeholder in a README': '+    {"kty":"oct","alg":"HS256","k":"YOUR_BASE64URL_SECRET"}\n',
    'F4 gitleaks rule with the b64 header': "+regex = '''LS0tLS1CRUdJTiBQUklWQVRFIEtFW[A-Za-z0-9+/=]+'''\n",
    'F4 prompt-watch question on SSH2': 'PuTTYgen gave me a file that starts with ---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ---- , how do I convert it for OpenSSH?',
    'F4 b64 header constant': "const B64_HEADER = 'LS0tLS1CRUdJTiBQUklWQVRFIEtFW'\n",
    'F4 b64 header line alone': "const ONE = 'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCg=='\n",
    'F4 EC JWK placeholder': '{ kty: "EC", crv: "P-256", d: "REPLACE_WITH_PRIVATE_SCALAR" }\n',
    'F4 oct JWK placeholder': '{"kty":"oct","alg":"HS256","k":"your-256-bit-secret-goes-here"}\n',
    'F4 RSAKeyValue placeholder': '<RSAKeyValue><Modulus>ModulusInBase64Here</Modulus><Exponent>AQAB</Exponent><D>PrivateExponentInBase64Here</D></RSAKeyValue>\n',
    // Near-misses of my own.
    'docs: truncated PKCS#8 example with END':
      `A PKCS#8 file looks like this:\n\n\`\`\`\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ${modulusStart}\n...\n-----END PRIVATE KEY-----\n\`\`\`\n`,
    'docs: truncated RSA example, no END': 'const r = m.scanText(\'-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA...\')\n',
    'docs: OpenSSH example header only': '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA...\n-----END OPENSSH PRIVATE KEY-----\n',
    'prose: SRI hashes after a BEGIN mention in prose':
      `Before -----BEGIN PRIVATE KEY----- appears, the bundle loads these scripts:\n${sri.map((h) => `  sha256-${h}`).join('\n')}\nNone of them is a key.`,
    'code: public PEM between two private constants':
      `const PRIV_BEGIN = '-----BEGIN PRIVATE KEY-----'\nconst PUBLIC_PEM = \`-----BEGIN PUBLIC KEY-----\n${wrap(pub).join('\n')}\n-----END PUBLIC KEY-----\`\nconst PRIV_END = '-----END PRIVATE KEY-----'\n`,
    'listing: rg -n of PEM constants across files':
      'src/pem.ts:3:export const BEGIN = "-----BEGIN PRIVATE KEY-----"\nsrc/pem.ts:4:export const END = "-----END PRIVATE KEY-----"\ntests/pem.test.ts:12:  expect(isPem("-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----")).toBe(true)\n',
    'tokens: AWS documentation example key id': 'aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE\n',
    'tokens: GitHub token placeholder': "process.env.GITHUB_TOKEN = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'\n",
    'tokens: repeated-letter fixture': `const GH = 'ghp_${'a'.repeat(36)}'\n`,
    'tokens: sk- branch names in git output': '* sk-1234-fix-login-redirect\n  sk-5678-add-retry-to-uploader\n  main\n',
    'tokens: rnd_ folder': 'Copied to D:\\rnd_ExperimentalPrototypeProjects2026\\build\n',
    'tokens: Stripe docs placeholder': "stripe.api_key = 'sk_test_your_secret_key_here_1234567890'\n",
    'tokens: notion secret_ identifiers': 'export const secret_redactionPlaceholderMessageForTheUserInterface = 1\n',
  }

  /** What the detectors flag in each, as the judge's prototype did (out2/final-p3.txt). */
  const FLAGS: Record<string, Record<string, number>> = {
    'F4 SSH2 header in docs': { ssh2_private_key: 1 },
    'F4 JWK placeholder in a README': { jwk_private_key: 1 },
    'F4 gitleaks rule with the b64 header': {},
    'F4 prompt-watch question on SSH2': { ssh2_private_key: 1 },
    'F4 b64 header constant': {},
    'F4 b64 header line alone': { private_key_b64: 1 },
    'F4 EC JWK placeholder': { jwk_private_key: 1 },
    'F4 oct JWK placeholder': { jwk_private_key: 1 },
    'F4 RSAKeyValue placeholder': { xml_private_key: 1 },
    'listing: rg -n of PEM constants across files': { private_key: 2 },
  }

  it("leaves every one of lnk3's false removals and the near-misses as it is, and flags what it should", () => {
    // 30 key-shaped texts and 7 token ones (main's token rules are screenText's: no detector's)
    expect(Object.keys(CASES)).toHaveLength(37)
    for (const [name, text] of Object.entries(CASES)) {
      const r = screenKeys(text)
      expect(r.text, name).toBe(text)
      expect(r.removed, name).toEqual({})
      expect(r.flagged, name).toEqual(name.startsWith('tokens:') ? {} : (FLAGS[name] ?? { private_key: 1 }))
    }
  })

  it('leaves each of them byte for byte as an end an older computer cut, wherever its cut fell', () => {
    // (the round-0 review's FR-1: an END line named in code or prose ended a "key's tail" made of
    // the pins, paths, an alphabet or a public key's lines above it, where a cut fell among them)
    for (const [name, text] of Object.entries(CASES)) {
      if (name.startsWith('tokens:')) continue
      const step = Math.max(1, Math.ceil(text.length / 400))
      for (let k = 1; k < text.length - 8; k += step) {
        const r = screenKeys(text.slice(k), { cutStart: true })
        expect(r.removed, `${name}, cut at ${k}`).toEqual({})
      }
    }
  })

  const BODY = ['MIIEvQIBADANBgkq' + 'Q'.repeat(48), 'R'.repeat(64), 'S'.repeat(64), 'T'.repeat(40) + '==']
  const begin = '-----BEGIN PRIVATE KEY-----'
  const end = '-----END PRIVATE KEY-----'
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

  it("leaves 45ac7c4's certificates, public keys and code that reads key files byte for byte", () => {
    // (45ac7c4's aiSecurityScreen.test.ts, verbatim)
    const samples: Record<string, string> = {
      'a base64 certificate': `  tls.crt: ${btoa(`-----BEGIN CERTIFICATE-----\n${BODY[0]}\n-----END CERTIFICATE-----\n`)}`,
      'a base64 public key': `pub: ${btoa(`-----BEGIN PUBLIC KEY-----\n${BODY[0]}\n-----END PUBLIC KEY-----\n`)}`,
      'a base64 RSA public key': `pub: ${btoa(`-----BEGIN RSA PUBLIC KEY-----\n${BODY[0]}\n-----END RSA PUBLIC KEY-----\n`)}`,
      'a base64 PGP public key': `pub: ${btoa(`-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${BODY[0]}\n`)}`,
      'a public JWK': JSON.stringify({ kty: 'RSA', n: 'n'.repeat(43), e: 'AQAB', kid: 'k1', use: 'sig' }),
      'a JWK with a short d': JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'placeholder' }),
      'a d with no kty': JSON.stringify({ d: 'Q'.repeat(43), name: 'x' }),
      'a public RSAKeyValue': `<RSAKeyValue><Modulus>${BODY[0]}</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>`,
      'a PuTTY parser': "if (line.startsWith('PuTTY-User-Key-File-')) { const v = /^PuTTY-User-Key-File-(\\d+): (.*)$/.exec(line) }",
      'a PuTTY header with no private lines': 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\nPrivate-Lines: 1\n...',
    }
    // (a placeholder d, and Private-Lines over fewer lines than it names, are named in a note)
    const FLAGGED: Record<string, Record<string, number>> = { 'a JWK with a short d': { jwk_private_key: 1 }, 'a PuTTY header with no private lines': { putty_private_key: 1 } }
    for (const [name, text] of Object.entries(samples)) {
      const r = screenKeys(text)
      expect(r.text, name).toBe(text)
      expect(r.removed, name).toEqual({})
      expect(r.flagged, name).toEqual(FLAGGED[name] ?? {})
    }
    const named = "const H = '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----'\nconst F = '---- END SSH2 ENCRYPTED PRIVATE KEY ----'"
    expect(screenKeys(named)).toMatchObject({ text: named, removed: {}, flagged: { ssh2_private_key: 1 } })
  })

  it("leaves 45ac7c4's text with no key in it between a BEGIN and an END line byte for byte", () => {
    // (45ac7c4's aiSecurityScreen.test.ts, verbatim)
    const samples: Record<string, string> = {
      'an alphabet': [`const PEM_HEADER = '${begin}'`, `const BASE64_ALPHABET = '${alphabet}'`, `const PEM_FOOTER = '${end}'`].join('\n'),
      'a table twice as long': [`const H = '${begin}'`, `const TABLE = '${alphabet.repeat(2)}'`, `const F = '${end}'`].join('\n'),
      'a test failure with a CI path': [
        ' FAIL  tests/pem.test.ts > parsePem > rejects a key with no footer',
        `AssertionError: expected '${begin}' to be rejected`,
        ' ❯ /home/runner/work/termpolis/termpolis/tests/pemParser.test.ts:41:7',
        `   - Expected: "${end}"`,
      ].join('\n'),
      'a 40-letter function name': [
        "export const BEGIN = '-----BEGIN RSA PRIVATE KEY-----'",
        'export function extractBase64BodyFromPemEncodedPrivateKey(pem: string): string {',
        "  return pem.split('\\n').slice(1, -1).join('')",
        '}',
        "export const END = '-----END RSA PRIVATE KEY-----'",
      ].join('\n'),
      'a long camelCase name': ["const b = '-----BEGIN OPENSSH PRIVATE KEY-----'", 'const assertPrivateKeyHeaderMatchesExpectedFormat = 1', "const e = '-----END OPENSSH PRIVATE KEY-----'"].join('\n'),
      'an upper-case constant': ["const BEGIN = '-----BEGIN RSA PRIVATE KEY-----'", 'const MAX_LINE_LENGTH_FOR_ENCODED_KEY_BODY_LINES = 64', "const END = '-----END RSA PRIVATE KEY-----'"].join('\n'),
      'a git SHA in a changelog': [
        `- Accept keys that start with ${begin} as well as the RSA form.`,
        '  Fixed in 2fd4e1c67a2d28fced849ee1bb76e7391b93eb12 (parser).',
        `- Reject a key that ends with ${end} but has no BEGIN line.`,
      ].join('\n'),
      'a git SHA in prose': 'accepts `-----BEGIN RSA PRIVATE KEY-----` (fixed in 9fceb02d0ae598e95dc970b74767f19372d61af8) and stops at `-----END RSA PRIVATE KEY-----`.',
      'a list of git SHAs': [`const B = '${begin}'`, '9fceb02d0ae598e95dc970b74767f19372d61af8', '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12', `const E = '${end}'`].join('\n'),
      'a SHA-256 digest': ['A = "-----BEGIN EC PRIVATE KEY-----"', 'E = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"', 'B = "-----END EC PRIVATE KEY-----"'].join('\n'),
      'a data: URI': [
        `A PKCS#8 key starts with \`${begin}\`. ![diagram](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==)`,
        `It ends with \`${end}\`.`,
      ].join('\n'),
      'a URL path': ['pemBegin = "-----BEGIN RSA PRIVATE KEY-----"', '// see https://github.com/golang/go/blob/master/src/crypto/x509/pem_decrypt.go', 'pemEnd = "-----END RSA PRIVATE KEY-----"'].join('\n'),
      'a = banner': [
        `export const PEM_BEGIN = '${begin}'`,
        `// ${'='.repeat(74)}`,
        '// Helpers',
        `// ${'='.repeat(74)}`,
        'export function stripPem(pem) { return pem.replace(PEM_BEGIN, "").replace(PEM_END, "").trim() }',
        `export const PEM_END = '${end}'`,
      ].join('\n'),
      'a / banner': ['#define A "-----BEGIN RSA PRIVATE KEY-----"', '/'.repeat(80), '#define B "-----END RSA PRIVATE KEY-----"'].join('\n'),
      'stacked banners': [`const B = '${begin}'`, `//${'='.repeat(56)}`, `//${'='.repeat(56)}`, `const E = '${end}'`].join('\n'),
      'a setext heading': ['from `-----BEGIN OPENSSH PRIVATE KEY-----`', 'Supported key formats and their headers explained', '='.repeat(50), 'to `-----END OPENSSH PRIVATE KEY-----`.'].join('\n'),
      'PGP and DSA too': [
        "const PGP = '-----BEGIN PGP PRIVATE KEY BLOCK-----'",
        `const SAMPLE = '${alphabet}'`,
        "const PGP_END = '-----END PGP PRIVATE KEY BLOCK-----'",
        "const DSA = '-----BEGIN DSA PRIVATE KEY-----'",
        `// ${'/'.repeat(60)}`,
        "const DSA_END = '-----END DSA PRIVATE KEY-----'",
      ].join('\n'),
    }
    expect(Object.keys(samples)).toHaveLength(17)
    for (const [name, text] of Object.entries(samples)) {
      const r = screenKeys(text)
      expect(r.text, name).toBe(text)
      expect(r.removed, name).toEqual({})
      // each BEGIN line over no key is named in a note, under its own kind's id
      expect(r.flagged, name).toEqual(name === 'PGP and DSA too' ? { gpg_block: 1, ssh_dsa_pubkey: 1 } : { private_key: 1 })
    }
  })

  it("leaves 45ac7c4's code that names a key's lines, and a body too short to be a key, byte for byte", () => {
    // (45ac7c4's aiSecurityScreen.test.ts, verbatim)
    const both = [
      "const PEM_HEADER = '-----BEGIN PRIVATE KEY-----'",
      "const PEM_FOOTER = '-----END PRIVATE KEY-----'",
      'export function strip(pem: string): string {',
      "  return pem.replace(PEM_HEADER, '').replace(PEM_FOOTER, '').replace(/\\s+/g, '')",
      '}',
      "const isRsa = (pem: string) => pem.includes('-----BEGIN RSA PRIVATE KEY-----') && pem.includes('-----END RSA PRIVATE KEY-----')",
      "const fake = ['-----BEGIN EC PRIVATE KEY-----', 'MIIB', '-----END EC PRIVATE KEY-----'].join('\\n')",
      '// An armored key runs from -----BEGIN PGP PRIVATE KEY BLOCK----- to -----END PGP PRIVATE KEY BLOCK-----.',
    ].join('\n')
    expect(screenKeys(both)).toMatchObject({ text: both, removed: {}, flagged: { private_key: 3, gpg_block: 1 } })
    const header = [
      'export function isPem(pem: string): boolean {',
      "  return pem.trimStart().startsWith('-----BEGIN PRIVATE KEY-----')",
      '}',
      'const t = NetworkConnectionManager.config.defaultTimeoutMillisecondsValue',
      'const header = "-----BEGIN PGP PRIVATE KEY BLOCK-----\\n" + armor',
    ].join('\n')
    expect(screenKeys(header)).toMatchObject({ text: header, removed: {}, flagged: { private_key: 1, gpg_block: 1 } })
    const short = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nThen run the tests.'
    expect(screenKeys(short)).toMatchObject({ text: short, removed: {}, flagged: { private_key: 1 } })
    // a DSA block whose body is 4 characters: main's rule removed it, an END line being enough; there
    // is no key in it, so it is named in a note instead
    const dsa = '-----BEGIN DSA PRIVATE KEY-----\nMIIB\n-----END DSA PRIVATE KEY-----'
    expect(screenKeys(dsa)).toMatchObject({ text: dsa, removed: {}, flagged: { ssh_dsa_pubkey: 1 } })
  })

  it("leaves judge 1's 22 kinds of ordinary text alone, 200 trials each", () => {
    const rnd = (n: number): string => randomBytes(n).toString('base64')
    const GENERATORS: Array<[string, (i: number) => string, { n?: number; screen?: { cutStart?: boolean; keep?: number } }]> = []
    const rate = (label: string, make: (i: number) => string, opts: { n?: number; screen?: { cutStart?: boolean; keep?: number } } = {}): void => {
      GENERATORS.push([label, make, opts])
    }
    // (judge/probes/k3-adversarial-final.cjs, verbatim)
    rate('A1 PGP mention + 3 sha256 (44 chars)', () => `The export begins with \`-----BEGIN PGP PRIVATE KEY BLOCK-----\`; the checksums of the three files:\n${rnd(32)}\n${rnd(32)}\n${rnd(32)}\nNone of them is a key.`)
    rate('A2 PGP mention + 4 sha256', () => `Look for -----BEGIN PGP PRIVATE KEY BLOCK----- in the bundle. Digests:\n${[0, 1, 2, 3].map(() => rnd(32)).join('\n')}\nend of list`)
    rate('A3 PGP mention + 2 sha512 (88 chars)', () => `-----BEGIN PGP PRIVATE KEY BLOCK----- was not found. sha512 of the two artifacts:\n${rnd(64)}\n${rnd(64)}\n`)
    rate('A4 PGP mention + 3 sha256 as a YAML list', () => `# no -----BEGIN PGP PRIVATE KEY BLOCK----- here\npins:\n  - ${rnd(32)}\n  - ${rnd(32)}\n  - ${rnd(32)}\n`)
    rate('A5 control: DER kind mention + 3 sha256', () => `The export begins with \`-----BEGIN PRIVATE KEY-----\`; the checksums of the three files:\n${rnd(32)}\n${rnd(32)}\n${rnd(32)}\nNone of them is a key.`)
    rate('A6 control: OPENSSH kind mention + 3 sha256', () => `The export begins with \`-----BEGIN OPENSSH PRIVATE KEY-----\`; checksums:\n${rnd(32)}\n${rnd(32)}\n${rnd(32)}\n`)
    rate('A7 control: SSH2 header + 3 sha256', () => `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ---- is the ssh.com header; digests:\n${rnd(32)}\n${rnd(32)}\n${rnd(32)}\n`)

    rate('B1 TS: PRIVATE_HEADER then PIN_1..3 constants', () => `export const PRIVATE_HEADER = '-----BEGIN PRIVATE KEY-----'\nexport const PIN_1 = '${rnd(32)}'\nexport const PIN_2 = '${rnd(32)}'\nexport const PIN_3 = '${rnd(32)}'\n`, { n: 2000 })
    rate('B2 TS: header constant then a pins array (one per line)', () => `const HEADER = '-----BEGIN PRIVATE KEY-----'\nconst PINS = [\n  '${rnd(32)}',\n  '${rnd(32)}',\n  '${rnd(32)}',\n]\n`, { n: 2000 })
    rate('B3 Go test table: header then digests in one frame', () => `var header = "-----BEGIN RSA PRIVATE KEY-----"\nvar digests = []string{\n\t"${rnd(48)}",\n\t"${rnd(48)}",\n\t"${rnd(48)}",\n}\n`, { n: 2000 })
    rate('B4 rg listing: BEGIN constant line, then lockfile integrity lines', () =>
      `src/pem.ts:3:export const KEY_BEGIN = '-----BEGIN PRIVATE KEY-----'\n` + Array.from({ length: 6 }, (_, i) => `package-lock.json:${100 + i * 7}:      "integrity": "sha512-${rnd(64)}",`).join('\n') + '\n', { n: 2000 })
    rate('B5 Python: header then SRI hashes', () => `HEADER = b"-----BEGIN PRIVATE KEY-----"\nSRI = (\n    "${rnd(48)}"\n    "${rnd(48)}"\n    "${rnd(48)}"\n)\n`, { n: 2000 })

    rate('C1 JS: an array of hashes, then an END element', () => `const PEM = [\n  '${rnd(48)}',\n  '${rnd(48)}',\n  '${rnd(48)}',\n  '-----END PRIVATE KEY-----',\n].join('\\n')\n`, { n: 2000 })
    rate('C2 screenshot dump (64 wide), then a standalone END line', () => `Screenshot:\n${wrap(rnd(2000), 64).join('\n')}\n-----END PRIVATE KEY-----\n(the footer the parser expects)\n`, { n: 2000 })
    rate('C3 SRI hashes (one per line), then an END line in a heredoc', () => `cat <<EOF\n${[0, 1, 2, 3].map(() => rnd(48)).join('\n')}\n-----END PRIVATE KEY-----\nEOF\n`, { n: 2000 })
    rate('C4 control: cert chain, then an END PRIVATE KEY mention line', () => `-----BEGIN CERTIFICATE-----\n${wrap(rnd(900), 64).join('\n')}\n-----END CERTIFICATE-----\n-----END PRIVATE KEY-----\n`, { n: 2000 })
    rate('C5 control: dump, then prose that mentions an END line', () => `Screenshot:\n${wrap(rnd(2000), 64).join('\n')}\nand no file ends with -----END PRIVATE KEY----- either.\n`, { n: 2000 })

    rate('D1 k8s secret: tls.crt base64 (public cert PEM), tls.key empty', () => `apiVersion: v1\nkind: Secret\ndata:\n  tls.crt: ${Buffer.from('-----BEGIN CERTIFICATE-----\n' + wrap(rnd(900), 64).join('\n') + '\n-----END CERTIFICATE-----\n').toString('base64')}\n  tls.key: ""\n`, { n: 2000 })
    rate('D2 old doer cut inside a 76-wide dump (cutStart)', () => wrap(rnd(30000), 76).slice(3).join('\n') + '\nDone.\n', { n: 2000, screen: { cutStart: true } })
    rate('D3 answer cut inside a dump (keep 4000)', () => 'x\n' + wrap(rnd(30000), 76).join('\n') + '\nDone.\n', { n: 2000, screen: { keep: 4000 } })
    rate('D4 known_hosts / authorized_keys lines', () => Array.from({ length: 5 }, (_, i) => `host${i}.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${rnd(32).slice(0, 43)}`).join('\n') + '\n', { n: 2000 })
    rate('D5 JWKS of public keys (n, e, x5c)', () => JSON.stringify({ keys: [{ kty: 'RSA', kid: 'a', n: crypto.randomBytes(256).toString('base64url'), e: 'AQAB', x5c: [rnd(900)] }, { kty: 'EC', crv: 'P-256', x: crypto.randomBytes(32).toString('base64url'), y: crypto.randomBytes(32).toString('base64url') }] }, null, 2), { n: 2000 })
    expect(GENERATORS).toHaveLength(22)
    // What is named in a note, the same in every trial: a BEGIN line over no key under its own
    // kind's id, an END line under random lines whose head is in view, a cut dump's leading run.
    // Nothing for a certificate chain, a public JWKS, known_hosts, or a dump the screen's own cut
    // falls inside a line of.
    const FLAGGED: Record<string, Record<string, number>> = {
      A1: { gpg_block: 1 },
      A2: { gpg_block: 1 },
      A3: { gpg_block: 1 },
      A4: { gpg_block: 1 },
      A7: { ssh2_private_key: 1 },
      C4: {},
      D1: {},
      D3: {},
      D4: {},
      D5: {},
    }
    for (const [label, make, opts] of GENERATORS) {
      for (let i = 0; i < 200; i++) {
        const s = make(i)
        const r = screenKeys(s, opts.screen ?? {})
        const kept = opts.screen?.keep !== undefined ? s.slice(-opts.screen.keep) : s
        expect(r.removed, label).toEqual({})
        expect(r.text === kept, label).toBe(true)
        expect(r.flagged, label).toEqual(FLAGGED[label.slice(0, 2)] ?? { private_key: 1 })
      }
    }
  })

  it('leaves a made-up body under a BEGIN line byte for byte, however long: a fixture is not a key', () => {
    // main's Linked fixtures (lines of `Ab` and a line number, 700 of them in PGP armor, in its own
    // lines and in \n escapes), lnk3's `AbCd...` rows, and an `AAAA` body
    const ab = (n: number): string[] => Array.from({ length: n }, (_, i) => `${'Ab'.repeat(28)}${String(i).padStart(8, '0')}`)
    const abcd = Array.from({ length: 6 }, (_, i) => ('AbCdEfGhIjKlMnOpQrStUvWxYz' + String(i).padStart(4, '0')).repeat(3).slice(0, 64))
    const texts: Array<[string, string]> = [
      ['gpg_block', ['-----BEGIN PGP PRIVATE KEY BLOCK-----', 'Version: GnuPG v2', '', ...ab(700), '=AbCd', '-----END PGP PRIVATE KEY BLOCK-----'].join('\n')],
      ['gpg_block', `{"key": "-----BEGIN PGP PRIVATE KEY BLOCK-----\\n\\n${ab(700).join('\\n')}\\n=AbCd\\n-----END PGP PRIVATE KEY BLOCK-----"}`],
      ['private_key', ['-----BEGIN RSA PRIVATE KEY-----', ...ab(25), '-----END RSA PRIVATE KEY-----'].join('\n')],
      ['private_key', [begin, ...abcd, end].join('\n')],
      ['private_key', ['-----BEGIN OPENSSH PRIVATE KEY-----', ...Array<string>(8).fill('A'.repeat(70)), '-----END OPENSSH PRIVATE KEY-----'].join('\n')],
    ]
    for (const [rule, text] of texts) {
      const r = screenKeys(text)
      expect(r.text, text.slice(0, 40)).toBe(text)
      expect(r.removed, text.slice(0, 40)).toEqual({})
      expect(r.flagged, text.slice(0, 40)).toEqual({ [rule]: 1 })
    }
  })

  it('leaves a made-up body byte for byte where an older computer cut it, and reports it', () => {
    // At the start of an end a version before 1.55 cut, a few characters above an END line are
    // taken as what its cut left of a key; a made-up body's are not (the round-0 review's FR-3).
    const ab = (n: number): string[] => Array.from({ length: n }, (_, i) => `${'Ab'.repeat(28)}${String(i).padStart(2, '0')}`)
    const abcd = Array.from({ length: 6 }, (_, i) => ('AbCdEfGhIjKlMnOpQrStUvWxYz' + String(i).padStart(4, '0')).repeat(3).slice(0, 64))
    const fakes = [
      ['-----BEGIN RSA PRIVATE KEY-----', ...ab(10), '-----END RSA PRIVATE KEY-----'].join('\n'),
      [begin, ...abcd, end].join('\n'),
      ['-----BEGIN OPENSSH PRIVATE KEY-----', ...Array<string>(8).fill('A'.repeat(70)), '-----END OPENSSH PRIVATE KEY-----'].join('\n'),
      [begin, ...BODY, end].join('\n'),
      // a test runner's diff of a fixture, and a fixture in a literal
      ['- Expected', '+ Received', '', '  "-----BEGIN RSA PRIVATE KEY-----', ...ab(10).map((l) => `+ ${l}`), '+ -----END RSA PRIVATE KEY-----"', ''].join('\n'),
      ['const FAKE = [', "  '-----BEGIN RSA PRIVATE KEY-----',", ...ab(10).map((l) => `  '${l}',`), "  '-----END RSA PRIVATE KEY-----',", "].join('\\n')"].join('\n'),
    ]
    let reported = 0
    for (const fake of fakes) {
      const e = fake.lastIndexOf('-----END')
      for (let i = fake.indexOf('\n') + 1; i < e - 1; i += 3) {
        for (const view of [fake.slice(i), `…${fake.slice(i)}`]) {
          const r = screenKeys(view, { cutStart: true })
          expect(r.text, `${fake.slice(0, 30)} cut at ${i}`).toBe(view)
          expect(r.removed, `${fake.slice(0, 30)} cut at ${i}`).toEqual({})
          if (r.spans.some((s) => s.why === 'cut-tail-made-up')) reported++
        }
      }
    }
    expect(reported).toBeGreaterThan(100)
  })

  it("leaves a JWK's placeholder that the text's end cut short, and takes a real value cut so", () => {
    // (the round-0 review's FR-7: cut to 23 characters, a slug no longer read as one)
    const jwk = '{"kty":"oct","alg":"HS256","k":"your-256-bit-secret-goes-here"}'
    const at = jwk.indexOf('your-')
    for (let n = 8; n <= 28; n++) {
      const view = jwk.slice(0, at + n)
      expect(screenKeys(view).removed, String(n)).toEqual({})
    }
    const k = randomBytes(32).toString('base64url')
    for (const n of [22, 30, 43]) {
      const view = `{"kty":"oct","alg":"HS256","k":"${k.slice(0, n)}`
      expect(screenKeys(view).removed, String(n)).toEqual({ jwk_private_key: 1 })
    }
    // a value the text does not end inside is judged by its length as before
    expect(placeholderWhy('your-256-bit-secret-go', 'b62')).toBeNull()
    expect(placeholderWhy('your-256-bit-secret-go', 'b62', true)).toBe('slug')
  })

  it('leaves a public key, a certificate and a CSR under a private BEGIN line, and random bytes no format names', () => {
    const certLike = der(0x30, Buffer.concat([der(0x30, Buffer.concat([der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, randomBytes(16)), randomBytes(400)])), randomBytes(64)]))
    const csrLike = der(0x30, Buffer.concat([der(0x30, Buffer.concat([der(0x02, Buffer.from([0])), der(0x30, randomBytes(60)), randomBytes(300)])), randomBytes(64)]))
    const spki = Buffer.from(pub, 'base64')
    const rsaPublic = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'pkcs1', format: 'der' })
    for (const [name, bytes] of [['SPKI', spki], ['certificate', certLike], ['CSR', csrLike], ['RSA public key', rsaPublic], ['random bytes', randomBytes(900)]] as Array<[string, Buffer]>) {
      for (const kind of ['', 'RSA ', 'EC ', 'ENCRYPTED ']) {
        const text = [`-----BEGIN ${kind}PRIVATE KEY-----`, ...wrap(bytes.toString('base64')), `-----END ${kind}PRIVATE KEY-----`].join('\n')
        const r = screenKeys(text)
        expect(r.text, `${name} ${kind}`).toBe(text)
        expect(r.flagged, `${name} ${kind}`).toEqual({ private_key: 1 })
      }
    }
    // a Proc-Type with no DEK-Info over a random body: no legacy key either
    const proc = ['-----BEGIN RSA PRIVATE KEY-----', 'Proc-Type: 4,ENCRYPTED', '', ...wrap(randomBytes(600).toString('base64')), '-----END RSA PRIVATE KEY-----'].join('\n')
    expect(screenKeys(proc).removed).toEqual({})
    // and a DEK-Info whose IV is not its cipher's size
    const dek = ['-----BEGIN RSA PRIVATE KEY-----', 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0011', '', ...wrap(randomBytes(600).toString('base64')), '-----END RSA PRIVATE KEY-----'].join('\n')
    expect(screenKeys(dek).removed).toEqual({})
    // a packet header with no known algorithm under a PGP BEGIN line: tag and version are not a key
    for (let i = 0; i < 20; i++) {
      const noAlgo = Buffer.concat([Buffer.from([0x95, 0x01, 0x80, 0x04]), randomBytes(4), Buffer.from([0xee]), randomBytes(380)])
      const text = ['-----BEGIN PGP PRIVATE KEY BLOCK-----', '', ...wrap(noAlgo.toString('base64')), '-----END PGP PRIVATE KEY BLOCK-----', ''].join('\n')
      expect(screenKeys(text)).toMatchObject({ text, removed: {} })
    }
    // a packet under a DER kind's BEGIN line, and DER under PGP's: each only under its own kind
    const pgpish = Buffer.concat([Buffer.from([0x95, 0x01, 0x80, 0x04]), randomBytes(4), Buffer.from([0x01, 0x08, 0x00, 0x80 | randomBytes(1)[0]]), randomBytes(376)])
    expect(screenKeys([begin, ...wrap(pgpish.toString('base64')), end].join('\n')).removed).toEqual({})
    const p8 = K.F.pkcs8_rsa
    expect(screenKeys(['-----BEGIN PGP PRIVATE KEY BLOCK-----', '', ...p8.slice(1, -1), '-----END PGP PRIVATE KEY BLOCK-----'].join('\n')).removed).toEqual({})
    expect(screenKeys(['-----BEGIN OPENSSH PRIVATE KEY-----', ...p8.slice(1, -1), '-----END OPENSSH PRIVATE KEY-----'].join('\n')).removed).toEqual({})
  })
})

describe('T5: the recall bugs the probes found stay fixed', () => {
  it('J8: an encrypted PKCS#8 key in a + diff decodes with the + dropped from every line (20 fresh keys)', () => {
    for (let i = 0; i < 20; i++) {
      const enc = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'probe' }) as string
      const lines = enc.trim().split('\n')
      const r = screenKeys('diff:\n' + JOIN.diff_plus(lines) + '\n')
      expect(leakedWindows(r.text, secretLinesOf(lines)), `key ${i}`).toBe(0)
      expect(r.spans.filter((s) => s.cls === 'remove').map((s) => s.why), `key ${i}`).toEqual(['encrypted-pkcs8-complete'])
    }
  })

  it('J9: a gpg export of a key with a photo ID is removed though its photo header does not look random', () => {
    const lines = pgpPhotoExport(2000)
    // the image header's 12 reserved zero bytes: the export fails the randomness test
    expect(looksRandom(lines.slice(2, -2).join(''))).toBe(false)
    const r = screenKeys('Exported:\n' + lines.join('\n') + '\n')
    expect(r.removed).toEqual({ gpg_block: 1 })
    expect(leakedWindows(r.text, secretLinesOf(lines))).toBe(0)
  })

  it('an SSH2 key whose Comment header continues onto the next line, END line or not, in 7 joinings', () => {
    const BSL = '\\'
    const body = wrap(Buffer.concat([Buffer.from([0x3f, 0x6f, 0xf9, 0xeb]), randomBytes(900)]).toString('base64'), 70)
    for (const withEnd of [true, false]) {
      const ls = ['---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----', 'Subject: probe', `Comment: "a very long comment that the writer ${BSL}`, 'continues on the next line"', ...body, ...(withEnd ? ['---- END SSH2 ENCRYPTED PRIVATE KEY ----'] : [])]
      for (const jn of ['lf', 'crlf', 'java_concat', 'json_n', 'cat_n', 'quote', 'rg_win']) {
        const r = screenKeys('Key:\n' + JOIN[jn](ls) + '\nDone.')
        expect(r.removed, `${jn} ${withEnd}`).toEqual({ ssh2_private_key: 1 })
        expect(leakedWindows(r.text, body), `${jn} ${withEnd}`).toBe(0)
      }
    }
    // and real ssh.com structure, encrypted or not
    for (const cipher of ['none', '3des-cbc'] as const) {
      const ls = ssh2Key(cipher, 1024)
      expect(screenKeys('Key:\n' + ls.join('\n') + '\nDone.').removed, cipher).toEqual({ ssh2_private_key: 1 })
    }
  })

  /** Exports whose last base64 line runs `wants` characters: one pair of keys, photos of the sizes
   *  that leave such a line (base64 grows 4 characters at a time, so any multiple of 4). */
  function exportsEndingWith(wants: number[]): Array<[number, string[]]> {
    const bodies: [Buffer, Buffer] = [pgpRsaBody(), pgpRsaBody()]
    const out: Array<[number, string[]]> = []
    for (const want of wants) {
      for (let photo = 600; photo < 900; photo++) {
        const lines = pgpPhotoExport(photo, bodies)
        if (lastLine(lines).length === want) {
          out.push([want, lines])
          break
        }
      }
    }
    return out
  }
  const shortTailExports = (): Array<[number, string[]]> => exportsEndingWith([4, 8, 12])

  it('J13: with no END line, a last line of 4, 8 or 12 characters goes too, as lines and as Java, VB and Python literals', () => {
    const exports = shortTailExports()
    expect(exports.map(([n]) => n)).toEqual([4, 8, 12])
    const p8 = K.F.pkcs8_rsa
    const pems: Array<[number, string[]]> = []
    for (let w = 40; w <= 76; w += 4) {
      const wrapped = wrap(bodyOf(p8), w)
      if (wrapped[wrapped.length - 1].length < 16) pems.push([w, [p8[0], ...wrapped]])
    }
    expect(pems.length).toBeGreaterThan(0)
    // and every line, the last too, followed by its newline constant (which only counts as a joiner)
    const each: Record<string, (ls: string[]) => string> = {
      vb_each: (ls) => 'Dim key = ' + ls.map((l) => `"${l}" & vbCrLf`).join(' & _\n    '),
      cs_each: (ls) => 'var key = ' + ls.map((l) => `"${l}" + Environment.NewLine`).join(' +\n    ') + ';',
    }
    for (const [what, ls] of [...exports.map(([n, l]): [string, string[]] => [`PGP, last line ${n}`, l.slice(0, -1)]), ...pems.map(([w, l]): [string, string[]] => [`PEM at ${w}`, l])]) {
      const last = lastLine(ls)
      for (const jn of ['lf', 'crlf', 'java_concat', 'js_concat', 'php_dot', 'vb_crlf', 'cs_newline', 'py_implicit', 'cat_n', 'quote', 'docker_t', 'yaml_block2', 'diff_plus', 'json_n', 'space_one_line', 'vb_each', 'cs_each']) {
        const r = screenKeys('Key:\n' + (each[jn] ?? JOIN[jn])(ls) + '\nThat is all.')
        expect(shownWhole(r.text, last), `${what} ${jn}`).toBe(false)
        expect(leakedWindows(r.text, secretLinesOf(ls)), `${what} ${jn}`).toBe(0)
        expect(r.text.endsWith('That is all.'), `${what} ${jn}`).toBe(true)
      }
    }
  })

  it("J13 on one line and in a listing's per-line suffix: a PGP export written so, with no END line, keeps none of its last line", () => {
    const exports = shortTailExports()
    const ONE_LINE: Record<string, (ls: string[]) => string> = {
      'space-joined': (ls) => 'PRIVATE_KEY="' + ls.join(' ') + '"',
      'a JSON array on one line': (ls) => '["' + ls.join('","') + '"]',
      "printf's arguments": (ls) => `printf '%s\\n' ${ls.map((l) => `'${l}'`).join(' ')} > key.asc`,
      'cat -A': (ls) => ls.map((l) => `${l}$`).join('\n'),
      'an echo per line': (ls) => ls.map((l, i) => `echo '${l}' ${i ? '>>' : '>'} key.asc`).join('\n'),
    }
    for (const [n, lines] of exports) {
      const ls = lines.slice(0, -1)
      const last = lastLine(ls)
      const crc = ls[ls.length - 1]
      for (const [name, join] of Object.entries(ONE_LINE)) {
        const r = screenKeys('Key:\n' + join(ls) + '\nThat is all.')
        expect(r.removed, `${name} ${n}`).toEqual({ gpg_block: 1 })
        expect(shownWhole(r.text, last), `${name} ${n}`).toBe(false)
        expect(r.text.includes(crc), `${name} ${n}`).toBe(false)
        expect(r.text.endsWith('That is all.'), `${name} ${n}`).toBe(true)
      }
    }
    // a word after a one-line key in another frame is not its last line
    const pgp = K.F.pgp_ed_nohdr.slice(0, -1)
    const said = screenKeys(`KEY="${pgp.join(' ')}" and done`)
    expect(said.text.endsWith('" and done')).toBe(true)
  })

  it('J13 takes a short line only under a full-width one: once a shorter last line has ended the key, the word or line after it stays', () => {
    // A key's lines share one width and only its last is shorter: after a shorter line, nothing but
    // a PGP checksum is the key's.
    const p8 = K.F.pkcs8_rsa.slice(0, -1)
    expect(lastLine(p8).length).toBeGreaterThanOrEqual(16) // its own run, shorter than the 64 above it
    expect(screenKeys(`Key:\n${p8.join('\n')}\nDone\nmore text`).text).toBe('Key:\n[REDACTED:private_key]\nDone\nmore text')
    expect(screenKeys(`KEY ${p8.join(' ')} and more words`).text).toBe('KEY [REDACTED:private_key] and more words')
    expect(screenKeys(`${p8.map((l) => `${l}$`).join('\n')}\nDone$\n`).text).toBe('[REDACTED:private_key]$\nDone$\n')
    expect(screenKeys(`${p8.map((l, i) => `echo '${l}' ${i ? '>>' : '>'} key.pem`).join('\n')}\necho 'Done' >> key.pem\n`).text).toBe(
      "echo '[REDACTED:private_key]' >> key.pem\necho 'Done' >> key.pem\n",
    )
    // (the prototype took the / of a comment's closing ` */` and a Ruby heredoc's closing `PEM`)
    expect(screenKeys(`/*\n${p8.map((l) => ` * ${l}`).join('\n')}\n */\nok`).text).toBe('/*\n * [REDACTED:private_key]\n */\nok')
    expect(screenKeys(`KEY = <<~PEM\n${p8.map((l) => `  ${l}`).join('\n')}\nPEM\nok`).text).toBe('KEY = <<~PEM\n  [REDACTED:private_key]\nPEM\nok')
    // a PGP export whose last line is 40 characters: its checksum still goes, on its own line or on
    // the same one, and what follows it stays
    const [[, lines]] = exportsEndingWith([40])
    const ls = lines.slice(0, -1)
    const crc = ls[ls.length - 1]
    for (const [name, text, rest] of [
      ['lines', `${ls.join('\n')}\nDone\n`, '\nDone\n'],
      ['one line', `KEY ${ls.join(' ')} and more`, ' and more'],
    ]) {
      const r = screenKeys(text)
      expect(r.removed, name).toEqual({ gpg_block: 1 })
      expect(r.text.includes(crc), name).toBe(false)
      expect(r.text.endsWith(`[REDACTED:gpg_block]${rest}`), name).toBe(true)
    }
  })
})

describe("what the round-0 leaks review found crossing: a short last line, a cut in the headers, uneven lines", () => {
  const BS = '\\'
  const ESC = String.fromCharCode(27)
  const BT = '`'
  /** An older doing computer's cut of `text` at `at`: the asking side screens what arrived. */
  const arrived = (text: string, at: number): ReturnType<typeof screenKeys> => screenKeys(`…${text.slice(at)}`, { cutStart: true })

  it('F-A: a key whose last line is 1 to 7 characters, cut through by an older computer, goes from its END line', () => {
    // every P-521 PKCS#8 key's last line is 4 characters: no run of 8 was on it, and the walk up
    // from the END line stopped there
    const p521 = (generateKeyPairSync('ec', { namedCurve: 'P-521' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).trim().split('\n')
    expect(p521[p521.length - 2].length).toBeLessThan(8)
    const secret = secretLinesOf(p521)
    for (const joining of ['lf', 'json_n', 'java_concat', 'cat_n', 'rg_win', 'docker_t', 'diff_plus']) {
      const body = JOIN[joining](p521)
      const text = `Here is the key:\n${body}\nDone.\n`
      // (a cut that leaves fewer than 16 of the key's characters leaves no key: 0.8 is the last that
      // leaves more in every joining)
      for (const f of [0.3, 0.6, 0.8]) {
        const at = text.indexOf(body) + Math.floor(body.length * f)
        expect(leakedWindows(arrived(text, at).text, secret), `${joining} ${f}`).toBe(0)
        // ...and its short last line too
        expect(shownWhole(arrived(text, at).text, p521[p521.length - 2]), `${joining} ${f}`).toBe(false)
      }
    }
  })

  it('F-B: a key an older computer cut in its BEGIN line or the header lines under it goes, END line and all', () => {
    for (const format of ['pkcs8_rsa', 'openssh', 'pgp_rsa_hdr', 'pgp_rsa_nohdr', 'rsa_legacy_enc', 'enc_pkcs8', 'ssh2_real'] as const) {
      const lines = K.F[format]
      const secret = secretLinesOf(lines)
      for (const joining of ['lf', 'crlf', 'json_n', 'cat_n']) {
        const body = JOIN[joining](lines)
        const text = `Here is the deploy key:\n${body}\nThe deploy finished.\n`
        const from = text.indexOf(body)
        const firstBody = text.indexOf(secret[0].slice(0, 16), from)
        for (let at = from + 1; at < firstBody; at += 2) {
          const r = arrived(text, at)
          expect(leakedWindows(r.text, secret), `${format} ${joining} cut at ${at - from}`).toBe(0)
        }
      }
    }
  })

  it('FR-4: an older computer cut through a key joined by escapes, newline constants or a per-line suffix: taken from its END line', () => {
    const joinings: Record<string, (ls: string[]) => string> = {
      json_rn: (ls) => `{"key": "${ls.join(`${BS}r${BS}n`)}${BS}r${BS}n"}`,
      u000a: JOIN.u000a,
      x0a: (ls) => `printf '${ls.join(`${BS}x0a`)}'`,
      html_br: (ls) => `<pre>${ls.join('<br>')}</pre>`,
      ps_backtick: (ls) => '$key = ' + ls.map((l) => `"${l}${BT}n"`).join(' +\n    '),
      vb_crlf: JOIN.vb_crlf,
      php_dot: JOIN.php_dot,
      cat_A: (ls) => ls.map((l) => `${l}$`).join('\n'),
      java_lineSep: (ls) => 'String KEY = ' + ls.map((l) => `"${l}"`).join(' + System.lineSeparator()\n    + ') + ';',
      // Python's and Rust's line continuations: a backslash before the line break
      py_backslash: (ls) => 'KEY = ' + ls.map((l) => `"${l}${BS}n"`).join(` ${BS}\n    `),
      rust_cont: (ls) => 'let key = "' + ls.join(`${BS}n${BS}\n`) + '";',
    }
    // (a PGP export's checksum line between its last line and the END line, in the joining's frame)
    for (const format of ['pkcs8_rsa', 'pkcs1_rsa', 'openssh', 'pgp_rsa_hdr'] as const) {
      const lines = K.F[format]
      const secret = secretLinesOf(lines)
      for (const [name, join] of Object.entries(joinings)) {
        const body = join(lines)
        const text = `Here it is:\n${body}\nDone.\n`
        for (const f of [0.5, 0.85]) {
          const at = text.indexOf(body) + Math.floor(body.length * f)
          expect(leakedWindows(arrived(text, at).text, secret), `${format} ${name} ${f}`).toBe(0)
        }
      }
    }
    // a cut inside a written-out break or a newline constant leaves its rest above the key lines
    const lines = K.F.pkcs8_rsa
    const secret = secretLinesOf(lines)
    for (const [name, join, mark] of [
      ['html_br', joinings.html_br, '<br>'],
      ['java_lineSep', joinings.java_lineSep, 'System.lineSeparator()'],
    ] as const) {
      const text = `Here it is:\n${join(lines)}\nDone.\n`
      const inMark = text.indexOf(mark, Math.floor(text.length / 2)) + 2
      expect(leakedWindows(arrived(text, inMark).text, secret), name).toBe(0)
    }
  })

  it('F-C and F-D: a key in JSON that escapes / or +, and in a coloured git diff, is removed whole', () => {
    const joinings: Record<string, (ls: string[]) => string> = {
      // PHP's json_encode writes / as \/; .NET's System.Text.Json writes + as the escape of U+002B
      php_json: (ls) => '{"key":"' + ls.join(BS + 'n').split('/').join(BS + '/') + BS + 'n"}',
      stj_plus: (ls) => JSON.stringify({ key: ls.join('\n') }).split('+').join(BS + 'u002B'),
      // git's colour output: ESC[32m+ before each added line, ESC[m after it
      ansi_diff: (ls) => ls.map((l) => `${ESC}[32m+${l}${ESC}[m`).join('\n'),
    }
    for (const format of ['pkcs8_rsa', 'pkcs1_rsa', 'enc_pkcs8', 'sec1_ec', 'openssh'] as const) {
      const lines = K.F[format]
      const secret = secretLinesOf(lines)
      for (const [name, join] of Object.entries(joinings)) {
        for (const end of [true, false]) {
          const r = screenKeys(`Config:\n${join(end ? lines : lines.slice(0, -1))}\nDone.\n`)
          expect(leakedWindows(r.text, secret), `${format} ${name} END ${end}`).toBe(0)
        }
      }
    }
    // an OpenVPN static key in a coloured diff
    const ovpn = screenKeys(K.F.openvpn.map((l) => `${ESC}[32m+${l}${ESC}[m`).join('\n'))
    expect(ovpn.removed).toEqual({ openvpn_static_key: 1 })
    // A legacy encrypted key, whose headers say it is one, in lines a colour code starts: the `m`
    // that ends it is glued to Proc-Type and DEK-Info (a terminal's colour, GitHub Actions' log).
    const legacy = K.F.rsa_legacy_enc
    for (const [style, color] of [
      ['a line colour', (l: string) => `${ESC}[33m${l}${ESC}[39m`],
      ['GitHub Actions', (l: string) => `2026-10-18T12:00:01.1234567Z ${ESC}[36;1m${l}${ESC}[0m`],
    ] as const) {
      for (const end of [true, false]) {
        const ls = end ? legacy : legacy.slice(0, -1)
        const r = screenKeys(`Config:\n${ls.map(color).join('\n')}\nDone.\n`)
        expect(r.removed, `${style}, END ${end}`).toEqual({ private_key: 1 })
        expect(leakedWindows(r.text, secretLinesOf(ls))).toBe(0)
      }
    }
  })

  it('F-E: a base64 key file an older computer cut through goes, its first line too', () => {
    const pem = K.F.sec1_ec.join('\n') + '\n'
    const b64 = Buffer.from(pem).toString('base64')
    // the base64 that holds the key's body, not its BEGIN and END lines'
    const from = Math.ceil(((K.F.sec1_ec[0].length + 1) * 4) / 3)
    const to = Math.floor(((pem.length - K.F.sec1_ec[K.F.sec1_ec.length - 1].length - 1) * 4) / 3)
    const windows = Array.from({ length: Math.floor((to - from - 16) / 4) }, (_, i) => b64.slice(from + 4 * i, from + 4 * i + 16))
    const forms: Record<string, string> = {
      'tls.key on one line': `apiVersion: v1\ndata:\n  tls.key: ${b64}\nkind: Secret\n`,
      'tls.key wrapped by Helm': `tls:\n  key: |\n${wrap(b64, 76).map((l) => `    ${l}`).join('\n')}\n`,
      'tls.key behind cat -n': wrap(b64, 76).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') + '\n',
    }
    for (const [name, text] of Object.entries(forms)) {
      for (const f of [0.3, 0.6, 0.9]) {
        const at = text.indexOf(b64.slice(0, 40)) + Math.floor((text.lastIndexOf(b64.slice(-20)) - text.indexOf(b64.slice(0, 40))) * f)
        const r = arrived(text, at)
        const left = r.text.replace(/\n\s+(?:\d+\t)?/g, '')
        expect(windows.filter((w) => left.includes(w)), `${name} ${f}`).toEqual([])
      }
    }
  })

  it('F-ROTATION: a key rotated in a git diff, the new one an Ed25519 key or with its first line shared, goes too', () => {
    const other = makeKeys()
    /** A unified diff of a key file from `a` to `b`, the lines they share as context. */
    const diff = (a: string[], b: string[]): string => {
      let i = 0
      while (i < a.length && i < b.length && a[i] === b[i]) i++
      let j = 0
      while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
      return [
        'diff --git a/deploy/id b/deploy/id',
        '--- a/deploy/id',
        '+++ b/deploy/id',
        `@@ -1,${a.length} +1,${b.length} @@`,
        ...a.slice(0, i).map((l) => ` ${l}`),
        ...a.slice(i, a.length - j).map((l) => `-${l}`),
        ...b.slice(i, b.length - j).map((l) => `+${l}`),
        ...a.slice(a.length - j).map((l) => ` ${l}`),
      ].join('\n')
    }
    for (const [name, a, b] of [
      ['OpenSSH Ed25519 to Ed25519 (first line shared)', K.F.openssh, other.F.openssh],
      ['PKCS#8 Ed25519 to Ed25519', K.F.pkcs8_ed25519, other.F.pkcs8_ed25519],
      ['PKCS#8 RSA to Ed25519', K.F.pkcs8_rsa, other.F.pkcs8_ed25519],
    ] as const) {
      const r = screenKeys(diff(a, b))
      expect(leakedWindows(r.text, secretLinesOf(a)), `${name}: the old key`).toBe(0)
      expect(leakedWindows(r.text, secretLinesOf(b)), `${name}: the new key`).toBe(0)
    }
    // a real key swapped for a test's made-up one: the made-up lines under it are left as they are
    const fake = ['-----BEGIN PRIVATE KEY-----', ...Array.from({ length: 6 }, (_, i) => `${'Ab'.repeat(28)}${String(i).padStart(8, '0')}`), '-----END PRIVATE KEY-----']
    const swapped = diff(K.F.pkcs8_rsa, fake)
    const sw = screenKeys(swapped)
    expect(leakedWindows(sw.text, secretLinesOf(K.F.pkcs8_rsa))).toBe(0)
    for (const l of fake.slice(1, -1)) expect(sw.text.includes(`+${l}`)).toBe(true)
  })

  it("F-A's short line counts only in its key lines' frame: a word line over an END line holds no key's tail", () => {
    // (the short line stepped over must be in the frame of the line above it)
    const r64 = (): string => randomBytes(48).toString('base64')
    const text = `  ${r64()}\n  ${r64()}\nok: 7\n-----END PRIVATE KEY-----\n`
    expect(screenKeys(text).removed).toEqual({})
  })

  it('F-IRREGULAR: a key with one line indented, split, joined or re-wrapped goes whole with its END line, and is reported past where it is taken without one', () => {
    const lines = K.F.pkcs8_rsa
    const secret = secretLinesOf(lines)
    const body = lines.slice(1, -1)
    const layouts: Record<string, string[]> = {
      'one line indented': body.map((l, i) => (i === 8 ? `  ${l}` : l)),
      'one line split': [...body.slice(0, 8), body[8].slice(0, 30), body[8].slice(30), ...body.slice(9)],
      'two lines joined': [...body.slice(0, 8), body[8] + body[9], ...body.slice(10)],
      'alternating 64 and 48': wrap(body.join(''), 64).flatMap((l, i) => (i % 2 ? [l.slice(0, 48), l.slice(48)] : [l])).filter(Boolean),
      // (re-wrapped at 50 and 64 by turns: its first line narrower than its second)
      'first line narrower, alternating': (() => {
        const all = body.join('')
        const out: string[] = []
        for (let i = 0, w = 50; i < all.length; i += w, w = w === 50 ? 64 : 50) out.push(all.slice(i, i + w))
        return out
      })(),
    }
    for (const [name, b] of Object.entries(layouts)) {
      const withEnd = screenKeys(`Key:\n${[lines[0], ...b, lines[lines.length - 1]].join('\n')}\nDone.\n`)
      expect(leakedWindows(withEnd.text, secret), `${name}, END line`).toBe(0)
      const noEnd = screenKeys(`Key:\n${[lines[0], ...b].join('\n')}\n`)
      // (taken from its BEGIN line up to the uneven line, and what goes on past it named in a note)
      expect(noEnd.removed, `${name}, no END line`).toEqual({ private_key: 1 })
      if (leakedWindows(noEnd.text, secret) > 0) expect(noEnd.flagged, `${name}, no END line`).toEqual({ private_key: 1 })
    }
  })

  it('F-IRREGULAR: a short EC key with a line indented or re-wrapped goes whole with its END line', () => {
    // (its block stops at the uneven line, and the lines from there up to the END line start inside
    // what the block took: the rest of the block's own key)
    for (const format of ['sec1_ec', 'pkcs8_ec'] as const) {
      const lines = K.F[format]
      const body = lines.slice(1, -1)
      const flat = body.join('')
      const rewrap = (a: number, b: number): string[] => {
        const out: string[] = []
        for (let i = 0, w = a; i < flat.length; i += w, w = w === a ? b : a) out.push(flat.slice(i, i + w))
        return out
      }
      for (const [name, b] of [
        ['one line indented', body.map((l, i) => (i === body.length >> 1 ? `  ${l}` : l))],
        ['re-wrapped at 76 and 64', rewrap(76, 64)],
        ['re-wrapped at 64 and 50', rewrap(64, 50)],
      ] as const) {
        const r = screenKeys(`Key:\n${[lines[0], ...b, lines[lines.length - 1]].join('\n')}\nDone.\n`)
        expect(leakedWindows(r.text, secretLinesOf(lines)), `${format} ${name}`).toBe(0)
      }
    }
  })

  it('F-IRREGULAR: a legacy encrypted key with its second line split goes whole with its END line', () => {
    // (its block stops at the split, and its tail, anchored by the DEK-Info line, runs on from the
    // block's end: the split line's second half between them goes too)
    const l = K.F.rsa_legacy_enc
    const hdrEnd = l.findIndex((x, i) => i > 0 && /^[A-Za-z0-9+/]{40,}={0,2}$/.test(x))
    const body = l.slice(hdrEnd, -1)
    const split = [...l.slice(0, hdrEnd), body[0], body[1].slice(0, 40), body[1].slice(40), ...body.slice(2), l[l.length - 1]]
    const r = screenKeys(`here:\n${split.join('\n')}\nok\n`)
    expect(r.text.includes(body[1].slice(40))).toBe(false)
    expect(leakedWindows(r.text, secretLinesOf(l))).toBe(0)
  })

  it("F-E: where an older computer's cut left 20 to 39 characters of a wrapped base64 key file's line, they go too", () => {
    const b64 = Buffer.from(K.F.pkcs8_rsa.join('\n') + '\n').toString('base64')
    const wrapped = wrap(b64, 76)
    for (const [name, text] of [
      ['Helm', `tls:\n  key: |\n${wrapped.map((l) => `    ${l}`).join('\n')}\n`],
      ['cat -n', wrapped.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') + '\n'],
    ] as const) {
      // the cut falls n characters before the end of the value's 8th line
      const lineEnd = text.indexOf(wrapped[8]) + 76
      for (const n of [20, 25, 32, 39]) {
        const r = arrived(text, lineEnd - n)
        const partial = wrapped[8].slice(-n)
        expect(r.text.includes(partial), `${name} ${n}`).toBe(false)
        expect(r.removed, `${name} ${n}`).toEqual({ private_key_b64: 1 })
      }
    }
  })

  it('F4: a run of key lines with no END line at the start of a text an older computer cut is reported wherever the cut fell', () => {
    // (an OpenSSH Ed25519 key's few lines are structured, not random: not reported, as a dump's would not be)
    for (const format of ['pkcs8_rsa', 'pkcs1_rsa', 'pgp_rsa_nohdr'] as const) {
      const lines = K.F[format].slice(0, -1)
      const text = `${lines.join('\n')}\nThe export stopped here.\n`
      const first = text.indexOf('\n') + 1
      const last = text.lastIndexOf(lines[lines.length - 1]) - 200
      for (let at = first + 1; at < last; at += 37) {
        const r = arrived(text, at)
        expect(r.removed, `${format} cut at ${at}`).toEqual({})
        expect(r.flagged.private_key, `${format} cut at ${at}`).toBe(1)
      }
    }
  })
})

describe("the round-1 rules at their edges", () => {
  const BS = '\\'
  const arrived = (text: string, at: number): ReturnType<typeof screenKeys> => screenKeys(`…${text.slice(at)}`, { cutStart: true })
  const prose = (n: number): string => {
    let s = ''
    for (let i = 0; s.length < n; i++) s += `Step ${i}: the build copied the assets and wrote out/report-${i}.txt.\n`
    return s.slice(0, n)
  }

  it('walks up over line breaks written as CR alone, and over a \\u000a escape right under a block whose frame changed', () => {
    const lines = K.F.pkcs8_rsa
    const secret = secretLinesOf(lines)
    // an older computer's cut through a key whose lines a lone CR joins
    const cr = `Key:\n${JOIN.cr(lines)}\nDone.\n`
    expect(leakedWindows(arrived(cr, cr.indexOf(lines[0]) + Math.floor(JOIN.cr(lines).length * 0.6)).text, secret)).toBe(0)
    // the lines after the frame change start right under the block, behind an escape the
    // between-test reads as no line break
    const half = lines.length >> 1
    const u = `"${[...lines.slice(0, half), ...lines.slice(half, -1).map((l) => `  ${l}`), lines[lines.length - 1]].join(`${BS}u000a`)}"`
    const r = screenKeys(u)
    expect(leakedWindows(r.text, secret)).toBe(0)
    expect(r.spans.filter((s) => s.cls === 'remove').map((s) => s.why)).toEqual(['pkcs8-prefix', 'tail-with-end'])
  })

  it("the doing side's window start inside a listing of a key's tail that starts the text: taken from the window's start", () => {
    // (the walk up from the END line reaches the text's start on a whole line: the key's head is
    // not in the answer, so the tail goes from where the window starts)
    const exp = pgpPhotoExport(20_000)
    const tail = exp.slice(100)
    const listing = tail.map((l, i) => `export.asc:${i + 101}:${l}`).join('\n')
    const text = `${listing}\n${prose(210_000)}`
    const from = text.indexOf(`export.asc:${101 + 200}:`)
    expect(from).toBeGreaterThan(8_000)
    const r = screenKeys(text, { keep: text.length - from })
    expect(r.removed).toEqual({ gpg_block: 1 })
    expect(leakedWindows(r.text, secretLinesOf(exp))).toBe(0)
  })

  it('a line holding more than a frame between a block and its tail stays, and the tail is reported', () => {
    const lines = K.F.pkcs8_rsa
    const body = lines.slice(1, -1)
    // a structured log line, no spaces, with a 20-character id: more than a key line's frame
    const log = `{"level":"info","ts":"2026-10-23T12:00:00Z","msg":"rotating","id":"${randomBytes(15).toString('base64')}"}`
    const text = [lines[0], ...body.slice(0, 6), `  ${body[6]}`, log, ...body.slice(7), lines[lines.length - 1], 'done'].join('\n')
    const r = screenKeys(text)
    expect(r.text.includes(log)).toBe(true)
    // (the tail at its END line, and what follows the uneven line)
    expect(Object.keys(r.flagged)).toEqual(['private_key'])
    expect(r.spans.filter((s) => s.cls === 'remove').map((s) => s.why)).toEqual(['pkcs8-prefix'])
  })

  it("a DSA key rotated in a diff: the new key's lines under the old block go with it, END line and all", () => {
    const other = makeKeys()
    const a = K.F.dsa
    const b = other.F.dsa
    const diff = ['--- a/k', '+++ b/k', '@@ -1 +1 @@', ` ${a[0]}`, ...a.slice(1, -1).map((l) => `-${l}`), ...b.slice(1, -1).map((l) => `+${l}`), ` ${a[a.length - 1]}`].join('\n')
    const r = screenKeys(diff)
    expect(leakedWindows(r.text, secretLinesOf(a))).toBe(0)
    expect(leakedWindows(r.text, secretLinesOf(b))).toBe(0)
  })

  it("an older computer's cut in a BEGIN line: an excerpt of two of a key's first lines goes, a truncated example's one line stays", () => {
    const l = K.F.pkcs1_rsa
    const two = [l[0], l[1], l[2], l[l.length - 1]].join('\n')
    expect(arrived(two, 5).removed).toEqual({ private_key: 1 })
    // a documentation example: a key's header line and its END line, nothing else
    const example = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ${randomBytes(12).toString('base64').slice(0, 14)}\n-----END PRIVATE KEY-----\n`
    // ...and the OpenSSH one a test writes with its line breaks escaped
    const ssh = `-----BEGIN OPENSSH PRIVATE KEY-----${BS}r${BS}nb3BlbnNzaC1rZXktdjEAAAAA${BS}r${BS}n-----END OPENSSH PRIVATE KEY-----${BS}r${BS}nafter`
    for (const [text, head] of [
      [example, 'MIIEvQIB'],
      [ssh, 'b3BlbnNz'],
    ] as const) {
      // (in its BEGIN line, and where only the example's one line is left above its END line: a
      // key's first bytes are no key's tail. A cut inside that line leaves no first bytes, and its
      // rest is taken as a key's, as an older computer's cut of a key's own line is.)
      for (const at of [3, 10, 20, text.indexOf(head)]) {
        const r = arrived(text, at)
        expect(r.text, `cut at ${at}`).toBe(`…${text.slice(at)}`)
        expect(r.removed, `cut at ${at}`).toEqual({})
      }
    }
    // lines that decode to a key of another kind than the END line names are no head of its key
    const mislabelled = [...K.F.openssh.slice(0, -1), '-----END PRIVATE KEY-----'].join('\n')
    expect(arrived(mislabelled, 4).spans.some((s) => s.why === 'tail-decoded')).toBe(false)
  })

  it("a run of fewer than 40 characters right under a key block is no rotated key's lines", () => {
    const l = K.F.pkcs8_rsa
    const body = l.slice(1, -1)
    const x = randomBytes(24).toString('base64').slice(0, 30)
    const text = [l[0], ...body.slice(0, -1), body[body.length - 1].slice(0, 10), `  ${x}`, l[l.length - 1], 'done'].join('\n')
    const r = screenKeys(text)
    expect(r.removed).toEqual({ private_key: 1 })
    expect(r.text.includes(`  ${x}\n${l[l.length - 1]}`)).toBe(true)
  })

  it("a list of hex digests above a bare END line at the start of an older computer's cut stays: a PEM key's lines are base64", () => {
    const hex = Array.from({ length: 12 }, () => randomBytes(32).toString('hex')).join('\n')
    const text = `Checksums:\n${hex}\n-----END PRIVATE KEY-----\nDone.\n`
    // at a line's start, inside a line, and with 40 characters of the last line left
    for (const at of [11, 11 + 65 * 3 + 10, text.indexOf('-----END') - 41]) {
      const r = arrived(text, at)
      expect(r.text, `cut at ${at}`).toBe(`…${text.slice(at)}`)
      expect(r.removed, `cut at ${at}`).toEqual({})
    }
  })

  it("a PKCS#1 key's tail at the top of what is screened goes, with no DEK-Info line above it", () => {
    const l = K.F.pkcs1_rsa
    const r = screenKeys(`${l.slice(8).join('\n')}\nDone.\n`)
    expect(r.removed).toEqual({ private_key: 1 })
    expect(leakedWindows(r.text, secretLinesOf(l))).toBe(0)
  })

  it('reports what goes on past an uneven line up to the next key block, after a tail removed above', () => {
    const top = K.F.pkcs1_rsa.slice(8)
    const a = K.F.pkcs8_rsa
    const body = a.slice(1, -1)
    const uneven = [a[0], ...body.slice(0, 8), `  ${body[8]}`, ...body.slice(9)]
    const text = [...top, 'and the next one:', ...uneven, 'and then', ...K.F.sec1_ec].join('\n')
    const r = screenKeys(text)
    expect(r.removed).toEqual({ private_key: 3 })
    expect(r.flagged).toEqual({ private_key: 1 })
    expect(r.spans.filter((s) => s.why === 'block-rest')).toHaveLength(1)
    expect(leakedWindows(r.text, secretLinesOf(K.F.sec1_ec))).toBe(0)
  })

  it('a key line holding vbLf, vbCrLf or vbNewLine by chance is a key line still: a newline constant stands apart from the base64', () => {
    // (random base64 holds vbLf about once in 270,000 characters: one RSA key's lines in some
    // 10,000 do, and a keyring export's tail with a photo ID often; written in code, a newline
    // constant stands apart, `" & vbCrLf & _`, `"+Environment.NewLine+"`)
    for (const name of ['vbLf', 'vbCrLf', 'vbNewLine']) {
      for (const [fmt, rule] of [['pkcs8_rsa', 'private_key'], ['pgp_rsa_hdr', 'gpg_block']] as const) {
        // at the start of a line, inside it, and at its end
        for (const [where, plant] of [
          ['start', (l: string) => `${name}A${l.slice(name.length + 1)}`],
          ['inside', (l: string) => `${l.slice(0, 10)}A${name}A${l.slice(12 + name.length)}`],
          ['end', (l: string) => `${l.slice(0, l.length - name.length - 1)}A${name}`],
        ] as const) {
          const lines = K.F[fmt].slice()
          const k = lines.length - 6
          lines[k] = plant(lines[k])
          const secret = secretLinesOf(lines)
          const body = lines.findIndex((l, i) => i > 0 && /^[A-Za-z0-9+/]{64}$/.test(l))
          const what = `${fmt}, ${name} at the line's ${where}`
          // a text that starts inside the key, at one of its lines, and an older computer's cut in one
          const inside = screenKeys(`${lines.slice(body + 1).join('\n')}\nDone.\n`)
          expect(inside.removed, what).toEqual({ [rule]: 1 })
          expect(leakedWindows(inside.text, secret)).toBe(0)
          const text = `Key:\n${lines.join('\n')}\nDone.\n`
          const cut = arrived(text, text.indexOf(lines[body + 2]) + 30)
          expect(cut.removed, `${what}, cut`).toEqual({ [rule]: 1 })
          expect(leakedWindows(cut.text, secret)).toBe(0)
          // and the whole key, from its BEGIN line
          expect(screenKeys(text).removed, `${what}, whole`).toEqual({ [rule]: 1 })
        }
      }
    }
  })

  it("at an older computer's cut, the 16 characters of key above an END line count what the cut left of a line and a last line of 1-7", () => {
    // (a cut at 95% of a key leaves a partial line and the short last one: a last line of 8-15
    // characters under a partial one narrower than a key's full lines, or one of 1-7 under a
    // partial one, which the walk up steps over)
    for (const [last, left, taken] of [
      [12, 4, true],
      [12, 9, true],
      [15, 1, true],
      [8, 8, true],
      [12, 3, false],
      [5, 11, true],
      [7, 9, true],
      [5, 10, false],
    ] as const) {
      const lines = K.F.pkcs8_rsa.slice()
      lines[lines.length - 2] = lines[lines.length - 2].slice(0, last)
      const text = `Key:\n${lines.join('\n')}\nDone.\n`
      const at = text.indexOf(`\n${lines[lines.length - 2]}\n-----END`) - left
      const r = arrived(text, at)
      const what = `last line ${last}, ${left} left of the line above`
      // (compared as booleans: a failure prints no key characters)
      if (taken) {
        expect(r.text === '…[REDACTED:private_key]\nDone.\n', what).toBe(true)
        expect(r.removed).toEqual({ private_key: 1 })
      } else {
        // fewer than 16 in all: no key's tail to tell from a fragment, as the K4 row has it
        expect(r.text === `…${text.slice(at)}`, what).toBe(true)
        expect(r.removed).toEqual({})
      }
      expect(r.flagged, what).toEqual({})
    }
    // A legacy key's headers over a made-up body (a test's), cut in its Proc-Type or DEK-Info line:
    // the IV that ends the DEK-Info line is no key line, under a partial one or behind its name.
    // (A cut at the IV's start leaves 16 characters of base64 above the END line, as a key's partial
    // line and its last would: the K4 row's 16 at a cut, and only a text that starts there.)
    for (const iv of ['0011AABB', '0011AABBCCDD']) {
      for (const nl of ['\n', '\\n']) {
        const fixture = ['-----BEGIN RSA PRIVATE KEY-----', 'Proc-Type: 4,ENCRYPTED', `DEK-Info: AES-128-CBC,${iv}`, '', 'MIIE', '-----END RSA PRIVATE KEY-----'].join(nl)
        const text = `const legacy = '${fixture}'\n`
        const p = text.indexOf('Proc-Type')
        for (let at = p; at < text.indexOf(iv); at++) {
          const r = arrived(text, at)
          expect(r.text, `IV ${iv.length}, ${JSON.stringify(nl)}, cut ${at - p} into the headers`).toBe(`…${text.slice(at)}`)
        }
      }
    }
  })

  it("a truncated OpenSSH example an older computer's cut fell inside stays: what is left of its magic is a key's first bytes", () => {
    // (the one line a test writes for OpenSSH's format, `openssh-key-v1` and the zeros after it:
    // where the cut took its first characters, what is left no longer starts with the magic)
    const magic = Buffer.from('openssh-key-v1\0\0\0\0', 'latin1').toString('base64')
    for (const nl of ['\n', '\\r\\n']) {
      const text = `const ssh = '-----BEGIN OPENSSH PRIVATE KEY-----${nl}${magic}${nl}-----END OPENSSH PRIVATE KEY-----${nl}after'\n`
      const p = text.indexOf(magic)
      for (let at = p; at < p + magic.length; at++) {
        const r = arrived(text, at)
        expect(r.text, `${JSON.stringify(nl)}, cut ${at - p} into the example`).toBe(`…${text.slice(at)}`)
        // (16 characters or more of it left: reported, as a made-up body's are)
        expect(r.flagged, `cut ${at - p}`).toEqual(p + magic.length - at >= 16 ? { private_key: 1 } : {})
      }
    }
  })
})

describe('the structure checks, on decoded bytes', () => {
  const int = (v: number[]): Buffer => der(0x02, Buffer.from(v))
  const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts))
  const oid = (bytes: number[]): Buffer => der(0x06, Buffer.from(bytes))
  const RSA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]
  const PBES2 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0d]
  const PKCS12 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x01, 0x03]

  it('reads PKCS#8, encrypted PKCS#8, PKCS#1 or DSA, and SEC1 headers, and nothing else', () => {
    const r = randomBytes(64)
    expect(structureOf(seq(int([0]), seq(oid(RSA_OID)), der(0x04, r)))).toMatchObject({ type: 'pkcs8' })
    expect(structureOf(seq(int([1]), seq(oid(RSA_OID)), der(0x04, r)))).toMatchObject({ type: 'pkcs8' })
    // (a PKCS#8 whose key OCTET STRING the decode did not reach: the bytes end at its tag)
    expect(structureOf(seq(int([0]), seq(oid(RSA_OID)), randomBytes(40)).subarray(0, 18))).toMatchObject({ type: 'pkcs8' })
    expect(structureOf(seq(int([0]), seq(oid(RSA_OID)), der(0x03, r)))).toBeNull() // a BIT STRING: not a key
    expect(structureOf(seq(int([0]), seq(der(0x04, r)), der(0x04, r)))).toBeNull() // no OID
    expect(structureOf(seq(int([2]), seq(oid(RSA_OID)), der(0x04, r)))).toBeNull() // version 2
    expect(structureOf(seq(seq(oid(PBES2), r), der(0x04, r)))).toMatchObject({ type: 'encrypted-pkcs8' })
    expect(structureOf(seq(seq(oid(PKCS12), r), der(0x04, r)))).toMatchObject({ type: 'encrypted-pkcs8' })
    expect(structureOf(seq(seq(oid(PBES2), r)).subarray(0, 40))).toMatchObject({ type: 'encrypted-pkcs8' }) // cut before its OCTET STRING
    expect(structureOf(seq(seq(oid(PBES2), r), der(0x03, r)))).toBeNull()
    expect(structureOf(seq(seq(oid(RSA_OID), r), der(0x03, r)))).toBeNull() // SubjectPublicKeyInfo
    expect(structureOf(seq(seq(der(0x02, r)), der(0x04, r)))).toBeNull()
    expect(structureOf(seq(der(0x04, r), der(0x04, r)))).toBeNull()
    expect(structureOf(seq(int([0]), der(0x02, randomBytes(64))))).toMatchObject({ type: 'pkcs1-or-dsa' })
    expect(structureOf(seq(int([0]), der(0x02, randomBytes(40)), r))).toBeNull() // too short a modulus
    expect(structureOf(seq(int([1]), der(0x02, randomBytes(64))))).toBeNull()
    expect(structureOf(seq(int([1]), der(0x04, randomBytes(32)), r))).toMatchObject({ type: 'sec1' })
    expect(structureOf(seq(int([1]), der(0x04, randomBytes(8)), r))).toBeNull()
    expect(structureOf(seq(int([1]), der(0x04, randomBytes(80)), r))).toBeNull()
    expect(structureOf(seq(int([0]), der(0x04, randomBytes(32)), r))).toBeNull()
    expect(structureOf(seq(int([1]), der(0x05, Buffer.alloc(0)), r))).toBeNull()
    expect(structureOf(seq(int([0, 0]), der(0x04, r)))).toBeNull() // a 2-byte version
    // the outer SEQUENCE and its first element
    expect(structureOf(Buffer.from([0x31, 0x40, ...randomBytes(64)]))).toBeNull()
    expect(structureOf(seq(randomBytes(8)))).toBeNull() // under 32 bytes
    expect(structureOf(Buffer.from([0x30, 0x40]))).toBeNull() // nothing in it
    expect(structureOf(Buffer.from([0x30, 0x40, 0x02, 0x01, 0x00]))).toBeNull() // a version, then nothing
    expect(structureOf(Buffer.from([0x30, 0x40, 0x02, 0x85, 0, 0, 0, 0, 1]))).toBeNull() // a 5-byte length
    expect(structureOf(Buffer.from([0x30, 0x40, 0x02, 0x80]))).toBeNull() // an indefinite length
    expect(structureOf(Buffer.from([0x30, 0x40, 0x02, 0x82, 0x01]))).toBeNull() // its length cut
    expect(structureOf(Buffer.from([0x30]))).toBeNull()
    expect(structureOf(Buffer.alloc(0))).toBeNull()
  })

  it('reads the OpenSSH blob down to its key count', () => {
    const str = (s: string | Buffer): Buffer => {
      const b = Buffer.isBuffer(s) ? s : Buffer.from(s)
      const n = Buffer.alloc(4)
      n.writeUInt32BE(b.length)
      return Buffer.concat([n, b])
    }
    const u32 = (v: number): Buffer => {
      const n = Buffer.alloc(4)
      n.writeUInt32BE(v)
      return n
    }
    const magic = Buffer.concat([Buffer.from('openssh-key-v1'), Buffer.from([0])])
    const blob = (cipher: string, kdf: string, keys: number): Buffer => Buffer.concat([magic, str(cipher), str(kdf), str(Buffer.alloc(0)), u32(keys), randomBytes(64)])
    expect(structureOf(blob('none', 'none', 1))).toEqual({ type: 'openssh', declared: 0 })
    expect(structureOf(blob('aes256-ctr', 'bcrypt', 16))).toEqual({ type: 'openssh', declared: 0 })
    expect(structureOf(blob('rot13', 'none', 1))).toBeNull()
    expect(structureOf(blob('none', 'scrypt', 1))).toBeNull()
    expect(structureOf(blob('none', 'none', 0))).toBeNull()
    expect(structureOf(blob('none', 'none', 17))).toBeNull()
    expect(opensshHeader(magic)).toBe(false) // the magic alone, as a truncated example shows it
    expect(opensshHeader(Buffer.concat([magic, str('none')]))).toBe(false) // no KDF
    expect(opensshHeader(Buffer.concat([magic, str('none'), str('none')]))).toBe(false) // no KDF options
    expect(opensshHeader(Buffer.concat([magic, str('none'), str('none'), str('')]))).toBe(false) // no key count
    expect(opensshHeader(Buffer.concat([magic, u32(5000), randomBytes(5000)]))).toBe(false) // a string too long
    expect(opensshHeader(Buffer.concat([magic, u32(40), Buffer.from('none')]))).toBe(false) // a string cut short
    expect(structureOf(Buffer.concat([Buffer.from([0x3f, 0x6f, 0xf9, 0xeb]), randomBytes(4)]))).toEqual({ type: 'ssh2', declared: 0 })
    expect(structureOf(Buffer.from([0x3f, 0x6f, 0xf9, 0xeb, 1, 2]))).toBeNull() // SSH2's magic, then too little
  })

  /** An OpenPGP packet: header byte(s), then the body. */
  const v4 = (algo: number, field: Buffer): Buffer => Buffer.concat([Buffer.from([4]), randomBytes(4), Buffer.from([algo]), field, randomBytes(200)])
  const mpiField = (bits: number, top: number): Buffer => Buffer.from([bits >> 8, bits & 255, top, ...randomBytes(8)])
  const oldHdr = (tag: number, len: number): Buffer => Buffer.from([0x80 | (tag << 2) | 1, len >> 8, len & 255])

  it('reads an OpenPGP secret-key packet down to its algorithm and first field', () => {
    const rsa = v4(1, mpiField(2048, 0x80))
    expect(pgpPacket(Buffer.concat([oldHdr(5, rsa.length), rsa]))).toEqual({ tag: 5, v: 4, algo: 1 })
    expect(pgpPacket(Buffer.concat([oldHdr(7, rsa.length), rsa]))).toEqual({ tag: 7, v: 4, algo: 1 })
    // the old format's 1- and 4-byte lengths, and its indeterminate length
    expect(pgpPacket(Buffer.concat([Buffer.from([0x80 | (5 << 2), 200]), rsa]))).toMatchObject({ tag: 5 })
    expect(pgpPacket(Buffer.concat([Buffer.from([0x80 | (5 << 2) | 2, 0, 0, 1, 0]), rsa]))).toMatchObject({ tag: 5 })
    expect(pgpPacket(Buffer.concat([Buffer.from([0x80 | (5 << 2) | 3]), rsa]))).toBeNull()
    // the new format's 1-, 2- and 5-byte lengths, and a partial length
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 100]), rsa]))).toMatchObject({ tag: 5 })
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 192, 50]), rsa]))).toMatchObject({ tag: 5 })
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 255, 0, 0, 1, 0]), rsa]))).toMatchObject({ tag: 5 })
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 230]), rsa]))).toBeNull()
    // other tags, lengths and versions
    expect(pgpPacket(Buffer.concat([oldHdr(6, rsa.length), rsa]))).toBeNull() // a public key
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 20]), rsa]))).toBeNull() // too short a body
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 255, 0, 2, 0, 0]), rsa]))).toBeNull() // too long a body
    expect(pgpPacket(Buffer.concat([oldHdr(5, rsa.length), Buffer.from([2]), rsa.subarray(1)]))).toBeNull()
    expect(pgpPacket(Buffer.concat([oldHdr(5, rsa.length), Buffer.from([7]), rsa.subarray(1)]))).toBeNull()
    expect(pgpPacket(Buffer.from([0x40, ...randomBytes(20)]))).toBeNull() // no packet bit
    expect(pgpPacket(randomBytes(8))).toBeNull()
    // v3: time, validity, then an RSA algorithm only
    const v3 = Buffer.concat([Buffer.from([3]), randomBytes(6), Buffer.from([1]), mpiField(1024, 0x80), randomBytes(100)])
    expect(pgpPacket(Buffer.concat([oldHdr(5, v3.length), v3]))).toMatchObject({ v: 3 })
    const v3dsa = Buffer.concat([Buffer.from([3]), randomBytes(6), Buffer.from([17]), mpiField(1024, 0x80), randomBytes(100)])
    expect(pgpPacket(Buffer.concat([oldHdr(5, v3dsa.length), v3dsa]))).toBeNull()
    // the MPI's bit count and its top byte agree; out of range they don't count
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(1, mpiField(2047, 0x40))]))).toMatchObject({ algo: 1 })
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(1, mpiField(2048, 0x40))]))).toBeNull()
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(1, mpiField(2048, 0))]))).toBeNull()
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(1, mpiField(100, 0x08))]))).toBeNull()
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(1, mpiField(20000, 0x80))]))).toBeNull()
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(99, mpiField(2048, 0x80))]))).toBeNull() // no such algorithm
    // a curve OID: its length, then 1.2 or 1.3
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(22, Buffer.from([9, 0x2b, 6, 1, 4, 1, 0xda, 0x47, 0x0f, 1]))]))).toMatchObject({ algo: 22 })
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(18, Buffer.from([8, 0x2a, 0x86, 0x48, 0xce, 0x3d, 3, 1, 7]))]))).toMatchObject({ algo: 18 })
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(19, Buffer.from([3, 0x2b, 1, 2]))]))).toBeNull()
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(19, Buffer.from([12, 0x2b, 1, 2]))]))).toBeNull()
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(19, Buffer.from([8, 0x06, 1, 2]))]))).toBeNull()
    // v5 and v6 carry a key-material count; 25-28 are v6 keys only
    const v6 = (algo: number, count: number): Buffer => Buffer.concat([Buffer.from([6]), randomBytes(4), Buffer.from([algo]), Buffer.from([count >> 24, (count >> 16) & 255, (count >> 8) & 255, count & 255]), mpiField(2048, 0x80), randomBytes(100)])
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 150]), v6(27, 64)]))).toMatchObject({ v: 6, algo: 27 })
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 150]), v6(1, 100)]))).toMatchObject({ v: 6, algo: 1 })
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 150]), v6(27, 8)]))).toBeNull()
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 150]), v6(27, 5000)]))).toBeNull()
    expect(pgpPacket(Buffer.concat([oldHdr(5, 200), v4(27, mpiField(2048, 0x80))]))).toBeNull() // Ed25519 in v4
    // a packet cut before its count or its first field (a 5-byte length leaves room for neither)
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 255, 0, 0, 0, 100, 6]), randomBytes(4), Buffer.from([27, 0, 0])]))).toBeNull()
    expect(pgpPacket(Buffer.concat([Buffer.from([0xc5, 255, 0, 0, 0, 100, 4]), randomBytes(4), Buffer.from([1])]))).toBeNull()
  })

  it('decodes a payload glued to a frame of up to 3 characters, and finds none in plain text', () => {
    const p8 = K.F.pkcs8_rsa.slice(1, -1)
    for (const glue of ['', '+', '//', '>> ']) {
      const text = p8.map((l) => glue + l).join('\n')
      const runs: Array<[number, number]> = []
      let at = 0
      for (const l of text.split('\n')) {
        runs.push([at + l.indexOf(glue) + (glue.trim() === '' ? glue.length : 0), at + l.length])
        at += l.length + 1
      }
      expect(decodeHead(text, runs), JSON.stringify(glue)).toMatchObject({ type: 'pkcs8' })
    }
    expect(decodeHead('Q'.repeat(64), [[0, 64]])).toBeNull()
  })
})

describe('looksRandom and placeholderWhy', () => {
  it('tells random base64 and hex from text, fills, sequences and short values', () => {
    expect(looksRandom(randomBytes(48).toString('base64'))).toBe(true)
    // (hex long enough that its ascending pairs, 1 in 9, stay under a fifth with margin)
    expect(looksRandom(randomBytes(128).toString('hex'))).toBe(true)
    expect(looksRandom(randomBytes(6000).toString('base64'))).toBe(true) // sampled from its first 4,096
    expect(looksRandom('short')).toBe(false)
    expect(looksRandom('Ab'.repeat(32))).toBe(false) // few distinct
    expect(looksRandom('0123456789abcdef'.repeat(4))).toBe(false) // hex, few distinct
    expect(looksRandom(randomBytes(30).toString('base64') + 'AAAAAAAA' + randomBytes(30).toString('base64'))).toBe(false) // a run of 6
    expect(looksRandom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')).toBe(false) // a sequence
    expect(looksRandom('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.split('').reverse().join('') + '+/')).toBe(false)
    expect(looksRandom('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'.repeat(2))).toBe(false) // repeated trigrams
  })

  it('names why a value is a placeholder, and passes random ones', () => {
    expect(placeholderWhy(randomBytes(32).toString('base64url'), 'b62')).toBeNull()
    expect(placeholderWhy(randomBytes(16).toString('hex'), 'hex')).toBeNull()
    expect(placeholderWhy('ab-cd', 'b62')).toBe('short')
    expect(placeholderWhy('Q'.repeat(43), 'b62')).toBe('repeat')
    expect(placeholderWhy('a1'.repeat(4) + 'bbbbbbbb' + 'c2'.repeat(4), 'hex')).toBe('repeat')
    expect(placeholderWhy('abacadaeafagahbcbdbebfbgbhcdcecfcgch', 'b62')).toBe('few-distinct')
    expect(placeholderWhy('fpousrbA0xZfpousrbA0xZfpousrbA0xZ', 'b62')).toBe('periodic')
    expect(placeholderWhy('xQ12345678wZ', 'b62')).toBe('sequence')
    expect(placeholderWhy('myExampleKey9Zq', 'b62')).toBe('word')
    expect(placeholderWhy('abcqwertyzxcvbnmpoiuylkjhgfdsa02', 'b62')).toBe('one-case')
    expect(placeholderWhy('ABCQWERTYZXCVBNMPOIUYLKJHGFDSA02', 'b62')).toBe('one-case')
    expect(placeholderWhy('my-dev-signing-key-for-2026-q4', 'b62')).toBe('slug')
    expect(placeholderWhy('ExperimentalPrototypeProjects2026', 'b62')).toBe('wordy')
    expect(placeholderWhy('ExperimentalPrototypeProjects', 'b62')).toBe('wordy')
    expect(placeholderWhy(randomBytes(16).toString('hex'), 'b62')).toBeNull() // hex in a base62 slot: not one case
  })
})

describe('detectorStart: each detector looks back for its own opener', () => {
  const prose = (n: number): string => Array.from({ length: n }, (_, i) => `Line ${i}: the build finished and the deploy step copied the files.`).join('\n')

  it('reaches a BEGIN line 256 KB back when the cut falls among key lines, and only then', () => {
    const p1 = K.F.pkcs1_rsa
    const pre = prose(500)
    // a key block so long its BEGIN line is far back: 200 KB of key lines
    const lines = [p1[0], ...wrap(randomBytes(150000).toString('base64'))]
    const text = `${pre}\n${lines.join('\n')}\n${prose(10)}`
    const begin = text.indexOf('-----BEGIN')
    const from = begin + 190000
    expect(detectorStart(text, from, 4096)).toBeLessThanOrEqual(begin)
    // in prose, far from any key line: the lookback alone
    const plain = `${p1.join('\n')}\n${prose(4000)}`
    const cut = plain.length - 3000
    expect(detectorStart(plain, cut, 4096)).toBe(cut - 4096)
    expect(detectorStart(plain, 0, 4096)).toBe(0)
  })

  it('finds an opener that sits right at the edge of where it looks', () => {
    // a PRIVATE KEY string that starts exactly where the search for one ends (the cut + 64): the
    // BEGIN line before it is still found. (Dots, so no base64 run reaches back past the cut.)
    const p1 = K.F.pkcs1_rsa
    const head = `${prose(20)}\n${p1.slice(0, 8).join('\n')}\n`
    const from = head.length + 10
    const text = head + '.'.repeat(from + 64 - head.length) + 'PRIVATE KEY' + '\n' + wrap(randomBytes(300).toString('base64')).join('\n')
    expect(text.indexOf('PRIVATE KEY', from)).toBe(from + 64)
    expect(detectorStart(text, from, 1)).toBe(text.indexOf('PRIVATE KEY') - 64)
  })

  it('looks back for kty, RSAKeyValue, OpenVPN, Private-Lines and a base64 run the cut is in', () => {
    // back over the run and the space before it (a run's indent), to the `:`
    const b64 = randomBytes(30000).toString('base64')
    const data = `${prose(50)}\ndata: ${b64}\n`
    expect(detectorStart(data, data.indexOf(b64) + 20000, 4096)).toBe(data.indexOf('data:') + 5)
    const jwk = `${prose(100)}\n{"kty":"EC",${' '.repeat(6000)}"d":"x"}`
    const kty = jwk.indexOf('kty')
    expect(detectorStart(jwk, jwk.length - 10, 16)).toBe(kty - 4096)
    const xml = `${prose(100)}\n<RSAKeyValue>${' '.repeat(10000)}<D>x</D>`
    expect(detectorStart(xml, xml.length - 5, 16)).toBe(xml.indexOf('RSAKeyValue'))
    // (an .ovpn: its CA certificate, then the static key the cut falls in; the certificate's random
    // base64 held `kty` one run in 40, and the JWK opener moved the start to 0)
    const ca = randomBytes(1500).toString('base64').replace(/kty/g, 'kTy')
    const ovpn = `${prose(10)}\n<ca>\n${wrap(ca).join('\n')}\n</ca>\n#\n# 2048 bit OpenVPN static key\n#\n-----BEGIN OpenVPN Static key V1-----\n${wrap(randomBytes(256).toString('hex'), 32).join('\n')}\n-----END OpenVPN Static key V1-----\n`
    expect(detectorStart(ovpn, ovpn.indexOf('-----BEGIN OpenVPN') + 200, 16)).toBe(ovpn.indexOf('OpenVPN Static key') - 16)
    // with the cut past its END line, the END line's name is what is found: the key is over
    const after = `${ovpn}<tls-auth>\n<cert>\n${wrap(randomBytes(1500).toString('base64')).join('\n')}\n</cert>\n`
    expect(detectorStart(after, after.length - 100, 16)).toBe(after.lastIndexOf('OpenVPN Static key') - 16)
    // a static key alone, 32 hex characters a line, is followed back as a base64-ish run instead
    const alone = `${prose(10)}\n-----BEGIN OpenVPN Static key V1-----\n${wrap(randomBytes(256).toString('hex'), 32).join('\n')}\n`
    expect(detectorStart(alone, alone.length - 100, 16)).toBe(prose(10).length)
    const ppk = `${prose(300)}\nPrivate-Lines: 14\n${wrap(randomBytes(3000).toString('base64')).join('\n')}\n`
    expect(detectorStart(ppk, ppk.length - 100, 16)).toBe(ppk.indexOf('Private-Lines:') - 16384)
  })
})

describe('each detector at its edges', () => {
  const rndLines = (bytes: number, w = 64): string[] => wrap(randomBytes(bytes).toString('base64'), w)

  it('key blocks: a header with prose under it, an END line with no closing dashes, a suffix on the last line, a glued legacy key', () => {
    const p8 = K.F.pkcs8_rsa
    // more than 2 KB of prose under a BEGIN line before any base64: not its key
    const prose = Array.from({ length: 60 }, (_, i) => `step ${i}: the deploy copied the files and moved on.`).join('\n')
    expect(prose.length).toBeGreaterThan(2048)
    const far = [p8[0], prose, ...p8.slice(1)].join('\n')
    expect(keyBlocks(far)[0]).toMatchObject({ cls: 'flag', why: 'header-only' })
    // an END line cut before its closing dashes: the block ends with its line
    const cut = [...p8.slice(0, -1), '-----END PRIVATE KEY', 'after'].join('\n')
    const r = screenKeys(cut)
    expect(r.text).toBe('[REDACTED:private_key]\nafter')
    // words after the last key line, and no END line: the key ends with its last line
    const said = [...p8.slice(0, -2), `${p8[p8.length - 2]} # the key ends here`, 'more'].join('\n')
    expect(screenKeys(said).text).toBe('[REDACTED:private_key] # the key ends here\nmore')
    // a legacy encrypted key written with no separators: its body is glued to the DEK-Info IV
    const glued = K.F.rsa_legacy_enc.join('')
    const g = screenKeys(`KEY="${glued}"`)
    expect(g.removed).toEqual({ private_key: 1 })
    expect(leakedWindows(g.text, secretLinesOf(K.F.rsa_legacy_enc))).toBe(0)
    // an OpenVPN header over no key, and over a made-up one
    expect(keyBlocks('-----BEGIN OpenVPN Static key V1-----\n-----END OpenVPN Static key V1-----')[0]).toMatchObject({ cls: 'flag', why: 'openvpn-header' })
    expect(keyBlocks(`-----BEGIN OpenVPN Static key V1-----\n${Array(16).fill('0123'.repeat(8)).join('\n')}\n-----END OpenVPN Static key V1-----`)[0]).toMatchObject({ cls: 'flag', why: 'openvpn-header' })
    // SSH2's magic over two short random lines: a key too short for its structure, still its own
    const ssh2 = wrap(Buffer.concat([Buffer.from([0x3f, 0x6f, 0xf9, 0xeb]), randomBytes(70)]).toString('base64'))
    expect(keyBlocks(['---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----', ...ssh2, '---- END SSH2 ENCRYPTED PRIVATE KEY ----'].join('\n'))[0]).toMatchObject({ cls: 'remove', why: 'ssh2-short' })
  })

  it('key tails: where the head is, and is not, out of view', () => {
    const p8 = K.F.pkcs8_rsa
    const body = secretLinesOf(p8)
    const END = '-----END PRIVATE KEY-----'
    // a tail at the top, then a whole key block: both removed, each by its own rule
    const two = [...body.slice(8), END, 'and the next one:', ...K.F.sec1_ec].join('\n')
    expect(screenKeys(two).removed).toEqual({ private_key: 2 })
    // cut mid-line, no ellipsis: the partial line goes too
    const mid = body.slice(8).join('\n')
    const m = screenKeys(`${mid.slice(30)}\n${END}\nok`)
    expect(m.text).toBe('[REDACTED:private_key]\nok')
    // a second key's lines glued to the first key's END line, its own BEGIN line missing
    const glued = [...p8.slice(0, -1), `${END}${body[0]}`, ...body.slice(1), END, 'done'].join('\n')
    const gl = screenKeys(glued)
    expect(gl.text.endsWith('done')).toBe(true)
    expect(leakedWindows(gl.text, body)).toBe(0)
    // hashes above an END line after another key: not at the top, not under it: flagged
    const hashes = Array.from({ length: 4 }, () => randomBytes(48).toString('base64'))
    const after = [...K.F.sec1_ec, 'The checksums of the release, for the record:', ...hashes, END, 'end'].join('\n')
    const a = screenKeys(after)
    expect(a.removed).toEqual({ private_key: 1 })
    expect(a.flagged).toEqual({ private_key: 1 })
    for (const h of hashes) expect(a.text.includes(h)).toBe(true)
    // at the top, under more than 1 KB of text: flagged
    const long = `${'The build log goes on and on. '.repeat(40)}\n${rndLines(400).join('\n')}\n${END}\n`
    expect(screenKeys(long)).toMatchObject({ text: long, removed: {}, flagged: { private_key: 1 } })
    // at the top, under two lines of words: flagged
    const words = `word\nmore\n${rndLines(400).join('\n')}\n${END}\n`
    expect(screenKeys(words)).toMatchObject({ text: words, removed: {}, flagged: { private_key: 1 } })
    // a cut-start tail of 20 characters under two lines of words: not a tail
    const under = `word\nmore\n${body[body.length - 1].slice(-20)}\n${END}\n`
    expect(screenKeys(under, { cutStart: true }).removed).toEqual({})
    // a key line glued to the END marker, and one with a stray mark before it: an END line that
    // carries more than a key line and joiners in front of it is not written as a key's END line,
    // so what is above it is only reported
    expect(screenKeys(`${body.slice(5).join('')}${END}`).removed).toEqual({})
    const stray = screenKeys(`${body.slice(5, -1).join('\n')}\n${body[body.length - 1]}!!${END}\n`)
    expect(stray.removed).toEqual({})
    expect(stray.flagged).toEqual({ private_key: 1 })
  })

  it('a cut-start run: one width, one frame, and no words after it', () => {
    const lines = rndLines(900)
    // two runs on its first line, the second shorter; words end it; no break after the last line
    const first = `${lines[0]} abcdefgh12`
    const run = [first, ...lines.slice(1, 6)].join('\n')
    expect(headless(run, [], { cutAt: 0 }).map((s) => s.why)).toEqual(['cut-start-run'])
    const worded = [lines[0], lines[1], `${lines[2]} and then the words go on`, ...lines.slice(3, 8)].join('\n')
    expect(headless(worded, [], { cutAt: 0 })).toEqual([{ rule: 'private_key', cls: 'flag', why: 'cut-start-run', from: 0, to: worded.indexOf(' and then') }])
    expect(headless('no key lines at all\n', [], { cutAt: 0 })).toEqual([])
  })

  it('PuTTY: a listing with a long path, one line, two lines, a Java literal, a gap, a long run, an early MAC, two files', () => {
    const ppk = K.ppk
    const at = ppk.findIndex((l) => l.startsWith('Private-Lines'))
    const priv = ppk.slice(at + 1, -1)
    const LONGPATH = '/home/dev/projects/infrastructure/deployment/keys/production'
    const listed = ppk.map((l, i) => `${LONGPATH}/deploy.ppk:${i + 1}:${l}`).join('\n')
    expect(leakedWindows(screenKeys(listed).text, priv)).toBe(0)
    const oneLine = screenKeys(`PPK="${ppk.join(' ')}"`)
    expect(oneLine.removed).toEqual({ putty_private_key: 1 })
    expect(leakedWindows(oneLine.text, priv)).toBe(0)
    // two private lines, the second short: the line before it has nothing to compare with
    const two = ['PuTTY-User-Key-File-3: ssh-ed25519', 'Private-Lines: 2', randomBytes(48).toString('base64'), randomBytes(15).toString('base64'), `Private-MAC: ${randomBytes(32).toString('hex')}`].join('\n')
    expect(screenKeys(two).removed).toEqual({ putty_private_key: 1 })
    // a Java literal joined with System.lineSeparator(): its 13 letters are frame, not a line
    const java = 'String PPK = ' + ppk.map((l) => `"${l}"`).join(' + System.lineSeparator()\n    + ') + ';'
    const j = screenKeys(java)
    expect(j.removed).toEqual({ putty_private_key: 1 })
    expect(leakedWindows(j.text, priv)).toBe(0)
    // a gap of more than 256 characters before the first line, and a run too long to be glued lines
    expect(puttyKeys(`Private-Lines: 2\n${'.'.repeat(300)}\n${priv[0]}\n${priv[1]}\n`).map((s) => s.cls)).toEqual(['flag'])
    // an entity between the anchor and the lines is stepped over (no line break in it)
    expect(puttyKeys(`Private-Lines: 2 &nbsp;\n${priv[0]}\n${priv[1]}\n`).map((s) => s.cls)).toEqual(['remove'])
    expect(puttyKeys(`Private-Lines: 14\n${randomBytes(300).toString('base64')}\n`).map((s) => s.why)).toEqual(['ppk 0/14'])
    // three of fourteen lines, then the MAC: what there is goes
    const early = ['Private-Lines: 14', ...priv.slice(0, 3), `Private-MAC: ${randomBytes(32).toString('hex')}`].join('\n')
    expect(puttyKeys(early).map((s) => [s.cls, s.why])).toEqual([['remove', 'ppk 3/14 mac']])
    // no MAC line, and a P after the lines that starts no MAC
    expect(puttyKeys(['Private-Lines: 2', priv[0], priv[1], 'Press Enter to go on.'].join('\n')).map((s) => s.why)).toEqual(['ppk 2/2'])
    // two files: each private part named from its own first line
    const both = `${ppk.join('\n')}\n\n${K.ppk.join('\n')}\n`
    const spans = puttyKeys(both)
    expect(spans.map((s) => s.from)).toEqual([0, ppk.join('\n').length + 2])
  })

  it('JWK and RSAKeyValue: nested objects, an unclosed object, a member set twice', () => {
    const ec = K.J.ec
    // a nested object before kty
    const nested = JSON.stringify({ meta: { use: 'sig' }, kty: 'EC', crv: 'P-256', x: ec.x, d: ec.d })
    const n = screenKeys(nested)
    expect(n.removed).toEqual({ jwk_private_key: 1 })
    expect(n.text.includes(ec.d as string)).toBe(false)
    // two keys in a YAML list, 1 KB around the first kty: both values taken from it, the second
    // kty in that stretch not looked at again
    const d2 = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }).d as string
    const yaml = `keys:\n  - kty: EC\n    crv: P-256\n    d: ${ec.d}\n  - kty: EC\n    crv: P-256\n    d: ${d2}\n`
    const y = screenKeys(yaml)
    expect(y.text.includes(ec.d as string) || y.text.includes(d2)).toBe(false)
    expect(jwkKeys(yaml).map((s) => s.why)).toEqual(['jwk EC d', 'jwk EC d'])
    // a JWK cut before its closing brace
    const unclosed = `{"kty":"EC","crv":"P-256","x":"${ec.x}","d":"${ec.d}"`
    expect(screenKeys(unclosed).removed).toEqual({ jwk_private_key: 1 })
    // an RSAKeyValue with no closing tag, and another one 1 KB on: each looked at once
    const open = `<RSAKeyValue><D>${Buffer.from(K.J.rsa.d as string, 'base64url').toString('base64')}</D>\n${'x'.repeat(1000)}\n<RSAKeyValue><D>short</D>`
    expect(rsaKeyValues(open).map((s) => [s.cls, s.why])).toEqual([['remove', 'RSAKeyValue D']])
  })

  it('base64 key files: a run with a character glued before it decodes a step on', () => {
    const b64 = Buffer.from(K.F.sec1_ec.join('\n') + '\n').toString('base64')
    const r = screenKeys(`+${b64}\n`)
    expect(r.removed).toEqual({ private_key_b64: 1 })
    expect(r.text.includes(b64.slice(20, 60))).toBe(false)
  })
})

describe('the detectors find nothing in text that has no key', () => {
  it('returns no span for prose, and every search starts where it is told to', () => {
    const text = 'Nothing to see here. A long line of prose with no key in it at all, and more of it.\n'.repeat(50)
    const { blocks, spans } = keySpans(text)
    expect(blocks).toEqual([])
    expect(spans).toEqual([])
    expect(headless(text, blocks)).toEqual([])
    // a block before `start` is not looked at
    const k = K.F.pkcs8_rsa.join('\n') + '\n' + text
    expect(keySpans(k, K.F.pkcs8_rsa.join('\n').length).spans).toEqual([])
    expect(rsaKeyValues('<RSAKeyValue></RSAKeyValue>')).toEqual([])
  })
})

describe('the detectors cost in step with the text, whatever the other computer sends', () => {
  /** The fastest of three runs, so a pause on a busy box doesn't count against a detector; no more
   *  runs once one took longer than `giveUp` (a run that long is the answer already). */
  function bestOf3(run: () => void, giveUp = Infinity): number {
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      run()
      best = Math.min(best, performance.now() - t)
      if (best > giveUp) break
    }
    return best
  }

  it('RSAKeyValue: a member left open, only whitespace after it and no closing tag, is read in step with its length', () => {
    // The value and the whitespace before its closing tag could both take a space: with no closing
    // tag, every way of sharing a run of spaces between them was tried (4,000 spaces took 9 s).
    for (const ws of [' ', '\n', '\r\n\t']) {
      const open = `<RSAKeyValue><D>${ws.repeat(3000)}`
      expect(bestOf3(() => rsaKeyValues(open)), JSON.stringify(ws)).toBeLessThan(50)
      expect(rsaKeyValues(open)).toEqual([])
    }
    // whitespace around a value, inside its tags, is the XML's: only the value goes
    const d = Buffer.from(K.J.rsa.d as string, 'base64url').toString('base64')
    const pretty = `<RSAKeyValue>\n  <D>\n    ${d}\n  </D>\n</RSAKeyValue>`
    expect(screenKeys(pretty).text).toBe('<RSAKeyValue>\n  <D>\n    [REDACTED:xml_private_key]\n  </D>\n</RSAKeyValue>')
    // a value wrapped over lines is one value, its inner line breaks included
    const wrapped = `<RSAKeyValue><D>${wrap(d, 76).join('\n')}</D></RSAKeyValue>`
    expect(screenKeys(wrapped).text).toBe('<RSAKeyValue><D>[REDACTED:xml_private_key]</D></RSAKeyValue>')
    // a member left unclosed ends where the next member's tag starts, and that member is read too
    const p = Buffer.from(K.J.rsa.p as string, 'base64url').toString('base64')
    const q = Buffer.from(K.J.rsa.q as string, 'base64url').toString('base64')
    expect(rsaKeyValues(`<RSAKeyValue><D>${d}<P>${p}</P><Q>${q}</Q></RSAKeyValue>`).map((s) => s.why)).toEqual(['RSAKeyValue D', 'RSAKeyValue P', 'RSAKeyValue Q'])
  })

  it('key blocks: BEGIN lines written one after another on one line are scanned in step with their number', () => {
    // Each block looked for the end of its first line from its BEGIN marker on: with no line
    // break, the rest of the text once per marker (80,000 characters of them took 0.9 s, 160,000
    // some 4 s). Now about 60 ms, twice that under coverage: the bound is for what costs seconds.
    const run = randomBytes(30).toString('base64')
    for (const unit of [
      '-----BEGIN PRIVATE KEY----- ',
      '-----BEGIN PGP PRIVATE KEY BLOCK----- ',
      '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ---- ',
      '-----BEGIN OpenVPN Static key V1----- ',
      `-----BEGIN PRIVATE KEY----- ${run} `,
    ]) {
      const line = unit.repeat(Math.ceil(160_000 / unit.length))
      expect(bestOf3(() => keySpans(line)), unit).toBeLessThan(1_000)
      // a line break every few markers was always fast: the result is the same as with none
      expect(keyBlocks(line).length).toBe(Math.ceil(160_000 / unit.length))
    }
  })

  it.each(Object.keys(COST_SHAPES))('%s is screened in step with its length', (shape) => {
    const [text, opts, bound] = COST_SHAPES[shape]
    expect(bestOf3(() => screenKeys(text, opts), bound * 4), shape).toBeLessThan(bound)
  })
})

describe('the linear replacements of three regexes and a prose test give what those gave', () => {
  // The regexes as they were, each cubic or quadratic in a run of plus signs or letters: the oracle.
  const PARTIAL_OLD = /^…?([^\r\n]*?)([A-Za-z0-9+/=]*)((?:\\+(?:[nr]|u000[aAdD]|x0[aAdD])|%0[aAdD]|&#(?:x0?[aAdD]|1[03]);|<br\s*\/?>|`[nr]|[ \t"'`,;+.&_$)\]}|])*\\?(?:\r\n|\r|\n)?)$/
  const SHORT_OLD = /([A-Za-z0-9+/]{1,7}={0,2})[\s"'`,;+&_)\]}|\\$]*$/
  const LINE_END_OLD = /[A-Za-z0-9+/=]+[\s"'`,;+&_)\]}|\\]*$/
  const PROSE_OLD = /[A-Za-z]{2,}[ \t]+[A-Za-z]{2,}/

  // A seeded generator: the same strings on every run.
  let seed = 20261031
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
  /** Every string of up to maxLen of the alphabet's symbols. */
  function everyString(alphabet: readonly string[], maxLen: number, fn: (s: string) => void): number {
    let n = 0
    const go = (s: string, left: number): void => {
      n++
      fn(s)
      if (left > 0) for (const c of alphabet) go(s + c, left - 1)
    }
    go('', maxLen)
    return n
  }
  const BS = '\\'
  /** The written-out breaks, joiners and base64 these read, joined at random. */
  const TOKENS = ['a', 'Q9', '/', '=', '==', '+', '++', ' ', '\t', '"', "'", '`', ',', ';', '.', '&', '_', '$', ')', ']', '}', '|', BS, BS + BS, BS + 'n', BS + 'r', BS + 'u000a', BS + 'u000D', BS + 'x0a', '%0A', '%0d', '&#xA;', '&#x0d;', '&#x0A;', '&#10;', '&#13;', '<br>', '<br/>', '<br />', '`n', '`r', '\n', '\r\n', '\r', '…', 'n', 'x', '0']
  const tokens = (): string => Array.from({ length: Math.floor(rnd() * 15) }, () => pick(TOKENS)).join('')
  /** The inputs on which `got` and `want` differ, the first few of them. */
  function differ(inputs: (visit: (s: string) => void) => void, got: (s: string) => unknown, want: (s: string) => unknown): string[] {
    const bad: string[] = []
    inputs((s) => {
      if (bad.length < 5 && JSON.stringify(got(s)) !== JSON.stringify(want(s))) bad.push(`${JSON.stringify(s)}: ${JSON.stringify(got(s))} but ${JSON.stringify(want(s))}`)
    })
    return bad
  }
  const randomInputs = (visit: (s: string) => void): void => {
    for (let i = 0; i < 40_000; i++) visit((rnd() < 0.2 ? '…' : '') + tokens())
  }

  const partialOld = (s: string): { frame: string; run: boolean } | null => {
    const m = PARTIAL_OLD.exec(s)
    return m ? { frame: m[1], run: m[2] !== '' } : null
  }
  const shortOld = (s: string): { index: number; length: number } | null => {
    const m = SHORT_OLD.exec(s)
    return m ? { index: m.index, length: m[1].length } : null
  }
  const lineEnd = (re: RegExp) => (s: string): [number, string] | null => {
    const m = re.exec(s)
    return m ? [m.index, m[0]] : null
  }

  it('partialLine finds the frame and the base64 that /^…?(frame)(base64)(trailer)$/ found', () => {
    let n = 0
    expect(differ((visit) => (n = everyString(['a', '=', '+', ' ', '\n', BS, 'n', '"'], 6, visit)), partialLine, partialOld)).toEqual([])
    expect(n).toBeGreaterThan(299_000)
    expect(differ(randomInputs, partialLine, partialOld)).toEqual([])
  })

  it('shortAbove finds the 1-7 characters that /([A-Za-z0-9+/]{1,7}={0,2})(joiners)$/ found', () => {
    expect(differ((visit) => everyString(['a', 'Q', '=', '+', ' ', '"', BS, '$', '!'], 6, visit), shortAbove, shortOld)).toEqual([])
    expect(differ(randomInputs, shortAbove, shortOld)).toEqual([])
  })

  it('LINE_END_RUN matches where /[A-Za-z0-9+/=]+(joiners)$/ matched, as much as it matched', () => {
    const got = lineEnd(LINE_END_RUN)
    const want = lineEnd(LINE_END_OLD)
    expect(differ((visit) => everyString(['a', '=', '+', ' ', '"', BS, '!', '/'], 6, visit), got, want)).toEqual([])
    expect(differ(randomInputs, got, want)).toEqual([])
  })

  it('proseEnds says a stretch holds two words exactly when /[A-Za-z]{2,}[ \\t]+[A-Za-z]{2,}/ matches it', () => {
    const bad: string[] = []
    const check = (text: string, start: number): void => {
      const ends = proseEnds(text, start)
      for (let from = start; from <= text.length; from++) {
        for (let to = from; to <= text.length; to++) {
          if (bad.length < 5 && (ends(from) <= to) !== PROSE_OLD.test(text.slice(from, to))) bad.push(JSON.stringify([text, start, from, to]))
        }
      }
    }
    everyString(['a', 'b', ' ', '\t', '\n', '1'], 6, (s) => check(s, 0))
    for (let i = 0; i < 3_000; i++) {
      const text = Array.from({ length: 4 + Math.floor(rnd() * 14) }, () => pick(['ab', 'Q', 'x', ' ', '  ', '\t', '\n', '1', '-', 'word'])).join('')
      check(text, Math.floor(rnd() * 4))
    }
    expect(bad).toEqual([])
    // a run of words many times the length of any one: found in one pass
    const long = 'ab '.repeat(30_000)
    expect(proseEnds(long, 0)(0)).toBe(5)
    expect(proseEnds(long, 0)(long.length - 2)).toBe(Infinity)
  })
})

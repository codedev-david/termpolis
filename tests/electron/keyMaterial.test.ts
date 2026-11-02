// The key detectors (src/main/keyMaterial.ts) on their own, before screenText uses them: a private
// key in every format is removed whole however an answer writes its lines (T1), everything that
// only looks like a key is left byte for byte (T2), and the recall bugs the prototype's probes found
// stay fixed (T5). Every key is made fresh in memory (fixtures/freshKeys.ts) and never printed; a
// synthetic body ('Ab'.repeat, 'Q'.repeat) only ever shows what is NOT removed.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import * as crypto from 'crypto'
import { createHash, generateKeyPairSync, randomBytes } from 'crypto'
import {
  decodeHead,
  DEK_REMNANT,
  detectorStart,
  encodedKeys,
  ESC_ALL_RE,
  hasWords,
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
  TRAILING_BLANKS,
  TRAILING_HEAD_JOINERS,
  TRAILING_LINE_BREAKS,
  TRAILING_NL_JOINERS,
  type KeySpan,
} from '../../src/main/keyMaterial'
import { COST_SHAPES, within } from './fixtures/costShapes'
import { JOIN, T1_JOININGS, armor, der, leakedWindows, makeKeys, pgpPhotoExport, pgpRsaBody, secretLinesOf, shownWhole, ssh2Key, wrap, type Format, type KeySet } from './fixtures/freshKeys'

// Several tests here screen a key in every joining at every cut offset, or 200 trials of 22 kinds of text: 10 to 15 s each on a quiet
// laptop, 3 to 5 times that under coverage, and 30 to 60 s beside the rest of the suite (two of them failed on the default 30 s). A
// test's own timeout is only a guard against a hang, and a synchronous loop cannot be interrupted by it anyway: the bounds are the
// assertions.
vi.setConfig({ testTimeout: 600_000 })

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
/** A key file's lines with no END line and its last base64 line cut to `cut` characters (the short last line
 *  an OpenSSH or PGP file ends in), its PGP checksum line after it; and that short line. */
function shortLast(file: string[], cut: number): { lines: string[]; last: string } {
  const body = file.slice(0, -1)
  const at = body.reduce((n, l, i) => (/^[A-Za-z0-9+/]+=*$/.test(l) && !l.startsWith('=') ? i : n), -1)
  const last = body[at].slice(0, cut)
  return { lines: [...body.slice(0, at), last, ...body.slice(at + 1)], last }
}

let K: KeySet
beforeAll(() => {
  K = makeKeys()
})

describe('T1 K1-K3: a key block, recognised by what its bytes decode to', () => {
  for (const format of FORMATS) {
    it(`${format}: removed whole in the 22 joinings, with its END line and without`, () => {
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

  it('takes the first body line of an EC or EdDSA key, which already holds its private value (head -2 key.pem); not an RSA, DSA or encrypted key\'s, which holds a modulus or parameters', () => {
    const pem = (key: crypto.KeyObject, type: 'sec1' | 'pkcs8'): string[] => (key.export({ type, format: 'pem' }) as string).trim().split('\n')
    const heads: Array<[string, string[]]> = []
    for (const curve of ['secp256k1', 'P-256', 'P-384', 'P-521']) {
      const key = generateKeyPairSync('ec', { namedCurve: curve }).privateKey
      heads.push([`SEC1 ${curve}`, pem(key, 'sec1')], [`PKCS#8 EC ${curve}`, pem(key, 'pkcs8')])
    }
    heads.push(['PKCS#8 ed448', pem(generateKeyPairSync('ed448').privateKey, 'pkcs8')], ['PKCS#8 x448', pem(generateKeyPairSync('x448').privateKey, 'pkcs8')], ['PKCS#8 x25519', pem(generateKeyPairSync('x25519').privateKey, 'pkcs8')])
    for (const [name, ls] of heads) {
      for (const withEnd of [false, true]) {
        const label = `${name}, ${withEnd ? "with" : "no"} END`
        const text = ['Here is the head of the file:', ls[0], ls[1], ...(withEnd ? [ls[ls.length - 1]] : []), 'and that is all.'].join('\n')
        const r = screenKeys(text)
        expect(r.removed, label).toEqual({ private_key: 1 })
        expect(leakedWindows(r.text, [ls[1]]), label).toBe(0)
        expect(r.text.startsWith('Here is the head of the file:\n') && r.text.endsWith('\nand that is all.'), label).toBe(true)
      }
    }
    // an RSA, DSA or encrypted key's first line is its modulus, its parameters or its salt: a documentation example
    for (const [name, ls] of [
      ['PKCS#8 RSA', K.F.pkcs8_rsa],
      ['PKCS#1 RSA', K.F.pkcs1_rsa],
      ['DSA', K.F.dsa],
      ['encrypted PKCS#8', K.F.enc_pkcs8],
    ] as Array<[string, string[]]>) {
      for (const withEnd of [false, true]) {
        const text = ['Here is the head of the file:', ls[0], ls[1], ...(withEnd ? [ls[ls.length - 1]] : []), 'and that is all.'].join('\n')
        const r = screenKeys(text)
        expect(r.text, name).toBe(text)
        expect(r.removed, name).toEqual({})
      }
    }
    // a SEC1 or PKCS#8 EC header over a made-up value is no key's
    const scalar = Buffer.alloc(32, 0x41)
    const sec1 = der(0x30, Buffer.concat([der(0x02, Buffer.from([1])), der(0x04, scalar), der(0xa0, der(0x06, Buffer.from('2a8648ce3d030107', 'hex'))), der(0xa1, der(0x03, Buffer.concat([Buffer.from([0, 4]), randomBytes(64)])))]))
    const madeUp = ['-----BEGIN EC PRIVATE KEY-----', wrap(sec1.toString('base64'))[0], '-----END EC PRIVATE KEY-----'].join('\n')
    expect(structureOf(sec1)).toMatchObject({ type: 'sec1' })
    expect(screenKeys(madeUp).text).toBe(madeUp)
    expect(screenKeys(madeUp).removed).toEqual({})
  })

  it('takes a key written one NAME=<line> per line, whatever the name: padding is the only = inside a key line', () => {
    // A properties file, journalctl -o export (MESSAGE=), a log field: the name and its = were part of the
    // base64 run, which then decoded to nothing (names of 4 characters or more; 3 worked by luck).
    for (const format of FORMATS) {
      const [rule] = EXPECT[format]
      for (const name of ['line', 'data', 'value', 'message', 'MESSAGE', 'payload', 'stdout', 'msg', 'k']) {
        for (const withEnd of [true, false]) {
          const label = `${format}/${name}=/${withEnd ? "END" : "no END"}`
          const ls = withEnd ? K.F[format] : K.F[format].slice(0, -1)
          const r = screenKeys('Answer follows.\n' + ls.map((l) => `${name}=${l}`).join('\n') + '\nThat was the file.')
          expect(leakedWindows(r.text, secretLinesOf(K.F[format])), label).toBe(0)
          expect(r.removed, label).toEqual({ [rule]: 1 })
        }
      }
    }
    // with no END line, the key's short last line and its checksum line (PGP) carry the name too
    for (const format of ['pgp_rsa_hdr', 'pgp_ed_nohdr', 'pkcs8_rsa', 'openssh'] as Format[]) {
      for (const cut of [4, 8, 12]) {
        const { lines, last } = shortLast(K.F[format], cut)
        const r = screenKeys('Answer follows.\n' + lines.map((l) => `line=${l}`).join('\n') + '\nThat was the file.')
        expect(r.removed, `${format}/${cut}`).toEqual({ [EXPECT[format][0]]: 1 })
        expect(shownWhole(r.text, last), `${format}/${cut}`).toBe(false)
        expect(r.text.includes(`line=${lines[lines.length - 1]}`), `${format}/${cut}`).toBe(false)
      }
    }
  })

  it('takes the = before 4 characters, far from the run start, for the checksum that ends an OpenPGP key written with no line breaks, not for a name', () => {
    // `gpg --armor --export-secret-keys | tr -d '\n'`: the body, its padding and `=XXXX` are one run, and the = that is nearest its
    // end was taken for a NAME= with the checksum for its value, which dropped the whole body and kept 4 characters. A name is
    // shorter than a key line (64); a body that long is read whole. (A line of 63 characters and a checksum is a name's.)
    const b64 = (n: number): string => randomBytes(Math.ceil(n * 0.75)).toString('base64').replace(/[+/=]/g, 'a').slice(0, n)
    // (header-only: no payload run was found under the BEGIN line)
    const why = (n: number): string => keyBlocks(`-----BEGIN PRIVATE KEY-----\n${b64(n)}=ab12\n-----END PRIVATE KEY-----\n`)[0].why
    expect(why(63), 'a name of 63').toBe('header-only')
    expect(why(64), 'a body of 64').not.toBe('header-only')
    expect(why(2500), 'a body of 2,500').not.toBe('header-only')
  })

  it('takes a key written as a JSON array of its lines, the writer escaping base64 characters: PHP json_encode(file($pem)), .NET string[]', () => {
    // Each element is its own JSON string, so the string does not end at the first closing quote.
    const php = (json: string): string => json.replace(/\//g, '\\/')
    const net = (json: string): string => json.replace(/\+/g, '\\' + 'u002B')
    const shapes: Record<string, (ls: string[]) => string> = {
      'PHP, inline': (ls) => php(JSON.stringify(ls)),
      'PHP, each line ending in \\n': (ls) => php(JSON.stringify(ls.map((l) => l + '\n'))),
      'PHP, JSON_PRETTY_PRINT': (ls) => php(JSON.stringify(ls.map((l) => l + '\n'), null, 4)),
      '.NET string[]': (ls) => net(JSON.stringify(ls)),
      '.NET, both escapes': (ls) => net(php(JSON.stringify(ls.map((l) => l + '\n'), null, 2))),
    }
    for (const format of FORMATS) {
      const [rule] = EXPECT[format]
      for (const [shape, write] of Object.entries(shapes)) {
        for (const withEnd of [true, false]) {
          const label = `${format}/${shape}/${withEnd ? "END" : "no END"}`
          const ls = withEnd ? K.F[format] : K.F[format].slice(0, -1)
          const r = screenKeys('Answer follows.\n' + write(ls) + '\nThat was the file.')
          expect(leakedWindows(r.text, secretLinesOf(K.F[format])), label).toBe(0)
          expect(r.removed, label).toEqual({ [rule]: 1 })
        }
      }
    }
    // elements that are not a key's lines stay: an array of words after the key's END line
    const ls = K.F.pkcs8_rsa
    const after = '["' + ls.join('\\n') + '\\n","next","and then \\/ this"]'
    const r = screenKeys(php('{"files":["a.txt"],"key":' + JSON.stringify(ls.join('\n') + '\n') + '}') + '\n' + after)
    expect(r.text).toContain('"next","and then \\/ this"]')
  })

  it('takes a key written as PHP string literals joined with ". PHP_EOL .", its last short line and its checksum line too, with no END line', () => {
    // (the dot also follows the last line when every line ends in the newline constant, as a Perl or Lua concatenation
    // does: the checksum line is then `"=AbCd" . PHP_EOL;`, and a dot after the base64 joins as well as a plus does)
    const forms: Record<string, [(ls: string[]) => string, string]> = {
      'PHP_EOL between the lines': [(ls) => '$key = ' + ls.map((l) => `"${l}"`).join(' . PHP_EOL .\n    ') + ';\nDone.', ';\nDone.'],
      'PHP_EOL after every line': [(ls) => '$key = ' + ls.map((l) => `"${l}" . PHP_EOL`).join(' .\n    ') + ';\nDone.', ';\nDone.'],
      'a "\\n" string after every line': [(ls) => '$key = ' + ls.map((l) => `"${l}" . "\\n"`).join(' .\n    ') + ';\nDone.', ';\nDone.'],
      'Lua': [(ls) => 'key = ' + ls.map((l) => `"${l}" .. "\\n"`).join(' ..\n    ') + '\nDone.', '\nDone.'],
    }
    for (const [name, [write, tail]] of Object.entries(forms)) {
      for (const format of ['pgp_rsa_hdr', 'pgp_ed_hdr', 'pgp_rsa_nohdr', 'pkcs8_rsa', 'pkcs1_rsa'] as Format[]) {
        for (const cut of [4, 8, 12]) {
          const { lines, last } = shortLast(K.F[format], cut)
          const label = `${name}/${format}/${cut}`
          const r = screenKeys(write(lines))
          expect(r.removed, label).toEqual({ [EXPECT[format][0]]: 1 })
          expect(shownWhole(r.text, last), label).toBe(false)
          // (a PGP file's checksum line: `=` and four characters)
          const crc = lines[lines.length - 1]
          if (crc.startsWith('=')) expect(r.text.includes(crc), label).toBe(false)
          expect(r.text.endsWith(tail), label).toBe(true)
        }
      }
    }
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

  it('a legacy encrypted key written with a cipher of an 8-byte block (DES, BF, CAST5, RC2, IDEA) is removed: its IV is 16 hex digits', () => {
    const body = wrap(randomBytes(1200).toString('base64'))
    for (const cipher of ['DES-CBC', 'DES-EDE-CBC', 'DES-EDE3-CBC', 'BF-CBC', 'CAST5-CBC', 'RC2-CBC', 'RC2-40-CBC', 'RC2-64-CBC', 'IDEA-CBC']) {
      for (const withEnd of [true, false]) {
        const lines = ['-----BEGIN RSA PRIVATE KEY-----', 'Proc-Type: 4,ENCRYPTED', `DEK-Info: ${cipher},${randomBytes(8).toString('hex').toUpperCase()}`, '', ...body]
        const text = `Answer follows.\n${(withEnd ? [...lines, '-----END RSA PRIVATE KEY-----'] : lines).join('\n')}\nThat was the file.`
        const r = screenKeys(text)
        expect(r.removed, `${cipher}/${withEnd}`).toEqual({ private_key: 1 })
        expect(leakedWindows(r.text, body), `${cipher}/${withEnd}`).toBe(0)
      }
    }
    // an IV of the wrong size for its cipher is no proof: AES takes 32 digits (any cipher is taken with that many), only the 64-bit
    // ciphers 16, a cipher no one writes with 16 is no 64-bit one, and a 12-digit IV is none
    for (const dek of [`AES-128-CBC,${randomBytes(8).toString('hex')}`, `FOO-CBC,${randomBytes(8).toString('hex')}`, `BF-CBC,${randomBytes(6).toString('hex')}`]) {
      const text = ['-----BEGIN RSA PRIVATE KEY-----', 'Proc-Type: 4,ENCRYPTED', `DEK-Info: ${dek}`, '', ...body, '-----END RSA PRIVATE KEY-----'].join('\n')
      expect(screenKeys(text).text, dek).toBe(text)
    }
  })

  it('a key with no END line of its own ends where its lines do: the END line of a certificate, a CSR or a public key after it stays', () => {
    // The scan closed a block at ANY `-----END ` marker and the removal ran to that marker's end: a truncated key (its END line
    // lost to a cut, `rg -A`, `head`) took the public marker line that came next with it.
    for (const format of ['pkcs8_rsa', 'openssh', 'pgp_rsa_hdr', 'rsa_legacy_enc'] as Format[]) {
      const [rule] = EXPECT[format]
      for (const marker of ['-----END CERTIFICATE-----', '-----END CERTIFICATE REQUEST-----', '-----END PUBLIC KEY-----', '-----END X509 CRL-----']) {
        const lines = K.F[format].slice(0, -1)
        const text = `Answer follows.\n${lines.join('\n')}\n${marker}\nThat was the file.`
        const r = screenKeys(text)
        expect(r.removed, `${format}/${marker}`).toEqual({ [rule]: 1 })
        expect(r.text, `${format}/${marker}`).toBe(`Answer follows.\n[REDACTED:${rule}]\n${marker}\nThat was the file.`)
      }
    }
    // a private key's END of another kind, an SSH2 key's (four dashes), an OpenVPN key's and an END line cut before its closing dashes
    // close it, and go with it
    const p8 = K.F.pkcs8_rsa
    const text = `${p8.slice(0, -1).join('\n')}\n-----END RSA PRIVATE KEY-----\nThat was the file.`
    expect(screenKeys(text).text).toBe('[REDACTED:private_key]\nThat was the file.')
    expect(screenKeys(`${K.F.ssh2.join('\n')}\nThat was the file.`).text).toBe('[REDACTED:ssh2_private_key]\nThat was the file.')
    expect(screenKeys(`${K.F.openvpn.slice(3).join('\n')}\nThat was the file.`).text).toBe('[REDACTED:openvpn_static_key]\nThat was the file.')
    expect(screenKeys(`${p8.slice(0, -1).join('\n')}\n-----END PRIVATE KEY\nThat was the file.`).text).toBe('[REDACTED:private_key]\nThat was the file.')
  })
})

describe('T2 K3: an OpenVPN static key is lines of exactly 32 hex digits, and nothing else is', () => {
  // The header named in a README, a table or a listing, over a list of digests (sha256sums: 64 hex digits, md5sums:
  // 32 and a file name): 256 random-looking hex digits in 2 KB were enough, and the sentence's tail and the first
  // lines of the list went with the header.
  const sha = (name: string): string => `${createHash("sha256").update(name + randomBytes(8).toString("hex")).digest("hex")}`
  const md5 = (name: string): string => `${createHash("md5").update(name + randomBytes(8).toString("hex")).digest("hex")}`
  const FILES = ['openvpn-2.6.12-I001-x86.msi', 'openvpn-2.6.12-I001-amd64.msi', 'openvpn-2.6.12-I001-arm64.msi', 'openvpn-2.6.12.tar.gz', 'openvpn-2.6.12.tar.xz', 'openvpn-2.6.12.zip', 'openvpn-gui.exe', 'tap-windows.exe', 'easy-rsa-3.1.7.tgz']
  const HEADER = '-----BEGIN OpenVPN Static key V1-----'
  const documents: Record<string, string> = {
    'a README sentence, then sha256sums': `The ta.key file starts with the line ${HEADER} and has 16 lines.\n\n${FILES.map((f) => `${sha(f)}  ${f}`).join("\n")}\n`,
    'a markdown table of digests': `Static keys begin with ${HEADER}.\n\n| file | sha256 |\n|---|---|\n${FILES.map((f) => `| ${f} | ${sha(f)} |`).join("\n")}\n`,
    'an rg listing of digests': `${HEADER}\n${FILES.map((f, i) => `docs/checksums.txt:${i + 1}:${sha(f)}  ${f}`).join("\n")}\n`,
    'md5sums': `The header is ${HEADER}\n${FILES.map((f) => `${md5(f)}  ${f}`).join("\n")}\n`,
    'digests in a table of 32': `${HEADER}\n\n${FILES.map((f) => `${md5(f)} | ${f}`).join("\n")}\n`,
    // (nothing after the digits to tell them from a key's lines but their number: 64 and 40, not 32)
    'bare sha256 digests, one per line': `${HEADER}\n${FILES.map((f) => sha(f)).join("\n")}\n`,
    'git object ids, one per line': `Static keys begin with ${HEADER}.\n${FILES.map(() => randomBytes(20).toString("hex")).join("\n")}\n`,
  }
  it('are left byte for byte, and reported', () => {
    for (const [name, text] of Object.entries(documents)) {
      const r = screenKeys(text)
      expect(r.text, name).toBe(text)
      expect(r.removed, name).toEqual({})
      expect(r.flagged, name).toEqual({ openvpn_static_key: 1 })
    }
  })
  it('a key written on one line is still one with words after it, however many', () => {
    const key = K.F.openvpn
    const values = key.filter((l) => /^[0-9a-f]{32}$/.test(l))
    expect(values).toHaveLength(16)
    for (const tail of [' and that is all', ' ' + 'and then some more words of text '.repeat(60), '']) {
      for (const end of [true, false]) {
        const text = `ta.key: ${key[3]} ${values.join(" ")}${end ? ` ${key[key.length - 1]}` : ""}${tail}\nNext line.\n`
        const r = screenKeys(text)
        expect(r.removed, JSON.stringify([tail.length, end])).toEqual({ openvpn_static_key: 1 })
        expect(leakedWindows(r.text, values), JSON.stringify([tail.length, end])).toBe(0)
        expect(r.text.startsWith('ta.key: [REDACTED:openvpn_static_key]'), JSON.stringify([tail.length, end])).toBe(true)
      }
    }
  })
  it('and a key is removed from the same header whatever lines come after it', () => {
    const key = K.F.openvpn
    const text = `${documents["md5sums"]}\n${key.join("\n")}\n`
    const r = screenKeys(text)
    expect(r.removed).toEqual({ openvpn_static_key: 1 })
    expect(leakedWindows(r.text, key.filter((l) => /^[0-9a-f]{32}$/.test(l)))).toBe(0)
    // ...and the documents above it stay
    expect(r.text.startsWith(documents['md5sums'])).toBe(true)
  })
  it('a key with a run of six to eight equal digits is still one: random digits hold one about once in 2,000 keys', () => {
    const key = K.F.openvpn
    for (const n of [6, 7, 8]) {
      // (neighbours that are not 7, so the run is exactly n long)
      const lines = key.map((l, i) => (/^[0-9a-f]{32}$/.test(l) && i % 5 === 2 ? `${l.slice(0, 5)}a${'7'.repeat(n)}b${l.slice(7 + n)}` : l))
      expect(lines.some((l) => l.includes('7'.repeat(n))), String(n)).toBe(true)
      const r = screenKeys(`The key file:\n${lines.join('\n')}\nThat was the file.\n`)
      expect(r.removed, String(n)).toEqual({ openvpn_static_key: 1 })
      expect(leakedWindows(r.text, lines.filter((l) => /^[0-9a-f]{32}$/.test(l))), String(n)).toBe(0)
    }
  })
  it('and one with nine in a row, or a few digits repeated, is a placeholder: reported, left as it is', () => {
    const key = K.F.openvpn
    const fakes: Record<string, string[]> = {
      'a run of nine': key.map((l, i) => (/^[0-9a-f]{32}$/.test(l) && i % 5 === 2 ? `${l.slice(0, 5)}a${'7'.repeat(9)}b${l.slice(16)}` : l)),
      'one digit': key.map((l) => (/^[0-9a-f]{32}$/.test(l) ? '0'.repeat(32) : l)),
      'two digits': key.map((l) => (/^[0-9a-f]{32}$/.test(l) ? 'ab'.repeat(16) : l)),
    }
    for (const [name, lines] of Object.entries(fakes)) {
      const text = `The key file:\n${lines.join('\n')}\nThat was the file.\n`
      const r = screenKeys(text)
      expect(r.text, name).toBe(text)
      expect(r.removed, name).toEqual({})
      expect(r.flagged, name).toEqual({ openvpn_static_key: 1 })
    }
  })
  // The ways a script, a page or a table writes the file out line by line: the same text after every line's digits, and the
  // header line has it too (an echo starts the file with `>` and adds to it with `>>`).
  const BS = '\\'
  const SHAPES: Record<string, (ls: string[]) => string> = {
    'echo into a file, the first with >': (ls) => ls.map((l, i) => `echo '${l}' ${i ? '>>' : '>'} ta.key`).join('\n'),
    'echo in a Dockerfile': (ls) => ls.map((l) => `RUN echo "${l}" >> /etc/openvpn/ta.key ${BS}`).join('\n'),
    'a batch file': (ls) => ls.map((l) => `echo ${l}>>ta.key`).join('\n'),
    printf: (ls) => ls.map((l) => `printf '%s${BS}n' "${l}" >> ta.key`).join('\n'),
    'sed inserting each line': (ls) => ls.map((l, i) => `sed -i '${i + 1}i ${l}' ta.key`).join('\n'),
    'a paragraph each': (ls) => ls.map((l) => `<p>${l}</p>`).join('\n'),
    'a CSV row each': (ls) => ls.map((l, i) => `${i + 1},${l},ok`).join('\n'),
    'a markdown table row each': (ls) => ls.map((l, i) => `| ${i + 1} | ${l} | ok |`).join('\n'),
    'a YAML list with comments': (ls) => ls.map((l) => `- ${l}  # line`).join('\n'),
    'a numbered comment each': (ls) => ls.map((l, i) => `${l}  # line ${i + 1}`).join('\n'),
    'a coloured diff of the echo script': (ls) => ls.map((l, i) => `\x1b[32m+\x1b[m\x1b[32mecho '${l}' ${i ? '>>' : '>'} ta.key\x1b[m`).join('\n'),
    'the 512 digits in one run (line breaks taken out)': (ls) => [ls[0], ls.filter((l) => /^[0-9a-f]{32}$/.test(l)).join(''), ...ls.slice(1).filter((l) => !/^[0-9a-f]{32}$/.test(l))].join('\n'),
  }
  it.each(Object.keys(SHAPES))('a key written out as %s is removed', (name) => {
    const key = K.F.openvpn.slice(3) // BEGIN, 16 lines of digits, END (the comment lines above are not the key)
    const values = key.filter((l) => /^[0-9a-f]{32}$/.test(l))
    for (const lines of [key, key.slice(0, -1)]) {
      const label = `${name}/${lines.length === key.length ? 'END' : 'no END'}`
      const text = `Answer follows.\n${SHAPES[name](lines)}\nThat was the file.`
      const r = screenKeys(text)
      expect(r.removed, label).toEqual({ openvpn_static_key: 1 })
      expect(leakedWindows(r.text, values), label).toBe(0)
      expect(r.text.startsWith('Answer follows.') && r.text.endsWith('That was the file.'), label).toBe(true)
    }
  })
  it('a coloured listing of the key (bat, a coloured diff) is one although its BEGIN line has a comment after it: the colour code is not part of what follows the digits', () => {
    const key = K.F.openvpn.slice(3)
    const values = key.filter((l) => /^[0-9a-f]{32}$/.test(l))
    const text = `Answer follows.\n${key.map((l, i) => (i === 0 ? `${l} # the file ta.key` : `\x1b[32m${l}\x1b[0m`)).join('\n')}\nThat was the file.`
    const r = screenKeys(text)
    expect(r.removed).toEqual({ openvpn_static_key: 1 })
    expect(leakedWindows(r.text, values)).toBe(0)
  })
  it('a run of 512 digits behind a long word is a hex number in a sentence, not the key with its line breaks taken out: reported, left as it is', () => {
    const hex = randomBytes(256).toString('hex')
    for (const prefix of ['', 'xx', 'ghijklmnopqrstu', 'ghijklmnopqrstuv', 'ghijklmnopqrstuvw', 'ghijklmnopqrstuvwxyzGHIJKLMNOPQRSTUVWXYZ']) {
      const text = `${HEADER}\n${prefix}${hex}\n`
      const r = screenKeys(text)
      // (a frame of up to 16 characters is a key's own: a quote, a name that is not hex)
      expect(r.removed, JSON.stringify(prefix)).toEqual(prefix.length > 16 ? {} : { openvpn_static_key: 1 })
      if (prefix.length > 16) expect(r.text, JSON.stringify(prefix)).toBe(text)
    }
  })
  it('but the same cell after a list of digests, under a header that does not have it, is no key', () => {
    // (a table of md5 sums with the same status on every row, under a header row of its own; the header in a sentence, in a list
    // item, in an echo that only writes it; sha256 sums and git ids with a constant cell)
    const sums = (n: number): string[] => Array.from({ length: n }, () => randomBytes(16).toString('hex'))
    const docs: Record<string, string> = {
      'a status column under the header row': `| file | status |\n|---|---|\n| ${HEADER} |\n${sums(20).map((h) => `| ${h} | ok |`).join('\n')}\n`,
      'the same cell after each, the header in a sentence': `The header ${HEADER} marks a static key.\n${sums(20).map((h) => `${h} OK`).join('\n')}\n`,
      'a list of digests under a header in a list item': `- ${HEADER}\n${sums(20).map((h) => `- ${h} verified`).join('\n')}\n`,
      'an echo that writes only the header': `echo '${HEADER}' >> key.pem   # (this writes the header)\n\nmd5s:\n${sums(20).map((h) => `${h} ok`).join('\n')}\n`,
      'sha256 digests with a constant cell': `${HEADER}\n${Array.from({ length: 20 }, () => `${randomBytes(32).toString('hex')} OK`).join('\n')}\n`,
      'git ids with a constant cell': `${HEADER}\n${Array.from({ length: 20 }, () => `${randomBytes(20).toString('hex')} OK`).join('\n')}\n`,
    }
    for (const [name, text] of Object.entries(docs)) {
      const r = screenKeys(text)
      expect(r.text, name).toBe(text)
      expect(r.removed, name).toEqual({})
    }
  })

  it('and a run of exactly 512 hex digits is the key with its line breaks taken out only right under its header, not further down in prose, a table or a listing', () => {
    // The header named in a sentence or a table, and 512 hex digits later in the same 2 KB that are not a key: an RSA-2048 modulus
    // (`openssl x509 -noout -modulus`), a signature, four SHA-512 digests glued, an `xxd -p -c 256` dump, a fingerprint.
    const hex = (n: number): string => randomBytes(n).toString('hex')
    const modulus = (generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }) as { n: string }).n
    const modHex = Buffer.from(modulus, 'base64url').toString('hex').toUpperCase()
    expect(modHex.length).toBe(512)
    const docs: Record<string, string> = {
      'a modulus after a sentence naming the header': `ta.key starts with ${HEADER}\n\n$ openssl x509 -in server.crt -noout -modulus\nModulus=${modHex}\n`,
      'the header in a table, then a modulus': `| file | first line |\n|---|---|\n| ta.key | ${HEADER} |\n\n$ openssl x509 -in server.crt -noout -modulus\nModulus=${modHex}\n`,
      'a signature': `The static key (${HEADER}) is not signed.\nsignature: ${hex(256)}\n`,
      'four SHA-512 digests glued': `${HEADER} is the ta.key header.\ncombined: ${hex(64) + hex(64) + hex(64) + hex(64)}\n`,
      'an xxd -p -c 256 dump': `# head -1 ta.key\n${HEADER}\n$ xxd -p -c 256 blob.bin\n${hex(256)}\n`,
      'a fingerprint in a YAML': `openvpn:\n  tls_auth_header: "${HEADER}"\n  fingerprint: ${hex(256)}\n`,
      'a hash after a short frame under the header': `${HEADER}\n  hash = ${hex(256)}\n`,
      'a run after the header and a word': `${HEADER} then ${hex(256)}\n`,
    }
    for (const [name, text] of Object.entries(docs)) {
      const r = screenKeys(text)
      expect(r.text, name).toBe(text)
      expect(r.removed, name).toEqual({})
    }
    // right under the header, with nothing but a frame and written-out line breaks between: the key with its line breaks taken out
    const digits = K.F.openvpn.filter((l) => /^[0-9a-f]{32}$/.test(l)).join('')
    expect(digits).toHaveLength(512)
    const END = '-----END OpenVPN Static key V1-----'
    const keys: Record<string, string> = {
      'a line': `${HEADER}\n${digits}\n${END}`,
      'no END': `${HEADER}\n${digits}`,
      'a space': `${HEADER} ${digits} ${END}`,
      'written-out line breaks': `"${HEADER}\\n${digits}\\n${END}\\n"`,
      'a quoted line': `${HEADER}\n"${digits}"\n${END}`,
      'upper case': `${HEADER}\n${digits.toUpperCase()}\n${END}`,
      'a diff': `${HEADER}\n+${digits}\n${END}`,
    }
    for (const [name, key] of Object.entries(keys)) {
      const r = screenKeys(`Answer follows.\n${key}\nThat was the file.`)
      expect(r.removed, name).toEqual({ openvpn_static_key: 1 })
      expect(leakedWindows(r.text, [digits.slice(0, 64), digits.slice(200, 264), digits.slice(448)]), name).toBe(0)
    }
    // the length is the key's: 2,048 bits, no more or fewer
    for (const n of [511, 513]) {
      const text = `${HEADER}\n${(digits + hex(2)).slice(0, n)}\n${END}\n`
      expect(screenKeys(text).text, String(n)).toBe(text)
      expect(screenKeys(text).removed, String(n)).toEqual({})
    }
    // a newline constant between the header and the run is a line break, not a word
    for (const nl of ['System.lineSeparator()', 'Environment.NewLine', 'os.linesep', 'PHP_EOL', 'vbCrLf']) {
      const r = screenKeys(`String key = "${HEADER}" + ${nl} + "${digits}" + ${nl} + "${END}";`)
      expect(r.removed, nl).toEqual({ openvpn_static_key: 1 })
      expect(leakedWindows(r.text, [digits.slice(0, 64), digits.slice(448)]), nl).toBe(0)
    }
  })

  it('and a line of 32 digits is a key line when what follows it is what follows the BEGIN line: the same text, blanks at an end aside', () => {
    const lines = K.F.openvpn.filter((l) => /^[0-9a-f]{32}$/.test(l))
    const END = '-----END OpenVPN Static key V1-----'
    // a list whose BEGIN item has trailing blanks the others have not (a tail with letters in it: only the same text is the key lines')
    const list = [`<li>${HEADER}</li>    `, ...lines.map((l) => `<li>${l}</li>`), `<li>${END}</li>`].join('\n')
    expect(screenKeys(list).removed).toEqual({ openvpn_static_key: 1 })
    expect(leakedWindows(screenKeys(list).text, lines)).toBe(0)
    // a tail that every line repeats and is longer than 16 characters (an echo into a file, a tag): read whole from the BEGIN line, not its first 16 characters
    const echo = [`echo '${HEADER}' > /etc/openvpn/ta.key.tmp`, ...lines.map((l) => `echo '${l}' >> /etc/openvpn/ta.key.tmp`), `echo '${END}' >> /etc/openvpn/ta.key.tmp`].join('\n')
    const tags = [`<li>${HEADER}</span></li><!-- static key line -->`, ...lines.map((l) => `<li>${l}</span></li><!-- static key line -->`), `<li>${END}</span></li><!-- static key line -->`].join('\n')
    for (const [name, doc] of [['an echo into a file', echo], ['tags and a comment', tags]]) {
      const r = screenKeys(doc)
      expect(r.removed, name).toEqual({ openvpn_static_key: 1 })
      expect(leakedWindows(r.text, lines), name).toBe(0)
    }
    // the same length of tail, other text: a list of digests with a constant cell that is not the header's
    const same = [`${HEADER} OK`, ...Array.from({ length: 20 }, () => `${randomBytes(16).toString('hex')} NO`)].join('\n')
    expect(screenKeys(same).text).toBe(same)
    expect(screenKeys(same).removed).toEqual({})
  })

  it('and a run of 512 digits is the key when it starts within 4,096 characters of the BEGIN line, and is not after that', () => {
    // The stretch between the header and the run is read for each run of 512 digits in a block, to see that no word is in it, so it is
    // bounded (a block of such runs cost the square of its length, and a run of backslashes inside the stretch, too). A frame is a few
    // characters, and a key is not sent 4 KB below its header.
    const BS = '\\'
    const digits = K.F.openvpn.filter((l) => /^[0-9a-f]{32}$/.test(l)).join('')
    const END = '-----END OpenVPN Static key V1-----'
    for (const [name, gap] of [['blanks', ' '], ['backslashes no escape ends', BS]] as const) {
      const within = `${HEADER}${gap.repeat(4096)}${digits}\n${END}`
      const r = screenKeys(within)
      expect(r.removed, `${name}, 4,096`).toEqual({ openvpn_static_key: 1 })
      expect(leakedWindows(r.text, [digits.slice(0, 64), digits.slice(448)]), `${name}, 4,096`).toBe(0)
      const beyond = `${HEADER}${gap.repeat(4097)}${digits}\n${END}`
      const b = screenKeys(beyond)
      expect(b.removed, `${name}, 4,097`).toEqual({})
      expect(b.flagged, `${name}, 4,097`).toEqual({ openvpn_static_key: 1 })
    }
    // (the distance is counted in characters: written-out line breaks under the header are 2 or 6 characters each)
    const breaks = `${HEADER}${(BS + 'n').repeat(1000)}${digits}\n${END}`
    expect(screenKeys(breaks).removed).toEqual({ openvpn_static_key: 1 })
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

describe('T1 K4: a PGP export whose checksum line sits behind a listing path with a long directory name', () => {
  // The guard that keeps '<key line><checksum>' glued together from being read as a checksum line looked
  // for a run of 16 base64 characters anywhere before the '=', and a path (/etc/ssl/private/server.key:12:,
  // ./deployment/keys/production/deploy.asc:12:) holds one: the export's tail crossed with no note.
  const LISTINGS: Record<string, (ls: string[]) => string> = {
    'rg, a deep POSIX path': (ls) => ls.map((l, i) => `/etc/ssl/private/server.key:${i + 1}:${l}`).join('\n'),
    'rg, a relative path': (ls) => ls.map((l, i) => `./deployment/keys/production/deploy.asc:${i + 1}:${l}`).join('\n'),
    'rg with -C context lines': (ls) => ls.map((l, i) => `/home/dev/projects/infrastructure/deployment/keys/production/deploy.key${i === 0 ? ":" : "-"}${i + 1}${i === 0 ? ":" : "-"}${l}`).join('\n'),
    'rg, no line numbers': (ls) => ls.map((l) => `/home/dev/projects/infrastructure/deployment/keys/production/deploy.key:${l}`).join('\n'),
    'grep -rn, a path of one long name': (ls) => ls.map((l, i) => `./abcdefghijklmnopqrstuvwxyz0123456789/deploy.asc:${i + 1}:${l}`).join('\n'),
  }

  it('is removed from its END line when the text an older computer cut starts inside it, in each listing', () => {
    for (const format of ['pgp_rsa_hdr', 'pgp_ed_hdr', 'pgp_rsa_nohdr'] as Format[]) {
      const lines = K.F[format]
      const secret = secretLinesOf(lines)
      for (const [name, list] of Object.entries(LISTINGS)) {
        const text = list(lines) + '\nThe export finished.\n'
        const first = text.indexOf(secret[0].slice(0, 16))
        const lastBody = text.indexOf(secret[secret.length - 1])
        // a cut at every 29th character from the first body line to the last: what arrived holds the
        // END line and the lines under the cut
        for (let cut = first; cut < lastBody; cut += 29) {
          const r = screenKeys(text.slice(cut), { cutStart: true })
          const arrived = secret.filter((l) => text.slice(cut).includes(l.slice(0, 12)))
          // (a line the cut left under 16 characters of cannot be told from other text: the rest must go)
          expect(leakedWindows(r.text, arrived.slice(1)), `${format}/${name}/cut ${cut - first}`).toBe(0)
        }
      }
    }
  })

  it('is removed from its END line when the doing side keeps only an end that starts inside it, past where a BEGIN line is looked for', () => {
    const lines = pgpPhotoExport(450_000)
    const secret = secretLinesOf(lines)
    for (const [name, list] of Object.entries(LISTINGS)) {
      const text = 'Listing:\n' + list(lines) + '\nDone.\n'
      for (const keep of [3_999, 200_000]) {
        const r = screenKeys(text, { keep })
        expect(leakedWindows(r.text, secret), `${name}/keep ${keep}`).toBe(0)
        expect(r.removed, `${name}/keep ${keep}`).toEqual({ gpg_block: 1 })
      }
    }
  })

  it('is told from a key line with a checksum glued on, which is no checksum line', () => {
    // three random lines, then 20 base64 characters and "=ab12" on one line, then a bare PGP END line at
    // the start of the text an older computer cut: no key's tail (a checksum line holds nothing else)
    for (let n = 0; n < 10; n++) {
      const glued = randomBytes(15).toString('base64') + 'Qx' + '=ab12'
      for (const dot of ['', '.', ' +']) {
        const text = [randomBytes(48).toString('base64'), randomBytes(48).toString('base64'), randomBytes(48).toString('base64'), glued + dot, '-----END PGP PRIVATE KEY BLOCK-----', ''].join('\n')
        const r = screenKeys(text, { cutStart: true })
        expect(r.text, `${n}/${JSON.stringify(dot)}`).toBe(text)
        expect(r.removed, `${n}/${JSON.stringify(dot)}`).toEqual({})
      }
    }
  })
})

describe('a key tail when the screen knows of no cut (no cutAt): the window starts inside the text', () => {
  it('is reported, not removed, when its head is in the text above the window', () => {
    // three key-shaped lines above an END line, the window starting 60 characters in: a hash list or a
    // dump whose first line the window's start fell under is no key the window cut off
    const lines = Array.from({ length: 3 }, () => randomBytes(48).toString('base64').replace(/[+/=]/g, 'x'))
    const text = `${"x".repeat(60)}\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`
    const spans = headless(text, [], { start: 60 })
    expect(spans.map((x) => [x.cls, x.why])).toEqual([['flag', 'tail-unanchored']])
  })
})

describe('F4: a key with no END line, an older computer cut it, in a listing whose path is a long run of letters', () => {
  // The docs promise that 80 or more characters of such a key arrive reported. The longest base64-alphabet run of each line was
  // taken for its payload, and a path of 65 characters or more (/Users/alice/Projects/PaymentService/src/main/resources/certs/private)
  // is longer than the key's 64-character line: no key run was found, and the key crossed with no note.
  const PATHS = ['/etc/ssl/private/server', '/Users/alice/Projects/PaymentService/src/main/resources/certs/private', `./${'a'.repeat(90)}/deploy`]
  const FRAMED: Record<string, (path: string, ls: string[]) => string> = {
    'rg -n': (p, ls) => ls.map((l, i) => `${p}.key:${i + 1}:${l}`).join('\n'),
    'rg -A (context lines)': (p, ls) => ls.map((l, i) => (i === 0 ? `${p}.key:${i + 1}:${l}` : `${p}.key-${i + 1}-${l}`)).join('\n'),
    'grep -r (no line numbers)': (p, ls) => ls.map((l) => `${p}.key:${l}`).join('\n'),
    'rg with CRLF line ends': (p, ls) => ls.map((l, i) => `${p}.key:${i + 1}:${l}`).join('\r\n'),
  }
  it.each(Object.keys(FRAMED))('%s: every cut of the key with 80 or more of its characters left leaves no key line in view without a note', (listing) => {
    for (const format of ['pkcs8_rsa', 'pgp_rsa_nohdr'] as Format[]) {
      const lines = K.F[format].slice(0, -1) // no END line
      for (const path of PATHS) {
        const text = FRAMED[listing](path, lines)
        const secret = secretLinesOf(lines)
        const first = text.indexOf(secret[0])
        const keyCharsAfter = (o: number): number => secret.reduce((n, s) => n + Math.max(0, text.indexOf(s) + s.length - Math.max(o, text.indexOf(s))), 0)
        for (let o = first; o < text.length - 20; o += 37) {
          if (keyCharsAfter(o) < 80) continue
          const r = screenKeys(text.slice(o), { cutStart: true })
          if (leakedWindows(r.text, secret) === 0) continue
          const label = `${format}/${path.length} chars of path/cut at ${o - first}`
          expect(Object.keys(r.removed).length + Object.keys(r.flagged).length, label).toBeGreaterThan(0)
        }
      }
    }
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

  /** The base64 of a PEM file as a Secret holds it, padded or not (the length of the file decides): the
   *  key's file gets extra blank lines until it is, a certificate a longer body. */
  const keyFile = (padded: boolean): string => {
    for (let n = 1; n < 6; n++) {
      const b = Buffer.from(K.F.sec1_ec.join('\n') + '\n'.repeat(n)).toString('base64')
      if (b.endsWith('=') === padded) return b
    }
    throw new Error('no length')
  }
  const certFile = (padded: boolean): string => {
    for (let n = 600; n < 700; n++) {
      const b = Buffer.from(['-----BEGIN CERTIFICATE-----', ...wrap(randomBytes(n).toString('base64')), '-----END CERTIFICATE-----', ''].join('\n')).toString('base64')
      if (b.endsWith('=') === padded) return b
    }
    throw new Error('no length')
  }

  it("removes the key of a Kubernetes TLS Secret whose certificate is listed above it, padded or not, and leaves the lines around its value", () => {
    for (const certPadded of [true, false]) {
      for (const keyPadded of [true, false]) {
        const crt = certFile(certPadded)
        const key = keyFile(keyPadded)
        const label = `certificate ${certPadded ? "padded" : "unpadded"}, key ${keyPadded ? "padded" : "unpadded"}`
        // kubectl get secret -o yaml: the keys come sorted, so tls.crt is right above tls.key
        const yaml = ['apiVersion: v1', 'data:', `  tls.crt: ${crt}`, `  tls.key: ${key}`, 'kind: Secret', 'metadata:', '  name: my-app-tls', 'type: kubernetes.io/tls', ''].join('\n')
        const r = screenKeys(yaml)
        expect(r.text, label).toBe(yaml.replace(key, '[REDACTED:private_key_b64]'))
        expect(r.removed, label).toEqual({ private_key_b64: 1 })
        // kubectl get secret -o json, indented
        const json = ['{', '    "apiVersion": "v1",', '    "data": {', `        "tls.crt": "${crt}",`, `        "tls.key": "${key}"`, '    },', '    "kind": "Secret",', '    "type": "kubernetes.io/tls"', '}', ''].join('\n')
        const j = screenKeys(json)
        expect(j.text, label).toBe(json.replace(key, '[REDACTED:private_key_b64]'))
        expect(j.removed, label).toEqual({ private_key_b64: 1 })
      }
    }
    // the lines under a key's value are not its wrapped lines: a label of their own ends the value
    const key = keyFile(false)
    const under = [
      `  tls.key: ${key}`,
      'kind: Secret',
      'type: kubernetes.io/tls',
      '  secretName: my-app-tls-secret',
      `  crt: ${certFile(false).slice(0, 60)}`,
      '  SHA: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08=',
      `bundle: ${certFile(false).slice(0, 48)}`,
      '  replicas: 3',
    ]
    const r = screenKeys(under.join('\n'))
    expect(r.text).toBe(['  tls.key: [REDACTED:private_key_b64]', ...under.slice(1)].join('\n'))
    // two files with no labels, one after the other (cat tls.crt.b64 tls.key.b64): the padded certificate ends its value
    const crt = certFile(true)
    const bare = screenKeys(crt + '\n' + keyFile(true) + '\n')
    expect(bare.text).toBe(crt + '\n[REDACTED:private_key_b64]\n')
    expect(bare.removed).toEqual({ private_key_b64: 1 })
  })

  it('removes a key file stored base64 encoded and written NAME=<base64>, keeping the name', () => {
    const key = keyFile(false)
    const padded = keyFile(true)
    const forms: Record<string, [string, string]> = {
      'a .env file': [`TLS_KEY_B64=${key}\nPORT=8080\n`, `TLS_KEY_B64=[REDACTED:private_key_b64]\nPORT=8080\n`],
      'export in a shell': [`export TLS_KEY=${padded}\n`, `export TLS_KEY=[REDACTED:private_key_b64]\n`],
      'a properties file': [`tls.key=${key}\n`, `tls.key=[REDACTED:private_key_b64]\n`],
      'docker run -e': [`docker run -e KEY=${key} -p 80:80 app\n`, `docker run -e KEY=[REDACTED:private_key_b64] -p 80:80 app\n`],
      'a compose environment': [`environment:\n  - TLS_KEY=${padded}\n  - PORT=8080\n`, `environment:\n  - TLS_KEY=[REDACTED:private_key_b64]\n  - PORT=8080\n`],
      'a URL query': [`curl "https://host/path?key=${key}&x=1"\n`, `curl "https://host/path?key=[REDACTED:private_key_b64]&x=1"\n`],
      'curl -d': [`curl -d key=${padded} https://host/\n`, `curl -d key=[REDACTED:private_key_b64] https://host/\n`],
      'an ini file': [`[tls]\nprivate_key=${key}\n`, `[tls]\nprivate_key=[REDACTED:private_key_b64]\n`],
    }
    for (const [name, [text, want]] of Object.entries(forms)) {
      const r = screenKeys(text)
      expect(r.text, name).toBe(want)
      expect(r.removed, name).toEqual({ private_key_b64: 1 })
    }
    // wrapped at 76 behind its name (a .env file whose value was folded), and a service-account JSON file
    const wrapped = wrap(keyFile(true), 76)
    const folded = screenKeys(`TLS_KEY=${wrapped[0]}\n${wrapped.slice(1).join("\n")}\nPORT=1\n`)
    expect(folded.removed).toEqual({ private_key_b64: 1 })
    expect(leakedWindows(folded.text, wrapped)).toBe(0)
    const sa = Buffer.from(JSON.stringify({ type: 'service_account', private_key: K.F.pkcs8_rsa.join('\n') + '\n', client_email: 'a@b.iam.gserviceaccount.com' })).toString('base64')
    for (const name of ['GOOGLE_CREDENTIALS', 'GCP_SA_KEY']) {
      const r = screenKeys(`${name}=${sa}\n`)
      expect(r.text, name).toBe(`${name}=[REDACTED:private_key_b64]\n`)
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
  const BS = '\\'
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

  it('takes the private lines of a PuTTY file in a JSON string whose writer escapes base64 characters (PHP \\/, .NET \\u002B), with its MAC line and without', () => {
    const ppk = K.ppk
    const secret = secretLinesOf(ppk, true)
    const php = (t: string): string => t.replace(/\//g, '\\/')
    const net = (t: string): string => t.replace(/\+/g, '\\' + 'u002B').replace(/\//g, '\\' + 'u002F')
    const withoutMac = ppk.slice(0, -1)
    for (const [name, escape] of [['PHP', php], ['.NET', net]] as Array<[string, (t: string) => string]>) {
      for (const [macName, lines] of [['with the MAC line', ppk], ['without it', withoutMac]] as Array<[string, string[]]>) {
        const text = '{"ppk":' + escape(JSON.stringify(lines.join('\n'))) + ',"ok":true}'
        const r = screenKeys(text)
        expect(r.removed, `${name} ${macName}`).toEqual({ putty_private_key: 1 })
        expect(leakedWindows(r.text, secret), `${name} ${macName}`).toBe(0)
        expect(r.text.endsWith(',"ok":true}'), `${name} ${macName}`).toBe(true)
      }
    }
    // the same file in an array of lines
    const lines = ppk.map((l) => l + '\n')
    expect(screenKeys(php(JSON.stringify(lines))).removed).toEqual({ putty_private_key: 1 })
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

  // The five kinds of key PuTTYgen writes, each with the size of its public and private blobs: an Ed25519 key's private part is one line of 48
  // characters (PuTTYgen's default), an ECDSA P-256 key's one of 52, P-521's two (64 and 32), a DSA key's one of 36. Built from a fixed stream of
  // bytes, so what is asserted of a short line's randomness is the same every run (3 in 100 of them fail the test); a stream is taken whose
  // private part passes it and does not start with a digit (a file with no line breaks reads the digits after `Private-Lines: ` as its count).
  const PPK_KINDS: Record<string, [string, number, number]> = {
    rsa: ['ssh-rsa', 279, 880],
    ed25519: ['ssh-ed25519', 51, 36],
    p256: ['ecdsa-sha2-nistp256', 104, 37],
    p521: ['ecdsa-sha2-nistp521', 172, 70],
    dsa: ['ssh-dss', 435, 25],
  }
  function ppkOf(kind: string, opts: { version?: 2 | 3; mac?: boolean } = {}): { lines: string[]; secret: string[] } {
    const [type, pubSize, privSize] = PPK_KINDS[kind]
    const stream = (tag: string, size: number): Buffer => Buffer.concat(Array.from({ length: Math.ceil(size / 32) }, (_, k) => createHash('sha256').update(`${tag}/${k}`).digest())).subarray(0, size)
    for (let i = 0; ; i++) {
      const priv = wrap(stream(`${kind}/private/${i}`, privSize).toString('base64'))
      if (/^\D/.test(priv[0]) && looksRandom(priv.join(''))) {
        const pub = wrap(stream(`${kind}/public/${i}`, pubSize).toString('base64'))
        const lines = [`PuTTY-User-Key-File-${opts.version ?? 3}: ${type}`, 'Encryption: none', 'Comment: key-20261102', `Public-Lines: ${pub.length}`, ...pub, `Private-Lines: ${priv.length}`, ...priv]
        if (opts.mac !== false) lines.push(`Private-MAC: ${stream(`${kind}/mac/${i}`, opts.version === 2 ? 20 : 32).toString('hex')}`)
        return { lines, secret: priv }
      }
    }
  }

  it('takes the private lines of a PuTTY file of any kind in a string whose line breaks are written out, with its MAC line behind and without it', () => {
    // An Ed25519, ECDSA or DSA file has one or two private lines, and the line before `Private-MAC:` is the only one there is: the rule that
    // skips a path (a listing's `deploy/key.ppk:12:`) read the `\nPrivate-` after it as more of a path and its dash as the end of one.
    const joinings: Record<string, (ls: string[]) => string> = {
      'a JSON string': (ls) => JSON.stringify(ls.join('\n')),
      'a JSON object': (ls) => `{"ppk":${JSON.stringify(ls.join('\n'))},"ok":true}`,
      'JSON in JSON': (ls) => JSON.stringify(JSON.stringify(ls.join('\n'))),
      'an environment variable': (ls) => `PUTTY_KEY="${ls.join(BS + 'n')}"`,
      'a YAML double-quoted string': (ls) => `key: "${ls.join(BS + 'n')}"`,
      'a JavaScript string': (ls) => `const key = '${ls.join(BS + 'n')}'`,
      'a $ string': (ls) => `$'${ls.join(BS + 'n')}'`,
      'the Unicode escape of a line feed': (ls) => ls.join(BS + 'u000a'),
      'the hex escape of a line feed': (ls) => ls.join(BS + 'x0a'),
      'a CR and a LF written out': (ls) => `"${ls.join(BS + 'r' + BS + 'n')}"`,
    }
    for (const kind of Object.keys(PPK_KINDS)) {
      for (const version of [2, 3] as const) {
        for (const mac of [true, false]) {
          const { lines, secret } = ppkOf(kind, { version, mac })
          for (const [name, join] of Object.entries(joinings)) {
            const label = `${kind}, version ${version}, ${mac ? 'with' : 'without'} the MAC line, ${name}`
            const r = screenKeys(`Here is the file:\n${join(lines)}\nDone.`)
            expect(r.removed, label).toEqual({ putty_private_key: 1 })
            expect(leakedWindows(r.text, secret), label).toBe(0)
          }
        }
      }
    }
  })

  it('takes the private lines of a PuTTY file with a log frame on each line inside one string, and of one in a listing in a JSON string', () => {
    // A tool result quotes a log in a JSON string: each line carries the clock time `docker logs -t` writes, a compose service's `web-1  | `,
    // or ripgrep's `path:N:`, and the lines are joined by written-out breaks. After the break of the last private line comes the frame of the
    // next one, whose digits and dash (or colon) the rule that skips a path read as the rest of a path.
    const frames: Record<string, (l: string, i: number) => string> = {
      'docker logs -t': (l, i) => `2026-11-02T10:11:${String(10 + (i % 50))}.123456789Z ${l}`,
      'compose': (l) => `web-1  | ${l}`,
      'ripgrep': (l, i) => `config/deploy/key.ppk:${i + 1}:${l}`,
      'ripgrep with a long directory name': (l, i) => `/home/dev/projects/infrastructure/deployment/keys/production/deploy.ppk:${i + 1}:${l}`,
    }
    for (const kind of ['rsa', 'ed25519', 'p521']) {
      const { lines, secret } = ppkOf(kind)
      for (const [name, frame] of Object.entries(frames)) {
        const r = screenKeys(`Output:\n${JSON.stringify(lines.map(frame).join('\n'))}\nDone.`)
        expect(r.removed, `${kind}, ${name}`).toEqual({ putty_private_key: 1 })
        expect(leakedWindows(r.text, secret), `${kind}, ${name}`).toBe(0)
      }
    }
    // the same RSA file whose RSA lines are K's own (a fresh key of the fixture's), in the two framings that put a colon after the path
    const fresh = K.ppk
    const rg = JSON.stringify(fresh.map((l, i) => `config/deploy/key.ppk:${i + 1}:${l}`).join('\n'))
    expect(screenKeys(rg).removed).toEqual({ putty_private_key: 1 })
    expect(leakedWindows(screenKeys(rg).text, secretLinesOf(fresh, true))).toBe(0)
  })

  it('skips a long piece of a path that a colon, a context line number or an equals sign ends, and takes the private lines after it', () => {
    // The directory's name is a run of 70 characters, longer than any key line, and what follows it says it is a path: an extension and a `:` (grep -H over
    // a file whose lines are indented, or rg without line numbers), a `-12-` (a context line), or an `=` and a line's worth of payload (journalctl's NAME=).
    const { lines, secret } = ppkOf('ed25519')
    const dir = Array.from({ length: 70 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7 + 3) % 36]).join('')
    const forms: Record<string, (l: string, i: number) => string> = {
      'a colon and an indent': (l) => `config/${dir}.yaml:    ${l}`,
      'a colon': (l) => `config/${dir}.ppk:${l}`,
      'a line number between colons': (l, i) => `config/${dir}.ppk:${i + 1}:${l}`,
      'a context line number between dashes': (l, i) => `config/${dir}.ppk-${i + 1}-${l}`,
      'an equals sign': (l) => `config/${dir}.ppk=${l}`,
      'a name with a dash in it, and a colon': (l) => `config/${dir}-signing.ppk:${l}`,
      'a name with an underscore in it': (l) => `config/${dir}_key.ppk:${l}`,
      'a name with a folder after it': (l, i) => `config/${dir}_sub/deploy.ppk:${i + 1}:${l}`,
      'a name that goes on with MAC': (l, i) => `config/${dir}-MACHINE.ppk:${i + 1}:${l}`,
    }
    for (const [name, form] of Object.entries(forms)) {
      const r = screenKeys(lines.map(form).join('\n'))
      expect(r.removed, name).toEqual({ putty_private_key: 1 })
      expect(leakedWindows(r.text, secret), name).toBe(0)
      expect(r.text, name).toContain(dir)
    }
  })

  it('reads an extension and an equals sign as the end of a path only with a line of payload behind them', () => {
    // After the last private line comes `.k=` and no payload (a quote, or the name of the MAC line): the `=` is not a listing's NAME= (journalctl's),
    // so the run in front of it is a private line, not the long piece of a path.
    for (const kind of ['ed25519', 'p256', 'p521']) {
      const { lines, secret } = ppkOf(kind)
      const last = lines.length - 2
      const head = lines.slice(0, last).join('\n')
      const forms: Record<string, string> = {
        'a quote and a line break': `${head}\n${lines[last]}.k="\n${lines[last + 1]}`,
        'the name of the MAC line': `${head}\n${lines[last]}.k=${lines[last + 1]}`,
      }
      for (const [name, text] of Object.entries(forms)) {
        const r = screenKeys(text)
        expect(r.removed, `${kind}, ${name}`).toEqual({ putty_private_key: 1 })
        expect(leakedWindows(r.text, secret), `${kind}, ${name}`).toBe(0)
      }
    }
  })

  it('takes the private lines of a PuTTY file whose lines are joined by a few characters of punctuation, with the MAC line behind and without it', () => {
    // `-`, `.` and `_` are characters of a path, and a dash or a colon in front of more text is where a path would end. A run that one of them, or
    // three, joins to the next line is no path's piece: nor is the last private line when the MAC line's name follows it (`Private-MAC:` has a colon).
    for (const kind of ['ed25519', 'p521', 'rsa']) {
      for (const mac of [true, false]) {
        const { lines, secret } = ppkOf(kind, { mac })
        for (const joiner of ['-', '.', '_', '--', '-_-', '.-.']) {
          const label = `${kind}, ${mac ? 'with' : 'without'} the MAC line, joined by ${joiner}`
          const r = screenKeys(`PUTTY_KEY="${lines.join(joiner)}"`)
          expect(r.removed, label).toEqual({ putty_private_key: 1 })
          expect(leakedWindows(r.text, secret), label).toBe(0)
        }
      }
    }
    // and by a colon, where only the MAC line's name is told from a path (a file of lines joined by colons is a listing's path and line)
    const { lines, secret } = ppkOf('p256')
    const r = screenKeys(`PUTTY_KEY="${lines.join(':')}"`)
    expect(r.removed).toEqual({ putty_private_key: 1 })
    expect(leakedWindows(r.text, secret)).toBe(0)
  })

  it('skips the long pieces of the path of a listing on Windows, whose folders start with an r or an n, and takes the private lines of a PuTTY file under it', () => {
    // `\notes` and `\repos` read as a written-out line break. The piece of the path in front of one is 45 characters, and the private lines
    // are under it, in a listing: the run of letters before `\keys\repos` ends in a path, and is no private line. (A file of 14 private
    // lines: one taken from the path would be the first of the 14 and the last of them would be left.)
    const { lines, secret } = ppkOf('rsa')
    const piece = Array.from({ length: 45 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 11 + 5) % 36]).join('')
    for (const dir of [`C:${BS}work${BS}${piece}${BS}keys${BS}repos`, `D:${BS}ci${BS}${piece}${BS}keys${BS}notes`]) {
      const text = lines.map((l, i) => `${dir}${BS}deploy.ppk:${i + 1}:${l}`).join('\r\n')
      const r = screenKeys(text)
      expect(r.removed, dir).toEqual({ putty_private_key: 1 })
      expect(leakedWindows(r.text, secret), dir).toBe(0)
      expect(r.text, dir).toContain(piece)
    }
  })

  it('takes the private lines of a PuTTY file written with no line break at all, with its MAC line behind and without it', () => {
    // `tr -d '\n'`, or PowerShell's `-join ''`: the lines run together, the last private line into the `Private` of `Private-MAC`. The
    // padding `=` that line ends in (ECDSA P-256 and P-521, DSA) is not the end of a NAME=, and the name of the MAC line is not a path.
    for (const kind of Object.keys(PPK_KINDS)) {
      for (const version of [2, 3] as const) {
        for (const mac of [true, false]) {
          const { lines, secret } = ppkOf(kind, { version, mac })
          const label = `${kind}, version ${version}, ${mac ? 'with' : 'without'} the MAC line`
          const r = screenKeys(`PUTTY_KEY="${lines.join('')}"`)
          expect(r.removed, label).toEqual({ putty_private_key: 1 })
          expect(leakedWindows(r.text, secret), label).toBe(0)
        }
      }
    }
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

describe('T2 K7 and K8: a value that describes or names a key is left, and reported', () => {
  const names = [
    'PrivateExponentBase64UrlEncodedValueGoesHere',
    'privateExponentEncodedAsBase64UrlGoesHere',
    'mySuperSecretKeyForSigning2026',
    'JWT_SIGNING_SECRET_BASE64URL',
    'PRIVATE_KEY_D_VALUE_FROM_ENV_VARS_HERE',
    'mysupersecretsigningkey',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC-truncated-here',
  ]
  it('in an oct JWK, in JSON, in YAML and in code', () => {
    for (const name of names) {
      for (const text of [
        JSON.stringify({ kty: 'oct', k: name, alg: 'HS256' }),
        `jwk:\n  kty: oct\n  k: ${name}\n`,
        `const jwk = { kty: "oct", k: ${name} }\n`,
        `jwk = {"kty": "oct", "k": "${name}"}\n`,
      ]) {
        const r = screenKeys(text)
        expect(r.text, text).toBe(text)
        expect(r.removed, text).toEqual({})
      }
    }
  })
  it('in an RSAKeyValue, as a sentence of 86 characters or more in a private member', () => {
    const sentence = 'PrivateExponentValueGoesHereBase64EncodedSecretMaterialConfigFromTheEnvironmentVariablesOfTheDeploymentPipeline'
    expect(sentence.length).toBeGreaterThanOrEqual(86)
    const xml = `<RSAKeyValue><Modulus>${hash(172)}</Modulus><Exponent>AQAB</Exponent><D>${sentence}</D><P>${sentence}</P><Q>${sentence}</Q></RSAKeyValue>`
    const r = screenKeys(xml)
    expect(r.text).toBe(xml)
    expect(r.removed).toEqual({})
  })
  /** Random base64 of n characters with no '+' or '/' that the placeholder checks would not read as a word. */
  function hash(n: number): string {
    return randomBytes(Math.ceil((n * 3) / 4)).toString('base64').replace(/[+/=]/g, 'x').slice(0, n)
  }
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

  it('F-B: a legacy encrypted key an older computer cut inside its DEK-Info line, or the line break after it, or the frame of the blank line under it, goes in every joining: listings, logs, diffs, code literals', () => {
    // The headers are the only proof of such a key (its body is encrypted, so it decodes to nothing):
    // what the cut left of them, and of the lines between them and the key lines, was read in a bare
    // frame only, so 847 of 4,618 cuts left the key's lines in view in 14 of the joinings.
    const lines = K.F.rsa_legacy_enc
    const secret = secretLinesOf(lines)
    // (not the three the docs name as crossing an older computer's cut: a key all on one line, with no separator, echoed line by line)
    const joinings = Object.keys(JOIN).filter((j) => !['space_one_line', 'no_sep', 'shell_echo'].includes(j))
    expect(joinings.length).toBeGreaterThanOrEqual(24)
    let cuts = 0
    for (const joining of joinings) {
      const text = JOIN[joining](lines) + '\nThe deploy finished.\n'
      const firstBody = text.indexOf(secret[0].slice(0, 16))
      for (let at = Math.max(1, firstBody - 260); at < firstBody; at += 2) {
        for (const lead of ['', '…']) {
          const r = screenKeys(lead + text.slice(at), { cutStart: true })
          cuts++
          expect(leakedWindows(r.text, secret), `${joining} cut ${firstBody - at} before the first key line${lead ? ", after an ellipsis" : ""}`).toBe(0)
        }
      }
    }
    expect(cuts).toBeGreaterThan(4_000)
  })

  it('F-B: and in a Python raw string, a Python or Rust line continuation, and cat -A, where the blank line under the headers is r"", "\\n" \\ or $', () => {
    // (the lines the cut left of the headers end in a joiner the first rule did not know: the raw string's r before its
    // quotes, a continuation's backslash, the `$` cat -A puts at each line's end. Every offset, not every second:
    // two of these leaked at one offset only)
    const more: Record<string, (ls: string[]) => string> = {
      py_raw: (ls) => 'KEY = (\n' + ls.map((l) => `    r"${l}"`).join('\n') + '\n)',
      py_backslash: (ls) => 'KEY = ' + ls.map((l) => `"${l}\\n"`).join(' \\\n    '),
      rust_cont: (ls) => 'let key = "' + ls.join('\\n\\\n') + '";',
      cat_A: (ls) => ls.map((l) => `${l}$`).join('\n'),
    }
    const lines = K.F.rsa_legacy_enc
    const secret = secretLinesOf(lines)
    let cuts = 0
    for (const [joining, join] of Object.entries(more)) {
      const text = join(lines) + '\nThe deploy finished.\n'
      const firstBody = text.indexOf(secret[0].slice(0, 16))
      for (let at = Math.max(1, firstBody - 260); at < firstBody; at++) {
        for (const lead of ['', '…']) {
          const r = screenKeys(lead + text.slice(at), { cutStart: true })
          cuts++
          expect(leakedWindows(r.text, secret), `${joining} cut ${firstBody - at} before the first key line${lead ? ', after an ellipsis' : ''}`).toBe(0)
        }
      }
    }
    expect(cuts).toBeGreaterThan(1_000)
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

  it('F-E: a base64 key file an older computer cut through goes with its first line behind frames with letters in them', () => {
    const wrapped = wrap(Buffer.from(K.F.pkcs8_rsa.join('\n') + '\n').toString('base64'), 76)
    // (the cut took the first line's frame with the start of its data. The other lines carry a path, a container's name or a
    // host, which is not the first line's frame, and a second line with a label of its own is another value, not a wrapped
    // line: except at the start of a text another computer cut, where the first line has no frame left to compare)
    const forms: Record<string, (l: string, i: number) => string> = {
      'rg listing': (l, i) => `deploy/config/secret.yaml:${i + 12}:${l}`,
      'docker logs': (l) => `web-1  | ${l}`,
      journalctl: (l) => `Oct 31 10:00:01 host app[123]: ${l}`,
    }
    for (const [name, frame] of Object.entries(forms)) {
      const text = `${wrapped.map(frame).join('\n')}\nthe end of the file\n`
      const data = text.indexOf(wrapped[3])
      for (const n of [10, 30, 60]) {
        const r = arrived(text, data + n)
        expect(r.text.includes(wrapped[3].slice(n)), `${name} ${n}: the first line`).toBe(false)
        expect(wrapped.slice(4).filter((l) => r.text.includes(l.slice(0, 16))), `${name} ${n}: the lines after it`).toEqual([])
        expect(r.removed, `${name} ${n}`).toEqual({ private_key_b64: 1 })
        expect(r.text.endsWith('\nthe end of the file\n'), `${name} ${n}`).toBe(true)
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

describe('what stays next to a key tail and its END line: the guards against taking ordinary text for a key', () => {
  // Found by the final round's false-removal review: five guards no test failed without. Each input below is
  // kept by the code and was removed by a build without that guard (scripts/linkedScreenMutants.cjs).
  const hash = (n: number): string => randomBytes(Math.ceil((n * 3) / 4)).toString('base64').replace(/[+/=]/g, 'x').slice(0, n)
  const END = '-----END PRIVATE KEY-----'
  /** Kept byte for byte as the end an older computer cut, and as an error behind an ellipsis. */
  function kept(text: string, label: string): void {
    for (const view of [text, '…' + text]) {
      const r = screenKeys(view, { cutStart: true })
      expect(r.text, label).toBe(view)
      expect(r.removed, label).toEqual({})
    }
  }

  it("a lone partial line above an END line is a key's only when the END line carries the same frame: a hash line and a path:13: are not one", () => {
    kept(`> ${hash(76)}\nx.pem:13:-----END EC PRIVATE KEY-----\n`, 'a quoted hash line, then a listing path')
    kept(`ck.json:123:      "integrity": "sha512-${hash(86)}==",\nkeys/a.pem:28:${END}\n`, 'a lockfile hash line, then another file')
  })

  it("a number is no clock time: 'Step 3:', 'see 4.2' and 'release 1.55 footer' before an END line frame no key", () => {
    for (const lead of ['Step 3: ', 'see 4.2 ', 'release 1.55 footer ']) kept(`${hash(40)}\n${lead}${END}\n`, lead)
    // a clock time is a frame: a log line's
    const log = screenKeys(`${hash(76)}\n${hash(76)}\n12:00:03 ${END}\n`, { cutStart: true })
    expect(log.text).not.toContain('12:00:03')
  })

  it('a block that was only flagged leads nothing: key-shaped lines after it and an END line are reported, not taken', () => {
    const empty = ['-----BEGIN PRIVATE KEY-----', hash(64), 'x'.repeat(16), hash(64), END].join('\n')
    const flagged = keyBlocks(empty)
    expect(flagged.map((b) => b.cls)).toEqual(['flag'])
    // ...then a comment line and an indented END line; and key lines of one width and an END line
    for (const [text, label] of [
      [`${empty}\n// ${hash(25)}\n  ${END}\n`, 'a comment line and an indented END line'],
      [`-----BEGIN PRIVATE KEY-----\n${hash(64)}\n${"x".repeat(16)}\n${hash(64)}\n// ${hash(25)}\n${hash(64)}\n${hash(64)}\n${END}\n`, 'three key lines and an END line'],
    ]) {
      const r = screenKeys(text)
      expect(r.text, label).toBe(text)
      expect(r.removed, label).toEqual({})
    }
  })

  it('lines between a key taken and the key lines above an END line lead nothing when one holds words', () => {
    const head = K.F.pkcs8_rsa.slice(0, 12).join('\n')
    // a key cut short, a line of another width (it ends the key), a sentence with a hash in it, then
    // three key-shaped lines and an END line: the sentence ends what could go with the key
    const text = `${head}\n${hash(70)}\nthe hash of the next lines is ${hash(24)} as logged\n${hash(64)}\n${hash(64)}\n${hash(64)}\n${END}\n`
    const r = screenKeys(text)
    expect(r.removed).toEqual({ private_key: 1 })
    expect(r.text.endsWith(`as logged\n${text.split("as logged\n")[1]}`)).toBe(true)
    // without the sentence the lines are the key's: both go
    expect(screenKeys(`${head}\n${hash(70)}\n${hash(64)}\n${hash(64)}\n${hash(64)}\n${END}\n`).removed).toEqual({ private_key: 2 })
  })

  it("a sentence that ends in a word and a full stop is no key's last line: 'the log output.' above an END line", () => {
    kept(`${hash(17)}\nThis is the next part of the log output.\n${END}\n`, 'a short hash line and a sentence')
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
    // the algorithms whose public parameters are fixed text, and where each says its private value is: an EC key's scalar, a DH key's INTEGER
    const EC_OID = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]
    const DH_PKCS3 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x03, 0x01]
    const DH_X942 = [0x2a, 0x86, 0x48, 0xce, 0x3e, 0x02, 0x01]
    expect(structureOf(seq(int([0]), seq(oid(RSA_OID)), der(0x04, r)))).not.toHaveProperty('fixed')
    for (const [name, algorithm] of [['PKCS #3', DH_PKCS3], ['X9.42', DH_X942]] as Array<[string, number[]]>) {
      const key = seq(int([0]), seq(oid(algorithm), r), der(0x04, der(0x02, r)))
      const body = key.indexOf(r, key.length - r.length - 4)
      expect(structureOf(key), name).toMatchObject({ type: 'pkcs8', fixed: true, priv: [body, body + r.length] })
      // a private value that is no INTEGER is not located
      expect(structureOf(seq(int([0]), seq(oid(algorithm), r), der(0x04, der(0x04, r)))), name).not.toHaveProperty('priv')
    }
    const point = der(0x30, Buffer.concat([int([1]), der(0x04, r.subarray(0, 32))]))
    expect(structureOf(seq(int([0]), seq(oid(EC_OID), oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07])), der(0x04, point)))).toMatchObject({ fixed: true, priv: [expect.any(Number), expect.any(Number)] })
    // (Ed25519 has no parameters at all: its value is located and nothing is fixed)
    expect(structureOf(seq(int([0]), seq(oid([0x2b, 0x65, 0x70])), der(0x04, der(0x04, r.subarray(0, 32)))))).not.toHaveProperty('fixed')
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

describe("where a key's private value is in its DER: the first line of an EC or EdDSA key", () => {
  const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts))
  const int = (n: number): Buffer => der(0x02, Buffer.from([n]))
  const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'))
  const octet = (b: Buffer): Buffer => der(0x04, b)
  const EC_PUBLIC_KEY = '2a8648ce3d0201'
  const P256 = '2a8648ce3d030107'
  const scalar = (): Buffer => randomBytes(32)
  /** A PKCS#8 key: version 0, the algorithm (its OID, then the parameters), the key bytes. */
  const pkcs8 = (alg: Buffer, inner: Buffer): Buffer => seq(int(0), alg, octet(inner))
  const priv = (b: Buffer): [number, number] | undefined => structureOf(b)?.priv

  it('is found in a SEC1 key, an EC PKCS#8 key and the key of an Ed25519, X25519, Ed448 or X448 PKCS#8 key', () => {
    const d = scalar()
    const sec1 = seq(int(1), octet(d), der(0xa0, oid(P256)))
    expect(priv(sec1)).toEqual([sec1.indexOf(d), sec1.indexOf(d) + 32])
    const ecKey = seq(int(1), octet(d))
    const ec = pkcs8(seq(oid(EC_PUBLIC_KEY), oid(P256)), ecKey)
    expect(priv(ec)).toEqual([ec.indexOf(d), ec.indexOf(d) + 32])
    for (const last of ['70', '71', '6e', '6f']) {
      const curve = pkcs8(seq(oid('2b65' + last)), octet(d))
      expect(priv(curve), last).toEqual([curve.lastIndexOf(d), curve.lastIndexOf(d) + 32])
    }
  })

  it('is not found where the key is something else, or malformed: an RSA key, another OID, a key that is not what its OID says', () => {
    const d = scalar()
    // RSA: its first line holds a modulus
    expect(priv(pkcs8(seq(oid('2a864886f70d010101'), der(0x05, Buffer.alloc(0))), seq(int(0), der(0x02, randomBytes(40)))))).toBeUndefined()
    // an Ed-curve OID's neighbours: 1.3.101.112 is the last, 1.3.101.113 too; 1.3.101.114 and 1.3.100.110 are not
    expect(priv(pkcs8(seq(oid('2b6572')), octet(d)))).toBeUndefined()
    expect(priv(pkcs8(seq(oid('2b646e')), octet(d)))).toBeUndefined()
    expect(priv(pkcs8(seq(oid('2c656e')), octet(d)))).toBeUndefined()
    // an EC key whose ECPrivateKey is not a SEQUENCE, has no version, or whose key is not an OCTET STRING
    expect(priv(pkcs8(seq(oid(EC_PUBLIC_KEY), oid(P256)), randomBytes(48)))).toBeUndefined()
    expect(priv(pkcs8(seq(oid(EC_PUBLIC_KEY), oid(P256)), seq(octet(d), octet(d))))).toBeUndefined()
    expect(priv(pkcs8(seq(oid(EC_PUBLIC_KEY), oid(P256)), seq(int(1), int(2))))).toBeUndefined()
    // a curve key that is not an OCTET STRING
    expect(priv(pkcs8(seq(oid('2b656e')), der(0x02, d)))).toBeUndefined()
    // cut short: the key's bytes end before its first field
    expect(structureOf(pkcs8(seq(oid(EC_PUBLIC_KEY), oid(P256)), Buffer.alloc(0)).subarray(0, 40))?.priv).toBeUndefined()
  })

  it('a first line that holds fewer than 12 bytes of the value is only reported: a long algorithm parameter pushes the value down the line', () => {
    const d = scalar()
    const long = der(0x06, randomBytes(34))
    const key = pkcs8(seq(oid(EC_PUBLIC_KEY), long), seq(int(1), octet(d)))
    const line = wrap(key.toString('base64'), 64)[0]
    const [from] = priv(key) as [number, number]
    expect(Math.floor((line.length * 3) / 4) - from).toBeLessThan(12)
    const text = ['-----BEGIN PRIVATE KEY-----', line].join('\n')
    expect(keyBlocks(text).map((b) => [b.cls, b.why])).toEqual([['flag', 'pkcs8-example']])
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
    // a description or an identifier made of the words a key is spoken of in: two of them, in any case form
    expect(placeholderWhy('PrivateExponentBase64UrlEncodedValueGoesHere', 'b62')).toBe('named')
    expect(placeholderWhy('privateExponentEncodedAsBase64UrlGoesHere', 'b62')).toBe('named')
    expect(placeholderWhy('mySuperSecretKeyForSigning2026', 'b62')).toBe('named')
    expect(placeholderWhy('mysupersecretsigningkey', 'b62')).toBe('named')
    // an environment variable's name
    expect(placeholderWhy('JWT_SIGNING_SECRET_BASE64URL', 'b62')).toBe('env-name')
    expect(placeholderWhy('PRIVATE_KEY_D_VALUE_FROM_ENV_VARS_HERE', 'b62')).toBe('env-name')
    // a truncated key
    expect(placeholderWhy('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC-truncated-here', 'b62')).toBe('word')
    // one word of the list is not enough (a random value holds three letters of one about 1 in 700), and
    // neither is a random one: 20,000 values of the sizes a JWK holds, none a placeholder
    expect(placeholderWhy('X9fQ2mPrivateLk7vNd3RzT8wYb5HcJ4aE', 'b62')).toBeNull()
    for (let i = 0; i < 20_000; i++) {
      expect(placeholderWhy(randomBytes(i % 2 ? 32 : 48).toString('base64url'), 'b62'), String(i)).toBeNull()
    }
    expect(placeholderWhy(randomBytes(16).toString('hex'), 'b62')).toBeNull() // hex in a base62 slot: not one case
  })

  it('names a value that decodes to a phrase, and passes the random ones of every size a key has', () => {
    // The checks above read the encoded characters, and base64 of a phrase passes every one of them: a test secret
    // ("my-super-secret-key") in a JWK. A key's bytes are random: 16 of them are all printable ASCII, a tab or a line break about twice in 10^7.
    // (the last two encode with a - or _ in base64url and a + or / in base64; the ones with a line feed are what `echo my-secret | base64`
    // makes, and a Windows editor's)
    for (const phrase of ['my-super-secret-key', 'this is a test key for unit tests', 'change-me-in-production-please', 'not-a-real-key-just-an-example-value', 'Some documentation text that is base64 encoded', 'what is the secret key?? maybe>>>', 'the test key is ???~~~ not real', 'my-super-secret-key\n', 'my-super-secret-key\r\n', 'a\ttab-separated\tsecret-phrase']) {
      expect(placeholderWhy(Buffer.from(phrase).toString('base64url'), 'b62'), JSON.stringify(phrase)).toBe('text')
      expect(placeholderWhy(Buffer.from(phrase).toString('base64'), 'b62'), JSON.stringify(phrase)).toBe('text')
    }
    // a control character or a byte over 0x7e anywhere is no text: the bytes of a key
    for (const bytes of [Buffer.from('my-super-secret\u0001key-for-tests'), Buffer.from('my-super-secret-key-for\u001f-tests'), Buffer.from('my-super-secret-key-for-tests\u007f'), Buffer.from('my-super-secret-key-for-testsé'), Buffer.concat([Buffer.from('my-super-secret-key-for-tests'), Buffer.from([0])])]) {
      expect(placeholderWhy(bytes.toString('base64url'), 'b62'), bytes.toString('hex')).not.toBe('text')
    }
    // a value with a character outside the base64 alphabets is no base64: Node's decoder skips such a character, and the phrase left
    // over would make a value with a `!` or an `@` among its letters one
    const encoded = Buffer.from('my-super-secret-key-for-tests').toString('base64url')
    expect(placeholderWhy(encoded, 'b62')).toBe('text')
    for (const odd of ['.', '!', '@@', '~', ':']) {
      expect(placeholderWhy(encoded.slice(0, 12) + odd + encoded.slice(12), 'b62'), odd).not.toBe('text')
    }
    // (twelve bytes is the least: a shorter run of letters is a word the checks above judged)
    expect(placeholderWhy(Buffer.from('eleven bytes').toString('base64'), 'b62')).toBe('text')
    expect(placeholderWhy(Buffer.from('ten bytes!!').toString('base64'), 'b62')).not.toBe('text')
    // the real sizes of a key's members, 20,000 of each (a fixed stream of bytes, so what this asserts of a statistic is the same every run):
    // none of them is taken for a phrase
    const stream = (size: number, i: number): Buffer => Buffer.concat(Array.from({ length: Math.ceil(size / 32) }, (_, k) => createHash('sha256').update(`${size}/${i}/${k}`).digest())).subarray(0, size)
    for (const size of [16, 32, 48, 64, 128, 256]) {
      for (let i = 0; i < (size > 64 ? 1_000 : 20_000); i++) {
        expect(placeholderWhy(stream(size, i).toString('base64url'), 'b62'), `${size}/${i}`).not.toBe('text')
      }
    }
    // hex is read as hex, never as base64: these 32 digits, read as base64, are 24 printable bytes
    const hex = ['a0d1', 'b1c3', 'c2d9', 'd3de', 'e0d4', 'a2c5', 'b3dc', 'c0d6'].join('')
    expect(Buffer.from(hex, 'base64').every((x) => x >= 0x20 && x <= 0x7e)).toBe(true)
    expect(placeholderWhy(hex, 'hex')).toBeNull()
    // (and in a base62 slot, read as base64, it is 24 random printable characters: not a phrase either)
    expect(placeholderWhy(hex, 'b62')).toBeNull()
  })

  it('takes an oct key whose k is a secret kept as text (hex, base64, alphanumerics, a UUID), and leaves one that is a phrase a person typed', () => {
    // `openssl rand -hex 32`, `openssl rand -base64 32`, a generated password or a UUID, base64url-encoded into k (how an existing text secret is
    // put into an HS256 JWK for jose, Istio or Envoy): real HMAC keys, as random as bytes. Only text a person types is a placeholder: a sentence, a
    // word that names a secret, a slug of words, a repeat or a sequence. (A fixed stream of bytes, so what this asserts of a statistic is the same every run.)
    const stream = (tag: string, i: number, size: number): Buffer => Buffer.concat(Array.from({ length: Math.ceil(size / 32) }, (_, k) => createHash('sha256').update(`${tag}/${i}/${k}`).digest())).subarray(0, size)
    const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const pick = (alphabet: string, tag: string, i: number, n: number): string => {
      const b = stream(tag, i, n * 2)
      return Array.from({ length: n }, (_, j) => alphabet[b.readUInt16BE(j * 2) % alphabet.length]).join('')
    }
    const uuid = (tag: string, i: number): string => {
      const h = stream(tag, i, 16).toString('hex')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
    }
    const kinds: Record<string, (i: number) => string> = {
      'hex, 64 digits': (i) => stream('hex64', i, 32).toString('hex'),
      'hex, 32 digits': (i) => stream('hex32', i, 16).toString('hex'),
      'hex, upper case': (i) => stream('HEX64', i, 32).toString('hex').toUpperCase(),
      'base64 text, 44 characters': (i) => stream('b64', i, 32).toString('base64'),
      'base64url text, 43 characters': (i) => stream('b64u', i, 32).toString('base64url'),
      'alphanumerics, 32': (i) => pick(ALNUM, 'al32', i, 32),
      'alphanumerics, 16': (i) => pick(ALNUM, 'al16', i, 16),
      'lower case and digits, 32': (i) => pick('abcdefghijklmnopqrstuvwxyz0123456789', 'ld32', i, 32),
      'lower case letters, 48': (i) => pick('abcdefghijklmnopqrstuvwxyz', 'lc48', i, 48),
      'alphanumerics and symbols, 20': (i) => pick(ALNUM + '!@#$%^&*()-_=+[]{};:,.?', 'sy20', i, 20),
      'a UUID': (i) => uuid('uuid', i),
      'two UUIDs': (i) => uuid('uuidA', i) + uuid('uuidB', i),
      'hex with the line feed echo adds': (i) => stream('hexnl', i, 32).toString('hex') + '\n',
    }
    for (const [label, make] of Object.entries(kinds)) {
      for (let i = 0; i < 30; i++) {
        // (k is base64url, RFC 7517's: a `/` or `+` of standard base64 ends the member's value, whatever it holds)
        const k = Buffer.from(make(i)).toString('base64url')
        const text = JSON.stringify({ kty: 'oct', k, alg: 'HS256', kid: 'test' })
        const r = screenKeys(text)
        expect(r.removed, `${label}/${i}`).toEqual({ jwk_private_key: 1 })
        expect(r.text.includes(k.slice(0, 12)), `${label}/${i}`).toBe(false)
        expect(JSON.parse(r.text.replace('[REDACTED:jwk_private_key]', 'x')).kid, label).toBe('test')
        for (const enc of ['base64url', 'base64'] as const) expect(placeholderWhy(Buffer.from(make(i)).toString(enc), 'b62'), `${label}/${i}/${enc}`).toBeNull()
      }
    }
    // what a person types for a test secret stays: flagged, byte for byte. (Not these two, which are no sentence, word or slug, and are
    // taken for keys: a leetspeak phrase, `Th1sIsAT3stK3yF0rUn1tT3sts`, and a phrase repeated with another ending, `MyP@ssw0rdMyP@ssw0rd1234`.)
    const phrases = [
      'my-super-secret-key', 'super-secret-key-for-testing', 'this-is-a-test-secret-key', 'mysecretkey1234567890', 'change-me-in-production-please',
      'supersecretsupersecretsupersecret', 'jwt-signing-secret-for-tests', 'a-string-secret-at-least-256-bits-long', 'your-256-bit-secret-your-256-bit-secret',
      'test_secret_key_do_not_use_in_prod', 'development-only-signing-key', 'HS256 test key material 01', 'The quick brown fox jumps over',
      'correct horse battery staple', 'hello world hello world hello world', '0123456789abcdef0123456789abcdef', 'password1234567890', 'secretsecretsecretsecret',
      'secret-key-for-unit-tests-only-1234', 'abcdefghijklmnopqrstuvwxyz012345', 'ThisIsMySecretKey1234567890', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a-string-secret-at-least-256-bits-long\n',
      // (a word that names a secret and nothing else that tells a phrase: no space, no dashes, no repeat or run)
      'mySuperSecretKey!2026', 'MyDummyHmacKey#9', 'PasswordForTheDemoServer',
      // (a name of three words with two capitals among 41 letters is prose by its capitals, and still a phrase for what it decodes to: wordy)
      'hynixfirmwaretoolsandmorenotesLinuxSystems',
    ]
    for (const phrase of phrases) {
      const text = JSON.stringify({ kty: 'oct', k: Buffer.from(phrase).toString('base64url'), alg: 'HS256' })
      const r = screenKeys(text)
      expect(r.text, JSON.stringify(phrase)).toBe(text)
      expect(r.removed, JSON.stringify(phrase)).toEqual({})
      for (const enc of ['base64url', 'base64'] as const) expect(placeholderWhy(Buffer.from(phrase).toString(enc), 'b62'), JSON.stringify(phrase)).not.toBeNull()
    }
  })

  it('leaves an RSAKeyValue whose members are a sentence, the XML reader reading across its spaces; a value is prose when it has next to no capital letters among 40 letters or more', () => {
    // `<D>Lorem ipsum dolor sit amet ...</D>`: the value is the text up to the next tag with its blanks taken out, and no check named it
    // (the case check wanted no capital at all). A random value holds a capital in two of five characters: one in 16 letters is out of reach.
    const modulus = randomBytes(256).toString('base64')
    const xml = (d: string, p: string): string => `<RSAKeyValue><Modulus>${modulus}</Modulus><Exponent>AQAB</Exponent><P>${p}</P><Q>${p}</Q><D>${d}</D></RSAKeyValue>`
    const sentences = [
      'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore',
      'The quick brown fox jumps over the lazy dog and then runs back across the field to the barn behind the house',
      'Four score and seven years ago our fathers brought forth on this continent a new nation conceived in liberty',
      'This value is filled in by the installer when the service is first started and is not meant to be edited by hand',
      'Call me Ishmael some years ago never mind how long precisely having little or no money in my purse',
    ]
    for (const sentence of sentences) {
      for (const [form, value] of [['spaces', sentence], ['no spaces', sentence.replace(/ /g, '')], ['wrapped', sentence.replace(/ /g, '\n    ')]]) {
        const text = xml(value, value.slice(0, 50))
        const r = screenKeys(text)
        expect(r.text, `${sentence.slice(0, 20)}/${form}`).toBe(text)
        expect(r.removed, `${sentence.slice(0, 20)}/${form}`).toEqual({})
      }
    }
    // the rule's edges: 40 letters with one capital, or two (40/16 = 2.5); not three, not 39 letters, not a hex string
    const lower = (n: number, label: string): string => Array.from(createHash('sha256').update(label).digest().subarray(0, n), (b) => String.fromCharCode(97 + (b % 26))).join('')
    const withCaps = (letters: string, at: number[]): string => Array.from(letters, (c, i) => (at.includes(i) ? c.toUpperCase() : c)).join('')
    const forty = lower(32, 'prose/a') + lower(8, 'prose/b')
    expect(placeholderWhy(withCaps(forty, [0]), 'b62')).toBe('prose')
    expect(placeholderWhy(withCaps(forty, [0, 20]), 'b62')).toBe('prose')
    expect(placeholderWhy(withCaps(forty, [10, 11, 12]), 'b62')).toBeNull() // (together: three spread apart read as three words, which wordy names)
    expect(placeholderWhy(withCaps(forty, [10, 11, 12]) + '70394816259203', 'b62')).toBeNull() // (digits are not letters: 3 capitals among 40, not 54)
    expect(placeholderWhy(withCaps(forty, [0, 13, 27]), 'b62')).toBe('wordy')
    expect(placeholderWhy(withCaps(forty.slice(0, 39), [0]), 'b62')).toBeNull()
    const hex128 = createHash('sha512').update('prose/hex').digest('hex')
    expect(hex128.replace(/[^a-f]/g, '').length).toBeGreaterThanOrEqual(40) // (letters enough to be prose, if hex were not the key's)
    expect(placeholderWhy(hex128, 'b62')).toBeNull() // (hex in a base62 slot is the key's, as one-case has it)
    expect(placeholderWhy(hex128, 'hex')).toBeNull()
    // a random value of the sizes a key's members have is never prose (a fixed stream, so the same every run): 3,000 of each, none. (Looser by
    // a factor of 8 -- a capital in one letter of two -- this would name one in two of them.)
    const stream = (size: number, i: number): Buffer => Buffer.concat(Array.from({ length: Math.ceil(size / 32) }, (_, k) => createHash('sha256').update(`prose/${size}/${i}/${k}`).digest())).subarray(0, size)
    for (const size of [32, 48, 64, 128]) {
      for (let i = 0; i < 3_000; i++) expect(placeholderWhy(stream(size, i).toString('base64url'), 'b62'), `${size}/${i}`).not.toBe('prose')
    }
  })

  it('leaves a JWK or an RSAKeyValue whose private member is a phrase byte for byte, and takes the random ones', () => {
    const phrase = (s: string): string => Buffer.from(s).toString('base64url')
    const text = JSON.stringify({ kty: 'oct', k: phrase('my-super-secret-key-for-tests') })
    expect(screenKeys(text).text).toBe(text)
    expect(screenKeys(text).removed).toEqual({})
    const rsa = `<RSAKeyValue><Modulus>${randomBytes(128).toString('base64')}</Modulus><Exponent>AQAB</Exponent><P>${Buffer.from('lorem ipsum dolor sit amet, consectetur adipiscing elit').toString('base64')}</P><Q>${Buffer.from('sed do eiusmod tempor incididunt ut labore et dolore magna').toString('base64')}</Q></RSAKeyValue>`
    expect(screenKeys(rsa).text).toBe(rsa)
    expect(screenKeys(rsa).removed).toEqual({})
    // an oct key of 16 bytes (the least; bytes from a hash, so it is the same every run) is removed, its object left parseable
    const real = JSON.stringify({ kty: 'oct', k: createHash('sha256').update('an oct key of 16 bytes').digest().subarray(0, 16).toString('base64url') })
    const r = screenKeys(real)
    expect(r.removed).toEqual({ jwk_private_key: 1 })
    expect(JSON.parse(r.text.replace('[REDACTED:jwk_private_key]', 'x')).kty).toBe('oct')
  })
})

describe('T1 K1/K5/K6: a key file behind a NAME= on every line, and a PuTTY file in a listing with a long path', () => {
  it('takes a base64-encoded key file written NAME=<line> per line, for every kind of name', () => {
    // `KEY=<76 characters>` on each line: the name and its = are not part of the value, on the first line or any other
    // (the first line's frame, measured from where the value starts, is the name's and equal to the next line's)
    const lines = wrap(K.k8s.plain, 76)
    expect(lines.length).toBeGreaterThan(3)
    for (const name of ['KEY', 'TLS_KEY', 'tls.key', 'MESSAGE', 'data', 'k']) {
      const r = screenKeys(`Answer follows.\n${lines.map((l) => `${name}=${l}`).join('\n')}\nThat was the file.`)
      expect(r.removed, name).toEqual({ private_key_b64: 1 })
      expect(leakedWindows(r.text, lines.slice(0, -1)), name).toBe(0)
      expect(r.text.startsWith('Answer follows.') && r.text.endsWith('That was the file.'), name).toBe(true)
    }
  })

  it('takes a PuTTY key behind a NAME= on every line and in a listing whose path has a long piece, with its MAC line and without', () => {
    const ppk = K.ppk
    const secret = secretLinesOf(ppk, true)
    expect(secret.length).toBeGreaterThan(3)
    const long = 'src/main/resources/keys/production/deployment_signing_key_for_the_release_pipeline_2026_q4'
    const slashes = 'src/main/resources/keys/production/deployment/signing/keys/release/pipeline/q4'
    expect(slashes.length).toBeGreaterThan(75)
    const writers: Record<string, (ls: string[]) => string> = {
      'MESSAGE= on each line': (ls) => ls.map((l) => `MESSAGE=${l}`).join('\n'),
      'TLSKEY= on each line': (ls) => ls.map((l) => `TLSKEY=${l}`).join('\n'),
      'a long path, rg -n': (ls) => ls.map((l, i) => `${long}/deploy.ppk:${i + 1}:${l}`).join('\n'),
      'a long path, rg -C': (ls) => ls.map((l, i) => `${long}/deploy.ppk${i === 0 ? ':' : '-'}${i + 1}${i === 0 ? ':' : '-'}${l}`).join('\n'),
      'a long path, grep with no line numbers': (ls) => ls.map((l) => `${long}/deploy.ppk:${l}`).join('\n'),
      // (a piece of the path that is all letters and slashes runs on to the file's name: 57 and 80 characters in front of `.ppk:`)
      'a path of 64 characters of slashes and letters, a space after the colon': (ls) => ls.map((l) => `${slashes.slice(0, 57)}/deploy.ppk: ${l}`).join('\n'),
      'a path of 87 characters of slashes and letters, a space after the colon': (ls) => ls.map((l) => `${slashes}/deploy.ppk: ${l}`).join('\n'),
    }
    for (const [name, write] of Object.entries(writers)) {
      for (const withMac of [true, false]) {
        const ls = withMac ? ppk : ppk.filter((l) => !l.startsWith('Private-MAC'))
        const r = screenKeys(`Answer follows.\n${write(ls)}\nThat was the file.`)
        expect(leakedWindows(r.text, secret), `${name}/${withMac ? 'MAC' : 'no MAC'}`).toBe(0)
        expect(r.removed, `${name}/${withMac ? 'MAC' : 'no MAC'}`).toEqual({ putty_private_key: 1 })
      }
    }
  })
})

describe('T1 thresholds: the sizes that tell a key from an excerpt', () => {
  // The first line of a PKCS#8, OpenSSH or OpenPGP key says what it is, and what is shown of the rest decides: 80 characters in two lines
  // are an excerpt of a real key, a key cut short needs 128, and an OpenSSH or OpenPGP blob has no length of its own.
  // The keys here are made of a fixed stream of bytes, the same every run: how much of a short excerpt looks random depends on the key
  // (a real RSA-2048 key's first 80 characters, 51 of them its fixed header, fail the randomness test 3.4 times in 100), so a random
  // key would make an assertion about the 80 and the 128 a matter of luck.
  const stream = (label: string, size: number): Buffer => Buffer.concat(Array.from({ length: Math.ceil(size / 32) }, (_, k) => createHash('sha256').update(`${label}/${k}`).digest())).subarray(0, size)
  const dint = (b: Buffer): Buffer => der(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b)
  /** A PKCS#8 RSA-2048 key laid out as OpenSSL writes one. */
  const steadyP8 = (label: string): string[] => {
    const s = stream(label, 1400)
    const inner = der(0x30, Buffer.concat([dint(Buffer.from([0])), dint(s.subarray(0, 256)), dint(Buffer.from([1, 0, 1])), dint(s.subarray(256, 512)), dint(s.subarray(512, 640)), dint(s.subarray(640, 768)), dint(s.subarray(768, 896)), dint(s.subarray(896, 1024)), dint(s.subarray(1024, 1152))]))
    const key = der(0x30, Buffer.concat([der(0x02, Buffer.from([0])), der(0x30, Buffer.concat([der(0x06, Buffer.from('2a864886f70d010101', 'hex')), der(0x05, Buffer.alloc(0))])), der(0x04, inner)]))
    return ['-----BEGIN PRIVATE KEY-----', ...wrap(key.toString('base64')), '-----END PRIVATE KEY-----']
  }
  /** An armored OpenPGP RSA secret-key packet (old format, tag 5): version 4, a fixed time, the modulus and the secret MPIs. */
  const steadyPgp = (label: string): string[] => {
    const s = stream(label, 600)
    const mpi = (b: Buffer): Buffer => Buffer.concat([Buffer.from([(((b.length - 1) * 8 + (32 - Math.clz32(b[0]))) >> 8) & 255, ((b.length - 1) * 8 + (32 - Math.clz32(b[0]))) & 255]), b])
    const body = Buffer.concat([Buffer.from([4, 0x63, 0, 0, 0, 1]), mpi(Buffer.concat([Buffer.from([0xc3]), s.subarray(0, 255)])), mpi(Buffer.from([1, 0, 1])), Buffer.from([0]), mpi(Buffer.concat([Buffer.from([0x9b]), s.subarray(255, 510)]))])
    return armor(Buffer.concat([Buffer.from([0x95, body.length >> 8, body.length & 255]), body]), [])
  }
  /** The characters of a key's body (its BEGIN and END lines, headers and checksum left out). */
  const bodyOf = (ls: string[]): string => ls.filter((l) => /^[A-Za-z0-9+/]{16,}$/.test(l)).join('')
  /** A BEGIN line, a key's first `n` characters in a first line of `first` and the rest in a second, then (with `end`) an elision and the END line. */
  const excerpt = (ls: string[], n: number, first: number, end: boolean): string => {
    const body = bodyOf(ls)
    return [ls[0], body.slice(0, first), body.slice(first, n), ...(end ? ['...', ls[ls.length - 1]] : [])].join('\n')
  }
  const whyOf = (text: string): Array<[string, string]> => keyBlocks(text).map((b) => [b.cls, b.why])
  const p8 = steadyP8('threshold/pkcs8')
  const pgp = steadyPgp('threshold/pgp')

  it('the fixed keys are what they are said to be: structures the detector verifies, and excerpts of 80, 127 and 128 characters that look random', () => {
    expect(structureOf(Buffer.from(bodyOf(p8), 'base64'))).toMatchObject({ type: 'pkcs8' })
    expect(structureOf(Buffer.from(bodyOf(pgp), 'base64'))).toMatchObject({ type: 'pgp' }) // (the packet's own header is the base64 text's first characters)
    for (const n of [80, 127, 128]) {
      expect(looksRandom(bodyOf(p8).slice(0, n)), `pkcs8 ${n}`).toBe(true)
      expect(looksRandom(bodyOf(pgp).slice(0, n)), `pgp ${n}`).toBe(true)
    }
  })

  it('a verified DER header over two lines: 80 characters are an excerpt of a real key and 79 are not', () => {
    // (the second line is 16 characters in both, the least a line can be: only the total differs)
    expect(whyOf(excerpt(p8, 80, 64, true))).toEqual([['remove', 'pkcs8-incomplete']])
    expect(whyOf(excerpt(p8, 79, 63, true))).toEqual([['flag', 'pkcs8-example']])
  })

  it('a verified DER header cut short before its END line: 128 characters are a key cut short, 127 an excerpt of one', () => {
    expect(whyOf(excerpt(p8, 128, 64, false))).toEqual([['remove', 'pkcs8-prefix']])
    expect(whyOf(excerpt(p8, 127, 64, false))).toEqual([['remove', 'pkcs8-incomplete']])
  })

  it('an OpenSSH or OpenPGP blob has no length of its own: 128 characters are the key; an OpenPGP excerpt is 80 to 127 characters in two lines, and 79 is an example', () => {
    expect(whyOf(excerpt(K.F.openssh, 128, 64, false))).toEqual([['remove', 'openssh']])
    expect(whyOf(excerpt(pgp, 128, 64, false))).toEqual([['remove', 'pgp']])
    // (below 128 the excerpt must look random, which an OpenSSH header's own runs of A -- the key count, the empty KDF options -- do not)
    expect(whyOf(excerpt(pgp, 127, 64, false))).toEqual([['remove', 'pgp-short']])
    expect(whyOf(excerpt(pgp, 80, 64, false))).toEqual([['remove', 'pgp-short']])
    expect(whyOf(excerpt(pgp, 79, 63, false))).toEqual([['flag', 'pgp-example']])
    expect(whyOf(excerpt(K.F.openssh, 127, 64, false))).toEqual([['flag', 'openssh-example']])
  })

  it('a block longer than 1 MB is removed whole (MAX_BLOCK is 4 MB)', () => {
    // a PGP key's first body line, then 1.1 MB of base64: the packet header verifies the block, and every line of it goes
    const first = bodyOf(pgp).slice(0, 64)
    const text = ['Answer follows.', pgp[0], first, ...wrap(randomBytes(1_100_000).toString('base64'), first.length), '=ab12', pgp[pgp.length - 1], 'That was the file.'].join('\n')
    expect(text.length).toBeGreaterThan(1_400_000)
    const r = screenKeys(text)
    expect(r.removed).toEqual({ gpg_block: 1 })
    expect(r.text).toBe('Answer follows.\n[REDACTED:gpg_block]\nThat was the file.')
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

  it('reaches each opener as far as it should and no further: just inside its reach is found, just outside is not (the cost of a screen is bounded by these)', () => {
    // An answer is uncapped (a job's stdout is read whole), and what the screen reads is bounded by where it looks for an opener. Take the
    // floor off one and the whole answer from the far opener on is read; shorten it and a key longer than that is read from the middle.
    // [what the opener is, where its needle starts in it, its reach, how far before the needle the screen starts reading]
    const openers: Array<[string, string, number, number]> = [
      ['-----BEGIN PRIVATE KEY----- is how it starts', 'PRIVATE KEY', 262_144, 64],
      ['-----BEGIN OpenVPN Static key V1-----', 'OpenVPN Static key', 16_384, 16],
      ['Private-Lines: 9999', 'Private-Lines:', 65_536, 16_384],
      ['{"kty":"oct"}', 'kty', 8_192, 4_096],
      ['<RSAKeyValue>', 'RSAKeyValue', 16_384, 0],
    ]
    const lookback = 100
    for (const [opener, needle, reach, margin] of openers) {
      for (const [label, distance, found] of [['inside', reach - 150, true], ['outside', reach + 150, false]] as Array<[string, number, boolean]>) {
        // 70,000 dots in front (so no start is clamped to 0), the opener, dots, and a line of base64 the cut falls in, `distance` after the needle
        const pre = '.'.repeat(70_000)
        const at = pre.length + opener.indexOf(needle)
        const line = randomBytes(90).toString('base64').replace(/kty/g, 'kTy')
        const filler = '.'.repeat(opener.indexOf(needle) + distance - 21 - opener.length)
        const text = `${pre}${opener}${filler}\n${line}\n${'.'.repeat(5_000)}`
        const from = at + distance
        expect(text[from - 21] === '\n' && /^[A-Za-z0-9+/=]{40}/.test(text.slice(from - 20)), `${needle}/${label}: the cut falls 20 characters into the line`).toBe(true)
        const start = detectorStart(text, from, lookback)
        if (found) expect(start, `${needle}/${label}`).toBe(at - margin)
        else expect(start, `${needle}/${label}`).toBe(from - lookback)
      }
    }
    // a base64 run the cut falls in is followed back to its start, or 64 KB and no further
    const longRun = wrap(randomBytes(180_000).toString('base64'), 76).join('\n')
    const longText = `${'.'.repeat(1_000)}\n${longRun}\n${'.'.repeat(1_000)}`
    const longFrom = 1_001 + 150_000
    expect(detectorStart(longText, longFrom, 16)).toBe(longFrom - 65_536)
    const shortText = `${'.'.repeat(1_000)}\n${wrap(randomBytes(30_000).toString('base64'), 76).join('\n')}\n${'.'.repeat(1_000)}`
    expect(detectorStart(shortText, 1_001 + 20_000, 16)).toBe(1_000)
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
      expect(bestOf3(() => rsaKeyValues(open)), JSON.stringify(ws)).toBeLessThan(within(50))
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
      expect(bestOf3(() => keySpans(line)), unit).toBeLessThan(within(1_000))
      // a line break every few markers was always fast: the result is the same as with none
      expect(keyBlocks(line).length).toBe(Math.ceil(160_000 / unit.length))
    }
  })

  it.each(Object.keys(COST_SHAPES))('%s is screened in step with its length', (shape) => {
    const [text, opts, bound] = COST_SHAPES[shape]
    expect(bestOf3(() => screenKeys(text, opts), within(bound) * 4), shape).toBeLessThan(within(bound))
  })

  it('PuTTY: an anchor that starts where a search found nothing goes on from where that search ended, after a written-out line feed that began before its window did', () => {
    // Two anchors stacked, 21,838 short words (frame), then a written-out line feed that begins 3 characters before the first search's
    // 65,536th character and ends after it, and then the private lines. The second anchor starts where the first stopped and goes on
    // from the end of the line feed (as its own search would reach it): from the window's end, inside the line feed, the last three
    // characters of it would glue onto the first private line and make it 71 long, a key written with no line breaks.
    const word = (n: number): string => randomBytes(Math.ceil(n * 0.75) + 3).toString('base64').replace(/[+/=]/g, 'a').slice(0, n)
    const private3 = [word(68), word(64), word(64)]
    const text = 'Private-Lines: 3\nPrivate-Lines: 3\n' + 'ab\n'.repeat(21_838) + '\n' + '\\' + 'u000a' + private3.join('\n') + '\n'
    expect(text.indexOf('\\' + 'u000a')).toBe(16 + 65_536 - 3)
    const spans = puttyKeys(text)
    expect(spans.map((s) => [s.cls, s.why])).toEqual([
      ['flag', 'ppk 0/3'],
      ['remove', 'ppk 3/3'],
    ])
    expect(text.slice(spans[1].from, spans[1].to)).toContain(private3[2])
  })
})

describe('the linear replacements of three regexes and a prose test give what those gave', () => {
  // The regexes as they were (LINE_END_RUN with the dot of a PHP `" .` since), each cubic or quadratic in a
  // run of plus signs or letters: the oracle.
  const PARTIAL_OLD = /^…?([^\r\n]*?)([A-Za-z0-9+/=]*)((?:\\+(?:[nr]|u000[aAdD]|x0[aAdD])|%0[aAdD]|&#(?:x0?[aAdD]|1[03]);|<br\s*\/?>|`[nr]|[ \t"'`,;+.&_$)\]}|])*\\?(?:\r\n|\r|\n)?)$/
  const SHORT_OLD = /([A-Za-z0-9+/]{1,7}={0,2})[\s"'`,;+&_)\]}|\\$]*$/
  const LINE_END_OLD = /[A-Za-z0-9+/=]+[\s"'`,;+&_.)\]}|\\]*$/
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
    expect(differ((visit) => everyString(['a', '=', '+', ' ', '"', BS, '.', '/'], 6, visit), got, want)).toEqual([])
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

describe('the linear replacements of the word-pair test and of the joiner strips give what the regexes gave', () => {
  // The regexes as they were, each quadratic in a long run of letters or joiners before a character that ends neither: the oracle.
  const WORDS_OLD = /[A-Za-z]{3,}[ \t]+[A-Za-z]{3,}/
  const WORDS_SPACE_OLD = /[A-Za-z]{3,}\s+[A-Za-z]{3,}/
  const NL_OLD = /[\s"'`,;+&_]+$/
  const HEAD_OLD = /[\s"'`,;+.&_\\$]+$/
  const BLANKS_OLD = /\s+$/
  const DEK_OLD = /^\s*(?:(?:[A-Za-z-]*: ?)?(?:[A-Z0-9-]*,)?[0-9A-Fa-f]{1,32})?[\s"'`,;+.&_)\]}|\\$]*$/

  let seed = 20261101
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
  const random = (alphabet: readonly string[], count: number, fn: (s: string) => void): void => {
    for (let i = 0; i < count; i++) fn(Array.from({ length: Math.floor(rnd() * 18) }, () => pick(alphabet)).join(''))
  }

  it('hasWords finds what /[A-Za-z]{3,}[ \\t]+[A-Za-z]{3,}/ finds, and with anySpace what the same with \\s+ finds', () => {
    const bad: string[] = []
    const check = (s: string): void => {
      if (hasWords(s) !== WORDS_OLD.test(s)) bad.push(`blanks ${JSON.stringify(s)}`)
      if (hasWords(s, true) !== WORDS_SPACE_OLD.test(s)) bad.push(`space ${JSON.stringify(s)}`)
    }
    // (letters in runs of one to four, a blank, a tab, a line break, other characters, and the whitespace \s has beyond ASCII's)
    const n = everyString(['a', 'Bc', 'dEf', ' ', '\t', '\n', '1', '-'], 6, check)
    random(['abc', 'Q', 'x', ' ', '  ', '\t', '\n', '\u00a0', '\u2003', '\u2028', '\ufeff', '\u180e', '1', '-', '=', 'word', 'AB'], 40_000, check)
    expect(n).toBe(299_593)
    expect(bad.slice(0, 5)).toEqual([])
    // the cases it exists for: one long run of letters (it took the regex 2 s at 40,000), then words
    expect(hasWords('Aa'.repeat(60_000) + 'x')).toBe(false)
    expect(hasWords('Aa'.repeat(60_000) + ' bcd')).toBe(true)
    expect(hasWords('ab cd')).toBe(false)
    expect(hasWords('abc  \t def')).toBe(true)
    expect(hasWords('abc\ndef')).toBe(false)
    expect(hasWords('abc\ndef', true)).toBe(true)
  })

  it('the joiner strips take the same trailing run as the regexes they replace', () => {
    const bad: string[] = []
    const check = (s: string): void => {
      for (const [name, got, want] of [
        ['nl', TRAILING_NL_JOINERS, NL_OLD],
        ['head', TRAILING_HEAD_JOINERS, HEAD_OLD],
        ['blanks', TRAILING_BLANKS, BLANKS_OLD],
      ] as const) {
        if (s.replace(got, '') !== s.replace(want, '')) bad.push(`${name} ${JSON.stringify(s)}`)
      }
    }
    everyString(['a', ' ', '"', '+', '.', '$', BS, '_', '\n', '&'], 6, check)
    random(['a', 'Q9', ' ', '\t', '\n', '"', "'", '`', ',', ';', '+', '.', '&', '_', '$', BS, '=', '/'], 40_000, check)
    expect(bad.slice(0, 5)).toEqual([])
    // a long run of joiners before a character that is none: the case they exist for
    expect('"'.repeat(80_000) + 'x').toBe(('"'.repeat(80_000) + 'x').replace(TRAILING_NL_JOINERS, ''))
    expect(('x' + ' '.repeat(80_000)).replace(TRAILING_BLANKS, '')).toBe('x')
  })

  it('ESC_ALL_RE replaces the written-out line breaks that its pattern without the lookbehind replaced, and TRAILING_LINE_BREAKS the line feeds at the end that /[\\r\\n]+$/ took', () => {
    const ESC_OLD = /\\+(?:[nr]|u000[aAdD]|x0[aAdD])|%0[aAdD]|&#(?:x0?[aAdD]|1[03]);|<br\s*\/?>|`[nr]/g
    const BREAKS_OLD = /[\r\n]+$/
    const bad: string[] = []
    const check = (s: string): void => {
      if (s.replace(ESC_ALL_RE, '\u0001') !== s.replace(ESC_OLD, '\u0001')) bad.push(`esc ${JSON.stringify(s)}`)
      if (s.replace(TRAILING_LINE_BREAKS, '') !== s.replace(BREAKS_OLD, '')) bad.push(`breaks ${JSON.stringify(s)}`)
    }
    // (runs of backslashes before and inside every escape, and the characters an escape is made of: a backslash run is where they differ in cost)
    everyString([BS, 'n', 'r', 'u', 'x', '0', 'a', '\n'], 6, check)
    random([BS, BS + BS, BS + 'n', BS + 'r', BS + 'u000a', BS + 'u000D', BS + 'x0a', BS + 'x0D', '%0A', '%0d', '&#xA;', '&#x0d;', '&#10;', '&#13;', '<br>', '<br/>', '<br />', '`n', '`r', 'a', 'n', 'u', '0', ' ', '\n', '\r', '\r\n'], 60_000, check)
    expect(bad.slice(0, 5)).toEqual([])
    // the cases they exist for: a run of backslashes that no escape ends (it took the pattern 2 s at 40,000), and one that an escape ends
    expect(BS.repeat(60_000).replace(ESC_ALL_RE, ' ')).toBe(BS.repeat(60_000))
    expect(`ab${BS.repeat(60_000)}n`.replace(ESC_ALL_RE, ' ')).toBe('ab ')
    expect(`ab${BS.repeat(60_000)}cd${BS}n`.replace(ESC_ALL_RE, ' ')).toBe(`ab${BS.repeat(60_000)}cd `)
    expect(`x${'\n'.repeat(80_000)}y`.replace(TRAILING_LINE_BREAKS, '')).toBe(`x${'\n'.repeat(80_000)}y`)
    expect(`x${'\r\n'.repeat(80_000)}`.replace(TRAILING_LINE_BREAKS, '')).toBe('x')
    expect('\n\n\n'.replace(TRAILING_LINE_BREAKS, '')).toBe('')
  })

  it('DEK_REMNANT accepts what the regex with the leading \\s* outside its group accepted', () => {
    const bad: string[] = []
    const check = (s: string): void => {
      if (DEK_REMNANT.test(s) !== DEK_OLD.test(s)) bad.push(JSON.stringify(s))
    }
    everyString(['A', 'f', '0', ' ', '-', ':', ',', '"', '$', 'g'], 6, check)
    random(['DEK-Info: ', 'AES-128-CBC,', 'F0DF', 'ab', 'Z', ' ', '\t', '"', '+', '$', BS, ',', ':', '-', '0123456789ABCDEF0123456789ABCDEF', 'x'], 40_000, check)
    expect(bad.slice(0, 5)).toEqual([])
    expect(DEK_REMNANT.test('EK-Info: AES-128-CBC,F0DFE2B3C0A1D2E3F4A5B6C7D8E9F0A1"')).toBe(true)
    expect(DEK_REMNANT.test(' '.repeat(60_000) + 'x')).toBe(false)
  })
})

describe('T1 K1: a private key whose algorithm parameters are fixed text (an EC key with explicit curve parameters, a Diffie-Hellman key)', () => {
  // A standard curve's or group's public parameters are long runs of 00 and FF bytes (base64 `AAAA...` and `////...`). They failed the
  // run test of looksRandom over the whole body, so the key was verified by its structure and then only reported; main's private_key
  // rule removed it. (openssl ecparam -param_enc explicit, openssl genpkey -algorithm DH, a Java keystore export.)
  const pem = (key: crypto.KeyObject, type: 'sec1' | 'pkcs8'): string[] => (key.export({ type, format: 'pem' }) as string).trim().split('\n')
  const dh = (group: string): crypto.KeyObject => (generateKeyPairSync as unknown as (t: string, o: { group: string }) => { privateKey: crypto.KeyObject })('dh', { group }).privateKey
  const keys: Array<[string, string[]]> = []
  for (const curve of ['prime256v1', 'secp384r1', 'secp521r1', 'secp256k1']) {
    const key = generateKeyPairSync('ec', { namedCurve: curve, paramEncoding: 'explicit' }).privateKey
    keys.push([`EC ${curve} explicit, SEC1`, pem(key, 'sec1')], [`EC ${curve} explicit, PKCS#8`, pem(key, 'pkcs8')])
  }
  for (const group of ['modp2', 'modp14', 'modp18']) keys.push([`DH ${group}, PKCS#8`, pem(dh(group), 'pkcs8')])

  it('removes it whole, in four joinings, with its END line and without', () => {
    for (const [name, ls] of keys) {
      expect(keyBlocks(ls.join('\n')).map((b) => [b.cls, b.rule]), name).toEqual([['remove', 'private_key']])
      for (const jn of ['lf', 'json_n', 'cat_n', 'rg_win']) {
        for (const withEnd of [true, false]) {
          const label = `${name}/${jn}/${withEnd ? 'END' : 'no END'}`
          const r = screenKeys('Answer follows.\n' + JOIN[jn](withEnd ? ls : ls.slice(0, -1)) + '\nThat was the file.')
          expect(leakedWindows(r.text, secretLinesOf(ls)), label).toBe(0)
          expect(r.removed, label).toEqual({ private_key: 1 })
          expect(r.text.startsWith('Answer follows.') && r.text.endsWith('That was the file.'), label).toBe(true)
        }
      }
    }
  })

  it('judges a block of more than 4,096 characters by its first 4,096, as looksRandom does: the key and then more lines of its width', () => {
    // (an EC key's lines, then 84 more of random base64, then the rest: the parameters are in the first 4,096 and the block is long)
    const ls = keys.find(([name]) => name === 'EC prime256v1 explicit, SEC1')?.[1] as string[]
    const text = [ls[0], ...ls.slice(1, 4), ...wrap(randomBytes(4000).toString('base64'), 64), ...ls.slice(4)].join('\n')
    expect(text.length).toBeGreaterThan(4_096 + 500)
    expect(keyBlocks(text).map((b) => [b.cls, b.rule])).toEqual([['remove', 'private_key']])
    const r = screenKeys(text)
    expect(Object.keys(r.removed)).toEqual(['private_key']) // (twice: the block's short last line ends it, and its END line is taken as a tail)
    expect(leakedWindows(r.text, secretLinesOf(ls))).toBe(0)
  })

  it('still reports the same header over a body that is mostly one repeated character, or whose runs are no public parameters', () => {
    for (const [name, ls] of keys.filter(([n]) => n.includes('explicit'))) {
      // the key's own first three lines, then padding: a made-up excerpt
      const padded = [ls[0], ...ls.slice(1, 4), ...Array.from({ length: 10 }, () => 'A'.repeat(64)), ls[ls.length - 1]].join('\n')
      expect(keyBlocks(padded).map((b) => [b.cls, b.rule]), name).toEqual([['flag', 'private_key']])
      expect(screenKeys(padded).text, name).toBe(padded)
      expect(screenKeys(padded).removed, name).toEqual({})
      // a run of any other character is no public parameter: the key's own lines with two of them in the middle is a made-up body
      for (const filler of ['x', 'Q', '+', '5']) {
        const odd = [ls[0], ...ls.slice(1, 6), filler.repeat(64), filler.repeat(64), ...ls.slice(6)].join('\n')
        expect(screenKeys(odd).text, `${name}/${filler}`).toBe(odd)
        expect(screenKeys(odd).removed, `${name}/${filler}`).toEqual({})
      }
    }
  })

  it('still reports the same structures over a made-up private value (all zero, the number 1, all FF, a fill), and removes them over a real one', () => {
    // A famous test key is the number 1 (secp256k1's `0x00...01`), and the parameters of a real curve or group, which are public, fill most of
    // the body: the structure and the parameters are a key's, and the value that makes it one is not. (Judged on the private value the
    // structure locates.)
    const pemOf = (kind: string, buf: Buffer): string => [`-----BEGIN ${kind}-----`, ...wrap(buf.toString('base64')), `-----END ${kind}-----`].join('\n')
    /** A value a key does not have, `n` bytes of it. */
    const fakes = (n: number): Array<[string, Buffer]> => [
      ['all zero', Buffer.alloc(n, 0)],
      ['the number 1', Buffer.concat([Buffer.alloc(n - 1, 0), Buffer.from([1])])],
      ['all FF', Buffer.alloc(n, 0xff)],
      ['a 0x41 fill', Buffer.alloc(n, 0x41)],
    ]
    /** Where the body of the DER element at `at` starts and ends. */
    const tlvAt = (b: Buffer, at: number): { body: number; end: number } => {
      const l = b[at + 1]
      const n = l < 0x80 ? 0 : l & 0x7f
      const len = n === 0 ? l : b.readUIntBE(at + 2, n)
      return { body: at + 2 + n, end: at + 2 + n + len }
    }
    const patch = (b: Buffer, from: number, value: Buffer): Buffer => Buffer.concat([b.subarray(0, from), value, b.subarray(from + value.length)])
    const kept = (pem: string, label: string): void => {
      expect(keyBlocks(pem).map((x) => x.cls), label).toEqual(['flag'])
      expect(screenKeys(pem).text, label).toBe(pem)
      expect(screenKeys(pem).removed, label).toEqual({})
    }

    // named curves, built by hand around a real public key
    for (const [curve, oid, size] of [['prime256v1', '2a8648ce3d030107', 32], ['secp256k1', '2b8104000a', 32], ['secp384r1', '2b81040022', 48]] as Array<[string, string, number]>) {
      const pub = (generateKeyPairSync('ec', { namedCurve: curve }).publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-(size * 2 + 1))
      const point = der(0xa1, der(0x03, Buffer.concat([Buffer.from([0]), pub])))
      const sec1 = (value: Buffer): Buffer => der(0x30, Buffer.concat([der(0x02, Buffer.from([1])), der(0x04, value), der(0xa0, der(0x06, Buffer.from(oid, 'hex'))), point]))
      const alg = der(0x30, Buffer.concat([der(0x06, Buffer.from('2a8648ce3d0201', 'hex')), der(0x06, Buffer.from(oid, 'hex'))]))
      const p8 = (value: Buffer): Buffer => der(0x30, Buffer.concat([der(0x02, Buffer.from([0])), alg, der(0x04, der(0x30, Buffer.concat([der(0x02, Buffer.from([1])), der(0x04, value), point])))]))
      for (const [form, kind, make] of [['SEC1', 'EC PRIVATE KEY', sec1], ['PKCS#8', 'PRIVATE KEY', p8]] as Array<[string, string, (v: Buffer) => Buffer]>) {
        for (const [fake, value] of fakes(size)) kept(pemOf(kind, make(value)), `${curve} ${form}/${fake}`)
        expect(screenKeys(pemOf(kind, make(randomBytes(size)))).removed, `${curve} ${form}/real`).toEqual({ private_key: 1 })
      }
    }

    // explicit curve parameters: a real key's DER with its scalar replaced by a fake of the same length
    // (a P-384 key's PKCS#8 holds its scalar past the 512 characters that are decoded, where nothing tells a fake value from a real one: SEC1 only)
    for (const curve of ['prime256v1', 'secp384r1']) {
      const key = generateKeyPairSync('ec', { namedCurve: curve, paramEncoding: 'explicit' }).privateKey
      const s1 = key.export({ type: 'sec1', format: 'der' }) as Buffer
      const p8 = key.export({ type: 'pkcs8', format: 'der' }) as Buffer
      const sc = tlvAt(s1, tlvAt(s1, tlvAt(s1, 0).body).end) // SEQUENCE { INTEGER 1, OCTET STRING scalar, ... }
      const scalar = s1.subarray(sc.body, sc.end)
      const at8 = p8.indexOf(scalar)
      expect(at8, curve).toBeGreaterThan(0)
      for (const [fake, value] of fakes(scalar.length)) {
        kept(pemOf('EC PRIVATE KEY', patch(s1, sc.body, value)), `${curve} explicit SEC1/${fake}`)
        if (curve === 'prime256v1') kept(pemOf('PRIVATE KEY', patch(p8, at8, value)), `${curve} explicit PKCS#8/${fake}`)
      }
    }

    // a Diffie-Hellman group: the private value is the INTEGER inside the last OCTET STRING
    for (const group of ['modp2', 'modp14']) {
      const key = (generateKeyPairSync as unknown as (t: string, o: { group: string }) => { privateKey: crypto.KeyObject })('dh', { group }).privateKey
      const p8 = key.export({ type: 'pkcs8', format: 'der' }) as Buffer
      const outer = tlvAt(p8, 0)
      const octet = tlvAt(p8, tlvAt(p8, tlvAt(p8, outer.body).end).end) // SEQUENCE { INTEGER 0, SEQUENCE { OID, parameters }, OCTET STRING { INTEGER x } }
      const x = tlvAt(p8, octet.body)
      for (const [fake, value] of fakes(x.end - x.body)) kept(pemOf('PRIVATE KEY', patch(p8, x.body, value)), `${group}/${fake}`)
      // the same key with the X9.42 algorithm (dhpublicnumber, `openssl genpkey -algorithm DHX`) in place of PKCS #3's dhKeyAgreement
      const version = tlvAt(p8, outer.body)
      const alg = tlvAt(p8, version.end)
      const params = p8.subarray(tlvAt(p8, alg.body).end, alg.end)
      const x942 = (value: Buffer): Buffer =>
        der(0x30, Buffer.concat([p8.subarray(outer.body, version.end), der(0x30, Buffer.concat([der(0x06, Buffer.from('2a8648ce3e0201', 'hex')), params])), der(0x04, der(0x02, value))]))
      expect(screenKeys(pemOf('PRIVATE KEY', x942(p8.subarray(x.body, x.end)))).removed, `${group} X9.42`).toEqual({ private_key: 1 })
      for (const [fake, value] of fakes(x.end - x.body)) kept(pemOf('PRIVATE KEY', x942(value)), `${group} X9.42/${fake}`)
    }
  })
})

describe('T1 K1: a key in a grep or rg listing whose path holds a long run of base64 characters', () => {
  // `/keys/prod/private` in ./keys/prod/private_key.asc is 18 base64-alphabet characters (a slash is one), and an armored key's blank
  // line shows only its path: that piece was taken for the key's first line, narrower than the real ones, and the key was only reported.
  const paths = [
    './keys/prod/private_key.asc',
    '/etc/ssl/private/server-key.pem',
    '/home/dev/.gnupg/private-keys-v1.d/backup.asc',
    'src/main/resources/keys/prod/deploy_rsa_4096_2026.pem',
    'C:\\Users\\dev\\OneDriveCommercialDocuments\\keys\\id_rsa',
  ]
  // A space right after the long piece ends it as a run, and the rest of the path is not read as one (a payload followed by a space and a
  // timestamp must not be taken for a path). Likewise a path with no line number after it (`grep` without -n): the piece in front of a
  // payload (`private_key.asc:=NRbN`) is not told from one. In both the END line's piece sets a second frame, the tail rule takes the END
  // line, and the block counts twice. Nothing is left either way.
  const spaced = '/var/lib/jenkins/workspace/My Project/keys/release.asc'
  const twice = (mode: string, p: string): boolean => p === spaced || mode === 'grep, no -n' || mode === 'path: line'
  const modes: Record<string, (p: string, ls: string[]) => string> = {
    'rg -n': (p, ls) => ls.map((l, i) => `${p}:${i + 1}:${l}`).join('\n'),
    'rg -C': (p, ls) => ls.map((l, i) => `${p}${i === 0 ? ':' : '-'}${i + 1}${i === 0 ? ':' : '-'}${l}`).join('\n'),
    'grep -nb': (p, ls) => ls.map((l, i) => `${p}:${i + 1}:${i * 65}:${l}`).join('\n'),
    'grep, no -n': (p, ls) => ls.map((l) => `${p}:${l}`).join('\n'),
    'path: line': (p, ls) => ls.map((l) => `${p}: ${l}`).join('\n'),
    'a tag after each line': (p, ls) => ls.map((l, i) => `${p}:${i + 1}:${l}</li>`).join('\n'),
  }

  it('removes every format, with its END line and without, in six listings', () => {
    for (const format of FORMATS) {
      const [rule] = EXPECT[format]
      for (const [mode, write] of Object.entries(modes)) {
        for (const p of paths) {
          for (const withEnd of [true, false]) {
            const label = `${format}/${mode}/${p}/${withEnd ? 'END' : 'no END'}`
            const ls = withEnd ? K.F[format] : K.F[format].slice(0, -1)
            const r = screenKeys('Answer follows.\n' + write(p, ls) + '\nThat was the file.')
            expect(leakedWindows(r.text, secretLinesOf(K.F[format])), label).toBe(0)
            if (twice(mode, p)) expect(Object.keys(r.removed), label).toEqual([rule])
            else expect(r.removed, label).toEqual({ [rule]: 1 })
          }
        }
        // (without END: the blank armor line's piece is the one a space leaves. And with no tag after the lines: a short last line with
        // one after it is shorter than that piece, which is then taken for it)
        if (mode.includes('tag')) continue
        const ls = K.F[format].slice(0, -1)
        const r = screenKeys('Answer follows.\n' + write(spaced, ls) + '\nThat was the file.')
        expect(leakedWindows(r.text, secretLinesOf(K.F[format])), `${format}/${mode}/spaced`).toBe(0)
        expect(Object.keys(r.removed), `${format}/${mode}/spaced`).toEqual([rule])
      }
    }
  })

  it('takes the text after a key line for a path only when it is all the line holds: a payload followed by path-like characters, a colon, and more is still a payload', () => {
    // (96 path-like characters, a colon and 15 spaces make exactly the 112 the path test reads: a line that goes on past them is no listing's)
    const pathLike = '_.'.repeat(48) + ':' + ' '.repeat(15)
    for (const format of ['pkcs8_rsa', 'openssh', 'pgp_rsa_nohdr'] as Format[]) {
      for (const more of ['x', 'xx yy zz']) {
        const r = screenKeys(K.F[format].map((l, i) => (i === 0 || i === K.F[format].length - 1 || !/^[A-Za-z0-9+/=]{16,}$/.test(l) ? l : l + pathLike + more)).join('\n'))
        expect(leakedWindows(r.text, secretLinesOf(K.F[format])), format).toBe(0)
        expect(Object.keys(r.removed), format).toEqual([EXPECT[format][0]])
      }
    }
  })

  it('does not take the path in front of an END marker for the last line of a key of one line (an Ed25519 key, with grep and no line numbers)', () => {
    // The END line's `/etc/ssl/private/server` is a run of 23 characters when nothing but `-key.pem:` follows it, and was added to the
    // key's 64 as its last line: its letters tipped the randomness test of that short body about 1 key in 50. Each key is judged as the
    // same key written plainly is (a body that is a heuristic's edge case is one either way), and a hundred keys of that rate would show.
    const p = '/etc/ssl/private/server-key.pem'
    for (let i = 0; i < 300; i++) {
      const ls = (generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).trim().split('\n')
      const plain = Object.keys(screenKeys(ls.join('\n')).removed).length
      for (const write of [(l: string) => `${p}:${l}`, (l: string) => `${p}: ${l}`]) {
        const r = screenKeys(ls.map(write).join('\n'))
        expect(Object.keys(r.removed).length, ls[1]).toBe(plain)
        if (plain) expect(r.text.includes(ls[1].slice(0, 20)), ls[1]).toBe(false)
      }
    }
  })
})

describe('T1 K1: a key written one markdown inline-code span per line', () => {
  // A backtick followed by n or r is PowerShell's line break (`n, `r) after the text it ends, but an inline-code span opens with one in
  // front of a key line, and about half of the key lines start with n or r (base64 letters): the phantom line break shortened that line by
  // one character and ended the key. It counts only after a base64 character, a quote or a dash.
  const BT = '`'
  const layouts: Record<string, (ls: string[]) => string> = {
    'one span per line': (ls) => ls.map((l) => `${BT}${l}${BT}`).join('\n'),
    'spans with a trailing comma': (ls) => ls.map((l) => `${BT}${l}${BT},`).join('\n'),
    'a bullet list of spans': (ls) => ls.map((l) => `- ${BT}${l}${BT}`).join('\n'),
    'spans on one line': (ls) => ls.map((l) => `${BT}${l}${BT}`).join(' '),
    'spans joined by a comma': (ls) => ls.map((l) => `${BT}${l}${BT}`).join(','),
  }
  /** A key's lines with every body line after the first starting with n or r (the bytes in the middle of the key are not the key's, which
   *  its header, length and randomness do not tell; the first line holds the header that does). */
  const nr = (ls: string[]): string[] => {
    const first = ls.findIndex((l) => /^[A-Za-z0-9+/]{16,}$/.test(l))
    return ls.map((l, i) => (i > first && /^[A-Za-z0-9+/]{16,}$/.test(l) ? (i % 2 ? 'n' : 'r') + l.slice(1) : l))
  }

  it('removes every format, with its END line and without, whatever letter a line starts with', () => {
    for (const format of FORMATS) {
      const [rule] = EXPECT[format]
      // (an OpenVPN key's lines are hex: no n or r among them)
      for (const key of format === 'openvpn' ? [K.F[format]] : [K.F[format], nr(K.F[format])]) {
        for (const [name, write] of Object.entries(layouts)) {
          for (const withEnd of [true, false]) {
            const label = `${format}/${name}/${withEnd ? 'END' : 'no END'}/${key === K.F[format] ? 'as made' : 'n and r'}`
            const r = screenKeys('Answer follows.\n' + write(withEnd ? key : key.slice(0, -1)) + '\nThat was the file.')
            expect(leakedWindows(r.text, secretLinesOf(key)), label).toBe(0)
            expect(Object.keys(r.removed), label).toEqual([rule])
          }
        }
      }
    }
  })

  it('still reads PowerShell\'s escapes: after a base64 character, a quote and the dashes of a marker', () => {
    // `n and `r after a line's end, after the dashes of a BEGIN line, `r`n (the n follows an r), a blank line, and the escape right after an
    // opening quote (a string per line, joined with +)
    const shapes: Record<string, (ls: string[]) => string> = {
      'one string, `n': (ls) => '$key = "' + ls.join(BT + 'n') + '"',
      'one string, `r`n': (ls) => '$key = "' + ls.join(BT + 'r' + BT + 'n') + '"',
      'one string, a blank line': (ls) => '$key = "' + ls.join(BT + 'n' + BT + 'n') + '"',
      'a string per line, `n at its end': (ls) => '$key = ' + ls.map((l) => `"${l}${BT}n"`).join(' +\n    '),
      'a string per line, `n at its start': (ls) => '$key = ' + ls.map((l) => `"${BT}n${l}"`).join(' +\n    '),
      // (one escape only, in a key of real line breaks: a run that took the n for its first character would be a character wider than the rest)
      'the escape after the dashes of the BEGIN line only': (ls) => '$key = "' + ls[0] + BT + 'n' + ls.slice(1).join('\n') + '"',
      // (the newline as a string of its own between the lines: the escape follows a quote, and the lines' strings have joiners and an n between them)
      'a string for the newline': (ls) => '$key = ' + ls.map((l) => `"${l}"`).join(` + "${BT}n" + `),
      'a single-quoted string per line, "`n" between': (ls) => '$key = ' + ls.map((l) => `'${l}'`).join(` + "${BT}n" + `),
    }
    for (const format of ['pkcs8_rsa', 'openssh', 'pgp_rsa_hdr'] as Format[]) {
      const ls = nr(K.F[format])
      for (const [name, write] of Object.entries(shapes)) {
        const r = screenKeys(write(ls))
        expect(leakedWindows(r.text, secretLinesOf(ls)), `${format}/${name}`).toBe(0)
        expect(Object.keys(r.removed), `${format}/${name}`).toEqual([EXPECT[format][0]])
        // (read whole, as the key it is: an escape taken for part of a line would leave it a character wider, and the block cut short)
        expect(keyBlocks(write(ls)).map((b) => b.why), `${format}/${name}`).toEqual([EXPECT[format][1]])
      }
    }
  })
})

describe('T1 K7: a JWK with no braces around it (YAML, TOML, properties) is read whatever its size and the order of its members', () => {
  // An RSA-2048 JWK is 1.6 KB and an RSA-4096 one 3.2 KB: the private members past the 1 KB the reader used to look at stayed.
  type Jwk = Record<string, string>
  let rsa4096: Jwk
  let ec384: Jwk
  beforeAll(() => {
    rsa4096 = generateKeyPairSync('rsa', { modulusLength: 4096 }).privateKey.export({ format: 'jwk' }) as Jwk
    ec384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'jwk' }) as Jwk
  })
  const PRIV: Record<string, string[]> = { EC: ['d'], OKP: ['d'], RSA: ['d', 'p', 'q', 'dp', 'dq', 'qi'], oct: ['k'] }
  const order = (jwk: Jwk, how: string): string[] => {
    const keys = Object.keys(jwk)
    if (how === 'kty last') return [...keys.filter((k) => k !== 'kty'), 'kty']
    if (how === 'private first') return [...keys.filter((k) => PRIV[jwk.kty].includes(k)), ...keys.filter((k) => !PRIV[jwk.kty].includes(k))]
    return keys // (node's: kty first)
  }
  const writers: Record<string, (jwk: Jwk, how: string) => string> = {
    YAML: (j, how) => 'jwk:\n' + order(j, how).map((k) => `  ${k}: ${j[k]}`).join('\n') + '\n',
    'quoted YAML': (j, how) => 'jwk:\n' + order(j, how).map((k) => `  ${k}: "${j[k]}"`).join('\n') + '\n',
    TOML: (j, how) => '[jwk]\n' + order(j, how).map((k) => `${k} = "${j[k]}"`).join('\n') + '\n',
    properties: (j, how) => order(j, how).map((k) => `jwk.${k}=${j[k]}`).join('\n') + '\n',
    'YAML after empty flow mappings': (j, how) => 'metadata:\n  labels: {}\n  annotations: {}\nsigning:\n' + order(j, how).map((k) => `  ${k}: ${j[k]}`).join('\n') + '\n',
  }
  const gone = (text: string, j: Jwk, label: string): void => {
    for (const m of PRIV[j.kty]) expect(leakedWindows(text, [j[m]]), `${label} ${j.kty} ${m}`).toBe(0)
  }
  const kept = (text: string, j: Jwk, label: string): void => {
    const pub = j.kty === 'RSA' ? j.n : j.kty === 'oct' ? j.alg : j.x
    expect(text.includes(pub), `${label} public part kept`).toBe(true)
  }

  it('takes every private member of an RSA-2048 and an RSA-4096 JWK, one key counted once', () => {
    for (const [name, jwk] of [['RSA-2048', K.J.rsa as Jwk], ['RSA-4096', rsa4096]] as Array<[string, Jwk]>) {
      for (const [form, write] of Object.entries(writers)) {
        for (const how of ['kty first', 'kty last', 'private first']) {
          const label = `${name}/${form}/${how}`
          const r = screenKeys(write(jwk, how))
          gone(r.text, jwk, label)
          kept(r.text, jwk, label)
          expect(r.removed, label).toEqual({ jwk_private_key: 1 })
        }
      }
    }
  })

  it('takes the members of each key of a list that mixes types, whichever side of its kty they are', () => {
    const oct: Jwk = { kty: 'oct', k: randomBytes(32).toString('base64url'), alg: 'HS256' }
    const keys: Array<[string, Jwk[]]> = [
      ['EC then oct', [K.J.ec as Jwk, oct]],
      ['oct then EC', [oct, K.J.ec as Jwk]],
      ['RSA, oct, EC', [K.J.rsa as Jwk, oct, K.J.ec as Jwk]],
      ['oct, RSA, EC', [oct, K.J.rsa as Jwk, K.J.ec as Jwk]],
      ['EC then RSA-4096', [K.J.ec as Jwk, rsa4096]],
      ['RSA-4096 then EC P-384', [rsa4096, ec384]],
      ['EC, EC P-384, oct', [K.J.ec as Jwk, ec384, oct]],
    ]
    for (const [name, list] of keys) {
      for (const how of ['kty first', 'kty last', 'private first']) {
        const yaml = 'keys:\n' + list.map((j) => '  -\n' + order(j, how).map((k) => `    ${k}: ${j[k]}`).join('\n')).join('\n') + '\n'
        const toml = list.map((j) => '[[keys]]\n' + order(j, how).map((k) => `${k} = "${j[k]}"`).join('\n')).join('\n') + '\n'
        for (const [form, text] of [['YAML', yaml], ['TOML', toml]]) {
          const r = screenKeys(text)
          for (const j of list) {
            gone(r.text, j, `${name}/${how}/${form}`)
            kept(r.text, j, `${name}/${how}/${form}`)
          }
          expect(Object.keys(r.removed), `${name}/${how}/${form}`).toEqual(['jwk_private_key'])
        }
      }
    }
  })

  it('reads a member up to 16 KB from its kty and no further, and a stretch between two keys at its two ends only', () => {
    const k = (): string => randomBytes(32).toString('base64url')
    const prose = (n: number): string => Array.from({ length: n }, (_, i) => `# ${i}: the service restarted and the cache was warmed up again.`).join('\n')
    const [near1, near2, before, middle, after] = [k(), k(), k(), k(), k()]
    // 5 KB from a kty is taken; 20 KB from it is not: before the first, in a stretch of 45 KB between two (20 KB from both), after the last
    const gap = (n: number): string => '\n' + prose(Math.ceil(n / 62)) + '\n'
    const text = `k: ${before}${gap(20_000)}kty: oct${gap(5_000)}k: ${near1}${gap(20_000)}k: ${middle}${gap(20_000)}kty: oct${gap(5_000)}k: ${near2}${gap(20_000)}k: ${after}\n`
    const r = screenKeys(text)
    expect(r.text.includes(near1.slice(0, 20)) || r.text.includes(near2.slice(0, 20))).toBe(false)
    for (const far of [before, middle, after]) expect(r.text.includes(far)).toBe(true)
    expect(r.removed).toEqual({ jwk_private_key: 2 })
  })

  it('the reach is 16,384 characters exactly: a member inside it is read, one a character further is not, on either side of the kty', () => {
    const REACH = 16_384
    const value = (): string => randomBytes(32).toString('base64url')
    for (const off of [0, 1]) {
      // before the kty: the member's name starts REACH + off characters before the kty's, 5 characters into the text (so the range does not start at 0)
      const v = value()
      const member = `k: ${v}\n`
      const kty = 5 + REACH + off
      const before = '#'.repeat(5) + member + '#'.repeat(kty - 5 - member.length - 1) + '\n' + 'kty: oct\n'
      expect(before.indexOf('kty: oct') - before.indexOf('k: '), `before/${off}`).toBe(REACH + off)
      expect(screenKeys(before).text.includes(v), `before/${off}`).toBe(off === 1)
      // after the kty: the member's value starts REACH - 1 + off characters after the kty's end
      const w = value()
      const after = 'kty: oct' + '#'.repeat(REACH - 1 + off - 4) + '\nk: ' + w + '\n'
      expect(after.indexOf(w) - 'kty: oct'.length, `after/${off}`).toBe(REACH - 1 + off)
      expect(screenKeys(after).text.includes(w), `after/${off}`).toBe(off === 1)
    }
  })

  it('reads a member whose opening quote is on the seam of two keys\' reach ranges, which just meet', () => {
    // kty at 0 reaches to 8 + 16,384; a second kty 2 x 16,384 characters further has its reach start there: ranges that meet are one.
    // The member `"k": "..."` starts with its quote on the last character of the first range, its name on the first of the second
    // (read as two, the first stops at its end and the second skips a member that starts before its own start: nobody reads it).
    const REACH = 16_384
    const v = randomBytes(32).toString('base64url')
    const member = `"k": "${v}"`
    const text = 'kty: oct' + '#'.repeat(8 + REACH - 1 - 8) + member + '#'.repeat(8 + 2 * REACH - (8 + REACH - 1) - member.length) + 'kty: oct\n'
    expect(text.indexOf('"k"'), 'the quote is the last character of the first range').toBe(8 + REACH - 1)
    expect(text.lastIndexOf('kty: oct') - REACH, 'the second range starts where the first ends').toBe(8 + REACH)
    expect(screenKeys(text).text.includes(v)).toBe(false)
  })

  it('flags the first d or k of a key that had no private member to take, and no other member, and no value of fewer than 8 characters', () => {
    const phrase = (s: string): string => Buffer.from(s).toString('base64url')
    // two placeholders under one kty (the first is named), a placeholder p (RSA's p is a private member, but not the one a note is about), a short k
    const two = `kty: oct\nk: ${phrase('my-super-secret-key-one')}\nk: ${phrase('my-super-secret-key-two')}\n`
    const spans = jwkKeys(two)
    expect(spans.map((s) => [s.cls, s.why, two.slice(s.from, s.to)])).toEqual([['flag', 'jwk oct k not a key', phrase('my-super-secret-key-one')]])
    expect(jwkKeys(`kty: RSA\np: ${phrase('my-super-secret-prime-value-for-tests')}\n`)).toEqual([])
    expect(jwkKeys('kty: oct\nk: abc1234\n')).toEqual([]) // (seven characters)
    expect(jwkKeys('kty: oct\nk: abc12345\n').map((s) => s.cls)).toEqual(['flag']) // (eight)
    expect(jwkKeys('kty: oct\nk: abc\n')).toEqual([])
  })

  it('names a placeholder of each key of a list, and takes one span for a member two keys could own', () => {
    const phrase = (s: string): string => Buffer.from(s).toString('base64url')
    // placeholders of two types: each key's own value is named, not the neighbour's (a `k` above an EC key is no EC member)
    const holders = `keys:\n  - kty: oct\n    k: ${phrase('my-super-secret-key-for-tests')}\n  - kty: EC\n    crv: P-256\n    d: ${phrase('your-private-key-goes-right-here')}\n`
    expect(jwkKeys(holders).map((s) => [s.cls, s.why])).toEqual([['flag', 'jwk oct k not a key'], ['flag', 'jwk EC d not a key']])
    expect(screenKeys(holders).text).toBe(holders)
    // a private value between two kty members is one span, whichever of them takes it
    const ec = K.J.ec as Record<string, string>
    const between = `kty: EC\ncrv: P-256\nd: ${ec.d}\nkty: RSA\n`
    expect(jwkKeys(between).map((s) => [s.cls, s.why])).toEqual([['remove', 'jwk EC d']])
    // an RSA key's `d` is bigger than any curve's: taken under the RSA kty below it, whichever side the EC kty above it is on
    const rsa = K.J.rsa as Record<string, string>
    const mixed = `- kty: EC\n  crv: P-256\n  d: ${ec.d}\n- d: ${rsa.d}\n  kty: RSA\n`
    expect(jwkKeys(mixed).map((s) => [s.cls, s.why])).toEqual([['remove', 'jwk EC d'], ['remove', 'jwk RSA d']])
  })

  it('does not read a JSON object beside a YAML key a second time', () => {
    // the JSON object is one key: its members are its own, and the YAML key next to it counts for one more
    const ec = K.J.ec as Record<string, string>
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as Record<string, string>
    const text = `jwk:\n  kty: EC\n  crv: P-256\n  d: ${ec.d}\n${JSON.stringify(other)}\n`
    expect(screenKeys(text).removed).toEqual({ jwk_private_key: 2 })
    expect(jwkKeys(text).filter((s) => s.cls === 'remove')).toHaveLength(2)
  })

  it('judges a JSON object that follows a YAML one by its braces, whatever lies between its kty and its private member', () => {
    // 20 KB of certificate chain between kty and d: past what a brace-less key reaches, inside what an object's braces hold
    const rsa = K.J.rsa as Jwk
    const chain = 'MII' + randomBytes(15_000).toString('base64').replace(/[+/=]/g, 'a')
    const json = JSON.stringify({ kty: 'RSA', n: rsa.n, e: rsa.e, x5c: [chain], d: rsa.d, p: rsa.p, q: rsa.q })
    const text = `jwk:\n  kty: oct\n  alg: HS256\n${json}\n`
    const r = screenKeys(text)
    expect(leakedWindows(r.text, [rsa.d as string, rsa.p as string, rsa.q as string])).toBe(0)
    expect(r.text.includes(chain)).toBe(true)
  })
})

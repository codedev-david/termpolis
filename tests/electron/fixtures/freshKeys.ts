// Key material for the key-detector tests (keyMaterial.test.ts), made fresh in memory by each run
// and never written to disk or printed: real keys from node:crypto where it can make them (RSA, EC
// and Ed25519 in PKCS#1, PKCS#8, SEC1, encrypted PKCS#8, legacy encrypted PEM, JWK, RSAKeyValue),
// and files built byte for byte with their formats' real structure where it cannot (OpenSSH,
// OpenSSL DSA, OpenPGP, SSH2, PuTTY, OpenVPN). No key is ever a literal: GitHub push protection
// blocks one, and a fixed key would be a real key in the repository.
//
// Also the ways an answer writes a key file's lines (JOIN), and the strict leak measure: whether
// any 12 characters of a key line are still in a text.
import { generateKeyPairSync, randomBytes, type KeyObject } from 'crypto'

/** `s` cut into lines of `w` characters, as PEM and base64 wrap it. */
export const wrap = (s: string, w = 64): string[] => s.match(new RegExp(`.{1,${w}}`, 'g')) ?? []
const pemLines = (pem: string): string[] => pem.trim().split(/\r?\n/)
const u16 = (n: number): Buffer => Buffer.from([n >> 8, n & 255])
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const sshStr = (buf: Buffer): Buffer => Buffer.concat([u32(buf.length), buf])
/** A DER tag-length-value. */
export function der(tag: number, body: Buffer): Buffer {
  const len = body.length
  const l = len < 128 ? Buffer.from([len]) : len < 256 ? Buffer.from([0x81, len]) : Buffer.from([0x82, len >> 8, len & 255])
  return Buffer.concat([Buffer.from([tag]), l, body])
}
const derInt = (bytes: Buffer): Buffer => der(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes)
const b64u = (s: string): Buffer => Buffer.from(s, 'base64url')
const toB64 = (s: string): string => b64u(s).toString('base64')

/** OpenPGP's armor checksum (RFC 4880 6.1). */
export function crc24(buf: Buffer): number {
  let crc = 0xb704ce
  for (const b of buf) {
    crc ^= b << 16
    for (let i = 0; i < 8; i++) {
      crc <<= 1
      if (crc & 0x1000000) crc ^= 0x1864cfb
    }
  }
  return crc & 0xffffff
}

// ---------------------------------------------------------------------------------------------
// OpenPGP: transferable secret keys with true packet structure (RFC 4880): a v4 RSA or EdDSA
// secret-key packet (S2K usage 0), a User ID, a secret-subkey packet, armored as GnuPG writes it.
// ---------------------------------------------------------------------------------------------
function mpi(buf: Buffer): Buffer {
  let i = 0
  while (i < buf.length - 1 && buf[i] === 0) i++
  const b = buf.subarray(i)
  const bits = (b.length - 1) * 8 + (32 - Math.clz32(b[0]))
  return Buffer.concat([u16(bits), b])
}
function newPacket(tag: number, body: Buffer): Buffer {
  const len = body.length
  let hdr: Buffer
  if (len < 192) hdr = Buffer.from([0xc0 | tag, len])
  else if (len < 8384) hdr = Buffer.from([0xc0 | tag, ((len - 192) >> 8) + 192, (len - 192) & 255])
  else hdr = Buffer.concat([Buffer.from([0xc0 | tag, 255]), u32(len)])
  return Buffer.concat([hdr, body])
}
const oldPacket = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([0x80 | (tag << 2) | 1]), u16(body.length), body])
function checksum(b: Buffer): Buffer {
  let s = 0
  for (const x of b) s = (s + x) & 0xffff
  return u16(s)
}

/** A v4 RSA secret-key packet's body, of a fresh 2048-bit key. */
export function pgpRsaBody(): Buffer {
  const j = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
  const pub = Buffer.concat([Buffer.from([4]), u32(Math.floor(Date.now() / 1000) - 86400 * 30), Buffer.from([1]), mpi(b64u(j.n as string)), mpi(b64u(j.e as string))])
  const sec = Buffer.concat([mpi(b64u(j.d as string)), mpi(b64u(j.p as string)), mpi(b64u(j.q as string)), mpi(b64u(j.qi as string))])
  return Buffer.concat([pub, Buffer.from([0]), sec, checksum(sec)])
}
/** A v4 EdDSA (legacy, algorithm 22, the Ed25519 curve OID) secret-key packet's body. */
function pgpEdBody(): Buffer {
  const j = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  const oid = Buffer.from([0x2b, 0x06, 0x01, 0x04, 0x01, 0xda, 0x47, 0x0f, 0x01])
  const pub = Buffer.concat([Buffer.from([4]), u32(Math.floor(Date.now() / 1000) - 86400 * 7), Buffer.from([22, oid.length]), oid, mpi(Buffer.concat([Buffer.from([0x40]), b64u(j.x as string)]))])
  const sec = mpi(b64u(j.d as string))
  return Buffer.concat([pub, Buffer.from([0]), sec, checksum(sec)])
}
/** `bin` armored: BEGIN line, headers, a blank line, 64-character lines, the checksum, END line. */
export function armor(bin: Buffer, headers: string[]): string[] {
  const c = crc24(bin)
  const crc = Buffer.from([c >> 16, (c >> 8) & 255, c & 255]).toString('base64')
  return ['-----BEGIN PGP PRIVATE KEY BLOCK-----', ...headers, '', ...wrap(bin.toString('base64')), '=' + crc, '-----END PGP PRIVATE KEY BLOCK-----']
}
const uid = (s: string): Buffer => Buffer.from(s, 'utf8')

/** A `gpg --export-secret-keys -a` of a key with a photo ID: a v4 RSA secret key, a User ID, a User
 *  Attribute packet (tag 17) holding `photoBytes` random bytes behind the image header (whose 12
 *  reserved bytes are zero), and a secret subkey. `bodies` lets one pair of keys be armored with
 *  photos of many sizes. */
export function pgpPhotoExport(photoBytes: number, bodies: [Buffer, Buffer] = [pgpRsaBody(), pgpRsaBody()]): string[] {
  const photo = Buffer.concat([Buffer.from([0x10, 0x00, 0x01, 0x01]), Buffer.alloc(12), randomBytes(photoBytes)])
  const bin = Buffer.concat([oldPacket(5, bodies[0]), oldPacket(13, uid('Probe Key <probe@example.invalid>')), newPacket(17, Buffer.concat([Buffer.from([0x01]), photo])), oldPacket(7, bodies[1])])
  return armor(bin, ['Version: GnuPG v2'])
}

// ---------------------------------------------------------------------------------------------
// SSH2 (ssh.com, PuTTYgen's "export ssh.com key"): magic 3f6ff9eb, the total length, the key-type
// string, the cipher string, then the key blob (for "none": ssh.com mpints e, d, n, u, p, q).
// ---------------------------------------------------------------------------------------------
function mpintCom(buf: Buffer): Buffer {
  let i = 0
  while (i < buf.length - 1 && buf[i] === 0) i++
  const b = buf.subarray(i)
  return Buffer.concat([u32((b.length - 1) * 8 + (32 - Math.clz32(b[0]))), b])
}
export function ssh2Key(cipher: 'none' | '3des-cbc', bits = 2048): string[] {
  const j = generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ format: 'jwk' })
  const inner = Buffer.concat([j.e, j.d, j.n, j.qi, j.p, j.q].map((x) => mpintCom(b64u(x as string))))
  let blob = Buffer.concat([u32(inner.length), inner])
  // (stands in for the 3DES ciphertext: random bytes of the padded length)
  if (cipher !== 'none') blob = randomBytes(blob.length + 8 - (blob.length % 8))
  const body = Buffer.concat([sshStr(Buffer.from('if-modn{sign{rsa-pkcs1-sha1},encrypt{rsa-pkcs1v2-oaep}}')), sshStr(Buffer.from(cipher)), sshStr(blob)])
  const all = Buffer.concat([u32(0x3f6ff9eb), u32(body.length + 8), body])
  return ['---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----', 'Comment: "rsa-key-20261022"', ...wrap(all.toString('base64'), 70), '---- END SSH2 ENCRYPTED PRIVATE KEY ----']
}

/** The key formats K1 recognises, each as its file's lines (BEGIN line first, END line last). */
export type Format =
  | 'pkcs8_rsa'
  | 'pkcs8_ec'
  | 'pkcs8_ed25519'
  | 'enc_pkcs8'
  | 'pkcs1_rsa'
  | 'rsa_legacy_enc'
  | 'sec1_ec'
  | 'openssh'
  | 'dsa'
  | 'pgp_rsa_hdr'
  | 'pgp_rsa_nohdr'
  | 'pgp_ed_hdr'
  | 'pgp_ed_nohdr'
  | 'ssh2'
  | 'ssh2_real'
  | 'openvpn'

export interface KeySet {
  F: Record<Format, string[]>
  /** A PuTTY .ppk, unencrypted, as PuTTYgen writes version 3. */
  ppk: string[]
  /** JWKs with their private members. */
  J: { ec: JsonWebKey; okp: JsonWebKey; rsa: JsonWebKey; oct: { kty: 'oct'; k: string; alg: string } }
  /** .NET's RSA.ToXmlString(true) of the RSA key. */
  xml: string
  /** A Kubernetes Secret's tls.key, as `-o yaml` shows it: the key file, base64 encoded. */
  k8s: { plain: string; ecParamsFirst: string; bagAttributes: string }
}

interface JsonWebKey {
  kty?: string
  crv?: string
  x?: string
  y?: string
  d?: string
  n?: string
  e?: string
  p?: string
  q?: string
  dp?: string
  dq?: string
  qi?: string
}

/** A fresh set of keys in every format. */
/** An unencrypted Ed25519 key's OpenSSH file, built from the real key's bytes. `check`: its check value (random, as ssh-keygen
 *  writes one; a test fixes it to one ending in a zero byte, which one key in 256 has). */
export function opensshEd25519(key: KeyObject, check: Buffer = randomBytes(4)): string[] {
  const okp = key.export({ format: 'jwk' }) as JsonWebKey
  const seed = b64u(okp.d as string)
  const pub = b64u(okp.x as string)
  const type = Buffer.from('ssh-ed25519')
  const pubBlob = Buffer.concat([sshStr(type), sshStr(pub)])
  let priv = Buffer.concat([check, check, sshStr(type), sshStr(pub), sshStr(Buffer.concat([seed, pub])), sshStr(Buffer.from('probe@fresh'))])
  for (let i = 1; priv.length % 8; i++) priv = Buffer.concat([priv, Buffer.from([i])])
  const blob = Buffer.concat([Buffer.from('openssh-key-v1', 'latin1'), Buffer.from([0]), sshStr(Buffer.from('none')), sshStr(Buffer.from('none')), sshStr(Buffer.alloc(0)), u32(1), sshStr(pubBlob), sshStr(priv)])
  return ['-----BEGIN OPENSSH PRIVATE KEY-----', ...wrap(blob.toString('base64'), 70), '-----END OPENSSH PRIVATE KEY-----']
}

export function makeKeys(): KeySet {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const ed = generateKeyPairSync('ed25519')
  const pass = randomBytes(9).toString('hex')
  const okp = ed.privateKey.export({ format: 'jwk' }) as JsonWebKey

  // OpenSSL's traditional DSA file: SEQUENCE { 0, p, q, g, y, x } of random integers.
  const big = (n: number): Buffer => {
    const b = randomBytes(n)
    b[0] |= 0x80
    return b
  }
  const dsa = der(0x30, Buffer.concat([der(0x02, Buffer.from([0])), derInt(big(256)), derInt(big(32)), derInt(big(256)), derInt(big(256)), derInt(big(32))]))

  const pgpRsa = Buffer.concat([oldPacket(5, pgpRsaBody()), oldPacket(13, uid('Probe Key <probe@example.invalid>')), oldPacket(7, pgpRsaBody())])
  const pgpEd = Buffer.concat([newPacket(5, pgpEdBody()), newPacket(13, uid('Probe Ed <probe@example.invalid>')), newPacket(7, pgpEdBody())])
  const ssh2 = Buffer.concat([Buffer.from([0x3f, 0x6f, 0xf9, 0xeb]), randomBytes(900)])

  const F: Record<Format, string[]> = {
    pkcs8_rsa: pemLines(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string),
    pkcs8_ec: pemLines(ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string),
    pkcs8_ed25519: pemLines(ed.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string),
    enc_pkcs8: pemLines(rsa.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: pass }) as string),
    pkcs1_rsa: pemLines(rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string),
    rsa_legacy_enc: pemLines(rsa.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: pass }) as string),
    sec1_ec: pemLines(ec.privateKey.export({ type: 'sec1', format: 'pem' }) as string),
    openssh: opensshEd25519(ed.privateKey),
    dsa: ['-----BEGIN DSA PRIVATE KEY-----', ...wrap(dsa.toString('base64')), '-----END DSA PRIVATE KEY-----'],
    pgp_rsa_hdr: armor(pgpRsa, ['Version: GnuPG v2', 'Comment: probe key']),
    pgp_rsa_nohdr: armor(pgpRsa, []),
    pgp_ed_hdr: armor(pgpEd, ['Version: GnuPG v2', 'Comment: probe key']),
    pgp_ed_nohdr: armor(pgpEd, []),
    ssh2: ['---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----', 'Comment: "rsa-key-20261018"', ...wrap(ssh2.toString('base64'), 70), '---- END SSH2 ENCRYPTED PRIVATE KEY ----'],
    ssh2_real: ssh2Key('none', 1024),
    openvpn: ['#', '# 2048 bit OpenVPN static key', '#', '-----BEGIN OpenVPN Static key V1-----', ...wrap(randomBytes(256).toString('hex'), 32), '-----END OpenVPN Static key V1-----'],
  }

  const pubL = wrap(randomBytes(279).toString('base64'))
  const privL = wrap(randomBytes(880).toString('base64'))
  const ppk = ['PuTTY-User-Key-File-3: ssh-rsa', 'Encryption: none', 'Comment: rsa-key-20261018', `Public-Lines: ${pubL.length}`, ...pubL, `Private-Lines: ${privL.length}`, ...privL, `Private-MAC: ${randomBytes(32).toString('hex')}`]

  const x = rsa.privateKey.export({ format: 'jwk' }) as JsonWebKey
  const J = {
    ec: ec.privateKey.export({ format: 'jwk' }) as JsonWebKey,
    okp,
    rsa: x,
    oct: { kty: 'oct' as const, k: randomBytes(32).toString('base64url'), alg: 'HS256' },
  }
  const xml = `<RSAKeyValue><Modulus>${toB64(x.n as string)}</Modulus><Exponent>${toB64(x.e as string)}</Exponent><P>${toB64(x.p as string)}</P><Q>${toB64(x.q as string)}</Q><DP>${toB64(x.dp as string)}</DP><DQ>${toB64(x.dq as string)}</DQ><InverseQ>${toB64(x.qi as string)}</InverseQ><D>${toB64(x.d as string)}</D></RSAKeyValue>`

  const ecPem = F.sec1_ec.join('\n') + '\n'
  const k8s = {
    plain: Buffer.from(ecPem).toString('base64'),
    ecParamsFirst: Buffer.from('-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n' + ecPem).toString('base64'),
    bagAttributes: Buffer.from('Bag Attributes\n    localKeyID: 01 00 00 00 \nKey Attributes: <No Attributes>\n' + F.pkcs8_rsa.join('\n') + '\n').toString('base64'),
  }
  return { F, ppk, J, xml, k8s }
}

// ---------------------------------------------------------------------------------------------
// How an answer writes a key file's lines: as a file, in code, JSON or YAML, in a diff, a listing
// or a log. (lnk3's joinings and the judge's listing forms.)
// ---------------------------------------------------------------------------------------------
const pad = (n: number, w: number): string => String(n).padStart(w)
const BT = '`'
const BS = '\\'
const LONG = '/home/dev/projects/infrastructure/deployment/keys/production'
export const JOIN: Record<string, (ls: string[]) => string> = {
  lf: (ls) => ls.join('\n'),
  crlf: (ls) => ls.join('\r\n'),
  cr: (ls) => ls.join('\r'),
  json_n: (ls) => `{"private_key": "${ls.join('\\n')}\\n", "x": 1}`,
  json_nn: (ls) => `{"outer": "{\\"private_key\\": \\"${ls.join('\\\\n')}\\\\n\\"}"}`,
  java_concat: (ls) => 'String KEY =\n' + ls.map((l) => `    "${l}\\n"`).join(' +\n') + ';',
  js_concat: (ls) => 'const KEY = ' + ls.map((l) => `'${l}\\n'`).join(' +\n  ') + ';',
  cs_newline: (ls) => 'var key = ' + ls.map((l) => `"${l}"`).join(' + Environment.NewLine +\n    ') + ';',
  php_dot: (ls) => '$key = ' + ls.map((l) => `"${l}\\n"`).join(' .\n    ') + ';',
  vb_crlf: (ls) => 'Dim key = ' + ls.map((l) => `"${l}"`).join(' & vbCrLf & _\n    '),
  py_implicit: (ls) => 'KEY = (\n' + ls.map((l) => `    "${l}\\n"`).join('\n') + '\n)',
  py_bytes: (ls) => 'KEY = (\n' + ls.map((l) => `    b"${l}\\n"`).join('\n') + '\n)',
  yaml_block2: (ls) => 'data:\n  key: |\n' + ls.map((l) => `    ${l}`).join('\n') + '\nother: 1',
  cat_n: (ls) => ls.map((l, i) => `${pad(i + 1, 6)}\t${l}`).join('\n'),
  rg_win: (ls) => ls.map((l, i) => `config\\keys\\deploy.pem:${i + 1}:${l}`).join('\r\n'),
  rg_C_win: (ls) => ls.map((l, i) => (i === 0 ? `config\\keys\\deploy.pem:${i + 1}:${l}` : `config\\keys\\deploy.pem-${i + 1}-${l}`)).join('\r\n'),
  rg_long_posix: (ls) => ls.map((l, i) => `${LONG}/deploy.key:${i + 1}:${l}`).join('\n'),
  select_string: (ls) => ls.map((l, i) => `  C:\\Users\\dev\\keys\\deploy.pem:${i + 1}:${l}`).join('\r\n'),
  docker_t: (ls) => ls.map((l, i) => `2026-10-18T12:00:0${i % 10}.123456789Z ${l}`).join('\n'),
  compose: (ls) => ls.map((l) => `web-1  | ${l}`).join('\n'),
  slash_comment: (ls) => ls.map((l) => `// ${l}`).join('\n'),
  quote: (ls) => ls.map((l) => `> ${l}`).join('\n'),
  diff_plus: (ls) => 'diff --git a/k b/k\n--- /dev/null\n+++ b/k\n@@ -0,0 +1,30 @@\n' + ls.map((l) => `+${l}`).join('\n'),
  // the six characters of a JSON line feed escape: a backslash, u, 000a
  u000a: (ls) => '"' + ls.join(BS + 'u000a') + '"',
  space_one_line: (ls) => 'PRIVATE_KEY="' + ls.join(' ') + '"',
  // (a key with its line breaks taken out: `tr -d "\n"`, a PowerShell -join '')
  no_sep: (ls) => 'PRIVATE_KEY="' + ls.join('') + '"',
  shell_echo: (ls) => ls.map((l, i) => `echo '${l}' ${i ? '>>' : '>'} key.pem`).join('\n'),
  js_template: (ls) => 'const KEY = ' + BT + ls.join('\n') + BT,
}
/** The reduced matrix of the design's T1: 20 joinings, and the key with no separator at all and the key echoed into a file line by line. */
export const T1_JOININGS = ['lf', 'crlf', 'cr', 'json_n', 'json_nn', 'java_concat', 'py_bytes', 'yaml_block2', 'cat_n', 'rg_win', 'rg_C_win', 'rg_long_posix', 'select_string', 'docker_t', 'compose', 'slash_comment', 'quote', 'diff_plus', 'u000a', 'space_one_line', 'no_sep', 'shell_echo']

/** The key lines of a key file: every line of 8 or more base64 characters (headers, armor, the
 *  checksum and the BEGIN and END lines excluded); for a PuTTY file, its private lines. */
export function secretLinesOf(lines: string[], ppk = false): string[] {
  if (ppk) {
    const i = lines.findIndex((l) => l.startsWith('Private-Lines'))
    const j = lines.findIndex((l) => l.startsWith('Private-MAC'))
    return lines.slice(i + 1, j === -1 ? undefined : j).filter((l) => l.length >= 8)
  }
  return lines.filter((l) => l.length >= 8 && /^[A-Za-z0-9+/]+=*$/.test(l) && !l.startsWith('='))
}

/** `text` with the escapes a joining adds undone, so a key line shows whatever wrote it. */
const normal = (text: string): string =>
  text
    .replace(/%2B/gi, '+')
    .replace(/%2F/gi, '/')
    .replace(/%3D/gi, '=')
    .replace(/\\\//g, '/')
    .replace(/\\u002[bB]/g, '+')

/** The strict leak measure: every 12-character window of every key line, at every offset, looked
 *  for in the text. Returns the windows found (0: nothing of the key crossed). (The judge's probes
 *  stepped by 4, which misses a run of 12 to 14 characters that starts off that step.) */
export function leakedWindows(text: string, secret: string[]): number {
  const out = normal(text)
  let windows = 0
  for (const l of secret) {
    const w = Math.min(12, l.length)
    for (let i = 0; i + w <= l.length; i++) if (out.includes(l.slice(i, i + w))) windows++
  }
  return windows
}

const B64C = /[A-Za-z0-9+/=]/
/** Whether `tok` shows in `text` as a whole base64 token, not inside a longer run: for a key's last
 *  line, too short for the 12-character windows. */
export function shownWhole(text: string, tok: string): boolean {
  for (let i = text.indexOf(tok); i !== -1; i = text.indexOf(tok, i + 1)) {
    if (!B64C.test(text[i - 1] ?? '') && !B64C.test(text[i + tok.length] ?? '')) return true
  }
  return false
}

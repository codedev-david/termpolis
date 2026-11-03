// Private keys in text that crosses to another computer (Linked machines), found by what their
// bytes are, not by how their lines are laid out.
//
// A rule that lists the ways a key's lines can be joined (string literals, escapes, listings,
// comments) grows with every way it misses, and each widening matches more ordinary text. These
// detectors do the opposite. Taking the base64 is permissive: each logical line's last run counts,
// whatever frames it. The decision rests on the DECODED bytes: a PKCS#8, encrypted PKCS#8, PKCS#1,
// DSA or SEC1 DER header, the OpenSSH magic, the SSH2 magic, an OpenPGP secret-key packet, PEM
// encryption headers, a PuTTY file's own count of its private lines, a JWK's or an RSAKeyValue's
// member sizes. Prose, paths, alphabets, hashes, pins, public keys and certificates never decode
// to those, so they are never removed, however close to a BEGIN line they sit.
//
// Each span found is `remove` (its bytes are a private key's) or `flag` (it only looks like one: a
// header with no key under it, a template, a public key or certificate under a private BEGIN line,
// a made-up body, a placeholder). aiSecurity's screenText applies them; nothing here changes text.
//
// Linear: every loop moves forward through the text or is bounded by a constant, and the search
// for the next BEGIN or END marker is cached, never repeated per line. Every search starts from the
// window the screen gives it, never from 0: what looks back (a PuTTY file's first line, a JWK's
// braces) looks back a bounded stretch. No electron import: aiSecurity, which the memory
// utilityProcess loads, will import this (memoryHostImportGraph.test.ts).

/** What a detector found: a span of the text, the rule its marker and notes name, and whether its
 *  bytes are key material (`remove`) or it only looks like a key (`flag`). */
export interface KeySpan {
  rule: string
  cls: 'remove' | 'flag'
  /** What decided, for tests and diagnostics: the structure decoded, or the check that failed. */
  why: string
  from: number
  to: number
  /** A JWK's or an RSAKeyValue's members share their object's start: one credential. */
  group?: number
}

/** A key block from its BEGIN line (keyBlocks), and where its scan stopped: its END line's end, or
 *  its last key line. headless leaves an END line inside one alone. `rest`: with no END line, the
 *  start of the line where its lines stopped keeping one width and frame (a line indented, split
 *  or joined), which headless reports if key lines go on from there. */
export interface KeyBlock extends KeySpan {
  scanEnd: number
  rest?: number
}

type Run = [number, number]

const B64 = new Uint8Array(128)
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=') B64[c.charCodeAt(0)] = 1
const isB64 = (c: number): boolean => c < 128 && B64[c] === 1

/** A payload run: the base64 a key line carries. */
const MIN_RUN = 16
/** What may sit between two payload runs (frames, joiner lines, headers). */
const MAX_GAP = 320
/** How far after a BEGIN line its first payload may start. */
const MAX_LEAD = 2048
/** How far after an OpenVPN BEGIN line a key written in one run of 512 digits may start: a frame and written-out line breaks sit
 *  between them, nothing else. (The stretch is read for each such run, so it is bounded, and a block of them costs its length.) */
const MAX_ONE_RUN_LEAD = 4096
/** The longest block followed: a PGP keyring export with a photo ID runs to hundreds of KB. */
const MAX_BLOCK = 4 * 1024 * 1024
/** A `NAME=` in front of a value is shorter than a key line is wide (64 characters, at the least). */
const MAX_NAME = 64
/** Payload characters a verified header must carry over a body that does not say how long it is
 *  (OpenSSH, SSH2, OpenPGP), or over a DER key cut short before its END line. */
const LONG_PAYLOAD = 128

// ---------------------------------------------------------------------------------------------
// Logical lines. A line ends at a real line break or an escaped one, so a key whose lines are
// joined by \n, \\n, the Unicode or hex escape of a line feed, %0A, &#xA;, <br> or PowerShell's `n
// reads as lines too.
// ---------------------------------------------------------------------------------------------
const ESC_RE = /\\+(?:[nr]|u000[aAdD]|x0[aAdD])|%0[aAdD]|&#(?:x0?[aAdD]|1[03]);|<br\s*\/?>|`[nr]/y

/** ESC_RE for replacing every written-out line break in a stretch of text. A run of backslashes is read once, from its first: the
 *  same characters follow all of it, so an escape starts at no other. (Tried at each, a run of n of them cost n * n.) */
export const ESC_ALL_RE = new RegExp('(?<!\\\\)' + ESC_RE.source, 'g')

/** A CR written out and the LF written out right behind it (a Windows line end in a JSON string, a form post, PowerShell's text): one break, as a real
 *  CR LF is for nextBreak, which reads the two as a break with an empty line between them. */
const CRLF_ESCAPED = /^(?:\\+r|\\+u000[dD]|\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\+n|\\+u000[aA]|\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/

/** What a Windows path goes on with after a backslash and the letter that read as a written-out CR or LF (`\repos\a.pem:12:AAAA`, `\rsa_key.pem:12:AAAA`):
 *  a name or more folders, and a listing's separator: `:N:` or `-N-`, or, when no line numbers are printed (`findstr`, `grep -H`), a `:` that a payload,
 *  a marker (`-----BEGIN`, SSH2's `---- BEGIN`), an armor header (`Proc-Type: `) or the line's end follows, after a name that has an extension or a folder in it
 *  (`error:` is a word). */
const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\-/\\]{0,95}?(?::\d{1,9}[:-]|-\d{1,9}-)|(?=[A-Za-z0-9_.\-/\\]{0,96}?[.\\/])[A-Za-z_.][A-Za-z0-9_.\-/\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\r\n]|$))/y
/** The same for a name the expression above is too narrow for, read when the text is read as a Windows path with names of every kind (`pathReading` 2): one that starts with a digit, a dash
 *  or a bracket (`\r123456`, `\n8n`, `\r-lib`, `\n(x86)`) or holds a blank or any other character a Windows name can (`\new project`, `\node_modules\@types`, a name in Unicode), up to
 *  MAX_PATH (259) characters, or a folder named just `n` or `r` (`\n\a.pem`); and the listing's colon may be followed by the blanks of an indented line. A name counts only if it
 *  holds a folder or file separator (a `.`, `\` or `/`): a clock time, a timestamp (`2026-11-02T10:11:10`) or a line of prose that follows a break has none before its first colon. It
 *  does not start with another written-out break: a CR and LF written out (`\r\n`) are one break, not a folder. */
const PATH_NAMED = /(?!\\+(?:[nr]|u000[aAdD]|x0[aAdD]))(?=[^\x00-\x1f"*:<>?|]{0,259}?[.\\/])[^\x00-\x1f"*:<>?|]{1,259}?(?::\d{1,9}[:-]|-\d{1,9}-|:(?=[ \t]*(?:[A-Za-z0-9+/=]{16}|-{4}|[A-Z][A-Za-z-]{2,12}: )|[A-Za-z0-9+/=]{4}|[\r\n]|$))/y
/** A written-out CR or LF made of backslashes and the letter alone (not the Unicode or hex escape of one). */
const BACKSLASH_BREAK = /^\\+[nr]$/
/** Whether `c` can be in a piece of a path: a letter, a digit, `_`, `.` or `-`. */
const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45
/** Whether `c` can be in the piece of a path that stands in front of a backslash and letter: `isPathChar`, the characters a Windows name holds that no base64 line does (`@types`, `Files (x86)`,
 *  `C#`, `{GUID}`: `@ ( ) [ ] { } ~ # $ % & ! ^`) and any character outside ASCII. */
const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126

/** Whether the written-out CR or LF `m`, found at i, is the backslash and the letter of a Windows path in a listing (`...\AzurePipelineTool\rsa_key.pem:12:AAAA`,
 *  `\repos`, `\notes`, `\node_modules`): the text after it goes on as a path to a listing's separator, and a piece of a path ends right before it, one that
 *  starts the line or follows a backslash, a blank, a `>` or a quote. (A piece that follows a `:` or a `/` is the end of a key line, in a listing whose lines are joined by
 *  written-out breaks, and so is any text that goes on with a timestamp or a service name instead of a path.) Read as a break, such a backslash cut the path in two,
 *  and a piece of 16 characters or more before it was taken for a key line. `wide`: a name of any kind a Windows path can hold counts, after the escape (PATH_NAMED) and in the piece in front of it
 *  (isPieceChar); not wide, only the usual names (PATH_AFTER_ESCAPE, isPathChar). */
function pathEscape(text: string, i: number, escape: string, wide: boolean): boolean {
  if (!BACKSLASH_BREAK.test(escape)) return false
  PATH_AFTER_ESCAPE.lastIndex = i + escape.length
  if (!PATH_AFTER_ESCAPE.test(text)) {
    if (!wide) return false
    PATH_NAMED.lastIndex = i + escape.length
    if (!PATH_NAMED.test(text)) return false
  }
  const inPiece = wide ? isPieceChar : isPathChar
  let k = i
  while (k > 0 && i - k < 97 && inPiece(text.charCodeAt(k - 1))) k--
  if (i - k > 96) return false
  if (k === i) {
    // No piece in front of it: a path that opens with it (a UNC path's `\\repos`, a relative one's first folder, a cut that took the piece before it), or one that
    // follows its drive (`C:\repos`).
    const before = text.charCodeAt(i - 1)
    return i === 0 || before === 10 || before === 13 || (before === 58 && isLetter(text.charCodeAt(i - 2)) && !isPathChar(text.charCodeAt(i - 3)))
  }
  const c = k === 0 ? 10 : text.charCodeAt(k - 1)
  return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39
}

/** How a backslash and a letter (`\n`, `\r`) that may be a Windows path's are read: 0 as a written-out line break, 1 as a piece of a path of the usual kind (letters, digits, `_`, `.`, `-`) when the
 *  text around it reads like a listing's path, 2 as that or as a piece of any path a Windows name can make (`pathEscape`'s `wide`). The text is ambiguous where a JSON string joins a listing's lines
 *  (every MCP tool result): the next key line's own frame (`id.pem-2-`, `values.yaml:2:    `, a pod name with a number in it) is what a path goes on with, and the end of the line before it is a
 *  piece of a path. So a text in which one reading kept an escape from being a break is read again with the reading below it (readEveryWay), 2 then 1 then 0, and what the readings find is joined: a
 *  key is removed only for what its bytes decode to, whichever way its lines were read, so another reading adds no removal of text that is not one, and none finds less than the one above it left
 *  to find. The two variables are module state, saved and restored by readEveryWay: keySpans calls itself on what a base64 key file decodes to, and the inner call must not clear the outer one's. */
export type PathReading = 0 | 1 | 2
let pathReading: PathReading = 2
let pathSuppressed = false

/** `find`, run at the reading it is called at and, while that reading kept an escape from being a break, at the one below it; `join` merges the results. (At 0 nothing is kept from being a
 *  break, so a find called from there reads once.) */
function readEveryWay<R>(find: () => R, join: (first: R, second: R) => R): R {
  const outerReading = pathReading
  const outerSuppressed = pathSuppressed
  try {
    pathSuppressed = false
    let out = find()
    while (pathSuppressed && pathReading > 0) {
      pathReading = (pathReading - 1) as PathReading
      pathSuppressed = false
      out = join(out, find())
    }
    return out
  } finally {
    pathReading = outerReading
    pathSuppressed = outerSuppressed
  }
}

/** `f` at one reading (see PathReading), for tests: a text read at the usual reading or at none is what round 5 and the version before it read. */
export function atReading<R>(reading: PathReading, f: () => R): R {
  const outer = pathReading
  pathReading = reading
  try {
    return f()
  } finally {
    pathReading = outer
  }
}

const spanKey = (x: KeySpan): string => `${x.from}:${x.to}:${x.rule}:${x.cls}`
/** `first` and what `second` finds that it does not, a span once. */
function joinSpans<T extends KeySpan>(first: T[], second: T[]): T[] {
  const seen = new Set(first.map(spanKey))
  const out = first.slice()
  for (const x of second) if (!seen.has(spanKey(x))) out.push(x)
  return out
}
/** The key blocks of two readings, one for each BEGIN line and in the order of their BEGIN lines (headless walks them so): where both readings found one, the one that takes the key, else the
 *  one that reaches further. */
export function joinBlocks(first: KeyBlock[], second: KeyBlock[]): KeyBlock[] {
  const takes = (x: KeyBlock): number => (x.cls === 'remove' ? 1 : 0)
  const byBegin = new Map<number, KeyBlock>()
  for (const b of first) byBegin.set(b.from, b)
  for (const b of second) {
    const a = byBegin.get(b.from)
    if (a === undefined || takes(b) > takes(a) || (takes(b) === takes(a) && Math.max(b.to, b.scanEnd) > Math.max(a.to, a.scanEnd))) byBegin.set(b.from, b)
  }
  return [...byBegin.values()].sort((x, y) => x.from - y.from)
}

/** The written-out line break that starts at i, or null. PowerShell's `n and `r count only after the text they end: a base64
 *  character, a quote or a dash (a BEGIN line's). An inline-code span opens with a backtick in front of a key line (after a space,
 *  a comma or a line start), and about half of the key lines start with n or r. A backslash and a letter of a Windows path are not one (pathEscape). */
export function escapeAt(text: string, i: number): RegExpExecArray | null {
  ESC_RE.lastIndex = i
  const m = ESC_RE.exec(text)
  if (m !== null && text.charCodeAt(i) === 96) {
    // (at the start of the text there is no character before it: NaN, which none of these is)
    const before = text.charCodeAt(i - 1)
    if (!isB64(before) && before !== 34 && before !== 39 && before !== 45) return null
  }
  if (m !== null && pathReading > 0 && pathEscape(text, i, m[0], pathReading === 2)) {
    pathSuppressed = true
    return null
  }
  return m
}

/** [start, end) of the next line break at or after i and before limit, or null. */
function nextBreak(text: string, i: number, limit: number): Run | null {
  for (; i < limit; i++) {
    const c = text.charCodeAt(i)
    if (c === 10) return [i, i + 1]
    if (c === 13) return [i, text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1]
    if (c === 92 /* \ */ || c === 37 /* % */ || c === 38 /* & */ || c === 60 /* < */ || c === 96 /* ` */) {
      const m = escapeAt(text, i)
      if (m) return [i, i + m[0].length]
      // No escape starts at this backslash, so none starts at the others in its run: each reads on
      // to the same character. (Tried at each one, a run of n backslashes cost n * n.)
      if (c === 92) while (i + 1 < limit && text.charCodeAt(i + 1) === 92) i++
    }
  }
  return null
}

/** nextBreak over one text, for searches that move forward: next(i, limit) is nextBreak(text, i,
 *  limit), and a stretch searched once is not searched again. Key blocks whose BEGIN lines share a
 *  line each look for that line's end: searched afresh, a text of BEGIN markers with no line break
 *  was searched to its end once per marker. */
function breakCursor(text: string): (i: number, limit: number) => Run | null {
  let from = -1
  // no break starts in [from, clear); `found`, when set, is the first one at or after `from`
  let clear = -1
  let found: Run | null = null
  return (i, limit) => {
    if (from === -1 || i < from || (found !== null && found[0] < i) || (found === null && i > clear)) {
      from = i
      clear = i
      found = null
    }
    if (found === null && clear < limit) {
      found = nextBreak(text, clear, limit)
      clear = found ? found[0] : limit
    }
    return found !== null && found[0] < limit ? found : null
  }
}

/** Where the value starts in the base64 run [a, e) of `text`: after a name and its `=` (`message=`,
 *  `data=`, `TLS_KEY=`, journalctl's `MESSAGE=`), which is the last `=` that has base64 after it and
 *  something before it in the run; else `a`. (Padding is the only `=` a key line holds, and only at its
 *  end; a checksum line's own `=` leads its run, unless the key was written with no line breaks.) A name
 *  is shorter than a key line: an OpenPGP key written with no line breaks (`| tr -d '\n'`) ends in its
 *  padding and then `=XXXX`, its checksum, and the `=` far from the run's start is no name's. (Taken for
 *  one, it dropped the whole key and kept 4 characters.) */
function valueStart(text: string, a: number, e: number): number {
  let end = e
  while (end > a && text.charCodeAt(end - 1) === 61) end--
  for (let p = end - 1; p > a; p--) if (text.charCodeAt(p) === 61) return p - a >= MAX_NAME ? a : p + 1
  return a
}

/** Base64 runs of at least `min` characters in [s, e), each starting at its value (see valueStart). */
function runsIn(text: string, s: number, e: number, min = MIN_RUN): Run[] {
  const runs: Run[] = []
  let i = s
  while (i < e) {
    while (i < e && !isB64(text.charCodeAt(i))) i++
    const a0 = i
    while (i < e && isB64(text.charCodeAt(i))) i++
    const a = valueStart(text, a0, i)
    if (i - a >= min) runs.push([a, i])
  }
  return runs
}

/** The next base64 run at or after i, stepping over escaped line breaks (so the n of a \n never
 *  glues onto the run after it); or, when there is none before `stop`, the position the search reached
 *  (`stop` or after it: an escaped line break that began before `stop` ends after it). */
function nextRun(text: string, i: number, stop: number): Run | number {
  while (i < stop) {
    const c = text.charCodeAt(i)
    if (c === 92 || c === 37 || c === 38 || c === 60 || c === 96) {
      const m = escapeAt(text, i)
      if (m) {
        i += m[0].length
        continue
      }
      // (as in nextBreak: none starts at the rest of this backslash's run either)
      if (c === 92) while (i + 1 < stop && text.charCodeAt(i + 1) === 92) i++
    }
    if (isB64(c)) break
    i++
  }
  if (i >= stop) return i
  const a = i
  while (i < stop && isB64(text.charCodeAt(i))) i++
  return [a, i]
}

const MARK_RE = /-----(?:BEGIN|END) |---- (?:BEGIN|END) /g
/** The END marker that closes a key block (the BEGIN_RE kinds': a private key's, an OpenVPN static key's), at its `lastIndex`.
 *  (Its closing dashes may be missing: an END line a cut took the end of closes it all the same.) */
const CLOSING_END = /-----END (?:(?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?|OpenVPN Static key V1)|---- END SSH2 ENCRYPTED PRIVATE KEY/y

/** A cursor over BEGIN/END marker positions: next(at) is the first marker at or after `at`. Each
 *  search runs once: the answer is reused until `at` passes it. */
function markerCursor(text: string): (at: number) => number | null {
  let cached: number | null | undefined
  return (at) => {
    if (cached !== undefined && (cached === null || cached >= at)) return cached
    MARK_RE.lastIndex = at
    const m = MARK_RE.exec(text)
    cached = m ? m.index : null
    return cached
  }
}

// ---------------------------------------------------------------------------------------------
// Structure checks on decoded bytes.
// ---------------------------------------------------------------------------------------------
interface Tlv {
  tag: number
  len: number
  body: number
  end: number
}

/** The DER tag-length-value at o: its tag, its length, where its body starts and ends. */
function tlv(b: Uint8Array, o: number): Tlv | null {
  if (o + 2 > b.length) return null
  const tag = b[o]
  let len = b[o + 1]
  let hdr = 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n < 1 || n > 4 || o + 2 + n > b.length) return null
    len = 0
    for (let k = 0; k < n; k++) len = len * 256 + b[o + 2 + k]
    hdr = 2 + n
  }
  return { tag, len, body: o + hdr, end: o + hdr + len }
}

const startsWith = (b: Uint8Array, bytes: number[]): boolean => bytes.every((x, i) => b[i] === x)
const OPENSSH = [...Buffer.from('openssh-key-v1', 'latin1'), 0]
/** OpenSSH's magic and the three zero bytes of the length after it, as text (latin1). */
const OPENSSH_RUN = 'openssh-key-v1\0\0\0\0'
const SSH2_MAGIC = [0x3f, 0x6f, 0xf9, 0xeb]
/** 1.2.840.113549.1.5: PBES1 and PBES2. */
const PKCS5 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05]
/** 1.2.840.113549.1.12.1: the PKCS#12 PBE schemes. */
const PKCS12PBE = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x01]
const OPENSSH_CIPHERS = new Set(['none', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc', 'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'chacha20-poly1305@openssh.com'])

/** An OpenSSH private-key blob after its magic: a known cipher and KDF name, KDF options, and 1 to
 *  16 keys. The magic alone is what a truncated documentation example shows. */
export function opensshHeader(b: Buffer): boolean {
  let o = OPENSSH.length
  const str = (): string | null => {
    if (o + 4 > b.length) return null
    const n = b.readUInt32BE(o)
    o += 4
    if (n > 4096 || o + n > b.length) return null
    const s = b.subarray(o, o + n).toString('latin1')
    o += n
    return s
  }
  const cipher = str()
  const kdf = str()
  const opts = str()
  if (cipher === null || kdf === null || opts === null) return false
  if (!OPENSSH_CIPHERS.has(cipher) || (kdf !== 'none' && kdf !== 'bcrypt')) return false
  if (o + 4 > b.length) return false
  const n = b.readUInt32BE(o)
  return n >= 1 && n <= 16
}

/** A private-key structure the decoded bytes start with. */
export interface Structure {
  type: 'openssh' | 'ssh2' | 'pgp' | 'pkcs8' | 'encrypted-pkcs8' | 'pkcs1-or-dsa' | 'sec1'
  /** How long the DER says it is, in bytes (0 for the kinds that don't say). */
  declared: number
  /** Where the key's private value starts and ends in the DER, for the structures whose first line
   *  already holds some of it: a SEC1 EC key's, an EC or EdDSA/XDH PKCS#8 key's. (An RSA or DSA key's
   *  first line is its modulus or its parameters, an encrypted key's its salt: documentation shows
   *  those.) */
  priv?: [number, number]
  /** Its algorithm's public parameters are fixed text that can run long (00 and FF bytes): an EC curve's, a Diffie-Hellman group's. */
  fixed?: true
}

/** 1.2.840.10045.2.1: id-ecPublicKey. (X25519, X448, Ed25519 and Ed448 are 1.3.101.110-113, in pkcs8PrivateAt.) */
const EC_OID = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]

/** 2.16.840.1.101.3.4, NIST's arcs for algorithms: ML-DSA is .3.17 to .3.19, SLH-DSA .3.20 to .3.31, ML-KEM .4.1 to .4.3. */
const NIST_ARC = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04]
/** 'seeded': a key of ML-DSA or ML-KEM (RFC 9881 and the ones for ML-KEM), which opens with its seed of 32 or 64 bytes: that as [0] IMPLICIT OCTET
 *  STRING, an expanded key as OCTET STRING, or both in a SEQUENCE. 'raw': a key of SLH-DSA, which is the key's own bytes. */
function pqcKind(oid: Uint8Array): 'seeded' | 'raw' | null {
  if (oid.length !== 9 || !startsWith(oid, NIST_ARC)) return null
  if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null
  return oid[7] === 4 && oid[8] >= 1 && oid[8] <= 3 ? 'seeded' : null
}

/** Where the private value starts and ends in a PKCS#8 key whose algorithm `oid` is an EC, EdDSA/XDH or
 *  post-quantum one (`d`: the OCTET STRING that holds the key), or undefined. An ECPrivateKey is a SEQUENCE { 1,
 *  OCTET STRING value, ... }, a CurvePrivateKey just the OCTET STRING. */
function pkcs8PrivateAt(b: Uint8Array, oid: Uint8Array, d: Tlv): [number, number] | undefined {
  const pqc = pqcKind(oid)
  if (pqc === 'raw') return [d.body, d.end]
  if (pqc === 'seeded') {
    const x = tlv(b, d.body)
    if (x && x.tag === 0x30) {
      const seed = tlv(b, x.body)
      return seed && seed.tag === 0x04 ? [seed.body, seed.end] : undefined
    }
    return x && (x.tag === 0x80 || x.tag === 0x04) ? [x.body, x.end] : undefined
  }
  if (isEcOid(oid)) {
    const seq = tlv(b, d.body)
    const ver = seq && seq.tag === 0x30 ? tlv(b, seq.body) : null
    const key = ver && ver.tag === 0x02 ? tlv(b, ver.end) : null
    return key && key.tag === 0x04 ? [key.body, key.end] : undefined
  }
  if (oid.length === 3 && oid[0] === 0x2b && oid[1] === 0x65 && oid[2] >= 0x6e && oid[2] <= 0x71) {
    const key = tlv(b, d.body)
    return key && key.tag === 0x04 ? [key.body, key.end] : undefined
  }
  if (isDhOid(oid)) {
    // (a Diffie-Hellman key's private value is the INTEGER inside the OCTET STRING)
    const x = tlv(b, d.body)
    return x && x.tag === 0x02 ? [x.body, x.end] : undefined
  }
  return undefined
}

/** 1.2.840.113549.1.3.1 (PKCS #3 dhKeyAgreement) and 1.2.840.10046.2.1 (X9.42 dhpublicnumber). */
const DH_OIDS = [[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x03, 0x01], [0x2a, 0x86, 0x48, 0xce, 0x3e, 0x02, 0x01]]
const isDhOid = (oid: Uint8Array): boolean => DH_OIDS.some((o) => oid.length === o.length && startsWith(oid, o))
const isEcOid = (oid: Uint8Array): boolean => oid.length === EC_OID.length && startsWith(oid, EC_OID)

/** What private-key structure `b` starts with, and how long it says it is, or null. */
export function structureOf(b: Buffer): Structure | null {
  if (b.length >= OPENSSH.length && startsWith(b, OPENSSH)) return opensshHeader(b) ? { type: 'openssh', declared: 0 } : null
  if (b.length >= 8 && startsWith(b, SSH2_MAGIC)) return { type: 'ssh2', declared: 0 }
  if (pgpPacket(b)) return { type: 'pgp', declared: 0 }
  const outer = tlv(b, 0)
  if (!outer || outer.tag !== 0x30 || outer.len < 32) return null
  const a = tlv(b, outer.body)
  if (!a) return null
  if (a.tag === 0x02 && a.len === 1) {
    const v = b[a.body]
    const c = tlv(b, a.end)
    if (!c) return null
    if (c.tag === 0x30 && (v === 0 || v === 1)) {
      // PKCS#8 / OneAsymmetricKey: version, AlgorithmIdentifier { OID ... }, OCTET STRING key
      const oid = tlv(b, c.body)
      const d = tlv(b, c.end)
      if (oid && oid.tag === 0x06 && (!d || d.tag === 0x04)) {
        const algorithm = b.subarray(oid.body, oid.end)
        const priv = d ? pkcs8PrivateAt(b, algorithm, d) : undefined
        return { type: 'pkcs8', declared: outer.end, ...(priv === undefined ? {} : { priv }), ...(isEcOid(algorithm) || isDhOid(algorithm) ? { fixed: true as const } : {}) }
      }
      return null
    }
    if (c.tag === 0x02 && v === 0 && c.len >= 64) return { type: 'pkcs1-or-dsa', declared: outer.end }
    if (c.tag === 0x04 && v === 1 && c.len >= 14 && c.len <= 72) return { type: 'sec1', declared: outer.end, priv: [c.body, c.end], fixed: true }
    return null
  }
  if (a.tag === 0x30) {
    // EncryptedPrivateKeyInfo: AlgorithmIdentifier { a PKCS#5 or PKCS#12 PBE OID }, OCTET STRING.
    // (A SubjectPublicKeyInfo has the same outline with a key OID and a BIT STRING: not this.)
    const oid = tlv(b, a.body)
    if (!oid || oid.tag !== 0x06) return null
    const o = b.subarray(oid.body, oid.end)
    if (!startsWith(o, PKCS5) && !startsWith(o, PKCS12PBE)) return null
    const d = tlv(b, a.end)
    if (d && d.tag !== 0x04) return null
    return { type: 'encrypted-pkcs8', declared: outer.end }
  }
  return null
}

const PGP_ALGOS = new Set([1, 2, 3, 16, 17, 18, 19, 22, 25, 26, 27, 28])

/** An OpenPGP secret-key (5) or secret-subkey (7) packet: its header, a body length a key packet
 *  can have, a known version, a known public-key algorithm, and that algorithm's first public field
 *  well formed (an MPI whose bit count matches its leading byte, or a curve OID). Tag and version
 *  alone pass random bytes about once in 550. */
export function pgpPacket(b: Buffer): { tag: number; v: number; algo: number } | null {
  if (b.length < 12) return null
  const h = b[0]
  let tag: number
  let o: number
  let len: number
  if ((h & 0xc0) === 0x80) {
    tag = (h >> 2) & 0x0f
    const lt = h & 3
    if (lt === 3) return null
    const n = [1, 2, 4][lt]
    len = 0
    for (let k = 0; k < n; k++) len = len * 256 + b[1 + k]
    o = 1 + n
  } else if ((h & 0xc0) === 0xc0) {
    tag = h & 0x3f
    const l0 = b[1]
    if (l0 < 192) {
      len = l0
      o = 2
    } else if (l0 < 224) {
      len = ((l0 - 192) << 8) + b[2] + 192
      o = 3
    } else if (l0 === 255) {
      len = b.readUInt32BE(2)
      o = 6
    } else return null // a partial body length: never a key packet's first chunk
  } else return null
  if (tag !== 5 && tag !== 7) return null
  if (len < 24 || len > 65536) return null
  const v = b[o]
  if (v < 3 || v > 6) return null
  // v3: time(4) validity(2) algo; v4: time(4) algo; v5/v6: time(4) algo count(4)
  const ao = v === 3 ? o + 7 : o + 5
  const algo = b[ao]
  if (!PGP_ALGOS.has(algo)) return null
  if (v === 3 && algo > 3) return null
  let f = ao + 1
  if (v >= 5) {
    if (f + 4 > b.length) return null
    const count = b.readUInt32BE(f)
    if (count < 32 || count > len) return null
    f += 4
  }
  if (f + 3 > b.length) return null
  if (algo <= 3 || algo === 16 || algo === 17) {
    // An MPI: a 2-byte bit count, then its bytes, the first with its top bit where the count says.
    const bits = b.readUInt16BE(f)
    if (bits < 160 || bits > 16384) return null
    const top = b[f + 2]
    if (top === 0 || 31 - Math.clz32(top) !== (bits - 1) % 8) return null
  } else if (algo === 18 || algo === 19 || algo === 22) {
    // A curve OID: a length of 5 to 10, then the OID's bytes, which start 1.2 or 1.3.
    const n = b[f]
    if (n < 5 || n > 10 || (b[f + 1] !== 0x2a && b[f + 1] !== 0x2b)) return null
  } else if (v < 6) return null // 25-28 (X25519, X448, Ed25519, Ed448) are v6 keys
  return { tag, v, algo }
}

/** Decode the first runs of a payload, trying the 0-4 characters a frame may glue onto each line
 *  (a diff's +, a //, a coloured diff's `32m+`): which structure, at which offset. The glue is dropped from every line that
 *  starts with it, not only the first: a diff's + is a base64 character, so each line's run starts
 *  with it, and with the first line's dropped alone the bytes after it were misaligned (an
 *  encrypted PKCS#8 key, whose PBES2 parameters run past its first line, failed to decode in 17 of
 *  40 `git diff` listings). */
export function decodeHead(text: string, runs: Run[]): (Structure & { offset: number; head: string }) | null {
  for (let k = 0; k <= 4; k++) {
    const glue = text.slice(runs[0][0], runs[0][0] + k)
    let head = ''
    for (const [s, e] of runs) {
      const r = text.slice(s, e)
      head += k > 0 && r.startsWith(glue) ? r.slice(k) : r
      if (head.length >= 512) break
    }
    const st = structureOf(Buffer.from(head, 'base64'))
    if (st) return { ...st, offset: k, head }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Randomness: key material is random; test values, templates, alphabets and placeholders are not.
// ---------------------------------------------------------------------------------------------
export function looksRandom(s: string): boolean {
  if (s.length < 32) return false
  const sample = s.length > 4096 ? s.slice(0, 4096) : s
  const hex = /^[0-9a-fA-F]+$/.test(sample)
  const distinct = new Set(sample).size
  if (distinct < (hex ? Math.min(13, sample.length * 0.3) : Math.min(40, sample.length * 0.45))) return false
  // (a run of six equal characters is a placeholder's, but 512 random hex digits hold one about once in 2,000 keys: an
  // OpenVPN static key was only reported then. Nine in a row is one in ten million.)
  const maxRun = hex ? 8 : 5
  let rep = 1
  let seq = 0
  const tri = new Set<string>()
  for (let i = 1; i < sample.length; i++) {
    rep = sample[i] === sample[i - 1] ? rep + 1 : 1
    if (rep > maxRun) return false
    const d = sample.charCodeAt(i) - sample.charCodeAt(i - 1)
    if (d === 1 || d === -1) seq++
    if (i >= 2) tri.add(sample.slice(i - 2, i + 1))
  }
  if (seq / sample.length > 0.2) return false
  return tri.size / (sample.length - 2) >= 0.8
}

/** A DER key under 100 base64 characters is a short body: its structure's own header is a large share of it (see bodyLooksRandom). */
const SHORT_BODY = 100
/** The characters of a short body that are its header: the SEQUENCE, the version and the algorithm's identifier of a PKCS#8 key (24 of an ML-DSA key's 72). */
const SHORT_BODY_HEADER = 24

/** Whether the base64 body under a BEGIN line looks random. A standard curve's or Diffie-Hellman group's public parameters are
 *  runs of 00 and FF bytes (`AAAA...` and `////...`), so an EC key with explicit curve parameters and a DH key fail the run test
 *  of looksRandom over the whole body, though their structure is a private key's: judged again with each such run counted once,
 *  and only while most of the body is something else (a real header over a page of `A` is no key), for a structure of such an
 *  algorithm (`st.fixed`), and only when the private value the structure locates in what was decoded is random itself: a curve's
 *  parameters and a public key are a real key's, and a test key's value is the number 1, or all zero, or all FF. (A value the
 *  decoded head holds fewer than 16 characters of is not told by it.) */
function bodyLooksRandom(body: string, st: (Structure & { head: string }) | null): boolean {
  if (looksRandom(body)) return true
  // (a short key of a verified structure: 24 of the 72 characters of an ML-DSA seed-only key are the header every such key has, and the count of distinct
  // characters that looksRandom asks of all 72 is missed by about 1 key in 300. Judged without the header, it is a random body's alone.)
  if (st && st.declared > 0 && body.length < SHORT_BODY && looksRandom(body.slice(SHORT_BODY_HEADER))) return true
  if (!st || !st.fixed) return false
  if (st.priv !== undefined) {
    // (what of the value the decoded head holds: a key's last line is short, and is not part of the payload)
    const [from, to] = st.priv
    const shown = st.head.slice(Math.ceil((from * 4) / 3), Math.min(Math.floor((to * 4) / 3), st.head.length))
    if (shown.length >= 16 && !looksRandomToken(shown)) return false
  }
  const sample = body.length > 4096 ? body.slice(0, 4096) : body
  const collapsed = sample.replace(/A{6,}|\/{6,}/g, (run) => run[0])
  return collapsed.length >= sample.length / 2 && looksRandom(collapsed)
}

// ---------------------------------------------------------------------------------------------
// Key blocks with a BEGIN line (K1-K3).
// ---------------------------------------------------------------------------------------------
const BEGIN_RE = /-----BEGIN ((?:[A-Z0-9]+ ){0,3})PRIVATE KEY(?: BLOCK)?-----|---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----|-----BEGIN OpenVPN Static key V1-----/g
/** An armor or PEM header's name, at a line's start or after its frame: a colour code too, whose
 *  final `m` a terminal or a CI log glues to it (`ESC[33mProc-Type: 4,ENCRYPTED`). */
const HEADER_WORD = /(?:^|[^A-Za-z0-9]|\x1b\[[0-9;]{0,16}m)(Proc-Type|DEK-Info|Version|Comment|Hash|Charset|MessageID): ?/
// (a cipher's IV is its block's size: 8 bytes, 16 digits, for DES and the other 64-bit ciphers OpenSSL writes a traditional key with;
// 16 bytes, 32 digits, for AES and the rest)
const DEK_RE = /DEK-Info: ?(?:(?:DES|BF|CAST5|RC2|RC5|IDEA)[A-Z0-9-]*,[0-9A-Fa-f]{16}|[A-Z0-9-]{3,32},[0-9A-Fa-f]{32})/
/** Only what ends a key line or joins two: whitespace, quotes, a concatenation, a closing bracket. */
const JOINERS = /^[\s"'`,;+)\]}|\\]*$/
/** A frame made of joiners, indentation and comment or quote marks only. */
const JOINER_FRAME = /^[\s"'`,;&|()[\]{}\\_>#*-]*$/
/** What follows a path in a listing: an optional extension, then `:N:`, `:N-`, `-N-` or `:`. */
const LISTING_SEP = /^(?:\.[A-Za-z0-9_]{1,12})?(?::\d{1,9}[:-]|-\d{1,9}-|:)/
/** The rest of a path (`_key.asc`, `/id_rsa`, `.d/backup.asc`: no space) and then `:N:`, `:N:M:` or `-N-`. */
const PATH_REST_SEP = /^[A-Za-z0-9_.\-/\\]{0,96}?(?:(?::\d{1,9}){1,2}[:-]|-\d{1,9}-)/
/** The rest of a path and a `:`, then the end of what the line holds (grep without -n: `path:` in front of a blank line or an END marker). */
const PATH_REST_END = /^[A-Za-z0-9_.\-/\\]{1,96}:\s*$/
/** The rest of a path (no space) and what ends it, right before the line's own text or a line number: a listing's `:` (`:N:` and the like
 *  begin with one), `-N-` for a context line, or the `=` after an extension with a line's worth of payload behind it (journalctl's `NAME=`). A lone
 *  dash ends nothing: the private lines of a file joined by `-` read so, and the colon of the MAC line's name, `Private-MAC:`, is not a path's
 *  (MAC_NEXT). */
const PATH_THEN_RUN = /^[A-Za-z0-9_.\-/\\]{0,96}?(?::|-\d{1,9}-|\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/
/** What stands between the last private line and the name of the MAC line when the file's lines are joined by a few characters of punctuation. */
const MAC_NEXT = /^[^A-Za-z0-9+/=]{0,3}Private-MAC/
/** Whether the run that ends at `e` is a listing's path, not a payload: a separator follows it at once, or only more of the path
 *  does, up to the line's end `limit`. (A path longer than a key line has a long piece in front of its `_key.asc:4:`; on the
 *  blank line of an armored key and in front of an END marker it is the only base64 there is, and taken as the key's last line it
 *  tips a short key, an Ed25519 one of 64 characters, over the randomness test.) */
function isPathRun(text: string, e: number, limit: number): boolean {
  if (LISTING_SEP.test(text.slice(e, e + 24))) return true
  const rest = text.slice(e, Math.min(limit, e + 112))
  return PATH_REST_SEP.test(rest) || (limit - e <= 112 && PATH_REST_END.test(rest))
}
const DER_TYPES: readonly string[] = ['pkcs8', 'encrypted-pkcs8', 'pkcs1-or-dsa', 'sec1']

function ruleFor(kind: string, marker: string): string {
  if (marker.startsWith('---- BEGIN SSH2')) return 'ssh2_private_key'
  if (marker.includes('OpenVPN')) return 'openvpn_static_key'
  if (kind === 'PGP ') return 'gpg_block'
  if (kind === 'DSA ') return 'ssh_dsa_pubkey' // main's id for the DSA kind, kept for the audit log
  return 'private_key'
}

/** A line's frame around its payload run, normalised: digits as 0, a listing's `:N:` and `-N-`
 *  alike, so the lines of one listing or one literal share a frame. */
const frameOf = (s: string): string => s.replace(/\d+/g, '0').replace(/\s+/g, ' ').replace(/[:-](0)[:-]/g, ':0:')
/** The frame of the run at r0 on the line from lineStart: normalised over up to 512 characters
 *  first, then cut to its last 64. Cut first, a listing prefix longer than 64 characters shifted
 *  by one where the line number gained a digit (line 9 to line 10), the frames differed, and the
 *  key's block ended there. */
const frameAt = (text: string, lineStart: number, r0: number): string => frameOf(text.slice(Math.max(lineStart, r0 - 512), r0)).slice(-64)
/** Frames compared with ':' and '-' alike: frameOf's `:N:`/`-N-` rule depends on where a cut fell in a
 *  timestamp (or a listing's number). */
const loose = (x: string): string => x.replace(/-/g, ':')

const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
const isBlank = (c: number): boolean => c === 32 || c === 9
/** JavaScript's `\s`. */
const isSpace = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
/** Whether `s` holds two words (3 or more ASCII letters each) with blanks between them: what
 *  /[A-Za-z]{3,}[ \t]+[A-Za-z]{3,}/ finds (`anySpace`: with `\s+` between), read once. (The regex, tried from each
 *  letter of a long run of them, cost n * n: a line of 40,000 letters took 2 seconds.) */
export function hasWords(s: string, anySpace = false): boolean {
  const space = anySpace ? isSpace : isBlank
  const n = s.length
  let i = 0
  while (i < n) {
    if (!isLetter(s.charCodeAt(i))) {
      i++
      continue
    }
    const a = i
    while (i < n && isLetter(s.charCodeAt(i))) i++
    if (i - a < 3 || i >= n || !space(s.charCodeAt(i))) continue
    let j = i + 1
    while (j < n && space(s.charCodeAt(j))) j++
    if (j + 2 < n && isLetter(s.charCodeAt(j)) && isLetter(s.charCodeAt(j + 1)) && isLetter(s.charCodeAt(j + 2))) return true
  }
  return false
}

// With no END line, a key's last line can be shorter than a payload run, so the block's last run
// leaves it behind. These take it (see scanBlock).
const SHORT_TAIL = /^([A-Za-z0-9+/]{1,15}={0,2})[\s"'`,;+&_.)\]}|\\]*$/
const CRC_LINE = /^=[A-Za-z0-9+/]{4}[\s"'`,;+&_.)\]}|\\]*$/
/** A code literal's `" +`, `" .`, `" & _` or `",` left between two lines. */
const FRAGMENT = /^[\s"'`,;+.&_)\]}|\\]*$/
// (a match starts where a base64 run does, and takes it whole: `+` is a joiner too, and tried from each
// of a run of n `+` with the joiners after it, the ways of splitting it cost n * n * n)
export const LINE_END_RUN = /(?<![A-Za-z0-9+/=])(?=([A-Za-z0-9+/=]+))\1[\s"'`,;+&_.)\]}|\\]*$/
/** Newline constants a literal is joined with: VB's `& vbCrLf & _`, C#'s `+ Environment.NewLine +`.
 *  They count as joiners: blanked to spaces of the same length, so offsets hold. Only standing
 *  apart from the base64 around them (a `+` may join them): random base64 holds vbLf about once in
 *  270,000 characters, inside a key's line. */
const NL_CONST = /(?<![A-Za-z0-9/=_])(?:vbCrLf|vbNewLine|vbLf|Environment\.NewLine|System\.lineSeparator\(\)|os\.linesep|PHP_EOL)(?![A-Za-z0-9/=_])/g
const blankNl = (s: string): string => s.replace(NL_CONST, (x) => ' '.repeat(x.length))
/** What follows a value on its line, to be compared with what follows another line's: colour codes as blanks, digits
 *  (a line number) as 0, `>>` as `>` (an echo into a file starts it with `>` and adds the rest with `>>`), no blanks
 *  at either end. */
const tailForm = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, ' ').replace(/\d+/g, '0').replace(/>>/g, '>').trim()
/** The written-out line breaks nextBreak reads, as answers write them. */
const ESC_FORMS = ['<br>', '<br/>', '<br />', '\\n', '\\r', '\\u000a', '\\u000A', '\\x0a', '\\x0A', '%0A', '%0a', '&#xA;', '&#xa;', '&#x0A;', '&#10;', '`n', '`r']
/** Whether `s` is what a cut left of a written-out line break (`br>` of `<br>`). */
const escTail = (s: string): boolean => s !== '' && ESC_FORMS.some((f) => f.length > s.length && f.endsWith(s))
const NL_NAMES = ['vbCrLf', 'vbNewLine', 'vbLf', 'Environment.NewLine', 'System.lineSeparator()', 'os.linesep', 'PHP_EOL']
// The joiners at the end of a string, found from the start of their run. (`[…]+$` is tried from each of a run of n before a
// character that is none, and fails n times: n * n. A match cannot start inside a run, and the one that ends the string
// starts a run, so the result is the same.)
export const TRAILING_NL_JOINERS = /(?<![\s"'`,;+&_])[\s"'`,;+&_]+$/
export const TRAILING_HEAD_JOINERS = /(?<![\s"'`,;+.&_\\$])[\s"'`,;+.&_\\$]+$/
export const TRAILING_BLANKS = /(?<!\s)\s+$/
export const TRAILING_LINE_BREAKS = /(?<![\r\n])[\r\n]+$/
/** Whether `s` is what a cut left of a newline constant, and the joiners after it (`tor() +`). */
const nlTail = (s: string): boolean => {
  const t = s.replace(TRAILING_NL_JOINERS, '')
  return t !== '' && NL_NAMES.some((n) => n.endsWith(t))
}
/** What joins the lines of a key written on one line: a space, a literal's `","` or `' '`. */
const ONE_LINE_SEP = /^[ \t"'`,;+]{1,8}$/
const SAME_LINE_TAIL = /^([A-Za-z0-9+/]{1,15}={0,2})(?![A-Za-z0-9+/=])/
const CRC_RUN = /^=[A-Za-z0-9+/]{4}(?![A-Za-z0-9+/=])/

/** With no END line, where a key's last line ends when that line is shorter than a payload run: the
 *  next logical line, when it is directly under the last key line (ending at `at`), in the key
 *  lines' `frame`, and holds nothing but 1-15 base64 characters (with = padding) and joiners; and a
 *  PGP checksum line (=XXXX) right under that. A literal's joiner-only fragment between two lines is
 *  stepped over once. `right`: what follows each key line's base64 when it is the same on the last
 *  two and is not joiners (cat -A's `$`, the `' >> key.pem` of an echo per line), which the short
 *  line ends with too. `full`: the last key line is as wide as the others; when it is shorter, it
 *  was the key's last, and only a checksum line can follow. `end`: where the last line ends, `at` when there is none; `chars`: how many
 *  base64 characters the short line holds (0 when there is none). */
function shortLastLine(text: string, at: number, frame: string, right: string, full: boolean): { end: number; chars: number } {
  let tailEnd = at
  let chars = 0
  let took = false
  let skipped = 0
  for (let guard = 0; guard < 5; guard++) {
    const br = nextBreak(text, at, Math.min(text.length, at + 96))
    if (!br) break
    const after = text.slice(at, br[0])
    if (!FRAGMENT.test(blankNl(after)) && (right === '' || after !== right)) break
    const nb = nextBreak(text, br[1], Math.min(text.length, br[1] + 600))
    const ls = br[1]
    const le = nb ? nb[0] : Math.min(text.length, br[1] + 600)
    const raw = text.slice(ls, le)
    const line = blankNl(right !== '' && raw.endsWith(right) ? raw.slice(0, raw.length - right.length) : raw)
    if (FRAGMENT.test(line)) {
      if (skipped++ >= 1) break
      at = le
      continue
    }
    // its frame: what comes before the base64, as the key lines' frame is measured
    const m = LINE_END_RUN.exec(line)
    if (!m) break
    const from = valueStart(line, m.index, m.index + m[1].length)
    // (behind a name, a checksum line's own `=` is the last one: `line==0TKB`, framed `line=`)
    const crc = from > m.index ? from - 1 : from
    const framed = (to: number): boolean => frameAt(text, ls, ls + to) === frame || JOINER_FRAME.test(line.slice(0, to))
    if (!framed(from) && !framed(crc)) break
    const short = took || !full || !framed(from) ? null : SHORT_TAIL.exec(line.slice(from))
    if (short) {
      tailEnd = ls + from + short[1].length
      chars = short[1].length
      at = tailEnd
      took = true
      skipped = 0
      continue
    }
    if (framed(crc) && CRC_LINE.test(line.slice(crc))) tailEnd = ls + crc + 5
    break
  }
  return { end: tailEnd, chars }
}

/** The end of the line right under a DER key's last line (ending at `at`) that holds exactly the `lack` base64 characters the key's declared length
 *  still lacks (under a payload run, so no run found it), as a key's short last line is taken (shortLastLine), or -1. With one line of the key in
 *  view there is no width to tell its last line by, but the DER says how long that line is: a word of other length under it is not the key's.
 *  `glue`: what a frame glues onto each line's base64 (a diff's `+`), which the key's lines start with and which is not the key's. */
function lackedLine(text: string, at: number, frame: string, lack: number, glue: string): number {
  const br = nextBreak(text, at, Math.min(text.length, at + 96))
  const own = br ? text.slice(at, br[0]) : ''
  const { end, chars } = shortLastLine(text, at, frame, FRAGMENT.test(blankNl(own)) ? '' : own, true)
  return chars - (text.startsWith(glue, end - chars) ? glue.length : 0) === lack ? end : -1
}

/** Whether `payload` base64 characters (the first `st.offset` of them a frame glued on) are the whole of the DER key `st`: 90% of the
 *  length it declares, or, with its END line under them (`closed`), all but a last line under a payload run, which no run counts
 *  (an ML-DSA seed-only PKCS#8 is 54 bytes, 72 characters: 64 and 8 in a PEM file). */
function wholeDer(st: Structure & { offset: number }, payload: number, closed: boolean): boolean {
  const chars = payload - st.offset
  return Math.floor((chars * 3) / 4) >= st.declared * 0.9 || (closed && Math.ceil(st.declared / 3) * 4 - chars < MIN_RUN)
}

/** The key block whose BEGIN marker is [b, me): its payload lines, END line, and class. */
function scanBlock(
  text: string,
  b: number,
  me: number,
  kind: string,
  marker: string,
  nextMark: (at: number) => number | null,
  nextBr: (i: number, limit: number) => Run | null,
): KeyBlock {
  const rule = ruleFor(kind, marker)
  const end = Math.min(text.length, me + MAX_BLOCK)
  const runs: Run[] = []
  const frames: string[] = []
  const headers: string[] = []
  let endAt = -1
  let endEnd = -1
  let lastPayloadEnd = -1
  let gap = 0
  let lineStart = me
  let width = 0
  let closed = false
  let stopped = -1
  while (lineStart < end) {
    const br = nextBr(lineStart, end)
    const lineEnd = br ? br[0] : end
    // A marker on this line: an END closes the block; another BEGIN ends it unclosed.
    const nm = nextMark(lineStart)
    const mk = nm !== null && nm < lineEnd ? nm : -1
    const contentEnd = mk !== -1 ? mk : lineEnd
    let lineRuns = runsIn(text, lineStart, contentEnd)
    // Armor and PEM headers before the key are never payload. A key written on one line carries
    // its payload after them on the same line, so only what follows the header's value counts:
    // runs of 40 or more, and a last, shorter one after such a run (the key's last line).
    if (runs.length === 0 && contentEnd - lineStart < 4096) {
      const line = text.slice(lineStart, contentEnd)
      const hdr = HEADER_WORD.exec(line)
      if (hdr) {
        headers.push(line.slice(hdr.index))
        const dek = DEK_RE.exec(line)
        const after = lineStart + (dek ? dek.index + dek[0].length : hdr.index + hdr[0].length)
        const afterHdr = lineRuns.map(([s, e]): Run => (s < after && e > after ? [after, e] : [s, e])).filter(([s]) => s >= after)
        lineRuns = afterHdr.filter(([s, e], i) => e - s >= 40 || (i === afterHdr.length - 1 && i > 0 && afterHdr[i - 1][1] - afterHdr[i - 1][0] >= 40))
      }
    }
    // A run that a listing separator follows at once (the path of `src/keys/deploy.key:4:`) is
    // part of the line's frame, never its payload: taken as key material, a frame-only line's
    // longest run (a blank or header line in a listing with a long path) set a wrong width.
    lineRuns = lineRuns.filter(([, e]) => !isPathRun(text, e, contentEnd))
    if (lineRuns.length) {
      // A key line's payload is the last run on its line when only joiners follow it (a listing's
      // prefix comes before, a literal's closing quote after), else the longest. Several runs on
      // one line only when nothing but joiners sits between them (a key written on one line).
      const last = lineRuns[lineRuns.length - 1]
      let picked: Run[] = [JOINERS.test(text.slice(last[1], contentEnd)) ? last : lineRuns.reduce((x, y) => (y[1] - y[0] >= x[1] - x[0] ? y : x))]
      if (lineRuns.length > 1) {
        const between = lineRuns.slice(1).map((r, i) => text.slice(lineRuns[i][1], r[0]))
        if (between.every((g) => /^[\s"'`,;+]{0,8}$/.test(g))) picked = lineRuns
      }
      // A key's lines share one width, all but the last, and from the second on one frame: a
      // line that breaks either is not the key's, and the body ends before it.
      let ended = false
      for (const r of picked) {
        const w = r[1] - r[0]
        const prev = runs.length ? runs[runs.length - 1][1] : -1
        const fr = frameAt(text, Math.max(lineStart, prev), r[0])
        // (a first line narrower than the second was re-wrapped: the second sets the width)
        if (runs.length > 0 && (closed || (w > width && runs.length > 1) || (runs.length >= 2 && fr !== frames[1]))) {
          ended = true
          break
        }
        if (runs.length === 0 || w > width) width = w
        else if (w < width) closed = true
        runs.push(r)
        frames.push(fr)
      }
      // (the first run picked is always taken: an empty body takes any width and frame)
      lastPayloadEnd = runs[runs.length - 1][1]
      gap = 0
      if (ended) {
        stopped = lineStart
        break
      }
    } else {
      gap += lineEnd - lineStart + (br ? br[1] - br[0] : 0)
      if (runs.length === 0 && lineEnd - me > MAX_LEAD) break
      if (runs.length > 0 && gap > MAX_GAP) break
    }
    if (mk !== -1) {
      // (only a private key's END line closes it: a key whose own is missing ends at its last line, and the END line of a
      // certificate or a public key after it is not the key's)
      CLOSING_END.lastIndex = mk
      if (CLOSING_END.test(text)) {
        endAt = mk
        const four = text.startsWith('---- END ', mk)
        const close = four ? text.indexOf(' ----', mk + 9) : text.indexOf('-----', mk + 9)
        endEnd = close === -1 || close > lineEnd ? lineEnd : close + 5
      }
      break
    }
    if (!br) break
    lineStart = br[1]
  }
  const payload = runs.reduce((n, [s, e]) => n + e - s, 0)
  // With no END line, a key's last line can be shorter than a payload run, and it was left behind
  // (a PGP export or a re-wrapped PEM key crossed with it). Only after a last run as wide as the
  // others: a shorter one was the key's last line, and the word or line after it is not the key's
  // (only a PGP checksum is).
  let tailEnd = lastPayloadEnd
  if (endAt === -1 && runs.length >= 2) {
    // A key written on one line, its lines joined by a space or a literal's `","`, has its short
    // last line (and a PGP checksum) on that line: after the last full one, as that came after the
    // one before it. (Else a PGP export written so crossed with its last line when that line ran 8
    // to 15 characters.)
    const sep = text.slice(runs[runs.length - 2][1], runs[runs.length - 1][0])
    if (ONE_LINE_SEP.test(sep)) {
      const short = !closed && text.startsWith(sep, tailEnd) ? SAME_LINE_TAIL.exec(text.slice(tailEnd + sep.length, tailEnd + sep.length + 24)) : null
      if (short) tailEnd += sep.length + short[1].length
      if (text.startsWith(sep, tailEnd) && CRC_RUN.test(text.slice(tailEnd + sep.length, tailEnd + sep.length + 6))) tailEnd += sep.length + 5
    }
    if (tailEnd === lastPayloadEnd) {
      // What follows the base64 on the last two key lines, when that is the same on both and is
      // not joiners: a listing's per-line suffix, which the short line carries too.
      const rest = (e: number): string | null => {
        const br = nextBreak(text, e, Math.min(text.length, e + 96))
        return br ? text.slice(e, br[0]) : null
      }
      const right = rest(runs[runs.length - 2][1])
      tailEnd = shortLastLine(text, lastPayloadEnd, frames[frames.length - 1], right !== null && right === rest(lastPayloadEnd) && !FRAGMENT.test(blankNl(right)) ? right : '', !closed).end
    }
  }
  const endOfKey = endAt !== -1 && runs.length ? endEnd : tailEnd
  const scanEnd = endAt !== -1 ? endEnd : Math.max(lastPayloadEnd, me)
  const span = (cls: KeySpan['cls'], why: string, end = endOfKey): KeyBlock => ({
    rule,
    cls,
    why,
    from: b,
    to: cls === 'flag' ? me : end,
    scanEnd,
    ...(endAt === -1 && stopped !== -1 ? { rest: stopped } : {}),
  })

  if (rule === 'openvpn_static_key') {
    // The file's own shape: lines of exactly 32 hex digits (or its 512 in one run, the line breaks taken out), a
    // frame in front and, after them, joiners (a key written on one line: the next value after a space, and
    // whatever follows the last) or what follows the BEGIN line's marker (a script that echoes each line into a
    // file, a table row, a tag around each line writes the same after each). A list of digests (sha256sums: 64
    // digits; md5sums: 32 and a file name, another on every line) is not one, however random its digits look.
    // (what follows the BEGIN line's marker: worked out when a line of 32 digits first needs it, not for every header)
    let beginTailMemo: string | null = null
    const beginTailOf = (): string => {
      if (beginTailMemo === null) {
        const beginBr = nextBreak(text, me, Math.min(text.length, me + 1024))
        beginTailMemo = tailForm(text.slice(me, beginBr ? beginBr[0] : Math.min(text.length, me + 1024)))
      }
      return beginTailMemo
    }
    const hex = runs
      .map(([s, e]) => {
        const one = /^[^0-9a-fA-F]{0,16}([0-9a-fA-F]{512})$/.exec(text.slice(s, e))
        // (only right under the BEGIN line, with a frame and written-out line breaks between and no word: a modulus, a signature or a digest a
        // sentence later is a hex number in prose, not the key with its line breaks taken out)
        if (one && s - me <= MAX_ONE_RUN_LEAD && !/[A-Za-z]/.test(blankNl(text.slice(me, s).replace(ESC_ALL_RE, ' ')))) return one[1]
        // (a frame glued on: a diff's +, a coloured diff's `32m+`)
        const v = text.slice(s, e).replace(/^(?:\d{1,3}m)?[^0-9a-fA-F]{0,3}(?=[0-9a-fA-F]{32}$)/, '')
        if (v.length !== 32 || !/^[0-9a-f]+$/i.test(v)) return ''
        const br = nextBreak(text, e, Math.min(text.length, e + 1024))
        const stop = Math.min(br ? br[0] : text.length, nextMark(e) ?? text.length, e + 1024)
        const rest = blankNl(text.slice(e, stop)).replace(/\x1b\[[0-9;]*m/g, ' ')
        return /^[\s"'`,;+]{1,8}\+?[0-9a-fA-F]{32}(?![A-Za-z0-9+/=])/.test(rest) || KEY_LINE_TAIL.test(rest) || tailForm(rest) === beginTailOf() ? v : ''
      })
      .join('')
    return hex.length >= 256 && looksRandom(hex) ? span('remove', 'openvpn-hex') : span('flag', 'openvpn-header')
  }
  if (runs.length === 0) return span('flag', 'header-only')
  // A structure counts only under a BEGIN line of its own kind: OpenPGP packets under PGP, the
  // OpenSSH blob under OPENSSH, SSH2's magic under SSH2, DER under every other kind. A chance match
  // of random bytes to a packet header under another kind's line does not make it verified. (A
  // public key, certificate or CSR under a private BEGIN line decodes to none of these.)
  const family: readonly string[] = marker.startsWith('---- BEGIN SSH2') ? ['ssh2'] : kind === 'PGP ' ? ['pgp'] : kind === 'OPENSSH ' ? ['openssh'] : DER_TYPES
  // (a first run narrower than the second, with a third behind them, may belong to a line that holds no payload: a listing's blank
  // armor line shows only its path, `src/main/resources/keys/deploy:4:`, whose first piece is a run. The head is then read without it.)
  const st0 = decodeHead(text, runs) ?? (runs.length >= 3 && runs[0][1] - runs[0][0] < runs[1][1] - runs[1][0] ? decodeHead(text, runs.slice(1)) : null)
  const st = st0 && family.includes(st0.type) ? st0 : null
  const random = bodyLooksRandom(runs.map(([s, e]) => text.slice(s, e)).join(''), st)
  if (st) {
    if (st.declared > 0) {
      // (no END line, and what the declared length lacks, under a payload run, is the line right under the key's last: that line is the key's)
      const size = Math.ceil(st.declared / 3) * 4
      const lack = size - (payload - st.offset)
      const lacked = endAt === -1 && lack < MIN_RUN ? lackedLine(text, lastPayloadEnd, frames[frames.length - 1], lack, text.slice(runs[runs.length - 1][0], runs[runs.length - 1][0] + st.offset)) : -1
      // (64 characters are the least a private key is: an Ed25519 key's 48 bytes. The key says how long it is, and one wrapped to a width that leaves a
      // last line under a payload run, which no run counts, has fewer than that in its runs: 51 to 62 at a width of 17 to 21 or 25 to 31.)
      if ((lacked !== -1 || wholeDer(st, payload, endAt !== -1)) && (payload >= 64 || size >= 64) && random) return span('remove', `${st.type}-complete`, Math.max(lacked, endOfKey))
      if (endAt === -1 && payload >= LONG_PAYLOAD && random) return span('remove', `${st.type}-prefix`) // cut short
      // A verified private-key header over a random body of two lines or more: an excerpt of a
      // real key's own bytes.
      if (runs.length >= 2 && payload >= 80 && random) return span('remove', `${st.type}-incomplete`)
      // Or over one line that already holds the key's private value: `head -2 key.pem` of an EC or
      // EdDSA key shows a SEC1 key's whole scalar, a PKCS#8 key's first 12 bytes of it. (An RSA, DSA or
      // encrypted key's first line holds a modulus or parameters: a documentation example.)
      if (runs.length === 1 && st.priv !== undefined) {
        const [from, to] = st.priv
        const line = text.slice(runs[0][0] + st.offset, runs[0][1])
        const seen = Math.min(to, Math.floor((line.length * 3) / 4))
        // (only the characters that are the value's alone: those a header or a following field shares are not)
        if (seen - from >= 12 && looksRandomToken(line.slice(Math.ceil((from * 4) / 3), Math.floor((seen * 4) / 3)))) return span('remove', `${st.type}-line`)
      }
      return span('flag', `${st.type}-example`)
    }
    // OpenSSH, SSH2 and OpenPGP carry no overall length: the magic or the packet header anchors
    // them. A verified OpenSSH blob or OpenPGP packet is not asked to look random: a real
    // `gpg --export-secret-keys -a` of a key with a photo ID carries the image header's 12 reserved
    // zero bytes (16 `A`s) in its first 4,096 characters, and failed looksRandom whole.
    if ((st.type === 'openssh' || st.type === 'pgp') && payload >= LONG_PAYLOAD) return span('remove', st.type)
    if (payload >= LONG_PAYLOAD && random) return span('remove', st.type)
    return runs.length >= 2 && payload >= 80 && random ? span('remove', `${st.type}-short`) : span('flag', `${st.type}-example`)
  }
  const legacy = headers.some((h) => /Proc-Type: ?4,ENCRYPTED/.test(h)) && headers.some((h) => DEK_RE.test(h))
  if (legacy && payload >= 64 && random) return span('remove', 'pem-encrypted-headers')
  // Key-shaped but in no format the screen can check, or no key material at all: left in, and
  // named in a note, as everything else that only looks like a key.
  return span('flag', random ? 'unverified' : 'not-key-material')
}

/** Every key block whose BEGIN line starts at `start` or after. */
export function keyBlocks(text: string, start = 0): KeyBlock[] {
  const out: KeyBlock[] = []
  const nextMark = markerCursor(text)
  const nextBr = breakCursor(text)
  const re = new RegExp(BEGIN_RE.source, 'g')
  re.lastIndex = start
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const s = scanBlock(text, m.index, m.index + m[0].length, m[1] ?? '', m[0], nextMark, nextBr)
    out.push(s)
    if (s.to > re.lastIndex) re.lastIndex = s.to
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// A key's tail with no BEGIN line in view (K4): random base64 lines ending at a private-key END
// line, at the top of what is screened or right under a key block taken.
// ---------------------------------------------------------------------------------------------
const END_RE = /-----END ((?:[A-Z0-9]+ ){0,3})PRIVATE KEY(?: BLOCK)?-----|---- END SSH2 ENCRYPTED PRIVATE KEY ----/g
// One partial line: its frame, its base64, then what ends a key line (an escaped break as nextBreak
// reads them, a closing quote, a concatenation, PHP's `" .`, VB's `& _`, cat -A's `$`, Python's or
// Rust's `\` line continuation, one real line break). Newline constants are blanked before it is
// matched. (The continuation is one backslash before the break only: as a character anywhere, it and
// the escapes' `\\+` could share a run of backslashes every way there is.)
const PARTIAL_JOINERS = ' \t"\'`,;+.&_$)]}|'
/** What /^…?([^\r\n]*?)([A-Za-z0-9+/=]*)(trailer)$/ finds in a partial line `s` (the trailer being those
 *  ends of a key line: joiners, written-out breaks, a `\` and one real break): the frame before its
 *  base64 (the shortest there is), and whether the base64 is there. That regex let the frame, the
 *  base64 and the trailer each hold a `+`, which took n * n * n for a line of n of them; here the
 *  positions a trailer can start at are found once, from the end, and the first start of a base64
 *  run that reaches one is the answer. */
export function partialLine(s: string): { frame: string; run: boolean } | null {
  const n = s.length
  const s0 = s.charCodeAt(0) === 0x2026 ? 1 : 0
  const endOk = (p: number): boolean => p === n || (p === n - 1 && (s.charCodeAt(p) === 10 || s.charCodeAt(p) === 13)) || (p === n - 2 && s.charCodeAt(p) === 13 && s.charCodeAt(p + 1) === 10)
  const hex = (p: number): boolean => p < n && 'aAdD'.includes(s[p])
  const trailer = new Uint8Array(n + 2) // s[p..] is a trailer
  const backslashes = new Int32Array(n + 2) // the backslashes from p on
  for (let p = n; p >= 0; p--) {
    if (p < n && s.charCodeAt(p) === 92) backslashes[p] = backslashes[p + 1] + 1
    let ok = endOk(p) || (p < n && s.charCodeAt(p) === 92 && endOk(p + 1))
    if (!ok && p < n) {
      const c = s[p]
      if (PARTIAL_JOINERS.includes(c) && trailer[p + 1]) ok = true
      if (c === '\\') {
        const q = p + backslashes[p]
        if ((s[q] === 'n' || s[q] === 'r') && trailer[q + 1]) ok = true
        else if (s.startsWith('u000', q) && hex(q + 4) && trailer[q + 5]) ok = true
        else if (s.startsWith('x0', q) && hex(q + 2) && trailer[q + 3]) ok = true
      } else if (c === '%') {
        if (s[p + 1] === '0' && hex(p + 2) && trailer[p + 3]) ok = true
      } else if (c === '&') {
        if (s.startsWith('&#x0', p) && hex(p + 4) && s[p + 5] === ';' && trailer[p + 6]) ok = true
        else if (s.startsWith('&#x', p) && hex(p + 3) && s[p + 4] === ';' && trailer[p + 5]) ok = true
        else if ((s.startsWith('&#10;', p) || s.startsWith('&#13;', p)) && trailer[p + 5]) ok = true
      } else if (c === '<' && s.startsWith('<br', p)) {
        let q = p + 3
        while (q < n && /\s/.test(s[q])) q++
        if (s[q] === '/') q++
        if (s[q] === '>' && trailer[q + 1]) ok = true
      } else if (c === '`') {
        if ((s[p + 1] === 'n' || s[p + 1] === 'r') && trailer[p + 2]) ok = true
      }
    }
    trailer[p] = ok ? 1 : 0
  }
  const nextTrailer = new Int32Array(n + 2) // the first position at or after p that a trailer starts at
  const runEnd = new Int32Array(n + 2) // the end of the base64 run at p
  nextTrailer[n + 1] = Number.MAX_SAFE_INTEGER
  for (let p = n; p >= 0; p--) {
    nextTrailer[p] = trailer[p] ? p : nextTrailer[p + 1]
    runEnd[p] = p < n && isB64(s.charCodeAt(p)) ? runEnd[p + 1] : p
  }
  let firstBreak = s0
  while (firstBreak < n && s.charCodeAt(firstBreak) !== 10 && s.charCodeAt(firstBreak) !== 13) firstBreak++
  for (let p = s0; p <= firstBreak; p++) {
    if (nextTrailer[p] <= runEnd[p]) return { frame: s.slice(s0, p), run: runEnd[p] > p }
  }
  return null
}

/** Payload lines read forward from `s`: one width (the last may be shorter), one frame.
 *  `partialHead`: the first line is not one of the key's full lines (what another computer's cut
 *  left of one at the start of a text, or the uneven line a key block stopped at): the second
 *  sets the width. */
function leadingRun(text: string, s: number, limit: number, partialHead = false): Run[] {
  const runs: Run[] = []
  let width = 0
  let frame = ''
  let lineStart = s
  let gap = 0
  while (lineStart < limit) {
    const br = nextBreak(text, lineStart, limit)
    const lineEnd = br ? br[0] : limit
    // (a run that a listing separator follows at once is a path's, as in scanBlock: a path longer than a key line is the longest run)
    const lr = runsIn(text, lineStart, lineEnd, 8).filter(([, e]) => !isPathRun(text, e, lineEnd))
    if (lr.length) {
      const r = lr.reduce((x, y) => (y[1] - y[0] >= x[1] - x[0] ? y : x))
      const w = r[1] - r[0]
      const f = frameAt(text, lineStart, r[0])
      if (runs.length === 0) {
        width = w
        frame = f
      } else if (partialHead && runs.length === 1 && w > width) {
        // the first line was the cut's partial one: the key's lines are as wide as the second
        width = w
        frame = f
      } else if (w > width || (runs.length > 1 && f !== frame)) {
        break
      }
      runs.push(r)
      if (w < width) break
      if (hasWords(text.slice(r[1], Math.min(lineEnd, r[1] + 256)), true)) break
      gap = 0
    } else {
      gap += lineEnd - lineStart
      // (the first line of a text another computer cut: its ellipsis alone, or with the few
      // characters the cut left of a key line)
      if (gap > 64 || (runs.length === 0 && !(partialHead && lineStart === s && /^…?[A-Za-z0-9+/=]{0,7}\s*$/.test(text.slice(lineStart, lineEnd))))) break
    }
    if (!br) break
    lineStart = br[1]
  }
  return runs
}

/** Where a line break that ends at `s` starts, or -1: a real one, or one written out as nextBreak
 *  reads them (the escapes of ESC_RE: `\n`, `\\n`, `\r`, the Unicode or hex escape of a line
 *  feed, %0A, &#xA;, <br>, PowerShell's `n). Looks back 7 characters at most (and over a run of
 *  backslashes), never past floor. */
function breakEndingAt(text: string, s: number, floor: number): number {
  if (s <= floor) return -1
  const c = text.charCodeAt(s - 1)
  if (c === 10) return s - 2 >= floor && text.charCodeAt(s - 2) === 13 ? s - 2 : s - 1
  if (c === 13) return s - 1
  // (an escape ends in n or r, a, A, d or D, a ; or a >)
  if (c !== 110 && c !== 114 && c !== 97 && c !== 65 && c !== 100 && c !== 68 && c !== 59 && c !== 62) return -1
  for (let b = s - 2; b >= Math.max(floor, s - 7); b--) {
    const d = text.charCodeAt(b)
    if (d !== 92 && d !== 37 && d !== 38 && d !== 60 && d !== 96) continue
    let a = b
    while (d === 92 && a - 1 >= floor && text.charCodeAt(a - 1) === 92) a--
    const m = escapeAt(text, a)
    if (m && a + m[0].length === s) return a
  }
  return -1
}

/** Start of the logical line holding position i - 1: back to a line break before it, real or
 *  written out (breakEndingAt), never past floor. */
function logicalLineStart(text: string, i: number, floor: number): number {
  let s = i
  while (s > floor && breakEndingAt(text, s, floor) === -1) s--
  return s
}

/** From the start `s` of a logical line, back over the break before it to the end of the line
 *  above: every real line break (a blank line is no line), then one written out, a written-out
 *  \r\n as one. */
function stepBack(text: string, s: number, floor: number): number {
  let e = s
  while (e > floor && (text.charCodeAt(e - 1) === 10 || text.charCodeAt(e - 1) === 13)) e--
  const b = breakEndingAt(text, e, floor)
  if (b === -1) return e
  const r = breakEndingAt(text, b, floor)
  return r !== -1 && /^\\+r$/.test(text.slice(r, b)) ? r : b
}

/** What may follow a key line's base64 on its line, newline constants blanked: joiners, a code
 *  literal's `" & vbCrLf & _` or `" + System.lineSeparator()`, and cat -A's `$`. */
const KEY_LINE_TAIL = /^[\s"'`,;+&_)\]}|\\$]*$/
/** A key's last line of 1-7 characters, which holds no run of 8 (every P-521 PKCS#8 key's): in `s`,
 *  where the first 1-7 base64 characters (and up to two `=`) that only KEY_LINE_TAIL follows start,
 *  and how many of them there are. What /([A-Za-z0-9+/]{1,7}={0,2})[\s"'`,;+&_)\]}|\\$]*$/ finds, longest
 *  first: that regex reads the joiners after it from every start, and a `+` is a joiner too, so a
 *  line of them took n * n. Here the joiners at the end are measured once, and no start before
 *  the 9 characters that can reach them is tried. */
const SHORT_JOINER = /[\s"'`,;+&_)\]}|\\$]/
export function shortAbove(s: string): { index: number; length: number } | null {
  let joined = s.length
  while (joined > 0 && SHORT_JOINER.test(s[joined - 1])) joined--
  const base64 = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47
  for (let at = Math.max(0, joined - 9); at < s.length; at++) {
    let k = 0
    while (k < 7 && at + k < s.length && base64(s.charCodeAt(at + k))) k++
    for (let g = k; g >= 1; g--) {
      let pad = 0
      while (pad < 2 && s.charCodeAt(at + g + pad) === 61) pad++
      for (let x = pad; x >= 0; x--) if (at + g + x >= joined) return { index: at, length: g + x }
    }
  }
  return null
}
/** What an escaped break leaves of a code literal's line between two key lines: joiners, and PHP's
 *  `" .` (a dot right after the closing quote; a line of dots is no literal's). */
const FRAGMENT_LINE = /^[\s"'`,;+&_)\]}|\\]*(?:["'`]\s*\.[\s"'`,;+&_)\]}|\\]*)?$/

/** The key lines that end right above a private-key END line at `at`, found by walking back one
 *  logical line at a time while lines keep the width and frame of the key's full lines. Reaches
 *  back as far as a key block runs (MAX_BLOCK), never past `floor`. `last.short`: set to the
 *  length of the key's last line when it is 1-7 characters, which the walk steps over. */
function tailAbove(text: string, at: number, floor: number, last?: { short: number }): Run[] {
  const runs: Run[] = []
  let width = 0
  let frame = ''
  let tail = ''
  let skipped = false
  let shortFrame: string | null = null
  let shortLen = 0
  let e = at
  for (let n = 0; e > floor && n < 65536; n++) {
    const s = logicalLineStart(text, e, floor)
    // (a newline constant is no run: `System.lineSeparator()` after a Java literal's key line)
    const lr = runsIn(blankNl(text.slice(s, e)), 0, e - s, 8)
    const last: Run | undefined = lr.length ? [s + lr[lr.length - 1][0], s + lr[lr.length - 1][1]] : undefined
    // The END line's own prefix is its frame (a listing's path:N:, a quote, an indent), not a key
    // line, unless a key run is glued to the END marker: step over it.
    if (n === 0 && !(last && last[1] - last[0] >= 16 && JOINERS.test(text.slice(last[1], e)))) {
      e = stepBack(text, s, floor)
      continue
    }
    const after = last ? blankNl(text.slice(last[1], e)) : ''
    if (!last || !KEY_LINE_TAIL.test(after)) {
      // A joiner-only line, or an OpenPGP armor checksum (=XXXX), between the last key line and
      // the END line. And a joiner-only fragment between two key lines, which is what an escaped
      // break leaves of a code literal's line (`"...\n" +` reads as the key line `"...` and the
      // fragment `" +`, PHP's `" .`): at most one in a row, of 16 characters at most.
      const seg = text.slice(s, e)
      const joinerOnly = FRAGMENT_LINE.test(blankNl(seg))
      // (the checksum line keeps its listing frame: `deploy.asc:41:=AbCd`, `    41\t=AbCd`, whatever the
      // path in it holds: a run of 16 characters right before the `=` is a key line that has one glued on,
      // not a frame)
      // (in any of the key lines' joinings: a literal's `" + System.lineSeparator()`, cat -A's `$`)
      const checksum = runs.length === 0 && /=[A-Za-z0-9+/]{4}[\s"'`,;+&_.)\]}|\\$]*$/.test(blankNl(seg)) && !/[A-Za-z0-9+/]{16}$/.test(seg.slice(0, seg.lastIndexOf('=')))
      if ((runs.length === 0 && (joinerOnly || checksum)) || (runs.length > 0 && joinerOnly && seg.length <= 16 && !skipped)) {
        if (runs.length > 0) skipped = true
        e = stepBack(text, s, floor)
        continue
      }
      // The key's last line, when it is 1-7 characters (an OpenSSH or PGP file whose base64 runs
      // that far past a full line): once, before any key line, under one in its frame.
      const short = runs.length === 0 && shortFrame === null ? shortAbove(blankNl(seg)) : null
      if (short) {
        shortFrame = seg.slice(0, short.index)
        shortLen = short.length
        e = stepBack(text, s, floor)
        continue
      }
      break
    }
    skipped = false
    const w = last[1] - last[0]
    const f = frameAt(text, s, last[0])
    if (runs.length === 0) {
      // (the short last line stepped over is in this line's frame; where the cut took this line's
      // start, its frame ends with what is left of it)
      if (shortFrame !== null) {
        const sf = frameOf(shortFrame.slice(-512)).slice(-64)
        // (':' and '-' alike, as at the top of a cut text: frameOf's `:N:`/`-N-` rule depends on
        // where the cut fell in a timestamp)
        if (sf !== f && !(s <= floor + 1 && loose(sf).endsWith(loose(f.replace(/^…/, '')))) && !JOINER_FRAME.test(shortFrame)) return []
      }
      runs.push(last) // the last key line, which may be short
    } else if (runs.length === 1) {
      // A key's full lines are as wide as its last one or wider, and at least a payload run wide:
      // the last word on each line of a report (`... as expected`) is no key line, and a report
      // printed above an END line named in prose was taken for a key's tail. What follows their
      // base64 is the same on each (a literal's `" +`, cat -A's `$`).
      if (w < runs[0][1] - runs[0][0] || w < MIN_RUN) break
      width = w
      frame = f
      tail = after
      runs.push(last)
    } else {
      if (w !== width || f !== frame || after !== tail) break
      runs.push(last)
    }
    e = stepBack(text, s, floor)
  }
  if (last && runs.length) last.short = shortLen
  return runs.reverse()
}

/** Two or more lines, 80 characters or more in all, that look random: a key's lines, not words. */
function isKeyRun(text: string, runs: Run[]): boolean {
  if (runs.length < 2) return false
  const all = runs.map(([a, b]) => text.slice(a, b)).join('')
  return all.length >= 80 && looksRandom(all)
}

/** Where a headless key tail's removal starts, or null when its head is in view (so it is not a
 *  tail). `atTop`: the walk's floor is the top of what is screened, not a previous END line. */
function headAnchor(text: string, runs: Run[], floor: number, atTop: boolean, blocks: readonly KeyBlock[]): number | null {
  const ls = logicalLineStart(text, runs[0][0], floor)
  const frame = runs.length > 1 ? frameAt(text, logicalLineStart(text, runs[1][0], floor), runs[1][0]) : ''
  // Right under a key block the detectors took (it stopped where the frame changed). Blocks are
  // sorted and disjoint: binary search for the last one ending at or before the run.
  let lo = 0
  let hi = blocks.length - 1
  let bi = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (blocks[mid].to <= runs[0][0]) {
      bi = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const bk = bi >= 0 ? blocks[bi] : null
  if (bk && bk.cls !== 'flag' && runs[0][0] - bk.to <= 512) {
    const between = text.slice(bk.to, ls)
    if ((between.match(/\r\n|\r|\n|\\n/g) ?? []).length <= 1 && !hasWords(between)) return runs[0][0]
  }
  if (!atTop) return null
  // At the top: nothing above, an ellipsis, or one partial key line (a suffix of the key lines'
  // frame, then base64).
  const above = text.slice(floor, ls)
  if (above.length > 1024) return null
  const m = partialLine(blankNl(above))
  if (!m) return null
  // (':' and '-' alike: frameOf's `:N:`/`-N-` rule depends on where the cut fell in a timestamp)
  const fr = frameOf(m.frame)
  if (fr !== '' && !loose(frame).endsWith(loose(fr)) && !JOINER_FRAME.test(m.frame) && !escTail(m.frame) && !nlTail(above.replace(/^…/, '').trimEnd())) return null
  return m.run ? floor + (above.startsWith('…') ? 1 : 0) + m.frame.length : runs[0][0]
}

/** A tool's own frame in front of an END line, where only one partial key line above it is left
 *  to compare it with: a listing's `path:N:` or `path-N-`, a log line's clock time, a pod's
 *  `[pod/name] ` or compose's `name  | `, a literal's `b"`, `u8"` or `L"`, an echo per line. A
 *  sentence or an assignment that names an END line (`Nothing ends with `, `B = "`) is none of
 *  them. */
const TOOL_FRAME: readonly RegExp[] = [
  /[:-]\d{1,9}[:-]\s?$/,
  /\d{1,2}:\d\d:\d\d/,
  /^\s*\[[^\]\s]{1,128}\]\s$/,
  /^\s*[\w.-]{1,64}\s+\|\s$/,
  /^\s*(?:[bruBRU]{1,2}|u8|L)["']$/,
  /^\s*(?:echo|printf)\s+(?:-[a-z]+\s+)?["']?$/,
]

/** Whether the private-key END marker at `at` is written as the END line of the key lines `runs`
 *  above it, and not named in a sentence or a code constant: the last key line is on the END line
 *  itself; or what comes before the marker on its line holds no letter (a diff's `+`, a quote, an
 *  indent, a line number); or it is the key lines' own frame (a listing's path, a log's time
 *  stamp), judged against the last key line when that line starts in view, and against the one
 *  partial line a cut left only for a tool's own frame (TOOL_FRAME). Taken anywhere, a report's
 *  hashes or a path printed above `... ends with -----END PRIVATE KEY-----` were removed as a key's
 *  tail. */
function endFramed(text: string, at: number, floor: number, runs: Run[]): boolean {
  const s = logicalLineStart(text, at, floor)
  if (runs.length && logicalLineStart(text, runs[runs.length - 1][0], floor) === s) return true
  const prefix = text.slice(s, at)
  if (!/[A-Za-z]/.test(prefix)) return true
  if (!runs.length) return false
  const r = runs[runs.length - 1]
  const ls = logicalLineStart(text, r[0], floor)
  const keyFrame = frameAt(text, ls, r[0])
  const endFrame = frameAt(text, s, at)
  if (runs.length > 1 || ls > floor) return endFrame === keyFrame
  // (':' and '-' alike: frameOf's `:N:`/`-N-` rule depends on where the cut fell in a timestamp)
  if (!loose(endFrame).endsWith(loose(keyFrame.replace(/^…/, '')))) return false
  return TOOL_FRAME.some((re) => re.test(prefix))
}

/** Whether the key lines that end at the END line at `at` stop in view, below a BEGIN line's reach
 *  past `floor`, the doing side's own cut (where the end it keeps starts, from which a BEGIN line is
 *  looked for REACH_BEGIN back: not from the window start, which a base64 run the cut fell in can
 *  pull 64 KB further back): their head is then in the answer, so they are no key the cut ran
 *  through (a dump or a list of hashes whose first line the window's start fell under, or under which
 *  the token lookback's start fell). False when the walk runs to that reach, or stops at the partial
 *  line it starts with: the head is out of reach there, as a key longer than the reach has it. At
 *  the text's start, a line is whole. */
function headInReach(text: string, at: number, floor: number, runs: Run[]): boolean {
  const lower = Math.max(0, floor - REACH_BEGIN)
  // (walked from the same END line with a lower floor, the lines are the same ones and more: its
  // top line is the walk's first, never below `runs`' own)
  const top = tailAbove(text, at, lower).reduce((x, r) => Math.min(x, r[0]), runs[0][0])
  const ls0 = logicalLineStart(text, top, lower)
  if (ls0 <= lower) return false
  if (lower === 0) return true
  return logicalLineStart(text, stepBack(text, ls0, lower), lower) > lower
}

const tailRule = (end: string): string => (end.includes('PGP') ? 'gpg_block' : end.includes('SSH2') ? 'ssh2_private_key' : 'private_key')

/** Whether every logical line in [a, b) is blank or a key line's: a base64 run of 16 or more, and
 *  besides its runs a frame of 64 characters at most with no words in it. (`b` starts a logical
 *  line, so each line in [a, b) ends with a line break before it.) */
function keyShapedLines(text: string, a: number, b: number): boolean {
  let any = false
  for (let br = nextBreak(text, a, b), i = a; br; i = br[1], br = nextBreak(text, i, b)) {
    const line = text.slice(i, br[0])
    if (!line.trim()) continue
    if (!/[A-Za-z0-9+/=]{16,}/.test(line) || hasWords(line)) return false
    if (line.replace(/[A-Za-z0-9+/=]{16,}/g, '').length > 64) return false
    any = true
  }
  return any
}

/** Where the removal of the key lines `runs` starts when they are under a key block taken of
 *  their END line `end`'s kind, or null: right under it (a frame or a short gap between, no words),
 *  at their first line when they hold 40 characters or more (a rotated key's in a diff); or past
 *  lines laid out unevenly between (one indented, split, joined or re-wrapped: every line a frame
 *  and base64), at the block's end. Blocks are sorted and disjoint. */
function blockLead(text: string, runs: Run[], floor: number, blocks: readonly KeyBlock[], end: string): number | null {
  // (`floor` is the last END line's end: a block before it had that END line to end its key at)
  let lo = 0
  let hi = blocks.length - 1
  let bi = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (blocks[mid].to <= runs[0][0]) {
      bi = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const bk = bi >= 0 ? blocks[bi] : null
  if (!bk || bk.cls === 'flag' || !sameKind(bk, end)) return null
  const ls = logicalLineStart(text, runs[0][0], floor)
  const between = text.slice(bk.to, ls)
  if (runs[0][0] - bk.to <= 512 && (between.match(/\r\n|\r|\n|\\n/g) ?? []).length <= 1 && !hasWords(between)) {
    return runs.reduce((n, [a, b]) => n + b - a, 0) >= 40 ? runs[0][0] : null
  }
  return bk.to >= floor && ls - bk.to <= REACH_BEGIN && keyShapedLines(text, bk.to, ls) ? bk.to : null
}

/** The key block taken that the key lines `runs` start inside, or null: their first line is its
 *  own key's, so they are the rest of it. (A flagged block's span is its BEGIN line, and an END
 *  line a block ends at is its own: neither holds a run.) Blocks are sorted and disjoint. */
function blockHolding(runs: Run[], blocks: readonly KeyBlock[]): KeyBlock | null {
  let lo = 0
  let hi = blocks.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const b = blocks[mid]
    if (b.to <= runs[0][0]) lo = mid + 1
    else if (b.from > runs[0][0]) hi = mid - 1
    else return b
  }
  return null
}

/** Whether the key block `bk` is of the END line `end`'s kind (its rule is the one a tail ending
 *  there gets; DSA's is its own). */
const sameKind = (bk: KeyBlock, end: string): boolean => bk.rule === tailRule(end) || (bk.rule === 'ssh_dsa_pubkey' && end.includes(' DSA '))

/** Whether the key lines `runs` start with a private key's first bytes, with the glue decodeHead
 *  tries: a structure decodeHead reads (DER, OpenPGP, SSH2), or the OpenSSH magic a truncated
 *  example shows without the header after it. A key's own tail starts so by chance about once in
 *  10^7. */
function keyHead(text: string, runs: Run[]): boolean {
  if (decodeHead(text, runs)) return true
  const r = text.slice(runs[0][0], runs[0][1])
  for (let k = 0; k <= 4; k++) if (startsWith(Buffer.from(r.slice(k, k + 24), 'base64'), OPENSSH.slice(0, 14))) return true
  // A line alone that a cut started inside the magic of: its bytes from a 4-character boundary are
  // a run of the magic and the zeros after it (6 bytes of them in 4 alignments: by chance about
  // once in 10^13). A key's own lines go on below its first.
  if (runs.length === 1) {
    for (let k = 0; k < 4; k++) {
      const b = Buffer.from(r.slice(k, k + 8), 'base64')
      if (b.length === 6 && OPENSSH_RUN.includes(b.toString('latin1'))) return true
    }
  }
  return false
}

/** Whether the key lines `runs` decode, from their first, to a private key of the END line `end`'s
 *  kind (OpenPGP under PGP, the OpenSSH blob under OPENSSH, SSH2's magic under SSH2, DER under any
 *  other), as a key block's would: OpenSSH and OpenPGP by their structure, the rest random too. A
 *  key from its first line, wherever its BEGIN line went (a cut through it or its headers, a
 *  rotated key's lines in a diff). */
function decodedHead(text: string, runs: Run[], end: string): boolean {
  const st = decodeHead(text, runs)
  if (!st) return false
  const kind = end.startsWith('---- END SSH2') ? 'ssh2' : end.includes(' PGP ') ? 'pgp' : end.includes(' OPENSSH ') ? 'openssh' : null
  if (kind ? st.type !== kind : !DER_TYPES.includes(st.type)) return false
  const all = runs.map(([a, b]) => text.slice(a, b)).join('')
  // as a key block with its END line (scanBlock): OpenSSH and OpenPGP by their structure over 128
  // characters, SSH2 random over 128, and DER random, whole (90% of the length it declares, a
  // one-line Ed25519 key) or two lines and 80 characters of a key's bytes (not a documentation
  // example's first line)
  if (st.type === 'openssh' || st.type === 'pgp') return all.length >= LONG_PAYLOAD
  if (!looksRandom(all)) return false
  if (st.type === 'ssh2') return all.length >= LONG_PAYLOAD
  return (Math.floor(((all.length - st.offset) * 3) / 4) >= st.declared * 0.9 && all.length >= 64) || (runs.length >= 2 && all.length >= 80)
}

/** The line breaks nextBreak reads, to split a stretch of text on. A written-out one starts at the
 *  first backslash of its run: tried at each of a run of n that no `n` or `r` follows, `\\+[nr]` read the
 *  rest of the run from every one, n * n. */
const BREAKS = /\r\n|\r|\n|(?<!\\)\\+(?:[nr]|u000[aAdD]|x0[aAdD])|%0[aAdD]|&#(?:x0?[aAdD]|1[03]);|<br\s*\/?>|`[nr]/
/** `s` split at its line breaks (BREAKS), but not at the backslash and letter of a Windows path (pathEscape). */
function splitBreaks(s: string): string[] {
  const out: string[] = []
  const re = new RegExp(BREAKS.source, 'g')
  let from = 0
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    if (m[0].charCodeAt(0) === 92 && pathReading > 0 && pathEscape(s, m.index, m[0], pathReading === 2)) {
      pathSuppressed = true
      continue
    }
    out.push(s.slice(from, m.index))
    from = m.index + m[0].length
  }
  out.push(s.slice(from))
  return out
}
/** What a cut leaves of a DEK-Info line's rest: a header name's end, a cipher's end, an IV's end, and
 *  what a listing, a log or a literal adds after it (joiners; `cat -A` ends every line in `$`). */
export const DEK_REMNANT = /^(?:\s*(?:[A-Za-z-]*: ?)?(?:[A-Z0-9-]*,)?[0-9A-Fa-f]{1,32})?[\s"'`,;+.&_)\]}|\\$]*$/

/** Whether a legacy encrypted PEM key's DEK-Info line is in the 4 lines above the key lines
 *  `runs`, or, at the start of a text another computer cut (`cutText`), what its cut left of one
 *  (its cipher and IV, or the IV's end) over the blank line under it. That line is blank in the key
 *  lines' own frame (a listing's `path:N:`, a log's clock time, a diff's `+`, a literal's opening
 *  quote), and a literal's `" +` or a newline constant stands between the lines. */
function legacyAbove(text: string, runs: Run[], floor: number, cutText: boolean): boolean {
  const ls = logicalLineStart(text, runs[0][0], floor)
  let a = ls
  for (let n = 0; n < 4 && a > floor; n++) a = logicalLineStart(text, stepBack(text, a, floor), floor)
  const above = text.slice(a, ls)
  if (DEK_RE.test(above)) return true
  if (!cutText || a !== floor) return false
  const lines = splitBreaks(blankNl(above.replace(/^…/, '')))
  // (a blank line keeps its frame: a listing's number `     4\t`, a path `deploy.pem:4:`; a cut at the
  // DEK-Info line's end left none of it)
  const frame = frameAt(text, ls, runs[0][0])
  const own = (l: string): string => frameOf(l.slice(-512)).slice(-64)
  // (a blank line in a literal's frame closes the quote it opens: `    r""` under `    r"`; cat -A ends it in `$`)
  const blank = (l: string): boolean =>
    /^[\s\d:|>#*+$-]*$/.test(l) || FRAGMENT.test(l) || (frame !== '' && (own(l) === frame || (own(l).startsWith(frame) && FRAGMENT.test(own(l).slice(frame.length)))))
  // (the first line: the rest of the DEK-Info line, or of the line break or newline constant that ended
  // it, whose literal's quote and continuation backslash (`n" \`) or `$` follow, or, the cut having taken
  // it whole, the rest of the frame of the blank line under it)
  const head = (l: string): boolean =>
    DEK_REMNANT.test(l) || blank(l) || escTail(l.replace(TRAILING_HEAD_JOINERS, '')) || nlTail(l) || (frame !== '' && own(l) !== '' && loose(frame).endsWith(loose(own(l))))
  return lines.length >= 2 && head(lines[0]) && lines.slice(1).every(blank)
}

/** Whether the key lines `runs` a cut left are a made-up body, not a key's: every line as wide as a
 *  key's (48 or more) has fewer than 16 different characters ('AbAb...' and a number, 'AAAA...')
 *  or eight letters or digits in order, in either case (lnk3's 'AbCdEfGh...'); with no line that
 *  wide, so does what is left, or a third or fewer of its characters are different (10 at most
 *  needed). A real key's lines hold 25 or more different characters, its structured ones too (an
 *  OpenSSH header, a photo ID's zero bytes), and 2,000,000 random lines of 48 held 16 or more every
 *  time; eight in order come about once in 10^9 random lines. (Every line, not one: an OpenSSH
 *  key's comment line can repeat itself, and its other lines are random.) Lines of hex only are
 *  digests, never a PEM key's. */
function madeUp(text: string, runs: Run[]): boolean {
  const ordered = (line: string): boolean => {
    const lower = line.toLowerCase()
    for (let i = 1, n = 1; i < lower.length; i++) {
      const c = lower.charCodeAt(i)
      n = c === lower.charCodeAt(i - 1) + 1 && ((c > 97 && c <= 122) || (c > 48 && c <= 57)) ? n + 1 : 1
      if (n >= 8) return true
    }
    return false
  }
  const lines = runs.map(([a, b]) => text.slice(a, b))
  // (a PEM key's lines are base64: lines all of hex, digests, are no key's however random they are)
  const hexy = lines.filter((l) => l.length >= 32)
  if (hexy.length && hexy.every((l) => /^[0-9a-fA-F]+$/.test(l))) return true
  const long = lines.filter((l) => l.length >= 48)
  if (long.length) return long.every((l) => new Set(l).size < 16 || ordered(l))
  const all = lines.join('')
  return ordered(all) || new Set(all.toLowerCase()).size < Math.min(10, Math.ceil(all.length / 3))
}

/** Key tails with no BEGIN line in view, from `start` on. `blocks` are keyBlocks' from the same
 *  `start` (an END line inside one is its own). `cutAt`: where the text someone else cut starts
 *  (0: the whole text is the end an older doing computer cut; another offset: where the screen's
 *  own cut falls, nothing running through it). `screenedStart`: the text starts where another
 *  computer cut it after screening it with these detectors, which took whole any key the cut ran
 *  through: nothing at its start is a key's tail. */
function headlessOnce(text: string, blocks: readonly KeyBlock[], opts: { start?: number; cutAt?: number; screenedStart?: boolean }): KeySpan[] {
  const out: KeySpan[] = []
  const start = opts.start ?? 0
  const re = new RegExp(END_RE.source, 'g')
  re.lastIndex = start
  let m: RegExpExecArray | null
  let prev = start
  let bi = 0
  while ((m = re.exec(text)) !== null) {
    const at = m.index
    while (bi < blocks.length && Math.max(blocks[bi].to, blocks[bi].scanEnd) < at) bi++
    const taken = bi < blocks.length && blocks[bi].from <= at && at <= Math.max(blocks[bi].to, blocks[bi].scanEnd)
    if (!taken) {
      // Random key lines right above a private-key END line, BEGIN line out of view: a key's tail.
      // And its head must be out of view too: the run must start at the top of what is screened
      // (the text's start, an error's ellipsis, the window's floor, with at most one partial key
      // line above it) or right under a key block the detectors took (one that stopped at a frame
      // change). Taken anywhere, a screenshot dump or an array of hashes printed above an END line
      // was removed.
      const floor = Math.max(prev, at - MAX_BLOCK)
      const last = { short: 0 }
      const runs = tailAbove(text, at, floor, last)
      const framed = endFramed(text, at, floor, runs)
      const rule = tailRule(m[0])
      const cutText = opts.cutAt === 0 && floor === start
      const holder = framed && runs.length > 0 ? blockHolding(runs, blocks) : null
      const lead = framed && runs.length > 0 && !holder ? blockLead(text, runs, floor, blocks, m[0]) : null
      if (holder) {
        // They go on from inside a key block taken, whose lines stopped keeping one width and frame
        // (one re-wrapped, split or indented), down to an END line of its kind: the rest of it.
        out.push({ rule, cls: 'remove', why: 'tail-of-block', from: holder.to, to: at + m[0].length })
      } else if (framed && runs.length > 0 && decodedHead(text, runs, m[0])) {
        // Its first lines decode to a private key of the END line's kind: a key from them on,
        // wherever its BEGIN line went (a cut through it or the headers under it, a key rotated
        // in a diff).
        out.push({ rule, cls: 'remove', why: 'tail-decoded', from: runs[0][0], to: at + m[0].length })
      } else if (isKeyRun(text, runs)) {
        // An END line named in prose or code ends no key: what looks like one above it is reported
        // as anywhere else. So is a run whose head the doing side's own window start fell under
        // while it is still in the answer: only a key longer than the BEGIN line's reach (from the
        // cut) is cut off.
        const ownFloor = framed && floor === start && start > 0 && opts.cutAt !== 0 && headInReach(text, at, opts.cutAt ?? start, runs)
        const atTop = (floor === start && !(opts.screenedStart === true && floor === 0)) || floor === at - MAX_BLOCK
        // (a legacy encrypted PEM key's body decodes to nothing: its DEK-Info line above is its head)
        const legacy = framed && /-----END (?:RSA|DSA|EC) PRIVATE KEY-----/.test(m[0]) && legacyAbove(text, runs, floor, cutText)
        // (and under a block taken, from its end: the lines between are the key's, laid out unevenly)
        const head = framed && !ownFloor && !madeUp(text, runs) ? (legacy ? lead ?? runs[0][0] : headAnchor(text, runs, floor, atTop, blocks) ?? lead) : null
        if (head !== null) out.push({ rule, cls: 'remove', why: 'tail-with-end', from: Math.min(head, runs[0][0]), to: at + m[0].length })
        else out.push({ rule, cls: 'flag', why: framed ? 'tail-unanchored' : 'tail-unframed', from: at, to: at + m[0].length })
      } else if (lead !== null && !madeUp(text, runs)) {
        // Under a key block taken, with an END line of its kind under them: a key rotated in a diff,
        // the old one's removed above it, whose lines need not look random (an Ed25519 key's
        // OpenSSH bytes, a PKCS#8 one's single line); or the rest of the block's own key, past
        // lines laid out unevenly, which go with it.
        out.push({ rule, cls: 'remove', why: 'tail-under-block', from: lead, to: at + m[0].length })
      } else if (framed && opts.cutAt === 0 && floor === start && runs.length >= 1) {
        // At the start of a text another computer cut, the few characters of key a cut left right
        // above a private END line are a key's tail whatever their length (a cut at 95% of a key
        // leaves a partial line and the short last one, under the 80 characters a key run needs),
        // from 16 on: its lines', with what the cut left of the line above them (narrower than a
        // key's full lines, where the walk up stopped) and a last line of 1-7 (which it stepped over).
        // A made-up body's lines (a test's fixture, which a key never is) are reported instead, and
        // so are a key's first bytes, which are no key's tail: what starts there is a key from its
        // first line, too short to be one (a truncated example), as decodedHead judged.
        const fake = madeUp(text, runs) || keyHead(text, runs)
        const head = fake ? null : headAnchor(text, runs, floor, true, blocks)
        const from = head ?? runs[0][0]
        let top = from
        while (top < runs[0][0] && isB64(text.charCodeAt(top))) top++
        // (one or the other, and only where the partial line starts the text, the cut inside its
        // base64: a key's lines there are a partial one and its last; one between them narrower
        // than a key's full lines is no key's, and nor is a run behind a header's name, as a
        // DEK-Info line's IV is)
        const atTop = from === floor + (text.startsWith('…', floor) ? 1 : 0)
        const extra = !atTop ? 0 : last.short > 0 ? (from === runs[0][0] ? last.short : 0) : top - from
        if (runs.reduce((n, [a, b]) => n + b - a, 0) + extra >= 16) {
          if (head !== null) out.push({ rule: tailRule(m[0]), cls: 'remove', why: 'cut-tail-with-end', from: Math.min(head, runs[0][0]), to: at + m[0].length })
          else if (fake) out.push({ rule: tailRule(m[0]), cls: 'flag', why: 'cut-tail-made-up', from: at, to: at + m[0].length })
        }
      }
    }
    prev = at + m[0].length
  }
  // Key lines that go on below a block whose lines stopped keeping one width and frame, with no
  // END line: reported, so a note says what was left (with an END line, they are removed above).
  // (each read up to the next block; the removals, in the order their END lines came, looked up
  // in step: linear however many blocks there are)
  const removes = out.filter((o) => o.cls === 'remove')
  let ri = 0
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k]
    if (b.cls === 'flag' || b.rest === undefined || b.rest < start) continue
    const rest = b.rest
    const limit = Math.min(text.length, rest + MAX_BLOCK, k + 1 < blocks.length ? blocks[k + 1].from : text.length)
    const runs = leadingRun(text, rest, limit, true)
    while (ri < removes.length && removes[ri].to <= rest) ri++
    const covered = ri < removes.length && removes[ri].from <= rest
    // (one line will do: the block above it is a key's, verified; a made-up body's is no key's)
    const enough = runs.length > 0 && runs.reduce((n, [x, y]) => n + y - x, 0) >= MIN_RUN && !madeUp(text, runs)
    if (enough && !covered) out.push({ rule: b.rule, cls: 'flag', why: 'block-rest', from: rest, to: runs[runs.length - 1][1] })
  }
  // The start of a text someone else cut (an older doing computer): a leading run of random key
  // lines with no END line below it is FLAGGED, not removed: a base64 dump (an image, an archive)
  // cut the same way looks the same, and with its END line a key tail is removed above.
  if (opts.cutAt !== undefined) {
    const s = opts.cutAt
    const runs = leadingRun(text, s, Math.min(text.length, s + 1024 * 1024), s === 0)
    const covered = out.some((o) => o.from <= s + 128 && o.to > s)
    if (!covered && isKeyRun(text, runs)) out.push({ rule: 'private_key', cls: 'flag', why: 'cut-start-run', from: s, to: runs[runs.length - 1][1] })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Base64-encoded key files (K5, a Kubernetes Secret's tls.key): decode the run, look inside.
// ---------------------------------------------------------------------------------------------
/** The base64 of `s` at each of the 3 byte alignments: the characters that are its bytes' alone,
 *  whatever comes before and after it. */
function b64Signatures(s: string): string[] {
  const sigs: string[] = []
  for (let p = 0; p < 3; p++) {
    const a = Buffer.from(String.fromCharCode(0).repeat(p) + s, 'latin1').toString('base64')
    const z = Buffer.from(String.fromCharCode(0xff).repeat(p) + s + String.fromCharCode(0xff), 'latin1').toString('base64')
    const from = Math.ceil((p * 4) / 3) + (p ? 1 : 0)
    let to = from
    while (to < a.length && a[to] === z[to]) to++
    sigs.push(a.slice(from, to - 1))
  }
  return sigs.filter((x) => x.length >= 8)
}
const B64_SIGS = [...b64Signatures('PRIVATE KEY'), ...b64Signatures('PuTTY-User-Key-File-'), ...b64Signatures('OpenVPN Static key')]

/** Base64 runs, wrapped or not, that encode a key file: judged on the decoded file. `cutText`:
 *  `text` is an end another computer cut, whose first line can be what its cut left of one. */
export function encodedKeys(text: string, start = 0, cutText = false): KeySpan[] {
  const out: KeySpan[] = []
  let i = start
  while (i < text.length) {
    while (i < text.length && !isB64(text.charCodeAt(i))) i++
    const a0 = i
    while (i < text.length && isB64(text.charCodeAt(i))) i++
    // (`TLS_KEY=LS0t...`: a name and its `=` come first, and a decode stops at that `=`: the value is the run,
    // and the name stays)
    const a = valueStart(text, a0, i)
    // (at the start of a text another computer cut, a shorter run can be what its cut left of a line)
    if (i - a < 40 && !(cutText && a0 <= start + 1 && i - a >= 4)) continue
    // Join the wrapped lines after it (base64 and openssl wrap at 64 or 76), whatever frames them
    // (indentation, a listing's number, a quote): one width, and from the second line one frame.
    const runs: Run[] = [[a, i]]
    let width = i - a
    let frame: string | null = null
    let j = i
    // (base64 padding ends a value: a padded line has none after it)
    for (let n = 0; n < 65536 && text.charCodeAt(j - 1) !== 61; n++) {
      const next = nextBreak(text, j, Math.min(text.length, j + 256))
      if (!next) break
      const pair = CRLF_ESCAPED.exec(text.slice(next[0], next[0] + 40))
      const br: Run = pair ? [next[0], next[0] + pair[0].length] : next
      const stop = Math.min(text.length, br[1] + 4096)
      const lineEnd = (nextBreak(text, br[1], stop) ?? [stop])[0]
      const lr = runsIn(text, br[1], lineEnd, 4)
      const last = lr[lr.length - 1]
      if (!last || !JOINERS.test(text.slice(last[1], lineEnd))) break
      const w = last[1] - last[0]
      const f = frameAt(text, br[1], last[0])
      // (a first line narrower than the second was cut: the second sets the width)
      if (runs.length === 1 && w > width) width = w
      if (w > width || (frame !== null && f !== frame)) break
      if (frame === null) {
        // (a second line with a label of its own is another value, not a wrapped line, as `tls.key` is under `tls.crt` in a
        // Secret: it is compared with the first line's own frame, which is worked out here and no sooner, as most runs, a long
        // base64 string in a document, have no second line to compare it with)
        if (/[A-Za-z]/.test(f) && !(cutText && a0 <= start + 1) && f !== frameAt(text, logicalLineStart(text, a, Math.max(0, a - 512)), a)) break
        frame = f
      }
      runs.push(last)
      j = last[1]
      if (w < width) break
    }
    i = Math.max(i, j)
    const joined = runs.map(([s, e]) => text.slice(s, e)).join('')
    if (!B64_SIGS.some((sig) => joined.includes(sig))) continue
    for (let k = 0; k <= 3; k++) {
      const decoded = Buffer.from(joined.slice(k), 'base64').toString('latin1')
      if (!/PRIVATE KEY|PuTTY-User-Key-File-|OpenVPN Static key/.test(decoded)) continue
      // (a run whose start a cut took decodes to a key's tail and its END line: headless judges it
      // as at the start of a text another computer cut)
      const blocks = keyBlocks(decoded)
      const inner: KeySpan[] = [...blocks, ...puttyKeys(decoded), ...headless(decoded, blocks, { cutAt: 0 })]
      const cls = inner.some((s) => s.cls === 'remove') ? 'remove' : 'flag'
      out.push({ rule: 'private_key_b64', cls, why: `decoded:${inner.map((s) => s.why).join('+')}`, from: runs[0][0], to: runs[runs.length - 1][1] })
      break
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// PuTTY (K6): the private part names its own length.
// ---------------------------------------------------------------------------------------------
/** A test for prose, asked of many stretches of one text: ends(from) is where the first match of
 *  /[A-Za-z]{2,}[ \t]+[A-Za-z]{2,}/ in the text from `from` on ends, or Infinity when none does; so the
 *  stretch [from, to) holds a match exactly when ends(from) <= to. (Asked afresh of each stretch, the
 *  regex read the stretch again for every candidate line and for every anchor that shared it, and a
 *  long run of letters took it n * n.) A match is a run of spaces and tabs with two letters on each
 *  side, so those are found once, in order, and the first that starts at or after `from` is the one
 *  that ends soonest. `from` is `start` or after. */
export function proseEnds(text: string, start = 0): (from: number) => number {
  let words: Array<[number, number]> | null = null
  return (from) => {
    if (words === null) {
      words = []
      const letter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      for (let p = start; p < text.length; p++) {
        const c = text.charCodeAt(p)
        if (c !== 32 && c !== 9) continue
        let q = p
        while (q < text.length && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9)) q++
        if (p >= start + 2 && letter(text.charCodeAt(p - 1)) && letter(text.charCodeAt(p - 2)) && q + 1 < text.length && letter(text.charCodeAt(q)) && letter(text.charCodeAt(q + 1))) words.push([p - 2, q + 2])
        p = q
      }
    }
    let lo = 0
    let hi = words.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (words[mid][0] < from) lo = mid + 1
      else hi = mid
    }
    return lo < words.length ? words[lo][1] : Infinity
  }
}

/** Whether the base64 run that ends at `e` is the last thing in its line or in the string it is written in: a break follows it (a real one, or one
 *  written out), or the quote that closes the string, with nothing but blanks and a literal's joiners between. A word, a digit or a colon comes
 *  first when the run is only a frame's (a request id in front of each line's payload). Reads 32 characters at the most. */
function endsItsLine(text: string, e: number): boolean {
  const stop = Math.min(text.length, e + 32)
  for (let i = e; i < stop; i++) {
    const c = text.charCodeAt(i)
    if (c === 10 || c === 13 || c === 34 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true
    // (a backslash that is no escape: the one in front of a quote that JSON written in JSON escapes, or a line continuation)
    if (c !== 92 && !PARTIAL_JOINERS.includes(text[i])) return false
  }
  return stop === text.length
}

export function puttyKeys(text: string, start = 0): KeySpan[] {
  const out: KeySpan[] = []
  const heads: number[] = []
  // First lines from 16 KB before `start` on: a file's first line is looked for that far back.
  for (let h = text.indexOf('PuTTY-User-Key-File-', Math.max(0, start - 16384)); h !== -1; h = text.indexOf('PuTTY-User-Key-File-', h + 1)) heads.push(h)
  let hi = 0
  const re = /Private-Lines: ?(\d{1,4})/g
  re.lastIndex = start
  let m: RegExpExecArray | null
  let prevStop = 0
  // (the prose test below is answered from one list of the text's spoken stretches, and one break cursor
  // serves all the anchors, which move forward)
  const wordsEnd = proseEnds(text, start)
  const nextLineBreak = breakCursor(text)
  // The stretch from `emptyFrom` to `emptyTo` that a search found no base64 run in. An anchor whose search starts at `emptyFrom` again
  // (they do, when a long stretch of blanks follows a first one: each starts where the last stopped) looks on from `emptyTo`. (Read
  // again by each of 8,000 anchors, 65,536 blanks took 3 seconds.)
  let emptyFrom = -1
  let emptyTo = -1
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1])
    // The private lines are the next n base64 runs of a line's width (64, with up to 4 characters
    // a frame glues on). Shorter runs between them are frame (a line number, a b" prefix, a
    // timestamp). Read in order, so one-line and escaped forms work too.
    const runs: Run[] = []
    let i = Math.max(m.index + m[0].length, prevStop)
    const stop = Math.min(text.length, i + 65536)
    let prevEnd = i
    // (where the search goes on; `i` is where the stretch it may find empty begins)
    let at = i === emptyFrom ? emptyTo : i
    while (runs.length < n) {
      const r = nextRun(text, at, stop)
      if (typeof r === 'number') {
        emptyFrom = i
        emptyTo = r
        break
      }
      const e = r[1]
      // (a file with no line breaks at all glues the last private line to the name of the MAC line after it, `…Private-MAC: `, and the
      // padding `=` before that name is not a NAME=. The MAC line follows the last private line, however they are joined: it is no path's rest)
      const glued = text.startsWith('-MAC', e) && text.startsWith('Private', e - 7)
      const beforeMac = glued || MAC_NEXT.test(text.slice(e, e + 16))
      // (a NAME= in front of the value, as journalctl's MESSAGE= or a properties file writes one on every line, is not part of it)
      const a = valueStart(text, r[0], glued ? e - 7 : e)
      i = e
      at = e
      const len = e - a
      // (the line the file still lacks can be this short: an ECDSA P-384 key's blob is 52 or 53 bytes, 72 characters, so the file says
      // `Private-Lines: 2` and its second line is 8, ending in padding. A frame's word is as short, but is not padded and is not the last thing on its
      // line: a clock time or a path's piece comes before the payload.)
      const lastShort = len >= 4 && runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && (beforeMac || endsItsLine(text, e))
      if (len <= 12 && !lastShort) {
        if (text.startsWith('Private', a) && text.startsWith('-MAC', e)) break
        continue
      }
      if (a - prevEnd > 256) break
      // Only a frame may sit between `Private-Lines: N` and the first private line (a listing
      // prefix, an indent, a quote, an escape), never words: `Private-Lines: 14 but I only see:`
      // followed by two hashes is prose. (Only the rest of the anchor's own line is judged: the
      // next line's prefix is the frame the private lines share, and a log prefix holds words.)
      if (runs.length === 0) {
        const ae = m.index + m[0].length
        const br = nextLineBreak(ae, a)
        if (wordsEnd(ae) <= (br ? br[0] : a)) break
      }
      // A run followed by more of a path (no space) and then what ends one (PATH_THEN_RUN: the `:` of `deploy.ppk:12:`, `_key.asc:12:` or
      // `grep` without -n, the `-12-` of a context line, the `=` of journalctl's `NAME=`) is a path: of any length (a long one is not a
      // private line either, nor the key written with no line breaks). A run that a written-out line break follows at once is a line's end, not a
      // path's piece: after the `\n` of a JSON string comes the next line's own `Private-MAC:` or `2026-11-02T10:11:10Z `, whose
      // letters, digits and dash would read as the rest of a path. (Nor is the last private line, glued to the name of the MAC line.)
      if (!beforeMac && escapeAt(text, e) === null && PATH_THEN_RUN.test(text.slice(e, e + 112))) continue
      // The last private line is short: it is the Nth line when the text between it and the line
      // before is what separates the lines before it (digits as 0), Private-MAC line or not.
      // (`lineSeparator` of `System.lineSeparator()` or a path's `infrastructure` are frame.)
      if (len < 40 && runs.length === n - 1) {
        const sep = (x: number, y: number): string => text.slice(x, y).replace(/\d+/g, '0')
        const prevSep = runs.length >= 2 ? sep(runs[runs.length - 2][1], runs[runs.length - 1][0]) : null
        if (prevSep === null || sep(runs[runs.length - 1][1], a) === prevSep) {
          runs.push([a, e])
          break
        }
        continue
      }
      if (len >= 40 && len <= 68) {
        runs.push([a, e])
        prevEnd = e
        continue
      }
      if (len > 68) {
        // Written with no line breaks: the private lines run together.
        const lines = Math.ceil(len / 64)
        if (runs.length === 0 && lines >= n - 1 && lines <= n + 1) for (let p = a; p < e; p += 64) runs.push([p, Math.min(e, p + 64)])
        break
      }
      // 13 to 39 characters and not the last line: a frame's word.
    }
    prevStop = i
    const got = runs.slice(0, n)
    const all = got.map(([s, e]) => text.slice(s, e)).join('')
    const macRe = /Private-MAC: ?[0-9a-fA-F]{40,64}/y
    let mac = -1
    const after = got.length ? got[got.length - 1][1] : m.index + m[0].length
    for (let p = after; p < Math.min(text.length, after + 512); p++) {
      if (text.charCodeAt(p) !== 80 /* P */) continue
      macRe.lastIndex = p
      const mm = macRe.exec(text)
      if (mm) {
        mac = p + mm[0].length
        break
      }
    }
    while (hi + 1 < heads.length && heads[hi + 1] < m.index) hi++
    const head = heads.length > 0 && heads[hi] < m.index ? heads[hi] : -1
    const from = head !== -1 && m.index - head < 16384 ? head : m.index
    const to = mac !== -1 ? mac : got.length ? got[got.length - 1][1] : m.index + m[0].length
    // All n private lines, or two or more of them (a file cut short): its own private lines.
    const cls = (got.length >= 2 || (got.length === n && n > 0)) && looksRandom(all) ? 'remove' : 'flag'
    out.push({ rule: 'putty_private_key', cls, why: `ppk ${got.length}/${n}${mac !== -1 ? ' mac' : ''}`, from, to: cls === 'flag' ? m.index + m[0].length : to })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// JWK (K7) and RSAKeyValue (K8): the private members, judged by their decoded size and randomness.
// ---------------------------------------------------------------------------------------------
const b64urlLen = (s: string): number => Math.floor((s.length * 3) / 4)
// (Maps, not objects: a curve name is the text's, and `toString` or `constructor` must not find a
// method.)
const EC_SIZES = new Map<string | undefined, number[]>([['P-256', [32]], ['P-384', [48]], ['P-521', [65, 66]], ['secp256k1', [32]]])
const OKP_SIZES = new Map<string | undefined, number[]>([['Ed25519', [32]], ['X25519', [32]], ['Ed448', [57]], ['X448', [56]]])
const RSA_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'r', 't']
/** A quote as JSON, JSON in JSON, the JSON escape of a double quote, or HTML writes it. */
const Q = String.raw`(?:\\{0,3}["']|\\u0022|&quot;)?`
const KTY_RE = new RegExp(String.raw`(?<![A-Za-z0-9_])${Q}kty${Q}\s{0,8}[:=]\s{0,8}${Q}(EC|RSA|OKP|oct)\b`, 'g')
const MEMBER_RE = new RegExp(String.raw`(?<![A-Za-z0-9_])${Q}(d|k|p|q|dp|dq|qi|r|t|crv)${Q}\s{0,8}[:=]\s{0,8}${Q}([A-Za-z0-9_-]{3,})`, 'g')

/** The object around a kty member: its braces (nesting allowed), or null when it has none (YAML, TOML). */
function objectAround(text: string, at: number): Run | null {
  const lo = Math.max(0, at - 4096)
  let depth = 0
  let open = -1
  for (let i = at; i >= lo; i--) {
    const c = text.charCodeAt(i)
    if (c === 125 /* } */) depth++
    else if (c === 123 /* { */) {
      if (depth === 0) {
        open = i
        break
      }
      depth--
    }
  }
  if (open !== -1) {
    const hi = Math.min(text.length, open + 65536)
    let d = 0
    for (let i = open; i < hi; i++) {
      const c = text.charCodeAt(i)
      if (c === 123) d++
      else if (c === 125 && --d === 0) return [open, i + 1]
    }
    return [open, hi]
  }
  return null
}

/** How far from a kty that has no braces around it (YAML, TOML, properties) its members are looked for: an RSA-2048 JWK is 1.6 KB, an
 *  RSA-4096 one 3.2 KB and an RSA-8192 one 6.4 KB, whatever order its members come in, and a YAML list holds several. */
const BARE_REACH = 16384

/** Whether a member named `name` is a private member of a JWK of this type, by its name alone. */
const privateName = (kty: string, name: string): boolean => (kty === 'oct' ? name === 'k' : kty === 'RSA' ? RSA_MEMBERS.includes(name) : name === 'd')

/** Whether `name` with this value has the size of a private member of a JWK of this type (and curve, when it says): EC and OKP `d` of the
 *  curve's size, RSA's `d p q dp dq qi` and the `oth` members `r d t` of 32 bytes or more, oct `k` of 16 or more. */
function privateSized(kty: string, crv: string | undefined, name: string, value: string): boolean {
  if (kty === 'EC') return name === 'd' && (EC_SIZES.get(crv) ?? [32, 48, 65, 66]).includes(b64urlLen(value))
  if (kty === 'OKP') return name === 'd' && (OKP_SIZES.get(crv) ?? [32, 56, 57]).includes(b64urlLen(value))
  if (kty === 'RSA') return RSA_MEMBERS.includes(name) && b64urlLen(value) >= 32
  return name === 'k' && b64urlLen(value) >= 16 // oct
}

interface BareKty {
  at: number
  end: number
  kty: string
  /** A private member of its type was taken. */
  taken: boolean
}
interface BareMember {
  name: string
  value: string
  at: number
  cut: boolean
  /** The kty above it and the one below it (those it can be a member of, by its name). */
  cands: BareKty[]
}

/** The private members of the JWKs that have no braces around them. A member belongs to the kty above it or the one below it (a YAML
 *  object that lists kty last has its members above it), by its name: taken if it has a private member's size under either, and as it is
 *  judged by its own neighbours, a list of keys of different types is judged key by key. It must be within BARE_REACH of a kty.
 *  Members inside a braced object (`skip`) are that object's. (The size of an EC or OKP `d` is judged against every curve's, not its
 *  `crv`'s: which `crv` belongs to which key is as unclear as which member does.)
 *
 *  The stretches within reach of a kty are merged where they meet and each is read once, in one pass of the member pattern: read for
 *  each kty with room past its end for a value, a text of nothing but `kty: oct` lines was read 4 KB beyond every one of them, a second
 *  for a long answer. */
function bareJwks(text: string, ktys: BareKty[], skip: readonly Run[], out: KeySpan[]): void {
  const n = ktys.length
  const ranges: Run[] = []
  for (const k of ktys) {
    const lo = Math.max(0, k.at - BARE_REACH)
    const hi = Math.min(text.length, k.end + BARE_REACH)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && lo <= last[1]) last[1] = Math.max(last[1], hi)
    else ranges.push([lo, hi])
  }
  const members: BareMember[] = []
  const mem = new RegExp(MEMBER_RE.source, 'g')
  let g = 0 // the first kty that starts after the member being read: the one below it, the one before that above it
  let si = 0
  for (const [lo, hi] of ranges) {
    // (one character before the range, for the member's lookbehind; room after it for a value that runs past it)
    const from = Math.max(0, lo - 1)
    const win = text.slice(from, Math.min(text.length, hi + 4096))
    mem.lastIndex = 0
    let mm: RegExpExecArray | null
    while ((mm = mem.exec(win)) !== null) {
      const at = from + mm.index + mm[0].length - mm[2].length
      if (from + mm.index < lo && lo > 0) continue
      if (at >= hi) break
      while (si < skip.length && skip[si][1] <= at) si++
      if (si < skip.length && skip[si][0] <= at) continue
      while (g < n && ktys[g].at < at) g++
      const above = g > 0 ? ktys[g - 1] : null
      const below = g < n ? ktys[g] : null
      const name = mm[1]
      const value = mm[2]
      const cands: BareKty[] = []
      if (above !== null && privateName(above.kty, name)) cands.push(above)
      if (below !== null && privateName(below.kty, name)) cands.push(below)
      if (cands.length) {
        // (a quoted value the text ends inside is cut short: its length then says nothing)
        const cut = at + value.length === text.length && /(?:["']|\\u0022|&quot;)$/.test(text.slice(Math.max(0, at - 6), at))
        members.push({ name, value, at, cut, cands })
      }
    }
  }
  for (const p of members) {
    for (const c of p.cands) {
      if (!privateSized(c.kty, undefined, p.name, p.value) || !looksRandomToken(p.value, p.cut)) continue
      out.push({ rule: 'jwk_private_key', cls: 'remove', why: `jwk ${c.kty} ${p.name}`, from: p.at, to: p.at + p.value.length, group: c.at })
      for (const x of p.cands) x.taken = true
      break
    }
  }
  // A key none of whose members was taken: its first d or k, when it is a value and not a word.
  const first = new Map<BareKty, BareMember>()
  for (const p of members) {
    if ((p.name !== 'd' && p.name !== 'k') || p.value.length < 8) continue
    for (const c of p.cands) if (!first.has(c)) first.set(c, p)
  }
  for (const c of ktys) {
    const p = c.taken ? undefined : first.get(c)
    if (p) out.push({ rule: 'jwk_private_key', cls: 'flag', why: `jwk ${c.kty} ${p.name} not a key`, from: p.at, to: p.at + p.value.length, group: c.at })
  }
}

export function jwkKeys(text: string, start = 0): KeySpan[] {
  const out: KeySpan[] = []
  const re = new RegExp(KTY_RE.source, 'g')
  re.lastIndex = start
  let m: RegExpExecArray | null
  let lastEnd = 0
  const bare: BareKty[] = []
  const braced: Run[] = []
  // (the first `{` after the last brace-less kty: with none between, the next kty has no object around it either, and the 4 KB look back
  // for one is not made again for every kty of a text that is all kty)
  let nextOpen = -1
  while ((m = re.exec(text)) !== null) {
    if (m.index < lastEnd) continue
    const kty = m[1]
    if (bare.length) {
      const last = bare[bare.length - 1].at
      if (nextOpen < last) {
        const o = text.indexOf('{', last)
        nextOpen = o === -1 ? text.length : o
      }
      if (nextOpen > m.index) {
        bare.push({ at: m.index, end: m.index + m[0].length, kty, taken: false })
        continue
      }
    }
    const around = objectAround(text, m.index)
    if (around === null) {
      bare.push({ at: m.index, end: m.index + m[0].length, kty, taken: false })
      continue
    }
    const [ws, we] = around
    braced.push(around)
    lastEnd = Math.max(we, m.index + 1)
    const win = text.slice(ws, we)
    const mem = new RegExp(MEMBER_RE.source, 'g')
    let mm: RegExpExecArray | null
    const priv: Array<{ name: string; value: string; at: number; cut: boolean }> = []
    let crv: string | undefined
    while ((mm = mem.exec(win)) !== null) {
      if (mm[1] === 'crv') crv = mm[2]
      else {
        const at = ws + mm.index + mm[0].length - mm[2].length
        // (a quoted value the text ends inside is cut short: its length then says nothing)
        const cut = at + mm[2].length === text.length && /(?:["']|\\u0022|&quot;)$/.test(text.slice(Math.max(0, at - 6), at))
        priv.push({ name: mm[1], value: mm[2], at, cut })
      }
    }
    // (RSA: d, the primes and CRT values, and a multi-prime key's `oth` members r, d, t)
    const ok = priv.filter((p) => privateSized(kty, crv, p.name, p.value) && looksRandomToken(p.value, p.cut))
    if (ok.length) {
      for (const p of ok) out.push({ rule: 'jwk_private_key', cls: 'remove', why: `jwk ${kty} ${p.name}`, from: p.at, to: p.at + p.value.length, group: ws })
    } else {
      const p = priv.find((x) => (x.name === 'd' || x.name === 'k') && x.value.length >= 8)
      if (p) out.push({ rule: 'jwk_private_key', cls: 'flag', why: `jwk ${kty} ${p.name} not a key`, from: p.at, to: p.at + p.value.length, group: ws })
    }
  }
  if (bare.length) bareJwks(text, bare, braced, out)
  return out
}

const XML_PRIVATE = ['D', 'P', 'Q', 'DP', 'DQ', 'InverseQ']
// A member's open tag, then its value (from its first base64 character, whitespace inside it
// allowed) up to the `<` that starts the next tag, which is left for the next member (an unclosed
// one's next member starts there). Only one part may take a given space: the value starts at a
// base64 character and runs as far as it can, and the whitespace before the closing tag is trimmed
// off it after. (With a lazy value and a `\s*` after it, both could, and a member left open over
// 4,000 spaces with no closing tag took 9 seconds: every way of sharing them was tried.)
const XML_MEMBER_RE = /(?:<|&lt;|\\u003[cC])(?:\w{1,16}:)?(Modulus|D|P|Q|DP|DQ|InverseQ)(?:\s[^>&\\]{0,128})?(?:>|&gt;|\\u003[eE])\s*([A-Za-z0-9+/=][A-Za-z0-9+/=\s]*)(?=<|&lt;|\\u003[cC])/g

export function rsaKeyValues(text: string, start = 0): KeySpan[] {
  const out: KeySpan[] = []
  const re = /RSAKeyValue/g
  re.lastIndex = start
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Its members run to the next RSAKeyValue (its closing tag), 16 KB at most: the next match is
    // that one, so no window is looked at twice.
    const we = Math.min(text.length, m.index + 16384)
    const close = text.indexOf('RSAKeyValue', m.index + 11)
    const end = close !== -1 && close < we ? close : we
    const win = text.slice(m.index, end)
    const mem = new RegExp(XML_MEMBER_RE.source, 'g')
    let mm: RegExpExecArray | null
    // Each member: where its value starts and ends, the value without whitespace, its byte length.
    const at = new Map<string, [number, number, string, number]>()
    while ((mm = mem.exec(win)) !== null) {
      // (the whitespace before the closing tag is the XML's, not the value's)
      const value = mm[2].replace(TRAILING_BLANKS, '')
      if (value.length < 16) continue
      const v = value.replace(/\s+/g, '')
      const s = m.index + mm.index + mm[0].length - mm[2].length
      at.set(mm[1], [s, s + value.length, v, Buffer.from(v, 'base64').length])
    }
    const members = XML_PRIVATE.flatMap((k) => {
      const x = at.get(k)
      return x ? [{ name: k, from: x[0], to: x[1], value: x[2], bytes: x[3] }] : []
    })
    if (!members.length) continue
    const bytes = (k: string): number => members.find((x) => x.name === k)?.bytes ?? 0
    const sized = bytes('D') >= 64 || (bytes('P') >= 32 && bytes('Q') >= 32)
    if (sized && members.every((x) => looksRandomToken(x.value))) {
      for (const x of members) out.push({ rule: 'xml_private_key', cls: 'remove', why: `RSAKeyValue ${x.name}`, from: x.from, to: x.to, group: m.index })
    } else {
      out.push({ rule: 'xml_private_key', cls: 'flag', why: 'RSAKeyValue not a key', from: members[0].from, to: members[0].to, group: m.index })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Placeholders: a JWK's or an RSAKeyValue's value that is a test value or a template, not a key.
// ---------------------------------------------------------------------------------------------
// A placeholder word, in one case form: all lower, all upper, or capitalised. Random base62 hits
// a 5-letter word in one of 3 forms about 3 x 32 / 62^5 = 1e-7 of the time.
const WORDS = ['example', 'sample', 'dummy', 'placeholder', 'changeme', 'redacted', 'truncated', 'elided', 'omitted', 'insert', 'replace', 'yourkey', 'your_key', 'yourtoken', 'your_token', 'yoursecret', 'your_secret']
// The words a key is spoken of in. A value holding two of them is a description or an identifier
// (PrivateExponentBase64UrlEncodedValueGoesHere, mySuperSecretKeyForSigning2026); one is not enough: a
// random 43-character value holds one of these about once in 10^4 (two about once in 10^9).
const NAME_WORDS = /private|public|exponent|secret|signing|base64|encoded|value|goes|here|material|config/g
const PLACEHOLDER_WORDS = new RegExp(WORDS.flatMap((w) => [w, w.toUpperCase(), w[0].toUpperCase() + w.slice(1)]).join('|'))

/** Why a value is a placeholder and not key material, or null. Each check is set so a random value
 *  of its alphabet trips it less than once in a million: case-sensitive repeats of 6 (hex 8), an
 *  ascending run of 8 (`12345678`, `abcdefgh`), under a quarter distinct characters, a short unit
 *  repeated, a placeholder word, an environment variable's name, two of the words a key is spoken of in,
 *  one case only over 32 characters, or a name made of words. `decoded`: `body` is the text a base64 value decodes to, not an encoded
 *  value, and is judged by the checks that name a phrase (the two that read a whole value's case or its dashes are the encoded
 *  form's: a lower-case hex string or a UUID is a secret made by a machine). */
export function placeholderWhy(body: string, alphabet: 'hex' | 'b62', cut = false, decoded = false): string | null {
  const core = body.replace(/[^A-Za-z0-9]/g, '')
  if (core.length < 8) return 'short'
  const hex = alphabet === 'hex'
  let rep = 1
  for (let i = 1; i < core.length; i++) {
    rep = core[i] === core[i - 1] ? rep + 1 : 1
    if (rep >= (hex ? 8 : 6)) return 'repeat'
  }
  if (new Set(core.toLowerCase()).size < Math.min(hex ? 8 : 10, Math.ceil(core.length / 4))) return 'few-distinct'
  // A short unit repeated (`fpousrbA0xZfpousrbA0xZ...`, a fill pattern).
  for (let p = 2; p <= Math.min(16, core.length >> 1); p++) if (core.slice(p) === core.slice(0, core.length - p)) return 'periodic'
  let seq = 1
  for (let i = 1; i < core.length; i++) {
    seq = core.charCodeAt(i) - core.charCodeAt(i - 1) === 1 ? seq + 1 : 1
    if (seq >= 8) return 'sequence'
  }
  if (PLACEHOLDER_WORDS.test(body)) return 'word'
  // An environment variable's name (JWT_SIGNING_SECRET_BASE64URL), or a description made of the words a key is spoken of in.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(body)) return 'env-name'
  if (new Set(body.toLowerCase().match(NAME_WORDS) ?? []).size >= 2) return 'named'
  if (!decoded && !hex && core.length >= 32 && (!/[A-Z]/.test(core) || !/[a-z]/.test(core)) && !/^[0-9a-f]+$/.test(core)) return 'one-case'
  // Prose with its blanks taken out (an XML value is read across them): next to no capital among 40 letters or more. A random value holds
  // a capital in two of every five characters, and one in 16 letters is out of its reach (none in 30 million draws of 32 bytes). (Hex, in
  // lower case, is not prose either, as for one-case; and text a base64 value decodes to is judged as text, below.)
  if (!decoded && !/^[0-9a-f]+$/.test(core)) {
    const letters = core.replace(/[^A-Za-z]/g, '')
    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length * 16 <= letters.length) return 'prose'
  }
  // A lower-case slug: `your-256-bit-secret-goes-here`, `my_dev_signing_key_2026`. The two name
  // checks only on 24 characters or more: shorter, they misfire on random base64url.
  // A value the text's end cut short (`cut`) is judged by them at any length: what was cut off may
  // have made it long enough, and a placeholder cut so read as a random value. (Random values cut
  // to 12 or 16 characters trip them 7 and 2 times in 100,000.)
  const named = cut || core.length >= 24
  if (!decoded && named && (body.match(/[-_]/g) ?? []).length >= 3 && !/[A-Z]/.test(body) && body.split(/[-_]+/).every((x) => /^[a-z0-9]{0,12}$/.test(x))) return 'slug'
  if (!hex && named && wordy(body)) return 'wordy'
  // Every check above reads the encoded characters, and base64 of a phrase passes them all (`bXktc2VjcmV0LWtleQ`, a test
  // secret's "my-secret-key"). A key's bytes are random: 16 of them are all text about twice in 10^7.
  if (!decoded && !hex && printableText(body)) return 'text'
  return null
}

/** Whether `body`, read as base64 or base64url, decodes to 12 bytes or more (16 characters) of printable ASCII or a tab, line feed or
 *  carriage return (`echo my-secret | base64` encodes the line feed `echo` ends its text with) that a person typed: a phrase. A
 *  secret kept as text is random too (the hex of `openssl rand -hex 32`, base64 text, generated alphanumerics, a UUID, and
 *  base64url-encoded into an oct JWK's k is how an HS256 key made of one is written), and is not one. */
function printableText(body: string): boolean {
  const core = body.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (core.length < 16 || /[^A-Za-z0-9+/]/.test(core)) return false
  const bytes = Buffer.from(core, 'base64')
  for (const x of bytes) if ((x < 0x20 && x !== 9 && x !== 10 && x !== 13) || x > 0x7e) return false
  return phraseLike(bytes.toString('latin1'))
}

/** The words a person writes into a test secret. A random value of 32 characters holds one about once in 10^6 (`dummy`, 5 letters in
 *  both cases) or less. */
const SECRET_WORDS = /secret|password|passphrase|passwd|example|sample|dummy|placeholder|changeme|testkey|notreal|yourkey/i
/** The reasons placeholderWhy gives for text that is a repeat, a sequence, a short unit repeated or a name made of words. */
const TYPED_SHAPES = new Set(['repeat', 'few-distinct', 'periodic', 'sequence', 'word', 'env-name', 'named', 'wordy'])

/** Whether printable text reads as what a person types for a test secret: a sentence (a space inside), a word that names a secret, a
 *  lower-case slug of words (`my-dev-signing-key`), or a repeat, a sequence, a short unit repeated or a name made of words. A hex
 *  string, base64 text, random alphanumerics and a UUID are none of these. */
function phraseLike(text: string): boolean {
  // (the line feeds at the end, found from the first of a run of them: tried from each, a run of n inside the text cost n * n)
  const body = text.replace(TRAILING_LINE_BREAKS, '')
  if (/\s/.test(body) || SECRET_WORDS.test(body)) return true
  const segs = body.split(/[-_.]/)
  if (segs.length >= 3 && segs.filter((s) => /^[a-z]{2,12}$/.test(s) && /[aeiouy]/.test(s)).length >= 3 && segs.every((s) => /^[a-z0-9]{1,12}$/.test(s))) return true
  const why = placeholderWhy(body, /^[0-9a-f]+$/i.test(body) && body.length >= 16 ? 'hex' : 'b62', false, true)
  return why !== null && TYPED_SHAPES.has(why)
}

/** A name made of words: `ExperimentalPrototypeProjects2026`, `hynix-firmware-tools`. Three or
 *  more words of four or more letters, each with a vowel, and nothing else but one number of up to
 *  four digits at the end. Random base62 or base64url almost never is. */
const WORD_SEG = /^(?:[A-Z][a-z]{3,}|[a-z]{4,})$/
function wordy(body: string): boolean {
  const segs = body.split(/[-_.]|(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/).filter(Boolean)
  const words = /^\d{1,4}$/.test(segs[segs.length - 1]) ? segs.slice(0, -1) : segs
  return words.length >= 3 && words.every((s) => WORD_SEG.test(s) && /[aeiouy]/.test(s))
}

const looksRandomToken = (s: string, cut = false): boolean => placeholderWhy(s, /^[0-9a-f]+$/i.test(s) && s.length >= 16 ? 'hex' : 'b62', cut) === null

// ---------------------------------------------------------------------------------------------
// A key block URL-encoded whole (K9): a query string, a form post.
// ---------------------------------------------------------------------------------------------
const PERCENT_BEGIN_RE = /-----BEGIN(?:%20|\+)(?:[A-Z0-9]+(?:%20|\+)){0,3}PRIVATE(?:%20|\+)KEY(?:(?:%20|\+)BLOCK)?-----/g

/** Each URL-encoded BEGIN line from `start` on: the value decoded, its key blocks found, and their
 *  spans mapped back. */
export function percentEncoded(text: string, start = 0): KeySpan[] {
  const out: KeySpan[] = []
  if (text.indexOf('-----BEGIN%20', start) === -1 && text.indexOf('-----BEGIN+', start) === -1) return out
  const re = new RegExp(PERCENT_BEGIN_RE.source, 'g')
  re.lastIndex = start
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const s = m.index
    const e = Math.min(text.length, s + 262144)
    // `+` is a space only in a form post's encoding, which writes no %20.
    const form = !text.slice(s, Math.min(e, s + 4096)).includes('%20')
    let dec = ''
    const map: number[] = []
    let i = s
    while (i < e) {
      const c = text[i]
      if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
        map.push(i)
        dec += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16))
        i += 3
        continue
      }
      if (/[\s&"'<>]/.test(c)) break // the encoded value ends
      map.push(i)
      dec += c === '+' && form ? ' ' : c
      i++
    }
    map.push(i)
    for (const blk of keyBlocks(dec)) out.push({ rule: blk.rule, cls: blk.cls, why: `url:${blk.why}`, from: map[blk.from], to: map[blk.to] })
    re.lastIndex = Math.max(re.lastIndex, i)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// A key block or a PuTTY file in a JSON string whose writer escapes base64's own characters (F-C):
// PHP's json_encode writes `/` as `\/`, .NET's System.Text.Json `+` as the escape of U+002B. The escape
// splits each line's base64, so the key is read as the text with those escapes decoded. A key written
// as an array of its lines (PHP's json_encode(file($pem))) is a string per line: the string goes on
// across a closing quote that another string follows.
// ---------------------------------------------------------------------------------------------
const B64_ESC_RE = /\\\/|\\u00(?:2[bBfF]|3[dD])/

/** Each private-key BEGIN line, and each PuTTY file's first line, from `start` on whose first 4 KB
 *  hold an escaped base64 character: the JSON string from there decoded of those escapes only (an
 *  escaped line break is kept as written: it ends a key line), to its closing quote or 256 KB, its
 *  key blocks or PuTTY lines found, and their spans mapped back. */
export function jsonEscaped(text: string, start = 0): KeySpan[] {
  const out: KeySpan[] = []
  if (!B64_ESC_RE.test(text.slice(start))) return out
  const re = new RegExp(BEGIN_RE.source + '|PuTTY-User-Key-File-', 'g')
  re.lastIndex = start
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const s = m.index
    const e = Math.min(text.length, s + 262144)
    if (!B64_ESC_RE.test(text.slice(s, Math.min(e, s + 4096)))) continue
    const ppk = m[0] === 'PuTTY-User-Key-File-'
    let dec = ''
    const map: number[] = []
    let i = s
    let between = false // after the closing quote of one string of an array of lines
    while (i < e) {
      const c = text.charCodeAt(i)
      if (c === 34 /* " */) {
        if (between || /^"\s*[,+.&]?\s*["']/.test(text.slice(i, i + 64))) {
          between = !between
          map.push(i)
          dec += '"'
          i++
          continue
        }
        break // the JSON string ends
      }
      if (c === 92 /* \ */) {
        const n = text[i + 1]
        if (n === '/') {
          map.push(i)
          dec += '/'
          i += 2
          continue
        }
        if (n === 'u' && /^00(?:2[bBfF]|3[dD])$/.test(text.slice(i + 2, i + 6))) {
          map.push(i)
          dec += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))
          i += 6
          continue
        }
        // any other escape as written: \n ends a key line, \" or \\ is the string's
        map.push(i, i + 1)
        dec += text.slice(i, i + 2)
        i += 2
        continue
      }
      map.push(i)
      dec += text[i]
      i++
    }
    map.push(i)
    for (const blk of ppk ? puttyKeys(dec) : keyBlocks(dec)) out.push({ rule: blk.rule, cls: blk.cls, why: `json:${blk.why}`, from: map[blk.from], to: map[blk.to] })
    re.lastIndex = Math.max(re.lastIndex, i)
  }
  return out
}

/** Every detector but the headless tails, from `start` on, in the order a screen ranks spans that
 *  start together: key blocks, PuTTY, JWK, RSAKeyValue, base64, URL-encoded and JSON-escaped key
 *  files. The key blocks come back on their own too: headless needs them once the screen knows
 *  where its cut is. */
function keySpansOnce(text: string, start: number, cutText: boolean): { blocks: KeyBlock[]; spans: KeySpan[] } {
  const blocks = keyBlocks(text, start)
  const spans: KeySpan[] = []
  // Appended one by one: `push(...found)` passes every span as an argument, and throws (call stack
  // exceeded) once a detector finds a few hundred thousand (8 MB of JWKs).
  for (const found of [blocks, puttyKeys(text, start), jwkKeys(text, start), rsaKeyValues(text, start), encodedKeys(text, start, cutText), percentEncoded(text, start), jsonEscaped(text, start)]) {
    for (const s of found) spans.push(s)
  }
  return { blocks, spans }
}

// ---------------------------------------------------------------------------------------------
// Where the detectors start when only the end of a text is kept: each looks back for its own
// opener, bounded by its own largest size, so no fixed lookback has to cover the longest.
// ---------------------------------------------------------------------------------------------
/** A key block's BEGIN line is looked for 256 KB back at most: a longer block the cut runs through
 *  is still removed from its END line by headless, so this reach only decides whether the removal
 *  is counted with its BEGIN line, and it bounds the cost. */
const REACH_BEGIN = 262144
const REACH_OPENVPN = 16384
const REACH_PUTTY = 65536
const REACH_KTY = 8192
const REACH_XML = 16384
const REACH_BASE64 = 65536

/** Characters a wrapped, indented or quoted base64 run is made of. */
const B64ISH = new Uint8Array(65536)
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/= \t\r\n"\'|>-') B64ISH[c.charCodeAt(0)] = 1

/** Where the last `needle` that starts in [floor, at) starts, or -1: linear in at - floor, never
 *  past floor. */
function lastIndexIn(text: string, needle: string, at: number, floor: number): number {
  // Back in chunks, so a missing needle costs at - floor, not at. Each chunk ends where a needle
  // that starts just before its end would end; the next one overlaps it by the needle's length.
  const CH = 65536
  for (let hi = at; hi > floor; hi -= CH) {
    const lo = Math.max(floor, hi - CH - needle.length)
    const i = text.slice(lo, hi + needle.length - 1).lastIndexOf(needle)
    if (i !== -1) return lo + i
  }
  return -1
}

/** Where the key detectors start screening `input` when what is kept starts at `from`: `lookback`
 *  before it, as the token rules, or further back where a detector's own opener is. Only when the
 *  cut falls in or near a run of key-shaped lines does a key block's BEGIN line matter: it is
 *  looked for when a 40-character base64 run lies within 4 KB of the cut. */
export function detectorStart(input: string, from: number, lookback: number): number {
  if (from === 0) return 0
  let s = Math.max(0, from - lookback)
  const near = input.slice(Math.max(0, from - 4096), Math.min(input.length, from + 4096))
  if (/[A-Za-z0-9+/=]{40}/.test(near)) {
    const p = lastIndexIn(input, 'PRIVATE KEY', from + 64, Math.max(0, from - REACH_BEGIN))
    if (p !== -1) s = Math.min(s, Math.max(0, p - 64))
    const v = lastIndexIn(input, 'OpenVPN Static key', from, Math.max(0, from - REACH_OPENVPN))
    if (v !== -1) s = Math.min(s, Math.max(0, v - 16))
    const q = lastIndexIn(input, 'Private-Lines:', from, Math.max(0, from - REACH_PUTTY))
    if (q !== -1) s = Math.min(s, Math.max(0, q - 16384))
  }
  const k = lastIndexIn(input, 'kty', from, Math.max(0, from - REACH_KTY))
  if (k !== -1) s = Math.min(s, Math.max(0, k - 4096))
  const x = lastIndexIn(input, 'RSAKeyValue', from, Math.max(0, from - REACH_XML))
  if (x !== -1) s = Math.min(s, x)
  // A base64 run (an encoded key file) the cut runs through: back to its start, 64 KB at most.
  let b = from
  const floor = Math.max(0, from - REACH_BASE64)
  while (b > floor && B64ISH[input.charCodeAt(b - 1)] === 1) b--
  return Math.min(s, b)
}

/** keySpans, reading a backslash and letter that may be a Windows path's every way its text allows (see readEveryWay). */
export function keySpans(text: string, start = 0, cutText = false): { blocks: KeyBlock[]; spans: KeySpan[] } {
  return readEveryWay(
    () => keySpansOnce(text, start, cutText),
    (a, b) => ({ blocks: joinBlocks(a.blocks, b.blocks), spans: joinSpans(a.spans, b.spans) }),
  )
}

/** headless, read every way like keySpans. */
export function headless(text: string, blocks: readonly KeyBlock[], opts: { start?: number; cutAt?: number; screenedStart?: boolean } = {}): KeySpan[] {
  return readEveryWay(() => headlessOnce(text, blocks, opts), joinSpans)
}

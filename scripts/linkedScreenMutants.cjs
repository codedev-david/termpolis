#!/usr/bin/env node
// Mutation checks for the Linked machines credential screen (design T12): each mutant weakens one
// decision of the screen, and the unit tests must fail on every one. A mutant that survives names a
// test that is missing. Offline, by hand, before a review of a change to the screen: each mutant
// is a vitest run of the screen's six test files, about a minute, so a group takes 20 minutes or
// more.
//
//   node scripts/linkedScreenMutants.cjs [judge|wiring|review|all] [part of a mutant's name]
//
//   judge   (the default) the design's own 20 mutants of its decisions, ported from the judge's
//           prototype probe (k9-mutants-final.cjs) to the TypeScript; its 21st, "public: never
//           public", went with publicStructure, which the port drops
//   wiring  what screenText does with the detectors, and the asking side's cut (two of these are
//           equivalent by construction and expected to survive: see EQUIVALENT)
//   review  the guards the round-1 fixes of the review's findings added
//
// Each mutant edits its source file in place, and the file is written back after the run, and
// at the end whatever happens. The script refuses to start while any of the files it edits has
// changes git doesn't have: if a run is killed, `git checkout -- src/main` puts them back. It
// prints, for each mutant, the tests that failed on it, and exits 1 if one survived that should
// not, or its text is no longer in the source.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const KEY = 'src/main/keyMaterial.ts'
const SCREEN = 'src/main/aiSecurity.ts'
const JOBS = 'src/main/linkedJobs.ts'
const TOOL = 'src/main/linkedTool.ts'
const HOST = 'src/main/linkedHost.ts'
const TESTS = [
  'tests/electron/keyMaterial.test.ts',
  'tests/electron/aiSecurityScreen.test.ts',
  'tests/electron/linkedJobs.test.ts',
  'tests/electron/linkedTool.test.ts',
  'tests/electron/linkedHost.test.ts',
  'tests/electron/linkedEndToEnd.test.ts',
]

/** [file, the exact text, its replacement, and optionally more test files to run besides TESTS]. The text must be
 *  in the file exactly once. */
const JUDGE = {
  'pgp: tag + version only': [KEY, 'const ao = v === 3 ? o + 7 : o + 5', 'if (v > 0) return { tag, v, algo: 0 }\n  const ao = v === 3 ? o + 7 : o + 5'],
  'pgp: random required (J9 reverted)': [KEY, "if ((st.type === 'openssh' || st.type === 'pgp') && payload >= LONG_PAYLOAD)", "if (st.type === 'openssh' && payload >= LONG_PAYLOAD)"],
  'decodeHead: glue dropped from the first line only (J8 reverted)': [KEY, 'head += k > 0 && r.startsWith(glue) ? r.slice(k) : r', "head += k > 0 && head === '' && r.startsWith(glue) ? r.slice(k) : r"],
  'decode: any family under any kind': [KEY, 'const st = st0 && family.includes(st0.type) ? st0 : null', 'const st = st0'],
  'random: always true': [KEY, 'export function looksRandom(s: string): boolean {', 'export function looksRandom(s: string): boolean {\n  if (s.length >= 0) return true'],
  'W1: unverifiable block removed': [KEY, "return span('flag', random ? 'unverified' : 'not-key-material')", "return span(random ? 'remove' : 'flag', random ? 'unverified' : 'not-key-material')"],
  'W2: verified fragment flagged': [KEY, "random) return span('remove', `${st.type}-incomplete`)", "random) return span('flag', `${st.type}-incomplete`)"],
  'frame: 64 raw characters first (J1 reverted)': [KEY, 'frameOf(text.slice(Math.max(lineStart, r0 - 512), r0)).slice(-64)', 'frameOf(text.slice(Math.max(lineStart, r0 - 64), r0))'],
  'legacy PEM: no DEK-Info needed': [KEY, 'const legacy = headers.some((h) => /Proc-Type: ?4,ENCRYPTED/.test(h)) && headers.some((h) => DEK_RE.test(h))', 'const legacy = headers.some((h) => /Proc-Type/.test(h))'],
  'tail: no head anchor (J6 reverted)': [KEY, "if (head !== null) out.push({ rule, cls: 'remove', why: 'tail-with-end'", "if (head !== -2) out.push({ rule, cls: 'remove', why: 'tail-with-end'"],
  'tail: no joiner-fragment skip': [KEY, '(runs.length > 0 && joinerOnly && seg.length <= 16 && !skipped)', '(runs.length < 0)'],
  'tail: no short cut tail': [KEY, '} else if (framed && opts.cutAt === 0 && floor === start && runs.length >= 1', '} else if (framed && opts.cutAt === -1 && floor === start && runs.length >= 1'],
  'tail: strict partial-line frame': [KEY, "if (fr !== '' && !loose(frame).endsWith(loose(fr)) && !JOINER_FRAME.test(m.frame)", "if (fr !== '' && !frame.endsWith(fr)"],
  'ppk: no length from Private-Lines': [KEY, "const cls = (got.length >= 2 || (got.length === n && n > 0)) && looksRandom(all) ? 'remove' : 'flag'", "const cls = got.length > 0 ? 'remove' : 'flag'"],
  'b64: removed on the signature alone': [KEY, "const cls = inner.some((s) => s.cls === 'remove') ? 'remove' : 'flag'", "const cls = inner.length >= 0 ? 'remove' : 'flag'"],
  'jwk: no randomness test': [KEY, 'ok = ok.filter((p) => looksRandomToken(p.value, p.cut))', 'ok = ok.filter((p) => p.value.length > 0)'],
  'J13: no short last line with no END line': [KEY, 'const endOfKey = endAt !== -1 && runs.length ? endEnd : tailEnd', 'const endOfKey = endAt !== -1 && runs.length ? endEnd : lastPayloadEnd'],
  'J13: no VB newline constants': [KEY, "const blankNl = (s: string): string => s.replace(NL_CONST, (x) => ' '.repeat(x.length))", 'const blankNl = (s: string): string => s'],
  'url: R9 off': [KEY, "if (text.indexOf('-----BEGIN%20', start) === -1 && text.indexOf('-----BEGIN+', start) === -1) return out", 'if (start >= 0) return out'],
  'keepEnd: move every marker-shaped string': [
    JOBS,
    'export function keepEnd(text: string, max: number, markers: SecretScreen[\'markers\']): MarkedText {\n',
    "export function keepEnd(text: string, max: number, markers: SecretScreen['markers']): MarkedText {\n  markers = [...text.matchAll(MARKER_RE)].map((m): [number, number] => [m.index ?? 0, (m.index ?? 0) + m[0].length])\n",
  ],
}

const WIRING = {
  'screen: the key-block rules still run': [SCREEN, 'RULES.filter((rule) => !KEY_BLOCK_RULES.has(rule.id))', 'RULES.filter((rule) => rule.id !== KEY_BLOCK_RULES.size.toString())'],
  'screen: no key detectors': [SCREEN, '  for (const span of keys.spans) found.push(span)\n  // Where the tail', "  for (const span of keys.spans) if (span.rule === '') found.push(span)\n  // Where the tail"],
  'screen: no key tails': [SCREEN, "for (const span of headless(input, keys.blocks, { start: keysFrom, cutAt, screenedStart: cutStart === 'screened' })) found.push(span)", "for (const span of headless(input, keys.blocks, { start: keysFrom, cutAt, screenedStart: cutStart === 'screened' })) if (span.rule === '') found.push(span)"],
  'screen: detectors start at the token lookback': [SCREEN, 'const keysFrom = lookback !== undefined ? detectorStart(input, from, Math.max(0, lookback)) : 0', 'const keysFrom = lookback !== undefined ? Math.max(0, from - Math.max(0, lookback)) : 0'],
  'screen: cutStart ignored': [SCREEN, 'const cutAt = cutStart === true ? 0 : from > 0 && !straddled ? from : undefined', 'const cutAt = from > 0 && !straddled ? from : undefined'],
  'screen: a straddled cut not checked': [SCREEN, 'const cutAt = cutStart === true ? 0 : from > 0 && !straddled ? from : undefined', 'const cutAt = cutStart === true ? 0 : from > 0 ? from : undefined'],
  "screen: a JWK's members each counted": [SCREEN, 'if (group === undefined || !groups.has(group)) removed[cut.rule]', 'if (group !== null) removed[cut.rule]'],
  'screen: no table order among cuts that start together': [SCREEN, "const taken = found.filter((f) => f.cls === 'remove').sort((a, b) => a.from - b.from)", "const taken = found.filter((f) => f.cls === 'remove').reverse().sort((a, b) => a.from - b.from)"],
  'mask: no detector spans': [SCREEN, '  for (const span of keys.spans) spans.push(span)\n  for (const span of headless(input, keys.blocks)) spans.push(span)', '  for (const span of headless(input, keys.blocks)) spans.push(span)'],
  'mask: no key tails': [SCREEN, '  for (const span of headless(input, keys.blocks)) spans.push(span)\n', ''],
  'mask: a BEGIN line only to its own end': [SCREEN, "spans.push({ rule: 'private_key', from: m.index, to: eol === -1 ? input.length : eol })", "spans.push({ rule: 'private_key', from: m.index, to: m.index + m[0].length })"],
  'mask: the line end looked for again for every BEGIN marker': [SCREEN, "if (eol !== -1 && eol < m.index) eol = input.indexOf('\\n', m.index)", "if (eol !== -1) eol = input.indexOf('\\n', m.index)", ['tests/electron/linkedScreenCost.test.ts']],
  'lookback: 65,536 again': [JOBS, 'export const SCREEN_LOOKBACK_CHARS = 4_096', 'export const SCREEN_LOOKBACK_CHARS = 65_536'],
  'check: a truncated output not told cut': [TOOL, 'screenTail(view.output, MAX_OUTPUT_CHARS, view.truncated === true && cutBy(job))', 'screenTail(view.output, MAX_OUTPUT_CHARS, false)'],
  'check: an error behind the ellipsis not told cut': [TOOL, "MAX_ERROR_CHARS, view.error.startsWith('…') && cutBy(job))", 'MAX_ERROR_CHARS, false)'],
  'check: every output told cut': [TOOL, 'screenTail(view.output, MAX_OUTPUT_CHARS, view.truncated === true && cutBy(job))', 'screenTail(view.output, MAX_OUTPUT_CHARS, true)'],
  'check: every error told cut': [TOOL, "MAX_ERROR_CHARS, view.error.startsWith('…') && cutBy(job))", 'MAX_ERROR_CHARS, true)'],
  "host: the asking side's binding drops cutStart": [
    HOST,
    '    screen: (text, keep, lookback, cutStart) => b.screenSecrets(text, keep, lookback, cutStart),\n    mask: (text) => b.maskSecrets(text),\n    onSecrets: auditSecrets,\n    onActivity',
    '    screen: (text, keep, lookback) => b.screenSecrets(text, keep, lookback),\n    mask: (text) => b.maskSecrets(text),\n    onSecrets: auditSecrets,\n    onActivity',
  ],
  "host: the doing side's binding drops cutStart": [
    HOST,
    '    screen: (text, keep, lookback, cutStart) => b.screenSecrets(text, keep, lookback, cutStart),\n    mask: (text) => b.maskSecrets(text),\n    onSecrets: auditSecrets,\n  })',
    '    screen: (text, keep, lookback) => b.screenSecrets(text, keep, lookback),\n    mask: (text) => b.maskSecrets(text),\n    onSecrets: auditSecrets,\n  })',
  ],
  'tail: full key lines of any width': [KEY, 'if (w < runs[0][1] - runs[0][0] || w < MIN_RUN) break', 'if (w < runs[0][1] - runs[0][0]) break'],
  'tail: full key lines 17 wide at least': [KEY, 'if (w < runs[0][1] - runs[0][0] || w < MIN_RUN) break', 'if (w < runs[0][1] - runs[0][0] || w <= MIN_RUN) break'],
  'tail: full key lines 15 wide allowed': [KEY, 'if (w < runs[0][1] - runs[0][0] || w < MIN_RUN) break', 'if (w < runs[0][1] - runs[0][0] || w < MIN_RUN - 1) break'],
}

const REVIEW = {
  // FR-1: an END line named in a sentence or code ends no key
  'tail: every END line written as a key\'s': [KEY, 'const framed = endFramed(text, at, floor, runs)', 'const framed = runs.length >= 0'],
  'tail: a cut\'s partial line under any frame': [KEY, 'return TOOL_FRAME.some((re) => re.test(prefix))', 'return prefix.length >= 0'],
  'tail: an unframed END line not reported': [KEY, "else out.push({ rule, cls: 'flag', why: framed ? 'tail-unanchored' : 'tail-unframed'", "else if (framed) out.push({ rule, cls: 'flag', why: framed ? 'tail-unanchored' : 'tail-unframed'"],
  // FR-2: a run whose head the doing side's window start fell under, still in the answer
  'tail: a head in the answer anchored at the window\'s start': [KEY, '&& opts.cutAt !== 0 && headInReach(text, at, opts.cutAt ?? start, runs)', '&& opts.cutAt !== 0 && headInReach(text, at, opts.cutAt ?? start, runs) && runs.length < 0'],
  'tail: the reach\'s partial line read as a head in view': [KEY, 'return logicalLineStart(text, stepBack(text, ls0, lower), lower) > lower', 'return ls0 >= 0'],
  'tail: the text\'s first line read as a partial one': [KEY, '  if (lower === 0) return true\n', ''],
  // cost: one break search per line, one way to match an RSAKeyValue member
  'cost: a fresh break search per block': [KEY, '    const br = nextBr(lineStart, end)\n', '    const br = nextBreak(text, lineStart, end)\n'],
  'cost: an RSAKeyValue value and its trailing whitespace overlap': [KEY, '([A-Za-z0-9+/=][A-Za-z0-9+/=\\s]*)(?=<|&lt;|\\\\u003[cC])/g', '([A-Za-z0-9+/=\\s]{1,}?)\\s*(?=<|&lt;|\\\\u003[cC])/g'],
  'cost: an RSAKeyValue member takes the next tag\'s <': [KEY, '([A-Za-z0-9+/=][A-Za-z0-9+/=\\s]*)(?=<|&lt;|\\\\u003[cC])/g', '([A-Za-z0-9+/=][A-Za-z0-9+/=\\s]*)(?:<|&lt;|\\\\u003[cC])/g'],
  // the final round's cost findings: a run of backslashes or plus signs, repeated anchors
  'cost: nextBreak reads every backslash of a run': [KEY, '      if (c === 92) while (i + 1 < limit && text.charCodeAt(i + 1) === 92) i++\n', ''],
  'cost: nextRun reads every backslash of a run': [KEY, '      if (c === 92) while (i + 1 < stop && text.charCodeAt(i + 1) === 92) i++\n', ''],
  'cost: the legacy header split reads every backslash of a run': [KEY, 'const BREAKS = /\\r\\n|\\r|\\n|(?<!\\\\)\\\\+(?:', 'const BREAKS = /\\r\\n|\\r|\\n|\\\\+(?:'],
  'cost: LINE_END_RUN may start inside a run of base64': [KEY, 'LINE_END_RUN = /(?<![A-Za-z0-9+/=])(?=([A-Za-z0-9+/=]+))\\1[', 'LINE_END_RUN = /[A-Za-z0-9+/=]+['],
  'cost: shortAbove tries every start': [KEY, 'for (let at = Math.max(0, joined - 9); at < s.length; at++) {', 'for (let at = 0; at < s.length; at++) {'],
  'cost: the prose test read afresh for each anchor': [KEY, '  const wordsEnd = proseEnds(text, start)\n', '  const wordsEnd = (from: number): number => proseEnds(text, start)(from)\n'],
  'partialLine: a trailer that starts where the base64 ends not counted': [KEY, 'if (nextTrailer[p] <= runEnd[p]) return', 'if (nextTrailer[p] < runEnd[p]) return'],
  // the final round's leak findings: one line of an EC key, NAME= frames, JSON arrays, a PuTTY file in JSON
  "one line: an EC or EdDSA key's first line not removed (head -2)": [KEY, 'if (runs.length === 1 && st.priv !== undefined) {', 'if (runs.length === -1 && st.priv !== undefined) {'],
  "one line: an RSA key's modulus line removed": [KEY, 'const priv = d ? pkcs8PrivateAt(b, b.subarray(oid.body, oid.end), d) : undefined', 'const priv: [number, number] | undefined = d ? [d.body, d.end] : undefined'],
  'one line: the private value judged with the header it follows': [KEY, 'looksRandomToken(line.slice(Math.ceil((from * 4) / 3), Math.floor((seen * 4) / 3)))', 'looksRandom(line)'],
  'runs: a name and its = part of the run (NAME=line)': [KEY, '    const a = valueStart(text, a0, i)\n    if (i - a >= min) runs.push([a, i])', '    const a = a0\n    if (i - a >= min) runs.push([a, i])'],
  'short last line: a name before its value not read': [KEY, 'const from = valueStart(line, m.index, m.index + m[1].length)', 'const from = m.index'],
  "short last line: a checksum line behind a name framed with its own =": [KEY, 'const crc = from > m.index ? from - 1 : from', 'const crc = from'],
  'json: an array of lines ends at the first closing quote': [KEY, 'if (between || /^"\\s*[,+.&]?\\s*["\']/.test(text.slice(i, i + 64))) {', 'if (text.length < 0) {'],
  'json: a PuTTY file not read': [KEY, "new RegExp(BEGIN_RE.source + '|PuTTY-User-Key-File-', 'g')", "new RegExp(BEGIN_RE.source, 'g')"],
  'short last line: no dot after the short line (PHP)': [KEY, 'const SHORT_TAIL = /^([A-Za-z0-9+/]{1,15}={0,2})[\\s"\'`,;+&_.)\\]}|\\\\]*$/', 'const SHORT_TAIL = /^([A-Za-z0-9+/]{1,15}={0,2})[\\s"\'`,;+&_)\\]}|\\\\]*$/'],
  'short last line: no dot after the checksum line (PHP)': [KEY, 'const CRC_LINE = /^=[A-Za-z0-9+/]{4}[\\s"\'`,;+&_.)\\]}|\\\\]*$/', 'const CRC_LINE = /^=[A-Za-z0-9+/]{4}[\\s"\'`,;+)\\]}|\\\\]*$/'],
  'short last line: no dot in the last run of a line (PHP)': [KEY, ')\\1[\\s"\'`,;+&_.)\\]}|\\\\]*$/', ')\\1[\\s"\'`,;+&_)\\]}|\\\\]*$/'],
  // the final round's K5 findings: a Secret's tls.crt above tls.key, the lines around a value, NAME=<base64>
  "b64: a name and its = part of the first run (NAME=base64)": [KEY, '    const a = valueStart(text, a0, i)\n    // (at the start of a text', '    const a = a0\n    // (at the start of a text'],
  'b64: a second line with a label of its own joins the value': [KEY, 'if (/[A-Za-z]/.test(f) && !(cutText && a0 <= start + 1) && f !== frameAt(text, logicalLineStart(text, a, Math.max(0, a - 512)), a)) break', 'if (f.length < 0) break'],
  'b64: a cut text\'s second line under a label of its own not joined': [KEY, 'if (/[A-Za-z]/.test(f) && !(cutText && a0 <= start + 1) && f !== frameAt(text, logicalLineStart(text, a, Math.max(0, a - 512)), a)) break', 'if (/[A-Za-z]/.test(f) && f !== frameAt(text, logicalLineStart(text, a, Math.max(0, a - 512)), a)) break'],
  'b64: padding does not end a value': [KEY, 'for (let n = 0; n < 65536 && text.charCodeAt(j - 1) !== 61; n++) {', 'for (let n = 0; n < 65536; n++) {'],
  // the final round's tail findings: the BEGIN line's reach from the cut, a PGP checksum behind a path, a legacy key cut in its headers
  "tail: a BEGIN line's reach measured from the window start (F1)": [KEY, 'headInReach(text, at, opts.cutAt ?? start, runs)', 'headInReach(text, at, start, runs)'],
  'tail: a run of 16 anywhere before the checksum line\'s = is a key line': [KEY, "!/[A-Za-z0-9+/]{16}$/.test(seg.slice(0, seg.lastIndexOf('=')))", "!/[A-Za-z0-9+/]{16}/.test(seg.slice(0, seg.lastIndexOf('=')))"],
  'tail: a key line with a checksum glued on is a checksum line': [KEY, " && !/[A-Za-z0-9+/]{16}$/.test(seg.slice(0, seg.lastIndexOf('=')))", ''],
  "legacy cut: a blank line in the key lines' own frame not read": [KEY, " || (frame !== '' && (own(l) === frame || (own(l).startsWith(frame) && FRAGMENT.test(own(l).slice(frame.length)))))\n", "\n"],
  "legacy cut: a literal's joiner-only line under the remnant not read": [KEY, "/^[\\s\\d:|>#*+$-]*$/.test(l) || FRAGMENT.test(l) ||", "/^[\\s\\d:|>#*+$-]*$/.test(l) ||"],
  'legacy cut: the rest of a frame the cut fell in not read': [KEY, " || nlTail(l) || (frame !== '' && own(l) !== '' && loose(frame).endsWith(loose(own(l))))", ' || nlTail(l)'],
  "legacy cut: the rest of a line break or newline constant not read": [KEY, " || escTail(l.replace(TRAILING_HEAD_JOINERS, '')) || nlTail(l)", ""],
  'legacy cut: only \\n and \\r split the lines': [KEY, 'const BREAKS = /\\r\\n|\\r|\\n|(?<!\\\\)\\\\+(?:[nr]|u000[aAdD]|x0[aAdD])|%0[aAdD]|&#(?:x0?[aAdD]|1[03]);|<br\\s*\\/?>|`[nr]/', 'const BREAKS = /\\r\\n|\\r|\\n|(?<!\\\\)\\\\+[nr]/'],
  'legacy cut: newline constants not blanked': [KEY, "blankNl(above.replace(/^…/, '')).split(BREAKS)", "above.replace(/^…/, '').split(BREAKS)"],
  "legacy cut: a blank line in the frame and a closing quote not read (r\"\")": [KEY, "own(l) === frame || (own(l).startsWith(frame) && FRAGMENT.test(own(l).slice(frame.length)))", "own(l) === frame"],
  "legacy cut: a $ at a blank line's end (cat -A) not read": [KEY, "/^[\\s\\d:|>#*+$-]*$/.test(l)", "/^[\\s\\d:|>#*+-]*$/.test(l)"],
  "legacy cut: a $ after the DEK-Info remnant (cat -A) not read": [KEY, ")?[\\s\"'`,;+.&_)\\]}|\\\\$]*$/", ")?[\\s\"'`,;+.&_)\\]}|\\\\]*$/"],
  "legacy cut: a continuation backslash after the escape's tail not read": [KEY, "export const TRAILING_HEAD_JOINERS = /(?<![\\s\"'`,;+.&_\\\\$])[\\s\"'`,;+.&_\\\\$]+$/", "export const TRAILING_HEAD_JOINERS = /(?<![\\s\"'`,;+.&_$])[\\s\"'`,;+.&_$]+$/"],
  "cost: the word-pair test is the regex, tried from each letter of a run": [KEY, "hasWords(line)) return false", "/[A-Za-z]{3,}[ \\t]+[A-Za-z]{3,}/.test(line)) return false"],
  "cost: the legacy first line's joiners taken from each joiner (head)": [KEY, "export const TRAILING_HEAD_JOINERS = /(?<![\\s\"'`,;+.&_\\\\$])[\\s\"'`,;+.&_\\\\$]+$/", "export const TRAILING_HEAD_JOINERS = /[\\s\"'`,;+.&_\\\\$]+$/"],
  "cost: the legacy first line's joiners taken from each joiner (newline constant)": [KEY, "export const TRAILING_NL_JOINERS = /(?<![\\s\"'`,;+&_])[\\s\"'`,;+&_]+$/", "export const TRAILING_NL_JOINERS = /[\\s\"'`,;+&_]+$/"],
  "cost: an RSAKeyValue value's trailing whitespace taken from each blank": [KEY, "export const TRAILING_BLANKS = /(?<!\\s)\\s+$/", "export const TRAILING_BLANKS = /\\s+$/"],
  "cost: DEK_REMNANT's leading whitespace outside its group": [KEY, "export const DEK_REMNANT = /^(?:\\s*(?:[A-Za-z-]*: ?)?(?:[A-Z0-9-]*,)?[0-9A-Fa-f]{1,32})?[\\s\"'`,;+.&_)\\]}|\\\\$]*$/", "export const DEK_REMNANT = /^\\s*(?:(?:[A-Za-z-]*: ?)?(?:[A-Z0-9-]*,)?[0-9A-Fa-f]{1,32})?[\\s\"'`,;+.&_)\\]}|\\\\$]*$/"],
  "words: the first word needs only two letters": [KEY, "if (i - a < 3 || i >= n || !space(s.charCodeAt(i))) continue", "if (i - a < 2 || i >= n || !space(s.charCodeAt(i))) continue"],
  "words: the second word needs only two letters": [KEY, "if (j + 2 < n && isLetter(s.charCodeAt(j)) && isLetter(s.charCodeAt(j + 1)) && isLetter(s.charCodeAt(j + 2))) return true", "if (j + 1 < n && isLetter(s.charCodeAt(j)) && isLetter(s.charCodeAt(j + 1))) return true"],
  // guards no test pinned (the final false-removal review)
  'tail: a lone partial line need not end the END frame': [KEY, "  if (!loose(endFrame).endsWith(loose(keyFrame.replace(/^…/, '')))) return false\n", ''],
  'tail: a number is a clock time': [KEY, '  /\\d{1,2}:\\d\\d:\\d\\d/,', '  /\\d/,'],
  'tail: a flagged block leads (blockLead)': [KEY, "if (!bk || bk.cls === 'flag' || !sameKind(bk, end)) return null", 'if (!bk || !sameKind(bk, end)) return null'],
  'tail: words among the lines under a block (keyShapedLines)': [KEY, ' || hasWords(line)) return false', ') return false'],
  'tail: any last word above an END line is its short last line': [KEY, 'const SHORT_JOINER = /[\\s"\'`,;+&_)\\]}|\\\\$]/', 'const SHORT_JOINER = /\\W/'],
  // the final false-removal round: an OpenVPN key is lines of exactly 32 hex digits; a value that names a key is no key
  'K3: lines of any hex length (a list of sha256sums)': [KEY, "if (v.length !== 32 || !/^[0-9a-f]+$/i.test(v)) return ''", "if (!/^[0-9a-f]+$/i.test(v)) return ''"],
  'K3: a file name after the digits (md5sums)': [KEY, "return /^[\\s\"'`,;+]{1,8}\\+?[0-9a-fA-F]{32}(?![A-Za-z0-9+/=])/.test(rest) || KEY_LINE_TAIL.test(rest) || tailForm(rest) === beginTail ? v : ''", "return v"],
  'K3: a key written on one line, the next value after a space': [KEY, "return /^[\\s\"'`,;+]{1,8}\\+?[0-9a-fA-F]{32}(?![A-Za-z0-9+/=])/.test(rest) || KEY_LINE_TAIL.test(rest) || tailForm(rest) === beginTail ? v : ''", "return KEY_LINE_TAIL.test(rest) || tailForm(rest) === beginTail ? v : ''"],
  'K3: a colour code after the digits': [KEY, "const rest = blankNl(text.slice(e, stop)).replace(/\\x1b\\[[0-9;]*m/g, ' ')", 'const rest = blankNl(text.slice(e, stop))'],
  // the cost findings of the final round 2: PuTTY anchors before a long stretch with no base64 in it, the first frame of a base64 run
  'cost: Private-Lines anchors search a stretch found empty again': [KEY, 'let at = i === emptyFrom ? emptyTo : i', 'let at = i'],
  "putty: a stretch found empty is taken to end at the search's window, not where the search ended": [KEY, '        emptyTo = r\n', '        emptyTo = stop\n'],
  'cost: the first line of a base64 run has its frame worked out for every run': [
    KEY,
    "        if (/[A-Za-z]/.test(f) && !(cutText && a0 <= start + 1) && f !== frameAt(text, logicalLineStart(text, a, Math.max(0, a - 512)), a)) break",
    "        if (f !== frameAt(text, logicalLineStart(text, a, Math.max(0, a - 512)), a) && /[A-Za-z]/.test(f) && !(cutText && a0 <= start + 1)) break",
  ],
  'tail: a path run followed by a listing separator is the payload of a cut key line (leadingRun)': [
    KEY,
    '    const lr = runsIn(text, lineStart, lineEnd, 8).filter(([, e]) => !LISTING_SEP.test(text.slice(e, e + 24)))\n    if (lr.length) {\n      const r = lr.reduce',
    '    const lr = runsIn(text, lineStart, lineEnd, 8)\n    if (lr.length) {\n      const r = lr.reduce',
  ],
  // the leak findings of the final round 2: a legacy key written with a cipher of a 64-bit block that is not DES
  'legacy: only DES takes an IV of 16 digits': [KEY, '(?:(?:DES|BF|CAST5|RC2|IDEA)[A-Z0-9-]*,', '(?:DES[A-Z0-9-]*,'],
  'legacy: any cipher takes an IV of 16 digits': [KEY, '(?:(?:DES|BF|CAST5|RC2|IDEA)[A-Z0-9-]*,[0-9A-Fa-f]{16}', '(?:[A-Z0-9-]{3,32},[0-9A-Fa-f]{16}'],
  // the false-removal findings of the final round 2: the END line of a certificate after a key with no END line of its own
  'scan: any END marker closes a key block': [KEY, '      if (CLOSING_END.test(text)) {', "      if (text.startsWith('-----END ', mk) || text.startsWith('---- END ', mk)) {"],
  "scan: an OpenVPN key's END does not close its block": [KEY, '(?: BLOCK)?|OpenVPN Static key V1)|---- END', '(?: BLOCK)?)|---- END'],
  "scan: an SSH2 key's END does not close its block": [KEY, '|---- END SSH2 ENCRYPTED PRIVATE KEY/y', '/y'],
  'scan: an END line cut before its dashes does not close a block': [KEY, 'OpenVPN Static key V1)|---- END', 'OpenVPN Static key V1)(?=-----)|---- END'],
  // the false-removal findings of the final round 2: base64 of a phrase is a made-up value, not a key's member
  "jwk: base64 of a phrase is random": [KEY, "  if (!hex && printableText(body)) return 'text'\n", ''],
  'jwk: a hex string is read as base64 for a phrase': [KEY, "  if (!hex && printableText(body)) return 'text'", "  if (printableText(body)) return 'text'"],
  'jwk: a phrase of 11 bytes is one': [KEY, '  if (core.length < 16 || /[^A-Za-z0-9+/]/.test(core)) return false', '  if (core.length < 12 || /[^A-Za-z0-9+/]/.test(core)) return false'],
  'jwk: a value with a character outside base64 is read as a phrase': [KEY, '  if (core.length < 16 || /[^A-Za-z0-9+/]/.test(core)) return false', '  if (core.length < 16) return false'],
  'jwk: one unprintable byte still makes a phrase': [KEY, "  for (const x of Buffer.from(core, 'base64')) if (x < 0x20 || x > 0x7e) return false", "  let bad = 0\n  for (const x of Buffer.from(core, 'base64')) if (x < 0x20 || x > 0x7e) bad++\n  if (bad > 1) return false"],
  'jwk: the url-safe alphabet is not read as base64': [KEY, ".replace(/-/g, '+').replace(/_/g, '/')\n  if (core.length < 16", "\n  if (core.length < 16"],
  // the recall findings of the final round 2: a key with no line breaks, an OpenVPN key a script echoes line by line
  'valueStart: a name of any length (the = before a glued checksum)': [KEY, 'return p - a >= MAX_NAME ? a : p + 1', 'return p + 1'],
  'valueStart: a 64-character key line and its checksum read as a name': [KEY, 'return p - a >= MAX_NAME ? a : p + 1', 'return p - a > MAX_NAME ? a : p + 1'],
  'valueStart: a name of 62 characters is none': [KEY, 'return p - a >= MAX_NAME ? a : p + 1', 'return p - a >= MAX_NAME - 2 ? a : p + 1'],
  'K3: a run of 512 digits (line breaks taken out) not read': [KEY, "        const one = /^[^0-9a-fA-F]{0,16}([0-9a-fA-F]{512})$/.exec(text.slice(s, e))\n        if (one) return one[1]\n", ''],
  'K3: a run of 512 digits behind a long frame': [KEY, '/^[^0-9a-fA-F]{0,16}([0-9a-fA-F]{512})$/', '/^[^0-9a-fA-F]{0,100}([0-9a-fA-F]{512})$/'],
  "K3: the header line's text after its marker not used": [KEY, ' || tailForm(rest) === beginTail ? v', ' ? v'],
  'K3: any text after the digits is the same as the header line\'s': [KEY, 'tailForm(rest) === beginTail', 'true'],
  'K3: an echo that starts the file with > and adds with >>': [KEY, ".replace(/>>/g, '>')", ''],
  'K3: the number of a line after its digits': [KEY, ".replace(/\\d+/g, '0').replace(/>>/g, '>')", ".replace(/>>/g, '>')"],
  "K3: a colour code on the header line's text": [KEY, "const tailForm = (s: string): string => s.replace(/\\x1b\\[[0-9;]*m/g, ' ')", 'const tailForm = (s: string): string => s'],
  'K3: a run of six equal hex digits is a placeholder\'s': [KEY, 'const maxRun = hex ? 8 : 5', 'const maxRun = 5'],
  'K3: a run of any length of equal hex digits is random': [KEY, 'const maxRun = hex ? 8 : 5', 'const maxRun = hex ? 100000 : 5'],
  "jwk: an environment variable's name is a key": [KEY, "  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(body)) return 'env-name'\n", ''],
  "jwk: two words of a key's name are a name": [KEY, "  if (new Set(body.toLowerCase().match(NAME_WORDS) ?? []).size >= 2) return 'named'\n", ''],
  "jwk: one word of a key's name is a name": [KEY, 'match(NAME_WORDS) ?? []).size >= 2', 'match(NAME_WORDS) ?? []).size >= 1'],
  'jwk: a truncated key is a key': [KEY, "'redacted', 'truncated', 'elided', 'omitted', ", "'redacted', "],
  // FR-3: an end a 1.55 machine cut is one it screened; a made-up body is no key's tail
  'cut: every machine taken for one that cut first': [TOOL, "const cutBy = (job: Followed): CutStart => (screensBeforeCut(versions.get(refOf(job.target))) ? 'screened' : true)", 'const cutBy = (job: Followed): CutStart => (job ? true : true)'],
  'cut: a screened end anchored at its start': [KEY, '(floor === start && !(opts.screenedStart === true && floor === 0))', '(floor === start)'],
  'cut: the screen not told an end was screened': [SCREEN, "screenedStart: cutStart === 'screened' }", 'screenedStart: false }'],
  'cut: the version asked for no end': [TOOL, "if (versions.has(ref) || !(view.truncated === true || view.error?.startsWith('…') === true)) return", 'if (ref.length >= 0) return'],
  'cut: the version asked for every end': [TOOL, "if (versions.has(ref) || !(view.truncated === true || view.error?.startsWith('…') === true)) return", 'if (versions.has(ref)) return'],
  'cut: what list heard not kept': [TOOL, "        versions.set(refOf(target), typeof hello.version === 'string' ? hello.version : '')\n", ''],
  'cut: any version taken for 1.55': [TOOL, '    if (v !== SCREENS_BEFORE_CUT[i]) return v > SCREENS_BEFORE_CUT[i]\n', '    if (v !== SCREENS_BEFORE_CUT[i]) return true\n'],
  'cut: a made-up remnant taken for a key': [KEY, 'const fake = madeUp(text, runs)', 'const fake = runs.length < 0'],
  'cut: a made-up remnant not reported': [KEY, "else if (fake) out.push({ rule: tailRule(m[0]), cls: 'flag', why: 'cut-tail-made-up'", "else if (fake && runs.length < 0) out.push({ rule: tailRule(m[0]), cls: 'flag', why: 'cut-tail-made-up'"],
  'cut: a made-up line judged by its width alone': [KEY, 'if (long.length) return long.every((l) => new Set(l).size < 16 || ordered(l))', 'if (long.length) return long.every((l) => ordered(l))'],
  'cut: letters in order no sign of a made-up body': [KEY, '      if (n >= 8) return true\n', ''],
  // MX-1, FR-6, FR-7
  'refusal: shown as it came': [TOOL, '      shown = deps.mask(message.length > REFUSAL_MASKED_CHARS ? message.slice(0, REFUSAL_MASKED_CHARS) : message)', '      shown = message'],
  'refusal: the whole of it masked': [TOOL, 'deps.mask(message.length > REFUSAL_MASKED_CHARS ? message.slice(0, REFUSAL_MASKED_CHARS) : message)', 'deps.mask(message)'],
  'refusal: cut before it is masked': [TOOL, 'deps.mask(message.length > REFUSAL_MASKED_CHARS ? message.slice(0, REFUSAL_MASKED_CHARS) : message)', 'deps.mask(message.slice(0, MAX_REFUSAL_CHARS))'],
  'cwd: a drive letter read as a user': [TOOL, 'const URL_USERINFO_RE = /^(?![A-Za-z]:)', 'const URL_USERINFO_RE = /^(?!:)'],
  'jwk: a value the text cut judged by its length': [KEY, 'const named = cut || core.length >= 24', 'const named = core.length >= 24'],
  // the round-0 leaks review: a short last line, a cut in the headers, joinings, uneven lines
  'tail: no short last line stepped over (F-A)': [KEY, '      if (short) {\n        shortFrame = seg.slice(0, short.index)', '      if (short && runs.length < 0) {\n        shortFrame = seg.slice(0, short.index)'],
  'tail: a short last line under any frame': [KEY, "        if (sf !== f && !(s <= floor + 1 && loose(sf).endsWith(loose(f.replace(/^…/, '')))) && !JOINER_FRAME.test(shortFrame)) return []", '        if (sf.length < 0) return []'],
  'tail: a line of dots is a fragment': [KEY, '      const joinerOnly = FRAGMENT_LINE.test(blankNl(seg))', '      const joinerOnly = FRAGMENT.test(blankNl(seg))'],
  'tail: no decoded head (F-B)': [KEY, '      } else if (framed && runs.length > 0 && decodedHead(text, runs, m[0])) {', '      } else if (framed && runs.length < 0 && decodedHead(text, runs, m[0])) {'],
  "tail: a decoded head without a key block's size rules": [KEY, '  if (!looksRandom(all)) return false\n  if (st.type === \'ssh2\') return all.length >= LONG_PAYLOAD\n', '  return true\n'],
  "tail: no legacy key's DEK-Info line above": [KEY, '  if (DEK_RE.test(above)) return true\n', ''],
  "tail: no legacy key's DEK-Info line a cut took": [KEY, '  if (!cutText || a !== floor) return false\n', '  if (cutText || a !== floor) return false\n'],
  'tail: nothing under a key block of its kind (F-ROTATION)': [KEY, '      } else if (lead !== null && !madeUp(text, runs)) {', '      } else if (lead !== null && runs.length < 0) {'],
  'tail: a made-up body under a key block': [KEY, '      } else if (lead !== null && !madeUp(text, runs)) {', '      } else if (lead !== null) {'],
  'tail: no uneven lines under a key block (F-IRREGULAR)': [KEY, '  return bk.to >= floor && ls - bk.to <= REACH_BEGIN && keyShapedLines(text, bk.to, ls) ? bk.to : null', '  return null'],
  "tail: no rest of a block's own key": [KEY, '      if (holder) {', '      if (holder && runs.length < 0) {'],
  'block: a narrower first line ends it': [KEY, '        if (runs.length > 0 && (closed || (w > width && runs.length > 1) || (runs.length >= 2 && fr !== frames[1]))) {', '        if (runs.length > 0 && (closed || w > width || (runs.length >= 2 && fr !== frames[1]))) {'],
  "block: what goes on past an uneven line not reported": [KEY, '    if (enough && !covered) out.push(', '    if (enough && !covered && rest < 0) out.push('],
  "cut start: a cut's partial first line sets the width (F4)": [KEY, '      } else if (partialHead && runs.length === 1 && w > width) {', '      } else if (partialHead && runs.length === -1 && w > width) {'],
  'breaks: only real ones and \\n (FR-4)': [KEY, '  if (c !== 110 && c !== 114 && c !== 97 && c !== 65 && c !== 100 && c !== 68 && c !== 59 && c !== 62) return -1', '  if (c !== 110 || text.charCodeAt(s - 2) !== 92) return -1'],
  'tail: a newline constant is a run (FR-4)': [KEY, '    const lr = runsIn(blankNl(text.slice(s, e)), 0, e - s, 8)', '    const lr = runsIn(text.slice(s, e), 0, e - s, 8)'],
  "top: the rest of a cut escape is a frame (FR-4)": [KEY, ' && !escTail(m.frame) && ', ' && '],
  "top: the rest of a cut newline constant is a frame (FR-4)": [KEY, " && !nlTail(above.replace(/^…/, '').trimEnd())) return null", ') return null'],
  'b64: no tail of a decoded key file (F-E)': [KEY, '      const inner: KeySpan[] = [...blocks, ...puttyKeys(decoded), ...headless(decoded, blocks, { cutAt: 0 })]', '      const inner: KeySpan[] = [...blocks, ...puttyKeys(decoded)]'],
  "b64: a cut's short first line skipped (F-E)": [KEY, '    if (i - a < 40 && !(cutText && a0 <= start + 1 && i - a >= 4)) continue', '    if (i - a < 40) continue'],
  'json: no escaped base64 read (F-C)': [KEY, '  if (!B64_ESC_RE.test(text.slice(start))) return out\n', '  if (start >= 0) return out\n'],
  'decode: a glue of 3 at most (F-D)': [KEY, '  for (let k = 0; k <= 4; k++) {\n    const glue = text.slice(runs[0][0], runs[0][0] + k)', '  for (let k = 0; k <= 3; k++) {\n    const glue = text.slice(runs[0][0], runs[0][0] + k)'],
  'top: no line continuation in a cut remnant (FR-4)': [KEY, 'let ok = endOk(p) || (p < n && s.charCodeAt(p) === 92 && endOk(p + 1))', 'let ok = endOk(p)'],
  "tail: a PGP checksum only between plain joiners (FR-4)": [KEY, '{4}[\\s"\'`,;+&_.)\\]}|\\\\$]*$/.test(blankNl(seg))', '{4}[\\s"\'`,;+)\\]}|\\\\]*$/.test(seg)'],
  "cut: a key's first bytes taken for a tail": [KEY, 'const fake = madeUp(text, runs) || keyHead(text, runs)', 'const fake = madeUp(text, runs)'],
  'cut: lines of hex digests taken for a key': [KEY, "  if (hexy.length && hexy.every((l) => /^[0-9a-fA-F]+$/.test(l))) return true\n", ''],
  'tail: a made-up run anchored as a key tail': [KEY, 'const head = framed && !ownFloor && !madeUp(text, runs) ?', 'const head = framed && !ownFloor ?'],
  "tail: a legacy key's tail from its first line under a block": [KEY, '(legacy ? lead ?? runs[0][0] :', '(legacy ? runs[0][0] :'],
  "nl: a newline constant's name inside a key's base64 blanked": [KEY, '/(?<![A-Za-z0-9/=_])(?:vbCrLf|vbNewLine|vbLf|Environment\\.NewLine|System\\.lineSeparator\\(\\)|os\\.linesep|PHP_EOL)(?![A-Za-z0-9/=_])/g', '/vbCrLf|vbNewLine|vbLf|Environment\\.NewLine|System\\.lineSeparator\\(\\)|os\\.linesep|PHP_EOL/g'],
  'cut: what the cut left of the line above not counted to 16': [KEY, 'last.short : 0) : top - from', 'last.short : 0) : 0'],
  'cut: a last line of 1-7 not counted to 16': [KEY, 'last.short > 0 ? (from === runs[0][0] ? last.short : 0) :', 'last.short > 0 ? 0 :'],
  'cut: a last line counted under a line between the partial one and it': [KEY, '(from === runs[0][0] ? last.short : 0)', 'last.short'],
  'cut: a partial line counted where it does not start the text': [KEY, 'const extra = !atTop ? 0 :', 'const extra ='],
  "cut: a truncated OpenSSH example's magic, cut inside, taken for a tail": [KEY, "OPENSSH_RUN.includes(b.toString('latin1'))", 'false'],
  'block: a header glued to a colour code not read as one': [KEY, '|\\x1b\\[[0-9;]{0,16}m)(Proc-Type', ')(Proc-Type'],
}

/** Mutants no test can kill, because they change nothing the screen returns. */
const EQUIVALENT = new Set([
  // A flag a text's start gets when a removal runs through the cut starts inside that removal, so
  // it always overlaps it and is never counted: the check only saves the search.
  'screen: a straddled cut not checked',
  // The doing side's jobs are its own, never an end another computer cut: nothing passes cutStart.
  "host: the doing side's binding drops cutStart",
  // The starts shortAbove tries before the last 9 characters before the joiners cannot match (a token is 7 at most,
  // with two = after it): the bound only bounds the work, and the cost shapes (a 64,000 character line) time it.
  'cost: shortAbove tries every start',
  // The first line's frame is worked out when a second line has letters in its frame, not for every run of 40 characters: the same
  // result, and the work it saves is a constant factor of a dense document (x6 main for a line of sha256 sums, x1.6 now) that no
  // bound on a 200,000-character answer can tell from the frame's: the cost of the old order is measured by the verifier's dense-text probe.
  'cost: the first line of a base64 run has its frame worked out for every run',
])

const group = process.argv[2] ?? 'judge'
const only = process.argv[3]
const mutants = group === 'all' ? { ...JUDGE, ...WIRING, ...REVIEW } : group === 'wiring' ? WIRING : group === 'review' ? REVIEW : group === 'judge' ? JUDGE : null
if (!mutants) {
  console.error('usage: node scripts/linkedScreenMutants.cjs [judge|wiring|review|all] [part of a mutant name]')
  process.exit(2)
}
const files = [...new Set(Object.values(mutants).map(([file]) => file))]
const dirty = spawnSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' })
if (dirty.status !== 0 || dirty.stdout.trim()) {
  console.error(`refusing to run: commit or stash the changes to ${files.join(', ')} first`)
  process.exit(2)
}
const originals = new Map(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]))
const restore = () => {
  for (const [f, src] of originals) fs.writeFileSync(path.join(ROOT, f), src)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-mutants-'))
const json = path.join(tmp, 'run.json')
// vitest's own entry point, run by this node: no shell between this script and the tests.
const vitest = path.join(path.dirname(require.resolve('vitest/package.json', { paths: [ROOT] })), 'vitest.mjs')
// What a vitest file that could not start says (a worker that did not come up, a timeout, no memory): under load these look like a
// run with no failed test, and a mutant would be reported SURVIVED when it was never run. A file that fails to LOAD for another
// reason (the mutated source throws as it is imported) is a failure the mutant caused, and kills it.
const COULD_NOT_RUN = /Failed to start|worker|time ?out|ENOMEM|EAGAIN|EBUSY|spawn|out of memory|heap/i

/** Runs the tests with the sources as they are on disk: { ran, failed (titles), noRun (why a file did not start) }. */
function runTests(more) {
  fs.rmSync(json, { force: true })
  const run = spawnSync(process.execPath, [vitest, 'run', ...TESTS, ...(more ?? []), '--reporter=json', `--outputFile=${json}`], { cwd: ROOT, encoding: 'utf8' })
  const failed = []
  const noRun = []
  let ran = 0
  try {
    const report = JSON.parse(fs.readFileSync(json, 'utf8'))
    ran = report.numTotalTests
    for (const f of report.testResults) {
      for (const a of f.assertionResults) if (a.status === 'failed') failed.push(`${path.basename(f.name)}: ${a.title}`)
      if (f.status === 'failed' && f.assertionResults.length === 0) {
        const why = String(f.message || '').split('\n')[0]
        if (COULD_NOT_RUN.test(why)) noRun.push(`${path.basename(f.name)}: ${why}`)
        else failed.push(`${path.basename(f.name)}: did not load (${why})`)
      }
    }
  } catch {
    noRun.push(`no report (vitest exited ${run.status})`)
  }
  return { ran, failed, noRun }
}

let bad = 0
try {
  // The tests as they are, once for each set of test files a mutant runs: how many there are, so a run of a mutant that ran fewer
  // is known not to be a whole run.
  const baselines = new Map()
  const baseline = (more) => {
    const key = (more ?? []).join('|')
    if (!baselines.has(key)) {
      const b = runTests(more)
      if (b.failed.length || b.noRun.length) {
        console.log(`the tests do not pass as they are (${b.failed.length} failed, ${b.noRun.length} files did not run): fix that first`)
        for (const t of [...b.failed, ...b.noRun].slice(0, 6)) console.log(`           ${t}`)
        process.exit(2)
      }
      console.log(`baseline: ${b.ran} tests pass${more ? ` (with ${more.join(', ')})` : ''}`)
      baselines.set(key, b)
    }
    return baselines.get(key)
  }
  for (const [name, [file, from, to, more]] of Object.entries(mutants)) {
    if (only && !name.includes(only)) continue
    const src = originals.get(file)
    const n = src.split(from).length - 1
    if (n !== 1) {
      console.log(`BAD MUTANT  ${name}: its text is in ${file} ${n} times, not once`)
      bad++
      continue
    }
    const base = baseline(more)
    fs.writeFileSync(path.join(ROOT, file), src.replace(from, to))
    const { ran, failed, noRun } = runTests(more)
    restore()
    const killed = failed.length > 0
    // (a run that lost tests, or a file that did not start, with no failure to show for it, proves nothing: run it again alone)
    if (!killed && (noRun.length > 0 || ran !== base.ran)) {
      bad++
      console.log(`NO RUN   ${name} (${ran} of ${base.ran} tests ran)`)
      for (const t of noRun.slice(0, 4)) console.log(`           ${t}`)
      continue
    }
    const expected = EQUIVALENT.has(name) ? !killed : killed
    if (!expected) bad++
    const verdict = killed ? 'KILLED  ' : EQUIVALENT.has(name) ? 'EQUIVALENT' : 'SURVIVED'
    console.log(`${verdict} ${name} (${failed.length} of ${ran} tests failed)`)
    for (const t of failed.slice(0, 4)) console.log(`           ${t}`)
  }
} finally {
  restore()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(bad ? `${bad} mutant(s) not as expected` : 'every mutant as expected')
process.exit(bad ? 1 : 0)

#!/usr/bin/env node
// Mutation checks for the Linked machines credential screen (design T12): each mutant weakens one
// decision of the screen, and the unit tests must fail on every one. A mutant that survives names a
// test that is missing. Offline, by hand, before a review of a change to the screen: each mutant
// is a vitest run of the screen's six test files, about a minute, so a group takes 20 minutes or
// more.
//
//   node scripts/linkedScreenMutants.cjs [judge|wiring|review|all] [part of a mutant's name, or several parts joined with |]
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
// runs the tests once as they are first (once more for each set of extra test files a mutant
// names), so it knows how many there are, and prints, for each mutant, the tests that failed on
// it and how many ran. A run that has fewer tests than that, or a test file that did not start
// (a worker that did not come up under load, a timeout) and no failed test to show for it, is
// NO RUN, not SURVIVED: it proves nothing, and the mutant is run again alone. The script exits 1
// if a mutant survived that should not, was not run, or its text is no longer in the source.
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
  'jwk: no randomness test': [KEY, 'const ok = priv.filter((p) => privateSized(kty, crv, p.name, p.value) && looksRandomToken(p.value, p.cut))', 'const ok = priv.filter((p) => privateSized(kty, crv, p.name, p.value) && p.value.length > 0)'],
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
  "one line: an RSA key's modulus line removed": [KEY, 'const priv = d ? pkcs8PrivateAt(b, algorithm, d) : undefined', 'const priv: [number, number] | undefined = d ? [d.body, d.end] : undefined'],
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
  'legacy cut: newline constants not blanked': [KEY, "splitBreaks(blankNl(above.replace(/^…/, '')))", "splitBreaks(above.replace(/^…/, ''))"],
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
  'K3: a file name after the digits (md5sums)': [KEY, "return /^[\\s\"'`,;+]{1,8}\\+?[0-9a-fA-F]{32}(?![A-Za-z0-9+/=])/.test(rest) || KEY_LINE_TAIL.test(rest) || tailForm(rest) === beginTailOf() ? v : ''", "return v"],
  'K3: a key written on one line, the next value after a space': [KEY, "return /^[\\s\"'`,;+]{1,8}\\+?[0-9a-fA-F]{32}(?![A-Za-z0-9+/=])/.test(rest) || KEY_LINE_TAIL.test(rest) || tailForm(rest) === beginTailOf() ? v : ''", "return KEY_LINE_TAIL.test(rest) || tailForm(rest) === beginTailOf() ? v : ''"],
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
    '    const lr = runsIn(text, lineStart, lineEnd, 8).filter(([, e]) => !isPathRun(text, e, lineEnd))\n    if (lr.length) {\n      const r = lr.reduce',
    '    const lr = runsIn(text, lineStart, lineEnd, 8)\n    if (lr.length) {\n      const r = lr.reduce',
  ],
  // the leak findings of the final round 2: a legacy key written with a cipher of a 64-bit block that is not DES
  'legacy: only DES takes an IV of 16 digits': [KEY, '(?:(?:DES|BF|CAST5|RC2|RC5|IDEA)[A-Z0-9-]*,', '(?:DES[A-Z0-9-]*,'],
  'legacy: any cipher takes an IV of 16 digits': [KEY, '(?:(?:DES|BF|CAST5|RC2|RC5|IDEA)[A-Z0-9-]*,[0-9A-Fa-f]{16}', '(?:[A-Z0-9-]{3,32},[0-9A-Fa-f]{16}'],
  // the false-removal findings of the final round 2: the END line of a certificate after a key with no END line of its own
  'scan: any END marker closes a key block': [KEY, '      if (CLOSING_END.test(text)) {', "      if (text.startsWith('-----END ', mk) || text.startsWith('---- END ', mk)) {"],
  "scan: an OpenVPN key's END does not close its block": [KEY, '(?: BLOCK)?|OpenVPN Static key V1)|---- END', '(?: BLOCK)?)|---- END'],
  "scan: an SSH2 key's END does not close its block": [KEY, '|---- END SSH2 ENCRYPTED PRIVATE KEY/y', '/y'],
  'scan: an END line cut before its dashes does not close a block': [KEY, 'OpenVPN Static key V1)|---- END', 'OpenVPN Static key V1)(?=-----)|---- END'],
  // the false-removal findings of the final round 2: base64 of a phrase is a made-up value, not a key's member
  "jwk: base64 of a phrase is random": [KEY, "  if (!decoded && !hex && printableText(body)) return 'text'\n", ''],
  'jwk: a hex string is read as base64 for a phrase': [KEY, "  if (!decoded && !hex && printableText(body)) return 'text'", "  if (!decoded && printableText(body)) return 'text'"],
  'jwk: a phrase of 11 bytes is one': [KEY, '  if (core.length < 16 || /[^A-Za-z0-9+/]/.test(core)) return false', '  if (core.length < 12 || /[^A-Za-z0-9+/]/.test(core)) return false'],
  'jwk: a value with a character outside base64 is read as a phrase': [KEY, '  if (core.length < 16 || /[^A-Za-z0-9+/]/.test(core)) return false', '  if (core.length < 16) return false'],
  'jwk: one unprintable byte still makes a phrase': [
    KEY,
    "  for (const x of bytes) if ((x < 0x20 && x !== 9 && x !== 10 && x !== 13) || x > 0x7e) return false",
    "  let bad = 0\n  for (const x of bytes) if ((x < 0x20 && x !== 9 && x !== 10 && x !== 13) || x > 0x7e) bad++\n  if (bad > 1) return false",
  ],
  'jwk: a line feed ends a phrase (what echo adds to a text base64 encodes)': [KEY, '(x < 0x20 && x !== 9 && x !== 10 && x !== 13)', '(x < 0x20 && x !== 9 && x !== 13)'],
  'jwk: a carriage return ends a phrase': [KEY, '(x < 0x20 && x !== 9 && x !== 10 && x !== 13)', '(x < 0x20 && x !== 9 && x !== 10)'],
  'jwk: a tab ends a phrase': [KEY, '(x < 0x20 && x !== 9 && x !== 10 && x !== 13)', '(x < 0x20 && x !== 10 && x !== 13)'],
  'jwk: a byte over 0x7e is text': [KEY, '|| x > 0x7e) return false', '|| x > 0xff) return false'],
  'jwk: a control character is text': [KEY, '(x < 0x20 && x !== 9 && x !== 10 && x !== 13)', '(x < 0x01 && x !== 9 && x !== 10 && x !== 13)'],
  'jwk: the url-safe alphabet is not read as base64': [KEY, ".replace(/-/g, '+').replace(/_/g, '/')\n  if (core.length < 16", "\n  if (core.length < 16"],
  // the recall findings of the final round 2: a key with no line breaks, an OpenVPN key a script echoes line by line
  'valueStart: a name of any length (the = before a glued checksum)': [KEY, 'return p - a >= MAX_NAME ? a : p + 1', 'return p + 1'],
  'valueStart: a 64-character key line and its checksum read as a name': [KEY, 'return p - a >= MAX_NAME ? a : p + 1', 'return p - a > MAX_NAME ? a : p + 1'],
  'valueStart: a name of 62 characters is none': [KEY, 'return p - a >= MAX_NAME ? a : p + 1', 'return p - a >= MAX_NAME - 2 ? a : p + 1'],
  'K3: a run of 512 digits (line breaks taken out) not read': [KEY, "        if (one && s - me <= MAX_ONE_RUN_LEAD && !/[A-Za-z]/.test(blankNl(text.slice(me, s).replace(ESC_ALL_RE, ' ')))) return one[1]\n", ''],
  'K3: a run of 512 digits behind a long frame': [KEY, '/^[^0-9a-fA-F]{0,16}([0-9a-fA-F]{512})$/', '/^[^0-9a-fA-F]{0,100}([0-9a-fA-F]{512})$/'],
  "K3: the header line's text after its marker not used": [KEY, ' || tailForm(rest) === beginTailOf() ? v', ' ? v'],
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
  // Round 3 of the review: each fix of that round, the guard of each, and the reach of every opener. Each is killed by the tests
  // of the commit that added the guard (keyMaterial.test.ts, linkedJobs.test.ts).
  "r3 listing: fix1 reverted (junk first run kept)": [KEY, "const st0 = decodeHead(text, runs) ?? (runs.length >= 3 && runs[0][1] - runs[0][0] < runs[1][1] - runs[1][0] ? decodeHead(text, runs.slice(1)) : null)", "const st0 = decodeHead(text, runs)"],
  "r3 listing: both path tests dropped": [KEY, "return PATH_REST_SEP.test(rest) || (limit - e <= 112 && PATH_REST_END.test(rest))", "return false"],
  "r3 listing: line-end alternative dropped": [KEY, "return PATH_REST_SEP.test(rest) || (limit - e <= 112 && PATH_REST_END.test(rest))", "return PATH_REST_SEP.test(rest)"],
  "r3 listing: path rest + separator dropped": [KEY, "return PATH_REST_SEP.test(rest) || (limit - e <= 112 && PATH_REST_END.test(rest))", "return PATH_REST_END.test(rest) || (limit - e <= 112 && PATH_REST_END.test(rest))"],
  "r3 listing: line-end test without the length bound": [KEY, "return PATH_REST_SEP.test(rest) || (limit - e <= 112 && PATH_REST_END.test(rest))", "return PATH_REST_SEP.test(rest) || PATH_REST_END.test(rest)"],
  "r3 listing: path rest read 12 characters only": [KEY, "text.slice(e, Math.min(limit, e + 112))\n  return", "text.slice(e, Math.min(limit, e + 12))\n  return"],
  "r3 bare JWK: reach back to 1 KB (the round 2 window)": [KEY, "const BARE_REACH = 16384", "const BARE_REACH = 1024"],
  "r3 bare JWK: reach 64 KB": [KEY, "const BARE_REACH = 16384", "const BARE_REACH = 65536"],
  "r3 bare JWK: above candidate dropped (kty-last objects)": [KEY, "if (above !== null && privateName(above.kty, name)) cands.push(above)", "if (false as boolean) cands.push(above as BareKty)"],
  "r3 bare JWK: below candidate dropped (kty-first objects)": [KEY, "if (below !== null && privateName(below.kty, name)) cands.push(below)", "if (false as boolean) cands.push(below as BareKty)"],
  "r3 bare JWK: only the first candidate tried": [KEY, "      if (!privateSized(c.kty, undefined, p.name, p.value) || !looksRandomToken(p.value, p.cut)) continue", "      if (c !== p.cands[0] || !privateSized(c.kty, undefined, p.name, p.value) || !looksRandomToken(p.value, p.cut)) continue"],
  "r3 bare JWK: ranges not merged where they meet": [KEY, "    if (last !== undefined && lo <= last[1]) last[1] = Math.max(last[1], hi)\n    else ranges.push([lo, hi])", "    ranges.push([lo, hi])"],
  "r3 bare JWK: ranges merged only where they overlap by 1": [KEY, "if (last !== undefined && lo <= last[1]) last[1]", "if (last !== undefined && lo < last[1]) last[1]"],
  "r3 bare JWK: the range end is not kept (a member past it is read)": [KEY, "      if (at >= hi) break\n", ""],
  "r3 bare JWK: the range end is exclusive of one more": [KEY, "      if (at >= hi) break\n", "      if (at > hi) break\n"],
  "r3 bare JWK: a member that starts before the range is read": [KEY, "      if (from + mm.index < lo && lo > 0) continue\n", ""],
  "r3 bare JWK: a member that starts at the range start is not read": [KEY, "      if (from + mm.index < lo && lo > 0) continue\n", "      if (from + mm.index <= lo && lo > 0) continue\n"],
  "r3 bare JWK: the pointer to the key below never moves": [KEY, "      while (g < n && ktys[g].at < at) g++\n", ""],
  "r3 bare JWK: name check dropped (any member of any kty)": [KEY, "const privateName = (kty: string, name: string): boolean => (kty === 'oct' ? name === 'k' : kty === 'RSA' ? RSA_MEMBERS.includes(name) : name === 'd')", "const privateName = (kty: string, name: string): boolean => name !== 'crv' || kty === ''"],
  "r3 bare JWK: every later kty taken for brace-less": [KEY, "if (nextOpen > m.index) {", "if (true as boolean) {"],
  "r3 bare JWK: braced spans not skipped": [KEY, "if (si < skip.length && skip[si][0] <= at) continue", "if (false as boolean) continue"],
  "r3 bare JWK: taken marks one candidate only": [KEY, "for (const x of p.cands) x.taken = true", "c.taken = true"],
  "r3 bare JWK: flag fallback dropped": [KEY, "    const p = c.taken ? undefined : first.get(c)\n", "    const p = undefined as BareMember | undefined\n"],
  "r3 bare JWK: flag fallback for a key that was taken too": [KEY, "    const p = c.taken ? undefined : first.get(c)\n", "    const p = first.get(c)\n"],
  "r3 bare JWK: flag fallback names the last member, not the first": [KEY, "    for (const c of p.cands) if (!first.has(c)) first.set(c, p)\n", "    for (const c of p.cands) first.set(c, p)\n"],
  "r3 bare JWK: flag fallback for any member, not d and k": [KEY, "    if ((p.name !== 'd' && p.name !== 'k') || p.value.length < 8) continue\n", "    if (p.value.length < 8) continue\n"],
  "r3 bare JWK: flag fallback for a value of 3 characters": [KEY, "    if ((p.name !== 'd' && p.name !== 'k') || p.value.length < 8) continue\n", "    if (p.name !== 'd' && p.name !== 'k') continue\n"],
  "r3 backtick: guard dropped (every backtick n/r is an escape)": [KEY, "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45) return null", ""],
  "r3 backtick: dash not a predecessor": [KEY, "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45) return null", "if (!isB64(before) && before !== 34 && before !== 39) return null"],
  "r3 backtick: double quote not a predecessor": [KEY, "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45) return null", "if (!isB64(before) && before !== 39 && before !== 45) return null"],
  "r3 backtick: base64 character not a predecessor": [KEY, "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45) return null", "if (before !== 34 && before !== 39 && before !== 45) return null"],
  "r3 backtick: space is a predecessor": [KEY, "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45) return null", "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45 && before !== 32) return null"],
  "r3 backtick: comma is a predecessor": [KEY, "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45) return null", "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45 && before !== 44) return null"],
  "r3 backtick: newline is a predecessor": [KEY, "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45) return null", "if (!isB64(before) && before !== 34 && before !== 39 && before !== 45 && before !== 10) return null"],
  "r3 OpenVPN: letters check dropped (any 512-digit run in the lead)": [KEY, "if (one && s - me <= MAX_ONE_RUN_LEAD && !/[A-Za-z]/.test(blankNl(text.slice(me, s).replace(ESC_ALL_RE, ' ')))) return one[1]", "if (one) return one[1]"],
  "r3 OpenVPN: written-out breaks count as words": [KEY, "if (one && s - me <= MAX_ONE_RUN_LEAD && !/[A-Za-z]/.test(blankNl(text.slice(me, s).replace(ESC_ALL_RE, ' ')))) return one[1]", "if (one && s - me <= MAX_ONE_RUN_LEAD && !/[A-Za-z]/.test(blankNl(text.slice(me, s)))) return one[1]"],
  "r3 OpenVPN: newline constants count as words": [KEY, "if (one && s - me <= MAX_ONE_RUN_LEAD && !/[A-Za-z]/.test(blankNl(text.slice(me, s).replace(ESC_ALL_RE, ' ')))) return one[1]", "if (one && s - me <= MAX_ONE_RUN_LEAD && !/[A-Za-z]/.test(text.slice(me, s).replace(ESC_ALL_RE, ' '))) return one[1]"],
  "r3 OpenVPN: one run is 512 or more digits": [KEY, "/^[^0-9a-fA-F]{0,16}([0-9a-fA-F]{512})$/.exec(text.slice(s, e))", "/^[^0-9a-fA-F]{0,16}([0-9a-fA-F]{512,})$/.exec(text.slice(s, e))"],
  "r3 OpenVPN: one run is 511 or more digits": [KEY, "/^[^0-9a-fA-F]{0,16}([0-9a-fA-F]{512})$/.exec(text.slice(s, e))", "/^[^0-9a-fA-F]{0,16}([0-9a-fA-F]{500,512})$/.exec(text.slice(s, e))"],
  "r3 OpenVPN: one run frame up to 17": [KEY, "/^[^0-9a-fA-F]{0,16}([0-9a-fA-F]{512})$/.exec(text.slice(s, e))", "/^[^0-9a-fA-F]{0,64}([0-9a-fA-F]{512})$/.exec(text.slice(s, e))"],
  "r3 OpenVPN: begin tail memo never set (recomputed each time)": [KEY, "beginTailMemo = tailForm(text.slice(me, beginBr ? beginBr[0] : Math.min(text.length, me + 1024)))", "return tailForm(text.slice(me, beginBr ? beginBr[0] : Math.min(text.length, me + 1024)))"],
  "r3 OpenVPN: begin tail read for 16 characters only": [KEY, "beginTailMemo = tailForm(text.slice(me, beginBr ? beginBr[0] : Math.min(text.length, me + 1024)))", "beginTailMemo = tailForm(text.slice(me, beginBr ? Math.min(beginBr[0], me + 16) : Math.min(text.length, me + 16)))"],
  "r3 OpenVPN: begin tail not trimmed": [KEY, "const tailForm = (s: string): string => s.replace(/\\x1b\\[[0-9;]*m/g, ' ').replace(/\\d+/g, '0').replace(/>>/g, '>').trim()", "const tailForm = (s: string): string => s.replace(/\\x1b\\[[0-9;]*m/g, ' ').replace(/\\d+/g, '0').replace(/>>/g, '>')"],
  "r3 OpenVPN: tail equality replaced by same length": [KEY, "|| tailForm(rest) === beginTailOf() ? v : ''", "|| tailForm(rest).length === beginTailOf().length ? v : ''"],
  "r3: reach: PRIVATE KEY searched to the text start": [KEY, "lastIndexIn(input, 'PRIVATE KEY', from + 64, Math.max(0, from - REACH_BEGIN))", "lastIndexIn(input, 'PRIVATE KEY', from + 64, 0)"],
  "r3: reach: OpenVPN searched to the text start": [KEY, "lastIndexIn(input, 'OpenVPN Static key', from, Math.max(0, from - REACH_OPENVPN))", "lastIndexIn(input, 'OpenVPN Static key', from, 0)"],
  "r3: reach: Private-Lines searched to the text start": [KEY, "lastIndexIn(input, 'Private-Lines:', from, Math.max(0, from - REACH_PUTTY))", "lastIndexIn(input, 'Private-Lines:', from, 0)"],
  "r3: reach: kty searched to the text start": [KEY, "lastIndexIn(input, 'kty', from, Math.max(0, from - REACH_KTY))", "lastIndexIn(input, 'kty', from, 0)"],
  "r3: reach: RSAKeyValue searched to the text start": [KEY, "lastIndexIn(input, 'RSAKeyValue', from, Math.max(0, from - REACH_XML))", "lastIndexIn(input, 'RSAKeyValue', from, 0)"],
  "r3: reach: base64 walk to the text start": [KEY, "const floor = Math.max(0, from - REACH_BASE64)", "const floor = 0"],
  "r3: reach: PRIVATE KEY 128 KB": [KEY, "const REACH_BEGIN = 262144", "const REACH_BEGIN = 131072"],
  "r3: reach: OpenVPN 4 KB": [KEY, "const REACH_OPENVPN = 16384", "const REACH_OPENVPN = 4096"],
  "r3: reach: Private-Lines 16 KB": [KEY, "const REACH_PUTTY = 65536", "const REACH_PUTTY = 16384"],
  "r3: reach: kty 4 KB": [KEY, "const REACH_KTY = 8192", "const REACH_KTY = 4096"],
  "r3: reach: RSAKeyValue 4 KB": [KEY, "const REACH_XML = 16384", "const REACH_XML = 4096"],
  "r3: reach: base64 walk 16 KB": [KEY, "const REACH_BASE64 = 65536", "const REACH_BASE64 = 16384"],
  "r3: reach: PRIVATE KEY 512 KB": [KEY, "const REACH_BEGIN = 262144", "const REACH_BEGIN = 524288"],
  "r3: reach: OpenVPN 64 KB": [KEY, "const REACH_OPENVPN = 16384", "const REACH_OPENVPN = 65536"],
  "r3: reach: Private-Lines 256 KB": [KEY, "const REACH_PUTTY = 65536", "const REACH_PUTTY = 262144"],
  "r3: reach: kty 64 KB": [KEY, "const REACH_KTY = 8192", "const REACH_KTY = 65536"],
  "r3: reach: RSAKeyValue 64 KB": [KEY, "const REACH_XML = 16384", "const REACH_XML = 65536"],
  "r3: reach: base64 walk 256 KB": [KEY, "const REACH_BASE64 = 65536", "const REACH_BASE64 = 262144"],
  "r3: thresholds: fragment 80 -> 100": [KEY, "if (runs.length >= 2 && payload >= 80 && random) return span('remove', `${st.type}-incomplete`)", "if (runs.length >= 2 && payload >= 100 && random) return span('remove', `${st.type}-incomplete`)"],
  "r3: thresholds: fragment 80 -> 60": [KEY, "if (runs.length >= 2 && payload >= 80 && random) return span('remove', `${st.type}-incomplete`)", "if (runs.length >= 2 && payload >= 60 && random) return span('remove', `${st.type}-incomplete`)"],
  "r3: thresholds: blob short 80 -> 100": [KEY, "return runs.length >= 2 && payload >= 80 && random ? span('remove', `${st.type}-short`)", "return runs.length >= 2 && payload >= 100 && random ? span('remove', `${st.type}-short`)"],
  "r3: thresholds: blob short 80 -> 60": [KEY, "return runs.length >= 2 && payload >= 80 && random ? span('remove', `${st.type}-short`)", "return runs.length >= 2 && payload >= 60 && random ? span('remove', `${st.type}-short`)"],
  "r3: thresholds: LONG_PAYLOAD 128 -> 160": [KEY, "const LONG_PAYLOAD = 128", "const LONG_PAYLOAD = 160"],
  "r3: thresholds: LONG_PAYLOAD 128 -> 100": [KEY, "const LONG_PAYLOAD = 128", "const LONG_PAYLOAD = 100"],
  "r3: thresholds: MAX_BLOCK 4 MB -> 1 MB": [KEY, "const MAX_BLOCK = 4 * 1024 * 1024", "const MAX_BLOCK = 1 * 1024 * 1024"],
  "r3: collapse dropped (fixed parameters read as random only whole)": [KEY, "  const collapsed = sample.replace(/A{6,}|\\/{6,}/g, (run) => run[0])\n  return collapsed.length >= sample.length / 2 && looksRandom(collapsed)", "  return false"],
  "r3: collapse: half-length guard dropped": [KEY, "return collapsed.length >= sample.length / 2 && looksRandom(collapsed)", "return looksRandom(collapsed)"],
  "r3: collapse: any character, not A and /": [KEY, "sample.replace(/A{6,}|\\/{6,}/g, (run) => run[0])", "sample.replace(/(.)\\1{5,}/g, '$1')"],
  "r3: collapse: runs of 2 or more": [KEY, "sample.replace(/A{6,}|\\/{6,}/g, (run) => run[0])", "sample.replace(/A{2,}|\\/{2,}/g, (run) => run[0])"],
  "r3: phrase: no secret words": [KEY, "if (/\\s/.test(body) || SECRET_WORDS.test(body)) return true", "if (/\\s/.test(body)) return true"],
  "r3: phrase: no whitespace test": [KEY, "if (/\\s/.test(body) || SECRET_WORDS.test(body)) return true", "if (SECRET_WORDS.test(body)) return true"],
  "r3: phrase: slug of words dropped": [KEY, "if (segs.length >= 3 && segs.filter((s) => /^[a-z]{2,12}$/.test(s) && /[aeiouy]/.test(s)).length >= 3 && segs.every((s) => /^[a-z0-9]{1,12}$/.test(s))) return true", ""],
  "r3: phrase: shapes of the encoded form not used": [KEY, "return why !== null && TYPED_SHAPES.has(why)", "return false"],
  "r3: phrase: everything printable is a phrase": [KEY, "return phraseLike(bytes.toString('latin1'))", "return true"],
  "r3: phrase: 0x1f is printable": [KEY, "if ((x < 0x20 && x !== 9 && x !== 10 && x !== 13) || x > 0x7e) return false", "if ((x < 0x1f && x !== 9 && x !== 10 && x !== 13) || x > 0x7e) return false"],
  "r3: phrase: 0x7f is printable": [KEY, "if ((x < 0x20 && x !== 9 && x !== 10 && x !== 13) || x > 0x7e) return false", "if ((x < 0x20 && x !== 9 && x !== 10 && x !== 13) || x > 0x7f) return false"],
  "r3: phrase: 0x20 is not printable": [KEY, "if ((x < 0x20 && x !== 9 && x !== 10 && x !== 13) || x > 0x7e) return false", "if ((x < 0x21 && x !== 9 && x !== 10 && x !== 13) || x > 0x7e) return false"],
  "r3: phrase: 0x7e is not printable": [KEY, "if ((x < 0x20 && x !== 9 && x !== 10 && x !== 13) || x > 0x7e) return false", "if ((x < 0x20 && x !== 9 && x !== 10 && x !== 13) || x > 0x7d) return false"],
  "r3: encodedKeys: first frame measured from the run start": [KEY, "f !== frameAt(text, logicalLineStart(text, a, Math.max(0, a - 512)), a)", "f !== frameAt(text, logicalLineStart(text, a0, Math.max(0, a0 - 512)), a0)"],
  // (round 4) The randomness test of a JWK's value at its other two readers: a JWK with no braces, and an RSAKeyValue's members.
  'jwk: no randomness test (a JWK with no braces)': [KEY, 'if (!privateSized(c.kty, undefined, p.name, p.value) || !looksRandomToken(p.value, p.cut)) continue', 'if (!privateSized(c.kty, undefined, p.name, p.value) || p.value.length === 0) continue'],
  'jwk: no randomness test (an RSAKeyValue)': [KEY, 'if (sized && members.every((x) => looksRandomToken(x.value))) {', 'if (sized && members.every((x) => x.value.length > 0)) {'],
  "r3: putty: the NAME= stays in the value": [KEY, "const a = valueStart(text, r[0], glued ? e - 7 : e)", "const a = r[0]"],
  "r3: putty: only a run of 68 or fewer followed at once by a separator is a path (the round 2 state)": [KEY, "if (!beforeMac && escapeAt(text, e) === null && PATH_THEN_RUN.test(text.slice(e, e + 112))) continue", "if (e - a <= 68 && LISTING_SEP.test(text.slice(e, e + 24))) continue"],
  "r3: putty: the rest of a path dropped": [KEY, "if (!beforeMac && escapeAt(text, e) === null && PATH_THEN_RUN.test(text.slice(e, e + 112))) continue", "if (LISTING_SEP.test(text.slice(e, e + 24))) continue"],
  "r3: putty: the separator at once is for a short run only": [KEY, "if (!beforeMac && escapeAt(text, e) === null && PATH_THEN_RUN.test(text.slice(e, e + 112))) continue", "if ((e - a <= 68 && LISTING_SEP.test(text.slice(e, e + 24))) || (!beforeMac && escapeAt(text, e) === null && PATH_THEN_RUN.test(text.slice(e, e + 112)))) continue"],
  "r3: putty: the rest of a path of 20 characters at most": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|", "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,20}?(?::|"],
  "r3: fixed: any structure may collapse (not only EC and DH)": [KEY, "if (!st || !st.fixed) return false", "if (!st) return false"],
  "r3: fixed: SEC1 is not fixed": [KEY, "return { type: 'sec1', declared: outer.end, priv: [c.body, c.end], fixed: true }", "return { type: 'sec1', declared: outer.end, priv: [c.body, c.end] }"],
  "r3: fixed: PKCS#8 only for EC, not DH": [KEY, "isEcOid(algorithm) || isDhOid(algorithm) ? { fixed: true as const } : {}", "isEcOid(algorithm) ? { fixed: true as const } : {}"],
  "r3: fixed: PKCS#8 only for DH, not EC": [KEY, "isEcOid(algorithm) || isDhOid(algorithm) ? { fixed: true as const } : {}", "isDhOid(algorithm) ? { fixed: true as const } : {}"],
  "r3: fixed: the private value is not judged": [KEY, "if (shown.length >= 16 && !looksRandomToken(shown)) return false", ""],
  "r3: fixed: the private value is judged only when 64 characters are shown": [KEY, "if (shown.length >= 16 && !looksRandomToken(shown)) return false", "if (shown.length >= 64 && !looksRandomToken(shown)) return false"],
  "r3: fixed: the DH private value is not located": [KEY, "  if (isDhOid(oid)) {\n    // (a Diffie-Hellman key's private value is the INTEGER inside the OCTET STRING)\n    const x = tlv(b, d.body)\n    return x && x.tag === 0x02 ? [x.body, x.end] : undefined\n  }\n", ""],
  "r3: fixed: PKCS #3 dhKeyAgreement not known": [KEY, "const DH_OIDS = [[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x03, 0x01], [0x2a, 0x86, 0x48, 0xce, 0x3e, 0x02, 0x01]]", "const DH_OIDS = [[0x2a, 0x86, 0x48, 0xce, 0x3e, 0x02, 0x01]]"],
  "r3: fixed: X9.42 dhpublicnumber not known": [KEY, "const DH_OIDS = [[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x03, 0x01], [0x2a, 0x86, 0x48, 0xce, 0x3e, 0x02, 0x01]]", "const DH_OIDS = [[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x03, 0x01]]"],
  "r3: fixed: the DH value is any element, not an INTEGER": [KEY, "return x && x.tag === 0x02 ? [x.body, x.end] : undefined", "return x ? [x.body, x.end] : undefined"],
  "r3: fixed: the head is not kept (the value is judged from nothing)": [KEY, "if (st) return { ...st, offset: k, head }", "if (st) return { ...st, offset: k, head: '' }"],
  "r3: prose: rule dropped": [KEY, "    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length * 16 <= letters.length) return 'prose'", ""],
  "r3: prose: floor 41 letters": [KEY, "    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length * 16 <= letters.length) return 'prose'", "    if (letters.length >= 41 && letters.replace(/[^A-Z]/g, '').length * 16 <= letters.length) return 'prose'"],
  "r3: prose: floor 39 letters": [KEY, "    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length * 16 <= letters.length) return 'prose'", "    if (letters.length >= 39 && letters.replace(/[^A-Z]/g, '').length * 16 <= letters.length) return 'prose'"],
  "r3: prose: one capital in 8 letters": [KEY, "    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length * 16 <= letters.length) return 'prose'", "    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length * 8 <= letters.length) return 'prose'"],
  "r3: prose: one capital in 32 letters": [KEY, "    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length * 16 <= letters.length) return 'prose'", "    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length * 32 <= letters.length) return 'prose'"],
  "r3: prose: no capital allowed (the one-case rule again)": [KEY, "    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length * 16 <= letters.length) return 'prose'", "    if (letters.length >= 40 && letters.replace(/[^A-Z]/g, '').length === 0) return 'prose'"],
  "r3: prose: also for decoded text": [KEY, "  if (!decoded && !/^[0-9a-f]+$/.test(core)) {\n    const letters", "  if (!/^[0-9a-f]+$/.test(core)) {\n    const letters"],
  "r3: prose: lower-case hex is prose": [KEY, "  if (!decoded && !/^[0-9a-f]+$/.test(core)) {\n    const letters", "  if (!decoded) {\n    const letters"],
  "r3: prose: letters counted with digits": [KEY, "const letters = core.replace(/[^A-Za-z]/g, '')", "const letters = core"],
  // (round 4) The three guards of the cost fixes: the written-out line breaks of a stretch are replaced from the first backslash of a run, an OpenVPN key
  // in one run of 512 digits is looked for within 4,096 characters of its BEGIN line, and the line feeds at the end of a typed phrase are found from their first.
  // (The cost test file is the one that fails on them: a quadratic is seconds, and a mutant of this kind runs it for several minutes.)
  'r4: cost: written-out line breaks replaced from each backslash of a run': [KEY, "new RegExp('(?<!" + '\\'.repeat(4) + ")' + ESC_RE.source, 'g')", "new RegExp(ESC_RE.source, 'g')", ['tests/electron/linkedScreenCost.test.ts']],
  'r4: cost: an OpenVPN key in one run of 512 digits at any distance from its BEGIN line': [KEY, 'if (one && s - me <= MAX_ONE_RUN_LEAD && !', 'if (one && !', ['tests/electron/linkedScreenCost.test.ts']],
  'r4: cost: the line feeds at the end of a typed phrase found by the quadratic regex': [KEY, "text.replace(TRAILING_LINE_BREAKS, '')", "text.replace(/[" + '\\' + 'r' + '\\' + "n]+$/, '')", ['tests/electron/linkedScreenCost.test.ts']],
  'r4: OpenVPN one run: 4,095 characters from the BEGIN line, not 4,096': [KEY, 'const MAX_ONE_RUN_LEAD = 4096', 'const MAX_ONE_RUN_LEAD = 4095'],
  'r4: OpenVPN one run: 4,097 characters from the BEGIN line': [KEY, 'const MAX_ONE_RUN_LEAD = 4096', 'const MAX_ONE_RUN_LEAD = 4097'],
  // (round 4) The guards of the PuTTY path rule and the glued MAC line, the DER key that lacks under 16 characters and the sizes the docs state, the folder echo of a
  // name an invisible character splits, the base64 key file whose lines end in a written-out CR and LF, and the five reaches of the key openers to the byte.
  "r4 PuTTY: A path rule with no guard (a path piece is any run followed by path characters and a terminator)": [KEY, "if (!beforeMac && escapeAt(text, e) === null && PATH_THEN_RUN.test(text.slice(e, e + 112))) continue", "if (PATH_THEN_RUN.test(text.slice(e, e + 112))) continue"],
  "r4 PuTTY: B path rule: no check for a written-out break at once after the run": [KEY, "!beforeMac && escapeAt(text, e) === null && PATH_THEN_RUN", "!beforeMac && PATH_THEN_RUN"],
  "r4 PuTTY: C path rule: a break anywhere in the rest of the path ends it": [KEY, "escapeAt(text, e) === null && PATH_THEN_RUN.test(text.slice(e, e + 112))", "nextBreak(text, e, Math.min(text.length, e + 112)) === null && PATH_THEN_RUN.test(text.slice(e, e + 112))"],
  "r4 PuTTY: D the MAC line next is no matter": [KEY, "if (!beforeMac && escapeAt", "if (escapeAt"],
  "r4 PuTTY: D2 beforeMac is the glued name alone": [KEY, "const beforeMac = glued || MAC_NEXT.test(text.slice(e, e + 16))", "const beforeMac = glued"],
  "r4 PuTTY: D3 beforeMac is the joiners and the name alone": [KEY, "const beforeMac = glued || MAC_NEXT.test(text.slice(e, e + 16))", "const beforeMac = MAC_NEXT.test(text.slice(e, e + 16))"],
  "r4 PuTTY: D4 MAC_NEXT: two joiners at most": [KEY, "const MAC_NEXT = /^[^A-Za-z0-9+/=]{0,3}Private-MAC/", "const MAC_NEXT = /^[^A-Za-z0-9+/=]{0,2}Private-MAC/"],
  "r4 PuTTY: D5 MAC_NEXT: a dash only": [KEY, "const MAC_NEXT = /^[^A-Za-z0-9+/=]{0,3}Private-MAC/", "const MAC_NEXT = /^[-]{0,3}Private-MAC/"],
  "r4 PuTTY: D6 MAC_NEXT: no joiner at all": [KEY, "const MAC_NEXT = /^[^A-Za-z0-9+/=]{0,3}Private-MAC/", "const MAC_NEXT = /^Private-MAC/"],
  "r4 PuTTY: E glued: padding read as a NAME=": [KEY, "const a = valueStart(text, r[0], glued ? e - 7 : e)", "const a = valueStart(text, r[0], e)"],
  "r4 PuTTY: F glued never": [KEY, "const glued = text.startsWith('-MAC', e) && text.startsWith('Private', e - 7)", "const glued = false"],
  "r4 PuTTY: G glued without the name Private": [KEY, " && text.startsWith('Private', e - 7)", ""],
  "r4 PuTTY: T1 a lone colon ends no path": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/", "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?:-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/"],
  "r4 PuTTY: T2 a context line number ends no path": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/", "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/"],
  "r4 PuTTY: T3 an extension and an equals sign end no path": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/", "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-)/"],
  "r4 PuTTY: T4 an equals sign ends a path with no payload behind it": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/", "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=)/"],
  "r4 PuTTY: T5 a path without its dots": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/", "const PATH_THEN_RUN = /^[A-Za-z0-9_\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/"],
  "r4 PuTTY: T6 a path without its dashes": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/", "const PATH_THEN_RUN = /^[A-Za-z0-9_./\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/"],
  "r4 PuTTY: T7 a path without its underscores": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/", "const PATH_THEN_RUN = /^[A-Za-z0-9.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/"],
  "r4 PuTTY: T8 a path without its slashes": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/", "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/"],
  "r4 PuTTY: T9 a path without its backslashes": [KEY, "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/\\\\]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/", "const PATH_THEN_RUN = /^[A-Za-z0-9_.\\-/]{0,96}?(?::|-\\d{1,9}-|\\.[A-Za-z0-9_]{1,12}=(?=[A-Za-z0-9+/]{16}))/"],
  "r4 DER: R pre-fix: the 90% rule alone": [KEY, "return Math.floor((chars * 3) / 4) >= st.declared * 0.9 || (closed && Math.ceil(st.declared / 3) * 4 - chars < MIN_RUN)", "return Math.floor((chars * 3) / 4) >= st.declared * 0.9"],
  "r4 DER: S the END line not needed for the lacking rule": [KEY, "st.declared * 0.9 || (closed && Math.ceil", "st.declared * 0.9 || (Math.ceil"],
  "r4 DER: T lacking 16 is whole": [KEY, "Math.ceil(st.declared / 3) * 4 - chars < MIN_RUN)", "Math.ceil(st.declared / 3) * 4 - chars <= MIN_RUN)"],
  "r4 DER: U lacking 15 is not whole": [KEY, "Math.ceil(st.declared / 3) * 4 - chars < MIN_RUN)", "Math.ceil(st.declared / 3) * 4 - chars < MIN_RUN - 1)"],
  "r4 DER: V 90% is 91%": [KEY, "st.declared * 0.9 || (closed", "st.declared * 0.91 || (closed"],
  "r4 DER: W 90% is 89%": [KEY, "st.declared * 0.9 || (closed", "st.declared * 0.89 || (closed"],
  "r4 DER: AB scanBlock: END not passed": [KEY, "wholeDer(st, payload, endAt !== -1)) && (payload", "wholeDer(st, payload, false)) && (payload"],
  "r4 DER: AC isKeyRun 79": [KEY, "return all.length >= 80 && looksRandom(all)", "return all.length >= 79 && looksRandom(all)"],
  "r4 DER: AD isKeyRun 81": [KEY, "return all.length >= 80 && looksRandom(all)", "return all.length >= 81 && looksRandom(all)"],
  "r4 DER: AE lacked: under 15 only": [KEY, "endAt === -1 && lack < MIN_RUN ? lackedLine(", "endAt === -1 && lack < MIN_RUN - 1 ? lackedLine("],
  "r4 DER: AF lacked: no per-line suffix": [KEY, "FRAGMENT.test(blankNl(own)) ? '' : own, true)", "'', true)"],
  "r4 DER: AG lacked: the glue counts": [KEY, "chars - (text.startsWith(glue, end - chars) ? glue.length : 0) === lack ? end : -1", "chars === lack ? end : -1"],
  "r4 DER: AH lacked: a line of at least that length": [KEY, "? glue.length : 0) === lack ? end : -1", "? glue.length : 0) >= lack ? end : -1"],
  "r4 DER: AI lacked: a line of at most that length": [KEY, "? glue.length : 0) === lack ? end : -1", "? glue.length : 0) <= lack ? end : -1"],
  "r4 DER: AJ lacked: the line is left behind": [KEY, "`${st.type}-complete`, Math.max(lacked, endOfKey))", "`${st.type}-complete`, endOfKey)"],
  "r4 DER: AK lacked: the glued frame is not taken off the count": [KEY, "const lack = size - (payload - st.offset)", "const lack = size - payload"],
  "r4 DER: AL lacked: any frame": [KEY, "lackedLine(text, lastPayloadEnd, frames[frames.length - 1], lack,", "lackedLine(text, lastPayloadEnd, '', lack,"],
  "r4 DER: AM lacked: the last line is not as wide as the others": [KEY, "FRAGMENT.test(blankNl(own)) ? '' : own, true)", "FRAGMENT.test(blankNl(own)) ? '' : own, false)"],
  "r4 DER: AN lacked: it decides nothing": [KEY, "if ((lacked !== -1 || wholeDer(st, payload, endAt !== -1)) && (payload", "if ((wholeDer(st, payload, endAt !== -1)) && (payload"],
  "r4 DER: AO shortLastLine counts no characters": [KEY, "      chars = short[1].length\n", "      chars = 0\n"],
  "r4 DER: AP lacked: also with an END line (equivalent: the END line is the end either way)": [KEY, "const lacked = endAt === -1 && lack < MIN_RUN ?", "const lacked = lack < MIN_RUN ?"],
  "r4 folder: A no check for a split token": [JOBS, "    if (joined !== folder && mask(joined) !== joined) return FOLDER_WITH_CONTROLS\n", ""],
  "r4 folder: B plain spaces kept when joining": [JOBS, "/[^\\u0021-\\u007e]/g, ''", "/[^\\u0020-\\u007e]/g, ''"],
  "r4 folder: C every name with a credential withheld, not only a split one": [JOBS, "if (joined !== folder && mask(joined) !== joined)", "if (mask(joined) !== joined)"],
  "r4 folder: D non-ASCII kept when joining": [JOBS, "/[^\\u0021-\\u007e]/g, ''", "/[^\\u0021-\\u00ff]/g, ''"],
  "r4 folder: E U+001F is no control": [JOBS, "/[\\u0000-\\u001f\\u007f-\\u009f]/.test(folder)", "/[\\u0000-\\u001e\\u007f-\\u009f]/.test(folder)"],
  "r4 folder: F U+009F is no control": [JOBS, "/[\\u0000-\\u001f\\u007f-\\u009f]/.test(folder)", "/[\\u0000-\\u001f\\u007f-\\u009e]/.test(folder)"],
  "r4 folder: G DEL is no control": [JOBS, "/[\\u0000-\\u001f\\u007f-\\u009f]/.test(folder)", "/[\\u0000-\\u001f\\u0080-\\u009f]/.test(folder)"],
  "r4 folder: H NUL is no control": [JOBS, "/[\\u0000-\\u001f\\u007f-\\u009f]/.test(folder)", "/[\\u0001-\\u001f\\u007f-\\u009f]/.test(folder)"],
  "r4 folder: I the joined text is not masked": [JOBS, "mask(joined) !== joined) return FOLDER_WITH_CONTROLS", "joined !== joined) return FOLDER_WITH_CONTROLS"],
  "r4 base64 key file: A no pair": [KEY, "const pair = CRLF_ESCAPED.exec(text.slice(next[0], next[0] + 40))", "const pair = null"],
  "r4 base64 key file: B window of 10": [KEY, "next[0] + 40))", "next[0] + 10))"],
  "r4 base64 key file: C the pair ends before the LF": [KEY, "const br: Run = pair ? [next[0], next[0] + pair[0].length] : next", "const br: Run = pair ? [next[0], next[1]] : next"],
  "r4 base64 key file: D any escape pair, not CR LF": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r|\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: E LF CR also a pair": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r|\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n|\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)/"],
  "r4 base64 key file: CR form 0 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: CR form 1 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: CR form 2 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: CR form 3 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: CR form 4 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: CR form 5 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: LF form 0 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: LF form 1 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: LF form 2 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: LF form 3 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: LF form 4 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|`n)/"],
  "r4 base64 key file: LF form 5 dropped": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);)/"],
  "r4 base64 key file: HTML hex without the optional zero (CR)": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/"],
  "r4 base64 key file: HTML hex without the optional zero (LF)": [KEY, "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x0?[aA]|10);|`n)/", "const CRLF_ESCAPED = /^(?:\\\\+r|\\\\+u000[dD]|\\\\+x0[dD]|%0[dD]|&#(?:x0?[dD]|13);|`r)(?:\\\\+n|\\\\+u000[aA]|\\\\+x0[aA]|%0[aA]|&#(?:x[aA]|10);|`n)/"],
  "r4 reach: REACH_BEGIN one less": [KEY, "const REACH_BEGIN = 262144\n", "const REACH_BEGIN = 262143\n"],
  "r4 reach: REACH_BEGIN one more": [KEY, "const REACH_BEGIN = 262144\n", "const REACH_BEGIN = 262145\n"],
  "r4 reach: REACH_OPENVPN one less": [KEY, "const REACH_OPENVPN = 16384\n", "const REACH_OPENVPN = 16383\n"],
  "r4 reach: REACH_OPENVPN one more": [KEY, "const REACH_OPENVPN = 16384\n", "const REACH_OPENVPN = 16385\n"],
  "r4 reach: REACH_PUTTY one less": [KEY, "const REACH_PUTTY = 65536\n", "const REACH_PUTTY = 65535\n"],
  "r4 reach: REACH_PUTTY one more": [KEY, "const REACH_PUTTY = 65536\n", "const REACH_PUTTY = 65537\n"],
  "r4 reach: REACH_KTY one less": [KEY, "const REACH_KTY = 8192\n", "const REACH_KTY = 8191\n"],
  "r4 reach: REACH_KTY one more": [KEY, "const REACH_KTY = 8192\n", "const REACH_KTY = 8193\n"],
  "r4 reach: REACH_XML one less": [KEY, "const REACH_XML = 16384\n", "const REACH_XML = 16383\n"],
  "r4 reach: REACH_XML one more": [KEY, "const REACH_XML = 16384\n", "const REACH_XML = 16385\n"],
  "r4 reach: REACH_BASE64 one less": [KEY, "const REACH_BASE64 = 65536\n", "const REACH_BASE64 = 65535\n"],
  "r4 reach: REACH_BASE64 one more": [KEY, "const REACH_BASE64 = 65536\n", "const REACH_BASE64 = 65537\n"],
  "r5 PuTTY last line: P1 lastShort: no minimum length": [KEY, "const lastShort = len >= 4 && runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && (beforeMac || endsItsLine(text, e))", "const lastShort = runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && (beforeMac || endsItsLine(text, e))"],
  "r5 PuTTY last line: P2 lastShort: any private line": [KEY, "const lastShort = len >= 4 && runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && (beforeMac || endsItsLine(text, e))", "const lastShort = len >= 4 && text.charCodeAt(e - 1) === 61 && (beforeMac || endsItsLine(text, e))"],
  "r5 PuTTY last line: P3 lastShort: no padding needed": [KEY, "const lastShort = len >= 4 && runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && (beforeMac || endsItsLine(text, e))", "const lastShort = len >= 4 && runs.length === n - 1 && (beforeMac || endsItsLine(text, e))"],
  "r5 PuTTY last line: P4 lastShort: no MAC line exception": [KEY, "const lastShort = len >= 4 && runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && (beforeMac || endsItsLine(text, e))", "const lastShort = len >= 4 && runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && endsItsLine(text, e)"],
  "r5 PuTTY last line: P5 lastShort: only before the MAC line": [KEY, "const lastShort = len >= 4 && runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && (beforeMac || endsItsLine(text, e))", "const lastShort = len >= 4 && runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && beforeMac"],
  "r5 PuTTY last line: P6 lastShort: every short run": [KEY, "const lastShort = len >= 4 && runs.length === n - 1 && text.charCodeAt(e - 1) === 61 && (beforeMac || endsItsLine(text, e))", "const lastShort = true"],
  "r5 line end: E1 endsItsLine reads 33 characters": [KEY, "const stop = Math.min(text.length, e + 32)", "const stop = Math.min(text.length, e + 33)"],
  "r5 line end: E2 endsItsLine reads 31 characters": [KEY, "const stop = Math.min(text.length, e + 32)", "const stop = Math.min(text.length, e + 31)"],
  "r5 line end: E3 endsItsLine: no double quote": [KEY, "if (c === 10 || c === 13 || c === 34 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true", "if (c === 10 || c === 13 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true"],
  "r5 line end: E4 endsItsLine: no single quote": [KEY, "if (c === 10 || c === 13 || c === 34 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true", "if (c === 10 || c === 13 || c === 34 || c === 96 || escapeAt(text, i) !== null) return true"],
  "r5 line end: E5 endsItsLine: no backtick": [KEY, "if (c === 10 || c === 13 || c === 34 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true", "if (c === 10 || c === 13 || c === 34 || c === 39 || escapeAt(text, i) !== null) return true"],
  "r5 line end: E6 endsItsLine: no written-out break": [KEY, "if (c === 10 || c === 13 || c === 34 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true", "if (c === 10 || c === 13 || c === 34 || c === 39 || c === 96) return true"],
  "r5 line end: E7 endsItsLine: no LF": [KEY, "if (c === 10 || c === 13 || c === 34 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true", "if (c === 13 || c === 34 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true"],
  "r5 line end: E8 endsItsLine: no CR": [KEY, "if (c === 10 || c === 13 || c === 34 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true", "if (c === 10 || c === 34 || c === 39 || c === 96 || escapeAt(text, i) !== null) return true"],
  "r5 line end: E9 endsItsLine: a backslash is no filler": [KEY, "if (c !== 92 && !PARTIAL_JOINERS.includes(text[i])) return false", "if (!PARTIAL_JOINERS.includes(text[i])) return false"],
  "r5 line end: E10 endsItsLine: anything is filler": [KEY, "if (c !== 92 && !PARTIAL_JOINERS.includes(text[i])) return false", "if (false) return false"],
  "r5 line end: E11 endsItsLine: the end of the text is not an end": [KEY, "return stop === text.length\n}", "return false\n}"],
  "r5 line end: E12 endsItsLine: the end of the read is an end": [KEY, "return stop === text.length\n}", "return true\n}"],
  "r5 Windows path: W1 pathEscape: any written-out break": [KEY, "if (!BACKSLASH_BREAK.test(escape)) return false", "if (false) return false"],
  "r5 Windows path: W2 pathEscape: a piece of any length": [KEY, "if (i - k > 96) return false", ""],
  "r5 Windows path: W3 pathEscape: no escape at the start of the text": [KEY, "return i === 0 || before === 10", "return before === 10"],
  "r5 Windows path: W4 pathEscape: no escape after a line feed": [KEY, "return i === 0 || before === 10 || before === 13", "return i === 0 || before === 13"],
  "r5 Windows path: W5 pathEscape: no escape after a CR": [KEY, "return i === 0 || before === 10 || before === 13", "return i === 0 || before === 10"],
  "r5 Windows path: W6 pathEscape: no escape after a drive": [KEY, "(before === 58 && isLetter(text.charCodeAt(i - 2)) && !isPathChar(text.charCodeAt(i - 3)))", "false"],
  "r5 Windows path: W7 pathEscape: a drive is no letter": [KEY, "(before === 58 && isLetter(text.charCodeAt(i - 2)) &&", "(before === 58 &&"],
  "r5 Windows path: W8 pathEscape: a drive is any name ending in a letter": [KEY, " && !isPathChar(text.charCodeAt(i - 3)))", ")"],
  "r5 Windows path: W9 pathEscape: the start of the text is not a line start": [KEY, "const c = k === 0 ? 10 : text.charCodeAt(k - 1)", "const c = k === 0 ? 0 : text.charCodeAt(k - 1)"],
  "r5 Windows path: W10 preceding: no backslash": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39"],
  "r5 Windows path: W11 preceding: no LF": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 92 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39"],
  "r5 Windows path: W12 preceding: no CR": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 92 || c === 10 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39"],
  "r5 Windows path: W13 preceding: no tab": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 92 || c === 10 || c === 13 || c === 32 || c === 62 || c === 34 || c === 39"],
  "r5 Windows path: W14 preceding: no blank": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 92 || c === 10 || c === 13 || c === 9 || c === 62 || c === 34 || c === 39"],
  "r5 Windows path: W15 preceding: no >": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 34 || c === 39"],
  "r5 Windows path: W16 preceding: no double quote": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 39"],
  "r5 Windows path: W17 preceding: no single quote": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34"],
  "r5 Windows path: W18 preceding: a colon too": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39 || c === 58"],
  "r5 Windows path: W19 preceding: a slash too": [KEY, "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39", "return c === 92 || c === 10 || c === 13 || c === 9 || c === 32 || c === 62 || c === 34 || c === 39 || c === 47"],
  "r5 Windows path: C1 isPathChar: no digits": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45"],
  "r5 Windows path: C2 isPathChar: the range of digits starts at 47": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 47 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45"],
  "r5 Windows path: C3 isPathChar: the range of digits ends at 58": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 48 && c <= 58) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45"],
  "r5 Windows path: C4 isPathChar: capitals start at 64": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 64 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45"],
  "r5 Windows path: C5 isPathChar: capitals end at 91": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 91) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45"],
  "r5 Windows path: C6 isPathChar: lower case starts at 96": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 96 && c <= 122) || c === 95 || c === 46 || c === 45"],
  "r5 Windows path: C7 isPathChar: lower case ends at 123": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 123) || c === 95 || c === 46 || c === 45"],
  "r5 Windows path: C8 isPathChar: no underscore": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 45"],
  "r5 Windows path: C9 isPathChar: no dot": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45"],
  "r5 Windows path: C10 isPathChar: no dash": [KEY, "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45", "const isPathChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46"],
  "r5 Windows path: R1 after the escape: no context line number": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-])|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R2 after the escape: a line number ends only in a colon": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}:|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R3 after the escape: a name may start with a digit": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z0-9_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R4 after the escape: a name of 95 at the most": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,94}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R5 after the escape: a name of 97 at the most": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,96}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R6 after the escape: no word test for a bare colon": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R7 after the escape: no dot in a path": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R8 after the escape: no backslash in a path": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[./])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R9 after the escape: no slash in a path": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R10 after the escape: the dot is found within 10": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,10}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R11 after the escape: a payload of 5": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{5}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R12 after the escape: a payload of 3": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{3}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R13 after the escape: a marker of 5 dashes": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{5}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R14 after the escape: a marker of 3 dashes": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{3}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R15 after the escape: a header of 3 to 12 letters after its first": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{3,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R16 after the escape: a header may start with a lower-case letter": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Za-z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y"],
  "r5 Windows path: R17 after the escape: no line end": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |$))/y"],
  "r5 Windows path: R18 after the escape: no text end": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]))/y"],
  "r5 Windows path: R19 after the escape: no header": [KEY, "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[A-Z][A-Za-z-]{2,12}: |[\\r\\n]|$))/y", "const PATH_AFTER_ESCAPE = /(?:[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?(?::\\d{1,9}[:-]|-\\d{1,9}-)|(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])[A-Za-z_.][A-Za-z0-9_.\\-/\\\\]{0,95}?:(?=[A-Za-z0-9+/=]{4}|-{4}|[\\r\\n]|$))/y"],
  "r5 Windows path: X1 legacyAbove splits at every written-out break": [KEY, "const lines = splitBreaks(blankNl(above.replace(/^…/, '')))", "const lines = blankNl(above.replace(/^…/, '')).split(BREAKS)"],
  "r5 Windows path: X2 splitBreaks: no path test": [KEY, "    if (m[0].charCodeAt(0) === 92 && pathReading > 0 && pathEscape(s, m.index, m[0], pathReading === 2)) {\n      pathSuppressed = true\n      continue\n    }\n", ""],
  "r5 Windows path: X3 escapeAt: no path test": [KEY, "  if (m !== null && pathReading > 0 && pathEscape(text, i, m[0], pathReading === 2)) {\n    pathSuppressed = true\n    return null\n  }\n", ""],
  "r5 post-quantum: Q1 pqcKind: an OID of any length": [KEY, "if (oid.length !== 9 || !startsWith(oid, NIST_ARC)) return null", "if (!startsWith(oid, NIST_ARC)) return null"],
  "r5 post-quantum: Q2 pqcKind: any first arcs": [KEY, "if (oid.length !== 9 || !startsWith(oid, NIST_ARC)) return null", "if (oid.length !== 9) return null"],
  "r5 post-quantum: Q3 pqcKind: no .3 arc": [KEY, "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null", "if (oid[7] === 5) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null"],
  "r5 post-quantum: Q4 pqcKind: ML-DSA starts at 18": [KEY, "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null", "if (oid[7] === 3) return oid[8] >= 18 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null"],
  "r5 post-quantum: Q5 pqcKind: ML-DSA ends at 18": [KEY, "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null", "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 18 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null"],
  "r5 post-quantum: Q6 pqcKind: ML-DSA starts at 16": [KEY, "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null", "if (oid[7] === 3) return oid[8] >= 16 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null"],
  "r5 post-quantum: Q7 pqcKind: ML-DSA ends at 20": [KEY, "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null", "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 20 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null"],
  "r5 post-quantum: Q8 pqcKind: SLH-DSA starts at 21": [KEY, "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null", "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 21 && oid[8] <= 31 ? 'raw' : null"],
  "r5 post-quantum: Q9 pqcKind: SLH-DSA ends at 30": [KEY, "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null", "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 30 ? 'raw' : null"],
  "r5 post-quantum: Q10 pqcKind: SLH-DSA ends at 32": [KEY, "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 31 ? 'raw' : null", "if (oid[7] === 3) return oid[8] >= 17 && oid[8] <= 19 ? 'seeded' : oid[8] >= 20 && oid[8] <= 32 ? 'raw' : null"],
  "r5 post-quantum: Q11 pqcKind: no .4 arc": [KEY, "return oid[7] === 4 && oid[8] >= 1 && oid[8] <= 3 ? 'seeded' : null", "return oid[7] === 5 && oid[8] >= 1 && oid[8] <= 3 ? 'seeded' : null"],
  "r5 post-quantum: Q12 pqcKind: ML-KEM starts at 0": [KEY, "return oid[7] === 4 && oid[8] >= 1 && oid[8] <= 3 ? 'seeded' : null", "return oid[7] === 4 && oid[8] >= 0 && oid[8] <= 3 ? 'seeded' : null"],
  "r5 post-quantum: Q13 pqcKind: ML-KEM starts at 2": [KEY, "return oid[7] === 4 && oid[8] >= 1 && oid[8] <= 3 ? 'seeded' : null", "return oid[7] === 4 && oid[8] >= 2 && oid[8] <= 3 ? 'seeded' : null"],
  "r5 post-quantum: Q14 pqcKind: ML-KEM ends at 4": [KEY, "return oid[7] === 4 && oid[8] >= 1 && oid[8] <= 3 ? 'seeded' : null", "return oid[7] === 4 && oid[8] >= 1 && oid[8] <= 4 ? 'seeded' : null"],
  "r5 post-quantum: Q15 pqcKind: ML-KEM ends at 2": [KEY, "return oid[7] === 4 && oid[8] >= 1 && oid[8] <= 3 ? 'seeded' : null", "return oid[7] === 4 && oid[8] >= 1 && oid[8] <= 2 ? 'seeded' : null"],
  "r5 post-quantum: Q16 pkcs8PrivateAt: no raw key": [KEY, "if (pqc === 'raw') return [d.body, d.end]", "if (pqc === 'raw') return undefined"],
  "r5 post-quantum: Q17 pkcs8PrivateAt: no sequence of seed and key": [KEY, "if (x && x.tag === 0x30) {", "if (x && x.tag === 0x31) {"],
  "r5 post-quantum: Q18 pkcs8PrivateAt: the seed in the sequence is no OCTET STRING": [KEY, "return seed && seed.tag === 0x04 ? [seed.body, seed.end] : undefined", "return seed && seed.tag === 0x05 ? [seed.body, seed.end] : undefined"],
  "r5 post-quantum: Q19 pkcs8PrivateAt: no seed alone": [KEY, "return x && (x.tag === 0x80 || x.tag === 0x04) ? [x.body, x.end] : undefined", "return x && (x.tag === 0x04) ? [x.body, x.end] : undefined"],
  "r5 post-quantum: Q20 pkcs8PrivateAt: no expanded key alone": [KEY, "return x && (x.tag === 0x80 || x.tag === 0x04) ? [x.body, x.end] : undefined", "return x && (x.tag === 0x80) ? [x.body, x.end] : undefined"],
  "r5 post-quantum: Q21 pkcs8PrivateAt: any element": [KEY, "return x && (x.tag === 0x80 || x.tag === 0x04) ? [x.body, x.end] : undefined", "return x ? [x.body, x.end] : undefined"],
  "r5 SEC1: S1 structureOf: a private value of 15 bytes at the least": [KEY, "c.len >= 14 && c.len <= 72", "c.len >= 15 && c.len <= 72"],
  "r5 SEC1: S2 structureOf: a private value of 13 bytes at the least": [KEY, "c.len >= 14 && c.len <= 72", "c.len >= 13 && c.len <= 72"],
  "r5 short body: B1 bodyLooksRandom: no short body": [KEY, "if (st && st.declared > 0 && body.length < SHORT_BODY && looksRandom(body.slice(SHORT_BODY_HEADER))) return true", ""],
  "r5 short body: B2 bodyLooksRandom: the header is not skipped": [KEY, "const SHORT_BODY_HEADER = 24", "const SHORT_BODY_HEADER = 0"],
  "r5 short body: B3 bodyLooksRandom: 40 characters skipped": [KEY, "const SHORT_BODY_HEADER = 24", "const SHORT_BODY_HEADER = 40"],
  "r5 short body: B4 bodyLooksRandom: a body of 72 is no short one": [KEY, "const SHORT_BODY = 100", "const SHORT_BODY = 72"],
  "r5 size floor: F1 scanBlock: the key must show 64 characters": [KEY, "if ((lacked !== -1 || wholeDer(st, payload, endAt !== -1)) && (payload >= 64 || size >= 64) && random) return span('remove', `${st.type}-complete`, Math.max(lacked, endOfKey))", "if ((lacked !== -1 || wholeDer(st, payload, endAt !== -1)) && payload >= 64 && random) return span('remove', `${st.type}-complete`, Math.max(lacked, endOfKey))"],
  "r5 size floor: F2 scanBlock: a key of 60 characters is one": [KEY, "if ((lacked !== -1 || wholeDer(st, payload, endAt !== -1)) && (payload >= 64 || size >= 64) && random) return span('remove', `${st.type}-complete`, Math.max(lacked, endOfKey))", "if ((lacked !== -1 || wholeDer(st, payload, endAt !== -1)) && (payload >= 64 || size >= 60) && random) return span('remove', `${st.type}-complete`, Math.max(lacked, endOfKey))"],
  "r5 size floor: F3 scanBlock: a key of 68 characters is the least": [KEY, "if ((lacked !== -1 || wholeDer(st, payload, endAt !== -1)) && (payload >= 64 || size >= 64) && random) return span('remove', `${st.type}-complete`, Math.max(lacked, endOfKey))", "if ((lacked !== -1 || wholeDer(st, payload, endAt !== -1)) && (payload >= 64 || size >= 68) && random) return span('remove', `${st.type}-complete`, Math.max(lacked, endOfKey))"],
  "r5 size floor: F4 scanBlock: the size rounds down": [KEY, "const size = Math.ceil(st.declared / 3) * 4", "const size = Math.floor(st.declared / 3) * 4"],
  "r5 guard: G1 puttyKeys: no randomness test": [KEY, "const cls = (got.length >= 2 || (got.length === n && n > 0)) && looksRandom(all) ? 'remove' : 'flag'", "const cls = (got.length >= 2 || (got.length === n && n > 0)) ? 'remove' : 'flag'"],
  "r5 guard: G2 scanBlock: a DER key cut short needs no randomness": [KEY, "if (endAt === -1 && payload >= LONG_PAYLOAD && random) return span('remove', `${st.type}-prefix`) // cut short", "if (endAt === -1 && payload >= LONG_PAYLOAD) return span('remove', `${st.type}-prefix`) // cut short"],
  "r5 guard: G3 scanBlock: an SSH2 key needs no randomness": [KEY, "if (payload >= LONG_PAYLOAD && random) return span('remove', st.type)", "if (payload >= LONG_PAYLOAD) return span('remove', st.type)"],
  "r5 guard: G4 scanBlock: a legacy PEM key needs no randomness": [KEY, "if (legacy && payload >= 64 && random) return span('remove', 'pem-encrypted-headers')", "if (legacy && payload >= 64) return span('remove', 'pem-encrypted-headers')"],
  "r5 cost: K1 the look at a path after an escape is unbounded": [KEY, "(?=[A-Za-z0-9_.\\-/\\\\]{0,96}?[.\\\\/])", "(?=[A-Za-z0-9_.\\-/\\\\]*[.\\\\/])", ["tests/electron/linkedScreenCost.test.ts"]],
  "r5 cost: K2 an OpenVPN run may start a million characters after its BEGIN line": [KEY, "const MAX_ONE_RUN_LEAD = 4096", "const MAX_ONE_RUN_LEAD = 1000000", ["tests/electron/linkedScreenCost.test.ts"]],
  "r5 cost: K3 an OpenVPN run has no bound after its BEGIN line": [KEY, "s - me <= MAX_ONE_RUN_LEAD && ", "", ["tests/electron/linkedScreenCost.test.ts"]],
  "r5 cost: K4 nextBreak: a run of backslashes is read from each of them": [KEY, "if (c === 92) while (i + 1 < limit && text.charCodeAt(i + 1) === 92) i++", "", ["tests/electron/linkedScreenCost.test.ts"]],
  // (round 6) the three readings of a backslash and letter that may be a Windows path's, the names a path can hold, the short payload of an indented line, the joined blocks and spans, RC5, the forms of a URL cwd, and J12 (port rule: results are appended one by one)
  'r6 readings: no second reading': [KEY, '    while (pathSuppressed && pathReading > 0) {', '    while (false && pathSuppressed && pathReading > 0) {'],
  'r6 readings: from the wide reading straight to every escape a break': [KEY, '      pathReading = (pathReading - 1) as PathReading', '      pathReading = 0'],
  'r6 readings: the reading of every escape a break never runs': [KEY, '    while (pathSuppressed && pathReading > 0) {', '    while (pathSuppressed && pathReading > 1) {'],
  'r6 readings: a text starts at the usual reading, not the wide one': [KEY, 'let pathReading: PathReading = 2', 'let pathReading: PathReading = 1'],
  'r6 readings: the reading is not given back': [KEY, '    pathReading = outerReading\n    pathSuppressed = outerSuppressed', '    pathSuppressed = outerSuppressed'],
  'r6 readings: a nested call clears the outer call\'s flag for good': [KEY, '    pathSuppressed = outerSuppressed\n  }\n}', '    pathSuppressed = false\n  }\n}'],
  'r6 readings: the flag is not cleared when the call starts': [KEY, '    pathSuppressed = false\n    let out = find()', '    let out = find()'],
  'r6 readings: the flag is not cleared between readings': [KEY, '      pathSuppressed = false\n      out = join(out, find())', '      out = join(out, find())'],
  'r6 readings: the escape gate of escapeAt ignores the reading': [KEY, '  if (m !== null && pathReading > 0 && pathEscape(text, i, m[0], pathReading === 2)) {', '  if (m !== null && pathEscape(text, i, m[0], pathReading === 2)) {'],
  'r6 readings: the escape gate of splitBreaks ignores the reading': [KEY, '    if (m[0].charCodeAt(0) === 92 && pathReading > 0 && pathEscape(s, m.index, m[0], pathReading === 2)) {', '    if (m[0].charCodeAt(0) === 92 && pathEscape(s, m.index, m[0], pathReading === 2)) {'],
  'r6 readings: escapeAt is always wide': [KEY, '  if (m !== null && pathReading > 0 && pathEscape(text, i, m[0], pathReading === 2)) {', '  if (m !== null && pathReading > 0 && pathEscape(text, i, m[0], true)) {'],
  'r6 readings: splitBreaks is always wide': [KEY, '    if (m[0].charCodeAt(0) === 92 && pathReading > 0 && pathEscape(s, m.index, m[0], pathReading === 2)) {', '    if (m[0].charCodeAt(0) === 92 && pathReading > 0 && pathEscape(s, m.index, m[0], true)) {'],
  'r6 wide: the usual reading takes the wide names too': [KEY, '    if (!wide) return false\n', ''],
  'r6 wide: the wide reading takes the usual piece only': [KEY, '  const inPiece = wide ? isPieceChar : isPathChar', '  const inPiece = isPathChar'],
  'r6 wide: the usual reading takes the wide piece': [KEY, '  const inPiece = wide ? isPieceChar : isPathChar', '  const inPiece = isPieceChar'],
  'r6 names: a name may start with another break written out': [KEY, '(?!\\\\+(?:[nr]|u000[aAdD]|x0[aAdD]))', ''],
  'r6 names: no separator needed in a name': [KEY, '(?=[^\\x00-\\x1f"*:<>?|]{0,259}?[.\\\\/])', ''],
  'r6 names: 260 characters': [KEY, '[^\\x00-\\x1f"*:<>?|]{1,259}?(?::', '[^\\x00-\\x1f"*:<>?|]{1,260}?(?::'],
  'r6 names: no line number between dashes': [KEY, '|-\\d{1,9}-|:(?=[ \\t]*(?:', '|:(?=[ \\t]*(?:'],
  'r6 names: no blanks after the colon': [KEY, ':(?=[ \\t]*(?:[A-Za-z0-9+/=]{16}|-{4}|[A-Z][A-Za-z-]{2,12}: )|', ':(?=(?:[A-Za-z0-9+/=]{16}|-{4}|[A-Z][A-Za-z-]{2,12}: )|'],
  'r6 names: a payload of one character after the blanks': [KEY, '[ \\t]*(?:[A-Za-z0-9+/=]{16}|-{4}|[A-Z][A-Za-z-]{2,12}: )', '[ \\t]*(?:[A-Za-z0-9+/=]{1}|-{4}|[A-Z][A-Za-z-]{2,12}: )'],
  'r6 names: no marker after the blanks': [KEY, '[ \\t]*(?:[A-Za-z0-9+/=]{16}|-{4}|[A-Z][A-Za-z-]{2,12}: )', '[ \\t]*(?:[A-Za-z0-9+/=]{16}|[A-Z][A-Za-z-]{2,12}: )'],
  'r6 names: no armor header after the blanks': [KEY, '[ \\t]*(?:[A-Za-z0-9+/=]{16}|-{4}|[A-Z][A-Za-z-]{2,12}: )', '[ \\t]*(?:[A-Za-z0-9+/=]{16}|-{4})'],
  'r6 piece: no character outside ASCII': [KEY, 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126', 'const isPieceChar = (c: number): boolean => isPathChar(c) || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126'],
  'r6 piece: no @': [KEY, 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126', 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126'],
  'r6 piece: no # $ % &': [KEY, 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126', 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126'],
  'r6 piece: no round brackets': [KEY, 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126', 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126'],
  'r6 piece: no square brackets': [KEY, 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126', 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 94 || c === 123 || c === 125 || c === 126'],
  'r6 piece: no braces': [KEY, 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126', 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 126'],
  'r6 piece: no !': [KEY, 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126', 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126'],
  'r6 piece: no ^': [KEY, 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126', 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 123 || c === 125 || c === 126'],
  'r6 piece: no ~': [KEY, 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125 || c === 126', 'const isPieceChar = (c: number): boolean => isPathChar(c) || c >= 128 || c === 33 || (c >= 35 && c <= 38) || c === 40 || c === 41 || c === 64 || c === 91 || c === 93 || c === 94 || c === 123 || c === 125'],
  'r6 join: a span found twice is kept twice': [KEY, '  for (const x of second) if (!seen.has(spanKey(x))) out.push(x)', '  for (const x of second) out.push(x)'],
  'r6 join: the key blocks of two readings are joined as spans': [KEY, '(a, b) => ({ blocks: joinBlocks(a.blocks, b.blocks), spans: joinSpans(a.spans, b.spans) })', '(a, b) => ({ blocks: joinSpans(a.blocks, b.blocks), spans: joinSpans(a.spans, b.spans) })'],
  'r6 join: a block that takes the key does not win': [KEY, '    if (a === undefined || takes(b) > takes(a) || (takes(b) === takes(a) && Math.max(b.to, b.scanEnd) > Math.max(a.to, a.scanEnd))) byBegin.set(b.from, b)', '    if (a === undefined || (Math.max(b.to, b.scanEnd) > Math.max(a.to, a.scanEnd))) byBegin.set(b.from, b)'],
  'r6 join: the second block wins a tie': [KEY, '    if (a === undefined || takes(b) > takes(a) || (takes(b) === takes(a) && Math.max(b.to, b.scanEnd) > Math.max(a.to, a.scanEnd))) byBegin.set(b.from, b)', '    if (a === undefined || takes(b) > takes(a) || (takes(b) === takes(a) && Math.max(b.to, b.scanEnd) >= Math.max(a.to, a.scanEnd))) byBegin.set(b.from, b)'],
  'r6 join: reach is the block end only': [KEY, '    if (a === undefined || takes(b) > takes(a) || (takes(b) === takes(a) && Math.max(b.to, b.scanEnd) > Math.max(a.to, a.scanEnd))) byBegin.set(b.from, b)', '    if (a === undefined || takes(b) > takes(a) || (takes(b) === takes(a) && b.to > a.to)) byBegin.set(b.from, b)'],
  'r6 join: the blocks are not put in order': [KEY, '  return [...byBegin.values()].sort((x, y) => x.from - y.from)', '  return [...byBegin.values()]'],
  'r6 legacy PEM: RC5-CBC is not a cipher of an 8-byte block': [KEY, 'const DEK_RE = /DEK-Info: ?(?:(?:DES|BF|CAST5|RC2|RC5|IDEA)', 'const DEK_RE = /DEK-Info: ?(?:(?:DES|BF|CAST5|RC2|IDEA)'],
  'r6 short payload: none is taken': [KEY, '|[ \\t]+[A-Za-z0-9+/=]{1,15}[ \\t]*(?:[\\r\\n"\'\\\\]|$)', ''],
  'r6 short payload: up to 14 characters': [KEY, '[A-Za-z0-9+/=]{1,15}[ \\t]*(?:[\\r', '[A-Za-z0-9+/=]{1,14}[ \\t]*(?:[\\r'],
  'r6 short payload: no blank needed': [KEY, '|[ \\t]+[A-Za-z0-9+/=]{1,15}', '|[ \\t]*[A-Za-z0-9+/=]{1,15}'],
  'r6 short payload: trailing blanks not allowed': [KEY, '{1,15}[ \\t]*(?:[\\r\\n"', '{1,15}(?:[\\r\\n"'],
  'r6 short payload: no line end': [KEY, '[ \\t]*(?:[\\r\\n"\'\\\\]|$)', '[ \\t]*(?:["\'\\\\]|$)'],
  'r6 short payload: no quote': [KEY, '(?:[\\r\\n"\'\\\\]|$)|[A-Za-z0-9+/=]{4}', '(?:[\\r\\n\'\\\\]|$)|[A-Za-z0-9+/=]{4}'],
  'r6 short payload: no break written out': [KEY, '(?:[\\r\\n"\'\\\\]|$)|[A-Za-z0-9+/=]{4}', '(?:[\\r\\n"\']|$)|[A-Za-z0-9+/=]{4}'],
  'r6 short payload: no end of the text': [KEY, '"\'\\\\]|$)|[A-Za-z0-9+/=]{4}', '"\'\\\\])|[A-Za-z0-9+/=]{4}'],
  'r6 cwd URL: a scheme with slashes only': [TOOL, 'const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]{1,31}:[\\\\/]{2}/i', 'const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]{1,31}:\\/\\//i'],
  'r6 cwd URL: no protocol-relative URL with a user and a password': [TOOL, '|| URL_RELATIVE_RE.test(p) || URL_INSIDE_RE.test(p)', '|| URL_INSIDE_RE.test(p)'],
  'r6 cwd URL: no URL with a user and a password after a path': [TOOL, '|| URL_RELATIVE_RE.test(p) || URL_INSIDE_RE.test(p)', '|| URL_RELATIVE_RE.test(p)'],
  'r6 cwd URL: zero-width characters are not taken out': [TOOL, '  let p = cwd.replace(ZERO_WIDTH, \'\').trim()', '  let p = cwd.trim()'],
  'r6 cwd URL: a UNC path is a protocol-relative URL': [TOOL, 'const URL_RELATIVE_RE = /^[\\\\/]{2}[^\\s/\\\\:@]{1,256}:[^\\s/\\\\@]{1,512}@/', 'const URL_RELATIVE_RE = /^[\\\\/]{2}[^\\s/\\\\:@]{1,256}/'],
  'r6 cwd URL: any scheme in a path is a URL': [TOOL, 'const URL_INSIDE_RE = /[a-z][a-z0-9+.-]{1,31}:[\\\\/]{2}[^\\s/\\\\:@]{0,256}:[^\\s/\\\\@]{1,512}@/i', 'const URL_INSIDE_RE = /[a-z][a-z0-9+.-]{1,31}:[\\\\/]{2}/i'],
  'r6 cwd URL: the byte order mark is not a zero-width character': [TOOL, ' + String.fromCharCode(0xfeff) + \']\', \'g\')', ' + \']\', \'g\')'],
  'r6 cwd URL: the word joiner is not a zero-width character': [TOOL, ' + String.fromCharCode(0x2060) + String.fromCharCode(0xfeff)', ' + String.fromCharCode(0xfeff)'],
  'r6 cwd URL: the zero-width joiners are not zero-width characters': [TOOL, '\'-\' + String.fromCharCode(0x200d)', '\'-\' + String.fromCharCode(0x200b)'],
  'r6 cost: a name read after a break has no length': [KEY, '[^\\x00-\\x1f"*:<>?|]{1,259}?(?::', '[^\\x00-\\x1f"*:<>?|]+?(?::', 'tests/electron/linkedScreenCost.test.ts'],
  'r6 cost: the separator a name must hold is looked for to the end of the text': [KEY, '(?=[^\\x00-\\x1f"*:<>?|]{0,259}?[.\\\\/])', '(?=[^\\x00-\\x1f"*:<>?|]*?[.\\\\/])', 'tests/electron/linkedScreenCost.test.ts'],
  'r6 J12: keySpans appends a detector\'s spans as arguments': [KEY, '    for (const s of found) spans.push(s)', '    spans.push(...found)', 'tests/electron/linkedScreenCost.test.ts'],
  'r6 J12: screenText appends the key spans as arguments': [SCREEN, '  for (const span of keys.spans) found.push(span)', '  found.push(...keys.spans)', 'tests/electron/linkedScreenCost.test.ts'],
  'r6 J12: screenText appends the tail spans as arguments': [SCREEN, '  for (const span of headless(input, keys.blocks, { start: keysFrom, cutAt, screenedStart: cutStart === \'screened\' })) found.push(span)', '  found.push(...headless(input, keys.blocks, { start: keysFrom, cutAt, screenedStart: cutStart === \'screened\' }))', 'tests/electron/linkedScreenCost.test.ts'],
  'r6 J12: maskForDisplay appends the key spans as arguments': [SCREEN, '  for (const span of keys.spans) spans.push(span)', '  spans.push(...keys.spans)', 'tests/electron/linkedScreenCost.test.ts'],
}

/** Mutants no test can kill, because they change nothing the screen returns. */
const EQUIVALENT = new Set([
  // (round 6) a nested call (keySpans on what a base64 key file decodes to) that starts with the flag set reads that text once more at the next reading, and a key file decodes to text with real line breaks: no written-out break for a reading to differ on (cost only)
  'r6 readings: the flag is not cleared when the call starts',
  // (round 6) a reading that kept nothing from being a break finds what the one below it finds, so the reading below it adds nothing (cost only)
  'r6 readings: the flag is not cleared between readings',
  // (round 6) the look stops at the first separator, and every break written out holds one (its backslash): its length is the distance to the next break, so a text of n breaks costs n of them, not n times the text
  'r6 cost: the separator a name must hold is looked for to the end of the text',
  // (round 6) a tail span holds an END line and 80 characters of key lines at the least, and push(...spans) holds up to about 120,000 arguments: a text the screen is given (200,000 characters and what its key lookback adds) holds a few thousand of them, and 4 MB of END lines and key lines holds under 42,000
  'r6 J12: screenText appends the tail spans as arguments',
  // (round 5) A padded short run that is not the file's last private line goes on through the checks that follow and reaches the same `continue` the skip makes:
  // the distance to the previous run (`a - prevEnd > 256`) and the prose test of a first line read the same text for it as for the run after it.
  "r5 PuTTY last line: P2 lastShort: any private line",
  // (round 4) The END line closes the key either way: its end is what the span runs to, and the line under the key's last is no part of it then.
  "r4 DER: AP lacked: also with an END line (equivalent: the END line is the end either way)",
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
  // (round 3) The begin tail of an OpenVPN header is worked out when a line of 32 digits first needs it and kept: the same result as working it out every time, and a cost that no bound on a 200,000-character answer tells from the frame's.
  "r3 OpenVPN: begin tail memo never set (recomputed each time)",
  // (round 3) The collapse of a fixed parameter's runs (`AAAA`, `////`) takes the runs that looksRandom itself rejects (six or more): taking two to five as well changes the verdict only for a body made of them, which no key's is.
  "r3: collapse: runs of 2 or more",
  // (round 3) A Diffie-Hellman key's private value is an INTEGER; the tag check only keeps a malformed structure (another element in the OCTET STRING) from being judged by the wrong bytes.
  "r3: fixed: the DH value is any element, not an INTEGER",
])

const group = process.argv[2] ?? 'judge'
const only = process.argv[3] ? process.argv[3].split('|') : null
const mutants = group === 'all' ? { ...JUDGE, ...WIRING, ...REVIEW } : group === 'wiring' ? WIRING : group === 'review' ? REVIEW : group === 'judge' ? JUDGE : null
if (!mutants) {
  console.error('usage: node scripts/linkedScreenMutants.cjs [judge|wiring|review|all] [part of a mutant name, or several joined with |]')
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
    if (only && !only.some((part) => name.includes(part))) continue
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

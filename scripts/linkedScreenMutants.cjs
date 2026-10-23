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

/** [file, the exact text, its replacement]. The text must be in the file exactly once. */
const JUDGE = {
  'pgp: tag + version only': [KEY, 'const ao = v === 3 ? o + 7 : o + 5', 'if (v > 0) return { tag, v, algo: 0 }\n  const ao = v === 3 ? o + 7 : o + 5'],
  'pgp: random required (J9 reverted)': [KEY, "if ((st.type === 'openssh' || st.type === 'pgp') && payload >= LONG_PAYLOAD)", "if (st.type === 'openssh' && payload >= LONG_PAYLOAD)"],
  'decodeHead: glue dropped from the first line only (J8 reverted)': [KEY, 'head += k > 0 && r.startsWith(glue) ? r.slice(k) : r', "head += k > 0 && head === '' && r.startsWith(glue) ? r.slice(k) : r"],
  'decode: any family under any kind': [KEY, 'const st = st0 && family.includes(st0.type) ? st0 : null', 'const st = st0'],
  'random: always true': [KEY, 'export function looksRandom(s: string): boolean {', 'export function looksRandom(s: string): boolean {\n  if (s.length >= 0) return true'],
  'W1: unverifiable block removed': [KEY, "return span('flag', random ? 'unverified' : 'not-key-material')", "return span(random ? 'remove' : 'flag', random ? 'unverified' : 'not-key-material')"],
  'W2: verified fragment flagged': [KEY, "? span('remove', `${st.type}-incomplete`)", "? span('flag', `${st.type}-incomplete`)"],
  'frame: 64 raw characters first (J1 reverted)': [KEY, 'frameOf(text.slice(Math.max(lineStart, r0 - 512), r0)).slice(-64)', 'frameOf(text.slice(Math.max(lineStart, r0 - 64), r0))'],
  'legacy PEM: no DEK-Info needed': [KEY, 'const legacy = headers.some((h) => /Proc-Type: ?4,ENCRYPTED/.test(h)) && headers.some((h) => DEK_RE.test(h))', 'const legacy = headers.some((h) => /Proc-Type/.test(h))'],
  'tail: no head anchor (J6 reverted)': [KEY, "if (head !== null) out.push({ rule, cls: 'remove', why: 'tail-with-end'", "if (head !== -2) out.push({ rule, cls: 'remove', why: 'tail-with-end'"],
  'tail: no joiner-fragment skip': [KEY, '(runs.length > 0 && joinerOnly && seg.length <= 16 && !skipped)', '(runs.length < 0)'],
  'tail: no short cut tail': [KEY, '} else if (framed && opts.cutAt === 0 && floor === start && runs.length >= 1', '} else if (framed && opts.cutAt === -1 && floor === start && runs.length >= 1'],
  'tail: strict partial-line frame': [KEY, "if (fr !== '' && !loose(frame).endsWith(loose(fr)) && !JOINER_FRAME.test(m[1])) return null", "if (fr !== '' && !frame.endsWith(fr)) return null"],
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
  'tail: a head in the answer anchored at the window\'s start': [KEY, '&& opts.cutAt !== 0 && headInReach(text, at, start, runs)', '&& opts.cutAt !== 0 && headInReach(text, at, start, runs) && runs.length < 0'],
  'tail: the reach\'s partial line read as a head in view': [KEY, 'return logicalLineStart(text, stepBack(text, ls0, lower), lower) > lower', 'return ls0 >= 0'],
  'tail: the text\'s first line read as a partial one': [KEY, '  if (lower === 0) return true\n', ''],
  // cost: one break search per line, one way to match an RSAKeyValue member
  'cost: a fresh break search per block': [KEY, '    const br = nextBr(lineStart, end)\n', '    const br = nextBreak(text, lineStart, end)\n'],
  'cost: an RSAKeyValue value and its trailing whitespace overlap': [KEY, '([A-Za-z0-9+/=][A-Za-z0-9+/=\\s]*)(?=<|&lt;|\\\\u003[cC])/g', '([A-Za-z0-9+/=\\s]{1,}?)\\s*(?=<|&lt;|\\\\u003[cC])/g'],
  'cost: an RSAKeyValue member takes the next tag\'s <': [KEY, '([A-Za-z0-9+/=][A-Za-z0-9+/=\\s]*)(?=<|&lt;|\\\\u003[cC])/g', '([A-Za-z0-9+/=][A-Za-z0-9+/=\\s]*)(?:<|&lt;|\\\\u003[cC])/g'],
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
  'cut: a made-up line judged by its width alone': [KEY, 'if (b - a >= 48 && new Set(line).size < 16) return true', 'if (b - a < 0) return true'],
  'cut: letters in order no sign of a made-up body': [KEY, '      if (n >= 8) return true\n', ''],
  // MX-1, FR-6, FR-7
  'refusal: shown as it came': [TOOL, '      shown = deps.mask(message)', '      shown = message'],
  'cwd: a drive letter read as a user': [TOOL, 'const URL_USERINFO_RE = /^(?![A-Za-z]:)', 'const URL_USERINFO_RE = /^(?!:)'],
  'jwk: a value the text cut judged by its length': [KEY, 'const named = cut || core.length >= 24', 'const named = core.length >= 24'],
}

/** Mutants no test can kill, because they change nothing the screen returns. */
const EQUIVALENT = new Set([
  // A flag a text's start gets when a removal runs through the cut starts inside that removal, so
  // it always overlaps it and is never counted: the check only saves the search.
  'screen: a straddled cut not checked',
  // The doing side's jobs are its own, never an end another computer cut: nothing passes cutStart.
  "host: the doing side's binding drops cutStart",
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
let bad = 0
try {
  for (const [name, [file, from, to]] of Object.entries(mutants)) {
    if (only && !name.includes(only)) continue
    const src = originals.get(file)
    const n = src.split(from).length - 1
    if (n !== 1) {
      console.log(`BAD MUTANT  ${name}: its text is in ${file} ${n} times, not once`)
      bad++
      continue
    }
    fs.writeFileSync(path.join(ROOT, file), src.replace(from, to))
    fs.rmSync(json, { force: true })
    const run = spawnSync(process.execPath, [vitest, 'run', ...TESTS, '--reporter=json', `--outputFile=${json}`], { cwd: ROOT, encoding: 'utf8' })
    restore()
    let failed = []
    let ran = 0
    try {
      const report = JSON.parse(fs.readFileSync(json, 'utf8'))
      ran = report.numTotalTests
      for (const f of report.testResults) for (const a of f.assertionResults) if (a.status === 'failed') failed.push(`${path.basename(f.name)}: ${a.title}`)
    } catch {
      failed = [`no report (vitest exited ${run.status})`]
    }
    const killed = failed.length > 0
    const expected = EQUIVALENT.has(name) ? !killed : killed
    if (!expected) bad++
    const verdict = killed ? 'KILLED  ' : EQUIVALENT.has(name) ? 'EQUIVALENT' : 'SURVIVED'
    console.log(`${verdict} ${name}${killed ? ` (${failed.length} of ${ran} tests failed)` : ''}`)
    for (const t of failed.slice(0, 4)) console.log(`           ${t}`)
  }
} finally {
  restore()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(bad ? `${bad} mutant(s) not as expected` : 'every mutant as expected')
process.exit(bad ? 1 : 0)

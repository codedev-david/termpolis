import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, truncateSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  normalizeForMatch,
  sfMatches,
  sniffFormat,
  parseLcovForFile,
  parseCoberturaForFile,
  parseJacocoForFile,
  parseCloverForFile,
  parseGoCoverForFile,
  parseCoverageForFile,
  findCoverageArtifact,
  readFileCoverage,
  COVERAGE_CANDIDATES,
  MAX_COVERAGE_BYTES,
} from '../../src/main/coverageReader'

describe('normalizeForMatch', () => {
  it('turns Windows separators into forward slashes', () => {
    expect(normalizeForMatch('src\\main\\a.ts')).toBe('src/main/a.ts')
  })

  it('strips a leading ./, including a repeated one', () => {
    expect(normalizeForMatch('./src/a.ts')).toBe('src/a.ts')
    expect(normalizeForMatch('././src/a.ts')).toBe('src/a.ts')
  })

  it('lowercases a drive letter, which tools disagree about', () => {
    expect(normalizeForMatch('C:\\repo\\a.ts')).toBe('c:/repo/a.ts')
  })

  it('leaves the rest of the path case alone, because Linux is case-sensitive', () => {
    expect(normalizeForMatch('src/Foo.ts')).toBe('src/Foo.ts')
  })
})

describe('sfMatches', () => {
  it('matches an identical path', () => {
    expect(sfMatches('src/a.ts', 'src/a.ts')).toBe(true)
  })

  it('matches an absolute SF against a repo-relative target', () => {
    expect(sfMatches('/home/me/repo/src/a.ts', 'src/a.ts')).toBe(true)
  })

  it('matches across separator styles', () => {
    expect(sfMatches('C:\\repo\\src\\a.ts', 'src/a.ts')).toBe(true)
  })

  it('refuses a path that merely ENDS with the same characters', () => {
    // The boundary check: `foosrc/a.ts` ends with the string `src/a.ts` but not with
    // the PATH `src/a.ts`. Without this, an unrelated file reports coverage as yours.
    expect(sfMatches('foosrc/a.ts', 'src/a.ts')).toBe(false)
  })

  it('refuses an unrelated file', () => {
    expect(sfMatches('src/b.ts', 'src/a.ts')).toBe(false)
  })

  it('still matches a genuinely nested copy — the documented limit of suffix matching', () => {
    expect(sfMatches('vendor/other/src/a.ts', 'src/a.ts')).toBe(true)
  })

  it('matches a source-root-relative path against a deeper repo-relative one', () => {
    // JaCoCo's shape. The recorded path is SHORTER than the target here, which is the
    // opposite of the absolute-path case and is why the match has to run both ways.
    expect(sfMatches('com/example/A.java', 'src/main/java/com/example/A.java')).toBe(true)
  })

  it('refuses a bare basename, which would otherwise claim every file of that name', () => {
    expect(sfMatches('A.java', 'src/main/java/com/example/A.java')).toBe(false)
  })

  it('still applies the boundary rule in the shorter direction', () => {
    expect(sfMatches('ple/A.java', 'src/main/java/com/example/A.java')).toBe(false)
  })

  it('matches a Go module import path against a repo-relative file', () => {
    // Go records `github.com/you/proj/pkg/a.go`, which shares no prefix with `pkg/a.go`.
    // Suffix matching is what makes Go work without knowing the module name.
    expect(sfMatches('github.com/you/proj/pkg/a.go', 'pkg/a.go')).toBe(true)
  })
})

describe('sniffFormat', () => {
  // Format is decided by CONTENT, never by filename — `coverage.info` is lcov from coverlet
  // and `coverage.xml` could be either XML dialect, so the name cannot be trusted.
  it('knows lcov by its SF record', () => {
    expect(sniffFormat('SF:src/a.ts\nDA:1,1\nend_of_record\n')).toBe('lcov')
  })

  it('knows lcov that opens with a TN test-name record', () => {
    expect(sniffFormat('TN:\nSF:src/a.ts\nDA:1,1\nend_of_record\n')).toBe('lcov')
  })

  it('knows a Go coverprofile by its mode header, in all three modes', () => {
    expect(sniffFormat('mode: set\nx/a.go:1.1,2.2 1 1\n')).toBe('gocover')
    expect(sniffFormat('mode: count\nx/a.go:1.1,2.2 1 1\n')).toBe('gocover')
    expect(sniffFormat('mode: atomic\nx/a.go:1.1,2.2 1 1\n')).toBe('gocover')
  })

  it('knows Cobertura by its line-rate attribute', () => {
    expect(sniffFormat('<?xml version="1.0"?>\n<coverage line-rate="0.5" version="1.9">')).toBe('cobertura')
  })

  it('knows Cobertura by its DOCTYPE even before the root element is read', () => {
    expect(sniffFormat('<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">')).toBe('cobertura')
  })

  it('knows JaCoCo by its DOCTYPE', () => {
    expect(sniffFormat('<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">\n<report name="app">')).toBe('jacoco')
  })

  it('still knows JaCoCo when a pipeline has stripped the DOCTYPE', () => {
    // The <report> root plus JaCoCo's own child elements. Without this fallback a valid
    // Java report sniffs as null, and the user is told they have no coverage at all.
    expect(sniffFormat('<report name="app"><counter type="LINE" missed="1" covered="9"/></report>')).toBe('jacoco')
  })

  it('tells Clover apart from Cobertura, which share a <coverage> root', () => {
    expect(sniffFormat('<coverage generated="1234567890" clover="3.2.0">\n<project name="All files">')).toBe('clover')
  })

  it('knows Clover from generated + project when the clover attribute is absent', () => {
    expect(sniffFormat('<coverage generated="1234567890">\n<project timestamp="1" name="All files">')).toBe('clover')
  })

  it('returns null for something it does not recognize, rather than guessing a parser', () => {
    // Guessing would produce numbers out of a document we do not understand, which is
    // worse than the honest "no coverage here".
    expect(sniffFormat('{"totals": {"percent_covered": 91.2}}')).toBeNull()
    expect(sniffFormat('')).toBeNull()
  })

  it('only reads the head, so a huge artifact costs no more to identify', () => {
    const artifact = 'SF:src/a.ts\n' + 'DA:1,1\n'.repeat(100_000)
    expect(sniffFormat(artifact)).toBe('lcov')
  })
})

describe('parseLcovForFile', () => {
  it('returns null when the file has no record at all', () => {
    // Null and {} are different answers: null means "no data, show nothing",
    // {} means "recorded, but no executable lines".
    expect(parseLcovForFile('SF:src/other.ts\nDA:1,1\nend_of_record\n', 'src/a.ts')).toBeNull()
  })

  it('returns an empty map for a file recorded with no DA lines', () => {
    expect(parseLcovForFile('SF:src/a.ts\nend_of_record\n', 'src/a.ts')).toEqual({})
  })

  it('reads hit counts for the requested file only', () => {
    const lcov = [
      'SF:src/other.ts', 'DA:1,99', 'end_of_record',
      'SF:src/a.ts', 'DA:1,3', 'DA:2,0', 'end_of_record',
    ].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 1: 3, 2: 0 })
  })

  it('SUMS a file that appears in more than one record', () => {
    // Two test projects covering the same source. First-wins would under-report a
    // line that only the second project exercises.
    const lcov = [
      'SF:src/a.ts', 'DA:1,2', 'DA:2,0', 'end_of_record',
      'SF:src/a.ts', 'DA:1,3', 'DA:2,5', 'end_of_record',
    ].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 1: 5, 2: 5 })
  })

  it('tolerates CRLF line endings', () => {
    expect(parseLcovForFile('SF:src/a.ts\r\nDA:7,4\r\nend_of_record\r\n', 'src/a.ts')).toEqual({ 7: 4 })
  })

  it('ignores the checksum field some writers append to DA', () => {
    expect(parseLcovForFile('SF:src/a.ts\nDA:7,4,d41d8cd9\nend_of_record\n', 'src/a.ts')).toEqual({ 7: 4 })
  })

  it('skips malformed DA records rather than poisoning the map with NaN', () => {
    const lcov = [
      'SF:src/a.ts',
      'DA:5',          // no comma at all
      'DA:foo,1',      // unparseable line number
      'DA:6,bar',      // unparseable hit count
      'DA:7,1',        // the only good one
      'end_of_record',
    ].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 7: 1 })
  })

  it('ignores DA lines belonging to a different file', () => {
    const lcov = [
      'SF:src/a.ts', 'DA:1,1', 'end_of_record',
      'SF:src/other.ts', 'DA:2,9', 'end_of_record',
    ].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 1: 1 })
  })

  it('ignores other lcov record types', () => {
    const lcov = ['SF:src/a.ts', 'FN:1,foo', 'FNDA:3,foo', 'LF:10', 'LH:4', 'DA:1,1', 'end_of_record'].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 1: 1 })
  })
})

// ---------------------------------------------------------------------------
// Cobertura — coverlet's DEFAULT output, so this parser is what makes .NET and C# work,
// and it is also what `coverage xml` gives for Python.
// ---------------------------------------------------------------------------
describe('parseCoberturaForFile', () => {
  const doc = (classes: string): string =>
    `<?xml version="1.0"?>\n<coverage line-rate="0.5">\n<packages><package name="P"><classes>\n${classes}\n</classes></package></packages>\n</coverage>`

  it('returns null when the document does not mention the file', () => {
    const xml = doc('<class name="P.B" filename="src/b.cs"><lines><line number="1" hits="1"/></lines></class>')
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toBeNull()
  })

  it('reads line numbers and hit counts for the requested file', () => {
    const xml = doc('<class name="P.A" filename="src/a.cs"><lines><line number="1" hits="4"/><line number="2" hits="0"/></lines></class>')
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toEqual({ 1: 4, 2: 0 })
  })

  it('takes the MAX per line, so the <methods> duplication does not double every count', () => {
    // This is the bug worth having a test for. Cobertura lists each method's lines inside
    // <methods> AND again in the class's own <lines>, so summing reports 8 hits where the
    // truth is 4 — a wrong number that still looks entirely plausible.
    const xml = doc(
      [
        '<class name="P.A" filename="src/a.cs">',
        '<methods><method name="M"><lines><line number="1" hits="4"/><line number="2" hits="0"/></lines></method></methods>',
        '<lines><line number="1" hits="4"/><line number="2" hits="0"/></lines>',
        '</class>',
      ].join('\n'),
    )
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toEqual({ 1: 4, 2: 0 })
  })

  it('merges two classes declared in the same file', () => {
    // C# partial classes, and any file holding more than one type.
    const xml = doc(
      [
        '<class name="P.A" filename="src/a.cs"><lines><line number="1" hits="2"/></lines></class>',
        '<class name="P.A2" filename="src/a.cs"><lines><line number="9" hits="3"/></lines></class>',
      ].join('\n'),
    )
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toEqual({ 1: 2, 9: 3 })
  })

  it('does not let a following class bleed into the matched one', () => {
    const xml = doc(
      [
        '<class name="P.A" filename="src/a.cs"><lines><line number="1" hits="2"/></lines></class>',
        '<class name="P.B" filename="src/b.cs"><lines><line number="5" hits="7"/></lines></class>',
      ].join('\n'),
    )
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toEqual({ 1: 2 })
  })

  it('matches a class recorded with an absolute filename', () => {
    const xml = doc('<class name="P.A" filename="C:\\build\\src\\a.cs"><lines><line number="3" hits="1"/></lines></class>')
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toEqual({ 3: 1 })
  })

  it('skips a class with no filename attribute at all', () => {
    const xml = doc('<class name="P.A"><lines><line number="1" hits="9"/></lines></class>')
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toBeNull()
  })

  it('skips malformed line elements rather than recording NaN', () => {
    const xml = doc(
      '<class name="P.A" filename="src/a.cs"><lines><line number="x" hits="1"/><line number="2"/><line number="3" hits="1"/></lines></class>',
    )
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toEqual({ 3: 1 })
  })

  it('handles minified XML with no line breaks at all', () => {
    // Tag-tokenizing rather than line-scanning is what buys this; a line-oriented parser
    // would read the whole document as one line and find nothing.
    const xml = '<coverage line-rate="1"><packages><package><classes><class filename="src/a.cs"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>'
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toEqual({ 1: 1 })
  })

  it('parses a second document correctly after a first', () => {
    // Guards the regex-state trap: a module-level /g regex keeps lastIndex between calls,
    // which silently drops matches on every document after the first.
    const xml = doc('<class name="P.A" filename="src/a.cs"><lines><line number="1" hits="1"/></lines></class>')
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toEqual({ 1: 1 })
    expect(parseCoberturaForFile(xml, 'src/a.cs')).toEqual({ 1: 1 })
  })
})

// ---------------------------------------------------------------------------
// JaCoCo — Java, Kotlin and Android.
// ---------------------------------------------------------------------------
describe('parseJacocoForFile', () => {
  it('joins the package name to the sourcefile name to rebuild the path', () => {
    // JaCoCo splits the path across two elements, so neither alone can be matched.
    const xml = [
      '<report name="app">',
      '<package name="com/example">',
      '<sourcefile name="A.java"><line nr="3" mi="0" ci="4"/><line nr="4" mi="2" ci="0"/></sourcefile>',
      '</package></report>',
    ].join('\n')
    expect(parseJacocoForFile(xml, 'com/example/A.java')).toEqual({ 3: 4, 4: 0 })
  })

  it('matches against a repo-relative source path under the usual Maven layout', () => {
    const xml = '<report><package name="com/example"><sourcefile name="A.java"><line nr="1" ci="1"/></sourcefile></package></report>'
    expect(parseJacocoForFile(xml, 'src/main/java/com/example/A.java')).toEqual({ 1: 1 })
  })

  it('returns null for a file the report does not mention', () => {
    const xml = '<report><package name="com/example"><sourcefile name="B.java"><line nr="1" ci="1"/></sourcefile></package></report>'
    expect(parseJacocoForFile(xml, 'com/example/A.java')).toBeNull()
  })

  it('does not let the next sourcefile in the same package bleed in', () => {
    const xml = [
      '<report><package name="com/example">',
      '<sourcefile name="A.java"><line nr="1" ci="1"/></sourcefile>',
      '<sourcefile name="B.java"><line nr="2" ci="9"/></sourcefile>',
      '</package></report>',
    ].join('\n')
    expect(parseJacocoForFile(xml, 'com/example/A.java')).toEqual({ 1: 1 })
  })

  it('stops matching when a new package opens', () => {
    const xml = [
      '<report>',
      '<package name="com/example"><sourcefile name="A.java"><line nr="1" ci="1"/></sourcefile></package>',
      '<package name="com/other"><line nr="99" ci="5"/></package>',
      '</report>',
    ].join('\n')
    expect(parseJacocoForFile(xml, 'com/example/A.java')).toEqual({ 1: 1 })
  })

  it('treats a missing ci attribute as zero rather than NaN', () => {
    const xml = '<report><package name="p"><sourcefile name="A.java"><line nr="1"/></sourcefile></package></report>'
    expect(parseJacocoForFile(xml, 'p/A.java')).toEqual({ 1: 0 })
  })

  it('skips a line with no usable line number', () => {
    const xml = '<report><package name="p"><sourcefile name="A.java"><line nr="x" ci="3"/><line nr="2" ci="1"/></sourcefile></package></report>'
    expect(parseJacocoForFile(xml, 'p/A.java')).toEqual({ 2: 1 })
  })

  it('handles a sourcefile in the default package, where the package name is empty', () => {
    const xml = '<report><package name=""><sourcefile name="A.java"><line nr="1" ci="2"/></sourcefile></package></report>'
    expect(parseJacocoForFile(xml, 'A.java')).toEqual({ 1: 2 })
  })

  it('skips a sourcefile with no name attribute', () => {
    const xml = '<report><package name="p"><sourcefile><line nr="1" ci="2"/></sourcefile></package></report>'
    expect(parseJacocoForFile(xml, 'p/A.java')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Clover — PHPUnit.
// ---------------------------------------------------------------------------
describe('parseCloverForFile', () => {
  it('reads counts from a file identified by its path attribute', () => {
    const xml = [
      '<coverage generated="1"><project name="All"><file path="/srv/app/src/A.php">',
      '<line num="5" type="stmt" count="3"/><line num="6" type="stmt" count="0"/>',
      '</file></project></coverage>',
    ].join('\n')
    expect(parseCloverForFile(xml, 'src/A.php')).toEqual({ 5: 3, 6: 0 })
  })

  it('falls back to the name attribute, which older PHPUnit used for the path', () => {
    const xml = '<coverage generated="1"><project><file name="src/A.php"><line num="1" count="2"/></file></project></coverage>'
    expect(parseCloverForFile(xml, 'src/A.php')).toEqual({ 1: 2 })
  })

  it('records condition and method lines too, not just statements', () => {
    // An uncovered branch is exactly what the gutter exists to point at.
    const xml = [
      '<coverage generated="1"><project><file path="src/A.php">',
      '<line num="1" type="method" name="foo" count="1"/>',
      '<line num="2" type="cond" truecount="0" falsecount="1" count="0"/>',
      '<line num="3" type="stmt" count="4"/>',
      '</file></project></coverage>',
    ].join('\n')
    expect(parseCloverForFile(xml, 'src/A.php')).toEqual({ 1: 1, 2: 0, 3: 4 })
  })

  it('returns null for a file the report does not mention', () => {
    const xml = '<coverage generated="1"><project><file path="src/B.php"><line num="1" count="1"/></file></project></coverage>'
    expect(parseCloverForFile(xml, 'src/A.php')).toBeNull()
  })

  it('does not let the next file bleed into the matched one', () => {
    const xml = [
      '<coverage generated="1"><project>',
      '<file path="src/A.php"><line num="1" count="1"/></file>',
      '<file path="src/B.php"><line num="2" count="9"/></file>',
      '</project></coverage>',
    ].join('\n')
    expect(parseCloverForFile(xml, 'src/A.php')).toEqual({ 1: 1 })
  })

  it('skips a file element carrying neither path nor name', () => {
    const xml = '<coverage generated="1"><project><file><line num="1" count="1"/></file></project></coverage>'
    expect(parseCloverForFile(xml, 'src/A.php')).toBeNull()
  })

  it('skips malformed line elements rather than recording NaN', () => {
    const xml = '<coverage generated="1"><project><file path="src/A.php"><line num="x" count="1"/><line num="2"/><line num="3" count="1"/></file></project></coverage>'
    expect(parseCloverForFile(xml, 'src/A.php')).toEqual({ 3: 1 })
  })
})

// ---------------------------------------------------------------------------
// Go — the only format here that reports BLOCKS rather than lines.
// ---------------------------------------------------------------------------
describe('parseGoCoverForFile', () => {
  it('expands a block into every line it spans', () => {
    // Go genuinely does not know which individual lines ran; the block's count is the
    // most honest thing that can be said about each line in it.
    const profile = 'mode: set\ngithub.com/me/p/pkg/a.go:3.10,6.2 2 1\n'
    expect(parseGoCoverForFile(profile, 'pkg/a.go')).toEqual({ 3: 1, 4: 1, 5: 1, 6: 1 })
  })

  it('records an unexecuted block as zero across its lines', () => {
    const profile = 'mode: set\ngithub.com/me/p/pkg/a.go:1.1,2.2 1 0\n'
    expect(parseGoCoverForFile(profile, 'pkg/a.go')).toEqual({ 1: 0, 2: 0 })
  })

  it('takes the MAX where blocks overlap, so a shared line is not reported unrun', () => {
    // Blocks meet on the lines that open and close them. A line belonging to both a
    // covered and an uncovered block did, in fact, run.
    const profile = ['mode: set', 'p/a.go:1.1,3.20 2 5', 'p/a.go:3.20,5.2 1 0'].join('\n')
    expect(parseGoCoverForFile(profile, 'p/a.go')).toEqual({ 1: 5, 2: 5, 3: 5, 4: 0, 5: 0 })
  })

  it('returns null for a file the profile does not mention', () => {
    expect(parseGoCoverForFile('mode: set\np/b.go:1.1,2.2 1 1\n', 'p/a.go')).toBeNull()
  })

  it('reads only the requested file out of a multi-file profile', () => {
    const profile = ['mode: count', 'p/a.go:1.1,1.10 1 3', 'p/b.go:1.1,9.10 1 7'].join('\n')
    expect(parseGoCoverForFile(profile, 'p/a.go')).toEqual({ 1: 3 })
  })

  it('tolerates CRLF and a trailing blank line', () => {
    expect(parseGoCoverForFile('mode: set\r\np/a.go:1.1,1.5 1 2\r\n\r\n', 'p/a.go')).toEqual({ 1: 2 })
  })

  it('ignores rows it cannot parse', () => {
    const profile = ['mode: set', 'garbage line here', 'p/a.go:1.1,1.5 1 2'].join('\n')
    expect(parseGoCoverForFile(profile, 'p/a.go')).toEqual({ 1: 2 })
  })

  it('refuses a block whose end precedes its start instead of looping', () => {
    expect(parseGoCoverForFile('mode: set\np/a.go:9.1,4.5 1 1\n', 'p/a.go')).toEqual({})
  })

  it('refuses an absurdly long block rather than allocating millions of entries', () => {
    // A corrupt profile should not be able to hang the main process.
    expect(parseGoCoverForFile('mode: set\np/a.go:1.1,999999.5 1 1\n', 'p/a.go')).toEqual({})
  })
})

describe('parseCoverageForFile', () => {
  // The dispatcher exists so readFileCoverage has one call site regardless of format.
  it('routes each format to the parser that understands it', () => {
    expect(parseCoverageForFile('SF:src/a.ts\nDA:1,1\nend_of_record\n', 'src/a.ts', 'lcov')).toEqual({ 1: 1 })
    expect(parseCoverageForFile('<coverage line-rate="1"><class filename="src/a.ts"><lines><line number="1" hits="1"/></lines></class></coverage>', 'src/a.ts', 'cobertura')).toEqual({ 1: 1 })
    expect(parseCoverageForFile('<report><package name="p"><sourcefile name="A.java"><line nr="1" ci="1"/></sourcefile></package></report>', 'p/A.java', 'jacoco')).toEqual({ 1: 1 })
    expect(parseCoverageForFile('<coverage generated="1"><project><file path="src/A.php"><line num="1" count="1"/></file></project></coverage>', 'src/A.php', 'clover')).toEqual({ 1: 1 })
    expect(parseCoverageForFile('mode: set\np/a.go:1.1,1.5 1 1\n', 'p/a.go', 'gocover')).toEqual({ 1: 1 })
  })
})

describe('findCoverageArtifact', () => {
  it('returns the first candidate that exists', () => {
    const present = join('/repo', 'coverage', 'lcov.info')
    expect(findCoverageArtifact('/repo', p => p === present)).toBe(present)
  })

  it('falls through to a later candidate', () => {
    const present = join('/repo', 'lcov.info')
    expect(findCoverageArtifact('/repo', p => p === present)).toBe(present)
  })

  it('returns null when a repo has produced no coverage at all', () => {
    expect(findCoverageArtifact('/repo', () => false)).toBeNull()
  })

  it('tries every documented candidate before giving up', () => {
    const tried: string[] = []
    findCoverageArtifact('/repo', p => { tried.push(p); return false })
    expect(tried).toHaveLength(COVERAGE_CANDIDATES.length)
  })

  it('looks for the .NET and Python lcov filenames, not only lcov.info', () => {
    // coverlet names its lcov output coverage.info and coverage.py names it coverage.lcov,
    // so a list of lcov.info paths finds nothing in a correctly instrumented repo.
    expect(COVERAGE_CANDIDATES).toContain('coverage.info')
    expect(COVERAGE_CANDIDATES).toContain('coverage.lcov')
  })

  it('looks for the artifacts the non-JS toolchains write by DEFAULT', () => {
    // The point of the whole change: these are what a developer gets without opting into
    // lcov at all, and each one is some language's out-of-the-box answer.
    expect(COVERAGE_CANDIDATES).toContain('coverage.cobertura.xml')  // .NET, coverlet default
    expect(COVERAGE_CANDIDATES).toContain('coverage.xml')            // Python, coverage xml
    expect(COVERAGE_CANDIDATES).toContain('coverage.out')            // Go
    expect(COVERAGE_CANDIDATES).toContain('clover.xml')              // PHP, PHPUnit
    expect(COVERAGE_CANDIDATES).toContain('target/site/jacoco/jacoco.xml')  // Java, Maven
  })
})

describe('findCoverageArtifact, for paths that cannot be fixed strings', () => {
  const dirsFrom = (dirs: Record<string, string[]>) => (p: string) => dirs[p] ?? []

  it('finds coverlet collector output under a per-run guid directory', () => {
    const readDir = dirsFrom({
      [join('/repo', 'TestResults')]: ['8f3c4a21-0b19-4e77-9f2d-5c1a7e6b3d40'],
      [join('/repo', 'TestResults', '8f3c4a21-0b19-4e77-9f2d-5c1a7e6b3d40')]: ['coverage.info'],
    })
    expect(findCoverageArtifact('/repo', () => false, readDir))
      .toBe(join('/repo', 'TestResults', '8f3c4a21-0b19-4e77-9f2d-5c1a7e6b3d40', 'coverage.info'))
  })

  it('also takes Cobertura from a guid directory, which is what coverlet writes by default', () => {
    // This assertion is deliberately the inverse of what it used to be. It previously
    // proved the scan IGNORED coverage.cobertura.xml, which was correct only while lcov
    // was the single parseable format — for a default `dotnet test` run that meant finding
    // the artifact and then throwing it away.
    const readDir = dirsFrom({
      [join('/repo', 'TestResults')]: ['abc'],
      [join('/repo', 'TestResults', 'abc')]: ['coverage.cobertura.xml'],
    })
    expect(findCoverageArtifact('/repo', () => false, readDir))
      .toBe(join('/repo', 'TestResults', 'abc', 'coverage.cobertura.xml'))
  })

  it('still ignores a guid directory holding nothing it can read', () => {
    const readDir = dirsFrom({
      [join('/repo', 'TestResults')]: ['abc'],
      [join('/repo', 'TestResults', 'abc')]: ['run.trx', 'In'],
    })
    expect(findCoverageArtifact('/repo', () => false, readDir)).toBeNull()
  })

  it('takes a single simplecov tracefile whatever the project named it', () => {
    const readDir = dirsFrom({ [join('/repo', 'coverage', 'lcov')]: ['my_app.lcov'] })
    expect(findCoverageArtifact('/repo', () => false, readDir))
      .toBe(join('/repo', 'coverage', 'lcov', 'my_app.lcov'))
  })

  it('refuses simplecov per-file fragments rather than passing one off as the repo', () => {
    // simplecov-lcov's default mode writes one .lcov per source file. Returning any one of
    // them would report that single file's coverage as the whole repository's — wrong in
    // the direction that still looks like a plausible number.
    const readDir = dirsFrom({
      [join('/repo', 'coverage', 'lcov')]: ['lib-foo.lcov', 'lib-bar.lcov'],
    })
    expect(findCoverageArtifact('/repo', () => false, readDir)).toBeNull()
  })

  it('prefers a fixed candidate over anything found by scanning', () => {
    const present = join('/repo', 'coverage', 'lcov.info')
    const readDir = dirsFrom({
      [join('/repo', 'TestResults')]: ['x'],
      [join('/repo', 'TestResults', 'x')]: ['coverage.info'],
    })
    expect(findCoverageArtifact('/repo', p => p === present, readDir)).toBe(present)
  })

  it('does not scan at all when a fixed candidate hits', () => {
    // The cost claim in the doc comment: an ordinary repo pays the stat calls it always
    // paid, and nothing else.
    const present = join('/repo', 'coverage', 'lcov.info')
    const scanned: string[] = []
    findCoverageArtifact('/repo', p => p === present, p => { scanned.push(p); return [] })
    expect(scanned).toEqual([])
  })

  it('treats an unreadable directory as empty rather than throwing', () => {
    // The default readDir hits the real filesystem, and /repo does not exist.
    expect(findCoverageArtifact('/repo', () => false)).toBeNull()
  })
})

describe('readFileCoverage', () => {
  let root: string

  const writeArtifact = (body: string, rel = 'coverage/lcov.info') => {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
    return p
  }

  /** Force explicit mtimes — real clock granularity is too coarse to rely on here. */
  const setMtime = (p: string, secondsFromEpoch: number) => {
    const d = new Date(secondsFromEpoch * 1000)
    utimesSync(p, d, d)
  }

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tp-cov-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('returns null for a repo with no coverage artifact — the common case, not an error', () => {
    expect(readFileCoverage(root, 'src/a.ts')).toBeNull()
  })

  it('returns null for a file the artifact does not mention', () => {
    writeArtifact('SF:src/other.ts\nDA:1,1\nend_of_record\n')
    expect(readFileCoverage(root, 'src/a.ts')).toBeNull()
  })

  it('reads the hit counts and names the artifact it used', () => {
    const lcovPath = writeArtifact('SF:src/a.ts\nDA:1,3\nDA:2,0\nend_of_record\n')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/a.ts'), 'x')
    setMtime(join(root, 'src/a.ts'), 1_000)
    setMtime(lcovPath, 2_000)

    const cov = readFileCoverage(root, 'src/a.ts')
    expect(cov).toMatchObject({ source: lcovPath, format: 'lcov', lines: { 1: 3, 2: 0 }, stale: false })
  })

  it('flags coverage older than the file it describes', () => {
    const lcovPath = writeArtifact('SF:src/a.ts\nDA:1,3\nend_of_record\n')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/a.ts'), 'x')
    setMtime(lcovPath, 1_000)
    setMtime(join(root, 'src/a.ts'), 2_000)

    expect(readFileCoverage(root, 'src/a.ts')?.stale).toBe(true)
  })

  it('treats a source file that no longer exists as stale, not as a crash', () => {
    writeArtifact('SF:src/gone.ts\nDA:1,1\nend_of_record\n')
    expect(readFileCoverage(root, 'src/gone.ts')?.stale).toBe(true)
  })

  it('refuses an artifact too large to parse without blocking the main process', () => {
    const p = writeArtifact('SF:src/a.ts\nDA:1,1\nend_of_record\n')
    // Extend rather than write 32 MB: statSync reports the size either way.
    truncateSync(p, MAX_COVERAGE_BYTES + 1)
    expect(readFileCoverage(root, 'src/a.ts')).toBeNull()
  })

  it('finds an artifact at a non-default candidate path', () => {
    const p = writeArtifact('SF:src/a.ts\nDA:1,1\nend_of_record\n', 'lcov.info')
    expect(readFileCoverage(root, 'src/a.ts')?.source).toBe(p)
  })

  it('matches an artifact written with absolute SF paths', () => {
    writeArtifact(`SF:${join(root, 'src/a.ts')}\nDA:1,1\nend_of_record\n`)
    expect(readFileCoverage(root, 'src/a.ts')?.lines).toEqual({ 1: 1 })
  })

  // --- the languages that had no answer at all before -----------------------------

  it('reads a .NET repo whose only artifact is coverlet Cobertura', () => {
    const p = writeArtifact(
      '<?xml version="1.0"?>\n<coverage line-rate="0.5"><packages><package name="App"><classes><class name="App.A" filename="src/a.cs"><lines><line number="1" hits="4"/><line number="2" hits="0"/></lines></class></classes></package></packages></coverage>',
      'coverage.cobertura.xml',
    )
    expect(readFileCoverage(root, 'src/a.cs')).toMatchObject({
      source: p, format: 'cobertura', lines: { 1: 4, 2: 0 },
    })
  })

  it('reads a Go repo from a coverprofile', () => {
    const p = writeArtifact('mode: set\ngithub.com/me/p/pkg/a.go:1.1,2.10 2 1\n', 'coverage.out')
    expect(readFileCoverage(root, 'pkg/a.go')).toMatchObject({
      source: p, format: 'gocover', lines: { 1: 1, 2: 1 },
    })
  })

  it('reads a Java repo from a JaCoCo report under the Maven layout', () => {
    const p = writeArtifact(
      '<report name="app"><package name="com/example"><sourcefile name="A.java"><line nr="7" mi="0" ci="3"/></sourcefile></package></report>',
      'target/site/jacoco/jacoco.xml',
    )
    expect(readFileCoverage(root, 'src/main/java/com/example/A.java')).toMatchObject({
      source: p, format: 'jacoco', lines: { 7: 3 },
    })
  })

  it('reads a PHP repo from a Clover report', () => {
    const p = writeArtifact(
      '<coverage generated="1"><project name="All"><file path="src/A.php"><line num="2" type="stmt" count="6"/></file></project></coverage>',
      'clover.xml',
    )
    expect(readFileCoverage(root, 'src/A.php')).toMatchObject({
      source: p, format: 'clover', lines: { 2: 6 },
    })
  })

  it('reads a Python repo from `coverage xml`, which is Cobertura under another name', () => {
    writeArtifact(
      '<?xml version="1.0"?>\n<coverage line-rate="0.9"><packages><package><classes><class filename="app/main.py"><lines><line number="4" hits="2"/></lines></class></classes></package></packages></coverage>',
      'coverage.xml',
    )
    expect(readFileCoverage(root, 'app/main.py')).toMatchObject({ format: 'cobertura', lines: { 4: 2 } })
  })

  it('returns null for an artifact in a format it cannot identify', () => {
    // A file sitting at a candidate path is not proof of anything. Guessing a parser here
    // would invent numbers from a document we do not understand.
    writeArtifact('{"totals": {"percent_covered": 91.2}}', 'coverage.xml')
    expect(readFileCoverage(root, 'src/a.ts')).toBeNull()
  })
})

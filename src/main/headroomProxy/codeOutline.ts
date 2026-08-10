/**
 * Structure-aware source compression: keep the shape of the code, drop the bodies.
 *
 * WHY THIS EXISTS. The head/tail line window is content-blind — on a 400-line source file it keeps
 * the first 12 lines (which are almost always imports) and the last 6, and throws away every
 * function signature in between. That is the worst possible 18 lines to keep. This pass spends the
 * budget on the lines that carry the file's structure: imports, class and type declarations, and
 * every function/method signature, with the bodies collapsed to a counted marker.
 *
 * WHAT IT IS NOT. It is not a parser. A real AST would mean a grammar per language in the proxy's
 * hot path — twenty parsers, twenty upgrade paths, and a parse cost on every request. This walks
 * lines with a masked-out view of strings and comments, tracks brace depth (or indentation, for
 * Python-family), and classifies each line as structure or body. That captures the actual win —
 * signatures survive, bodies don't — for a few hundred lines of dependency-free, deterministic code.
 * Where it is wrong it is wrong in the safe direction: an unrecognized line is KEPT, not dropped.
 *
 * LINE NUMBERS. The dominant source-code payload on the wire is a Read result, which arrives in
 * `cat -n` form — `␣␣␣␣12\tcode`. Those prefixes defeat every indentation and start-of-line test, so
 * they are detected and stripped for ANALYSIS while the emitted lines keep them: the numbers are how
 * an agent addresses a location, and they cost almost nothing next to the bodies being dropped.
 *
 * CACHE SAFETY. Pure and deterministic: same bytes in, same bytes out, no clock, no randomness, no
 * dependence on anything outside the input. That is non-negotiable — the output lands in the
 * conversation prefix that Anthropic's cache keys on, so a transform that varied between turns
 * would invalidate the prefix on every request and cost far more than it saves.
 *
 * SHRINK-ONLY. Every path returns the original text unless the outline is meaningfully smaller.
 */

/** Below this, the line window alone is fine and an outline is churn. */
export const OUTLINE_MIN_LINES = 12
/** Don't replace a run of N body lines with a marker unless the marker actually wins. */
export const OUTLINE_MIN_RUN = 3
/** An outline that saves less than this fraction isn't worth the fidelity change. */
export const OUTLINE_MIN_GAIN = 0.15
/** Fraction of non-blank lines that must carry a `cat -n` prefix before we treat it as numbered. */
export const NUMBERED_MIN_RATIO = 0.8

export type CodeFamily = 'brace' | 'indent'

const BRACE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'java', 'cs', 'go', 'rs', 'c', 'h', 'cc',
  'cpp', 'cxx', 'hpp', 'hh', 'swift', 'kt', 'kts', 'scala', 'php', 'm', 'mm', 'dart', 'groovy',
  'proto', 'sol', 'zig', 'v', 'cu',
])
const INDENT_EXT = new Set(['py', 'pyi', 'rb', 'coffee', 'nim', 'cr'])

/** Language family from a file path, when the wire gave us one. Cheapest and most reliable signal. */
export function familyForPath(p: unknown): CodeFamily | null {
  if (typeof p !== 'string') return null
  const m = /\.([A-Za-z0-9]+)$/.exec(p.trim())
  if (!m) return null
  const ext = m[1].toLowerCase()
  if (BRACE_EXT.has(ext)) return 'brace'
  if (INDENT_EXT.has(ext)) return 'indent'
  return null
}

/** `␣␣␣12\t` — the Read tool's line-number gutter. Bounded so it can't eat real indentation. */
const NUM_PREFIX_RE = /^[ \t]{0,8}\d+\t/

/**
 * Strip a `cat -n` gutter when the text overwhelmingly has one. Returns null when it does not, so
 * the caller analyses the lines it was given. Never applied to the emitted text — only the analysis.
 */
export function stripNumbering(lines: string[]): string[] | null {
  let hits = 0
  let nonBlank = 0
  for (const l of lines) {
    if (l.trim() === '') continue
    nonBlank++
    if (NUM_PREFIX_RE.test(l)) hits++
  }
  if (nonBlank === 0 || hits / nonBlank < NUMBERED_MIN_RATIO) return null
  return lines.map((l) => {
    const m = NUM_PREFIX_RE.exec(l)
    return m ? l.slice(m[0].length) : l
  })
}

/**
 * Blank out string literals and comments so brace counting can't be fooled by a `{` inside a string
 * or a commented-out block. Character positions are preserved (spaces substituted) so indentation
 * and column-based checks still line up with the original line.
 *
 * `#` starts a comment everywhere EXCEPT the brace family, where it is a C preprocessor directive, a
 * Rust/C# attribute or a JS private field — all of which are structure worth keeping.
 */
function maskLines(lines: string[], family?: CodeFamily | null): string[] {
  const hashIsComment = family !== 'brace'
  const out: string[] = []
  let inBlock = false                 // /* … */
  let inTriple: string | null = null  // ''' or """
  for (const raw of lines) {
    let masked = ''
    let i = 0
    let inStr: string | null = null
    while (i < raw.length) {
      const c = raw[i]
      const two = raw.slice(i, i + 2)
      const three = raw.slice(i, i + 3)
      if (inTriple) {
        if (three === inTriple) { inTriple = null; masked += '   '; i += 3; continue }
        masked += ' '; i++; continue
      }
      if (inBlock) {
        if (two === '*/') { inBlock = false; masked += '  '; i += 2; continue }
        masked += ' '; i++; continue
      }
      if (inStr) {
        if (c === '\\') { masked += '  '; i += 2; continue }
        if (c === inStr) { inStr = null; masked += ' '; i++; continue }
        masked += ' '; i++; continue
      }
      if (three === '"""' || three === "'''") { inTriple = three; masked += '   '; i += 3; continue }
      if (two === '/*') { inBlock = true; masked += '  '; i += 2; continue }
      if (two === '//') { masked += ' '.repeat(raw.length - i); break }
      if (c === '#' && hashIsComment) { masked += ' '.repeat(raw.length - i); break }
      if (c === '"' || c === "'" || c === '`') { inStr = c; masked += ' '; i++; continue }
      masked += c
      i++
    }
    out.push(masked)
  }
  return out
}

/**
 * Declaration-shaped line starts. Deliberately does NOT include bare `const`/`let`/`var`: at file
 * scope those are already kept by the depth rule, and inside a body they are the single most common
 * statement there is — matching them would keep most of every function body and win nothing.
 */
const DECL_RE = new RegExp(
  '^\\s*(?:' +
  '@\\w' +                                                          // decorator / annotation
  '|#\\s*(?:include|define|pragma|import|if|ifdef|endif|region)\\b' + // preprocessor
  '|#\\[' +                                                         // Rust attribute
  '|(?:export|module\\.exports|declare)\\b' +                       // any export / ambient decl
  '|(?:import|from|use|using|require|include|package|namespace|module|open)\\b' +
  '|(?:pub\\s+)?(?:public|private|protected|internal|static|final|abstract|sealed|virtual|' +
  'override|readonly|async|unsafe|extern|inline|partial|synchronized)\\b' +
  '|(?:func|fn|def|function|class|interface|type|enum|struct|impl|trait|record|object|protocol|' +
  'extension|delegate|operator|constructor)\\b' +
  '|(?:extends|implements)\\b' +
  ')',
)
/** A line that only closes blocks — worth keeping so the outline still reads as nested code. */
const CLOSE_ONLY_RE = /^\s*[)}\]]+[;,]?\s*$/
/** Signature-shaped: has a parameter list and opens a block. Catches Java/C/Go methods with no keyword. */
const SIG_RE = /\([^)]*\)[^(){}]*\{\s*$/
/**
 * Control flow wears the same `(…) {` shape as a signature, so SIG_RE alone keeps every `if` and
 * `for` in the file — that is body, not structure, and it is where most of the bytes are.
 */
const CTRL_RE = new RegExp(
  '^\\s*(?:\\}\\s*)?(?:if|else|elif|for|foreach|while|do|switch|case|default|catch|try|finally|' +
  'with|using|unless|when|match|guard|lock|synchronized|return|await|yield|go|defer)\\b',
)

/** Brace depth only — counting parens/brackets too would make a multi-line call look like a body. */
function braceDelta(masked: string): number {
  let d = 0
  for (const c of masked) {
    if (c === '{') d++
    else if (c === '}') d--
  }
  return d
}

function indentOf(line: string): number {
  let n = 0
  for (const c of line) {
    if (c === ' ') n++
    else if (c === '\t') n += 4
    else break
  }
  return n
}

/** Which lines carry structure worth keeping. Unknown → keep, so the failure mode is "less saving". */
function keepMap(masked: string[], family: CodeFamily): boolean[] {
  const keep = new Array<boolean>(masked.length).fill(false)
  if (family === 'brace') {
    let depth = 0
    for (let i = 0; i < masked.length; i++) {
      const m = masked[i]
      const before = depth
      depth += braceDelta(m)
      const after = depth
      if (m.trim() === '') { keep[i] = false; continue }
      keep[i] = before === 0 || after === 0 || DECL_RE.test(m) ||
        (SIG_RE.test(m) && !CTRL_RE.test(m)) ||
        (CLOSE_ONLY_RE.test(m) && after <= 1)
    }
    return keep
  }
  // Indent family: structure is anything at column 0 plus declarations and decorators at any depth.
  for (let i = 0; i < masked.length; i++) {
    const m = masked[i]
    if (m.trim() === '') { keep[i] = false; continue }
    keep[i] = indentOf(m) === 0 || DECL_RE.test(m)
  }
  return keep
}

/**
 * Is this text source code? Used only when the wire gave us no usable file path. Deliberately
 * strict — mistaking a log or prose for code would drop lines that carry the actual content.
 */
export function looksLikeCode(text: string, family?: CodeFamily | null): boolean {
  if (family) return true
  const raw = text.split('\n')
  if (raw.length < OUTLINE_MIN_LINES) return false
  const src = stripNumbering(raw) ?? raw
  const masked = maskLines(src, family)
  let decls = 0
  let opens = 0
  let indented = 0
  let nonBlank = 0
  for (const m of masked) {
    if (m.trim() === '') continue
    nonBlank++
    if (DECL_RE.test(m)) decls++
    if (/\{\s*$/.test(m)) opens++
    if (indentOf(m) > 0) indented++
  }
  if (nonBlank < OUTLINE_MIN_LINES) return false
  // Needs BOTH a real declaration density and block/indent structure — either alone shows up in
  // ordinary prose and command output often enough to matter.
  return decls >= 3 && decls / nonBlank >= 0.05 && (opens >= 3 || indented / nonBlank >= 0.4)
}

/** Content-only guess at the family, for when there is no path. */
export function guessFamily(text: string): CodeFamily {
  const raw = text.split('\n')
  const src = stripNumbering(raw) ?? raw
  let braces = 0
  for (const m of maskLines(src)) if (/\{\s*$/.test(m)) braces++
  return braces >= 3 ? 'brace' : 'indent'
}

/**
 * Collapse body lines, keep structure. Returns the input unchanged unless the result is
 * meaningfully smaller — the caller can therefore use the return value unconditionally.
 */
export function outlineCode(text: string, family?: CodeFamily | null): string {
  const lines = text.split('\n')
  if (lines.length < OUTLINE_MIN_LINES) return text
  const src = stripNumbering(lines) ?? lines
  const fam = family || guessFamily(text)
  const keep = keepMap(maskLines(src, fam), fam)

  const out: string[] = []
  let run: number[] = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length < OUTLINE_MIN_RUN) {
      for (const i of run) out.push(lines[i])
    } else {
      // Indent the marker like the first line it replaces, so nesting still reads correctly.
      const pad = ' '.repeat(indentOf(src[run[0]]))
      out.push(`${pad}… ${run.length} lines …`)
    }
    run = []
  }
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) { flush(); out.push(lines[i]) } else run.push(i)
  }
  flush()

  const result = out.join('\n')
  if (result.length > text.length * (1 - OUTLINE_MIN_GAIN)) return text
  return result
}

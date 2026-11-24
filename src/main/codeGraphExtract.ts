// codeGraphExtract.ts — pure, dependency-free heuristic extraction of code STRUCTURE
// (symbols, import specifiers, intra-file references) from one source file.
//
// No tree-sitter, no TypeScript compiler, no native bindings — just per-language regex
// rule sets over the raw text. That keeps the code graph native-free (the same ethos as
// the WASM embedder) and, crucially, exhaustively unit-testable: every branch here is a
// pure function of a string. It is lower fidelity than a real AST (no scope resolution;
// references are matched by NAME), which the graph layer accounts for when it resolves
// references to symbols. Top-level symbols only in this MVP (class methods are not emitted
// as separate symbols) — precision over recall.

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'module'
  | 'resource'
  | 'variable'
  | 'method'

export interface CodeSymbol {
  name: string
  kind: SymbolKind
  file: string
  startLine: number // 1-based
  endLine: number // 1-based, best-effort (brace/indent matched)
  lang: string
  // AST-precise callee names inside this symbol's body, set by the tree-sitter extractor. When
  // present the graph uses them verbatim; when absent (heuristic extractor) it derives refs from
  // the sliced body text. Optional so heuristic symbols stay unchanged.
  refs?: string[]
}

export interface FileExtract {
  file: string
  lang: string
  symbols: CodeSymbol[]
  imports: string[] // module specifiers, de-duplicated, first-seen order
  references: string[] // callable names referenced (name followed by '('), de-duplicated
}

/** What extractFile asks of a rule: a global RegExp, or a hand-written matcher that keeps the same exec/lastIndex
 *  contract (a match's index, capture group 1, lastIndex past the match, and lastIndex 0 with null at the end). */
interface Matcher {
  lastIndex: number
  exec(text: string): RegExpExecArray | null
}
interface DefRule {
  kind: SymbolKind
  re: Matcher // global + multiline; capture group 1 = the symbol name
}
interface LangRules {
  lang: string
  block: 'brace' | 'indent'
  defs: DefRule[]
  imports: Matcher[] // global; capture group 1 = the imported specifier
}

// Every rule is read in time linear in the file. A rule whose loop or run can stretch over blank lines, a long line or
// an unclosed bracket is either written so each line start is matched one way only, or is a hand-written matcher below.
// tests/electron/codeGraphExtract.test.ts times each language on 50k-character worst cases.

/** A match result shaped like RegExp.exec's: the matched text, group 1, and where it starts. */
function execResult(text: string, index: number, end: number, group: string): RegExpExecArray {
  const m = [text.slice(index, end), group] as unknown as RegExpExecArray
  m.index = index
  m.input = text
  return m
}

const WS = /\s/
const QUOTE = /['"]/g

/** The first ' or " at or after `from`, or -1. */
function nextQuote(text: string, from: number): number {
  QUOTE.lastIndex = from
  return QUOTE.exec(text)?.index ?? -1
}

/**
 * `import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]` (global), matched in linear time. The regex retried every split of
 * the whitespace and of the run up to the first quote, so `import` followed by a long run of spaces took seconds. The
 * match it finds is fixed by the first quote Q after `import` and its whitespace: the text before Q is whitespace only
 * (`import 'x'`), or ends in whitespace, `from` and whitespace with at least two characters between `import` and
 * `from` (`import x from 'y'`, `import {\n…\n} from 'y'`, however long); the specifier runs to the next quote.
 */
class JsImportMatcher implements Matcher {
  lastIndex = 0
  private q = -2 // the first quote after the last `import` looked at (-1: none left)
  private qWs = 0 // where the whitespace run ending at q starts
  private q2 = 0 // the quote after q

  exec(text: string): RegExpExecArray | null {
    if (this.lastIndex === 0) this.q = -2
    for (let i = text.indexOf('import', this.lastIndex); i >= 0; i = text.indexOf('import', i + 1)) {
      const w = i + 6
      if (!WS.test(text.charAt(w))) continue
      if (this.q !== -1 && w >= this.q) this.findQuote(text, w)
      const q = this.q
      if (q < 0) break
      const direct = this.qWs <= w
      const f = this.qWs - 4
      const viaFrom = this.qWs < q && f >= w + 2 && text.startsWith('from', f) && WS.test(text[f - 1])
      if ((direct || viaFrom) && this.q2 > q + 1) {
        this.lastIndex = this.q2 + 1
        return execResult(text, i, this.q2 + 1, text.slice(q + 1, this.q2))
      }
    }
    this.lastIndex = 0
    return null
  }

  private findQuote(text: string, from: number): void {
    const q = nextQuote(text, from)
    this.q = q
    if (q < 0) return
    let s = q
    while (s > from && WS.test(text[s - 1])) s--
    this.qWs = s
    this.q2 = nextQuote(text, q + 1)
  }
}

/**
 * A method rule `HEAD\([^{}]*\)\s*(?:CLAUSE)?\{` (global, multiline), where HEAD is a regex ending at the parameter
 * list's `(` that matches a line start one way only (its modifiers are separated by spaces or tabs, never a newline).
 * The tail is read here in linear time: as a regex, `[^{}]*` ran from every head to the next brace, so thousands of
 * `void f(int x);` lines with no brace after them took seconds. For a head ending at e, let B be the first brace at or
 * after e and C the first `{` at or after B. Without the clause the regex matches iff B is `{` and the last non-space
 * before it is a `)` at or after e. `clause` reads the stretch from e to B once and returns the last `)` before B that
 * a clause the regex would accept follows (-1 when none); the rule then also matches when that `)` is at or after e.
 * Either way the match ends just past C. Heads come in order, so e only grows, and each stretch is read once a pass;
 * C is remembered too, as every head after a `}` with no `{` near shares it.
 */
class MethodMatcher implements Matcher {
  lastIndex = 0
  private b = -1 // the first brace at or after the e the facts below were read from (text.length when none)
  private c = -1 // the first { at or after b (-1 when none)
  private solid = -1 // the last non-space before b (-1 when none)
  private clauseAt = -1 // the last ) before b that an accepted clause follows (-1 when none)
  private readonly open = new NextOf('{') // c: many heads past a `}` share the next `{`

  constructor(
    private readonly head: RegExp,
    private readonly clause: (text: string, e: number, b: number, c: number) => number,
  ) {}

  exec(text: string): RegExpExecArray | null {
    if (this.lastIndex === 0) {
      this.b = -1
      this.open.reset()
    }
    this.head.lastIndex = this.lastIndex
    for (let h = this.head.exec(text); h !== null; h = this.head.exec(text)) {
      const e = h.index + h[0].length
      // The facts read for an earlier e hold for this one while e <= b.
      if (e > this.b) this.read(text, e)
      const direct = text[this.b] === '{' && this.solid >= e && text[this.solid] === ')'
      if (this.c >= 0 && (direct || this.clauseAt >= e)) {
        this.lastIndex = this.c + 1
        return execResult(text, h.index, this.c + 1, h[1])
      }
      this.head.lastIndex = h.index + 1
    }
    this.lastIndex = 0
    return null
  }

  private read(text: string, e: number): void {
    this.solid = -1
    let b = e
    for (; b < text.length; b++) {
      const ch = text[b]
      if (ch === '{' || ch === '}') break
      if (!WS.test(ch)) this.solid = b
    }
    this.b = b
    this.c = text[b] === '{' ? b : this.open.find(text, b)
    this.clauseAt = this.c >= 0 ? this.clause(text, e, b, this.c) : -1
  }
}

/** The first non-space at or after `from`, or `to` when there is none before it. */
function nextSolid(text: string, from: number, to: number): number {
  let i = from
  while (i < to && WS.test(text[i])) i++
  return i
}

/** Java/C# `where` clause, `\s*where\s[^{]+` before the `{`: the last `)` followed by it, before b. */
function whereClause(text: string, e: number, b: number, c: number): number {
  let at = -1
  for (let p = text.indexOf(')', e); p >= 0 && p < b; p = text.indexOf(')', p + 1)) {
    const q = nextSolid(text, p + 1, b)
    if (q + 5 < b && text.startsWith('where', q) && WS.test(text[q + 5]) && c !== q + 6) at = p
  }
  return at
}

/**
 * TypeScript return type, `\s*:\s*[^={;]{1,120}` before the `{` at c. For a `:` at q that follows a `)` and spaces,
 * the clause matches iff the text S from q + 1 to c is not empty, holds no `=` or `;` (nor `{`: c is the first one)
 * and is at most 120 characters past its leading spaces. Each condition only gets easier as q moves right, and only
 * the last `:` can make S empty, so the last two such `:` decide it.
 */
function returnTypeClause(text: string, e: number, b: number, c: number): number {
  let close = -1 // a ) followed only by spaces so far
  let last = -1
  let lastClose = -1
  let prev = -1
  let prevClose = -1
  for (let i = e; i < b; i++) {
    const ch = text[i]
    if (ch === ')') close = i
    else if (ch === ':' && close >= 0) {
      prev = last
      prevClose = lastClose
      last = i
      lastClose = close
      close = -1
    } else if (!WS.test(ch)) close = -1
  }
  const q = last === c - 1 ? prev : last
  if (q < 0) return -1
  const f = nextSolid(text, q + 1, c)
  if (c - f > 120) return -1
  for (let i = f; i < c; i++) if (text[i] === '=' || text[i] === ';') return -1
  return q === last ? lastClose : prevClose
}

/** `text.indexOf(ch, from)`, remembered: a later `from` at or before the last answer has the same answer. */
class NextOf {
  private from = -1
  private at = -1

  constructor(private readonly ch: string) {}

  reset(): void {
    this.from = -1
  }

  find(text: string, from: number): number {
    if (this.from < 0 || from < this.from || (this.at >= 0 && from > this.at)) {
      this.from = from
      this.at = text.indexOf(this.ch, from)
    }
    return this.at
  }
}

const CONST_HEAD = /^[ \t]*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*/gm
const IDENT_AT = /[A-Za-z_$][\w$]*/y

/**
 * `^[ \t]*(?:export\s+)?(?:const|let)\s+(NAME)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|IDENT)\s*=>` (global,
 * multiline), matched in linear time. `[^=]+` and `[^)]*` each run to the first `=` or `)` after them, so thousands of
 * `const a: T` or `const a = (` lines before the next one took seconds. Every run here has one way to match, so the
 * match is read straight through: the head up to the type or the `=`, then the first `=` after a `:`, then the arrow.
 * The first `=` or `)` after a point and the arrow read from a given `=` or `)` are remembered, as many heads share them.
 */
class ConstArrowMatcher implements Matcher {
  lastIndex = 0
  private readonly eq = new NextOf('=')
  private readonly close = new NextOf(')')
  private tailAt = -1 // the `=` the arrow was last read from, and where that match ends (-1: none)
  private tailEnd = -1
  private closeAt = -1 // the `)` the arrow was last read from, and where that match ends (-1: none)
  private closeEnd = -1

  exec(text: string): RegExpExecArray | null {
    if (this.lastIndex === 0) {
      this.eq.reset()
      this.close.reset()
      this.tailAt = -1
      this.closeAt = -1
    }
    CONST_HEAD.lastIndex = this.lastIndex
    for (let h = CONST_HEAD.exec(text); h !== null; h = CONST_HEAD.exec(text)) {
      const e = h.index + h[0].length
      let q = -1
      if (text[e] === '=') q = e
      else if (text[e] === ':') {
        const n = this.eq.find(text, e + 1)
        if (n > e + 1) q = n
      }
      const end = q < 0 ? -1 : this.tail(text, q)
      if (end >= 0) {
        this.lastIndex = end
        return execResult(text, h.index, end, h[1])
      }
      CONST_HEAD.lastIndex = h.index + 1
    }
    this.lastIndex = 0
    return null
  }

  /** Where `=\s*(?:async\s+)?(?:\([^)]*\)|IDENT)\s*=>` read from the `=` at q ends, or -1. */
  private tail(text: string, q: number): number {
    if (q !== this.tailAt) {
      this.tailAt = q
      const r = nextSolid(text, q + 1, text.length)
      let end = -1
      if (text.startsWith('async', r) && WS.test(text.charAt(r + 5))) end = this.arrow(text, nextSolid(text, r + 5, text.length))
      this.tailEnd = end >= 0 ? end : this.arrow(text, r)
    }
    return this.tailEnd
  }

  /** Where `(?:\([^)]*\)|IDENT)\s*=>` read from r ends, or -1. */
  private arrow(text: string, r: number): number {
    if (text[r] === '(') {
      const p = this.close.find(text, r + 1)
      if (p < 0) return -1
      if (p !== this.closeAt) {
        this.closeAt = p
        const s = nextSolid(text, p + 1, text.length)
        this.closeEnd = text.startsWith('=>', s) ? s + 2 : -1
      }
      return this.closeEnd
    }
    IDENT_AT.lastIndex = r
    const m = IDENT_AT.exec(text)
    if (m === null) return -1
    const s = nextSolid(text, r + m[0].length, text.length)
    return text.startsWith('=>', s) ? s + 2 : -1
  }
}

// `^[ \t]+(?:MOD[ \t]+)*(?!KEYWORD\b)(NAME)\s*(?:<…>)?\([^{}]*\)\s*(?::\s*[^={;]{1,120})?\{`.
const TS_METHOD = new MethodMatcher(
  /^[ \t]+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)[ \t]+)*(?!(?:if|for|while|switch|catch|return|do|else|await|yield|typeof|delete|new|function|constructor|super|in|of|case|throw|try|with)\b)([A-Za-z_$][\w$]*)\s*(?:<[^>{}]{0,80}>)?\(/gm,
  returnTypeClause,
)

// `^[ \t]+(?:MOD[ \t]+)*TYPE\s+(NAME)\s*\([^{}]*\)\s*(?:where\s[^{]+)?\{`.
const CURLY_METHOD = new MethodMatcher(
  /^[ \t]+(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|sealed|unsafe|extern|new|partial|synchronized|default)[ \t]+)*(?:[A-Za-z_][\w.<>[\],?]*)\s+([A-Za-z_]\w*)\s*\(/gm,
  whereClause,
)

const JS_TS: LangRules = {
  lang: 'ts',
  block: 'brace',
  defs: [
    // `function`, then a star between optional spaces or at least one space: two optional runs of spaces around an
    // optional star split a long run of spaces every way before failing.
    { kind: 'function', re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*\s*|\s+)([A-Za-z_$][\w$]*)/gm },
    { kind: 'class', re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'interface', re: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'type', re: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm },
    { kind: 'enum', re: /^[ \t]*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'const', re: new ConstArrowMatcher() },
    // Class/object methods: an INDENTED `name(params) {` (optionally typed) that is not a
    // control-flow keyword — so `render() {}` / `async load(): Promise<void> {` are captured but
    // `if (x) {` / `for (…) {` are not. Indent requirement keeps top-level functions out.
    { kind: 'method', re: TS_METHOD },
  ],
  imports: [
    new JsImportMatcher(),
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
}

const PYTHON: LangRules = {
  lang: 'python',
  block: 'indent',
  defs: [
    { kind: 'function', re: /^[ \t]*def\s+([A-Za-z_]\w*)/gm },
    { kind: 'class', re: /^[ \t]*class\s+([A-Za-z_]\w*)/gm },
  ],
  imports: [/^[ \t]*from\s+([.\w]+)\s+import/gm, /^[ \t]*import\s+([.\w]+)/gm],
}

const GO: LangRules = {
  lang: 'go',
  block: 'brace',
  defs: [
    // The receiver closes within four lines: `[^)]*` ran from every `func (` to the next `)`, so thousands of unclosed
    // ones each read on to the end of the file (half a minute at 512 KB). A line is read by at most the four heads above.
    { kind: 'function', re: /^func\s+(?:\([^)\n]*(?:\n[^)\n]*){0,3}\)\s*)?([A-Za-z_]\w*)/gm },
    { kind: 'struct', re: /^type\s+([A-Za-z_]\w*)\s+struct\b/gm },
    { kind: 'interface', re: /^type\s+([A-Za-z_]\w*)\s+interface\b/gm },
  ],
  // `[ \t]*`, not `\s*`: from every line start of a run of blank lines, `\s*` ran to its end and back.
  imports: [/^[ \t]*"([^"]+)"/gm],
}

const RUST: LangRules = {
  lang: 'rust',
  block: 'brace',
  defs: [
    { kind: 'function', re: /^[ \t]*(?:pub(?:\([^)\n]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm },
    { kind: 'struct', re: /^[ \t]*(?:pub(?:\([^)\n]*\))?\s+)?struct\s+([A-Za-z_]\w*)/gm },
    { kind: 'enum', re: /^[ \t]*(?:pub(?:\([^)\n]*\))?\s+)?enum\s+([A-Za-z_]\w*)/gm },
    { kind: 'trait', re: /^[ \t]*(?:pub(?:\([^)\n]*\))?\s+)?trait\s+([A-Za-z_]\w*)/gm },
  ],
  imports: [/\buse\s+([A-Za-z_][\w:]*)/g],
}

// Java/C# share `[modifiers] ReturnType name(params) {` methods — the return type + name (two
// identifiers) requirement keeps calls/fields/control-flow out (constructors, which have no
// return type, are intentionally not captured).

const JAVA: LangRules = {
  lang: 'java',
  block: 'brace',
  defs: [
    // Modifiers are separated by spaces or tabs, here and in C# and Swift below, as in Kotlin: a `\s` alternative in
    // the modifier loop crossed newlines, so a run of blank lines was split every way before failing, and a declaration
    // after a blank line was reported at that blank line.
    { kind: 'class', re: /^[ \t]*(?:(?:public|private|protected|final|abstract|static)[ \t]+)*class\s+([A-Za-z_]\w*)/gm },
    { kind: 'interface', re: /^[ \t]*(?:(?:public|private|protected)[ \t]+)*interface\s+([A-Za-z_]\w*)/gm },
    { kind: 'enum', re: /^[ \t]*(?:(?:public|private|protected)[ \t]+)*enum\s+([A-Za-z_]\w*)/gm },
    { kind: 'method', re: CURLY_METHOD },
  ],
  imports: [/^[ \t]*import\s+(?:static\s+)?([\w.]+)/gm],
}

// Kotlin. `fun` covers free functions, methods and extension functions (`fun Foo.bar()`); objects
// (and companion objects with a name) are classes too. Modifiers and names are separated by spaces or tabs, never a
// newline, and annotations and the receiver are bounded, so a line is matched in time linear in its length: a `\s` in
// the modifier loop, or an unbounded receiver, made a run of blank or modifier-only lines, or one long line, quadratic.
const KOTLIN_MOD = '(?:(?:companion|public|private|protected|internal|open|final|abstract|sealed|data|enum|annotation|inner|value|inline|override|suspend|operator|infix|tailrec|external|expect|actual|fun)[ \\t]+)*'
const KOTLIN: LangRules = {
  lang: 'kotlin',
  block: 'brace',
  defs: [
    { kind: 'function', re: /^[ \t]*(?:@[\w.]+(?:\([^)\n]*\))?\s+){0,8}(?:(?:public|private|protected|internal|open|final|abstract|override|suspend|operator|infix|inline|tailrec|external|expect|actual)[ \t]+)*fun[ \t]+(?:<[^>\n]*>[ \t]*)?(?:[A-Za-z_][\w.<>?, ]{0,200}\.)?([A-Za-z_]\w*)[ \t]*\(/gm },
    { kind: 'class', re: new RegExp(`^[ \\t]*${KOTLIN_MOD}(?:class|object)[ \\t]+([A-Za-z_]\\w*)`, 'gm') },
    { kind: 'interface', re: new RegExp(`^[ \\t]*${KOTLIN_MOD}interface[ \\t]+([A-Za-z_]\\w*)`, 'gm') },
  ],
  imports: [/^[ \t]*import\s+([\w.]+)/gm],
}

// C# (.NET). Braces + typed signatures, so the paren-aware block detection applies.
const CSHARP: LangRules = {
  lang: 'csharp',
  block: 'brace',
  defs: [
    { kind: 'class', re: /^[ \t]*(?:(?:public|private|protected|internal|abstract|sealed|static|partial)[ \t]+)*class\s+([A-Za-z_]\w*)/gm },
    { kind: 'class', re: /^[ \t]*(?:(?:public|private|protected|internal|sealed)[ \t]+)*record\s+(?:class\s+|struct\s+)?([A-Za-z_]\w*)/gm },
    { kind: 'interface', re: /^[ \t]*(?:(?:public|private|protected|internal|partial)[ \t]+)*interface\s+([A-Za-z_]\w*)/gm },
    { kind: 'struct', re: /^[ \t]*(?:(?:public|private|protected|internal|readonly|ref)[ \t]+)*struct\s+([A-Za-z_]\w*)/gm },
    { kind: 'enum', re: /^[ \t]*(?:(?:public|private|protected|internal)[ \t]+)*enum\s+([A-Za-z_]\w*)/gm },
    { kind: 'method', re: CURLY_METHOD },
  ],
  imports: [/^[ \t]*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm],
}

// Swift — `func` covers BOTH free functions and methods (like Python/Ruby/Go/Rust), so it's
// deep without a separate method rule. Protocols map to interfaces.
const SWIFT: LangRules = {
  lang: 'swift',
  block: 'brace',
  defs: [
    // Up to eight attributes (each may end its own line), then modifiers separated by spaces or tabs.
    { kind: 'function', re: /^[ \t]*(?:@[\w()]+\s+){0,8}(?:(?:public|private|internal|fileprivate|open|static|final|override|class|mutating|nonmutating)[ \t]+)*func\s+([A-Za-z_]\w*)/gm },
    { kind: 'class', re: /^[ \t]*(?:(?:public|private|internal|fileprivate|open|final)[ \t]+)*class\s+(?!func\b)([A-Za-z_]\w*)/gm },
    { kind: 'struct', re: /^[ \t]*(?:(?:public|private|internal|fileprivate)[ \t]+)*struct\s+([A-Za-z_]\w*)/gm },
    { kind: 'enum', re: /^[ \t]*(?:(?:public|private|internal|indirect)[ \t]+)*enum\s+([A-Za-z_]\w*)/gm },
    { kind: 'interface', re: /^[ \t]*(?:(?:public|private|internal)[ \t]+)*protocol\s+([A-Za-z_]\w*)/gm },
  ],
  imports: [/^[ \t]*import\s+([A-Za-z_]\w*)/gm],
}

// Bicep (Azure IaC). Brace blocks (`= { … }`). Like Terraform, dependencies are symbolic
// dot-paths, not calls — SURFACE level: symbol discovery (resource/param/var/output/module).
const BICEP: LangRules = {
  lang: 'bicep',
  block: 'brace',
  defs: [
    { kind: 'resource', re: /^[ \t]*resource\s+([A-Za-z_]\w*)\s+'/gm },
    { kind: 'module', re: /^[ \t]*module\s+([A-Za-z_]\w*)\s+'/gm },
    { kind: 'variable', re: /^[ \t]*param\s+([A-Za-z_]\w*)/gm },
    { kind: 'variable', re: /^[ \t]*var\s+([A-Za-z_]\w*)\s*=/gm },
    { kind: 'variable', re: /^[ \t]*output\s+([A-Za-z_]\w*)/gm },
    { kind: 'type', re: /^[ \t]*type\s+([A-Za-z_]\w*)\s*=/gm },
  ],
  imports: [],
}

// Ruby. Keyword-delimited (def/class/module … end); Ruby is conventionally indented and `end`
// sits at the opener's indent, so the indent block heuristic captures the body well enough.
const RUBY: LangRules = {
  lang: 'ruby',
  block: 'indent',
  defs: [
    { kind: 'function', re: /^[ \t]*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/gm },
    { kind: 'class', re: /^[ \t]*class\s+([A-Za-z_]\w*)/gm },
    { kind: 'module', re: /^[ \t]*module\s+([A-Za-z_]\w*)/gm },
  ],
  imports: [/^[ \t]*require(?:_relative)?\s+['"]([^'"]+)['"]/gm],
}

// Terraform / OpenTofu (HCL). Brace blocks. NOTE: HCL dependencies are dot-paths
// (aws_instance.web.id), not `name()` calls, so the reference/edge model is thin here — the
// value is symbol discovery (resources/variables/outputs/modules) via search + explore.
const TERRAFORM: LangRules = {
  lang: 'terraform',
  block: 'brace',
  defs: [
    { kind: 'resource', re: /^[ \t]*resource\s+"[^"]+"\s+"([^"]+)"/gm },
    { kind: 'resource', re: /^[ \t]*data\s+"[^"]+"\s+"([^"]+)"/gm },
    { kind: 'variable', re: /^[ \t]*variable\s+"([^"]+)"/gm },
    { kind: 'variable', re: /^[ \t]*output\s+"([^"]+)"/gm },
    { kind: 'module', re: /^[ \t]*module\s+"([^"]+)"/gm },
  ],
  imports: [],
}

const BY_EXT: Array<{ ext: RegExp; rules: LangRules }> = [
  { ext: /\.(ts|tsx|js|jsx|mjs|cjs)$/i, rules: JS_TS },
  { ext: /\.py$/i, rules: PYTHON },
  { ext: /\.go$/i, rules: GO },
  { ext: /\.rs$/i, rules: RUST },
  { ext: /\.java$/i, rules: JAVA },
  { ext: /\.kt$/i, rules: KOTLIN },
  { ext: /\.(cs|csx)$/i, rules: CSHARP },
  { ext: /\.rb$/i, rules: RUBY },
  { ext: /\.tf$/i, rules: TERRAFORM },
  { ext: /\.swift$/i, rules: SWIFT },
  { ext: /\.bicep$/i, rules: BICEP },
]

function rulesForFile(file: string): LangRules | null {
  const m = BY_EXT.find((e) => e.ext.test(file))
  return m ? m.rules : null
}

/** The language id for a file path, or null if we have no rules for it. */
export function languageForFile(file: string): string | null {
  return rulesForFile(file)?.lang ?? null
}

// Words that appear as `word(` but are control-flow / keywords / builtins, not references.
const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'typeof', 'new', 'delete', 'void', 'do',
  'with', 'yield', 'super', 'constructor', 'throw', 'case', 'instanceof', 'async', 'import', 'export', 'print',
  'range', 'def', 'class', 'fn', 'func', 'match', 'use', 'type', 'interface', 'enum', 'struct', 'trait', 'and', 'or',
  'not', 'in', 'is', 'elif', 'else', 'try', 'except', 'finally', 'assert', 'lambda', 'require',
  // C#/Java/Swift/Ruby/HCL keywords + common non-call builtins that appear as `name(`
  'using', 'namespace', 'lock', 'fixed', 'unless', 'until', 'when', 'begin', 'rescue', 'ensure', 'yield', 'raise',
  'puts', 'guard', 'defer', 'repeat', 'where', 'var', 'let', 'val', 'foreach', 'select', 'from', 'resource', 'variable',
  'output', 'module', 'data', 'provider', 'param', 'protocol', 'extension', 'init', 'deinit', 'subscript', 'get', 'set',
])

/** Where each line of `content` starts, so a match's line is a binary search, not a count from the top per symbol. */
function lineStarts(content: string): number[] {
  const starts = [0]
  for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** The 1-based line holding `index`: how many lines start at or before it. */
function lineOfIndex(starts: readonly number[], index: number): number {
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid] <= index) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * How many characters the block scans of one file may read in all, as a multiple of its length. A scan that reaches a
 * line start with nothing open goes on as one from that line would, so it takes that line's answer when one is known
 * and that stretch is read once in all (`BlockScan.from`). What is left is each symbol reading its own body, a few times
 * the file for ordinary nesting. Thousands of blocks that never close, nest deeper and deeper or sit inside a `(` that
 * never closes made every scan read to the end of the file (50k characters of `  a() {` lines took 0.7 s, and the
 * 512 KB a world reads over a minute), so past this budget a scan is taken to reach the end of the file at once.
 */
const BLOCK_SCAN_FACTOR = 16
const BLOCK_SCAN_MIN = 1 << 16
/** `BlockScan.from` for a line whose scan finds no multi-line block, so the symbol ends on its own line. */
const NO_BLOCK = -1

/** What the block scans of one file share. */
interface BlockScan {
  /** Characters they may still read. */
  left: number
  /** Line index → the answer of a brace scan that starts there with nothing open (1-based line, or NO_BLOCK). */
  from: Map<number, number>
}

// Best-effort last line (1-based) of the block a symbol on `startLine` opens.
function blockEnd(lines: string[], startLine: number, block: 'brace' | 'indent', scan: BlockScan): number {
  const startIdx = startLine - 1
  if (startIdx < 0 || startIdx >= lines.length) return startLine
  if (block === 'indent') {
    const baseIndent = (lines[startIdx].match(/^[ \t]*/) as RegExpMatchArray)[0].length
    let lastContent = startLine // the def line itself, if the body is empty
    for (let i = startIdx + 1; i < lines.length; i++) {
      scan.left -= lines[i].length + 1
      if (scan.left < 0) return lastContent
      if (lines[i].trim() === '') continue
      const indent = (lines[i].match(/^[ \t]*/) as RegExpMatchArray)[0].length
      if (indent <= baseIndent) return lastContent // dedented → block ended at the last content line
      lastContent = i + 1 // 1-based line of this in-block content line
    }
    return lastContent
  }
  // Body detection that survives typed signatures (a real-repo bug the unit snippets missed):
  //  - braces INSIDE the parameter parens (`(o: { x: number })`) are skipped (paren depth > 0),
  //    which covers multi-line signatures where the object type sits on a continuation line;
  //  - a paren-depth-0 brace block that opens AND closes on the SAME line is a type annotation
  //    (a `): { ok: boolean }` return type), not the body — the real body is the first
  //    paren-depth-0 block that spans a newline.
  let paren = 0
  let depth = 0
  let openLine = -1
  const clear: number[] = [] // line starts this scan passed with nothing open: they share its answer
  const settle = (end: number): number => {
    for (const i of clear) scan.from.set(i, end)
    return end === NO_BLOCK ? startLine : end
  }
  for (let i = startIdx; i < lines.length; i++) {
    if (paren === 0 && depth === 0) {
      const known = scan.from.get(i)
      if (known !== undefined) return settle(known)
      clear.push(i)
    }
    const line = lines[i]
    scan.left -= line.length + 1
    if (scan.left < 0) return depth > 0 ? lines.length : startLine
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      if (ch === '(') paren++
      else if (ch === ')') { if (paren > 0) paren-- }
      else if (paren === 0 && ch === '{') { if (depth === 0) openLine = i; depth++ }
      else if (paren === 0 && ch === '}' && depth > 0) {
        depth--
        if (depth === 0) {
          if (i > openLine) return settle(i + 1) // opened on an earlier line → the real (multi-line) body
          openLine = -1 // same-line {} → an annotation; keep scanning for the body
        }
      }
    }
  }
  return settle(depth > 0 ? lines.length : NO_BLOCK) // unterminated body → EOF; no multi-line block → single line
}

/** Extract the structure of one source file. Returns null for an unsupported extension or
 *  empty content. Pure — no fs, no clock, no state. */
export function extractFile(file: string, content: string): FileExtract | null {
  const rules = rulesForFile(file)
  if (!rules || !content) return null
  // A byte-order mark (Visual Studio writes one) is no part of line 1: the rules' `^[ \t]*` would not reach past it.
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
  const lines = content.split('\n')
  const starts = lineStarts(content)
  const scan: BlockScan = { left: BLOCK_SCAN_FACTOR * content.length + BLOCK_SCAN_MIN, from: new Map() }

  const symbols: CodeSymbol[] = []
  const seenDef = new Set<string>()
  for (const rule of rules.defs) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(content)) !== null) {
      const name = m[1]
      if (!name) continue
      const startLine = lineOfIndex(starts, m.index)
      const key = `${name}@${startLine}`
      if (seenDef.has(key)) continue // a name matched by two rules on the same line → keep the first
      seenDef.add(key)
      symbols.push({ name, kind: rule.kind, file, startLine, endLine: blockEnd(lines, startLine, rules.block, scan), lang: rules.lang })
    }
  }
  symbols.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))

  const imports: string[] = []
  const seenImp = new Set<string>()
  for (const re of rules.imports) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const spec = m[1]
      if (spec && !seenImp.has(spec)) {
        seenImp.add(spec)
        imports.push(spec)
      }
    }
  }

  return { file, lang: rules.lang, symbols, imports, references: extractReferences(content) }
}

/** Callable names referenced in `text` (a name immediately followed by `(`), de-duplicated in
 *  first-seen order, with control-flow keywords/builtins filtered out. Reused by the graph
 *  layer to attribute calls to the enclosing symbol (scan its body slice). Pure. */
export function extractReferences(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // Each run of word characters is read once, and the name is its part from the first non-digit: what
  // /([A-Za-z_$][\w$]*)\s*\(/g finds, without that regex retrying a long run from every one of its characters.
  const runs = /[\w$]+/g
  for (let m = runs.exec(text); m !== null; m = runs.exec(text)) {
    let j = runs.lastIndex
    while (j < text.length && /\s/.test(text[j])) j++
    if (text[j] !== '(') continue
    const from = m[0].search(/[A-Za-z_$]/)
    if (from < 0) continue
    const name = m[0].slice(from)
    if (CALL_KEYWORDS.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

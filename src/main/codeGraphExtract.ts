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

export interface CodeSymbol {
  name: string
  kind: SymbolKind
  file: string
  startLine: number // 1-based
  endLine: number // 1-based, best-effort (brace/indent matched)
  lang: string
}

export interface FileExtract {
  file: string
  lang: string
  symbols: CodeSymbol[]
  imports: string[] // module specifiers, de-duplicated, first-seen order
  references: string[] // callable names referenced (name followed by '('), de-duplicated
}

interface DefRule {
  kind: SymbolKind
  re: RegExp // global + multiline; capture group 1 = the symbol name
}
interface LangRules {
  lang: string
  block: 'brace' | 'indent'
  defs: DefRule[]
  imports: RegExp[] // global; capture group 1 = the imported specifier
}

const JS_TS: LangRules = {
  lang: 'ts',
  block: 'brace',
  defs: [
    { kind: 'function', re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm },
    { kind: 'class', re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'interface', re: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'type', re: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm },
    { kind: 'enum', re: /^[ \t]*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'const', re: /^[ \t]*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm },
  ],
  imports: [
    /import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g,
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
    { kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
    { kind: 'struct', re: /^type\s+([A-Za-z_]\w*)\s+struct\b/gm },
    { kind: 'interface', re: /^type\s+([A-Za-z_]\w*)\s+interface\b/gm },
  ],
  imports: [/^\s*"([^"]+)"/gm],
}

const RUST: LangRules = {
  lang: 'rust',
  block: 'brace',
  defs: [
    { kind: 'function', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm },
    { kind: 'struct', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/gm },
    { kind: 'enum', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/gm },
    { kind: 'trait', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/gm },
  ],
  imports: [/\buse\s+([A-Za-z_][\w:]*)/g],
}

const JAVA: LangRules = {
  lang: 'java',
  block: 'brace',
  defs: [
    { kind: 'class', re: /^[ \t]*(?:public|private|protected|final|abstract|static|\s)*class\s+([A-Za-z_]\w*)/gm },
    { kind: 'interface', re: /^[ \t]*(?:public|private|protected|\s)*interface\s+([A-Za-z_]\w*)/gm },
    { kind: 'enum', re: /^[ \t]*(?:public|private|protected|\s)*enum\s+([A-Za-z_]\w*)/gm },
  ],
  imports: [/^[ \t]*import\s+(?:static\s+)?([\w.]+)/gm],
}

const BY_EXT: Array<{ ext: RegExp; rules: LangRules }> = [
  { ext: /\.(ts|tsx|js|jsx|mjs|cjs)$/i, rules: JS_TS },
  { ext: /\.py$/i, rules: PYTHON },
  { ext: /\.go$/i, rules: GO },
  { ext: /\.rs$/i, rules: RUST },
  { ext: /\.java$/i, rules: JAVA },
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
])

function lineOfIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++
  return line
}

// Best-effort last line (1-based) of the block a symbol on `startLine` opens.
function blockEnd(lines: string[], startLine: number, block: 'brace' | 'indent'): number {
  const startIdx = startLine - 1
  if (startIdx < 0 || startIdx >= lines.length) return startLine
  if (block === 'indent') {
    const baseIndent = (lines[startIdx].match(/^[ \t]*/) as RegExpMatchArray)[0].length
    let lastContent = startLine // the def line itself, if the body is empty
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue
      const indent = (lines[i].match(/^[ \t]*/) as RegExpMatchArray)[0].length
      if (indent <= baseIndent) return lastContent // dedented → block ended at the last content line
      lastContent = i + 1 // 1-based line of this in-block content line
    }
    return lastContent
  }
  let depth = 0
  let seen = false
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++
        seen = true
      } else if (ch === '}') {
        depth--
        if (seen && depth === 0) return i + 1
      }
    }
  }
  return seen ? lines.length : Math.min(startLine, lines.length) // unterminated block → EOF; no block → single line
}

/** Extract the structure of one source file. Returns null for an unsupported extension or
 *  empty content. Pure — no fs, no clock, no state. */
export function extractFile(file: string, content: string): FileExtract | null {
  const rules = rulesForFile(file)
  if (!rules || !content) return null
  const lines = content.split('\n')

  const symbols: CodeSymbol[] = []
  const seenDef = new Set<string>()
  for (const rule of rules.defs) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(content)) !== null) {
      const name = m[1]
      if (!name) continue
      const startLine = lineOfIndex(content, m.index)
      const key = `${name}@${startLine}`
      if (seenDef.has(key)) continue // a name matched by two rules on the same line → keep the first
      seenDef.add(key)
      symbols.push({ name, kind: rule.kind, file, startLine, endLine: blockEnd(lines, startLine, rules.block), lang: rules.lang })
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

  const references: string[] = []
  const seenRef = new Set<string>()
  const callRe = /([A-Za-z_$][\w$]*)\s*\(/g
  let cm: RegExpExecArray | null
  while ((cm = callRe.exec(content)) !== null) {
    const name = cm[1]
    if (CALL_KEYWORDS.has(name) || seenRef.has(name)) continue
    seenRef.add(name)
    references.push(name)
  }

  return { file, lang: rules.lang, symbols, imports, references }
}

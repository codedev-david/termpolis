// codeGraphTreeSitter.ts — AST-precise symbol + call extraction via web-tree-sitter, producing the
// same FileExtract shape as the heuristic codeGraphExtract so it drops straight into the graph.
//
// Why it's more precise than the regex heuristic:
//  - Symbol boundaries come from the parse tree (exact start/end), not brace/indent guessing.
//  - Per-symbol `refs` are the REAL call sites inside that symbol's node — strings and comments are
//    distinct node types, so `save` inside a string/comment is never counted as a call.
//  - Member calls (`u.save()`) and free calls (`save()`) are separate captures, so we can bias
//    resolution correctly instead of linking a call to every same-named symbol.
//
// Unsupported languages (or a missing/failed grammar) return null → the caller falls back to the
// heuristic extractor. The graph degrades, never breaks.

import type Parser from 'web-tree-sitter'
import { loadGrammar, newParser, grammarAvailable } from './tsGrammars'
import type { FileExtract, CodeSymbol, SymbolKind } from './codeGraphExtract'

interface LangConfig {
  lang: string // friendly label stored on symbols
  grammar: string // grammar wasm name (tree-sitter-<grammar>.wasm)
  decl: string // query: each pattern captures @name + one kind-tagged capture spanning the decl
  call: string // query: each @call capture is a called name
}

// A kind-tagged capture name in a decl query maps 1:1 to a SymbolKind.
const KINDS: SymbolKind[] = ['function', 'class', 'interface', 'type', 'const', 'enum', 'struct', 'trait', 'module', 'method']
function kindOf(capture: string): SymbolKind | null {
  return (KINDS as string[]).includes(capture) ? (capture as SymbolKind) : null
}

const TS_DECL = `
(function_declaration name: (identifier) @name) @function
(method_definition name: (property_identifier) @name) @method
(class_declaration name: (type_identifier) @name) @class
(interface_declaration name: (type_identifier) @name) @interface
(type_alias_declaration name: (type_identifier) @name) @type
(enum_declaration name: (identifier) @name) @enum
(variable_declarator name: (identifier) @name value: (arrow_function)) @function
(variable_declarator name: (identifier) @name value: (function_expression)) @function
`
const JS_DECL = `
(function_declaration name: (identifier) @name) @function
(method_definition name: (property_identifier) @name) @method
(class_declaration name: (identifier) @name) @class
(variable_declarator name: (identifier) @name value: (arrow_function)) @function
(variable_declarator name: (identifier) @name value: (function_expression)) @function
`
const JS_CALL = `
(call_expression function: (identifier) @call)
(call_expression function: (member_expression property: (property_identifier) @call))
(new_expression constructor: (identifier) @call)
`

const CONFIGS: Record<string, LangConfig> = {
  typescript: { lang: 'typescript', grammar: 'typescript', decl: TS_DECL, call: JS_CALL },
  tsx: { lang: 'tsx', grammar: 'tsx', decl: TS_DECL, call: JS_CALL },
  javascript: { lang: 'javascript', grammar: 'javascript', decl: JS_DECL, call: JS_CALL },
  python: {
    lang: 'python',
    grammar: 'python',
    decl: `
      (function_definition name: (identifier) @name) @function
      (class_definition name: (identifier) @name) @class
    `,
    call: `
      (call function: (identifier) @call)
      (call function: (attribute attribute: (identifier) @call))
    `,
  },
  go: {
    lang: 'go',
    grammar: 'go',
    decl: `
      (function_declaration name: (identifier) @name) @function
      (method_declaration name: (field_identifier) @name) @method
      (type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @struct
      (type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @interface
    `,
    call: `
      (call_expression function: (identifier) @call)
      (call_expression function: (selector_expression field: (field_identifier) @call))
    `,
  },
  rust: {
    lang: 'rust',
    grammar: 'rust',
    decl: `
      (function_item name: (identifier) @name) @function
      (struct_item name: (type_identifier) @name) @struct
      (enum_item name: (type_identifier) @name) @enum
      (trait_item name: (type_identifier) @name) @trait
    `,
    call: `
      (call_expression function: (identifier) @call)
      (call_expression function: (field_expression field: (field_identifier) @call))
      (call_expression function: (scoped_identifier name: (identifier) @call))
    `,
  },
  java: {
    lang: 'java',
    grammar: 'java',
    decl: `
      (method_declaration name: (identifier) @name) @method
      (constructor_declaration name: (identifier) @name) @method
      (class_declaration name: (identifier) @name) @class
      (interface_declaration name: (identifier) @name) @interface
      (enum_declaration name: (identifier) @name) @enum
    `,
    call: `
      (method_invocation name: (identifier) @call)
      (object_creation_expression type: (type_identifier) @call)
    `,
  },
  c_sharp: {
    lang: 'csharp',
    grammar: 'c_sharp',
    decl: `
      (method_declaration name: (identifier) @name) @method
      (constructor_declaration name: (identifier) @name) @method
      (class_declaration name: (identifier) @name) @class
      (interface_declaration name: (identifier) @name) @interface
      (struct_declaration name: (identifier) @name) @struct
      (enum_declaration name: (identifier) @name) @enum
    `,
    call: `
      (invocation_expression function: (identifier) @call)
      (invocation_expression function: (member_access_expression name: (identifier) @call))
      (object_creation_expression type: (identifier) @call)
    `,
  },
  ruby: {
    lang: 'ruby',
    grammar: 'ruby',
    decl: `
      (method name: (identifier) @name) @method
      (singleton_method name: (identifier) @name) @method
      (class name: (constant) @name) @class
      (module name: (constant) @name) @module
    `,
    call: `
      (call method: (identifier) @call)
    `,
  },
  swift: {
    lang: 'swift',
    grammar: 'swift',
    decl: `
      (function_declaration name: (simple_identifier) @name) @function
      (class_declaration name: (type_identifier) @name) @class
      (protocol_declaration name: (type_identifier) @name) @interface
    `,
    call: `
      (call_expression (simple_identifier) @call)
      (call_expression (navigation_expression (navigation_suffix (simple_identifier) @call)))
    `,
  },
}

const EXT_TO_GRAMMAR: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'c_sharp', '.csx': 'c_sharp',
  '.rb': 'ruby',
  '.swift': 'swift',
}

function grammarForFile(file: string): string | null {
  const dot = file.lastIndexOf('.')
  if (dot < 0) return null
  return EXT_TO_GRAMMAR[file.slice(dot).toLowerCase()] ?? null
}

/** True if this file's language is handled by the AST extractor AND its grammar is on disk. */
export function treeSitterSupports(file: string): boolean {
  const g = grammarForFile(file)
  return !!g && grammarAvailable(g)
}

interface Call {
  name: string
  byte: number
}

// A parser + its compiled queries, built ONCE per grammar and reused. web-tree-sitter objects live
// in WASM linear memory and must be reused (not re-created per call) or the heap fills and aborts the
// process. Only the per-parse Tree is short-lived and is deleted after each extraction. Kept on
// globalThis so a per-file module re-import (test runner) doesn't rebuild — and leak — them.
interface Compiled {
  parser: Parser
  declQ: Parser.Query
  callQ: Parser.Query
}
const CG = globalThis as unknown as { __termpolisTSCompiled?: Map<string, Compiled | null> }
function compiledCache(): Map<string, Compiled | null> {
  return (CG.__termpolisTSCompiled ??= new Map())
}

async function getCompiled(grammar: string, cfg: LangConfig): Promise<Compiled | null> {
  const cache = compiledCache()
  if (cache.has(grammar)) return cache.get(grammar) ?? null
  const lang = await loadGrammar(grammar)
  if (!lang) {
    cache.set(grammar, null)
    return null
  }
  try {
    const parser = newParser()
    parser.setLanguage(lang)
    const compiled: Compiled = { parser, declQ: lang.query(cfg.decl), callQ: lang.query(cfg.call) }
    cache.set(grammar, compiled)
    return compiled
  } catch {
    cache.set(grammar, null) // a query that doesn't compile against this grammar → fall back
    return null
  }
}

/** AST-precise extraction. Returns null for unsupported languages or when the grammar can't load
 *  (→ heuristic fallback), or when the parse produces nothing usable. */
export async function extractFileTS(file: string, content: string): Promise<FileExtract | null> {
  const grammar = grammarForFile(file)
  if (!grammar) return null
  const cfg = CONFIGS[grammar]
  if (!cfg) return null
  const compiled = await getCompiled(grammar, cfg)
  if (!compiled) return null

  let tree
  try {
    tree = compiled.parser.parse(content)
  } catch {
    return null
  }
  if (!tree?.rootNode) {
    tree?.delete()
    return null
  }

  try {
    // Gather call sites once, then attribute to enclosing symbols by byte range.
    const calls: Call[] = []
    const references: string[] = []
    const seenRef = new Set<string>()
    for (const cap of compiled.callQ.captures(tree.rootNode)) {
      const name = cap.node.text
      if (!name) continue
      calls.push({ name, byte: cap.node.startIndex })
      if (!seenRef.has(name)) { seenRef.add(name); references.push(name) }
    }

    const symbols: CodeSymbol[] = []
    for (const match of compiled.declQ.matches(tree.rootNode)) {
      const nameCap = match.captures.find((c) => c.name === 'name')
      const kindCap = match.captures.find((c) => c.name !== 'name')
      if (!nameCap || !kindCap) continue
      const kind = kindOf(kindCap.name)
      if (!kind) continue
      const rangeNode = kindCap.node
      const startByte = rangeNode.startIndex
      const endByte = rangeNode.endIndex
      const refs = calls.filter((c) => c.byte >= startByte && c.byte < endByte).map((c) => c.name)
      symbols.push({
        name: nameCap.node.text,
        kind,
        file,
        startLine: rangeNode.startPosition.row + 1,
        endLine: rangeNode.endPosition.row + 1,
        lang: cfg.lang,
        refs,
      })
    }

    return { file, lang: cfg.lang, symbols, imports: [], references }
  } finally {
    tree.delete() // free the WASM tree — the parser + queries are cached and reused
  }
}

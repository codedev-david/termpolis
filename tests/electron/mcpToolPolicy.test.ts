// The permission policy for Termpolis's own MCP tools, checked against what the server really
// advertises.
//
// Every tool in mcpServer.ts's TOOLS table must be classified exactly once: Claude Code may
// run it without asking (MCP_TOOLS_AUTO_ALLOWED) or it keeps asking (MCP_TOOLS_ASK). A new
// tool in neither list is a tool nobody decided about, and an entry the server no longer
// advertises is an allow rule that silently matches nothing.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'
import {
  CODEX_AUTO_APPROVED_TOOLS,
  MCP_TOOLS_ASK,
  MCP_TOOLS_AUTO_ALLOWED,
} from '../../src/shared/agentIntegration'

const SERVER_FILE = join(__dirname, '..', '..', 'src', 'main', 'mcpServer.ts')

/**
 * The `name` of every entry in mcpServer.ts's TOOLS array. TOOLS is module-private, so it is
 * read from the source with the TypeScript parser rather than a regex. Anything this cannot
 * read with certainty throws instead of guessing: a silently short list would make every
 * assertion below pass for the wrong reason.
 */
function advertisedToolNames(): string[] {
  const text = readFileSync(SERVER_FILE, 'utf8')
  const source = ts.createSourceFile(SERVER_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const unreadable = (why: string): Error =>
    new Error(`mcpServer.ts: ${why}. The TOOLS table changed shape; teach mcpToolPolicy.test.ts to read it.`)

  const declarations: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'TOOLS') {
      declarations.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (declarations.length !== 1) throw unreadable(`expected one TOOLS declaration, found ${declarations.length}`)

  let init = declarations[0].initializer
  while (
    init &&
    (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) ||
      ts.isParenthesizedExpression(init) || ts.isTypeAssertionExpression(init))
  ) {
    init = init.expression
  }
  if (!init || !ts.isArrayLiteralExpression(init)) throw unreadable('TOOLS is not an array literal')

  return init.elements.map((element, i) => {
    if (!ts.isObjectLiteralExpression(element)) throw unreadable(`TOOLS[${i}] is not an object literal`)
    const nameProps = element.properties.filter(
      (p) => p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'name',
    )
    if (nameProps.length !== 1) throw unreadable(`TOOLS[${i}] has ${nameProps.length} name properties`)
    const prop = nameProps[0]
    if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteralLike(prop.initializer)) {
      throw unreadable(`TOOLS[${i}].name is not a string literal`)
    }
    return prop.initializer.text
  })
}

/** The tools the brief for this policy names: they run commands, type into, open, close or
 *  read other terminals, list files, or call through to other MCP servers. */
const NEVER_AUTO_ALLOWED = [
  'run_command', 'run_and_wait', 'write_to_terminal', 'create_terminal', 'close_terminal',
  'read_output', 'get_file_tree', 'gateway_call',
]

/** A tool outside Termpolis's own memory whose name says it acts, or that goes through the
 *  gateway to another MCP server. Catches the next such tool before anyone classifies it. */
function soundsLikeItActs(tool: string): boolean {
  if (tool.startsWith('memory_')) return false
  return /^gateway_/.test(tool) ||
    /(^|_)(run|exec|execute|write|create|close|kill|stop|start|spawn|send|update|delete|remove|set|move|rename|install)(_|$)/.test(tool)
}

describe('MCP tool permission policy', () => {
  let advertised: string[]

  beforeAll(() => {
    advertised = advertisedToolNames()
  })

  it('advertises each tool once, under a well-formed name', () => {
    // Also proves the reader found the real table, not an empty or partial one.
    expect(advertised).toEqual(expect.arrayContaining(['list_terminals', 'run_command', 'memory_search']))
    expect(new Set(advertised).size).toBe(advertised.length)
    for (const tool of advertised) expect(tool, tool).toMatch(/^[a-z][a-z0-9_]*[a-z0-9]$/)
  })

  it('puts every advertised tool in exactly one of MCP_TOOLS_AUTO_ALLOWED and MCP_TOOLS_ASK', () => {
    const unclassified = advertised.filter((t) => !MCP_TOOLS_AUTO_ALLOWED.includes(t) && !MCP_TOOLS_ASK.includes(t))
    const inBoth = advertised.filter((t) => MCP_TOOLS_AUTO_ALLOWED.includes(t) && MCP_TOOLS_ASK.includes(t))
    expect(unclassified, 'advertised by mcpServer.ts but in neither list: add each to one of them').toEqual([])
    expect(inBoth, 'in both lists').toEqual([])
    expect(MCP_TOOLS_AUTO_ALLOWED.length + MCP_TOOLS_ASK.length).toBe(advertised.length)
  })

  it('names no tool the server does not advertise', () => {
    const missing = (list: readonly string[]): string[] => list.filter((t) => !advertised.includes(t))
    expect(missing(MCP_TOOLS_AUTO_ALLOWED), 'MCP_TOOLS_AUTO_ALLOWED').toEqual([])
    expect(missing(MCP_TOOLS_ASK), 'MCP_TOOLS_ASK').toEqual([])
    expect(missing(CODEX_AUTO_APPROVED_TOOLS), 'CODEX_AUTO_APPROVED_TOOLS').toEqual([])
  })

  it('never auto-allows a tool that runs commands, drives other terminals, lists files or calls other servers', () => {
    expect(MCP_TOOLS_AUTO_ALLOWED.filter((t) => NEVER_AUTO_ALLOWED.includes(t))).toEqual([])
    for (const tool of NEVER_AUTO_ALLOWED.filter((t) => advertised.includes(t))) {
      expect(MCP_TOOLS_ASK, `${tool} must ask first`).toContain(tool)
    }
  })

  it('never auto-allows a non-memory tool whose name says it acts or reaches the gateway', () => {
    // The name check is not vacuous: it flags tools that act or call out, and spares
    // read-only tools and Termpolis's own memory writes.
    for (const t of ['run_command', 'write_to_terminal', 'create_terminal', 'gateway_call', 'gateway_list_tools',
      'swarm_send_message', 'swarm_create_task', 'swarm_update_task', 'kill_process', 'delete_file']) {
      expect(soundsLikeItActs(t), t).toBe(true)
    }
    for (const t of ['memory_write', 'memory_correct', 'list_terminals', 'code_search', 'swarm_read_messages',
      'get_git_status', 'retrieve_full', 'test_coverage']) {
      expect(soundsLikeItActs(t), t).toBe(false)
    }
    expect(MCP_TOOLS_AUTO_ALLOWED.filter(soundsLikeItActs)).toEqual([])
    expect(advertised.filter(soundsLikeItActs).filter((t) => !MCP_TOOLS_ASK.includes(t))).toEqual([])
  })
})

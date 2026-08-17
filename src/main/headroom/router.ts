export type Route = 'exempt' | 'array' | 'object'

export const EXEMPT_TOOLS: readonly string[] = [
  'list_terminals', 'create_terminal', 'run_command', 'close_terminal', 'write_to_terminal',
  'retrieve_full',
]

/**
 * Strip the MCP namespace from a tool name.
 *
 * The MCP layer sees bare names (`memory_write`); the Anthropic wire sees the namespaced form
 * the client sends (`mcp__termpolis__memory_write`). Both layers consult isExempt, so without
 * this the exemption silently applied to only one of them and the proxy compressed recalled
 * memory on its way back to the model.
 *
 * Server names may themselves contain underscores (`mcp__claude_ai_Gmail__get_message`), so the
 * split is on the LAST separator, not the first.
 */
export function bareToolName(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const i = tool.lastIndexOf('__')
  return i > 3 ? tool.slice(i + 2) : tool
}

export function isExempt(tool: string): boolean {
  // Never touch memory/learning or swarm coordination surfaces, or control acks.
  const t = bareToolName(tool)
  return t.startsWith('memory_') || t.startsWith('swarm_') || EXEMPT_TOOLS.includes(t)
}

export function route(tool: string, result: unknown): Route {
  if (isExempt(tool)) return 'exempt'
  if (Array.isArray(result)) return 'array'
  if (result !== null && typeof result === 'object') return 'object'
  return 'exempt'
}

export type Route = 'exempt' | 'array' | 'object'

export const EXEMPT_TOOLS: readonly string[] = [
  'list_terminals', 'create_terminal', 'run_command', 'close_terminal', 'write_to_terminal',
  'retrieve_full',
]

export function isExempt(tool: string): boolean {
  // Never touch memory/learning or swarm coordination surfaces, or control acks.
  return tool.startsWith('memory_') || tool.startsWith('swarm_') || EXEMPT_TOOLS.includes(tool)
}

export function route(tool: string, result: unknown): Route {
  if (isExempt(tool)) return 'exempt'
  if (Array.isArray(result)) return 'array'
  if (result !== null && typeof result === 'object') return 'object'
  return 'exempt'
}

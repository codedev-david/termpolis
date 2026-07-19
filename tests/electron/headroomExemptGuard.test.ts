import { describe, it, expect } from 'vitest'
const { route } = await import('../../src/main/headroom/router')

// The full set of tool names the MCP server dispatches that must NEVER be compressed.
// This guard fails the build if any memory/swarm/control tool becomes compressible.
const MUST_EXEMPT = [
  'memory_write', 'memory_search', 'memory_list', 'memory_primer', 'memory_related', 'memory_audit',
  'memory_link', 'memory_graph', 'memory_feedback', 'memory_selfcheck', 'memory_pool',
  'memory_anticipate', 'memory_conflicts',
  'swarm_send_message', 'swarm_read_messages', 'swarm_create_task', 'swarm_list_tasks',
  'swarm_update_task', 'swarm_list_agents',
  'create_terminal', 'close_terminal', 'write_to_terminal', 'run_command', 'list_terminals',
  'retrieve_full',
]

describe('brain/control non-interference guard', () => {
  it('routes every memory/swarm/control tool to exempt regardless of payload shape', () => {
    for (const tool of MUST_EXEMPT) {
      expect(route(tool, [{ big: 'x'.repeat(9999) }])).toBe('exempt')
      expect(route(tool, { big: 'x'.repeat(9999) })).toBe('exempt')
    }
  })
})

// Lumopolis as a gateway provider: agents reach the world through `gateway_call` with server
// "lumopolis" (the direct MCP tool list is nearly full, so new tools live behind the gateway).
// It is a TRUSTED built-in: Termpolis ships it, so the gateway skips the allow-list and the 'ask'
// prompt for it. `index.ts` registers it with the runtime (setBuiltinTransports); the runtime never
// imports this file, and a user's config server can never carry the trusted flag.
//
// One tool in 2.0: world_read. Arguments arrive from a model, so they are checked here: a wrong
// type is a clean error result (the gateway turns a thrown Error into { ok: false, error }), the
// limit is clamped to 1..100 and at most 200 ids are passed on. A project with no world yet gets a
// helpful message, never an empty answer that reads as "this project has no parts".
import type { Transport, UpstreamTool } from '../mcpGateway'
import type { WorldQuery } from '../../shared/world/types'
import type { WorldClient } from './worldClient'

export const WORLD_GATEWAY_ID = 'lumopolis'
export const WORLD_READ_TOOL = 'world_read'
/** The most items one gateway read may ask for (the host's own ceiling is higher). */
export const MAX_GATEWAY_LIMIT = 100
/** The most ids one gateway read passes on; the rest are dropped. */
export const MAX_GATEWAY_IDS = 200
export const NO_WORLD_MESSAGE = 'No Lumopolis map for this project yet. Open Lumopolis in Termpolis to build one.'
export const NO_ROOT_MESSAGE = 'world_read needs {"cwd": "<project folder>"}: pass your working directory as "cwd" in the arguments.'

/** What the transport needs from the world client: the full client satisfies it. */
export type WorldGatewayClient = Pick<WorldClient, 'read' | 'hasWorld'>
/** The project root for an agent's working directory, or null when there is none. */
export type WorldRootFor = (cwd?: string) => string | null | Promise<string | null>

const WORLD_READ: UpstreamTool = {
  name: WORLD_READ_TOOL,
  description:
    "Look up a project's Lumopolis map: its parts, the connections between them and the evidence behind each. Pass the project folder as \"cwd\", and filter by ids and/or text.",
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, maxItems: MAX_GATEWAY_IDS, description: 'Part or connection ids to fetch' },
      text: { type: 'string', description: 'Words to match in names, labels and claims (case-insensitive)' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_GATEWAY_LIMIT, description: 'Most items to return (default 20)' },
      cwd: { type: 'string', description: 'The project folder (your working directory): picks the map' }
    },
    required: ['cwd']
  }
}

interface ReadArgs {
  query: WorldQuery
  cwd?: string
}

function fail(message: string): never {
  throw new Error(message)
}

/** Checks a model's world_read arguments. A null field counts as absent; any other wrong type fails. */
export function parseWorldReadArgs(args: unknown): ReadArgs {
  if (args === undefined || args === null) return { query: {} }
  if (typeof args !== 'object' || Array.isArray(args)) fail('world_read arguments must be an object')
  const a = args as Record<string, unknown>
  const query: WorldQuery = {}
  if (a.ids !== undefined && a.ids !== null) {
    if (!Array.isArray(a.ids) || !a.ids.every((id) => typeof id === 'string')) fail('world_read "ids" must be an array of strings')
    query.ids = a.ids.slice(0, MAX_GATEWAY_IDS)
  }
  if (a.text !== undefined && a.text !== null) {
    if (typeof a.text !== 'string') fail('world_read "text" must be a string')
    query.text = a.text
  }
  if (a.limit !== undefined && a.limit !== null) {
    if (typeof a.limit !== 'number' || !Number.isFinite(a.limit)) fail('world_read "limit" must be a number')
    query.limit = Math.min(MAX_GATEWAY_LIMIT, Math.max(1, Math.floor(a.limit)))
  }
  let cwd: string | undefined
  if (a.cwd !== undefined && a.cwd !== null) {
    if (typeof a.cwd !== 'string') fail('world_read "cwd" must be a string')
    cwd = a.cwd
  }
  return cwd === undefined ? { query } : { query, cwd }
}

export function createWorldGatewayTransport(client: WorldGatewayClient, rootFor: WorldRootFor): Transport & { trusted: true } {
  return Object.freeze({
    id: WORLD_GATEWAY_ID,
    trusted: true as const,
    listTools: async (): Promise<UpstreamTool[]> => [WORLD_READ],
    async callTool(tool: string, args: unknown): Promise<string> {
      if (tool !== WORLD_READ_TOOL) fail(`unknown Lumopolis tool "${tool}"`)
      const { query, cwd } = parseWorldReadArgs(args)
      const root = await rootFor(cwd)
      if (typeof root !== 'string' || root.trim() === '') fail(NO_ROOT_MESSAGE)
      if (!(await client.hasWorld(root))) fail(NO_WORLD_MESSAGE)
      return JSON.stringify(await client.read(root, query))
    }
  })
}

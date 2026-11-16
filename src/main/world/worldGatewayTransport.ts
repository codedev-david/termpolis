// Lumopolis as a gateway provider: agents reach the world through `gateway_call` with server
// "lumopolis" (the direct MCP tool list is nearly full, so new tools live behind the gateway).
// It is a TRUSTED built-in: Termpolis ships it, so the gateway skips the allow-list and the 'ask'
// prompt for it. `index.ts` registers it with the runtime (setBuiltinTransports); the runtime never
// imports this file, and a user's config server can never carry the trusted flag.
//
// world_read looks up a project's map (or a design's, by designKey). world_propose, offered when
// the design deps are given, sketches planned parts into a design world: the one linked to the
// agent's project (made and linked on first use) or a named design. The only thing it writes is
// Lumopolis data under userData, and every change goes through applyDesignPatch's checks.
// Arguments arrive from a model, so they are checked here: a wrong type is a clean error result
// (the gateway turns a thrown Error into { ok: false, error }), the limit is clamped to 1..100 and
// at most 200 ids are passed on. A project with no world yet gets a helpful message, never an empty
// answer that reads as "this project has no parts".
import { stat } from 'fs/promises'
import { isAbsolute } from 'path'
import type { Transport, UpstreamTool } from '../mcpGateway'
import { MAX_DESIGN_OPS } from '../../shared/world/designPatch'
import type { WorldQuery, WorldReadResult } from '../../shared/world/types'
import { DESIGN_KEY_RE, DESIGN_NOT_FOUND, DESIGN_SAVE_FAILED, type Designer } from './designer'
import { createKeyedLock } from './keyedLock'
import { keyForSource, type SourceRegistry, type WorldSource } from './sources'
import type { WorldClient } from './worldClient'

export const WORLD_GATEWAY_ID = 'lumopolis'
export const WORLD_READ_TOOL = 'world_read'
export const WORLD_PROPOSE_TOOL = 'world_propose'
/** The most items one gateway read may ask for (the host's own ceiling is higher). */
export const MAX_GATEWAY_LIMIT = 100
/** The most ids one gateway read passes on; the rest are dropped. */
export const MAX_GATEWAY_IDS = 200
export const NO_WORLD_MESSAGE = 'No Lumopolis map for this project yet. Open Lumopolis in Termpolis to build one.'
export const NO_ROOT_MESSAGE = 'world_read needs {"cwd": "<project folder>"}: pass your working directory as "cwd" in the arguments.'
export const BAD_CWD_MESSAGE = '"cwd" must be the full path of a project folder on this computer (not a network path).'
export const BAD_DESIGN_KEY_MESSAGE = '"designKey" must be a Lumopolis design key, like "design:abc123".'
export const NO_DESIGN_MESSAGE = 'No Lumopolis design has that key.'
export const NO_PROPOSE_ROOT_MESSAGE = 'world_propose needs {"cwd": "<project folder>"} (your working directory) or a "designKey".'

/** What the transport needs from the world client: the full client satisfies it. */
export type WorldGatewayClient = Pick<WorldClient, 'read' | 'hasWorld'>
/** The project root for an agent's working directory, or null when there is none. */
export type WorldRootFor = (cwd?: string) => string | null | Promise<string | null>
/** Whether a path is an existing directory. */
export type IsDirectory = (p: string) => Promise<boolean>
/** What world_propose and designKey reads need: the designer, the source registry and a design reader. */
export interface WorldDesignDeps {
  designer: Pick<Designer, 'propose'>
  registry: Pick<SourceRegistry, 'get' | 'upsert'>
  /** The read result for a stored design, or null when there is none. */
  readDesign(key: string, q: WorldQuery): Promise<WorldReadResult | null>
}

const isDirectory: IsDirectory = async (p) => (await stat(p)).isDirectory()

/** Two leading separators: a UNC share (`\\server\share`, `//server/share`) or a device path (`\\?\`). */
const NETWORK_OR_DEVICE = /^[\\/]{2}/

/**
 * A model's cwd, before it reaches git or the disk: it must be absolute, local (a UNC path would make
 * Windows reach out to another machine, with the user's sign-in, just to answer a lookup) and an
 * existing folder. Anything else is a clean error result, in the same style as the other messages.
 */
async function checkCwd(cwd: string, isDir: IsDirectory): Promise<void> {
  if (NETWORK_OR_DEVICE.test(cwd) || !isAbsolute(cwd)) fail(BAD_CWD_MESSAGE)
  const ok = await isDir(cwd).catch(() => false)
  if (!ok) fail(BAD_CWD_MESSAGE)
}

const READ_PROPERTIES = {
  ids: { type: 'array', items: { type: 'string' }, maxItems: MAX_GATEWAY_IDS, description: 'Part or connection ids to fetch' },
  text: { type: 'string', description: 'Words to match in names, labels and claims (case-insensitive)' },
  limit: { type: 'integer', minimum: 1, maximum: MAX_GATEWAY_LIMIT, description: 'Most items to return (default 20)' },
  cwd: { type: 'string', description: 'The project folder (your working directory): picks the map' }
}

const WORLD_READ: UpstreamTool = {
  name: WORLD_READ_TOOL,
  description:
    "Look up a project's Lumopolis map: its parts, the connections between them and the evidence behind each. Pass the project folder as \"cwd\", and filter by ids and/or text.",
  inputSchema: { type: 'object', properties: READ_PROPERTIES, required: ['cwd'] }
}

const DESIGN_KEY_PROPERTY = { type: 'string', description: 'A design key (design:<id>): picks that design instead' }

const WORLD_READ_WITH_DESIGN: UpstreamTool = {
  name: WORLD_READ_TOOL,
  description:
    "Look up a project's Lumopolis map: its parts, the connections between them and the evidence behind each. Pass the project folder as \"cwd\" (or a design's \"designKey\"), and filter by ids and/or text.",
  inputSchema: { type: 'object', properties: { ...READ_PROPERTIES, designKey: DESIGN_KEY_PROPERTY } }
}

const WORLD_PROPOSE: UpstreamTool = {
  name: WORLD_PROPOSE_TOOL,
  description:
    "Sketch planned parts of a project in its Lumopolis design, shown beside the built code. Pass \"ops\" (addDistrict, addBuilding, addEdge, rename, move, describe, remove) and your \"cwd\", or a \"designKey\".",
  inputSchema: {
    type: 'object',
    properties: {
      ops: {
        type: 'array', maxItems: MAX_DESIGN_OPS, items: { type: 'object' },
        description: 'Changes, e.g. {"op":"addBuilding","id":"mail","districtId":"core","name":"Mailer","does":"sends receipts"}'
      },
      cwd: { type: 'string', description: 'The project folder (your working directory): picks its linked design' },
      designKey: DESIGN_KEY_PROPERTY
    },
    required: ['ops']
  }
}

interface ReadArgs {
  query: WorldQuery
  cwd?: string
  designKey?: string
}

interface ProposeArgs {
  ops: unknown[]
  cwd?: string
  designKey?: string
}

function fail(message: string): never {
  throw new Error(message)
}

/** An optional string argument: null or absent is undefined, any other non-string fails. */
function optString(a: Record<string, unknown>, field: string, tool: string): string | undefined {
  const v = a[field]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') fail(`${tool} "${field}" must be a string`)
  return v
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
  const cwd = optString(a, 'cwd', WORLD_READ_TOOL)
  const designKey = optString(a, 'designKey', WORLD_READ_TOOL)
  return { query, ...(cwd === undefined ? {} : { cwd }), ...(designKey === undefined ? {} : { designKey }) }
}

/** Checks a model's world_propose arguments: an ops array (at most MAX_DESIGN_OPS), optional cwd and designKey. */
function parseProposeArgs(args: unknown): ProposeArgs {
  const a = (typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>
  if (!Array.isArray(a.ops)) fail('world_propose "ops" must be an array of changes')
  if (a.ops.length > MAX_DESIGN_OPS) fail(`world_propose takes at most ${MAX_DESIGN_OPS} changes at a time`)
  const cwd = optString(a, 'cwd', WORLD_PROPOSE_TOOL)
  const designKey = optString(a, 'designKey', WORLD_PROPOSE_TOOL)
  return { ops: a.ops, ...(cwd === undefined ? {} : { cwd }), ...(designKey === undefined ? {} : { designKey }) }
}

/** A designKey a model passed: the design pattern (never a path), else a clean error. */
function checkDesignKey(key: string): void {
  if (!DESIGN_KEY_RE.test(key)) fail(BAD_DESIGN_KEY_MESSAGE)
}

export function createWorldGatewayTransport(
  client: WorldGatewayClient,
  rootFor: WorldRootFor,
  isDir: IsDirectory = isDirectory,
  design?: WorldDesignDeps
): Transport & { trusted: true } {
  /** One world_propose link step at a time per project (see propose). */
  const linkLock = createKeyedLock()
  /** A model's cwd, checked, or undefined when blank or absent. */
  const usableCwd = async (raw: string | undefined): Promise<string | undefined> => {
    // A blank cwd is no cwd: the caller is told to pass one.
    const cwd = raw?.trim() ? raw : undefined
    if (cwd !== undefined) await checkCwd(cwd, isDir)
    return cwd
  }

  const read = async (args: unknown): Promise<string> => {
    const parsed = parseWorldReadArgs(args)
    if (parsed.designKey !== undefined) {
      checkDesignKey(parsed.designKey)
      const found = design ? await design.readDesign(parsed.designKey, parsed.query) : null
      if (!found) fail(NO_DESIGN_MESSAGE)
      return JSON.stringify(found)
    }
    const cwd = await usableCwd(parsed.cwd)
    const root = await rootFor(cwd)
    if (typeof root !== 'string' || root.trim() === '') fail(NO_ROOT_MESSAGE)
    if (!(await client.hasWorld(root))) fail(NO_WORLD_MESSAGE)
    return JSON.stringify(await client.read(root, parsed.query))
  }

  const propose = async (deps: WorldDesignDeps, args: unknown): Promise<string> => {
    const p = parseProposeArgs(args)
    if (p.designKey !== undefined) {
      checkDesignKey(p.designKey)
      return JSON.stringify(await deps.designer.propose({ key: p.designKey }, p.ops))
    }
    const cwd = await usableCwd(p.cwd)
    if (cwd === undefined) fail(NO_PROPOSE_ROOT_MESSAGE)
    const root = await rootFor(cwd)
    if (typeof root !== 'string' || root.trim() === '') fail(NO_PROPOSE_ROOT_MESSAGE)
    // The project's registry entry (project, folder or git: one key per root) names its linked design.
    // Look-up, create-or-propose and link run under the project's lock, so two first calls for one
    // project make one linked design (the second finds the first's link) instead of orphaning one.
    const projectKey = keyForSource({ kind: 'project', root })
    return linkLock(projectKey, async () => {
      const entry = await deps.registry.get(projectKey)
      const own = entry && entry.source.kind !== 'design' ? entry.source : null
      if (own?.linkedDesign) {
        try {
          return JSON.stringify(await deps.designer.propose({ key: own.linkedDesign }, p.ops))
        } catch (e) {
          if ((e as Error).message !== DESIGN_NOT_FOUND) throw e
        }
      }
      const made = await deps.designer.propose({ linkRoot: root }, p.ops)
      const source: WorldSource = own ? { ...own, linkedDesign: made.key } : { kind: 'project', root, linkedDesign: made.key }
      try {
        await deps.registry.upsert(source, entry?.title)
      } catch {
        fail(DESIGN_SAVE_FAILED)
      }
      return JSON.stringify(made)
    })
  }

  return Object.freeze({
    id: WORLD_GATEWAY_ID,
    trusted: true as const,
    listTools: async (): Promise<UpstreamTool[]> => (design ? [WORLD_READ_WITH_DESIGN, WORLD_PROPOSE] : [WORLD_READ]),
    async callTool(tool: string, args: unknown): Promise<string> {
      if (tool === WORLD_READ_TOOL) return read(args)
      if (tool === WORLD_PROPOSE_TOOL && design) return propose(design, args)
      fail(`unknown Lumopolis tool "${tool}"`)
    }
  })
}

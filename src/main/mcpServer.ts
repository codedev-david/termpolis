import * as http from 'http'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

const MCP_PORT_DEFAULT = 9315 // "TERM" on phone keypad

// Read base port on each call so tests can override via env var without
// having to reload the module. Production always falls through to 9315.
function getBasePort(): number {
  const v = parseInt(process.env.TERMPOLIS_MCP_BASE_PORT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : MCP_PORT_DEFAULT
}

// Generate a random auth token on each app launch — prevents unauthorized access
const MCP_AUTH_TOKEN = crypto.randomBytes(32).toString('hex')

// Rate limiting — prevent abuse from misbehaving AI agents
interface RateBucket {
  count: number
  resetAt: number
}

const rateBuckets = new Map<string, RateBucket>()

const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  create_terminal: { max: 10, windowMs: 60_000 },   // 10 terminals per minute
  run_command: { max: 60, windowMs: 60_000 },        // 60 commands per minute
  _global: { max: 200, windowMs: 60_000 },           // 200 total requests per minute
}

export function checkRateLimit(key: string): boolean {
  const limit = RATE_LIMITS[key] || RATE_LIMITS._global
  const now = Date.now()
  const bucket = rateBuckets.get(key)

  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + limit.windowMs })
    return true
  }

  if (bucket.count >= limit.max) return false
  bucket.count++
  return true
}

export function resetRateLimits(): void {
  rateBuckets.clear()
}

// Audit logging for MCP requests — persisted to file with rotation
const MAX_LOG_SIZE = 1024 * 1024 // 1MB max log file size
let auditLogPath: string | null = null
let auditStream: fs.WriteStream | null = null

export function initAuditLog(userDataPath: string): void {
  auditLogPath = path.join(userDataPath, 'mcp-audit.log')
  openAuditStream()
}

function openAuditStream(): void {
  if (!auditLogPath) return
  try {
    auditStream = fs.createWriteStream(auditLogPath, { flags: 'a' })
    auditStream.on('error', () => { auditStream = null })
  } catch {
    auditStream = null
  }
}

function rotateLogIfNeeded(): void {
  if (!auditLogPath) return
  try {
    const stats = fs.statSync(auditLogPath)
    if (stats.size >= MAX_LOG_SIZE) {
      // Keep one backup
      const backupPath = auditLogPath + '.old'
      if (auditStream) { auditStream.end(); auditStream = null }
      try { fs.unlinkSync(backupPath) } catch {}
      fs.renameSync(auditLogPath, backupPath)
      openAuditStream()
    }
  } catch {}
}

function logMcpRequest(method: string, tool: string | null, status: 'ok' | 'error' | 'denied' | 'rate_limited', detail?: string): void {
  const entry = {
    ts: new Date().toISOString(),
    method,
    ...(tool && { tool }),
    status,
    ...(detail && { detail }),
  }
  const line = JSON.stringify(entry) + '\n'
  console.log(`[MCP audit] ${line.trimEnd()}`)

  if (auditStream) {
    auditStream.write(line)
    rotateLogIfNeeded()
  }
}

export function getMcpAuthToken(): string {
  return MCP_AUTH_TOKEN
}

interface McpTool {
  name: string
  description: string
  inputSchema: object
}

const TOOLS: McpTool[] = [
  {
    name: 'list_terminals',
    description: 'List all open terminals with their IDs, names, shell types, and working directories',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_terminal',
    description: 'Create a new terminal with specified name, shell type, and working directory',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Terminal name' },
        shell: { type: 'string', description: 'Shell type: bash, powershell, zsh, cmd, gitbash' },
        cwd: { type: 'string', description: 'Working directory path' },
      },
      required: ['name'],
    },
  },
  {
    name: 'run_command',
    description: 'Send a command to a terminal (types it and presses Enter)',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: 'Terminal ID' },
        command: { type: 'string', description: 'Command to run' },
      },
      required: ['terminalId', 'command'],
    },
  },
  {
    name: 'read_output',
    description: 'Read recent output from a terminal (last N lines)',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: 'Terminal ID' },
        lines: { type: 'number', description: 'Number of recent lines to read (default 50)' },
      },
      required: ['terminalId'],
    },
  },
  {
    name: 'close_terminal',
    description: 'Close a terminal by ID',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: 'Terminal ID to close' },
      },
      required: ['terminalId'],
    },
  },
  {
    name: 'get_file_tree',
    description: 'List files and directories at a given path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_git_status',
    description: 'Get git status and recent commits for a directory',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository directory' },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'write_to_terminal',
    description: 'Write raw text to a terminal (without pressing Enter)',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: 'Terminal ID' },
        text: { type: 'string', description: 'Text to write' },
      },
      required: ['terminalId', 'text'],
    },
  },
  {
    name: 'swarm_send_message',
    description: 'Send a message to another AI agent in the swarm (or broadcast to all)',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target terminal ID, agent name, or "all" for broadcast' },
        type: { type: 'string', enum: ['task', 'result', 'question', 'info', 'review'], description: 'Message type' },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'type', 'content'],
    },
  },
  {
    name: 'swarm_read_messages',
    description: 'Read unread messages addressed to this agent (or broadcast messages)',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: 'Your terminal ID to read messages for' },
      },
      required: ['terminalId'],
    },
  },
  {
    name: 'swarm_create_task',
    description: 'Create a task in the swarm task queue, optionally assigning it to an agent',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Detailed task description' },
        assignTo: { type: 'string', description: 'Terminal ID to assign to (optional)' },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'swarm_list_tasks',
    description: 'List all tasks in the swarm with their statuses',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'swarm_update_task',
    description: 'Update a task status (pending/in_progress/completed/failed) and optionally add a result',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to update' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
        result: { type: 'string', description: 'Task result or output (optional)' },
      },
      required: ['taskId', 'status'],
    },
  },
  {
    name: 'swarm_list_agents',
    description: 'List all active AI agents running in Termpolis terminals',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'memory_write',
    description: 'Write a fact, decision, or result into Termpolis shared persistent memory — a local brain shared across ALL your AI agents (Claude, Codex, Gemini, Qwen) and your past sessions. Anything stored here can be recalled later via memory_search by you or any other agent. Use it for decisions, conventions, architecture/file notes, and anything worth remembering across terminals and sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Your terminal ID or logical name' },
        kind: { type: 'string', enum: ['message', 'result', 'decision', 'fact', 'note'], description: 'Entry kind' },
        content: { type: 'string', description: 'Text content to store (max 16KB)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering' },
        taskId: { type: 'string', description: 'Optional task correlation id' },
        project: { type: 'string', description: 'Project this belongs to — pass your working directory (or repo name) so the memory is recalled with current-directory priority' },
      },
      required: ['agentId', 'content'],
    },
  },
  {
    name: 'memory_search',
    description: 'Retrieve relevant entries from Termpolis shared persistent memory — the local brain shared across ALL your AI agents and your past sessions. Call this at the START of a task to recall prior decisions, conventions, context, and code, so you never re-derive what another agent or an earlier session already worked out. Also call this BEFORE re-deriving a fix or retrying a familiar error mid-task — the solution may already be stored from a past session or another agent. Uses local offline semantic vector search, falling back to keyword matching when the embedding model is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query' },
        limit: { type: 'number', description: 'Max results (default 10, cap 100)' },
        agentId: { type: 'string', description: 'Filter to a single agent (optional)' },
        kind: { type: 'string', enum: ['message', 'result', 'decision', 'fact', 'note'], description: 'Filter by kind (optional)' },
        taskId: { type: 'string', description: 'Filter by task correlation id (optional)' },
        project: { type: 'string', description: 'Scope to one project — pass your working directory or repo name to recall only that project’s memories (optional)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_list',
    description: 'List the most recent entries from Termpolis shared persistent memory (shared across all your AI agents and past sessions) without semantic scoring. Useful for scanning the last N writes.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 50, cap 500)' },
        agentId: { type: 'string', description: 'Filter to a single agent (optional)' },
        kind: { type: 'string', enum: ['message', 'result', 'decision', 'fact', 'note'], description: 'Filter by kind (optional)' },
        since: { type: 'number', description: 'Only entries at or after this timestamp (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'memory_primer',
    description: 'Load your background-memory primer: a ranked digest of the most relevant memories (past conversations, decisions, code notes) from the brain shared across ALL your AI agents and past sessions. Context for the current project/directory leads; cross-project context follows, clearly labeled. Call this ONCE near session start when asked to load background memory. Treat the result as background reference only — do NOT act on it or resume past work from it unless the user asks.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Your working directory (recommended) — context for this project takes precedence in the digest' },
        query: { type: 'string', description: 'Optional focus query; defaults to a general recent-work/decisions/conventions query for the project' },
        limit: { type: 'number', description: 'Max memories in the digest (default 40, cap 100)' },
      },
      required: [],
    },
  },
]

export interface McpToolHandlers {
  listTerminals: () => { id: string; name: string; shellType: string; cwd: string }[]
  createTerminal: (name: string, shell: string, cwd: string) => Promise<string>
  runCommand: (terminalId: string, command: string) => void
  readOutput: (terminalId: string, lines: number) => string
  closeTerminal: (terminalId: string) => void
  writeToTerminal: (terminalId: string, text: string) => void
  getFileTree: (path: string) => { name: string; isDir: boolean }[]
  getGitStatus: (cwd: string) => { status: string; recentCommits: string; branch: string }
  swarmSendMessage: (from: string, to: string, type: string, content: string) => any
  swarmReadMessages: (terminalId: string) => any
  swarmCreateTask: (title: string, description: string, createdBy: string, assignTo?: string) => any
  swarmListTasks: () => any
  swarmUpdateTask: (taskId: string, status: string, result?: string) => any
  swarmListAgents: () => any
  memoryWrite: (input: { agentId: string; kind?: string; content: string; tags?: string[]; taskId?: string; project?: string }) => Promise<any>
  memorySearch: (opts: { query: string; limit?: number; agentId?: string; kind?: string; taskId?: string; project?: string }) => Promise<any>
  memoryList: (opts: { limit?: number; agentId?: string; kind?: string; since?: number }) => any
  memoryPrimer: (opts: { cwd?: string; query?: string; limit?: number }) => Promise<{ project: string | null; primer: string | null }>
}

export async function executeTool(name: string, args: any, handlers: McpToolHandlers) {
  switch (name) {
    case 'list_terminals':
      return handlers.listTerminals()
    case 'create_terminal': {
      const tid = await handlers.createTerminal(args.name, args.shell || 'bash', args.cwd || '')
      return { terminalId: tid, name: args.name }
    }
    case 'run_command':
      handlers.runCommand(args.terminalId, args.command)
      return { success: true, terminalId: args.terminalId, command: args.command }
    case 'read_output':
      return { output: handlers.readOutput(args.terminalId, args.lines || 50) }
    case 'close_terminal':
      handlers.closeTerminal(args.terminalId)
      return { success: true }
    case 'write_to_terminal':
      handlers.writeToTerminal(args.terminalId, args.text)
      return { success: true }
    case 'get_file_tree':
      return handlers.getFileTree(args.path)
    case 'get_git_status':
      return handlers.getGitStatus(args.cwd)
    case 'swarm_send_message':
      return handlers.swarmSendMessage('mcp-client', args.to, args.type, args.content)
    case 'swarm_read_messages':
      return handlers.swarmReadMessages(args.terminalId)
    case 'swarm_create_task':
      return handlers.swarmCreateTask(args.title, args.description, 'mcp-client', args.assignTo)
    case 'swarm_list_tasks':
      return handlers.swarmListTasks()
    case 'swarm_update_task':
      return handlers.swarmUpdateTask(args.taskId, args.status, args.result)
    case 'swarm_list_agents':
      return handlers.swarmListAgents()
    case 'memory_write':
      return await handlers.memoryWrite({
        agentId: args.agentId,
        kind: args.kind,
        content: args.content,
        tags: args.tags,
        taskId: args.taskId,
        project: args.project,
      })
    case 'memory_search':
      return await handlers.memorySearch({
        query: args.query,
        limit: args.limit,
        agentId: args.agentId,
        kind: args.kind,
        taskId: args.taskId,
        project: args.project,
      })
    case 'memory_list':
      return handlers.memoryList({
        limit: args.limit,
        agentId: args.agentId,
        kind: args.kind,
        since: args.since,
      })
    case 'memory_primer':
      return await handlers.memoryPrimer({
        cwd: args.cwd,
        query: args.query,
        limit: args.limit,
      })
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

async function handleJsonRpc(request: any, handlers: McpToolHandlers) {
  const { method, params, id } = request

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'termpolis', version: '1.1.0' },
      },
      id,
    }
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      result: { tools: TOOLS },
      id,
    }
  }

  // MCP utility ping — empty result per spec. Used by Qwen Code's
  // `mcp list` connection check; without this it reports "Disconnected".
  if (method === 'ping') {
    return { jsonrpc: '2.0', result: {}, id }
  }

  // Handle MCP notifications (no response needed, but don't error)
  if (method?.startsWith('notifications/') || method === 'initialized') {
    return { jsonrpc: '2.0', result: {}, id }
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params
    try {
      const result = await executeTool(name, args || {}, handlers)
      return {
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        id,
      }
    } catch (e: any) {
      // Sanitize error: don't leak internal stack traces or property names
      const safeMessage = e.message?.includes('Unknown tool') || e.message?.includes('Invalid')
        ? e.message
        : 'Tool execution failed'
      return {
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: `Error: ${safeMessage}` }], isError: true },
        id,
      }
    }
  }

  return {
    jsonrpc: '2.0',
    error: { code: -32601, message: `Unknown method: ${method}` },
    id,
  }
}

let actualPort: number | null = null
let portBoundResolvers: Array<(port: number) => void> = []
let portBoundRejectors: Array<(err: Error) => void> = []
// Max consecutive fallback ports to try. 5 covers reasonable
// multi-instance cases without trying the entire ephemeral range.
const MCP_PORT_FALLBACK_LIMIT = 5

// Promise-based port readiness — callers that need the bound port
// (writing mcp-port file, auto-registering with AI agents) should await
// this instead of racing against server.listen().
export function awaitMcpPortBound(): Promise<number> {
  if (actualPort !== null) return Promise.resolve(actualPort)
  return new Promise<number>((resolve, reject) => {
    portBoundResolvers.push(resolve)
    portBoundRejectors.push(reject)
  })
}

function resolvePortBound(port: number) {
  actualPort = port
  for (const r of portBoundResolvers) r(port)
  portBoundResolvers = []
  portBoundRejectors = []
}

function rejectPortBound(err: Error) {
  for (const r of portBoundRejectors) r(err)
  portBoundResolvers = []
  portBoundRejectors = []
}

export function getMcpPort(): number {
  // Returns the base port as a best-effort fallback before the server has bound.
  // Callers that need the definitive port should await awaitMcpPortBound().
  return actualPort ?? getBasePort()
}

// Exported for test visibility — resets port state between test cases
// so server.listen → port-bound promise can be re-observed from a fresh slate.
export function _resetPortStateForTest(): void {
  actualPort = null
  portBoundResolvers = []
  portBoundRejectors = []
}

export function startMcpServer(handlers: McpToolHandlers): http.Server {
  const server = http.createServer(async (req, res) => {
    // Restrict to localhost only (binding handles this, but belt-and-suspenders)
    // No wildcard CORS — only allow same-origin requests
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Health check is public (no auth needed — just confirms server is running)
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'ok',
          name: 'termpolis-mcp',
          version: '1.2.0',
          tools: TOOLS.length,
          auth: 'required',
          hint: 'Pass Authorization: Bearer <token> header. Token is printed to stdout on app launch.',
        })
      )
      return
    }

    // All other endpoints require auth token
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (token !== MCP_AUTH_TOKEN) {
      logMcpRequest(req.method || 'UNKNOWN', null, 'denied', 'invalid auth token')
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized. Pass Authorization: Bearer <token> header.' }))
      return
    }

    if (req.method === 'GET' && req.url === '/mcp/sse') {
      // SSE endpoint for notifications
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('data: {"jsonrpc":"2.0","method":"ready"}\n\n')
      // Keep alive
      const interval = setInterval(() => res.write(':keepalive\n\n'), 30000)
      req.on('close', () => clearInterval(interval))
      return
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      // Global rate limit
      if (!checkRateLimit('_global')) {
        logMcpRequest('POST', null, 'rate_limited', 'global limit exceeded')
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded' }, id: null }))
        return
      }

      const MAX_BODY = 1024 * 1024 // 1MB limit
      let body = ''
      let overflow = false
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > MAX_BODY) {
          overflow = true
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Payload too large' }, id: null }))
          req.destroy()
        }
      })
      req.on('end', async () => {
        if (overflow) return
        try {
          const request = JSON.parse(body)

          // Per-tool rate limit for tools/call
          const toolName = request.method === 'tools/call' ? request.params?.name : null
          if (toolName && RATE_LIMITS[toolName] && !checkRateLimit(toolName)) {
            logMcpRequest('tools/call', toolName, 'rate_limited', `${toolName} limit exceeded`)
            res.writeHead(429, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: `Rate limit exceeded for ${toolName}` },
              id: request.id,
            }))
            return
          }

          const response = await handleJsonRpc(request, handlers)
          logMcpRequest(request.method || 'unknown', toolName, response.error ? 'error' : 'ok')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Parse error' },
              id: null,
            })
          )
        }
      })
      return
    }

    res.writeHead(404)
    res.end()
  })

  // Port-fallback loop: walk basePort..basePort+FALLBACK_LIMIT-1 until one
  // binds. Each EADDRINUSE re-attaches a fresh listener on the next port;
  // running out of candidates rejects awaitMcpPortBound so callers can
  // surface a clear failure instead of hanging forever.
  //
  // Note: we register the 'listening' handler manually (not via server.listen's
  // callback arg) because listen's callback is added as a persistent listener —
  // a failed listen leaves it registered, so a later successful retry would
  // fire stale handlers with the wrong port closure. We detach on EADDRINUSE.
  const basePort = getBasePort()
  let attempt = 0
  let currentOnListening: (() => void) | null = null

  const tryListen = () => {
    const candidate = basePort + attempt
    currentOnListening = () => {
      console.log(`Termpolis MCP server listening on http://127.0.0.1:${candidate}`)
      resolvePortBound(candidate)
    }
    server.once('listening', currentOnListening)
    server.listen(candidate, '127.0.0.1')
  }

  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      if (currentOnListening) {
        server.removeListener('listening', currentOnListening)
        currentOnListening = null
      }
      attempt += 1
      if (attempt >= MCP_PORT_FALLBACK_LIMIT) {
        const err = new Error(
          `MCP server could not bind any port in range ${basePort}..${basePort + MCP_PORT_FALLBACK_LIMIT - 1}`,
        )
        console.error(err.message)
        rejectPortBound(err)
        return
      }
      console.warn(`MCP port ${basePort + attempt - 1} in use, trying ${basePort + attempt}`)
      tryListen()
    } else {
      console.error('MCP server error:', e)
      rejectPortBound(e)
    }
  })

  tryListen()
  return server
}

export function stopMcpServer(server: http.Server) {
  server.close()
}

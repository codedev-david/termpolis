import * as http from 'http'
import * as crypto from 'crypto'

const MCP_PORT = 9315 // "TERM" on phone keypad

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
}

async function executeTool(name: string, args: any, handlers: McpToolHandlers) {
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
      return {
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
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
          if (request.method === 'tools/call' && request.params?.name) {
            const toolName = request.params.name
            if (RATE_LIMITS[toolName] && !checkRateLimit(toolName)) {
              res.writeHead(429, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: `Rate limit exceeded for ${toolName}` },
                id: request.id,
              }))
              return
            }
          }

          const response = await handleJsonRpc(request, handlers)
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

  server.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`Termpolis MCP server listening on http://127.0.0.1:${MCP_PORT}`)
  })

  // Don't crash if port is taken
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.warn(`MCP port ${MCP_PORT} in use, trying ${MCP_PORT + 1}`)
      server.listen(MCP_PORT + 1, '127.0.0.1')
    }
  })

  return server
}

export function stopMcpServer(server: http.Server) {
  server.close()
}

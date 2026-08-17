#!/usr/bin/env node

// Termpolis CLI -- control Termpolis from any terminal
// Usage: termpolis-cli <command> [args...]
//   termpolis-cli list                    -- list all terminals
//   termpolis-cli create <name> [shell]   -- create a new terminal
//   termpolis-cli run <id> <command>      -- run a command in a terminal
//   termpolis-cli read <id> [lines]       -- read output from a terminal
//   termpolis-cli close <id>              -- close a terminal
//   termpolis-cli files <path>            -- list files at path
//   termpolis-cli git <path>              -- get git status at path
//   termpolis-cli health                  -- check server status
//   termpolis-cli primer [cwd]            -- print the shared-memory primer for a project
//   termpolis-cli recall <query> [proj]   -- search the shared memory brain
//   termpolis-cli remember <text> [proj]  -- write one memory to the shared brain

const http = require('http')
const fs = require('fs')

// Data-dir logic is shared so it can't drift (lowercase name, XDG_CONFIG_HOME on Linux) — dataDir.cjs
const { dataFile } = require('./dataDir.cjs')

// Find the auth token
function findToken() {
  const tokenPath = dataFile('mcp-token')
  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim()
  } catch {
    console.error(`Error: Cannot read MCP token from ${tokenPath}`)
    console.error('Make sure Termpolis is running.')
    process.exit(1)
  }
}

const TOKEN = findToken()

// The MCP server binds 9315 but falls back through 9316-9319 when the port is taken -- a second
// Termpolis, or anything else already on 9315. It writes the port it actually got to `mcp-port`,
// which stdio-adapter.cjs has always read and this CLI never did: every command silently talked to
// the wrong port, or to nothing, whenever the fallback fired. Same resolution order as the adapter,
// same default, so the two cannot disagree about where the server is.
function findPort() {
  try {
    const port = parseInt(fs.readFileSync(dataFile('mcp-port'), 'utf-8').trim(), 10)
    if (port > 0 && port < 65536) return port
  } catch {}
  return 9315
}
const PORT = findPort()

function mcpCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error(data)) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function toolCall(name, args = {}) {
  return mcpCall('tools/call', { name, arguments: args })
}

async function main() {
  const [,, cmd, ...args] = process.argv

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`Termpolis CLI -- control your terminals from the command line

Usage: termpolis-cli <command> [args...]

Commands:
  list                    List all open terminals
  create <name> [shell]   Create a new terminal (shell: bash, powershell, zsh, cmd, gitbash)
  run <id> <command>      Run a command in a terminal
  read <id> [lines]       Read recent output (default: 50 lines)
  write <id> <text>       Write text to a terminal (no Enter)
  close <id>              Close a terminal
  files <path>            List files at a directory path
  git <path>              Get git status for a directory
  health                  Check if Termpolis MCP server is running
  tools                   List available MCP tools

Shared memory (the same brain every Termpolis agent reads and writes):
  primer [cwd]            Print the project primer (defaults to the current directory)
  recall <query> [proj]   Search the shared memory brain
  remember <text> [proj]  Write one memory to the shared brain`)
    return
  }

  try {
    switch (cmd) {
      case 'health': {
        const res = await new Promise((resolve, reject) => {
          http.get(`http://127.0.0.1:${PORT}/health`, (r) => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d))
          }).on('error', reject)
        })
        console.log(res)
        break
      }
      case 'tools': {
        const res = await mcpCall('tools/list')
        const tools = res.result?.tools || []
        tools.forEach(t => console.log(`  ${t.name.padEnd(20)} ${t.description}`))
        break
      }
      case 'list': {
        const res = await toolCall('list_terminals')
        const terminals = JSON.parse(res.result?.content?.[0]?.text || '[]')
        if (terminals.length === 0) { console.log('No terminals open'); break }
        terminals.forEach(t => console.log(`  ${t.id.slice(0,8)}  ${t.name.padEnd(20)} ${t.shellType.padEnd(12)} ${t.cwd}`))
        break
      }
      case 'create': {
        const name = args[0] || 'Terminal'
        const shell = args[1] || 'bash'
        const res = await toolCall('create_terminal', { name, shell })
        console.log(res.result?.content?.[0]?.text || 'Created')
        break
      }
      case 'run': {
        const [id, ...cmdParts] = args
        if (!id || cmdParts.length === 0) { console.error('Usage: termpolis-cli run <id> <command>'); process.exit(1) }
        const res = await toolCall('run_command', { terminalId: id, command: cmdParts.join(' ') })
        console.log(res.result?.content?.[0]?.text || 'Sent')
        break
      }
      case 'read': {
        const [id, lines] = args
        if (!id) { console.error('Usage: termpolis-cli read <id> [lines]'); process.exit(1) }
        const res = await toolCall('read_output', { terminalId: id, lines: parseInt(lines) || 50 })
        const output = JSON.parse(res.result?.content?.[0]?.text || '{}')
        console.log(output.output || '(empty)')
        break
      }
      case 'write': {
        const [id, ...textParts] = args
        if (!id || textParts.length === 0) { console.error('Usage: termpolis-cli write <id> <text>'); process.exit(1) }
        await toolCall('write_to_terminal', { terminalId: id, text: textParts.join(' ') })
        console.log('Written')
        break
      }
      case 'close': {
        if (!args[0]) { console.error('Usage: termpolis-cli close <id>'); process.exit(1) }
        await toolCall('close_terminal', { terminalId: args[0] })
        console.log('Closed')
        break
      }
      case 'files': {
        if (!args[0]) { console.error('Usage: termpolis-cli files <path>'); process.exit(1) }
        const res = await toolCall('get_file_tree', { path: args[0] })
        const files = JSON.parse(res.result?.content?.[0]?.text || '[]')
        files.forEach(f => console.log(`  ${f.isDir ? 'DIR' : '   '} ${f.name}`))
        break
      }
      case 'git': {
        if (!args[0]) { console.error('Usage: termpolis-cli git <path>'); process.exit(1) }
        const res = await toolCall('get_git_status', { cwd: args[0] })
        console.log(res.result?.content?.[0]?.text || '(no git info)')
        break
      }
      // Memory verbs. The brain is reachable over MCP from inside a Termpolis terminal and from
      // any agent wired to the stdio adapter, but never from a plain shell -- so a CI job, a git
      // hook, or a script had no way to read or add to the shared memory the whole app is built
      // around. These three are the read/recall/write triad; everything else stays in-app.
      case 'primer': {
        const res = await toolCall('memory_primer', { cwd: args[0] || process.cwd() })
        console.log(res.result?.content?.[0]?.text || '(no primer)')
        break
      }
      case 'recall': {
        if (!args[0]) { console.error('Usage: termpolis-cli recall <query> [project]'); process.exit(1) }
        const res = await toolCall('memory_search', { query: args[0], project: args[1] })
        console.log(res.result?.content?.[0]?.text || '(no matches)')
        break
      }
      case 'remember': {
        if (!args[0]) { console.error('Usage: termpolis-cli remember <text> [project]'); process.exit(1) }
        const res = await toolCall('memory_write', { content: args[0], project: args[1] })
        console.log(res.result?.content?.[0]?.text || '(saved)')
        break
      }
      default:
        console.error(`Unknown command: ${cmd}. Run termpolis-cli help for usage.`)
        process.exit(1)
    }
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}

main()

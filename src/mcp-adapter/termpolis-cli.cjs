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
//   termpolis-cli exec <prompt>           -- run a hosted agent headlessly, primed with project memory
//   termpolis-cli receipt [--json]        -- print (or --verify) a signed token-savings receipt
//   termpolis-cli bench [--save]          -- score recall quality against this brain's own memories

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

function mcpCall(method, params = {}, timeoutMs = 120000) {
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
    // A headless `exec` can legitimately run for many minutes; without an explicit timeout
    // node's socket-inactivity default would abort the request while the agent was still
    // working, and the run would look like a transport failure rather than a long job.
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`request timed out after ${timeoutMs}ms`)) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function toolCall(name, args = {}, timeoutMs) {
  return mcpCall('tools/call', { name, arguments: args }, timeoutMs)
}

// Minimal flag parsing. The positional verbs predate it and keep working unchanged: flags
// are stripped out first, so `exec "do the thing" --write` and `exec --write "do the thing"`
// are the same command and the prompt never has to be quoted around a flag.
function parseFlags(argv, boolFlags = []) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { rest.push(a); continue }
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
    if (eq > 0) { flags[key] = a.slice(eq + 1); continue }
    if (boolFlags.includes(key)) { flags[key] = true; continue }
    flags[key] = argv[++i]
  }
  return { flags, rest }
}

function textOf(res) {
  return res.result?.content?.[0]?.text
}

// The MCP server answers a tool error as an ordinary result whose text carries the message,
// so a CLI that only checked the transport would exit 0 on a failed run. CI needs the exit
// code to mean what it says.
function failIfError(res) {
  if (res.error) { console.error(`Error: ${res.error.message || JSON.stringify(res.error)}`); process.exit(1) }
  return res
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
  remember <text> [proj]  Write one memory to the shared brain

Headless + proof (for CI, git hooks, and scripts):
  exec <prompt> [flags]   Run a hosted agent headlessly, primed with this project's memory
                          --agent claude|codex|gemini  --model <id>  --cwd <path>
                          --write (allow repo edits; default read-only)  --timeout <ms>
                          --json (full result object instead of just the output)
  receipt [--json]        Print a signed token-savings receipt for this install
  receipt --verify <file> Check a receipt file's signature and internal consistency
  bench [flags]           Score recall quality (MRR / recall@k) over this brain's memories
                          --project <slug>  --limit <n>  --save (record a new baseline)`)
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
      // Headless execution. This is the verb that lets everything the app has learned reach
      // a context with no app in it -- a CI job, a pre-push hook, a cron. Read-only by
      // default: the safe shape for the review/analysis jobs that are most of what CI wants.
      case 'exec': {
        const { flags, rest } = parseFlags(args, ['write', 'json'])
        const prompt = rest.join(' ').trim()
        if (!prompt) { console.error('Usage: termpolis-cli exec <prompt> [--agent claude|codex|gemini] [--model id] [--cwd path] [--write] [--timeout ms]'); process.exit(1) }
        const timeoutMs = flags.timeout ? parseInt(flags.timeout, 10) : undefined
        const res = failIfError(await toolCall('agent_exec', {
          prompt,
          agent: flags.agent,
          model: flags.model,
          cwd: flags.cwd || process.cwd(),
          write: flags.write === true,
          timeoutMs,
        }, (timeoutMs || 900000) + 30000))
        const payload = JSON.parse(textOf(res) || '{}')
        if (flags.json) console.log(JSON.stringify(payload, null, 2))
        else console.log(payload.output || payload.error || '(no output)')
        // Exit non-zero on a failed run so a pipeline stage actually fails.
        if (!payload.ok) process.exit(payload.code && payload.code !== 0 ? payload.code : 1)
        break
      }
      // The savings receipt. Portable and signed so the number can leave the machine that
      // produced it -- a screenshot of a dashboard proves nothing to a finance team.
      case 'receipt': {
        const { flags } = parseFlags(args, ['json'])
        if (flags.verify) {
          const res = failIfError(await toolCall('savings_receipt', { verify: fs.readFileSync(flags.verify, 'utf-8') }))
          const payload = JSON.parse(textOf(res) || '{}')
          if (!payload.ok) { console.error(`Error: ${payload.error}`); process.exit(1) }
          console.log(JSON.stringify(payload.verify, null, 2))
          if (!payload.verify.consistent || payload.verify.intact === false) process.exit(1)
          break
        }
        const res = failIfError(await toolCall('savings_receipt', { format: flags.json ? 'json' : 'markdown' }))
        const payload = JSON.parse(textOf(res) || '{}')
        console.log(payload.text || '(no receipt)')
        break
      }
      // Scored recall quality. Without a number, "the memory got better" is an anecdote.
      case 'bench': {
        const { flags } = parseFlags(args, ['save', 'json'])
        const res = failIfError(await toolCall('recall_bench', {
          project: flags.project,
          limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
          save: flags.save === true,
        }, 300000))
        const payload = JSON.parse(textOf(res) || '{}')
        if (flags.json) { console.log(JSON.stringify(payload, null, 2)); break }
        console.log(payload.text || '(no result)')
        if (payload.verdict && payload.verdict.regressed) {
          console.error(`\nREGRESSION: ${(payload.verdict.reasons || []).join('; ') || 'recall quality fell below the recorded baseline'}`)
          process.exit(1)
        }
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

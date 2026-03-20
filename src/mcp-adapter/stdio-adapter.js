#!/usr/bin/env node

// Termpolis MCP Stdio Adapter
// Claude Code launches this as a subprocess. It proxies MCP calls to
// Termpolis's HTTP server on localhost:9315.

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const readline = require('readline')

// Find the auth token
function findToken() {
  const platform = process.platform
  let tokenDir
  if (platform === 'win32') {
    tokenDir = path.join(process.env.APPDATA || '', 'termpolis')
  } else if (platform === 'darwin') {
    tokenDir = path.join(os.homedir(), 'Library', 'Application Support', 'termpolis')
  } else {
    tokenDir = path.join(os.homedir(), '.config', 'termpolis')
  }
  const tokenPath = path.join(tokenDir, 'mcp-token')
  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim()
  } catch {
    process.stderr.write(`Error: Cannot read MCP token from ${tokenPath}\nMake sure Termpolis is running.\n`)
    process.exit(1)
  }
}

const TOKEN = findToken()
const MCP_PORT = 9315

function sendToServer(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1',
      port: MCP_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(new Error(`Invalid JSON response: ${body}`))
        }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// Read JSON-RPC messages from stdin (newline-delimited)
const rl = readline.createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  if (!line.trim()) return
  try {
    const request = JSON.parse(line)
    const response = await sendToServer(request)
    process.stdout.write(JSON.stringify(response) + '\n')
  } catch (err) {
    const errorResponse = {
      jsonrpc: '2.0',
      error: { code: -32603, message: err.message },
      id: null,
    }
    process.stdout.write(JSON.stringify(errorResponse) + '\n')
  }
})

rl.on('close', () => process.exit(0))

// Health check on start
http.get(`http://127.0.0.1:${MCP_PORT}/health`, (res) => {
  let body = ''
  res.on('data', chunk => body += chunk)
  res.on('end', () => {
    process.stderr.write(`Termpolis MCP adapter connected: ${body}\n`)
  })
}).on('error', () => {
  process.stderr.write(`Warning: Cannot connect to Termpolis MCP server on port ${MCP_PORT}. Is the app running?\n`)
})

'use strict'
const http = require('http')
const { openStore } = require('./db/store')
const { handle } = require('./routes')
const { log } = require('./lib/logger')
const config = require('./config')

function start(port = config.port) {
  const store = openStore()
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'ERR_VALIDATION', message: 'invalid JSON' }))
        return
      }
      const out = handle(store, { method: req.method, path: req.url.split('?')[0], body })
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out.body))
    })
  })
  server.listen(port, () => log.info('listening', { port }))
  return server
}

if (require.main === module) start()

module.exports = { start }

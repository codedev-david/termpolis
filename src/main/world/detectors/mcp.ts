import { collect, type Boundary } from './common'

// mcp key = the server name string if present, else 'server'.
//   provide: `new McpServer({ name: 'x', ... })`        -> 'x'
//   consume: `mcpServers: { x: ... }` / `mcpServers = { 'x': ... }` -> first server name 'x'
const SERVER = /\bnew McpServer\(\s*(?:\{[^}]*?\bname\s*:\s*['"`]([^'"`]+)['"`])?/
const CONFIG = /\bmcpServers\s*[:=]\s*\{\s*(?:['"`]?([\w.-]+)['"`]?\s*:)?/

export function detectMcp(file: string, text: string): Boundary[] {
  return [
    ...collect(file, text, SERVER, (m) => ({ kind: 'mcp', key: m[1] ?? 'server', side: 'provide' })),
    ...collect(file, text, CONFIG, (m) => ({ kind: 'mcp', key: m[1] ?? 'server', side: 'consume' }))
  ]
}

// mcpToml.ts
//
// Enumerates `[mcp_servers.NAME]` sections out of a Codex config.
//
// WHY A TEXT SCAN AND NOT A TOML PARSER: the same reason agentMcpRegistry.ts:313-315
// gives for writing one — a real parser refuses the whole file over an unrelated
// syntax error somewhere else in it, and this file is hand-edited. A listing that
// shows four of five servers beats a listing that shows none.
//
// Read-only. Registration still belongs to agentMcpRegistry.ts; nothing here writes.

export interface TomlMcpServer {
  name: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

/** A TOML string, unquoted. Basic strings unescape `\"` and `\\`; literal (single-quoted)
 *  strings take no escapes at all, which is what makes them the safe way to spell a
 *  Windows path. A bare, unquoted value is returned as written rather than rejected. */
function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return trimmed
  const inner = trimmed.slice(1, -1)
  return quote === "'" ? inner : inner.replace(/\\(["\\])/g, '$1')
}

/** Every quoted string in an inline array, in order. Tolerates a trailing comma. */
function parseArray(raw: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    out.push(match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : match[2])
  }
  return out
}

/** `{ KEY = "value", OTHER = 'v' }` as a flat record. */
function parseInlineTable(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z0-9_.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) out[match[1]] = unquote(match[2])
  return out
}

/** The server name in `[mcp_servers.NAME]`, or null when the header is anything else —
 *  including a SUB-table such as `[mcp_servers.a.tools.b]`, which configures a server
 *  that its own header already introduced. Registering that as a server named
 *  "a.tools.b" would invent one the user never wrote. */
function serverNameFromHeader(header: string): string | null {
  const prefix = 'mcp_servers.'
  if (!header.startsWith(prefix)) return null
  const rest = header.slice(prefix.length).trim()
  if (!rest) return null
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quote = rest[0]
    const end = rest.indexOf(quote, 1)
    if (end === -1) return null
    // A quoted name followed by anything (`."tools"`) is a sub-table.
    return end === rest.length - 1 ? rest.slice(1, end) : null
  }
  return rest.includes('.') ? null : rest
}

export function parseCodexMcpServers(content: string): TomlMcpServer[] {
  if (typeof content !== 'string' || !content) return []
  const servers: TomlMcpServer[] = []
  let current: TomlMcpServer | null = null

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // A header only counts when `[` is the first non-space character on the line, which
    // is what keeps `args = ["C:\x[1].cjs"]` from reading as one.
    if (trimmed.startsWith('[')) {
      const end = trimmed.lastIndexOf(']')
      current = null
      if (end > 1) {
        const name = serverNameFromHeader(trimmed.slice(1, end).trim())
        if (name) {
          current = { name }
          servers.push(current)
        }
      }
      continue
    }

    if (!current) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()

    if (key === 'command') current.command = unquote(value)
    else if (key === 'url') current.url = unquote(value)
    else if (key === 'args') current.args = parseArray(value)
    else if (key === 'env') current.env = parseInlineTable(value)
  }

  return servers
}

import { describe, it, expect } from 'vitest'
import { parseCodexMcpServers } from '../../src/main/mcpToml'

describe('parseCodexMcpServers', () => {
  it('reads a plain stdio server', () => {
    const toml = [
      '[mcp_servers.termpolis]',
      'command = "node"',
      'args = ["C:\\\\Users\\\\d\\\\adapter.cjs"]',
      '',
    ].join('\n')
    expect(parseCodexMcpServers(toml)).toEqual([
      { name: 'termpolis', command: 'node', args: ['C:\\Users\\d\\adapter.cjs'] },
    ])
  })

  it('ignores sub-tables rather than inventing a server', () => {
    const toml = [
      '[mcp_servers.termpolis]',
      'command = "node"',
      '[mcp_servers.termpolis.tools.memory_search]',
      'approval_mode = "never"',
    ].join('\n')
    const servers = parseCodexMcpServers(toml)
    expect(servers.map(s => s.name)).toEqual(['termpolis'])
    // The sub-table's keys must not leak onto the parent server either.
    expect(servers[0]).toEqual({ name: 'termpolis', command: 'node' })
  })

  it('does not mistake a bracket inside a value for a table header', () => {
    const toml = '[mcp_servers.a]\nargs = ["C:\\\\x[1].cjs"]\n'
    expect(parseCodexMcpServers(toml)).toEqual([{ name: 'a', args: ['C:\\x[1].cjs'] }])
  })

  it('handles CRLF, comments, quoted names and an unterminated final section', () => {
    const toml =
      '# top\r\n[mcp_servers."my-server"]\r\nurl = "https://x.test"\r\n[mcp_servers.tail]\r\ncommand = "x"'
    expect(parseCodexMcpServers(toml)).toEqual([
      { name: 'my-server', url: 'https://x.test' },
      { name: 'tail', command: 'x' },
    ])
  })

  it('reads an inline env table, the shape agentMcpRegistry itself writes', () => {
    const toml = '[mcp_servers.a]\ncommand = "x"\nenv = { TOKEN = "abc", MODE = \'dev\' }\n'
    expect(parseCodexMcpServers(toml)[0].env).toEqual({ TOKEN: 'abc', MODE: 'dev' })
  })

  it('reads single-quoted (literal) strings and multi-entry arrays', () => {
    const toml = "[mcp_servers.a]\ncommand = 'npx'\nargs = ['-y', \"pkg\", ]\n"
    expect(parseCodexMcpServers(toml)).toEqual([{ name: 'a', command: 'npx', args: ['-y', 'pkg'] }])
  })

  it('skips other top-level tables without disturbing the servers around them', () => {
    const toml = '[mcp_servers.a]\ncommand = "x"\n[profile]\nmodel = "gpt"\n[mcp_servers.b]\ncommand = "y"\n'
    expect(parseCodexMcpServers(toml).map(s => s.name)).toEqual(['a', 'b'])
  })

  it('tolerates malformed headers, bare values and stray lines', () => {
    const toml = [
      '[',                                // no closing bracket
      '[]',                               // empty header
      '[mcp_servers.]',                   // prefix with no name
      '[mcp_servers."unterminated]',      // quote never closes
      '[mcp_servers."quoted".tools]',     // quoted name, but a sub-table
      'command = "orphan"',               // a key before any header
      '[mcp_servers.ok]',
      'command = node',                   // unquoted value
      'url =',                            // empty value
      'nonsense-without-an-equals',
    ].join('\n')
    expect(parseCodexMcpServers(toml)).toEqual([{ name: 'ok', command: 'node', url: '' }])
  })

  it('returns [] for garbage rather than throwing', () => {
    expect(parseCodexMcpServers('!!! not toml [[[')).toEqual([])
    expect(parseCodexMcpServers('')).toEqual([])
    expect(parseCodexMcpServers(null as unknown as string)).toEqual([])
  })
})

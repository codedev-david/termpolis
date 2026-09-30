import { describe, it, expect, vi } from 'vitest'
import {
  addCodexToolApprovals, codexConfigSets, codexServerState, codexTrustedProjects,
  stripCodexProjectTrust, stripCodexServer, tomlString, upsertCodexServer,
  type CodexServerSpec, type TomlEdit,
} from '../../src/main/codexConfigEdit'
import { CODEX_AUTO_APPROVED_TOOLS, isUnsafeTrustRoot } from '../../src/shared/agentIntegration'

// Codex rewrites ~/.codex/config.toml itself and people edit it by hand, so every test here feeds
// realistic text and compares the exact bytes that come back. Nothing touches a real config file.

/** Each line followed by LF. */
const lf = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('')
/** Each line followed by CRLF. */
const crlf = (...lines: string[]): string => lines.map((l) => `${l}\r\n`).join('')

const BOM = '\uFEFF'
const NODE = '/usr/local/bin/node'
const ADAPTER = '/opt/Termpolis/resources/mcp-adapter.js'
const SPEC: CodexServerSpec = { command: NODE, args: [ADAPTER] }
const ELECTRON_SPEC: CodexServerSpec = { ...SPEC, env: { ELECTRON_RUN_AS_NODE: '1' } }
const SERVER_BLOCK = [
  '[mcp_servers.termpolis]',
  'command = "/usr/local/bin/node"',
  'args = ["/opt/Termpolis/resources/mcp-adapter.js"]',
]
const ELECTRON_ENV = 'env = { ELECTRON_RUN_AS_NODE = "1" }'

const ARRAY_OF_TABLES = 'mcp_servers is written as an array of tables ([[\u2026]])'
const DOTTED_SERVER = 'mcp_servers.termpolis is set with dotted keys or an inline table'
const INLINE_SERVERS = 'mcp_servers is set as an inline table'

/** A config.toml the way people keep one: comments, odd spacing, several tables. */
const USER_CONFIG = lf(
  '# Codex CLI configuration (hand-edited)',
  'model = "gpt-5-codex"',
  'model_reasoning_effort = "high"',
  'approval_policy = "on-request"   # ask before leaving the sandbox',
  'sandbox_mode = "workspace-write"',
  '',
  '[tui]',
  'notifications = ["agent-turn-complete", "approval-requested"]',
  '',
  '[profiles.ci]',
  'approval_policy = "never"',
  '',
  '[projects."/home/me/work/api"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.github]',
  'command = "npx"',
  'args = ["-y", "@modelcontextprotocol/server-github"]',
  'env = { LOG_LEVEL = "debug" }',
)

function edited(r: TomlEdit): { text: string; changed: boolean } {
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`)
  return r
}

function approvalsText(r: { text: string; added: string[] } | { error: string }): string {
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`)
  return r.text
}

/** The lines addCodexToolApprovals adds for one tool. */
const approval = (tool: string): string[] => ['', `[mcp_servers.termpolis.tools.${tool}]`, 'approval_mode = "auto"']

describe('tomlString', () => {
  it('quotes plain text as a basic string', () => {
    expect(tomlString(NODE)).toBe('"/usr/local/bin/node"')
  })

  it('escapes backslashes and double quotes', () => {
    expect(tomlString('C:\\Program Files\\say "hi"')).toBe(String.raw`"C:\\Program Files\\say \"hi\""`)
  })

  it('writes control characters and DEL as \\u escapes', () => {
    expect(tomlString('a\tb\nc\u0000d\u007f')).toBe(String.raw`"a\u0009b\u000ac\u0000d\u007f"`)
  })

  it('leaves non-ASCII text, astral characters included, as it is', () => {
    expect(tomlString('café 😀')).toBe('"café 😀"')
  })

  it('round-trips through the scanner however hostile the text', () => {
    const nasty = `C:\\dir "q" 's' #[mcp_servers.x] \t\n\u001b\u007f é 😀 \\u0041`
    const spec = { command: nasty, args: [nasty, ''] }
    const { text } = edited(upsertCodexServer('', spec))
    expect(codexServerState(text)).toEqual({ state: 'present', command: nasty, args: [nasty, ''] })
    expect(upsertCodexServer(text, spec)).toEqual({ text, changed: false })
  })
})

describe('config.toml scanner', () => {
  it('decodes basic-string escapes and keeps literal strings raw', () => {
    const basic = lf(
      '[mcp_servers.termpolis]',
      String.raw`command = "C:\\Program Files\\nodejs\\node.exe"`,
      String.raw`args = ["a\b\t\n\f\r\e\"\\z", "\u00e9\U0001F600\x41"]`,
    )
    expect(codexServerState(basic)).toEqual({
      state: 'present',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['a\b\t\n\f\r\u001b"\\z', 'é😀A'],
    })
    const literal = lf(
      '[mcp_servers.termpolis]',
      String.raw`command = 'C:\Program Files\nodejs\node.exe'`,
      String.raw`args = ['C:\x\mcp.js']`,
    )
    expect(codexServerState(literal)).toEqual({ state: 'present', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\x\\mcp.js'] })
  })

  it('recognizes quoted, spaced, indented and commented spellings of a header', () => {
    for (const header of [
      '[mcp_servers."termpolis"]',
      "[ 'mcp_servers' . termpolis ]  # Termpolis",
      '\t [mcp_servers.termpolis]',
    ]) {
      expect(codexServerState(lf(header, '\tcommand = "node"', 'args = []')), header)
        .toEqual({ state: 'present', command: 'node', args: [] })
    }
  })

  it('does not mistake a header-looking line inside a multi-line string for a table', () => {
    for (const q of ['"""', "'''"]) {
      const text = lf('[profiles.default]', `notes = ${q}`, '[mcp_servers.termpolis]', 'command = "evil"', q)
      expect(codexServerState(text), q).toEqual({ state: 'absent' })
    }
  })

  it('keeps a multi-line basic string open past an escaped quote, but not a literal one', () => {
    const basic = lf('[profiles.default]', String.raw`notes = """He typed \""" and left`, '[mcp_servers.termpolis]', 'command = "evil"', '"""')
    expect(codexServerState(basic)).toEqual({ state: 'absent' })
    const literal = lf('[profiles.default]', String.raw`path = '''C:\temp\'''`, '[mcp_servers.termpolis]', 'command = "node"')
    expect(codexServerState(literal)).toEqual({ state: 'present', command: 'node', args: undefined })
  })

  it('lets up to two quotes sit right before the three that close a multi-line string', () => {
    const text = lf('a = """say "hi""""', "b = '''it''s'''''", 'c = 1')
    expect(codexConfigSets(text, 'c')).toBe(true)
  })

  it('does not end a table at a header-looking line inside a multi-line array', () => {
    const text = lf('[projects."/home/me/app"]', 'weights = [', '[1.5],', ']', 'trust_level = "trusted"')
    expect(codexTrustedProjects(text)).toEqual(['/home/me/app'])
  })

  it('ignores brackets and quotes inside comments', () => {
    const text = lf('[projects."/home/me/app"]', `list = [ # closes with ] and quotes " '`, '  "x",', ']  # done ]', 'trust_level = "trusted"')
    expect(codexTrustedProjects(text)).toEqual(['/home/me/app'])
  })

  it('honours escapes in one-line basic strings and none in literal strings', () => {
    const text = lf('[projects."/home/me/app"]', String.raw`motd = "a \" b # [not] a header"`, String.raw`path = 'C:\'`, 'trust_level = "trusted"')
    expect(codexTrustedProjects(text)).toEqual(['/home/me/app'])
  })

  const MALFORMED: Array<[string, string, string]> = [
    ['an unclosed header', lf('[mcp_servers.termpolis'), 'line 1: unreadable table header'],
    ['text after a header', lf('model = "o3"', '[tui] notifications = true'), 'line 2: unreadable table header'],
    ['an unclosed array-table header', lf('[[profiles]'), 'line 1: unreadable table header'],
    ['an empty header', lf('[]'), 'line 1: unreadable table header'],
    ['a header ending in a dot', lf('[projects.]'), 'line 1: unreadable table header'],
    ['a bad escape in a header key', lf(String.raw`[projects."\q"]`), 'line 1: unreadable table header'],
    ['a line starting with =', lf('= "o3"'), 'line 1: unreadable key'],
    ['a key with a space in it', lf('model name = "o3"'), 'line 1: unreadable key'],
    ['a bare word', lf('# settings', 'hello'), 'line 2: unreadable key'],
    ['an unterminated quoted key', lf('"model = 1'), 'line 1: unreadable key'],
    ['an unterminated literal key', lf("'model = 1"), 'line 1: unreadable key'],
    ['a multi-line string as a key', lf('"""model""" = 1'), 'line 1: unreadable key'],
    ['a key with no value', lf('model ='), 'line 1: key without a value'],
    ['a key with only a comment for a value', lf('model = # todo'), 'line 1: key without a value'],
    ['an unterminated string', lf('model = "o3'), 'line 1: unterminated string'],
    ['a backslash ending a string', lf('model = "o3\\'), 'line 1: unterminated string'],
    ['an unterminated literal string', lf("model = 'o3"), 'line 1: unterminated string'],
    ['a stray closing bracket', lf('args = ]'), 'line 1: unbalanced brackets'],
    ['an extra bracket on a later line', lf('args = [', '  "a" ]]'), 'line 2: unbalanced brackets'],
    ['six quotes closing a multi-line string', lf('notes = """x""""""'), 'line 1: too many quotes closing a multi-line string'],
    ['an array left open', lf('args = [', '  "a",'), 'unterminated multi-line string or array'],
    ['a multi-line string left open', lf('notes = """', 'text'), 'unterminated multi-line string or array'],
  ]

  it.each(MALFORMED)('reports %s instead of guessing', (_name, text, error) => {
    expect(codexServerState(text)).toEqual({ state: 'error', error })
  })

  it('makes every entry point refuse a file it cannot scan', () => {
    const bad = lf('model = "o3', '[mcp_servers.termpolis]')
    const error = 'line 1: unterminated string'
    expect(codexServerState(bad)).toEqual({ state: 'error', error })
    expect(upsertCodexServer(bad, SPEC)).toEqual({ error })
    expect(stripCodexServer(bad)).toEqual({ error })
    expect(addCodexToolApprovals(bad, CODEX_AUTO_APPROVED_TOOLS)).toEqual({ error })
    expect(codexConfigSets(bad, 'model')).toEqual({ error })
    expect(codexTrustedProjects(bad)).toEqual({ error })
    expect(stripCodexProjectTrust(bad, () => true)).toEqual({ error })
  })
})

describe('codexServerState', () => {
  it('reads the command and args out of a realistic config', () => {
    expect(codexServerState(USER_CONFIG + lf('', ...SERVER_BLOCK, 'enabled = true')))
      .toEqual({ state: 'present', command: NODE, args: [ADAPTER] })
  })

  it('is absent without the table, including for servers that only share the prefix', () => {
    expect(codexServerState('')).toEqual({ state: 'absent' })
    expect(codexServerState(USER_CONFIG)).toEqual({ state: 'absent' })
    expect(codexServerState(lf('[mcp_servers.termpolis-dev]', 'command = "node"', '[mcp_servers.termpolis_old]', 'command = "node"')))
      .toEqual({ state: 'absent' })
  })

  it('reads one-line arrays in any quoting and spacing', () => {
    expect(codexServerState(lf('[mcp_servers.termpolis]', 'command = "node"', `args = [ 'a', "b", ]  # note`)))
      .toEqual({ state: 'present', command: 'node', args: ['a', 'b'] })
  })

  it('leaves command and args undefined when the table does not set them', () => {
    expect(codexServerState(lf('[mcp_servers.termpolis]', 'enabled = true')))
      .toEqual({ state: 'present', command: undefined, args: undefined })
  })

  it('reports a command it cannot read with certainty as undefined, never a guess', () => {
    const values = [
      String.raw`"\q"`, String.raw`"\u12"`, String.raw`"\u12zz"`, String.raw`"\UFFFFFFFF"`, String.raw`"\uD800"`,
      '42', '["node"]', '"""node"""', "'''node'''", '"node" "x"',
    ]
    for (const v of values) {
      expect(codexServerState(lf('[mcp_servers.termpolis]', `command = ${v}`, 'args = []')), v)
        .toEqual({ state: 'present', command: undefined, args: [] })
    }
    expect(codexServerState(lf('[mcp_servers.termpolis]', 'command = """', 'node"""')))
      .toEqual({ state: 'present', command: undefined, args: undefined })
  })

  it('reports args it cannot read with certainty as undefined', () => {
    for (const v of ['"x"', '[1, 2]', '["a" "b"]', '["a"] "x"']) {
      const s = codexServerState(lf('[mcp_servers.termpolis]', 'command = "node"', `args = ${v}`))
      expect(s, v).toEqual({ state: 'present', command: 'node', args: undefined })
    }
    expect(codexServerState(lf('[mcp_servers.termpolis]', 'command = "node"', 'args = [', '  "a",', ']')))
      .toEqual({ state: 'present', command: 'node', args: undefined })
  })
})

describe('refusing shapes it cannot edit safely', () => {
  const REFUSED: Array<[string, string, string]> = [
    ['two server tables', lf('[mcp_servers.termpolis]', 'command = "a"', '', '[mcp_servers.termpolis]', 'command = "b"'),
      'config.toml has two [mcp_servers.termpolis] tables'],
    ['mcp_servers as an array of tables', lf('[[mcp_servers]]', 'name = "termpolis"'), ARRAY_OF_TABLES],
    ['the server as an array of tables', lf('[[mcp_servers.termpolis]]', 'command = "node"'), ARRAY_OF_TABLES],
    ['a sub-table as an array of tables', lf(...SERVER_BLOCK, '[[mcp_servers.termpolis.tools]]', 'name = "memory_search"'), ARRAY_OF_TABLES],
    ['dotted keys at the top level', lf('mcp_servers.termpolis.command = "node"'), DOTTED_SERVER],
    ['an inline table under [mcp_servers]', lf('[mcp_servers]', 'termpolis = { command = "node" }'), DOTTED_SERVER],
    ['dotted keys under [mcp_servers]', lf('[mcp_servers]', '"termpolis".command = "node"'), DOTTED_SERVER],
    ['a top-level inline table naming it', lf('mcp_servers = { termpolis = { command = "node" } }'), INLINE_SERVERS],
    ['a top-level inline table naming it on a later line', lf('mcp_servers = {', '  termpolis = { command = "node" } }'), INLINE_SERVERS],
  ]

  it.each(REFUSED)('refuses %s in every server edit', (_name, text, error) => {
    expect(codexServerState(text)).toEqual({ state: 'error', error })
    expect(upsertCodexServer(text, SPEC)).toEqual({ error })
    expect(stripCodexServer(text)).toEqual({ error })
    expect(addCodexToolApprovals(text, CODEX_AUTO_APPROVED_TOOLS)).toEqual({ error })
  })

  const ADD_ONLY: Array<[string, string, string]> = [
    ['a top-level inline mcp_servers table', lf('mcp_servers = { github = { command = "npx" } }'), INLINE_SERVERS],
    ['top-level dotted mcp_servers keys', lf('mcp_servers.github.command = "npx"'), 'mcp_servers is set with dotted keys at the top level'],
  ]

  it.each(ADD_ONLY)('reads and strips around %s, but will not add a header that would clash with it', (_name, text, error) => {
    expect(codexServerState(text)).toEqual({ state: 'absent' })
    expect(stripCodexServer(text)).toEqual({ text, changed: false })
    expect(upsertCodexServer(text, SPEC)).toEqual({ error })
    expect(addCodexToolApprovals(text, CODEX_AUTO_APPROVED_TOOLS)).toEqual({ error })
  })

  it('adds beside an [mcp_servers] table of other servers and beside unrelated arrays of tables', () => {
    for (const text of [
      lf('[mcp_servers]', 'github = { command = "npx" }'),
      lf('[[hooks]]', 'event = "start"', '', '[[mcp_servers.legacy]]', 'command = "x"'),
    ]) {
      expect(upsertCodexServer(text, SPEC)).toEqual({ text: text + lf('', ...SERVER_BLOCK), changed: true })
    }
  })
})

describe('upsertCodexServer', () => {
  it('writes just the block into an empty file', () => {
    expect(upsertCodexServer('', SPEC)).toEqual({ text: lf(...SERVER_BLOCK), changed: true })
  })

  it('appends after one blank line and leaves every existing byte alone', () => {
    expect(upsertCodexServer(USER_CONFIG, SPEC)).toEqual({ text: USER_CONFIG + lf('', ...SERVER_BLOCK), changed: true })
  })

  it('does not double a blank line the file already ends with', () => {
    const text = lf('model = "o3"', '')
    expect(upsertCodexServer(text, SPEC)).toEqual({ text: text + lf(...SERVER_BLOCK), changed: true })
  })

  it('ends an unterminated last line before appending', () => {
    expect(upsertCodexServer('model = "o3"', SPEC)).toEqual({ text: lf('model = "o3"', '', ...SERVER_BLOCK), changed: true })
  })

  it('adds lines in the file\'s own line ending and keeps its BOM', () => {
    const text = BOM + crlf('# config', 'model = "o3"')
    expect(upsertCodexServer(text, SPEC)).toEqual({ text: BOM + crlf('# config', 'model = "o3"', '', ...SERVER_BLOCK), changed: true })
  })

  it('treats a file with any CRLF as CRLF, leaving each existing line its own ending', () => {
    const text = 'a = 1\nb = 2\r\n'
    expect(upsertCodexServer(text, SPEC)).toEqual({ text: text + crlf('', ...SERVER_BLOCK), changed: true })
  })

  it('writes Windows paths as escaped basic strings that read back unchanged', () => {
    const spec = {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Users\\me\\AppData\\Local\\Programs\\Termpolis\\resources\\mcp-adapter.js'],
    }
    const { text } = edited(upsertCodexServer('', spec))
    expect(text).toBe(lf(
      '[mcp_servers.termpolis]',
      String.raw`command = "C:\\Program Files\\nodejs\\node.exe"`,
      String.raw`args = ["C:\\Users\\me\\AppData\\Local\\Programs\\Termpolis\\resources\\mcp-adapter.js"]`,
    ))
    expect(codexServerState(text)).toEqual({ state: 'present', ...spec })
    // The same paths written by hand as literal strings are already up to date.
    const literal = lf(
      '[mcp_servers.termpolis]',
      String.raw`command = 'C:\Program Files\nodejs\node.exe'`,
      String.raw`args = ['C:\Users\me\AppData\Local\Programs\Termpolis\resources\mcp-adapter.js']`,
    )
    expect(upsertCodexServer(literal, spec)).toEqual({ text: literal, changed: false })
  })

  it('is idempotent: a second run changes nothing and returns the same text', () => {
    const once = edited(upsertCodexServer(USER_CONFIG, ELECTRON_SPEC)).text
    expect(upsertCodexServer(once, ELECTRON_SPEC)).toEqual({ text: once, changed: false })
  })

  it('accepts an up-to-date server in any quoting, spacing or comment style', () => {
    const text = lf(
      '[mcp_servers.termpolis]  # Termpolis',
      `  command   =   '${NODE}'   # pinned`,
      `  args = [ '${ADAPTER}', ]  # adapter`,
    )
    expect(upsertCodexServer(text, SPEC)).toEqual({ text, changed: false })
  })

  it('updates a stale command and args in place, keeping indent, position and every other key', () => {
    const before = lf(
      'model = "o3"',
      '',
      '[mcp_servers.termpolis]',
      '# Termpolis memory + code search',
      '  command = "/old/node"   # moved in v1.40',
      'args = ["/old/mcp-adapter.js", "--stdio"]',
      'enabled = true',
      'startup_timeout_sec = 20',
      'env = { TERMPOLIS_LOG = "1" }',
      '',
      '[mcp_servers.termpolis.tools.memory_write]',
      'approval_mode = "approve"',
    )
    const after = lf(
      'model = "o3"',
      '',
      '[mcp_servers.termpolis]',
      '# Termpolis memory + code search',
      '  command = "/usr/local/bin/node"',
      'args = ["/opt/Termpolis/resources/mcp-adapter.js"]',
      'enabled = true',
      'startup_timeout_sec = 20',
      'env = { TERMPOLIS_LOG = "1" }',
      '',
      '[mcp_servers.termpolis.tools.memory_write]',
      'approval_mode = "approve"',
    )
    expect(upsertCodexServer(before, SPEC)).toEqual({ text: after, changed: true })
  })

  it.each([
    ['a different path', '["/old/mcp-adapter.js"]'],
    ['an extra argument', `["${ADAPTER}", "--verbose"]`],
    ['no arguments', '[]'],
    ['a plain string', `"${ADAPTER}"`],
  ])('replaces args holding %s', (_name, value) => {
    const text = lf('[mcp_servers.termpolis]', `command = "${NODE}"`, `args = ${value}`, 'enabled = true')
    expect(upsertCodexServer(text, SPEC)).toEqual({ text: lf(...SERVER_BLOCK, 'enabled = true'), changed: true })
  })

  it('rewrites a multi-line command as one line, keeping its indent and its last line\'s ending', () => {
    const text = lf('[mcp_servers.termpolis]', '  command = """', '/old/node"""', `args = ["${ADAPTER}"]`)
    expect(upsertCodexServer(text, SPEC))
      .toEqual({ text: lf('[mcp_servers.termpolis]', `  command = "${NODE}"`, `args = ["${ADAPTER}"]`), changed: true })
    // At the end of a file with no final newline, the replacement doesn't gain one.
    const atEnd = `[mcp_servers.termpolis]\nargs = ["${ADAPTER}"]\ncommand = """\n/old/node"""`
    expect(upsertCodexServer(atEnd, SPEC))
      .toEqual({ text: `[mcp_servers.termpolis]\nargs = ["${ADAPTER}"]\ncommand = "${NODE}"`, changed: true })
  })

  it('rewrites a multi-line args array once, then leaves it alone', () => {
    const text = lf('[mcp_servers.termpolis]', `command = "${NODE}"`, 'args = [', `  "${ADAPTER}",`, ']', 'enabled = true')
    const once = edited(upsertCodexServer(text, SPEC))
    expect(once).toEqual({ text: lf(...SERVER_BLOCK, 'enabled = true'), changed: true })
    expect(upsertCodexServer(once.text, SPEC)).toEqual({ text: once.text, changed: false })
  })

  it('fills in a missing command under the header and missing args right after it', () => {
    const text = lf('model = "o3"', '', '[mcp_servers.termpolis]', 'enabled = true', 'tool_timeout_sec = 60')
    expect(upsertCodexServer(text, SPEC))
      .toEqual({ text: lf('model = "o3"', '', ...SERVER_BLOCK, 'enabled = true', 'tool_timeout_sec = 60'), changed: true })
  })

  it('ends an unterminated last line before inserting after it', () => {
    expect(upsertCodexServer('[mcp_servers.termpolis]', SPEC)).toEqual({ text: lf(...SERVER_BLOCK), changed: true })
    expect(upsertCodexServer(`[mcp_servers.termpolis]\ncommand = "${NODE}"`, SPEC)).toEqual({ text: lf(...SERVER_BLOCK), changed: true })
  })

  describe('env', () => {
    it('writes the Electron-as-node env with a new block when the spec needs one', () => {
      expect(upsertCodexServer('', ELECTRON_SPEC)).toEqual({ text: lf(...SERVER_BLOCK, ELECTRON_ENV), changed: true })
    })

    it('adds that env right after args when the table has none', () => {
      expect(upsertCodexServer(lf(...SERVER_BLOCK, 'enabled = true'), ELECTRON_SPEC))
        .toEqual({ text: lf(...SERVER_BLOCK, ELECTRON_ENV, 'enabled = true'), changed: true })
    })

    it('quotes env names that are not bare keys and escapes the values', () => {
      const spec = { ...SPEC, env: { 'MY VAR': 'say "hi"', PATH_EXT: 'x' } }
      expect(upsertCodexServer('', spec))
        .toEqual({ text: lf(...SERVER_BLOCK, String.raw`env = { "MY VAR" = "say \"hi\"", PATH_EXT = "x" }`), changed: true })
    })

    it.each([
      ['an inline env of the user\'s', ['env = { LOG_LEVEL = "debug" }']],
      ['dotted env keys', ['env.LOG_LEVEL = "debug"']],
      ['an env sub-table', ['', '[mcp_servers.termpolis.env]', 'LOG_LEVEL = "debug"']],
      ['the fallback env it already wrote', [ELECTRON_ENV]],
    ])('never touches %s, even when the spec wants an env', (_name, rest) => {
      const text = lf(...SERVER_BLOCK, ...rest)
      expect(upsertCodexServer(text, ELECTRON_SPEC)).toEqual({ text, changed: false })
    })

    it('drops the old Electron fallback env once a real node is in use', () => {
      expect(upsertCodexServer(lf(...SERVER_BLOCK, ELECTRON_ENV, 'enabled = true'), SPEC))
        .toEqual({ text: lf(...SERVER_BLOCK, 'enabled = true'), changed: true })
      expect(upsertCodexServer(lf(...SERVER_BLOCK, `env = { "ELECTRON_RUN_AS_NODE" = '1' }  # fallback`), SPEC))
        .toEqual({ text: lf(...SERVER_BLOCK), changed: true })
    })

    it.each([
      ['a different value', 'env = { ELECTRON_RUN_AS_NODE = "0" }'],
      ['an extra variable', 'env = { ELECTRON_RUN_AS_NODE = "1", LOG_LEVEL = "debug" }'],
      ['a number, not a string', 'env = { ELECTRON_RUN_AS_NODE = 1 }'],
      ['a dotted name', 'env = { ELECTRON_RUN_AS_NODE.value = "1" }'],
      ['no name', 'env = { = "1" }'],
      ['no equals sign', 'env = { ELECTRON_RUN_AS_NODE "1" }'],
      ['no comma between entries', 'env = { ELECTRON_RUN_AS_NODE = "1" LOG = "x" }'],
      ['text after the table', 'env = { ELECTRON_RUN_AS_NODE = "1" } "x"'],
      ['an empty table', 'env = {}'],
      ['a string, not a table', 'env = "ELECTRON_RUN_AS_NODE=1"'],
      ['a table over two lines', 'env = {\n  ELECTRON_RUN_AS_NODE = "1" }'],
    ])('keeps an env that only resembles the fallback: %s', (_name, envLine) => {
      const text = lf(...SERVER_BLOCK, envLine)
      expect(upsertCodexServer(text, SPEC)).toEqual({ text, changed: false })
    })
  })
})

describe('stripCodexServer', () => {
  it('removes the server and every table under it, wherever they sit, and nothing else', () => {
    const text = lf(
      'model = "o3"',
      '',
      '[mcp_servers.termpolis]',
      `command = "${NODE}"`,
      `args = ["${ADAPTER}"]`,
      '',
      '[mcp_servers.termpolis.tools.memory_search]',
      'approval_mode = "auto"',
      '',
      '[tui]',
      'notifications = true',
      '',
      '[mcp_servers."termpolis".env]',
      'ELECTRON_RUN_AS_NODE = "1"',
    )
    expect(stripCodexServer(text)).toEqual({ text: lf('model = "o3"', '', '[tui]', 'notifications = true'), changed: true })
  })

  it('takes comments inside the table with it and leaves the ones after its last key', () => {
    const text = lf(
      '[mcp_servers.termpolis]',
      '# managed by Termpolis',
      `command = "${NODE}"`,
      '',
      '',
      '# GitHub server, added 2026-05',
      '[mcp_servers.github]',
      'command = "npx"',
    )
    expect(stripCodexServer(text))
      .toEqual({ text: lf('# GitHub server, added 2026-05', '[mcp_servers.github]', 'command = "npx"'), changed: true })
  })

  it('removes a table through the closing line of a last value that spans several lines', () => {
    const text = lf(
      'model = "o3"',
      '',
      '[mcp_servers.termpolis]',
      `command = "${NODE}"`,
      'args = [',
      `  "${ADAPTER}",`,
      ']',
      '',
      '[tui]',
      'notifications = true',
    )
    expect(stripCodexServer(text)).toEqual({ text: lf('model = "o3"', '', '[tui]', 'notifications = true'), changed: true })
  })

  it('keeps a missing final newline missing when the table was last', () => {
    expect(stripCodexServer(`model = "o3"\n\n\n[mcp_servers.termpolis]\ncommand = "${NODE}"`)).toEqual({ text: 'model = "o3"', changed: true })
  })

  it('empties a file that held only the server', () => {
    expect(stripCodexServer(lf(...SERVER_BLOCK, ...approval('memory_search')))).toEqual({ text: '', changed: true })
  })

  it('returns the text untouched when there is nothing to remove', () => {
    expect(stripCodexServer(USER_CONFIG)).toEqual({ text: USER_CONFIG, changed: false })
    const lookalikes = lf('[mcp_servers.termpolis-dev]', 'command = "node"', '', '[mcp_servers.termpolis_old]', 'command = "node"')
    expect(stripCodexServer(lookalikes)).toEqual({ text: lookalikes, changed: false })
  })

  it('is idempotent', () => {
    const once = edited(stripCodexServer(USER_CONFIG + lf('', ...SERVER_BLOCK)))
    expect(once).toEqual({ text: USER_CONFIG, changed: true })
    expect(stripCodexServer(once.text)).toEqual({ text: USER_CONFIG, changed: false })
  })

  it.each([
    ['LF', USER_CONFIG],
    ['CRLF', USER_CONFIG.replace(/\n/g, '\r\n')],
    ['a BOM', BOM + USER_CONFIG],
    ['no content at all', ''],
  ])('undoes a full connect exactly on a file with %s', (_name, original) => {
    const connected = approvalsText(addCodexToolApprovals(edited(upsertCodexServer(original, ELECTRON_SPEC)).text, CODEX_AUTO_APPROVED_TOOLS))
    expect(connected).not.toBe(original)
    expect(stripCodexServer(connected)).toEqual({ text: original, changed: true })
  })

  it('drops blank lines a file ended with, since they sat before the removed table', () => {
    const original = USER_CONFIG + '\n\n'
    const connected = edited(upsertCodexServer(original, SPEC)).text
    expect(connected).toBe(original + lf(...SERVER_BLOCK))
    expect(stripCodexServer(connected)).toEqual({ text: USER_CONFIG, changed: true })
  })
})

describe('addCodexToolApprovals', () => {
  it('pre-approves each memory tool in its own table after the server', () => {
    expect(CODEX_AUTO_APPROVED_TOOLS.length).toBeGreaterThan(0)
    expect(addCodexToolApprovals(lf(...SERVER_BLOCK), CODEX_AUTO_APPROVED_TOOLS)).toEqual({
      text: lf(...SERVER_BLOCK, ...CODEX_AUTO_APPROVED_TOOLS.flatMap(approval)),
      added: [...CODEX_AUTO_APPROVED_TOOLS],
    })
  })

  it('never overrides a setting the user (or Codex) already made for a tool', () => {
    const text = lf(
      ...SERVER_BLOCK,
      '',
      '[mcp_servers.termpolis.tools.memory_write]',
      'approval_mode = "approve"',
      '',
      '[mcp_servers.termpolis.tools.memory_correct]',
      'approval_mode = "prompt"  # ask me',
    )
    expect(addCodexToolApprovals(text, ['memory_search', 'memory_write', 'memory_correct']))
      .toEqual({ text: text + lf(...approval('memory_search')), added: ['memory_search'] })
  })

  it('counts a tool named only in a comment under the server as a choice already made', () => {
    const text = lf(...SERVER_BLOCK, '# memory_write: left unapproved on purpose')
    expect(addCodexToolApprovals(text, ['memory_search', 'memory_write'])).toEqual({
      text: lf(...SERVER_BLOCK, ...approval('memory_search'), '', '# memory_write: left unapproved on purpose'),
      added: ['memory_search'],
    })
  })

  it('matches whole tool names only, and only under this server', () => {
    const head = lf(
      ...SERVER_BLOCK,
      '',
      '[mcp_servers.termpolis.tools.memory_search_v2]',
      'approval_mode = "approve"',
      '',
      '[mcp_servers.termpolis.tools.xmemory_search]',
      'approval_mode = "approve"',
    )
    const tail = lf('', '[mcp_servers.github.tools.memory_search]', 'approval_mode = "approve"')
    expect(addCodexToolApprovals(head + tail, ['memory_search']))
      .toEqual({ text: head + lf(...approval('memory_search')) + tail, added: ['memory_search'] })
  })

  it('escapes regex characters in tool names and quotes names that are not bare keys', () => {
    const text = lf('[mcp_servers.termpolis]', 'command = "node"', 'args = ["/opt/axb.js"]')
    const first = approvalsText(addCodexToolApprovals(text, ['a.b']))
    expect(first).toBe(text + lf('', '[mcp_servers.termpolis.tools."a.b"]', 'approval_mode = "auto"'))
    expect(addCodexToolApprovals(first, ['a.b'])).toEqual({ text: first, added: [] })
  })

  it('returns the same text and adds nothing on a second run', () => {
    const once = approvalsText(addCodexToolApprovals(USER_CONFIG + lf('', ...SERVER_BLOCK), CODEX_AUTO_APPROVED_TOOLS))
    expect(addCodexToolApprovals(once, CODEX_AUTO_APPROVED_TOOLS)).toEqual({ text: once, added: [] })
  })

  it('separates the new tables from what follows by exactly one blank line', () => {
    const expected = lf(...SERVER_BLOCK, ...approval('memory_search'), '', '[mcp_servers.github]', 'command = "npx"')
    for (const text of [
      lf(...SERVER_BLOCK, '[mcp_servers.github]', 'command = "npx"'),
      lf(...SERVER_BLOCK, '', '[mcp_servers.github]', 'command = "npx"'),
    ]) {
      expect(addCodexToolApprovals(text, ['memory_search'])).toEqual({ text: expected, added: ['memory_search'] })
    }
  })

  it('goes after the last table under the server, wherever it sits', () => {
    const text = lf(...SERVER_BLOCK, '', '[tui]', 'notifications = true', '', '[mcp_servers.termpolis.tools.memory_list]', 'approval_mode = "approve"')
    expect(addCodexToolApprovals(text, ['memory_list', 'memory_search']))
      .toEqual({ text: text + lf(...approval('memory_search')), added: ['memory_search'] })
  })

  it('goes after the closing line of a last value that spans several lines', () => {
    const text = lf('[mcp_servers.termpolis]', `command = "${NODE}"`, 'args = [', `  "${ADAPTER}",`, ']')
    expect(addCodexToolApprovals(text, ['memory_search']))
      .toEqual({ text: text + lf(...approval('memory_search')), added: ['memory_search'] })
  })

  it('works under an empty server table and ends an unterminated last line', () => {
    expect(addCodexToolApprovals('[mcp_servers.termpolis]', ['memory_search']))
      .toEqual({ text: lf('[mcp_servers.termpolis]', ...approval('memory_search')), added: ['memory_search'] })
  })

  it('writes CRLF lines into a CRLF file', () => {
    expect(addCodexToolApprovals(crlf(...SERVER_BLOCK), ['memory_search']))
      .toEqual({ text: crlf(...SERVER_BLOCK, ...approval('memory_search')), added: ['memory_search'] })
  })

  it('refuses without a server table, or when approvals are set with a tools key inside it', () => {
    expect(addCodexToolApprovals(USER_CONFIG, ['memory_search'])).toEqual({ error: 'no [mcp_servers.termpolis] table' })
    for (const line of ['tools.memory_search.approval_mode = "approve"', 'tools = { memory_search = { approval_mode = "approve" } }']) {
      expect(addCodexToolApprovals(lf(...SERVER_BLOCK, line), ['memory_search']), line)
        .toEqual({ error: 'tool approvals are set with a tools key inside [mcp_servers.termpolis]' })
    }
  })
})

describe('connect and disconnect', () => {
  it('never changes the user\'s own approval settings', () => {
    const settings = lf('approval_policy = "never"', '', '[profiles.ci]', 'approval_policy = "untrusted"')
    const userApproval = lf('[mcp_servers.termpolis.tools.memory_write]', 'approval_mode = "approve"')
    const original = settings + lf('', '[mcp_servers.termpolis]', 'command = "/old/node"', 'args = ["/old/adapter.js"]', '') + userApproval

    // Updating the stale server touches only its command and args lines.
    const upserted = edited(upsertCodexServer(original, SPEC))
    expect(upserted.text).toBe(settings + lf('', ...SERVER_BLOCK, '') + userApproval)

    // The approvals leave the user's "approve" as it is and only add the other memory tools.
    const approved = addCodexToolApprovals(upserted.text, CODEX_AUTO_APPROVED_TOOLS)
    if ('error' in approved) throw new Error(approved.error)
    const others = CODEX_AUTO_APPROVED_TOOLS.filter((t) => t !== 'memory_write')
    expect(approved).toEqual({ text: upserted.text + lf(...others.flatMap(approval)), added: others })
    expect(approved.text.match(/approval_mode = "approve"/g)).toHaveLength(1)
    expect(codexConfigSets(approved.text, 'approval_policy')).toBe(true)
    // Disconnecting takes Termpolis's tables, approvals included, and leaves the policies as they were.
    expect(stripCodexServer(approved.text)).toEqual({ text: settings, changed: true })
  })
})

describe('codexConfigSets', () => {
  const CASES: Array<[string, string, string, boolean]> = [
    ['a top-level key', lf('developer_instructions = "Be brief"'), 'developer_instructions', true],
    ['a double-quoted top-level key', lf('"developer_instructions" = "Be brief"'), 'developer_instructions', true],
    ['a single-quoted top-level key', lf("'developer_instructions' = 'Be brief'"), 'developer_instructions', true],
    ['another top-level key', lf('model = "o3"'), 'developer_instructions', false],
    ['a top-level value that only mentions the key', lf('notes = "see developer_instructions"'), 'developer_instructions', false],
    ['a comment', lf('# developer_instructions = "x"'), 'developer_instructions', false],
    ['a [profiles.<name>] key', lf('[profiles.work]', 'developer_instructions = "x"'), 'developer_instructions', true],
    ['another key in a profile', lf('[profiles.work]', 'model = "o3"'), 'developer_instructions', false],
    ['a profile value that only mentions the key', lf('[profiles.work]', 'notes = "no developer_instructions here"'), 'developer_instructions', false],
    ['dotted profile keys', lf('profiles.work.developer_instructions = "x"'), 'developer_instructions', true],
    ['spaced dotted profile keys', lf('profiles . work . developer_instructions = "x"'), 'developer_instructions', true],
    ['an inline profile', lf('profiles.work = { developer_instructions = "x" }'), 'developer_instructions', true],
    ['an inline profile under [profiles]', lf('[profiles]', 'work = { developer_instructions = "x" }'), 'developer_instructions', true],
    ['an inline profile without it', lf('[profiles]', 'work = { model = "o3" }'), 'developer_instructions', false],
    ['an unrelated table', lf('[tui]', 'developer_instructions = "x"'), 'developer_instructions', false],
    ['a project table', lf('[projects."/home/me"]', 'developer_instructions = "x"'), 'developer_instructions', false],
    ['approval_policy at the top level', lf('approval_policy = "never"'), 'approval_policy', true],
    ['approval_policy in a profile', lf('[profiles.ci]', 'approval_policy = "never"'), 'approval_policy', true],
    ['approval_policy nowhere', USER_CONFIG.replace(/approval_policy/g, 'sandbox_note'), 'approval_policy', false],
  ]

  it.each(CASES)('sees %s', (_name, text, key, expected) => {
    expect(codexConfigSets(text, key)).toBe(expected)
  })
})

describe('codexTrustedProjects', () => {
  it('lists the trusted folders as the config spells them', () => {
    const text = lf(
      'model = "o3"',
      '',
      '[projects."/home/me/work/api"]',
      'trust_level = "trusted"',
      '',
      String.raw`[projects.'C:\Users\me\repo']`,
      'trust_level = "trusted"',
      '',
      String.raw`[projects."C:\\Users\\me\\app"]`,
      "trust_level = 'trusted'  # answered in Codex",
      '',
      '[projects.café]',
      'trust_level = "trusted"',
    )
    expect(codexTrustedProjects(text)).toEqual(['/home/me/work/api', 'C:\\Users\\me\\repo', 'C:\\Users\\me\\app', 'café'])
  })

  it('skips folders that are not plainly trusted and look-alikes outside [projects.<folder>]', () => {
    const text = lf(
      'trust_level = "trusted"',
      '',
      '[projects."/home/me/scratch"]',
      'trust_level = "untrusted"',
      '',
      '[projects."/home/me/notes"]',
      'model = "o3"',
      '',
      '[projects."/home/me/multi"]',
      'trust_level = """trusted"""',
      '',
      '[projects."/home/me/api".settings]',
      'trust_level = "trusted"',
      '',
      '[profiles."/home/me/api"]',
      'trust_level = "trusted"',
      '',
      '[[projects."/home/me/list"]]',
      'trust_level = "trusted"',
    )
    expect(codexTrustedProjects(text)).toEqual([])
  })
})

describe('stripCodexProjectTrust', () => {
  const PROJECTS = lf(
    'model = "o3"',
    '',
    '[projects."/home/me"]',
    'trust_level = "trusted"',
    '',
    '[projects."/home/me/api"]',
    'trust_level = "trusted"',
    'model = "o3-mini"',
    '',
    '[projects."/home/me/web"]',
    'trust_level = "trusted"',
  )

  it('removes a trust-only table whole, and just the trust line from a table that holds more', () => {
    expect(stripCodexProjectTrust(PROJECTS, (f) => f !== '/home/me/web')).toEqual({
      text: lf(
        'model = "o3"',
        '',
        '[projects."/home/me/api"]',
        'model = "o3-mini"',
        '',
        '[projects."/home/me/web"]',
        'trust_level = "trusted"',
      ),
      removed: ['/home/me', '/home/me/api'],
    })
  })

  it('removes a trusted table at the end of the file with the blank line before it', () => {
    expect(stripCodexProjectTrust(PROJECTS.replace(/\n/g, '\r\n'), (f) => f === '/home/me/web')).toEqual({
      text: crlf('model = "o3"', '', '[projects."/home/me"]', 'trust_level = "trusted"', '', '[projects."/home/me/api"]', 'trust_level = "trusted"', 'model = "o3-mini"'),
      removed: ['/home/me/web'],
    })
  })

  it('asks only about trusted folders, decoded, and leaves the text alone when it keeps them all', () => {
    const text = PROJECTS + lf('', String.raw`[projects."/home/me/caf\u00e9"]`, 'trust_level = "trusted"', '', '[projects."/tmp/x"]', 'trust_level = "untrusted"')
    const shouldRemove = vi.fn(() => false)
    expect(stripCodexProjectTrust(text, shouldRemove)).toEqual({ text, removed: [] })
    expect(shouldRemove.mock.calls).toEqual([['/home/me'], ['/home/me/api'], ['/home/me/web'], ['/home/me/café']])
  })

  it('withdraws exactly the home and drive-root trust the Termpolis caller targets', () => {
    const home = 'C:\\Users\\me'
    const text = lf(
      String.raw`[projects.'C:\Users\me']`,
      'trust_level = "trusted"',
      '',
      String.raw`[projects.'C:\']`,
      'trust_level = "trusted"',
      '',
      String.raw`[projects."\\\\?\\C:\\Users\\me"]`,
      'trust_level = "trusted"',
      '',
      String.raw`[projects.'C:\Users\me\repo']`,
      'trust_level = "trusted"',
    )
    expect(stripCodexProjectTrust(text, (f) => isUnsafeTrustRoot(f, home))).toEqual({
      text: lf(String.raw`[projects.'C:\Users\me\repo']`, 'trust_level = "trusted"'),
      removed: ['C:\\Users\\me', 'C:\\', '\\\\?\\C:\\Users\\me'],
    })
  })

  it('is not blocked by an MCP server shape the server edits refuse', () => {
    const text = lf('[mcp_servers.termpolis]', 'command = "a"', '', '[mcp_servers.termpolis]', 'command = "b"', '', '[projects."/home/me"]', 'trust_level = "trusted"')
    expect(stripCodexProjectTrust(text, () => true)).toEqual({
      text: lf('[mcp_servers.termpolis]', 'command = "a"', '', '[mcp_servers.termpolis]', 'command = "b"'),
      removed: ['/home/me'],
    })
  })
})

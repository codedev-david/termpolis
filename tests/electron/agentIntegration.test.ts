// Contract tests for src/shared/agentIntegration.ts — the rules main, preload and the renderer
// share when Termpolis wires itself into Claude Code, Codex and Gemini CLI.
//
// isShellSafeInstruction guards the text typed into a live shell as
// `codex -c "developer_instructions='…'"`, so a character it wrongly lets through is shell
// injection. isUnsafeTrustRoot guards the folder-trust writes, so a folder it wrongly calls safe
// ends up trusting every project under the home folder or a whole drive.
import { describe, it, expect } from 'vitest'
import {
  AGENT_INTEGRATION_IPC,
  AGENT_INTEGRATION_WRITES,
  CODEX_AUTO_APPROVED_TOOLS,
  CODEX_INSTRUCTION_MAX_CHARS,
  MCP_TOOLS_ASK,
  MCP_TOOLS_AUTO_ALLOWED,
  isShellSafeInstruction,
  isUnsafeTrustRoot,
  type AgentId,
} from '../../src/shared/agentIntegration'
import { CODEX_BASE_INSTRUCTION } from '../../src/main/codexParity'

const WIN_HOME = 'C:\\Users\\me'
const POSIX_HOME = '/home/me'

describe('isShellSafeInstruction', () => {
  const ALLOWED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;()_/-'

  it('accepts the instruction Termpolis actually sends Codex', () => {
    // If this ever fails, every Codex launch silently loses its memory instruction:
    // aiProfiles drops the -c flag for text that is not shell-safe.
    expect(isShellSafeInstruction(CODEX_BASE_INSTRUCTION)).toBe(true)
  })

  it('accepts letters, digits, spaces and . , : ; ( ) _ / -', () => {
    expect(isShellSafeInstruction(ALLOWED)).toBe(true)
    for (const ch of ALLOWED) expect(isShellSafeInstruction(`a${ch}b`), JSON.stringify(ch)).toBe(true)
  })

  it('rejects the characters bash, PowerShell, cmd or a TOML literal string would reinterpret', () => {
    const unsafe = [
      "'", '"', '$', '`', '%', '!', '&', '|', '<', '>', '^', // the documented set
      '\\', '*', '?', '#', '~', '{', '}', '[', ']', '=', '+', '@',
    ]
    for (const ch of unsafe) {
      expect(isShellSafeInstruction(`call memory_search ${ch} now`), JSON.stringify(ch)).toBe(false)
    }
    expect(isShellSafeInstruction("it's done")).toBe(false)
    expect(isShellSafeInstruction('$(rm -rf ~)')).toBe(false)
    expect(isShellSafeInstruction('a; Remove-Item -Recurse $HOME')).toBe(false)
    expect(isShellSafeInstruction('%USERPROFILE%')).toBe(false)
  })

  it('rejects anything that is not a single line', () => {
    for (const s of ['one\ntwo', 'one\rtwo', 'one\r\ntwo', 'one\ttwo', 'one\u000btwo', 'one\u000ctwo', 'nul\u0000byte']) {
      expect(isShellSafeInstruction(s), JSON.stringify(s)).toBe(false)
    }
    // A trailing newline would press Enter mid-command. JS `$` without the m flag does not
    // match before a final \n, which is what keeps this false.
    expect(isShellSafeInstruction('recall first\n')).toBe(false)
    expect(isShellSafeInstruction('\nrecall first')).toBe(false)
  })

  it('rejects non-ASCII, including the typographic quotes PowerShell treats as real quotes', () => {
    const lookalikes = [
      '\u2018', '\u2019', '\u201c', '\u201d', // ‘ ’ “ ” — PowerShell quote characters
      '\u00a0', // no-break space
      '\u2028', '\u2029', // line / paragraph separators
      '\u200b', // zero-width space
      '\u2013', '\u2014', '\u2026', // – — …
      '\u00e9', // é
      '\uff04', // fullwidth $
    ]
    for (const ch of lookalikes) {
      expect(isShellSafeInstruction(`call memory${ch}search`), JSON.stringify(ch)).toBe(false)
    }
  })

  it('rejects empty text and text longer than CODEX_INSTRUCTION_MAX_CHARS', () => {
    expect(isShellSafeInstruction('')).toBe(false)
    expect(isShellSafeInstruction('x'.repeat(CODEX_INSTRUCTION_MAX_CHARS))).toBe(true)
    expect(isShellSafeInstruction('x'.repeat(CODEX_INSTRUCTION_MAX_CHARS + 1))).toBe(false)
  })

  it('caps the instruction well inside the 8191-character cmd.exe command line', () => {
    const typed = `codex -c "developer_instructions='${'x'.repeat(CODEX_INSTRUCTION_MAX_CHARS)}'"`
    expect(CODEX_INSTRUCTION_MAX_CHARS).toBeGreaterThan(0)
    expect(typed.length).toBeLessThan(8191)
  })
})

describe('isUnsafeTrustRoot', () => {
  it('refuses a missing or blank folder', () => {
    for (const home of [WIN_HOME, POSIX_HOME, '']) {
      expect(isUnsafeTrustRoot('', home)).toBe(true)
      expect(isUnsafeTrustRoot('   ', home)).toBe(true)
      expect(isUnsafeTrustRoot('\t\n', home)).toBe(true)
      expect(isUnsafeTrustRoot(undefined as unknown as string, home)).toBe(true)
      expect(isUnsafeTrustRoot(null as unknown as string, home)).toBe(true)
    }
  })

  it('refuses the POSIX root, whatever the home folder', () => {
    for (const home of [POSIX_HOME, WIN_HOME, '']) {
      expect(isUnsafeTrustRoot('/', home)).toBe(true)
      expect(isUnsafeTrustRoot('  /  ', home)).toBe(true)
    }
  })

  it('refuses a Windows drive root in every spelling, whatever the home folder', () => {
    const roots = ['C:\\', 'C:/', 'c:', 'C:', 'c:\\', 'D:\\\\', 'Z:/', '  c:/  ', 'E:/\\/']
    for (const home of [WIN_HOME, POSIX_HOME, '']) {
      for (const root of roots) expect(isUnsafeTrustRoot(root, home), `${JSON.stringify(root)} home=${home}`).toBe(true)
    }
  })

  it('refuses a drive root written as a Win32 verbatim or device path', () => {
    for (const root of ['\\\\?\\C:\\', '\\\\?\\c:', '\\\\.\\D:\\', '//?/C:/', '//./c:']) {
      expect(isUnsafeTrustRoot(root, WIN_HOME), root).toBe(true)
      expect(isUnsafeTrustRoot(root, ''), root).toBe(true)
    }
  })

  it('refuses a UNC server or share root, in plain and verbatim spellings', () => {
    const shareRoots = [
      '\\\\server', '\\\\server\\', '\\\\server\\share', '\\\\server\\share\\', '\\\\server\\share\\\\',
      '//server/share', '//server/share/', '\\\\SERVER\\Share',
      '\\\\?\\UNC\\server\\share', '\\\\?\\unc\\srv\\share\\', '\\\\.\\UNC\\srv\\share',
    ]
    for (const home of [WIN_HOME, '']) {
      for (const root of shareRoots) expect(isUnsafeTrustRoot(root, home), `${root} home=${home}`).toBe(true)
    }
  })

  it('allows a folder inside a UNC share', () => {
    expect(isUnsafeTrustRoot('\\\\server\\share\\project', WIN_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('\\\\?\\UNC\\server\\share\\project', WIN_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('//server/share/project/', '')).toBe(false)
  })

  it('refuses the Windows home folder with trailing separators, mixed slashes and any case', () => {
    for (const p of [
      'C:\\Users\\me', 'C:\\Users\\me\\', 'C:\\Users\\me\\\\', 'C:/Users/me/', 'C:\\Users/me',
      'c:\\users\\ME', 'C:\\USERS\\ME\\', '  C:\\Users\\me  ', '\\\\?\\C:\\Users\\me',
    ]) {
      expect(isUnsafeTrustRoot(p, WIN_HOME), p).toBe(true)
    }
  })

  it('refuses home however the home folder itself is spelled', () => {
    for (const home of ['C:\\Users\\me\\', 'c:/users/me', 'C:\\USERS\\Me', '\\\\?\\C:\\Users\\me', '  C:\\Users\\me\\  ']) {
      expect(isUnsafeTrustRoot('C:\\Users\\me', home), home).toBe(true)
    }
  })

  it('refuses every folder above the home folder, since trust is inherited downward', () => {
    expect(isUnsafeTrustRoot('C:\\Users', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('c:/users/', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('C:\\Users', 'C:\\Users\\me\\OneDrive\\Home')).toBe(true)
    expect(isUnsafeTrustRoot('C:\\Users\\me', 'C:\\Users\\me\\OneDrive\\Home')).toBe(true)
    expect(isUnsafeTrustRoot('/home', POSIX_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('/home/', POSIX_HOME)).toBe(true)
  })

  it('refuses the POSIX home folder with trailing slashes', () => {
    for (const p of ['/home/me', '/home/me/', '/home/me//', '  /home/me  ']) {
      expect(isUnsafeTrustRoot(p, POSIX_HOME), p).toBe(true)
    }
    expect(isUnsafeTrustRoot('/home/me', '/home/me/')).toBe(true)
  })

  it('refuses a home folder that lives on a UNC share (roaming profile), in any case', () => {
    const home = '\\\\server\\share\\me'
    expect(isUnsafeTrustRoot('\\\\server\\share\\me', home)).toBe(true)
    expect(isUnsafeTrustRoot('\\\\SERVER\\Share\\ME\\', home)).toBe(true)
    expect(isUnsafeTrustRoot('\\\\server\\share\\me\\app', home)).toBe(false)
  })

  it('allows a project folder inside home', () => {
    expect(isUnsafeTrustRoot('C:\\Users\\me\\projects\\app', WIN_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('c:/users/me/projects/app/', WIN_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('\\\\?\\C:\\Users\\me\\app', WIN_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('/home/me/code/app', POSIX_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('/home/me/code/app/', POSIX_HOME)).toBe(false)
  })

  it('compares whole path segments, so a sibling sharing a prefix with home is not home', () => {
    expect(isUnsafeTrustRoot('C:\\Users\\me2', WIN_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('C:\\Users\\m', WIN_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('/home/me2', POSIX_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('/home/m', POSIX_HOME)).toBe(false)
  })

  it('allows folders on another drive or outside home', () => {
    expect(isUnsafeTrustRoot('D:\\Users\\me', WIN_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('D:\\work\\app', WIN_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('/opt/app', POSIX_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('/srv/me', POSIX_HOME)).toBe(false)
  })

  it('refuses only roots when the home folder is unknown', () => {
    for (const home of ['', '   ', undefined as unknown as string, null as unknown as string]) {
      expect(isUnsafeTrustRoot('C:\\', home)).toBe(true)
      expect(isUnsafeTrustRoot('/', home)).toBe(true)
      expect(isUnsafeTrustRoot('\\\\server\\share', home)).toBe(true)
      expect(isUnsafeTrustRoot('C:\\Users\\me', home)).toBe(false)
      expect(isUnsafeTrustRoot('/home/me', home)).toBe(false)
    }
  })

  it('refuses a relative path, which could name any folder', () => {
    expect(isUnsafeTrustRoot('me', POSIX_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('home/me', POSIX_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('Users\\me', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('project', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('.', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('C:project', WIN_HOME)).toBe(true) // drive-relative
  })

  it('resolves . and .. before comparing', () => {
    expect(isUnsafeTrustRoot('/home/me/..', POSIX_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('/home/me/./', POSIX_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('/home/me/proj/..', POSIX_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('/home/me/proj/../proj', POSIX_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('/home/../..', POSIX_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('C:\\Users\\..', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('C:\\Users\\me\\.', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('C:\\Users\\me\\repo\\..', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('\\\\server\\share\\team\\..', WIN_HOME)).toBe(true)
  })

  it('refuses a path made only of separators', () => {
    for (const home of [WIN_HOME, POSIX_HOME, '']) {
      for (const p of ['//', '\\\\', '\\\\?\\', '\\\\.\\', '\\\\?\\UNC\\', '///']) {
        expect(isUnsafeTrustRoot(p, home)).toBe(true)
      }
    }
  })

  it('treats a Windows name with trailing dots or spaces as the name without them', () => {
    expect(isUnsafeTrustRoot('C:\\Users\\me.', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('C:\\Users\\me \\', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('C:\\Users.\\me..', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('C:\\Users\\me\\repo.', WIN_HOME)).toBe(false)
    // POSIX keeps them: `/home/me.` is a different folder.
    expect(isUnsafeTrustRoot('/home/me.', POSIX_HOME)).toBe(false)
  })

  it('expands ~ to the home folder, and refuses it when home is unknown', () => {
    expect(isUnsafeTrustRoot('~', POSIX_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('~/', POSIX_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('~\\', WIN_HOME)).toBe(true)
    expect(isUnsafeTrustRoot('~/proj', POSIX_HOME)).toBe(false)
    expect(isUnsafeTrustRoot('~', '')).toBe(true)
    expect(isUnsafeTrustRoot('~/proj', null as unknown as string)).toBe(true)
    expect(isUnsafeTrustRoot('~proj', POSIX_HOME)).toBe(true) // another user's home, unresolvable
  })

  it('compares names without regard to case on every platform', () => {
    // macOS's default volume is case-insensitive, so /Users/Me is the home of /Users/me.
    expect(isUnsafeTrustRoot('/Users/Me', '/Users/me')).toBe(true)
    expect(isUnsafeTrustRoot('/USERS', '/Users/me')).toBe(true)
  })
})

describe('tool approval tables', () => {
  it('pre-approves only memory tools in Codex, and all of them come from the Claude allow list', () => {
    expect(CODEX_AUTO_APPROVED_TOOLS.length).toBeGreaterThan(0)
    for (const tool of CODEX_AUTO_APPROVED_TOOLS) {
      expect(tool.startsWith('memory_'), tool).toBe(true)
      expect(MCP_TOOLS_AUTO_ALLOWED, tool).toContain(tool)
    }
    expect([...CODEX_AUTO_APPROVED_TOOLS].sort()).toEqual(
      MCP_TOOLS_AUTO_ALLOWED.filter(t => t.startsWith('memory_')).sort(),
    )
  })

  it('never lists a tool as both auto-allowed and ask-first', () => {
    const both = MCP_TOOLS_AUTO_ALLOWED.filter(t => MCP_TOOLS_ASK.includes(t))
    expect(both).toEqual([])
  })

  it('lists each tool once, by its bare MCP name', () => {
    for (const list of [MCP_TOOLS_AUTO_ALLOWED, MCP_TOOLS_ASK, CODEX_AUTO_APPROVED_TOOLS]) {
      expect(new Set(list).size).toBe(list.length)
      // Callers add the `mcp__termpolis__` prefix themselves; a prefixed or mis-cased entry
      // would produce an allow-list rule that matches nothing.
      for (const tool of list) expect(tool, tool).toMatch(/^[a-z][a-z0-9_]*[a-z0-9]$/)
    }
  })
})

describe('AGENT_INTEGRATION_WRITES', () => {
  it('describes what connecting writes for each agent, and only for those agents', () => {
    const agents: AgentId[] = ['claude', 'codex', 'gemini']
    expect(Object.keys(AGENT_INTEGRATION_WRITES).sort()).toEqual([...agents].sort())
    for (const agent of agents) {
      const lines = AGENT_INTEGRATION_WRITES[agent]
      expect(lines.length, agent).toBeGreaterThan(0)
      for (const line of lines) expect(line.trim().length, `${agent}: ${JSON.stringify(line)}`).toBeGreaterThan(0)
    }
  })

  it('quotes tool counts that match the approval tables', () => {
    const claudeCount = AGENT_INTEGRATION_WRITES.claude.join('\n').match(/Lets (\d+) read-only and memory tools/)
    const codexCount = AGENT_INTEGRATION_WRITES.codex.join('\n').match(/Pre-approves the (\d+) memory tools/)
    expect(Number(claudeCount?.[1])).toBe(MCP_TOOLS_AUTO_ALLOWED.length)
    expect(Number(codexCount?.[1])).toBe(CODEX_AUTO_APPROVED_TOOLS.length)
  })
})

describe('AGENT_INTEGRATION_IPC', () => {
  it('gives every channel its own agents: name', () => {
    const channels = Object.values(AGENT_INTEGRATION_IPC)
    expect(channels.length).toBeGreaterThan(0)
    expect(new Set(channels).size).toBe(channels.length)
    for (const channel of channels) expect(channel).toMatch(/^agents:[a-z][a-z-]*$/)
  })
})

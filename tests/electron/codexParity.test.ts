import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import {
  AGENTS_BEGIN, AGENTS_END, stripAgentsMdBlock, cleanAgentsMd, CODEX_BASE_INSTRUCTION, buildCodexInstruction,
} from '../../src/main/codexParity'
import { addCodexToolApprovals } from '../../src/main/codexConfigEdit'
import {
  CODEX_AUTO_APPROVED_TOOLS, CODEX_INSTRUCTION_MAX_CHARS, isShellSafeInstruction,
} from '../../src/shared/agentIntegration'
import { buildInjectedInstruction } from '../../src/main/headroom/injectedInstruction'
import { steeringDirective } from '../../src/main/headroom/outputSteering'

// Earlier versions gave Codex its memory instruction by writing a managed block into
// <cwd>/AGENTS.md: a file in the user's repo that showed up in their diffs and was read by
// every other agent too. Codex now gets the instruction as a one-session command-line
// override (buildCodexInstruction), and cleanAgentsMd only ever takes an old block back OUT.

const BLOCK = `${AGENTS_BEGIN}\nTermpolis project memory: call memory_primer first.\n${AGENTS_END}`

describe('stripAgentsMdBlock', () => {
  it('leaves a file without a complete block unchanged', () => {
    expect(stripAgentsMdBlock('# My agents file\n\nBe nice.\n')).toEqual({ kind: 'unchanged' })
    expect(stripAgentsMdBlock('')).toEqual({ kind: 'unchanged' })
    // An END with no BEGIN before it, and a BEGIN with no END after it, cut nothing.
    expect(stripAgentsMdBlock(`# Mine\n${AGENTS_END}\n`)).toEqual({ kind: 'unchanged' })
    expect(stripAgentsMdBlock(`# Mine\n\n${AGENTS_BEGIN}\nhalf a block\n`)).toEqual({ kind: 'unchanged' })
    expect(stripAgentsMdBlock(`${AGENTS_END}\n${AGENTS_BEGIN}\n`)).toEqual({ kind: 'unchanged' })
  })

  it('asks for the file to be deleted when the block was all it held', () => {
    expect(stripAgentsMdBlock(`${BLOCK}\n`)).toEqual({ kind: 'file-deleted' })
    expect(stripAgentsMdBlock(`\n  \n${BLOCK}\r\n\t\n`)).toEqual({ kind: 'file-deleted' })
  })

  it('removes a block appended after the user\u2019s text, separator included', () => {
    expect(stripAgentsMdBlock(`# Mine\n\nnotes\n\n${BLOCK}\n`))
      .toEqual({ kind: 'block-removed', text: '# Mine\n\nnotes\n' })
    // Trailing whitespace after the block goes with it.
    expect(stripAgentsMdBlock(`# Mine\n\n${BLOCK}\n   \n`))
      .toEqual({ kind: 'block-removed', text: '# Mine\n' })
  })

  it('removes a block at the top and keeps what follows, without the blank lines between', () => {
    expect(stripAgentsMdBlock(`${BLOCK}\n\n  \n# Mine\nnotes\n`))
      .toEqual({ kind: 'block-removed', text: '# Mine\nnotes\n' })
  })

  it('removes a block between two parts of the file, leaving one blank line where it was', () => {
    expect(stripAgentsMdBlock(`# Top\n\n${BLOCK}\n\n# Bottom\n`))
      .toEqual({ kind: 'block-removed', text: '# Top\n\n# Bottom\n' })
  })

  it('keeps the file\u2019s CRLF line endings', () => {
    const crlfBlock = BLOCK.replace(/\n/g, '\r\n')
    expect(stripAgentsMdBlock(`# Mine\r\n\r\n${crlfBlock}\r\n`))
      .toEqual({ kind: 'block-removed', text: '# Mine\r\n' })
    expect(stripAgentsMdBlock(`# Top\r\n\r\n${crlfBlock}\r\n\r\n# Bottom\r\n`))
      .toEqual({ kind: 'block-removed', text: '# Top\r\n\r\n# Bottom\r\n' })
  })

  it('removes every block when more than one was written', () => {
    expect(stripAgentsMdBlock(`# A\n\n${BLOCK}\n\n# B\n\n${BLOCK}\n`))
      .toEqual({ kind: 'block-removed', text: '# A\n\n# B\n' })
    expect(stripAgentsMdBlock(`${BLOCK}\n\n${BLOCK}\n`)).toEqual({ kind: 'file-deleted' })
  })

  it('removes the complete blocks and stops at an unterminated one', () => {
    expect(stripAgentsMdBlock(`# A\n\n${BLOCK}\n\n${AGENTS_BEGIN}\nhalf a block\n`))
      .toEqual({ kind: 'block-removed', text: `# A\n\n${AGENTS_BEGIN}\nhalf a block\n` })
  })
})

describe('cleanAgentsMd', () => {
  let cwd: string
  let agentsPath: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cxp-'))
    agentsPath = path.join(cwd, 'AGENTS.md')
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('never creates AGENTS.md in a repo that has none', () => {
    expect(cleanAgentsMd(cwd)).toEqual({})
    expect(fs.existsSync(agentsPath)).toBe(false)
  })

  it('takes an old block back out and keeps everything the user wrote', () => {
    fs.writeFileSync(agentsPath, `# Team rules\n\nUse tabs.\n\n${BLOCK}\n`)
    expect(cleanAgentsMd(cwd)).toEqual({ cleaned: 'block-removed' })
    expect(fs.readFileSync(agentsPath, 'utf-8')).toBe('# Team rules\n\nUse tabs.\n')
  })

  it('deletes an AGENTS.md that only ever held the block', () => {
    fs.writeFileSync(agentsPath, `${BLOCK}\n`)
    expect(cleanAgentsMd(cwd)).toEqual({ cleaned: 'file-deleted' })
    expect(fs.existsSync(agentsPath)).toBe(false)
  })

  it('leaves a file with no block, or only half of one, byte-for-byte alone', () => {
    fs.writeFileSync(agentsPath, '# Team rules\r\nUse tabs.\r\n')
    expect(cleanAgentsMd(cwd)).toEqual({})
    expect(fs.readFileSync(agentsPath, 'utf-8')).toBe('# Team rules\r\nUse tabs.\r\n')

    const half = `# Team rules\n\n${AGENTS_BEGIN}\nhand-edited, END marker deleted\n`
    fs.writeFileSync(agentsPath, half)
    expect(cleanAgentsMd(cwd)).toEqual({})
    expect(fs.readFileSync(agentsPath, 'utf-8')).toBe(half)
  })

  it('reports an AGENTS.md it cannot read instead of throwing', () => {
    fs.mkdirSync(agentsPath)
    const res = cleanAgentsMd(cwd)
    expect(res.cleaned).toBeUndefined()
    expect(res.error).toBeTruthy()
  })

  it('does not read an implausibly large AGENTS.md', () => {
    fs.writeFileSync(agentsPath, BLOCK + '\n' + 'x'.repeat(4 * 1024 * 1024))
    const res = cleanAgentsMd(cwd)
    expect(res.error).toMatch(/larger than/)
    expect(fs.statSync(agentsPath).size).toBeGreaterThan(4 * 1024 * 1024)
  })

  it('reports a failed write and leaves the file as it was', () => {
    const original = `# Team rules\n\n${BLOCK}\n`
    fs.writeFileSync(agentsPath, original)
    // A directory squatting on the temp file the atomic write goes through.
    fs.mkdirSync(`${fs.realpathSync.native(agentsPath)}.termpolis-${process.pid}.tmp`)

    const res = cleanAgentsMd(cwd)
    expect(res.cleaned).toBeUndefined()
    expect(res.error).toBeTruthy()
    expect(fs.readFileSync(agentsPath, 'utf-8')).toBe(original)
  })
})

describe('buildCodexInstruction', () => {
  it('sends the memory instruction alone when output steering is off', () => {
    expect(buildCodexInstruction()).toBe(CODEX_BASE_INSTRUCTION)
    expect(buildCodexInstruction(null)).toBe(CODEX_BASE_INSTRUCTION)
    expect(buildCodexInstruction('')).toBe(CODEX_BASE_INSTRUCTION)
    expect(buildCodexInstruction(' \n\t ')).toBe(CODEX_BASE_INSTRUCTION)
  })

  it('appends the steering directive, flattened so it survives any shell', () => {
    const out = buildCodexInstruction('Be brief \u2013 skip the  "Here is\u2026" preamble \u2014 always.\n  Next line.')
    expect(out).toBe(`${CODEX_BASE_INSTRUCTION} Be brief - skip the Here is... preamble - always. Next line.`)
    expect(isShellSafeInstruction(out)).toBe(true)
  })

  it('drops a directive that would still break the shell, and keeps the memory part', () => {
    for (const bad of [
      "Don't pad.", 'Use $HOME.', 'Run `ls`.', '100% terse!', 'a & b', 'a | b', '<b>', 'x^2',
      '\u201Csmart quotes\u201D',
    ]) {
      expect(buildCodexInstruction(bad), bad).toBe(CODEX_BASE_INSTRUCTION)
    }
  })

  it('drops a directive that would push the command past its length limit', () => {
    const room = CODEX_INSTRUCTION_MAX_CHARS - CODEX_BASE_INSTRUCTION.length - 1
    expect(buildCodexInstruction('a'.repeat(room))).toHaveLength(CODEX_INSTRUCTION_MAX_CHARS)
    expect(buildCodexInstruction('a'.repeat(room + 1))).toBe(CODEX_BASE_INSTRUCTION)
  })

  it('delivers every output-steering mode Termpolis ships, rather than silently dropping one', () => {
    for (const mode of ['conservative', 'balanced', 'aggressive', 'max'] as const) {
      const out = buildCodexInstruction(steeringDirective(mode))
      expect(out, mode).not.toBe(CODEX_BASE_INSTRUCTION)
      expect(out.startsWith(CODEX_BASE_INSTRUCTION + ' '), mode).toBe(true)
      expect(isShellSafeInstruction(out), mode).toBe(true)
    }
  })

  it('the base instruction is shell-safe and asks only for tools Codex runs without a prompt', () => {
    expect(isShellSafeInstruction(CODEX_BASE_INSTRUCTION)).toBe(true)
    const tools = CODEX_BASE_INSTRUCTION.match(/\bmemory_[a-z_]+/g) ?? []
    expect(new Set(tools)).toEqual(new Set(['memory_primer', 'memory_search']))
    for (const tool of tools) expect(CODEX_AUTO_APPROVED_TOOLS, tool).toContain(tool)
  })

  it('carries the same obligations as the instruction Claude is launched with', () => {
    const claude = buildInjectedInstruction({ cwd: 'C:\\repos\\termpolis', steering: false }).toLowerCase()
    const codex = CODEX_BASE_INSTRUCTION.toLowerCase()
    for (const duty of ['memory_primer', 'memory_search', 'background', 'compacted', 'unavailable']) {
      expect(claude, duty).toContain(duty)
      expect(codex, duty).toContain(duty)
    }
  })
})

// Earlier versions flipped any approval the user had set on a Termpolis memory tool to
// "auto". Pre-approval now lives in codexConfigEdit and only fills in tools the user has
// not configured.
describe('Codex tool approvals — the user\u2019s own setting wins', () => {
  const CONFIG = [
    '[mcp_servers.termpolis]',
    'command = "node"',
    '',
    '[mcp_servers.termpolis.tools.memory_primer]',
    'approval_mode = "approve"',
    '',
  ].join('\n')

  it('keeps an "approve" the user chose instead of overriding it', () => {
    const res = addCodexToolApprovals(CONFIG, CODEX_AUTO_APPROVED_TOOLS)
    if ('error' in res) throw new Error(res.error)
    expect(res.added).not.toContain('memory_primer')
    expect(res.text).toContain('[mcp_servers.termpolis.tools.memory_primer]\napproval_mode = "approve"')
    expect(res.text.match(/approval_mode = "approve"/g)).toHaveLength(1)
  })

  it('pre-approves every other memory tool that had no setting', () => {
    const res = addCodexToolApprovals(CONFIG, CODEX_AUTO_APPROVED_TOOLS)
    if ('error' in res) throw new Error(res.error)
    expect(res.added).toEqual(CODEX_AUTO_APPROVED_TOOLS.filter((t) => t !== 'memory_primer'))
    for (const tool of res.added) {
      expect(res.text, tool).toContain(`[mcp_servers.termpolis.tools.${tool}]\napproval_mode = "auto"`)
    }
    // A second pass finds nothing left to add and rewrites nothing.
    const again = addCodexToolApprovals(res.text, CODEX_AUTO_APPROVED_TOOLS)
    expect(again).toEqual({ text: res.text, added: [] })
  })

  it('never pre-approves a tool that can touch the machine', () => {
    expect(CODEX_AUTO_APPROVED_TOOLS.length).toBeGreaterThan(0)
    expect(CODEX_AUTO_APPROVED_TOOLS.every((t) => t.startsWith('memory_'))).toBe(true)
    for (const tool of ['run_command', 'run_and_wait', 'write_to_terminal', 'create_terminal', 'close_terminal']) {
      expect(CODEX_AUTO_APPROVED_TOOLS).not.toContain(tool)
    }
  })
})

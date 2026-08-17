import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import {
  AGENTS_BEGIN, AGENTS_END, buildAgentsBlock, mergeAgentsMd, writeAgentsMd,
  CODEX_AUTO_APPROVED_TOOLS, CODEX_AUTO, ensureCodexMemoryAutoApproved,
} from '../../src/main/codexParity'
import { buildInjectedInstruction } from '../../src/main/headroom/injectedInstruction'

const OPTS = { cwd: 'C:\\repos\\termpolis', steering: false } as const
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cxp-'))

describe('AGENTS.md memory block', () => {
  it('carries the exact instruction Claude is launched with', () => {
    // Parity is not "similar wording" — it is the same bytes from the same builder. Two
    // hand-maintained copies of this text would drift on the first edit to either one.
    expect(buildAgentsBlock(OPTS)).toContain(buildInjectedInstruction(OPTS))
  })

  it('is byte-stable across calls', () => {
    expect(buildAgentsBlock(OPTS)).toBe(buildAgentsBlock(OPTS))
  })
})

describe('mergeAgentsMd', () => {
  const block = buildAgentsBlock(OPTS)

  it('creates the whole file when there is nothing to merge into', () => {
    expect(mergeAgentsMd('', block).trim()).toBe(block)
  })

  it('keeps every line the user wrote outside the markers', () => {
    const user = '# House rules\n\nAlways run the linter.\n'
    const out = mergeAgentsMd(user + '\n' + block + '\n', block)
    expect(out).toContain('# House rules')
    expect(out).toContain('Always run the linter.')
  })

  it('replaces a stale managed span instead of stacking a second one', () => {
    const stale = `${AGENTS_BEGIN}\nold text\n${AGENTS_END}`
    const out = mergeAgentsMd(`intro\n\n${stale}\n\noutro\n`, block)
    expect(out).not.toContain('old text')
    expect(out.split(AGENTS_BEGIN).length - 1).toBe(1)
    expect(out).toContain('outro')
  })

  it('is idempotent — re-merging the same block changes nothing', () => {
    const once = mergeAgentsMd('notes\n', block)
    expect(mergeAgentsMd(once, block)).toBe(once)
  })
})

describe('writeAgentsMd', () => {
  it('creates AGENTS.md, then reports no change on a second pass', () => {
    const dir = tmp()
    expect(writeAgentsMd(dir, OPTS).changed).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain(AGENTS_BEGIN)
    // Byte-stable content is the point: this file is usually tracked in git, and a launcher that
    // dirtied the working tree on every terminal open would be uninstalled within a day.
    expect(writeAgentsMd(dir, OPTS).changed).toBe(false)
  })

  it('reports read-failed instead of throwing when AGENTS.md is unreadable', () => {
    // A directory named AGENTS.md: exists, cannot be read. Contrived, but it is the same
    // code path as a permission-denied file, and it fails identically on every platform.
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'AGENTS.md'))
    const r = writeAgentsMd(dir, OPTS)
    expect(r.changed).toBe(false)
    expect(r.skipped).toBe('read-failed')
    expect(r.error).toBeTruthy()
  })

  it('reports write-failed instead of throwing when the directory is gone', () => {
    const r = writeAgentsMd(path.join(tmp(), 'no-such-dir'), OPTS)
    expect(r.changed).toBe(false)
    expect(r.skipped).toBe('write-failed')
    expect(r.error).toBeTruthy()
  })
})

describe('ensureCodexMemoryAutoApproved', () => {
  const write = (body: string): string => {
    const p = path.join(tmp(), 'config.toml')
    fs.writeFileSync(p, body, 'utf8')
    return p
  }

  it('flips an existing "approve" override to "auto"', () => {
    // This is the real config Codex wrote for David: a prompt on memory_primer, which is the one
    // call the whole parity story depends on landing silently at session start.
    const p = write('[mcp_servers.termpolis.tools.memory_primer]\napproval_mode = "approve"\n')
    const r = ensureCodexMemoryAutoApproved(p)
    expect(r.changed).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toContain('approval_mode = "auto"')
    expect(fs.readFileSync(p, 'utf8')).not.toContain('"approve"')
  })

  it('adds a stanza for every memory tool that had none', () => {
    const p = write('[mcp_servers.termpolis]\ncommand = "node"\n')
    const r = ensureCodexMemoryAutoApproved(p)
    expect(r.tools.sort()).toEqual([...CODEX_AUTO_APPROVED_TOOLS].sort())
    const out = fs.readFileSync(p, 'utf8')
    for (const t of CODEX_AUTO_APPROVED_TOOLS) expect(out).toContain(`tools.${t}]`)
  })

  it('never auto-approves a tool that can touch the machine', () => {
    // Parity is about memory, not about handing Codex an unprompted shell.
    expect(CODEX_AUTO_APPROVED_TOOLS).not.toContain('run_command')
    expect(CODEX_AUTO_APPROVED_TOOLS).not.toContain('write_to_terminal')
    const p = write('[mcp_servers.termpolis]\ncommand = "node"\n')
    ensureCodexMemoryAutoApproved(p)
    expect(fs.readFileSync(p, 'utf8')).not.toContain('run_command')
  })

  it('is idempotent — a second pass rewrites nothing', () => {
    const p = write('[mcp_servers.termpolis]\ncommand = "node"\n')
    ensureCodexMemoryAutoApproved(p)
    const after = fs.readFileSync(p, 'utf8')
    expect(ensureCodexMemoryAutoApproved(p).changed).toBe(false)
    expect(fs.readFileSync(p, 'utf8')).toBe(after)
  })

  it('leaves an unrelated config untouched and skips a missing file', () => {
    const p = write('[mcp_servers.other]\ncommand = "x"\n')
    const before = fs.readFileSync(p, 'utf8')
    ensureCodexMemoryAutoApproved(p)
    expect(fs.readFileSync(p, 'utf8')).toContain(before)
    expect(ensureCodexMemoryAutoApproved(path.join(tmp(), 'nope.toml')).skipped).toBe('missing')
  })

  it('adds approval_mode to a tool stanza that exists but never had the key', () => {
    // Codex writes the stanza header the first time a tool is seen and only adds
    // approval_mode once the user answers a prompt — so a header with no key is the
    // normal state of a fresh install, not an edge case.
    const tool = CODEX_AUTO_APPROVED_TOOLS[0]
    const p = write(`[mcp_servers.termpolis.tools.${tool}]\ndescription = "x"\n\n[other]\nk = 1\n`)
    const r = ensureCodexMemoryAutoApproved(p)
    expect(r.changed).toBe(true)
    expect(r.tools).toContain(tool)
    const after = fs.readFileSync(p, 'utf8')
    expect(after).toContain(`approval_mode = "${CODEX_AUTO}"`)
    // The neighbouring stanza must survive: the rewrite is bounded by the next header.
    expect(after).toContain('[other]')
    expect(after).toContain('k = 1')
  })

  it('reports corrupt rather than throwing when the config cannot be read', () => {
    const p = path.join(tmp(), 'config.toml')
    fs.mkdirSync(p)
    const r = ensureCodexMemoryAutoApproved(p)
    expect(r.changed).toBe(false)
    expect(r.skipped).toBe('corrupt')
    expect(r.error).toBeTruthy()
  })

  it('reports write-failed instead of throwing when the config is read-only', () => {
    // Read succeeds, a change is genuinely needed, the write is refused. A user who has
    // locked their Codex config should get a diagnosable skip, not a crashed launch.
    const tool = CODEX_AUTO_APPROVED_TOOLS[0]
    const p = write(`[mcp_servers.termpolis.tools.${tool}]\napproval_mode = "approve"\n`)
    fs.chmodSync(p, 0o444)
    const r = ensureCodexMemoryAutoApproved(p)
    fs.chmodSync(p, 0o644)
    // Root ignores mode 0444, so a container running tests as root writes through and there is
    // no failure to observe. Assert the behaviour that actually occurred rather than pretending
    // the environment is something it is not — a test that lies about its platform is worse
    // than one that admits it only proves the failure path where the platform allows it.
    if (r.skipped) {
      expect(r.changed).toBe(false)
      expect(r.skipped).toBe('write-failed')
      expect(r.error).toBeTruthy()
    } else {
      expect(r.changed).toBe(true)
    }
  })
})

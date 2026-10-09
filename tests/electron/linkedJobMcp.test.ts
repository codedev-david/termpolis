// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLinkedJobMcp } from '../../src/main/linkedJobMcp'

const ENTRY = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\app\\resources\\mcp-adapter\\stdio-adapter.cjs'] }
const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tp-linked-mcp-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('linkedJobMcp: per-run MCP plumbing for a Linked machines job', () => {
  it('writes claude a config holding only Termpolis\'s server, the job marked in its env, and removes it after', () => {
    const dir = tempDir()
    const mcp = createLinkedJobMcp({ serverEntry: () => ENTRY, codexHasTermpolis: () => false, tempDir: () => dir })('0a1b2c3d4e5f', 'claude')
    expect(mcp?.claudeMcpConfig).toBe(join(dir, 'termpolis-linked-0a1b2c3d4e5f.mcp.json'))
    expect(JSON.parse(readFileSync(mcp!.claudeMcpConfig!, 'utf8'))).toEqual({
      mcpServers: { termpolis: { type: 'stdio', ...ENTRY, env: { TERMPOLIS_LINKED_JOB: '0a1b2c3d4e5f' } } },
    })
    mcp!.dispose!()
    expect(existsSync(mcp!.claudeMcpConfig!)).toBe(false)
    // A second dispose finds nothing and says nothing.
    expect(() => mcp!.dispose!()).not.toThrow()
  })

  it('keeps the runner\'s own env alongside the marker (the Electron fallback runner)', () => {
    const writeFile = vi.fn()
    const mcp = createLinkedJobMcp({
      serverEntry: () => ({ ...ENTRY, env: { ELECTRON_RUN_AS_NODE: '1' } }),
      codexHasTermpolis: () => false,
      tempDir: () => '/tmp',
      writeFile,
      unlink: vi.fn(),
    })('job1', 'claude')
    expect(mcp?.claudeMcpConfig).toBe(join('/tmp', 'termpolis-linked-job1.mcp.json'))
    expect(JSON.parse(writeFile.mock.calls[0][1]).mcpServers.termpolis.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', TERMPOLIS_LINKED_JOB: 'job1' })
  })

  it('gives claude nothing when the server entry can\'t be built, or the id isn\'t a plain job id', () => {
    const writeFile = vi.fn()
    const base = { codexHasTermpolis: () => true, tempDir: () => '/tmp', writeFile }
    expect(createLinkedJobMcp({ ...base, serverEntry: () => null })('job1', 'claude')).toBeNull()
    for (const id of ['../escape', 'A B', '', 'x'.repeat(65)]) {
      expect(createLinkedJobMcp({ ...base, serverEntry: () => ENTRY })(id, 'claude')).toBeNull()
    }
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('tells codex whether its config holds Termpolis\'s own server, and writes nothing for it', () => {
    const writeFile = vi.fn()
    const make = (has: boolean) => createLinkedJobMcp({ serverEntry: () => ENTRY, codexHasTermpolis: () => has, tempDir: () => '/tmp', writeFile })
    expect(make(true)('job1', 'codex')).toEqual({ codexHasTermpolis: true })
    expect(make(false)('job1', 'codex')).toBeNull()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('needs nothing for agy, which passes the marker to its MCP servers itself', () => {
    const serverEntry = vi.fn(() => ENTRY)
    expect(createLinkedJobMcp({ serverEntry, codexHasTermpolis: () => true, tempDir: () => '/tmp' })('job1', 'gemini')).toBeNull()
    expect(serverEntry).not.toHaveBeenCalled()
  })
})

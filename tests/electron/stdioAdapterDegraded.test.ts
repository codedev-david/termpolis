/**
 * stdio-adapter.cjs — degraded-mode behavior (subprocess test)
 * ------------------------------------------------------------
 * Spawns the real adapter with an isolated HOME / APPDATA so the token
 * file is guaranteed absent, sends MCP requests over stdin, and verifies
 * the responses. This is the runtime side of the regex contract tests in
 * stdioAdapterContract.test.ts — together they cover the issue chan-yuu
 * reported: Gemini CLI used to surface a hard "MCP server crashed" error
 * whenever Termpolis wasn't running, blocking all CLI use.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const ADAPTER = resolve(__dirname, '..', '..', 'src/mcp-adapter/stdio-adapter.cjs')

// Spawn the adapter with HOME/APPDATA pointed at an empty tmp dir so the
// token file cannot be found — guaranteed degraded-mode entry.
async function runAdapterDegraded(requests: object[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const tmpHome = mkdtempSync(join(tmpdir(), 'termpolis-adapter-test-'))
  try {
    const child = spawn(process.execPath, [ADAPTER], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        APPDATA: tmpHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + '\n')
    }
    // Give the adapter a moment to process each line, then close stdin
    // so the readline 'close' handler exits the process.
    await new Promise((r) => setTimeout(r, 250))
    child.stdin.end()

    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve(null)
      }, 5000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    return { stdout, stderr, exitCode }
  } finally {
    rmSync(tmpHome, { recursive: true, force: true })
  }
}

function parseLines(stdout: string): any[] {
  return stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

describe('stdio-adapter.cjs degraded mode — subprocess', () => {
  it('does NOT exit when the token file is missing (must stay alive for the agent)', async () => {
    const { exitCode, stderr } = await runAdapterDegraded([])
    // Adapter should exit cleanly when stdin closes, with code 0 — not crash on missing token.
    expect(exitCode).toBe(0)
    // Should emit a diagnostic so a human investigating can see why it went degraded.
    expect(stderr.toLowerCase()).toContain('degraded')
  })

  it('responds to initialize with a real result so the host treats the server as healthy', async () => {
    const { stdout } = await runAdapterDegraded([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    ])
    const lines = parseLines(stdout)
    expect(lines.length).toBeGreaterThan(0)
    const init = lines[0]
    expect(init.id).toBe(1)
    expect(init.error).toBeUndefined()
    expect(init.result?.protocolVersion).toBeTruthy()
    expect(init.result?.serverInfo?.name).toBe('termpolis')
  })

  it('returns an empty tools list so the agent does not call any Termpolis tools', async () => {
    const { stdout } = await runAdapterDegraded([
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
    const lines = parseLines(stdout)
    const resp = lines.find((l) => l.id === 2)
    expect(resp).toBeDefined()
    expect(resp.result?.tools).toEqual([])
  })

  it('returns a friendly JSON-RPC error on tools/call mentioning Termpolis', async () => {
    const { stdout } = await runAdapterDegraded([
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whatever', arguments: {} } },
    ])
    const lines = parseLines(stdout)
    const resp = lines.find((l) => l.id === 3)
    expect(resp).toBeDefined()
    expect(resp.error).toBeDefined()
    expect(resp.error.message).toMatch(/Termpolis/i)
  })

  it('silently drops MCP notifications without replying', async () => {
    const { stdout } = await runAdapterDegraded([
      { jsonrpc: '2.0', method: 'notifications/initialized' }, // no id
    ])
    const lines = parseLines(stdout)
    expect(lines).toEqual([]) // no response expected
  })
})

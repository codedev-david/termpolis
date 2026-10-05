// @vitest-environment node
//
// `termpolis-cli exec`, run for real against a fake MCP server on 127.0.0.1. The CLI finds the
// server through its data dir (mcp-token, mcp-port), which follows APPDATA / XDG_CONFIG_HOME /
// HOME, so a temp folder stands in for it and nothing reaches a running Termpolis.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const CLI = resolve(__dirname, '..', '..', 'src', 'mcp-adapter', 'termpolis-cli.cjs')

let home = ''
let shell = ''
let server: Server
let reply: (args: Record<string, unknown>) => unknown = () => ({})
const received: Array<{ name: string; arguments: Record<string, unknown> }> = []

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tp-cli-exec-'))
  shell = join(home, 'shell')
  mkdirSync(join(shell, 'sub'), { recursive: true })
  server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      const body = JSON.parse(data) as { id: number; params: { name: string; arguments: Record<string, unknown> } }
      received.push(body.params)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: reply(body.params.arguments) }))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  // dataDir.cjs's per-platform layout, under the temp home.
  const dataDir = process.platform === 'win32'
    ? join(home, 'termpolis')
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'termpolis') : join(home, 'termpolis')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'mcp-token'), 'test-token')
  writeFileSync(join(dataDir, 'mcp-port'), String((server.address() as AddressInfo).port))
})

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()))
  rmSync(home, { recursive: true, force: true })
})

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: shell,
      env: { ...process.env, APPDATA: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

describe('termpolis-cli exec', () => {
  it('sends a relative --cwd resolved against the shell it was typed in', async () => {
    // The app refuses a relative cwd: there it would mean the app's own folder.
    reply = () => text(JSON.stringify({ ok: true, output: 'done', code: 0 }))
    const r = await runCli(['exec', '--cwd', 'sub', 'summarise the repo'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('done')
    const call = received.at(-1)!
    expect(call.name).toBe('agent_exec')
    const cwd = call.arguments.cwd as string
    expect(isAbsolute(cwd)).toBe(true)
    expect([basename(dirname(cwd)), basename(cwd)]).toEqual(['shell', 'sub'])
  }, 30_000)

  it('sends the shell\'s own folder when there is no --cwd', async () => {
    reply = () => text(JSON.stringify({ ok: true, output: 'done', code: 0 }))
    const r = await runCli(['exec', 'summarise the repo'])
    expect(r.code, r.stderr).toBe(0)
    const cwd = received.at(-1)!.arguments.cwd as string
    expect(isAbsolute(cwd)).toBe(true)
    expect(basename(cwd)).toBe('shell')
  }, 30_000)

  it('prints a tool error and exits 1, rather than failing to parse it as a result', async () => {
    reply = () => text('Error: Invalid agent: expected claude, codex or gemini', true)
    const r = await runCli(['exec', '--agent', 'agy', 'summarise the repo'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Error: Invalid agent: expected claude, codex or gemini')
    expect(r.stderr).not.toMatch(/JSON|Unexpected token/)
  }, 30_000)
})

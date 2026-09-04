import { describe, it, expect, vi } from 'vitest'
import { RequestDispatcher } from '../../src/main/remoteBridge/dispatcher'
import { CapabilityError } from '../../src/main/remoteBridge/remotePolicy'
import { NO_CAPABILITIES, type Capabilities, type RemoteRequest } from '../../src/main/remoteBridge/protocol'

const all: Capabilities = { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true }
const fakeMcp = () => ({ callTool: vi.fn().mockResolvedValue({ ok: true }) })

describe('RequestDispatcher', () => {
  it('maps listTerminals to the list_terminals tool', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'listTerminals' }, all)
    expect(mcp.callTool).toHaveBeenCalledWith('list_terminals', {})
  })

  it('maps createTerminal with its arguments', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'createTerminal', name: 'agent-1', cwd: '/repo' }, all)
    expect(mcp.callTool).toHaveBeenCalledWith('create_terminal', { name: 'agent-1', cwd: '/repo' })
  })

  it('maps writeToTerminal', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'hi' }, all)
    expect(mcp.callTool).toHaveBeenCalledWith('write_to_terminal', { terminalId: 't1', text: 'hi' })
  })

  it('refuses a request the device lacks capability for, without touching MCP', async () => {
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    await expect(d.dispatch({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, NO_CAPABILITIES))
      .rejects.toThrow(CapabilityError)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('checks capability BEFORE dispatching, for every request kind', async () => {
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    const readOnly: Capabilities = { ...NO_CAPABILITIES, read: true }
    await expect(d.dispatch({ kind: 'createTerminal', name: 'x' }, readOnly)).rejects.toThrow(CapabilityError)
    await expect(d.dispatch({ kind: 'closeTerminal', terminalId: 't' }, readOnly)).rejects.toThrow(CapabilityError)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('handles subscribe/unsubscribe locally without calling MCP', async () => {
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    await d.dispatch({ kind: 'subscribe', terminalId: 't1' }, all)
    await d.dispatch({ kind: 'unsubscribe', terminalId: 't1' }, all)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('propagates an MCP failure rather than swallowing it', async () => {
    const mcp = { callTool: vi.fn().mockRejectedValue(new Error('mcp down')) }
    await expect(new RequestDispatcher(mcp).dispatch({ kind: 'listTerminals' }, all))
      .rejects.toThrow(/mcp down/)
  })
})

describe('RequestDispatcher — input outside the union', () => {
  it('refuses an unrecognised request kind without touching MCP', async () => {
    // The switch has no default because TypeScript proves it exhaustive. That
    // holds only because assertAllowed rejects unknown kinds FIRST -- this test
    // pins the ordering those two facts depend on. Drop the guard and the switch
    // falls through to `undefined`, which the phone would read as a success.
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    const bogus = { kind: 'sudoEverything' } as unknown as RemoteRequest

    await expect(d.dispatch(bogus, all)).rejects.toThrow(/unrecognised request kind/)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })
})

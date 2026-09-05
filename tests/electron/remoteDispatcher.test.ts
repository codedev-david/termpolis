import { describe, it, expect, vi } from 'vitest'
import { RequestDispatcher } from '../../src/main/remoteBridge/dispatcher'
import { CapabilityError } from '../../src/main/remoteBridge/remotePolicy'
import { NO_CAPABILITIES, type Capabilities, type RemoteRequest } from '../../src/main/remoteBridge/protocol'

const all: Capabilities = { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true }
const fakeMcp = () => ({ callTool: vi.fn().mockResolvedValue({ ok: true }) })

/** A device id of the shape `pairing.ts` mints: sixteen lowercase hex. The MCP
 *  server validates it before writing it to the audit trail, so a placeholder
 *  like 'phone' here would pass the dispatcher and be silently dropped there. */
const DEVICE = 'a1b2c3d4e5f60718'

describe('RequestDispatcher', () => {
  it('maps listTerminals to the list_terminals tool', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'listTerminals' }, all, DEVICE)
    expect(mcp.callTool).toHaveBeenCalledWith('list_terminals', {}, DEVICE)
  })

  it('maps createTerminal with its arguments', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'createTerminal', name: 'agent-1', cwd: '/repo' }, all, DEVICE)
    expect(mcp.callTool).toHaveBeenCalledWith('create_terminal', { name: 'agent-1', cwd: '/repo' }, DEVICE)
  })

  it('maps writeToTerminal', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'hi' }, all, DEVICE)
    expect(mcp.callTool).toHaveBeenCalledWith('write_to_terminal', { terminalId: 't1', text: 'hi' }, DEVICE)
  })

  it('refuses a request the device lacks capability for, without touching MCP', async () => {
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    await expect(d.dispatch({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, NO_CAPABILITIES, DEVICE))
      .rejects.toThrow(CapabilityError)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('checks capability BEFORE dispatching, for every request kind', async () => {
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    const readOnly: Capabilities = { ...NO_CAPABILITIES, read: true }
    await expect(d.dispatch({ kind: 'createTerminal', name: 'x' }, readOnly, DEVICE)).rejects.toThrow(CapabilityError)
    await expect(d.dispatch({ kind: 'closeTerminal', terminalId: 't' }, readOnly, DEVICE)).rejects.toThrow(CapabilityError)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('handles subscribe/unsubscribe locally without calling MCP', async () => {
    const mcp = fakeMcp()
    const d = new RequestDispatcher(mcp)
    await d.dispatch({ kind: 'subscribe', terminalId: 't1' }, all, DEVICE)
    await d.dispatch({ kind: 'unsubscribe', terminalId: 't1' }, all, DEVICE)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('propagates an MCP failure rather than swallowing it', async () => {
    const mcp = { callTool: vi.fn().mockRejectedValue(new Error('mcp down')) }
    await expect(new RequestDispatcher(mcp).dispatch({ kind: 'listTerminals' }, all, DEVICE))
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

    await expect(d.dispatch(bogus, all, DEVICE)).rejects.toThrow(/unrecognised request kind/)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('maps runCommand to run_command', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'runCommand', terminalId: 't1', command: 'ls' }, all, DEVICE)
    expect(mcp.callTool).toHaveBeenCalledWith('run_command', { terminalId: 't1', command: 'ls' }, DEVICE)
  })

  it('maps closeTerminal to close_terminal', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'closeTerminal', terminalId: 't1' }, all, DEVICE)
    expect(mcp.callTool).toHaveBeenCalledWith('close_terminal', { terminalId: 't1' }, DEVICE)
  })

  // The cwd arm matters on its own: MCP's create_terminal treats an EXPLICIT
  // `cwd: undefined` differently from an absent key, so spreading the key in
  // unconditionally would silently change where remote terminals open.
  it('omits cwd entirely when the phone did not send one', async () => {
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'createTerminal', name: 'agent' }, all, DEVICE)
    const args = mcp.callTool.mock.calls[0][1] as Record<string, unknown>
    expect('cwd' in args).toBe(false)
  })

  // The bridge answers getCapabilities before the dispatcher ever sees it. If one
  // reaches here anyway the dispatcher must refuse it, not reach for a tool that
  // does not exist -- an ungranted kind arriving at MCP is the failure the whole
  // capability model exists to prevent.
  it('refuses getCapabilities even with every capability granted', async () => {
    const mcp = fakeMcp()
    await expect(
      new RequestDispatcher(mcp).dispatch({ kind: 'getCapabilities' }, all, DEVICE),
    ).rejects.toThrow(CapabilityError)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })
})

describe('RequestDispatcher — who asked', () => {
  it('tags every MCP-bound request with the originating device', async () => {
    // Spec section 4.4: "audit entries are tagged with the originating device".
    // The tag is applied at the call, so a request kind added later without it
    // produces an audit line that cannot name the phone that caused it -- and
    // nothing else in the system would notice. Enumerating the kinds here is
    // what makes that a failing test rather than a silent gap.
    const acting: RemoteRequest[] = [
      { kind: 'listTerminals' },
      { kind: 'createTerminal', name: 'agent' },
      { kind: 'runCommand', terminalId: 't1', command: 'ls' },
      { kind: 'writeToTerminal', terminalId: 't1', text: 'hi' },
      { kind: 'closeTerminal', terminalId: 't1' },
    ]

    for (const request of acting) {
      const mcp = fakeMcp()
      await new RequestDispatcher(mcp).dispatch(request, all, DEVICE)
      expect(mcp.callTool).toHaveBeenCalledTimes(1)
      expect(mcp.callTool.mock.calls[0][2]).toBe(DEVICE)
    }
  })

  it('passes the id through untouched rather than deriving anything from it', async () => {
    // The dispatcher is not the component that decides whether an id is real --
    // `handleRemoteRequest` already resolved it against the registry, and the MCP
    // server validates the shape again before it writes it down. Rewriting it
    // here would put a third opinion between those two.
    const mcp = fakeMcp()
    await new RequestDispatcher(mcp).dispatch({ kind: 'listTerminals' }, all, 'ffffffffffffffff')
    expect(mcp.callTool.mock.calls[0][2]).toBe('ffffffffffffffff')
  })
})

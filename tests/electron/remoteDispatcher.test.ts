import { describe, it, expect, vi } from 'vitest'
import { RequestDispatcher, SUBMIT_SETTLE_MS } from '../../src/main/remoteBridge/dispatcher'
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

describe('RequestDispatcher — typing, then Enter', () => {
  /** Records the pauses instead of taking them, so the suite does not sleep. */
  const fakeSettle = () => {
    const slept: number[] = []
    return { slept, settle: async (ms: number) => { slept.push(ms) } }
  }

  it('sends the carriage return as a separate write from the message', async () => {
    // The whole point of the dispatcher's SUBMIT_SETTLE_MS comment: fused into
    // one write, Codex reads `hello\r` as a single pasted burst and leaves it in
    // the composer unsent. Two writes are two stdin reads, which is what a
    // person typing looks like. Asserting the CALL COUNT is what pins that -- an
    // "optimisation" back to a single call is the bug returning.
    const mcp = fakeMcp()
    const { settle } = fakeSettle()
    await new RequestDispatcher(mcp, settle)
      .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'hello\r' }, all, DEVICE)

    expect(mcp.callTool).toHaveBeenCalledTimes(2)
    expect(mcp.callTool).toHaveBeenNthCalledWith(1, 'write_to_terminal', { terminalId: 't1', text: 'hello' }, DEVICE)
    expect(mcp.callTool).toHaveBeenNthCalledWith(2, 'write_to_terminal', { terminalId: 't1', text: '\r' }, DEVICE)
  })

  it('waits between the two, and does not press Enter before the text has been sent', async () => {
    // Ordering, not just presence. A settle that ran after both writes, or
    // writes issued concurrently, would satisfy a count assertion and still
    // deliver one burst to the pty.
    const order: string[] = []
    const mcp = {
      callTool: vi.fn(async (_n: string, args: Record<string, unknown>) => {
        order.push(`write:${JSON.stringify(args.text)}`)
        return { ok: true }
      }),
    }
    const settle = async (ms: number): Promise<void> => { order.push(`settle:${ms}`) }

    await new RequestDispatcher(mcp, settle)
      .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'hi\r' }, all, DEVICE)

    expect(order).toEqual(['write:"hi"', `settle:${SUBMIT_SETTLE_MS}`, 'write:"\\r"'])
  })

  it('pauses long enough to clear a paste-burst window', async () => {
    const mcp = fakeMcp()
    const { slept, settle } = fakeSettle()
    await new RequestDispatcher(mcp, settle)
      .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'x\r' }, all, DEVICE)
    // The exact number is empirical; what must not happen is it drifting down
    // into the tens of milliseconds those TUIs treat as a single burst.
    expect(slept).toEqual([SUBMIT_SETTLE_MS])
    expect(SUBMIT_SETTLE_MS).toBeGreaterThanOrEqual(100)
  })

  it('keeps a multi-line paste whole, splitting only the final Enter', async () => {
    // The phone wraps multi-line text in a bracketed paste and puts ONE carriage
    // return after the closing marker. Splitting on an interior newline would
    // submit half a message; splitting inside the markers would leave the
    // terminal stuck in paste mode.
    const mcp = fakeMcp()
    const { settle } = fakeSettle()
    const pasted = '\x1b[200~one\rtwo\x1b[201~\r'
    await new RequestDispatcher(mcp, settle)
      .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: pasted }, all, DEVICE)

    expect(mcp.callTool.mock.calls[0][1]).toEqual({ terminalId: 't1', text: '\x1b[200~one\rtwo\x1b[201~' })
    expect(mcp.callTool.mock.calls[1][1]).toEqual({ terminalId: 't1', text: '\r' })
  })

  it('forwards text with no trailing newline untouched, in a single write', async () => {
    // Raw keystrokes stay raw. A client steering a TUI one key at a time must
    // not have a 150ms pause spliced into its stream.
    const mcp = fakeMcp()
    const { slept, settle } = fakeSettle()
    await new RequestDispatcher(mcp, settle)
      .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: '\x1b[B' }, all, DEVICE)

    expect(mcp.callTool).toHaveBeenCalledTimes(1)
    expect(mcp.callTool).toHaveBeenCalledWith('write_to_terminal', { terminalId: 't1', text: '\x1b[B' }, DEVICE)
    expect(slept).toEqual([])
  })

  it('sends a bare Enter as one write, with nothing to settle behind', async () => {
    // Answering a y/n prompt is a real use. There is no body, so there is no
    // burst to break up -- and a needless pause would just make the phone feel
    // slow.
    const mcp = fakeMcp()
    const { slept, settle } = fakeSettle()
    await new RequestDispatcher(mcp, settle)
      .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: '\r' }, all, DEVICE)

    expect(mcp.callTool).toHaveBeenCalledTimes(1)
    expect(mcp.callTool).toHaveBeenCalledWith('write_to_terminal', { terminalId: 't1', text: '\r' }, DEVICE)
    expect(slept).toEqual([])
  })

  it('splits a bare newline terminator too, not just a carriage return', async () => {
    // toTerminalSubmit sends \r, but the dispatcher is the desktop's edge and an
    // older or third-party client may terminate with \n. Both mean submit.
    const mcp = fakeMcp()
    const { settle } = fakeSettle()
    await new RequestDispatcher(mcp, settle)
      .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'ship it\n' }, all, DEVICE)

    expect(mcp.callTool).toHaveBeenCalledTimes(2)
    expect(mcp.callTool.mock.calls[1][1]).toEqual({ terminalId: 't1', text: '\n' })
  })

  it('reports failure when the Enter fails, even though the text got through', async () => {
    // The phone clears the composer on success. Calling this a success would
    // lose the message: the text is on the desktop, unsent, and the only copy
    // the user could resend has just been wiped from their screen.
    const mcp = {
      callTool: vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error('terminal is gone')),
    }
    const { settle } = fakeSettle()
    await expect(
      new RequestDispatcher(mcp, settle)
        .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'hello\r' }, all, DEVICE),
    ).rejects.toThrow(/terminal is gone/)
  })

  it('does not press Enter at all if the text never landed', async () => {
    const mcp = { callTool: vi.fn().mockRejectedValue(new Error('mcp down')) }
    const { settle } = fakeSettle()
    await expect(
      new RequestDispatcher(mcp, settle)
        .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'hello\r' }, all, DEVICE),
    ).rejects.toThrow(/mcp down/)
    expect(mcp.callTool).toHaveBeenCalledTimes(1)
  })

  it('tags both halves with the device that asked', async () => {
    // Two writes are two audit lines. Neither of them may be anonymous.
    const mcp = fakeMcp()
    const { settle } = fakeSettle()
    await new RequestDispatcher(mcp, settle)
      .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'hello\r' }, all, DEVICE)
    expect(mcp.callTool.mock.calls.map((c) => c[2])).toEqual([DEVICE, DEVICE])
  })

  it('really does wait when nothing is injected', async () => {
    // The default argument is the only thing that makes this work in production.
    // A suite that always injects a fake would never notice it going missing.
    const mcp = fakeMcp()
    const started = Date.now()
    await new RequestDispatcher(mcp)
      .dispatch({ kind: 'writeToTerminal', terminalId: 't1', text: 'hello\r' }, all, DEVICE)
    expect(Date.now() - started).toBeGreaterThanOrEqual(SUBMIT_SETTLE_MS - 25)
    expect(mcp.callTool).toHaveBeenCalledTimes(2)
  })
})

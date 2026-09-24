import { describe, it, expect, vi } from 'vitest'
import { RequestDispatcher, SUBMIT_SETTLE_MS } from '../../src/main/remoteBridge/dispatcher'
import { CapabilityError } from '../../src/main/remoteBridge/remotePolicy'
import {
  NO_CAPABILITIES,
  type Capabilities,
  type DirectoryListing,
  type LaunchedAgent,
  type RemoteRequest,
} from '../../src/main/remoteBridge/protocol'

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

describe('RequestDispatcher — the folder picker', () => {
  /** Records the pauses instead of taking them, so the suite does not sleep. */
  const fakeSettle = () => {
    const slept: number[] = []
    return { slept, settle: async (ms: number) => { slept.push(ms) } }
  }

  it('answers listDirectory from the injected picker, never from MCP', async () => {
    // The listing is bridge-local filesystem, not an MCP tool -- the whole reason
    // it exists is to avoid spending the nearly-full agent tool-description budget
    // on it. So a listDirectory that reached `callTool` would be the design gone
    // wrong, not merely a wrong path.
    const mcp = fakeMcp()
    const listing: DirectoryListing = {
      path: '/home/dev',
      parent: null,
      entries: [{ name: 'repo', path: '/home/dev/repo' }],
    }
    const listDir = vi.fn().mockReturnValue(listing)
    const { settle } = fakeSettle()

    const answer = await new RequestDispatcher(mcp, settle, listDir).dispatch(
      { kind: 'listDirectory', path: '/home/dev' },
      all,
      DEVICE,
    )

    expect(listDir).toHaveBeenCalledWith('/home/dev')
    expect(answer).toBe(listing)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('passes no path to the picker when the phone named none, so it opens at home', async () => {
    // An absent `path` is the phone asking for the desktop home. Forwarding an
    // explicit `undefined` is what listHomeDirectory reads as "the root" -- a
    // sentinel string here would name a folder called "undefined" instead.
    const mcp = fakeMcp()
    const listDir = vi.fn().mockReturnValue({ path: '/home/dev', parent: null, entries: [] })
    const { settle } = fakeSettle()

    await new RequestDispatcher(mcp, settle, listDir).dispatch({ kind: 'listDirectory' }, all, DEVICE)

    expect(listDir).toHaveBeenCalledWith(undefined)
  })

  it('refuses listDirectory for a device without createTerminal', async () => {
    // The folder list rides `createTerminal` because it exists only to feed a
    // launch. A read-only device has no business enumerating the desktop's tree.
    const mcp = fakeMcp()
    const listDir = vi.fn()
    const readOnly: Capabilities = { ...NO_CAPABILITIES, read: true }

    await expect(
      new RequestDispatcher(mcp, undefined, listDir).dispatch({ kind: 'listDirectory' }, readOnly, DEVICE),
    ).rejects.toThrow(CapabilityError)
    expect(listDir).not.toHaveBeenCalled()
    expect(mcp.callTool).not.toHaveBeenCalled()
  })
})

describe('RequestDispatcher — launching an agent', () => {
  /** The middle dot the terminal name is built with, spelled by code point so
   *  the assertion cannot drift from the source over a copy-paste. */
  const DOT = '·'

  const fakeSettle = () => {
    const slept: number[] = []
    return { slept, settle: async (ms: number) => { slept.push(ms) } }
  }

  /** An MCP whose create_terminal names a terminal and whose run_command just
   *  succeeds -- the shape launchAgent needs to reach its happy path. */
  const launchMcp = (created: unknown = { terminalId: 't9' }) => ({
    callTool: vi.fn().mockResolvedValueOnce(created).mockResolvedValue({ ok: true }),
  })

  it('opens the terminal, waits, THEN starts the agent -- in that order', async () => {
    // The settle between the two is the same fix the typed-message path carries:
    // run_command fused onto a just-spawned PTY reaches an agent still drawing its
    // first frame and is swallowed -- "launched it and nothing happened". The
    // order is the assertion; a settle that ran after both calls would satisfy a
    // count and still deliver one burst.
    const order: string[] = []
    const mcp = {
      callTool: vi.fn(async (name: string) => {
        order.push(name)
        return name === 'create_terminal' ? { terminalId: 't9' } : { ok: true }
      }),
    }
    const settle = async (ms: number): Promise<void> => { order.push(`settle:${ms}`) }

    const launched = await new RequestDispatcher(mcp, settle).dispatch(
      { kind: 'launchAgent', agent: 'claude', cwd: '/home/dev/api' },
      all,
      DEVICE,
    )

    expect(order).toEqual(['create_terminal', `settle:${SUBMIT_SETTLE_MS}`, 'run_command'])
    expect(launched).toEqual({ terminalId: 't9', name: `Claude ${DOT} api` })
  })

  it('names the terminal for its agent and folder, and runs the agent binary in it', async () => {
    const mcp = launchMcp()
    const { slept, settle } = fakeSettle()

    await new RequestDispatcher(mcp, settle).dispatch(
      { kind: 'launchAgent', agent: 'codex', cwd: '/home/dev/api' },
      all,
      DEVICE,
    )

    expect(mcp.callTool).toHaveBeenNthCalledWith(
      1,
      'create_terminal',
      { name: `Codex ${DOT} api`, cwd: '/home/dev/api' },
      DEVICE,
    )
    expect(mcp.callTool).toHaveBeenNthCalledWith(2, 'run_command', { terminalId: 't9', command: 'codex' }, DEVICE)
    expect(slept).toEqual([SUBMIT_SETTLE_MS])
  })

  it("runs gemini's real binary, which is not named after it", async () => {
    // The one agent whose key and command differ: `gemini` launches `agy`. A map
    // that regressed to running `gemini` would fail only here.
    const mcp = launchMcp({ terminalId: 't1' })
    const { settle } = fakeSettle()

    await new RequestDispatcher(mcp, settle).dispatch(
      { kind: 'launchAgent', agent: 'gemini', cwd: '/repo' },
      all,
      DEVICE,
    )

    expect(mcp.callTool).toHaveBeenNthCalledWith(2, 'run_command', { terminalId: 't1', command: 'agy' }, DEVICE)
  })

  it('recovers the terminal id when create_terminal answers with a bare string', async () => {
    // The MCP result shape is not guaranteed: create_terminal is Headroom-exempt
    // and usually returns an object, but a bare id must still route the run.
    const mcp = launchMcp('t-str')
    const { settle } = fakeSettle()

    const launched = await new RequestDispatcher(mcp, settle).dispatch(
      { kind: 'launchAgent', agent: 'claude', cwd: '/repo' },
      all,
      DEVICE,
    )

    expect((launched as LaunchedAgent).terminalId).toBe('t-str')
    expect(mcp.callTool).toHaveBeenNthCalledWith(2, 'run_command', { terminalId: 't-str', command: 'claude' }, DEVICE)
  })

  it('tags both the create and the run with the device that asked', async () => {
    // Two MCP calls are two audit lines. Spec §4.4: neither may be anonymous.
    const mcp = launchMcp()
    const { settle } = fakeSettle()

    await new RequestDispatcher(mcp, settle).dispatch(
      { kind: 'launchAgent', agent: 'claude', cwd: '/repo' },
      all,
      DEVICE,
    )

    expect(mcp.callTool.mock.calls.map((c) => c[2])).toEqual([DEVICE, DEVICE])
  })

  it('falls back to the whole path for a folder with no basename, as a root has', async () => {
    // basename('/') is '' -- the `|| cwd` keeps the terminal from being named
    // "Claude · " with nothing after the dot.
    const mcp = launchMcp({ terminalId: 't1' })
    const { settle } = fakeSettle()

    const launched = await new RequestDispatcher(mcp, settle).dispatch(
      { kind: 'launchAgent', agent: 'claude', cwd: '/' },
      all,
      DEVICE,
    )

    expect((launched as LaunchedAgent).name).toBe(`Claude ${DOT} /`)
  })

  it.each<[string, unknown]>([
    ['a success object carrying no id', { ok: true }],
    ['an object whose id is empty', { terminalId: '' }],
    ['a bare empty string', ''],
    ['null', null],
  ])('refuses to launch, and never runs the agent, when create_terminal returns %s', async (_label, created) => {
    // No terminal id means there is nowhere to run the agent. It must throw
    // BEFORE the settle and the run_command, not open a headless terminal and
    // fire a command into the void.
    const mcp = { callTool: vi.fn().mockResolvedValueOnce(created).mockResolvedValue({ ok: true }) }
    const { slept, settle } = fakeSettle()

    await expect(
      new RequestDispatcher(mcp, settle).dispatch(
        { kind: 'launchAgent', agent: 'claude', cwd: '/repo' },
        all,
        DEVICE,
      ),
    ).rejects.toThrow(/create_terminal did not return a terminal id/)

    expect(mcp.callTool).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('refuses an agent it has no binary for, without opening a terminal', async () => {
    const mcp = fakeMcp()
    const bogus = { kind: 'launchAgent', agent: 'rogue', cwd: '/repo' } as unknown as RemoteRequest

    await expect(new RequestDispatcher(mcp).dispatch(bogus, all, DEVICE)).rejects.toThrow(/unknown agent/)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it("does not treat an inherited key like 'constructor' as a known agent", async () => {
    // hasOwnProperty, not `in`: `'constructor' in AGENT_BINARY` is true through the
    // prototype, and an `in` check would let the phone name a "binary" that is a
    // function on Object's prototype. This pins the own-property guard.
    const mcp = fakeMcp()
    const sneaky = { kind: 'launchAgent', agent: 'constructor', cwd: '/repo' } as unknown as RemoteRequest

    await expect(new RequestDispatcher(mcp).dispatch(sneaky, all, DEVICE)).rejects.toThrow(/unknown agent/)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it.each<[string, unknown]>([
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('refuses to launch with %s for a working directory', async (_label, cwd) => {
    // `cwd` arrives unvalidated over the wire and the dispatcher does not
    // re-derive it, so an empty or non-string cwd must be refused here rather
    // than passed to create_terminal, which would open a terminal somewhere
    // undefined.
    const mcp = fakeMcp()
    const req = { kind: 'launchAgent', agent: 'claude', cwd } as unknown as RemoteRequest

    await expect(new RequestDispatcher(mcp).dispatch(req, all, DEVICE)).rejects.toThrow(/no working directory/)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('refuses launchAgent for a device without createTerminal, before it validates anything', async () => {
    // Capability is checked first, so an ungranted launch is refused as a
    // CapabilityError -- not as "unknown agent" -- and never reaches the agent or
    // cwd checks. A read-only device cannot even probe which agents exist.
    const mcp = fakeMcp()
    const readOnly: Capabilities = { ...NO_CAPABILITIES, read: true }

    await expect(
      new RequestDispatcher(mcp).dispatch({ kind: 'launchAgent', agent: 'claude', cwd: '/repo' }, readOnly, DEVICE),
    ).rejects.toThrow(CapabilityError)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })
})

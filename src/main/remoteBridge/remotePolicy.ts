import type { Capabilities, RemoteRequest } from './protocol'

export class CapabilityError extends Error {
  constructor(public readonly capability: keyof Capabilities | null) {
    super(
      capability === null
        ? 'remote device sent an unrecognised request kind'
        : `remote device lacks the "${capability}" capability`,
    )
    this.name = 'CapabilityError'
  }
}

/**
 * Which grant a request needs.
 *
 * writeToTerminal is deliberately NOT implied by createTerminal: typing into an
 * existing agent session bypasses sanitizeAgentCommand entirely (spec §4.5), so it
 * is its own grant and must be turned on deliberately.
 */
export function requiredCapability(request: RemoteRequest): keyof Capabilities | null {
  switch (request.kind) {
    case 'listTerminals':
    case 'subscribe':
    case 'unsubscribe':
      return 'read'
    case 'createTerminal':
      return 'createTerminal'
    // `runCommand` is NOT terminal creation. It reaches main as a writeToTerminal
    // of the command plus a carriage return, and sanitizeAgentCommand passes any
    // non-agent command through verbatim (agentCommandSanitizer.ts:57-59) -- so
    // it is arbitrary shell execution under another name. Spec 4.5 separates
    // `writeToTerminal` precisely because that power is the accepted risk that
    // must be granted deliberately; letting `createTerminal` confer it would
    // have handed it to every device allowed to open a terminal.
    case 'runCommand':
    case 'writeToTerminal':
      return 'writeToTerminal'
    case 'closeTerminal':
      return 'closeTerminal'
    default:
      // Fail closed. This input arrives over the network from a device that may be
      // compromised, malicious, or simply running a newer build than this desktop,
      // so an unrecognised kind must be an explicit refusal. TypeScript proves the
      // cases above are exhaustive over RemoteRequest, which is exactly why this
      // branch is unreachable in TYPE terms and reachable in FACT.
      return null
  }
}

export function isAllowed(request: RemoteRequest, caps: Capabilities): boolean {
  const needed = requiredCapability(request)
  return needed === null ? false : caps[needed] === true
}

export function assertAllowed(request: RemoteRequest, caps: Capabilities): void {
  const needed = requiredCapability(request)
  // `needed` is null for an unknown kind; passing it through keeps the refusal
  // honest instead of blaming whichever capability happened to be first.
  if (needed === null || caps[needed] !== true) {
    throw new CapabilityError(needed)
  }
}

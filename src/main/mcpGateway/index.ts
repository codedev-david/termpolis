// mcpGateway/index.ts
//
// The gateway itself: one governed path from an agent, through Termpolis, to an
// external MCP server.
//
// THE SHAPE THAT MAKES THIS WORK: Termpolis already auto-registers itself as an MCP
// server in the config of Claude Code, Codex and Gemini CLI (`agentMcpRegistry`).
// Upstream tools are therefore re-published as TERMPOLIS tools — `gateway_list_tools`
// and `gateway_call` — rather than asking the user to point each agent at each server.
// One registration the agents already trust, and every upstream call inherits the
// policy, the secret scan, the injection scan and the audit log for free. It is also
// the only arrangement that governs all three CLIs at once, which is the entire point:
// no single-vendor harness will ever proxy a competitor's traffic on your behalf.
//
// TRANSPORT IS A SEAM. Talking JSON-RPC over stdio or HTTP is mechanical and
// I/O-bound; the interesting behaviour is the policy/guard/audit sandwich around it.
// Everything here is therefore injectable and the whole orchestration is unit-tested
// with fake transports — no child processes, no sockets.

import { decide, defaultPolicy, type GatewayPolicy, type GateDecision } from './policy'
import { scanArgs, redactArgs, inspectResult, riskBanner, sanitizeToolMetadata, type SecretScan, type ArgFinding } from './guard'
import { recordGatewayCall } from './audit'

export interface UpstreamTool {
  name: string
  description?: string
  inputSchema?: unknown
}

/** One upstream MCP server, reduced to what the gateway needs from it. */
export interface Transport {
  id: string
  listTools: () => Promise<UpstreamTool[]>
  callTool: (tool: string, args: unknown) => Promise<string>
}

export interface GatewayDeps {
  getPolicy: () => GatewayPolicy
  transports: () => Transport[]
  /** aiSecurity.scanText, structurally. */
  scanSecrets: (text: string) => SecretScan
  /** Asked only when the policy says 'ask'. Absent (or throwing) means no human is
   *  available, which fails CLOSED — see `resolveAsk`. */
  prompt?: (server: string, tool: string, findings: ArgFinding[]) => Promise<GateDecision>
  now?: () => number
}

export interface GatewayCallResult {
  ok: boolean
  /** Present when ok. Already banner-wrapped if the injection scan was not green. */
  text?: string
  error?: string
  decision: GateDecision
  argFindings: ArgFinding[]
  resultLevel: 'green' | 'yellow' | 'red' | null
}

/** A tool name as agents see it: `server/tool`. Splitting on the FIRST slash keeps
 *  tool names containing slashes intact, which some servers emit. */
export function qualify(server: string, tool: string): string {
  return `${server}/${tool}`
}

export function unqualify(qualified: string): { server: string; tool: string } | null {
  const at = qualified.indexOf('/')
  if (at <= 0 || at === qualified.length - 1) return null
  return { server: qualified.slice(0, at), tool: qualified.slice(at + 1) }
}

/** Resolve an 'ask' to a terminal decision.
 *
 *  FAIL CLOSED: a missing prompter, a rejected prompt, or anything other than an
 *  explicit 'allow' becomes 'deny'. The failure mode of the opposite default is that
 *  a headless run — where no window exists to answer — silently grants an external
 *  server everything, which is precisely the situation the gateway is built to stop. */
async function resolveAsk(deps: GatewayDeps, server: string, tool: string, findings: ArgFinding[]): Promise<GateDecision> {
  if (!deps.prompt) return 'deny'
  try {
    const answer = await deps.prompt(server, tool, findings)
    return answer === 'allow' ? 'allow' : 'deny'
  } catch {
    return 'deny'
  }
}

export function createGateway(deps: GatewayDeps) {
  const now = deps.now ?? Date.now

  /** Every upstream tool, namespaced, with the ones the policy already denies removed
   *  and every surviving tool's METADATA scanned.
   *
   *  Hiding a denied tool is deliberate: a tool the model can see is a tool it will
   *  eventually try, burning a turn and an audit line to be told no.
   *
   *  The metadata scan is the other half of the injection defence. `callTool` guards the
   *  result path, but a tool's description and input schema reach the model earlier and
   *  unprompted — the classic MCP tool-poisoning vector. Scanning only results would leave
   *  the listing as an ungoverned channel straight into context. */
  async function listTools(): Promise<UpstreamTool[]> {
    const policy = deps.getPolicy()
    if (!policy.enabled) return []
    const out: UpstreamTool[] = []
    for (const transport of deps.transports()) {
      let tools: UpstreamTool[] = []
      try {
        tools = await transport.listTools()
      } catch {
        continue // one unreachable server must not hide the others
      }
      for (const tool of tools) {
        const verdict = decide(policy, transport.id, tool.name)
        if (verdict.decision === 'deny') continue

        const meta = sanitizeToolMetadata(transport.id, tool.name, tool.description, tool.inputSchema)
        if (meta.level !== 'green') {
          // A withheld description is a security event in its own right — it is how a
          // poisoned server announces itself, and it happens without any call being made.
          recordGatewayCall({
            ts: now(),
            server: transport.id,
            tool: tool.name,
            decision: verdict.decision,
            reason: `tools/list metadata withheld ${meta.rules.length > 0 ? `(${meta.rules.join(', ')})` : '(oversized metadata)'}`,
            argFindings: [],
            resultLevel: meta.level,
            resultTruncated: false,
            durationMs: 0,
            ok: false,
          })
        }

        out.push({
          ...tool,
          name: qualify(transport.id, tool.name),
          description: meta.description,
          inputSchema: meta.inputSchema,
        })
      }
    }
    return out
  }

  async function callTool(qualified: string, args: unknown): Promise<GatewayCallResult> {
    const started = now()
    const parts = unqualify(qualified)
    if (!parts) {
      return { ok: false, error: `malformed tool name "${qualified}" (expected server/tool)`, decision: 'deny', argFindings: [], resultLevel: null }
    }
    const { server, tool } = parts
    const transport = deps.transports().find(t => t.id === server)

    const policy = deps.getPolicy()
    const verdict = decide(policy, server, tool)

    // The argument scan runs BEFORE the decision is finalised so an 'ask' prompt can
    // show the human what is about to leave. It is the whole reason the prompt is
    // worth showing at all.
    let argFindings: ArgFinding[] = []
    try {
      argFindings = scanArgs(args, deps.scanSecrets)
    } catch {
      /* a scanner fault must not open the gate; findings stay empty and the policy
         decision still governs */
    }

    let decision = verdict.decision
    if (decision === 'ask') decision = await resolveAsk(deps, server, tool, argFindings)

    const audit = (ok: boolean, resultLevel: 'green' | 'yellow' | 'red' | null, truncated: boolean, error?: string): void => {
      recordGatewayCall({
        ts: started,
        server,
        tool,
        decision,
        reason: verdict.reason,
        argFindings: argFindings.map(f => ({ path: f.path, rule: f.rule })),
        resultLevel,
        resultTruncated: truncated,
        durationMs: now() - started,
        ok,
        ...(error ? { error } : {}),
      })
    }

    if (decision !== 'allow') {
      audit(false, null, false, verdict.reason)
      return { ok: false, error: `denied by gateway policy (${verdict.reason})`, decision, argFindings, resultLevel: null }
    }
    if (!transport) {
      audit(false, null, false, 'unknown server')
      return { ok: false, error: `unknown MCP server "${server}"`, decision, argFindings, resultLevel: null }
    }

    // Allowed but the arguments carry a secret: send the redacted form. The user said
    // yes to the CALL, not to the credential — and a redacted call usually still works,
    // because the secret is almost never the field the tool actually needed.
    const outbound = argFindings.length > 0 ? redactArgs(args, text => deps.scanSecrets(text).redacted) : args

    try {
      const raw = await transport.callTool(tool, outbound)
      const risk = inspectResult(raw)
      audit(true, risk.level, risk.truncated)
      return { ok: true, text: riskBanner(risk, server, tool), decision, argFindings, resultLevel: risk.level }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      audit(false, null, false, message)
      return { ok: false, error: message, decision, argFindings, resultLevel: null }
    }
  }

  return { listTools, callTool }
}

export { defaultPolicy }
export type { GatewayPolicy, GateDecision, ArgFinding }

// mcpGateway/policy.ts
//
// The allow-list that decides whether an agent may call one tool on one upstream
// MCP server.
//
// WHY THIS LAYER EXISTS: Termpolis has always been an MCP *server* — it publishes
// tools to Claude Code / Codex / Gemini and governs what they can do to the machine.
// It was never an MCP *client*, so the moment a user wired a third-party MCP server
// straight into their agent's own config, every Termpolis control was bypassed:
// the traffic never touched this app. `importScanner` inspects such a server at
// INSTALL time, but install-time scanning says nothing about the call that happens
// four hours later with your credentials in the arguments.
//
// The gateway closes that: upstream servers are reached THROUGH Termpolis, and this
// module is the decision function in front of every call. It is deliberately pure —
// no fs, no electron, no network — so the decision can be unit-tested exhaustively
// and replayed from the audit log.
//
// DESIGN: specificity, not order. A rule names a server and a tool, either of which
// may be the wildcard '*'. The most specific matching rule wins, which is the only
// model where adding a broad rule cannot silently weaken a narrow one that already
// exists. Order is used only to break exact ties, and the LATEST such rule wins,
// because a tie is the user answering the same prompt a second time.

/** What may happen to a call. 'ask' defers to the human; it is never auto-resolved here. */
export type GateDecision = 'allow' | 'deny' | 'ask'

export interface ToolRule {
  /** Upstream server id, or '*' for any. */
  server: string
  /** Tool name on that server, or '*' for any. */
  tool: string
  decision: GateDecision
}

export interface GatewayPolicy {
  /** Master switch. Off means the gateway refuses every call — a kill switch that
   *  does not require unpicking individual rules. */
  enabled: boolean
  /** Applied when no rule matches. Default 'ask' — never 'allow'. */
  defaultDecision: GateDecision
  rules: ToolRule[]
  /** Strict mode collapses 'ask' to 'deny' everywhere: for unattended/headless runs
   *  where there is no human to answer the prompt, so an unanswered prompt must fail
   *  closed rather than hang or default open. */
  strict: boolean
}

export interface PolicyVerdict {
  decision: GateDecision
  /** The rule that decided it, or null when the default did. */
  rule: ToolRule | null
  /** Human-readable justification, copied verbatim into the audit log. */
  reason: string
}

export function defaultPolicy(): GatewayPolicy {
  return { enabled: true, defaultDecision: 'ask', rules: [], strict: false }
}

/** Specificity: an exact server outranks an exact tool, so a rule that names one
 *  server governs it entirely rather than being overridden by a '*'-server rule that
 *  happens to name the tool. Scores: server exact = 2, tool exact = 1. */
export function ruleSpecificity(rule: ToolRule): number {
  return (rule.server === '*' ? 0 : 2) + (rule.tool === '*' ? 0 : 1)
}

function matches(rule: ToolRule, server: string, tool: string): boolean {
  return (rule.server === '*' || rule.server === server) && (rule.tool === '*' || rule.tool === tool)
}

export function decide(policy: GatewayPolicy, server: string, tool: string): PolicyVerdict {
  if (!policy.enabled) {
    return { decision: 'deny', rule: null, reason: 'gateway disabled' }
  }

  let best: ToolRule | null = null
  let bestScore = -1
  for (const rule of policy.rules) {
    if (!matches(rule, server, tool)) continue
    const score = ruleSpecificity(rule)
    // >= so the LAST rule at a given specificity wins: re-answering a prompt should
    // replace the earlier answer, not be ignored by it.
    if (score >= bestScore) {
      best = rule
      bestScore = score
    }
  }

  const raw = best ? best.decision : policy.defaultDecision
  const reason = best
    ? `rule ${best.server}/${best.tool} -> ${best.decision}`
    : `no rule; default ${policy.defaultDecision}`

  // Strict mode has to apply AFTER matching so the audit log records which rule was
  // in play. An explicit 'allow' is a decision the user already made and survives;
  // only the unresolved 'ask' fails closed.
  if (policy.strict && raw === 'ask') {
    return { decision: 'deny', rule: best, reason: `${reason}; strict mode denies unattended 'ask'` }
  }
  return { decision: raw, rule: best, reason }
}

/** Record a decision as a rule. Returns a NEW policy — the store owns persistence.
 *  Superseding is by append (see the >= tie-break in `decide`) rather than by mutating
 *  the matching rule, so the rule list stays an auditable history of what was answered. */
export function remember(policy: GatewayPolicy, server: string, tool: string, decision: GateDecision): GatewayPolicy {
  return { ...policy, rules: [...policy.rules, { server, tool, decision }] }
}

/** Drop every rule for a server — what "forget this server" means. */
export function forgetServer(policy: GatewayPolicy, server: string): GatewayPolicy {
  return { ...policy, rules: policy.rules.filter(r => r.server !== server) }
}

/** Collapse the append-only rule list to the set of rules that can still decide
 *  anything. Used by the settings UI so a user who answered the same prompt nine
 *  times sees one row, and by `policySummary` for the audit header. */
export function effectiveRules(policy: GatewayPolicy): ToolRule[] {
  const seen = new Map<string, ToolRule>()
  for (const rule of policy.rules) seen.set(`${rule.server}\u0000${rule.tool}`, rule)
  return [...seen.values()]
}

export function policySummary(policy: GatewayPolicy): string {
  if (!policy.enabled) return 'MCP gateway: disabled (all upstream calls denied)'
  const rules = effectiveRules(policy)
  const allow = rules.filter(r => r.decision === 'allow').length
  const deny = rules.filter(r => r.decision === 'deny').length
  const mode = policy.strict ? 'strict' : `default ${policy.defaultDecision}`
  return `MCP gateway: ${mode}; ${allow} allowed, ${deny} denied, ${rules.length} rules`
}

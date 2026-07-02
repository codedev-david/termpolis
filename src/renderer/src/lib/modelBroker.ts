// Model broker — chooses a cheaper/smaller model for lesser or high-volume work
// and the premium model for hard work, so a swarm conserves tokens without
// sacrificing quality where it matters. Pure (no IO) so every rule is unit-tested.
//
// Termpolis orchestrates CLI agents; it does not call model APIs. "Brokering a
// model" therefore means passing a validated `--model <alias>` to the agent CLI
// it launches. Today only Claude Code exposes that control (its --model accepts
// the opus/sonnet/haiku/fable aliases); other agents run their own default model until
// their flags are validated (see the design doc — Phase 2). The security boundary
// that actually enforces which model flags may run lives in the MAIN process
// (src/main/agentCommandSanitizer.ts AGENT_MODEL_ALIASES) — this module is the
// renderer-side brain that recommends and the conductor prompt that instructs.

export type ModelTier = 'economy' | 'standard' | 'premium'

export interface AgentModelTiers {
  /** Model alias the agent CLI accepts for each tier (omit a tier = not offered). */
  economy?: string
  standard?: string
  premium?: string
  /** Relative cost weight per tier, premium = 1.0 (≈ ratio of output $/MTok). */
  cost: Record<ModelTier, number>
}

// Per-agent model tiers. Claude only, for now — aliases match Claude Code's
// --model (opus = claude-opus-4-8 ≈ $5/$25 per MTok, sonnet = claude-sonnet-4-6
// ≈ $3/$15, haiku = claude-haiku-4-5 ≈ $1/$5). Cost weights use the output price
// ratio to Opus, the dominant cost in agentic coding. Keep the alias strings in
// sync with the sanitizer's AGENT_MODEL_ALIASES (the authoritative allowlist).
export const AGENT_MODEL_TIERS: Record<string, AgentModelTiers> = {
  claude: {
    economy: 'haiku',
    standard: 'sonnet',
    premium: 'opus',
    cost: { economy: 0.2, standard: 0.6, premium: 1.0 },
  },
}

export interface TaskSignals {
  /** 1 (trivial) … 5 (architectural / correctness-critical). */
  complexity: number
  /** Rough output volume — high-volume routine work is where cheap models save most. */
  tokenIntensity: 'low' | 'medium' | 'high'
}

/**
 * Recommend a model tier from a task's signals. Pure.
 *  - complexity ≥ 4  → premium  (correctness over cost — never downshift hard work)
 *  - complexity ≤ 2  → economy  (boilerplate, scaffolding, docs, formatting)
 *  - complexity 3    → economy when token-heavy (big-but-routine, max savings),
 *                      else standard (balanced)
 */
export function recommendTier(t: TaskSignals): ModelTier {
  if (t.complexity >= 4) return 'premium'
  if (t.complexity <= 2) return 'economy'
  return t.tokenIntensity === 'high' ? 'economy' : 'standard'
}

/** The `--model <alias>` flag for an agent+tier, or '' if the agent has no model control. Pure. */
export function resolveModelFlag(agentId: string, tier: ModelTier): string {
  const alias = AGENT_MODEL_TIERS[agentId]?.[tier]
  return alias ? `--model ${alias}` : ''
}

/** Cost of running an agent at a tier as a fraction of its premium cost (1.0). Pure. */
export function tierCostRatio(agentId: string, tier: ModelTier): number {
  return AGENT_MODEL_TIERS[agentId]?.cost[tier] ?? 1
}

/** Whole-percent token-cost saved vs. always running the premium model. Pure. */
export function estimateSavingsPct(agentId: string, tier: ModelTier): number {
  return Math.round((1 - tierCostRatio(agentId, tier)) * 100)
}

/** End-to-end recommendation for one agent + task. Pure. */
export interface BrokerDecision {
  tier: ModelTier
  /** '' when the agent has no model control (runs its default). */
  modelFlag: string
  savingsPct: number
}
export function brokerModel(agentId: string, signals: TaskSignals): BrokerDecision {
  const tier = recommendTier(signals)
  return { tier, modelFlag: resolveModelFlag(agentId, tier), savingsPct: estimateSavingsPct(agentId, tier) }
}

/**
 * The Claude model-selection guidance the swarm conductor sees, generated from
 * AGENT_MODEL_TIERS so the aliases never drift from the registry. Returns null
 * if Claude has no tiers configured (so the conductor prompt can omit the block).
 */
export interface ModelOption {
  /** CLI model alias — Claude Code's --model and /model accept these. */
  alias: string
  label: string
  /** % token-cost saved vs. the premium (Opus) model. 0 for Opus and for the flagship. */
  savingsPct: number
  /** Optional tag shown in the picker in place of the savings %, for a model that
   *  is NOT "cheaper than Opus" (the flagship, which costs more). */
  note?: string
}

// Fable 5 — Anthropic's most capable model, a rung ABOVE the premium (Opus) tier.
// Deliberately NOT part of AGENT_MODEL_TIERS: the swarm broker downshifts to save
// tokens and must never auto-pick a model that costs MORE than Opus (~2×). Fable is
// offered only as a manual pick (the launch + hot-swap picker) for when maximum
// capability is worth the price. Claude Code resolves the `fable` alias to the
// latest Fable 5, so this needs no update when a newer Fable ships.
export const CLAUDE_FLAGSHIP: ModelOption = {
  alias: 'fable',
  label: 'Fable',
  savingsPct: 0, // above premium — not "cheaper than Opus"
  note: 'most capable',
}

/** Claude model picker options, most-capable→cheapest: the flagship, then premium→economy with savings vs Opus. */
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  CLAUDE_FLAGSHIP,
  ...(['premium', 'standard', 'economy'] as ModelTier[]).map((tier) => {
    const alias = AGENT_MODEL_TIERS.claude[tier] as string
    return { alias, label: alias.charAt(0).toUpperCase() + alias.slice(1), savingsPct: estimateSavingsPct('claude', tier) }
  }),
]

// The aliases Claude Code accepts, derived from the picker options so the picker,
// the sanitizer allowlist, and the broker never drift apart.
const CLAUDE_ALIASES = new Set(CLAUDE_MODEL_OPTIONS.map((o) => o.alias))

/** The ` --model <alias>` to append to a Claude LAUNCH command, or '' if not a valid alias. Pure. */
export function claudeModelArg(model: string | undefined | null): string {
  return model && CLAUDE_ALIASES.has(model) ? ` --model ${model}` : ''
}

/** The `/model <alias>` to type into a RUNNING Claude agent to hot-swap, or '' if invalid. Pure. */
export function modelSwitchCommand(alias: string): string {
  return CLAUDE_ALIASES.has(alias) ? `/model ${alias}` : ''
}

export function claudeModelGuidance(): string | null {
  const t = AGENT_MODEL_TIERS.claude
  if (!t?.economy || !t.standard || !t.premium) return null
  return [
    `  MODEL SELECTION (Claude only) — conserve tokens by matching the model to the task.`,
    `  A Claude command MAY append exactly one model flag; it is the ONLY optional flag allowed:`,
    `    • simple / boilerplate / large-but-routine subtasks → '--model ${t.economy}' (cheapest)`,
    `    • moderate subtasks                                  → '--model ${t.standard}'`,
    `    • complex / architectural / correctness-critical     → '--model ${t.premium}' (use this if unsure)`,
    `  Example: 'claude --dangerously-skip-permissions --model ${t.standard}'.`,
    `  Use cheaper models for the simpler pieces of the swarm — that is the whole point of brokering.`,
  ].join('\n')
}

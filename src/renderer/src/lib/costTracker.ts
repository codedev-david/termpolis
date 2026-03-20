export interface CostInfo {
  tokensIn: number
  tokensOut: number
  estimatedCost: number
  lastUpdated: number
}

/**
 * Parse Claude Code style output for token/cost info.
 * Looks for patterns like "Total cost: $X.XX" or "tokens: X,XXX"
 */
export function parseCostFromOutput(output: string): Partial<CostInfo> | null {
  // Match patterns like "$2.40" or "cost: $1.50" or "Cost: $0.23"
  const costMatch = output.match(/(?:cost|total)[^$]*\$(\d+\.?\d*)/i)
  // Match patterns like "45,234 tokens" or "tokens: 12345"
  const tokenMatch = output.match(/([\d,]+)\s*tokens?/i)

  if (!costMatch && !tokenMatch) return null

  const result: Partial<CostInfo> = { lastUpdated: Date.now() }
  if (costMatch) result.estimatedCost = parseFloat(costMatch[1])
  if (tokenMatch) result.tokensIn = parseInt(tokenMatch[1].replace(/,/g, ''), 10)
  return result
}

/**
 * Format token count for display (e.g. 45234 -> "45K")
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`
  return String(count)
}

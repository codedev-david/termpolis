// Lumopolis token estimates. The agent CLIs do not report usage in the text mode headless runs use,
// so every figure is an estimate (about four characters a token) and the copy always says "about".

/** A rough token count for `text`: four characters to a token, rounded up. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** "about 840 tokens", "about 3.2k tokens", "about 1.3M tokens"; zero, negative or not finite is "no tokens". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return 'no tokens'
  if (n < 999.5) return `about ${Math.round(n)} tokens`
  // A value that rounds up to the next unit (999,950 to 1.0M) is shown in that unit.
  if (n < 999_950) return `about ${(Math.round(n / 100) / 10).toFixed(1)}k tokens`
  return `about ${(Math.round(n / 100_000) / 10).toFixed(1)}M tokens`
}

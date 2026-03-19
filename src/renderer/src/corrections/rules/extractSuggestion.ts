/**
 * Parses stderr output for "Did you mean" / "most similar command" style suggestions
 * and substitutes the suggested token back into the original command.
 */
export function extractSuggestionFromStderr(command: string, stderr: string): string | null {
  // Patterns to extract a suggestion from common CLIs:
  // 1. git: "The most similar command is\n    <suggestion>"
  // 2. npm: "Did you mean this?\n  <suggestion>"
  // 3. Generic: "Did you mean '<suggestion>'?"
  const patterns = [
    /the most similar command is\s+(\S+)/i,
    /did you mean this\?\s+(\S+)/i,
    /did you mean[:\s]+['""]?(\S+?)['""]?[?.]?\s*$/im,
  ]

  let suggestion: string | null = null

  for (const pattern of patterns) {
    const match = stderr.match(pattern)
    if (match) {
      suggestion = match[1].trim()
      break
    }
  }

  if (!suggestion) return null

  // Replace the first occurrence of the typo token in the command with the suggestion.
  // We consider the second token (index 1) to be the subcommand/typo when the command
  // starts with a well-known launcher (e.g. "git comit"), but we handle both cases:
  // find the token in the command that is "close enough" to something, or simply
  // replace the first token that is NOT the first word if it matches partially.
  //
  // Strategy: walk the command tokens and replace the first token that differs from
  // the suggestion but could be the typo (i.e. neither the binary nor flags).
  const tokens = command.split(' ')

  // Try to find which token is the typo by checking which token the suggestion could replace.
  // We look for the token that is most similar to the suggestion (cheapest substitution).
  let bestIndex = -1
  let bestDist = Infinity

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    // Skip flags (starting with -) and empty tokens
    if (!token || token.startsWith('-')) continue
    const dist = levenshtein(token, suggestion)
    if (dist < bestDist && dist < token.length) {
      bestDist = dist
      bestIndex = i
    }
  }

  if (bestIndex === -1) return null

  const corrected = [...tokens]
  corrected[bestIndex] = suggestion
  return corrected.join(' ')
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
      }
    }
  }
  return dp[m][n]
}

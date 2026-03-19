/**
 * Detects "command not found" errors and suggests the closest known command
 * using Levenshtein distance.
 */
export function fixCommandNotFound(
  command: string,
  stderr: string,
  knownCommands: string[]
): string | null {
  const notFoundPatterns = [/command not found/i, /not recognized/i, /is not recognized/i]

  const isCommandNotFound = notFoundPatterns.some((p) => p.test(stderr))
  if (!isCommandNotFound) return null

  const tokens = command.trim().split(/\s+/)
  const typo = tokens[0]
  if (!typo) return null

  let bestMatch: string | null = null
  let bestDist = Infinity

  for (const known of knownCommands) {
    const dist = levenshtein(typo, known)
    if (dist < bestDist) {
      bestDist = dist
      bestMatch = known
    }
  }

  // Only suggest if distance is small enough to be a plausible typo
  if (bestMatch === null || bestDist > 2) return null

  const corrected = [bestMatch, ...tokens.slice(1)].join(' ')
  return corrected
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

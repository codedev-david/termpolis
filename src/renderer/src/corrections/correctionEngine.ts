import { extractSuggestionFromStderr, fixPermissionDenied, fixCommandNotFound } from './rules'

export async function getSuggestion(command: string, output: string): Promise<string | null> {
  // Try extracting suggestion from stderr first (most reliable)
  const stderrFix = extractSuggestionFromStderr(command, output)
  if (stderrFix) return stderrFix

  // Try permission denied fix
  const permFix = fixPermissionDenied(command, output)
  if (permFix) return permFix

  // Try command-not-found with Levenshtein matching
  try {
    const res = await window.termpolis.completionPathCommands()
    if (res.success && res.data) {
      const cmdFix = fixCommandNotFound(command, output, res.data)
      if (cmdFix) return cmdFix
    }
  } catch {
    // Ignore errors fetching path commands
  }

  return null
}

/**
 * Detects permission-related errors in stderr and prepends "sudo" to the command.
 */
export function fixPermissionDenied(command: string, stderr: string): string | null {
  const permissionPatterns = [
    /permission denied/i,
    /EACCES/,
    /operation not permitted/i,
  ]

  const isPermissionError = permissionPatterns.some((p) => p.test(stderr))
  if (!isPermissionError) return null

  // Already elevated — nothing to fix
  if (/^sudo\s/.test(command.trim())) return null

  return `sudo ${command}`
}

// Where a newly created terminal should start.
//
// This is not cosmetic. A terminal's git dot and its Changes rail both read
// `TerminalSession.cwd`, and while a later `cd` is now followed on every platform —
// shell integration reports it, and on POSIX a pid probe backs that up — none of that
// produces a single byte until the shell draws its first prompt. Until then the launch
// directory is the only value there is. Defaulting every "+ Add Terminal" terminal to
// the home directory is what made the dot invisible for every non-agent terminal.
//
// Order: the folder explicitly chosen in the New Terminal modal, then the directory the
// active terminal was launched in (so a new tab opens where you already are, as every
// other terminal app does), and only then the home directory.
export function resolveNewTerminalCwd(
  chosen: string | undefined,
  activeCwd: string | undefined,
  homedir: string,
): string {
  const picked = chosen?.trim()
  if (picked) return picked
  const active = activeCwd?.trim()
  if (active) return active
  return homedir
}

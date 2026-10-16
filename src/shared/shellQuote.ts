// Literal strings for the scripts Termpolis writes for a shell to run. Shared because the
// main process (secondOpinion) and the renderer (the swarm conductor's run scripts) both
// put paths and arguments into PowerShell, and a second copy of the quoting would drift.

/** A PowerShell single-quoted literal. Nothing inside one is special except a single quote, which
 *  doubles, and PowerShell reads the typographic ones (U+2018 to U+201B) as single quotes too.
 *  Doubling only `'` once let a folder name holding `\u2019` close the literal and run the rest. */
export const psQuote = (s: string): string => `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`

/** A POSIX shell single-quoted string. Nothing inside one is special, and a single quote can't
 *  appear in one at all, so each is written as close-quote, escaped quote, reopen. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

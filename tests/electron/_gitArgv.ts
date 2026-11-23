// What a test that routes git by its argument list needs since every git read goes through gitSafety.ts: the command
// as the code wrote it. safeGitAsync puts the read-only prefix before the subcommand and the display flags just after
// it, and status and diff first run `git config --show-scope … ^filter\.` to read the repository's filter drivers.
// writtenGitArgs undoes the first two and returns null for the third, so a router can answer `argv[0] === 'status'`
// as it always did. Whether the guard itself is there is the business of gitSafety.test.ts, gitSafetyGuard.test.ts and
// gitSafetyHarness.test.ts.
import { displayFlags, gitSubcommand, runFilterScan, type FilterScan } from '../../src/main/gitSafety'

/** A real filter scan (gitSafety.ts runFilterScan, the only maker of one) whose git printed `text`: what guardGitArgs
 *  is handed for a repository with those drivers. With nothing, a repository with none. */
export const scanOf = (text = ''): Promise<FilterScan> => runFilterScan(['status'], false, async () => text)

/** True for the filter-driver read safeGitAsync runs before status and diff. */
export function isFilterScan(argv: readonly string[]): boolean {
  const sub = gitSubcommand(argv)
  return sub !== null && sub.name === 'config' && argv.includes('--show-scope') && argv.includes('^filter\\.')
}

/** The argument list as the code wrote it, or null for the filter-driver read. */
export function writtenGitArgs(argv: readonly string[]): string[] | null {
  if (isFilterScan(argv)) return null
  const sub = gitSubcommand(argv)
  if (sub === null) return [...argv]
  // The display flags were inserted in their own order, each one only if the code had not given it: walk them in
  // that order and skip the ones that sit right after the subcommand.
  let at = sub.index + 1
  for (const flag of displayFlags(sub.name)) if (argv[at] === flag) at++
  // A `-c` the code itself gave sits before the prefix; the prefix and filter overrides are dropped with the rest.
  const leading = argv.slice(0, sub.index)
  const own: string[] = []
  for (let i = 0; i < leading.length; i++) {
    if (leading[i] === '-c') { i++; continue }
    own.push(leading[i])
  }
  return [...own, sub.name, ...argv.slice(at)]
}

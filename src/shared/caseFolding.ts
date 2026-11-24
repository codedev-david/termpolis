// The one case rule (WP5 X03): which platforms' usual file systems fold case (NTFS, APFS), so `Src` and `src` are one
// folder there. Project keys, folder keys, the code index, the watchers and a walked folder's .gitignore all read it
// from here. A lookup, not a comparison, so the rule has no branch that only one platform can reach.
// Gap after 2.0: a case-sensitive APFS volume is folded here too; keeping its case needs a per-volume probe persisted in userData and shared with the memory host.

export const CASE_FOLDING_PLATFORMS: ReadonlySet<string> = new Set(['win32', 'darwin'])

/** Whether `platform`'s file systems ignore case; this platform's when not given. */
export function foldsCase(platform: string = process.platform): boolean {
  return CASE_FOLDING_PLATFORMS.has(platform)
}

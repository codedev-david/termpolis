// Lumopolis pane notices that follow from the world itself. A world of a folder outside git maps at most the
// folder walk's cap (main/world/folderWalk.ts); the doc then carries filesCapped, and the pane says so.

const CAPPED_START = 'Showing the first '

/** The notice for a world whose folder walk stopped at its cap. */
export function cappedNotice(files: number): string {
  return `${CAPPED_START}${files.toLocaleString('en-US')} files in this folder.`
}

/**
 * The notice slot after the world changes: the capped notice for a capped world; otherwise the slot as it was, unless
 * it holds a capped notice from the world before, which goes.
 */
export function nextCappedNotice(filesCapped: number | undefined, current: string | null): string | null {
  if (filesCapped !== undefined && filesCapped > 0) return cappedNotice(filesCapped)
  return current !== null && current.startsWith(CAPPED_START) ? null : current
}

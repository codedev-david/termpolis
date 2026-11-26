// The banner the code indexer shows once a repository's code graph is built (useAutoCodeIndex.ts). HOLD-B #27 (F9): it
// came up on every first open of a project and took the eye from the Lumopolis pane's first impression, so App puts it
// away while the pane is open (the pane shows that world itself). Kept apart from useAutoCodeIndex.ts, which App's
// tests replace with a stub.

const PREFIX = '🧭 Code graph: '

/** The banner for `symbols` symbols indexed in the repository `name`. */
export function codeGraphNotice(symbols: number, name: string): string {
  return `${PREFIX}${symbols} symbols indexed in "${name}"`
}

/** Whether a banner is the code graph one. */
export function isCodeGraphNotice(notice: string | null | undefined): boolean {
  return typeof notice === 'string' && notice.startsWith(PREFIX)
}

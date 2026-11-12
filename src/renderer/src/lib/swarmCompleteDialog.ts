import { useCallback, useState } from 'react'

/**
 * Whether the "Swarm complete" dialog shows for this completion summary.
 *
 * Closing the dialog (Dismiss, View Dashboard, Review Changes) hides it for this summary only.
 * It used to clear the summary itself, and the dashboard's Review tab is built from that
 * summary, so the review could not be reached once the dialog was gone. The summary now stays
 * until the next swarm starts, and the next completion shows the dialog again.
 */
export function useSwarmCompleteDialog(summary: object | null): { open: boolean; hide: () => void } {
  const [hiddenFor, setHiddenFor] = useState<object | null>(null)
  const hide = useCallback(() => setHiddenFor(summary), [summary])
  return { open: summary !== null && summary !== hiddenFor, hide }
}

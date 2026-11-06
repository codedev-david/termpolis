import { switchEnabled, SWITCH_DATA_ROUTING } from './paneSwitches'

/**
 * How a pane hears its terminal's output (1.54.5, plan package P9): through the preload's ONE shared listener
 * (`onTerminalDataFor`, which also tells main this terminal is listened to), or, when that is not there or its kill switch
 * ('termpolis.dataRouting' = '0', read when the pane mounts) is off, through the all-terminal listener every pane used to
 * have, dropping the chunks of other terminals itself. Either way the callback gets the same three arguments, for its own
 * terminal only.
 */

export type OutputCallback = (id: string, data: string, end?: number) => void

export interface OutputApi {
  onTerminalData: (cb: OutputCallback) => () => void
  onTerminalDataFor?: (id: string, cb: OutputCallback) => () => void
}

export function subscribeTerminalOutput(api: OutputApi, id: string, cb: OutputCallback): () => void {
  if (typeof api.onTerminalDataFor === 'function' && switchEnabled(SWITCH_DATA_ROUTING)) {
    try {
      return api.onTerminalDataFor(id, cb)
    } catch {
      // The routed API threw before it subscribed (a bridge that is not what it claims): the all-terminal listener below
      // hears everything, so the pane is never left deaf.
    }
  }
  return api.onTerminalData((tid, data, end) => {
    if (tid === id) cb(tid, data, end)
  })
}

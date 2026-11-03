// Which terminals' output main pushes to the renderer as `terminal:data` events (1.54.5, plan package P9).
//
// Main used to push EVERY chunk of EVERY terminal, whether or not anything in the renderer listened: a hidden swarm
// worker, which has no pane at all, cost a structured clone, an IPC message, a context-bridge crossing for each
// mounted pane and a handler run for every chunk it printed. The renderer now says what it listens to:
//
//   terminal:subscribe    { id, epoch }    a pane for this terminal is mounted
//   terminal:subscribe    { all, epoch }   something wants EVERY terminal's output (a launch waiting for its shell to go quiet)
//   terminal:unsubscribe  { id | all, epoch }
//
// and a chunk goes out only if something listens for it. What routing never changes: the chunk is appended to the
// terminal's output buffer BEFORE this is asked (a pane that mounts later replays it; the phone pump and MCP
// read_output read the same buffer), and the output still counts as activity. A pane announces itself BEFORE it asks
// for its replay and the two messages travel in order, so output produced between the two is in the replay.
//
// FAILS OPEN, every way it can:
//   * until a renderer page has announced anything, main sends everything (a window without the new preload, a unit
//     test with no renderer at all);
//   * `epoch` is the page's load time: a reloaded page announces under a newer one and starts from nothing, and a
//     message from the page it replaced (an older epoch, however late) is ignored;
//   * a window main is not tracking is sent everything;
//   * ANY malformed announcement turns routing off for the rest of the process: the one thing that must never happen
//     is a pane that is not sent its output, so a message that cannot be understood is never guessed at;
//   * TERMPOLIS_TERMINAL_DATA_ROUTING=0 in the environment turns it off at start.

export interface TerminalDataTarget {
  webContents: { id?: number; send: (channel: string, ...args: unknown[]) => void }
}

export interface RoutingStats {
  /** terminal:data events handed to a window. */
  sent: number
  /** Chunks not sent because nothing listens for their terminal. */
  skipped: number
  /** Terminals a pane listens to now. */
  ids: number
  /** True while routing filters (a page announced, nothing was malformed, the kill switch is off). */
  armed: boolean
  /** True while something listens to every terminal. */
  all: boolean
}

export interface TerminalDataRouting {
  /** An announcement from `sender`'s page: `on` = subscribe, otherwise unsubscribe. */
  note: (sender: number | undefined, msg: unknown, on: boolean) => void
  /** Hand a chunk to the window, if anything there listens for it. Returns whether it was sent. */
  send: (target: TerminalDataTarget | null | undefined, id: string, data: string, end?: number) => boolean
  stats: () => RoutingStats
  /** Forget every announcement (and any malformed one): back to sending everything. */
  reset: () => void
}

/** A terminal id is a uuid or a short name; anything longer is not one. */
const MAX_ID_LENGTH = 512

interface Listening {
  epoch: number
  sender: number | undefined
  ids: Set<string>
  all: boolean
}

interface Announcement {
  epoch: number
  id: string | null
  all: boolean
}

function parse(msg: unknown): Announcement | null {
  if (typeof msg !== 'object' || msg === null) return null
  const { id, all, epoch } = msg as { id?: unknown; all?: unknown; epoch?: unknown }
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return null
  if (all === true && id === undefined) return { epoch, id: null, all: true }
  if (typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH && all === undefined) return { epoch, id, all: false }
  return null
}

export function createTerminalDataRouting(opts: { enabled?: boolean } = {}): TerminalDataRouting {
  const enabled = opts.enabled !== false
  let listening: Listening | null = null
  let poisoned = false
  let sent = 0
  let skipped = 0

  const wants = (sender: number | undefined, id: string): boolean => {
    if (!enabled || poisoned || listening === null) return true
    if (listening.sender !== sender) return true
    return listening.all || listening.ids.has(id)
  }

  return {
    note(sender, msg, on) {
      if (!enabled || poisoned) return
      const a = parse(msg)
      if (a === null) {
        poisoned = true
        listening = null
        return
      }
      if (listening === null || listening.sender !== sender || a.epoch > listening.epoch) {
        // Only a subscribe starts tracking: an unsubscribe from a page nobody tracks (the old page's cleanup, after the
        // new page announced and was then forgotten) must not arm a router with nothing in it.
        if (!on) return
        listening = { epoch: a.epoch, sender, ids: new Set(), all: false }
      } else if (a.epoch < listening.epoch) {
        return // the page that was replaced
      }
      if (a.all) listening.all = on
      else if (on) listening.ids.add(a.id as string)
      else listening.ids.delete(a.id as string)
    },
    send(target, id, data, end) {
      if (!target) return false
      const { webContents } = target
      if (!wants(webContents.id, id)) {
        skipped++
        return false
      }
      webContents.send('terminal:data', id, data, end)
      sent++
      return true
    },
    stats: () => ({
      sent,
      skipped,
      ids: listening?.ids.size ?? 0,
      armed: enabled && !poisoned && listening !== null,
      all: listening?.all ?? false,
    }),
    reset() {
      listening = null
      poisoned = false
    },
  }
}

/** The process-wide router every PTY pump sends through. */
export const terminalDataRouting: TerminalDataRouting = createTerminalDataRouting({
  enabled: process.env.TERMPOLIS_TERMINAL_DATA_ROUTING !== '0',
})

/** A PTY chunk, to the window, if anything in it listens for the terminal. Same arguments the direct send had. */
export function sendTerminalData(
  target: TerminalDataTarget | null | undefined,
  id: string,
  data: string,
  end?: number,
): boolean {
  return terminalDataRouting.send(target, id, data, end)
}

type AnnouncementHandler = (event: { sender?: { id?: number } } | undefined, msg: unknown) => void

export function registerTerminalDataRouting(
  ipc: { on: (channel: string, listener: AnnouncementHandler) => unknown },
  routing: TerminalDataRouting = terminalDataRouting,
): void {
  ipc.on('terminal:subscribe', (e, msg) => routing.note(e?.sender?.id, msg, true))
  ipc.on('terminal:unsubscribe', (e, msg) => routing.note(e?.sender?.id, msg, false))
}

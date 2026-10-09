// Terminals a paired phone opened, held in main until the saved session records them.
//
// `list_terminals` answers from the session, which the renderer writes a second after its
// terminal list changes. A phone that has just started an agent asks for the list as soon as
// the launch returns, well inside that second, so the terminal the user had just watched start
// would be missing from the list they went back to. Main opens the terminal itself and knows
// it from that moment, so it answers for it until the session catches up.

/** The fields `list_terminals` reports for a terminal. */
export interface ListedTerminal {
  id: string
  name: string
  shellType: string
  cwd: string
}

export interface RemoteTerminals {
  /** Hold a terminal a phone just opened. */
  add(terminal: ListedTerminal): void
  /** Forget a terminal: it closed. */
  remove(id: string): void
  /** The renderer saved a session listing these terminals, so the session answers for them
   *  from now on: a rename or a close on the desktop is never contradicted here. */
  recorded(ids: string[]): void
  /** The recorded terminals, then each held one the record does not have yet. */
  merge(recorded: ListedTerminal[]): ListedTerminal[]
}

export function createRemoteTerminals(): RemoteTerminals {
  const held = new Map<string, ListedTerminal>()
  return {
    add(terminal) {
      held.set(terminal.id, terminal)
    },
    remove(id) {
      held.delete(id)
    },
    recorded(ids) {
      for (const id of ids) held.delete(id)
    },
    merge(recorded) {
      const recordedIds = new Set(recorded.map((t) => t.id))
      return [...recorded, ...[...held.values()].filter((t) => !recordedIds.has(t.id))]
    },
  }
}

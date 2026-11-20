// The renderer's half of the `lumopolis` shell command (src/main/shellIntegration.ts prints it).
//
// The command prints a private OSC, `ESC ] 7377 ; lumopolis ; <nonce> ; <folder> BEL`, into its terminal's
// output. A pane registers this handler on its xterm parser (which reassembles a sequence split across
// chunks), so the sequence is caught however the output arrived, main's pipe or the Windows direct-typing
// port. The handler always consumes it, so it never reaches the screen, and it only ASKS main: main checks
// the terminal, this run's nonce and that the folder is a folder (src/main/world/lumopolisOpen.ts), and
// answers the folder to open. History being replayed into a pane (a remount, a restored session) asks
// nothing: a lumopolis typed an hour ago must not open the pane again.
import { LUMOPOLIS_MAX_PAYLOAD } from '../../../shared/world/lumopolisCommand'

export interface LumopolisOscDeps {
  terminalId: string
  /** True while the pane is replaying history into xterm. */
  replaying(): boolean
  /** The terminal's last known folder, which a relative path is resolved against. */
  cwd(): string | undefined
  /** Opens the Lumopolis pane on the folder main answered. */
  open(folder: string): void
}

/** The handler to pass to `term.parser.registerOscHandler(LUMOPOLIS_OSC, …)`. */
export function lumopolisOscHandler(deps: LumopolisOscDeps): (payload: string) => boolean {
  return (payload) => {
    if (deps.replaying() || payload.length > LUMOPOLIS_MAX_PAYLOAD) return true
    const api = window.termpolis
    const cwd = deps.cwd()
    api.worldTerminalOpen({ terminalId: deps.terminalId, payload, ...(cwd ? { cwd } : {}) }).then(
      (res) => { if (res.success) deps.open(res.data) },
      () => undefined,
    )
    return true // consumed: the sequence never reaches the screen, whatever main answers
  }
}

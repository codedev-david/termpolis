// The renderer's half of the `lumopolis` shell command (src/main/shellIntegration.ts prints it).
//
// The command prints a private OSC, `ESC ] 7377 ; lumopolis ; <nonce> ; <folder> BEL`, into its terminal's
// output. A pane registers this handler on its xterm parser (which reassembles a sequence split across
// chunks), so the sequence is caught however the output arrived, main's pipe or the Windows direct-typing
// port. The handler always consumes it, so it never reaches the screen, and it only ASKS main: main checks
// the terminal, this run's nonce and that the folder is a folder (src/main/world/lumopolisOpen.ts), and
// answers the folder to open. History being replayed into a pane (a remount, a restored session) asks
// nothing: a lumopolis typed an hour ago must not open the pane again.
//
// Main's answer is acted on in one of three ways. A folder from the active terminal opens the pane. A folder
// from any other terminal (a program left running there, which can read the nonce) does not take the screen:
// a notice offers the open instead. A refusal main marks `show` (no such folder, a folder of the shell's own,
// too many requests, the same folder asked again) becomes a notice, with an Open button when main names the
// folder (a repeat inside main's 3 seconds opens nothing by itself; main allows at most one open of a folder every
// 3 seconds and 5 a minute from a terminal, so a loop can reopen a closed pane that often and no more); a quiet one (a
// forged request) says nothing.
// A notice rather than a line written into the terminal: text written into xterm from here lands after the
// prompt the shell has already drawn, so the line editor's idea of the cursor goes wrong, and it is missing
// from main's copy of the output, so a reload or the phone never shows it.
// The zsh integration's ready mark (the same OSC, payload `ready`, printed with every prompt report) is swallowed too,
// and asks nothing: main reads it from the terminal's output itself (#29).
import { LUMOPOLIS_MAX_PAYLOAD, LUMOPOLIS_READY } from '../../../shared/world/lumopolisCommand'
import { folderName, showLumopolisNotice } from '../components/World/worldOpen'

export interface LumopolisOscDeps {
  terminalId: string
  /** True while the pane is replaying history into xterm. */
  replaying(): boolean
  /** True while this is the active terminal (the one the person is typing in). */
  active(): boolean
  /** The terminal's last known folder, which a relative path is resolved against. */
  cwd(): string | undefined
  /** Opens the Lumopolis pane on the folder main answered. */
  open(folder: string): void
}

/** The handler to pass to `term.parser.registerOscHandler(LUMOPOLIS_OSC, …)`. */
export function lumopolisOscHandler(deps: LumopolisOscDeps): (payload: string) => boolean {
  return (payload) => {
    if (deps.replaying() || payload === LUMOPOLIS_READY || payload.length > LUMOPOLIS_MAX_PAYLOAD) return true
    const api = window.termpolis
    const cwd = deps.cwd()
    api.worldTerminalOpen({ terminalId: deps.terminalId, payload, ...(cwd ? { cwd } : {}) }).then(
      (res) => {
        if (!res.success) { if (res.show) showLumopolisNotice({ message: res.error, ...(res.folder ? { folder: res.folder } : {}) }) }
        else if (deps.active()) deps.open(res.data)
        else showLumopolisNotice({ message: `Another terminal asked to map ${folderName(res.data)} in Lumopolis.`, folder: res.data })
      },
      () => undefined,
    )
    return true // consumed: the sequence never reaches the screen, whatever main answers
  }
}

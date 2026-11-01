// Waiting for an agent to be gone from its terminal, for the two parts of Termpolis that restart one:
// the model switch (renderer, lib/modelRelaunch.ts) and the account switch (main, accountSwitch.ts).
// They once each had a clock of their own. Found live, driving the real CLIs through a real PTY:
//
//   - A fixed wait after the quit is the wrong clock. Claude Code took 4 to 11 s to hand the terminal
//     back on a machine with SessionEnd hooks, and a command typed while it is still tearing down is
//     swallowed: no error, no relaunch, the terminal just sits at a bare prompt.
//   - What the screen shows is not enough either: Claude Code and Antigravity leave their last frame,
//     input box and exit hint included, on the screen while the process is still going.
//
// So the OS has the last say, asked through shellAlone (main/shellAlone.ts: nothing runs in the
// terminal but its shell, read from the terminal's own processes, never a process listing). Where
// the OS cannot tell, the caller decides what to do: the model switch waits blind for a while, the
// account switch (which has watched the exit on the screen) goes on.

/** Between "has it gone?" questions. On Windows each question also costs ~1 s on its own. */
export const EXIT_POLL_MS = 500
/** How long an agent gets to quit before we give up and leave the terminal alone. */
export const EXIT_CEILING_MS = 30_000
/** When the OS cannot tell, assume a slow teardown: too long only delays, too short loses the command. */
export const BLIND_EXIT_WAIT_MS = 12_000
/** After the OS says the agent is gone, the shell still has to draw its prompt. */
export const PROMPT_SETTLE_MS = 600

export interface ExitWatch {
  sleep: (ms: number) => Promise<void>
  /** Clock for the exit ceiling; Date.now unless a test injects one. */
  now?: () => number
  /** Whether nothing runs in the terminal but its shell, as the OS tells: true once the agent has
   *  exited, false while it runs, null where main cannot tell. Absent or failing reads as null. */
  shellAlone?: () => Promise<boolean | null>
}

/** What the OS says about the terminal now: absent or failing reads as "cannot tell". */
export async function aloneNow(io: Pick<ExitWatch, 'shellAlone'>): Promise<boolean | null> {
  if (!io.shellAlone) return null
  try {
    return await io.shellAlone()
  } catch {
    return null
  }
}

/**
 * True once the agent is gone (or, where the OS never could say, once it is sane to guess); false if
 * it was still running at the ceiling. `osKnown`: the OS already answered "still running" once, so
 * it CAN tell, and a later failed query is a hiccup to ask again about rather than a reason to go
 * on while the agent may still be tearing down. `blindMs`: how long to wait when the OS cannot tell
 * from the first question (BLIND_EXIT_WAIT_MS; none for a caller that watched the exit on screen).
 */
export async function waitForExit(io: ExitWatch, osKnown: boolean, blindMs: number = BLIND_EXIT_WAIT_MS): Promise<boolean> {
  const now = io.now ?? Date.now
  const deadline = now() + EXIT_CEILING_MS
  let known = osKnown
  for (;;) {
    await io.sleep(EXIT_POLL_MS)
    const alone = await aloneNow(io)
    if (alone === true) return true
    if (alone === false) known = true
    else if (!known) {
      if (blindMs > 0) await io.sleep(blindMs)
      return true
    }
    if (now() >= deadline) return false
  }
}

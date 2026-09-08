/**
 * What a phone has to write to a terminal for the far end to treat it as sent.
 *
 * `write_to_terminal` is raw by contract -- "without pressing Enter" -- so text
 * on its own lands in the agent's input line and sits there. That is exactly
 * what the phone looked like it was doing: the words appeared on the desktop
 * and nothing happened. The carriage return is the submit.
 *
 * A multi-line draft gets wrapped as a bracketed paste first, matching what the
 * desktop already does when it injects text (TerminalPane, useAutoPrimer). A
 * raw-mode TUI reads every embedded CR as its own Enter, so an unwrapped
 * three-line prompt is submitted three times, the first two of them truncated.
 * Inside the paste markers the same CRs are content, and the single one after
 * the closing marker is the send.
 */
const ESC = '\u001b'
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

/** The byte an agent CLI reads as Enter. Not a newline: the pty is in raw mode. */
export const SUBMIT = '\r'

export function toTerminalSubmit(draft: string): string {
  // A phone keyboard produces newlines; the wire never sees a lone carriage
  // return, so only the two newline forms need folding.
  const body = draft.replace(/\r\n|\n/g, SUBMIT)
  return body.includes(SUBMIT) ? `${PASTE_START}${body}${PASTE_END}${SUBMIT}` : `${body}${SUBMIT}`
}

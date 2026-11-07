/**
 * What xterm.js writes back to a program that asked it something: the cursor position, device
 * attributes, a status or mode report, the window's size, the answer to a colour query (OSC) or a
 * DCS reply. They go through the same write as keystrokes, carry no key, and are wanted by whatever
 * asked; a CLI starting while a switch holds its terminal (SW5-2) waits on some of them.
 *
 * Narrower on purpose than accountsIpc's TERMINAL_REPLY: focus reports, mouse reports and the
 * bracketed-paste markers are sent with no question asked, so while a switch types into the shell
 * they could land on its line. They stay held.
 */
const ANSWER = String.raw`\x1b(?:\[[?>=]?[0-9;:]*[ -/]*[Rcnty]|\][0-9]+;[^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\)`
const ONLY_ANSWERS = new RegExp(`^(?:${ANSWER})+$`)

/** Whether a terminal write is made only of answers to a program's queries, and nothing typed. */
export function isTerminalAnswer(data: unknown): boolean {
  return typeof data === 'string' && ONLY_ANSWERS.test(data)
}

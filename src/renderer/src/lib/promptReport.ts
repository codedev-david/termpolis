/**
 * The prompt reports Termpolis's shell integration writes (shellIntegration.ts), read from a
 * terminal's output: OSC 9;9 from PowerShell and cmd, OSC 7 from bash, zsh and fish, one each time
 * the shell shows its prompt. They tell what the OS cannot always say: whether the shell has come up
 * yet (agentLaunch.ts waits for the first one), and whether it sits at its prompt now (useAutoPrimer). A shell's own semantic prompt
 * marks (OSC 133, 633) count too: main reads prompts with the same matcher (shared/accountSwitch.ts PROMPT_REPORT).
 */
import { lastPromptReport as lastReport } from '../../../shared/accountSwitch'

/** Whether `output` holds a prompt report: the shell has shown its prompt at least once. */
export function promptReported(output: string): boolean {
  return lastReport(output) >= 0
}

/**
 * Whether the shell that wrote `output` sits at its prompt: true when its last prompt report has no
 * line break after it, so nothing was submitted since (whatever is typed on the line is still
 * unsent, and no agent was started from it); false when a line went in after it; null when no
 * report is in `output` (the integration is off, or the report has left the window main keeps).
 * A prompt drawn over two lines reads as false, as a submitted line does: the caller goes on as it
 * did before it could ask.
 */
export function atShellPrompt(output: string): boolean | null {
  const last = lastReport(output)
  if (last < 0) return null
  return output.indexOf('\n', last) < 0
}

/** The terminal's output as main keeps it, or null when it cannot be read: a failed or missing call
 *  (an older preload, a test double) and a throw. */
export async function terminalOutput(terminalId: string): Promise<string | null> {
  try {
    const res = await window.termpolis?.readTerminalBuffer?.(terminalId)
    return res?.success && res.data ? res.data.output || '' : null
  } catch {
    return null
  }
}

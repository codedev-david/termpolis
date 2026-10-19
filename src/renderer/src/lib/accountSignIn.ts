// Settings ▸ Accounts ▸ Sign in: a new, visible terminal named "Sign in · Claude Code · codedev",
// in the home folder, with the account line and the CLI's own sign-in command typed into it
// (main builds the line: accounts:sign-in-line). The CLI opens the browser and keeps its own
// sign-in; Termpolis types nothing after the command and answers none of its screens. The
// terminal carries no agentCommand, so neither App.tsx poller reads it and the login-method Enter
// (promptAutoDismiss) can't fire there (R29). Its IO is injected, as modelRelaunch's is.
import type { IpcResponse, ShellType, TerminalSession } from '../types'

export interface SignInIO {
  newId: () => string
  createTerminal: (id: string, shellType: ShellType, cwd: string) => Promise<IpcResponse>
  addTerminal: (t: TerminalSession) => void
  /** 'ready': the new shell has spoken and gone quiet. 'echo': it echoed the sacrificial Enter. */
  waitShellReady: (terminalId: string, phase: 'ready' | 'echo') => Promise<void>
  write: (terminalId: string, data: string) => void
  /** Where the terminal's output ends now; null when it can't be read. */
  outputEnd: (terminalId: string) => Promise<number | null>
  watch: (accountId: string, terminalId: string, mark: number) => Promise<IpcResponse<{ watching: boolean }>>
  terminalDefaults: () => Pick<TerminalSession, 'fontSize' | 'theme' | 'fontFamily'>
}

export interface SignInRequest {
  accountId: string
  line: string
  name: string
  shellType: ShellType
  home: string
  color: string
}

export type SignInStart = { terminalId: string; watching: boolean; watchError?: string } | { error: string }

export async function startSignIn(req: SignInRequest, io: SignInIO): Promise<SignInStart> {
  const id = io.newId()
  const res = await io.createTerminal(id, req.shellType, req.home)
  if (!res.success) return { error: res.error }
  io.addTerminal({ id, name: req.name, color: req.color, shellType: req.shellType, cwd: req.home, ...io.terminalDefaults() })
  // The launch sequence's guard (aiProfiles.ts): the first byte typed into a shell that has just
  // gone quiet can be lost, so a sacrificial Enter goes first and its echo is waited for.
  await io.waitShellReady(id, 'ready')
  io.write(id, '\r')
  await io.waitShellReady(id, 'echo')
  // The shell's next prompt after this point is the sign-in command finishing.
  const mark = (await io.outputEnd(id)) ?? 0
  io.write(id, req.line + '\r')
  const w = await io.watch(req.accountId, id, mark)
  if (!w.success) return { terminalId: id, watching: false, watchError: w.error }
  return { terminalId: id, watching: w.data.watching }
}

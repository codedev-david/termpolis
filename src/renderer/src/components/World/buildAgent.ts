// Lumopolis Build it: which agent profile the dialog preselects. Build it starts Claude Code only in
// 2.0, because Claude Code is the one agent that takes a first prompt on launch (taskPromptArg, the
// launch line), so `profiles` here are the user's Claude Code profiles. Termpolis has no single
// "default agent" setting, so the user's default is read from what they use:
//   1. the profile of the agent running in the active terminal,
//   2. else the profile of the newest terminal running one of them,
//   3. else the user's own Claude Code profile (one they added, not a built-in),
//   4. else the first profile.

export interface BuildProfile { id: string; command: string }
export interface BuildTerminal { id: string; agentCommand?: string }

export function defaultBuildAgent(
  profiles: BuildProfile[],
  builtInIds: readonly string[],
  terminals: BuildTerminal[],
  activeTerminalId: string | null | undefined
): string | undefined {
  const profileOf = (t: BuildTerminal | undefined): BuildProfile | undefined =>
    t?.agentCommand ? profiles.find((p) => p.command === t.agentCommand) : undefined
  const active = profileOf(terminals.find((t) => t.id === activeTerminalId))
  if (active) return active.id
  for (let i = terminals.length - 1; i >= 0; i--) {
    const p = profileOf(terminals[i])
    if (p) return p.id
  }
  return (profiles.find((p) => !builtInIds.includes(p.id)) ?? profiles[0])?.id
}

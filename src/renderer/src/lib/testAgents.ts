const TEST_AGENT_MAP: Record<string, string> = {
  'claude': 'node e2e/mocks/mock-claude.cjs',
  'codex': 'node e2e/mocks/mock-codex.cjs',
  'gemini': 'node e2e/mocks/mock-gemini.cjs',
  // Gemini's real launch command: the sidebar, Welcome screen and shortcuts all type `agy`.
  'agy': 'node e2e/mocks/mock-gemini.cjs',
}

const TEST_FLAG_ENV = {
  agents: 'TERMPOLIS_TEST_AGENTS',
  timing: 'TERMPOLIS_TEST_TIMING',
  promptTrace: 'TERMPOLIS_TEST_PROMPT_TRACE',
} as const

/**
 * The renderer runs with contextIsolation on and nodeIntegration off, so it has no
 * `process` at all — reading `process.env` there throws ReferenceError and every switch
 * below silently stayed off. That meant every UI-driven agent launch under E2E ran the
 * REAL claude/codex binary at the full 4s/10s delays instead of the mocks. Preload ferries
 * the flags across on `window.termpolisTestFlags`; the `process.env` branch is the
 * fallback for unit tests, which import this module under plain Node.
 */
function testFlag(name: keyof typeof TEST_FLAG_ENV): boolean {
  const bridged = (globalThis as any).termpolisTestFlags
  if (bridged) return !!bridged[name]
  try {
    return process?.env?.[TEST_FLAG_ENV[name]] === '1'
  } catch {}
  return false
}

/** E2E only: keep a trace of the terminal's prompt parses (see TerminalPane's tracePromptParse). */
export function tracesPromptParses(): boolean {
  return testFlag('promptTrace')
}

export function resolveAgentCommand(command: string): string {
  if (testFlag('agents')) {
    return TEST_AGENT_MAP[command] ?? command
  }
  return command
}

/** True when a command string launches Claude Code — used to gate the Headroom proxy (on by default). */
export function isClaudeCommand(command?: string | null): boolean {
  return !!command && command.trim().toLowerCase().startsWith('claude')
}

export function testDelay(ms: number): number {
  if (testFlag('timing')) {
    return Math.max(Math.round(ms / 10), 50)
  }
  return ms
}

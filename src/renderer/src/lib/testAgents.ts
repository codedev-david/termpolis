const TEST_AGENT_MAP: Record<string, string> = {
  'claude': 'node e2e/mocks/mock-claude.cjs',
  'codex': 'node e2e/mocks/mock-codex.cjs',
  'gemini': 'node e2e/mocks/mock-gemini.cjs',
  'qwen': 'node e2e/mocks/mock-qwen.cjs',
  'aider --model ollama/qwen3-coder --no-show-model-warnings': 'node e2e/mocks/mock-aider.cjs',
}

export function resolveAgentCommand(command: string): string {
  try {
    if (process?.env?.TERMPOLIS_TEST_AGENTS === '1') {
      return TEST_AGENT_MAP[command] ?? command
    }
  } catch {}
  return command
}

export function testDelay(ms: number): number {
  try {
    if (process?.env?.TERMPOLIS_TEST_TIMING === '1') {
      return Math.max(Math.round(ms / 10), 50)
    }
  } catch {}
  return ms
}

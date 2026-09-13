// Covers the FALSE arm of conductorPrompt's `modelGuidance ? ... : ''`.
//
// claudeModelGuidance() returns null when the broker registry has no COMPLETE
// Claude tier set (economy + standard + premium). buildConductorPrompt then has
// to close STEP 4 up cleanly — the template interpolates the guidance block
// immediately before "  Then post a status update", so an empty block must not
// leave a stray blank line behind, and no --model advice may survive.
//
// That arm is unreachable through buildConductorPrompt's options, so the broker
// is mocked. vi.mock is hoisted and file-scoped, which is exactly why this lives
// in its own file: conductorPrompt.test.ts keeps testing the REAL broker.
import { describe, it, expect, vi } from 'vitest'
import { buildConductorPrompt } from '../../src/renderer/src/lib/conductorPrompt'

vi.mock('../../src/renderer/src/lib/modelBroker', () => ({
  claudeModelGuidance: () => null,
}))

const build = (): string =>
  buildConductorPrompt({
    taskDescription: 'ship the release',
    installedAgents: { claude: true, codex: true, gemini: true },
    projectCwd: '/home/user/proj',
    shellType: 'bash',
  })

describe('buildConductorPrompt — broker reports no Claude model tiers', () => {
  it('omits the model-selection guidance entirely', () => {
    const prompt = build()
    expect(prompt).not.toContain('MODEL SELECTION')
    expect(prompt).not.toMatch(/conserve tokens/i)
    expect(prompt).not.toContain("'--model haiku'")
    expect(prompt).not.toContain("'--model sonnet'")
    expect(prompt).not.toContain("'--model opus'")
  })

  it('closes STEP 4 with no blank line where the guidance would have been', () => {
    expect(build()).toContain(
      "Gemini CLI  → 'agy --dangerously-skip-permissions'\n  Then post a status update",
    )
  })

  it('still emits the agent launch commands and the rest of the prompt', () => {
    const prompt = build()
    expect(prompt).toContain("Claude Code → 'claude --dangerously-skip-permissions'")
    expect(prompt).toContain("Codex       → 'codex --full-auto'")
    expect(prompt).toContain('ship the release')
    expect(prompt).toContain('/home/user/proj')
    expect(prompt).toContain('Begin now.')
  })

  it('keeps the standing ban on extra flags even with no tiers to offer', () => {
    // The ban text mentions --model as the ONE allowed exception; dropping the
    // guidance block must not drop the rule itself.
    const prompt = build()
    expect(prompt).toContain('NEVER add -p, --sandbox, or --print.')
    expect(prompt).toContain('--model <opus|sonnet|haiku>')
  })
})

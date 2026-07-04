import { describe, it, expect } from 'vitest'
import { buildSecondOpinionMenu, parseSecondOpinion } from '../../src/renderer/src/lib/secondOpinion'

const CLAUDE_MODELS = [
  { alias: 'fable', label: 'Fable' },
  { alias: 'opus', label: 'Opus' },
  { alias: 'sonnet', label: 'Sonnet' },
  { alias: 'haiku', label: 'Haiku' },
]

describe('buildSecondOpinionMenu', () => {
  it('lists only installed top-level agents and nests Claude models', () => {
    const menu = buildSecondOpinionMenu({ claude: true, codex: true, agy: true, 'qwen-code': true }, CLAUDE_MODELS)
    expect(menu.flat.map((o) => o.value)).toEqual(['codex', 'gemini', 'qwen']) // gemini via agy, qwen binary name
    expect(menu.claude?.map((o) => o.value)).toEqual(['claude:fable', 'claude:opus', 'claude:sonnet', 'claude:haiku'])
    expect(menu.hasAny).toBe(true)
  })
  it('hasAny is true from the Claude group alone when no flat agents are installed', () => {
    const menu = buildSecondOpinionMenu({ claude: true }, CLAUDE_MODELS) // no codex/agy/qwen
    expect(menu.flat).toEqual([])
    expect(menu.claude).toHaveLength(4)
    expect(menu.hasAny).toBe(true) // exercises the `flat.length>0 || !!(claude && claude.length>0)` right side
  })
  it('shows Gemini only when agy (the Antigravity CLI) is installed — not the deprecated gemini binary', () => {
    expect(buildSecondOpinionMenu({ agy: true }, CLAUDE_MODELS).flat.map((o) => o.value)).toContain('gemini')
    expect(buildSecondOpinionMenu({ gemini: true }, CLAUDE_MODELS).flat.map((o) => o.value)).not.toContain('gemini')
  })
  it('omits the Claude group entirely when Claude is not installed', () => {
    const menu = buildSecondOpinionMenu({ claude: false, codex: true, agy: false, 'qwen-code': false }, CLAUDE_MODELS)
    expect(menu.claude).toBeNull()
    expect(menu.flat.map((o) => o.value)).toEqual(['codex'])
  })
  it('hasAny is false when nothing is installed', () => {
    const menu = buildSecondOpinionMenu({ claude: false, codex: false, gemini: false, 'qwen-code': false }, CLAUDE_MODELS)
    expect(menu.hasAny).toBe(false)
    expect(menu.flat).toEqual([])
    expect(menu.claude).toBeNull()
  })
  it('tolerates a null install map', () => {
    expect(buildSecondOpinionMenu(null, CLAUDE_MODELS).hasAny).toBe(false)
  })
})

describe('parseSecondOpinion', () => {
  it('parses a nested Claude model value', () => {
    expect(parseSecondOpinion('claude:fable')).toEqual({ agent: 'claude', model: 'fable' })
  })
  it('parses a top-level agent value', () => {
    expect(parseSecondOpinion('codex')).toEqual({ agent: 'codex' })
    expect(parseSecondOpinion('gemini')).toEqual({ agent: 'gemini' })
    expect(parseSecondOpinion('qwen')).toEqual({ agent: 'qwen' })
  })
  it('returns null for the placeholder or an unknown value', () => {
    expect(parseSecondOpinion('')).toBeNull()
    expect(parseSecondOpinion('bogus')).toBeNull()
    expect(parseSecondOpinion('claude:')).toEqual({ agent: 'claude' })
  })
})

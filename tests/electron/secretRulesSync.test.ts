// The anti-drift guard for the Commit Shield.
//
// The git hook must scan a diff in a plain `node` process with Termpolis possibly CLOSED,
// so it cannot import the bundled Electron main process. It therefore carries its own copy
// of the rule table in src/mcp-adapter/secretRules.cjs (which electron-builder already ships
// via extraResources).
//
// Two copies of a security rule set is exactly how a scanner quietly rots: someone adds a
// rule for a new token shape to aiSecurity.ts, the hook never learns about it, and the thing
// you believe is guarding your commits has a hole in it that nobody can see.
//
// This test makes that impossible. It asserts the two tables are equivalent — same ids, same
// labels, same regex sources and flags, same order. Add a rule to one and CI goes red.
//
// If this test fails: DO NOT loosen it. Regenerate secretRules.cjs from aiSecurity.ts.
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'module'
import { RULES } from '../../src/main/aiSecurity'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const require_ = createRequire(import.meta.url)
const hookRules = require_('../../src/mcp-adapter/secretRules.cjs') as {
  id: string
  label: string
  pattern: RegExp
}[]

describe('secret rules — the app and the git hook must never diverge', () => {
  it('the hook ships the same NUMBER of rules as the app', () => {
    expect(hookRules.length).toBe(RULES.length)
    expect(hookRules.length).toBeGreaterThan(50) // sanity: we did not ship an empty table
  })

  it('every rule id matches, in the same order', () => {
    expect(hookRules.map((r) => r.id)).toEqual(RULES.map((r) => r.id))
  })

  it('every rule label matches (the label is what the user is shown on a block)', () => {
    expect(hookRules.map((r) => r.label)).toEqual(RULES.map((r) => r.label))
  })

  it('every regex is IDENTICAL — same source and same flags', () => {
    // The whole point. A pattern that differs by one character is a rule that catches a
    // secret in the prompt path but waves it through at the git boundary.
    const shape = (r: { pattern: RegExp }): string => `${r.pattern.source}//${r.pattern.flags}`
    expect(hookRules.map(shape)).toEqual(RULES.map(shape))
  })

  it('every hook rule is well-formed (real RegExp, non-empty id and label)', () => {
    for (const r of hookRules) {
      expect(r.pattern).toBeInstanceOf(RegExp)
      expect(typeof r.id).toBe('string')
      expect(r.id.length).toBeGreaterThan(0)
      expect(typeof r.label).toBe('string')
      expect(r.label.length).toBeGreaterThan(0)
    }
  })

  it('rule ids are unique (a duplicate id makes a block message ambiguous)', () => {
    expect(new Set(hookRules.map((r) => r.id)).size).toBe(hookRules.length)
  })
})

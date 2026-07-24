import { describe, it, expect } from 'vitest'
import { STARTER_WORKFLOWS } from './starterWorkflows'
import { validateWorkflow } from '../../../../main/workflow/workflowStore'

describe('STARTER_WORKFLOWS', () => {
  it('offers the three launcher starters', () => {
    expect(STARTER_WORKFLOWS.map(w => w.id)).toEqual(['claude-dev', 'full-stack', 'code-review'])
  })

  it('every starter passes the main-process validator (would persist to disk)', () => {
    for (const wf of STARTER_WORKFLOWS) {
      const res = validateWorkflow(wf)
      expect(res.ok, `${wf.id}: ${res.errors.join('; ')}`).toBe(true)
    }
  })

  it('each starter is a single visible inline Command step that opens a pane', () => {
    for (const wf of STARTER_WORKFLOWS) {
      expect(wf.version).toBe(1)
      expect(wf.trigger.type).toBe('manual')
      expect(wf.steps).toHaveLength(1)
      const s = wf.steps[0] as { type: string; source: string; command?: string; visible?: boolean }
      expect(s.type).toBe('command')
      expect(s.source).toBe('inline')
      expect(typeof s.command).toBe('string')
      expect((s.command as string).length).toBeGreaterThan(0)
      expect(s.visible).toBe(true)
    }
  })

  it('uses only distinct, filesystem-safe template ids and names', () => {
    const ids = STARTER_WORKFLOWS.map(w => w.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    for (const wf of STARTER_WORKFLOWS) expect(wf.name.trim().length).toBeGreaterThan(0)
  })
})

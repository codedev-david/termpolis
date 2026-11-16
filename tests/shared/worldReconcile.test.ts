import { describe, expect, it } from 'vitest'
import { applyDesignPatch, emptyDesignDoc, type DesignOp } from '../../src/shared/world/designPatch'
import { linkedPlanStamp, normalizePartName, planStamp, reconcilePlan, NOT_IN_DESIGN } from '../../src/shared/world/reconcile'
import type { Building, WorldDoc } from '../../src/shared/world/types'
import minDoc from './fixtures/world.min.json'

/** The minimal fixture with its buildings replaced (each one a copy of b1 with the given fields). */
function builtWith(list: Partial<Building>[]): WorldDoc {
  const doc = JSON.parse(JSON.stringify(minDoc)) as WorldDoc
  const base = doc.buildings[0]
  doc.buildings = list.map((b) => ({ ...base, members: [], floors: [], ...b }) as Building)
  return doc
}

/** A design (through the real patch path) with one district and the given buildings. */
function planWith(list: { id: string; name: string }[]): WorldDoc {
  const ops: DesignOp[] = [
    { op: 'addDistrict', id: 'core', name: 'Core' },
    ...list.map((b): DesignOp => ({ op: 'addBuilding', id: b.id, districtId: 'core', name: b.name }))
  ]
  const patch = applyDesignPatch(emptyDesignDoc('design:p1', 77), ops)
  expect(patch.applied).toBe(ops.length)
  return patch.doc
}

describe('normalizePartName', () => {
  it('lowercases, strips separators and drops one trailing service/api/app', () => {
    expect(normalizePartName('Payments API')).toBe('payments')
    expect(normalizePartName('User-Profile_Service')).toBe('userprofile')
    expect(normalizePartName('Web App')).toBe('web')
    expect(normalizePartName('apiapi')).toBe('api')
    // A name that is only a suffix keeps it: dropping it would match everything empty.
    expect(normalizePartName('App')).toBe('app')
    expect(normalizePartName('  ')).toBe('')
  })
})

describe('reconcilePlan', () => {
  it("matches by id, by name ignoring case/separators/'Service' suffix, by member path segment", () => {
    const plan = planWith([
      { id: 'aaa', name: 'Something else' },
      { id: 'auth', name: 'Authentication' },
      { id: 'pay', name: 'Payments API' },
      { id: 'profiles', name: 'User Profile Service' },
      { id: 'web', name: 'Web App' }
    ])
    const built = builtWith([
      { id: 'auth', name: 'Something else' },
      { id: 'b3', name: 'web' },
      { id: 'b7', name: 'user_profile' },
      { id: 'b9', name: 'Billing core', members: ['src/payments/index.ts'] }
    ])
    const r = reconcilePlan(plan, built)
    // auth by id wins before "aaa" (first in id order) can take it by name: one built building, one plan building.
    expect(r.matched).toEqual({ auth: 'auth', web: 'b3', profiles: 'b7', pay: 'b9' })
    expect(r.missing).toEqual(['aaa'])
    expect(r.extra).toEqual([])
  })

  it('missing and extra lists', () => {
    const plan = planWith([
      { id: 'orders', name: 'Orders Service' },
      { id: 'search', name: 'Search' },
      { id: 'mail', name: 'Mailer' },
      { id: 'zeta', name: 'Zeta' }
    ])
    const built = builtWith([
      // Windows separators and a file name with its extension still count as path segments.
      { id: 'x2', name: 'Shop', members: ['src\\orders\\main.ts'] },
      // A floor's members count too.
      { id: 'x3', name: 'Lookup', floors: [{ name: 'F', tech: [], members: ['lib/search.ts'] }] },
      { id: 'x1', name: 'Cron' },
      { id: 'x0', name: 'Telemetry' }
    ])
    const r = reconcilePlan(plan, built)
    expect(r.matched).toEqual({ orders: 'x2', search: 'x3' })
    expect(r.missing).toEqual(['mail', 'zeta'])
    expect(r.extra).toEqual(['x0', 'x1'])

    // Nothing planned: everything built is extra. Nothing built: everything planned is missing.
    expect(reconcilePlan(planWith([]), built)).toEqual({ matched: {}, missing: [], extra: ['x0', 'x1', 'x2', 'x3'] })
    expect(reconcilePlan(plan, builtWith([]))).toEqual({ matched: {}, missing: ['mail', 'orders', 'search', 'zeta'], extra: [] })
  })

  it('an empty normalized name never matches by name or path', () => {
    const plan = planWith([{ id: 'p', name: '---' }])
    const built = builtWith([{ id: 'q', name: '...', members: ['a//b.ts'] }])
    expect(reconcilePlan(plan, built)).toEqual({ matched: {}, missing: ['p'], extra: ['q'] })
  })

  it('an unchecked world with a repeated id still reconciles: one built building per plan id', () => {
    const plan = planWith([{ id: 'a', name: 'Alpha' }])
    const built = builtWith([{ id: 'a', name: 'One' }, { id: 'a', name: 'Two' }, { id: 'z', name: 'Zed' }])
    expect(reconcilePlan(plan, built)).toEqual({ matched: { a: 'a' }, missing: [], extra: ['z'] })
  })
})

describe('plan stamps', () => {
  it('stamps a plan by key and time, and reads the stamp a linked proposal carries', () => {
    const plan = planWith([])
    expect(planStamp(null)).toBe('')
    expect(planStamp(plan)).toBe('design:p1@77')
    const doc = builtWith([])
    expect(linkedPlanStamp(doc)).toBe('')
    doc.layers.plan.push({ id: 'p0', title: 'Not linked', summary: [], buildings: [], edges: [] })
    expect(linkedPlanStamp(doc)).toBe('')
    doc.layers.plan.push({
      id: 'design:p1', title: 'Linked design', summary: [], buildings: [], edges: [],
      reconcile: { matched: {}, missing: [], extra: [], planAt: 77 }
    })
    expect(linkedPlanStamp(doc)).toBe(planStamp(plan))
    expect(NOT_IN_DESIGN).toBe('not in the design')
  })
})

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
    expect(reconcilePlan(planWith([]), built)).toEqual({ matched: {}, missing: [], extra: ['x0', 'x1', 'x2', 'x3'], changed: [] })
    expect(reconcilePlan(plan, builtWith([]))).toEqual({ matched: {}, missing: ['mail', 'orders', 'search', 'zeta'], extra: [], changed: [] })
  })

  it('an empty normalized name never matches by name or path', () => {
    const plan = planWith([{ id: 'p', name: '---' }])
    const built = builtWith([{ id: 'q', name: '...', members: ['a//b.ts'] }])
    expect(reconcilePlan(plan, built)).toEqual({ matched: {}, missing: ['p'], extra: ['q'], changed: [] })
  })

  it('an unchecked world with a repeated id still reconciles: one built building per plan id', () => {
    const plan = planWith([{ id: 'a', name: 'Alpha' }])
    const built = builtWith([{ id: 'a', name: 'One' }, { id: 'a', name: 'Two' }, { id: 'z', name: 'Zed' }])
    expect(reconcilePlan(plan, built)).toMatchObject({ matched: { a: 'a' }, missing: [], extra: ['z'], changed: [] })
  })
})

describe('reconcilePlan changed', () => {
  const planOf = (over: Partial<Building>): WorldDoc => {
    const doc = planWith([{ id: 'pay', name: 'Payments' }, { id: 'web', name: 'Web' }])
    Object.assign(doc.buildings.find((b) => b.id === 'pay') as Building, over)
    return doc
  }
  const at = (over: Partial<Building> = {}): WorldDoc =>
    builtWith([{ id: 'b1', name: 'Payments', members: [], stack: [], floors: [], ...over }, { id: 'b2', name: 'Web', members: ['w.ts'] }])

  it('reconcile marks a matched part with different members as changed', () => {
    const plan = planOf({ members: ['src/pay.ts', 'src/refund.ts'] })
    expect(reconcilePlan(plan, at({ members: ['src/pay.ts'] })).changed).toEqual(['b1'])
    expect(reconcilePlan(plan, at({ members: ['src/pay.ts', 'src/refund.ts', 'x.ts'] })).changed).toEqual([]) // met: done
    // A planned file inside a floor counts as present.
    expect(reconcilePlan(plan, at({ members: ['src/pay.ts'], floors: [{ name: 'F', tech: [], members: ['src/refund.ts'] }] })).changed).toEqual([])
    // Unmatched parts, and parts that ask for nothing, are never changed.
    expect(reconcilePlan(planOf({}), at()).changed).toEqual([])
    expect(reconcilePlan(plan, builtWith([])).changed).toEqual([])
  })

  it('marks a part changed while a planned floor or tech is missing, whatever the case or order', () => {
    const plan = planOf({ floors: [{ name: 'Checkout', tech: ['Stripe'], members: [] }], stack: ['Node'] })
    expect(reconcilePlan(plan, at()).changed).toEqual(['b1'])
    expect(reconcilePlan(plan, at({ floors: [{ name: 'checkout', tech: [], members: [] }], stack: ['node'] })).changed).toEqual(['b1']) // Stripe missing
    expect(reconcilePlan(plan, at({ floors: [{ name: 'Other', tech: ['stripe'], members: [] }], stack: ['node'] })).changed).toEqual(['b1']) // floor missing
    expect(reconcilePlan(plan, at({ floors: [{ name: 'checkout', tech: ['stripe'], members: [] }], stack: ['NODE'] })).changed).toEqual([])
  })

  it('is stateless: the same build gives the same answer every time, so a recompile keeps the outline', () => {
    const plan = planOf({ stack: ['Stripe'] })
    const built = at({ members: ['a.ts'] })
    expect(reconcilePlan(plan, built).changed).toEqual(['b1'])
    expect(reconcilePlan(plan, built).changed).toEqual(['b1'])
    expect(reconcilePlan(plan, at({ members: ['a.ts'], stack: ['Stripe'] })).changed).toEqual([])
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

import { describe, it, expect } from 'vitest'
import {
  machineViews,
  pruneMeta,
  resolveMachine,
  uniqueName,
  type DesktopPeer,
  type DirectoryInput,
  type LinkedMachineView,
} from '../../src/main/linkedDirectory'
import type { JoinedLink, LinkMeta } from '../../src/main/linkedStore'

const PEER_ID = 'a1b2c3d4e5f60718'
const LINK_ID = '0011223344556677'
const PHRASE = 'acorn admiral agate album amber anchor antler apricot'

const peer = (over: Partial<DesktopPeer> = {}): DesktopPeer => ({
  id: PEER_ID,
  label: 'DESKTOP-7F3K',
  pairedAt: 1_000,
  ...over,
})

const link = (over: Partial<JoinedLink> = {}): JoinedLink => ({
  id: LINK_ID,
  hostPublicKey: '0f'.repeat(32),
  relayUrl: 'wss://relay.example.com',
  sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
  secretKey: '1e'.repeat(32),
  linkedAt: 2_000,
  ...over,
})

const meta = (over: Partial<LinkMeta> = {}): LinkMeta => ({
  ref: `link:${LINK_ID}`,
  name: 'linux',
  grants: { run: true, write: true },
  confirmed: true,
  linkedAt: 3_000,
  ...over,
})

const input = (over: Partial<DirectoryInput> = {}): DirectoryInput => ({
  peers: [],
  links: [],
  meta: [],
  online: new Set<string>(),
  lastActivity: new Map<string, number>(),
  ...over,
})

describe('machineViews', () => {
  it('shows one row per hosted peer and per joined link, named by their meta', () => {
    const views = machineViews(
      input({
        peers: [peer()],
        links: [link()],
        meta: [meta(), meta({ ref: `device:${PEER_ID}`, name: 'Office PC', grants: { run: true, write: false }, linkedAt: 4_000 })],
        online: new Set([`link:${LINK_ID}`]),
        lastActivity: new Map([[`device:${PEER_ID}`, 9_000]]),
      }),
    )
    expect(views).toEqual([
      { ref: `link:${LINK_ID}`, name: 'linux', online: true, confirmed: true, grants: { run: true, write: true }, linkedAt: 3_000 },
      {
        ref: `device:${PEER_ID}`,
        name: 'Office PC',
        online: false,
        confirmed: true,
        grants: { run: true, write: false },
        linkedAt: 4_000,
        lastActivityAt: 9_000,
      },
    ])
  })

  it('describes a machine without meta as unconfirmed, with the default grants', () => {
    // A peer keeps the name it suggested for itself; a joined link has no name
    // of its own until the user gives it one.
    const views = machineViews(input({ peers: [peer({ label: '\u001b]0;evil\u0007  Build box ' })], links: [link()] }))
    expect(views).toEqual([
      { ref: `device:${PEER_ID}`, name: ']0;evil  Build box', online: false, confirmed: false, grants: { run: true, write: false }, linkedAt: 1_000 },
      { ref: `link:${LINK_ID}`, name: 'Computer', online: false, confirmed: false, grants: { run: true, write: false }, linkedAt: 2_000 },
    ])
    expect(machineViews(input({ peers: [peer({ label: '\u0000 ' })] }))[0].name).toBe('Computer')
  })

  it('hands out grants nobody else holds', () => {
    const [a, b] = machineViews(input({ links: [link(), link({ id: 'ffffffffffffffff' })] }))
    a.grants.write = true
    expect(b.grants).toEqual({ run: true, write: false })
    expect(machineViews(input({ links: [link()] }))[0].grants).toEqual({ run: true, write: false })
  })

  it('shows the safety words only while a link waits for confirmation', () => {
    const views = machineViews(
      input({
        links: [link(), link({ id: 'ffffffffffffffff' })],
        meta: [meta({ confirmed: false, phrase: PHRASE }), meta({ ref: 'link:ffffffffffffffff', name: 'mac', phrase: PHRASE })],
      }),
    )
    expect(views.find((v) => v.name === 'linux')).toMatchObject({ confirmed: false, phrase: PHRASE })
    expect(views.find((v) => v.name === 'mac')).not.toHaveProperty('phrase')
  })

  it('fails closed on meta grants that are not two booleans, and applies write-implies-run', () => {
    const views = machineViews(
      input({
        links: [link(), link({ id: 'ffffffffffffffff' })],
        meta: [
          meta({ grants: { run: 'yes' } as unknown as LinkMeta['grants'] }),
          meta({ ref: 'link:ffffffffffffffff', name: 'mac', grants: { run: false, write: true } }),
        ],
      }),
    )
    expect(views.find((v) => v.name === 'linux')?.grants).toEqual({ run: false, write: false })
    expect(views.find((v) => v.name === 'mac')?.grants).toEqual({ run: true, write: true })
  })

  it('sorts by name without regard to case, then by ref', () => {
    const ids = ['0000000000000001', '0000000000000002', '0000000000000003', '0000000000000004']
    const views = machineViews(
      input({
        links: ids.map((id) => link({ id })),
        meta: [
          meta({ ref: `link:${ids[0]}`, name: 'zeta' }),
          meta({ ref: `link:${ids[1]}`, name: 'Alpha' }),
          meta({ ref: `link:${ids[2]}`, name: 'beta' }),
        ],
        peers: [peer({ label: 'beta' })],
      }),
    )
    expect(views.map((v) => `${v.name}|${v.ref}`)).toEqual([
      `Alpha|link:${ids[1]}`,
      `beta|device:${PEER_ID}`,
      `beta|link:${ids[2]}`,
      `Computer|link:${ids[3]}`,
      `zeta|link:${ids[0]}`,
    ])
  })

  it('ignores meta for machines that are gone and repeated peers or links', () => {
    const views = machineViews(
      input({
        peers: [peer(), peer({ label: 'again' })],
        links: [link(), link({ linkedAt: 99 })],
        meta: [meta({ ref: 'link:ffffffffffffffff', name: 'gone' })],
      }),
    )
    // 'Computer' (the unnamed link) sorts before 'DESKTOP-7F3K'.
    expect(views.map((v) => v.ref)).toEqual([`link:${LINK_ID}`, `device:${PEER_ID}`])
    expect(views[0].linkedAt).toBe(2_000)
    expect(views[1].name).toBe('DESKTOP-7F3K')
  })

  it('takes the first meta record for a ref', () => {
    const [view] = machineViews(input({ links: [link()], meta: [meta({ name: 'first' }), meta({ name: 'second' })] }))
    expect(view.name).toBe('first')
  })
})

describe('resolveMachine', () => {
  const views: LinkedMachineView[] = machineViews(
    input({
      peers: [peer()],
      links: [link()],
      meta: [meta({ name: 'Linux Box' }), meta({ ref: `device:${PEER_ID}`, name: `link:${LINK_ID}` })],
    }),
  )
  const byRef = (ref: string) => views.find((v) => v.ref === ref)

  it('matches an exact ref first', () => {
    // A machine the user named after another's ref still cannot capture it.
    expect(resolveMachine(views, `link:${LINK_ID}`)).toBe(byRef(`link:${LINK_ID}`))
    expect(resolveMachine(views, `device:${PEER_ID}`)).toBe(byRef(`device:${PEER_ID}`))
  })

  it('matches a name without regard to case', () => {
    expect(resolveMachine(views, 'linux box')).toBe(byRef(`link:${LINK_ID}`))
    expect(resolveMachine(views, 'LINUX BOX')).toBe(byRef(`link:${LINK_ID}`))
  })

  it('tries the trimmed input last', () => {
    expect(resolveMachine(views, '  Linux Box \n')).toBe(byRef(`link:${LINK_ID}`))
    expect(resolveMachine(views, ` link:${LINK_ID} `)).toBe(byRef(`link:${LINK_ID}`))
  })

  it('returns null when nothing matches', () => {
    expect(resolveMachine(views, 'mac')).toBeNull()
    expect(resolveMachine(views, '')).toBeNull()
    expect(resolveMachine(views, '   ')).toBeNull()
    expect(resolveMachine([], 'linux box')).toBeNull()
    expect(resolveMachine(views, 7 as unknown as string)).toBeNull()
  })

  it('compares names in one Unicode form', () => {
    const accented = machineViews(input({ links: [link()], meta: [meta({ name: 'Café' })] }))
    expect(resolveMachine(accented, 'café')?.name).toBe('Café')
  })
})

describe('uniqueName', () => {
  it('keeps a free name as it is', () => {
    expect(uniqueName([], 'linux')).toBe('linux')
    expect(uniqueName(['mac', 'desk'], 'linux')).toBe('linux')
  })

  it('numbers a taken name, comparing without regard to case', () => {
    expect(uniqueName(['linux'], 'linux')).toBe('linux (2)')
    expect(uniqueName(['LINUX'], 'linux')).toBe('linux (2)')
    expect(uniqueName(['linux', 'Linux (2)', 'linux (3)'], 'linux')).toBe('linux (4)')
    expect(uniqueName(['linux', 'linux (3)'], 'linux')).toBe('linux (2)')
  })

  it('sanitizes the base and falls back to Computer', () => {
    expect(uniqueName([], '  \u001b[2Jbox\u0007 ')).toBe('[2Jbox')
    expect(uniqueName([], '')).toBe('Computer')
    expect(uniqueName([], ' \u0000 ')).toBe('Computer')
    expect(uniqueName(['computer'], 42 as unknown as string)).toBe('Computer (2)')
  })

  it('stays within 64 characters once numbered', () => {
    const long = 'x'.repeat(80)
    expect(uniqueName([], long)).toBe('x'.repeat(64))
    const numbered = uniqueName(['x'.repeat(64)], long)
    expect(numbered).toBe(`${'x'.repeat(60)} (2)`)
    expect(numbered.length).toBe(64)
    // A cut that lands on a space does not leave a double space before the number.
    const spaced = `${'y'.repeat(59)} ${'z'.repeat(10)}`
    expect(uniqueName([spaced.slice(0, 64)], spaced)).toBe(`${'y'.repeat(59)} (2)`)
  })
})

describe('pruneMeta', () => {
  it('keeps meta only for peers and links that still exist', () => {
    const keepPeer = meta({ ref: `device:${PEER_ID}` })
    const keepLink = meta()
    const result = pruneMeta(
      [
        keepPeer,
        keepLink,
        meta({ ref: 'device:ffffffffffffffff' }),
        meta({ ref: `link:${PEER_ID}` }),
        meta({ ref: `device:${LINK_ID}` }),
        meta({ ref: 'garbage' }),
      ],
      [peer()],
      [link()],
    )
    expect(result).toEqual([keepPeer, keepLink])
  })

  it('drops everything when nothing is linked', () => {
    expect(pruneMeta([meta()], [], [])).toEqual([])
  })
})

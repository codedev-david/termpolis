// Who this machine is linked with, as one list.
//
// Linked machines come from two places that know nothing of each other: the
// computers that entered a code this machine created (desktop peers, in the
// bridge's device registry) and the computers whose code this machine entered
// (joined links, in linkedStore). This joins them with the names, grants and
// confirmation main keeps for each, so the settings screen and the agent tool
// read one list and agree about what it says. Pure: the caller hands in a
// snapshot and gets views back.
import { MAX_DEVICE_LABEL, sanitizeDeviceLabel } from './remoteBridge/deviceLabel'
import {
  DEFAULT_GRANTS,
  DEFAULT_MACHINE_NAME,
  normalizeGrants,
  refOf,
  type JoinedLink,
  type LinkedGrants,
  type LinkMeta,
} from './linkedStore'

/** A bridge `PairedDevice` with `kind: 'desktop'`: a computer that entered a
 *  code this machine created. */
export interface DesktopPeer {
  id: string
  label: string
  pairedAt: number
}

export interface LinkedMachineView {
  ref: string
  name: string
  online: boolean
  confirmed: boolean
  /** The safety words, while the link waits for confirmation. */
  phrase?: string
  grants: LinkedGrants
  linkedAt: number
  lastActivityAt?: number
}

export interface DirectoryInput {
  peers: DesktopPeer[]
  links: JoinedLink[]
  meta: LinkMeta[]
  /** Refs (`'device:<id>'` / `'link:<id>'`) of the machines reachable right now. */
  online: ReadonlySet<string>
  /** Last job activity per ref, epoch ms. */
  lastActivity: ReadonlyMap<string, number>
}

/** One spelling per name for comparison: case-folded, and in one Unicode form so
 *  an accent typed as one code point matches the same accent typed as two. */
function fold(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/** One view per hosted peer and per joined link, sorted by name without regard
 *  to case (then by ref, so equal names keep a stable order).
 *
 *  A machine with no meta yet -- one whose pairing finished a moment ago -- is
 *  shown unconfirmed with the default grants, under the name it suggested for
 *  itself (a peer's label) or a placeholder (a joined link: the host's name
 *  arrives with the pairing, which is when main writes the meta). Meta whose
 *  machine has gone is not shown; `pruneMeta` is what forgets it. */
export function machineViews(input: DirectoryInput): LinkedMachineView[] {
  const metaByRef = new Map<string, LinkMeta>()
  for (const m of input.meta) if (!metaByRef.has(m.ref)) metaByRef.set(m.ref, m)

  const views: LinkedMachineView[] = []
  const seen = new Set<string>()
  const add = (ref: string, fallbackName: string, recordedAt: number): void => {
    if (seen.has(ref)) return
    seen.add(ref)
    const meta = metaByRef.get(ref)
    const lastActivityAt = input.lastActivity.get(ref)
    const view: LinkedMachineView = meta
      ? {
          ref,
          name: meta.name,
          online: input.online.has(ref),
          confirmed: meta.confirmed === true,
          // Not two booleans is no grant at all: this view is what Settings
          // shows, and showing a permission the file does not hold would lie.
          grants: normalizeGrants(meta.grants) ?? { run: false, write: false },
          linkedAt: meta.linkedAt,
          ...(meta.confirmed !== true && meta.phrase ? { phrase: meta.phrase } : {}),
        }
      : {
          ref,
          name: fallbackName,
          online: input.online.has(ref),
          confirmed: false,
          grants: { ...DEFAULT_GRANTS },
          linkedAt: recordedAt,
        }
    views.push(lastActivityAt === undefined ? view : { ...view, lastActivityAt })
  }

  for (const p of input.peers) {
    add(refOf({ via: 'device', id: p.id }), sanitizeDeviceLabel(p.label) || DEFAULT_MACHINE_NAME, p.pairedAt)
  }
  for (const l of input.links) add(refOf({ via: 'link', id: l.id }), DEFAULT_MACHINE_NAME, l.linkedAt)

  return views.sort((a, b) => compare(fold(a.name), fold(b.name)) || compare(a.ref, b.ref))
}

/** Plain code-unit order, so the list sorts the same on every machine whatever
 *  its locale. */
function compare(x: string, y: string): number {
  return Number(x > y) - Number(x < y)
}

/** The machine an agent or the UI means: an exact ref first, so no name can
 *  capture another machine's ref; then a name, without regard to case; then
 *  the same two again with the input trimmed. */
export function resolveMachine(views: LinkedMachineView[], nameOrRef: string): LinkedMachineView | null {
  if (typeof nameOrRef !== 'string') return null
  const find = (q: string): LinkedMachineView | undefined =>
    views.find((v) => v.ref === q) ?? views.find((v) => fold(v.name) === fold(q))
  return find(nameOrRef) ?? find(nameOrRef.trim()) ?? null
}

/** A name nobody else has. `taken` holds the other machines' names -- the
 *  caller leaves out the one being renamed. Sanitized like every device label
 *  (no control characters, trimmed, at most 64 chars); numbered `X (2)`,
 *  `X (3)`... the way the phone numbers two desktops with one hostname, but
 *  compared without regard to case, because an agent addresses machines that
 *  way and `Linux` and `linux` would be one name to it. */
export function uniqueName(taken: string[], base: string): string {
  const name = sanitizeDeviceLabel(base) || DEFAULT_MACHINE_NAME
  const used = new Set(taken.map(fold))
  if (!used.has(fold(name))) return name
  // Terminates: each pass tries a new number, and only `taken.length` can be in use.
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`
    const candidate = `${name.slice(0, MAX_DEVICE_LABEL - suffix.length).trimEnd()}${suffix}`
    if (!used.has(fold(candidate))) return candidate
  }
}

/** Meta for machines that still exist. A peer's meta lives as long as the
 *  bridge's device record, a joined link's as long as the link. */
export function pruneMeta(meta: LinkMeta[], peers: DesktopPeer[], links: JoinedLink[]): LinkMeta[] {
  const live = new Set([
    ...peers.map((p) => refOf({ via: 'device', id: p.id })),
    ...links.map((l) => refOf({ via: 'link', id: l.id })),
  ])
  return meta.filter((m) => live.has(m.ref))
}

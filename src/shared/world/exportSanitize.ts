// Lumopolis export: the privacy boundary. Every exported page and every generated document is built from the
// WorldDoc this module returns, so nothing here may let through an absolute path, the home or userData folder,
// a memory note, a transcript step, an evidence excerpt or a secret. The doc is rebuilt field by field from the
// WorldDoc contract (types.ts): a field this file does not name is dropped, never copied.

import { redactSecrets } from '../appLog'
import type { Building, BuildingGrowth, Claim, District, Evidence, EvidenceKind, External, Floor, PlanReconcile, Proposal, Tour, WorldDoc, WorldEdge } from './types'

/** Where the export is made from. `root` is the project folder, null for a design world (it has no folder). */
export interface SanitizeContext { root: string | null; home: string; userData: string }

/** What a path outside the project becomes (followed by `/<basename>` when it has one). */
export const OUTSIDE = '<outside the project>'

/** A design world's key (main/world/designer.ts DESIGN_KEY_RE): it holds no path, so it is kept as it is. */
const DESIGN_KEY = /^design:[A-Za-z0-9][A-Za-z0-9._-]*$/
/** Evidence kinds whose ref is a project path; every other ref is free text. */
const PATH_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['file', 'symbol', 'test'])
/** Evidence kinds that quote the person's notes or agent sessions: never exported. */
const PRIVATE_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['memory', 'transcriptStep'])

/** Forward slashes, no trailing slash. */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
/** A drive path or a UNC path: compared without regard to case. */
const windowsLike = (p: string): boolean => /^[A-Za-z]:(\/|$)/.test(p) || p.startsWith('//')
const isAbsolute = (p: string): boolean => /^[A-Za-z]:(\/|$)/.test(p) || p.startsWith('/')

/** Whether `p` (normalised) lies in or is `base` (normalised), by whole folder names; gives the segments past it. */
function under(p: string, base: string): string[] | null {
  if (!base) return null
  const fold = windowsLike(base) ? (s: string): string => s.toLowerCase() : (s: string): string => s
  const ps = p.split('/')
  const bs = base.split('/')
  if (ps.length < bs.length || bs.some((s, i) => fold(s) !== fold(ps[i]))) return null
  return ps.slice(bs.length)
}

/** The last real name in a path: no empty, dot or drive part. */
function baseName(segments: string[]): string {
  const names = segments.filter((s) => s !== '' && s !== '.' && s !== '..')
  const last = names.length ? names[names.length - 1] : ''
  return /^[A-Za-z]:$/.test(last) ? '' : last
}

const outside = (segments: string[]): string => {
  const name = baseName(segments)
  return name ? `${OUTSIDE}/${name}` : OUTSIDE
}

/** Folds `.` and `..` out of a relative path; one that climbs above its start is outside the project. */
function resolveRelative(segments: string[]): string {
  const kept: string[] = []
  for (const s of segments) {
    if (s === '' || s === '.') continue
    if (s !== '..') kept.push(s)
    else if (!kept.pop()) return outside(segments)
  }
  return kept.join('/') || '.'
}

/**
 * A path as the export may show it: relative to the project root with forward slashes, or `<outside the project>/`
 * and its basename. The home and userData folders themselves become `<outside the project>` alone, so the account
 * name never shows. `~` stands for the home folder.
 */
export function relativePath(p: string, ctx: SanitizeContext): string {
  let n = p.replace(/\\/g, '/')
  if (n === '~' || n.startsWith('~/')) n = norm(ctx.home) + n.slice(1)
  if (!isAbsolute(n)) return n ? resolveRelative(n.split('/')) : ''
  const n2 = norm(n)
  const inRoot = ctx.root === null ? null : under(n2, norm(ctx.root))
  if (inRoot) return resolveRelative(inRoot)
  if ([ctx.home, ctx.userData].some((b) => under(n2, norm(b))?.length === 0)) return OUTSIDE
  return outside(n2.split('/'))
}

/** A RegExp source matching `base` in either slash form and any letter case. */
function baseSource(base: string): string {
  return norm(base).split('/').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)).join('[\\\\/]')
}

/** Whatever the app's log scanner (appLog.ts) takes for a secret, as `[redacted]`. */
const redact = (text: string): string => redactSecrets(text).replace(/<redacted(?:-[a-z]+)?>/g, '[redacted]')

/** The characters a path in free text runs on with: up to a space, a quote, an angle bracket or a pipe. */
const REST = `[^\\s"'<>|]*`
/** Absolute paths found in free text without knowing the folders: drive, UNC (backslashes), `~` and user folders. */
const GENERIC = [
  `\\b[A-Za-z]:[\\\\/]${REST}`,
  `\\\\\\\\[^\\s\\\\/"'<>|]+[\\\\/]${REST}`,
  `\\B~[\\\\/]${REST}`,
  `\\B/(?:home|Users|root|mnt|media|Volumes|tmp|private)(?![A-Za-z0-9._-])${REST}`,
].join('|')
/** Punctuation that ends a sentence, not a path. */
const TRAILING = /[.,;:!?)\]}]+$/

function pathPattern(ctx: SanitizeContext): RegExp {
  const bases = [ctx.root ?? '', ctx.userData, ctx.home].filter((b) => norm(b) !== '')
    .sort((a, b) => norm(b).length - norm(a).length).map(baseSource)
  // `(?!)` never matches: with no folder known, group 1 simply never takes part. A known folder must end at a whole
  // name: not followed by a name character, nor by a dot that starts one (a dot ending the sentence is fine).
  const known = [...bases, '(?!)'].join('|')
  return new RegExp(`(${known})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9._-])((?:[\\\\/]${REST})?)|(${GENERIC})`, 'g')
}

/**
 * Free text as the export may show it: a secret the app's log scanner recognises becomes `[redacted]`, then every
 * absolute path in it is rewritten with relativePath (the project root, the home and userData folders are found
 * in either slash form and any case, even holding spaces).
 */
export function sanitizeText(text: string, ctx: SanitizeContext): string {
  return textCleaner(ctx)(text)
}

/** sanitizeText for one context, its pattern built once (a world holds thousands of strings). */
function textCleaner(ctx: SanitizeContext): (text: string) => string {
  const pattern = pathPattern(ctx)
  const rewrite = (m: string, base: string | undefined, rest: string | undefined): string => {
    const path = base === undefined ? m : base + rest
    // A folder named alone keeps its last character; a path running on drops the punctuation that ends a sentence.
    const tail = base === undefined || rest ? (TRAILING.exec(path) ?? [''])[0] : ''
    return relativePath(path.slice(0, path.length - tail.length), ctx) + tail
  }
  return (text) => redact(text).replace(pattern, rewrite)
}

/** Rebuilds a WorldDoc from its known fields only, with every path relative and no private evidence. */
export function sanitizeWorld(doc: WorldDoc, ctx: SanitizeContext): WorldDoc {
  const text = textCleaner(ctx)
  const path = (s: string): string => relativePath(s, ctx)
  const evidence = (e: Evidence): Evidence =>
    ({ kind: e.kind, ref: PATH_KINDS.has(e.kind) ? redact(path(e.ref)) : text(e.ref) })
  const claims = (list: Claim[]): Claim[] => list.map((c) =>
    ({ text: text(c.text), state: c.state, evidence: c.evidence.filter((e) => !PRIVATE_KINDS.has(e.kind)).map(evidence) }))
  const floor = (f: Floor): Floor => ({ name: text(f.name), tech: f.tech.map(text), members: f.members.map(path) })
  const growth = (g: BuildingGrowth): BuildingGrowth => ({
    start: g.start, seed: path(g.seed), ...(g.folder !== undefined ? { folder: path(g.folder) } : {}),
    merged: g.merged, mergedFiles: g.mergedFiles, ...(g.reached !== undefined ? { reached: g.reached } : {}),
    ...(g.inFolder !== undefined ? { inFolder: g.inFolder } : {}), folded: g.folded, cap: g.cap,
  })
  const building = (b: Building): Building => ({
    id: b.id, districtId: b.districtId, name: text(b.name), techLabel: text(b.techLabel), process: b.process,
    floors: b.floors.map(floor), stack: b.stack.map(text), how: claims(b.how), why: claims(b.why), status: b.status,
    members: b.members.map(path), claims: claims(b.claims), nameState: b.nameState,
    ...(b.growth ? { growth: growth(b.growth) } : {}),
  })
  const edge = (e: WorldEdge): WorldEdge => ({
    id: e.id, from: e.from, to: e.to, cargo: e.cargo, label: text(e.label), how: claims(e.how), tech: e.tech.map(text),
    why: claims(e.why), rate: text(e.rate), twoWay: e.twoWay, ...(e.twoWayStated ? { twoWayStated: true as const } : {}),
    claims: claims(e.claims),
  })
  const district = (d: District): District =>
    ({ id: d.id, name: text(d.name), subtitle: text(d.subtitle), hue: d.hue, members: d.members.map(path), nameState: d.nameState })
  const external = (x: External): External => ({ id: x.id, name: text(x.name), kind: x.kind, fog: x.fog })
  const tour = (t: Tour): Tour =>
    ({ id: t.id, title: text(t.title), steps: t.steps.map((s) => ({ ids: [...s.ids], caption: text(s.caption) })) })
  const reconcile = (r: PlanReconcile & { planAt: number }): PlanReconcile & { planAt: number } =>
    ({ matched: { ...r.matched }, missing: [...r.missing], extra: [...r.extra], changed: [...r.changed], planAt: r.planAt })
  const proposal = (p: Proposal): Proposal => ({
    id: p.id, title: text(p.title), summary: claims(p.summary), buildings: p.buildings.map(building), edges: p.edges.map(edge),
    ...(p.reconcile ? { reconcile: reconcile(p.reconcile) } : {}), ...(p.removes ? { removes: [...p.removes] } : {}),
  })
  const record = <T, U>(r: Record<string, T>, key: (k: string) => string, value: (v: T) => U): Record<string, U> =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [key(k), value(v)]))
  const same = (k: string): string => k
  const projectKey = DESIGN_KEY.test(doc.projectKey) ? doc.projectKey
    : ctx.root !== null ? baseName(norm(ctx.root).split('/')) : text(doc.projectKey)
  return {
    version: doc.version, projectKey, generatedAt: doc.generatedAt,
    sourceRevision: { head: doc.sourceRevision.head, dirty: doc.sourceRevision.dirty },
    districts: doc.districts.map(district), buildings: doc.buildings.map(building), edges: doc.edges.map(edge),
    externals: doc.externals.map(external),
    glossary: record(doc.glossary, text, text),
    cargo: record(doc.cargo, same, (c) => ({ shape: c.shape, color: c.color, label: text(c.label) })),
    processes: record(doc.processes, same, (p) => ({ label: text(p.label), color: p.color })),
    tours: doc.tours.map(tour),
    layout: {
      seed: doc.layout.seed, positions: record(doc.layout.positions, same, (v) => [v[0], v[1], v[2]] as [number, number, number]),
      ...(doc.layout.round !== undefined ? { round: doc.layout.round } : {}),
    },
    runtimeNames: record(doc.runtimeNames, same, (names) => names.map(text)),
    ...(doc.runtimeHandSet ? { runtimeHandSet: [...doc.runtimeHandSet] } : {}),
    layers: { plan: doc.layers.plan.map(proposal) },
    ...(doc.labelTokens !== undefined ? { labelTokens: doc.labelTokens } : {}),
  }
}

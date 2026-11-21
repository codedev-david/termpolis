// Lumopolis export: the privacy boundary. Every exported page and every generated document is built from the
// WorldDoc this module returns, so nothing here may let through an absolute path, the home or userData folder,
// a memory note, a transcript step, an evidence excerpt or a secret. The doc is rebuilt field by field from the
// WorldDoc contract (types.ts): a field this file does not name is dropped, never copied.
//
// What counts as a revealing path in free text (REVEALING_PATH, isRevealingPath): one that names a place on the
// machine, so it is always rewritten. It is a route-safe heuristic, deliberately so: a claim saying a service
// "serves /api/users" must keep its words.
//   - Windows drive paths: standalone with either slash (`C:\x`, `C:/x`; `C://` is a URL), glued after a digit or
//     `_` with either slash (`x_C:/x`), glued after a letter only with a backslash (`xC:\x`), so prose such as
//     `route:/users` keeps its words. The project, home and userData folders are caught glued in any form anyway.
//   - UNC paths (`\\server\share`), with the long forms `\\?\` and `\\.\`.
//   - `file://` URLs, whatever the host.
//   - `~/` and `~user/`.
//   - POSIX paths whose first folder is home, Users, root, mnt, media, Volumes, tmp, private, var, opt, srv,
//     workspace or workspaces, in any letter case, starting the text or after a space, quote, bracket, `=`, `,`
//     or `;` (not after `:`, so `route:/users` stays prose).
// Other absolute POSIX text (`/api/users`, `/etc/hosts`) is left alone. Beyond that definition, the project root,
// the home folder and the userData folder are found wherever they appear (any case, either slash, doubled
// backslashes, the long and admin-share forms), so a folder name holding a space never splits.

import { redactSecrets } from '../appLog'
import type { Building, BuildingGrowth, Claim, District, Evidence, EvidenceKind, External, Floor, PlanReconcile, Proposal, Tour, WorldDoc, WorldEdge } from './types'

/** Where the export is made from. `root` is the project folder, null for a design world (it has no folder). */
export interface SanitizeContext { root: string | null; home: string; userData: string }

/** What a path outside the project becomes (followed by `/<basename>` when it has one). */
export const OUTSIDE = '<outside the project>'

/** A design world's key (main/world/designer.ts DESIGN_KEY_RE): it holds no path, so it is kept as it is. */
const DESIGN_KEY = /^design:[A-Za-z0-9][A-Za-z0-9._-]*$/
/** Evidence kinds whose ref is a project path; the other kept kinds' refs are free text. */
const PATH_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['file', 'symbol', 'test'])
/** The only evidence an export carries. Memory notes, transcript steps and the live layer's kinds never leave. */
const EXPORTED_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['file', 'symbol', 'test', 'commit', 'person'])

/** The characters a path in free text runs on with: up to a space, a quote, an angle bracket or a pipe. */
const REST = `[^\\s"'<>|]*`
/** The source of the revealing-path pattern described at the top of this file (use it with the `i` flag). */
export const REVEALING_PATH = [
  `(?<![a-z0-9])[a-z]:(?:\\\\|/(?!/))${REST}`,
  `(?<=[0-9_])[a-z]:[\\\\/]${REST}`,
  `(?<=[a-z])[a-z]:\\\\${REST}`,
  `\\\\\\\\[^\\s\\\\/"'<>|]+[\\\\/]${REST}`,
  `file://${REST}`,
  `(?<![\\w~])~[\\w.-]*[\\\\/]${REST}`,
  `(?<=^|[\\s"'\`(\\[{=,;])/(?:home|users|root|mnt|media|volumes|tmp|private|var|opt|srv|workspaces?)(?![\\w.-])${REST}`,
].join('|')

/** Every revealing path in `text`, as written (trailing punctuation included). */
export function revealingPaths(text: string): string[] {
  return text.match(new RegExp(REVEALING_PATH, 'gi')) ?? []
}

/** Whether `text` holds a revealing path. */
export function isRevealingPath(text: string): boolean {
  return new RegExp(REVEALING_PATH, 'i').test(text)
}

/** Forward slashes, no trailing slash. */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
/** A drive path or a UNC path: compared without regard to case. */
const windowsLike = (p: string): boolean => /^[A-Za-z]:(\/|$)/.test(p) || p.startsWith('//')
const isAbsolute = (p: string): boolean => /^[A-Za-z]:(\/|$)/.test(p) || p.startsWith('/')

/**
 * A path in the plain form the comparisons expect: a file URL becomes its (decoded) path, every slash a single
 * forward slash (a UNC path keeps its leading two), the long forms `//?/` and `//./` lose their prefix and an admin
 * share (`//host/C$/x`) becomes its drive (`C:/x`).
 */
function plainPath(p: string): string {
  let n = p
  const url = /^file:(?:\/\/([^/\\]*))?(.*)$/i.exec(n)
  if (url) {
    n = (url[1] ? `//${url[1]}` : '') + url[2]
    try { n = decodeURIComponent(n) } catch { /* a stray % : keep the path as written */ }
    if (/^\/[A-Za-z]:/.test(n)) n = n.slice(1)
  }
  n = n.replace(/\\/g, '/')
  n = (n.startsWith('//') ? '/' : '') + n.replace(/\/{2,}/g, '/')
  const long = /^\/\/[?.]\/(unc\/)?/i.exec(n)
  if (long) n = (long[1] ? '//' : '') + n.slice(long[0].length)
  const share = /^\/\/[^/]+\/([A-Za-z])\$(?=\/|$)/.exec(n)
  if (share) n = `${share[1]}:${n.slice(share[0].length)}`
  return n
}

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
 * name never shows. `~` stands for the home folder; `~user` is another account's, so it is outside.
 */
export function relativePath(p: string, ctx: SanitizeContext): string {
  let n = plainPath(p)
  if (n === '~' || n.startsWith('~/')) n = norm(ctx.home) + n.slice(1)
  else if (n.startsWith('~')) return outside(n.split('/').slice(1))
  if (!isAbsolute(n)) return n ? resolveRelative(n.split('/')) : ''
  const n2 = norm(n)
  const inRoot = ctx.root === null ? null : under(n2, norm(ctx.root))
  if (inRoot) return resolveRelative(inRoot)
  if ([ctx.home, ctx.userData].some((b) => under(n2, norm(b))?.length === 0)) return OUTSIDE
  return outside(n2.split('/'))
}

const SEP = '[\\\\/]+'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A RegExp source (for the `i` flag) matching folder `base` however a text writes it: either slash, doubled
 * backslashes (JSON), the long forms `\\?\` and `\\.\`, and a drive as an admin share (`\\host\C$`).
 */
function baseSource(base: string): string {
  const n = norm(base)
  const parts = n.split('/')
  const drive = /^([A-Za-z]):$/.exec(parts[0])
  if (drive) {
    const head = `(?:[\\\\/]{2}[?.]${SEP})?(?:${drive[1]}:|[\\\\/]{2}[^\\s\\\\/"'<>|]+${SEP}${drive[1]}\\$)`
    return head + parts.slice(1).map((s) => SEP + escapeRe(s)).join('')
  }
  if (n.startsWith('//')) return `(?:[\\\\/]{2}[?.]${SEP}unc${SEP}|[\\\\/]{2})` + parts.slice(2).map(escapeRe).join(SEP)
  return parts.map(escapeRe).join(SEP)
}

/** Whatever the app's log scanner (appLog.ts) takes for a secret, as `[redacted]`. */
const redact = (text: string): string => redactSecrets(text).replace(/<redacted(?:-[a-z]+)?>/g, '[redacted]')

/** Punctuation that ends a sentence, not a path. */
const TRAILING = /[.,;:!?)\]}]+$/

/** The project root, home and userData folders, longest first, each ending at a whole name, then the rest of the path. */
function knownPattern(ctx: SanitizeContext): RegExp {
  const bases = [ctx.root ?? '', ctx.userData, ctx.home].filter((b) => norm(b) !== '')
    .sort((a, b) => norm(b).length - norm(a).length).map(baseSource)
  // A `file:` URL of a known folder is taken whole. `(?!)` never matches, so with no folder known the pass changes
  // nothing. A folder ends at a whole name: not followed by a name character, nor by a dot that starts one (a dot
  // ending the sentence is fine).
  return new RegExp(`((?:file:/*)?(?:${[...bases, '(?!)'].join('|')}))(?![\\w-]|\\.[\\w.-])((?:[\\\\/]${REST})?)`, 'gi')
}

/** sanitizeText for one context, its patterns built once (a world holds thousands of strings). */
function textCleaner(ctx: SanitizeContext): (text: string) => string {
  const known = knownPattern(ctx)
  const revealing = new RegExp(REVEALING_PATH, 'gi')
  const rewrite = (path: string, tail: string): string => relativePath(path.slice(0, path.length - tail.length), ctx) + tail
  // A known folder named alone keeps its last character; a path running on drops the punctuation ending a sentence.
  const knownHit = (_m: string, base: string, rest: string): string =>
    rewrite(base + rest, rest ? (TRAILING.exec(rest) ?? [''])[0] : '')
  const revealingHit = (m: string): string => rewrite(m, (TRAILING.exec(m) ?? [''])[0])
  // The known folders go first, in a pass of their own: a generic pattern would stop at a space in the user name.
  return (text) => redact(text).replace(known, knownHit).replace(revealing, revealingHit)
}

/**
 * Free text as the export may show it: a secret the app's log scanner recognises becomes `[redacted]`, then the
 * project root, home and userData folders and every revealing path (top of this file) are rewritten with relativePath.
 */
export function sanitizeText(text: string, ctx: SanitizeContext): string {
  return textCleaner(ctx)(text)
}

/** Rebuilds a WorldDoc from its known fields only, with every path relative and no private evidence. */
export function sanitizeWorld(doc: WorldDoc, ctx: SanitizeContext): WorldDoc {
  const text = textCleaner(ctx)
  // A path field is relativised, then scanned as text: a URL, a quoted or padded path, or a note after it.
  const path = (s: string): string => text(relativePath(s, ctx))
  const evidence = (e: Evidence): Evidence => ({ kind: e.kind, ref: PATH_KINDS.has(e.kind) ? path(e.ref) : text(e.ref) })
  const claims = (list: Claim[]): Claim[] => list.map((c) =>
    ({ text: text(c.text), state: c.state, evidence: c.evidence.filter((e) => EXPORTED_KINDS.has(e.kind)).map(evidence) }))
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
  const record = <T, U>(r: Record<string, T>, value: (v: T) => U): Record<string, U> =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, value(v)]))
  // Two terms can sanitise to the same text: the first keeps its place and the second's definition joins it.
  const glossary = new Map<string, string>()
  for (const [term, def] of Object.entries(doc.glossary)) {
    const key = text(term)
    const prev = glossary.get(key)
    glossary.set(key, prev === undefined ? text(def) : `${prev}; ${text(def)}`)
  }
  const projectKey = DESIGN_KEY.test(doc.projectKey) ? doc.projectKey
    : ctx.root !== null ? baseName(norm(ctx.root).split('/')) || 'project' : text(doc.projectKey)
  return {
    version: doc.version, projectKey, generatedAt: doc.generatedAt,
    sourceRevision: { head: doc.sourceRevision.head, dirty: doc.sourceRevision.dirty },
    districts: doc.districts.map(district), buildings: doc.buildings.map(building), edges: doc.edges.map(edge),
    externals: doc.externals.map(external),
    glossary: Object.fromEntries(glossary),
    cargo: record(doc.cargo, (c) => ({ shape: c.shape, color: c.color, label: text(c.label) })),
    processes: record(doc.processes, (p) => ({ label: text(p.label), color: p.color })),
    tours: doc.tours.map(tour),
    layout: {
      seed: doc.layout.seed, positions: record(doc.layout.positions, (v) => [v[0], v[1], v[2]] as [number, number, number]),
      ...(doc.layout.round !== undefined ? { round: doc.layout.round } : {}),
    },
    runtimeNames: record(doc.runtimeNames, (names) => names.map(text)),
    ...(doc.runtimeHandSet ? { runtimeHandSet: [...doc.runtimeHandSet] } : {}),
    layers: { plan: doc.layers.plan.map(proposal) },
    ...(doc.labelTokens !== undefined ? { labelTokens: doc.labelTokens } : {}),
  }
}

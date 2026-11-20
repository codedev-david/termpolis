// The facts both Lumopolis cards state, gathered once: the HTML card (renderer engine cards.ts) and the
// plain-text card an agent reads (main cardText.ts) import these, so the two cannot say different things.
// Pure and ES2020.
import type { Building, BuildingGrowth, Evidence, WorldDoc, WorldEdge } from './types'
import { edgeActions, edgeItems } from './edgeText'

/** The status pill of a building, in words. */
export const BUILD_STATUS_TEXT: Record<Building['status'], string> = {
  verified: 'Built · tests pass', built: 'Built · not yet checked', gap: 'Built · no test results yet', proposed: 'Planned only',
}

/** One piece of evidence in words: its kind and where it points, and for a test where its result came from (a test
 *  report, an agent transcript or CI), so a pass read off a transcript never looks like one from a report. */
export const evidenceText = (e: Evidence): string =>
  e.kind === 'test' && typeof e.excerpt === 'string' && e.excerpt !== '' ? `${e.kind} ${e.ref} (${e.excerpt})` : `${e.kind} ${e.ref}`

/** The built buildings and those of every proposal. */
export const allBuildings = (doc: WorldDoc): Building[] => [...doc.buildings, ...doc.layers.plan.flatMap((p) => p.buildings)]
/** The built edges and those of every proposal. */
export const allEdges = (doc: WorldDoc): WorldEdge[] => [...doc.edges, ...doc.layers.plan.flatMap((p) => p.edges)]

/** A node's name: a building's, an outside part's, else its id. */
export const nodeName = (doc: WorldDoc, id: string): string =>
  allBuildings(doc).find((b) => b.id === id)?.name ?? doc.externals.find((x) => x.id === id)?.name ?? id

/** Whether the project's linked design does not have this built building. */
export const notInDesign = (doc: WorldDoc, id: string): boolean =>
  doc.layers.plan.some((p) => p.reconcile !== undefined && p.reconcile.extra.indexOf(id) >= 0)

/** The process a building runs in: its label when the world names it, else the raw id (may be blank). */
export const runsIn = (doc: WorldDoc, b: Building): string => {
  const proc = doc.processes[b.process]
  return proc ? proc.label : b.process
}

/** What a planned line no model has described says under "How it travels": it has no code to read. */
export const NOT_DESCRIBED = 'Not described yet.'

/** What a line no model has described says under "How it travels": for a built line, what the code alone shows, who
 *  reaches whom and through what (the identifiers themselves are listed under "What it carries"); a planned line
 *  (a proposal's, or any line of a design world, keyed `design:`) has no code, so it says only that it is not described. */
export function edgeFromCode(doc: WorldDoc, e: WorldEdge): string {
  if (doc.projectKey.startsWith('design:') || !doc.edges.some((x) => x.id === e.id)) return NOT_DESCRIBED
  const from = nodeName(doc, e.from)
  const to = nodeName(doc, e.to)
  const items = edgeItems(e.label)
  if (items) {
    const acts = edgeActions(items)
    const said = acts.length === 1 ? acts[0] : `${acts.slice(0, -1).join(', ')} and ${acts[acts.length - 1]}`
    return `From the code: ${from} reaches ${to} this way: it ${said}.`
  }
  if (e.label.trim() === 'imports') return `From the code: ${from} imports code from ${to}.`
  return `From the code: ${from} reaches ${to}${e.tech.length ? ` through ${e.tech.join(', ')}` : ''}.`
}

/** What a line no model has described says under "Why". Nobody read the code for a reason (the line may be past the
 *  labelling cap, or not reached yet), so it claims nothing about the code beyond what code can show. */
export const NO_WHY_YET = 'Not described yet; the code alone does not say why.'

/** `edges` with twoWay set on every line whose reverse (to back to from) is among them, and kept on one already
 *  marked (an agent may write it on a single line). New objects; ids and order stay, so labels and layout hold. */
export function markTwoWay(edges: WorldEdge[]): WorldEdge[] {
  const links = new Set(edges.map((e) => `${e.from}\n${e.to}`))
  return edges.map((e) => ({ ...e, twoWay: e.twoWay || links.has(`${e.to}\n${e.from}`) }))
}

/** The list a line belongs to: the built lines, else the proposal holding it (a plan's lines pair only with each other). */
const linesOf = (doc: WorldDoc, e: WorldEdge): WorldEdge[] =>
  doc.edges.some((x) => x.id === e.id) ? doc.edges : doc.layers.plan.find((p) => p.edges.some((x) => x.id === e.id))?.edges ?? []

/** The line back (to back to from) in the same list as `e`, if there is one. */
export const reverseOf = (doc: WorldDoc, e: WorldEdge): WorldEdge | undefined =>
  linesOf(doc, e).find((x) => x.from === e.to && x.to === e.from)

/** Which way a line runs, as one sentence (`text`), cut where the HTML card links the line back: `before`, then
 *  `link` (a link to line `reverseId` when there is one), then `after`. */
export interface Direction { text: string; before: string; link: string; after: string; reverseId?: string }

const sentence = (before: string, link = '', after = '', reverseId?: string): Direction =>
  ({ text: before + link + after, before, link, after, ...(reverseId !== undefined ? { reverseId } : {}) })

/** Whether the code shows the line's start getting an answer back: only a call to an outside web address (the
 *  http-out boundary: fetch, axios, http.get or request, each of which returns the response). Compile alone writes an
 *  outside line's label, so a model's words cannot fake one. IPC does not count (the detector records invoke and send
 *  alike as one consume side), nor MCP (it records the config entry, not the calls), nor programs, ports or settings. */
const withReplies = (doc: WorldDoc, e: WorldEdge): boolean =>
  doc.externals.some((x) => x.id === e.to) && (edgeItems(e.label) ?? []).some((i) => i.startsWith('http-out '))

/**
 * Which way a line runs, the sentence both cards show under "Direction". Both ways when the line back exists in the
 * same list (or the line is marked twoWay); one way with replies when the code records a call that returns an answer;
 * else one way. A planned line (a proposal's, or any line of a design world) has no code, so it says only what the
 * plan says.
 */
export function direction(doc: WorldDoc, e: WorldEdge): Direction {
  const from = nodeName(doc, e.from)
  const to = nodeName(doc, e.to)
  const planned = doc.projectKey.startsWith('design:') || !doc.edges.some((x) => x.id === e.id)
  const back = reverseOf(doc, e)
  const tag = planned ? ' (planned)' : ''
  if (back || e.twoWay) return sentence(`Both ways${tag}: ${from} reaches ${to}, and `, `${to} reaches ${from}`, '.', back?.id)
  if (planned) return sentence(`One way (planned): ${from} reaches ${to}.`)
  if (withReplies(doc, e)) return sentence(`One way, with replies: ${from} asks and ${to} answers.`)
  // Only what the scan shows: several kinds cannot see a way back at all (a main process pushing to a page, a
  // worker posting results), so the sentence never says the target does not reach back.
  return sentence(`One way: ${from} reaches ${to}; the code shows no line from ${to} back to ${from}.`)
}

/** A building is big from this many files, when it also holds at least twice the median of the other buildings. */
export const BIG_MIN_FILES = 20
/** The most floors a building's card lists (main/world/label.ts MAX_FLOORS): past it the rest share one "other" floor. */
export const FLOOR_CAP = 12

/** How a card can show a building's floors: a double-click in the 3D city, listed in the agent's text, or not at all. */
export type FloorsView = 'open3d' | 'listed' | 'none'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const folderName = (dir: string): string => (dir ? `the ${dir} folder` : 'the top-level folder')
const STARTS: Record<BuildingGrowth['start'], (g: BuildingGrowth) => string> = {
  process: (g) => `the entry of the "${g.seed}" process`,
  service: (g) => `the channel service ${g.seed}`,
  folder: (g) => folderName(g.seed),
  family: (g) => `${folderName(g.folder ?? '')}'s name family "${g.seed}"`,
  file: (g) => `the single file ${g.seed}`
}

function median(sizes: number[]): number {
  const s = [...sizes].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * "Why it is this big": the note both cards show on a big building, in facts the grouping recorded (`growth`) and
 * nothing else, one fact a sentence. Big means at least BIG_MIN_FILES files and twice the median of the other
 * buildings (BIG_MIN_FILES alone in a project of one building), or anything the building cap folded in. Empty for
 * any other building, and for one without growth (a planned one, or a world stored before growth was recorded).
 * `floors` says how this card's reader can see the floors; only that way is named.
 */
export function sizeNote(doc: WorldDoc, b: Building, floors: FloorsView = 'none'): string {
  const g = b.growth
  if (!g) return ''
  const n = b.members.length
  const others = doc.buildings.filter((x) => x.id !== b.id).map((x) => x.members.length)
  const big = n >= BIG_MIN_FILES && (others.length === 0 || n >= 2 * median(others))
  if (!big && g.folded === 0) return ''
  const facts = [`${plural(n, 'file', 'files')}.`, `It started as ${STARTS[g.start](g)}.`]
  const merges = [
    ...(g.merged > 0 ? [plural(g.merged, 'name family', 'name families')] : []),
    ...(g.mergedFiles > 0 ? [plural(g.mergedFiles, 'single file', 'single files')] : [])
  ]
  if (merges.length) facts.push(`${merges.join(' and ')} ${g.merged + g.mergedFiles === 1 ? 'was' : 'were'} merged in because of dense imports.`)
  if (g.reached) facts.push(`${plural(g.reached, 'file', 'files')} imported only from inside it joined it.`)
  if (g.inFolder) {
    facts.push(`${plural(g.inFolder, 'other file', 'other files')} of ${folderName(g.folder ?? '')} joined it because its process is named for that folder.`)
  }
  if (g.folded > 0) {
    facts.push(`${plural(g.folded, 'other group was', 'other groups were')} folded in because Lumopolis shows at most ${g.cap} buildings per project.`)
  }
  const last = b.floors[b.floors.length - 1]
  if (b.floors.length >= FLOOR_CAP && last.name === 'other') facts.push(`Its "other" floor holds ${plural(last.members.length, 'file', 'files')}.`)
  if (b.floors.length > 1 && floors !== 'none') facts.push(floors === 'open3d' ? 'Double-click it to see its floors.' : "Its floors are listed under What's inside.")
  return facts.join(' ')
}

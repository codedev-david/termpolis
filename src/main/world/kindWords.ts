/**
 * The word the code gives each kind of boundary (a part's tech label, a line's tech chips), and the rename of a word an
 * older compiler gave wrongly: TCP for a message port (look spec §9.4). A TCP is renamed only where the code made it from
 * a port, never where a model wrote it (review I-1). The world store (worldStore.ts) applies upgradeSavedWords to every
 * saved world it hands out, by the evidence a saved world carries; the compile (compile.ts labelAll) decides the parts and
 * lines it keeps by their own boundaries, which a saved world does not carry.
 */
import { edgeItems } from '../../shared/world/edgeText'
import type { Building, Proposal, WorldDoc, WorldEdge } from '../../shared/world/types'
import type { BoundaryKind } from './detectors/common'

/** A message port: `new MessageChannel()` and `xPort.postMessage(` (detectors/processes.ts), never a network socket. */
export const MESSAGE_PORT = 'Message port'
export const MESSAGE_PORT_MEANS = 'Messages passed over a channel between two parts of the app'

export const KIND_WORD: Readonly<Record<BoundaryKind, string>> = {
  ipc: 'IPC',
  port: MESSAGE_PORT,
  fork: 'Process',
  worker: 'Worker',
  spawn: 'Spawn',
  'http-out': 'HTTP client',
  'http-listen': 'HTTP server',
  env: 'Config',
  mcp: 'MCP',
  watch: 'Watcher'
}

/** What compilers before look spec §9.4 called a port, and the definition they gave it. */
const OLD_PORT_WORD = 'TCP'
const OLD_PORT_MEANS = 'A network connection on a numbered port'
/** Every word an older compiler could put in a code-made tech label. */
const OLD_KIND_WORDS = new Set([...Object.values(KIND_WORD).filter((w) => w !== MESSAGE_PORT), OLD_PORT_WORD])
const SEP = ' · '
/** The claim the compile gives every line it found in the code (compile.ts seenIn); a design's lines never carry it. */
const SEEN_IN_CODE = 'Seen in code'

const oldWord = (k: BoundaryKind): string => (k === 'port' ? OLD_PORT_WORD : KIND_WORD[k])
const renamed = (words: readonly string[]): string[] => [...new Set(words.map((w) => (w === OLD_PORT_WORD ? MESSAGE_PORT : w)))]

/**
 * `words` with TCP renamed when every word is what an older compiler called one of `kinds` and a port is among them:
 * then the TCP came from that port. Anything else (a model's "TCP" on a part with no port, "TCP server", a word that is
 * not one of these crossings) is the model's own, and the same array comes back.
 */
export function portWords(words: readonly string[], kinds: readonly BoundaryKind[]): readonly string[] {
  if (!words.includes(OLD_PORT_WORD) || !kinds.includes('port')) return words
  const own = new Set(kinds.map(oldWord))
  return words.every((w) => own.has(w)) ? renamed(words) : words
}

/** A part's tech label, by the same rule (its words are joined by " · "). */
export function portLabel(label: string, kinds: readonly BoundaryKind[]): string {
  const words = label.split(SEP)
  const up = portWords(words, kinds)
  return up === words ? label : up.join(SEP)
}

/** A line the code wrote with a port among its identifiers ("ipc a, port b"), and found in the code. */
function isCodePortLine(e: WorldEdge): boolean {
  return (edgeItems(e.label) ?? []).some((i) => i.startsWith('port ')) && e.claims.some((c) => c.text === SEEN_IN_CODE)
}

/** A saved world's parts and lines with TCP renamed where the saved world itself shows it came from a port. */
function upgradeItems(buildings: Building[], edges: WorldEdge[]): { buildings: Building[]; edges: WorldEdge[]; changed: boolean } {
  let changed = false
  // A code-made port line is the evidence: its chips are the code's, and the parts at its ends post or open that port.
  const portEnds = new Set(edges.filter(isCodePortLine).flatMap((e) => [e.from, e.to]))
  const nextB = buildings.map((b) => {
    const words = b.techLabel.split(SEP)
    if (!portEnds.has(b.id) || !words.includes(OLD_PORT_WORD) || !words.every((w) => OLD_KIND_WORDS.has(w))) return b
    changed = true
    return { ...b, techLabel: renamed(words).join(SEP) }
  })
  const nextE = edges.map((e) => {
    if (!e.tech.includes(OLD_PORT_WORD) || !isCodePortLine(e)) return e
    changed = true
    return { ...e, tech: renamed(e.tech) }
  })
  return { buildings: changed ? nextB : buildings, edges: changed ? nextE : edges, changed }
}

/** Whether a word is still shown anywhere in the world: a part, a floor, a line, or a plan proposal's part or line. */
function usesWord(doc: Pick<WorldDoc, 'buildings' | 'edges' | 'layers'>, w: string): boolean {
  const inParts = (list: readonly Building[]): boolean =>
    list.some((b) => b.techLabel.split(SEP).includes(w) || b.stack.includes(w) || b.floors.some((f) => f.tech.includes(w)))
  const inLines = (list: readonly WorldEdge[]): boolean => list.some((e) => e.tech.includes(w))
  return inParts(doc.buildings) || inLines(doc.edges) || doc.layers.plan.some((p) => inParts(p.buildings) || inLines(p.edges))
}

/**
 * The glossary without the older compiler's own TCP definition once nothing in the world shows TCP. A definition a
 * model wrote, or one still in use, stays. The same object comes back when nothing goes.
 */
export function withoutUnusedOldPort(doc: WorldDoc): WorldDoc {
  if (doc.glossary[OLD_PORT_WORD] !== OLD_PORT_MEANS || usesWord(doc, OLD_PORT_WORD)) return doc
  const glossary = { ...doc.glossary }
  delete glossary[OLD_PORT_WORD]
  return { ...doc, glossary }
}

/**
 * A saved world with the older words brought up to date (look spec §9.4), by the evidence the saved world carries: TCP
 * on a line the code wrote with a port on it, and on a code-made label (only kind words) of a part such a line reaches,
 * becomes Message port; plan proposals follow the same rule. Message port gains its definition, and the old TCP
 * definition goes once nothing uses it. A model's own TCP and its own definition are kept, and a world with nothing to
 * change comes back as the same object.
 */
export function upgradeSavedWords(doc: WorldDoc): WorldDoc {
  const top = upgradeItems(doc.buildings, doc.edges)
  let changed = top.changed
  const plan = doc.layers.plan.map((p): Proposal => {
    const up = upgradeItems(p.buildings, p.edges)
    if (!up.changed) return p
    changed = true
    return { ...p, buildings: up.buildings, edges: up.edges }
  })
  const next: WorldDoc = changed
    ? { ...doc, buildings: top.buildings, edges: top.edges, layers: { ...doc.layers, plan }, glossary: { ...doc.glossary, [MESSAGE_PORT]: MESSAGE_PORT_MEANS } }
    : doc
  return withoutUnusedOldPort(next)
}

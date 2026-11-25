/**
 * The word the code gives each kind of boundary (a part's tech label, a line's tech chips), and the load-time rename of
 * a word an older compiler gave wrongly. Pure: the world store (worldStore.ts loadNow) applies it to every saved world
 * it loads, so the compile that follows starts from today's words.
 */
import { edgeItems } from '../../shared/world/edgeText'
import type { WorldDoc } from '../../shared/world/types'
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

/** A part's tech label made by the code alone (only kind words) has its TCP from a port; a model's label is its own. */
function upgradeLabel(label: string): string {
  const words = label.split(SEP)
  if (!words.includes(OLD_PORT_WORD) || !words.every((w) => OLD_KIND_WORDS.has(w))) return label
  return words.map((w) => (w === OLD_PORT_WORD ? MESSAGE_PORT : w)).join(SEP)
}

/** A line the code labelled with a port among its identifiers has its TCP chip from that port. */
function upgradeTech(label: string, tech: string[]): string[] {
  if (!tech.includes(OLD_PORT_WORD)) return tech
  const items = edgeItems(label)
  if (!items || !items.some((i) => i.startsWith('port '))) return tech
  return [...new Set(tech.map((t) => (t === OLD_PORT_WORD ? MESSAGE_PORT : t)))]
}

/**
 * A saved world with the older words brought up to date (look spec §9.4): TCP on a code-made part label or on a
 * code-made port line becomes Message port, Message port gains its definition, and the old TCP definition goes once
 * nothing uses it. A model's own TCP ("TCP server", a line it described) and its own definition are kept. A world
 * with nothing to change comes back as the same object.
 */
export function upgradeSavedWords(doc: WorldDoc): WorldDoc {
  let changed = false
  const buildings = doc.buildings.map((b) => {
    const techLabel = upgradeLabel(b.techLabel)
    if (techLabel === b.techLabel) return b
    changed = true
    return { ...b, techLabel }
  })
  const edges = doc.edges.map((e) => {
    const tech = upgradeTech(e.label, e.tech)
    if (tech === e.tech) return e
    changed = true
    return { ...e, tech }
  })
  const glossary = { ...doc.glossary }
  if (changed) glossary[MESSAGE_PORT] = MESSAGE_PORT_MEANS
  const used = (w: string): boolean =>
    buildings.some((b) => b.techLabel.split(SEP).includes(w) || b.stack.includes(w) || b.floors.some((f) => f.tech.includes(w))) ||
    edges.some((e) => e.tech.includes(w))
  if (glossary[OLD_PORT_WORD] === OLD_PORT_MEANS && !used(OLD_PORT_WORD)) {
    delete glossary[OLD_PORT_WORD]
    changed = true
  }
  return changed ? { ...doc, buildings, edges, glossary } : doc
}

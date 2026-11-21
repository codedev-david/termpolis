// Fixture worlds for the Lumopolis documentation model (src/shared/world/documentation.ts) and its renderer. Each
// builder returns a fresh, valid WorldDoc (the tests run every one through validateWorld), so a test may change
// what it gets without touching another test's world.
import type { Building, Claim, ClaimState, District, External, WorldDoc, WorldEdge } from '../../../src/shared/world/types'

const claim = (text: string, state: ClaimState = 'inferred', ref = 'src/a.ts'): Claim =>
  ({ text, state, evidence: [{ kind: 'file', ref }] })

const district = (id: string, name: string, subtitle: string, over: Partial<District> = {}): District =>
  ({ id, name, subtitle, hue: 200, members: [], nameState: 'observed', ...over })

const building = (id: string, districtId: string, over: Partial<Building> = {}): Building => ({
  id, districtId, name: id, techLabel: '', process: '', floors: [], stack: [], how: [], why: [], status: 'built',
  members: [], claims: [], nameState: 'observed', ...over
})

const edge = (id: string, from: string, to: string, over: Partial<WorldEdge> = {}): WorldEdge =>
  ({ id, from, to, cargo: '', label: '', how: [], tech: [], why: [], rate: '', twoWay: false, claims: [], ...over })

const external = (id: string, name: string, over: Partial<External> = {}): External =>
  ({ id, name, kind: 'service', fog: false, ...over })

/** A world with nothing in it; `projectKey` decides code (any key) or design (`design:<id>`). */
function bare(projectKey = 'termpolis'): WorldDoc {
  return {
    version: 1, projectKey, generatedAt: 1763251200000, sourceRevision: { head: '9281177c', dirty: false },
    districts: [], buildings: [], edges: [], externals: [], glossary: {}, cargo: {}, processes: {}, tours: [],
    layout: { seed: 7, positions: {} }, runtimeNames: {}, layers: { plan: [] }
  }
}

/** Gives every building of the world (and of its proposals) a layout position, as a compiled world has. */
function placed(doc: WorldDoc): WorldDoc {
  let i = 0
  for (const b of [...doc.buildings, ...doc.layers.plan.flatMap((p) => p.buildings)]) doc.layout.positions[b.id] = [i++ * 6, 0, 0]
  return doc
}

/** The empty world: no districts, parts, lines, tours, outside systems or glossary. */
export const emptyWorld = (): WorldDoc => bare()

/**
 * A labelled code world: described parts with test-verified and person-confirmed facts, a big building (size note),
 * a building of thirteen floors and a floor of fifteen files (both past the card's caps), an AI-suggested name,
 * hand-set service names, a code-written line and a model-labelled pair of lines both ways, a line no model
 * described, an outside service in fog, a tour through a district, a line and parts, and a process with no parts.
 */
export function labelledWorld(): WorldDoc {
  const doc = bare()
  doc.sourceRevision = { head: 'a1b2c3d', dirty: true }
  doc.districts = [
    district('d1', 'Core', 'The app and its memory'),
    district('d2', 'Agents', 'Where the agents run', { nameState: 'inferred' })
  ]
  doc.glossary = { electron: 'A framework for desktop apps.', sqlite: 'A small database in one file.', ipc: 'How two programs talk.' }
  doc.cargo = { memory: { shape: 'sphere', color: '#6aa9ff', label: 'Memory' } }
  doc.processes = { main: { label: 'Main process', color: '#8888ff' }, memory: { label: 'Memory host', color: '#44cc99' }, idle: { label: 'Spare worker', color: '#999999' } }
  const files = Array.from({ length: 15 }, (_, i) => `src/main/shell/part${i}.ts`)
  doc.buildings = [
    building('b1', 'd1', {
      name: 'Desktop app', techLabel: 'Electron + React', process: 'main', stack: ['electron', 'ipc'],
      floors: [{ name: 'Window shell', tech: ['electron'], members: files }, { name: 'Menus', tech: [], members: [] }],
      members: files,
      how: [claim('The main process opens the window and hosts terminals.', 'observed', 'src/main/index.ts')],
      why: [claim('One shell hosts every agent terminal.', 'inferred', 'docs/architecture.md')],
      claims: [
        { text: 'Startup is covered by a test.', state: 'verified', evidence: [{ kind: 'test', ref: 'tests/main/startup.test.ts', excerpt: 'report' }] },
        { text: 'The window opens maximised.', state: 'verified', evidence: [{ kind: 'person', ref: 'David' }] }
      ],
      growth: { start: 'process', seed: 'main', merged: 2, mergedFiles: 1, reached: 3, folded: 1, cap: 30 }
    }),
    building('b2', 'd1', {
      name: 'Memory host', techLabel: 'Node + SQLite', process: 'memory', stack: ['sqlite'], status: 'verified',
      floors: Array.from({ length: 13 }, (_, i) => ({ name: `Floor ${i + 1}`, tech: ['sqlite'], members: [`src/main/memory/f${i}.ts`] })),
      how: [claim('Memories are stored in a local SQLite database.', 'verified', 'src/main/memory/store.ts')],
      why: [claim('Agents share what they learn without a cloud service.')]
    }),
    building('b3', 'd2', {
      name: 'Agent runner', process: 'main', nameState: 'inferred', status: 'gap',
      how: [claim('Starts each agent in its own terminal.')]
    })
  ]
  doc.runtimeNames = { b2: ['memory-host', 'brain'] }
  doc.runtimeHandSet = ['b2']
  doc.edges = [
    edge('e1', 'b1', 'b2', {
      cargo: 'memory', label: 'Memory calls', tech: ['ipc'], rate: 'on demand',
      how: [claim('The app calls the memory host over a local socket.', 'observed')],
      why: [claim('Keeps the database out of the UI process.')],
      claims: [claim('Each call is answered within a second.', 'verified')]
    }),
    edge('e2', 'b2', 'b1', { cargo: 'memory', label: 'Memory replies', how: [claim('The host answers each call.')] }),
    edge('e3', 'b1', 'b3', { label: 'env AGENT_HOME, ipc agent:start' }),
    edge('e4', 'b3', 'x1', { label: 'http-out api.example.com', how: [claim('The runner calls the service.')] })
  ]
  doc.externals = [external('x1', 'Model API', { kind: 'provider', fog: true }), external('x2', 'Shared drive', { kind: 'files' })]
  doc.tours = [
    { id: 't1', title: 'First look', steps: [{ ids: ['d1', 'e1', 'b2'], caption: 'The app talks to its memory.' }, { ids: [], caption: 'That is all.' }] }
  ]
  return placed(doc)
}

/** A compiled world no model has labelled yet: names, members and code-written lines, nothing described. */
export function unlabelledWorld(): WorldDoc {
  const doc = bare()
  doc.districts = [district('d1', 'src', '')]
  doc.processes = { main: { label: 'main', color: '#888888' } }
  doc.buildings = [
    building('b1', 'd1', { name: 'main', process: 'main', members: ['src/main.ts'], growth: { start: 'process', seed: 'main', merged: 0, mergedFiles: 0, folded: 0, cap: 30 } }),
    building('b2', 'd1', { name: 'util', members: ['src/util.ts'], growth: { start: 'file', seed: 'src/util.ts', merged: 0, mergedFiles: 0, folded: 0, cap: 30 } })
  ]
  doc.edges = [edge('e1', 'b1', 'b2', { label: 'imports' })]
  return placed(doc)
}

/** A design world (keyed `design:`): every part planned, every statement proposed, no commit. */
export function designWorld(): WorldDoc {
  const doc = bare('design:7f3a')
  doc.sourceRevision = { head: '', dirty: false }
  doc.districts = [district('d1', 'Front', 'What people use')]
  doc.glossary = { react: 'A library for user interfaces.' }
  doc.processes = { web: { label: 'Web page', color: '#5588ff' } }
  doc.buildings = [
    building('b1', 'd1', { name: 'Shop page', process: 'web', stack: ['react'], status: 'proposed', how: [claim('Shows the products.', 'proposed')], why: [claim('People shop in a browser.', 'proposed')] }),
    building('b2', 'd1', { name: 'Basket', process: 'web', status: 'proposed', how: [claim('Holds what a person picked.', 'proposed')] })
  ]
  doc.edges = [edge('e1', 'b1', 'b2', { label: 'Adds items', how: [claim('The page adds items to the basket.', 'proposed')] })]
  return placed(doc)
}

/**
 * A code world with a linked design and a second proposal: the design has a part the build lacks (missing), one it
 * matches, one changed, and the build has a part the design does not (extra, so its card says "not in the design").
 * The second proposal adds a part with a line and takes one away.
 */
export function linkedDesignWorld(): WorldDoc {
  const doc = bare()
  doc.districts = [district('d1', 'Core', 'The service')]
  doc.processes = { api: { label: 'API server', color: '#55aa55' } }
  doc.buildings = [
    building('b1', 'd1', { name: 'Orders', process: 'api', how: [claim('Takes orders.')] }),
    building('b2', 'd1', { name: 'Billing', process: 'api', how: [claim('Charges cards.')] }),
    building('b3', 'd1', { name: 'Legacy export', process: 'api' })
  ]
  doc.edges = [edge('e1', 'b1', 'b2', { label: 'Charges', how: [claim('Orders asks Billing to charge.')] })]
  doc.layers.plan = [
    {
      id: 'p1', title: 'Shop design', summary: [claim('The shop as designed.', 'proposed')],
      buildings: [building('pb1', '', { name: 'Notifications', status: 'proposed', how: [claim('Sends receipts.', 'proposed')] })],
      edges: [],
      reconcile: { matched: { 'plan-orders': 'b1', 'plan-billing': 'b2' }, missing: ['pb1'], extra: ['b3'], changed: ['b2'], planAt: 1763251100000 }
    },
    {
      id: 'p2', title: 'Retire the export', summary: [],
      buildings: [building('pb2', 'd1', { name: 'Report builder', status: 'proposed' })],
      edges: [edge('pe1', 'b1', 'pb2', { label: 'Sends orders' })],
      removes: ['b3']
    }
  ]
  return placed(doc)
}

/** The 400-character name of the hostile world. */
export const LONG_NAME = 'Long name '.repeat(40)
/** Names that would break a careless renderer: markup, quotes and ampersands, unicode, emoji and a 400-character name. */
export const HOSTILE = {
  script: '<script>alert("x")</script>',
  quotes: `"double" 'single' & <b>bold</b>`,
  unicode: 'Ünïcødé 名前 Ωμέγα',
  emoji: 'Rocket 🚀 fire 🔥 family 👨‍👩‍👧',
  long: LONG_NAME
}

/** A world named with HOSTILE everywhere a name or sentence can go. */
export function hostileWorld(): WorldDoc {
  const doc = bare()
  doc.districts = [district('d1', HOSTILE.script, HOSTILE.quotes)]
  doc.glossary = { [HOSTILE.unicode]: HOSTILE.emoji }
  doc.processes = { p: { label: HOSTILE.quotes, color: '#000000' } }
  doc.buildings = [
    building('b1', 'd1', { name: HOSTILE.script, techLabel: HOSTILE.quotes, process: 'p', stack: [HOSTILE.unicode], how: [claim(HOSTILE.emoji)] }),
    building('b2', 'd1', { name: HOSTILE.long, floors: [{ name: HOSTILE.unicode, tech: [], members: [HOSTILE.emoji] }] }),
    building('b3', 'd1', { name: HOSTILE.emoji, nameState: 'inferred' })
  ]
  doc.edges = [edge('e1', 'b1', 'b2', { label: HOSTILE.quotes, rate: HOSTILE.unicode })]
  doc.externals = [external('x1', HOSTILE.script, { fog: true })]
  doc.tours = [{ id: 't1', title: HOSTILE.emoji, steps: [{ ids: ['b1'], caption: HOSTILE.script }] }]
  doc.runtimeNames = { b1: [HOSTILE.quotes] }
  doc.layers.plan = [{ id: 'p1', title: HOSTILE.long, summary: [claim(HOSTILE.script, 'proposed')], buildings: [], edges: [] }]
  return placed(doc)
}

/**
 * A generated code world of `parts` buildings in six districts and `lines` lines, where the first `describedParts`
 * buildings and the first `describedLines` lines carry a `how` claim. Line k runs from building k mod n to building
 * (k mod n + 1 + floor(k / n)) mod n, so no two lines share both ends while lines < n * (n - 1).
 */
export function describedWorld(parts: number, lines: number, describedParts: number, describedLines: number): WorldDoc {
  const doc = bare()
  doc.processes = { main: { label: 'Main process', color: '#8888ff' } }
  doc.glossary = { node: 'A JavaScript runtime.' }
  doc.districts = Array.from({ length: 6 }, (_, i) => district(`d${i}`, `Area ${i}`, `Area ${i} of the generated world`))
  doc.buildings = Array.from({ length: parts }, (_, i) => building(`b${i}`, `d${i % 6}`, {
    name: `Part ${i}`, techLabel: 'Node', process: 'main', stack: ['node'],
    floors: [{ name: 'Code', tech: ['node'], members: [`src/part${i}/index.ts`] }], members: [`src/part${i}/index.ts`],
    how: i < describedParts ? [claim(`Part ${i} does its job.`, 'inferred', `src/part${i}/index.ts`)] : [],
    growth: { start: 'folder', seed: `src/part${i}`, merged: 0, mergedFiles: 0, folded: 0, cap: 60 }
  }))
  doc.edges = Array.from({ length: lines }, (_, k) => {
    const from = k % parts
    const to = (from + 1 + Math.floor(k / parts)) % parts
    return edge(`e${k}`, `b${from}`, `b${to}`, {
      label: `ipc channel-${k}`, how: k < describedLines ? [claim(`Line ${k} carries a message.`)] : []
    })
  })
  return placed(doc)
}

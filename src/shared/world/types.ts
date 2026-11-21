// Lumopolis (the 3D world view). The WorldDoc is the single data contract between the analyzer
// (main process), the engine/renderer and the standalone website demo. Types only: this file
// emits no JavaScript.

import type { RepoLogin } from './repoAccess'

export type ClaimState = 'proposed' | 'observed' | 'inferred' | 'verified'
export type EvidenceKind = 'file' | 'symbol' | 'test' | 'transcriptStep' | 'memory' | 'commit'
  | 'trace' | 'metric' | 'log' | 'deploy'            // trace..deploy reserved for the live layer (§5.11)
  | 'person'                                         // a person confirmed it in Lumopolis (only the pane's annotate writes it)
export interface Evidence { kind: EvidenceKind; ref: string; excerpt?: string }
export interface Claim { text: string; state: ClaimState; evidence: Evidence[] }
export type BuildStatus = 'verified' | 'built' | 'gap' | 'proposed'
export interface Floor { name: string; tech: string[]; members: string[] }
/** Whether a name came from the code ('observed') or was suggested by the model ('inferred'). */
export type NameState = 'observed' | 'inferred'
export interface District { id: string; name: string; subtitle: string; hue: number; members: string[]; nameState: NameState }
/**
 * How the grouping (main/world/group.ts) made a building, as plain facts it recorded: what it started as, how many
 * clusters joined that start because their files import each other densely, and how many smaller buildings the
 * building cap folded into it. `seed` is the process key (process), the file (service, file), the folder (folder) or
 * the leading name word (family, whose folder is `folder`).
 */
export interface BuildingGrowth {
  start: 'process' | 'service' | 'folder' | 'family' | 'file'
  seed: string
  /** The folder of a family start, or of a process built from a folder. */
  folder?: string
  /** Name families of two or more files merged into the start because their files import each other densely. */
  merged: number
  /** Single files (in no name family of their own) merged in the same way. */
  mergedFiles: number
  /** A process building: files imported only from inside it, which joined it. */
  reached?: number
  /** A process built from a folder: the other files of that folder, which it took. */
  inFolder?: number
  /** Buildings the cap folded into it. */
  folded: number
  /** The most buildings a project shows (the cap in force when it was grouped). */
  cap: number
}
export interface Building {
  id: string; districtId: string; name: string; techLabel: string; process: string
  floors: Floor[]; stack: string[]; how: Claim[]; why: Claim[]; status: BuildStatus; members: string[]
  /** Facts beyond how and why: observed in code, verified by tests, or confirmed by a person. */
  claims: Claim[]; nameState: NameState
  /** How the grouping made it. Only compiled buildings carry it, and worlds stored before it have none. */
  growth?: BuildingGrowth
}
export interface WorldEdge {
  id: string; from: string; to: string; cargo: string; label: string
  how: Claim[]; tech: string[]; why: Claim[]; rate: string; twoWay: boolean
  /** Set only as true, on a design line an agent itself marked twoWay: that stays when the line back is removed. */
  twoWayStated?: true
  /** Facts beyond how and why (Seen in code, a person's confirmation). */
  claims: Claim[]
}
export interface External { id: string; name: string; kind: 'agent' | 'provider' | 'files' | 'machine' | 'service'; fog: boolean }
/** Plan versus built (shared/world/reconcile.ts): plan building id → built building id, plus what each side lacks. */
export interface PlanReconcile {
  matched: Record<string, string>; missing: string[]; extra: string[]
  /** Built ids a plan part matched whose planned members, floors or tech the build does not yet have all of. Recomputed on every reconcile. */
  changed: string[]
}
/** A planned change drawn over the world. One carrying `reconcile` is the project's linked design, overlaid
 *  by compile: its buildings are the missing ones only, and `planAt` is the design's generatedAt. */
export interface Proposal {
  id: string; title: string; summary: Claim[]; buildings: Building[]; edges: WorldEdge[]
  reconcile?: PlanReconcile & { planAt: number }
  /** Built building ids this proposal takes away: drawn fading. */
  removes?: string[]
}
export interface Tour { id: string; title: string; steps: { ids: string[]; caption: string }[] }
export interface WorldDoc {
  version: 1; projectKey: string; generatedAt: number; sourceRevision: { head: string; dirty: boolean }
  districts: District[]; buildings: Building[]; edges: WorldEdge[]; externals: External[]
  glossary: Record<string, string>; cargo: Record<string, { shape: 'cube' | 'sphere' | 'octa' | 'tetra'; color: string; label: string }>
  processes: Record<string, { label: string; color: string }>
  tours: Tour[]
  /**
   * Where every part stands. `round` counts the Re-layouts the person asked for (absent before the first):
   * a plain compile carries it, so a newer world tells a Re-layout from a watched change by it alone.
   */
  layout: { seed: number; positions: Record<string, [number, number, number]>; round?: number }
  runtimeNames: Record<string, string[]>             // §5.11 hook
  /** Ids of the parts whose service names a person set by hand (they replace the detected ones). Absent when none. */
  runtimeHandSet?: string[]
  layers: { plan: Proposal[]; live?: unknown }       // plan authoring arrives in 2.x; live in §5.11
  /** Estimated tokens the last labelling run spent on model calls (cached replies cost none). Absent on older worlds. */
  labelTokens?: number
}
export type WorldAction =
  | { type: 'focus'; ids: string[] } | { type: 'highlight'; ids: string[] }
  | { type: 'flow'; edgeIds: string[] } | { type: 'openCard'; id: string }
  | { type: 'fog'; ids: string[] }                   // parts the evidence does not support: drawn in fog until the next reset
  | { type: 'tour'; steps: { ids: string[]; caption: string }[] }
  | { type: 'draftProposal'; proposalId: string }    // website demo only in 2.0
  | { type: 'reset' }

// ---- world host wire shapes (main <-> renderer, main <-> the Lumopolis utility process) ----
/** A filter over a stored world: by ids, by case-insensitive text, or both; `limit` defaults to 20. */
export interface WorldQuery { ids?: string[]; text?: string; limit?: number; /** A plain-text card per building and line returned. */ cards?: boolean; /** Each proposal's plan versus built. */ plan?: boolean }
/** The matching districts, buildings and edges, plus the evidence their claims cite (deduplicated). */
export interface WorldReadResult {
  items: (Building | WorldEdge | District)[]; evidence: Evidence[]
  /** Item id to plain-text card (with `cards`). */
  cards?: Record<string, string>
  /** Each proposal against the built code (with `plan`). */
  plan?: { proposals: { id: string; title: string; missing: string[]; changed: string[]; extra: string[]; removes: string[]; /** When the design was last compiled into the world: the plan may be older than the design. */ planAt?: number }[] }
}
/** A compile stage's progress, pushed while a world compiles. `root` is the folder the renderer asked about. */
export interface WorldProgressEvent { root: string; projectKey: string; stage: string; pct: number }
/** A stored world changed after files changed (the watcher's recompile finished). */
export interface WorldUpdatedEvent { root: string; projectKey: string }

// ---- Lumopolis ask (renderer <-> main): one question about the world, answered by the user's agent ----
export interface AskRequest { askId: string; root: string; question: string; selection: string[]; cameraRegion: string[]; summary: string; /** The model id for the Lumopolis agent; absent means the CLI's own default. */ model?: string; /** The design proposal on show (an id in doc.layers.plan); main looks it up and adds it to the question. */ proposalId?: string }
/** Evidence an answer cites, with the ids of the buildings and lines it points at. */
export type CitedEvidence = Evidence & { items: string[] }
export type AskResult =
  | { askId: string; ok: true; answer: import('./answerProtocol').WorldAnswer; summary: string; cited: Record<string, CitedEvidence>; tokens: number }
  | { askId: string; ok: false; error: string; cancelled?: boolean }

// ---- Lumopolis design (renderer <-> main): a planned system drafted and refined by conversation ----
/** A new design world, keyed design:<id>, and the agent's plain-language note about it. */
export interface DesignDraftResult { key: string; doc: WorldDoc; text: string; tokens: number }
/** The design after one refine: changes applied and skipped (malformed ones count as skipped), plus the running summary. */
export interface DesignRefineResult { doc: WorldDoc; text: string; applied: number; skipped: number; summary: string; tokens: number }

// ---- Lumopolis sources (renderer <-> main): the worlds the user has opened, newest first ----
/** Where a world comes from: this project, a folder, a cloned repository, or a design (keyed design:<id>). */
export type WorldSource =
  | { kind: 'project'; root: string; linkedDesign?: string }
  | { kind: 'folder'; root: string; linkedDesign?: string }
  | { kind: 'git'; url: string; ref?: string; root: string; linkedDesign?: string; login?: RepoLogin }
  | { kind: 'design'; id: string; title: string; linkedRoot?: string }

/** One recent world. `missing`: its folder (or stored design) is gone, so it can only be removed. */
export interface WorldEntry {
  key: string
  source: WorldSource
  title: string
  lastOpened: number
  missing?: boolean
}

/** A folder picked for Build it: nothing is registered yet; `empty` drives the "not empty" warning. */
export interface WorldFolderPick { root: string; empty: boolean }
/** Build it: the folder now linked to the design, and the first prompt for the agent opened there. */
export interface BuildItResult { root: string; key: string; title: string; prompt: string }

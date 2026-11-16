// Lumopolis (the 3D world view). The WorldDoc is the single data contract between the analyzer
// (main process), the engine/renderer and the standalone website demo. Types only: this file
// emits no JavaScript.

export type ClaimState = 'proposed' | 'observed' | 'inferred' | 'verified'
export type EvidenceKind = 'file' | 'symbol' | 'test' | 'transcriptStep' | 'memory' | 'commit'
  | 'trace' | 'metric' | 'log' | 'deploy'            // last four reserved for the live layer (§5.11)
export interface Evidence { kind: EvidenceKind; ref: string; excerpt?: string }
export interface Claim { text: string; state: ClaimState; evidence: Evidence[] }
export type BuildStatus = 'verified' | 'built' | 'gap' | 'proposed'
export interface Floor { name: string; tech: string[]; members: string[] }
export interface District { id: string; name: string; subtitle: string; hue: number; members: string[] }
export interface Building {
  id: string; districtId: string; name: string; techLabel: string; process: string
  floors: Floor[]; stack: string[]; how: Claim[]; why: Claim[]; status: BuildStatus; members: string[]
}
export interface WorldEdge {
  id: string; from: string; to: string; cargo: string; label: string
  how: Claim[]; tech: string[]; why: Claim[]; rate: string; twoWay: boolean
}
export interface External { id: string; name: string; kind: 'agent' | 'provider' | 'files' | 'machine' | 'service'; fog: boolean }
export interface Proposal { id: string; title: string; summary: Claim[]; buildings: Building[]; edges: WorldEdge[] }  // 2.0: website demo only
export interface Tour { id: string; title: string; steps: { ids: string[]; caption: string }[] }
export interface WorldDoc {
  version: 1; projectKey: string; generatedAt: number; sourceRevision: { head: string; dirty: boolean }
  districts: District[]; buildings: Building[]; edges: WorldEdge[]; externals: External[]
  glossary: Record<string, string>; cargo: Record<string, { shape: 'cube' | 'sphere' | 'octa' | 'tetra'; color: string; label: string }>
  processes: Record<string, { label: string; color: string }>
  tours: Tour[]
  layout: { seed: number; positions: Record<string, [number, number, number]> }
  runtimeNames: Record<string, string[]>             // §5.11 hook
  layers: { plan: Proposal[]; live?: unknown }       // plan authoring arrives in 2.x; live in §5.11
}
export type WorldAction =
  | { type: 'focus'; ids: string[] } | { type: 'highlight'; ids: string[] }
  | { type: 'flow'; edgeIds: string[] } | { type: 'openCard'; id: string }
  | { type: 'tour'; steps: { ids: string[]; caption: string }[] }
  | { type: 'draftProposal'; proposalId: string }    // website demo only in 2.0
  | { type: 'reset' }

// ---- world host wire shapes (main <-> renderer, main <-> the Lumopolis utility process) ----
/** A filter over a stored world: by ids, by case-insensitive text, or both; `limit` defaults to 20. */
export interface WorldQuery { ids?: string[]; text?: string; limit?: number }
/** The matching districts, buildings and edges, plus the evidence their claims cite (deduplicated). */
export interface WorldReadResult { items: (Building | WorldEdge | District)[]; evidence: Evidence[] }
/** A compile stage's progress, pushed while a world compiles. `root` is the folder the renderer asked about. */
export interface WorldProgressEvent { root: string; projectKey: string; stage: string; pct: number }
/** A stored world changed after files changed (the watcher's recompile finished). */
export interface WorldUpdatedEvent { root: string; projectKey: string }

// ---- Lumopolis ask (renderer <-> main): one question about the world, answered by the user's agent ----
export interface AskRequest { askId: string; root: string; question: string; selection: string[]; cameraRegion: string[]; summary: string }
export type AskResult =
  | { askId: string; ok: true; answer: import('./answerProtocol').WorldAnswer; summary: string }
  | { askId: string; ok: false; error: string; cancelled?: boolean }

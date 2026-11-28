// The words the mapping progress shows and says for a compile stage (signoff-decisions.md B11; layout, COPY1 R1 M3).
// The stage ids stay as they are on the wire (main/world/compile.ts CompileStage, and worldHost.ts's 'cloning'); only
// the pane turns them into words. Every stage main sends has its own words; an id a later version adds reads as
// "Mapping" until it gets some.

export const STAGE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  structure: 'Listing files',
  boundaries: 'Reading files',
  grouping: 'Grouping files',
  status: 'Checking changes',
  labelling: 'Naming parts',
  layout: 'Arranging',
  cloning: 'Cloning',
})

/** The words for a stage id; any id without its own words, an inherited name such as "constructor" too, is "Mapping". */
export function stageWord(stage: string): string {
  return Object.prototype.hasOwnProperty.call(STAGE_WORDS, stage) ? STAGE_WORDS[stage] : 'Mapping'
}

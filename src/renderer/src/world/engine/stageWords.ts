// The words the mapping progress shows and says for a compile stage (signoff-decisions.md B11). The stage ids stay as
// they are on the wire (main/world/compile.ts CompileStage, and worldHost.ts's 'cloning'); only the pane turns them into
// words. A stage with no words of its own (layout, or one a later version adds) reads as "Mapping".

export const STAGE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  structure: 'Listing files',
  boundaries: 'Reading files',
  grouping: 'Grouping files',
  status: 'Checking changes',
  labelling: 'Naming parts',
  cloning: 'Cloning',
})

/** The words for a stage id; any id without its own words, an inherited name such as "constructor" too, is "Mapping". */
export function stageWord(stage: string): string {
  return Object.prototype.hasOwnProperty.call(STAGE_WORDS, stage) ? STAGE_WORDS[stage] : 'Mapping'
}

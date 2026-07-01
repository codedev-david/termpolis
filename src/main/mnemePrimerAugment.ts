// mnemePrimerAugment.ts
//
// Composes the launch primer with Mneme's higher-organ blocks (P1c/P5): the
// brain's self-assessed weak spots (metacognition), open questions worth
// exploring (curiosity), and its continuous-identity digest. Pure and testable;
// every block is optional so this is a no-op until that state has accrued.

export interface PrimerParts {
  competence?: string
  curiosity?: string[]
  identity?: string
}

export function augmentPrimer(primer: string | null, parts: PrimerParts): string | null {
  const blocks: string[] = []
  if (parts.competence) blocks.push(`Self-competence — proceed carefully here:\n${parts.competence}`)
  if (parts.curiosity && parts.curiosity.length) {
    blocks.push(`Open questions worth exploring:\n${parts.curiosity.map((q) => `- ${q}`).join('\n')}`)
  }
  if (parts.identity) blocks.push(parts.identity)
  if (blocks.length === 0) return primer
  return [primer, ...blocks].filter(Boolean).join('\n\n') || null
}

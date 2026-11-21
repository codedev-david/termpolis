// The name a person sees for a world. The World pane's toolbar shows it, and main titles an exported page and
// a documentation file with it, so the name on screen and the name in the file can never differ.
import type { WorldEntry } from './types'

/** A design is named by its title in the recent worlds, or "Design" when it isn't listed there. */
export function designTitle(entries: readonly WorldEntry[], designKey: string): string {
  return entries.find((e) => e.key === designKey)?.title ?? 'Design'
}

/** The world's name: a design's title; a cloned repository's registry title (its folder is named by a hash);
 *  any other folder's last name. Empty with neither a folder nor a design (the home). */
export function worldTitle(entries: readonly WorldEntry[], at: { root: string | null; designKey: string | null }): string {
  if (at.designKey !== null) return designTitle(entries, at.designKey)
  if (!at.root) return ''
  const root = at.root
  const git = entries.find((e) => e.source.kind === 'git' && e.source.root === root)
  return git ? git.title : (root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() as string)
}

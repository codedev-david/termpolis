// Lumopolis runtime names: the names a part goes by while it runs (a service, a container, a deployment).
// Code and manifests give some; a person can edit them in the pane. An edit is stored as an annotation
// whose text is "runtime:" and the names, comma separated. Such a claim is not shown as a note on the card:
// the merge turns it into the part's runtimeNames. Dependency-free and ES2020: main, the gateway and the
// renderer all use it.

/** Prefix of the annotation text that carries a part's hand-edited runtime names. */
export const RUNTIME_PREFIX = 'runtime:'
/** The most names one part keeps. */
export const MAX_RUNTIME_NAMES = 10
const NAME = /^[\w.-]{1,64}$/

/** Whether an annotation text is a runtime-names claim. */
export const isRuntimeText = (text: string): boolean => text.startsWith(RUNTIME_PREFIX)

/** The names that fit (1 to 64 letters, digits, dots, dashes and underscores), each once, at most MAX_RUNTIME_NAMES. */
export function cleanRuntimeNames(names: readonly unknown[]): string[] {
  const out: string[] = []
  for (const n of names) {
    if (typeof n !== 'string') continue
    const t = n.trim()
    if (NAME.test(t) && !out.includes(t)) out.push(t)
    if (out.length === MAX_RUNTIME_NAMES) break
  }
  return out
}

/** The annotation text for a list of names. */
export const runtimeText = (names: readonly string[]): string => `${RUNTIME_PREFIX}${cleanRuntimeNames(names).join(',')}`

/** The names an annotation text carries, checked; none when the text is not a runtime-names claim. */
export const namesOfRuntimeText = (text: string): string[] => (isRuntimeText(text) ? cleanRuntimeNames(text.slice(RUNTIME_PREFIX.length).split(',')) : [])

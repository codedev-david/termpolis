import { collect, type Boundary } from './common'

// watch key = the first argument if it is a string literal, else '*'. Watching is a consume.
const WATCH = /\b(?:fs|fsp|fsPromises|chokidar)\.(?:watch|watchFile)\(\s*(?:['"`]([^'"`]+)['"`])?/

export function detectWatch(file: string, text: string): Boundary[] {
  return collect(file, text, WATCH, (m) => ({ kind: 'watch', key: m[1] ?? '*', side: 'consume' }))
}

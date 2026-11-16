import { collect, type Boundary } from './common'

// http-out key = host only (no scheme, port or path); a non-literal host (`${host}`) is skipped; http-listen key = the port as a string.
const OUT = /\b(?:fetch|axios(?:\.\w+)?|https?\.(?:get|request))\(\s*['"`]https?:\/\/([^/:?#'"`\s${}]+)(?=[/:?#'"`\s]|$)/
const LISTEN = /\.listen\(\s*(\d+)/

export function detectHttp(file: string, text: string): Boundary[] {
  return [
    ...collect(file, text, OUT, (m) => ({ kind: 'http-out', key: m[1], side: 'consume' })),
    ...collect(file, text, LISTEN, (m) => ({ kind: 'http-listen', key: m[1], side: 'provide' }))
  ]
}

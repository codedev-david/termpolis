import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// GUARD (v1.27.4 crash class). A JSONL loader must NEVER decode a whole file into one string via
// `readFileSync(path, 'utf8').split('\n')`. On Node 20 (Electron 30's runtime) that fast path builds
// the string through String::NewFromUtf8, which returns Empty and then FATALS — UNCATCHABLY:
// "v8::ToLocalChecked Empty MaybeLocal", aborting the whole process — once the file crosses V8's max
// string length (~512 MiB). That is how a 568 MB swarm-memory.jsonl crash-looped the app on launch.
// Stream by bytes instead: forEachShardLine / forEachBufferLine in src/main/fileLines.ts.
//
// This guard is the ONLY thing that catches a REGRESSION here: behavioural tests use small fixtures,
// and a reverted loader still passes them (a small file never reaches the cliff). So we assert the
// pattern is absent from the source. It fails CI the moment anyone reintroduces it.
describe('no whole-file JSONL string decode in main-process loaders (v1.27.4 crash guard)', () => {
  const MAIN = path.join(process.cwd(), 'src', 'main')

  function tsFiles(dir: string): string[] {
    const out: string[] = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...tsFiles(full))
      else if (e.name.endsWith('.ts')) out.push(full)
    }
    return out
  }

  // readFileSync(<anything>, 'utf8'|"utf8"|'utf-8').split(...)  — [^)] spans newlines, so this also
  // catches the pattern split across lines. Legit single-JSON reads — JSON.parse(readFileSync(f,'utf8'))
  // or readFileSync(f,'utf8').trim() — have no `.split(` and are correctly NOT flagged.
  const BAD = /readFileSync\s*\([^)]*['"]utf-?8['"][^)]*\)\s*\.split\s*\(/

  it("has no readFileSync(..., 'utf8').split(...) anywhere under src/main", () => {
    const offenders: string[] = []
    for (const f of tsFiles(MAIN)) {
      const src = fs.readFileSync(f, 'utf8')
      if (!BAD.test(src)) continue
      // Report a precise line for whoever has to fix it.
      src.split('\n').forEach((line, i) => {
        if (/readFileSync\s*\([^)]*['"]utf-?8['"]/.test(line) && /\.split\s*\(/.test(line)) {
          offenders.push(`${path.relative(MAIN, f)}:${i + 1}  ${line.trim()}`)
        }
      })
      // Fallback if the match spanned lines (line-level heuristic missed it).
      if (offenders.length === 0) offenders.push(path.relative(MAIN, f) + ' (multi-line readFileSync utf8 .split)')
    }
    expect(
      offenders,
      'Whole-file JSONL decode(s) found — stream via forEachShardLine (src/main/fileLines.ts) instead:\n' + offenders.join('\n'),
    ).toEqual([])
  })
})

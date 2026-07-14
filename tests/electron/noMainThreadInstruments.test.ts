// The instrument must never become the disease.
//
// v1.25.15 shipped a V8 sampling profiler to name freezes. Its premise — "`Profiler.stop` blocks the
// thread for 4-15 ms, so the instrument cannot manufacture the disease" — was measured in a toy
// script. In the real main process (heap 1.1 GB, RSS 1.75 GB, a very large loaded-code footprint)
// `Profiler.stop` blocked for ~1000 ms, and it was called from the stall watchdog itself:
//
//     Profiler.stop blocks ~1000ms  ->  next 250ms tick arrives 750ms late
//     750ms > STALL_RECORD_MS(400)  ->  "a freeze!" -> to name it, harvest -> Profiler.stop
//     ...which blocks ~1000ms       ->  next tick 750ms late -> "a freeze!" -> harvest -> ...
//
// A closed loop that never breaks: every freeze it detected was one it had just caused. David's
// stalls.jsonl recorded 1,139 freezes blaming `post` (the session.post wrapper) for 890 SECONDS of
// main-thread block in a 21-minute session, with `breadcrumb: null` and `spans: null` — no app work
// was running at all. The main thread is the one that echoes PTY keystrokes, so it read as a 5-10s
// typing lag and an app that froze on every click.
//
// These are static guards, deliberately. The failure was not a logic bug that a unit test would have
// caught — the unit tests all passed. It was a COST assumption about a native call, and the only
// durable defence is to keep the whole class of instrument out of the thread that serves the UI.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const MAIN = path.join(__dirname, '..', '..', 'src', 'main')

function mainProcessSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  }
  walk(MAIN)
  return out
}

describe('the main thread carries no self-inflicted instruments', () => {
  it('has no stall profiler', () => {
    expect(fs.existsSync(path.join(MAIN, 'stallProfiler.ts'))).toBe(false)
  })

  it('has no freeze detector', () => {
    expect(fs.existsSync(path.join(MAIN, 'processHealth.ts'))).toBe(false)
  })

  // The V8 inspector answers IN-PROCESS and SYNCHRONOUSLY. Any use of it from the main process is a
  // main-thread block whose cost scales with the size of the heap and the call tree — i.e. it is
  // cheapest exactly where you test it, and most expensive exactly where the user runs it.
  it('never attaches the V8 inspector to the main process', () => {
    const offenders = mainProcessSources().filter((f) => {
      const src = fs.readFileSync(f, 'utf8')
      return /from ['"]node:inspector['"]|require\(['"]node:inspector['"]\)|require\(['"]inspector['"]\)/.test(src)
    })
    expect(offenders.map((f) => path.basename(f))).toEqual([])
  })

  it('never drives the V8 CPU profiler', () => {
    const offenders = mainProcessSources().filter((f) =>
      /Profiler\.(start|stop|enable|setSamplingInterval)/.test(fs.readFileSync(f, 'utf8')),
    )
    expect(offenders.map((f) => path.basename(f))).toEqual([])
  })
})

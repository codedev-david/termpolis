// MUST be the FIRST import of src/main/index.ts, and MUST import nothing itself.
//
// libuv reads UV_THREADPOOL_SIZE once, when the first piece of pool work is submitted (async fs, crypto,
// dns.lookup, zlib), and never again. The default is 4 threads. On a machine where Defender makes every file
// open slow, four slow opens fill the whole pool and every other async fs/crypto call in the app queues behind
// them, the echo path's neighbours included. 16 threads is cheap (they are idle most of the time) and keeps
// one slow open from starving the rest.
//
// WHY A SEPARATE FIRST IMPORT AND NOT A LINE IN index.ts: ES imports are hoisted, so an assignment written as
// the first line of index.ts would run AFTER every module it imports had been evaluated. A leading side-effect
// import of a module with no imports of its own is the only way to run before them. (tests/electron/
// threadpoolEnv.test.ts pins both facts: this is index.ts's first statement, and this file imports nothing.)
//
// A value the user (or CI) already set is respected; TERMPOLIS_NO_GOVERNOR=1 leaves the process exactly as it
// was before the governor existed.
//
// THE VARIABLE LIVES FOR A FEW LINES ONLY. Whatever stays in process.env is inherited by EVERYTHING Termpolis
// starts afterwards: every shell and every agent CLI in a terminal (Claude Code, Codex and Gemini are Node
// programs and would run with a pool size nobody asked for), every workflow command, the utility hosts, and a
// Termpolis relaunched by the updater (which would take the value for the USER's own and pass it on for ever).
// A user's shell must see no variable the user never set. libuv has read the variable by the time the first
// async call has been submitted (uv__work_submit starts the whole pool, and reads the variable, synchronously
// inside that call), so this module makes that call itself, a throw-away async stat, and puts the environment
// back exactly as it found it: deleted when the user had none, the empty string when that is what they had.
// That happens before anything else in the app can run, so no child can exist yet and no per-spawn cleanup is
// needed anywhere. If the pool cannot be started on the spot (no process.getBuiltinModule, or the call throws)
// the variable is still put back and the pool starts later at the default size: today's behaviour, nothing
// leaked. (tests/electron/threadpoolPtyEnv.test.ts counts the environment a terminal is given;
// tests/electron/threadpoolChildEnv.test.ts asks a real child process what it inherited.)

/** What this module did, for the tests and the field diagnostics. Plain data. */
export interface ThreadpoolEnvState {
  /** The default was put in place for the pool: false when the user set a value, or the kill switch is on. */
  applied: boolean
  /** The pool was started here, so libuv has read the default; false when that could not be done (default size). */
  started: boolean
  /** What the variable held before this module touched it: undefined means the user never set it. */
  original: string | undefined
}

export const threadpoolEnvState: ThreadpoolEnvState = { applied: false, started: false, original: undefined }

if (process.env.TERMPOLIS_NO_GOVERNOR !== '1' && process.env.TERMPOLIS_NO_GOVERNOR !== 'true' && !process.env.UV_THREADPOOL_SIZE) {
  const original = process.env.UV_THREADPOOL_SIZE // undefined, or the empty string (libuv treats that as unset)
  threadpoolEnvState.applied = true
  threadpoolEnvState.original = original
  process.env.UV_THREADPOOL_SIZE = '16'
  try {
    const host = process as unknown as { getBuiltinModule?: (id: string) => unknown }
    const fs = typeof host.getBuiltinModule === 'function'
      ? (host.getBuiltinModule('node:fs') as { stat?: (path: string, done: () => void) => void } | undefined)
      : undefined
    if (fs && typeof fs.stat === 'function') {
      fs.stat('.', () => {})
      threadpoolEnvState.started = true
    }
  } catch {
    // Not started: the pool will start at the default size when first used. Today's behaviour.
  }
  // Put it back, whatever happened above: from here on no child process can inherit it.
  if (original === undefined) delete process.env.UV_THREADPOOL_SIZE
  else process.env.UV_THREADPOOL_SIZE = original
}

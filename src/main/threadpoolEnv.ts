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
// was before the governor existed. Child processes (the utility hosts) inherit the value through the
// environment, so each of them gets the same pool size.
if (process.env.TERMPOLIS_NO_GOVERNOR !== '1' && process.env.TERMPOLIS_NO_GOVERNOR !== 'true' && !process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16'
}

// A module, not a script: isolatedModules needs one export (an empty one).
export {}

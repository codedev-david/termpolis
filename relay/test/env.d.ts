// The bindings the tests reach for. `cloudflare:test` types `env` as
// `Cloudflare.Env`, which is empty unless the project declares it -- so without
// this every `env.PAIRING_ROOM` is a type error even though it resolves fine at
// run time. Declared here rather than in src so a test-only binding
// (CONNECTION_BYTE_BUDGET) never looks like part of the production surface.
declare namespace Cloudflare {
  interface Env {
    PAIRING_ROOM: DurableObjectNamespace
    CONNECTION_BYTE_BUDGET?: string
  }
}

// `?raw` imports are a Vite transform, not a module the TypeScript resolver can
// find. Declared so `npm run typecheck` accepts the wrangler.toml read in
// config.test.ts without loosening anything else.
declare module '*?raw' {
  const contents: string
  export default contents
}

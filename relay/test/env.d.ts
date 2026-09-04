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

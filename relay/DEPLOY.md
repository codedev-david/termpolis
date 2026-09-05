# Deploying the relay

The relay is one Cloudflare Worker (`termpolis-relay`) plus one Durable Object
class (`PairingRoom`). There is no database to provision and no state to
migrate. A deploy replaces the code and nothing else.

## Prerequisites

1. A Cloudflare account. The Workers **free** plan is enough: `PairingRoom` is
   declared under `new_sqlite_classes`, and SQLite-backed Durable Objects are
   available on every plan. (The older KV-backed `new_classes` form does require
   Workers Paid, which is why this one does not use it — see the comment in
   `wrangler.toml`. The choice is permanent for a class, so it was made before
   the first deploy rather than discovered after one.)
2. Authentication, one of:
   - `npx wrangler login` in an interactive terminal, for a hand deploy; or
   - `CLOUDFLARE_API_TOKEN` in the environment, for CI. The token needs
     *Workers Scripts: Edit* and *Workers Durable Objects: Edit* on the account.
3. A hostname. `relay.termpolis.com` is the obvious choice, since
   `termpolis.com` already lives on this account.

**No Cloudflare token is committed to this repository.** CI reads
`CLOUDFLARE_API_TOKEN` from repository secrets; `gh secret list` shows the
current inventory. If it is not there, it has not been set — add it with
`gh secret set CLOUDFLARE_API_TOKEN`, and do not paste it into a file.

## Deploying

```bash
npm --prefix relay test          # 51 tests, in real workerd
npm --prefix relay run deploy    # wrangler deploy
```

`wrangler deploy` prints the `workers.dev` URL it published to. That URL works
immediately and is fine for a first smoke test.

## Deploying from CI

`.github/workflows/relay-deploy.yml` does the same thing without a laptop in the
loop: it runs the typecheck and the workerd suite, deploys, then probes every
trigger URL wrangler printed with `GET /v1/pair/<32 hex>` and requires a **426**.
That path is refused before the rate limiter runs and before any Durable Object
is addressed, so the smoke test proves the Worker is live and routing while
opening nothing and costing nothing.

It runs on pushes to `main` that touch `relay/`, and on demand:

```bash
gh workflow run relay-deploy.yml                    # deploy
gh workflow run relay-deploy.yml -f dry_run=true    # validate config only, no token needed
```

With no `CLOUDFLARE_API_TOKEN` set, a push skips the deploy with a notice and a
hand-run fails with instructions. It never half-deploys and never turns `main`
red for a credential that was never added.

## Binding the custom domain

In the Cloudflare dashboard: **Workers & Pages → termpolis-relay → Settings →
Domains & Routes → Add → Custom domain**, then enter `relay.termpolis.com`.
Cloudflare creates the DNS record and provisions the certificate; it takes a
minute or two. A custom domain is not the same as a route — use the domain, so
the Worker owns the hostname rather than intercepting a path on another zone.

Once bound, the desktop's relay URL is `wss://relay.termpolis.com`.

## The rate-limit namespace id

`wrangler.toml` declares an `unsafe.bindings` rate limiter:

```toml
[[unsafe.bindings]]
name = "REGISTRATIONS"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 30, period = 60 }
```

`namespace_id` is **not** an account-level resource you create in the
dashboard — it is an arbitrary identifier you choose, scoped to this Worker. It
only has to be stable and unique among this Worker's own limiters. Changing it
resets every counter, which is harmless. `1001` is the first id this Worker
used and there is no reason to change it.

## Rolling back

```bash
npx wrangler rollback --name termpolis-relay
```

`wrangler deployments list --name termpolis-relay` shows the history and the
ids a rollback can target. Rolling back drops every live connection, because
the Worker is replaced; desktops and phones reconnect on their own backoff.
There is no persisted state to be inconsistent afterwards.

## Reading logs without reading traffic

```bash
npx wrangler tail --name termpolis-relay --format json
```

This streams request metadata: URL, status, timing, exceptions, and anything
the Worker explicitly logs. It does **not** stream WebSocket frame bodies —
`wrangler tail` has no access to them, and the Worker never logs a frame,
a frame body, or any part of one. See `PRIVACY.md` for what that leaves
visible.

If you need to add logging while debugging, log the pairing id and the frame
length. Never log the frame. A `console.log` of a frame body would put
ciphertext in Cloudflare's logs — still unreadable, still not something that
should be there.

## Testing without deploying

Everything up to `wrangler deploy` is exercisable locally:

```bash
npm --prefix relay run dev    # wrangler dev, a local workerd
npm --prefix relay test       # the suite, also in workerd
```

The tests run inside real workerd via `@cloudflare/vitest-pool-workers`, not a
mock — Durable Object storage, alarms, hibernation and WebSocket semantics all
behave as they will in production. A green suite is meaningful evidence, which
is why the CI job that runs it is blocking.

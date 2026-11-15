# ADR-0007: Tenant invoice prefixes

- Status: Accepted
- Date: 2026-09-18
- Supersedes: ADR-0004

## Context

Ledgerly now bills for several tenants. Year-based numbers collided across tenants,
and the January reset produced duplicate numbers in exported ledgers.

## Decision

An invoice number is `<TENANT_CODE>-<NNNNNN>`: the tenant's code, a hyphen and a
six-digit zero-padded sequence (for example `ACME-000042`). Each tenant has its own
sequence, stored in `store.tables.sequences` under the tenant code. Sequences start at 1
and never reset.

## Consequences

`docs/ARCHITECTURE.md` and `src/legacy/billing.js` still describe the old format.

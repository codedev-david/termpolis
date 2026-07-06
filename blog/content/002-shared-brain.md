---
title: "The Shared Brain: How Termpolis Gives Every AI Agent the Same Memory"
subtitle: "One persistent, private, semantic memory — written by Claude, recalled by Codex, and never siloed per tool."
slug: shared-brain
order: 2
status: draft
tags: [AI, Developer Tools, Memory, MCP, Privacy]
platforms: [substack, medium]
mediumStatus: public
---

> Draft outline — flesh out, then change `status` to `queued` to make it the next post.

## Angle
Solve the "goldfish problem": AI agents that forget everything the moment a session ends.

## Beats
- **The problem.** Every agent starts from zero; knowledge dies with the session and never crosses tools.
- **The store.** Local, encrypted at rest (AES-256-GCM), native-free WASM embedder, HNSW semantic search with a keyword fallback.
- **The proof.** The CI test: agent A writes a decision, agent B recalls it from a keyword-free paraphrase, over the real MCP wire.
- **Auto-primer.** Launch an agent and the relevant project memory is injected automatically — you control the send.
- **Hot + cold.** A 50k-token hot window over a JSONL cold store; content-addressed dedup keeps it lean.
- **Privacy by construction.** Local-first, encrypted, `deviceId` never exported; brain export/import as a portable `.zip`.

## Takeaway
Memory is the substrate everything else is built on. Next week: how it doesn't just store, but *learns*.

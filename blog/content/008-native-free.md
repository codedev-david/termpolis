---
title: "Built Native-Free: WASM Embeddings, WASM Tree-Sitter, and Why It Matters"
subtitle: "The engineering bets that let an AI-native terminal ship as one small, signed, auto-updating installer."
slug: native-free
order: 8
status: draft
tags: [Software Engineering, WebAssembly, Electron, Developer Tools]
platforms: [substack, medium]
mediumStatus: public
---

> Draft outline — flesh out, then change `status` to `queued` to make it the next post.

## Angle
The how-we-built-it finale, for a technical audience.

## Beats
- **The native-free thesis.** No node-gyp, no build toolchain — one small signed installer that auto-updates cleanly on Windows.
- **WASM embeddings.** Running the embedding model in-process without native binaries, and the threading gotcha it created.
- **WASM tree-sitter.** Ten grammars as WASM, and the sharp edges (ABI pinning, parser/worker lifecycle).
- **What it buys you.** Portability, install size, painless CI, clean code-signing.
- **Closing reflection.** What building an AI-native dev tool taught me — and where Termpolis goes next.

## Takeaway
Wrap-up of the series, plus a look at the roadmap.

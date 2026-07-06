---
title: "The Code Graph: AST-Precise Code Intelligence, No Native Deps"
subtitle: "Grep lies and agents hallucinate call sites. A real, tree-sitter-backed map of your code across ten languages."
slug: code-graph
order: 6
status: draft
tags: [AI, Developer Tools, Programming, Static Analysis]
platforms: [substack, medium]
mediumStatus: public
---

> Draft outline — flesh out, then change `status` to `queued` to make it the next post.

## Angle
Grep lies; agents hallucinate call sites. Ground them in real structure.

## Beats
- **The precision problem.** String search invents false edges from comments and substrings.
- **AST-precise, everywhere.** web-tree-sitter (WASM) across ten languages — real call sites only, member-vs-free calls, exact boundaries.
- **The tools.** `code_explore`, `code_callers`, `code_impact` (blast radius), `code_search`.
- **Always fresh.** Auto-index on launch plus `fs.watch` so the graph tracks the working tree.
- **Native-free.** Why shipping tree-sitter as WASM matters: tiny installer, no build toolchain, cross-platform. The +1MB grammars trick.
- **Agents that refactor safely.** "Who calls this?" and "what breaks if I change it?" answered from the graph, not a guess.

## Takeaway
Agents that reason about real structure. Next week: the guardrails that keep all this power from leaking your secrets.

---
title: "Secure AI-Assisted Development: What Termpolis Watches So You Don't Leak"
subtitle: "Every prompt to a hosted model is an egress event. Scan it, audit it, and keep your secrets home — without going local."
slug: secure-ai-dev
order: 7
status: draft
tags: [Security, AI, Developer Tools, DevSecOps]
platforms: [substack, medium]
mediumStatus: public
---

> Draft outline — flesh out, then change `status` to `queued` to make it the next post.

## Angle
Every prompt to a hosted model is an egress event — so treat it like one.

## Beats
- **The threat model.** Code, `.env` contents, and keys flowing to a cloud model, invisibly.
- **The AI Security Center.** Outbound prompt scanning (70+ secret patterns, sub-millisecond on Enter/paste), a sensitive-file-read watcher (`.env*`, PEM, SSH, cloud creds), an egress audit trail, a ToS-drift watcher, Strict Mode, and a JSONL audit log.
- **The thesis.** Secure *hosted*-model use with layered defenses — not a retreat to weaker local models.
- **Second Opinion.** Cross-model review (Codex / Gemini / Qwen / nested Claude) as a quality and safety net.

## Takeaway
Use the best cloud models — with guardrails. Next week, the series finale: the engineering bets under the hood.

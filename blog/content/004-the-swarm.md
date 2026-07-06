---
title: "The Swarm: Orchestrating a Team of AI Agents From One Conductor"
subtitle: "One agent is a contractor. A swarm is a crew — decomposed tasks, a shared board, and cost-aware routing."
slug: the-swarm
order: 4
status: draft
tags: [AI, Developer Tools, Automation, Orchestration]
platforms: [substack, medium]
mediumStatus: public
---

> Draft outline — flesh out, then change `status` to `queued` to make it the next post.

## Angle
One agent is a contractor; a swarm is a coordinated crew.

## Beats
- **The conductor.** A 15-step orchestration spec: decompose a task and assign the pieces to Claude / Codex / Gemini / Qwen.
- **Coordination.** A shared task board plus an inter-agent message bus (`swarm_create_task`, `swarm_send_message`, ...).
- **The dashboard.** Watching agents move tasks pending → in-progress → completed in real time.
- **Cost-aware routing.** Send boilerplate to a cheap model, hard reasoning to the best one — token economics as a first-class concern.
- **Guardrails.** A cap of 8 agents; the whole pipeline is end-to-end gated in CI.
- **When to swarm.** And, honestly, when a single agent is the right call.

## Takeaway
Parallelism with coordination, not chaos. Next week: the protocol layer that makes all of this drivable — MCP.

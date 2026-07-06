---
title: "31 Tools Over MCP: Turning the Whole App Into an Agent API"
subtitle: "How Termpolis becomes a Model Context Protocol server, so every agent can drive memory, swarm, and code intelligence."
slug: mcp-tools
order: 5
status: draft
tags: [AI, MCP, Developer Tools, APIs]
platforms: [substack, medium]
mediumStatus: public
---

> Draft outline — flesh out, then change `status` to `queued` to make it the next post.

## Angle
MCP as the universal remote that ties memory + swarm + code graph together.

## Beats
- **What MCP is,** briefly, for readers who haven't met the Model Context Protocol.
- **Termpolis as a server.** It exposes 31 tools: memory (search / write / list / graph / primer), swarm (tasks / messages), code graph (explore / callers / impact / search), and terminal control (create / write / read / run).
- **One toolbox, every agent.** Claude, Codex, Gemini, and Qwen all connect and get the same capabilities.
- **Implementation notes.** `ping`/`list`, degraded-mode handling, per-agent auto-registration.
- **Why it matters.** The agents can program the app itself — the app stops being a passive host.

## Takeaway
MCP is the nervous system. Next week, one of the tools it exposes gets its own deep dive: the code graph.

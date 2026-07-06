---
title: "Meet Termpolis: One Terminal for All Your AI Coding Agents"
subtitle: "Run Claude Code, Codex, Gemini, and Qwen side by side — with a memory they all share, a swarm that coordinates them, and guardrails that keep your secrets home."
slug: meet-termpolis
order: 1
status: queued
tags: [AI, Developer Tools, Programming, Terminal, Productivity]
platforms: [substack, medium]
mediumStatus: public
---

If you build software with AI in 2026, your workspace probably looks a lot like mine used to: Claude Code running in one terminal, Codex in another, maybe Gemini CLI or Qwen Code in a third. Each of them is genuinely brilliant. And each of them is an amnesiac working in a locked room.

Close a tab and the context evaporates. Switch from Claude to Codex and you re-explain your architecture from scratch. Everything the first agent painstakingly learned about your codebase — the naming conventions, the gotcha in the build, the reason you chose that weird abstraction — dies when its session ends. It certainly never reaches the next agent. And in the background, every one of those tools is streaming pieces of your code (and occasionally your secrets) to a hosted model, with no ledger of what actually left your machine.

I built **Termpolis** to close all three of those gaps at once. It's a terminal — a fast, native, multi-pane terminal you'd be happy to live in all day — but one designed from the ground up for **running AI coding agents together, securely**.

This post is the map. Over the coming weeks I'll go deep on each subsystem in its own article. Subscribe if you want the full tour; here's the shape of it.

## The core idea: your agents should share a brain

The thing that makes Termpolis more than "a terminal with tabs" is that every agent you launch inside it plugs into the **same persistent, shared memory**.

When Claude Code figures out how your auth flow works, that knowledge is written to a local, encrypted store. Later — different agent, different day, different project window — Codex can *recall* it, semantically, without you re-typing a word. There's a test in the Termpolis CI that proves exactly this: one agent writes a decision, a second agent retrieves it from a keyword-free paraphrase, over the real wire. Memory that's actually shared, not memory that's siloed per tool.

And it's private by construction: the store lives on your machine, encrypted at rest, and never ships your device identity anywhere. I'll spend a whole article on how the memory works, and another on how it *learns* — because it does more than store. It reflects, links causes to effects, and lets old decisions be superseded by newer ones.

## Three pillars

Underneath the day-to-day, Termpolis stands on three ideas.

**1. Shared memory.** One brain across Claude, Codex, Gemini, and Qwen. Launch an agent and the relevant project memory is primed into it automatically. Nothing starts from zero.

**2. Orchestration — the swarm.** Sometimes one agent isn't enough. Termpolis has a *conductor* that can decompose a task, hand pieces to different agents, and let them coordinate through a shared task board and a message bus — a crew, not a lone contractor. It's cost-aware, too, routing work to the right model instead of burning your most expensive one on boilerplate.

**3. Security.** Every prompt to a hosted model is an egress event. Termpolis scans outbound prompts for secrets in real time — dozens of patterns, sub-millisecond on paste — watches for reads of sensitive files like `.env` and private keys, and keeps an audit trail of what left. The thesis is deliberate: you *can* use the best cloud models responsibly, with layered guardrails, instead of retreating to weaker local ones.

## The quiet machinery that ties it together

A few pieces don't get headlines but make everything above work:

- **An MCP control plane.** Termpolis is a Model Context Protocol *server*. It exposes its memory, its swarm, and its code intelligence as tools — so any MCP-native agent can drive the app itself. That's how four different agents all get the same superpowers.
- **A code graph.** Instead of letting an agent grep-and-guess, Termpolis builds an AST-precise map of your codebase across ten languages — real call sites, real answers to "what breaks if I change this?" — with no native dependencies to install.
- **Voice, session resume, and cross-agent handoff.** Talk to your terminal, resume any past AI session, or lift the context out of a Claude session and inject it straight into Codex. Small things that compound.

## Who it's for

Termpolis is for people who've already gone all-in on AI-assisted development and hit the ceiling of doing it with a pile of disconnected terminal tabs. If you're juggling two or more coding agents, care about not leaking secrets to a model, and wish your tools *remembered things*, it was built for you.

## The road ahead

This is the first post in a series. Here's what's coming, one per week:

1. **Meet Termpolis** — you're reading it.
2. **The Shared Brain** — how one memory serves every agent, and how it stays private.
3. **A Memory That Learns** — reflection, causal links, and forgetting on purpose.
4. **The Swarm** — orchestrating a team of agents from one conductor.
5. **31 Tools Over MCP** — turning the whole app into an agent API.
6. **The Code Graph** — AST-precise code intelligence with zero native deps.
7. **Secure AI-Assisted Development** — what Termpolis watches so you don't leak.
8. **Built Native-Free** — the engineering bets that made it all shippable.

If that sounds like your kind of thing, subscribe — and I'll see you next week, inside the memory.

*Termpolis is available at [termpolis.com](https://termpolis.com).*

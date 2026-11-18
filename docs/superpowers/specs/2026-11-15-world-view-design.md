# Lumopolis: Design Spec

> **Lumopolis: Where AI Worlds Become Human Understanding.**
> Lumopolis is the world-view visualization tool inside Termpolis, not a separate app (David, 2026-11-16). The idea behind the name: **the city of enlightenment for understanding between humans and AI** (*lumo* = light, *polis* = city). That is why the world is drawn as a city of districts and buildings (section 5.1). It was called "Lumopolis" until then. Internal code keeps the neutral `world` name (`WorldDoc`, `src/main/world/`, `world:*` IPC); everything a person sees says Lumopolis.

**Date:** 2026-11-15
**Status:** Approved by David (2026-11-15)
**Target:** Termpolis **2.0**, a major release with Lumopolis as its headline (David, 2026-11-15: "the next evolution of understanding between human and AI")
**Prototype:** `.superpowers/brainstorm/2400-1794800636/content/world-relationships.html`, a throwaway Three.js mockup that David approved as the direction ("click in certain areas and it gives detailed information for how it was built or what is being proposed")
**Source idea:** David's *Living Software Universe Plan v2* (PDF) and sketches

---

## 1. Intent: why this exists

AI now writes software faster than people can understand it. The bottleneck is no longer writing code; it is a person understanding what an agent **is about to build** or **has just built**. One day people may not read the code at all, and agents may write in languages people can't read. People will still need to understand the software, judge it and ask for changes.

Lumopolis closes that gap. It is an interactive, animated 3D world of a piece of software, shown on an ordinary 2D screen and using every visual trick for depth, where:

- the parts of the software are places you can fly around;
- the relationships between them are visible, moving connections;
- clicking anything explains, in plain English, **what it does, what technology it uses, how it connects, and why it was built that way**, without showing code;
- you can **talk to an agent inside the world**, by text or voice, to ask questions and to request changes;
- the **same world** shows something proposed (wireframe) and something built (solid), so one tool covers an idea, a plan, work in progress, and finished work.

David's framing: "almost a world model for humans to understand", a bridge between what the LLM designed or did and human understanding.

**What success looks like:** a person who has never read the code can open the world, follow a tour, click around and ask a few questions, and then correctly explain how the system works and what an agent changed. They can also point at a part and get a change built.

## 2. Goals, non-goals, anti-goals

### Goals
1. A **Lumopolis pane** in Termpolis, beside terminals, that renders the current project as a 3D world using the grammar in section 5.1.
2. **Detail cards** for every building and connection: what it does, the parts inside, technology (with a plain-English glossary), why it's built this way, what flows in and out, and how often. This is the information density of the v2 prototype.
3. **Built and proposed in one world.** Built parts come from evidence. Proposed parts come from a plan layer that agents write. The difference between them is computed and shown.
4. **Conversation inside the world** by text and by Termpolis's existing voice input. The agent's answers move the camera, highlight parts and play flows, and every claim links to its evidence.
5. **Change by pointing.** Describing a change in the world produces a wireframe proposal on the map. Approving it hands the work to agents, and the world shows the build progressing to verified.
6. **"What the agent just did"**: a before/after view of an agent's work, built from its activity log and the code graph.
7. **Export** any world, or any proposal, as one self-contained HTML file that anyone can open.
8. **A public, interactive demo on termpolis.com** that shows the world of Termpolis itself, built from the approved v2 prototype, so anyone can try Lumopolis in a browser without installing anything. It is the launch centrepiece for 2.0 (section 5.10).

### Non-goals (for this version)
- Editing code by hand in the world. Code changes always go through agents.
- Live production view in 2.0. It is the **next** project, with its own design (section 5.11). 2.0 must be built so it slots in without rework.
- VR/AR headsets.
- Multi-user, real-time shared worlds.
- Supporting every language on day one. Coverage follows what the code graph (tree-sitter) already parses.

### Anti-goals: failures even if it technically works
- **A confident, pretty lie.** If the world shows structure or reasons the code doesn't support, and doesn't mark them as guesses, it is worse than no world. Every claim has a state (section 5.2) and guesses look different on screen (fog, dashed lines).
- **A city that rearranges itself.** People remember places. Positions must stay stable between visits and across small changes.
- **A screensaver.** Spectacle that doesn't help understanding is a failure. Every visual has to carry meaning: shape, colour, motion, fog.
- **Making Termpolis slower.** The world must never add typing lag or main-process stalls. This lesson already shipped regressions in 1.47, 1.54 and 1.61.
- **Surprise token bills.** Labelling and conversation cost tokens. Both are cached, incremental and visible to the user.
- **"Open a terminal and type a command."** All of this is real in-app UI; any hidden CLI sessions run behind it (David, 2026-10-23).

## 3. Constraints

- **Performance:** nothing heavy on the Electron main thread. Compiling and laying out the world runs off the main thread, in a utility process or a worker, as the memory host and pty host already do. No synchronous file I/O or spawning on main (Defender scan stalls of 0.1–1.5 s were measured on this laptop).
- **EDR-clean:** the world compiler reads only project files, the code graph, agent transcripts and memory. It must never read credential stores, enumerate processes or network connections, or read other apps' credential files. `endpointActivityGuard` CI gates stay. Exception: with CI results on (Settings ▸ Lumopolis ▸ Read CI results with GitHub CLI, on by default; David approved `gh` on 2026-11-18), Lumopolis starts the user's own `gh` by its full path, and `gh` reads its own stored GitHub login; Termpolis never reads it. Turning the setting off means `gh` never runs. Git and `gh` are always started by full path, never by bare name, and never from inside the repository. PRIVACY.md's Lumopolis section says the same: CI through `gh`, code excerpts, commit subjects and doc lines sent to the chosen AI provider when labelling or answering, cloning only on request, and worlds, notes and bookmarks kept locally.
- **Agent tool budget:** the agent-facing MCP tool descriptions are nearly full. World tools are exposed through the existing gateway route (`gateway_list_tools` / `gateway_call`, `src/main/mcpGateway`), not as new top-level MCP tools.
- **Renderer target ES2020** (no `.at()`), Electron 43.
- **New dependency:** Three.js (`three`) is not yet a dependency. David's rule is never to run `npm install` on this laptop. The plan must add it in a way consistent with that rule, for example in CI or another machine, with the lockfile committed.
- **Providers:** US-based only (Claude Code, Codex, Gemini CLI). AI requests go through the existing token proxy (Headroom). Gemini CLI has no proxy route, so a Lumopolis run on Gemini goes straight to its provider, uncompressed, and Settings ▸ Lumopolis says so when Gemini is picked.
- **Privacy:** rendering is fully local. The only data that leaves the machine is what an agent sends to its provider, the same as any agent session: selected evidence for a question, and module summaries for labelling. A setting turns AI labelling off; the world then shows unlabelled structure.
- **Quality gates:** Windows CI coverage of lines 97 / functions 96 / branches 95 / statements 96. The `e2e/` suite is blocking and sharded.
- **Releases:** commit directly to `main` and tag releases (David's workflow).

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| **A** | **Evidence-derived world plus an agent-written plan layer.** The built world is compiled from the code graph, agent transcripts, memory and tests. An AI pass adds names and explanations, each one tied to evidence and marked as inferred until checked. Agents write proposals as a separate plan layer in the same grammar, and plan versus built is computed. | Honest and stays in sync with the code. Reuses what Termpolis already has. More upfront work: grouping code into districts and buildings, and describing relationships well, is the hard part. | **Chosen** (David, 2026-11-15) |
| B | The agent draws the world from scratch on request, like generating a diagram. | Fastest to ship and fine for ideas, but nothing checks it. It invents structure and drifts from the code, which is the first anti-goal. | Rejected |
| C | A standalone web tool that reads a repository. | Easy to share, but it can't see agent activity, memory, live work or the swarm. It throws away what makes Termpolis the right home for this. | Rejected (export in goal 7 covers sharing) |

## 5. Design

### 5.1 World grammar (decided, from the PDF and validated in the prototype)

| Software concept | In the world |
|---|---|
| Bounded context / subsystem | **District**: a hexagonal platform with a name and subtitle |
| Service / component | **Building** |
| Module / internal stage | **Floor**: floors stack in pipeline order, bottom to top |
| Something outside the system (agent CLIs, AI providers, other machines, files) | **Floating orb** |
| Dependency / communication | **Conduit**: a curved line |
| What travels on a conduit | **Packets**: shape and colour by cargo type (keystrokes, requests, tool calls, memories, code changes, logs, jobs and so on), with a legend |
| Built / observed | Solid |
| Proposed | Pulsing wireframe; dashed conduits |
| Verified (tests pass) | A green ring rotating above the building |
| Built but no tests | Amber edges |
| Uncertain or unknown | Fog; dashed lines |
| The program it runs in (process isolation) | A translucent shell around the building, coloured by process (optional layer) |

Visual depth tricks (decided, as in the prototype): bloom, exponential fog, a starfield and drifting dust for parallax, light pooling on the platforms, eased camera flights, buildings that explode floor by floor on double-click, and flow pulses. Three themes: Neon, Blueprint, Glass. The world respects reduced-motion settings.

### 5.2 The world document (source of truth)

A versioned JSON document per project, stored in Termpolis's per-user data (not the repository) and keyed by the project key the code graph already uses.

```
World {
  version, projectKey, generatedAt, sourceRevision (git HEAD + dirty flag)
  districts[]:  { id, name, subtitle, hue, members: [path globs or symbol ids] }
  buildings[]:  { id, districtId, name, techLabel, process, floors[], stack[] (technology ids),
                  how, why, status, claims[] }
  floors[]:     { name, tech, members[] }
  edges[]:      { id, from, to, cargo, label, how, tech[], why, rate, direction (one or two way), claims[] }
  externals[]:  orbs (agent CLIs, providers, files, other machines)
  glossary:     { technologyId: plain-English line }
  layout:       { seed, positions by id }   // stable, persisted, never recomputed from scratch
  layers:       { built, plan:[Proposal], live? }   // live: reserved for the production layer (5.11)
  runtimeNames: { buildingId: [service names as they appear in traces/metrics] }
}
Claim    { text, state: proposed | observed | inferred | verified, evidence: Evidence[] }
Evidence { kind: file | symbol | test | transcriptStep | memory | commit, ref, excerpt? }
```

How the code stores this: an edge's direction is `twoWay: boolean` (true is two way). There is no `layers.built` key: the top-level `buildings`, `edges` and `districts` are the built layer. A building's `status` (`BuildStatus`: verified, built, gap, proposed) keeps `built` for a solid part whose tests fail or only partly pass, while claims use the `observed` state. A design world (5.12) stores its planned parts as top-level buildings with status `proposed`; on a project, a plan shows through `layers.plan`, and a linked design carries `reconcile`, so both draw the same wireframes on screen.

Every sentence on a card is a `Claim`. The UI marks `inferred` claims as such, and items whose claims are mostly inferred get fog. "Verified" means a linked test passed or a person confirmed it.

### 5.3 World compiler: built layer

The compiler runs off the main thread (my call: a new utility process, `termpolis-lumopolis`, the same pattern as `termpolis-memory`; the builder may host it in an existing utility process if that is simpler and keeps main free). It runs in stages; each stage is cached and incremental.

1. **Structure.** Read the code graph (`src/main/codeGraph.ts`: symbols, files, callers and callees) and the directory tree.
2. **Boundaries.** Static detectors for cross-component communication, the relationships people most need explained:
   - Electron IPC channels (`ipcMain.handle` / `ipcRenderer.invoke` / `contextBridge`)
   - `MessagePort`, `utilityProcess.fork` and `Worker` entries
   - child process spawns
   - local and outbound HTTP (`fetch`, servers listening on ports)
   - environment-variable hand-offs
   - file watchers
   - MCP servers and clients

   Detectors are a pluggable list, so more frameworks can be added later.
3. **Grouping.** Cluster files and modules into buildings and buildings into districts, using directory structure, import density and boundaries. The AI may rename groups or suggest merges, but proposed groupings stay `inferred`.
4. **Labelling.** The default headless agent's cheapest model (Claude Code's Haiku; see section 10), through the proxy, writes `how`, `why`, the cargo and edge descriptions, technology chips and glossary lines from bounded excerpts: signatures, comments, docs, commit messages and memory decisions. **Every output must cite evidence ids**; uncited sentences are dropped. Results are cached by a content hash of their inputs, so only changed parts are re-labelled.
5. **Status.** Tie tests to buildings through the code graph and the existing coverage tooling, and set verified, observed or gap.
6. **Layout.** Seeded, stable positions. New items take free slots next to their neighbours; existing items don't move unless a person asks for a re-layout.
7. **Incremental updates.** The file watcher already feeds the code graph. The compiler subscribes and recompiles only the affected buildings, debounced.

**Quality bar for stage 1 to 6:** run on the Termpolis repository, the compiled world should recover roughly the buildings and connections of the hand-made v2 prototype: the screen, gatekeeper, terminal host, memory host, proxy, gateway, code graph, swarm and remote bridge, and the main connections between them. That prototype is the test case.

### 5.4 Plan layer: proposed work

- A **proposal** is a named overlay of new or changed districts, buildings, floors and edges, plus removals. All of its claims start as `proposed`.
- Agents write proposals through gateway tools (5.8). A person can also start one from the world: "Point out a change", or a spoken request.
- **Plan versus built** is computed by matching proposal items to built items by id or by member paths. The world shows what is new (wireframe), what changes (wireframe outline around a solid building), what is removed (fading) and what is already done (solid).
- A proposal moves through **Imagine → Approve → Build → Observe → Verify** (the PDF's modes). Approval turns it into swarm tasks, each in its own git worktree, using the existing conductor. As agents work, the compiler sees the changes and proposal items fill in. Tests passing add green rings. The proposal is archived when everything is built and verified (Evolve).

### 5.5 The Lumopolis pane (UI)

The interactions match the v2 prototype (decided by David's approval of that version):

- Hover a building to highlight its connections, dim everything else and show the connection labels.
- Click a building for its card: status, the program it runs in, what it does, parts inside, technology chips, why, what comes in and what goes out.
- Click a connection, or its label, for the connection card: what travels, how, technology, why, how often.
- Click a technology chip for its plain-English explanation, with every place it's used lit up.
- Double-click to explode a building into floors, with work flowing up through them.
- Layers: job or technology labels; what runs where; label every line; planned parts on or off; proposal selector; before/after.
- Tours: generated tours (how the technology fits together; follow a request), plus journeys made up on the spot by the conversation (5.6).
- Navigation: orbit, zoom, WASD/QE flight, Esc to the overview, and bookmarks.
- Semantic zoom: districts from far away, buildings in the middle distance, floors and labels up close. Instancing and level of detail keep large repositories smooth.
- A 2D map fallback for machines without WebGL, and for accessibility.

### 5.6 Conversation inside the world

- **Input:** a chat bar inside Lumopolis. Text, or **Termpolis's existing voice input** (`useVoiceInput`, tap-or-hold, Groq Whisper transcription with phantom-word filtering), reused as-is; the transcript goes to the world conversation instead of a terminal. No new voice-input system.
- **Context:** each question carries the current selection, the camera's region, the active proposal and the evidence for the selected items, capped by a token budget.
- **The agent:** a hidden, read-only agent session started the way `termpolis exec` starts one (`src/main/headlessExec.ts`: primed with the project primer, read-only by default, killed at a deadline), using the user's default agent and model, through the proxy. There is no visible terminal. My call: a fresh one-shot run per question, carrying a compact conversation summary, which works the same on all three CLIs (section 10). A warm session is a later optimisation.
- **Answer protocol:** the agent returns plain-English text plus **world actions** in a structured block:
  - `focus(ids)`, `highlight(ids)`, `flow(edgeIds)`, `tour(steps)`
  - `openCard(id)`
  - `draftProposal(…)`

  The pane carries them out as the text appears, so the camera moves and parts light up while the answer is read. The headless run returns the whole answer at once, so the pane reveals it one sentence at a time at reading pace and plays each sentence's actions as it appears (with reduced motion, all at once). Each claim in an answer links to evidence and to world items.
- **Honesty rule:** when the evidence doesn't support an answer (for example, nothing recorded why something was designed a certain way), the agent says so explicitly, and the related items stay fogged.
- **Changes from conversation:** "make this faster" or "add team sharing" produces `draftProposal`, which shows up as wireframes. Follow-up messages edit the proposal. Saying or clicking "approve" moves it to Build (5.4). The conversation never edits code itself.
- **Spoken answers (optional, off by default):** Termpolis can listen but not speak today (verified: there is no speech output in `src/`). Answers can be read aloud through Chromium's `speechSynthesis`, which uses the operating system's voices locally at no cost. Text is always shown.

### 5.7 "What the agent just did"

When an agent session finishes, or on request, the world compares the snapshot from before the session with the one after. The transcript watchers (`src/main/transcriptWatchers`) supply which files changed and the agent's stated reasons. The world highlights changed buildings in order, plays a generated tour of the change with the agent's reasons as narration, and offers "Ask about this change". This is the review mode: walk through the change instead of reading the diff.

### 5.8 Agent access through the gateway

The gateway route exposes three tools; no new top-level MCP tools:
- `world_read`: query the world (items, cards, evidence, plan versus built) for a region or ids;
- `world_propose`: create or update a proposal overlay;
- `world_annotate`: attach a claim with evidence to an item (for example, "I verified this by running X").

Agents can then design in the world ("draw your plan before building") and explain their work in it.

### 5.9 Export

"Export world" writes one HTML file: the viewer, the world document (or one proposal) embedded, and Three.js inlined, with no network needed. It is read-only and includes the cards, tours and layers, but not the conversation. Same-machine paths in evidence are reduced to repository-relative paths.

### 5.10 Website demo (termpolis.com)

- **What:** a standalone page on the website (`termpolis-web` repository, which auto-deploys to termpolis.com on push to `main`) where visitors fly around the world of Termpolis itself. It has the cards, technology chips, tours, layers, themes and double-click to open buildings from the v2 prototype.
- **Source:** the approved prototype (`world-relationships.html`) is the starting point. Its hand-written data is reviewed against the real code before launch, so every card is accurate for the release it ships with. Once phase 1 works, the demo world should be the compiler's own export of the Termpolis repository, touched up by hand where needed. Then the demo also proves the product.
- **Conversation in the demo:** the website has no agent behind it, so the Ask bar is scripted: a short list of suggested questions ("What happens when I type a prompt?", "Where do my memories live?", "What would team sharing touch?") with pre-written answers that fly the camera, light up parts and play flows, exactly as the real answer protocol does. It should be clearly labelled as a demo, with a link to download Termpolis for the real thing. One suggested question shows a proposal appearing as wireframe, so visitors see the plan-to-built idea.
- **Page and site rules:**
  - Its own page, `lumopolis.html` (my call on the name, renamed with the feature). It is linked from the homepage hero and the nav. The homepage stays lean (site rule): it gets a short teaser with a still image or short loop, and the detail lives on the demo page.
  - Three.js is vendored into the site repository at a pinned version, not loaded from a CDN at runtime, so the page doesn't depend on a third party.
  - It works on phones: touch orbit and pinch zoom, a reduced effects tier on low-power devices, and a 2D fallback or still image without WebGL.
  - Fast first view: a poster image shows while it loads, and the 3D starts after.
  - No tracking beyond what the site already does.
- **Timing:** the demo can launch **before** the 2.0 app ships, as a "coming in 2.0" preview, because it doesn't depend on the compiler. My call: launch it with 2.0 so the claims match a downloadable product. David may prefer an early teaser.

### 5.12 Where a world comes from (added 2026-11-16, David: "start building it for how you think will work best")

David wants three ways in, all inside the same city:

1. **Point it at any code.** Choices are this project, any folder on the computer, or a git repository URL. A URL is cloned read-only (shallow) into Termpolis's own data folder, indexed by the existing code graph and compiled like any project. https and ssh URLs only. Git asks for nothing interactively: no prompts and no `file://` or `ext::` transports. Private repositories work through the user's own git setup; Termpolis never reads credentials itself.
2. **Design ahead.** "Design something new": a person describes an app by voice or text, and their default agent drafts a **design world**. Every building is a wireframe and every claim is `proposed`. They refine it by conversation ("add a payments service", "split the API"); the agent replies with a design patch that the world applies on screen. Agents working in terminals can write the same designs through the gateway (`world_propose`).
3. **Watch AI build it.** "Build it" starts the default agent in a new terminal in a chosen empty folder. (Ruling, 2026-11-16: in 2.0 this is the user's default Claude Code profile, because Claude Code is the one agent that takes a first prompt on launch; the dialog says so. The folder must come from the folder dialog, and never be a drive root, the home folder or Termpolis's data folder.) Its task is the design, and it reads the design through `world_read`. That folder's world carries the design as its plan layer. As files appear, the compiler runs and planned buildings **rise and turn solid** when matched (plan versus built, 5.4). New or changed buildings pulse briefly after every recompile, so any agent's work (not only "Build it") is visible as it happens.

A **Lumopolis home** screen lists these choices and recent worlds, and a toolbar switcher moves between them. Approval into multi-agent swarm worktrees stays in 2.x (5.4).

### 5.11 Next: live production view (own design, after 2.0)

David (2026-11-15): the tool should also look into a **live running application, in the cloud or anywhere**, show **where the bottlenecks are**, and help **diagnose errors during production issues**. In his words, this "will bring it to the next level". It is the PDF's Observe mode, and it is planned as the headline of a 2.x release with its own design doc. In outline:

- **The same world, alive:**
  - Connections thicken with request rate and glow red with errors.
  - Buildings heat with latency, so a bottleneck looks like packets piling up.
  - A single slow or failed request replays as one packet walking its path.
  - Clicking a hot building shows latency, errors, the slowest requests and what changed recently (deploys, agent commits).
  - Questions by voice or text ("why is checkout slow since 2pm?") are answered from traces, logs and metrics, with evidence.
  - A diagnosis can become a proposal for agents to build.
- **Platforms (David, 2026-11-15): apps deployed on both Azure and AWS**, as first-class connectors:
  - **Azure:** Application Insights (requests, dependencies, exceptions, traces, application map) and **Log Analytics workspaces** (KQL queries over logs and metrics), plus Azure Monitor metrics.
  - **AWS:** CloudWatch Metrics and CloudWatch Logs (Logs Insights queries), and X-Ray / CloudWatch Application Signals for traces and service maps.
  - **OpenTelemetry:** for anything else, on any cloud or server.

  The service maps both platforms already produce (the App Insights application map and the X-Ray service map) are matched to the world's buildings through `runtimeNames`.
- **Safety:**
  - Access is read-only.
  - Connections are added by the user in Termpolis settings: an Azure sign-in in the app (Entra ID) or an app registration, and an AWS sign-in (IAM Identity Center) or a role the user enters. They're stored in Termpolis's own vault, with the least read-only roles listed in the UI (Monitoring Reader / Log Analytics Reader; CloudWatch and X-Ray read-only). Termpolis never pulls credentials from other tools' caches on the machine (`az` CLI, `~/.aws`; EDR rule).
  - Production data stays local, except the slice sent to the AI for a question, with personal data in logs masked first.

**What 2.0 must do so this slots in:**
- keep a `runtimeNames` mapping from buildings to the service names used in traces, filled from code where it's detectable (OpenTelemetry service names, deployment manifests) and editable by hand;
- reserve a `live` layer in the world document;
- have the renderer drive line width, colour and building heat from data, not hard-coded values;
- use an answer protocol whose evidence kinds can grow (`trace`, `metric`, `log`, `deploy`).

## 6. Decided in brainstorming (David)

- The idea and the framing: a 3D animated world for human understanding of AI-designed and AI-built software; it must convey deep understanding without showing code (2026-11-15).
- Visual: full 3D animation on a 2D screen with depth tricks, exportable to HTML5.
- Engine: David suggested Three.js or Babylon.js. Three.js was recommended and used in both prototypes, and David approved the result.
- The level of detail in the v2 prototype: relationships, technology, why, and what's planned versus built ("i like the latest version where you can click in certain areas and it gives detailed information").
- Scope: works for anything in the app, from something someone wants to build to something already done.
- Conversation in the world by voice or text, about what was built or what is designed, reusing the voice capability the app already has.
- Approach A.
- Released as **Termpolis 2.0**, with Lumopolis as its headline.
- A public interactive demo page on termpolis.com, built from the prototype that shows how Termpolis works.
- Next after 2.0: a live production view of running applications for bottlenecks and diagnosis (5.11), with its own design. It connects to apps on **Azure** (Application Insights, Log Analytics workspaces) and **AWS** (CloudWatch, X-Ray).

## 7. Calls I made (David can override)

- **Order of delivery (section 8):** start with the existing project's world plus questions, because the plan layer needs the built map underneath it.
- A dedicated `termpolis-lumopolis` utility process for the compiler.
- Labelling with the default headless agent's cheapest model (Claude Code's Haiku), cached by content hash, with an off switch.
- The world document lives in per-user data, not committed to the repository. Exports are files the user chooses to share.
- A hidden, read-only one-shot agent run per question, with a carried conversation summary (section 10).
- Spoken answers through OS voices, off by default.
- World tools only through the gateway route, as a trusted built-in provider.
- The demo page is `lumopolis.html`, with Three.js vendored and scripted questions, and it launches with 2.0.

## 8. Delivery order

1. **The world of what exists:** compiler stages 1 to 7, Lumopolis with cards, layers and tours, and the Termpolis repository as the acceptance test (5.3).
2. **Conversation:** text and voice in the world, the answer protocol with world actions, evidence links.
3. **What the agent just did:** snapshots, before/after, generated change tours.
4. **Plan layer:** proposals from conversation and from agents, plan versus built, approval into swarm tasks, build progress, verification.
5. **Export** and the 2D fallback.
6. **Website demo** (5.10). Work on it can run in parallel with phase 1, since it starts from the prototype. It goes live with the 2.0 release.

**2.0 release scope (David):** phases 1 and 2 plus the website demo, plus (David, 2026-11-16) the three ways in from 5.12: any folder or git URL, design ahead, and watching AI build it, with basic plan versus built. Change tours and snapshots (phase 3), swarm approval (part of phase 4) and export (phase 5) ship as 2.x updates.

**Testing (David, 2026-11-16: "test 100%"):** every new Lumopolis module under `src/shared/world/`, `src/main/world/` and the engine's pure modules is held to **100%** lines, functions, branches and statements by per-folder Vitest thresholds. The one Three.js drawing file, which unit tests can't exercise meaningfully, is covered by Playwright e2e instead. The repository-wide gate (97/96/95/96) is unchanged.

## 9. Left to the builder

- Exact grouping and clustering algorithm, and its thresholds.
- Detector implementations and how they are tested.
- How the viewer is structured in React: plain Three.js in a component, or React Three Fiber. The prototype uses plain Three.js.
- Layout algorithm details, provided positions stay stable.
- Answer-protocol wire format and parsing.
- Storage format details and migrations.
- How Three.js is added without running `npm install` on David's laptop.

## 10. Settled after the builder check (my calls)

- **Gateway policy for world tools.** World tools are a **built-in, trusted provider** on the gateway, not an external server, so they skip the "ask" policy. This is safe because:
  - `world_read` is read-only;
  - `world_propose` and `world_annotate` write only to the world document's plan layer and claims, never to code or files in the repository;
  - turning a proposal into work still needs a person's approval in the UI (5.4).

  Agents learn about them from **one line in the project primer** ("this project has a World; use `gateway_call` world_* to read it or draw a plan"), not from new tool descriptions.
- **Conversation sessions.** Phase 2 uses a **fresh, primed, read-only one-shot run per question** through `headlessExec`, with a compact summary of the conversation so far plus the selection's evidence. That works the same for Claude Code, Codex and Gemini CLI. Keeping a session warm (for example `--resume` on Claude) is a later speed and token optimisation, not a 2.0 requirement.
- **Labelling providers.** Labelling uses the **default headless agent's cheapest model** through the same headless path. Termpolis's default headless agent is Claude Code (the same default `agent_exec` uses), so that is Haiku; the labelling code can also run the matching small model on Codex or Gemini if a per-user default-agent setting is added later. With no agent installed, or labelling turned off, the world is unlabelled: names from the code, structure and connections, with no prose.
- **Where "verified" comes from.** The compiler **only reads test results that already exist**: Vitest/Jest JSON or JUnit XML in the repository, test runs found in agent transcripts, and CI results through `gh`, which is on by default and can be turned off in Settings ▸ Lumopolis (it runs only for a project with a GitHub remote, when `gh` is installed). It **never runs tests itself**, which keeps it light and EDR-quiet. A project with no results shows amber ("no test results yet"), never green.
- **A world for an idea with no code yet.** World documents can also be keyed by a named workspace, not only a repository. A plan-only world is a world with an empty built layer. Its scope is in the 2.0 question below.
- **Testing the 3D code.** All logic (layout, data, actions, card content, protocol parsing) lives in plain, tested modules. `createWorldViewer.ts`, the logic around the drawing, is under the 100% engine gate with a stand-in renderer. The drawing layer, `threeRenderer.ts`, is unit-tested too, with only the GPU faked: the tests swap out three's `WebGLRenderer` and the post-processing passes (jsdom has no WebGL context), and use the real scene graph, materials, `Raycaster`, `OrbitControls` and `CSS2DRenderer`. Its pixels are checked by e2e (`e2e/world-visual.spec.ts` screenshots, `e2e/world-engine.spec.ts` interaction). No Lumopolis file is excluded: every one is at 100% lines, functions, branches and statements, and the coverage gate itself is unchanged.

## 11. Answered by David (2026-11-15)

- **2.0 scope:** phases 1 and 2 (the world of existing software, plus voice and text conversation) and the website demo. Phases 3 to 5 ("what the agent just did", the plan layer and plan-only worlds, export) ship as 2.x updates. Until the plan layer ships, `draftProposal` in the answer protocol is not offered in the app; the website demo still shows a scripted wireframe proposal, labelled "coming soon".
- **Demo timing:** the termpolis.com demo goes live with the 2.0 release, not before.

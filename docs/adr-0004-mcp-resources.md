# ADR 0004 — MCP Resources for pinnable component context

- Status: Accepted (design only — implementation deferred per the post-1.1 plan)
- Date: 2026-05-23
- Deciders: maintainer
- Replaces / replaced by: builds on ADR-0002

## Context

ADR-0002 introduced progressive disclosure to shrink per-call output. The default-case lookup dropped from ~2 K tokens to ~300, and drill-downs are targeted enough that the agent fetches only what it needs. That solves the per-call cost problem.

It does not solve the **per-session** cost problem: across a 30-turn coding task on `<sl-button>`, an agent may call `get_component_docs` for that one tag 10+ times — once to discover what's available, again for an attribute, again for an event, again because context was compacted, again because the agent's plan changed. Each call is small, but the aggregate is real, and most of those calls return the same compact view we already returned earlier in the session.

MCP supports a second primitive for exactly this kind of long-lived context: **resources**. A resource is a server-exposed document with a URI; the client can pin it into the conversation, and its content stays available without further tool calls. This is the right primitive for "I'm using this component throughout this task."

A second consideration: a few MCP clients (Claude Code among them) surface a UI for resource pinning that doesn't exist for tools. Exposing components as resources lets users — not just agents — declare "this conversation is about `<sl-button>`," which short-circuits the discovery phase entirely.

## Decision

Expose every loaded component as an MCP resource with a stable URI scheme. The tool surface is untouched; resources are additive.

### URI scheme

```
cem://<package-name>/<tag-name>
```

Examples:

```
cem://@shoelace-style/shoelace/sl-button
cem://@esri/calcite-components/calcite-button
cem://@carbon/web-components/cds-button
```

Package names containing `/` (scoped packages) are not URL-encoded; the URI parser splits on the **last** `/`, treating everything before it as the package name.

### Resource list (`resources/list`)

Enumerates every `<package>/<tag>` known to the registry. Each entry carries metadata only:

```jsonc
{
  "uri": "cem://@shoelace-style/shoelace/sl-button",
  "name": "sl-button",
  "description": "Buttons represent actions...",
  "mimeType": "text/markdown",
}
```

Across the 9 bench libraries (~500 components), the full `resources/list` response is ~150 KB — tractable as a single response, no pagination needed. If component counts grow into the thousands we revisit; for now, simplicity wins.

### Resource content (`resources/read`)

Returns the **compact view** of the named tag — the same markdown `get_component_docs(package, tag)` returns with no `aspect`/`attr`/`event` set. ~300 tokens typical.

**Why compact, not full.** A pinned resource lives in context for the whole session. Pinning the full ~2 K-token view across 5 components would burn 10 K tokens of context per session before the agent has done any work. Compact view is the right size for "what's available on this component" reference data; drill-downs stay where they are (the tool).

### Drill-downs still go through the tool

Resources answer "what's available on this component." The tool answers "give me the type of this one attribute." Clean split. Per-aspect resource URIs (`cem://pkg/tag#events`) were considered and rejected for v1 — they triple the resource surface, complicate the pin-this-component UX, and the use case ("I always want events pinned but not attrs") hasn't surfaced.

### Update notifications

MCP supports `notifications/resources/list_changed` (the catalog changed) and `notifications/resources/updated` (a specific resource's content changed). The initial release sends neither — discovery runs once at server start and stays stable. Adding `chokidar` to watch `node_modules/**/custom-elements.json` and emit updates is a deferred follow-up; agents that pinned a resource still see the version they pinned, which is the right behavior for a coding session that shouldn't shift under the agent's feet mid-task.

### Backwards compatibility

Resources are additive. Existing tool consumers see no change. Clients that don't implement the resources capability simply don't see the new surface. The server's `capabilities` response declares `resources: {}` when implementation lands.

## Method

The compact-as-resource decision came from estimating context cost. A typical coding task touches ~5 components; pinning full views (~2K each = 10K) vs compact views (~300 each = 1.5K) is the difference between dominating the context budget and a rounding error. The drill-down tool still exists for the rare cases where the agent really needs full detail on a pinned component.

The decision to expose every component (not just "recent" or "pinned") came from the realization that we don't know the agent's intent until it pins. A pre-filtered list saves bytes on `resources/list` but costs flexibility — and the full list is already small enough to send unfiltered.

The per-aspect URI rejection was the same single-intent-tool reasoning as ADR-0002's rejection of polymorphic tool modes: one URI = one concept = one pin makes the surface predictable. If pinning the "events of sl-button" turns out to be a real need, add a separate convention later (e.g. tool params) rather than fragmenting the resource catalog.

## Consequences

**Wins.** Tasks that work on a small set of known components can pin them once and never re-fetch. Removes a class of "the agent forgot what `<sl-button>` looks like and re-queried" inefficiencies. Surfaces a user-facing pin mechanism in clients that have one (Claude Code). Reduces per-session tool-call volume in long sessions.

**Costs.** New code surface: `resources/list` handler, `resources/read` handler, URI parser, capabilities declaration update. ~100 LOC. Tests for the URI scheme + content rendering. No changes to existing code paths.

**Risks to watch.** (a) Clients that pin resources may expect updates when the underlying CEM changes; without a watcher, the pinned content goes stale across a dependency upgrade. Mitigation in v1: document that the server reads `node_modules` once at start; restart to pick up changes. Future fix: chokidar watcher emits `notifications/resources/updated`. (b) Component count growth — at 500 components the list response is 150 KB, fine; at 5000 it's 1.5 MB, not fine. Mitigation: paginate via `cursor` parameter (MCP spec supports it) when the package count threshold is hit. (c) Some clients implement `resources/list` but don't surface pinning UX, so the catalog ships but nothing pins — wasted protocol surface. Mitigation: small enough cost that it's worth it even for the subset of clients that do pin.

## What we learned

- **Per-call cost (output shape) and per-session cost (re-query frequency) are different problems with different solutions.** Compact views solve the first; pinnable resources solve the second. Conflating them — e.g. trying to make tools "stateful" so they remember prior calls — would be a worse fit than reaching for the protocol's stateful primitive.
- **MCP primitives encode intent.** "Tool" reads as "an action I can take"; "resource" reads as "a document I can refer to." Choosing the right primitive at the protocol level shapes how agents (and human users) think about the surface. A doc lookup _is_ a document — it should be a resource, not just a tool that returns one.
- **The catalog size question is empirical, not theoretical.** At our current scale (500 components, 150 KB) the simplest answer (one big list) works. Designing pagination upfront would have added complexity for a problem we don't have.

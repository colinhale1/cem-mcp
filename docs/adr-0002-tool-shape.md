# ADR 0002 — Progressive disclosure, cross-package search, and `validate_component_usage`

- Status: Accepted
- Date: 2026-05-23
- Deciders: maintainer
- Replaces / replaced by: —

## Context

ADR-0001 settled how the search engine ranks candidates. This ADR settles how the MCP tools _present_ results and what shape the tool surface takes. The two are independent — even a perfect ranker dumps too much per call if the formatter always returns every field a Custom Elements Manifest declares.

A head-to-head evaluation against nine real component libraries (Shoelace, Calcite, PatternFly, RHDS, Nord, Vivid, UI5, Carbon, CDS) on five realistic agent queries surfaced three concrete problems with the current shape:

1. **Eager output bloats agent context.** A single `get_component_docs("@shoelace-style/shoelace", "sl-button")` returned ~7 KB / ~2 K tokens; `calcite-combobox` returned ~9.4 KB. Most queries only need a subset (events, or one attribute's type) but always pay for the full set.
2. **Cross-package questions are unanswerable.** "Which of my installed libraries has a tree view?" required calling the tool once per package, with no scoring across packages. The natural shape — search with `package` omitted — was used to mean "list packages," which is rarely what the agent actually wants.
3. **Negative results are not honest.** Queries that have no real answer (e.g. "date picker" against Shoelace, which doesn't ship one) returned an 18-row ranked list with confidence-looking scores. An agent could plausibly pick `sl-format-date` (a formatter) as a date picker.

A fourth problem is structural: the existing tool answers "what does X look like?" but cannot answer "is this snippet I'm about to write correct?". The second question is where agents waste the most cycles — they hallucinate prop names and enum values and only find out at runtime.

## Decision

Three coordinated changes, all in service of one principle: **the tool's grammar lives in the schema (cached once at MCP handshake), the output instantiates that grammar without re-teaching it.**

### 1. Progressive disclosure on `get_component_docs`

Default to a compact view. Drill into a specific aspect or a specific named member via additional parameters whose vocabulary is fixed and documented in the tool schema:

```
get_component_docs(package?, query?, aspect?, attr?, event?)

aspect: 'attrs' | 'events' | 'slots' | 'css' | 'methods' | 'examples' | 'all'
attr:   '<attribute-name>'   single attribute detail
event:  '<event-name>'       single event detail
```

The compact view for an exact-tag lookup lists what's available — section names match aspect values 1:1 — with names but no types, defaults, or descriptions. Counts in parentheses are locators, not prose. The agent learns the grammar once from the tool description and can chain drill-downs without re-reading prior output.

```
# sl-button (@shoelace-style/shoelace)
Buttons represent actions...

attrs (22):  variant, size, caret, disabled, loading, ...
events (3):  sl-blur, sl-focus, sl-invalid
slots (4):   default, prefix, suffix, label
methods (4): click, focus, blur, setCustomValidity
css-vars: 23
```

Sections with zero items are omitted entirely. `aspect: 'all'` is the escape hatch for "I really need everything" (today's default behavior). `aspect: 'css'` collapses css-vars + css-parts because they're related and rarely useful separately.

### 2. Cross-package search

Drop the requirement that `package` be present when `query` is set. The behavior matrix becomes:

| `package` | `query`   | result                                                                |
| --------- | --------- | --------------------------------------------------------------------- |
| absent    | absent    | list every discovered package                                         |
| absent    | present   | **search across all packages, return ranked hits grouped by package** |
| present   | absent    | list components in that package                                       |
| present   | `"all"`   | same as above                                                         |
| present   | exact tag | compact docs for that component (drilled by `aspect`/`attr`/`event`)  |
| present   | other     | ranked search within that package                                     |

Cross-package output is capped (5 hits per package by default; total capped at a reasonable number) and uses the same negative-result discipline as single-package search: if no hit clears a confidence floor, return _"no good match for `<query>`"_ with at most two near-miss leads — not a fishing expedition.

### 3. New tool: `validate_component_usage`

A separate tool, not a polymorphic mode of `get_component_docs`. Inputs and outputs are different _kinds_:

|                | `get_component_docs`    | `validate_component_usage` |
| -------------- | ----------------------- | -------------------------- |
| Input          | NL query string         | code snippet (HTML)        |
| Output         | formatted markdown docs | structured error list      |
| Purpose        | discover what exists    | verify what's written      |
| Trigger intent | "what's available?"     | "is this right?"           |

Polymorphic alternatives (a `snippet` field on `get_component_docs`, or a `mode` discriminator) were rejected because LLM tool callers handle one-intent-per-tool better than discriminated unions, and because the tool description has to clearly answer "when do I call this?" — two intents in one description muddies that signal.

Initial scope: HTML-shaped snippets only (`<tag attr="value">`), validating tag existence, attribute existence per tag, and enum-typed attribute values (where `type.text` is a literal union). JSX and Lit-template parsing is future work. The validate tool reuses the registry built by the doc-search tool — no second discovery pass.

## Output formatting rules (binding for all tools)

To make the schema-teaches-grammar principle actually hold, the output layer follows fixed rules:

1. **Section names match the aspect vocabulary, 1:1.** `attrs`/`events`/`slots`/`css`/`methods`/`examples`. Not "Attributes" in output and `attrs` in schema. The agent should not have to translate.
2. **Drill-down inputs are names that appeared in the compact view.** `attr: 'variant'` works because `variant` was printed verbatim. No opaque IDs, no slugs.
3. **No prose hints in output.** No "_Call this tool again with…_" trailers, no "for details on this specific component, pass…" footers. They pollute every response, are redundant once the schema is loaded, and undermine the cacheability of the grammar.
4. **Errors stay in-grammar.** `aspect: 'attributes'` returns _"unknown aspect 'attributes' — did you mean 'attrs'?"_ The error names the closed set the agent should choose from.
5. **Counts everywhere a list is collapsed.** `(22)` is a locator that tells the agent "there is something here to expand" without listing contents. Zero-count sections are omitted entirely.
6. **Cross-tool consistency.** `validate_component_usage` errors reference the same vocabulary: when it reports "unknown attribute 'variants' on `<sl-button>`," the agent already knows to call `get_component_docs(package, 'sl-button', aspect: 'attrs')` to recover. No per-tool dialect.

## Method

The compact view's structure was chosen by walking each query type from the head-to-head evaluation and asking: what is the minimum the agent needs to either answer the user or know what to ask next?

- "What attributes does `sl-button` have?" → needs the attribute _names_; agent can drill into `aspect: 'attrs'` only if it actually wants types/defaults/descriptions.
- "What events does `calcite-combobox` emit?" → needs `aspect: 'events'`.
- "Show me how to use the loading state on sl-button" → would benefit from `aspect: 'examples'` extracted from JSDoc `@example` blocks (future work; the section is in the schema today even though no examples surface until the extractor lands).
- "I need a date picker" → handled by cross-package search, not a per-component view.

The validate tool's MVP scope (HTML, attrs, enum values) was chosen because:

- HTML is what CEMs describe; that's the ground truth.
- Attribute-name validation catches the most common agent mistake (typos like `variants` for `variant`).
- Enum-value validation catches the second-most-common mistake (invented values like `variant="dangerous"` when the literal union is `'... | danger'`). Both are mechanically detectable from `type.text`.

What's deliberately out of scope for MVP: JSX/template literal parsing, validating dynamic values (`variant={someVar}`), validating event handlers, validating slot content, type-checking properties (`.prop=`) vs attributes (`prop=`). All deferred until usage signals say which matter.

## Consequences

**Wins.** Default-case lookup output drops from ~2 K tokens to ~300 tokens (eyeballed against the evaluation queries). The cross-package question becomes one tool call instead of nine. Validation catches a class of agent errors that grep + Read against a JSON manifest can't catch ergonomically — the agent would need to load and parse the manifest, then write its own validator. The MCP server doing it once and exposing the result is exactly where this kind of tool earns its keep.

**Costs.** More tool calls per task in the worst case: an agent that genuinely needs everything pays one compact call + N drill-down calls instead of one eager call. The tradeoff is that this case is much rarer than the "I just need the events" case in practice, and the eager-output path is still available via `aspect: 'all'`.

**Risks to watch.** (a) The compact view's name-only attribute listings are useful only if attribute names are descriptive enough to predict purpose; for libraries with terse names (e.g. `cds-` Carbon) the agent may still need `aspect: 'attrs'`. (b) Cross-package search latency is O(packages × per-package-search); at nine packages this is ~5 ms total in the current bench — fine — but warrants a re-check if package counts grow. (c) The validate tool will be judged on false-positive rate; an aggressive parser that misreads benign JSX or template syntax as HTML and flags a "missing attribute" would be worse than no validator at all. Keep the parser conservative; prefer false negatives over false positives.

## What we learned

- **Default output shape is a product decision, not a formatting detail.** Every call pays the default's price. Compact-by-default is the right baseline because the most common task — "tell me what's here so I can decide what to ask next" — needs almost none of what the schema can produce.
- **Self-describing pagination only works if the grammar lives in the schema.** Inline "tip:" hints in output are a tax paid on every call for the agent's first call's benefit. Move that text to the tool description where it's loaded once.
- **Single-intent tools beat polymorphic ones for LLM callers.** A tool description that says one thing the tool does, with a tight schema, is easier for the agent to route to correctly than a polymorphic tool whose mode depends on which optional field is set.
- **Negative results are part of the contract.** Returning a long ranked list when nothing scored well is dishonest formatting — it implies confidence the ranker doesn't have. A confidence floor with a clear "no good match" is the honest shape.

## Amendment 1 (2026-05-23): examples are sourced from overlays, not CEMs

**Context.** A post-1.1 audit of the 9 bench libraries found **zero** examples in the CEM data — neither in `@example` JSDoc blocks (0 occurrences across 9 libraries) nor in inline ` ``` ` code-fenced descriptions (also 0). The `aspect: 'examples'` slot we shipped in 1.1 returns `(none)` for every real library, which is worse than not shipping the slot at all — the agent's first call costs a tool round-trip to discover the slot is dead.

**Decision.** Keep `aspect: 'examples'` in the schema, but source the data from **per-package overlays** (introduced in [ADR-0005](adr-0005-extensibility.md)) instead of from CEM JSDoc. Specifically:

- The `@example` extractor (`extractExamples` in `src/format.ts`) is removed.
- The overlay loader supplies `elements.<tag>.examples: string[]`.
- Compact view shows `examples (N):` only when N > 0 (zero-count sections are already omitted per the original ADR-0002 rules).
- `aspect: 'examples'` returns `(none)` if no overlay supplies them, same as any other empty section.

**Why not just drop the aspect.** Two reasons. (1) Teams with vendored design systems will supply examples via overlays — the data exists, just not in CEM. Keeping the aspect means they don't have to teach their agents a new vocabulary when they wire up overlays. (2) The cost of keeping a slot that returns `(none)` for unaugmented libraries is zero — the compact view already omits zero-count sections, and `aspect: 'examples'` already returns `(none)` for empty inputs.

**Migration.** None required for existing users — output for unaugmented libraries is identical (no examples section shown). The change is observable only when an overlay is supplied.

# ADR 0001 — Fuzzy search: custom indexer vs `fuzzysort`

- Status: Accepted
- Date: 2026-05-23
- Deciders: maintainer
- Replaces / replaced by: —

## Context

The MCP tool surfaces web components from a Custom Elements Manifest to a coding agent. The agent's queries arrive in many shapes for the same logical thing:

- The exact kebab tag: `calcite-date-picker`
- The bare component name: `date-picker`, `date picker`
- A PascalCase form (a coder's habit): `DatePicker`
- A common-word query: `button`
- An acronym (LLM shorthand): `dp`
- A typo: `alrt`, `chiip`, `tooltp`

The dataset is small (one library publishes ~100 components, large libraries cap around a few hundred), entries are short, and the field has strong structure (kebab-case with a library-wide common prefix like `calcite-`). The agent issues an interactive query per tool call, so per-query latency well under 10ms is invisible; ranking quality is what an LLM actually feels.

We wanted to decide between:

- **A. Custom matcher** — tag-aware, pre-indexed at load time. Generates PascalCase forms, kebab tokens, acronyms (with and without the library prefix), a concatenated "flat" form, and uses Damerau-Levenshtein for capped edit-distance.
- **B. `fuzzysort`** (MIT) — general-purpose, char-in-order matching with word-boundary bonuses. The most direct off-the-shelf comparison: fast, MIT, designed for short strings like file paths and tag names.

Other libraries considered and rejected without bench: `fuse.js` (Apache-2.0, heavier than needed for ~100 short strings), `uFuzzy` (low-level API, similar quality-vs-speed tradeoff to fuzzysort), `MiniSearch` (full-text engine, overkill).

## Method

`bench/compare.ts` runs both matchers against `@esri/calcite-components@5.0.2` (105 components) with a 22-query test set covering: exact tags, single words, phrasal queries, PascalCase (with and without the library prefix), concatenated forms, 2-letter acronyms, drop-vowel typos, drop-letter typos, and insert-letter typos.

For each query we know the expected top-1 tag. We measure:

- **Top-1 hit rate** — does the expected tag come first?
- **Top-3 hit rate** — is it in the top three?
- **Mean rank** — average position of the expected tag (lower is better; 50 if absent)
- **Latency** — median across 200 iterations of running all 22 queries

To keep the comparison apples-to-apples, both matchers search the same surface (tag names only). The substring scoring across description / attributes / events / slots / CSS variables runs downstream of fuzzy search and is shared by both configurations in production, so adding it would just add the same noise to both columns.

## Results

| matcher    | top-1            | top-3              | mean rank | median time (per query) |
| ---------- | ---------------- | ------------------ | --------- | ----------------------- |
| custom     | **95% (21/22)**  | **100% (22/22)**   | **1.05**  | 0.094 ms                |
| fuzzysort  | 86% (19/22)      | 95% (21/22)        | 3.36      | **0.009 ms**            |

Both matchers handle exact tags, single-word queries, phrasal queries, PascalCase, and drop-letter typos cleanly. The differences:

- **Insertion typos** — `chiip` for `calcite-chip`. Fuzzysort cannot match (rank 9999); its algorithm needs the query characters to appear in order in the target, and the extra `i` has no home. The custom matcher catches it via capped Damerau-Levenshtein on the flat form.
- **Vowel-drop typos** — `alrt` for `calcite-alert`. Fuzzysort ranks it third (other `al…` tags out-score it on char-in-order matching). The custom matcher promotes it to first via edit-distance (`alrt` ↔ `alert`, distance 1).
- **2-letter acronyms with collisions** — `cb` matches both `calcite-button` and `calcite-block`. Both matchers tie and fall back to alphabetical, giving `calcite-block` rank 1. Neither approach resolves this without additional context; we accept this miss.

Latency: fuzzysort is ~10× faster, but both are well under 0.1 ms/query on this dataset. At the scale we care about (a coding agent making one query at a time, datasets in the low hundreds), the absolute latency of either matcher is invisible.

## Decision

**Use the custom matcher.** Top-1 accuracy is what an LLM feels — if the obvious answer isn't first, the agent gets a search-result list and pays an extra round trip (or guesses badly). The 9-point top-1 gap (95% vs 86%) and the 100% vs 95% top-3 gap matter; the 0.085 ms latency penalty does not.

We keep `fuzzysort` as a `devDependency` so `npm run bench` continues to work as the spec for this decision. If our dataset grows enough that latency becomes a real concern (>10k components per package, say), this trade flips and we should revisit.

## What we learned

- **Tag-name search has exploitable structure.** Knowing the data is kebab-case with a library-wide common prefix lets us materialize PascalCase, acronym, prefix-stripped, and flat forms once at load time and look matches up directly. This is the "back-engineer from the component list" insight: a generic matcher can't take advantage of structure it doesn't know about.
- **Char-in-order matching is fundamentally weak on insertion typos.** This is structural to the algorithm, not a tuning issue. Edit-distance — even capped — is the right tool when the query may have extra characters.
- **Per-query latency is not the constraint here.** Under 0.1 ms, ranking quality dominates user experience. We optimized for the wrong axis first; the bench revealed which axis actually moves the needle.
- **2-letter acronyms are intrinsically ambiguous** when multiple components share the same initials. No purely lexical matcher resolves this; if it matters later, we'd need usage signals (e.g. prefer the more central or more commonly imported component).

## Addendum: cross-library validation

After the initial decision (calcite-only, 22 hand-curated cases) we ran a broader bench across 8 component libraries with auto-generated query sets derived from each library's tag list. See `bench/multi.ts`. For every tag whose prefix-stripped form is unique within its library, we generate six queries: the exact tag, the prefix-stripped tag, PascalCase, concatenated flat, drop-letter typo, insert-letter typo.

| library                       | components | prefix    | cases | custom top-1     | fuzzysort top-1  |
| ----------------------------- | ---------- | --------- | ----- | ---------------- | ---------------- |
| @cds/core                     | 68         | `cds`     | 394   | **100%**         | 88%              |
| @esri/calcite-components      | 105        | `calcite` | 606   | **100%**         | 92%              |
| @nordhealth/components        | 55         | `nord`    | 322   | **100%**         | 88%              |
| @patternfly/elements          | 54         | `pf`      | 318   | **100%**         | 84%              |
| @rhds/elements                | 81         | `rh`      | 464   | **100%**         | 85%              |
| @shoelace-style/shoelace      | 58         | `sl`      | 336   | **100%**         | 86%              |
| @ui5/webcomponents            | 105        | `ui5`     | 604   | **100%**         | 84%              |
| **OVERALL**                   | **526**    |           | 3044  | **100% (3044)**  | **87% (2646)**   |

By query kind across all libraries:

| kind        | cases | custom top-1 | fuzzysort top-1 |
| ----------- | ----- | ------------ | --------------- |
| exact       | 526   | 100%         | 100%            |
| short       | 526   | 100%         | 100%            |
| pascal      | 526   | 100%         | 100%            |
| flat        | 526   | 100%         | 100%            |
| typo-drop   | 470   | 100%         | 99%             |
| typo-ins    | 470   | **100%**     | **17%**         |

### What the cross-library bench surfaced

1. **A bug in the edit-distance function.** Our initial Damerau-Levenshtein included a transposition step that read `prev[j-2]` — but with a two-row rolling buffer, `prev` is row `i-1`, while a correct Damerau extension needs row `i-2`. On strings with repeated characters (e.g. `v5progressstepper`), the stale value pulled the answer artificially low — sometimes returning distance 0 for clearly different strings, causing the matcher to silently produce no hits at all. The fix was to drop the transposition step entirely and stick to plain Levenshtein: insertion / deletion / substitution typos are the common cases anyway, and a buggy Damerau is much worse than no Damerau. After the fix, every typo-drop and typo-ins case across all libraries lands at top-1. The original 22-case calcite bench did not exhibit the bug because none of its typo queries hit the repeated-character path.

2. **`tagName` cannot be trusted on its own.** `@vonage/vivid@5.19.0` ships declarations where `tagName` is the *symbol of a constant* holding the real tag (e.g. `VC_HEX_PICKER_TAG`) because the build tool couldn't resolve the reference. We now filter to declarations whose `tagName` matches the HTML custom-element grammar (`[a-z][a-z0-9]*(-[a-z0-9]+)+`). The matcher only sees real tags; broken authoring shows up as a 0-component package rather than as garbage in the index.

3. **A filename is not a schema.** `@carbon/web-components` ships a VS Code HTML custom-data file at `custom-elements.json` — same filename, completely different schema (`{ version, tags }` instead of `{ schemaVersion, modules }`). Discovery now opens each candidate and checks for the CEM 2.x `modules` array before declaring victory.

4. **Some packages ship neither a CEM nor a useful equivalent.** `@material/web` has no `customElements` field and no fallback manifest. `@microsoft/fast-foundation` ships a schema 1.0 manifest with framework primitives but no `tagName` on any declaration (their component package was deprecated separately). Discovery silently skips both. This is the right outcome — we surface only packages that can actually answer a query.

5. **The latency picture stayed the same.** Both matchers remain well under 0.1 ms/query at this dataset scale. The 10× factor between them is real but invisible.

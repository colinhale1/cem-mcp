# Changelog

All notable changes to `cem-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-05-23

Phase 1 of the post-1.1 roadmap: extends `validate_component_usage` to cover
properties, event handlers, and per-package deprecations. Adds the
declarative extensibility scaffolding (overlays + rule registry + config v2)
that everything else in the roadmap builds on. See ADRs 0003, 0004, 0005,
and the ADR-0002 amendment.

### Added

- **Overlays.** Per-package JSON file referenced from `cem.config.json` adds
  `examples`, `usage`, and `deprecated.{attrs,events,properties}` to any
  component. Strict Zod schema; additive only — cannot rename/remove/retype
  CEM-sourced fields. See ADR-0005.
- **Rule registry.** `validate_component_usage` is now a thin driver over a
  named-rule registry (`BUILTIN_RULES`). Individual rules can be disabled
  via `cem.config.json` → `validate.rules.disable: ["invalid-value", ...]`.
- **`unknown-property` rule.** Flags `.foo=` bindings whose name isn't a
  public field on the tag. Closes the ~500-prop-per-library gap from the
  audit. Includes camelCase suggestion for kebab-cased property bindings
  (`.complex-object` → `.complexObject`).
- **`unknown-event` rule.** Flags `@foo=` handlers not declared on the
  component. Strips Vue/Lit modifiers (`@click.stop` → checks `click`).
  Conservative native-DOM-event allowlist passes through `@click`,
  `@keydown`, etc. without flagging.
- **`deprecated-field` rule.** Reads `decl.overlay.deprecated.*` and flags
  any deprecated attr/event/property usage with the overlay-supplied
  replacement hint.
- **Cross-prefix hint** inside `unknown-attr` and `unknown-property`. When
  the agent uses the wrong form for a known field, the message points at
  the right form: `<calcite-combobox>` has no attribute `filteredItems`,
  but it does have a property — try `.filteredItems=${…}`.
- **Per-package config v2.** `cem.config.json` → `packages.<name>.{ path, overlay }`.
  Backwards-compatible — existing top-level `paths` and
  `packages.include/exclude` keep working.
- **MCP resources design (ADR-0004).** Spec-only — implementation deferred.

### Changed

- `aspect: 'examples'` now sources from `decl.overlay.examples` rather than
  `@example` JSDoc extraction. The audit found zero examples in `@example`
  blocks across the 9 bench libraries. Compact view shows `examples (N)`
  only when an overlay supplies them; otherwise the section is omitted.
  See ADR-0002 amendment.
- Compact view now shows a `Usage:` line when overlay supplies it.
- `aspect: 'all'` / full view picks up a new `## usage` section when
  overlay supplies it.
- Parser preserves case on `.foo=` and `@foo=` bindings (JS identifiers
  and DOM event names are case-sensitive; HTML attribute names remain
  lowercased per spec).

### Tests

117 → 145 (+28). All 117 from 1.1 pass unchanged, proving the
rule-registry refactor is behavior-preserving.

## [1.1.0] - 2026-05-23

Tool-surface redesign for context hygiene. See [ADR-0002](docs/adr-0002-tool-shape.md).

### Added
- Progressive disclosure on `get_component_docs`: compact view by default with
  named-only sections + counts; `aspect: 'attrs' | 'events' | 'slots' | 'css' | 'methods' | 'examples' | 'all'`
  to drill into one section; `attr: '<name>'` / `event: '<name>'` for single-member detail.
- Cross-package search when `package` is omitted but `query` is set — ranked
  hits grouped by package, with a confidence floor and an "honest negative"
  output when nothing scores well.
- `validate_component_usage(snippet, package?)`: HTML snippet linter that flags
  unknown custom elements, unknown attributes per tag, and enum-typed values
  outside the declared union. Suggestions via capped edit-distance.

### Changed
- Section names in element output match the aspect vocabulary (`attrs`/`events`/`slots`/`css`/`methods`/`examples`).
- Prose hints (`_Call this tool again..._`) removed from output. The tool
  grammar lives in the schema instead, so the agent loads it once at MCP
  handshake and can target drill-downs without re-reading prior output.
- Default response shape for an exact-tag lookup is now ~300 tokens (compact),
  not the previous ~2 K-token full element view. `aspect: 'all'` reproduces
  the old eager output.

## [1.0.0] - 2026-05-23

First public release. Distillation of the prior 0.x work into a publishable
package.

### Added
- npm metadata: license (MIT), repository, bugs, homepage, author, keywords.
- `LICENSE` (MIT) and `CHANGELOG.md`.
- `--help` and `--version` flags on the CLI.
- TypeScript `.d.ts` declarations emitted and exposed via `exports`, so
  `CemRegistry`, `CemAdapter`, etc. are usable as a library.
- `scripts/pack-check.mjs` and `prepublishOnly` hook so npm publish always
  ships a green, complete tarball.
- `npm publish --provenance` enabled by default via `publishConfig`.
- GitHub Actions CI matrix on Node 18 / 20 / 22, Linux + macOS + Windows.
- `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue templates.
- `examples/` directory with copy-paste MCP client configs for Claude Code,
  Claude Desktop, Cursor, Windsurf, VS Code, Zed, Continue, and Cline.

## [0.5.0] - pre-release

### Added
- Stemming applied at index time and query time
  (`loading↔load`, `expandable↔expand`).
- Token-to-tag boost: any query token (original or synonym-expanded) that
  names a kebab token of a component lifts that component, fixing cases
  where the target component's description is empty.
- Attribute-anchored scoring channel: when the query head names an attribute
  shared by ≥2 components, score by attribute presence + value coverage.
  Survives single-character value tokens that the regular tokenizer drops.

### Changed
- BM25 is suppressed when attribute-anchored fires for a component, so
  category queries return clean ties instead of being broken by tiny BM25
  variance.

### Bench (44 hand-curated real-world cases)
- Paraphrastic top-1: 58% → 92%.
- Attribute-anchored top-1: 0% → 100%.
- Overall top-1: 86% → 98%. Top-3: 100%.

## [0.4.0] - pre-release

### Added
- BM25 text index over per-component description / attribute / event / slot
  / CSS metadata.
- Bidirectional UI-domain synonym map (`src/synonyms.json`, ~40 clusters)
  expandable via `cem.config.json#synonyms`.
- Tokenizer with stopwords and camelCase splitting.

### Bench
- Paraphrastic top-1: 50% → 58%.

## [0.3.0] - pre-release

### Added
- Schema adapter interface (`src/adapters/`). Built-in adapters: `cem2`
  (standard CEM 2.x) and `carbon-html-data` (VS Code HTML custom-data).
- `cem.config.json` with `packages` allow/deny list, manual `paths`, and
  adapter `disable`. Strict zod schema.
- "Did you mean?" suggester for unknown package requests.
- Real test runner (`node:test`) replacing the hand-rolled smoke script.
  50 → 70 → 82 tests across the 0.3 → 0.5 series.
- Honest paraphrastic real-world bench (`bench/real-world.ts`).

## [0.2.0] - pre-release

### Changed
- **Architectural rewrite**: server now points at a project root
  (`--project` / `CEM_PROJECT`) and discovers every package in
  `node_modules` that ships a Custom Elements Manifest. Single tool
  `get_component_docs(package?, query?)` with smart dispatch.

### Added
- Custom fuzzy matcher (`src/fuzzy.ts`) tuned for kebab-case tag names.
  Pre-indexed PascalCase, prefix-stripped, acronym, and flat forms; capped
  Levenshtein for typo tolerance.
- Cross-library bench harness (`bench/multi.ts`) covering Calcite,
  Shoelace, Patternfly, RHDS, Nord, Vivid, UI5, Carbon (via adapter),
  `@cds/core`.
- Multi-query support: `query` accepts string or string[].

### Fixed
- Damerau-transposition step in `editDistance` read stale rolling-buffer
  values, returning distance 0 for some clearly different strings.
  Replaced with plain Levenshtein.
- Discovery now validates each candidate file is a real CEM 2.x manifest
  (has a `modules` array). Stops misidentifying Carbon's VS Code HTML
  custom-data file as a CEM.
- `tagName` is now validated against the HTML custom-element grammar, so
  broken authoring like Vonage's unresolved `VC_HEX_PICKER_TAG` constants
  no longer leaks into search results.

## [0.1.0] - pre-release

Initial prototype. Single CEM file passed via `--cem`. Substring search over
the manifest. No package discovery, no adapters, no config.

[1.0.0]: https://github.com/colinhale1/cem-mcp/releases/tag/v1.0.0

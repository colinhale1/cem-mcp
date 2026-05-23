# Changelog

All notable changes to `cem-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

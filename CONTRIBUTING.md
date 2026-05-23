# Contributing to cem-mcp

Thanks for considering a contribution. This document covers the basics; for
design background see [`docs/adr-0001-fuzzy-search.md`](docs/adr-0001-fuzzy-search.md).

## Quick start

```bash
git clone https://github.com/colinhale1/cem-mcp.git
cd cem-mcp
npm install           # `prepare` script installs husky pre-commit hooks
npm run fetch-libs   # populate test/fixtures/project with 8+ component libraries (~30s)
npm test             # 82 tests across adapters, discovery, fuzzy, BM25, config, integration
npm run build        # tsc + chmod +x dist/index.js
```

## Pre-commit hooks

`npm install` wires up a husky pre-commit hook that runs:

1. **lint-staged** — `eslint --fix` and `prettier --write` against only the
   files you actually changed (fast).
2. **`npm test`** — the full 82-test suite (~1.5 s).

If you really need to bypass it (WIP commits, fixing a pre-commit failure
in a follow-up), use `git commit --no-verify`. CI re-runs everything so
nothing slips through to `main`.

Run the server against your own project:

```bash
npm run dev -- --project /path/to/some/project
```

## Project layout

```
src/
  adapters/         schema adapters (cem2, carbon-html-data) — extend here for new schemas
  bm25.ts           text index
  cem.ts            registry + search orchestration
  config.ts         cem.config.json loader (zod-validated)
  discovery.ts      node_modules walker
  format.ts         markdown formatters for MCP tool output
  fuzzy.ts          tag-name fuzzy matcher
  index.ts          MCP server entry / stdio transport / CLI
  suggest.ts        did-you-mean for unknown package names
  synonyms.json     starter UI-domain synonym clusters
  synonyms.ts       synonym map builder + query expansion
  text.ts           tokenizer + stemmer
test/               node:test suites
bench/              empirical benches (custom vs fuzzysort, multi-library, real-world)
scripts/            fixture fetchers, pack-check
docs/               architecture decision records
examples/           MCP client config snippets
```

## Adding support for a new component schema

`@carbon/web-components` and `@cds/core` ship a VS Code HTML custom-data file
at `custom-elements.json` — same filename as a real CEM, different schema.
The adapter system handles cases like this. To add a new schema:

1. Create `src/adapters/<your-adapter>.ts` exporting a `CemAdapter`.
   Interface in `src/adapters/types.ts`.
2. Add it to the `builtinAdapters` array in `src/adapters/index.ts`. Order
   matters — the first adapter whose `matches()` returns true wins.
3. Add a test case in `test/adapters.test.ts`.

The `matches(parsed)` function is a cheap shape check on already-parsed
JSON; it must not throw. `load(parsed, sourcePath)` converts to the
internal CEM 2.x shape (`{ schemaVersion, modules: [...] }`); throwing is
fine here — it surfaces to the user as a discovery error for that one
package, not a global crash.

## Extending the synonym map

The starter map in `src/synonyms.json` covers ~40 UI-domain clusters. To
add new pairs without editing the package itself, users can extend via
`cem.config.json#synonyms.extend`. To add to the built-in map (for cases
that are universally useful), edit `src/synonyms.json` and add a test
case in `test/synonyms.test.ts` or, ideally, add a real-world bench case
in `bench/real-world.ts` so the value is measurable.

Pairs are declared one-directionally in the JSON and made bidirectional at
build time. No transitive closure is computed — that runs away on dense
clusters and amplifies noisy edges.

## Tests

```bash
npm test               # all node:test suites
npm run bench          # custom matcher vs fuzzysort, hand-curated calcite set
npm run bench:multi    # auto-generated cross-library bench (3000+ cases)
npm run bench:realworld # hand-curated paraphrastic + attribute-anchored bench
```

The integration suite (`test/integration.test.ts`) requires `npm run fetch-libs`
to have populated `test/fixtures/project`. Other suites are self-contained.

## Commit / PR style

- One logical change per PR.
- Tests for new behavior. Bench cases for fuzzy-quality changes (so the
  improvement is measurable, not just claimed).
- Honest commit messages — what changed, why, and (when relevant) what
  bench numbers moved.

## Releases

The maintainer cuts releases with `npm version <patch|minor|major>` and
publishes via `npm publish` (which runs `prepublishOnly`: tests, build,
and `pack:check`). The CI workflow publishes with provenance attestation
when a `v*` tag is pushed.

## Code of conduct

Be respectful. Disagreements about technical direction are welcome and
expected; personal attacks are not.

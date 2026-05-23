# cem-mcp

An MCP server that delivers **repo-accurate web component documentation** by reading the [Custom Elements Manifests](https://github.com/webcomponents/custom-elements-manifest) shipped by packages in your project's `node_modules`. One tool, package-aware, smart dispatch: list packages, list components, look one up, or fuzzy-search across many.

## Why

Web component libraries publish a `custom-elements.json` that describes their public API — attributes, properties, methods, events, slots, CSS custom properties, and CSS shadow parts. This server hands that source-of-truth to an LLM via MCP, so coding agents stop hallucinating prop names. Because discovery is `node_modules`-based, it works for any library the project actually depends on.

## Install & build

```bash
npm install
npm run build
```

## Run

Point the server at a project root (the directory containing `node_modules`):

```bash
CEM_PROJECT=/path/to/project node dist/index.js
# or
node dist/index.js --project /path/to/project --config /path/to/cem.config.json
```

Dev mode (no build step):

```bash
npm run dev -- --project /path/to/project
```

### Wire it into Claude Code

```json
{
  "mcpServers": {
    "cem": {
      "command": "node",
      "args": ["/abs/path/to/cem-mcp/dist/index.js"],
      "env": { "CEM_PROJECT": "/abs/path/to/your/project" }
    }
  }
}
```

## The tool

One tool, `get_component_docs(package?, query?)`. Every parameter is optional; dispatch covers four cases:

| `package`       | `query`                                                   | Result                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(omitted)_     | _(any)_                                                   | List every package the server discovered.                                                                                                                                                               |
| set             | _(omitted)_ or `"all"`                                    | List every component in that package.                                                                                                                                                                   |
| set             | exact tag name, e.g. `"sl-button"` (case-insensitive)     | Full docs: attributes, properties, methods, events, slots, CSS vars, CSS parts.                                                                                                                         |
| set             | any other term, e.g. `"DatePicker"`, `"alrt"`, `"dp"`     | Ranked fuzzy search. A clear-winner hit returns full docs directly; otherwise returns a ranked list.                                                                                                    |
| set             | array of strings                                          | Multi-query — each item is dispatched independently within the chosen package and concatenated with section markers, so an agent can ask for `["sl-button", "alert", "DatePicker"]` in one call.        |

If the agent asks for a package the server doesn't know, the error includes a **Did you mean?** suggestion based on a substring + capped-Levenshtein match over the known package names.

## Discovery and adapters

Discovery scans `node_modules` (top-level and `@scoped/*`) at the project root, opens each `package.json`, and registers packages that ship a Custom Elements Manifest. Each candidate file is run through an **adapter chain** — the first adapter that recognizes the file's shape wins. Built-in adapters:

| adapter             | shape                                                                      | covers                                                            |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `cem2`              | Standard CEM 2.x (`{ schemaVersion, modules: [...] }`)                     | Calcite, Shoelace, Patternfly, RHDS, Nord, UI5, Vivid, Lit libs   |
| `carbon-html-data`  | VS Code HTML custom-data (`{ version, tags: [...] }`)                      | Carbon (`@carbon/web-components`, `@cds/core`)                    |

Fallback paths checked when `customElements` isn't declared in `package.json`: `custom-elements.json`, `dist/custom-elements.json`, `dist/docs/custom-elements.json`, `dist/docs/api.json`.

### Adding a new adapter

1. Create `src/adapters/<name>.ts` exporting a `CemAdapter` (`matches(parsed)` + `load(parsed, sourcePath)`).
2. Register it in `src/adapters/index.ts`.
3. Add a test case in `test/adapters.test.ts`.

The interface is in `src/adapters/types.ts`. Discovery is schema-agnostic from there on — your adapter converts the source JSON into our internal `CustomElementsManifest` shape and the rest of the pipeline (indexing, fuzzy search, formatting) handles it uniformly.

## Configuration

Drop a `cem.config.json` in the project root (or pass `--config <path>`):

```jsonc
{
  // Allow-list / deny-list applied after discovery.
  "packages": {
    "include": ["@esri/calcite-components", "@shoelace-style/shoelace"],
    "exclude": ["@some/legacy-lib"]
  },
  // Manual package -> manifest path. Useful for CEMs outside node_modules
  // (vendored builds, monorepo siblings). Paths resolve relative to this file.
  "paths": {
    "@my/elements": "./vendor/my-elements/custom-elements.json"
  },
  // Skip specific built-in adapters by name.
  "adapters": {
    "disable": ["carbon-html-data"]
  },
  // Add to or replace the built-in synonym map used by paraphrastic search.
  // Pairs are bidirectional (declaring "toast": ["alert"] also makes "alert"
  // → "toast"). No transitive closure is computed.
  "synonyms": {
    "extend": { "snackbar": ["alert", "toast"] },
    "disable": false
  }
}
```

All fields are optional; the schema is `strict` (unknown fields throw at startup so typos surface immediately).

## Fuzzy search

Four scoring channels combine per query, all built once at load time:

- **Tag fuzzy index** (`src/fuzzy.ts`) — tuned for kebab-case tag names with a library-wide common prefix. Matches across exact tag, prefix-stripped form, PascalCase, concatenated flat, acronym, substring, and capped Levenshtein edit-distance. Strong on anchored queries (`"button"`, `"DatePicker"`, `"alrt"`, `"dp"`).
- **BM25 text index** (`src/bm25.ts`) — Okapi BM25 over the per-component bag of words from description, summary, attribute names + descriptions, slot descriptions, event names + descriptions, CSS var / part names + descriptions, and the tag itself. Tokenizer strips stopwords, splits camelCase boundaries, and applies a light suffix stemmer (`loading → load`, `expandable → expand`, `buttons → button`). Queries are expanded through a bidirectional synonym map (`src/synonyms.json`, ~40 UI-domain clusters like `toast ↔ alert`, `spinner ↔ loader`) before scoring. Strong on paraphrastic queries.
- **Token-to-tag boost** — when any query token, original or synonym-expanded, exactly names a kebab token in a component's tag, that component gets a fixed bonus (synonyms at 0.6 weight). Rescues cases like `expandable → accordion → calcite-accordion` when the component's description is empty.
- **Attribute-anchored channel** — when the head token names an attribute shared by ≥2 components, treat the query as a category lookup. Score by attribute presence + value coverage; bypass BM25 (which would just add noise to a tie). Handles `"scale s m l"` correctly by surviving single-character value tokens that the regular tokenizer drops.

See [`docs/adr-0001-fuzzy-search.md`](docs/adr-0001-fuzzy-search.md) for benchmarks: **100% top-1 anchored, 92% top-1 paraphrastic, 100% top-1 attribute-anchored, 98% overall on the hand-curated 44-case real-world set. Top-3: 100%.**

## Scripts

```bash
npm test               # node:test runner — 50 tests across adapters, discovery, fuzzy, config, suggester, integration
npm run bench          # custom vs fuzzysort, 22-case hand-curated Calcite set
npm run bench:multi    # auto-generated cross-library bench (~3000 cases)
npm run bench:realworld # hand-curated paraphrastic bench across 6 libraries
npm run fetch-calcite  # populate test/fixtures/project with just Calcite 5
npm run fetch-libs     # populate test/fixtures/project with 10 libraries
```

## Known limitations

- **Paraphrastic queries** are at 92% top-1 / 100% top-3 on the hand-curated real-world bench. The single remaining miss (`expandable section → calcite-block-section` instead of `calcite-accordion-item`) is defensible — `block-section` literally contains "section". Extending `synonyms.extend` in config closes specific gaps; the path beyond 92% would need either substantial synonym curation or a small embedding model and isn't built.
- **2-letter acronyms** with multiple plausible expansions (e.g. `cb` for `calcite-button` vs `calcite-block`) are inherently ambiguous and tied on score. We fall back to alphabetical; this is sometimes wrong.
- **No support yet** for components declared only through `module.exports[]` `custom-element-definition` entries (some Lit/FAST patterns). None of the 8 working libraries in the bench use this pattern.
- **No live reload.** Adding/upgrading a package requires restarting the server.

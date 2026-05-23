# cem-mcp

An MCP server that delivers **repo-accurate web component documentation** by reading the [Custom Elements Manifests](https://github.com/webcomponents/custom-elements-manifest) shipped by packages in your project's `node_modules`. One tool, package-aware, smart dispatch: list packages, list components, look one up, or fuzzy-search across many.

## Why

Web component libraries publish a `custom-elements.json` that exactly describes their public API — attributes, properties, methods, events, slots, CSS custom properties, and CSS shadow parts. This server hands that source-of-truth to an LLM via MCP, so coding agents stop hallucinating prop names. Because discovery is `node_modules`-based, it works for any library the project actually depends on.

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
node dist/index.js --project /path/to/project
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

One tool, `get_component_docs(package?, query?)`. Every parameter is optional; the dispatch covers four cases:

| `package`       | `query`                                                   | Result                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(omitted)_     | _(any)_                                                   | List every package the server discovered.                                                                                                                                                               |
| set             | _(omitted)_ or `"all"`                                    | List every component in that package.                                                                                                                                                                   |
| set             | exact tag name, e.g. `"sl-button"` (case-insensitive)     | Full docs: attributes, properties, methods, events, slots, CSS vars, CSS parts.                                                                                                                         |
| set             | any other term, e.g. `"DatePicker"`, `"alrt"`, `"dp"`     | Ranked fuzzy search. A clear-winner hit (high score and decisively ahead of the runner-up) returns full docs directly; otherwise returns a ranked list.                                                 |
| set             | array of strings                                          | Multi-query — each item is dispatched independently within the chosen package and concatenated with section markers, so an agent can ask for `["sl-button", "alert", "DatePicker"]` in one call.        |

## Discovery

Discovery scans `node_modules` (top-level and `@scoped/*`) at the project root, opens each `package.json`, and registers packages that declare a `customElements` field. As a fallback we also check `custom-elements.json`, `dist/custom-elements.json`, `dist/docs/custom-elements.json`, and Stencil's `dist/docs/api.json`. Each candidate is then validated to be a CEM 2.x manifest (has a `modules` array) — VS Code HTML custom-data files at the same filename are skipped automatically.

## Fuzzy search

Pre-indexed at load time, tuned for kebab-case tag names with a library-wide common prefix. Matches across exact tag, prefix-stripped form, PascalCase, concatenated flat, acronym, substring, and capped Levenshtein edit-distance. See [`docs/adr-0001-fuzzy-search.md`](docs/adr-0001-fuzzy-search.md) for the head-to-head against `fuzzysort` (3044 cases across 8 libraries; 100% vs 87% top-1).

## Scripts

```bash
npm run smoke         # in-process dispatch tests against the Calcite fixture
npm run bench         # custom vs fuzzysort, hand-curated 22-case Calcite set
npm run bench:multi   # same head-to-head across 7+ component libraries
npm run fetch-calcite # populate test/fixtures/project with just Calcite 5
npm run fetch-libs    # populate test/fixtures/project with 8+ libraries
```

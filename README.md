# cem-mcp

An MCP server that delivers **repo-accurate web component documentation** by reading a [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest) (`custom-elements.json`). One tool, smart dispatch: list everything, fetch full docs for a tag, or fuzzy-search.

## Why

Web component libraries publish a `custom-elements.json` that exactly describes their public API — attributes, properties, methods, events, slots, CSS custom properties, and CSS shadow parts. This server hands that source-of-truth to an LLM via MCP, so coding agents stop hallucinating prop names.

## Install & build

```bash
npm install
npm run build
```

## Run

Point the server at any `custom-elements.json`:

```bash
CEM_PATH=./path/to/custom-elements.json node dist/index.js
# or
node dist/index.js --cem ./path/to/custom-elements.json
```

Dev mode (no build step):

```bash
npm run dev -- --cem ./path/to/custom-elements.json
```

### Wire it into Claude Code

```json
{
  "mcpServers": {
    "cem": {
      "command": "node",
      "args": ["/absolute/path/to/cem-mcp/dist/index.js"],
      "env": { "CEM_PATH": "/absolute/path/to/your/custom-elements.json" }
    }
  }
}
```

## The tool

A single tool, `get_component_docs(query: string)`:

| `query` value | Result |
| --- | --- |
| `"all"` | Markdown list of every component with a one-line summary. |
| Exact tag name, e.g. `"calcite-button"` (case-insensitive) | Full docs: attributes, properties, methods, events, slots, CSS vars, CSS parts. |
| Any other term | Ranked fuzzy search across tag names, descriptions, attributes, events, slots, CSS vars. A single match returns full docs directly. |

## Try it with Calcite 5

```bash
npm run fetch-calcite          # downloads @esri/calcite-components@5.0.2 CEM into test/fixtures
npm run smoke                  # runs the dispatch logic against the fixture
npm run dev -- --cem test/fixtures/calcite.custom-elements.json
```

# cem-mcp

[![npm](https://img.shields.io/npm/v/cem-mcp.svg)](https://www.npmjs.com/package/cem-mcp)
[![CI](https://github.com/colinhale1/cem-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/colinhale1/cem-mcp/actions/workflows/ci.yml)
[![Node ≥ 18](https://img.shields.io/node/v/cem-mcp)](https://nodejs.org)
[![MIT](https://img.shields.io/npm/l/cem-mcp.svg)](LICENSE)

**Stop your AI assistant from hallucinating web-component props.** `cem-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that hands a coding agent the _actual_ documentation of the web components your project depends on — attributes, properties, methods, events, slots, CSS vars, and CSS parts — by reading the [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest) shipped inside each library in `node_modules`.

No description-scraping, no out-of-date docs, no made-up prop names. If the library publishes a CEM, the agent gets the truth.

---

## 30-second tour

```bash
npm i -g cem-mcp
```

Add to your MCP client config (one of [Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Zed, Continue, Cline](#wire-it-into-your-agent) — see `examples/` for copy-paste configs):

```jsonc
{
  "mcpServers": {
    "cem": {
      "command": "cem-mcp",
      "env": { "CEM_PROJECT": "/abs/path/to/your/project" },
    },
  },
}
```

Now the agent has `get_component_docs` (look up) and `validate_component_usage` (check a snippet) tools that resolve natural-language questions against the real CEMs:

- `"button"` → full docs for `calcite-button` / `sl-button` / etc.
- `"DatePicker"` → `calcite-date-picker` (handles PascalCase, kebab, acronyms, typos)
- `"show a temporary toast"` → `calcite-alert` (paraphrastic, via synonym map)
- `"scale s m l"` → ranked list of every component with that attribute pattern

---

## Wire it into your agent

| Client                                         | Config file                                                                                                                         | Snippet                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| [Claude Code](examples/claude-code.json)       | `~/.claude.json` or `claude mcp add cem -- npx -y cem-mcp`                                                                          | `mcpServers`                        |
| [Claude Desktop](examples/claude-desktop.json) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) <br/> `%APPDATA%\Claude\claude_desktop_config.json` (Win) | `mcpServers`                        |
| [Cursor](examples/cursor.json)                 | `~/.cursor/mcp.json` or `.cursor/mcp.json`                                                                                          | `mcpServers`                        |
| [Windsurf](examples/windsurf.json)             | `~/.codeium/windsurf/mcp_config.json`                                                                                               | `mcpServers`                        |
| [VS Code](examples/vscode.json)                | `.vscode/mcp.json`                                                                                                                  | `servers` _(different key)_         |
| [Zed](examples/zed.json)                       | `~/.config/zed/settings.json`                                                                                                       | `context_servers` _(different key)_ |
| [Continue](examples/continue.yaml)             | `~/.continue/config.yaml`                                                                                                           | `mcpServers` _(YAML)_               |
| [Cline](examples/cline.json)                   | Cline MCP settings                                                                                                                  | `mcpServers`                        |

All examples are in [`examples/`](examples/) with the literal JSON ready to copy. The README there has client-specific notes.

---

## What it does (in detail)

Two MCP tools.

### `get_component_docs(package?, query?, aspect?, attr?, event?)`

Progressive disclosure — compact view by default, drill in for detail. See [ADR-0002](docs/adr-0002-tool-shape.md) for the design.

| `package` | `query`              | Result                                                                          |
| --------- | -------------------- | ------------------------------------------------------------------------------- |
| _omitted_ | _omitted_            | List every discovered package                                                   |
| _omitted_ | set                  | **Cross-package search** — ranked hits grouped by package                       |
| set       | _omitted_ or `"all"` | List every component in that package                                            |
| set       | exact tag            | Compact docs (section names + counts; drill in for detail)                      |
| set       | any term             | Ranked search — fuzzy + BM25 + synonym-aware. Clear-winner promotes to compact. |
| set       | `string[]`           | Multi-query — each item dispatched independently, results joined                |

Drill-downs (require `package` + exact tag in `query`):

- `aspect: 'attrs' | 'events' | 'slots' | 'css' | 'methods' | 'examples' | 'all'` — expand one section.
- `attr: '<name>'` — full detail for one attribute (type, default, description).
- `event: '<name>'` — full detail for one event.

Section names in compact output match `aspect` values 1:1, so the agent can target drill-downs without re-reading prior output.

### `validate_component_usage(snippet, package?)`

Lint an HTML snippet against the loaded CEMs. Catches:

- Unknown custom elements (with did-you-mean across same-prefix tags).
- Unknown attributes (`foo="x"`) per tag.
- Unknown property bindings (`.foo=${x}`) per tag — including kebab-cased syntax with camelCase suggestion.
- Unknown event handlers (`@foo="h"`) per tag — strips Vue/Lit modifiers (`@click.stop`); native DOM events pass through.
- Enum-typed attribute values outside the declared union.
- Cross-prefix hints — e.g. `<calcite-combobox filteredItems="x">` returns _"`<calcite-combobox>` has no attribute `filteredItems`, but it does have a property — try `.filteredItems=${…}`"_.
- Deprecation warnings sourced from per-package overlays (see "Per-package overlays" below).

HTML-only; skips `data-*` / `aria-*` / `on*` attributes. Individual rules can be disabled in `cem.config.json` (see "Configuration").

### Per-package overlays

CEMs don't ship usage examples or deprecation labels. Augment them via a per-package overlay file referenced from `cem.config.json`:

```jsonc
// cem.config.json
{
  "packages": {
    "@acme/design-system": { "overlay": "./cem-overlays/acme.json" },
  },
}
```

```jsonc
// cem-overlays/acme.json
{
  "elements": {
    "acme-button": {
      "examples": ["<acme-button variant=\"primary\">Save</acme-button>"],
      "usage": "Always pair with `<acme-form-group>` for label/error UX.",
      "deprecated": { "attrs": { "type": "use `variant` instead" } },
    },
  },
}
```

Overlays are additive only — they cannot rename, remove, or retype CEM-sourced fields. See [ADR-0005](docs/adr-0005-extensibility.md) for the full schema and design.

If the agent asks for an unknown package, the error includes a **Did you mean?** suggestion.

### Bench results (44 hand-curated real-world queries, 6 libraries)

| Query kind                                                     | Top-1    | Top-3    |
| -------------------------------------------------------------- | -------- | -------- |
| Anchored (`"button"`, `"DatePicker"`, `"alrt"`)                | **100%** | 100%     |
| Paraphrastic (`"show a temporary toast"`, `"loading spinner"`) | **92%**  | 100%     |
| Attribute-anchored (`"scale s m l"`)                           | **100%** | 100%     |
| **Overall**                                                    | **98%**  | **100%** |

For the head-to-head against `fuzzysort` and the full methodology see [`docs/adr-0001-fuzzy-search.md`](docs/adr-0001-fuzzy-search.md).

---

## How discovery works

`cem-mcp` walks `node_modules` (top-level and `@scoped/*`) in the project root, opens each `package.json`, and registers packages that ship a Custom Elements Manifest. Each candidate file is matched against a chain of **schema adapters**:

| adapter            | shape                                                  | covers                                                               |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------- |
| `cem2`             | Standard CEM 2.x (`{ schemaVersion, modules: [...] }`) | Calcite, Shoelace, Patternfly, RHDS, Nord, UI5, Vivid, most Lit libs |
| `carbon-html-data` | VS Code HTML custom-data (`{ version, tags: [...] }`)  | `@carbon/web-components`, `@cds/core`                                |

Fallback paths checked when `customElements` isn't declared in `package.json`: `custom-elements.json`, `dist/custom-elements.json`, `dist/docs/custom-elements.json`, `dist/docs/api.json`.

Adding a new schema is a single file under `src/adapters/` plus one line in `src/adapters/index.ts` — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## How search works

Four scoring channels combine per query, all pre-indexed at load:

1. **Tag fuzzy index** — tuned for kebab-case tags with a library-wide common prefix. Exact, prefix-stripped, PascalCase, concatenated flat, acronym, substring, and capped Levenshtein typo tolerance.
2. **BM25 text index** — over per-component description / attribute / event / slot / CSS metadata. Tokenizer strips stopwords, splits camelCase, applies light stemming (`loading → load`, `expandable → expand`). Queries expanded through a bidirectional synonym map (~40 UI-domain clusters: `toast ↔ alert`, `spinner ↔ loader`, etc.).
3. **Token-to-tag boost** — when any query token (original or synonym-expanded) names a kebab token of some component, that component gets lifted. Rescues cases where the target's description is empty.
4. **Attribute-anchored channel** — when the query head names an attribute shared by ≥2 components, score by attribute presence + value coverage. Survives single-character value tokens.

## Configuration

Drop a `cem.config.json` in the project root (or pass `--config <path>`). Everything is optional; strict zod schema rejects unknown keys at startup. See [`examples/cem.config.example.json`](examples/cem.config.example.json).

```jsonc
{
  "packages": {
    "include": ["@esri/calcite-components"],
    "exclude": ["@some/legacy-lib"],
  },
  "paths": {
    "@my/elements": "./vendor/my-elements/custom-elements.json",
  },
  "adapters": { "disable": ["carbon-html-data"] },
  "synonyms": {
    "extend": { "snackbar": ["alert", "toast"] },
    "disable": false,
  },
}
```

---

## CLI

```
cem-mcp [--project <dir>] [--config <path>]
cem-mcp --help | --version
```

The server speaks MCP over stdio; you don't typically invoke it directly — your MCP client launches it. Environment overrides: `CEM_PROJECT`, `CEM_CONFIG`.

## Programmatic use

Types are exported. Use `CemRegistry` directly if you want to embed discovery + search in another tool:

```ts
import { CemRegistry } from "cem-mcp/cem";

const registry = await CemRegistry.fromProject("/path/to/project");
const pkg = await registry.get("@esri/calcite-components");
// pkg.byTag, pkg.elements, pkg.index, pkg.bm25, pkg.synonyms, pkg.attrIndex
```

Adapters are extensible the same way:

```ts
import type { CemAdapter } from "cem-mcp/adapters";
// register your own and pass via internal API; see src/adapters/ for examples
```

---

## Development

```bash
npm install
npm run fetch-libs   # populate test/fixtures/project (10 component libraries, ~30s)
npm test             # 82 tests across adapters, discovery, fuzzy, BM25, config, integration
npm run build        # tsc + chmod +x dist/index.js
npm run dev -- --project /path/to/your/project   # run server in dev
npm run bench:realworld  # the honest paraphrastic bench

npm run pack:check   # verify what would ship to npm (runs as part of prepublishOnly)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for project layout, how to add an adapter, and how to extend the synonym map.

## Known limitations

- **Paraphrastic ceiling**: 92% top-1 / 100% top-3 on the real-world bench. The single remaining miss is defensible (`expandable section → calcite-block-section` — that tag literally has "section" in it). Further jumps would need either curated synonym work via config or a small embedding model; the latter isn't built.
- **2-letter acronyms** (`cb` for both `calcite-button` and `calcite-block`) are tied on score and fall back to alphabetical, sometimes wrong.
- **No support yet** for components declared only through `module.exports[]` `custom-element-definition` entries (some Lit / FAST patterns).
- **No live reload.** Adding or upgrading a package in the project requires restarting the server.

## License

[MIT](LICENSE)

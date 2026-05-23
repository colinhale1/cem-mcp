# MCP client configurations for cem-mcp

Copy the snippet for your client into the file it expects. The server
itself is the same in every case — these are just where each tool wants
to be told about it.

| Client | Config file | Schema |
| --- | --- | --- |
| [Claude Code](#claude-code-cli) | `~/.claude.json` or `claude mcp add` | `mcpServers` |
| [Claude Desktop](#claude-desktop) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows) | `mcpServers` |
| [Cursor](#cursor) | `~/.cursor/mcp.json` or `.cursor/mcp.json` per-project | `mcpServers` |
| [Windsurf](#windsurf-codeium) | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| [VS Code (MCP)](#vs-code) | `.vscode/mcp.json` per-workspace or user `settings.json` | `servers` (note: different key) |
| [Zed](#zed) | `~/.config/zed/settings.json` or `.zed/settings.json` | `context_servers` (note: different key) |
| [Continue](#continue) | `~/.continue/config.yaml` | `mcpServers` (YAML) |
| [Cline](#cline) | VS Code settings → MCP, or `cline_mcp_settings.json` | `mcpServers` |

Across all clients you almost always want to set `CEM_PROJECT` to the
absolute path of the project whose `node_modules` cem-mcp should scan.
Several clients let you use `${workspaceFolder}` or similar — those
examples are noted inline.

## Two ways to run the server

In every snippet below you'll see one of these two `command` shapes:

**`npx`** — no install, always uses the latest version:

```json
"command": "npx",
"args": ["-y", "cem-mcp"]
```

**`node`** — point at a globally installed binary (`npm i -g cem-mcp`):

```json
"command": "cem-mcp"
```

`npx` is convenient but adds a few seconds of startup the first time a
session loads. For day-to-day use, prefer `npm i -g cem-mcp` and use the
`cem-mcp` command directly.

---

## Claude Code (CLI)

Easiest path is the built-in command:

```bash
claude mcp add cem -- npx -y cem-mcp
# then set the project root via the env var when you launch claude:
CEM_PROJECT=/abs/path/to/your/project claude
```

Or edit `~/.claude.json` directly — see [`claude-code.json`](./claude-code.json).

## Claude Desktop

See [`claude-desktop.json`](./claude-desktop.json). Restart Claude Desktop
after editing.

## Cursor

See [`cursor.json`](./cursor.json). Place at `.cursor/mcp.json` in a
project for per-project config, or `~/.cursor/mcp.json` for global.

## Windsurf (Codeium)

See [`windsurf.json`](./windsurf.json). Restart Windsurf after editing.

## VS Code

VS Code uses a different top-level key (`servers`, not `mcpServers`).
See [`vscode.json`](./vscode.json). Place at `.vscode/mcp.json` for the
current workspace.

## Zed

Zed uses `context_servers` instead of `mcpServers`. See
[`zed.json`](./zed.json). Place in `settings.json`.

## Continue

Continue uses YAML for its config now. See [`continue.yaml`](./continue.yaml).

## Cline

VS Code extension. See [`cline.json`](./cline.json), or edit through the
Cline MCP settings UI in VS Code.

---

## Troubleshooting

- **"No packages with a Custom Elements Manifest found"** — Your
  `CEM_PROJECT` doesn't point at a real `node_modules`, or none of the
  installed packages publish a CEM. Try installing `@esri/calcite-components`
  or `@shoelace-style/shoelace` to verify.
- **Server starts but the tool isn't available** — Restart the client
  after editing the config; most don't hot-reload MCP server definitions.
- **`npx` is slow on first call** — Switch to a global install:
  `npm i -g cem-mcp`, then change `"command": "npx"` to `"command": "cem-mcp"`
  and drop the `args` array.
- **Different absolute paths per machine** — Most clients support an env
  var or workspace variable; check that client's MCP docs for the right
  substitution.

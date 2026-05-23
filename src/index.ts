#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { CemRegistry, searchElements, type LoadedPackage } from "./cem.js";
import {
  ASPECTS,
  formatAspect,
  formatAttribute,
  formatComponentList,
  formatCrossPackageSearch,
  formatElementCompact,
  formatEventDetail,
  formatMulti,
  formatNoCrossPackageMatch,
  formatPackageList,
  formatSearch,
  type Aspect,
  type CrossPackageHit,
} from "./format.js";
import { suggestPackages } from "./suggest.js";
import { formatValidationResult, validateSnippet } from "./validate.js";

function hasFlag(...names: string[]): boolean {
  return process.argv.some((a) => names.includes(a));
}

function readFlag(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`))?.slice(`${name}=`.length);
  if (eq !== undefined) return eq;
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function resolveProjectRoot(): string {
  return resolve(readFlag("--project") ?? process.env.CEM_PROJECT ?? process.cwd());
}

function resolveConfigPath(): string | undefined {
  return readFlag("--config") ?? process.env.CEM_CONFIG;
}

async function readOwnVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(resolve(here, "../package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const HELP = `cem-mcp — MCP server delivering repo-accurate web component docs from
Custom Elements Manifests discovered in a project's node_modules.

USAGE
  cem-mcp [--project <dir>] [--config <path>]
  cem-mcp --help | --version

OPTIONS
  --project <dir>     Project root containing node_modules.
                      Defaults to $CEM_PROJECT or the current working directory.
  --config <path>     Path to a cem.config.json. Defaults to $CEM_CONFIG, or
                      <project>/cem.config.json if present.
  -h, --help          Print this help and exit.
  -v, --version       Print the version and exit.

ENVIRONMENT
  CEM_PROJECT         Same as --project.
  CEM_CONFIG          Same as --config.

PROTOCOL
  cem-mcp speaks the Model Context Protocol over stdio. It's meant to be
  launched by an MCP-capable client (Claude Code, Cursor, Windsurf, VS Code
  with MCP, Zed, Continue, Cline, etc.). See the README for client-specific
  config snippets: https://github.com/colinhale1/cem-mcp#readme

TOOLS
  get_component_docs(package?, query?, aspect?, attr?, event?)
    - no args                       → list every discovered package
    - query only                    → cross-package search
    - package only                  → list components in that package
    - package + tag                 → compact docs
    - package + tag + aspect=X      → drill into one section (attrs|events|...)
    - package + tag + attr=NAME     → single attribute detail
    - package + tag + event=NAME    → single event detail
    - package + non-tag query       → ranked search within that package

  validate_component_usage(snippet, package?)
    - Validate an HTML snippet against the loaded CEMs.
    - Catches: unknown custom elements, unknown attributes per tag,
      enum-typed attribute values outside the declared union.
`;

const GET_TOOL_NAME = "get_component_docs";
const VALIDATE_TOOL_NAME = "validate_component_usage";

// Grammar lives in the tool description so the agent loads it once at MCP
// handshake and can target every drill-down without re-reading prior output.
// See docs/adr-0002-tool-shape.md.
const GET_TOOL_DESCRIPTION = [
  "Look up repo-accurate web component documentation from Custom Elements Manifests",
  "shipped by packages in the project's `node_modules`.",
  "",
  "Behavior by parameter combination:",
  "- No arguments → list every discovered package.",
  "- `query` only (no `package`) → cross-package search across every discovered package.",
  "- `package` only → list every component in that package.",
  "- `package` + exact tag name → compact docs (sections with names + counts; drill in for detail).",
  "- `package` + non-tag query → ranked fuzzy/BM25/synonym search within that package.",
  "",
  "Drill-downs (require `package` + exact tag in `query`):",
  "- `aspect: 'attrs' | 'events' | 'slots' | 'css' | 'methods' | 'examples' | 'all'`",
  "  → expand one section to full detail (types, defaults, descriptions). `all` returns every section.",
  "- `attr: '<attribute-name>'` → full detail for one attribute.",
  "- `event: '<event-name>'` → full detail for one event.",
  "",
  "Compact output lists names with counts in parentheses. To get type information,",
  "defaults, and descriptions for any section, re-call with `aspect` set to that section name.",
  "Section names in output match aspect values 1:1.",
  "",
  "Pass `query` as an array of strings for a multi-lookup within the same package.",
].join("\n");

const VALIDATE_TOOL_DESCRIPTION = [
  "Validate an HTML snippet that uses web components against the loaded Custom Elements Manifests.",
  "",
  "Catches:",
  "- Unknown custom element tags (any tag containing a hyphen that isn't declared by any installed package)",
  "- Unknown attributes on otherwise-known tags",
  "- Enum-typed attribute values outside the declared union (e.g. variant=\"dangerous\" when allowed is 'default'|'primary'|...|'danger')",
  "",
  "Skips: standard HTML attributes (`id`, `class`, ...), `data-*`, `aria-*`, `on*` event handlers,",
  "and dynamic-binding prefixes (`:`, `@`, `.`, `?`) — the parser does not evaluate expressions.",
  "",
  "Pass `package` to limit validation to one package's tags; omit it to validate against every",
  "discovered package.",
].join("\n");

const GetToolInput = z.object({
  package: z.string().min(1).optional(),
  query: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  aspect: z.enum(ASPECTS).optional(),
  attr: z.string().min(1).optional(),
  event: z.string().min(1).optional(),
});

const ValidateToolInput = z.object({
  snippet: z.string().min(1),
  package: z.string().min(1).optional(),
});

// A fuzzy result is "definitive" when its score is high in absolute terms and
// decisively above the runner-up. Thresholds derived empirically; see
// docs/adr-0001-fuzzy-search.md.
const PROMOTE_MIN_SCORE = 400;
const PROMOTE_MIN_RATIO = 2;

// Cross-package confidence floor — we drop below this in formatNoCrossPackageMatch
// rather than render a long noisy ranking. Calibrated against the real-world
// bench: ~150 is the boundary between a "this is at least somewhat lexically
// related" hit and "every component whose description happened to contain a
// query token."
const CROSS_PKG_FLOOR = 150;

function isDefinitive(hits: { score: number }[]): boolean {
  if (hits.length === 0) return false;
  if (hits.length === 1) return true;
  return hits[0].score >= PROMOTE_MIN_SCORE && hits[0].score >= PROMOTE_MIN_RATIO * hits[1].score;
}

interface DrillOptions {
  aspect?: Aspect;
  attr?: string;
  event?: string;
}

function renderElement(
  pkg: LoadedPackage,
  decl: import("./cem.js").CemDeclaration,
  drill: DrillOptions,
): { text: string; isError?: boolean } {
  if (drill.attr) {
    const out = formatAttribute(decl, drill.attr, pkg.name);
    if (out === null) {
      const known = (decl.attributes ?? []).map((a) => a.name);
      return {
        isError: true,
        text: `Unknown attribute \`${drill.attr}\` on \`${decl.tagName}\`. Known: ${known.length ? known.map((n) => `\`${n}\``).join(", ") : "(none)"}.`,
      };
    }
    return { text: out };
  }
  if (drill.event) {
    const out = formatEventDetail(decl, drill.event, pkg.name);
    if (out === null) {
      const known = (decl.events ?? []).map((e) => e.name);
      return {
        isError: true,
        text: `Unknown event \`${drill.event}\` on \`${decl.tagName}\`. Known: ${known.length ? known.map((n) => `\`${n}\``).join(", ") : "(none)"}.`,
      };
    }
    return { text: out };
  }
  if (drill.aspect) {
    return { text: formatAspect(decl, drill.aspect, pkg.name) };
  }
  return { text: formatElementCompact(decl, pkg.name) };
}

function handleQuery(
  pkg: LoadedPackage,
  rawQuery: string,
  drill: DrillOptions,
): { text: string; isError?: boolean } {
  const query = rawQuery.trim();
  if (!query || query.toLowerCase() === "all") {
    return { text: formatComponentList(pkg) };
  }

  const exact = pkg.byTag.get(query.toLowerCase());
  if (exact) return renderElement(pkg, exact, drill);

  const hits = searchElements(pkg, query);
  if (isDefinitive(hits)) return renderElement(pkg, hits[0].decl, drill);
  // Drill-down on a non-exact query doesn't make sense — the agent picked a
  // search term, not a target. Surface the ranked list so the agent can pick
  // the tag it actually wants and re-call with the drill-down.
  return { text: formatSearch(pkg.name, query, hits) };
}

function handleQueries(
  pkg: LoadedPackage,
  queries: string[],
  drill: DrillOptions,
): { text: string; isError?: boolean } {
  if (queries.length === 1) return handleQuery(pkg, queries[0], drill);
  // Multi-query intentionally ignores drill — the agent passes one drill per
  // call. If they want drill on multiple tags, that's separate calls.
  const sections = queries.map((q) => ({ query: q, body: handleQuery(pkg, q, {}).text }));
  return { text: formatMulti(pkg.name, sections) };
}

async function handleCrossPackageQuery(registry: CemRegistry, rawQuery: string): Promise<string> {
  const query = rawQuery.trim();
  if (!query) {
    // Defensive — handler should have routed elsewhere.
    return formatPackageList(
      registry.packagesMeta(),
      registry.projectRoot,
      registry.config.sourcePath,
    );
  }
  const PER_PACKAGE_LIMIT = 5;
  const TOTAL_LIMIT = 15;
  const pkgs = await Promise.all(registry.packageNames().map((n) => registry.get(n)));
  const allHits: CrossPackageHit[] = [];
  for (const pkg of pkgs) {
    // Exact-tag hit short-circuits across packages too — if the agent typed
    // a fully-qualified tag and one package owns it, return compact docs.
    const exact = pkg.byTag.get(query.toLowerCase());
    if (exact) {
      return formatElementCompact(exact, pkg.name);
    }
    const hits = searchElements(pkg, query, PER_PACKAGE_LIMIT);
    for (const h of hits) allHits.push({ packageName: pkg.name, hit: h });
  }
  allHits.sort((a, b) => b.hit.score - a.hit.score);

  const confident = allHits.filter((h) => h.hit.score >= CROSS_PKG_FLOOR).slice(0, TOTAL_LIMIT);
  if (confident.length === 0) {
    const nearMisses = allHits.slice(0, 3);
    return formatNoCrossPackageMatch(query, pkgs.length, nearMisses);
  }
  return formatCrossPackageSearch(query, confident, pkgs.length);
}

function unknownPackageMessage(pkgName: string, available: string[]): string {
  const lines: string[] = [];
  lines.push(`Package \`${pkgName}\` was not found in the project.`);
  if (available.length === 0) {
    lines.push("");
    lines.push("No packages with a Custom Elements Manifest are installed under the project root.");
    return lines.join("\n");
  }
  const suggestions = suggestPackages(pkgName, available);
  if (suggestions.length) {
    lines.push("");
    lines.push(`Did you mean: ${suggestions.map((n) => `\`${n}\``).join(", ")}?`);
  }
  lines.push("");
  lines.push(`Available: ${available.map((n) => `\`${n}\``).join(", ")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (hasFlag("--help", "-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (hasFlag("--version", "-v")) {
    process.stdout.write(`${await readOwnVersion()}\n`);
    return;
  }

  const projectRoot = resolveProjectRoot();
  const configPath = resolveConfigPath();
  const registry = await CemRegistry.fromProject(projectRoot, { configPath });

  const server = new Server({ name: "cem-mcp", version: "0.4.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: GET_TOOL_NAME,
        description: GET_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            package: {
              type: "string",
              description:
                "Name of the package to query (e.g. '@esri/calcite-components'). Omit to search across every discovered package, or to list packages if `query` is also omitted.",
            },
            query: {
              description:
                'Either a tag name for compact docs, any term to fuzzy-search, "all" to list components, or an array of strings for multi-lookup. Required for cross-package search.',
              oneOf: [
                { type: "string", minLength: 1 },
                {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  minItems: 1,
                },
              ],
            },
            aspect: {
              type: "string",
              enum: [...ASPECTS],
              description:
                "Drill into one section of a known tag's docs. Section names in compact output match these values 1:1. `all` returns every section in one call.",
            },
            attr: {
              type: "string",
              minLength: 1,
              description: "Return full detail for one attribute of the looked-up tag.",
            },
            event: {
              type: "string",
              minLength: 1,
              description: "Return full detail for one event of the looked-up tag.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: VALIDATE_TOOL_NAME,
        description: VALIDATE_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            snippet: {
              type: "string",
              minLength: 1,
              description: "HTML snippet to validate.",
            },
            package: {
              type: "string",
              minLength: 1,
              description:
                "Optional package name to limit validation to. Omit to validate against every discovered package.",
            },
          },
          required: ["snippet"],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === GET_TOOL_NAME) {
      const parsed = GetToolInput.safeParse(req.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        };
      }
      try {
        const { package: pkgName, query, aspect, attr, event } = parsed.data;
        const drill: DrillOptions = { aspect, attr, event };

        // No args → list packages.
        if (!pkgName && query === undefined) {
          return {
            content: [
              {
                type: "text",
                text: formatPackageList(
                  registry.packagesMeta(),
                  registry.projectRoot,
                  registry.config.sourcePath,
                ),
              },
            ],
          };
        }

        // Cross-package search.
        if (!pkgName && query !== undefined) {
          if (Array.isArray(query)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Multi-query (`query` as array) requires `package`. Cross-package search takes a single string.",
                },
              ],
            };
          }
          return {
            content: [{ type: "text", text: await handleCrossPackageQuery(registry, query) }],
          };
        }

        // Package known? — pkgName is set from here on.
        if (!registry.has(pkgName!)) {
          return {
            isError: true,
            content: [
              { type: "text", text: unknownPackageMessage(pkgName!, registry.packageNames()) },
            ],
          };
        }
        const pkg = await registry.get(pkgName!);

        if (query === undefined) {
          return { content: [{ type: "text", text: formatComponentList(pkg) }] };
        }

        const queries = Array.isArray(query) ? query : [query];
        const result = handleQueries(pkg, queries, drill);
        return {
          isError: result.isError,
          content: [{ type: "text", text: result.text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    }

    if (req.params.name === VALIDATE_TOOL_NAME) {
      const parsed = ValidateToolInput.safeParse(req.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        };
      }
      try {
        const { snippet, package: pkgName } = parsed.data;
        if (pkgName && !registry.has(pkgName)) {
          return {
            isError: true,
            content: [
              { type: "text", text: unknownPackageMessage(pkgName, registry.packageNames()) },
            ],
          };
        }
        const result = await validateSnippet(registry, snippet, { package: pkgName });
        return { content: [{ type: "text", text: formatValidationResult(result) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const pkgCount = registry.packageNames().length;
  const cfg = registry.config.sourcePath ? ` · config ${registry.config.sourcePath}` : "";
  process.stderr.write(
    `cem-mcp ready · project ${projectRoot} · ${pkgCount} package(s) discovered${cfg}\n`,
  );
}

// Re-export helpers used by the eval driver and downstream consumers.
export { formatElementCompact, formatElementFull, formatAspect } from "./format.js";

main().catch((err) => {
  process.stderr.write(`cem-mcp failed to start: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
